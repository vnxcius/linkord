//! REC's session engine (Windows): one recording at a time, started and stopped by the app (lib/rec.ts) when a game
//! starts and ends, and everything around it.
//!
//! The folder (`Videos\Linkord` unless the user picked one; `Videos\Linkord Dev` for the dev app):
//! - `VODs/<date> <game>/`: the recording (vod.rs segments), `session.json` (`Meta`: game, times, size, bookmarks,
//!   events, stems, starred) and `thumbs/<second>.jpg` (a picture every 10 s, for the timeline).
//! - `Clips/<game> <date>.mp4` and `Screenshots/<game> <date>.png`, each with a `.json` sidecar (`ItemMeta`).
//!   There's no index file: the library is the folder, so moving or cleaning it by hand never confuses REC.
//!
//! Limits (owner): VODs and clips + screenshots each have a cap in GB; past it the oldest go first, never one that's
//! starred, shared or being recorded. Below the free-disk floor the recording stops and says why.
//! Nothing here draws anything: the app plays a sound, and only the REC overlay shows that it's recording.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub use super::model::*;
use tauri::{AppHandle, Emitter};

use super::audio::{AudioRecorder, AudioSettings, Source};
use super::gpu::{Grab, VideoRecorder, VideoSettings};
use super::{mp4, vod, Shared};
use crate::capture::audio::process_loopback_supported;
use crate::capture::duplication::Target;

struct Recording {
    dir: PathBuf,
    meta: Meta,
    origin: Instant,
    writer: Shared,
    video: Option<VideoRecorder>,
    audio: Option<AudioRecorder>,
    settings: VideoSettings,
    voices: bool,
    /// Seconds into the recording of the last thumbnail.
    last_thumb: Option<u64>,
}

#[derive(Default)]
struct Engine {
    config: Config,
    rec: Option<Recording>,
    error: Option<String>,
}

static ENGINE: Mutex<Option<Engine>> = Mutex::new(None);
static APP: OnceLock<AppHandle> = OnceLock::new();

fn with<T>(f: impl FnOnce(&mut Engine) -> T) -> T {
    let mut guard = ENGINE.lock().unwrap();
    f(guard.get_or_insert_with(Engine::default))
}

/// Starts the housekeeping (thumbnails, caps, disk space, a recorder that stopped by itself). Called once at startup.
pub fn init(app: AppHandle) {
    let _ = APP.set(app);
    start_housekeeping();
}

/// The housekeeping thread alone (`init` starts it; tools without the app call this).
pub fn start_housekeeping() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        std::thread::Builder::new().name("linkord-rec".into()).spawn(housekeeping).ok();
    });
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn emit_status() {
    if let Some(app) = APP.get() {
        let _ = app.emit("rec-status", status());
    }
}

/// Something was saved (or failed to): the app plays a sound.
fn emit_saved(kind: &str, path: Option<&Path>, error: Option<String>) {
    if let Some(app) = APP.get() {
        let _ = app.emit("rec-saved", serde_json::json!({ "kind": kind, "path": path.map(|p| p.display().to_string()), "error": error }));
    }
}

pub fn status() -> Status {
    with(|e| {
        let folder = root(&e.config).display().to_string();
        match &e.rec {
            Some(r) => {
                let live = |stem: &str, gain: Option<&std::sync::atomic::AtomicU32>| {
                    r.meta.stems.iter().any(|s| s == stem).then(|| gain.is_none_or(|g| f32::from_bits(g.load(std::sync::atomic::Ordering::Relaxed)) > 0.0))
                };
                let gains = r.audio.as_ref().map(|a| &a.gains);
                Status {
                    recording: true,
                    game: Some(r.meta.game.clone()),
                    since: Some(r.meta.started),
                    paused: r.video.as_ref().is_some_and(|v| v.paused()),
                    voices: r.voices,
                    folder,
                    error: e.error.clone(),
                    mic_on: live("mic", gains.map(|g| &g.mic)),
                    voices_on: live("voices", gains.map(|g| &g.voices)),
                }
            }
            None => Status { folder, error: e.error.clone(), ..Status::default() },
        }
    })
}

// ---------- folders and names ----------

