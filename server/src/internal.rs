//! What the monitor (the separate `monitor/` service) gets from the server: counters only this process knows, and
//! the one thing it may ask for, removing an uploaded file so connected apps hear about it.
//!
//! This listens on its own loopback address (LINKORD_INTERNAL_BIND, default 127.0.0.1:7711), never on the port the
//! tunnel forwards, and every request needs the token in `<data>/internal-token`. It must never get in the app's
//! way: failing to bind only logs a warning, and the counters are relaxed atomics.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering::Relaxed};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use dashmap::DashMap;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{bad, ApiError, ApiResult};
use crate::id::Id;
use crate::state::AppState;

// ---------- counters ----------

/// Upper bounds of the request time histogram, in ms; one more bucket holds everything above.
const BUCKETS: [u64; 10] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
/// Distinct route names kept: a scanner asking for random paths must not grow this forever.
const MAX_ROUTES: usize = 300;

#[derive(Default)]
struct RouteStats {
    count: AtomicU64,
    errors: AtomicU64,
    total_ms: AtomicU64,
    max_ms: AtomicU64,
}

#[derive(Default)]
pub struct Counters {
    in_flight: AtomicI64,
    requests: AtomicU64,
    status: [AtomicU64; 6],
    histogram: [AtomicU64; BUCKETS.len() + 1],
    routes: OnceLock<DashMap<String, RouteStats>>,
    pub voice_packets: AtomicU64,
    pub voice_bytes: AtomicU64,
    pub media_packets: AtomicU64,
    pub media_bytes: AtomicU64,
    /// Listener queues that were full: the packet was dropped for that listener.
    pub queue_drops: AtomicU64,
    /// Media too old to send (MEDIA_MAX_AGE): the listener's connection can't keep up.
    pub stale_media: AtomicU64,
    /// Voice connections that dropped without leaving (the seat waited for a reconnect).
    pub voice_drops: AtomicU64,
    /// Seats taken back by a reconnect (after a drop or a restart).
    pub voice_resumes: AtomicU64,
    lag_last_us: AtomicU64,
    lag_max_us: AtomicU64,
}

/// How many migrations this build has (main.rs sets it), so the monitor can tell whether some are waiting.
pub static MIGRATIONS: OnceLock<usize> = OnceLock::new();

fn tools() -> &'static std::sync::RwLock<Value> {
    static T: OnceLock<std::sync::RwLock<Value>> = OnceLock::new();
    T.get_or_init(|| std::sync::RwLock::new(Value::Null))
}

/// The first line of `program args`, or None if it can't run.
async fn version_of(mut cmd: tokio::process::Command) -> Option<String> {
    cmd.kill_on_drop(true).stdin(std::process::Stdio::null());
    let out = tokio::time::timeout(Duration::from_secs(10), cmd.output()).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    out.status.success().then(|| text.lines().next().unwrap_or("").trim().to_string())
}

/// Checks ffmpeg, yt-dlp and Node (yt-dlp's JavaScript runtime); at startup and after each yt-dlp update.
pub async fn probe_tools(st: &AppState) {
    let ff = {
        let mut c = tokio::process::Command::new("ffmpeg");
        c.args(["-hide_banner", "-version"]);
        version_of(c).await.map(|v| v.split(" Copyright").next().unwrap_or(&v).to_string())
    };
    let ytdlp = version_of(crate::music::ytdlp_version_cmd(st)).await;
    let node = version_of({
        let mut c = tokio::process::Command::new("node");
        c.arg("--version");
        c
    })
    .await;
    *tools().write().unwrap() = json!({ "ffmpeg": ff, "yt_dlp": ytdlp, "node": node });
}

pub fn counters() -> &'static Counters {
    static C: OnceLock<Counters> = OnceLock::new();
    C.get_or_init(Counters::default)
}

/// `/api/channels/1234/messages` -> `/api/channels/:id/messages`. Numbers and anything that looks like a code or
/// token become `:id`, so names stay few and hold nothing private.
fn route_name(path: &str, status: u16) -> String {
    if !path.starts_with("/api/") {
        return "(files and web client)".into();
    }
    if status == 404 {
        return "(not found)".into();
    }
    let mut out = String::with_capacity(path.len());
    for seg in path.split('/').filter(|s| !s.is_empty()) {
        out.push('/');
        let idlike = seg.chars().all(|c| c.is_ascii_digit()) || (seg.len() >= 6 && seg.chars().any(|c| c.is_ascii_digit()));
        out.push_str(if idlike { ":id" } else { seg });
    }
    out
}

