//! REC's Tauri commands (lib/rec.ts calls them). Anything that may wait (stopping drains the encoders, a clip waits
//! for its last segment) runs on a blocking thread, never the main one. Other platforms answer that REC is Windows-only.

use super::model::{Config, Game, Library, Status};

#[cfg(windows)]
use super::session;

#[cfg(not(windows))]
const ONLY_WINDOWS: &str = "REC records on Windows only";

/// Runs `f` off the async runtime (it may block for a while).
#[cfg(windows)]
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rec_configure(config: Config) -> Status {
    #[cfg(windows)]
    {
        session::configure(config);
        session::status()
    }
    #[cfg(not(windows))]
    {
        let _ = config;
        Status { error: Some(ONLY_WINDOWS.into()), ..Status::default() }
    }
}

#[tauri::command]
pub fn rec_status() -> Status {
    #[cfg(windows)]
    return session::status();
    #[cfg(not(windows))]
    Status::default()
}

#[tauri::command]
pub async fn rec_start(game: Game) -> Result<Status, String> {
    #[cfg(windows)]
    {
        blocking(move || session::start(game)).await??;
        Ok(session::status())
    }
    #[cfg(not(windows))]
    {
        let _ = game;
        Err(ONLY_WINDOWS.into())
    }
}

#[tauri::command]
pub async fn rec_stop() -> Status {
    #[cfg(windows)]
    {
        let _ = blocking(session::stop).await;
        session::status()
    }
    #[cfg(not(windows))]
    Status::default()
}

#[tauri::command]
pub async fn rec_retarget(window: String, pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    return blocking(move || session::retarget(window, pid)).await?;
    #[cfg(not(windows))]
    {
        let _ = (window, pid);
        Err(ONLY_WINDOWS.into())
    }
}

/// Saves the last `seconds` (default: the setting) as a clip, named `title` if given (League auto-clips: "Pentakill");
/// returns its path.
#[tauri::command]
pub async fn rec_clip(seconds: Option<u32>, title: Option<String>) -> Result<String, String> {
    #[cfg(windows)]
    return blocking(move || session::clip(seconds, title).map(|p| p.display().to_string())).await?;
    #[cfg(not(windows))]
    {
        let _ = (seconds, title);
        Err(ONLY_WINDOWS.into())
    }
}

#[tauri::command]
pub async fn rec_screenshot() -> Result<String, String> {
    #[cfg(windows)]
    return blocking(|| session::screenshot().map(|p| p.display().to_string())).await?;
    #[cfg(not(windows))]
    Err(ONLY_WINDOWS.into())
}

/// Marks this moment of the recording; returns ms from its start.
#[tauri::command]
pub fn rec_bookmark() -> Result<u64, String> {
    #[cfg(windows)]
    return session::bookmark();
    #[cfg(not(windows))]
    Err(ONLY_WINDOWS.into())
}

/// A game event on the timeline (League: kills, objectives...), `ago_ms` before now (when it was noticed late).
#[tauri::command]
pub fn rec_event(kind: String, label: String, ago_ms: Option<u64>) {
    #[cfg(windows)]
    session::event(kind, label, ago_ms.unwrap_or(0));
    #[cfg(not(windows))]
    let _ = (kind, label, ago_ms);
}

#[tauri::command]
pub async fn rec_library() -> Library {
    #[cfg(windows)]
    return blocking(session::library).await.unwrap_or_default();
    #[cfg(not(windows))]
    Library::default()
}

#[tauri::command]
pub async fn rec_delete(path: String) -> Result<(), String> {
    #[cfg(windows)]
    return blocking(move || session::delete(&path)).await?;
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(ONLY_WINDOWS.into())
    }
}

/// Stars, renames, or records the share slug of a VOD, clip or screenshot. `shared`: absent = unchanged,
/// null = no longer shared.
#[tauri::command]
pub fn rec_update(path: String, starred: Option<bool>, title: Option<String>, shared: Option<Option<String>>) -> Result<(), String> {
    #[cfg(windows)]
    return session::update(&path, starred, title, shared);
    #[cfg(not(windows))]
    {
        let _ = (path, starred, title, shared);
        Err(ONLY_WINDOWS.into())
    }
}

