//! The soundboard, like Discord's: short sounds anyone in a voice call can play for everyone in it.
//! Default sounds are the audio files in LINKORD_SOUNDS_DIR (served at /soundboard/<file>; a leading emoji in
//! the file name, "🦆 quack.mp3", becomes the sound's emoji). Servers add their own (Manage Emojis).
//! Playing goes over the voice socket (voice.rs, op `sound`): everyone in the channel gets the sound's URL and
//! plays it themselves, at the sound's volume times their own volume for whoever played it.

use axum::extract::{Multipart, Path, State};
use axum::routing::{get, patch};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::auth::AuthUser;
use crate::error::{bad, ApiError, ApiResult};
use crate::gateway::guild_members;
use crate::id::Id;
use crate::perms::{self, guild_perms};
use crate::state::AppState;
use crate::uploads;

const AUDIO_EXT: &[&str] = &["mp3", "ogg", "opus", "wav", "webm", "m4a"];
/// The uploaded file (the part that plays is cut from it).
const MAX_SOURCE: usize = 8 * 1024 * 1024;
/// Discord allows 5.2 seconds.
const MAX_SECONDS: f64 = 5.2;
const MAX_PER_GUILD: i64 = 48;

#[derive(Clone, Serialize, FromRow)]
pub struct Sound {
    /// A snowflake for server sounds, "default:<file name>" for default ones.
    pub id: String,
    pub guild_id: Option<Id>,
    pub name: String,
    pub emoji: Option<String>,
    pub volume: f32,
    pub url: String,
    /// The uploaded original the sound is cut from (server sounds), and where the cut starts and ends.
    pub source: Option<String>,
    pub trim_start: f32,
    pub trim_end: Option<f32>,
}

/// "🦆 quack" -> (Some("🦆"), "quack"); "airhorn" -> (None, "airhorn").
fn split_emoji(stem: &str) -> (Option<String>, String) {
    match stem.split_once(' ') {
        Some((first, rest)) if !first.is_empty() && first.chars().all(|c| !c.is_alphanumeric() && !c.is_ascii()) => {
            (Some(first.to_string()), rest.trim().to_string())
        }
        _ => (None, stem.to_string()),
    }
}

