//! Discord inside Linkord (Windows): Discord's own web app (discord.com/app) in a second WebView2 view over the main
//! window, below the title bar. Opt-in from Settings -> Discord; nothing exists until it's turned on.
//!
//! The view is a raw WebView2 controller made from the main webview's own environment, not a Tauri webview: it shares
//! Linkord's browser, GPU and network processes (one more renderer instead of a second Chromium like the Discord
//! app), Tauri's IPC is never injected into Discord's page, and no Tauri multi-webview (unstable) is needed. Nothing
//! is injected into Discord either: the badge comes from the page title, notifications from WebView2's
//! NotificationReceived, so this is a browser showing a site, never a modified client.
//!
//! Hidden, the view keeps running (notifications, Discord calls) unless "Keep Discord running in the background" is
//! off: then it closes a minute after you leave it, once it isn't playing sound. Hidden views use WebView2's low
//! memory target; WebView2 also stops painting them.
//!
//! Every WebView2 object lives on the main thread (thread_local VIEW); commands hop there with run_on_main_thread.

use tauri::AppHandle;

/// Main-frame navigation stays on Discord's own sites; anything else goes to the browser. memory.rs uses it too.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn is_discord(url: &str) -> bool {
    let Ok(url) = tauri::Url::parse(url) else { return false };
    if url.scheme() != "https" {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    ["discord.com", "discordapp.com", "discord.gg", "discord.new", "discord.gift"]
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// Discord's tab title carries its badge: "(3) Discord | #general | Server" for mentions, a leading bullet for other
/// unread messages. (mentions, unread).
#[cfg_attr(not(windows), allow(dead_code))]
fn badge_of(title: &str) -> (u32, bool) {
    let t = title.trim_start();
    if let Some(rest) = t.strip_prefix('(') {
        if let Some(n) = rest.split_once(')').and_then(|(n, _)| n.trim().trim_end_matches('+').parse::<u32>().ok()) {
            return (n, true);
        }
    }
    (0, t.starts_with('•') || t.starts_with('●'))
}

#[cfg(windows)]
mod imp {
    use super::{badge_of, is_discord};
    use std::cell::{Cell, RefCell};
    use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager};
    use tauri_plugin_opener::OpenerExt;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{
        take_pwstr, AcceleratorKeyPressedEventHandler, CallDevToolsProtocolMethodCompletedHandler,
        CapturePreviewCompletedHandler, ContainsFullScreenElementChangedEventHandler,
        CreateCoreWebView2ControllerCompletedHandler, DocumentTitleChangedEventHandler,
        IsDocumentPlayingAudioChangedEventHandler, NavigationStartingEventHandler, NewWindowRequestedEventHandler,
        NotificationCloseRequestedEventHandler, NotificationReceivedEventHandler, PermissionRequestedEventHandler,
    };
    use windows::core::{w, Interface, BOOL, HSTRING, PWSTR};
    use windows::Win32::Foundation::{E_FAIL, HGLOBAL, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, FindWindowExW, GetClientRect, RegisterClassExW, SetWindowPos,
        ShowWindow, HWND_TOP, SIZE_MINIMIZED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNA,
        WINDOW_EX_STYLE, WM_MOVE, WM_SETFOCUS, WM_SIZE, WNDCLASSEXW, WS_CHILD, WS_CLIPCHILDREN,
    };

    const HOME: &str = "https://discord.com/app";
    /// What "Remove Discord" wipes (local storage with the sign-in, cookies, caches, service workers).
    const ORIGINS: [&str; 3] = ["https://discord.com", "https://discordapp.com", "https://www.discord.com"];
    /// Background off: how long a hidden, quiet Discord waits before it closes.
    const CLOSE_AFTER: Duration = Duration::from_secs(60);
    const CREATE_WAIT: Duration = Duration::from_secs(15);

    /// The view's top edge in the window's pixels (the title bar's height, sent by the page).
    static TOP: AtomicI32 = AtomicI32::new(0);
    static VISIBLE: AtomicBool = AtomicBool::new(false);
    /// "Keep Discord running in the background".
    static KEEP: AtomicBool = AtomicBool::new(true);
    static AUDIO: AtomicBool = AtomicBool::new(false);
    static FULLSCREEN: AtomicBool = AtomicBool::new(false);
    /// Bumped by every show/hide, so a pending close knows it's stale.
    static HIDE_GEN: AtomicU64 = AtomicU64::new(0);

    struct View {
        controller: ICoreWebView2Controller,
        core: ICoreWebView2,
        /// The main window, and our own child window in it that holds the view. The main webview sits in wry's child
        /// window (WRY_WEBVIEW) under Tauri's resize borders (TAURI_DRAG_RESIZE_BORDERS, a full-size child that only
        /// covers the edges): ours goes between them whenever it shows, so it's over Linkord and the window still
        /// resizes from its edges. Neither clips siblings: a window that did would leave the borders' strip unpainted.
        parent: HWND,
        container: HWND,
        /// Notifications on screen, by the id Linkord's toast carries (newest last).
        notes: Vec<(u32, ICoreWebView2Notification)>,
        next_note: u32,
        badge: (u32, bool),
    }

    thread_local! {
        static VIEW: RefCell<Option<View>> = const { RefCell::new(None) };
        /// When the view started being made (a creation that never reports back stops blocking after CREATE_WAIT).
        static CREATING: Cell<Option<std::time::Instant>> = const { Cell::new(None) };
    }

    fn on_main(app: &AppHandle, f: impl FnOnce(&AppHandle) + Send + 'static) {
        let a = app.clone();
        let _ = app.run_on_main_thread(move || f(&a));
    }

    fn emit_state(app: &AppHandle) {
        let running = VIEW.with(|v| v.borrow().is_some());
        let _ = app.emit_to("main", "discord-state", serde_json::json!({ "running": running }));
    }

    fn emit_badge(app: &AppHandle, (mentions, unread): (u32, bool)) {
        let _ = app.emit_to("main", "discord-badge", serde_json::json!({ "mentions": mentions, "unread": unread }));
    }

    unsafe fn fit(view: &View) {
        let mut r = RECT::default();
        if GetClientRect(view.parent, &mut r).is_err() {
            return;
        }
        let top = if FULLSCREEN.load(Ordering::Relaxed) { 0 } else { TOP.load(Ordering::Relaxed).clamp(0, r.bottom) };
        let (width, height) = (r.right, r.bottom - top);
        let _ = SetWindowPos(view.container, None, 0, top, width, height, SWP_NOACTIVATE | SWP_NOZORDER);
        let _ = view.controller.SetBounds(RECT { left: 0, top: 0, right: width, bottom: height });
    }

    unsafe fn apply_visibility(app: &AppHandle, view: &View) {
        let visible = VISIBLE.load(Ordering::Relaxed);
        if visible {
            let under = FindWindowExW(Some(view.parent), None, w!("TAURI_DRAG_RESIZE_BORDERS"), None).unwrap_or(HWND_TOP);
            let _ = SetWindowPos(view.container, Some(under), 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
            let _ = ShowWindow(view.container, SW_SHOWNA);
        } else {
            let _ = ShowWindow(view.container, SW_HIDE);
        }
        let _ = view.controller.SetIsVisible(visible);
        if let Ok(c) = view.core.cast::<ICoreWebView2_19>() {
            let _ = c.SetMemoryUsageTargetLevel(if visible {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            });
        }
        if visible {
            let _ = view.controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        } else if let Some(main) = app.get_webview_window("main") {
            let _ = main.with_webview(|w| unsafe {
                let _ = w.controller().MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
            });
        }
    }

    /// Background off: closes a hidden Discord once it has been quiet for CLOSE_AFTER.
    fn schedule_close(app: &AppHandle) {
        if KEEP.load(Ordering::Relaxed) || VISIBLE.load(Ordering::Relaxed) {
            return;
        }
        let gen = HIDE_GEN.fetch_add(1, Ordering::Relaxed) + 1;
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(CLOSE_AFTER).await;
            on_main(&app, move |app| {
                let stale = HIDE_GEN.load(Ordering::Relaxed) != gen;
                if stale || KEEP.load(Ordering::Relaxed) || VISIBLE.load(Ordering::Relaxed) || AUDIO.load(Ordering::Relaxed) {
                    return;
                }
                close(app);
            });
        });
    }

    fn close(app: &AppHandle) {
        let Some(view) = VIEW.with(|v| v.borrow_mut().take()) else { return };
        unsafe {
            let _ = view.controller.Close();
            let _ = DestroyWindow(view.container);
        }
        AUDIO.store(false, Ordering::Relaxed);
        if FULLSCREEN.swap(false, Ordering::Relaxed) {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.set_fullscreen(false);
            }
        }
        emit_badge(app, (0, false));
        emit_state(app);
    }

    fn open_outside(app: &AppHandle, url: &str) {
        if url.starts_with("https://") || url.starts_with("http://") {
            let _ = app.opener().open_url(url, None::<&str>);
        }
    }

    /// Makes the view (hidden or shown, as VISIBLE says) unless it exists or is on its way.
    fn create(app: &AppHandle) {
        let busy = CREATING.get().is_some_and(|t| t.elapsed() < CREATE_WAIT);
        if VIEW.with(|v| v.borrow().is_some()) || busy {
            return;
        }
        let Some(main) = app.get_webview_window("main") else { return };
        let Ok(hwnd) = main.hwnd() else { return };
        // As a number: HWND isn't Send, and with_webview's closure must be.
        let parent = hwnd.0 as isize;
        CREATING.set(Some(std::time::Instant::now()));
        let app = app.clone();
        let started = main.with_webview(move |w| unsafe {
            let parent = HWND(parent as *mut _);
            let env = w.controller().CoreWebView2().and_then(|c| c.cast::<ICoreWebView2_2>()).and_then(|c| c.Environment());
            let (Ok(env), Some(container)) = (env, make_container(parent)) else {
                CREATING.set(None);
                return;
            };
            let handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(move |hr, controller| {
                CREATING.set(None);
                let made = hr.and_then(|_| controller.ok_or_else(|| windows::core::Error::from(E_FAIL)));
                if let Err(e) = made.and_then(|controller| setup(&app, parent, container, controller)) {
                    eprintln!("discord view: {e}");
                    let _ = DestroyWindow(container);
                }
                Ok(())
            }));
            if env.CreateCoreWebView2Controller(container, &handler).is_err() {
                CREATING.set(None);
                let _ = DestroyWindow(container);
            }
        });
        if started.is_err() {
            CREATING.set(None);
        }
    }

    /// Our child window for the view (hidden until shown). Once per main window: the main window's size, moves and
    /// focus reach the view (wry does the same for its own).
    unsafe fn make_container(parent: HWND) -> Option<HWND> {
        unsafe extern "system" fn proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
            if msg == WM_SETFOCUS {
                focus_view();
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
        static SETUP: std::sync::Once = std::sync::Once::new();
        let instance = HINSTANCE(GetModuleHandleW(None).ok()?.0);
        SETUP.call_once(|| {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(proc),
                hInstance: instance,
                lpszClassName: w!("LINKORD_DISCORD"),
                ..Default::default()
            };
            RegisterClassExW(&class);
            let _ = SetWindowSubclass(parent, Some(parent_proc), 0x4C44, 0);
        });
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("LINKORD_DISCORD"),
            None,
            WS_CHILD | WS_CLIPCHILDREN,
            0,
            0,
            0,
            0,
            Some(parent),
            None,
            Some(instance),
            None,
        )
        .ok()
    }

    unsafe extern "system" fn parent_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        let result = DefSubclassProc(hwnd, msg, wparam, lparam);
        match msg {
            WM_SIZE if wparam.0 != SIZE_MINIMIZED as usize => with_view(|view| fit(view)),
            WM_MOVE => with_view(|view| {
                let _ = view.controller.NotifyParentWindowPositionChanged();
            }),
            // wry gives the keyboard to its webview when the window gets it back: Discord's, while it's in front.
            WM_SETFOCUS => focus_view(),
            _ => {}
        }
        result
    }

    /// For window messages, which can arrive while the view is being changed: skipped then.
    fn with_view(f: impl FnOnce(&View)) {
        VIEW.with(|v| {
            if let Ok(v) = v.try_borrow() {
                if let Some(view) = v.as_ref() {
                    f(view);
                }
            }
        });
    }

    fn focus_view() {
        if VISIBLE.load(Ordering::Relaxed) {
            with_view(|view| unsafe {
                let _ = view.controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
            });
        }
    }

    unsafe fn setup(
        app: &AppHandle,
        parent: HWND,
        container: HWND,
        controller: ICoreWebView2Controller,
    ) -> windows::core::Result<()> {
        let core = controller.CoreWebView2()?;
        // Discord's dark grey until its first paint, instead of a white flash.
        if let Ok(c2) = controller.cast::<ICoreWebView2Controller2>() {
            let _ = c2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: 255, R: 30, G: 31, B: 34 });
        }
        let settings = core.Settings()?;
        let _ = settings.SetAreDevToolsEnabled(cfg!(debug_assertions));
        let _ = settings.SetIsStatusBarEnabled(false);
        // What's typed there (the sign-in email...) stays in Discord's own storage, which Remove Discord clears; the
        // profile's autofill is shared with Linkord and can't be cleared per site.
        if let Ok(s4) = settings.cast::<ICoreWebView2Settings4>() {
            let _ = s4.SetIsGeneralAutofillEnabled(false);
            let _ = s4.SetIsPasswordAutosaveEnabled(false);
        }
        let mut token = 0i64;

        // Navigation: Discord's sites only; links people post open in the browser.
        let a = app.clone();
        let handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = take_pwstr(uri);
            if !is_discord(&uri) && uri != "about:blank" {
                args.SetCancel(true)?;
                open_outside(&a, &uri);
            }
            Ok(())
        }));
        core.add_NavigationStarting(&handler, &mut token)?;

        // New windows: Discord's sign-in flows for connections (Spotify, Xbox...) need a real popup that comes back to
        // discord.com; other Discord links open in the view itself, everything else in the browser.
        let a = app.clone();
        let handler = NewWindowRequestedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else { return Ok(()) };
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = take_pwstr(uri);
            if is_discord(&uri) {
                let path = tauri::Url::parse(&uri).map(|u| u.path().to_string()).unwrap_or_default();
                if path.starts_with("/api/") || path.starts_with("/oauth2/") || path.starts_with("/connections/") {
                    return Ok(()); // WebView2's own popup
                }
                args.SetHandled(true)?;
                if let Some(core) = sender {
                    let _ = core.Navigate(&HSTRING::from(uri));
                }
                return Ok(());
            }
            args.SetHandled(true)?;
            open_outside(&a, &uri);
            Ok(())
        }));
        core.add_NewWindowRequested(&handler, &mut token)?;

        // Permissions: what Discord's app asks a browser for (voice, video, notifications, pasting pictures...), for
        // Discord's own pages only. Screen sharing goes through WebView2's own picker.
        let allowed = [
            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
            COREWEBVIEW2_PERMISSION_KIND_CAMERA,
            COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
            COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
            COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
            COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS,
            COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT,
        ];
        let handler = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let ok = is_discord(&take_pwstr(uri)) && allowed.contains(&kind);
            args.SetState(if ok { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY })?;
            Ok(())
        }));
        core.add_PermissionRequested(&handler, &mut token)?;

        // The badge, from the title.
        let a = app.clone();
        let handler = DocumentTitleChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(core) = sender else { return Ok(()) };
            let mut title = PWSTR::null();
            core.DocumentTitle(&mut title)?;
            let badge = badge_of(&take_pwstr(title));
            let changed = VIEW.with(|v| {
                v.borrow_mut().as_mut().is_some_and(|view| std::mem::replace(&mut view.badge, badge) != badge)
            });
            if changed {
                emit_badge(&a, badge);
            }
            Ok(())
        }));
        core.add_DocumentTitleChanged(&handler, &mut token)?;

        // Notifications become Linkord's own (Windows toasts); a click is reported back so Discord opens the chat.
        if let Ok(core24) = core.cast::<ICoreWebView2_24>() {
            let a = app.clone();
            let handler = NotificationReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut origin = PWSTR::null();
                args.SenderOrigin(&mut origin)?;
                if !is_discord(&take_pwstr(origin)) {
                    return Ok(());
                }
                let note = args.Notification()?;
                args.SetHandled(true)?;
                let (mut title, mut body) = (PWSTR::null(), PWSTR::null());
                note.Title(&mut title)?;
                note.Body(&mut body)?;
                let (title, body) = (take_pwstr(title), take_pwstr(body));
                let _ = note.ReportShown();
                let id = VIEW.with(|v| {
                    let mut v = v.borrow_mut();
                    let view = v.as_mut()?;
                    view.next_note = view.next_note.wrapping_add(1);
                    let id = view.next_note;
                    view.notes.push((id, note.clone()));
                    if view.notes.len() > 30 {
                        view.notes.remove(0);
                    }
                    Some(id)
                });
                let Some(id) = id else { return Ok(()) };
                let closed = NotificationCloseRequestedEventHandler::create(Box::new(move |_, _| {
                    VIEW.with(|v| {
                        if let Some(view) = v.borrow_mut().as_mut() {
                            view.notes.retain(|(n, _)| *n != id);
                        }
                    });
                    Ok(())
                }));
                let mut t = 0i64;
                let _ = note.add_CloseRequested(&closed, &mut t);
                let _ = a.emit_to("main", "discord-notification", serde_json::json!({ "id": id, "title": title, "body": body }));
                Ok(())
            }));
            core24.add_NotificationReceived(&handler, &mut token)?;
        }

        // Sound playing (a call, a video): background off waits for it to stop before closing.
        if let Ok(core8) = core.cast::<ICoreWebView2_8>() {
            let a = app.clone();
            let handler = IsDocumentPlayingAudioChangedEventHandler::create(Box::new(move |sender, _| {
                let Some(core) = sender.and_then(|c| c.cast::<ICoreWebView2_8>().ok()) else { return Ok(()) };
                let mut playing = BOOL::default();
                core.IsDocumentPlayingAudio(&mut playing)?;
                AUDIO.store(playing.as_bool(), Ordering::Relaxed);
                if !playing.as_bool() {
                    schedule_close(&a);
                }
                Ok(())
            }));
            core8.add_IsDocumentPlayingAudioChanged(&handler, &mut token)?;
        }

        // Fullscreen video or streams: the view takes the whole window, and the window the whole screen.
        let a = app.clone();
        let handler = ContainsFullScreenElementChangedEventHandler::create(Box::new(move |sender, _| {
            let Some(core) = sender else { return Ok(()) };
            let mut full = BOOL::default();
            core.ContainsFullScreenElement(&mut full)?;
            FULLSCREEN.store(full.as_bool(), Ordering::Relaxed);
            if let Some(main) = a.get_webview_window("main") {
                let _ = main.set_fullscreen(full.as_bool());
            }
            VIEW.with(|v| {
                if let Some(view) = v.borrow().as_ref() {
                    fit(view);
                }
            });
            Ok(())
        }));
        core.add_ContainsFullScreenElementChanged(&handler, &mut token)?;

        // Ctrl+Alt+D switches back while Discord has the keyboard.
        let a = app.clone();
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
            args.KeyEventKind(&mut kind)?;
            let mut key = 0u32;
            args.VirtualKey(&mut key)?;
            let down = |vk: i32| GetKeyState(vk) < 0;
            // With Alt held, Windows reports a "system" key.
            let pressed = kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN || kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN;
            if pressed
                && key == 0x44
                && down(VK_CONTROL.0 as i32)
                && down(VK_MENU.0 as i32)
                && !down(VK_SHIFT.0 as i32)
            {
                args.SetHandled(true)?;
                let _ = a.emit_to("main", "discord-toggle", ());
            }
            Ok(())
        }));
        controller.add_AcceleratorKeyPressed(&handler, &mut token)?;

        let view = View { controller, core, parent, container, notes: Vec::new(), next_note: 0, badge: (0, false) };
        fit(&view);
        apply_visibility(app, &view);
        view.core.Navigate(&HSTRING::from(HOME))?;
        VIEW.with(|v| *v.borrow_mut() = Some(view));
        emit_state(app);
        if !VISIBLE.load(Ordering::Relaxed) {
            schedule_close(app);
        }
        Ok(())
    }

    pub fn start(app: &AppHandle, top: i32, visible: bool, keep: bool) {
        TOP.store(top, Ordering::Relaxed);
        KEEP.store(keep, Ordering::Relaxed);
        VISIBLE.store(visible, Ordering::Relaxed);
        HIDE_GEN.fetch_add(1, Ordering::Relaxed);
        on_main(app, |app| {
            let existing = VIEW.with(|v| {
                let v = v.borrow();
                let view = v.as_ref()?;
                unsafe {
                    fit(view);
                    apply_visibility(app, view);
                }
                Some(view.badge)
            });
            match existing {
                Some(badge) => {
                    emit_badge(app, badge);
                    emit_state(app);
                    schedule_close(app);
                }
                None => create(app),
            }
        });
    }

    pub fn show(app: &AppHandle, visible: bool, keep: bool) {
        VISIBLE.store(visible, Ordering::Relaxed);
        KEEP.store(keep, Ordering::Relaxed);
        HIDE_GEN.fetch_add(1, Ordering::Relaxed);
        on_main(app, |app| {
            let found = VIEW.with(|v| {
                v.borrow().as_ref().map(|view| unsafe {
                    fit(view);
                    apply_visibility(app, view);
                })
            });
            if found.is_some() {
                schedule_close(app);
            }
        });
    }

    pub fn set_top(app: &AppHandle, top: i32) {
        TOP.store(top, Ordering::Relaxed);
        fit_now(app);
    }

    fn fit_now(app: &AppHandle) {
        on_main(app, |_| {
            VIEW.with(|v| {
                if let Some(view) = v.borrow().as_ref() {
                    unsafe { fit(view) };
                }
            })
        });
    }

    pub fn stop(app: &AppHandle) {
        VISIBLE.store(false, Ordering::Relaxed);
        on_main(app, close);
    }

    pub fn notification_clicked(app: &AppHandle, id: u32) {
        on_main(app, move |_| {
            VIEW.with(|v| {
                if let Some(view) = v.borrow_mut().as_mut() {
                    if let Some(i) = view.notes.iter().position(|(n, _)| *n == id) {
                        let (_, note) = view.notes.remove(i);
                        unsafe {
                            let _ = note.ReportClicked();
                        }
                    }
                }
            })
        });
    }

    /// A JPEG of what the view shows now, for the switch's motion to play on.
    pub fn snapshot(app: &AppHandle) -> Result<Vec<u8>, String> {
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
        on_main(app, move |_| {
            let tx2 = tx.clone();
            let started = VIEW.with(|v| -> Result<(), String> {
                let v = v.borrow();
                let view = v.as_ref().ok_or("Discord isn't open")?;
                unsafe {
                    let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true).map_err(|e| e.to_string())?;
                    let s = stream.clone();
                    let handler = CapturePreviewCompletedHandler::create(Box::new(move |hr| {
                        let _ = tx2.send(hr.map_err(|e| e.to_string()).and_then(|_| read_stream(&s)));
                        Ok(())
                    }));
                    view.core
                        .CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG, &stream, &handler)
                        .map_err(|e| e.to_string())
                }
            });
            if let Err(e) = started {
                let _ = tx.send(Err(e));
            }
        });
        rx.recv_timeout(Duration::from_secs(2)).map_err(|_| "no picture".to_string())?
    }

    unsafe fn read_stream(stream: &IStream) -> Result<Vec<u8>, String> {
        let mut stat = STATSTG::default();
        stream.Stat(&mut stat, STATFLAG_NONAME).map_err(|e| e.to_string())?;
        stream.Seek(0, STREAM_SEEK_SET, None).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; stat.cbSize as usize];
        let mut read = 0u32;
        stream.Read(buf.as_mut_ptr().cast(), buf.len() as u32, Some(&mut read)).ok().map_err(|e| e.to_string())?;
        buf.truncate(read as usize);
        Ok(buf)
    }

    /// Signs out of Discord and removes everything it kept (only Discord's sites; Linkord's own data stays).
    pub fn forget(app: &AppHandle) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<bool>();
        on_main(app, move |app| {
            close(app);
            let Some(main) = app.get_webview_window("main") else {
                let _ = tx.send(false);
                return;
            };
            let tx2 = tx.clone();
            let started = main.with_webview(move |w| unsafe {
                let Ok(core) = w.controller().CoreWebView2() else {
                    let _ = tx2.send(false);
                    return;
                };
                // The HTTP cache (pictures and attachments Discord showed) isn't kept per site: it's emptied whole,
                // which only costs Linkord a few downloads again.
                let calls = ORIGINS
                    .iter()
                    .map(|origin| {
                        let params = serde_json::json!({ "origin": origin, "storageTypes": "all" }).to_string();
                        ("Storage.clearDataForOrigin", params)
                    })
                    .chain([("Network.clearBrowserCache", "{}".to_string())]);
                for (method, params) in calls {
                    let tx3 = tx2.clone();
                    let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |hr, _| {
                        let _ = tx3.send(hr.is_ok());
                        Ok(())
                    }));
                    if core.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(params), &done).is_err()
                    {
                        let _ = tx2.send(false);
                    }
                }
            });
            if started.is_err() {
                let _ = tx.send(false);
            }
        });
        let mut ok = true;
        for _ in 0..ORIGINS.len() + 1 {
            ok &= rx.recv_timeout(Duration::from_secs(10)).unwrap_or(false);
        }
        if ok {
            Ok(())
        } else {
            Err("Couldn't remove all of Discord's data".into())
        }
    }
}

