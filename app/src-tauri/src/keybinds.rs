//! Global keybinds (push-to-talk, toggle mute, go live...) on Windows via low-level keyboard and
//! mouse hooks. They work while a game has focus, while Linkord is focused, minimized or in the tray.
//! The hooks only observe input (keys always reach the focused app).
//!
//! Windows silently removes low-level hooks that answer slowly, so the hook callbacks only update
//! the [`Matcher`] and queue matches; a separate thread forwards them to the webview.

use std::collections::HashSet;

use serde::Deserialize;

pub const CTRL: u8 = 1;
pub const SHIFT: u8 = 2;
pub const ALT: u8 = 4;
pub const META: u8 = 8;

/// One keybind as the client sends it: a key (Windows virtual-key code; 0x04-0x06 are mouse
/// buttons) plus required modifiers. Hold binds (push-to-talk) report press and release.
#[derive(Clone, Debug, Deserialize)]
pub struct Bind {
    pub id: u32,
    pub vk: u32,
    pub mods: u8,
    pub hold: bool,
}

/// Which modifier a virtual-key code is (generic and left/right variants).
pub fn modifier_of(vk: u32) -> u8 {
    match vk {
        0x10 | 0xA0 | 0xA1 => SHIFT,
        0x11 | 0xA2 | 0xA3 => CTRL,
        0x12 | 0xA4 | 0xA5 => ALT,
        0x5B | 0x5C => META,
        _ => 0,
    }
}

#[derive(Default)]
pub struct Matcher {
    binds: Vec<Bind>,
    /// Keys currently held, to tell real presses from auto-repeat and to know the modifiers.
    down: HashSet<u32>,
    /// Hold binds currently pressed.
    active: Vec<u32>,
}

impl Matcher {
    /// Replaces the binds; anything held is released.
    pub fn set_binds(&mut self, binds: Vec<Bind>) -> Vec<(u32, bool)> {
        self.binds = binds;
        self.active.drain(..).map(|id| (id, false)).collect()
    }

    /// Modifiers held, not counting `except` itself (so a bare "Left Ctrl" bind still matches).
    fn mods(&self, except: u32) -> u8 {
        self.down.iter().filter(|&&k| k != except).fold(0, |m, &k| m | modifier_of(k))
    }

    /// Forgets keys whose release we never saw (lock screen, UAC prompt...).
    pub fn retain_down(&mut self, still_down: impl Fn(u32) -> bool) {
        self.down.retain(|&k| still_down(k));
    }

    pub fn key_down(&mut self, vk: u32) -> Vec<(u32, bool)> {
        if !self.down.insert(vk) {
            return vec![]; // auto-repeat
        }
        let mods = self.mods(vk);
        let mut out = vec![];
        for b in &self.binds {
            // Hold binds tolerate extra modifiers (sprinting with Shift while talking); presses
            // need the exact combination so Ctrl+M doesn't also fire a bare M bind.
            let hit = b.vk == vk && if b.hold { mods & b.mods == b.mods } else { mods == b.mods };
            if !hit {
                continue;
            }
            if b.hold {
                if self.active.contains(&b.id) {
                    continue;
                }
                self.active.push(b.id);
            }
            out.push((b.id, true));
        }
        out
    }

    pub fn key_up(&mut self, vk: u32) -> Vec<(u32, bool)> {
        self.down.remove(&vk);
        let released = modifier_of(vk);
        let still = self.mods(0);
        let binds = &self.binds;
        let mut out = vec![];
        self.active.retain(|id| {
            let Some(b) = binds.iter().find(|b| b.id == *id) else { return false };
            let lost_modifier = released != 0 && b.mods & released != 0 && still & released == 0;
            if b.vk == vk || lost_modifier {
                out.push((*id, false));
                false
            } else {
                true
            }
        });
        out
    }
}

