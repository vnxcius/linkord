use std::time::{Duration, Instant};

use axum::extract::{FromRequestParts, Query, State};
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::direct::PublicBase;
use crate::error::{bad, ApiError, ApiResult};
use crate::id::Id;
use crate::models::validate_username;
use crate::ratelimit::ClientIp;
use crate::state::{AppState, OAuthState, PendingLogin};
use crate::uploads;

const SESSION_DAYS: i64 = 90;
pub const LOGIN_TTL: Duration = Duration::from_secs(600);

/// Authenticated user, from `Authorization: Bearer <token>`.
pub struct AuthUser(pub Id);

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(ApiError::Unauthorized)?;
        user_from_token(st, token).await?.map(AuthUser).ok_or(ApiError::Unauthorized)
    }
}

pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub async fn user_from_token(st: &AppState, token: &str) -> ApiResult<Option<Id>> {
    Ok(sqlx::query_scalar::<_, Id>("SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()")
        .bind(hash_token(token))
        .fetch_optional(&st.db)
        .await?)
}

async fn create_session(st: &AppState, user: Id) -> ApiResult<String> {
    let token = random_token(32);
    sqlx::query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))")
        .bind(hash_token(&token))
        .bind(user)
        .bind(SESSION_DAYS as i32)
        .execute(&st.db)
        .await?;
    Ok(token)
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/config", get(auth_config))
        .route("/auth/discord/start", get(discord_start))
        .route("/auth/discord/callback", get(discord_callback))
        .route("/auth/poll", get(poll))
        .route("/auth/dev", post(dev_login))
        .route("/auth/logout", post(logout))
}

async fn auth_config(State(st): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({ "discord": st.cfg.discord_enabled(), "dev_login": st.cfg.dev_login, "spotify": st.cfg.spotify_enabled() }))
}

#[derive(Deserialize)]
struct StartQuery {
    /// Set by the desktop app, which then polls /auth/poll with the same nonce.
    nonce: Option<String>,
}

async fn discord_start(State(st): State<AppState>, base: PublicBase, ClientIp(ip): ClientIp, Query(q): Query<StartQuery>) -> ApiResult<Redirect> {
    st.limits.check(format!("login:{ip}"), 10.0, 0.2)?;
    if !st.cfg.discord_enabled() {
        return Err(bad("Discord login is not configured on this server"));
    }
    if let Some(n) = &q.nonce {
        if !(32..=128).contains(&n.len()) {
            return Err(bad("invalid nonce"));
        }
    }
    let state = random_token(24);
    st.oauth_states.insert(state.clone(), OAuthState { nonce: q.nonce, created: Instant::now() });
    let url = format!(
        "https://discord.com/oauth2/authorize?client_id={}&response_type=code&scope=identify&prompt=none&redirect_uri={}&state={}",
        st.cfg.discord_client_id,
        urlencoding::encode(&redirect_uri(&base)),
        state
    );
    Ok(Redirect::to(&url))
}

/// Discord sends people back to the address they started from (the tunnel or direct access, see direct.rs);
/// both must be registered as redirects in the Discord application.
fn redirect_uri(base: &PublicBase) -> String {
    format!("{base}/api/auth/discord/callback")
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct DiscordToken {
    access_token: String,
}

#[derive(Deserialize)]
struct DiscordUser {
    id: String,
    username: String,
    global_name: Option<String>,
    avatar: Option<String>,
    banner: Option<String>,
    accent_color: Option<i32>,
}

async fn discord_callback(State(st): State<AppState>, base: PublicBase, ClientIp(ip): ClientIp, Query(q): Query<CallbackQuery>) -> Response {
    if st.limits.check(format!("login:{ip}"), 10.0, 0.2).is_err() {
        return result_page("Too many sign-in attempts. Please wait a minute and try again.").into_response();
    }
    let oauth = match q.state.as_deref().and_then(|s| st.oauth_states.remove(s)) {
        Some((_, o)) if o.created.elapsed() < LOGIN_TTL => o,
        _ => return result_page("This login link expired. Please try again from Linkord.").into_response(),
    };
    let Some(code) = q.code.filter(|_| q.error.is_none()) else {
        return result_page("Discord login was cancelled.").into_response();
    };
    let token = match finish_discord_login(&st, &code, &base).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("discord login failed: {e:#}");
            return result_page("Could not sign in with Discord. Please try again.").into_response();
        }
    };
    match oauth.nonce {
        Some(nonce) => {
            st.pending_logins.insert(nonce, PendingLogin { token, created: Instant::now() });
            result_page("You're signed in. You can close this tab and return to Linkord.").into_response()
        }
        None => Redirect::to(&format!("{base}/#token={token}")).into_response(),
    }
}

