//! The in-game voice overlay (Windows): who's in the call and who's talking, over borderless games.
//!
//! Built so a game can't feel it. Nothing goes into the game's process: no DLL, no Present hook, so no anti-cheat
//! trouble and no work inside the game's frame. It's an ordinary click-through window that never takes focus:
//! - drawn on the CPU (Direct2D software target) into a bitmap Windows keeps, so this process uses no GPU;
//! - drawn only when what it shows changes. Between changes it costs nothing: the thread sleeps in GetMessage;
//! - only as big as its rows, and hidden unless a fullscreen window is in front during a call;
//! - no thread or window until first used, and everything is freed when the call ends.
//!
//! What a visible window costs (measured, RTX 5060, no hardware overlay planes): Windows has to composite it with the
//! game, about 0.1 ms per frame. Showing or hiding it switches the game between that and its direct path, which is a
//! frame of about 30 ms. So it never appears and disappears with who's talking: once up, it stays up at one size for
//! the whole call and silence just draws nothing. Don't "optimize" that into hiding it.
//!
//! Hidden from screen capture, so it doesn't end up in your stream.
//! This file only depends on std, serde and windows, so it can be built alone to measure it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use windows::core::{w, Interface, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HMODULE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_COLOR_F, D2D1_PIXEL_FORMAT, D2D_RECT_F, D2D_SIZE_U,
};
use windows::Win32::Graphics::Direct2D::{
    D2D1CreateFactory, ID2D1Bitmap, ID2D1DCRenderTarget, ID2D1Factory, ID2D1RenderTarget, ID2D1SolidColorBrush,
    D2D1_ANTIALIAS_MODE_PER_PRIMITIVE, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR, D2D1_BITMAP_PROPERTIES,
    D2D1_DRAW_TEXT_OPTIONS_CLIP, D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_FEATURE_LEVEL_DEFAULT,
    D2D1_RENDER_TARGET_PROPERTIES, D2D1_RENDER_TARGET_TYPE_SOFTWARE, D2D1_RENDER_TARGET_USAGE_GDI_COMPATIBLE,
    D2D1_ROUNDED_RECT, D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE,
};
use windows::Win32::Graphics::DirectWrite::{
    DWriteCreateFactory, IDWriteFactory, IDWriteTextFormat, IDWriteTextLayout, DWRITE_FACTORY_TYPE_SHARED,
    DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_WEIGHT_MEDIUM, DWRITE_FONT_WEIGHT_NORMAL,
    DWRITE_PARAGRAPH_ALIGNMENT_CENTER, DWRITE_TEXT_ALIGNMENT_CENTER, DWRITE_TEXT_ALIGNMENT_LEADING,
    DWRITE_TEXT_METRICS, DWRITE_TRIMMING, DWRITE_TRIMMING_GRANULARITY_CHARACTER, DWRITE_WORD_WRAPPING_NO_WRAP,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, GetMonitorInfoW, MonitorFromWindow, ReleaseDC,
    SelectObject, AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS,
    HBITMAP, HDC, HGDIOBJ, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetClassNameW, GetForegroundWindow, GetMessageW, GetWindow,
    GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed, KillTimer, PostMessageW,
    RegisterClassW, SetTimer, SetWindowDisplayAffinity, SetWindowPos, ShowWindow, UpdateLayeredWindow,
    EVENT_SYSTEM_FOREGROUND, GW_HWNDPREV, HWND_TOPMOST, MSG, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE,
    SW_SHOWNOACTIVATE, ULW_ALPHA, WDA_EXCLUDEFROMCAPTURE, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_APP,
    WM_TIMER, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};

