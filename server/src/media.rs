//! Running ffmpeg, ffprobe and yt-dlp on what strangers send: how many at once, for how long, with how much memory, and
//! never letting the file choose its own format (a "song" that is really an HLS playlist would make ffmpeg open other
//! files).

use std::path::Path;
use std::process::Output;
use std::sync::OnceLock;
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::error::{ApiError, ApiResult};

/// ffmpeg/ffprobe jobs for uploads at the same time. Voice runs on this machine too.
const MAX_JOBS: usize = 2;
/// yt-dlp lookups at the same time.
const MAX_LOOKUPS: usize = 4;
/// How long a request waits for its turn before being told to try again.
const QUEUE_WAIT: Duration = Duration::from_secs(20);
/// Address space and CPU time for one job. A tiny GIF can declare enormous frames.
const MAX_MEMORY: u64 = 2 * 1024 * 1024 * 1024;
const MAX_CPU_SECS: u64 = 120;
/// The largest GIF side accepted, read from its header before ffmpeg sees it.
pub const MAX_GIF_SIDE: u16 = 4096;

fn jobs() -> &'static std::sync::Arc<Semaphore> {
    static S: OnceLock<std::sync::Arc<Semaphore>> = OnceLock::new();
    S.get_or_init(|| std::sync::Arc::new(Semaphore::new(MAX_JOBS)))
}

fn lookups() -> &'static std::sync::Arc<Semaphore> {
    static S: OnceLock<std::sync::Arc<Semaphore>> = OnceLock::new();
    S.get_or_init(|| std::sync::Arc::new(Semaphore::new(MAX_LOOKUPS)))
}

async fn turn(queue: &std::sync::Arc<Semaphore>) -> ApiResult<OwnedSemaphorePermit> {
    match tokio::time::timeout(QUEUE_WAIT, queue.clone().acquire_owned()).await {
        Ok(Ok(permit)) => Ok(permit),
        _ => Err(ApiError::RateLimited(5.0)),
    }
}

/// A turn for one yt-dlp lookup, held while it runs.
pub async fn lookup_turn() -> ApiResult<OwnedSemaphorePermit> {
    turn(lookups()).await
}

/// Keeps a child process within the limits above (on Windows, only the time limit in `run` applies).
pub fn limit(cmd: &mut Command) {
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            let set = |what, max: u64| {
                let lim = libc::rlimit { rlim_cur: max as libc::rlim_t, rlim_max: max as libc::rlim_t };
                if libc::setrlimit(what, &lim) == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
            };
            set(libc::RLIMIT_AS, MAX_MEMORY)?;
            set(libc::RLIMIT_CPU, MAX_CPU_SECS)
        });
    }
    #[cfg(not(unix))]
    let _ = cmd;
}

/// Runs an upload's job to the end: waits its turn, then limits memory and time. `None` means it took too long.
pub async fn run(mut cmd: Command, timeout: Duration) -> ApiResult<Option<Output>> {
    let _turn = turn(jobs()).await?;
    limit(&mut cmd);
    cmd.kill_on_drop(true).stdin(std::process::Stdio::null());
    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(out) => Ok(Some(out?)),
        Err(_) => Ok(None),
    }
}

/// `ffmpeg` reading `path` strictly as `format`, from a plain file.
pub fn ffmpeg_input(path: &Path, format: &str) -> Command {
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-protocol_whitelist", "file", "-f", format, "-i"]).arg(path);
    cmd
}

/// The ffmpeg format of an audio file, from its first bytes. Everything else is refused, text playlists above all.
pub fn audio_format(head: &[u8]) -> Option<&'static str> {
    match head {
        [b'I', b'D', b'3', ..] => Some("mp3"),
        [0xff, b, ..] if b & 0xe0 == 0xe0 => Some("mp3"),
        [b'O', b'g', b'g', b'S', ..] => Some("ogg"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'A', b'V', b'E', ..] => Some("wav"),
        [0x1a, 0x45, 0xdf, 0xa3, ..] => Some("matroska"),
        [_, _, _, _, b'f', b't', b'y', b'p', ..] => Some("mov"),
        _ => None,
    }
}

/// The format of an audio file on disk.
pub async fn audio_format_of(path: &Path) -> Option<&'static str> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let mut head = [0u8; 16];
    let n = file.read(&mut head).await.ok()?;
    audio_format(&head[..n])
}

/// A GIF's width and height, from its header.
pub fn gif_size(bytes: &[u8]) -> Option<(u16, u16)> {
    if bytes.len() < 10 || !bytes.starts_with(b"GIF8") {
        return None;
    }
    Some((u16::from_le_bytes([bytes[6], bytes[7]]), u16::from_le_bytes([bytes[8], bytes[9]])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_real_audio_files_have_a_format() {
        assert_eq!(audio_format(b"ID3\x04"), Some("mp3"));
        assert_eq!(audio_format(&[0xff, 0xfb, 0x90]), Some("mp3"));
        assert_eq!(audio_format(b"OggS\0"), Some("ogg"));
        assert_eq!(audio_format(b"RIFF\0\0\0\0WAVEfmt "), Some("wav"));
        assert_eq!(audio_format(&[0x1a, 0x45, 0xdf, 0xa3, 1]), Some("matroska"));
        assert_eq!(audio_format(b"\0\0\0\x20ftypM4A "), Some("mov"));
        assert_eq!(audio_format(b"#EXTM3U\n"), None);
        assert_eq!(audio_format(b"ffconcat version 1.0"), None);
        assert_eq!(audio_format(b""), None);
    }

    #[test]
    fn gif_header() {
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&[0xe0, 0x2e, 0xe0, 0x2e]);
        assert_eq!(gif_size(&gif), Some((12000, 12000)));
        assert_eq!(gif_size(b"GIF89a"), None);
        assert_eq!(gif_size(b"PNG89a\0\0\0\0"), None);
    }
}
