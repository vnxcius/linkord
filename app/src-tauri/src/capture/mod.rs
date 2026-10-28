//! Native screen capture for streaming (Windows): an in-app source picker, Windows Graphics Capture,
//! hardware H.264 encoding and per-application audio. Encoded frames go to the web app over a Tauri
//! channel and from there out through the existing voice connection.
//! Other platforms report "unsupported" and the app falls back to the browser's capture.

#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod convert;
#[cfg(windows)]
mod encoder;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};

#[derive(Serialize)]
pub struct CaptureSource {
    /// "screen:<hmonitor>" or "window:<hwnd>"
    id: String,
    kind: &'static str,
    name: String,
    app: Option<String>,
    width: u32,
    height: u32,
    /// JPEG data URL preview.
    thumbnail: Option<String>,
}

#[derive(Serialize)]
pub struct CaptureInfo {
    encoder: &'static str,
    /// "app" (only the shared app), "all_but_linkord", "system" (everything, Windows 10) or "none"
    audio: &'static str,
}

#[derive(Serialize)]
pub struct CaptureCapabilities {
    /// Per-application audio (and excluding Linkord's own audio) needs Windows 11.
    per_app_audio: bool,
}

#[tauri::command]
pub fn capture_capabilities() -> CaptureCapabilities {
    #[cfg(windows)]
    return CaptureCapabilities { per_app_audio: audio::process_loopback_supported() };
    #[cfg(not(windows))]
    CaptureCapabilities { per_app_audio: false }
}