// ---------- what the client sends ----------

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Person {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub speaking: bool,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub deafened: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Corner {
    #[default]
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

/// Everything shown. Empty `people` = not in a call (or the overlay is off): everything is freed.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct View {
    pub people: Vec<Person>,
    #[serde(default)]
    pub corner: Corner,
    /// Only rows for people talking right now. The window stays up in silence, empty (see the top of this file).
    #[serde(default)]
    pub only_speaking: bool,
}

/// A row per person up to here, then "+N": it must not cover the game.
const MAX_ROWS: usize = 10;
/// More than a call has; the client decides who's in the list, so it's only a limit on memory.
const MAX_PEOPLE: usize = 99;
const MAX_NAME: usize = 64;
pub const MAX_AVATAR_SIDE: u32 = 128;
const MAX_AVATARS: usize = 128;

/// Which rows to draw, and how many people that left out.
fn visible_rows(view: &View) -> (Vec<&Person>, usize) {
    let shown: Vec<&Person> = view.people.iter().filter(|p| !view.only_speaking || p.speaking).collect();
    let extra = shown.len().saturating_sub(MAX_ROWS);
    (shown.into_iter().take(MAX_ROWS).collect(), extra)
}

/// Keeps what's kept for the client's list within the limits.
fn clean(mut view: View) -> View {
    view.people.truncate(MAX_PEOPLE);
    for p in &mut view.people {
        if p.name.chars().count() > MAX_NAME {
            p.name = p.name.chars().take(MAX_NAME).collect();
        }
    }
    view
}

/// Square RGBA from the client -> premultiplied BGRA with the app's rounded-square corners cut out.
fn avatar_pixels(side: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    if side == 0 || side > MAX_AVATAR_SIDE || rgba.len() != (side * side * 4) as usize {
        return None;
    }
    let radius = side as f32 * 0.25;
    let mut out = Vec::with_capacity(rgba.len());
    for (i, px) in rgba.chunks_exact(4).enumerate() {
        let (x, y) = ((i as u32 % side) as f32 + 0.5, (i as u32 / side) as f32 + 0.5);
        // Distance into the corner circle, with a pixel of soft edge.
        let dx = (radius - x).max(x - (side as f32 - radius)).max(0.0);
        let dy = (radius - y).max(y - (side as f32 - radius)).max(0.0);
        let cover = (radius + 0.5 - (dx * dx + dy * dy).sqrt()).clamp(0.0, 1.0);
        let a = px[3] as f32 / 255.0 * cover;
        out.extend_from_slice(&[
            (px[2] as f32 * a) as u8,
            (px[1] as f32 * a) as u8,
            (px[0] as f32 * a) as u8,
            (a * 255.0) as u8,
        ]);
    }
    Some(out)
}

// ---------- the thread ----------

#[derive(Default)]
struct Shared {
    view: View,
    avatars: HashMap<String, (u32, Vec<u8>)>,
    /// Goes up with every picture received.
    avatars_changed: u64,
}

static SHARED: Mutex<Option<Shared>> = Mutex::new(None);
static STARTED: OnceLock<()> = OnceLock::new();
/// The overlay's window; messages to it wake its thread.
static WINDOW: AtomicIsize = AtomicIsize::new(0);
/// A change the thread hasn't drawn yet (several in a row are drawn once).
static DIRTY: AtomicBool = AtomicBool::new(false);

const WM_CHANGED: u32 = WM_APP + 1;
const WM_FOREGROUND: u32 = WM_APP + 2;
/// Catches what no event reports (a game going fullscreen after it got focus, or raising itself over us).
const CHECK_TIMER: usize = 1;
const CHECK_MS: u32 = 2000;

fn wake(message: u32) {
    let hwnd = WINDOW.load(Ordering::Acquire);
    if hwnd != 0 {
        unsafe {
            let _ = PostMessageW(Some(HWND(hwnd as *mut _)), message, WPARAM(0), LPARAM(0));
        }
    }
}

/// Shows this view. Cheap to call, and starts nothing while there's nobody to show and it never ran.
pub fn update(view: View) {
    let view = clean(view);
    let mut shared = SHARED.lock().unwrap();
    if view.people.is_empty() && STARTED.get().is_none() {
        return;
    }
    let s = shared.get_or_insert_with(Shared::default);
    if view.people.is_empty() {
        s.avatars.clear();
    }
    s.view = view;
    drop(shared);
    STARTED.get_or_init(|| {
        let _ = std::thread::Builder::new().name("overlay".into()).spawn(run);
    });
    if !DIRTY.swap(true, Ordering::AcqRel) {
        wake(WM_CHANGED);
    }
}

/// Keeps someone's picture (a square of RGBA, drawn once by the client).
pub fn set_avatar(id: String, side: u32, rgba: &[u8]) -> Result<(), &'static str> {
    let pixels = avatar_pixels(side, rgba).ok_or("bad avatar")?;
    let mut shared = SHARED.lock().unwrap();
    let s = shared.get_or_insert_with(Shared::default);
    if s.avatars.len() >= MAX_AVATARS && !s.avatars.contains_key(&id) {
        return Err("too many avatars");
    }
    s.avatars.insert(id, (side, pixels));
    s.avatars_changed += 1;
    drop(shared);
    if !DIRTY.swap(true, Ordering::AcqRel) {
        wake(WM_CHANGED);
    }
    Ok(())
}

unsafe extern "system" fn on_foreground(_: HWINEVENTHOOK, _: u32, _: HWND, _: i32, _: i32, _: u32, _: u32) {
    wake(WM_FOREGROUND);
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    DefWindowProcW(hwnd, msg, w, l)
}

fn run() {
    let Ok(hwnd) = create_window() else { return };
    WINDOW.store(hwnd.0 as isize, Ordering::Release);
    let mut overlay = Overlay::new(hwnd);
    // In case update() ran before the window existed.
    overlay.changed();
    let mut msg = MSG::default();
    unsafe {
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            match msg.message {
                WM_CHANGED => overlay.changed(),
                WM_FOREGROUND => overlay.refresh(),
                WM_TIMER if msg.wParam.0 == CHECK_TIMER => overlay.refresh(),
                _ => {
                    DispatchMessageW(&msg);
                }
            }
        }
    }
}

