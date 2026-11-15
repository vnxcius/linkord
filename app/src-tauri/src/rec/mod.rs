//! REC: game recording, VODs and clips (plan and progress: CLAUDE.md "REC").
//!
//! - gpu.rs: video, Desktop Duplication (the shared hub in capture/duplication.rs) -> H.264 without leaving the GPU.
//! - audio.rs + aac.rs + mix.rs: game, mic and voice chat mixed on a wall clock -> AAC (mix + stems).
//! - vod.rs + mp4.rs: both written as 2 s fragmented-MP4 segments; clips copied out of them.
//!
//! - session.rs (+ model.rs, commands.rs): one recording at a time, clips, screenshots, the library, the limits.
//!
//! Video and audio count time from the same `origin`, and write into one `vod::Writer` behind a mutex (`Shared`).

mod commands;
pub mod mix;
pub mod model;
pub mod mp4;
pub mod vod;
#[cfg(windows)]
pub mod session;

pub use commands::*;
#[cfg(windows)]
pub mod aac;
#[cfg(windows)]
pub mod audio;
#[cfg(windows)]
pub mod gpu;
#[cfg(windows)]
pub mod overlay;

use std::sync::{Arc, Mutex};

/// The recording's writer, fed by the video encoder thread and the audio mixer thread.
#[derive(Clone)]
pub struct Shared(pub Arc<Mutex<vod::Writer>>);

#[cfg(windows)]
impl gpu::VideoOut for Shared {
    fn start(&mut self, width: u32, height: u32) {
        self.0.lock().unwrap().start(width, height);
    }

    fn packet(&mut self, packet: crate::capture::encoder::Packet) {
        self.0.lock().unwrap().frame(&packet.data, packet.key, vod::ticks(packet.time));
    }
}

#[cfg(windows)]
impl audio::AudioOut for Shared {
    fn audio(&mut self, track: usize, frame: Vec<u8>, time: u64) {
        self.0.lock().unwrap().audio(track, frame, time);
    }
}

/// What a trial recording did (the debug command and the game-cost measurement print it).
#[derive(serde::Serialize, Debug, Default)]
pub struct TrialReport {
    pub folder: String,
    pub clip: Option<String>,
    pub width: u32,
    pub height: u32,
    pub seconds: f32,
    pub captured: u32,
    pub dropped: u32,
    pub encoded: u32,
    /// Average time the capture thread spent queuing GPU work per frame.
    pub submit_ms: f32,
    pub audio_tracks: usize,
    pub error: Option<String>,
}

/// Records the primary monitor (and `audio`) for `seconds` into a new folder under `root`, then exports the last 5 s
/// as a clip. Only for trying the pipeline out (debug builds' `rec_debug_record` command, examples/rec_probe.rs).
#[cfg(windows)]
pub fn trial(root: &std::path::Path, seconds: f32, settings: gpu::VideoSettings, audio: audio::AudioSettings) -> Result<TrialReport, String> {
    use std::sync::atomic::Ordering::Relaxed;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};

    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let folder = root.join(format!("trial-{stamp}"));
    let tracks = audio.tracks();
    let writer = Shared(Arc::new(Mutex::new(vod::Writer::new(folder.clone(), settings.fps, tracks).map_err(|e| e.to_string())?)));
    let monitor = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
    let target = crate::capture::duplication::Target::Screen(monitor.0 as usize);
    let origin = std::time::Instant::now();
    let recorder = gpu::VideoRecorder::start(target, settings, origin, writer.clone())?;
    let sound = audio::AudioRecorder::start(&audio, origin, writer.clone());
    let until = origin + std::time::Duration::from_secs_f32(seconds);
    while std::time::Instant::now() < until && recorder.error().is_none() {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let stats = recorder.stats();
    let (captured, dropped, encoded) = (stats.captured.load(Relaxed), stats.dropped.load(Relaxed), stats.encoded.load(Relaxed));
    let submit_ms = stats.submit_us.load(Relaxed) as f32 / 1000.0 / captured.max(1) as f32;
    let (width, height) = (recorder.width, recorder.height);
    let error = recorder.error().or_else(|| sound.error.lock().unwrap().clone());
    drop(recorder);
    drop(sound);
    {
        let mut w = writer.0.lock().unwrap();
        w.finish();
        if let Some(e) = &w.error {
            return Err(format!("writing the recording: {e}"));
        }
    }
    let mut report = TrialReport {
        folder: folder.display().to_string(),
        clip: None,
        width,
        height,
        seconds: origin.elapsed().as_secs_f32(),
        captured,
        dropped,
        encoded,
        submit_ms,
        audio_tracks: tracks,
        error,
    };
    let length = vod::duration(&folder).map_err(|e| e.to_string())?;
    let clip = folder.join("clip.mp4");
    let five = 5 * mp4::VIDEO_TIMESCALE as u64;
    match vod::export(&folder, length.saturating_sub(five), length, &clip) {
        Ok(_) => report.clip = Some(clip.display().to_string()),
        Err(e) => {
            report.error.get_or_insert_with(|| format!("export: {e}"));
        }
    }
    Ok(report)
}

/// Voice chat audio for the recording in progress (the playback worklet's recording mix): raw little-endian f32,
/// interleaved stereo, 48 kHz.
#[tauri::command]
pub fn rec_voice_audio(request: tauri::ipc::Request) {
    #[cfg(windows)]
    if let tauri::ipc::InvokeBody::Raw(bytes) = request.body() {
        audio::push_voice(bytes);
    }
    #[cfg(not(windows))]
    let _ = request;
}

/// Debug builds only: records the primary monitor and the PC's sound (not Linkord's) for a few seconds into the temp
/// folder and returns what happened.
#[tauri::command]
pub async fn rec_debug_record(seconds: f32) -> Result<TrialReport, String> {
    if !cfg!(debug_assertions) {
        return Err("only in development builds".into());
    }
    #[cfg(windows)]
    let result = {
        let settings = gpu::VideoSettings { max_height: 1080, fps: 60, bitrate: 12_000_000, cursor: true };
        let sound = audio::AudioSettings { game: Some(crate::capture::audio::Source::AllExcept(std::process::id())), mic: None, output: String::new(), voices: true };
        let root = std::env::temp_dir().join("linkord-rec");
        tauri::async_runtime::spawn_blocking(move || trial(&root, seconds.clamp(1.0, 120.0), settings, sound)).await.map_err(|e| e.to_string())?
    };
    #[cfg(not(windows))]
    let result = {
        let _ = seconds;
        Err("REC records on Windows only".into())
    };
    result
}