/// Creates the view if needed (hidden unless `visible`) and places it below `top` (physical pixels).
#[tauri::command]
pub fn discord_start(app: AppHandle, top: i32, visible: bool, keep: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::start(&app, top, visible, keep);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, top, visible, keep);
        Err("Discord in Linkord is Windows only".into())
    }
}

#[tauri::command]
pub fn discord_show(app: AppHandle, visible: bool, keep: bool) {
    #[cfg(windows)]
    imp::show(&app, visible, keep);
    #[cfg(not(windows))]
    let _ = (app, visible, keep);
}

#[tauri::command]
pub fn discord_set_top(app: AppHandle, top: i32) {
    #[cfg(windows)]
    imp::set_top(&app, top);
    #[cfg(not(windows))]
    let _ = (app, top);
}

#[tauri::command]
pub fn discord_stop(app: AppHandle) {
    #[cfg(windows)]
    imp::stop(&app);
    #[cfg(not(windows))]
    let _ = app;
}

#[tauri::command]
pub fn discord_notification_clicked(app: AppHandle, id: u32) {
    #[cfg(windows)]
    imp::notification_clicked(&app, id);
    #[cfg(not(windows))]
    let _ = (app, id);
}

/// Async: it waits for the main thread, which a plain command would be running on.
#[tauri::command]
pub async fn discord_snapshot(app: AppHandle) -> Result<tauri::ipc::Response, String> {
    #[cfg(windows)]
    {
        let bytes = tauri::async_runtime::spawn_blocking(move || imp::snapshot(&app)).await.map_err(|e| e.to_string())??;
        Ok(tauri::ipc::Response::new(bytes))
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Discord in Linkord is Windows only".into())
    }
}

#[tauri::command]
pub async fn discord_forget(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || imp::forget(&app)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Discord in Linkord is Windows only".into())
    }
}

