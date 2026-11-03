//! Capture through DXGI Desktop Duplication, the default way of streaming on Windows.
//!
//! Why not Windows Graphics Capture: while any of its sessions is alive, Windows draws the mouse cursor in software
//! for the whole system, even with the session's own cursor capture off (measured on the owner's PC, 2026-11-03, and
//! confirmed in League of Legends: the cursor lags, this path doesn't). Duplication leaves the hardware cursor alone,
//! so the cursor isn't in the image and is drawn into each frame here.
//!
//! Duplication sees a whole monitor, so a window stream is cut out of it and anything on top of that window would be
//! in the stream. So while something covers the window, or it's minimized, the last picture stays up (`window_view`).
//! Don't relax that check: it's what keeps a browser opened over a game out of the stream. Frames are still sent twice
//! a second then, and on a still screen, because viewers drop a stream after 8 s without frames.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::Interface;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Direct3D::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dwm::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::WindowsAndMessaging::*;

/// What's streamed: an HMONITOR or an HWND, as numbers so they can cross threads.
#[derive(Clone, Copy, Debug)]
pub enum Target {
    Screen(usize),
    Window(usize),
}

/// Where frames go, and when.
pub trait Sink: Send + 'static {
    fn stopped(&self) -> bool;
    /// How long until the next frame is wanted.
    fn until_due(&self) -> Duration;
    /// Whether to take a frame now. A true answer books the slot.
    fn due(&mut self) -> bool;
    /// Someone needs a picture even if nothing changed (a viewer's keyframe request).
    fn wants_frame(&self) -> bool;
    /// Hands over a BGRA image of `width` x `height`. `started` is when reading it back began.
    fn send(&mut self, image: &[u8], width: u32, height: u32, stride: usize, started: Instant);
    /// The picture is being held because the window is covered or minimized.
    fn set_paused(&mut self, paused: bool);
}

/// The running capture. Dropping it stops it.
pub struct Duplicated {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Duplicated {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Starts capturing, or says why it can't (the caller falls back to Windows Graphics Capture).
pub fn start(target: Target, sink: impl Sink) -> Result<Duplicated, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let (ready, opened) = sync_channel(1);
    let flag = stop.clone();
    let thread = std::thread::Builder::new()
        .name("linkord-duplication".into())
        .spawn(move || unsafe {
            let output = match Output::open(monitor_of(target)) {
                Ok(o) => {
                    let _ = ready.send(Ok(()));
                    o
                }
                Err(e) => {
                    let _ = ready.send(Err(e));
                    return;
                }
            };
            run(target, output, sink, &flag);
        })
        .map_err(|e| e.to_string())?;
    opened.recv().map_err(|e| e.to_string())??;
    Ok(Duplicated { stop, thread: Some(thread) })
}

/// A still picture is sent again this often: well under the 8 s after which viewers drop a stream, and more than once
/// in each second the app measures (0 frames in one shows a spinner over the picture).
const HEARTBEAT: Duration = Duration::from_millis(500);
/// After a window stops covering ours, its closing animation is still on screen, out of the z-order.
const SETTLE: Duration = Duration::from_millis(300);
const WAIT_MS: u32 = 100;

fn run(target: Target, output: Output, mut sink: impl Sink, stop: &AtomicBool) {
    let mut output = Some(output);
    let mut held = Held::default();
    let mut changed = true;
    let mut settle: Option<Instant> = None;
    let mut paused = false;
    while !stop.load(Ordering::Relaxed) && !sink.stopped() {
        let wait = sink.until_due();
        if wait > Duration::from_millis(2) {
            std::thread::sleep((wait - Duration::from_millis(1)).min(Duration::from_millis(WAIT_MS as u64)));
        }
        unsafe {
            let monitor = monitor_of(target);
            if output.as_ref().is_none_or(|o| o.monitor != monitor) {
                output = None;
                held = Held::default();
                match Output::open(monitor) {
                    Ok(o) => output = Some(o),
                    // The secure desktop, a mode change: try again in a moment.
                    Err(_) => {
                        std::thread::sleep(Duration::from_millis(250));
                        continue;
                    }
                }
                changed = true;
            }
            let out = output.as_mut().unwrap();

            let view = view_of(target, out.bounds);
            let area = match view {
                View::Area(a) => Some(a),
                // The app ends the stream or follows the app when it reads this from the stats.
                View::Closed => {
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                }
                View::Covered | View::Hidden => None,
            };
            let Some(area) = area else {
                if !paused {
                    paused = true;
                    sink.set_paused(true);
                }
                settle = None;
                held.repeat(out, &mut sink);
                std::thread::sleep(Duration::from_millis(50));
                continue;
            };
            if paused {
                paused = false;
                settle = Some(Instant::now() + SETTLE);
            }
            if let Some(until) = settle {
                if Instant::now() < until {
                    held.repeat(out, &mut sink);
                    std::thread::sleep(Duration::from_millis(30));
                    continue;
                }
                settle = None;
                sink.set_paused(false);
                changed = true;
            }

            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource = None;
            match out.duplication.AcquireNextFrame(WAIT_MS, &mut info, &mut resource) {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                    held.repeat(out, &mut sink);
                    continue;
                }
                // The display changed, a game went fullscreen, the desktop switched: start over.
                Err(_) => {
                    output = None;
                    held = Held::default();
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                }
            }
            changed |= out.pointer.update(&out.duplication, &info);
            changed |= info.LastPresentTime != 0;

            // Checked again now that this image exists: a window that came up meanwhile doesn't get sent.
            let area = match target {
                Target::Screen(_) => area,
                Target::Window(_) => match view_of(target, out.bounds) {
                    View::Area(a) => a,
                    _ => {
                        let _ = out.duplication.ReleaseFrame();
                        continue;
                    }
                },
            };
            if !(changed || sink.wants_frame()) || !sink.due() {
                let _ = out.duplication.ReleaseFrame();
                continue;
            }
            let started = Instant::now();
            let copied = resource.and_then(|r| held.copy(out, &r).ok());
            let _ = out.duplication.ReleaseFrame();
            if copied.is_none() {
                continue;
            }
            changed = false;
            held.area = area;
            held.send(out, &mut sink, true, started);
        }
    }
}

