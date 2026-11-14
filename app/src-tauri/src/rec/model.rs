//! REC's data as the app sees it: settings, the game to record, a VOD's session.json, a clip's or screenshot's
//! sidecar, the status and the library. No Windows APIs, so the commands build everywhere (REC records on Windows).

use serde::{Deserialize, Serialize};

/// Settings from the REC page (prefs.rec on the app's side).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// '' = the default folder.
    pub folder: String,
    /// Largest recorded height, 0 = as captured.
    pub max_height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    pub cursor: bool,
    pub game_audio: bool,
    /// None = no mic, '' = Windows' communications mic, else that device's name.
    pub mic: Option<String>,
    /// The output whose sound is recorded when the game's own can't be told apart (Windows 10, desktop recordings on
    /// Windows 10): '' = Windows' default, else that device's name.
    pub output: String,
    pub voices: bool,
    pub clip_seconds: u32,
    pub vod_cap_gb: f64,
    pub clip_cap_gb: f64,
    pub min_free_gb: f64,
}

impl Default for Config {
    fn default() -> Config {
        Config {
            folder: String::new(),
            max_height: 1080,
            fps: 60,
            bitrate_kbps: 12_000,
            cursor: true,
            game_audio: true,
            mic: Some(String::new()),
            output: String::new(),
            voices: true,
            clip_seconds: 30,
            vod_cap_gb: 50.0,
            clip_cap_gb: 20.0,
            min_free_gb: 5.0,
        }
    }
}

/// The game to record, from games.ts.
#[derive(Deserialize, Clone, Debug)]
pub struct Game {
    pub name: String,
    pub key: String,
    /// 0 for a manual recording (no game).
    pub pid: u32,
    /// "window:<hwnd>", or "screen:front" for a manual recording.
    pub window: String,
}

/// A VOD's `session.json`.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Meta {
    pub version: u32,
    pub game: String,
    pub key: String,
    /// Set by the user; '' = the game and date.
    pub title: String,
    /// Unix ms.
    pub started: u64,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    /// What each stem track is ("game", "mic", "voices"), in order.
    pub stems: Vec<String>,
    /// Ms from the start.
    pub bookmarks: Vec<u64>,
    pub events: Vec<Event>,
    pub starred: bool,
    /// Bytes on disk, once finished.
    pub size: u64,
    /// Ended properly (or was repaired after a crash).
    pub finished: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Event {
    pub ms: u64,
    /// "clip", "screenshot", or a game's ("kill", "death", "dragon"...).
    pub kind: String,
    pub label: String,
}

/// A clip's or screenshot's sidecar.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ItemMeta {
    pub game: String,
    pub title: String,
    /// Unix ms.
    pub created: u64,
    pub duration_ms: u64,
    /// The VOD it came from (folder name), if any.
    pub source: String,
    pub starred: bool,
    /// Shared on the server: its slug. Shared items are never deleted to make room.
    pub shared: Option<String>,
}

/// What the app shows and acts on (`rec-status` event and `rec_status`).
#[derive(Serialize, Clone, Debug, Default)]
pub struct Status {
    pub recording: bool,
    pub game: Option<String>,
    /// Unix ms the recording started.
    pub since: Option<u64>,
    /// The game's window is covered or minimized: the recording holds the last picture.
    pub paused: bool,
    /// The voice chat goes into the recording now (the app sends its recording mix only then).
    pub voices: bool,
    pub folder: String,
    /// Why the last recording stopped by itself, or why it couldn't start.
    pub error: Option<String>,
    /// Your mic / the voice chat go into the recording right now (the overlay's switches); None = not recorded at all.
    pub mic_on: Option<bool>,
    pub voices_on: Option<bool>,
}

#[derive(Serialize)]
pub struct VodItem {
    pub dir: String,
    pub meta: Meta,
    pub size: u64,
    /// The first timeline picture (the poster).
    pub thumb: Option<String>,
    pub recording: bool,
}

#[derive(Serialize)]
pub struct FileItem {
    pub path: String,
    pub meta: ItemMeta,
    pub size: u64,
}

#[derive(Serialize, Default)]
pub struct Library {
    pub folder: String,
    pub vods: Vec<VodItem>,
    pub clips: Vec<FileItem>,
    pub screenshots: Vec<FileItem>,
    pub vod_bytes: u64,
    pub clip_bytes: u64,
    pub free_bytes: Option<u64>,
}

