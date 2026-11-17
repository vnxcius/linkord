//! REC's shared clips (2.0): clips and VODs uploaded from the desktop app, watched by anyone with the link.
//!
//! - Upload: POST /clips (size + what it is: quota and size checked first) -> PUT /clips/uploads/{id}?offset= in chunks
//!   of up to 50 MB (Cloudflare caps a request at 100 MB) -> POST /clips/uploads/{id}/finish. The file grows in
//!   data/clip-uploads, so an upload resumes after a dropped connection or a server restart (the offset says where).
//! - Finish checks the file with ffprobe, strictly as MP4 (H.264 video, AAC audio, nothing else), takes a picture from
//!   it, and moves it to uploads/clips/<slug>.mp4: served like every upload (nosniff, sandbox CSP, Range for seeking).
//! - /clip/<slug>: a plain page anyone can open, no login, no script: the video, who shared it, and a slim "Recorded with
//!   Linkord" strip (download / create an account). Open Graph tags make the link play in Discord, WhatsApp...
//!   Views: each viewer once a day (a salted hash of address + day, never the address), link-preview bots left out.
//! - In chat a clip link becomes a `clip` embed (embeds.rs asks `embed_for`): the app's player, no page fetched.
//!
//! Limits: LINKORD_CLIP_QUOTA_MB per person (default 5 GB), LINKORD_CLIP_MAX_MB per file (default 1 GB), apart from
//! the attachments quota.

use std::path::{Path as FsPath, PathBuf};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::auth::AuthUser;
use crate::error::{bad, ApiError, ApiResult};
use crate::id::Id;
use crate::models::User;
use crate::ratelimit::ClientIp;
use crate::state::AppState;

/// The largest chunk, and the body limit of the chunk route (security::body_limit).
pub const CHUNK: usize = 50 * 1024 * 1024;
pub const CHUNK_BODY: usize = CHUNK + 64 * 1024;
const MAX_TITLE: usize = 100;
/// Longest a shared VOD may be.
const MAX_DURATION_MS: i64 = 6 * 3600 * 1000;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/clips", post(start_upload))
        .route("/clips/uploads/{id}", put(chunk).delete(abort))
        .route("/clips/uploads/{id}/finish", post(finish))
        .route("/clips/{key}", get(public_info).patch(update).delete(remove))
        .route("/users/@me/clips", get(mine))
        .route("/users/{id}/clips", get(of_user))
}

/// The public page, outside /api.
pub fn page_routes() -> Router<AppState> {
    Router::new().route("/clip/{slug}", get(page))
}

#[derive(sqlx::FromRow, Clone)]
pub struct Clip {
    pub id: Id,
    pub slug: String,
    pub user_id: Id,
    pub kind: String,
    pub title: String,
    pub game: String,
    pub duration_ms: i64,
    pub width: i32,
    pub height: i32,
    pub size: i64,
    pub views: i64,
    pub on_profile: bool,
    pub created_at: DateTime<Utc>,
}

const COLS: &str = "id, slug, user_id, kind, title, game, duration_ms, width, height, size, views, on_profile, created_at";

fn video_path(st: &AppState, slug: &str) -> PathBuf {
    st.cfg.uploads_dir().join("clips").join(format!("{slug}.mp4"))
}

fn picture_path(st: &AppState, slug: &str) -> PathBuf {
    st.cfg.uploads_dir().join("clips").join(format!("{slug}.jpg"))
}

fn part_path(st: &AppState, id: &str) -> PathBuf {
    st.cfg.data_dir.join("clip-uploads").join(format!("{id}.part"))
}