/// The REC folder.
pub fn root(config: &Config) -> PathBuf {
    if !config.folder.trim().is_empty() {
        return PathBuf::from(config.folder.trim());
    }
    let videos = unsafe {
        use windows::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_Videos, KF_FLAG_DEFAULT};
        SHGetKnownFolderPath(&FOLDERID_Videos, KF_FLAG_DEFAULT, None).ok().and_then(|p| {
            let s = p.to_string().ok();
            windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _));
            s
        })
    };
    let videos = videos.map(PathBuf::from).unwrap_or_else(|| PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default()).join("Videos"));
    // The dev app records into its own folder, so trying REC never mixes with the real library.
    videos.join(if cfg!(debug_assertions) { "Linkord Dev" } else { "Linkord" })
}

/// "2026-11-13 21-04-05", local time.
fn stamp() -> String {
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    format!("{:04}-{:02}-{:02} {:02}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}

/// A game's name made safe for a file name.
pub fn file_safe(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { ' ' } else { c }).collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed: String = cleaned.chars().take(60).collect();
    let trimmed = trimmed.trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() {
        "Recording".into()
    } else {
        trimmed
    }
}

/// `dir/name.ext`, or `dir/name (2).ext`... if taken.
fn unique(dir: &Path, name: &str, ext: &str) -> PathBuf {
    let mut path = dir.join(format!("{name}.{ext}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{name} ({n}).{ext}"));
        n += 1;
    }
    path
}

fn sidecar(path: &Path) -> PathBuf {
    path.with_extension("json")
}

fn write_json<T: Serialize>(path: &Path, value: &T) {
    let tmp = path.with_extension("json.tmp");
    if let Ok(text) = serde_json::to_vec_pretty(value) {
        if fs::write(&tmp, text).and_then(|_| fs::rename(&tmp, path)).is_err() {
            let _ = fs::remove_file(&tmp);
        }
    }
}