async fn finish_discord_login(st: &AppState, code: &str, base: &PublicBase) -> anyhow::Result<String> {
    let tok: DiscordToken = st
        .http
        .post("https://discord.com/api/oauth2/token")
        .form(&[
            ("client_id", st.cfg.discord_client_id.as_str()),
            ("client_secret", st.cfg.discord_client_secret.as_str()),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &redirect_uri(base)),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let du: DiscordUser = st
        .http
        .get("https://discord.com/api/v10/users/@me")
        .bearer_auth(&tok.access_token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let username = normalize_username(&du.username);
    let (id, inserted): (Id, bool) = sqlx::query_as(
        "INSERT INTO users (id, discord_id, username, display_name, accent_color, discord_username) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (discord_id) DO UPDATE SET username = EXCLUDED.username, discord_username = EXCLUDED.discord_username
         RETURNING id, (xmax = 0)",
    )
    .bind(Id::new())
    .bind(&du.id)
    .bind(&username)
    .bind(&du.global_name)
    .bind(du.accent_color)
    .bind(&du.username)
    .fetch_one(&st.db)
    .await?;

    // Profile pictures are copied from Discord once, on first login. After that the profile is linkord's own.
    if inserted {
        let ext = |h: &str| if h.starts_with("a_") { "gif" } else { "png" };
        let avatar_url = match &du.avatar {
            Some(h) => format!("https://cdn.discordapp.com/avatars/{}/{h}.{}?size=256", du.id, ext(h)),
            None => {
                let idx = du.id.parse::<u64>().map(|i| (i >> 22) % 6).unwrap_or(0);
                format!("https://cdn.discordapp.com/embed/avatars/{idx}.png")
            }
        };
        let avatar = uploads::mirror(st, &avatar_url, &format!("avatars/{id}")).await;
        let banner = match &du.banner {
            Some(h) => {
                let url = format!("https://cdn.discordapp.com/banners/{}/{h}.{}?size=600", du.id, ext(h));
                uploads::mirror(st, &url, &format!("banners/{id}")).await
            }
            None => None,
        };
        sqlx::query("UPDATE users SET avatar = $2, banner = $3 WHERE id = $1")
            .bind(id)
            .bind(avatar)
            .bind(banner)
            .execute(&st.db)
            .await?;
    }
    Ok(create_session(st, id).await?)
}

/// Discord usernames already follow linkord's rules; this only guards against legacy names.
fn normalize_username(raw: &str) -> String {
    let mut s: String = raw
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '.' { c } else { '_' })
        .collect();
    while s.contains("..") {
        s = s.replace("..", ".");
    }
    s.truncate(32);
    if s.len() < 2 {
        s.push_str("__");
    }
    s
}

pub fn result_page(message: &str) -> Html<String> {
    Html(format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>Linkord</title>
<style>body{{margin:0;height:100vh;display:grid;place-items:center;background:#0e1412;color:#e8e4d6;font:16px system-ui,sans-serif}}
.c{{text-align:center;max-width:420px;padding:24px}}h1{{font-weight:600;letter-spacing:.02em;color:#d9b65d}}</style></head>
<body><div class="c"><h1>Linkord</h1><p>{}</p></div></body></html>"#,
        message.replace('<', "&lt;")
    ))
}

#[derive(Deserialize)]
struct PollQuery {
    nonce: String,
}

async fn poll(State(st): State<AppState>, ClientIp(ip): ClientIp, Query(q): Query<PollQuery>) -> ApiResult<Json<serde_json::Value>> {
    st.limits.check(format!("poll:{ip}"), 30.0, 2.0)?;
    let token = st.pending_logins.remove(&q.nonce).filter(|(_, p)| p.created.elapsed() < LOGIN_TTL).map(|(_, p)| p.token);
    Ok(Json(json!({ "token": token })))
}

#[derive(Deserialize)]
struct DevLogin {
    username: String,
}

async fn dev_login(State(st): State<AppState>, ClientIp(ip): ClientIp, Json(body): Json<DevLogin>) -> ApiResult<Json<serde_json::Value>> {
    if !st.cfg.dev_login {
        return Err(ApiError::NotFound);
    }
    st.limits.check(format!("dev:{ip}"), 20.0, 1.0)?;
    let username = body.username.trim().to_string();
    validate_username(&username).map_err(bad)?;
    let id: Id = sqlx::query_scalar(
        "INSERT INTO users (id, discord_id, username) VALUES ($1, $2, $3)
         ON CONFLICT (discord_id) DO UPDATE SET username = EXCLUDED.username RETURNING id",
    )
    .bind(Id::new())
    .bind(format!("dev:{username}"))
    .bind(&username)
    .fetch_one(&st.db)
    .await?;
    let token = create_session(&st, id).await?;
    Ok(Json(json!({ "token": token })))
}

async fn logout(State(st): State<AppState>, parts: Parts) -> ApiResult<()> {
    if let Some(token) = parts.headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1").bind(hash_token(token)).execute(&st.db).await?;
    }
    Ok(())
}

/// Drops abandoned login attempts and expired sessions.
pub async fn sweep(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    loop {
        tick.tick().await;
        st.oauth_states.retain(|_, o| o.created.elapsed() < LOGIN_TTL);
        st.pending_logins.retain(|_, p| p.created.elapsed() < LOGIN_TTL);
        st.limits.sweep();
        if let Err(e) = sqlx::query("DELETE FROM sessions WHERE expires_at < now()").execute(&st.db).await {
            tracing::warn!("session sweep failed: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames() {
        assert!(validate_username("link.of.hyrule").is_ok());
        assert!(validate_username("zelda_99").is_ok());
        assert!(validate_username("a..b").is_err());
        assert!(validate_username("Upper").is_err());
        assert!(validate_username("x").is_err());
        assert_eq!(normalize_username("Old Name"), "old_name");
        assert_eq!(normalize_username("a..b"), "a.b");
    }
}
