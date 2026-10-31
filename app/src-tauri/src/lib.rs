use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

mod capture;
mod games;
mod keybinds;

static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

struct Tray(Mutex<Option<TrayIcon>>);

fn tray_image(state: &str) -> Option<Image<'static>> {
    let bytes: &'static [u8] = match state {
        "speaking" => include_bytes!("../icons/tray/speaking.png"),
        "muted" => include_bytes!("../icons/tray/muted.png"),
        "deafened" => include_bytes!("../icons/tray/deafened.png"),
        "connected" => include_bytes!("../icons/tray/connected.png"),
        _ => include_bytes!("../icons/tray/idle.png"),
    };
    Image::from_bytes(bytes).ok()
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Tray icon reflects voice: green ring while speaking, red badge when muted or deafened. The
/// client sends the tooltip in the UI language.
#[tauri::command]
fn set_tray_state(app: AppHandle, state: String, tooltip: Option<String>) {
    if let Some(tray) = app.state::<Tray>().0.lock().unwrap().as_ref() {
        let _ = tray.set_icon(tray_image(&state));
        let _ = tray.set_tooltip(Some(tooltip.as_deref().unwrap_or("Linkord")));
    }
}

fn tray_menu(app: &AppHandle, open: &str, quit: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "show", open, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit, true, None::<&str>)?;
    Menu::with_items(app, &[&show, &quit])
}

/// Tray menu labels in the UI language (the client sends them on start and when it changes).
#[tauri::command]
fn set_tray_menu(app: AppHandle, open: String, quit: String) {
    if let Some(tray) = app.state::<Tray>().0.lock().unwrap().as_ref() {
        if let Ok(menu) = tray_menu(&app, &open, &quit) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

#[tauri::command]
fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
}

/// Present when "Start minimized" is off: starting with the OS opens the window instead of staying in the
/// tray. A file because the choice is needed before the web app loads.
fn start_open_flag(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("start-open"))
}