/// The last picture read back, kept so it can be sent again.
#[derive(Default)]
struct Held {
    staging: Option<(ID3D11Texture2D, u32, u32)>,
    area: Rect,
    sent: Option<Instant>,
}

impl Held {
    unsafe fn copy(&mut self, out: &Output, resource: &IDXGIResource) -> windows::core::Result<()> {
        let texture: ID3D11Texture2D = resource.cast()?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);
        if self.staging.as_ref().is_none_or(|(_, w, h)| (*w, *h) != (desc.Width, desc.Height)) {
            desc.Usage = D3D11_USAGE_STAGING;
            desc.BindFlags = 0;
            desc.MiscFlags = 0;
            desc.CPUAccessFlags = (D3D11_CPU_ACCESS_READ.0 | D3D11_CPU_ACCESS_WRITE.0) as u32;
            let mut staging = None;
            out.device.CreateTexture2D(&desc, None, Some(&mut staging))?;
            self.staging = Some((staging.unwrap(), desc.Width, desc.Height));
        }
        out.context.CopyResource(&self.staging.as_ref().unwrap().0, &texture);
        Ok(())
    }

    /// Sends the picture again if it's time to, or if a viewer needs one. The cursor is already in it.
    unsafe fn repeat(&mut self, out: &Output, sink: &mut impl Sink) {
        let late = self.sent.is_some_and(|at| at.elapsed() >= HEARTBEAT);
        if self.staging.is_some() && (late || sink.wants_frame()) && sink.due() {
            self.send(out, sink, false, Instant::now());
        }
    }

    unsafe fn send(&mut self, out: &Output, sink: &mut impl Sink, draw_pointer: bool, started: Instant) {
        let Some((staging, width, height)) = &self.staging else { return };
        let mut map = D3D11_MAPPED_SUBRESOURCE::default();
        if out.context.Map(staging, 0, D3D11_MAP_READ_WRITE, 0, Some(&mut map)).is_err() {
            return;
        }
        let stride = map.RowPitch as usize;
        let image = std::slice::from_raw_parts_mut(map.pData as *mut u8, stride * *height as usize);
        if draw_pointer && out.pointer.visible {
            let (x, y) = out.pointer.position;
            blend_pointer(image, stride, (*width as i32, *height as i32), (x, y), &out.pointer.shape());
        }
        let area = self.area;
        // Never past the image: the window moved or the display changed since the area was worked out.
        if area.w > 0 && area.h > 0 && area.x >= 0 && area.y >= 0 && area.x + area.w <= *width as i32 && area.y + area.h <= *height as i32 {
            let start = area.y as usize * stride + area.x as usize * 4;
            sink.send(&image[start..], area.w as u32, area.h as u32, stride, started);
            self.sent = Some(Instant::now());
        }
        out.context.Unmap(staging, 0);
    }
}