/// What clients get: everything to show and play it, and the link to share.
pub fn clip_json(st: &AppState, c: &Clip, author: Option<&User>) -> Value {
    json!({
        "id": c.id,
        "slug": c.slug,
        "user_id": c.user_id,
        "author": author.map(|u| json!({ "id": u.id, "username": u.username, "display_name": u.display_name, "avatar": u.avatar })),
        "kind": c.kind,
        "title": c.title,
        "game": c.game,
        "duration_ms": c.duration_ms,
        "width": c.width,
        "height": c.height,
        "size": c.size,
        "views": c.views,
        "on_profile": c.on_profile,
        "created_at": c.created_at,
        "url": format!("{}/clip/{}", st.cfg.public_url, c.slug),
        "video": format!("/uploads/clips/{}.mp4", c.slug),
        "thumbnail": format!("/uploads/clips/{}.jpg", c.slug),
    })
}

async fn by_key(st: &AppState, key: &str) -> ApiResult<Clip> {
    let row: Option<Clip> = match key.parse::<Id>() {
        Ok(id) => sqlx::query_as(&format!("SELECT {COLS} FROM clips WHERE id = $1")).bind(id).fetch_optional(&st.db).await?,
        Err(_) => sqlx::query_as(&format!("SELECT {COLS} FROM clips WHERE slug = $1")).bind(key).fetch_optional(&st.db).await?,
    };
    row.ok_or(ApiError::NotFound)
}

fn slug() -> String {
    const CHARS: &[u8] = b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..12).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}

fn clean(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(MAX_TITLE).collect::<String>().trim().to_string()
}

// ---------- upload ----------

#[derive(Deserialize)]
struct StartUpload {
    size: i64,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    game: String,
}

/// Bytes counted against someone's clip quota: their clips and the uploads they started.
async fn used(st: &AppState, user: Id) -> ApiResult<i64> {
    let (clips, pending): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COALESCE(SUM(size), 0)::BIGINT FROM clips WHERE user_id = $1),
                (SELECT COALESCE(SUM(size), 0)::BIGINT FROM clip_uploads WHERE user_id = $1)",
    )
    .bind(user)
    .fetch_one(&st.db)
    .await?;
    Ok(clips + pending)
}

async fn start_upload(State(st): State<AppState>, AuthUser(me): AuthUser, Json(body): Json<StartUpload>) -> ApiResult<Json<Value>> {
    st.limits.check(format!("clip-upload:{me}"), 10.0, 10.0 / 3600.0)?;
    if body.size <= 0 {
        return Err(bad("the clip is empty"));
    }
    if body.size as u64 > st.cfg.clip_max {
        return Err(bad("this clip is too big to share; cut a shorter part"));
    }
    if (used(&st, me).await? + body.size) as u64 > st.cfg.clip_quota {
        return Err(bad("you've used all your space for shared clips; delete some first"));
    }
    let kind = if body.kind.as_deref() == Some("vod") { "vod" } else { "clip" };
    let id = crate::auth::random_token(18);
    tokio::fs::create_dir_all(part_path(&st, &id).parent().unwrap()).await.map_err(anyhow::Error::from)?;
    tokio::fs::File::create(part_path(&st, &id)).await.map_err(anyhow::Error::from)?;
    sqlx::query("INSERT INTO clip_uploads (id, user_id, size, meta) VALUES ($1, $2, $3, $4)")
        .bind(&id)
        .bind(me)
        .bind(body.size)
        .bind(json!({ "kind": kind, "title": clean(&body.title), "game": clean(&body.game) }))
        .execute(&st.db)
        .await?;
    Ok(Json(json!({ "upload_id": id, "chunk": CHUNK })))
}

#[derive(Deserialize)]
struct ChunkQuery {
    offset: i64,
}

async fn upload_of(st: &AppState, me: Id, id: &str) -> ApiResult<(i64, i64, Value)> {
    let row: Option<(i64, i64, Value)> =
        sqlx::query_as("SELECT size, received, meta FROM clip_uploads WHERE id = $1 AND user_id = $2").bind(id).bind(me).fetch_optional(&st.db).await?;
    row.ok_or(ApiError::NotFound)
}