/// Counts a request while it runs; called by the access log middleware.
pub fn request_started() {
    counters().in_flight.fetch_add(1, Relaxed);
}

pub fn request_finished(path: &str, status: u16, ms: u64) {
    let c = counters();
    c.in_flight.fetch_sub(1, Relaxed);
    c.requests.fetch_add(1, Relaxed);
    c.status[(status / 100).min(5) as usize].fetch_add(1, Relaxed);
    let bucket = BUCKETS.iter().position(|b| ms <= *b).unwrap_or(BUCKETS.len());
    c.histogram[bucket].fetch_add(1, Relaxed);
    let routes = c.routes.get_or_init(DashMap::new);
    let name = route_name(path, status);
    let name = if routes.len() >= MAX_ROUTES && !routes.contains_key(&name) { "(other)".to_string() } else { name };
    let r = routes.entry(name).or_default();
    r.count.fetch_add(1, Relaxed);
    if status >= 500 {
        r.errors.fetch_add(1, Relaxed);
    }
    r.total_ms.fetch_add(ms, Relaxed);
    r.max_ms.fetch_max(ms, Relaxed);
}

/// How late a timer fires tells whether the async runtime is starved (blocking work, too little CPU).
async fn watch_runtime_lag() {
    const EVERY: Duration = Duration::from_millis(250);
    loop {
        let start = Instant::now();
        tokio::time::sleep(EVERY).await;
        let late = start.elapsed().saturating_sub(EVERY).as_micros() as u64;
        let c = counters();
        c.lag_last_us.store(late, Relaxed);
        c.lag_max_us.fetch_max(late, Relaxed);
    }
}

// ---------- listener ----------

/// The monitor reads the same file (mc-manager reads `steve-token`), so nothing needs configuring.
async fn load_token(st: &AppState, file: &str) -> std::io::Result<String> {
    let path = st.cfg.data_dir.join(file);
    if let Ok(t) = tokio::fs::read_to_string(&path).await {
        if t.trim().len() >= 32 {
            return Ok(t.trim().to_string());
        }
    }
    let token = crate::auth::random_token(32);
    tokio::fs::create_dir_all(&st.cfg.data_dir).await?;
    tokio::fs::write(&path, &token).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).await?;
    }
    Ok(token)
}

pub async fn serve(st: AppState) {
    let Some(bind) = st.cfg.internal_bind.clone() else { return };
    tokio::spawn(watch_runtime_lag());
    let addr: Option<SocketAddr> = bind.parse().ok();
    let Some(addr) = addr.filter(|a| a.ip().is_loopback()) else {
        tracing::warn!("LINKORD_INTERNAL_BIND must be a loopback address, not starting it: {bind}");
        return;
    };
    let (token, steve_token) = match (load_token(&st, "internal-token").await, load_token(&st, "steve-token").await) {
        (Ok(t), Ok(s)) => (t, s),
        (Err(e), _) | (_, Err(e)) => {
            tracing::warn!("internal api off, can't write its token: {e}");
            return;
        }
    };
    let listener = match crate::handover::listener("internal", &addr.to_string()).and_then(tokio::net::TcpListener::from_std) {
        Ok(l) => l,
        // A second instance on this machine (tests next to a dev server). The app itself doesn't need this.
        Err(e) => {
            tracing::warn!("internal api off, can't bind {addr}: {e}");
            return;
        }
    };
    let app = Router::new()
        .route("/metrics", get(metrics))
        .route("/moderation/remove", post(remove_media))
        .route("/moderation/suspend", post(suspend))
        .route("/moderation/badge", post(badge))
        .layer(axum::middleware::from_fn(move |req: Request, next: Next| {
            let token = token.clone();
            async move { guard(&token, req, next).await }
        }))
        // Steve (steve.rs), driven by mc-manager, has his own token: the monitor's can't speak as him and his can't
        // moderate.
        .merge(crate::steve::bot_routes().layer(axum::middleware::from_fn(move |req: Request, next: Next| {
            let token = steve_token.clone();
            async move { guard(&token, req, next).await }
        })))
        .with_state(st);
    tracing::info!("internal api on {addr}");
    crate::handover::until_drained(async {
        if let Err(e) = axum::serve(listener, app).with_graceful_shutdown(crate::handover::stop_accepting()).await {
            tracing::warn!("internal api stopped: {e}");
        }
    })
    .await;
}

