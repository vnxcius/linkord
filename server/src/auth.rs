use std::time::{Duration, Instant};

use axum::extract::{FromRequestParts, Query, State};
use axum::http::header::{AUTHORIZATION, COOKIE, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue};
use axum::http::request::Parts;
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use rand::RngCore;
use sqlx::PgPool;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::direct::PublicBase;
use crate::error::{bad, ApiError, ApiResult};
use crate::id::Id;
use crate::models::validate_username;
use crate::ratelimit::ClientIp;
use crate::state::{AppState, DesktopLogin, OAuthState, PendingLogin};
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

/// An admin (LINKORD_ADMINS): may read the logs and change the music bot's picture.
pub async fn is_admin(st: &AppState, user: Id) -> bool {
    if st.cfg.admins.is_empty() {
        return false;
    }
    let row: Option<(String, String, Option<String>)> =
        sqlx::query_as("SELECT username, discord_id, discord_username FROM users WHERE id = $1 AND deleted_at IS NULL AND NOT bot")
            .bind(user)
            .fetch_optional(&st.db)
            .await
            .ok()
            .flatten();
    let Some((username, discord_id, discord_username)) = row else { return false };
    let id = user.to_string();
    // Names are matched against the Discord username: Linkord usernames can be changed, so someone could take an
    // admin's old one. (Dev-login accounts have no Discord username; they can't sign in when dev login is off.)
    let name = discord_username.map(|n| n.to_lowercase()).or_else(|| discord_id.starts_with("dev:").then_some(username));
    st.cfg.admins.iter().any(|a| Some(a) == name.as_ref() || *a == discord_id || *a == id)
}

/// Same as [`AuthUser`], for admins only.
pub struct AdminUser(#[allow(dead_code)] pub Id);

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Self::Rejection> {
        let AuthUser(me) = AuthUser::from_request_parts(parts, st).await?;
        if is_admin(st, me).await {
            Ok(AdminUser(me))
        } else {
            Err(ApiError::Forbidden)
        }
    }
}

pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

pub fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub async fn user_from_token(st: &AppState, token: &str) -> ApiResult<Option<Id>> {
    Ok(sqlx::query_scalar::<_, Id>(
        "SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND u.suspended_at IS NULL",
    )
        .bind(hash_token(token))
        .fetch_optional(&st.db)
        .await?)
}

async fn create_session(st: &AppState, user: Id) -> ApiResult<String> {
    tracing::info!(user = %user, "signed in");
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
        .route("/auth/exchange", post(exchange))
        .route("/auth/dev", post(dev_login))
        .route("/auth/logout", post(logout))
        .route("/auth/logout-all", post(logout_all))
}

async fn auth_config(State(st): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({ "discord": st.cfg.discord_enabled(), "dev_login": st.cfg.dev_login, "spotify": st.cfg.spotify_enabled() }))
}

#[derive(Deserialize)]
struct StartQuery {
    /// Desktop apps before the local callback, which got their session by polling. Whoever chose the nonce got the
    /// session of whoever opened the link, so that way of signing in is gone.
    nonce: Option<String>,
    /// The desktop app's local callback (see `DesktopLogin`).
    port: Option<u16>,
    state: Option<String>,
    challenge: Option<String>,
    invite: Option<String>,
}

const LOGIN_COOKIE: &str = "linkord_login";

async fn discord_start(State(st): State<AppState>, base: PublicBase, ClientIp(ip): ClientIp, Query(q): Query<StartQuery>) -> ApiResult<Response> {
    st.limits.check(format!("login:{ip}"), 10.0, 0.2)?;
    if !st.cfg.discord_enabled() {
        return Err(bad("Discord login is not configured on this server"));
    }
    if q.nonce.is_some() {
        return Ok(result_page("This version of Linkord can't sign in any more. Restart it to update, then try again.").into_response());
    }
    let long_enough = |v: &str| (32..=128).contains(&v.len()) && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    let desktop = match (q.port, q.state, q.challenge) {
        (None, None, None) => None,
        (Some(port), Some(state), Some(challenge)) if port >= 1024 && long_enough(&state) && long_enough(&challenge) => {
            Some(DesktopLogin { port, state, challenge })
        }
        _ => return Err(bad("invalid sign-in request")),
    };
    let state = random_token(24);
    // Only people already signed in to Linkord on Discord skip the consent screen, and only in the browser client:
    // the desktop flow always shows it.
    let prompt = if desktop.is_some() { "" } else { "&prompt=none" };
    let invite = q.invite.filter(|c| c.len() <= 64);
    st.oauth_states.insert(state.clone(), OAuthState { desktop, invite, created: Instant::now() });
    let url = format!(
        "https://discord.com/oauth2/authorize?client_id={}&response_type=code&scope=identify{prompt}&redirect_uri={}&state={}",
        st.cfg.discord_client_id,
        urlencoding::encode(&redirect_uri(&base)),
        state
    );
    // The callback must come back to the browser that started this.
    let secure = if base.to_string().starts_with("https:") { "; Secure" } else { "" };
    let cookie = format!("{LOGIN_COOKIE}={state}; Path=/api/auth; Max-Age={}; HttpOnly; SameSite=Lax{secure}", LOGIN_TTL.as_secs());
    let mut res = Redirect::to(&url).into_response();
    res.headers_mut().insert(SET_COOKIE, HeaderValue::from_str(&cookie).map_err(anyhow::Error::from)?);
    Ok(res)
}

