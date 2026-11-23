//! Videos every app can show. Linkord plays chat videos in the browser's engine (WebView2 in the desktop app), which
//! only decodes what Chromium ships or Windows provides: a phone video in HEVC (iPhones and many Androids record it by
//! default), 10-bit H.264, ProRes or an MKV plays its sound with no picture, on Windows 10 especially (seen
//! 2026-11-13). So each video attachment is probed once after it's posted; when Chromium can't show it, a
//! copy that any app plays (H.264 8-bit + AAC in a faststart MP4, at most 1920 px) is made next to it at low priority and
//! the message updates (Attachment.playable). Downloads keep the original. Older videos are checked after each start.
//!
//! Kept off the voice's way: one conversion at a time, niced, two threads (media.rs convert).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::api::messages::hydrate;
use crate::gateway::channel_audience;
use crate::id::Id;
use crate::models::{Attachment, Channel, MessageRow, MESSAGE_COLS};
use crate::state::AppState;

/// What a video needs before every app can show it.
#[derive(Debug, PartialEq)]
enum Verdict {
    /// Plays as it is (or isn't a video at all).
    Fine,
    /// Right codecs, wrong box (MKV/AVI with H.264): rewrapped as MP4, nothing re-encoded.
    Remux,
    /// The picture (or the sound) must be encoded again.
    Encode { audio_copy: bool },
}

const AUDIO_OK: [&str; 5] = ["aac", "mp3", "opus", "vorbis", "flac"];

/// From ffprobe's streams: what Chromium shows on any PC (H.264 8-bit 4:2:0, VP8, VP9, AV1) in MP4/MOV or WebM.
fn verdict(json: &Value, format: &str) -> (Verdict, Option<String>) {
    let streams = json["streams"].as_array().cloned().unwrap_or_default();
    let Some(video) = streams.iter().find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1) else {
        return (Verdict::Fine, None);
    };
    let codec = video["codec_name"].as_str().unwrap_or("").to_string();
    let pix = video["pix_fmt"].as_str().unwrap_or("");
    let video_ok = match codec.as_str() {
        "h264" => matches!(pix, "yuv420p" | "yuvj420p"),
        "vp8" | "av1" => true,
        "vp9" => matches!(pix, "yuv420p" | "yuv420p10le"),
        _ => false,
    };
    let audio = streams.iter().find(|s| s["codec_type"] == "audio").and_then(|a| a["codec_name"].as_str());
    let audio_ok = audio.is_none_or(|a| AUDIO_OK.contains(&a));
    let webm_codecs = matches!(codec.as_str(), "vp8" | "vp9" | "av1") && audio.is_none_or(|a| matches!(a, "opus" | "vorbis"));
    let container_ok = match format {
        "mov" => true,
        "matroska" => webm_codecs,
        _ => false,
    };
    let v = match (video_ok, audio_ok, container_ok) {
        (true, true, true) => Verdict::Fine,
        (true, true, false) => Verdict::Remux,
        (_, audio_ok, _) => Verdict::Encode { audio_copy: audio_ok && audio.is_some_and(|a| a == "aac" || a == "mp3") },
    };
    (v, Some(codec))
}

/// The container, from the first bytes (the name and declared type are the uploader's word).
fn video_format(head: &[u8]) -> Option<&'static str> {
    match head {
        [_, _, _, _, b'f', b't', b'y', b'p', ..] => Some("mov"),
        [0x1a, 0x45, 0xdf, 0xa3, ..] => Some("matroska"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'A', b'V', b'I', b' ', ..] => Some("avi"),
        _ => None,
    }
}

async fn format_of(path: &Path) -> Option<&'static str> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let mut head = [0u8; 16];
    let n = file.read(&mut head).await.ok()?;
    video_format(&head[..n])
}

async fn probe(path: &Path, format: &str) -> Option<Value> {
    let mut cmd = tokio::process::Command::new("ffprobe");
    cmd.args(["-v", "error", "-protocol_whitelist", "file", "-f", format])
        .args(["-show_entries", "stream=codec_type,codec_name,pix_fmt:stream_disposition=attached_pic", "-of", "json", "-i"])
        .arg(path);
    let out = crate::media::run(cmd, Duration::from_secs(60)).await.ok()??;
    out.status.success().then(|| serde_json::from_slice(&out.stdout).ok()).flatten()
}

