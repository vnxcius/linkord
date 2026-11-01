use std::path::Path;

use axum::extract::multipart::Field;

use crate::auth::random_token;
use crate::error::{bad, ApiResult};
use crate::id::Id;
use crate::state::AppState;

pub const MAX_FILE: usize = 25 * 1024 * 1024;
pub const MAX_IMAGE: usize = 8 * 1024 * 1024;
/// A whole request with attachments (10 files of up to 25 MB, plus overhead).
pub const MESSAGE_BODY: usize = 260 * 1024 * 1024;
/// A whole request with one picture, sound or song.
pub const UPLOAD_BODY: usize = 32 * 1024 * 1024;

pub fn sanitize_filename(name: &str) -> String {
    let base = Path::new(name).file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let s: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect();
    let s = s.trim_start_matches('.').chars().take(100).collect::<String>();
    if s.is_empty() { "file".into() } else { s }
}

/// Writes the file under `uploads/<dir>/<random>/<filename>` and returns its public path.
pub async fn save(st: &AppState, dir: &str, filename: &str, bytes: &[u8]) -> std::io::Result<String> {
    let rel = format!("{dir}/{}/{}", random_token(9), sanitize_filename(filename));
    let path = st.cfg.uploads_dir().join(&rel);
    tokio::fs::create_dir_all(path.parent().unwrap()).await?;
    tokio::fs::write(&path, bytes).await?;
    Ok(format!("/uploads/{rel}"))
}

/// Attachments saved for a message that isn't posted yet. If the request fails before it is, they go, and the space
/// counted for them comes back: nothing would ever point at them.
pub struct SavedFiles {
    st: AppState,
    user: Id,
    files: Vec<(String, u64)>,
}

impl SavedFiles {
    pub fn new(st: &AppState, user: Id) -> Self {
        SavedFiles { st: st.clone(), user, files: Vec::new() }
    }

    pub fn add(&mut self, url: &str, size: u64) {
        self.files.push((url.to_string(), size));
    }

    pub fn keep(mut self) {
        self.files.clear();
    }
}

impl Drop for SavedFiles {
    fn drop(&mut self) {
        let files = std::mem::take(&mut self.files);
        if files.is_empty() {
            return;
        }
        let (st, user) = (self.st.clone(), self.user);
        tokio::spawn(async move {
            for (url, size) in files {
                if let Some(dir) = url.strip_prefix("/uploads/").and_then(|rel| rel.rsplit_once('/')).map(|(dir, _)| dir.to_string()) {
                    let _ = tokio::fs::remove_dir_all(st.cfg.uploads_dir().join(dir)).await;
                }
                release(&st, user, size).await;
            }
        });
    }
}

