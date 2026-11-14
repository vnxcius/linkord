//! The REC overlay (Windows): REC over the game, opened with its hotkey. The only place that shows it's recording.
//!
//! Not the voice overlay (overlay.rs): that one never takes input. This is a transparent, frameless, always-on-top
//! WebView window covering the game's monitor (components/RecOverlay.tsx draws a panel on a dimmed backdrop):
//! - made on the first opening, then hidden on close and kept (owner, 2026-11-14: a window made again showed black
//!   before its page drew); a hidden WebView only holds memory, no CPU or GPU;
//! - excluded from capture, so it's never in a recording or a stream;
//! - takes focus when it opens (it needs the mouse) and gives it back to the game's window when it closes.
//!
//! Borderless games only, like the voice overlay: nothing can draw over exclusive fullscreen without injection.

use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CLOAK, DWMWA_TRANSITIONS_FORCEDISABLED};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTOPRIMARY};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsWindow, SetForegroundWindow, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
};

pub const LABEL: &str = "rec-overlay";
/// The window that was in front when the overlay opened (the game): it gets focus back.
static GAME: AtomicIsize = AtomicIsize::new(0);
/// Told by the page (rec_overlay_ready) once it has drawn since the last opening.
static READY: Mutex<Option<mpsc::Sender<()>>> = Mutex::new(None);
/// How long an opening waits for the page to draw: a new window starts a WebView first.
const WAIT_NEW: Duration = Duration::from_millis(3000);
const WAIT_SHOWN: Duration = Duration::from_millis(500);

fn raw(window: &tauri::WebviewWindow) -> Option<HWND> {
    window.hwnd().ok().map(|h| HWND(h.0))
}

/// Opens it over the window in front, or closes it.
pub async fn toggle(app: AppHandle) -> Result<(), String> {
    match app.get_webview_window(LABEL) {
        Some(w) if w.is_visible().unwrap_or(false) => {
            close(&app);
            Ok(())
        }
        _ => open(app).await,
    }
}

async fn open(app: AppHandle) -> Result<(), String> {
    // The monitor the game is on, in physical pixels (a block: an HWND can't be held across the wait below).
    let screen = {
        let front = unsafe { GetForegroundWindow() };
        let ours = app.webview_windows().values().filter_map(raw).any(|h| h == front);
        if !ours && !front.is_invalid() {
            GAME.store(front.0 as isize, Ordering::Relaxed);
        }
        unsafe {
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            let _ = GetMonitorInfoW(MonitorFromWindow(front, MONITOR_DEFAULTTOPRIMARY), &mut info);
            info.rcMonitor
        }
    };
    let existing = app.get_webview_window(LABEL);
    let wait = if existing.is_some() { WAIT_SHOWN } else { WAIT_NEW };
    let (ready_tx, ready_rx) = mpsc::channel();
    *READY.lock().unwrap() = Some(ready_tx);
    let window = match existing {
        Some(w) => w,
        None => WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html".into()))
            .title("REC")
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?,
    };
    let RECT { left, top, right, bottom } = screen;
    let _ = window.set_position(PhysicalPosition::new(left, top));
    let _ = window.set_size(PhysicalSize::new((right - left).max(1) as u32, (bottom - top).max(1) as u32));
    if let Some(hwnd) = raw(&window) {
        unsafe {
            let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            // No Windows open/close animation: on a window the size of the screen it shows as the dimmed backdrop
            // zooming and fading in and out (owner, 2026-11-14).
            set_bool(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, true);
            // Shown cloaked (laid out and drawn, not on screen) until the page has drawn: a window shown before that
            // is a moment of black the first time (owner, 2026-11-14).
            set_bool(hwnd, DWMWA_CLOAK, true);
        }
    }
    window.show().map_err(|e| e.to_string())?;
    let _ = app.emit_to(LABEL, "rec-overlay-shown", ());
    let _ = tauri::async_runtime::spawn_blocking(move || ready_rx.recv_timeout(wait)).await;
    // Closed while it was getting ready.
    if !window.is_visible().unwrap_or(false) {
        return Ok(());
    }
    if let Some(hwnd) = raw(&window) {
        unsafe { set_bool(hwnd, DWMWA_CLOAK, false) };
        take_focus(hwnd);
    }
    let _ = window.set_focus();
    Ok(())
}

/// The page has drawn: the opening waiting for it can show the window.
pub fn ready() {
    if let Some(tx) = READY.lock().unwrap().take() {
        let _ = tx.send(());
    }
}

unsafe fn set_bool(hwnd: HWND, attribute: windows::Win32::Graphics::Dwm::DWMWINDOWATTRIBUTE, on: bool) {
    let value = BOOL(on as i32);
    let _ = DwmSetWindowAttribute(hwnd, attribute, &value as *const BOOL as *const _, std::mem::size_of::<BOOL>() as u32);
}

/// Windows only lets the app in front give focus away; borrowing its input queue for a moment lets us take it
/// (the hotkey came through a hook, which doesn't count as our input).
fn take_focus(hwnd: HWND) {
    unsafe {
        let front = GetForegroundWindow();
        let theirs = GetWindowThreadProcessId(front, None);
        let mine = GetCurrentThreadId();
        let attached = theirs != 0 && theirs != mine && AttachThreadInput(mine, theirs, true).as_bool();
        let _ = BringWindowToTop(hwnd);
        let _ = SetForegroundWindow(hwnd);
        if attached {
            let _ = AttachThreadInput(mine, theirs, false);
        }
    }
}

/// Hides it (kept for the next opening) and gives the game its focus back.
pub fn close(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    let _ = window.hide();
    let game = GAME.swap(0, Ordering::Relaxed);
    if game != 0 {
        let hwnd = HWND(game as *mut std::ffi::c_void);
        unsafe {
            if IsWindow(Some(hwnd)).as_bool() {
                let _ = SetForegroundWindow(hwnd);
            }
        }
    }
}