fn create_window() -> windows::core::Result<HWND> {
    unsafe {
        let instance: HMODULE = GetModuleHandleW(None)?;
        let class = w!("PottiraOverlay");
        let wc = WNDCLASSW { lpfnWndProc: Some(window_proc), hInstance: instance.into(), lpszClassName: class, ..Default::default() };
        RegisterClassW(&wc);
        // Layered + transparent: clicks go through to the game. Noactivate: it never takes focus, which is what would
        // knock a game out of fullscreen. Toolwindow: not in the taskbar or Alt+Tab.
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            class,
            PCWSTR::null(),
            WS_POPUP,
            0,
            0,
            1,
            1,
            None,
            None,
            Some(instance.into()),
            None,
        )?;
        // Keeps it out of your stream. Older Windows may refuse; then a full-screen share would show it.
        let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
        Ok(hwnd)
    }
}

// ---------- where it goes ----------

#[derive(Clone, Copy, PartialEq, Debug)]
struct Screen {
    monitor: isize,
    rect: (i32, i32, i32, i32),
    dpi: u32,
}

fn is_desktop_class(hwnd: HWND) -> bool {
    let mut buf = [0u16; 32];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) } as usize;
    let name = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
    matches!(name.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "XamlExplorerHostIslandWindow")
}

/// The screen this window fills, if it's one that does: a game, or anything else fullscreen.
/// A maximized window doesn't count, nor do the desktop and Pottira.
fn fullscreen_on(hwnd: HWND) -> Option<Screen> {
    unsafe {
        if hwnd.is_invalid() || !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() || IsZoomed(hwnd).as_bool() {
            return None;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == std::process::id() || is_desktop_class(hwnd) {
            return None;
        }
        let mut r = RECT::default();
        GetWindowRect(hwnd, &mut r).ok()?;
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        GetMonitorInfoW(monitor, &mut info).ok().ok()?;
        let m = info.rcMonitor;
        if r.left > m.left || r.top > m.top || r.right < m.right || r.bottom < m.bottom {
            return None;
        }
        let dpi = GetDpiForWindow(hwnd);
        Some(Screen { monitor: monitor.0 as isize, rect: (m.left, m.top, m.right, m.bottom), dpi: if dpi == 0 { 96 } else { dpi } })
    }
}

fn monitor_of(hwnd: HWND) -> HMONITOR {
    unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) }
}

/// Pure placement: the top-left corner for a window this big, in this corner of the screen.
fn place(screen: (i32, i32, i32, i32), size: (i32, i32), corner: Corner, margin: i32) -> (i32, i32) {
    let (l, t, r, b) = screen;
    let x = match corner {
        Corner::TopLeft | Corner::BottomLeft => l + margin,
        Corner::TopRight | Corner::BottomRight => r - margin - size.0,
    };
    let y = match corner {
        Corner::TopLeft | Corner::TopRight => t + margin,
        Corner::BottomLeft | Corner::BottomRight => b - margin - size.1,
    };
    (x, y)
}

// ---------- drawing ----------

struct Bitmap {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    size: (i32, i32),
    #[cfg(test)]
    bits: *const u8,
}

impl Bitmap {
    fn new(size: (i32, i32)) -> Option<Bitmap> {
        unsafe {
            let screen = GetDC(None);
            let dc = CreateCompatibleDC(Some(screen));
            ReleaseDC(None, screen);
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: size.0,
                    biHeight: -size.1,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits = std::ptr::null_mut();
            let Ok(bitmap) = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) else {
                let _ = DeleteDC(dc);
                return None;
            };
            let previous = SelectObject(dc, bitmap.into());
            Some(Bitmap {
                dc,
                bitmap,
                previous,
                size,
                #[cfg(test)]
                bits: bits as *const u8,
            })
        }
    }
}

impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

fn color(hex: u32, alpha: f32) -> D2D1_COLOR_F {
    D2D1_COLOR_F {
        r: ((hex >> 16) & 255) as f32 / 255.0,
        g: ((hex >> 8) & 255) as f32 / 255.0,
        b: (hex & 255) as f32 / 255.0,
        a: alpha,
    }
}

fn rect(x: f32, y: f32, w: f32, h: f32) -> D2D_RECT_F {
    D2D_RECT_F { left: x, top: y, right: x + w, bottom: y + h }
}

