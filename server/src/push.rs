//! Web Push: notifications on phones (the installed web app) and in browsers while Linkord isn't open.
//!
//! Standard Web Push (RFC 8030), so no Firebase or any account: the browser gives us an endpoint at its vendor's push
//! service (Google, Mozilla, Apple, Microsoft) and two keys. We encrypt each notification for that browser only
//! (RFC 8291, aes128gcm: the push service can't read it) and sign the request with our own key (VAPID, RFC 8292;
//! generated on first start into <data>/push-vapid.key).
//!
//! Who gets one follows the app's own rules (gateway.ts onMessage): DMs, mentions, replies, @everyone, and every
//! message in channels set to "All messages"; never while muted ("Nothing", muted channel/server except direct
//! mentions), in Do Not Disturb, from someone blocked, or while the person is using Linkord on another device
//! (a session that reported activity in the last ACTIVE_WINDOW and isn't in the background, gateway.rs in_use).
//! Endpoints must be at a known push service (SSRF: the server POSTs to them).

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine as _;
use p256::ecdsa::signature::Signer as _;
use p256::elliptic_curve::sec1::ToEncodedPoint as _;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::AuthUser;
use crate::error::{bad, ApiError, ApiResult};
use crate::id::Id;
use crate::models::{kind, Channel, Message};
use crate::state::AppState;

/// Someone using Linkord on another device (input in the last few minutes, window not in the background) gets no push.
pub const ACTIVE_WINDOW: Duration = Duration::from_secs(5 * 60);
/// One person's subscriptions; past this the oldest goes.
const MAX_PER_USER: i64 = 10;
/// Push services keep an undelivered message this long (phone off, no signal).
const MESSAGE_TTL: u32 = 24 * 3600;
const CALL_TTL: u32 = 60;
const BODY_CHARS: usize = 200;

/// Push services browsers use. Endpoints anywhere else are refused.
const PUSH_HOSTS: &[&str] = &["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

struct Vapid {
    key: p256::ecdsa::SigningKey,
    /// Uncompressed public key, base64url: the browser's applicationServerKey and the `k` of each request.
    public: String,
}

static VAPID: OnceLock<Vapid> = OnceLock::new();

/// Loads (or creates) the signing key. Call once at startup.
pub fn init(st: &AppState) -> anyhow::Result<()> {
    let path = st.cfg.data_dir.join("push-vapid.key");
    let secret = match std::fs::read_to_string(&path) {
        Ok(hex) => p256::SecretKey::from_slice(&hex::decode(hex.trim())?)?,
        Err(_) => {
            let key = p256::SecretKey::random(&mut rand::rngs::OsRng);
            std::fs::create_dir_all(&st.cfg.data_dir)?;
            std::fs::write(&path, hex::encode(key.to_bytes()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
            }
            tracing::info!("push: created the signing key");
            key
        }
    };
    let public = B64.encode(secret.public_key().to_encoded_point(false).as_bytes());
    let _ = VAPID.set(Vapid { key: p256::ecdsa::SigningKey::from(secret), public });
    Ok(())
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/push/key", get(public_key))
        .route("/push/subscriptions", post(subscribe).delete(unsubscribe))
        .route("/push/test", post(test))
        .route("/push/received", post(received))
}

async fn public_key() -> ApiResult<Json<Value>> {
    let v = VAPID.get().ok_or_else(|| anyhow::anyhow!("push isn't set up"))?;
    Ok(Json(json!({ "public_key": v.public })))
}

#[derive(Deserialize)]
struct Keys {
    p256dh: String,
    auth: String,
}

#[derive(Deserialize)]
struct Subscribe {
    endpoint: String,
    keys: Keys,
    #[serde(default)]
    lang: Option<String>,
}

fn login_of(headers: &HeaderMap) -> ApiResult<Vec<u8>> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(ApiError::Unauthorized)?;
    Ok(crate::auth::hash_token(token))
}

/// Extra hosts (with port) allowed as endpoints, over plain HTTP too: LINKORD_PUSH_HOSTS, for tests.
fn extra_hosts() -> &'static Vec<String> {
    static H: OnceLock<Vec<String>> = OnceLock::new();
    H.get_or_init(|| std::env::var("LINKORD_PUSH_HOSTS").unwrap_or_default().split(',').map(|h| h.trim().to_string()).filter(|h| !h.is_empty()).collect())
}

