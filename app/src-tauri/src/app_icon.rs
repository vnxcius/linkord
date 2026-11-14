//! The Christmas app icon on Windows, changed while the app runs. The icon inside the .exe can't change, so:
//! - open windows get it with WM_SETICON (title bar, Alt+Tab, the taskbar button of a running app);
//! - shortcuts that start this .exe (Start menu, desktop, pinned to the taskbar) point at an .ico in the app's data
//!   folder, and go back to the .exe's own icon afterwards. Only shortcuts whose target is this exact .exe are touched;
//! - Explorer is told at once (SHChangeNotify, then ie4uinit, which also clears what the taskbar keeps). It's never
//!   restarted, and its icon cache is never deleted.
//! An update reinstalls the shortcuts, so this runs at every launch while the theme is on.
use std::ffi::OsStr;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Manager};
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, MAX_PATH, WPARAM};
use windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, STGM_READWRITE,
};
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, IShellLinkW, SHChangeNotify, SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT, SHCNE_ASSOCCHANGED,
    SHCNE_UPDATEITEM, SHCNF_FLUSHNOWAIT, SHCNF_IDLIST, SHCNF_PATHW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, LoadImageW, SendMessageW, SetClassLongPtrW, GCLP_HICON, GCLP_HICONSM, ICON_BIG, ICON_SMALL,
    IMAGE_ICON, LR_LOADFROMFILE, SM_CXICON, SM_CXSMICON, WM_SETICON,
};

const NORMAL_ICO: &[u8] = include_bytes!("../icons/icon.ico");
const CHRISTMAS_ICO: &[u8] = include_bytes!("../icons/christmas/icon.ico");
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(Some(0)).collect()
}

fn folder(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?.join("app-icon");
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Whether the Christmas icon was left on (read before the web app loads, so the window starts with it).
pub fn is_on(app: &AppHandle) -> bool {
    folder(app).is_some_and(|d| d.join("christmas").exists())
}

/// Changes everything over. Blocks on the windows' thread and on Explorer: call it off the main thread.
pub fn apply(app: &AppHandle, christmas: bool) {
    let Some(dir) = folder(app) else { return };
    let marker = dir.join("christmas");
    // The normal icon with nothing to undo: the usual launch does no work here.
    if !christmas && !marker.exists() {
        return;
    }
    let ico = dir.join(if christmas { "christmas.ico" } else { "normal.ico" });
    if fs::write(&ico, if christmas { CHRISTMAS_ICO } else { NORMAL_ICO }).is_err() {
        return;
    }
    set_windows(app, &ico);
    let Ok(exe) = std::env::current_exe() else { return };
    // The .exe's own icon, not normal.ico: a shortcut left alone shouldn't depend on a file in the data folder.
    update_shortcuts(&exe, if christmas { &ico } else { &exe });
    if christmas {
        let _ = fs::write(&marker, b"");
    } else {
        let _ = fs::remove_file(&marker);
    }
}

fn set_windows(app: &AppHandle, ico: &Path) {
    let path = wide(ico.as_os_str());
    let load = |size: i32| unsafe {
        LoadImageW(None, PCWSTR(path.as_ptr()), IMAGE_ICON, size, size, LR_LOADFROMFILE).ok()
    };
    let (big, small) = unsafe { (load(GetSystemMetrics(SM_CXICON)), load(GetSystemMetrics(SM_CXSMICON))) };
    for (_, window) in app.webview_windows() {
        let Ok(hwnd) = window.hwnd() else { continue };
        let hwnd = HWND(hwnd.0 as _);
        unsafe {
            if let Some(icon) = big {
                SendMessageW(hwnd, WM_SETICON, Some(WPARAM(ICON_BIG as usize)), Some(LPARAM(icon.0 as isize)));
                SetClassLongPtrW(hwnd, GCLP_HICON, icon.0 as isize);
            }
            if let Some(icon) = small {
                SendMessageW(hwnd, WM_SETICON, Some(WPARAM(ICON_SMALL as usize)), Some(LPARAM(icon.0 as isize)));
                SetClassLongPtrW(hwnd, GCLP_HICONSM, icon.0 as isize);
            }
        }
    }
}

/// .lnk files in a folder, one level of subfolders down (Start menu entries live in a folder of their own).
fn links_in(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 0 {
                links_in(&path, depth - 1, out);
            }
        } else if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk")) {
            out.push(path);
        }
    }
}