fn rounded(r: D2D_RECT_F, radius: f32) -> D2D1_ROUNDED_RECT {
    D2D1_ROUNDED_RECT { rect: r, radiusX: radius, radiusY: radius }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

// In logical pixels, at 100% display scale.
const ROW_H: f32 = 34.0;
const ROW_GAP: f32 = 4.0;
const AVATAR: f32 = 26.0;
const PAD: f32 = 4.0;
const TEXT_GAP: f32 = 8.0;
const NAME_MAX: f32 = 170.0;
const ICON: f32 = 18.0;
const FONT: f32 = 13.0;
const MARGIN: f32 = 16.0;

// The app's colors (styles.css, dark theme).
const PANEL: u32 = 0x18181b;
const PANEL_ALPHA: f32 = 0.82;
const TILE: u32 = 0x3f3f46;
const TEXT: u32 = 0xf4f4f5;
const TEXT_QUIET: u32 = 0xa1a1aa;
const SPEAKING: u32 = 0x3ba55d;
const DANGER: u32 = 0xe5484d;

/// Segoe MDL2 Assets, on every Windows 10 and 11.
const GLYPH_MIC_OFF: &str = "\u{EC54}";
const GLYPH_DEAFENED: &str = "\u{E74F}";

struct Painter {
    target: ID2D1DCRenderTarget,
    write: IDWriteFactory,
    name: IDWriteTextFormat,
    letter: IDWriteTextFormat,
    glyph: IDWriteTextFormat,
    /// Made for the target, kept until a picture changes.
    avatars: HashMap<String, ID2D1Bitmap>,
    scale: f32,
}

struct Row<'a> {
    person: &'a Person,
    name: IDWriteTextLayout,
    width: f32,
}

fn text_format(write: &IDWriteFactory, family: PCWSTR, medium: bool, size: f32, center: bool) -> windows::core::Result<IDWriteTextFormat> {
    unsafe {
        let weight = if medium { DWRITE_FONT_WEIGHT_MEDIUM } else { DWRITE_FONT_WEIGHT_NORMAL };
        let f = write.CreateTextFormat(family, None, weight, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_STRETCH_NORMAL, size, w!("en-us"))?;
        f.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP)?;
        f.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER)?;
        f.SetTextAlignment(if center { DWRITE_TEXT_ALIGNMENT_CENTER } else { DWRITE_TEXT_ALIGNMENT_LEADING })?;
        Ok(f)
    }
}