fn read_json<T: for<'a> Deserialize<'a> + Default>(path: &Path) -> T {
    fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// A path the app sent, accepted only inside the REC folder.
pub fn inside(path: &str) -> Result<PathBuf, String> {
    let root = with(|e| root(&e.config));
    let root = fs::canonicalize(&root).map_err(|_| "no REC folder yet".to_string())?;
    let path = fs::canonicalize(path).map_err(|_| "not found".to_string())?;
    if path.starts_with(&root) && path != root {
        Ok(path)
    } else {
        Err("not in the REC folder".into())
    }
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else { return fs::metadata(path).map(|m| m.len()).unwrap_or(0) };
    entries.flatten().map(|e| match e.file_type() {
        Ok(t) if t.is_dir() => dir_size(&e.path()),
        _ => e.metadata().map(|m| m.len()).unwrap_or(0),
    }).sum()
}

fn free_space(path: &Path) -> Option<u64> {
    use windows::core::HSTRING;
    let mut free = 0u64;
    let probe = path.ancestors().find(|p| p.exists())?;
    unsafe { windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(&HSTRING::from(probe.as_os_str()), Some(&mut free), None, None) }.ok()?;
    Some(free)
}

const GB: f64 = 1024.0 * 1024.0 * 1024.0;

// ---------- recording ----------

fn video_settings(c: &Config) -> VideoSettings {
    VideoSettings { max_height: c.max_height, fps: c.fps.clamp(15, 120), bitrate: c.bitrate_kbps.clamp(1_000, 100_000) * 1000, cursor: c.cursor }
}

/// Windows 11 records only the game's own sound; Windows 10 has the whole PC's (which holds the voice chat already).
/// A manual recording (pid 0, no game) gets everything the PC plays except Linkord.
fn audio_settings(c: &Config, pid: u32) -> AudioSettings {
    let per_process = process_loopback_supported();
    let game = match (per_process, pid) {
        (false, _) => Source::System,
        (true, 0) => Source::AllExcept(crate::capture::linkord_audio_pid()),
        (true, pid) => Source::Only(pid),
    };
    AudioSettings {
        game: c.game_audio.then_some(game),
        mic: c.mic.clone(),
        output: c.output.clone(),
        voices: c.voices && (per_process || !c.game_audio),
    }
}

/// "window:<hwnd>", "screen:<hmonitor>" (a desktop recording, on the display the user picked), or "screen:front"
/// (the monitor of the window in front; older clients).
fn window_target(window: &str) -> Result<Target, String> {
    if let Some(monitor) = window.strip_prefix("screen:").and_then(|m| m.parse::<usize>().ok()) {
        return Ok(Target::Screen(monitor));
    }
    if window == "screen:front" {
        use windows::Win32::Graphics::Gdi::{MonitorFromWindow, MONITOR_DEFAULTTOPRIMARY};
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        let monitor = unsafe { MonitorFromWindow(GetForegroundWindow(), MONITOR_DEFAULTTOPRIMARY) };
        return Ok(Target::Screen(monitor.0 as usize));
    }
    window.strip_prefix("window:").and_then(|h| h.parse::<usize>().ok()).map(Target::Window).ok_or_else(|| "bad window".into())
}

pub fn configure(config: Config) {
    let folder = root(&config);
    with(|e| e.config = config);
    // The app shows recordings through the asset protocol, which reaches nothing else on disk.
    let _ = fs::create_dir_all(&folder);
    if let Some(app) = APP.get() {
        use tauri::Manager;
        let _ = app.asset_protocol_scope().allow_directory(&folder, true);
    }
    emit_status();
}

/// What the player needs for one VOD: its parts and segments, and the timeline pictures (ms, path).
#[derive(Serialize)]
pub struct VodIndex {
    pub meta: Meta,
    pub parts: Vec<vod::PartIndex>,
    pub thumbs: Vec<(u64, String)>,
}

pub fn vod_index(dir: &str) -> Result<VodIndex, String> {
    let dir = inside(dir)?;
    let meta: Meta = read_json(&dir.join("session.json"));
    let parts = vod::index(&dir).map_err(|e| e.to_string())?;
    let mut thumbs: Vec<(u64, String)> = fs::read_dir(dir.join("thumbs"))
        .map(|e| e.flatten().filter_map(|f| {
            let p = f.path();
            let secs: u64 = p.file_stem()?.to_str()?.parse().ok()?;
            Some((secs * 1000, p.display().to_string()))
        }).collect())
        .unwrap_or_default();
    thumbs.sort();
    Ok(VodIndex { meta, parts, thumbs })
}

pub fn start(game: Game) -> Result<(), String> {
    let config = with(|e| {
        e.error = None;
        e.config.clone()
    });
    if with(|e| e.rec.as_ref().is_some_and(|r| r.meta.key == game.key)) {
        return Ok(());
    }
    stop();
    let root = root(&config);
    if free_space(&root).is_some_and(|f| (f as f64) < config.min_free_gb * GB) {
        let message = "not enough free disk space".to_string();
        with(|e| e.error = Some(message.clone()));
        emit_status();
        return Err(message);
    }
    let dir = root.join("VODs").join(format!("{} {}", stamp(), file_safe(&game.name)));
    let target = window_target(&game.window)?;
    let settings = video_settings(&config);
    let audio = audio_settings(&config, game.pid);
    let stems: Vec<String> = [(audio.game.is_some(), "game"), (audio.mic.is_some(), "mic"), (audio.voices, "voices")].iter().filter(|s| s.0).map(|s| s.1.to_string()).collect();
    let writer = Shared(Arc::new(Mutex::new(vod::Writer::new(dir.clone(), settings.fps, audio.tracks()).map_err(|e| e.to_string())?)));
    let origin = Instant::now();
    let video = match VideoRecorder::start(target, settings, origin, writer.clone()) {
        Ok(v) => v,
        Err(e) => {
            drop(writer);
            let _ = fs::remove_dir_all(&dir);
            with(|en| en.error = Some(e.clone()));
            emit_status();
            return Err(e);
        }
    };
    let meta = Meta { version: 1, game: game.name.clone(), key: game.key.clone(), started: now_ms(), width: video.width, height: video.height, stems, ..Meta::default() };
    write_json(&dir.join("session.json"), &meta);
    let audio_rec = (audio.tracks() > 0).then(|| AudioRecorder::start(&audio, origin, writer.clone()));
    let voices = audio.voices;
    with(|e| e.rec = Some(Recording { dir, meta, origin, writer, video: Some(video), audio: audio_rec, settings, voices, last_thumb: None }));
    emit_status();
    Ok(())
}

/// Leaves your mic or the voice chat out of the recording from now on (or puts it back): the overlay's switches.
pub fn set_live(mic: Option<bool>, voices: Option<bool>) {
    with(|e| {
        let Some(audio) = e.rec.as_ref().and_then(|r| r.audio.as_ref()) else { return };
        let bits = |on: bool| if on { 1.0f32 } else { 0.0 }.to_bits();
        if let Some(on) = mic {
            audio.gains.mic.store(bits(on), std::sync::atomic::Ordering::Relaxed);
        }
        if let Some(on) = voices {
            audio.gains.voices.store(bits(on), std::sync::atomic::Ordering::Relaxed);
        }
    });
    emit_status();
}

/// The game moved to another window/process (League: client -> game): follow it, same recording.
pub fn retarget(window: String, pid: u32) -> Result<(), String> {
    let target = window_target(&window)?;
    let (writer, origin, settings) = with(|e| e.rec.as_mut().map(|r| (r.writer.clone(), r.origin, r.settings))).ok_or("not recording")?;
    // The old capture goes first (its encoder finishes its part).
    let old = with(|e| e.rec.as_mut().and_then(|r| r.video.take()));
    drop(old);
    let video = VideoRecorder::start(target, settings, origin, writer);
    let config = with(|e| e.config.clone());
    with(|e| {
        if let Some(r) = e.rec.as_mut() {
            if let (Some(audio), Some(source)) = (&r.audio, audio_settings(&config, pid).game) {
                audio.set_game(source);
            }
            match video {
                Ok(v) => r.video = Some(v),
                Err(err) => e.error = Some(err),
            }
        }
    });
    Ok(())
}

pub fn stop() {
    let Some(mut rec) = with(|e| e.rec.take()) else { return };
    emit_status();
    drop(rec.video.take());
    drop(rec.audio.take());
    {
        let mut w = rec.writer.0.lock().unwrap();
        w.finish();
        rec.meta.duration_ms = w.written_end() * 1000 / mp4::VIDEO_TIMESCALE as u64;
        if let Some(e) = &w.error {
            with(|en| en.error = Some(format!("writing the recording: {e}")));
        }
    }
    rec.meta.finished = true;
    rec.meta.size = dir_size(&rec.dir);
    // Nothing usable (stopped right away): don't leave an empty VOD around.
    if rec.meta.duration_ms < 1000 {
        let _ = fs::remove_dir_all(&rec.dir);
    } else {
        write_json(&rec.dir.join("session.json"), &rec.meta);
    }
    emit_status();
    enforce_caps();
}

/// Ms into the recording now.
fn elapsed(rec: &Recording) -> u64 {
    rec.origin.elapsed().as_millis() as u64
}

pub fn bookmark() -> Result<u64, String> {
    let ms = with(|e| {
        let r = e.rec.as_mut()?;
        let ms = elapsed(r);
        r.meta.bookmarks.push(ms);
        write_json(&r.dir.join("session.json"), &r.meta);
        Some(ms)
    })
    .ok_or("not recording")?;
    emit_saved("bookmark", None, None);
    Ok(ms)
}

/// A game event on the timeline (League: kills, objectives...).
pub fn event(kind: String, label: String, ago_ms: u64) {
    with(|e| {
        if let Some(r) = e.rec.as_mut() {
            let ms = elapsed(r).saturating_sub(ago_ms.min(60_000));
            r.meta.events.push(Event { ms, kind, label });
            write_json(&r.dir.join("session.json"), &r.meta);
        }
    });
}

/// Saves the last `seconds` of the recording as a clip. Waits (on this thread) for the newest part to reach the disk:
/// the encoder is asked for a keyframe so the segment closes at once, a second or so.
pub fn clip(seconds: Option<u32>, title: Option<String>) -> Result<PathBuf, String> {
    let (dir, writer, game, until, length) = with(|e| {
        let length = seconds.unwrap_or(e.config.clip_seconds).clamp(5, 300) as u64;
        let r = e.rec.as_mut()?;
        let ms = elapsed(r);
        r.meta.events.push(Event { ms, kind: "clip".into(), label: String::new() });
        write_json(&r.dir.join("session.json"), &r.meta);
        if let Some(v) = &r.video {
            v.keyframe_now();
        }
        r.writer.0.lock().unwrap().cut_soon();
        Some((r.dir.clone(), r.writer.clone(), r.meta.game.clone(), ms * mp4::VIDEO_TIMESCALE as u64 / 1000, length))
    })
    .ok_or("not recording")?;
    let deadline = Instant::now() + Duration::from_secs(6);
    while writer.0.lock().unwrap().written_end() < until && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    let root = with(|e| root(&e.config));
    let clips = root.join("Clips");
    fs::create_dir_all(&clips).map_err(|e| e.to_string())?;
    let title = title.map(|t| t.trim().chars().take(100).collect::<String>()).unwrap_or_default();
    let name = if title.is_empty() { format!("{} {}", file_safe(&game), stamp()) } else { format!("{} {}", file_safe(&title), stamp()) };
    let path = unique(&clips, &name, "mp4");
    let from = until.saturating_sub(length * mp4::VIDEO_TIMESCALE as u64);
    vod::export(&dir, from, until, &path).map_err(|e| e.to_string())?;
    let source = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let meta = ItemMeta { game, title, created: now_ms(), duration_ms: (until - from) * 1000 / mp4::VIDEO_TIMESCALE as u64, source, ..ItemMeta::default() };
    write_json(&sidecar(&path), &meta);
    enforce_caps();
    Ok(path)
}

/// A clip from a VOD (the editor): `from`..`to` ms.
pub fn export(vod_dir: &str, from_ms: u64, to_ms: u64, title: String) -> Result<PathBuf, String> {
    let vod_dir = inside(vod_dir)?;
    let vod_dir = vod_dir.as_path();
    let meta: Meta = read_json(&vod_dir.join("session.json"));
    let root = with(|e| root(&e.config));
    let clips = root.join("Clips");
    fs::create_dir_all(&clips).map_err(|e| e.to_string())?;
    let name = if title.trim().is_empty() { format!("{} {}", file_safe(&meta.game), stamp()) } else { file_safe(&title) };
    let path = unique(&clips, &name, "mp4");
    let tick = |ms: u64| ms * mp4::VIDEO_TIMESCALE as u64 / 1000;
    vod::export(vod_dir, tick(from_ms), tick(to_ms.max(from_ms + 500)), &path).map_err(|e| e.to_string())?;
    let source = vod_dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    write_json(&sidecar(&path), &ItemMeta { game: meta.game, title, created: now_ms(), duration_ms: to_ms.saturating_sub(from_ms), source, ..ItemMeta::default() });
    enforce_caps();
    Ok(path)
}

/// A screenshot of the game being recorded (from the recording's own frames, no cursor), or of the screen with the
/// window in front when nothing records.
pub fn screenshot() -> Result<PathBuf, String> {
    let root = with(|e| root(&e.config));
    let dir = root.join("Screenshots");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let game = with(|e| e.rec.as_ref().map(|r| r.meta.game.clone()));
    let name = format!("{} {}", file_safe(game.as_deref().unwrap_or("Screenshot")), stamp());
    let path = unique(&dir, &name, "png");
    let (tx, rx) = std::sync::mpsc::channel();
    let asked = with(|e| e.rec.as_ref().and_then(|r| r.video.as_ref()).map(|v| v.grab(Grab::Screenshot(path.clone(), tx.clone()))).is_some());
    let from_recording = asked && matches!(rx.recv_timeout(Duration::from_millis(1500)), Ok(Ok(())));
    if !from_recording {
        screen_picture(&path)?;
    }
    write_json(&sidecar(&path), &ItemMeta { game: game.clone().unwrap_or_default(), created: now_ms(), ..ItemMeta::default() });
    with(|e| {
        if let Some(r) = e.rec.as_mut() {
            let ms = elapsed(r);
            r.meta.events.push(Event { ms, kind: "screenshot".into(), label: String::new() });
            write_json(&r.dir.join("session.json"), &r.meta);
        }
    });
    enforce_caps();
    Ok(path)
}

/// The monitor under the window in front, through xcap (when no recording gives us frames).
fn screen_picture(path: &Path) -> Result<(), String> {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect};
    let mut r = RECT::default();
    unsafe {
        let _ = GetWindowRect(GetForegroundWindow(), &mut r);
    }
    let monitor = xcap::Monitor::from_point((r.left + r.right) / 2, (r.top + r.bottom) / 2).or_else(|_| xcap::Monitor::from_point(0, 0)).map_err(|e| e.to_string())?;
    let image = monitor.capture_image().map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    image::DynamicImage::ImageRgba8(image).to_rgb8().save_with_format(&tmp, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// ---------- library ----------

fn files(dir: &Path, ext: &str) -> Vec<(PathBuf, ItemMeta, u64)> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<(PathBuf, ItemMeta, u64)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case(ext)))
        .map(|p| {
            let mut meta: ItemMeta = read_json(&sidecar(&p));
            let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            if meta.created == 0 {
                // Dropped in by hand: date from the file.
                meta.created = fs::metadata(&p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            }
            (p, meta, size)
        })
        .collect();
    out.sort_by_key(|f| std::cmp::Reverse(f.1.created));
    out
}