fn allowed_endpoint(endpoint: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(endpoint) else { return false };
    let Some(host) = url.host_str() else { return false };
    let with_port = match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    };
    if extra_hosts().contains(&with_port) {
        return true;
    }
    url.scheme() == "https" && url.port().is_none() && PUSH_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

async fn subscribe(State(st): State<AppState>, AuthUser(me): AuthUser, headers: HeaderMap, Json(b): Json<Subscribe>) -> ApiResult<StatusCode> {
    if b.endpoint.len() > 1024 || !allowed_endpoint(&b.endpoint) {
        return Err(bad("this browser's push service isn't supported"));
    }
    let p256dh = B64.decode(b.keys.p256dh.trim_end_matches('=')).map_err(|_| bad("bad subscription keys"))?;
    let auth = B64.decode(b.keys.auth.trim_end_matches('=')).map_err(|_| bad("bad subscription keys"))?;
    if auth.len() != 16 || p256::PublicKey::from_sec1_bytes(&p256dh).is_err() {
        return Err(bad("bad subscription keys"));
    }
    let lang = if b.lang.as_deref().is_some_and(|l| l.starts_with("pt")) { "pt-BR" } else { "en" };
    let session = login_of(&headers)?;
    sqlx::query(
        "INSERT INTO push_subscriptions (endpoint, user_id, session, p256dh, auth, lang) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = $2, session = $3, p256dh = $4, auth = $5, lang = $6",
    )
    .bind(&b.endpoint)
    .bind(me)
    .bind(&session)
    .bind(&p256dh)
    .bind(&auth)
    .bind(lang)
    .execute(&st.db)
    .await?;
    sqlx::query(
        "DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint NOT IN
           (SELECT endpoint FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2)",
    )
    .bind(me)
    .bind(MAX_PER_USER)
    .execute(&st.db)
    .await?;
    tracing::info!(user = %me, service = service_of(&b.endpoint), "push: subscribed");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Unsubscribe {
    endpoint: String,
}

async fn unsubscribe(State(st): State<AppState>, AuthUser(me): AuthUser, Json(b): Json<Unsubscribe>) -> ApiResult<StatusCode> {
    sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2").bind(&b.endpoint).bind(me).execute(&st.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// "Send a test" in Settings: to this login's subscriptions, whether or not they're using Linkord right now.
#[derive(Deserialize, Default)]
struct TestBody {
    /// Seconds to wait first (at most 30), so the app can be closed and the test arrives like a real one.
    #[serde(default)]
    delay: u64,
}

async fn test(State(st): State<AppState>, AuthUser(me): AuthUser, headers: HeaderMap, body: Option<Json<TestBody>>) -> ApiResult<Json<Value>> {
    st.limits.check(format!("pushtest:{me}"), 5.0, 0.1)?;
    let session = login_of(&headers)?;
    let subs = subscriptions(&st, "session = $1", &session).await?;
    if subs.is_empty() {
        return Err(bad("notifications aren't on for this device"));
    }
    let delay = body.map(|b| b.delay).unwrap_or(0).min(30);
    let count = subs.len();
    let job = async move {
        let mut sent = 0;
        for s in subs {
            let (title, body) = words(&s.lang, Words::Test);
            // Its own tag each time: a test never just replaces the previous one quietly.
            let payload = json!({ "title": title, "body": body, "tag": format!("test-{}", chrono::Utc::now().timestamp_millis()), "url": "/channels/@me" });
            if send(&st, &s, &payload, 60, "high", None).await {
                sent += 1;
            }
        }
        sent
    };
    if delay == 0 {
        return Ok(Json(json!({ "sent": job.await })));
    }
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(delay)).await;
        job.await;
    });
    Ok(Json(json!({ "sent": count, "delay": delay })))
}