impl Painter {
    fn new(scale: f32) -> windows::core::Result<Painter> {
        unsafe {
            // Software on purpose: this process never touches the GPU the game is using.
            let factory: ID2D1Factory = D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)?;
            let props = D2D1_RENDER_TARGET_PROPERTIES {
                r#type: D2D1_RENDER_TARGET_TYPE_SOFTWARE,
                pixelFormat: D2D1_PIXEL_FORMAT { format: DXGI_FORMAT_B8G8R8A8_UNORM, alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED },
                dpiX: 96.0,
                dpiY: 96.0,
                usage: D2D1_RENDER_TARGET_USAGE_GDI_COMPATIBLE,
                minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
            };
            let target = factory.CreateDCRenderTarget(&props)?;
            target.SetAntialiasMode(D2D1_ANTIALIAS_MODE_PER_PRIMITIVE);
            // ClearType needs an opaque background; this one is see-through.
            target.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);
            let write: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
            let name = text_format(&write, w!("Segoe UI"), true, FONT * scale, false)?;
            let ellipsis = write.CreateEllipsisTrimmingSign(&name)?;
            let trimming = DWRITE_TRIMMING { granularity: DWRITE_TRIMMING_GRANULARITY_CHARACTER, delimiter: 0, delimiterCount: 0 };
            name.SetTrimming(&trimming, &ellipsis)?;
            let letter = text_format(&write, w!("Segoe UI"), true, 11.0 * scale, true)?;
            let glyph = text_format(&write, w!("Segoe MDL2 Assets"), false, 13.0 * scale, true)?;
            Ok(Painter { target, write, name, letter, glyph, avatars: HashMap::new(), scale })
        }
    }

    fn brush(&self, hex: u32, alpha: f32) -> windows::core::Result<ID2D1SolidColorBrush> {
        unsafe { self.target.CreateSolidColorBrush(&color(hex, alpha), None) }
    }

    fn rows<'a>(&self, people: &[&'a Person]) -> Vec<Row<'a>> {
        let s = self.scale;
        let mut rows = Vec::with_capacity(people.len());
        for &person in people {
            let text = wide(&person.name);
            let layout = unsafe { self.write.CreateTextLayout(&text, &self.name, NAME_MAX * s, ROW_H * s) };
            let Ok(name) = layout else { continue };
            let mut m = DWRITE_TEXT_METRICS::default();
            let text_w = unsafe { name.GetMetrics(&mut m) }.map(|_| m.widthIncludingTrailingWhitespace).unwrap_or(NAME_MAX * s);
            let icon = if person.muted || person.deafened { ICON * s } else { 0.0 };
            let width = (PAD + AVATAR + TEXT_GAP) * s + text_w.ceil().min(NAME_MAX * s) + icon + 10.0 * s;
            rows.push(Row { person, name, width });
        }
        rows
    }

    fn avatar(&mut self, id: &str, avatars: &HashMap<String, (u32, Vec<u8>)>) -> Option<ID2D1Bitmap> {
        let (side, pixels) = avatars.get(id)?;
        if let Some(b) = self.avatars.get(id) {
            return Some(b.clone());
        }
        let props = D2D1_BITMAP_PROPERTIES {
            pixelFormat: D2D1_PIXEL_FORMAT { format: DXGI_FORMAT_B8G8R8A8_UNORM, alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED },
            dpiX: 96.0,
            dpiY: 96.0,
        };
        let size = D2D_SIZE_U { width: *side, height: *side };
        let bitmap = unsafe { self.target.CreateBitmap(size, Some(pixels.as_ptr() as *const _), side * 4, &props) }.ok()?;
        self.avatars.insert(id.to_string(), bitmap.clone());
        Some(bitmap)
    }

    /// Draws the rows into `bitmap`, on the side of `corner`.
    fn paint(&mut self, bitmap: &Bitmap, rows: &[Row], extra: usize, corner: Corner, avatars: &HashMap<String, (u32, Vec<u8>)>) -> windows::core::Result<()> {
        let s = self.scale;
        let right = matches!(corner, Corner::TopRight | Corner::BottomRight);
        let full = RECT { left: 0, top: 0, right: bitmap.size.0, bottom: bitmap.size.1 };
        unsafe {
            self.target.BindDC(bitmap.dc, &full)?;
            self.target.BeginDraw();
            self.target.Clear(Some(&color(0, 0.0)));
            let panel = self.brush(PANEL, PANEL_ALPHA)?;
            let tile = self.brush(TILE, 1.0)?;
            let text = self.brush(TEXT, 1.0)?;
            let quiet = self.brush(TEXT_QUIET, 1.0)?;
            let speaking = self.brush(SPEAKING, 1.0)?;
            let danger = self.brush(DANGER, 1.0)?;
            let target: ID2D1RenderTarget = self.target.cast()?;
            let bottom = matches!(corner, Corner::BottomLeft | Corner::BottomRight);
            let mut y = if bottom { (bitmap.size.1 as f32 - 1.0 - content_height(rows.len(), extra, s)).max(0.0) } else { 0.0 };
            for row in rows {
                let x = if right { bitmap.size.0 as f32 - row.width } else { 0.0 };
                target.FillRoundedRectangle(&rounded(rect(x, y, row.width, ROW_H * s), 9.0 * s), &panel);
                let av = rect(x + PAD * s, y + (ROW_H - AVATAR) / 2.0 * s, AVATAR * s, AVATAR * s);
                match self.avatar(&row.person.id, avatars) {
                    Some(b) => target.DrawBitmap(&b, Some(&av), 1.0, D2D1_BITMAP_INTERPOLATION_MODE_LINEAR, None),
                    None => {
                        target.FillRoundedRectangle(&rounded(av, AVATAR * 0.25 * s), &tile);
                        let first: String = row.person.name.chars().take(1).flat_map(char::to_uppercase).collect();
                        target.DrawText(&wide(&first), &self.letter, &av, &text, D2D1_DRAW_TEXT_OPTIONS_CLIP, Default::default());
                    }
                }
                if row.person.speaking {
                    // The same green ring as in the app.
                    let ring = rect(av.left - 1.0 * s, av.top - 1.0 * s, (AVATAR + 2.0) * s, (AVATAR + 2.0) * s);
                    target.DrawRoundedRectangle(&rounded(ring, (AVATAR * 0.25 + 1.0) * s), &speaking, 2.0 * s, None);
                }
                let name_at = windows_numerics::Vector2 { X: x + (PAD + AVATAR + TEXT_GAP) * s, Y: y };
                target.DrawTextLayout(name_at, &row.name, if row.person.speaking { &text } else { &quiet }, D2D1_DRAW_TEXT_OPTIONS_CLIP);
                if row.person.muted || row.person.deafened {
                    let glyph = if row.person.deafened { GLYPH_DEAFENED } else { GLYPH_MIC_OFF };
                    let at = rect(x + row.width - (ICON + 6.0) * s, y, ICON * s, ROW_H * s);
                    target.DrawText(&wide(glyph), &self.glyph, &at, &danger, D2D1_DRAW_TEXT_OPTIONS_CLIP, Default::default());
                }
                y += (ROW_H + ROW_GAP) * s;
            }
            if extra > 0 {
                let w = 44.0 * s;
                let x = if right { bitmap.size.0 as f32 - w } else { 0.0 };
                let more = rect(x, y, w, ROW_H * 0.7 * s);
                target.FillRoundedRectangle(&rounded(more, 7.0 * s), &panel);
                target.DrawText(&wide(&format!("+{extra}")), &self.letter, &more, &quiet, D2D1_DRAW_TEXT_OPTIONS_CLIP, Default::default());
            }
            self.target.EndDraw(None, None)
        }
    }
}

