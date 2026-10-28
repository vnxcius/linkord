//! Activities shown with someone's presence, like Discord's: "Listening to Spotify" (spotify.rs),
//! "Playing <game>", which the desktop app detects from running processes and reports here, and the custom
//! status (emoji + text, saved in custom_statuses so it survives restarts).
//!
//! Game detection uses Discord's public list of detectable applications (executable names per game), fetched
//! once a day, trimmed to Windows games and cached under the data dir; the desktop app downloads it from
//! `/api/activities/detectable` and matches it against its own process list.

use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime};

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use chrono::Utc;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{bad, ApiResult};
use crate::gateway::broadcast_presence;
use crate::id::Id;
use crate::models::User;
use crate::state::AppState;

/// Activity types, as Discord numbers them.
pub const PLAYING: i64 = 0;
pub const LISTENING: i64 = 2;
pub const CUSTOM: i64 = 4;

/// A game activity disappears unless the app refreshes it (it does every minute), so a crashed app or a
/// PC that went to sleep doesn't leave "Playing" up forever.
const GAME_TTL: Duration = Duration::from_secs(150);
const LIST_MAX_AGE: Duration = Duration::from_secs(24 * 3600);
const LIST_FILE: &str = "detectable.json";

fn kind_of(a: &Value) -> i64 {
    a["type"].as_i64().unwrap_or(-1)
}

/// Replaces the user's activity of this type (None removes it). Returns whether anything changed.
pub fn put_activity(st: &AppState, user: Id, kind: i64, activity: Option<Value>) -> bool {
    let mut list = st.activities.entry(user).or_default();
    let before = list.clone();
    list.retain(|a| kind_of(a) != kind);
    if let Some(a) = activity {
        // Games come first, like Discord's "Playing" over "Listening to".
        if kind == PLAYING {
            list.insert(0, a);
        } else {
            list.push(a);
        }
    }
    let changed = *list != before;
    let empty = list.is_empty();
    drop(list);
    if empty {
        st.activities.remove_if(&user, |_, l| l.is_empty());
    }
    changed
}

pub fn activity_of(st: &AppState, user: Id, kind: i64) -> Option<Value> {
    st.activities.get(&user).and_then(|l| l.iter().find(|a| kind_of(a) == kind).cloned())
}

/// Tells everyone who can see the user's presence about their current activities.
pub async fn announce(st: &AppState, user: Id) {
    if let Ok(u) = User::get(&st.db, user).await {
        let _ = broadcast_presence(st, &u).await;
    }
}

// ---------- detectable games ----------

/// Discord's detectable list, trimmed: `[[id, name, icon_hash, [executable, ...]], ...]` (Windows only).
pub struct GameList {
    pub json: Arc<str>,
    pub etag: String,
    /// id -> (name, icon hash), to give reported games their real name and icon.
    pub by_id: std::collections::HashMap<String, (String, String)>,
}

#[derive(Default)]
pub struct Games {
    pub list: RwLock<Option<Arc<GameList>>>,
    /// Users with a game activity -> when it expires.
    pub expires: DashMap<Id, Instant>,
}

/// Keeps Windows executables (minus launchers and argument-matched ones, which need a command line).
fn trim(raw: &Value) -> Value {
    let apps = raw.as_array().map(Vec::as_slice).unwrap_or_default();
    Value::Array(
        apps.iter()
            .filter_map(|app| {
                let exes: Vec<&str> = app["executables"]
                    .as_array()?
                    .iter()
                    .filter(|e| e["os"] == "win32" && !e["is_launcher"].as_bool().unwrap_or(false) && e.get("arguments").is_none_or(Value::is_null))
                    .filter_map(|e| e["name"].as_str())
                    .collect();
                if exes.is_empty() {
                    return None;
                }
                Some(json!([app["id"], app["name"], app["icon_hash"].as_str().unwrap_or(""), exes]))
            })
            .collect(),
    )
}

fn parse(trimmed: &str) -> Option<GameList> {
    let v: Value = serde_json::from_str(trimmed).ok()?;
    let by_id = v
        .as_array()?
        .iter()
        .filter_map(|g| Some((g[0].as_str()?.to_string(), (g[1].as_str()?.to_string(), g[2].as_str().unwrap_or("").to_string()))))
        .collect();
    let etag = format!("\"{:x}\"", fnv1a(trimmed.as_bytes()));
    Some(GameList { json: trimmed.into(), etag, by_id })
}

/// Cheap content hash for the ETag (FNV-1a, 64-bit).
fn fnv1a(data: &[u8]) -> u64 {
    data.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3))
}

async fn fetch_list(st: &AppState) -> anyhow::Result<String> {
    let raw: Value = st.http.get(&st.cfg.detectable_url).timeout(Duration::from_secs(60)).send().await?.error_for_status()?.json().await?;
    Ok(serde_json::to_string(&trim(&raw))?)
}