/// The WebView2 browser process plays the voice chat; screen-share audio must leave its whole process tree out.
#[cfg(windows)]
pub fn set_webview_pid(pid: u32) {
    imp::WEBVIEW_PID.store(pid, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
pub async fn list_capture_sources() -> Result<Vec<CaptureSource>, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(imp::list).await.map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    Err("native capture is only available on Windows".into())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn start_capture(
    source: String,
    height: u32,
    fps: u32,
    bitrate: u32,
    audio: bool,
    on_video: Channel<InvokeResponseBody>,
    on_audio: Channel<InvokeResponseBody>,
) -> Result<CaptureInfo, String> {
    #[cfg(windows)]
    return imp::start(source, height, fps, bitrate, audio, on_video, on_audio);
    #[cfg(not(windows))]
    {
        let _ = (source, height, fps, bitrate, audio, on_video, on_audio);
        Err("native capture is only available on Windows".into())
    }
}

#[tauri::command]
pub fn capture_switch_source(source: String) -> Result<CaptureInfo, String> {
    #[cfg(windows)]
    return imp::switch(source);
    #[cfg(not(windows))]
    {
        let _ = source;
        Err("native capture is only available on Windows".into())
    }
}

#[tauri::command]
pub fn stop_capture() {
    #[cfg(windows)]
    imp::stop();
}

#[tauri::command]
pub fn capture_keyframe() {
    #[cfg(windows)]
    imp::keyframe();
}

#[derive(Serialize)]
pub struct CaptureAudioStats {
    /// The output device's own mix format (0 = unknown); Windows resamples it to our 48 kHz stereo.
    mix_rate: u32,
    mix_channels: u32,
    /// Gaps WASAPI reported in the captured audio since the capture started.
    discontinuities: u32,
}

#[tauri::command]
pub fn capture_audio_stats() -> CaptureAudioStats {
    #[cfg(windows)]
    {
        use std::sync::atomic::Ordering::Relaxed;
        CaptureAudioStats {
            mix_rate: audio::MIX_RATE.load(Relaxed),
            mix_channels: audio::MIX_CHANNELS.load(Relaxed),
            discontinuities: audio::DISCONTINUITIES.load(Relaxed),
        }
    }
    #[cfg(not(windows))]
    CaptureAudioStats { mix_rate: 0, mix_channels: 0, discontinuities: 0 }
}

/// Where the time of the native video pipeline goes, per stage, since the previous call (the stats readout
/// asks once a second). Averages and peaks in milliseconds.
#[derive(Serialize, Default)]
pub struct CaptureVideoStats {
    /// Frames read back and converted, and frames skipped because the encoder was still busy.
    frames: u32,
    busy_skips: u32,
    readback_ms: f32,
    readback_max_ms: f32,
    convert_ms: f32,
    convert_max_ms: f32,
    encoded: u32,
    encode_ms: f32,
    encode_max_ms: f32,
    /// Threads converting frames.
    threads: u32,
    /// Why the stream stopped on its own (the encoder could not be created), if it did.
    error: Option<String>,
}

#[tauri::command]
pub fn capture_video_stats() -> Option<CaptureVideoStats> {
    #[cfg(windows)]
    return imp::video_stats();
    #[cfg(not(windows))]
    None
}

#[tauri::command]
pub fn capture_set_quality(height: u32, fps: u32, bitrate: u32) {
    #[cfg(windows)]
    imp::set_quality(height, fps, bitrate);
    #[cfg(not(windows))]
    let _ = (height, fps, bitrate);
}

#[cfg(windows)]
mod imp {
    use std::io::Cursor;
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
    use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    use base64::Engine;
    use tauri::ipc::{Channel, InvokeResponseBody};
    use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::InternalCaptureControl;
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
    };
    use windows_capture::window::Window;

    use super::audio::{process_loopback_supported, AudioCapture, Source};
    use windows_capture::graphics_capture_api::GraphicsCaptureApi;
    use super::convert::{target_size, Converter};
    use super::encoder::Encoder;
    use super::{CaptureInfo, CaptureSource, CaptureVideoStats};

    type BoxError = Box<dyn std::error::Error + Send + Sync>;

    #[derive(Clone, Copy)]
    struct Params {
        height: u32,
        fps: u32,
        bitrate: u32,
    }

    struct Shared {
        stop: AtomicBool,
        keyframe: AtomicBool,
        params: Mutex<Params>,
        params_changed: AtomicBool,
        /// A converted frame is waiting for the encoder: the next ones are skipped before any work is done.
        queued: AtomicBool,
        /// NV12 buffers handed back by the encoder, so frames don't allocate.
        pool: Mutex<Vec<Vec<u8>>>,
        stats: Stats,
        /// Set when the encoder gave up; the stream stops and the app reads why from the stats.
        error: Mutex<Option<String>>,
    }

    /// Per-stage counters (microseconds), reset by every `video_stats` read.
    #[derive(Default)]
    struct Stats {
        frames: AtomicU32,
        busy_skips: AtomicU32,
        readback_us: AtomicU64,
        readback_max_us: AtomicU64,
        convert_us: AtomicU64,
        convert_max_us: AtomicU64,
        encoded: AtomicU32,
        encode_us: AtomicU64,
        encode_max_us: AtomicU64,
        threads: AtomicU32,
    }

    fn record(total: &AtomicU64, max: &AtomicU64, since: Instant) {
        let us = since.elapsed().as_micros() as u64;
        total.fetch_add(us, Ordering::Relaxed);
        max.fetch_max(us, Ordering::Relaxed);
    }

    /// Spare buffers kept for reuse: one waiting, one encoding, one being filled.
    const POOL_SIZE: usize = 3;

    struct Converted {
        nv12: Vec<u8>,
        width: u32,
        height: u32,
        at: Instant,
    }

    struct Session {
        shared: Arc<Shared>,
        control: Option<CaptureControl<Handler, BoxError>>,
        encoder: Option<JoinHandle<()>>,
        audio: Option<AudioCapture>,
        // Kept so the source can be switched without restarting the stream.
        frames: SyncSender<Converted>,
        on_audio: Channel<InvokeResponseBody>,
        want_audio: bool,
        hardware: bool,
        source: String,
        /// The frame rate the capture's update interval was set up for.
        capture_fps: u32,
    }

    static SESSION: Mutex<Option<Session>> = Mutex::new(None);
    pub static WEBVIEW_PID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    // Some capture options only exist on Windows 11; asking for them on Windows 10 makes capture fail.
    fn border() -> DrawBorderSettings {
        if GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false) { DrawBorderSettings::WithoutBorder } else { DrawBorderSettings::Default }
    }

    fn cursor() -> CursorCaptureSettings {
        if GraphicsCaptureApi::is_cursor_settings_supported().unwrap_or(false) { CursorCaptureSettings::WithCursor } else { CursorCaptureSettings::Default }
    }

    /// Asks Windows (11 24H2+) not to produce frames much faster than the stream needs, instead of one per
    /// display refresh. A bit under the frame interval: frames land on refreshes, and the pacing in
    /// `on_frame_arrived` picks which ones are sent.
    fn update_interval(fps: u32) -> MinimumUpdateIntervalSettings {
        if GraphicsCaptureApi::is_minimum_update_interval_supported().unwrap_or(false) {
            MinimumUpdateIntervalSettings::Custom(Duration::from_micros(750_000 / fps.max(1) as u64))
        } else {
            MinimumUpdateIntervalSettings::Default
        }
    }

    fn secondary_windows() -> SecondaryWindowSettings {
        if GraphicsCaptureApi::is_secondary_windows_supported().unwrap_or(false) { SecondaryWindowSettings::Include } else { SecondaryWindowSettings::Default }
    }

    // ---------- source list ----------

    fn thumbnail(img: image::RgbaImage) -> Option<String> {
        let (w, h) = img.dimensions();
        if w == 0 || h == 0 {
            return None;
        }
        let tw = 320u32.min(w);
        let small = image::imageops::thumbnail(&img, tw, (tw * h / w).max(1));
        let rgb = image::DynamicImage::ImageRgba8(small).to_rgb8();
        let mut jpeg = Cursor::new(Vec::new());
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 70).encode_image(&rgb).ok()?;
        Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg.into_inner())))
    }

    pub fn list() -> Result<Vec<CaptureSource>, String> {
        let mut out = Vec::new();
        for (i, m) in xcap::Monitor::all().map_err(|e| e.to_string())?.into_iter().enumerate() {
            let Ok(id) = m.id() else { continue };
            out.push(CaptureSource {
                id: format!("screen:{id}"),
                kind: "screen",
                name: m.friendly_name().or_else(|_| m.name()).unwrap_or_else(|_| format!("Screen {}", i + 1)),
                app: None,
                width: m.width().unwrap_or(0),
                height: m.height().unwrap_or(0),
                thumbnail: m.capture_image().ok().and_then(thumbnail),
            });
        }
        let me = std::process::id();
        for w in xcap::Window::all().map_err(|e| e.to_string())?.into_iter().take(40) {
            let title = w.title().unwrap_or_default();
            let (width, height) = (w.width().unwrap_or(0), w.height().unwrap_or(0));
            if title.trim().is_empty() || w.is_minimized().unwrap_or(true) || w.pid().ok() == Some(me) || width < 120 || height < 80 {
                continue;
            }
            let Ok(id) = w.id() else { continue };
            out.push(CaptureSource {
                id: format!("window:{id}"),
                kind: "window",
                name: title,
                app: w.app_name().ok(),
                width,
                height,
                thumbnail: w.capture_image().ok().and_then(thumbnail),
            });
        }
        Ok(out)
    }

    // ---------- capture ----------

    struct Handler {
        shared: Arc<Shared>,
        frames: SyncSender<Converted>,
        /// When the next frame is due (a running deadline, so the average rate matches the target even when
        /// the display's refresh rate isn't a multiple of it).
        next: Option<Instant>,
        converter: Converter,
    }

    /// Frames arriving this early are still taken, so a 60 Hz display can feed a 60 fps stream.
    const SLACK: Duration = Duration::from_micros(1500);

    impl GraphicsCaptureApiHandler for Handler {
        type Flags = (Arc<Shared>, SyncSender<Converted>);
        type Error = BoxError;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            let (shared, frames) = ctx.flags;
            let converter = Converter::new();
            shared.stats.threads.store(converter.threads as u32, Ordering::Relaxed);
            Ok(Handler { shared, frames, next: None, converter })
        }

        fn on_frame_arrived(&mut self, frame: &mut Frame, control: InternalCaptureControl) -> Result<(), Self::Error> {
            if self.shared.stop.load(Ordering::Relaxed) {
                control.stop();
                return Ok(());
            }
            let params = *self.shared.params.lock().unwrap();
            // Windows delivers frames at the display's refresh rate; keep only what the stream needs.
            let interval = Duration::from_micros(1_000_000 / params.fps as u64);
            let now = Instant::now();
            if self.next.is_some_and(|due| now + SLACK < due) {
                return Ok(());
            }
            let stats = &self.shared.stats;
            // The encoder hasn't taken the last frame yet: skip this one before reading it back (the next
            // arriving frame is due right away).
            if self.shared.queued.load(Ordering::Acquire) {
                stats.busy_skips.fetch_add(1, Ordering::Relaxed);
                return Ok(());
            }
            // Keep the schedule unless we fell behind it (static screens produce no frames at all).
            self.next = Some(match self.next {
                Some(due) if now < due + interval => due + interval,
                _ => now + interval,
            });
            let started = Instant::now();
            let mut buffer = frame.buffer()?;
            record(&stats.readback_us, &stats.readback_max_us, started);
            let (sw, sh, stride) = (buffer.width(), buffer.height(), buffer.row_pitch() as usize);
            let (dw, dh) = target_size(sw, sh, params.height);
            let mut nv12 = self.shared.pool.lock().unwrap().pop().unwrap_or_default();
            let started = Instant::now();
            self.converter.convert(buffer.as_raw_buffer(), sw, sh, stride, dw, dh, &mut nv12);
            record(&stats.convert_us, &stats.convert_max_us, started);
            stats.frames.fetch_add(1, Ordering::Relaxed);
            // Marked before sending, so the encoder's "taken" (after receiving) can't be overwritten.
            self.shared.queued.store(true, Ordering::Release);
            if let Err(e) = self.frames.try_send(Converted { nv12, width: dw, height: dh, at: now }) {
                self.shared.queued.store(false, Ordering::Release);
                let (std::sync::mpsc::TrySendError::Full(c) | std::sync::mpsc::TrySendError::Disconnected(c)) = e;
                self.shared.pool.lock().unwrap().push(c.nv12);
            }
            Ok(())
        }
    }

    fn encode_loop(shared: Arc<Shared>, frames: Receiver<Converted>, on_video: Channel<InvokeResponseBody>) {
        let mut encoder: Option<Encoder> = None;
        let started = Instant::now();
        while !shared.stop.load(Ordering::Relaxed) {
            let frame = match frames.recv_timeout(Duration::from_millis(200)) {
                Ok(f) => f,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            shared.queued.store(false, Ordering::Release);
            let params = *shared.params.lock().unwrap();
            let rebuild = shared.params_changed.swap(false, Ordering::Relaxed)
                || encoder.as_ref().is_none_or(|e| e.width != frame.width || e.height != frame.height);
            if rebuild {
                // Release the old encoder (and its GPU session) before creating the new one.
                drop(encoder.take());
                match Encoder::new(frame.width, frame.height, params.fps, params.bitrate) {
                    Ok(e) => encoder = Some(e),
                    Err(e) => {
                        // Don't keep capturing (and converting) frames nobody encodes: stop, and let the app know.
                        eprintln!("H.264 encoder unavailable: {e}");
                        *shared.error.lock().unwrap() = Some(format!("H.264 encoder unavailable: {e}"));
                        shared.stop.store(true, Ordering::Relaxed);
                        break;
                    }
                }
            }
            let enc = encoder.as_mut().unwrap();
            if rebuild || shared.keyframe.swap(false, Ordering::Relaxed) {
                enc.force_keyframe();
            }
            let time = frame.at.duration_since(started).as_nanos() as i64 / 100;
            let duration = 10_000_000 / params.fps as i64;
            let started = Instant::now();
            let result = enc.encode(&frame.nv12, time, duration, &mut |data, key| {
                let mut msg = Vec::with_capacity(data.len() + 1);
                msg.push(key as u8);
                msg.extend_from_slice(&data);
                let _ = on_video.send(InvokeResponseBody::Raw(msg));
            });
            let stats = &shared.stats;
            record(&stats.encode_us, &stats.encode_max_us, started);
            stats.encoded.fetch_add(1, Ordering::Relaxed);
            let mut pool = shared.pool.lock().unwrap();
            if pool.len() < POOL_SIZE {
                pool.push(frame.nv12);
            }
            drop(pool);
            if let Err(e) = result {
                eprintln!("encode failed, restarting encoder: {e}");
                encoder = None;
            }
        }
    }

    /// Starts capturing a source ("screen:<hmonitor>" / "window:<hwnd>"); returns which audio to pair with it.
    fn start_item(source: &str, shared: &Arc<Shared>, frames: &SyncSender<Converted>) -> Result<(CaptureControl<Handler, BoxError>, Source), String> {
        let (kind, raw) = source.split_once(':').ok_or("bad source")?;
        let handle: usize = raw.parse().map_err(|_| "bad source")?;
        let flags = (shared.clone(), frames.clone());
        let fps = shared.params.lock().unwrap().fps;
        let (control, audio_source) = match kind {
            "screen" => {
                let item = Monitor::from_raw_hmonitor(handle as *mut std::ffi::c_void);
                let settings = Settings::new(
                    item,
                    cursor(),
                    border(),
                    SecondaryWindowSettings::Default,
                    update_interval(fps),
                    DirtyRegionSettings::Default,
                    ColorFormat::Bgra8,
                    flags,
                );
                let webview = WEBVIEW_PID.load(Ordering::Relaxed);
                let exclude = if webview != 0 { webview } else { std::process::id() };
                (Handler::start_free_threaded(settings).map_err(|e| e.to_string())?, Source::AllExcept(exclude))
            }
            "window" => {
                let item = Window::from_raw_hwnd(handle as *mut std::ffi::c_void);
                let pid = item.process_id().map_err(|e| e.to_string())?;
                let settings = Settings::new(
                    item,
                    cursor(),
                    border(),
                    secondary_windows(),
                    update_interval(fps),
                    DirtyRegionSettings::Default,
                    ColorFormat::Bgra8,
                    flags,
                );
                (Handler::start_free_threaded(settings).map_err(|e| e.to_string())?, Source::Only(pid))
            }
            _ => return Err("bad source".into()),
        };
        // Windows 10 can't capture per process: fall back to everything the PC plays.
        let audio_source = if process_loopback_supported() { audio_source } else { Source::System };
        Ok((control, audio_source))
    }

    fn start_audio(want: bool, source: Source, on_audio: &Channel<InvokeResponseBody>) -> (Option<AudioCapture>, &'static str) {
        if !want {
            return (None, "none");
        }
        let channel = on_audio.clone();
        let capture = AudioCapture::start(source, move |chunk| {
            let _ = channel.send(InvokeResponseBody::Raw(chunk));
        })
        .map_err(|e| eprintln!("{e}"))
        .ok();
        let mode = match (&capture, source) {
            (None, _) => "none",
            (Some(_), Source::Only(_)) => "app",
            (Some(_), Source::AllExcept(_)) => "all_but_linkord",
            (Some(_), Source::System) => "system",
        };
        (capture, mode)
    }

    pub fn start(
        source: String,
        height: u32,
        fps: u32,
        bitrate: u32,
        audio: bool,
        on_video: Channel<InvokeResponseBody>,
        on_audio: Channel<InvokeResponseBody>,
    ) -> Result<CaptureInfo, String> {
        stop();
        let shared = Arc::new(Shared {
            stop: AtomicBool::new(false),
            keyframe: AtomicBool::new(true),
            params: Mutex::new(Params { height: height.clamp(360, 1080), fps: fps.clamp(5, 60), bitrate }),
            params_changed: AtomicBool::new(false),
            queued: AtomicBool::new(false),
            pool: Mutex::new(Vec::new()),
            stats: Stats::default(),
            error: Mutex::new(None),
        });
        // Probe the encoder up front so failures surface as an error the app can fall back from.
        let probe = Encoder::new(1280, 720, fps.clamp(5, 60), bitrate).map_err(|e| format!("no H.264 encoder: {e}"))?;
        let hardware = probe.hardware;
        drop(probe);

        let (tx, rx) = sync_channel::<Converted>(1);
        let (control, audio_source) = start_item(&source, &shared, &tx)?;
        let capture_fps = shared.params.lock().unwrap().fps;
        let enc_shared = shared.clone();
        let encoder = std::thread::spawn(move || encode_loop(enc_shared, rx, on_video));
        let (audio_capture, audio_mode) = start_audio(audio, audio_source, &on_audio);
        *SESSION.lock().unwrap() = Some(Session {
            shared,
            control: Some(control),
            encoder: Some(encoder),
            audio: audio_capture,
            frames: tx,
            on_audio,
            want_audio: audio,
            hardware,
            source,
            capture_fps,
        });
        Ok(CaptureInfo { encoder: if hardware { "hardware" } else { "software" }, audio: audio_mode })
    }

    /// Swaps what's being shared while live: same encoder, same connection, viewers keep watching.
    pub fn switch(source: String) -> Result<CaptureInfo, String> {
        let mut guard = SESSION.lock().unwrap();
        let session = guard.as_mut().ok_or("not streaming")?;
        let audio_source = restart_video(session, source)?;
        drop(session.audio.take());
        let (audio_capture, audio_mode) = start_audio(session.want_audio, audio_source, &session.on_audio);
        session.audio = audio_capture;
        Ok(CaptureInfo { encoder: if session.hardware { "hardware" } else { "software" }, audio: audio_mode })
    }

    /// Starts capturing `source` in place of the current one (same encoder and connection).
    fn restart_video(session: &mut Session, source: String) -> Result<Source, String> {
        let (control, audio_source) = start_item(&source, &session.shared, &session.frames)?;
        if let Some(old) = session.control.replace(control) {
            let _ = old.stop();
        }
        session.source = source;
        session.capture_fps = session.shared.params.lock().unwrap().fps;
        // The new source may have a different size; either way viewers need a fresh keyframe.
        session.shared.keyframe.store(true, Ordering::Relaxed);
        Ok(audio_source)
    }

    pub fn video_stats() -> Option<CaptureVideoStats> {
        let shared = SESSION.lock().unwrap().as_ref()?.shared.clone();
        let st = &shared.stats;
        let error = shared.error.lock().unwrap().clone();
        let take = |a: &AtomicU64| a.swap(0, Ordering::Relaxed);
        let ms = |us: u64| us as f32 / 1000.0;
        let avg = |us: u64, n: u32| if n == 0 { 0.0 } else { ms(us) / n as f32 };
        let frames = st.frames.swap(0, Ordering::Relaxed);
        let encoded = st.encoded.swap(0, Ordering::Relaxed);
        Some(CaptureVideoStats {
            frames,
            busy_skips: st.busy_skips.swap(0, Ordering::Relaxed),
            readback_ms: avg(take(&st.readback_us), frames),
            readback_max_ms: ms(take(&st.readback_max_us)),
            convert_ms: avg(take(&st.convert_us), frames),
            convert_max_ms: ms(take(&st.convert_max_us)),
            encoded,
            encode_ms: avg(take(&st.encode_us), encoded),
            encode_max_ms: ms(take(&st.encode_max_us)),
            threads: st.threads.load(Ordering::Relaxed),
            error,
        })
    }

    pub fn stop() {
        let Some(mut session) = SESSION.lock().unwrap().take() else { return };
        session.shared.stop.store(true, Ordering::Relaxed);
        if let Some(control) = session.control.take() {
            let _ = control.stop();
        }
        if let Some(t) = session.encoder.take() {
            let _ = t.join();
        }
    }

    pub fn keyframe() {
        if let Some(s) = SESSION.lock().unwrap().as_ref() {
            s.shared.keyframe.store(true, Ordering::Relaxed);
        }
    }

    pub fn set_quality(height: u32, fps: u32, bitrate: u32) {
        let mut guard = SESSION.lock().unwrap();
        let Some(s) = guard.as_mut() else { return };
        let fps = fps.clamp(5, 60);
        *s.shared.params.lock().unwrap() = Params { height: height.clamp(360, 1080), fps, bitrate };
        s.shared.params_changed.store(true, Ordering::Relaxed);
        // The capture's update interval was set for the old frame rate: restart it (audio keeps running).
        if fps != s.capture_fps && matches!(update_interval(fps), MinimumUpdateIntervalSettings::Custom(_)) {
            let source = s.source.clone();
            if let Err(e) = restart_video(s, source) {
                eprintln!("couldn't restart capture for {fps} fps: {e}");
            }
        }
    }
}