fn vods(root: &Path) -> Vec<(PathBuf, Meta)> {
    let Ok(entries) = fs::read_dir(root.join("VODs")) else { return Vec::new() };
    let mut out: Vec<(PathBuf, Meta)> = entries.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| (e.path(), read_json::<Meta>(&e.path().join("session.json")))).collect();
    out.sort_by_key(|v| std::cmp::Reverse(v.1.started));
    out
}

pub fn library() -> Library {
    let root = with(|e| root(&e.config));
    let current = with(|e| e.rec.as_ref().map(|r| r.dir.clone()));
    let mut vod_bytes = 0;
    let mut items = Vec::new();
    for (dir, mut meta) in vods(&root) {
        let recording = current.as_ref() == Some(&dir);
        // Cut short by a crash: work out what's there once, and remember it.
        if !meta.finished && !recording {
            meta.duration_ms = vod::duration(&dir).map(|t| t * 1000 / mp4::VIDEO_TIMESCALE as u64).unwrap_or(0);
            meta.size = dir_size(&dir);
            meta.finished = true;
            if meta.started == 0 {
                meta.game = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            }
            write_json(&dir.join("session.json"), &meta);
        }
        let size = if recording || meta.size == 0 { dir_size(&dir) } else { meta.size };
        vod_bytes += size;
        let thumb = fs::read_dir(dir.join("thumbs")).ok().and_then(|e| e.flatten().map(|f| f.path()).filter(|p| p.extension().is_some_and(|x| x == "jpg")).min());
        items.push(VodItem { dir: dir.display().to_string(), meta, size, thumb: thumb.map(|t| t.display().to_string()), recording });
    }
    let to_items = |list: Vec<(PathBuf, ItemMeta, u64)>| list.into_iter().map(|(p, meta, size)| FileItem { path: p.display().to_string(), meta, size }).collect::<Vec<_>>();
    let clips = to_items(files(&root.join("Clips"), "mp4"));
    let screenshots = to_items(files(&root.join("Screenshots"), "png"));
    let clip_bytes = clips.iter().chain(&screenshots).map(|f| f.size).sum();
    Library { folder: root.display().to_string(), vods: items, clips, screenshots, vod_bytes, clip_bytes, free_bytes: free_space(&root) }
}