/// Background task: loads the cached list, and refreshes it from Discord once a day.
pub async fn keep_list(st: AppState) {
    let path = st.cfg.data_dir.join(LIST_FILE);
    if let Ok(cached) = tokio::fs::read_to_string(&path).await {
        if let Some(list) = parse(&cached) {
            *st.games.list.write().unwrap() = Some(Arc::new(list));
        }
    }
    // Failed fetches retry soon (Discord briefly unreachable), backing off to the hourly check.
    let mut retry = Duration::from_secs(5);
    loop {
        let age = tokio::fs::metadata(&path).await.and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok());
        let mut wait = Duration::from_secs(3600);
        if age.is_none_or(|a| a > LIST_MAX_AGE) {
            match fetch_list(&st).await.map(|t| parse(&t).map(|l| (t, l))) {
                Ok(Some((trimmed, list))) => {
                    tracing::info!("detectable games: {} entries", list.by_id.len());
                    *st.games.list.write().unwrap() = Some(Arc::new(list));
                    let _ = tokio::fs::write(&path, trimmed).await;
                    retry = Duration::from_secs(5);
                }
                failed => {
                    if let Err(e) = failed {
                        tracing::warn!("detectable games: {e}");
                    }
                    wait = retry;
                    retry = (retry * 2).min(Duration::from_secs(3600));
                }
            }
        }
        tokio::time::sleep(wait).await;
    }
}

async fn detectable(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let Some(list) = st.games.list.read().unwrap().clone() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(list.etag.as_str()) {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    (
        [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "public, max-age=3600"), (header::ETAG, list.etag.as_str())],
        list.json.to_string(),
    )
        .into_response()
}

// ---------- playing ----------

#[derive(Deserialize)]
struct Playing {
    /// Discord application id from the detectable list; absent for games the user added themselves.
    application_id: Option<String>,
    name: String,
    /// Unix ms when the game started.
    started_at: Option<i64>,
}