/// One monitor being duplicated.
struct Output {
    duplication: IDXGIOutputDuplication,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    monitor: usize,
    /// In desktop coordinates.
    bounds: Rect,
    pointer: Pointer,
}

impl Output {
    unsafe fn open(monitor: usize) -> Result<Output, String> {
        let text = |e: windows::core::Error| e.to_string();
        let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(text)?;
        let mut a = 0;
        while let Ok(adapter) = factory.EnumAdapters1(a) {
            a += 1;
            let mut o = 0;
            while let Ok(output) = adapter.EnumOutputs(o) {
                o += 1;
                let desc = output.GetDesc().map_err(text)?;
                if desc.Monitor.0 as usize != monitor {
                    continue;
                }
                // Frames of a rotated monitor come in the panel's orientation, not the desktop's.
                if !matches!(desc.Rotation, DXGI_MODE_ROTATION_IDENTITY | DXGI_MODE_ROTATION_UNSPECIFIED) {
                    return Err("rotated monitor".into());
                }
                let (mut device, mut context) = (None, None);
                let flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
                D3D11CreateDevice(&adapter, D3D_DRIVER_TYPE_UNKNOWN, HMODULE::default(), flags, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut context)).map_err(text)?;
                let (device, context): (ID3D11Device, ID3D11DeviceContext) = (device.unwrap(), context.unwrap());
                // Asking for 8 bits gets an HDR monitor's picture converted. Windows 10 before 1703 only has the old call.
                let duplication = match output.cast::<IDXGIOutput5>() {
                    Ok(o5) => o5.DuplicateOutput1(&device, 0, &[DXGI_FORMAT_B8G8R8A8_UNORM]),
                    Err(_) => output.cast::<IDXGIOutput1>().map_err(text)?.DuplicateOutput(&device),
                }
                .map_err(text)?;
                if duplication.GetDesc().ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM {
                    return Err("not an 8-bit picture".into());
                }
                let r = desc.DesktopCoordinates;
                let bounds = Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
                return Ok(Output { duplication, device, context, monitor, bounds, pointer: Pointer::default() });
            }
        }
        Err("monitor not found".into())
    }
}

fn monitor_of(target: Target) -> usize {
    match target {
        Target::Screen(monitor) => monitor,
        Target::Window(window) => unsafe { MonitorFromWindow(hwnd(window), MONITOR_DEFAULTTONEAREST).0 as usize },
    }
}

fn hwnd(window: usize) -> HWND {
    HWND(window as *mut std::ffi::c_void)
}

// ---------- the window being streamed ----------

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    fn from_win(r: RECT) -> Rect {
        Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top }
    }

    fn intersect(self, o: Rect) -> Rect {
        let (x, y) = (self.x.max(o.x), self.y.max(o.y));
        let (right, bottom) = ((self.x + self.w).min(o.x + o.w), (self.y + self.h).min(o.y + o.h));
        Rect { x, y, w: (right - x).max(0), h: (bottom - y).max(0) }
    }

    fn is_empty(self) -> bool {
        self.w <= 0 || self.h <= 0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    /// What to send, relative to the monitor.
    Area(Rect),
    /// Something's in front of it.
    Covered,
    /// Minimized, on another virtual desktop, off this monitor.
    Hidden,
    Closed,
}