#[cfg(windows)]
mod hook {
    use std::sync::mpsc::{channel, Sender};
    use std::sync::{Mutex, OnceLock};

    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetWindowsHookExW, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN,
        WM_KEYUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
    };

    use super::{Bind, Matcher};

    static MATCHER: Mutex<Option<Matcher>> = Mutex::new(None);
    static TX: OnceLock<Sender<(u32, bool)>> = OnceLock::new();

    fn with(f: impl FnOnce(&mut Matcher) -> Vec<(u32, bool)>) {
        let events = match MATCHER.lock() {
            Ok(mut m) => f(m.get_or_insert_with(Matcher::default)),
            Err(_) => return,
        };
        if let Some(tx) = TX.get() {
            for e in events {
                let _ = tx.send(e);
            }
        }
    }

    pub fn set_binds(binds: Vec<Bind>) {
        with(|m| m.set_binds(binds));
    }

    unsafe extern "system" fn keyboard(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code >= 0 {
            let vk = (*(l.0 as *const KBDLLHOOKSTRUCT)).vkCode;
            match w.0 as u32 {
                WM_KEYDOWN | WM_SYSKEYDOWN => with(|m| {
                    m.retain_down(|k| k == vk || k <= 0x06 || GetAsyncKeyState(k as i32) < 0);
                    m.key_down(vk)
                }),
                WM_KEYUP | WM_SYSKEYUP => with(|m| m.key_up(vk)),
                _ => {}
            }
        }
        CallNextHookEx(None, code, w, l)
    }

    unsafe extern "system" fn mouse(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code >= 0 {
            let msg = w.0 as u32;
            let info = &*(l.0 as *const MSLLHOOKSTRUCT);
            let button = match msg {
                WM_MBUTTONDOWN | WM_MBUTTONUP => Some(0x04),
                WM_XBUTTONDOWN | WM_XBUTTONUP => Some(if (info.mouseData >> 16) & 0xffff == 1 { 0x05 } else { 0x06 }),
                _ => None,
            };
            if let Some(vk) = button {
                if matches!(msg, WM_MBUTTONDOWN | WM_XBUTTONDOWN) {
                    with(|m| m.key_down(vk));
                } else {
                    with(|m| m.key_up(vk));
                }
            }
        }
        CallNextHookEx(None, code, w, l)
    }

    /// Installs the hooks on a dedicated thread with its own message loop (required for low-level
    /// hooks), and a second thread that delivers matches as `keybind` events.
    pub fn start(app: AppHandle) {
        let (tx, rx) = channel::<(u32, bool)>();
        let _ = TX.set(tx);
        std::thread::spawn(move || {
            for (id, down) in rx {
                let _ = app.emit("keybind", serde_json::json!({ "id": id, "down": down }));
            }
        });
        std::thread::spawn(|| unsafe {
            let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), None, 0);
            let ms = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), None, 0);
            if kb.is_err() || ms.is_err() {
                eprintln!("keybind hooks unavailable: {:?} {:?}", kb.err(), ms.err());
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        });
    }
}

#[cfg(windows)]
pub use hook::{set_binds, start};

#[cfg(test)]
mod tests {
    use super::*;

    fn bind(id: u32, vk: u32, mods: u8, hold: bool) -> Bind {
        Bind { id, vk, mods, hold }
    }

    #[test]
    fn combos_need_exact_modifiers() {
        let mut m = Matcher::default();
        m.set_binds(vec![bind(1, b'M' as u32, CTRL, false), bind(2, b'M' as u32, 0, false), bind(3, 0x6A, SHIFT, false)]);
        assert_eq!(m.key_down(0xA2), vec![]);
        assert_eq!(m.key_down(b'M' as u32), vec![(1, true)]);
        assert_eq!(m.key_down(b'M' as u32), vec![], "auto-repeat");
        m.key_up(b'M' as u32);
        m.key_up(0xA2);
        assert_eq!(m.key_down(b'M' as u32), vec![(2, true)]);
        m.key_up(b'M' as u32);
        m.key_down(0xA1); // right shift + numpad *
        assert_eq!(m.key_down(0x6A), vec![(3, true)]);
    }

    #[test]
    fn hold_binds_release_on_key_or_modifier_up() {
        let mut m = Matcher::default();
        m.set_binds(vec![bind(1, b'V' as u32, 0, true), bind(2, 0x05, ALT, true), bind(3, 0xA2, 0, true)]);
        m.key_down(0xA0); // holding shift to sprint doesn't stop push-to-talk
        assert_eq!(m.key_down(b'V' as u32), vec![(1, true)]);
        assert_eq!(m.key_up(0xA0), vec![]);
        assert_eq!(m.key_up(b'V' as u32), vec![(1, false)]);
        m.key_down(0xA4);
        assert_eq!(m.key_down(0x05), vec![(2, true)]);
        assert_eq!(m.key_up(0xA4), vec![(2, false)], "releasing Alt ends Alt+Mouse4");
        m.key_up(0x05);
        assert_eq!(m.key_down(0xA2), vec![(3, true)], "a bare modifier can be a bind");
        assert_eq!(m.key_up(0xA2), vec![(3, false)]);
    }

    #[test]
    fn changing_binds_releases_held_ones() {
        let mut m = Matcher::default();
        m.set_binds(vec![bind(1, b'V' as u32, 0, true)]);
        m.key_down(b'V' as u32);
        assert_eq!(m.set_binds(vec![]), vec![(1, false)]);
    }
}
