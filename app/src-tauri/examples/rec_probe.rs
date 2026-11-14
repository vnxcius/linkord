//! Runs REC's video pipeline on the primary monitor for a while and prints what it did (Windows). With
//! rec_standin running, it measures what recording costs a game.
//!
//!   cargo run --release --example rec_probe -- <seconds=15> <height=1080> <fps=60> <cursor=1> <mic=0|1|name>
//!
//! Leaves the recording (segments + the last 5 s as clip.mp4) in %TEMP%\pottira-rec.

#[cfg(windows)]
fn main() {
    // Like the app: physical pixels, and Desktop Duplication's newer call.
    unsafe {
        use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let args: Vec<String> = std::env::args().collect();
    let arg = |i: usize, default: u32| args.get(i).and_then(|a| a.parse().ok()).unwrap_or(default);
    let settings = pottira_lib::rec::gpu::VideoSettings { max_height: arg(2, 1080), fps: arg(3, 60), bitrate: 12_000_000, cursor: arg(4, 1) == 1 };
    let root = std::env::temp_dir().join("pottira-rec");
    // <mic>: 0 = none, 1 = Windows' communications mic, anything else = that device's name.
    let mic = match args.get(5).map(String::as_str) {
        None | Some("0") => None,
        Some("1") => Some(String::new()),
        Some(name) => Some(name.to_string()),
    };
    // Sound: everything the PC plays (this program plays nothing); the mic only with <mic=1>.
    let audio = pottira_lib::rec::audio::AudioSettings { game: Some(pottira_lib::rec::audio::Source::AllExcept(std::process::id())), mic, output: String::new(), voices: false };
    match pottira_lib::rec::trial(&root, arg(1, 15) as f32, settings, audio) {
        Ok(report) => println!("{report:#?}"),
        Err(e) => eprintln!("failed: {e}"),
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows only");
}