fn login_cookie(headers: &HeaderMap) -> Option<&str> {
    headers.get(COOKIE)?.to_str().ok()?.split(';').find_map(|c| c.trim().strip_prefix(LOGIN_COOKIE)?.strip_prefix('='))
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

/// Why a sign-in was refused, in words for the person.
#[derive(Debug, thiserror::Error)]
enum Refused {
    #[error("Linkord is invite-only. Open an invite link from a friend in this browser, then sign in.")]
    NotInvited,
    #[error("New accounts aren't being created right now.")]
    Closed,
    #[error("This account has been suspended.")]
    Suspended,
}

async fn discord_callback(State(st): State<AppState>, base: PublicBase, ClientIp(ip): ClientIp, headers: HeaderMap, Query(q): Query<CallbackQuery>) -> Response {
    if st.limits.check(format!("login:{ip}"), 10.0, 0.2).is_err() {
        return result_page("Too many sign-in attempts. Please wait a minute and try again.").into_response();
    }
    if q.state.is_none() || q.state.as_deref() != login_cookie(&headers) {
        return result_page("This login link expired. Please try again from Linkord.").into_response();
    }
    let oauth = match q.state.as_deref().and_then(|s| st.oauth_states.remove(s)) {
        Some((_, o)) if o.created.elapsed() < LOGIN_TTL => o,
        _ => return result_page("This login link expired. Please try again from Linkord.").into_response(),
    };
    let Some(code) = q.code.filter(|_| q.error.is_none()) else {
        return result_page("Discord login was cancelled.").into_response();
    };
    let user = match finish_discord_login(&st, &code, &base, oauth.invite.as_deref()).await {
        Ok(u) => u,
        Err(e) => {
            if let Some(refused) = e.downcast_ref::<Refused>() {
                return result_page(&refused.to_string()).into_response();
            }
            tracing::warn!("discord login failed: {e:#}");
            return result_page("Could not sign in with Discord. Please try again.").into_response();
        }
    };
    match oauth.desktop {
        // Only the app listening on this computer gets the code, so a link someone else sends can't sign them in.
        Some(d) => {
            let code = random_token(32);
            st.pending_logins.insert(code.clone(), PendingLogin { user, challenge: d.challenge, created: Instant::now() });
            Redirect::to(&format!("http://127.0.0.1:{}/login?code={code}&state={}", d.port, d.state)).into_response()
        }
        None => match create_session(&st, user).await {
            Ok(token) => Redirect::to(&format!("{base}/#token={token}")).into_response(),
            Err(_) => result_page("Could not sign in with Discord. Please try again.").into_response(),
        },
    }
}

async fn finish_discord_login(st: &AppState, code: &str, base: &PublicBase, invite: Option<&str>) -> anyhow::Result<Id> {
    let tok: DiscordToken = st
        .http
        .post(format!("{}/api/oauth2/token", st.cfg.discord_api_url))
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
        .get(format!("{}/api/v10/users/@me", st.cfg.discord_api_url))
        .bearer_auth(&tok.access_token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    check_signup(st, &du.id, invite).await?;
    let (id, inserted) = sign_up_or_in(&st.db, &du.id, &normalize_username(&du.username), Some(&du.username)).await?;
    if inserted {
        sqlx::query("UPDATE users SET display_name = $2, accent_color = $3 WHERE id = $1")
            .bind(id)
            .bind(&du.global_name)
            .bind(du.accent_color)
            .execute(&st.db)
            .await?;
    }

    // Profile pictures are copied from Discord once, on first login. After that the profile is linkord's own.
    if inserted {
        let ext = |h: &str| if h.starts_with("a_") { "gif" } else { "png" };
        let avatar_url = match &du.avatar {
            Some(h) => format!("{}/avatars/{}/{h}.{}?size=256", st.cfg.discord_cdn_url, du.id, ext(h)),
            None => {
                let idx = du.id.parse::<u64>().map(|i| (i >> 22) % 6).unwrap_or(0);
                format!("{}/embed/avatars/{idx}.png", st.cfg.discord_cdn_url)
            }
        };
        let avatar = uploads::mirror(st, &avatar_url, &format!("avatars/{id}")).await;
        let banner = match &du.banner {
            Some(h) => {
                let url = format!("{}/banners/{}/{h}.{}?size=600", st.cfg.discord_cdn_url, du.id, ext(h));
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
    Ok(id)
}

/// Whether this Discord account may sign in: existing accounts unless suspended, new ones per LINKORD_SIGNUP.
async fn check_signup(st: &AppState, discord_id: &str, invite: Option<&str>) -> anyhow::Result<()> {
    let existing: Option<Option<chrono::DateTime<chrono::Utc>>> =
        sqlx::query_scalar("SELECT suspended_at FROM users WHERE discord_id = $1").bind(discord_id).fetch_optional(&st.db).await?;
    match existing {
        Some(Some(_)) => Err(Refused::Suspended.into()),
        Some(None) => Ok(()),
        None => match st.cfg.signup.as_str() {
            "open" => Ok(()),
            "closed" => Err(Refused::Closed.into()),
            _ => match invite {
                Some(code) if crate::api::invites::is_valid(st, code).await? => Ok(()),
                _ => Err(Refused::NotInvited.into()),
            },
        },
    }
}

/// Someone other than `except` (deleted accounts don't count) already has this username.
pub async fn username_taken(db: &PgPool, name: &str, except: Option<Id>) -> sqlx::Result<bool> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE username = $1 AND deleted_at IS NULL AND id IS DISTINCT FROM $2)")
        .bind(name)
        .bind(except)
        .fetch_one(db)
        .await
}

/// Finds or creates the account for `discord_id` -> (id, newly created). New accounts take `wanted` as their
/// username; if someone has it, they get a free stand-in ("name_1234") and must pick their own (needs_username).
/// Existing accounts follow their Discord username until they pick one in Linkord, as long as it's free.
async fn sign_up_or_in(db: &PgPool, discord_id: &str, wanted: &str, discord_username: Option<&str>) -> sqlx::Result<(Id, bool)> {
    let existing: Option<(Id, String, bool)> = sqlx::query_as("SELECT id, username, username_set FROM users WHERE discord_id = $1")
        .bind(discord_id)
        .fetch_optional(db)
        .await?;
    if let Some((id, username, set)) = existing {
        let follow = !set && username != wanted && !username_taken(db, wanted, Some(id)).await?;
        sqlx::query("UPDATE users SET username = $2, discord_username = COALESCE($3, discord_username) WHERE id = $1")
            .bind(id)
            .bind(if follow { wanted } else { username.as_str() })
            .bind(discord_username)
            .execute(db)
            .await?;
        return Ok((id, false));
    }
    let taken = username_taken(db, wanted, None).await?;
    let username = if taken { stand_in(db, wanted).await? } else { wanted.to_string() };
    let id: Id = sqlx::query_scalar(
        "INSERT INTO users (id, discord_id, username, discord_username, needs_username) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (discord_id) DO UPDATE SET discord_username = EXCLUDED.discord_username RETURNING id",
    )
    .bind(Id::new())
    .bind(discord_id)
    .bind(&username)
    .bind(discord_username)
    .bind(taken)
    .fetch_one(db)
    .await?;
    if taken {
        tracing::info!(user = %id, "signed up with a taken username: asked to pick another");
    }
    Ok((id, true))
}

/// A free "name_1234" for a new account whose username is taken.
async fn stand_in(db: &PgPool, base: &str) -> sqlx::Result<String> {
    let mut base = base.to_string();
    base.truncate(27);
    loop {
        let name = format!("{base}_{:04}", rand::thread_rng().next_u32() % 10_000);
        if !username_taken(db, &name, None).await? {
            return Ok(name);
        }
    }
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
struct Exchange {
    code: String,
    verifier: String,
}

/// The desktop app swaps the code its local callback received, plus the secret behind the sign-in's challenge, for a
/// session.
async fn exchange(State(st): State<AppState>, ClientIp(ip): ClientIp, Json(b): Json<Exchange>) -> ApiResult<Json<serde_json::Value>> {
    st.limits.check(format!("exchange:{ip}"), 10.0, 0.5)?;
    let pending = st.pending_logins.remove(&b.code).filter(|(_, p)| p.created.elapsed() < LOGIN_TTL).map(|(_, p)| p);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(b.verifier.as_bytes()));
    let pending = pending.filter(|p| p.challenge == challenge).ok_or(ApiError::Unauthorized)?;
    let token = create_session(&st, pending.user).await?;
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
    let (id, _) = sign_up_or_in(&st.db, &format!("dev:{username}"), &username, None).await?;
    let token = create_session(&st, id).await?;
    Ok(Json(json!({ "token": token })))
}

async fn logout(State(st): State<AppState>, parts: Parts) -> ApiResult<()> {
    if let Some(token) = parts.headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")) {
        let hash = hash_token(token);
        let user: Option<Id> = sqlx::query_scalar("DELETE FROM sessions WHERE token_hash = $1 RETURNING user_id").bind(&hash).fetch_optional(&st.db).await?;
        // What this session has open ends with it.
        st.hub.close_token(&hash);
        if let Some(user) = user {
            crate::voice::close_token(&st, user, &hash).await;
        }
    }
    Ok(())
}

/// Signs the user out everywhere, for when a device or a session was lost.
async fn logout_all(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<()> {
    end_sessions(&st, me).await
}

/// Deletes every session of the user and closes what they have open.
pub async fn end_sessions(st: &AppState, user: Id) -> ApiResult<()> {
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(user).execute(&st.db).await?;
    st.hub.close_user(user);
    crate::voice::leave(st, user).await;
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