/// Makes `playable.mp4` beside `src`; true when it worked.
async fn convert(src: &Path, format: &str, how: &Verdict, dst: &Path) -> bool {
    let tmp = dst.with_extension("part.mp4");
    let mut ff = crate::media::ffmpeg_input(src, format);
    ff.args(["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-map_metadata", "-1"]);
    match how {
        Verdict::Fine => return false,
        Verdict::Remux => {
            ff.args(["-c", "copy"]);
        }
        Verdict::Encode { audio_copy } => {
            ff.args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-profile:v", "high"])
                .args(["-vf", "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"])
                .args(["-threads", "2"]);
            if *audio_copy {
                ff.args(["-c:a", "copy"]);
            } else {
                ff.args(["-c:a", "aac", "-b:a", "160k", "-ac", "2"]);
            }
        }
    }
    ff.args(["-movflags", "+faststart", "-f", "mp4"]).arg(&tmp);
    let ok = matches!(crate::media::convert(ff, Duration::from_secs(30 * 60)).await, Some(o) if o.status.success());
    if ok && tokio::fs::rename(&tmp, dst).await.is_ok() {
        return true;
    }
    let _ = tokio::fs::remove_file(&tmp).await;
    false
}

/// Checks one attachment (once: `codec` marks it checked) and makes its playable copy if needed. True if it changed.
async fn check(st: &AppState, a: &mut Attachment) -> bool {
    if a.codec.is_some() || !a.content_type.starts_with("video/") {
        return false;
    }
    let Some(src) = crate::soundboard::upload_path(st, &a.url) else { return false };
    let Some(format) = format_of(&src).await else {
        a.codec = Some(String::new());
        return true;
    };
    let Some(json) = probe(&src, format).await else { return false };
    let (how, codec) = verdict(&json, format);
    a.codec = Some(codec.unwrap_or_default());
    if how != Verdict::Fine {
        let dst: PathBuf = src.with_file_name("playable.mp4");
        tracing::info!(attachment = %a.id, ?how, codec = a.codec.as_deref().unwrap_or(""), "videos: making a playable copy");
        if convert(&src, format, &how, &dst).await {
            let rel = Path::new(a.url.trim_start_matches('/')).with_file_name("playable.mp4");
            a.playable = Some(format!("/{}", rel.display()).replace('\\', "/"));
        } else {
            tracing::warn!(attachment = %a.id, "videos: the copy couldn't be made");
        }
    }
    true
}

/// Stores new attachments if nobody changed them meanwhile (a moderator removing a file must stay removed); the
/// updated message, for MESSAGE_UPDATE.
async fn store(st: &AppState, message: Id, old: &Value, new: &[Attachment]) -> Option<MessageRow> {
    sqlx::query_as::<_, MessageRow>(&format!("UPDATE messages SET attachments = $2 WHERE id = $1 AND attachments = $3 RETURNING {MESSAGE_COLS}"))
        .bind(message)
        .bind(sqlx::types::Json(new))
        .bind(sqlx::types::Json(old))
        .fetch_optional(&st.db)
        .await
        .ok()
        .flatten()
}

async fn announce(st: &AppState, ch: &Channel, row: MessageRow) {
    if let (Ok(Some(msg)), Ok(audience)) = (hydrate(st, vec![row]).await.map(|mut v| v.pop()), channel_audience(&st.db, ch).await) {
        st.hub.send(&audience, "MESSAGE_UPDATE", &msg);
    }
}

/// After a message is posted: its videos, in the background.
pub fn spawn(st: AppState, ch: Channel, message: Id, attachments: Vec<Attachment>) {
    if !attachments.iter().any(|a| a.content_type.starts_with("video/")) {
        return;
    }
    tokio::spawn(async move {
        let old = serde_json::to_value(&attachments).unwrap_or_default();
        let mut new = attachments;
        let mut changed = false;
        for a in new.iter_mut() {
            changed |= check(&st, a).await;
        }
        if changed {
            if let Some(row) = store(&st, message, &old, &new).await {
                announce(&st, &ch, row).await;
            }
        }
    });
}