async fn chunk(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<String>, Query(q): Query<ChunkQuery>, body: Bytes) -> ApiResult<Response> {
    let (size, received, _) = upload_of(&st, me, &id).await?;
    // Not where the upload is: say where, so the app resumes from there.
    if q.offset != received {
        return Ok((StatusCode::CONFLICT, Json(json!({ "received": received }))).into_response());
    }
    if body.len() > CHUNK || received + body.len() as i64 > size {
        return Err(bad("more than the clip's size"));
    }
    let mut file = tokio::fs::OpenOptions::new().append(true).open(part_path(&st, &id)).await.map_err(anyhow::Error::from)?;
    file.write_all(&body).await.map_err(anyhow::Error::from)?;
    file.flush().await.map_err(anyhow::Error::from)?;
    let received = received + body.len() as i64;
    sqlx::query("UPDATE clip_uploads SET received = $2 WHERE id = $1").bind(&id).bind(received).execute(&st.db).await?;
    Ok(Json(json!({ "received": received })).into_response())
}

async fn abort(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    upload_of(&st, me, &id).await?;
    sqlx::query("DELETE FROM clip_uploads WHERE id = $1").bind(&id).execute(&st.db).await?;
    let _ = tokio::fs::remove_file(part_path(&st, &id)).await;
    Ok(StatusCode::NO_CONTENT)
}

/// What ffprobe says about an uploaded file, when it's an MP4 the app could have made.
#[derive(Debug, PartialEq)]
struct Probed {
    width: i32,
    height: i32,
    duration_ms: i64,
}

/// H.264 video, at most one AAC audio track, nothing else.
fn check_probe(json: &Value) -> Option<Probed> {
    let streams = json["streams"].as_array()?;
    let video: Vec<&Value> = streams.iter().filter(|s| s["codec_type"] == "video").collect();
    let audio: Vec<&Value> = streams.iter().filter(|s| s["codec_type"] == "audio").collect();
    if video.len() != 1 || video[0]["codec_name"] != "h264" {
        return None;
    }
    if audio.len() > 1 || audio.iter().any(|a| a["codec_name"] != "aac") || video.len() + audio.len() != streams.len() {
        return None;
    }
    let duration: f64 = json["format"]["duration"].as_str().and_then(|d| d.parse().ok())?;
    let probed = Probed {
        width: video[0]["width"].as_i64().unwrap_or(0) as i32,
        height: video[0]["height"].as_i64().unwrap_or(0) as i32,
        duration_ms: (duration * 1000.0) as i64,
    };
    if probed.width <= 0 || probed.height <= 0 || probed.width > 8192 || probed.height > 8192 {
        return None;
    }
    if probed.duration_ms <= 0 || probed.duration_ms > MAX_DURATION_MS {
        return None;
    }
    Some(probed)
}