/// How tall these rows are together.
fn content_height(rows: usize, extra: usize, scale: f32) -> f32 {
    let height = rows as f32 * (ROW_H + ROW_GAP) * scale + if extra > 0 { ROW_H * 0.7 * scale + ROW_GAP * scale } else { -ROW_GAP * scale };
    height.max(0.0)
}

/// Size of the window for these rows. Leaves room for a mute icon on every row, so muting doesn't resize it.
fn window_size(rows: &[Row], extra: usize, scale: f32) -> (i32, i32) {
    let room = |r: &Row| r.width + if r.person.muted || r.person.deafened { 0.0 } else { ICON * scale };
    let widest = rows.iter().map(room).fold(0.0, f32::max).max(if extra > 0 { 44.0 * scale } else { 0.0 });
    (widest.ceil() as i32 + 1, content_height(rows.len(), extra, scale).ceil().max(1.0) as i32 + 1)
}

// ---------- the window's life ----------

struct Overlay {
    hwnd: HWND,
    hook: Option<HWINEVENTHOOK>,
    timer: bool,
    painter: Option<Painter>,
    bitmap: Option<Bitmap>,
    /// Last game seen in front: it stays shown when focus moves to another screen.
    game: HWND,
    /// What's on the window now (view, screen, pictures), so nothing is redrawn for nothing.
    drawn: Option<(View, Screen, u64)>,
    shown: bool,
}

impl Overlay {
    fn new(hwnd: HWND) -> Overlay {
        Overlay { hwnd, hook: None, timer: false, painter: None, bitmap: None, game: HWND::default(), drawn: None, shown: false }
    }

    /// The client sent something.
    fn changed(&mut self) {
        DIRTY.store(false, Ordering::Release);
        self.refresh();
    }

    /// Which screen's game to draw on, if any.
    fn target(&mut self) -> Option<Screen> {
        let front = unsafe { GetForegroundWindow() };
        if let Some(screen) = fullscreen_on(front) {
            self.game = front;
            return Some(screen);
        }
        // Looking at another screen (the chat, a browser): the game is still there, on its own.
        if !self.game.is_invalid() {
            if let Some(screen) = fullscreen_on(self.game) {
                if front.is_invalid() || monitor_of(front) != monitor_of(self.game) {
                    return Some(screen);
                }
            }
        }
        self.game = HWND::default();
        None
    }

    /// Follows the call: nothing is watched between calls.
    fn watch(&mut self, on: bool) {
        unsafe {
            if on && self.hook.is_none() {
                let hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, Some(on_foreground), 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
                self.hook = (!hook.is_invalid()).then_some(hook);
            }
            if !on {
                if let Some(hook) = self.hook.take() {
                    let _ = UnhookWinEvent(hook);
                }
            }
            if on != self.timer {
                self.timer = on;
                if on {
                    SetTimer(Some(self.hwnd), CHECK_TIMER, CHECK_MS, None);
                } else {
                    let _ = KillTimer(Some(self.hwnd), CHECK_TIMER);
                }
            }
        }
    }

    fn hide(&mut self) {
        if self.shown {
            self.shown = false;
            unsafe {
                let _ = ShowWindow(self.hwnd, SW_HIDE);
            }
        }
        self.drawn = None;
    }

