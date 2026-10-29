//! Running applications, for "Playing <game>" activities (Windows). The web app matches the executable
//! paths against Discord's detectable-games list and uses the main window to stream the game directly.

use serde::Serialize;

#[derive(Serialize)]
pub struct RunningApp {
    pid: u32,
    /// Full executable path when Windows lets us read it (not for elevated processes), else just the file name.
    path: String,
    /// The process's largest visible top-level window, if it has one.
    window: Option<AppWindow>,
}

#[derive(Serialize)]
pub struct AppWindow {
    /// Capture source id ("window:<hwnd>"), as in list_capture_sources.
    id: String,
    title: String,
    width: u32,
    height: u32,
    minimized: bool,
}

#[tauri::command]
pub async fn running_apps() -> Result<Vec<RunningApp>, String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(imp::list).await.map_err(|e| e.to_string());
    #[cfg(not(windows))]
    Err("game detection is only available on Windows".into())
}

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;

    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};

    use super::{AppWindow, RunningApp};

    fn wide_to_string(w: &[u16]) -> String {
        let end = w.iter().position(|&c| c == 0).unwrap_or(w.len());
        String::from_utf16_lossy(&w[..end])
    }

    fn full_path(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(h);
            ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
        }
    }

    /// Largest visible window per process.
    fn windows() -> HashMap<u32, AppWindow> {
        let mut out: HashMap<u32, AppWindow> = HashMap::new();
        for w in xcap::Window::all().unwrap_or_default() {
            let (Ok(pid), Ok(id)) = (w.pid(), w.id()) else { continue };
            let title = w.title().unwrap_or_default();
            let (width, height) = (w.width().unwrap_or(0), w.height().unwrap_or(0));
            let minimized = w.is_minimized().unwrap_or(false);
            // Minimized windows report a tiny size; keep them (League's client sits minimized during a match).
            if title.trim().is_empty() || (!minimized && (width < 120 || height < 80)) {
                continue;
            }
            if out.get(&pid).is_some_and(|o| o.width * o.height >= width * height) {
                continue;
            }
            out.insert(pid, AppWindow { id: format!("window:{id}"), title, width, height, minimized });
        }
        out
    }

    pub fn list() -> Vec<RunningApp> {
        let me = std::process::id();
        let mut wins = windows();
        let mut out = Vec::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut more = Process32FirstW(snap, &mut e).is_ok();
            while more {
                let pid = e.th32ProcessID;
                if pid > 4 && pid != me {
                    let path = full_path(pid).unwrap_or_else(|| wide_to_string(&e.szExeFile));
                    out.push(RunningApp { pid, path, window: wins.remove(&pid) });
                }
                more = Process32NextW(snap, &mut e).is_ok();
            }
            let _ = CloseHandle(snap);
        }
        out
    }
}