#[tauri::command]
fn set_start_minimized(app: AppHandle, enabled: bool) -> Result<(), String> {
    let path = start_open_flag(&app).ok_or("no config directory")?;
    if enabled {
        match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    } else {
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&path, b"").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The global keybinds the native hook should report (Windows; elsewhere the client listens in-window).
#[tauri::command]
fn set_keybinds(binds: Vec<keybinds::Bind>) {
    #[cfg(windows)]
    keybinds::set_binds(binds);
    #[cfg(not(windows))]
    let _ = binds;
}

/// Writes a downloaded file (raw request body) into the Downloads folder without overwriting
/// anything, and returns where it went. The name arrives percent-encoded in `x-filename`.
#[tauri::command]
async fn save_download(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected file contents".into());
    };
    let name = request.headers().get("x-filename").and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default();
    let name = std::path::Path::new(&name).file_name().and_then(|n| n.to_str()).unwrap_or("download").to_string();
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.clone(), String::new()),
    };
    let mut path = dir.join(&name);
    for n in 1.. {
        if !path.exists() {
            break;
        }
        path = dir.join(format!("{stem} ({n}){ext}"));
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = if b[i] == b'%' { s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) } else { None };
        match hex {
            Some(v) => {
                out.push(v);
                i += 3;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Leaving on purpose (tray Quit, or closing the window without close-to-tray). The client gets a
/// moment to forget its voice session, so only crashes and updates offer to rejoin on next launch.
fn quit_app(app: &AppHandle) {
    let _ = app.emit("quitting", ());
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        app.exit(0);
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let menu = tray_menu(app, "Open Linkord", "Quit Linkord")?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Linkord")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "show" => show_main(app),
            "quit" => quit_app(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = tray_image("idle") {
        builder = builder.icon(icon);
    }
    builder.build(app)
}

/// Everything about the window except whether it's visible (see run()).
fn window_state_flags() -> StateFlags {
    StateFlags::all() - StateFlags::VISIBLE
}

static WINDOW_MOVES: AtomicU64 = AtomicU64::new(0);

/// The watch-together pop-out (WatchPopout.tsx): the same page as the app, which shows only the player when it
/// finds itself in a window with this label.
const WATCH_POPOUT: &str = "watch-popout";

/// Opens the pop-out (or brings it forward): small, frameless, always on top, at the bottom right of the screen
/// the app is on the first time (the window-state plugin remembers where it was moved after that). Async: making
/// a window from a synchronous command deadlocks on Windows.
#[tauri::command]
async fn watch_popout_open(app: AppHandle, title: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(WATCH_POPOUT) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(());
    }
    // A 16:9 video under the pop-out's 30 px bar (+1 px border).
    let (width, height) = (480.0, 270.0 + 31.0);
    let mut builder = tauri::WebviewWindowBuilder::new(&app, WATCH_POPOUT, tauri::WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(256.0, 144.0 + 31.0)
        .decorations(false)
        .always_on_top(true)
        .resizable(true)
        .background_color(tauri::window::Color(0, 0, 0, 255))
        .focused(true);
    if let Some(screen) = app.get_webview_window("main").and_then(|m| m.current_monitor().ok().flatten()) {
        let scale = screen.scale_factor();
        let area = screen.work_area();
        let x = (area.position.x as f64 + area.size.width as f64) / scale - width - 24.0;
        let y = (area.position.y as f64 + area.size.height as f64) / scale - height - 24.0;
        builder = builder.position(x, y);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    quiet_frame_menus(&window);
    let handle = app.clone();
    window.on_window_event(move |e| {
        if let WindowEvent::Destroyed = e {
            let _ = handle.emit_to("main", "watch-popout-closed", ());
        }
    });
    Ok(())
}

/// Closes the pop-out; the main window shows the player again.
#[tauri::command]
fn watch_popout_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window(WATCH_POPOUT) {
        let _ = w.destroy();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch focuses the running window instead of opening another client.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        // The window opens where it was last (position, size, maximized), also after updates and restarts.
        // Showing it stays ours: started with Windows it waits in the tray.
        .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(window_state_flags()).build())
        .manage(Tray(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            set_tray_state,
            set_tray_menu,
            set_close_to_tray,
            set_start_minimized,
            set_keybinds,
            save_download,
            watch_popout_open,
            watch_popout_close,
            capture::list_capture_sources,
            capture::start_capture,
            capture::stop_capture,
            capture::capture_keyframe,
            capture::capture_set_quality,
            capture::capture_capabilities,
            capture::capture_switch_source,
            capture::capture_audio_stats,
            capture::capture_video_stats,
            games::running_apps,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            *app.state::<Tray>().0.lock().unwrap() = Some(build_tray(&handle)?);
            if let Some(w) = app.get_webview_window("main") {
                enable_media(&w);
                forward_frame_menus(&w);
                // Started with the OS: stay in the tray until opened, unless "Start minimized" is off.
                let with_os = std::env::args().any(|a| a == "--minimized");
                if !with_os || start_open_flag(&handle).is_some_and(|p| p.exists()) {
                    let _ = w.show();
                }
            }
            #[cfg(windows)]
            keybinds::start(handle);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Only the app's own window goes to the tray or quits; the watch pop-out just closes.
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                let _ = window.app_handle().save_window_state(window_state_flags());
                if CLOSE_TO_TRAY.load(Ordering::Relaxed) {
                    let _ = window.hide();
                } else {
                    quit_app(window.app_handle());
                }
            }
            // Saved as soon as the window settles: an update's installer ends the app without an exit event.
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                let n = WINDOW_MOVES.fetch_add(1, Ordering::Relaxed) + 1;
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                    if WINDOW_MOVES.load(Ordering::Relaxed) == n {
                        let _ = app.save_window_state(window_state_flags());
                    }
                });
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running linkord");
}

/// Lets voice work out of the box on Linux: enables media capture in WebKitGTK and grants the
/// app's own microphone/camera requests (WebView2 on Windows handles this itself).
#[cfg(target_os = "linux")]
fn enable_media(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        use glib::prelude::*;
        use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt};
        let view = webview.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_media_stream(true);
        }
        view.connect_permission_request(|_, request| {
            if request.is::<UserMediaPermissionRequest>() {
                request.allow();
                true
            } else {
                false
            }
        });
    });
}