fn view_of(target: Target, monitor: Rect) -> View {
    match target {
        Target::Screen(_) => View::Area(Rect { x: 0, y: 0, w: monitor.w, h: monitor.h }),
        Target::Window(window) => unsafe { window_view(hwnd(window), monitor) },
    }
}

/// Whether a window can be sent right now, and which part of the monitor it is.
pub unsafe fn window_view(window: HWND, monitor: Rect) -> View {
    if !IsWindow(Some(window)).as_bool() {
        return View::Closed;
    }
    if IsIconic(window).as_bool() || !IsWindowVisible(window).as_bool() || cloaked(window) {
        return View::Hidden;
    }
    let area = bounds(window).intersect(monitor);
    if area.is_empty() {
        return View::Hidden;
    }
    if first_cover(window, area).is_some() {
        return View::Covered;
    }
    View::Area(Rect { x: area.x - monitor.x, y: area.y - monitor.y, ..area })
}

/// The first window above this one that would show up in its area.
pub unsafe fn first_cover(window: HWND, area: Rect) -> Option<HWND> {
    let root = GetAncestor(window, GA_ROOTOWNER);
    let mut above = GetWindow(window, GW_HWNDPREV);
    while let Ok(w) = above {
        if shows_over(w, root, area) {
            return Some(w);
        }
        above = GetWindow(w, GW_HWNDPREV);
    }
    None
}

