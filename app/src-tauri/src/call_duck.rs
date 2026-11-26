//! Lowers Linkord while another app's call needs to be heard (Windows): a WhatsApp, Teams, Zoom... call that rings or
//! is answered while you're in a Linkord call. Only during a Linkord call, it looks at Windows' audio sessions about
//! once a second (no hooks into anything) and tells the web app `call-duck` true/false; the web app turns its voice
//! output down (lib/voice.ts) and back up.
//!
//! - In a call: a calling app (or a process it started, like its WebView2) uses a microphone.
//! - Ringing: a calling app starts playing sound after a quiet spell; that counts for up to [RING_MAX] (a ringtone,
//!   a voice note), so an app that keeps its output open all the time never holds Linkord down.
//!
//! Games' voice chats never count (only the apps in [CALL_APPS]), and neither does Linkord itself.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

/// Calling apps, by executable name (lower case).
const CALL_APPS: &[&str] = &[
    "whatsapp.exe",
    "whatsapp.root.exe",
    "ms-teams.exe",
    "teams.exe",
    "zoom.exe",
    "cpthost.exe",
    "skype.exe",
    "telegram.exe",
    "signal.exe",
    "discord.exe",
    "discordptb.exe",
    "discordcanary.exe",
    "slack.exe",
    "phoneexperiencehost.exe",
    "messenger.exe",
    "viber.exe",
    "webex.exe",
    "ciscocollabhost.exe",
];
const POLL: Duration = Duration::from_millis(900);
/// How long an app must have been silent for new sound from it to count as ringing.
const QUIET_BEFORE_RING: Duration = Duration::from_secs(3);
/// The longest a ring (sound without the microphone) keeps Linkord down.
const RING_MAX: Duration = Duration::from_secs(45);
/// Linkord comes back up only after the other call has been over this long (no bouncing between words).
const RELEASE_AFTER: Duration = Duration::from_millis(1500);

static RUNNING: AtomicBool = AtomicBool::new(false);
static WATCHING: Mutex<bool> = Mutex::new(false);

/// The web app joined (true) or left (false) a voice call. Off: Linkord is let back up at once.
#[tauri::command]
pub fn call_watch(app: AppHandle, on: bool) {
    *WATCHING.lock().unwrap() = on;
    if on && !RUNNING.swap(true, Ordering::SeqCst) {
        std::thread::Builder::new()
            .name("linkord-call-duck".into())
            .spawn(move || {
                #[cfg(windows)]
                imp::run(&app);
                #[cfg(not(windows))]
                let _ = app;
                RUNNING.store(false, Ordering::SeqCst);
            })
            .ok();
    }
}

fn watching() -> bool {
    *WATCHING.lock().unwrap()
}

/// What one look at the sessions found, per calling app (its name): using a microphone, playing sound.
#[derive(Default, Clone, Copy)]
#[cfg_attr(not(windows), allow(dead_code))]
struct Seen {
    mic: bool,
    sound: bool,
}

