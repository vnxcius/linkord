//! What Linkord uses, measured like Task Manager's Memory column (private working set): linkord.exe and the WebView2
//! processes it runs on, split by what they serve. Task Manager files the WebView2 ones under "Microsoft Edge WebView2",
//! apart from Linkord, so its "Linkord" line is only the shell; Settings -> Desktop App shows the whole of it.

use tauri::AppHandle;

/// Bytes. `pages`: Linkord's own pages (windows, players inside them); `discord`: Discord's view (discord.rs) and what
/// it embeds; `engine`: the browser engine's shared processes (browser, graphics, network, audio...).
#[derive(serde::Serialize, Default, Debug)]
pub struct Usage {
    app: u64,
    pages: u64,
    discord: u64,
    engine: u64,
}

#[cfg(windows)]
mod imp {
    use super::Usage;
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};
    use webview2_com::GetProcessExtendedInfosCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::core::{Interface, BOOL, PWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    #[derive(Clone, Copy)]
    enum Part {
        Pages,
        Discord,
        Engine,
    }

    /// The page a frame belongs to: its top frame's address.
    unsafe fn top_source(frame: ICoreWebView2FrameInfo) -> String {
        let mut frame = frame;
        for _ in 0..16 {
            let parent = frame.cast::<ICoreWebView2FrameInfo2>().and_then(|f| f.ParentFrameInfo());
            match parent {
                Ok(p) => frame = p,
                Err(_) => break,
            }
        }
        let mut source = PWSTR::null();
        if frame.Source(&mut source).is_err() {
            return String::new();
        }
        webview2_com::take_pwstr(source)
    }

    /// A page process is Discord's when every page it serves is; anything mixed counts as Linkord's.
    unsafe fn renderer_part(info: &ICoreWebView2ProcessExtendedInfo) -> Part {
        let Ok(frames) = info.AssociatedFrameInfos().and_then(|f| f.GetIterator()) else { return Part::Engine };
        let (mut discord, mut other) = (false, false);
        let mut has = BOOL::default();
        while frames.HasCurrent(&mut has).is_ok() && has.as_bool() {
            if let Ok(frame) = frames.GetCurrent() {
                if crate::discord::is_discord(&top_source(frame)) {
                    discord = true;
                } else {
                    other = true;
                }
            }
            let mut more = BOOL::default();
            if frames.MoveNext(&mut more).is_err() || !more.as_bool() {
                break;
            }
        }
        match (discord, other) {
            (true, false) => Part::Discord,
            (false, false) => Part::Engine, // a spare process waiting for a page
            _ => Part::Pages,
        }
    }

    fn private_working_set(pid: u32) -> u64 {
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return 0 };
            let mut counters = PROCESS_MEMORY_COUNTERS_EX2 {
                cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32,
                ..Default::default()
            };
            let ok = GetProcessMemoryInfo(
                handle,
                &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
                counters.cb,
            )
            .is_ok();
            let _ = CloseHandle(handle);
            if ok {
                counters.PrivateWorkingSetSize as u64
            } else {
                0
            }
        }
    }

    pub fn measure(app: &AppHandle) -> Result<Usage, String> {
        let main = app.get_webview_window("main").ok_or("no window")?;
        let (tx, rx) = mpsc::channel::<Vec<(u32, Part)>>();
        main.with_webview(move |w| unsafe {
            let env = w
                .controller()
                .CoreWebView2()
                .and_then(|c| c.cast::<ICoreWebView2_2>())
                .and_then(|c| c.Environment())
                .and_then(|e| e.cast::<ICoreWebView2Environment13>());
            let Ok(env) = env else {
                let _ = tx.send(Vec::new());
                return;
            };
            let tx2 = tx.clone();
            let handler = GetProcessExtendedInfosCompletedHandler::create(Box::new(move |hr, list| {
                let mut out = Vec::new();
                if let (Ok(()), Some(list)) = (hr, list) {
                    let mut count = 0u32;
                    let _ = list.Count(&mut count);
                    for i in 0..count {
                        let Ok(info) = list.GetValueAtIndex(i) else { continue };
                        let Ok(process) = info.ProcessInfo() else { continue };
                        let (mut pid, mut kind) = (0i32, COREWEBVIEW2_PROCESS_KIND::default());
                        let _ = process.ProcessId(&mut pid);
                        let _ = process.Kind(&mut kind);
                        let part =
                            if kind == COREWEBVIEW2_PROCESS_KIND_RENDERER { renderer_part(&info) } else { Part::Engine };
                        out.push((pid as u32, part));
                    }
                }
                let _ = tx2.send(out);
                Ok(())
            }));
            if env.GetProcessExtendedInfos(&handler).is_err() {
                let _ = tx.send(Vec::new());
            }
        })
        .map_err(|e| e.to_string())?;
        let processes = rx.recv_timeout(Duration::from_secs(3)).map_err(|_| "no answer".to_string())?;
        let mut usage = Usage { app: private_working_set(std::process::id()), ..Default::default() };
        for (pid, part) in processes {
            let bytes = private_working_set(pid);
            match part {
                Part::Pages => usage.pages += bytes,
                Part::Discord => usage.discord += bytes,
                Part::Engine => usage.engine += bytes,
            }
        }
        Ok(usage)
    }
}

/// Async: it waits for the main thread, which a plain command would be running on.
#[tauri::command]
pub async fn app_memory(app: AppHandle) -> Result<Usage, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || imp::measure(&app)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Windows only".into())
    }
}