async fn set_playing(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<Playing>) -> ApiResult<StatusCode> {
    let now = Utc::now().timestamp_millis();
    let start = body.started_at.unwrap_or(now).clamp(now - 7 * 24 * 3600 * 1000, now);
    let known = body.application_id.as_ref().and_then(|id| st.games.list.read().unwrap().as_ref().and_then(|l| l.by_id.get(id).cloned()).map(|g| (id.clone(), g)));
    let activity = match known {
        Some((id, (name, icon))) => json!({
            "type": PLAYING,
            "name": name,
            "application_id": id,
            "icon": (!icon.is_empty()).then(|| format!("https://cdn.discordapp.com/app-icons/{id}/{icon}.png?size=128")),
            "timestamps": { "start": start },
        }),
        None => {
            let name = body.name.trim();
            if name.is_empty() || name.chars().count() > 128 {
                return Err(bad("Game name must be 1-128 characters"));
            }
            json!({ "type": PLAYING, "name": name, "timestamps": { "start": start } })
        }
    };
    st.games.expires.insert(me, Instant::now() + GAME_TTL);
    if put_activity(&st, me, PLAYING, Some(activity)) {
        announce(&st, me).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn clear_playing(State(st): State<AppState>, AuthUser(me): AuthUser) -> StatusCode {
    st.games.expires.remove(&me);
    if put_activity(&st, me, PLAYING, None) {
        announce(&st, me).await;
    }
    StatusCode::NO_CONTENT
}

/// Background task: drops games the app stopped refreshing.
pub async fn sweep_games(st: AppState) {
    loop {
        tokio::time::sleep(Duration::from_secs(15)).await;
        let now = Instant::now();
        let expired: Vec<Id> = st.games.expires.iter().filter(|e| *e.value() <= now).map(|e| *e.key()).collect();
        for user in expired {
            st.games.expires.remove_if(&user, |_, t| *t <= now);
            if put_activity(&st, user, PLAYING, None) {
                announce(&st, user).await;
            }
        }
    }
}

// ---------- custom status ----------

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct StatusEmoji {
    /// A server emoji; absent for a Unicode emoji.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    id: Option<Id>,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    animated: Option<bool>,
}

#[derive(Deserialize)]
struct SetCustom {
    text: Option<String>,
    emoji: Option<StatusEmoji>,
    /// Unix ms when it clears itself; absent = never.
    expires_at: Option<i64>,
}

const CUSTOM_TEXT_MAX: usize = 128;

/// The activity everyone sees: `{"type": 4, "name": "Custom Status", "state": text, "emoji": ..., "expires_at": ms}`.
fn custom_activity(text: Option<&str>, emoji: Option<&StatusEmoji>, expires_at: Option<i64>) -> Value {
    let mut a = json!({ "type": CUSTOM, "name": "Custom Status" });
    if let Some(t) = text {
        a["state"] = json!(t);
    }
    if let Some(e) = emoji {
        a["emoji"] = json!(e);
    }
    if let Some(at) = expires_at {
        a["expires_at"] = json!(at);
    }
    a
}

/// The user's own custom status for READY (shown to them even while invisible).
pub fn own_custom_status(st: &AppState, user: Id) -> Option<Value> {
    activity_of(st, user, CUSTOM)
}

/// Tells everyone, and the user's other sessions (they see their own status even while invisible).
async fn announce_custom(st: &AppState, user: Id) {
    st.hub.send(&[user], "CUSTOM_STATUS_UPDATE", &json!({ "custom_status": own_custom_status(st, user) }));
    announce(st, user).await;
}

async fn set_custom(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<SetCustom>) -> ApiResult<Json<Value>> {
    let text = body.text.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string);
    if text.as_ref().is_some_and(|t| t.chars().count() > CUSTOM_TEXT_MAX) {
        return Err(bad("Custom status must be at most 128 characters"));
    }
    let mut emoji = body.emoji.filter(|e| !e.name.trim().is_empty());
    if let Some(e) = &mut emoji {
        match e.id {
            // Server emoji: any that still exists, with its real name.
            Some(id) => {
                let row: Option<(String, bool)> = sqlx::query_as("SELECT name, animated FROM emojis WHERE id = $1").bind(id).fetch_optional(&st.db).await?;
                let (name, animated) = row.ok_or_else(|| bad("Unknown emoji"))?;
                e.name = name;
                e.animated = Some(animated);
            }
            None if e.name.chars().count() > 32 => return Err(bad("Unknown emoji")),
            None => e.animated = None,
        }
    }
    let now = Utc::now().timestamp_millis();
    let expires_at = body.expires_at.filter(|&at| at > now);
    if text.is_none() && emoji.is_none() || body.expires_at.is_some() && expires_at.is_none() {
        clear_custom_status(&st, me).await?;
        return Ok(Json(Value::Null));
    }
    sqlx::query(
        "INSERT INTO custom_statuses (user_id, text, emoji, expires_at) VALUES ($1, $2, $3, to_timestamp($4::float8 / 1000))
         ON CONFLICT (user_id) DO UPDATE SET text = $2, emoji = $3, expires_at = to_timestamp($4::float8 / 1000)",
    )
    .bind(me)
    .bind(&text)
    .bind(emoji.as_ref().map(|e| json!(e)))
    .bind(expires_at)
    .execute(&st.db)
    .await?;
    let activity = custom_activity(text.as_deref(), emoji.as_ref(), expires_at);
    if put_activity(&st, me, CUSTOM, Some(activity.clone())) {
        announce_custom(&st, me).await;
    }
    Ok(Json(activity))
}

async fn clear_custom_status(st: &AppState, user: Id) -> ApiResult<()> {
    sqlx::query("DELETE FROM custom_statuses WHERE user_id = $1").bind(user).execute(&st.db).await?;
    if put_activity(st, user, CUSTOM, None) {
        announce_custom(st, user).await;
    }
    Ok(())
}

async fn clear_custom(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<StatusCode> {
    clear_custom_status(&st, me).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Background task: loads saved custom statuses, then clears the ones that expire.
pub async fn keep_custom_statuses(st: AppState) {
    let rows: Result<Vec<(Id, Option<String>, Option<Value>, Option<i64>)>, _> = sqlx::query_as(
        "SELECT user_id, text, emoji, (extract(epoch FROM expires_at) * 1000)::bigint FROM custom_statuses WHERE expires_at IS NULL OR expires_at > now()",
    )
    .fetch_all(&st.db)
    .await;
    match rows {
        Ok(rows) => {
            for (user, text, emoji, expires_at) in rows {
                let emoji: Option<StatusEmoji> = emoji.and_then(|e| serde_json::from_value(e).ok());
                put_activity(&st, user, CUSTOM, Some(custom_activity(text.as_deref(), emoji.as_ref(), expires_at)));
            }
        }
        Err(e) => tracing::error!("loading custom statuses: {e}"),
    }
    loop {
        tokio::time::sleep(Duration::from_secs(15)).await;
        let now = Utc::now().timestamp_millis();
        let expired: Vec<Id> = st
            .activities
            .iter()
            .filter(|e| e.value().iter().any(|a| kind_of(a) == CUSTOM && a["expires_at"].as_i64().is_some_and(|at| at <= now)))
            .map(|e| *e.key())
            .collect();
        for user in expired {
            if let Err(e) = clear_custom_status(&st, user).await {
                tracing::warn!("clearing an expired custom status: {e:?}");
            }
        }
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/activities/detectable", get(detectable))
        .route("/activities/playing", put(set_playing).delete(clear_playing))
        .route("/activities/custom", put(set_custom).delete(clear_custom))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_to_windows_games() {
        let raw = json!([
            { "id": "1", "name": "Game", "icon_hash": "abc", "executables": [
                { "os": "win32", "name": "win64/game.exe", "is_launcher": false },
                { "os": "win32", "name": "launcher.exe", "is_launcher": true },
                { "os": "win32", "name": ">javaw.exe", "is_launcher": false, "arguments": "net.minecraft" },
                { "os": "darwin", "name": "game.app", "is_launcher": false },
            ]},
            { "id": "2", "name": "Mac only", "icon_hash": null, "executables": [{ "os": "darwin", "name": "x.app", "is_launcher": false }] },
        ]);
        assert_eq!(trim(&raw), json!([["1", "Game", "abc", ["win64/game.exe"]]]));
        let list = parse(&trim(&raw).to_string()).unwrap();
        assert_eq!(list.by_id.get("1"), Some(&("Game".to_string(), "abc".to_string())));
    }
}