unsafe fn shows_over(w: HWND, root: HWND, area: Rect) -> bool {
    if !IsWindowVisible(w).as_bool() || IsIconic(w).as_bool() || bounds(w).intersect(area).is_empty() {
        return false;
    }
    // Its own dialogs and popups are part of it. Not everything of its process: another browser window is the same
    // process and may be private.
    if GetAncestor(w, GA_ROOTOWNER) == root {
        return false;
    }
    let ex = GetWindowLongW(w, GWL_EXSTYLE) as u32;
    // Click-through layers (Linkord's own overlay, other programs' overlays) aren't content anyone opened.
    if ex & WS_EX_TRANSPARENT.0 != 0 {
        return false;
    }
    if ex & WS_EX_LAYERED.0 != 0 {
        let (mut alpha, mut flags) = (255u8, LAYERED_WINDOW_ATTRIBUTES_FLAGS(0));
        if GetLayeredWindowAttributes(w, None, Some(&mut alpha), Some(&mut flags)).is_ok() && flags.0 & LWA_ALPHA.0 != 0 && alpha == 0 {
            return false;
        }
    }
    if cloaked(w) {
        return false;
    }
    // Windows keeps these out of duplicated frames anyway.
    let mut affinity = 0;
    if GetWindowDisplayAffinity(w, &mut affinity).is_ok() && affinity == WDA_EXCLUDEFROMCAPTURE.0 {
        return false;
    }
    // Always on top but always there: a window near the bottom of the screen would never be sent.
    let mut class = [0u16; 32];
    let n = GetClassNameW(w, &mut class) as usize;
    let class = String::from_utf16_lossy(&class[..n]);
    !matches!(class.as_str(), "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
}

unsafe fn cloaked(w: HWND) -> bool {
    let mut value = 0u32;
    DwmGetWindowAttribute(w, DWMWA_CLOAKED, &mut value as *mut u32 as *mut _, 4).is_ok() && value != 0
}

/// The visible rectangle: GetWindowRect includes the invisible resize borders.
unsafe fn bounds(w: HWND) -> Rect {
    let mut r = RECT::default();
    let size = std::mem::size_of::<RECT>() as u32;
    if DwmGetWindowAttribute(w, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut _, size).is_err() {
        let _ = GetWindowRect(w, &mut r);
    }
    Rect::from_win(r)
}

// ---------- the cursor ----------

#[derive(Default)]
struct Pointer {
    visible: bool,
    /// The top-left of its shape, relative to the monitor.
    position: (i32, i32),
    data: Vec<u8>,
    info: DXGI_OUTDUPL_POINTER_SHAPE_INFO,
}

impl Pointer {
    /// Reads what the frame says about the cursor. Returns whether it looks any different.
    unsafe fn update(&mut self, duplication: &IDXGIOutputDuplication, frame: &DXGI_OUTDUPL_FRAME_INFO) -> bool {
        let mut changed = false;
        if frame.LastMouseUpdateTime != 0 {
            let visible = frame.PointerPosition.Visible.as_bool();
            let p = frame.PointerPosition.Position;
            changed = visible != self.visible || (visible && (p.x, p.y) != self.position);
            self.visible = visible;
            self.position = (p.x, p.y);
        }
        if frame.PointerShapeBufferSize > 0 {
            self.data.resize(frame.PointerShapeBufferSize as usize, 0);
            let mut needed = 0;
            let read = duplication.GetFramePointerShape(frame.PointerShapeBufferSize, self.data.as_mut_ptr() as *mut _, &mut needed, &mut self.info);
            if read.is_err() {
                self.data.clear();
            }
            changed = true;
        }
        changed
    }

    fn shape(&self) -> Shape<'_> {
        let (info, data) = (&self.info, self.data.as_slice());
        let (width, height, pitch) = (info.Width as usize, info.Height as usize, info.Pitch as usize);
        match DXGI_OUTDUPL_POINTER_SHAPE_TYPE(info.Type as i32) {
            DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR => Shape { kind: ShapeKind::Color, width, height, pitch, data },
            DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR => Shape { kind: ShapeKind::Masked, width, height, pitch, data },
            // Two masks, one over the other.
            DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME => Shape { kind: ShapeKind::Mono, width, height: height / 2, pitch, data },
            _ => Shape { kind: ShapeKind::Color, width: 0, height: 0, pitch: 0, data: &[] },
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ShapeKind {
    /// BGRA with alpha.
    Color,
    /// BGRA where alpha says replace (0) or invert with the colour (255).
    Masked,
    /// 1 bit per pixel: an AND mask, then an XOR mask.
    Mono,
}

pub struct Shape<'a> {
    pub kind: ShapeKind,
    pub width: usize,
    pub height: usize,
    pub pitch: usize,
    pub data: &'a [u8],
}

/// Draws the cursor into a BGRA image, cut off at its edges. A shape that doesn't match its size is left out.
pub fn blend_pointer(image: &mut [u8], stride: usize, size: (i32, i32), at: (i32, i32), shape: &Shape) {
    let needed = match shape.kind {
        ShapeKind::Mono => shape.pitch * shape.height * 2,
        _ => shape.pitch * shape.height,
    };
    let row_bytes = if shape.kind == ShapeKind::Mono { shape.width.div_ceil(8) } else { shape.width * 4 };
    if shape.data.len() < needed || shape.pitch < row_bytes {
        return;
    }
    for row in 0..shape.height {
        let y = at.1 + row as i32;
        if y < 0 || y >= size.1 {
            continue;
        }
        for col in 0..shape.width {
            let x = at.0 + col as i32;
            if x < 0 || x >= size.0 {
                continue;
            }
            let start = y as usize * stride + x as usize * 4;
            let Some(dst) = image.get_mut(start..start + 3) else { continue };
            match shape.kind {
                ShapeKind::Color => {
                    let s = &shape.data[row * shape.pitch + col * 4..][..4];
                    let a = s[3] as u32;
                    for c in 0..3 {
                        dst[c] = ((s[c] as u32 * a + dst[c] as u32 * (255 - a) + 127) / 255) as u8;
                    }
                }
                ShapeKind::Masked => {
                    let s = &shape.data[row * shape.pitch + col * 4..][..4];
                    for c in 0..3 {
                        dst[c] = if s[3] == 0 { s[c] } else { dst[c] ^ s[c] };
                    }
                }
                ShapeKind::Mono => {
                    let bit = 0x80u8 >> (col % 8);
                    let and = shape.data[row * shape.pitch + col / 8] & bit != 0;
                    let xor = shape.data[(row + shape.height) * shape.pitch + col / 8] & bit != 0;
                    for c in dst.iter_mut() {
                        *c = (if and { *c } else { 0 }) ^ (if xor { 0xff } else { 0 });
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(w: usize, h: usize, value: u8) -> Vec<u8> {
        vec![value; w * h * 4]
    }
    fn pixel(img: &[u8], w: usize, x: usize, y: usize) -> &[u8] {
        &img[(y * w + x) * 4..][..3]
    }

    #[test]
    fn colour_cursors_blend_by_their_alpha() {
        let mut img = image(4, 4, 100);
        // Opaque white, half white, then fully transparent.
        let data = [255, 255, 255, 255, 255, 255, 255, 128, 255, 255, 255, 0];
        let shape = Shape { kind: ShapeKind::Color, width: 3, height: 1, pitch: 12, data: &data };
        blend_pointer(&mut img, 16, (4, 4), (0, 1), &shape);
        assert_eq!(pixel(&img, 4, 0, 1), [255, 255, 255]);
        assert_eq!(pixel(&img, 4, 1, 1), [178, 178, 178]);
        assert_eq!(pixel(&img, 4, 2, 1), [100, 100, 100]);
        assert_eq!(pixel(&img, 4, 0, 0), [100, 100, 100], "nothing outside the shape");
    }

    #[test]
    fn cursors_are_cut_at_the_edges_of_the_image() {
        let mut img = image(2, 2, 0);
        let data = [255u8; 16];
        let shape = Shape { kind: ShapeKind::Color, width: 2, height: 2, pitch: 8, data: &data };
        blend_pointer(&mut img, 8, (2, 2), (1, 1), &shape);
        assert_eq!(pixel(&img, 2, 1, 1), [255, 255, 255]);
        assert_eq!(pixel(&img, 2, 0, 0), [0, 0, 0]);
        blend_pointer(&mut img, 8, (2, 2), (-1, -1), &shape);
        assert_eq!(pixel(&img, 2, 0, 0), [255, 255, 255]);
        blend_pointer(&mut img, 8, (2, 2), (500, 500), &shape);
    }

    #[test]
    fn monochrome_cursors_use_both_masks() {
        let mut img = image(4, 1, 0x40);
        // AND 1,1,0,0 then XOR 0,1,0,1: keep, invert, black, white.
        let data = [0b1100_0000u8, 0b0101_0000];
        let shape = Shape { kind: ShapeKind::Mono, width: 4, height: 1, pitch: 1, data: &data };
        blend_pointer(&mut img, 16, (4, 1), (0, 0), &shape);
        assert_eq!(pixel(&img, 4, 0, 0), [0x40; 3]);
        assert_eq!(pixel(&img, 4, 1, 0), [0xbf; 3]);
        assert_eq!(pixel(&img, 4, 2, 0), [0; 3]);
        assert_eq!(pixel(&img, 4, 3, 0), [0xff; 3]);
    }

    #[test]
    fn masked_cursors_replace_or_invert() {
        let mut img = image(2, 1, 0x0f);
        let data = [1, 2, 3, 0, 0xff, 0xff, 0xff, 0xff];
        let shape = Shape { kind: ShapeKind::Masked, width: 2, height: 1, pitch: 8, data: &data };
        blend_pointer(&mut img, 8, (2, 1), (0, 0), &shape);
        assert_eq!(pixel(&img, 2, 0, 0), [1, 2, 3]);
        assert_eq!(pixel(&img, 2, 1, 0), [0xf0; 3]);
    }

    #[test]
    fn a_shape_with_too_little_data_is_left_out() {
        let mut img = image(2, 2, 7);
        let shape = Shape { kind: ShapeKind::Color, width: 2, height: 2, pitch: 8, data: &[255; 4] };
        blend_pointer(&mut img, 8, (2, 2), (0, 0), &shape);
        assert!(img.iter().all(|b| *b == 7));
    }

    #[test]
    fn areas_stay_on_the_monitor() {
        let monitor = Rect { x: -2560, y: 0, w: 2560, h: 1080 };
        let window = Rect { x: -100, y: 100, w: 300, h: 200 };
        assert_eq!(window.intersect(monitor), Rect { x: -100, y: 100, w: 100, h: 200 });
        assert!(Rect { x: 10, y: 10, w: 5, h: 5 }.intersect(monitor).is_empty());
    }
}