/// Turns what's seen over time into "keep Linkord down" (no Windows calls in here).
#[derive(Default)]
#[cfg_attr(not(windows), allow(dead_code))]
struct Decide {
    /// Per app: when it last made no sound, and when its current sound started.
    quiet_at: HashMap<String, Instant>,
    sound_from: HashMap<String, Instant>,
    /// When the current ring started (sound after a quiet spell), per app.
    ring_from: HashMap<String, Instant>,
    /// When the last reason to stay down was seen.
    last_reason: Option<Instant>,
    /// The first look: an app not heard from since has been quiet since then.
    start: Option<Instant>,
    down: bool,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl Decide {
    /// Returns the new state when it changes.
    fn step(&mut self, now: Instant, seen: &HashMap<String, Seen>) -> Option<bool> {
        let start = *self.start.get_or_insert(now);
        let mut reason = false;
        let names: Vec<String> = self.quiet_at.keys().chain(self.sound_from.keys()).chain(seen.keys()).cloned().collect();
        for name in names {
            let s = seen.get(&name).copied().unwrap_or_default();
            if s.mic {
                reason = true;
            }
            if s.sound {
                if !self.sound_from.contains_key(&name) {
                    self.sound_from.insert(name.clone(), now);
                    // Silent long enough before (never heard from: since the first look): a ring starts.
                    let quiet = self.quiet_at.get(&name).copied().unwrap_or(start);
                    if now.duration_since(quiet) >= QUIET_BEFORE_RING {
                        self.ring_from.insert(name.clone(), now);
                    }
                }
                if self.ring_from.get(&name).is_some_and(|r| now.duration_since(*r) < RING_MAX) {
                    reason = true;
                }
            } else {
                self.sound_from.remove(&name);
                self.ring_from.remove(&name);
                self.quiet_at.insert(name.clone(), now);
            }
        }
        if reason {
            self.last_reason = Some(now);
        }
        let want = reason || self.last_reason.is_some_and(|t| now.duration_since(t) < RELEASE_AFTER);
        (want != self.down).then(|| {
            self.down = want;
            want
        })
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::Interface;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};

    pub fn run(app: &AppHandle) {
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        let mut decide = Decide::default();
        // An app seen once (a process the first look missed) is first heard from as "quiet before": a call already
        // ringing when you joined counts only once it stops and starts again.
        let mut first = true;
        while watching() {
            let seen = unsafe { look() }.unwrap_or_default();
            let now = Instant::now();
            if first {
                for name in seen.keys() {
                    decide.sound_from.insert(name.clone(), now);
                }
                first = false;
            }
            if let Some(down) = decide.step(now, &seen) {
                let _ = app.emit_to("main", "call-duck", down);
            }
            std::thread::sleep(POLL);
        }
        if decide.down {
            let _ = app.emit_to("main", "call-duck", false);
        }
        if com {
            unsafe { CoUninitialize() };
        }
    }

    /// Every active audio session on every device, by calling app.
    unsafe fn look() -> windows::core::Result<HashMap<String, Seen>> {
        let mut out: HashMap<String, Seen> = HashMap::new();
        let procs = processes();
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let list = devices.EnumAudioEndpoints(eAll, DEVICE_STATE_ACTIVE)?;
        for i in 0..list.GetCount()? {
            let Ok(device) = list.Item(i) else { continue };
            let Ok(flow) = device.cast::<IMMEndpoint>().and_then(|e| e.GetDataFlow()) else { continue };
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let Ok(sessions) = manager.GetSessionEnumerator() else { continue };
            for j in 0..sessions.GetCount().unwrap_or(0) {
                let Ok(s) = sessions.GetSession(j) else { continue };
                if s.GetState().ok() != Some(AudioSessionStateActive) {
                    continue;
                }
                let Ok(pid) = s.cast::<IAudioSessionControl2>().and_then(|s| s.GetProcessId()) else { continue };
                let Some(name) = calling_app(pid, &procs) else { continue };
                let e = out.entry(name).or_default();
                if flow == eCapture {
                    e.mic = true;
                } else {
                    e.sound = true;
                }
            }
        }
        Ok(out)
    }

    /// pid -> (parent pid, executable name in lower case).
    unsafe fn processes() -> HashMap<u32, (u32, String)> {
        let mut out = HashMap::new();
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut more = Process32FirstW(snap, &mut e).is_ok();
        while more {
            let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
            out.insert(e.th32ProcessID, (e.th32ParentProcessID, String::from_utf16_lossy(&e.szExeFile[..len]).to_lowercase()));
            more = Process32NextW(snap, &mut e).is_ok();
        }
        let _ = CloseHandle(snap);
        out
    }

    /// The calling app a process belongs to: itself, or the nearest of its parents that is one (a WebView2 or
    /// Electron helper plays the sound for many of them). Never Linkord.
    fn calling_app(pid: u32, procs: &HashMap<u32, (u32, String)>) -> Option<String> {
        let ours = crate::capture::linkord_audio_pid();
        let mut at = pid;
        for _ in 0..6 {
            if at == ours || at == std::process::id() {
                return None;
            }
            let (parent, name) = procs.get(&at)?;
            if CALL_APPS.contains(&name.as_str()) {
                return Some(name.clone());
            }
            if *parent == 0 || *parent == at {
                return None;
            }
            at = *parent;
        }
        None
    }
}