fn shortcuts() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        links_in(&appdata.join(r"Microsoft\Windows\Start Menu\Programs"), 1, &mut out);
        links_in(&appdata.join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"), 0, &mut out);
        links_in(&appdata.join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned\StartMenu"), 0, &mut out);
    }
    unsafe {
        // Not %USERPROFILE%\Desktop: OneDrive and folder redirection move it.
        if let Ok(p) = SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DEFAULT, None) {
            if let Ok(desktop) = p.to_string() {
                links_in(Path::new(&desktop), 0, &mut out);
            }
            CoTaskMemFree(Some(p.0 as _));
        }
    }
    out
}

fn same_path(a: &Path, b: &Path) -> bool {
    a.as_os_str().eq_ignore_ascii_case(b.as_os_str())
        || matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

/// Points one shortcut at `icon` if it starts `exe`. Returns whether the file changed.
fn set_link_icon(lnk: &Path, exe: &Path, icon: &Path) -> windows::core::Result<bool> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        let file: IPersistFile = link.cast()?;
        let name = wide(lnk.as_os_str());
        file.Load(PCWSTR(name.as_ptr()), STGM_READWRITE)?;

        let mut buf = [0u16; MAX_PATH as usize];
        let mut find = WIN32_FIND_DATAW::default();
        link.GetPath(&mut buf, &mut find, 0)?;
        if !same_path(&PathBuf::from(from_wide(&buf)), exe) {
            return Ok(false);
        }
        let mut current = [0u16; MAX_PATH as usize];
        let mut index = 0;
        link.GetIconLocation(&mut current, &mut index)?;
        if from_wide(&current).eq_ignore_ascii_case(&icon.to_string_lossy()) {
            return Ok(false);
        }
        let target = wide(icon.as_os_str());
        link.SetIconLocation(PCWSTR(target.as_ptr()), 0)?;
        file.Save(PCWSTR(name.as_ptr()), true)?;
        Ok(true)
    }
}

fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

fn update_shortcuts(exe: &Path, icon: &Path) {
    unsafe {
        let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let mut changed = false;
        for lnk in shortcuts() {
            if matches!(set_link_icon(&lnk, exe, icon), Ok(true)) {
                let path = wide(lnk.as_os_str());
                SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW | SHCNF_FLUSHNOWAIT, Some(path.as_ptr() as _), None);
                changed = true;
            }
        }
        // Only when something changed: this makes Explorer redraw every icon, so it isn't for every launch.
        if changed {
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSHNOWAIT, None, None);
            if let Some(windows) = std::env::var_os("SystemRoot") {
                let _ = Command::new(Path::new(&windows).join(r"System32\ie4uinit.exe"))
                    .arg("-show")
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn();
            }
        }
        if com {
            CoUninitialize();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_link(lnk: &Path, target: &Path) {
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
            let t = wide(target.as_os_str());
            link.SetPath(PCWSTR(t.as_ptr())).unwrap();
            let file: IPersistFile = link.cast().unwrap();
            let name = wide(lnk.as_os_str());
            file.Save(PCWSTR(name.as_ptr()), true).unwrap();
        }
    }

    fn icon_of(lnk: &Path) -> String {
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
            let file: IPersistFile = link.cast().unwrap();
            let name = wide(lnk.as_os_str());
            file.Load(PCWSTR(name.as_ptr()), STGM_READWRITE).unwrap();
            let mut buf = [0u16; MAX_PATH as usize];
            let mut index = 0;
            link.GetIconLocation(&mut buf, &mut index).unwrap();
            from_wide(&buf)
        }
    }

    #[test]
    fn app_icon_only_changes_shortcuts_to_this_exe_and_goes_back() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        let dir = std::env::temp_dir().join(format!("pottira-app-icon-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let exe = std::env::current_exe().unwrap();
        let other = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join(r"System32\notepad.exe");
        let ours = dir.join("ours.lnk");
        let theirs = dir.join("theirs.lnk");
        make_link(&ours, &exe);
        make_link(&theirs, &other);
        let ico = dir.join("christmas.ico");
        fs::write(&ico, CHRISTMAS_ICO).unwrap();

        assert!(set_link_icon(&ours, &exe, &ico).unwrap());
        assert!(icon_of(&ours).eq_ignore_ascii_case(&ico.to_string_lossy()));
        // Already right: nothing to write, so nothing for Explorer to redraw at the next launch.
        assert!(!set_link_icon(&ours, &exe, &ico).unwrap());
        // Someone else's shortcut stays as it was.
        assert!(!set_link_icon(&theirs, &exe, &ico).unwrap());
        assert_eq!(icon_of(&theirs), "");

        assert!(set_link_icon(&ours, &exe, &exe).unwrap());
        assert!(icon_of(&ours).eq_ignore_ascii_case(&exe.to_string_lossy()));
        let _ = fs::remove_dir_all(&dir);
    }
}