/// The default sounds: every audio file in the sounds folder, by name.
pub async fn defaults(st: &AppState) -> Vec<Sound> {
    let mut out = vec![];
    if let Ok(mut dir) = tokio::fs::read_dir(&st.cfg.sounds_dir).await {
        while let Ok(Some(e)) = dir.next_entry().await {
            let file = e.file_name().to_string_lossy().into_owned();
            let Some((stem, ext)) = file.rsplit_once('.') else { continue };
            if file.starts_with('.') || !AUDIO_EXT.contains(&ext.to_ascii_lowercase().as_str()) {
                continue;
            }
            let (emoji, name) = split_emoji(stem);
            out.push(Sound {
                id: format!("default:{file}"),
                guild_id: None,
                name,
                emoji,
                volume: 1.0,
                url: format!("/soundboard/{}", urlencoding::encode(&file)),
                source: None,
                trim_start: 0.0,
                trim_end: None,
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

const COLS: &str = "id::TEXT AS id, guild_id, name, emoji, volume, url, source, trim_start, trim_end";

async fn guild_sounds(st: &AppState, guild: Id) -> ApiResult<Vec<Sound>> {
    Ok(sqlx::query_as::<_, Sound>(&format!("SELECT {COLS} FROM soundboard_sounds WHERE guild_id = $1 ORDER BY name"))
        .bind(guild)
        .fetch_all(&st.db)
        .await?)
}

/// A sound `user` may play: a default one, or one from a server they're in.
pub async fn find(st: &AppState, id: &str, user: Id) -> ApiResult<Sound> {
    if id.starts_with("default:") {
        return defaults(st).await.into_iter().find(|s| s.id == id).ok_or(ApiError::NotFound);
    }
    let id: i64 = id.parse().map_err(|_| ApiError::NotFound)?;
    sqlx::query_as::<_, Sound>(&format!(
        "SELECT {COLS} FROM soundboard_sounds s WHERE id = $1 AND EXISTS (SELECT 1 FROM members m WHERE m.guild_id = s.guild_id AND m.user_id = $2)"
    ))
    .bind(id)
    .bind(user)
    .fetch_optional(&st.db)
    .await?
    .ok_or(ApiError::NotFound)
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/soundboard/default", get(list_defaults))
        .route("/guilds/{id}/soundboard", get(list_guild).post(create))
        .route("/guilds/{id}/soundboard/{sound}", patch(update).delete(remove))
}

async fn list_defaults(State(st): State<AppState>, AuthUser(_): AuthUser) -> ApiResult<Json<Vec<Sound>>> {
    Ok(Json(defaults(&st).await))
}

async fn list_guild(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>) -> ApiResult<Json<Vec<Sound>>> {
    guild_perms(&st.db, id, me).await?;
    Ok(Json(guild_sounds(&st, id).await?))
}

/// Tells the server's members its sounds changed.
async fn announce(st: &AppState, guild: Id) -> ApiResult<()> {
    let sounds = guild_sounds(st, guild).await?;
    st.hub.send(&guild_members(&st.db, guild).await?, "GUILD_SOUNDBOARD_UPDATE", &serde_json::json!({ "guild_id": guild, "sounds": sounds }));
    Ok(())
}

#[derive(Deserialize, Default)]
struct SoundFields {
    name: Option<String>,
    emoji: Option<String>,
    volume: Option<f32>,
    /// The part of the uploaded file that plays, in seconds (default: from the start, up to 5.2 s).
    trim_start: Option<f64>,
    trim_end: Option<f64>,
}

fn upload_path(st: &AppState, url: &str) -> Option<std::path::PathBuf> {
    let rel = url.strip_prefix("/uploads/")?;
    (!rel.contains("..")).then(|| st.cfg.uploads_dir().join(rel))
}

/// Cuts `start..end` seconds of `src` into an MP3 next to it; returns its URL.
async fn cut(st: &AppState, src_url: &str, start: f64, end: f64) -> ApiResult<String> {
    let src = upload_path(st, src_url).ok_or_else(|| bad("couldn't read that sound"))?;
    if !(start >= 0.0 && end - start >= 0.1 && end - start <= MAX_SECONDS + 0.01) {
        return Err(bad("sounds can be at most 5 seconds long"));
    }
    let name = format!("sound-{}.mp3", crate::auth::random_token(6));
    let out_path = src.with_file_name(&name);
    let status = tokio::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error", "-y", "-ss", &format!("{start:.3}"), "-t", &format!("{:.3}", end - start), "-i"])
        .arg(&src)
        .args(["-vn", "-ac", "2", "-ar", "48000", "-c:a", "libmp3lame", "-b:a", "128k"])
        .arg(&out_path)
        .status()
        .await?;
    if !status.success() {
        return Err(bad("couldn't read that sound"));
    }
    Ok(src_url.rsplit_once('/').map(|(dir, _)| format!("{dir}/{name}")).unwrap_or(name))
}

fn clean_name(n: &str) -> ApiResult<String> {
    let n = n.trim();
    if !(2..=32).contains(&n.chars().count()) {
        return Err(bad("sound names must be 2-32 characters"));
    }
    Ok(n.to_string())
}

fn clean_emoji(e: Option<String>) -> Option<String> {
    e.map(|e| e.trim().chars().take(16).collect::<String>()).filter(|e| !e.is_empty())
}

/// Length in seconds with ffprobe; None when ffprobe isn't there (the client checks too).
async fn duration(path: &std::path::Path) -> Option<f64> {
    let out = tokio::process::Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
        .arg(path)
        .output()
        .await
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// Multipart: `file` (mp3, ogg, wav, webm or m4a, up to 1 MB and 5 seconds) and `payload_json` {name, emoji, volume}.
async fn create(State(st): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<Id>, mut mp: Multipart) -> ApiResult<Json<Sound>> {
    guild_perms(&st.db, id, me).await?.require(perms::MANAGE_EMOJIS)?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM soundboard_sounds WHERE guild_id = $1").bind(id).fetch_one(&st.db).await?;
    if count >= MAX_PER_GUILD {
        return Err(bad(format!("servers can have up to {MAX_PER_GUILD} sounds")));
    }
    let mut fields = SoundFields::default();
    let mut file: Option<(String, Vec<u8>)> = None;
    while let Some(field) = mp.next_field().await.map_err(|e| bad(e.body_text()))? {
        match field.name() {
            Some("payload_json") => {
                let text = field.text().await.map_err(|e| bad(e.body_text()))?;
                fields = serde_json::from_str(&text).map_err(|_| bad("invalid payload_json"))?;
            }
            Some("file") => {
                let name = field.file_name().unwrap_or("sound.mp3").to_string();
                let ext = name.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
                if !AUDIO_EXT.contains(&ext.as_str()) {
                    return Err(bad("sounds must be mp3, ogg, wav, webm or m4a files"));
                }
                file = Some((name, uploads::read_field(field, MAX_SOURCE).await?));
            }
            _ => {}
        }
    }
    let (filename, bytes) = file.ok_or_else(|| bad("missing file"))?;
    let name = clean_name(fields.name.as_deref().unwrap_or(filename.rsplit_once('.').map_or(&filename[..], |x| x.0)))?;
    uploads::reserve(&st, me, bytes.len()).await?;
    let source = uploads::save(&st, &format!("sounds/{id}"), &filename, &bytes).await?;
    let path = upload_path(&st, &source).ok_or_else(|| bad("couldn't read that sound"))?;
    let length = duration(&path).await.unwrap_or(MAX_SECONDS);
    let start = fields.trim_start.unwrap_or(0.0).max(0.0);
    let end = fields.trim_end.unwrap_or(start + MAX_SECONDS).min(length).max(start);
    let url = match cut(&st, &source, start, end).await {
        Ok(url) => url,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(path.parent().unwrap()).await;
            uploads::release(&st, me, bytes.len() as u64).await;
            return Err(e);
        }
    };
    let sound = sqlx::query_as::<_, Sound>(&format!(
        "INSERT INTO soundboard_sounds (id, guild_id, name, emoji, volume, url, creator_id, source, trim_start, trim_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING {COLS}"
    ))
    .bind(Id::new())
    .bind(id)
    .bind(name)
    .bind(clean_emoji(fields.emoji))
    .bind(fields.volume.unwrap_or(1.0).clamp(0.0, 1.0))
    .bind(&url)
    .bind(me)
    .bind(&source)
    .bind(start as f32)
    .bind(end as f32)
    .fetch_one(&st.db)
    .await?;
    tracing::info!(user = %me, guild = %id, "soundboard: sound added");
    announce(&st, id).await?;
    Ok(Json(sound))
}

async fn update(State(st): State<AppState>, AuthUser(me): AuthUser, Path((id, sound)): Path<(Id, Id)>, Json(body): Json<SoundFields>) -> ApiResult<Json<Sound>> {
    guild_perms(&st.db, id, me).await?.require(perms::MANAGE_EMOJIS)?;
    let name = body.name.as_deref().map(clean_name).transpose()?;
    // A new trim: cut again from the original and drop the previous cut.
    let mut recut: Option<(String, f64, f64)> = None;
    if body.trim_start.is_some() || body.trim_end.is_some() {
        let (url, source, start, end): (String, Option<String>, f32, Option<f32>) =
            sqlx::query_as("SELECT url, source, trim_start, trim_end FROM soundboard_sounds WHERE id = $1 AND guild_id = $2")
                .bind(sound)
                .bind(id)
                .fetch_optional(&st.db)
                .await?
                .ok_or(ApiError::NotFound)?;
        let src = source.clone().unwrap_or_else(|| url.clone());
        let start = body.trim_start.unwrap_or(start as f64).max(0.0);
        let mut end = body.trim_end.or(end.map(f64::from)).unwrap_or(start + MAX_SECONDS);
        if let Some(len) = upload_path(&st, &src).filter(|p| p.exists()) {
            if let Some(d) = duration(&len).await {
                end = end.min(d);
            }
        }
        let new_url = cut(&st, &src, start, end).await?;
        if source.is_some() && url != src {
            if let Some(old) = upload_path(&st, &url) {
                let _ = tokio::fs::remove_file(old).await;
            }
        }
        recut = Some((new_url, start, end));
    }
    let updated = sqlx::query_as::<_, Sound>(&format!(
        "UPDATE soundboard_sounds SET name = COALESCE($3, name), emoji = CASE WHEN $4 THEN $5 ELSE emoji END, volume = COALESCE($6, volume),
             url = COALESCE($7, url), source = COALESCE(source, CASE WHEN $7 IS NOT NULL THEN url END),
             trim_start = COALESCE($8, trim_start), trim_end = COALESCE($9, trim_end)
         WHERE id = $1 AND guild_id = $2 RETURNING {COLS}"
    ))
    .bind(sound)
    .bind(id)
    .bind(name)
    .bind(body.emoji.is_some())
    .bind(clean_emoji(body.emoji))
    .bind(body.volume.map(|v| v.clamp(0.0, 1.0)))
    .bind(recut.as_ref().map(|r| r.0.clone()))
    .bind(recut.as_ref().map(|r| r.1 as f32))
    .bind(recut.as_ref().map(|r| r.2 as f32))
    .fetch_optional(&st.db)
    .await?
    .ok_or(ApiError::NotFound)?;
    announce(&st, id).await?;
    Ok(Json(updated))
}

async fn remove(State(st): State<AppState>, AuthUser(me): AuthUser, Path((id, sound)): Path<(Id, Id)>) -> ApiResult<()> {
    guild_perms(&st.db, id, me).await?.require(perms::MANAGE_EMOJIS)?;
    let url: String = sqlx::query_scalar("DELETE FROM soundboard_sounds WHERE id = $1 AND guild_id = $2 RETURNING url")
        .bind(sound)
        .bind(id)
        .fetch_optional(&st.db)
        .await?
        .ok_or(ApiError::NotFound)?;
    // Only ever the sound's own random directory under this server's sounds.
    let base = st.cfg.uploads_dir().join("sounds").join(id.to_string());
    if let Some(dir) = url.strip_prefix("/uploads/").and_then(|r| st.cfg.uploads_dir().join(r).parent().map(|d| d.to_path_buf())) {
        if dir.starts_with(&base) && dir != base && !url.contains("..") {
            let _ = tokio::fs::remove_dir_all(dir).await;
        }
    }
    announce(&st, id).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn emoji_prefix_in_file_names() {
        assert_eq!(super::split_emoji("🦆 quack"), (Some("🦆".into()), "quack".into()));
        assert_eq!(super::split_emoji("⛳ golf clap"), (Some("⛳".into()), "golf clap".into()));
        assert_eq!(super::split_emoji("ba dum tss"), (None, "ba dum tss".into()));
    }
}