/// Videos posted before this check existed, after each start (one at a time; ones already checked are skipped).
pub async fn backfill(st: AppState) {
    tokio::time::sleep(Duration::from_secs(30)).await;
    let mut after = Id(0);
    loop {
        let rows: Result<Vec<(Id, Id, sqlx::types::Json<Value>)>, _> = sqlx::query_as(
            "SELECT id, channel_id, attachments FROM messages
             WHERE id > $1 AND EXISTS (
                 SELECT 1 FROM jsonb_array_elements(attachments) a WHERE a->>'content_type' LIKE 'video/%' AND NOT a ? 'codec'
             )
             ORDER BY id LIMIT 50",
        )
        .bind(after)
        .fetch_all(&st.db)
        .await;
        let rows = match rows {
            Ok(rows) => rows,
            Err(e) => return tracing::warn!("video check stopped: {e}"),
        };
        let Some(last) = rows.last().map(|(id, ..)| *id) else { break };
        after = last;
        for (id, channel, old) in rows {
            let Ok(mut new) = serde_json::from_value::<Vec<Attachment>>(old.0.clone()) else { continue };
            let mut changed = false;
            for a in new.iter_mut() {
                changed |= check(&st, a).await;
            }
            if !changed {
                continue;
            }
            if let Some(row) = store(&st, id, &old.0, &new).await {
                if let Ok(ch) = Channel::get(&st.db, channel).await {
                    announce(&st, &ch, row).await;
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn probe(v: &str, pix: &str, a: Option<&str>) -> Value {
        let mut streams = vec![json!({ "codec_type": "video", "codec_name": v, "pix_fmt": pix })];
        if let Some(a) = a {
            streams.push(json!({ "codec_type": "audio", "codec_name": a }));
        }
        json!({ "streams": streams })
    }

    #[test]
    fn what_chromium_shows_plays_as_is() {
        assert_eq!(verdict(&probe("h264", "yuv420p", Some("aac")), "mov").0, Verdict::Fine);
        assert_eq!(verdict(&probe("vp9", "yuv420p", Some("opus")), "matroska").0, Verdict::Fine);
        assert_eq!(verdict(&probe("av1", "yuv420p", None), "mov").0, Verdict::Fine);
        assert_eq!(verdict(&json!({ "streams": [{ "codec_type": "audio", "codec_name": "aac" }] }), "mov"), (Verdict::Fine, None));
    }

    #[test]
    fn phone_hevc_and_odd_formats_get_a_copy() {
        // An iPhone video: HEVC in a MOV, AAC sound kept.
        assert_eq!(verdict(&probe("hevc", "yuv420p10le", Some("aac")), "mov"), (Verdict::Encode { audio_copy: true }, Some("hevc".into())));
        assert_eq!(verdict(&probe("h264", "yuv420p10le", Some("aac")), "mov").0, Verdict::Encode { audio_copy: true });
        assert_eq!(verdict(&probe("prores", "yuv422p10le", Some("pcm_s16le")), "mov").0, Verdict::Encode { audio_copy: false });
        // OBS's MKV: right codecs, wrong box.
        assert_eq!(verdict(&probe("h264", "yuv420p", Some("aac")), "matroska").0, Verdict::Remux);
        assert_eq!(verdict(&probe("h264", "yuv420p", Some("ac3")), "matroska").0, Verdict::Encode { audio_copy: false });
        assert_eq!(verdict(&probe("mpeg4", "yuv420p", Some("mp3")), "avi").0, Verdict::Encode { audio_copy: true });
    }

    #[test]
    fn the_box_comes_from_the_bytes() {
        assert_eq!(video_format(b"\0\0\0\x20ftypqt  "), Some("mov"));
        assert_eq!(video_format(&[0x1a, 0x45, 0xdf, 0xa3, 1]), Some("matroska"));
        assert_eq!(video_format(b"RIFF\0\0\0\0AVI LIST"), Some("avi"));
        assert_eq!(video_format(b"#EXTM3U\n"), None);
    }
}