/// Deletes a VOD (folder), clip or screenshot (with its sidecar). Never the recording in progress.
pub fn delete(path: &str) -> Result<(), String> {
    let path = inside(path)?;
    if with(|e| e.rec.as_ref().is_some_and(|r| fs::canonicalize(&r.dir).ok().as_ref() == Some(&path))) {
        return Err("it's being recorded".into());
    }
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(sidecar(&path));
        Ok(())
    }
}

/// Changes a VOD's or item's starred / title / shared slug.
pub fn update(path: &str, starred: Option<bool>, title: Option<String>, shared: Option<Option<String>>) -> Result<(), String> {
    let path = inside(path)?;
    if path.is_dir() {
        let file = path.join("session.json");
        // The recording in progress keeps its meta in memory: change it there.
        let live = with(|e| {
            let r = e.rec.as_mut().filter(|r| fs::canonicalize(&r.dir).ok().as_ref() == Some(&path))?;
            if let Some(s) = starred {
                r.meta.starred = s;
            }
            if let Some(t) = &title {
                r.meta.title = t.clone();
            }
            write_json(&file, &r.meta);
            Some(())
        });
        if live.is_none() {
            let mut meta: Meta = read_json(&file);
            if let Some(s) = starred {
                meta.starred = s;
            }
            if let Some(t) = title {
                meta.title = t;
            }
            write_json(&file, &meta);
        }
    } else {
        let file = sidecar(&path);
        let mut meta: ItemMeta = read_json(&file);
        if let Some(s) = starred {
            meta.starred = s;
        }
        if let Some(t) = title {
            meta.title = t;
        }
        if let Some(s) = shared {
            meta.shared = s;
        }
        write_json(&file, &meta);
    }
    Ok(())
}