    /// Windows that came up after ours and are topmost too go over it: only raised if the game actually did.
    fn keep_on_top(&self) {
        unsafe {
            let mut w = self.hwnd;
            for _ in 0..256 {
                let Ok(above) = GetWindow(w, GW_HWNDPREV) else { return };
                if above == self.game {
                    let _ = SetWindowPos(self.hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
                    return;
                }
                w = above;
            }
        }
    }

    /// Everything that decides what's on screen. Does nothing when nothing changed, which is nearly always.
    fn refresh(&mut self) {
        let (view, pictures) = {
            let shared = SHARED.lock().unwrap();
            let Some(s) = shared.as_ref() else { return };
            if s.view.people.is_empty() {
                drop(shared);
                self.release();
                return;
            }
            (s.view.clone(), s.avatars_changed)
        };
        self.watch(true);
        let Some(screen) = self.target() else { return self.hide() };
        let (people, extra) = visible_rows(&view);
        self.keep_on_top();
        if let Some((v, sc, p)) = &self.drawn {
            if *v == view && *sc == screen && *p == pictures {
                return;
            }
            if *p != pictures {
                if let Some(painter) = &mut self.painter {
                    painter.avatars.clear();
                }
            }
        }
        if self.draw(&view, &people, extra, screen).is_err() {
            // Start over on the next change.
            self.painter = None;
            self.bitmap = None;
            self.drawn = None;
            return self.hide();
        }
        self.drawn = Some((view.clone(), screen, pictures));
    }

    fn draw(&mut self, view: &View, people: &[&Person], extra: usize, screen: Screen) -> windows::core::Result<()> {
        let scale = screen.dpi as f32 / 96.0;
        if self.painter.as_ref().map(|p| p.scale) != Some(scale) {
            self.painter = Some(Painter::new(scale)?);
            self.bitmap = None;
        }
        let painter = self.painter.as_mut().unwrap();
        // Sized for everyone in the call, whoever is drawn right now: resizing isn't free either.
        let everyone: Vec<&Person> = view.people.iter().take(MAX_ROWS).collect();
        let size = window_size(&painter.rows(&everyone), usize::from(view.people.len() > MAX_ROWS), scale);
        let rows = painter.rows(people);
        if self.bitmap.as_ref().map(|b| b.size) != Some(size) {
            self.bitmap = Bitmap::new(size);
        }
        let Some(bitmap) = self.bitmap.as_ref() else { return Err(windows::core::Error::empty()) };
        {
            let shared = SHARED.lock().unwrap();
            let empty = HashMap::new();
            let avatars = shared.as_ref().map(|s| &s.avatars).unwrap_or(&empty);
            painter.paint(bitmap, &rows, extra, view.corner, avatars)?;
        }
        let (x, y) = place(screen.rect, size, view.corner, (MARGIN * scale) as i32);
        let at = POINT { x, y };
        let dims = SIZE { cx: size.0, cy: size.1 };
        let from = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA as u8 };
        unsafe {
            UpdateLayeredWindow(self.hwnd, None, Some(&at), Some(&dims), Some(bitmap.dc), Some(&from), COLORREF(0), Some(&blend), ULW_ALPHA)?;
            if !self.shown {
                self.shown = true;
                let _ = ShowWindow(self.hwnd, SW_SHOWNOACTIVATE);
                let _ = SetWindowPos(self.hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
            }
        }
        Ok(())
    }

    /// The call ended: the thread sleeps until the next one, holding nothing.
    fn release(&mut self) {
        self.hide();
        self.watch(false);
        self.painter = None;
        self.bitmap = None;
        self.game = HWND::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn person(id: &str, speaking: bool) -> Person {
        Person { id: id.into(), name: id.into(), speaking, ..Default::default() }
    }

    #[test]
    fn only_speaking_shows_nobody_in_silence() {
        let view = View { people: vec![person("a", false), person("b", false)], only_speaking: true, ..Default::default() };
        let (rows, extra) = visible_rows(&view);
        assert!(rows.is_empty());
        assert_eq!(extra, 0);
    }

    #[test]
    fn only_speaking_keeps_the_speakers() {
        let view = View { people: vec![person("a", false), person("b", true)], only_speaking: true, ..Default::default() };
        let (rows, _) = visible_rows(&view);
        assert_eq!(rows.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["b"]);
    }

    #[test]
    fn long_lists_stop_at_a_count() {
        let people = (0..14).map(|i| person(&i.to_string(), false)).collect();
        let view = View { people, ..Default::default() };
        let (rows, extra) = visible_rows(&view);
        assert_eq!((rows.len(), extra), (MAX_ROWS, 4));
    }

    #[test]
    fn corners() {
        let screen = (0, 0, 1920, 1080);
        assert_eq!(place(screen, (200, 100), Corner::TopLeft, 16), (16, 16));
        assert_eq!(place(screen, (200, 100), Corner::TopRight, 16), (1704, 16));
        assert_eq!(place(screen, (200, 100), Corner::BottomLeft, 16), (16, 964));
        assert_eq!(place(screen, (200, 100), Corner::BottomRight, 16), (1704, 964));
    }

    #[test]
    fn corners_on_a_screen_left_of_the_main_one() {
        assert_eq!(place((-2560, 0, 0, 1080), (200, 100), Corner::TopLeft, 16), (-2544, 16));
    }

    #[test]
    fn avatars_must_be_what_they_claim() {
        assert!(avatar_pixels(2, &[0; 16]).is_some());
        assert!(avatar_pixels(2, &[0; 15]).is_none());
        assert!(avatar_pixels(0, &[]).is_none());
        assert!(avatar_pixels(MAX_AVATAR_SIDE + 1, &vec![0; ((MAX_AVATAR_SIDE + 1).pow(2) * 4) as usize]).is_none());
    }

    #[test]
    fn avatar_corners_are_cut_and_pixels_premultiplied() {
        let side = 32u32;
        let rgba: Vec<u8> = [10u8, 20, 30, 255].repeat((side * side) as usize);
        let out = avatar_pixels(side, &rgba).unwrap();
        assert_eq!(out[3], 0, "corner is see-through");
        let middle = ((side / 2 * side + side / 2) * 4) as usize;
        assert_eq!(&out[middle..middle + 4], &[30, 20, 10, 255], "BGRA, opaque in the middle");
    }

    /// Really draws (Direct2D and DirectWrite on the CPU, no window). LINKORD_OVERLAY_DUMP=<file> saves the pixels as
    /// a 32-bit BMP to look at.
    #[test]
    fn draws_rows_on_a_see_through_background() {
        let ann = person("Ann", true);
        let mut bob = person("Bob with quite a long name that has to be cut off by the row", false);
        bob.muted = true;
        let mut cid = person("Çida 日本語", false);
        cid.deafened = true;
        let people = [&ann, &bob, &cid];
        let mut avatars = HashMap::new();
        avatars.insert("Ann".to_string(), (32u32, avatar_pixels(32, &[200u8, 120, 40, 255].repeat(32 * 32)).unwrap()));

        for (corner, name) in [(Corner::TopLeft, ""), (Corner::BottomRight, "-right")] {
            let mut painter = Painter::new(1.0).unwrap();
            let rows = painter.rows(&people);
            let size = window_size(&rows, 2, 1.0);
            assert!(size.0 <= ((PAD + AVATAR + TEXT_GAP + NAME_MAX + ICON + 10.0) as i32) + 2, "names are capped: {size:?}");
            let bitmap = Bitmap::new(size).unwrap();
            painter.paint(&bitmap, &rows, 2, corner, &avatars).unwrap();
            let bytes = unsafe { std::slice::from_raw_parts(bitmap.bits, (size.0 * size.1 * 4) as usize) };
            let alpha = |x: i32, y: i32| bytes[((y * size.0 + x) * 4 + 3) as usize];
            // Ann's row is the short one: the far side of the window beside it stays empty.
            let (near, far) = if corner == Corner::TopLeft { (2, size.0 - 2) } else { (size.0 - 3, 1) };
            assert!(alpha(near, ROW_H as i32 / 2) > 100, "the first row's panel is drawn");
            assert_eq!(alpha(near, (ROW_H + ROW_GAP / 2.0) as i32), 0, "the gap between rows is see-through");
            assert_eq!(alpha(far, ROW_H as i32 / 2), 0, "a short row leaves the rest of the window see-through");
            if let Ok(path) = std::env::var("LINKORD_OVERLAY_DUMP") {
                let mut file = Vec::new();
                let image = (size.0 * size.1 * 4) as u32;
                file.extend_from_slice(b"BM");
                file.extend_from_slice(&(54 + image).to_le_bytes());
                file.extend_from_slice(&[0; 4]);
                file.extend_from_slice(&54u32.to_le_bytes());
                file.extend_from_slice(&40u32.to_le_bytes());
                file.extend_from_slice(&size.0.to_le_bytes());
                file.extend_from_slice(&(-size.1).to_le_bytes());
                file.extend_from_slice(&1u16.to_le_bytes());
                file.extend_from_slice(&32u16.to_le_bytes());
                file.extend_from_slice(&[0; 24]);
                file.extend_from_slice(bytes);
                std::fs::write(format!("{path}{name}.bmp"), file).unwrap();
            }
        }
    }

    /// Silence doesn't hide the window (a hitch in the game), it draws nothing; and rows sit against their corner.
    #[test]
    fn silence_is_an_empty_picture_at_the_same_size() {
        let ann = person("Ann", false);
        let bob = person("Bob", true);
        let everyone = [&ann, &bob];
        let mut painter = Painter::new(1.0).unwrap();
        let size = window_size(&painter.rows(&everyone), 0, 1.0);
        let bitmap = Bitmap::new(size).unwrap();
        let bytes = unsafe { std::slice::from_raw_parts(bitmap.bits, (size.0 * size.1 * 4) as usize) };
        let alpha = |x: i32, y: i32| bytes[((y * size.0 + x) * 4 + 3) as usize];

        painter.paint(&bitmap, &[], 0, Corner::TopLeft, &HashMap::new()).unwrap();
        assert!(bytes.iter().all(|b| *b == 0), "nothing at all is drawn");

        let speakers = painter.rows(&[&bob]);
        painter.paint(&bitmap, &speakers, 0, Corner::BottomLeft, &HashMap::new()).unwrap();
        assert_eq!(alpha(2, 10), 0, "the top is left empty");
        assert!(alpha(2, size.1 - 1 - ROW_H as i32 / 2) > 100, "the one row sits at the bottom");
    }

    #[test]
    fn muting_does_not_resize_the_window() {
        let ann = person("Ann", false);
        let mut muted = ann.clone();
        muted.muted = true;
        let painter = Painter::new(1.0).unwrap();
        assert_eq!(window_size(&painter.rows(&[&ann]), 0, 1.0), window_size(&painter.rows(&[&muted]), 0, 1.0));
    }

    #[test]
    fn names_are_cut_by_characters() {
        let view = clean(View { people: vec![Person { name: "é".repeat(100), ..Default::default() }], ..Default::default() });
        assert_eq!(view.people[0].name.chars().count(), MAX_NAME);
    }
}