#[derive(Deserialize)]
struct Received {
    endpoint: String,
    /// Shown, or why not (showNotification threw).
    shown: bool,
    #[serde(default)]
    error: Option<String>,
    /// Linkord was on screen when it arrived (some browsers don't show notifications for the site you're looking at).
    #[serde(default)]
    visible: Option<bool>,
    /// How many of the site's notifications the browser lists right after showing it (0 = it dropped it).
    #[serde(default)]
    listed: Option<u32>,
    #[serde(default)]
    browser: Option<String>,
}

/// The service worker reports each push it got (sw.js): "Google accepted it" and "the phone showed it" are different
/// things, and only the device knows the second. No login there (a service worker has no token): the endpoint, which
/// only that browser and we know, says who it is.
async fn received(State(st): State<AppState>, Json(b): Json<Received>) -> ApiResult<StatusCode> {
    let user: Option<Id> = sqlx::query_scalar("SELECT user_id FROM push_subscriptions WHERE endpoint = $1").bind(&b.endpoint).fetch_optional(&st.db).await?;
    let Some(user) = user else { return Ok(StatusCode::NO_CONTENT) };
    let error: String = b.error.unwrap_or_default().chars().take(200).collect();
    let browser: String = b.browser.unwrap_or_default().chars().take(160).collect();
    let (visible, listed) = (b.visible.map_or("?".into(), |v| v.to_string()), b.listed.map_or("?".into(), |n| n.to_string()));
    if b.shown {
        tracing::info!(user = %user, visible, listed, browser, "push: the device got it and showed it");
    } else {
        tracing::warn!(user = %user, error, visible, browser, "push: the device got it but couldn't show it");
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(sqlx::FromRow)]
struct Sub {
    endpoint: String,
    user_id: Id,
    p256dh: Vec<u8>,
    auth: Vec<u8>,
    lang: String,
}

async fn subscriptions<T>(st: &AppState, filter: &str, value: T) -> ApiResult<Vec<Sub>>
where
    T: for<'q> sqlx::Encode<'q, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send,
{
    Ok(sqlx::query_as::<_, Sub>(&format!("SELECT endpoint, user_id, p256dh, auth, lang FROM push_subscriptions WHERE {filter}")).bind(value).fetch_all(&st.db).await?)
}

enum Words {
    Attachment,
    Forwarded,
    Calling,
    Test,
}

/// The few words the server writes itself, in the language the device chose.
fn words(lang: &str, w: Words) -> (&'static str, &'static str) {
    let pt = lang == "pt-BR";
    match w {
        Words::Attachment => ("", if pt { "Enviou um anexo" } else { "Sent an attachment" }),
        Words::Forwarded => ("", if pt { "Encaminhou uma mensagem" } else { "Forwarded a message" }),
        Words::Calling => ("", if pt { "está te ligando" } else { "is calling you" }),
        Words::Test => ("Linkord", if pt { "As notificações estão funcionando neste dispositivo." } else { "Notifications work on this device." }),
    }
}

// ---------- who gets a notification ----------

/// A new message: notifications for the people it should reach who aren't in Linkord right now.
pub fn on_message(st: &AppState, ch: &Channel, msg: &Message, audience: &[Id]) {
    if msg.ephemeral || msg.kind != crate::models::message_type::DEFAULT {
        return;
    }
    let (st, ch, msg) = (st.clone(), ch.clone(), msg.clone());
    let audience: Vec<Id> = audience.iter().copied().filter(|u| *u != msg.author.id).collect();
    tokio::spawn(async move {
        if let Err(e) = message_pushes(&st, &ch, &msg, &audience).await {
            tracing::warn!("push: {e:?}");
        }
    });
}

async fn message_pushes(st: &AppState, ch: &Channel, msg: &Message, audience: &[Id]) -> ApiResult<()> {
    // Most people have no subscription: that's one query and done.
    let subs = subscriptions(st, "user_id = ANY($1)", audience).await?;
    if subs.is_empty() {
        return Ok(());
    }
    let candidates: Vec<Id> = subs.iter().map(|s| s.user_id).collect::<HashSet<_>>().into_iter().collect();
    let private = kind::is_private(ch.kind);
    let direct: HashSet<Id> = mention_ids(&msg.content, "<@").into_iter().collect();
    let roles = mention_ids(&msg.content, "<@&");
    let role_mentioned: HashSet<Id> = match (ch.guild_id, roles.is_empty()) {
        (Some(g), false) => sqlx::query_scalar("SELECT DISTINCT user_id FROM member_roles WHERE guild_id = $1 AND role_id = ANY($2) AND user_id = ANY($3)")
            .bind(g)
            .bind(&roles)
            .bind(&candidates)
            .fetch_all(&st.db)
            .await?
            .into_iter()
            .collect(),
        _ => HashSet::new(),
    };
    let statuses: HashMap<Id, String> =
        sqlx::query_as::<_, (Id, String)>("SELECT id, status FROM users WHERE id = ANY($1)").bind(&candidates).fetch_all(&st.db).await?.into_iter().collect();
    // A thread follows its channel, which follows its category.
    let parent = match ch.parent_id {
        Some(p) => Some((p, sqlx::query_scalar::<_, Option<Id>>("SELECT parent_id FROM channels WHERE id = $1").bind(p).fetch_optional(&st.db).await?.flatten())),
        None => None,
    };
    let mut reach = Vec::new();
    // Why someone didn't get one, logged (ids only, never the message): "I got nothing" is answerable from the logs.
    let skip = |user: Id, why: &str| tracing::info!(user = %user, channel = %ch.id, reason = why, "push: not sent");
    for user in candidates {
        if statuses.get(&user).is_some_and(|s| s == "dnd") {
            skip(user, "do not disturb");
            continue;
        }
        if st.hub.in_use(user, ACTIVE_WINDOW) {
            skip(user, "using Linkord on another device");
            continue;
        }
        if crate::api::relationships::blocked_between(&st.db, user, msg.author.id).await? {
            skip(user, "blocked");
            continue;
        }
        let settings = crate::api::settings::load(&st.db, user).await?;
        let listed = |key: &str, id: Id| settings[key].as_array().is_some_and(|a| a.iter().any(|v| v.as_str() == Some(&id.to_string())));
        let is_direct = direct.contains(&user);
        let mentioned = private
            || is_direct
            || role_mentioned.contains(&user)
            || msg.mention_everyone
            || msg.referenced_message.as_ref().is_some_and(|r| r.author.id == user);
        let level = if private { "all".to_string() } else { level_for(&settings, ch, parent) };
        let muted = listed("muted_channels", ch.id) || ch.parent_id.is_some_and(|p| listed("muted_channels", p)) || ch.guild_id.is_some_and(|g| listed("muted_guilds", g));
        if level == "none" || (muted && !is_direct) {
            skip(user, if level == "none" { "notifications set to nothing" } else { "muted" });
            continue;
        }
        if !mentioned && (level != "all" || msg.author.bot) {
            skip(user, if msg.author.bot { "bot message without a mention" } else { "mentions only" });
            continue;
        }
        reach.push((user, mentioned));
    }
    if reach.is_empty() {
        return Ok(());
    }
    let (title, body, icon, url) = describe(st, ch, msg).await?;
    for (user, mentioned) in reach {
        for s in subs.iter().filter(|s| s.user_id == user) {
            let body = if body.is_empty() {
                words(&s.lang, if msg.forwarded.is_some() { Words::Forwarded } else { Words::Attachment }).1.to_string()
            } else {
                body.clone()
            };
            let payload = json!({ "title": title, "body": body, "icon": icon, "tag": ch.id, "url": url, "channel_id": ch.id, "message_id": msg.id });
            send(st, s, &payload, MESSAGE_TTL, if mentioned { "high" } else { "normal" }, Some(&ch.id.to_string())).await;
        }
    }
    Ok(())
}

/// The channel's notification level for someone, like the app's notifyLevel: its own, its parent's, its
/// grandparent's, the server's, else 'all'.
fn level_for(settings: &Value, ch: &Channel, parent: Option<(Id, Option<Id>)>) -> String {
    let own = &settings["channel_notifications"];
    let pick = |id: Id| own[id.to_string()].as_str().map(str::to_string);
    pick(ch.id)
        .or_else(|| parent.and_then(|(p, _)| pick(p)))
        .or_else(|| parent.and_then(|(_, gp)| gp).and_then(pick))
        .or_else(|| ch.guild_id.and_then(|g| settings["guild_notifications"][g.to_string()].as_str().map(str::to_string)))
        .unwrap_or_else(|| "all".into())
}

/// `<@123>` (or `<@&123>` for roles) ids in a message.
fn mention_ids(content: &str, prefix: &str) -> Vec<Id> {
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(i) = rest.find(prefix) {
        rest = &rest[i + prefix.len()..];
        // `<@&` also starts with `<@`: skip roles when looking for people.
        if prefix == "<@" && rest.starts_with('&') {
            continue;
        }
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() && rest[digits.len()..].starts_with('>') {
            if let Ok(id) = digits.parse() {
                out.push(Id(id));
            }
        }
    }
    out
}

/// Title, text (mentions and emoji written out), icon and where a click goes.
async fn describe(st: &AppState, ch: &Channel, msg: &Message) -> ApiResult<(String, String, String, String)> {
    let author = name_in(st, msg.author.id, ch.guild_id).await;
    let title = match ch.guild_id {
        Some(g) => {
            let server: String = sqlx::query_scalar("SELECT name FROM guilds WHERE id = $1").bind(g).fetch_optional(&st.db).await?.unwrap_or_default();
            format!("{author} (#{}, {server})", ch.name)
        }
        None if ch.kind == kind::GROUP_DM && !ch.name.is_empty() => format!("{author} ({})", ch.name),
        None => author,
    };
    let mut body = msg.content.clone();
    for id in mention_ids(&msg.content, "<@") {
        body = body.replace(&format!("<@{id}>"), &format!("@{}", name_in(st, id, ch.guild_id).await));
    }
    for id in mention_ids(&msg.content, "<@&") {
        let role: Option<String> = sqlx::query_scalar("SELECT name FROM roles WHERE id = $1").bind(id).fetch_optional(&st.db).await?;
        body = body.replace(&format!("<@&{id}>"), &format!("@{}", role.unwrap_or_default()));
    }
    for id in mention_ids(&msg.content, "<#") {
        let name: Option<String> = sqlx::query_scalar("SELECT name FROM channels WHERE id = $1").bind(id).fetch_optional(&st.db).await?;
        body = body.replace(&format!("<#{id}>"), &format!("#{}", name.unwrap_or_default()));
    }
    let body = custom_emoji(&body);
    let body: String = body.trim().chars().take(BODY_CHARS).collect();
    let icon = msg.author.avatar.clone().unwrap_or_else(|| "/icon.png".into());
    let url = format!("/channels/{}/{}", ch.guild_id.map_or("@me".to_string(), |g| g.to_string()), ch.id);
    Ok((title, body, icon, url))
}

/// `<:name:123>` / `<a:name:123>` -> `:name:`.
fn custom_emoji(s: &str) -> String {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"<a?:(\w+):\d+>").unwrap()).replace_all(s, ":$1:").into_owned()
}

