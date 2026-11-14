//! Logs every key a low-level keyboard hook sees, for a few seconds (Windows): a check that keys reach hooks while some
//! window has focus (REC overlay hotkeys).
//!
//!   cargo run --release --example hook_log -- <seconds=15>

#[cfg(windows)]
fn main() {
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::*;

    unsafe extern "system" fn keyboard(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code >= 0 {
            let k = &*(l.0 as *const KBDLLHOOKSTRUCT);
            let what = match w.0 as u32 {
                WM_KEYDOWN | WM_SYSKEYDOWN => "down",
                WM_KEYUP | WM_SYSKEYUP => "up",
                _ => "?",
            };
            println!("{:>8} vk {:#04x} {} flags {:#x}", k.time, k.vkCode, what, k.flags.0);
        }
        CallNextHookEx(None, code, w, l)
    }

    let seconds: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(15);
    unsafe {
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard), None, 0).expect("hook");
        let until = Instant::now() + Duration::from_secs(seconds);
        let mut msg = MSG::default();
        while Instant::now() < until {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {}
            std::thread::sleep(Duration::from_millis(5));
        }
        let _ = UnhookWindowsHookEx(hook);
    }
}

#[cfg(not(windows))]
fn main() {}