async fn guard(token: &str, req: Request, next: Next) -> Response {
    let given = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    if given == Some(token) {
        next.run(req).await
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    }
}

// ---------- metrics ----------

fn started() -> &'static (Instant, i64) {
    static S: OnceLock<(Instant, i64)> = OnceLock::new();
    S.get_or_init(|| (Instant::now(), chrono::Utc::now().timestamp()))
}

/// Remembers when the server started; call early in main.
pub fn mark_started() {
    let _ = started();
}

async fn metrics(State(st): State<AppState>) -> Json<Value> {
    let c = counters();
    let (sessions, attached, online) = st.hub.snapshot();
    let voice = st.voice.snapshot();
    let routes: Vec<Value> = c
        .routes
        .get()
        .map(|m| {
            m.iter()
                .map(|e| {
                    json!({
                        "route": e.key(),
                        "count": e.count.load(Relaxed),
                        "errors": e.errors.load(Relaxed),
                        "total_ms": e.total_ms.load(Relaxed),
                        "max_ms": e.max_ms.load(Relaxed),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let runtime = tokio::runtime::Handle::current().metrics();
    let previews_bytes: usize = st.previews.iter().map(|p| p.value().0.len()).sum();
    Json(json!({
        "pid": std::process::id(),
        "started_at": started().1,
        "uptime_s": started().0.elapsed().as_secs(),
        "version": env!("CARGO_PKG_VERSION"),
        // Docker slot (deploy/docker-compose.yml) serving; empty outside Docker.
        "slot": std::env::var("LINKORD_SLOT").unwrap_or_default(),
        // What the server itself can run: the monitor lives in another container and can't check these on its own.
        "tools": tools().read().unwrap().clone(),
        "migrations_in_code": MIGRATIONS.get().copied(),
        "config": {
            "dev_login": st.cfg.dev_login,
            "discord_login": st.cfg.discord_enabled(),
            "spotify": st.cfg.spotify_enabled(),
            "direct": st.cfg.direct_bind.is_some(),
            "admins": st.cfg.admins.len(),
            "upload_quota": st.cfg.upload_quota,
        },
        "gateway": { "sessions": sessions, "attached": attached, "online_users": online },
        "voice": {
            "users": voice.users,
            "calls": voice.calls,
            "streams": voice.streams,
            "cameras": voice.cameras,
            "voice_packets": c.voice_packets.load(Relaxed),
            "voice_bytes": c.voice_bytes.load(Relaxed),
            "media_packets": c.media_packets.load(Relaxed),
            "media_bytes": c.media_bytes.load(Relaxed),
            "queue_drops": c.queue_drops.load(Relaxed),
            "stale_media": c.stale_media.load(Relaxed),
            "voice_drops": c.voice_drops.load(Relaxed),
            "voice_resumes": c.voice_resumes.load(Relaxed),
        },
        "features": {
            "music_playing": st.music.is_playing(),
            "watches": st.watches.len(),
            "previews": st.previews.len(),
            "previews_bytes": previews_bytes,
            "embed_cache": st.embed_cache.len(),
            "activities": st.activities.len(),
        },
        "http": {
            "in_flight": c.in_flight.load(Relaxed),
            "requests": c.requests.load(Relaxed),
            "status": c.status.iter().map(|s| s.load(Relaxed)).collect::<Vec<_>>(),
            "buckets": BUCKETS,
            "histogram": c.histogram.iter().map(|s| s.load(Relaxed)).collect::<Vec<_>>(),
            "routes": routes,
        },
        "db_pool": { "size": st.db.size(), "idle": st.db.num_idle(), "max": st.db.options().get_max_connections() },
        "runtime": {
            "workers": runtime.num_workers(),
            "tasks": runtime.num_alive_tasks(),
            "queued": runtime.global_queue_depth(),
            "lag_ms": c.lag_last_us.load(Relaxed) as f64 / 1000.0,
            // Worst since the last read.
            "lag_max_ms": c.lag_max_us.swap(0, Relaxed) as f64 / 1000.0,
        },
    }))
}

// ---------- removing media ----------

#[derive(Deserialize)]
struct RemoveMedia {
    /// attachment | avatar | banner | server_icon | server_banner | member_avatar | member_banner | emoji | sound |
    /// profile_song
    kind: String,
    url: String,
    /// The message (attachment), emoji or sound.
    item_id: Option<Id>,
    user_id: Option<Id>,
    guild_id: Option<Id>,
}

fn required(id: Option<Id>, what: &str) -> ApiResult<Id> {
    id.ok_or_else(|| bad(format!("{what} is required")))
}

/// Deletes the random directory holding an upload, only if it sits under `uploads/<base>`, and returns the file's size.
async fn remove_upload(st: &AppState, base: &str, url: &str) -> u64 {
    let root = st.cfg.uploads_dir();
    let Some(rel) = url.strip_prefix("/uploads/").filter(|r| !r.contains("..")) else { return 0 };
    let file = root.join(rel);
    let size = tokio::fs::metadata(&file).await.map(|m| m.len()).unwrap_or(0);
    let base = root.join(base);
    if let Some(dir) = file.parent().filter(|d| d.starts_with(&base) && *d != base.as_path()) {
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
    size
}

#[derive(Deserialize)]
struct GiveBadge {
    user_id: Id,
    badge: String,
    given: bool,
}

/// Gives or takes away a badge only admins hand out (badges::MANUAL: Bug Hunter, Tester...).
async fn badge(State(st): State<AppState>, Json(b): Json<GiveBadge>) -> ApiResult<Json<Value>> {
    if !crate::badges::set_manual(&st, b.user_id, &b.badge, b.given).await? {
        return Err(ApiError::NotFound);
    }
    tracing::info!(target: "moderation", user = %b.user_id, badge = %b.badge, given = b.given, "badge changed");
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct Suspend {
    user_id: Id,
    suspended: bool,
}

/// Suspends an account (no sign-in, every session ended, out of voice) or restores it.
async fn suspend(State(st): State<AppState>, Json(b): Json<Suspend>) -> ApiResult<Json<Value>> {
    let done = sqlx::query("UPDATE users SET suspended_at = CASE WHEN $2 THEN now() END WHERE id = $1 AND NOT bot AND deleted_at IS NULL")
        .bind(b.user_id)
        .bind(b.suspended)
        .execute(&st.db)
        .await?
        .rows_affected();
    if done == 0 {
        return Err(crate::error::ApiError::NotFound);
    }
    if b.suspended {
        crate::auth::end_sessions(&st, b.user_id).await?;
    }
    tracing::info!(target: "moderation", user = %b.user_id, suspended = b.suspended, "account suspension changed");
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Removes one upload for a moderator: the row that shows it, its file and the owner's quota, and tells connected
/// apps through the same events as the normal paths.
async fn remove_media(State(st): State<AppState>, Json(b): Json<RemoveMedia>) -> ApiResult<Json<Value>> {
    let freed = match b.kind.as_str() {
        "attachment" => crate::api::messages::remove_attachment(&st, required(b.item_id, "item_id")?, &b.url).await?,
        "avatar" => {
            let user = required(b.user_id, "user_id")?;
            sqlx::query("DELETE FROM avatar_history WHERE user_id = $1 AND url = $2").bind(user).bind(&b.url).execute(&st.db).await?;
            sqlx::query("UPDATE users SET avatar = NULL WHERE id = $1 AND avatar = $2").bind(user).bind(&b.url).execute(&st.db).await?;
            let freed = remove_upload(&st, &format!("avatars/{user}"), &b.url).await;
            crate::uploads::release(&st, user, freed).await;
            crate::api::users::notify_update(&st, &crate::models::User::get(&st.db, user).await?).await?;
            freed
        }
        "banner" => {
            let user = required(b.user_id, "user_id")?;
            sqlx::query("UPDATE users SET banner = NULL WHERE id = $1 AND banner = $2").bind(user).bind(&b.url).execute(&st.db).await?;
            let freed = remove_upload(&st, &format!("banners/{user}"), &b.url).await;
            crate::uploads::release(&st, user, freed).await;
            crate::api::users::notify_update(&st, &crate::models::User::get(&st.db, user).await?).await?;
            freed
        }
        "server_icon" | "server_banner" => {
            let guild = required(b.guild_id, "guild_id")?;
            let (column, dir) = if b.kind == "server_icon" { ("icon", "icons") } else { ("banner", "banners") };
            let owner: Id = sqlx::query_scalar("SELECT owner_id FROM guilds WHERE id = $1").bind(guild).fetch_optional(&st.db).await?.ok_or(ApiError::NotFound)?;
            sqlx::query(&format!("UPDATE guilds SET {column} = NULL WHERE id = $1 AND {column} = $2")).bind(guild).bind(&b.url).execute(&st.db).await?;
            let freed = remove_upload(&st, &format!("{dir}/{guild}"), &b.url).await;
            crate::uploads::release(&st, owner, freed).await;
            let _ = crate::api::guilds::announce_update(&st, guild, owner).await?;
            freed
        }
        "member_avatar" | "member_banner" => {
            let (guild, user) = (required(b.guild_id, "guild_id")?, required(b.user_id, "user_id")?);
            let column = b.kind.trim_start_matches("member_");
            sqlx::query(&format!("UPDATE members SET {column} = NULL WHERE guild_id = $1 AND user_id = $2 AND {column} = $3"))
                .bind(guild)
                .bind(user)
                .bind(&b.url)
                .execute(&st.db)
                .await?;
            let freed = remove_upload(&st, &format!("member-profiles/{guild}/{user}"), &b.url).await;
            crate::uploads::release(&st, user, freed).await;
            let _ = crate::api::guilds::announce_member(&st, guild, user).await?;
            freed
        }
        "emoji" => {
            let id = required(b.item_id, "item_id")?;
            let (guild, animated, creator): (Id, bool, Id) = sqlx::query_as("DELETE FROM emojis WHERE id = $1 RETURNING guild_id, animated, creator_id")
                .bind(id)
                .fetch_optional(&st.db)
                .await?
                .ok_or(ApiError::NotFound)?;
            let file = st.cfg.uploads_dir().join("emojis").join(format!("{id}.{}", if animated { "gif" } else { "png" }));
            let freed = tokio::fs::metadata(&file).await.map(|m| m.len()).unwrap_or(0);
            let _ = tokio::fs::remove_file(&file).await;
            crate::uploads::release(&st, creator, freed).await;
            crate::api::emojis::announce(&st, guild).await?;
            freed
        }
        "sound" => {
            let id = required(b.item_id, "item_id")?;
            let (guild, creator, url): (Id, Id, String) = sqlx::query_as("DELETE FROM soundboard_sounds WHERE id = $1 RETURNING guild_id, creator_id, url")
                .bind(id)
                .fetch_optional(&st.db)
                .await?
                .ok_or(ApiError::NotFound)?;
            let freed = remove_upload(&st, &format!("sounds/{guild}"), &url).await;
            crate::uploads::release(&st, creator, freed).await;
            crate::soundboard::announce(&st, guild).await?;
            freed
        }
        "profile_song" => {
            let user = required(b.user_id, "user_id")?;
            sqlx::query("DELETE FROM profile_songs WHERE user_id = $1").bind(user).execute(&st.db).await?;
            let freed = remove_upload(&st, &format!("profile-songs/{user}"), &b.url).await;
            let _ = tokio::fs::remove_dir_all(st.cfg.uploads_dir().join(format!("profile-songs/{user}"))).await;
            crate::uploads::release(&st, user, freed).await;
            freed
        }
        // REC: a shared clip (its quota is apart from attachments, so nothing to give back there).
        "clip" => {
            let id = required(b.item_id, "item_id")?;
            let clip: crate::clips::Clip = sqlx::query_as("SELECT id, slug, user_id, kind, title, game, duration_ms, width, height, size, views, on_profile, created_at FROM clips WHERE id = $1")
                .bind(id)
                .fetch_optional(&st.db)
                .await?
                .ok_or(ApiError::NotFound)?;
            crate::clips::delete_clip(&st, &clip).await?;
            clip.size as u64
        }
        _ => return Err(ApiError::NotFound),
    };
    let id = |i: Option<Id>| i.map(|i| i.to_string()).unwrap_or_default();
    tracing::info!(target: "moderation", kind = %b.kind, item = %id(b.item_id), user = %id(b.user_id), guild = %id(b.guild_id), freed, "media removed by a moderator");
    Ok(Json(json!({ "freed": freed })))
}

#[cfg(test)]
mod tests {
    use super::route_name;

    #[test]
    fn route_names_hold_no_ids_or_codes() {
        assert_eq!(route_name("/api/channels/110071797004632064/messages", 200), "/api/channels/:id/messages");
        assert_eq!(route_name("/api/invites/a1b2c3d4", 200), "/api/invites/:id");
        assert_eq!(route_name("/api/users/@me", 200), "/api/users/@me");
        assert_eq!(route_name("/api/whatever/1", 404), "(not found)");
        assert_eq!(route_name("/uploads/attachments/1/x/cat.png", 200), "(files and web client)");
    }
}