/// A clip from a VOD (the editor), `from_ms`..`to_ms`; returns its path.
#[tauri::command]
pub async fn rec_export(vod: String, from_ms: u64, to_ms: u64, title: String) -> Result<String, String> {
    #[cfg(windows)]
    let result = blocking(move || session::export(&vod, from_ms, to_ms, title).map(|p| p.display().to_string())).await?;
    #[cfg(not(windows))]
    let result = {
        let _ = (vod, from_ms, to_ms, title);
        Err(ONLY_WINDOWS.into())
    };
    result
}

/// Opens the REC overlay over the game in front, or closes it.
#[tauri::command]
pub async fn rec_overlay_toggle(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    return super::overlay::toggle(app).await;
    #[cfg(not(windows))]
    {
        let _ = app;
        Err(ONLY_WINDOWS.into())
    }
}

/// The REC overlay's page has drawn since it was opened: it can be uncloaked.
#[tauri::command]
pub fn rec_overlay_ready() {
    #[cfg(windows)]
    super::overlay::ready();
}

/// Closes the REC overlay and gives the game its focus back.
#[tauri::command]
pub fn rec_overlay_close(app: tauri::AppHandle) {
    #[cfg(windows)]
    super::overlay::close(&app);
    #[cfg(not(windows))]
    let _ = app;
}

/// Your mic / the voice chat in the recording from now on (the overlay's switches).
#[tauri::command]
pub fn rec_live(mic: Option<bool>, voices: Option<bool>) -> Status {
    #[cfg(windows)]
    {
        session::set_live(mic, voices);
        session::status()
    }
    #[cfg(not(windows))]
    {
        let _ = (mic, voices);
        Status::default()
    }
}

/// A VOD's parts, segments and timeline pictures, for the player.
#[tauri::command]
pub async fn rec_vod(dir: String) -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    let result = blocking(move || session::vod_index(&dir).map(|i| serde_json::to_value(i).unwrap_or_default())).await?;
    #[cfg(not(windows))]
    let result = {
        let _ = dir;
        Err(ONLY_WINDOWS.into())
    };
    result
}

/// Shows a file (or the REC folder) in Explorer. Only things inside the REC folder.
#[tauri::command]
pub fn rec_reveal(path: Option<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let folder = session::status().folder;
        let _ = std::fs::create_dir_all(&folder);
        let mut cmd = std::process::Command::new("explorer.exe");
        match path {
            Some(p) => {
                session::inside(&p)?;
                cmd.arg(format!("/select,{p}"))
            }
            None => cmd.arg(&folder),
        };
        cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(ONLY_WINDOWS.into())
    }
}

/// The REC overlay's default key (owner: Shift + the key left of 1, "~" on a US keyboard, '"' on ABNT2): that key's
/// virtual-key code in the current layout and the character it types with Shift, for its label.
#[derive(serde::Serialize)]
pub struct LayoutKey {
    pub vk: u32,
    pub label: String,
}

#[tauri::command]
pub fn rec_overlay_key() -> Option<LayoutKey> {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::Input::KeyboardAndMouse::{MapVirtualKeyW, ToUnicode, MAPVK_VSC_TO_VK};
        /// The key left of 1 on every common layout.
        const SCAN: u32 = 0x29;
        let vk = MapVirtualKeyW(SCAN, MAPVK_VSC_TO_VK);
        if vk == 0 {
            return None;
        }
        let mut state = [0u8; 256];
        state[0x10] = 0x80; // Shift down
        let mut buf = [0u16; 8];
        // Flag 4: don't touch the keyboard's state (a dead key would otherwise linger).
        let n = ToUnicode(vk, SCAN, Some(&state), &mut buf, 4);
        let label = if n > 0 { String::from_utf16_lossy(&buf[..n as usize]) } else { "`".into() };
        Some(LayoutKey { vk, label: label.trim().to_string() })
    }
    #[cfg(not(windows))]
    None
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn the_overlay_key_comes_from_the_keyboard_layout() {
        let key = super::rec_overlay_key().expect("the key left of 1 exists");
        println!("overlay key: vk {:#x}, Shift gives {:?}", key.vk, key.label);
        assert!(key.vk >= 0x30, "a character key, not a control key");
        assert!(!key.label.is_empty());
    }
}