// ---------- limits ----------

/// Deletes the oldest VODs and clips/screenshots past their caps (never starred, shared or being recorded).
pub fn enforce_caps() {
    let (config, current) = with(|e| (e.config.clone(), e.rec.as_ref().map(|r| r.dir.clone())));
    let root = root(&config);
    let cap = (config.vod_cap_gb.max(1.0) * GB) as u64;
    let mut vods: Vec<(PathBuf, Meta, u64)> = vods(&root).into_iter().map(|(d, m)| {
        let size = if m.finished && m.size > 0 { m.size } else { dir_size(&d) };
        (d, m, size)
    }).collect();
    let mut total: u64 = vods.iter().map(|v| v.2).sum();
    vods.sort_by_key(|v| v.1.started);
    for (dir, meta, size) in &vods {
        if total <= cap {
            break;
        }
        if meta.starred || current.as_ref() == Some(dir) {
            continue;
        }
        if fs::remove_dir_all(dir).is_ok() {
            total -= size;
        }
    }
    let cap = (config.clip_cap_gb.max(0.5) * GB) as u64;
    let mut items: Vec<(PathBuf, ItemMeta, u64)> = files(&root.join("Clips"), "mp4").into_iter().chain(files(&root.join("Screenshots"), "png")).collect();
    let mut total: u64 = items.iter().map(|i| i.2).sum();
    items.sort_by_key(|i| i.1.created);
    for (path, meta, size) in &items {
        if total <= cap {
            break;
        }
        if meta.starred || meta.shared.is_some() {
            continue;
        }
        if fs::remove_file(path).is_ok() {
            let _ = fs::remove_file(sidecar(path));
            total -= size;
        }
    }
}