/// Windows counterpart: clears any earlier "Block" on the mic/camera prompt for the app's own origin
/// and allows future requests, so voice never depends on a one-time dialog.
#[cfg(windows)]
fn enable_media(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use webview2_com::{PermissionRequestedEventHandler, SetPermissionStateCompletedHandler};
        use windows::core::{Interface, HSTRING};

        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let mut browser_pid = 0u32;
        if core.BrowserProcessId(&mut browser_pid).is_ok() {
            capture::set_webview_pid(browser_pid);
        }
        let media = [COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_KIND_CAMERA];

        let profile = core.cast::<ICoreWebView2_13>().and_then(|c| c.Profile()).and_then(|p| p.cast::<ICoreWebView2Profile4>());
        if let Ok(profile) = profile {
            let origin = HSTRING::from("http://tauri.localhost");
            for kind in media {
                let done = SetPermissionStateCompletedHandler::create(Box::new(|_| Ok(())));
                let _ = profile.SetPermissionState(kind, &origin, COREWEBVIEW2_PERMISSION_STATE_ALLOW, &done);
            }
        }

        let handler = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if media.contains(&kind) {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
            }
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core.add_PermissionRequested(&handler, &mut token);
    });
}

#[cfg(not(any(target_os = "linux", windows)))]
fn enable_media(_window: &tauri::WebviewWindow) {}

/// Right-clicks inside embedded players (watch together, videos in chat) would open WebView2's own menu, which a
/// page can't stop from inside a cross-origin frame. Windows: those requests come to the page instead, as a
/// `frame-context-menu` event {x, y, frame} (x/y in the webview's pixels), which shows the app's own menu.
#[cfg(windows)]
fn forward_frame_menus(window: &tauri::WebviewWindow) {
    let app = window.app_handle().clone();
    let _ = window.with_webview(move |webview| unsafe {
        use webview2_com::ContextMenuRequestedEventHandler;
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use windows::core::{Interface, BOOL, PWSTR};

        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let Ok(core) = core.cast::<ICoreWebView2_11>() else { return };
        let handler = ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let target = args.ContextMenuTarget()?;
            let mut main = BOOL::default();
            target.IsRequestedForMainFrame(&mut main)?;
            // The app's own document shows its own menus already (contextmenu.ts).
            if main.as_bool() {
                return Ok(());
            }
            let mut at = windows::Win32::Foundation::POINT::default();
            args.Location(&mut at)?;
            let mut uri = PWSTR::null();
            let frame = if target.FrameUri(&mut uri).is_ok() { webview2_com::take_pwstr(uri) } else { String::new() };
            args.SetHandled(true)?;
            let _ = app.emit("frame-context-menu", serde_json::json!({ "x": at.x, "y": at.y, "frame": frame }));
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core.add_ContextMenuRequested(&handler, &mut token);
    });
}

#[cfg(not(windows))]
fn forward_frame_menus(_window: &tauri::WebviewWindow) {}

/// The pop-out has no menus of its own: WebView2's (Back, Reload, Inspect...) don't show in it either.
#[cfg(windows)]
fn quiet_frame_menus(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        if let Ok(settings) = webview.controller().CoreWebView2().and_then(|c| c.Settings()) {
            let _ = settings.SetAreDefaultContextMenusEnabled(false);
        }
    });
}

#[cfg(not(windows))]
fn quiet_frame_menus(_window: &tauri::WebviewWindow) {}
