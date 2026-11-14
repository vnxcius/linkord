//! Spotify connection, like Discord's: link an account in Settings -> Connections, and while you're
//! online the server checks what you're playing and shows it as your activity ("Listening to Spotify")
//! to everyone who can see your presence. Uses the Web API's currently-playing endpoint, polled every
//! few seconds and again right when the current song ends.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::{random_token, result_page, AuthUser};
use crate::direct::PublicBase;
use crate::error::{bad, ApiError, ApiResult};
use crate::activities::{activity_of, announce, put_activity, LISTENING};
use crate::id::Id;
use crate::models::User;
use crate::state::AppState;

const KIND: &str = "spotify";
const SCOPES: &str = "user-read-currently-playing user-read-playback-state";
const STATE_TTL: Duration = Duration::from_secs(600);

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/connections/spotify/authorize", get(authorize))
        .route("/connections/spotify/callback", get(callback))
        .route("/users/@me/connections/spotify", axum::routing::patch(update).delete(disconnect))
}

/// Back to the address the user connected from (tunnel or direct access); both are registered with Spotify.
fn redirect_uri(base: &PublicBase) -> String {
    format!("{base}/api/connections/spotify/callback")
}

/// The Spotify consent page URL; the client opens it in a browser.
async fn authorize(State(st): State<AppState>, base: PublicBase, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    if !st.cfg.spotify_enabled() {
        return Err(bad("Spotify is not set up on this server"));
    }
    st.limits.check(format!("spotify-auth:{me}"), 5.0, 0.1)?;
    st.spotify_states.retain(|_, (_, at)| at.elapsed() < STATE_TTL);
    let state = random_token(24);
    st.spotify_states.insert(state.clone(), (me, Instant::now()));
    let url = format!(
        "{}/authorize?client_id={}&response_type=code&redirect_uri={}&scope={}&state={}&show_dialog=true",
        st.cfg.spotify_accounts_url,
        st.cfg.spotify_client_id,
        urlencoding::encode(&redirect_uri(&base)),
        urlencoding::encode(SCOPES),
        state
    );
    Ok(Json(json!({ "url": url })))
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
}

#[derive(Deserialize)]
struct SpotifyUser {
    id: String,
    display_name: Option<String>,
}

async fn callback(State(st): State<AppState>, base: PublicBase, Query(q): Query<CallbackQuery>) -> Response {
    let user = match q.state.as_deref().and_then(|s| st.spotify_states.remove(s)) {
        Some((_, (user, at))) if at.elapsed() < STATE_TTL => user,
        _ => return result_page("This link expired. Connect Spotify again from Pottira's settings.").into_response(),
    };
    let Some(code) = q.code.filter(|_| q.error.is_none()) else {
        return result_page("Spotify wasn't connected.").into_response();
    };
    match finish_connect(&st, user, &code, &base).await {
        Ok(name) => {
            st.hub.send(&[user], "USER_CONNECTIONS_UPDATE", &json!({}));
            result_page(&format!("Spotify ({name}) is connected. You can close this tab and return to Pottira.")).into_response()
        }
        Err(e) => {
            tracing::warn!("spotify connect failed: {e:#}");
            result_page("Could not connect Spotify. Please try again.").into_response()
        }
    }
}

async fn finish_connect(st: &AppState, user: Id, code: &str, base: &PublicBase) -> anyhow::Result<String> {
    let tok: TokenResponse = st
        .http
        .post(format!("{}/api/token", st.cfg.spotify_accounts_url))
        .basic_auth(&st.cfg.spotify_client_id, Some(&st.cfg.spotify_client_secret))
        .form(&[("grant_type", "authorization_code"), ("code", code), ("redirect_uri", &redirect_uri(base))])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let refresh = tok.refresh_token.ok_or_else(|| anyhow::anyhow!("no refresh token"))?;
    let me: SpotifyUser = st
        .http
        .get(format!("{}/v1/me", st.cfg.spotify_api_url))
        .bearer_auth(&tok.access_token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let name = me.display_name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| me.id.clone());
    sqlx::query(
        "INSERT INTO connections (user_id, kind, account_id, account_name, access_token, refresh_token, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
         ON CONFLICT (user_id, kind) DO UPDATE SET account_id = EXCLUDED.account_id, account_name = EXCLUDED.account_name,
           access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, expires_at = EXCLUDED.expires_at, revoked = false",
    )
    .bind(user)
    .bind(KIND)
    .bind(&me.id)
    .bind(&name)
    .bind(&tok.access_token)
    .bind(&refresh)
    .bind(tok.expires_in as f64)
    .execute(&st.db)
    .await?;
    Ok(name)
}