/// Every second: a recorder that stopped by itself, timeline pictures every 10 s, the free-disk floor, and the caps
/// every 30 s while recording.
fn housekeeping() {
    let mut tick = 0u64;
    loop {
        std::thread::sleep(Duration::from_secs(1));
        tick += 1;
        let (failed, low_disk) = with(|e| {
            let r = e.rec.as_mut()?;
            let failed = r.video.as_ref().and_then(|v| v.error());
            let secs = r.origin.elapsed().as_secs();
            if r.last_thumb.is_none_or(|t| secs >= t + 10) && secs >= 2 {
                let _ = fs::create_dir_all(r.dir.join("thumbs"));
                if let Some(v) = &r.video {
                    v.grab(Grab::Thumbnail(r.dir.join("thumbs").join(format!("{secs:06}.jpg"))));
                }
                r.last_thumb = Some(secs);
                r.meta.duration_ms = secs * 1000;
                write_json(&r.dir.join("session.json"), &r.meta);
            }
            let low = tick.is_multiple_of(5) && free_space(&r.dir).is_some_and(|f| (f as f64) < e.config.min_free_gb * GB);
            Some((failed, low))
        })
        .unwrap_or((None, false));
        if let Some(err) = failed {
            stop();
            with(|e| e.error = Some(err));
            emit_status();
        } else if low_disk {
            stop();
            with(|e| e.error = Some("not enough free disk space".into()));
            emit_status();
        }
        if tick.is_multiple_of(30) && with(|e| e.rec.is_some()) {
            enforce_caps();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_names_become_safe_file_names() {
        assert_eq!(file_safe("League of Legends"), "League of Legends");
        assert_eq!(file_safe("Who: Me? <beta>/2"), "Who Me beta 2");
        assert_eq!(file_safe("  ...  "), "Recording");
        assert_eq!(file_safe("Game."), "Game");
        assert_eq!(file_safe(&"a".repeat(100)).len(), 60);
    }

    #[test]
    fn settings_from_the_page_fill_in_defaults() {
        let c: Config = serde_json::from_str(r#"{"fps": 30, "mic": null}"#).unwrap();
        assert_eq!((c.fps, c.max_height, c.mic.clone(), c.clip_seconds), (30, 1080, None, 30));
        assert_eq!(video_settings(&Config { fps: 500, bitrate_kbps: 1, ..c }).fps, 120);
    }
}