async fn probe(path: &FsPath) -> ApiResult<Probed> {
    let mut cmd = tokio::process::Command::new("ffprobe");
    cmd.args(["-v", "error", "-protocol_whitelist", "file", "-f", "mov", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", "-i"])
        .arg(path);
    let out = crate::media::run(cmd, Duration::from_secs(60)).await?.ok_or_else(|| bad("the clip couldn't be read"))?;
    let json: Value = serde_json::from_slice(&out.stdout).map_err(|_| bad("the clip couldn't be read"))?;
    if !out.status.success() {
        return Err(bad("the clip couldn't be read"));
    }
    check_probe(&json).ok_or_else(|| bad("only clips from Linkord's REC can be shared"))
}

/// A picture from a second in (or the first frame of a very short clip), 640 px wide at most.
async fn picture(video: &FsPath, out: &FsPath) {
    for at in ["1", "0"] {
        let mut cmd = crate::media::ffmpeg_input(video, "mov");
        cmd.args(["-ss", at, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "4"]).arg(out);
        if matches!(crate::media::run(cmd, Duration::from_secs(30)).await, Ok(Some(o)) if o.status.success()) && out.exists() {
            return;
        }
    }
}

async fn finish(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let (size, received, meta) = upload_of(&st, me, &id).await?;
    if received != size {
        return Err(bad("the upload isn't complete"));
    }
    let part = part_path(&st, &id);
    let probed = match probe(&part).await {
        Ok(p) => p,
        Err(e) => {
            sqlx::query("DELETE FROM clip_uploads WHERE id = $1").bind(&id).execute(&st.db).await?;
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e);
        }
    };
    let slug = slug();
    let video = video_path(&st, &slug);
    tokio::fs::create_dir_all(video.parent().unwrap()).await.map_err(anyhow::Error::from)?;
    tokio::fs::rename(&part, &video).await.map_err(anyhow::Error::from)?;
    picture(&video, &picture_path(&st, &slug)).await;
    let text = |k: &str| meta[k].as_str().unwrap_or("").to_string();
    let clip: Clip = sqlx::query_as(&format!(
        "INSERT INTO clips (id, slug, user_id, kind, title, game, duration_ms, width, height, size) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING {COLS}"
    ))
    .bind(Id::new())
    .bind(&slug)
    .bind(me)
    .bind(text("kind"))
    .bind(text("title"))
    .bind(text("game"))
    .bind(probed.duration_ms)
    .bind(probed.width)
    .bind(probed.height)
    .bind(size)
    .fetch_one(&st.db)
    .await?;
    sqlx::query("DELETE FROM clip_uploads WHERE id = $1").bind(&id).execute(&st.db).await?;
    crate::stats::add(&st, me, "clips_shared", 1).await;
    tracing::info!(user = %me, clip = %clip.id, "shared a clip");
    let author = User::get(&st.db, me).await.ok();
    Ok(Json(clip_json(&st, &clip, author.as_ref())))
}

// ---------- reading and managing ----------

/// Anyone may read a clip's details: its link is meant to be shared.
async fn public_info(State(st): State<AppState>, Path(key): Path<String>) -> ApiResult<Json<Value>> {
    let clip = by_key(&st, &key).await?;
    let author = User::get(&st.db, clip.user_id).await.ok();
    Ok(Json(clip_json(&st, &clip, author.as_ref())))
}

#[derive(Deserialize)]
struct ClipUpdate {
    title: Option<String>,
    on_profile: Option<bool>,
}

async fn update(State(st): State<AppState>, AuthUser(me): AuthUser, Path(key): Path<String>, Json(body): Json<ClipUpdate>) -> ApiResult<Json<Value>> {
    let clip = by_key(&st, &key).await?;
    if clip.user_id != me {
        return Err(ApiError::Forbidden);
    }
    let clip: Clip = sqlx::query_as(&format!("UPDATE clips SET title = COALESCE($2, title), on_profile = COALESCE($3, on_profile) WHERE id = $1 RETURNING {COLS}"))
        .bind(clip.id)
        .bind(body.title.map(|t| clean(&t)))
        .bind(body.on_profile)
        .fetch_one(&st.db)
        .await?;
    let author = User::get(&st.db, me).await.ok();
    Ok(Json(clip_json(&st, &clip, author.as_ref())))
}

/// Removes a clip and its files (its owner here; the monitor through internal.rs).
pub async fn delete_clip(st: &AppState, clip: &Clip) -> ApiResult<()> {
    sqlx::query("DELETE FROM clips WHERE id = $1").bind(clip.id).execute(&st.db).await?;
    delete_files(st, &clip.slug).await;
    Ok(())
}

/// A clip's video and picture.
pub async fn delete_files(st: &AppState, slug: &str) {
    let _ = tokio::fs::remove_file(video_path(st, slug)).await;
    let _ = tokio::fs::remove_file(picture_path(st, slug)).await;
}

/// An unfinished upload's file (its row goes with the account, or with the upload).
pub async fn delete_part(st: &AppState, id: &str) {
    let _ = tokio::fs::remove_file(part_path(st, id)).await;
}

async fn remove(State(st): State<AppState>, AuthUser(me): AuthUser, Path(key): Path<String>) -> ApiResult<StatusCode> {
    let clip = by_key(&st, &key).await?;
    if clip.user_id != me {
        return Err(ApiError::Forbidden);
    }
    delete_clip(&st, &clip).await?;
    tracing::info!(user = %me, clip = %clip.id, "deleted a shared clip");
    Ok(StatusCode::NO_CONTENT)
}

/// Your shared clips (the REC page's Shared tab), and how much of your space they use.
async fn mine(State(st): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    let clips: Vec<Clip> = sqlx::query_as(&format!("SELECT {COLS} FROM clips WHERE user_id = $1 ORDER BY created_at DESC")).bind(me).fetch_all(&st.db).await?;
    let author = User::get(&st.db, me).await.ok();
    Ok(Json(json!({
        "clips": clips.iter().map(|c| clip_json(&st, c, author.as_ref())).collect::<Vec<_>>(),
        "used": used(&st, me).await?,
        "quota": st.cfg.clip_quota,
        "max_size": st.cfg.clip_max,
    })))
}

/// Someone's recent clips for their profile's widget (the ones they show there, if they show the widget).
async fn of_user(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>) -> ApiResult<Json<Value>> {
    let user = User::get(&st.db, id).await?;
    if id != me && !crate::api::users::knows(&st, me, &user).await? {
        return Err(ApiError::NotFound);
    }
    let shows: bool = sqlx::query_scalar("SELECT show_clips FROM users WHERE id = $1").bind(id).fetch_one(&st.db).await?;
    if !shows && id != me {
        return Ok(Json(json!({ "clips": [], "hidden": true })));
    }
    let clips: Vec<Clip> = sqlx::query_as(&format!("SELECT {COLS} FROM clips WHERE user_id = $1 AND on_profile ORDER BY created_at DESC LIMIT 6"))
        .bind(id)
        .fetch_all(&st.db)
        .await?;
    Ok(Json(json!({ "clips": clips.iter().map(|c| clip_json(&st, c, Some(&user))).collect::<Vec<_>>(), "hidden": !shows })))
}

/// Sweeps uploads nobody finished (started over a day ago).
pub async fn sweep_uploads(st: AppState) {
    loop {
        let stale: Vec<String> = sqlx::query_scalar("DELETE FROM clip_uploads WHERE created_at < now() - interval '1 day' RETURNING id")
            .fetch_all(&st.db)
            .await
            .unwrap_or_default();
        for id in stale {
            let _ = tokio::fs::remove_file(part_path(&st, &id)).await;
        }
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

// ---------- chat ----------

/// The clip a link on this server points to (/clip/<slug>, on the usual or the direct address).
pub async fn from_link(st: &AppState, url: &str) -> Option<Clip> {
    let parsed = reqwest::Url::parse(url.trim()).ok()?;
    let base = reqwest::Url::parse(&st.cfg.public_url).ok()?;
    let ours = parsed.host_str() == base.host_str() || (!st.cfg.direct_host.is_empty() && parsed.host_str() == Some(st.cfg.direct_host.as_str()));
    let slug = parsed.path().strip_prefix("/clip/")?.trim_end_matches('/');
    if !ours || slug.is_empty() || slug.contains('/') {
        return None;
    }
    by_key(st, slug).await.ok().filter(|c| c.slug == slug)
}

/// A clip's author, by slug (watch together's premiere badge).
pub async fn author_of(st: &AppState, slug: &str) -> Option<Id> {
    by_key(st, slug).await.ok().filter(|c| c.slug == slug).map(|c| c.user_id)
}

/// A link to one of our clips becomes the app's own clip embed (no page fetched).
pub async fn embed_for(st: &AppState, url: &str) -> Option<Value> {
    let clip = from_link(st, url).await?;
    let author = User::get(&st.db, clip.user_id).await.ok();
    Some(json!({ "type": "clip", "url": url, "clip": clip_json(st, &clip, author.as_ref()) }))
}

// ---------- the public page ----------

/// Link previews (Discord, WhatsApp...) open the page too; they aren't viewers.
fn is_crawler(agent: &str) -> bool {
    let a = agent.to_ascii_lowercase();
    ["bot", "crawler", "spider", "facebookexternalhit", "whatsapp", "slack", "telegram", "embedly", "preview", "curl", "wget"].iter().any(|k| a.contains(k))
}

/// The salt for viewer hashes, made once and kept (data/view-salt), so a restart doesn't count everyone again.
async fn view_salt(st: &AppState) -> Vec<u8> {
    static SALT: tokio::sync::OnceCell<Vec<u8>> = tokio::sync::OnceCell::const_new();
    SALT.get_or_init(|| async {
        let path = st.cfg.data_dir.join("view-salt");
        if let Ok(bytes) = tokio::fs::read(&path).await {
            if bytes.len() >= 32 {
                return bytes;
            }
        }
        let fresh: Vec<u8> = (0..32).map(|_| rand::random::<u8>()).collect();
        let _ = tokio::fs::write(&path, &fresh).await;
        fresh
    })
    .await
    .clone()
}

async fn count_view(st: &AppState, clip: &Clip, ip: &str) {
    let day = Utc::now().date_naive();
    let mut h = Sha256::new();
    h.update(view_salt(st).await);
    h.update(ip.as_bytes());
    h.update(day.to_string().as_bytes());
    let viewer = h.finalize().to_vec();
    let new = sqlx::query("INSERT INTO clip_views (clip_id, viewer, day) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
        .bind(clip.id)
        .bind(viewer)
        .bind(day)
        .execute(&st.db)
        .await
        .map(|r| r.rows_affected() == 1)
        .unwrap_or(false);
    if new {
        let _ = sqlx::query("UPDATE clips SET views = views + 1 WHERE id = $1").bind(clip.id).execute(&st.db).await;
        crate::stats::add(st, clip.user_id, "clip_views", 1).await;
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}

/// Strict for a page anyone opens: only our own files. The script is the web build's player (player_tags), never
/// inline; connect-src is for its Download (a fetch of the clip).
const PAGE_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// The custom player's tags (script module, preloads, stylesheet) from the web build's clip.html (app/clip.html,
/// src/clip-page.tsx), read once. Empty without a build: the page's plain <video> plays the clip anyway.
fn player_tags(web_dir: &std::path::Path) -> &'static str {
    static TAGS: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TAGS.get_or_init(|| extract_player_tags(&std::fs::read_to_string(web_dir.join("clip.html")).unwrap_or_default()))
}

/// Only tags for files of this server (src/href starting with "/"): module scripts, module preloads, stylesheets.
fn extract_player_tags(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(i) = rest.find('<') {
        rest = &rest[i..];
        if rest.starts_with("<script") {
            let Some(end) = rest.find("</script>") else { break };
            let tag = &rest[..end + "</script>".len()];
            let open = &tag[..tag.find('>').unwrap_or(0)];
            if open.contains("type=\"module\"") && open.contains(" src=\"/") && !open.contains(" src=\"//") {
                out.push_str(tag);
            }
            rest = &rest[end + "</script>".len()..];
        } else if rest.starts_with("<link") {
            let Some(end) = rest.find('>') else { break };
            let tag = &rest[..=end];
            let kind = tag.contains("rel=\"stylesheet\"") || tag.contains("rel=\"modulepreload\"");
            if kind && tag.contains(" href=\"/") && !tag.contains(" href=\"//") {
                out.push_str(tag);
            }
            rest = &rest[end + 1..];
        } else {
            rest = &rest[1..];
        }
    }
    out
}

async fn page(State(st): State<AppState>, ClientIp(ip): ClientIp, headers: HeaderMap, Path(slug): Path<String>) -> Response {
    let Ok(clip) = by_key(&st, &slug).await.filter_slug(&slug) else {
        return (StatusCode::NOT_FOUND, Html(not_found_page())).into_response();
    };
    let agent = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !is_crawler(agent) {
        count_view(&st, &clip, &ip).await;
    }
    let author = User::get(&st.db, clip.user_id).await.ok();
    let mut res = Html(render_page(&st, &clip, author.as_ref())).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(PAGE_CSP));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("strict-origin-when-cross-origin"));
    res
}

/// Only slugs open the page (ids are guessable).
trait FilterSlug {
    fn filter_slug(self, slug: &str) -> Self;
}

impl FilterSlug for ApiResult<Clip> {
    fn filter_slug(self, slug: &str) -> Self {
        self.and_then(|c| if c.slug == slug { Ok(c) } else { Err(ApiError::NotFound) })
    }
}

fn duration_text(ms: i64) -> String {
    let s = ms / 1000;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s % 3600 / 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

const PAGE_STYLE: &str = "
:root{color-scheme:dark;--bg:#0f1012;--panel:#17181b;--line:#2a2c31;--text:#e8e6e1;--muted:#9a9890;--brand:#ece8e1}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f3f1ec;--panel:#fff;--line:#dedad1;--text:#1d1c1a;--muted:#6b6862;--brand:#22201d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;min-height:100vh;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:10px;padding:14px 20px}header img{width:26px;height:26px;border-radius:7px}header a{color:inherit;text-decoration:none;font-weight:600;letter-spacing:.02em}
main{flex:1;width:min(1100px,100%);margin:0 auto;padding:8px 16px 32px;display:flex;flex-direction:column;gap:14px}
video{width:100%;max-height:72vh;background:#000;border-radius:14px;display:block}
h1{margin:0;font:400 30px/1.15 Georgia,'Times New Roman',serif}.meta{color:var(--muted);font-size:14px}.meta b{color:var(--text);font-weight:600}
.cta{position:sticky;bottom:0;display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap;padding:10px 16px;background:var(--panel);border-top:1px solid var(--line);font-size:14px}
.cta a{color:var(--brand);text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--brand) 45%,transparent);text-underline-offset:2px;font-weight:600}.cta a:hover{text-decoration-color:var(--brand)}
.cta label{cursor:pointer;color:var(--muted);padding:0 6px;font-size:18px;line-height:1}#hide-cta{display:none}#hide-cta:checked+.cta{display:none}
";

fn render_page(st: &AppState, clip: &Clip, author: Option<&User>) -> String {
    let base = &st.cfg.public_url;
    let who = author.map(|u| u.display_name.clone().unwrap_or_else(|| u.username.clone())).unwrap_or_default();
    let title = if clip.title.is_empty() { if clip.game.is_empty() { "Clip".to_string() } else { clip.game.clone() } } else { clip.title.clone() };
    let video = format!("{base}/uploads/clips/{}.mp4", clip.slug);
    let picture = format!("{base}/uploads/clips/{}.jpg", clip.slug);
    let url = format!("{base}/clip/{}", clip.slug);
    let description = [Some(clip.game.as_str()).filter(|g| !g.is_empty()), Some(who.as_str()).filter(|w| !w.is_empty())]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
    let views = if clip.views == 1 { "1 view".to_string() } else { format!("{} views", clip.views) };
    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{t} · Linkord</title><meta name="description" content="{d}">
<meta property="og:site_name" content="Linkord"><meta property="og:type" content="video.other"><meta property="og:title" content="{t}">
<meta property="og:description" content="{d}"><meta property="og:url" content="{u}"><meta property="og:image" content="{p}">
<meta property="og:video" content="{v}"><meta property="og:video:secure_url" content="{v}"><meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="{w}"><meta property="og:video:height" content="{h}"><meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="{p}"><meta name="theme-color" content="#18181c"><link rel="icon" href="/icon.png">{player}<style>{s}</style></head>
<body><header><img src="/icon.png" alt=""><a href="/">Linkord</a></header>
<main><div id="clip-player" data-filename="{f}"><video src="{v}" poster="{p}" controls playsinline preload="metadata"></video></div>
<h1>{t}</h1><div class="meta">{who_part}{game_part}{len} · {views}</div></main>
<input type="checkbox" id="hide-cta"><div class="cta"><span>Recorded with <b>Linkord</b>, where friends talk, play and clip their games.</span>
<a href="/download">Download Linkord</a><a href="/">Create an account</a><label for="hide-cta" title="Hide">×</label></div></body></html>"##,
        t = escape(&title),
        d = escape(&description),
        u = escape(&url),
        p = escape(&picture),
        v = escape(&video),
        w = clip.width,
        h = clip.height,
        s = PAGE_STYLE,
        player = player_tags(&st.cfg.web_dir),
        f = escape(&format!("{}.mp4", title.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_"))),
        who_part = if who.is_empty() { String::new() } else { format!("Shared by <b>{}</b> · ", escape(&who)) },
        game_part = if clip.game.is_empty() { String::new() } else { format!("{} · ", escape(&clip.game)) },
        len = duration_text(clip.duration_ms),
        views = views,
    )
}

fn not_found_page() -> String {
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Clip not found · Linkord</title><style>{PAGE_STYLE}</style></head>
<body><header><img src="/icon.png" alt=""><a href="/">Linkord</a></header><main><h1>This clip isn't here anymore</h1><p class="meta">It was deleted, or the link is wrong.</p></main></body></html>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_h264_with_at_most_one_aac_track_passes() {
        let ok = json!({ "streams": [{ "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080 }, { "codec_type": "audio", "codec_name": "aac" }], "format": { "duration": "12.5" } });
        assert_eq!(check_probe(&ok), Some(Probed { width: 1920, height: 1080, duration_ms: 12_500 }));
        let silent = json!({ "streams": [{ "codec_type": "video", "codec_name": "h264", "width": 1280, "height": 720 }], "format": { "duration": "3" } });
        assert!(check_probe(&silent).is_some());
        for bad in [
            json!({ "streams": [{ "codec_type": "video", "codec_name": "hevc", "width": 1920, "height": 1080 }], "format": { "duration": "1" } }),
            json!({ "streams": [{ "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080 }, { "codec_type": "subtitle", "codec_name": "mov_text" }], "format": { "duration": "1" } }),
            json!({ "streams": [{ "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080 }, { "codec_type": "audio", "codec_name": "aac" }, { "codec_type": "audio", "codec_name": "aac" }], "format": { "duration": "1" } }),
            json!({ "streams": [{ "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080 }], "format": { "duration": "99999" } }),
            json!({ "streams": [], "format": { "duration": "1" } }),
        ] {
            assert!(check_probe(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn only_our_own_player_files_go_into_the_page() {
        let built = r#"<!doctype html><html><head><script type="module" crossorigin src="/assets/clip-a1.js"></script>
<link rel="modulepreload" crossorigin href="/assets/solid-b2.js"><link rel="stylesheet" crossorigin href="/assets/clip-c3.css">
<link rel="icon" href="/icon.png"><script>alert(1)</script><script type="module" src="https://evil.example/x.js"></script>
<script type="module" src="//evil.example/y.js"></script><link rel="stylesheet" href="https://evil.example/z.css"></head></html>"#;
        let tags = extract_player_tags(built);
        assert!(tags.contains(r#"src="/assets/clip-a1.js""#));
        assert!(tags.contains(r#"href="/assets/solid-b2.js""#));
        assert!(tags.contains(r#"href="/assets/clip-c3.css""#));
        assert!(!tags.contains("alert") && !tags.contains("evil") && !tags.contains("icon.png"), "{tags}");
        assert_eq!(extract_player_tags(""), "");
    }

    #[test]
    fn link_previews_are_not_viewers() {
        assert!(is_crawler("Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)"));
        assert!(is_crawler("WhatsApp/2.23.20.0"));
        assert!(!is_crawler("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"));
    }

    #[test]
    fn slugs_are_twelve_unambiguous_characters() {
        let s = slug();
        assert_eq!(s.len(), 12);
        assert!(s.chars().all(|c| c.is_ascii_alphanumeric() && !"0Ol1I".contains(c)));
        assert_ne!(slug(), s);
    }

    #[test]
    fn page_text_is_escaped() {
        assert_eq!(escape("<b>\"Tom & Jerry's\"</b>"), "&lt;b&gt;&quot;Tom &amp; Jerry&#39;s&quot;&lt;/b&gt;");
    }
}