#[derive(Deserialize)]
struct ConnectionUpdate {
    show_on_profile: Option<bool>,
    show_activity: Option<bool>,
}

async fn update(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<ConnectionUpdate>) -> ApiResult<Json<Value>> {
    let done = sqlx::query(
        "UPDATE connections SET show_on_profile = COALESCE($3, show_on_profile), show_activity = COALESCE($4, show_activity)
         WHERE user_id = $1 AND kind = $2",
    )
    .bind(me)
    .bind(KIND)
    .bind(body.show_on_profile)
    .bind(body.show_activity)
    .execute(&st.db)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    if body.show_activity == Some(false) {
        clear_activity(&st, me).await;
    }
    st.hub.send(&[me], "USER_CONNECTIONS_UPDATE", &json!({}));
    Ok(Json(json!({})))
}

async fn disconnect(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<()> {
    sqlx::query("DELETE FROM connections WHERE user_id = $1 AND kind = $2").bind(me).bind(KIND).execute(&st.db).await?;
    clear_activity(&st, me).await;
    st.hub.send(&[me], "USER_CONNECTIONS_UPDATE", &json!({}));
    Ok(())
}

/// The user's connections for Settings (without tokens).
pub async fn list(st: &AppState, user: Id) -> ApiResult<Vec<Value>> {
    let rows: Vec<(String, String, String, bool, bool, bool, DateTime<Utc>)> = sqlx::query_as(
        "SELECT kind, account_id, account_name, show_on_profile, show_activity, revoked, created_at FROM connections WHERE user_id = $1",
    )
    .bind(user)
    .fetch_all(&st.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(kind, id, name, show_on_profile, show_activity, revoked, linked_at)| {
            json!({ "type": kind, "id": id, "username": name, "show_on_profile": show_on_profile, "show_activity": show_activity, "revoked": revoked, "linked_at": linked_at })
        })
        .collect())
}

/// Connections shown on someone's profile ("Display on profile").
pub async fn public(st: &AppState, user: Id) -> ApiResult<Vec<Value>> {
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT kind, account_id, account_name FROM connections WHERE user_id = $1 AND show_on_profile AND NOT revoked")
            .bind(user)
            .fetch_all(&st.db)
            .await?;
    Ok(rows.into_iter().map(|(kind, id, name)| json!({ "type": kind, "id": id, "name": name })).collect())
}

// ---------- activity ----------

async fn clear_activity(st: &AppState, user: Id) {
    if put_activity(st, user, LISTENING, None) {
        announce(st, user).await;
    }
}

async fn set_activity(st: &AppState, user: Id, activity: Value) {
    if put_activity(st, user, LISTENING, Some(activity)) {
        announce(st, user).await;
    }
}

/// What's playing, in the shape clients render (Discord-like: type 2 = "Listening to").
fn to_activity(v: &Value, now_ms: i64) -> Option<Value> {
    if !v["is_playing"].as_bool().unwrap_or(false) || v["currently_playing_type"].as_str() != Some("track") {
        return None;
    }
    let item = &v["item"];
    let id = item["id"].as_str()?;
    let duration = item["duration_ms"].as_i64()?;
    let progress = v["progress_ms"].as_i64().unwrap_or(0).clamp(0, duration);
    let start = now_ms - progress;
    let artists: Vec<Value> = item["artists"]
        .as_array()
        .map(|a| a.iter().map(|x| json!({ "name": x["name"], "url": x["external_urls"]["spotify"] })).collect())
        .unwrap_or_default();
    let names: Vec<&str> = artists.iter().filter_map(|a| a["name"].as_str()).collect();
    // Spotify lists album art largest first; ~300px is plenty for a 64-80px cover.
    let images = item["album"]["images"].as_array().cloned().unwrap_or_default();
    let image = images.iter().find(|i| i["width"].as_i64().is_some_and(|w| w <= 320)).or(images.first()).and_then(|i| i["url"].as_str());
    Some(json!({
        "type": 2,
        "name": "Spotify",
        "details": item["name"],
        "state": names.join("; "),
        "artists": artists,
        "album": item["album"]["name"],
        "album_url": item["album"]["external_urls"]["spotify"],
        "image": image,
        "url": item["external_urls"]["spotify"],
        "sync_id": id,
        "timestamps": { "start": start, "end": start + duration },
    }))
}