/// What the app calls someone: their server nickname, display name or username.
async fn name_in(st: &AppState, user: Id, guild: Option<Id>) -> String {
    sqlx::query_scalar(
        "SELECT COALESCE(m.nickname, u.display_name, u.username) FROM users u LEFT JOIN members m ON m.user_id = u.id AND m.guild_id = $2 WHERE u.id = $1",
    )
    .bind(user)
    .bind(guild)
    .fetch_optional(&st.db)
    .await
    .ok()
    .flatten()
    .unwrap_or_default()
}

/// A DM call ringing `users`: their phones ring too (unless they're in Linkord already, where the app rings).
pub fn on_ring(st: &AppState, channel: Id, caller: Id, users: Vec<Id>) {
    let st = st.clone();
    tokio::spawn(async move {
        let subs = match subscriptions(&st, "user_id = ANY($1)", &users).await {
            Ok(s) => s,
            Err(e) => return tracing::warn!("push: {e:?}"),
        };
        if subs.is_empty() {
            return;
        }
        let name = name_in(&st, caller, None).await;
        let icon: Option<String> = sqlx::query_scalar("SELECT avatar FROM users WHERE id = $1").bind(caller).fetch_optional(&st.db).await.ok().flatten().flatten();
        let dnd: HashSet<Id> = sqlx::query_scalar("SELECT id FROM users WHERE id = ANY($1) AND status = 'dnd'").bind(&users).fetch_all(&st.db).await.unwrap_or_default().into_iter().collect();
        for s in subs.iter().filter(|s| !dnd.contains(&s.user_id) && !st.hub.in_use(s.user_id, ACTIVE_WINDOW)) {
            let payload = json!({
                "title": name,
                "body": words(&s.lang, Words::Calling).1,
                "icon": icon.clone().unwrap_or_else(|| "/icon.png".into()),
                "tag": format!("call-{channel}"),
                "url": format!("/channels/@me/{channel}"),
                "channel_id": channel,
                "call": true,
            });
            send(&st, s, &payload, CALL_TTL, "high", None).await;
        }
    });
}

