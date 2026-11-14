//! Drives REC's session engine like the app does, against a running examples/rec_standin.rs (Windows): records its
//! window and process, saves a clip from the live recording, a screenshot and a bookmark, stops, and prints the
//! library. Everything goes to %TEMP%\pottira-rec-session (not the real REC folder).
//!
//!   start rec_standin, then: cargo run --release --example rec_session -- <seconds=12>

#[cfg(windows)]
fn main() {
    use pottira_lib::rec::session;
    use windows::core::w;
    use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowThreadProcessId};

    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let seconds: u64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(12);
    let hwnd = unsafe { FindWindowW(None, w!("REC stand-in")) }.expect("start rec_standin first");
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    session::start_housekeeping();
    let folder = std::env::temp_dir().join("pottira-rec-session");
    let _ = std::fs::remove_dir_all(&folder);
    session::configure(session::Config { folder: folder.display().to_string(), mic: None, clip_seconds: 5, ..session::Config::default() });

    let game = session::Game { name: "REC: Stand-in?".into(), key: "standin".into(), pid, window: format!("window:{}", hwnd.0 as usize) };
    let started = std::time::Instant::now();
    session::start(game).expect("recording starts");
    println!("recording: {:?}", session::status());
    std::thread::sleep(std::time::Duration::from_secs(seconds / 2));
    println!("bookmark at {:?} ms", session::bookmark());
    let shot = session::screenshot();
    println!("screenshot: {shot:?}");
    std::thread::sleep(std::time::Duration::from_secs(seconds / 2));
    let asked = std::time::Instant::now();
    let clip = session::clip(None, None);
    println!("clip: {clip:?} (saved {} ms after asking)", asked.elapsed().as_millis());
    session::stop();
    println!("stopped after {:.1} s: {:?}", started.elapsed().as_secs_f32(), session::status());
    let library = session::library();
    println!("{}", serde_json::to_string_pretty(&library).unwrap());
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows only");
}