/// Whether two activities differ enough to tell everyone: another song, or a seek of 2+ seconds.
fn changed(old: Option<&Value>, new: Option<&Value>) -> bool {
    match (old, new) {
        (None, None) => false,
        (Some(a), Some(b)) => {
            a["sync_id"] != b["sync_id"] || (a["timestamps"]["start"].as_i64().unwrap_or(0) - b["timestamps"]["start"].as_i64().unwrap_or(0)).abs() > 2000
        }
        _ => true,
    }
}

enum Poll {
    Playing(Value),
    Nothing,
    /// The user revoked access (or the token broke): they need to connect again.
    Revoked,
    /// Spotify said slow down, or a network error: try again later.
    Later(Duration),
}

async fn refresh(st: &AppState, user: Id, refresh_token: &str) -> anyhow::Result<Option<String>> {
    let res = st
        .http
        .post(format!("{}/api/token", st.cfg.spotify_accounts_url))
        .basic_auth(&st.cfg.spotify_client_id, Some(&st.cfg.spotify_client_secret))
        .form(&[("grant_type", "refresh_token"), ("refresh_token", refresh_token)])
        .send()
        .await?;
    if res.status() == reqwest::StatusCode::BAD_REQUEST || res.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(None);
    }
    let tok: TokenResponse = res.error_for_status()?.json().await?;
    sqlx::query(
        "UPDATE connections SET access_token = $3, refresh_token = COALESCE($4, refresh_token), expires_at = now() + make_interval(secs => $5)
         WHERE user_id = $1 AND kind = $2",
    )
    .bind(user)
    .bind(KIND)
    .bind(&tok.access_token)
    .bind(&tok.refresh_token)
    .bind(tok.expires_in as f64)
    .execute(&st.db)
    .await?;
    Ok(Some(tok.access_token))
}

async fn poll_user(st: &AppState, c: &Conn) -> Poll {
    let mut token = c.access_token.clone();
    if c.expires_at < Utc::now() + chrono::Duration::seconds(60) {
        match refresh(st, c.user_id, &c.refresh_token).await {
            Ok(Some(t)) => token = t,
            Ok(None) => return Poll::Revoked,
            Err(_) => return Poll::Later(Duration::from_secs(30)),
        }
    }
    for attempt in 0..2 {
        let res = st.http.get(format!("{}/v1/me/player/currently-playing", st.cfg.spotify_api_url)).bearer_auth(&token).send().await;
        let Ok(res) = res else { return Poll::Later(Duration::from_secs(15)) };
        match res.status().as_u16() {
            204 => return Poll::Nothing,
            200 => {
                let Ok(v) = res.json::<Value>().await else { return Poll::Nothing };
                let now = Utc::now().timestamp_millis();
                return to_activity(&v, now).map_or(Poll::Nothing, Poll::Playing);
            }
            401 if attempt == 0 => match refresh(st, c.user_id, &c.refresh_token).await {
                Ok(Some(t)) => token = t,
                Ok(None) => return Poll::Revoked,
                Err(_) => return Poll::Later(Duration::from_secs(30)),
            },
            429 => {
                let wait = res.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(30);
                return Poll::Later(Duration::from_secs(wait));
            }
            _ => return Poll::Later(Duration::from_secs(30)),
        }
    }
    Poll::Revoked
}

#[derive(sqlx::FromRow)]
struct Conn {
    user_id: Id,
    access_token: String,
    refresh_token: String,
    expires_at: DateTime<Utc>,
    show_activity: bool,
}