// ---------- sending (RFC 8291 encryption, RFC 8292 VAPID) ----------

/// Sends one notification. True if the push service took it. A subscription the service says is gone is deleted.
async fn send(st: &AppState, s: &Sub, payload: &Value, ttl: u32, urgency: &str, topic: Option<&str>) -> bool {
    let Some(vapid) = VAPID.get() else { return false };
    let Ok(body) = encrypt(&s.p256dh, &s.auth, payload.to_string().as_bytes()) else {
        tracing::warn!(user = %s.user_id, "push: couldn't encrypt for a subscription");
        return false;
    };
    let Ok(url) = reqwest::Url::parse(&s.endpoint) else { return false };
    let audience = url.origin().ascii_serialization();
    let jwt = vapid_jwt(vapid, &audience, &st.cfg.public_url);
    let mut req = st
        .http
        .post(url)
        .header("TTL", ttl.to_string())
        .header("Urgency", urgency)
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("Authorization", format!("vapid t={jwt}, k={}", vapid.public))
        .timeout(Duration::from_secs(10))
        .body(body);
    if let Some(t) = topic {
        // Undelivered ones for the same channel replace each other (a phone off for a day gets the latest).
        req = req.header("Topic", t);
    }
    match req.send().await {
        Ok(r) if r.status().is_success() => {
            tracing::info!(user = %s.user_id, service = service_of(&s.endpoint), status = r.status().as_u16(), "push: sent");
            let _ = sqlx::query("UPDATE push_subscriptions SET last_ok_at = now() WHERE endpoint = $1").bind(&s.endpoint).execute(&st.db).await;
            true
        }
        Ok(r) if matches!(r.status().as_u16(), 404 | 410) => {
            tracing::info!(user = %s.user_id, "push: subscription expired, removed");
            let _ = sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = $1").bind(&s.endpoint).execute(&st.db).await;
            false
        }
        Ok(r) => {
            let status = r.status().as_u16();
            // Push services explain refusals in the body (e.g. Apple's {"reason":"BadJwtToken"}); it holds no secrets.
            let why: String = r.text().await.unwrap_or_default().chars().take(200).collect();
            tracing::warn!(user = %s.user_id, service = service_of(&s.endpoint), status, why, "push: the push service refused a notification");
            false
        }
        Err(e) => {
            tracing::warn!(user = %s.user_id, "push: couldn't reach the push service: {}", e.without_url());
            false
        }
    }
}