/// Reads a multipart field up to `limit` bytes.
pub async fn read_field(mut field: Field<'_>, limit: usize) -> ApiResult<Vec<u8>> {
    let mut buf = Vec::new();
    while let Some(chunk) = field.chunk().await.map_err(|e| bad(e.to_string()))? {
        if buf.len() + chunk.len() > limit {
            return Err(bad(format!("file exceeds {} MB", limit / 1024 / 1024)));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

pub fn is_image(content_type: &str) -> bool {
    matches!(content_type, "image/png" | "image/jpeg" | "image/gif" | "image/webp")
}

/// The extension for an image, from its first bytes. The name and type a client declares decide nothing: the type a
/// file is served with comes from its extension.
pub fn image_ext(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, ..] => Some("png"),
        [0xff, 0xd8, 0xff, ..] => Some("jpg"),
        [b'G', b'I', b'F', b'8', ..] => Some("gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("webp"),
        _ => None,
    }
}

/// `stem.ext` for an uploaded image, or an error if the bytes aren't one of the allowed formats.
pub fn image_name(stem: &str, bytes: &[u8]) -> ApiResult<String> {
    image_ext(bytes).map(|ext| format!("{stem}.{ext}")).ok_or_else(|| bad("must be a png, jpeg, gif or webp image"))
}

/// Downloads a remote image (Discord avatar/banner) into local storage.
pub async fn mirror(st: &AppState, url: &str, dir: &str) -> Option<String> {
    let resp = st.http.get(url).send().await.ok()?.error_for_status().ok()?;
    let ext = match resp.headers().get("content-type").and_then(|v| v.to_str().ok()) {
        Some("image/gif") => "gif",
        Some("image/jpeg") => "jpg",
        Some("image/webp") => "webp",
        _ => "png",
    };
    let bytes = resp.bytes().await.ok()?;
    match save(st, dir, &format!("image.{ext}"), &bytes).await {
        Ok(p) => Some(p),
        Err(e) => {
            tracing::warn!("mirroring {url} failed: {e}");
            None
        }
    }
}

/// Counts `bytes` against the user's upload quota, failing if it would be exceeded.
pub async fn reserve(st: &AppState, user: Id, bytes: usize) -> ApiResult<()> {
    let ok: Option<i64> = sqlx::query_scalar(
        "UPDATE users SET upload_bytes = upload_bytes + $2 WHERE id = $1 AND upload_bytes + $2 <= $3 RETURNING upload_bytes",
    )
    .bind(user)
    .bind(bytes as i64)
    .bind(st.cfg.upload_quota as i64)
    .fetch_optional(&st.db)
    .await?;
    ok.map(|_| ()).ok_or_else(|| bad("you've used up your upload space; delete some old files first"))
}

pub async fn release(st: &AppState, user: Id, bytes: u64) {
    let _ = sqlx::query("UPDATE users SET upload_bytes = GREATEST(0, upload_bytes - $2) WHERE id = $1")
        .bind(user)
        .bind(bytes as i64)
        .execute(&st.db)
        .await;
}

/// Browsers record voice messages as WebM without a duration or seek index, so players can't seek in
/// them. Rewrites the file as Ogg/Opus next to the original (same audio, no re-encode). Keeps the
/// original if ffmpeg is missing or fails.
pub async fn remux_voice(st: &AppState, user: Id, att: &mut crate::models::Attachment) {
    if !att.content_type.starts_with("audio/webm") {
        return;
    }
    let Some(rel) = att.url.strip_prefix("/uploads/") else { return };
    let src = st.cfg.uploads_dir().join(rel);
    let dst = src.with_file_name("voice-message.ogg");
    // Only what a recorder makes: the name and declared type are the client's word, the file itself isn't.
    if crate::media::audio_format_of(&src).await != Some("matroska") {
        return;
    }
    let mut ff = crate::media::ffmpeg_input(&src, "matroska");
    ff.args(["-vn", "-c:a", "copy", "-f", "ogg"]).arg(&dst);
    let ok = matches!(crate::media::run(ff, std::time::Duration::from_secs(30)).await, Ok(Some(o)) if o.status.success());
    let size = if ok { tokio::fs::metadata(&dst).await.ok().map(|m| m.len()) } else { None };
    let Some(new) = size else {
        let _ = tokio::fs::remove_file(&dst).await;
        return;
    };
    let _ = tokio::fs::remove_file(&src).await;
    let old = att.size;
    if new < old {
        release(st, user, old - new).await;
    } else if new > old {
        let _ = reserve(st, user, (new - old) as usize).await;
    }
    att.url = format!("/uploads/{}", std::path::Path::new(rel).with_file_name("voice-message.ogg").display());
    att.filename = "voice-message.ogg".into();
    att.content_type = "audio/ogg".into();
    att.size = new;
}

/// Removes an attachment's files (its random directory under attachments/), unless a message still shows them:
/// forwards share the original's files, so call this after deleting the message row.
pub async fn delete_attachment(st: &AppState, url: &str) {
    let Some(rel) = url.strip_prefix("/uploads/attachments/") else { return };
    let mut parts = rel.split('/');
    if let (Some(ch), Some(dir)) = (parts.next(), parts.next()) {
        let Ok(ch_id) = ch.parse::<i64>() else { return };
        if !ch.chars().all(|c| c.is_ascii_digit()) || dir.is_empty() || dir.contains("..") {
            return;
        }
        // The directory is named after the original's channel, so its own row is found through messages_channel.
        let probe = serde_json::json!([{ "url": url }]);
        let used: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE (channel_id = $1 AND attachments @> $2)
                OR (forwarded IS NOT NULL AND forwarded->'attachments' @> $2))",
        )
        .bind(ch_id)
        .bind(&probe)
        .fetch_one(&st.db)
        .await
        .unwrap_or(true);
        if !used {
            let _ = tokio::fs::remove_dir_all(st.cfg.uploads_dir().join("attachments").join(ch).join(dir)).await;
        }
    }
}