/// Background task: checks connected users who are online and showing their activity.
pub async fn poller(st: AppState) {
    let mut next: HashMap<Id, Instant> = HashMap::new();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tick.tick().await;
        let Ok(conns) = sqlx::query_as::<_, Conn>(
            "SELECT user_id, access_token, refresh_token, expires_at, show_activity FROM connections WHERE kind = $1 AND NOT revoked",
        )
        .bind(KIND)
        .fetch_all(&st.db)
        .await
        else {
            continue;
        };
        let now = Instant::now();
        let mut due = Vec::new();
        for c in conns {
            let user = User::get(&st.db, c.user_id).await.ok();
            // Offline, invisible or "Display Spotify as your status" off: nothing to show, no need to ask Spotify.
            let visible = c.show_activity && user.as_ref().is_some_and(|u| st.hub.presence(u) != "offline");
            if !visible {
                next.remove(&c.user_id);
                if put_activity(&st, c.user_id, LISTENING, None) {
                    announce(&st, c.user_id).await;
                }
                continue;
            }
            if next.get(&c.user_id).is_none_or(|t| *t <= now) {
                due.push(c);
            }
        }
        let results = futures_util::future::join_all(due.iter().map(|c| poll_user(&st, c))).await;
        for (c, result) in due.iter().zip(results) {
            let user = c.user_id;
            let wait = match result {
                Poll::Playing(a) => {
                    let current = activity_of(&st, user, LISTENING);
                    // Check again right after this song ends, so the next one shows up promptly.
                    let left = a["timestamps"]["end"].as_i64().unwrap_or(0) - Utc::now().timestamp_millis();
                    if changed(current.as_ref(), Some(&a)) {
                        set_activity(&st, user, a).await;
                    }
                    st.cfg.spotify_poll.min(Duration::from_millis(left.max(0) as u64 + 800))
                }
                Poll::Nothing => {
                    clear_activity(&st, user).await;
                    st.cfg.spotify_poll
                }
                Poll::Revoked => {
                    let _ = sqlx::query("UPDATE connections SET revoked = true WHERE user_id = $1 AND kind = $2").bind(user).bind(KIND).execute(&st.db).await;
                    clear_activity(&st, user).await;
                    st.hub.send(&[user], "USER_CONNECTIONS_UPDATE", &json!({}));
                    st.cfg.spotify_poll
                }
                Poll::Later(d) => d,
            };
            next.insert(user, Instant::now() + wait);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn playing(id: &str, progress: i64, playing: bool) -> Value {
        json!({
            "is_playing": playing, "currently_playing_type": "track", "progress_ms": progress,
            "item": {
                "id": id, "name": "Song", "duration_ms": 200_000,
                "external_urls": { "spotify": "https://open.spotify.com/track/x" },
                "artists": [{ "name": "A", "external_urls": { "spotify": "u" } }, { "name": "B", "external_urls": { "spotify": "v" } }],
                "album": { "name": "Album", "external_urls": { "spotify": "w" }, "images": [{ "url": "big", "width": 640 }, { "url": "mid", "width": 300 }] }
            }
        })
    }

    #[test]
    fn activity_from_currently_playing() {
        let a = to_activity(&playing("t1", 50_000, true), 1_000_000).unwrap();
        assert_eq!(a["details"], "Song");
        assert_eq!(a["state"], "A; B");
        assert_eq!(a["image"], "mid");
        assert_eq!(a["timestamps"]["start"], 950_000);
        assert_eq!(a["timestamps"]["end"], 1_150_000);
        assert!(to_activity(&playing("t1", 0, false), 0).is_none(), "paused shows nothing, like Discord");
    }

    #[test]
    fn only_song_changes_and_seeks_are_announced() {
        let a = to_activity(&playing("t1", 50_000, true), 1_000_000).unwrap();
        let same = to_activity(&playing("t1", 55_000, true), 1_005_500).unwrap();
        let seek = to_activity(&playing("t1", 120_000, true), 1_005_000).unwrap();
        let other = to_activity(&playing("t2", 0, true), 1_005_000).unwrap();
        assert!(!changed(Some(&a), Some(&same)));
        assert!(changed(Some(&a), Some(&seek)));
        assert!(changed(Some(&a), Some(&other)));
        assert!(changed(None, Some(&a)));
        assert!(changed(Some(&a), None));
    }
}