/// Which push service an endpoint is at (its host), for logs: never the endpoint itself, which works like a password.
fn service_of(endpoint: &str) -> String {
    reqwest::Url::parse(endpoint).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default()
}

/// The VAPID token for one push service (`aud` = its origin), valid 12 hours.
fn vapid_jwt(v: &Vapid, audience: &str, public_url: &str) -> String {
    let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let exp = chrono::Utc::now().timestamp() + 12 * 3600;
    // Apple wants a contact: the site's address is one.
    let sub = if public_url.starts_with("https://") { public_url.to_string() } else { "mailto:admin@localhost".to_string() };
    let claims = B64.encode(json!({ "aud": audience, "exp": exp, "sub": sub }).to_string());
    let signing_input = format!("{header}.{claims}");
    let sig: p256::ecdsa::Signature = v.key.sign(signing_input.as_bytes());
    format!("{signing_input}.{}", B64.encode(sig.to_bytes()))
}

/// RFC 8291 + RFC 8188 (aes128gcm), one record: salt | rs | keyid length | our public key | ciphertext.
fn encrypt(ua_public: &[u8], auth_secret: &[u8], plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
    use hkdf::Hkdf;
    use rand::RngCore as _;
    use sha2::Sha256;
    let ua = p256::PublicKey::from_sec1_bytes(ua_public)?;
    let ephemeral = p256::ecdh::EphemeralSecret::random(&mut rand::rngs::OsRng);
    let as_public = ephemeral.public_key().to_encoded_point(false);
    let shared = ephemeral.diffie_hellman(&ua);
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public.as_bytes());
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth_secret), shared.raw_secret_bytes()).expand(&key_info, &mut ikm).map_err(|_| anyhow::anyhow!("hkdf"))?;
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let prk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).map_err(|_| anyhow::anyhow!("hkdf"))?;
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce).map_err(|_| anyhow::anyhow!("hkdf"))?;
    // The last (and only) record ends with the 0x02 delimiter.
    let mut record = plaintext.to_vec();
    record.push(2);
    let cipher = aes_gcm::Aes128Gcm::new_from_slice(&cek)?;
    let sealed = cipher.encrypt(aes_gcm::Nonce::from_slice(&nonce), record.as_slice()).map_err(|_| anyhow::anyhow!("aes-gcm"))?;
    let mut out = Vec::with_capacity(16 + 4 + 1 + 65 + sealed.len());
    out.extend_from_slice(&salt);
    out.extend_from_slice(&4096u32.to_be_bytes());
    out.push(as_public.as_bytes().len() as u8);
    out.extend_from_slice(as_public.as_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_mentions() {
        assert_eq!(mention_ids("hi <@12> and <@&34> <@x> <@56>", "<@"), vec![Id(12), Id(56)]);
        assert_eq!(mention_ids("hi <@12> and <@&34>", "<@&"), vec![Id(34)]);
        assert_eq!(custom_emoji("ok <:pog:123> <a:dance:9>"), "ok :pog: :dance:");
    }

    #[test]
    fn only_known_push_services() {
        assert!(allowed_endpoint("https://fcm.googleapis.com/fcm/send/abc"));
        assert!(allowed_endpoint("https://updates.push.services.mozilla.com/wpush/v2/abc"));
        assert!(allowed_endpoint("https://web.push.apple.com/abc"));
        assert!(allowed_endpoint("https://wns2-bl2p.notify.windows.com/w/?token=x"));
        assert!(!allowed_endpoint("http://fcm.googleapis.com/fcm/send/abc"));
        assert!(!allowed_endpoint("https://evil.example/fcm.googleapis.com"));
        assert!(!allowed_endpoint("https://fcm.googleapis.com.evil.example/x"));
        assert!(!allowed_endpoint("https://127.0.0.1/x"));
        assert!(!allowed_endpoint("https://fcm.googleapis.com:8443/x"));
    }

    #[test]
    fn levels_follow_the_app() {
        let ch = |id: i64, parent: Option<i64>| Channel {
            id: Id(id),
            guild_id: Some(Id(1)),
            kind: 0,
            name: String::new(),
            topic: String::new(),
            position: 0,
            parent_id: parent.map(Id),
            last_message_id: None,
            owner_id: None,
            thread_message_id: None,
            archived: false,
            message_count: 0,
            permission_overwrites: None,
        };
        let s = json!({ "guild_notifications": { "1": "mentions" }, "channel_notifications": { "3": "all", "5": "none" } });
        assert_eq!(level_for(&s, &ch(2, None), None), "mentions");
        assert_eq!(level_for(&s, &ch(4, Some(3)), Some((Id(3), None))), "all");
        assert_eq!(level_for(&s, &ch(6, Some(7)), Some((Id(7), Some(Id(5))))), "none");
        assert_eq!(level_for(&json!({}), &ch(2, None), None), "all");
    }
}
