//! Capture through DXGI Desktop Duplication, the default way of streaming and the only way REC records on Windows.
//!
//! Why not Windows Graphics Capture: while any of its sessions is alive, Windows draws the mouse cursor in software
//! for the whole system, even with the session's own cursor capture off (measured on the owner's PC, 2026-11-03, and
//! confirmed in League of Legends: the cursor lags, this path doesn't). Duplication leaves the hardware cursor alone,
//! so the cursor isn't in the image and is drawn into each frame (here for streams, on the GPU for REC).
//!
//! Duplication sees a whole monitor, so a window stream is cut out of it and anything on top of that window would be
//! in the stream. So while something covers the window, or it's minimized, the last picture stays up (`window_view`).
//! Don't relax that check: it's what keeps a browser opened over a game out of the stream (and out of recordings).
//! Frames are still sent twice a second then, and on a still screen, because viewers drop a stream after 8 s without
//! frames.
//!
//! One process can duplicate a monitor only once, and a stream and REC often want the same one. So there's one capture
//! thread (the hub) with one duplication per monitor in use, and any number of subscribers: CPU ones (`Sink`, streams:
//! a BGRA image read back) and GPU ones (`GpuSink`, REC: the frame's texture, never read back). The thread exists only
//! while someone subscribes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, sync_channel, Receiver, Sender, SyncSender};
use std::sync::{Arc, Mutex};
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

/// What's captured: an HMONITOR or an HWND, as numbers so they can cross threads.
#[derive(Clone, Copy, Debug)]
pub enum Target {
    Screen(usize),
    Window(usize),
}

/// Where frames go as BGRA images (streams), and when.
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

/// Where frames go as GPU textures (REC). Called on the capture thread; nothing here may block.
pub trait GpuSink: Send + 'static {
    fn stopped(&self) -> bool;
    fn until_due(&self) -> Duration;
    /// Whether to take this frame. A true answer books the slot.
    fn due(&mut self) -> bool;
    /// A new picture. The texture is only valid during the call: copy what's needed (GPU commands, no waiting).
    fn frame(&mut self, frame: &GpuFrame);
    /// The window is covered or minimized: no frames come until it's back (the recording holds its last picture).
    fn set_paused(&mut self, paused: bool);
}

/// One duplicated frame for a GPU subscriber.
pub struct GpuFrame<'a> {
    pub device: &'a ID3D11Device,
    pub context: &'a ID3D11DeviceContext,
    /// Changes whenever the monitor is opened again (new device): whatever was made on the old one must be dropped.
    pub generation: u64,
    /// The whole monitor, BGRA.
    pub texture: &'a ID3D11Texture2D,
    pub width: u32,
    pub height: u32,
    /// The part being captured, relative to the monitor.
    pub area: Rect,
    /// The cursor, when it's visible.
    pub pointer: Option<PointerFrame<'a>>,
    pub at: Instant,
}

pub struct PointerFrame<'a> {
    /// Top-left of the shape, relative to the monitor.
    pub position: (i32, i32),
    pub shape: Shape<'a>,
    /// Changes whenever the shape does, so a sink can keep its own copy until then.
    pub shape_id: u64,
}

/// A subscription. Dropping it ends it, and returns once the capture thread has let go of the sink.
pub struct Duplicated {
    stop: Arc<AtomicBool>,
    gone: Option<Receiver<()>>,
}

impl Drop for Duplicated {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(gone) = self.gone.take() {
            // Disconnected (Err) once the hub dropped the entry, or if the thread is gone.
            let _ = gone.recv();
        }
    }
}

/// Starts sending BGRA frames of `target` to `sink`, or says why it can't (streams then fall back to Graphics Capture).
pub fn start(target: Target, sink: impl Sink) -> Result<Duplicated, String> {
    subscribe(target, Kind::Cpu { sink: Box::new(sink), held: Held::default() })
}

/// Starts sending `target`'s frames as GPU textures to `sink` (REC). A window in front (the game being played) is
/// recorded even with something small over it (a notification); covered by another app in front, it's held.
pub fn start_gpu(target: Target, sink: impl GpuSink) -> Result<Duplicated, String> {
    subscribe(target, Kind::Gpu { sink: Box::new(sink) })
}

/// A still picture is sent again this often: well under the 8 s after which viewers drop a stream, and more than once
/// in each second the app measures (0 frames in one shows a spinner over the picture).
const HEARTBEAT: Duration = Duration::from_millis(500);
/// After a window stops covering ours, its closing animation is still on screen, out of the z-order.
const SETTLE: Duration = Duration::from_millis(300);
const WAIT_MS: u32 = 100;
/// Per monitor when more than one is duplicated, so each gets its turn.
const WAIT_MANY_MS: u32 = 10;

/// The running hub's mailbox. Sending to it and the hub deciding to stop both happen under this lock.
static HUB: Mutex<Option<Sender<Entry>>> = Mutex::new(None);

enum Kind {
    Cpu { sink: Box<dyn Sink>, held: Held },
    Gpu { sink: Box<dyn GpuSink> },
}

struct Entry {
    target: Target,
    kind: Kind,
    stop: Arc<AtomicBool>,
    /// Answered once the monitor is open (or can't be).
    opened: Option<SyncSender<Result<(), String>>>,
    /// Dropped with the entry; `Duplicated::drop` waits for that.
    _gone: SyncSender<()>,
    /// Something new is on screen since this subscriber's last frame.
    changed: bool,
    settle: Option<Instant>,
    paused: bool,
    /// The part to capture this round, if it may be captured at all.
    area: Option<Rect>,
}

impl Entry {
    fn finished(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
            || match &self.kind {
                Kind::Cpu { sink, .. } => sink.stopped(),
                Kind::Gpu { sink } => sink.stopped(),
            }
    }

    fn until_due(&self) -> Duration {
        match &self.kind {
            Kind::Cpu { sink, .. } => sink.until_due(),
            Kind::Gpu { sink } => sink.until_due(),
        }
    }

    fn due(&mut self) -> bool {
        match &mut self.kind {
            Kind::Cpu { sink, .. } => sink.due(),
            Kind::Gpu { sink } => sink.due(),
        }
    }

    fn wants_frame(&self) -> bool {
        match &self.kind {
            Kind::Cpu { sink, .. } => sink.wants_frame(),
            Kind::Gpu { .. } => false,
        }
    }

    fn set_paused(&mut self, paused: bool) {
        match &mut self.kind {
            Kind::Cpu { sink, .. } => sink.set_paused(paused),
            Kind::Gpu { sink } => sink.set_paused(paused),
        }
    }

    /// Streams keep a still picture flowing; recordings just hold the last frame.
    unsafe fn repeat(&mut self, out: &Output) {
        if let Kind::Cpu { sink, held } = &mut self.kind {
            held.repeat(out, sink.as_mut());
        }
    }

    /// What may be captured of the target now. Streams send nothing covered; REC keeps recording the window in front.
    unsafe fn view(&self, monitor: Rect) -> View {
        let view = view_of(self.target, monitor);
        match (view, self.target, &self.kind) {
            (View::Covered, Target::Window(w), Kind::Gpu { .. }) if in_front(hwnd(w)) => match window_area(hwnd(w), monitor) {
                Some(area) => View::Area(area),
                None => View::Hidden,
            },
            _ => view,
        }
    }

    /// Works out whether this subscriber may get a frame of `out` now (`area`), handling covered/minimized windows.
    unsafe fn prepare(&mut self, out: &Output) {
        self.area = None;
        let area = match self.view(out.bounds) {
            View::Area(a) => a,
            // The app ends the stream (or follows the app) when it reads this from the stats.
            View::Closed => return,
            View::Covered | View::Hidden => {
                if !self.paused {
                    self.paused = true;
                    self.set_paused(true);
                }
                self.settle = None;
                self.repeat(out);
                return;
            }
        };
        if self.paused {
            self.paused = false;
            self.settle = Some(Instant::now() + SETTLE);
        }
        if let Some(until) = self.settle {
            if Instant::now() < until {
                self.repeat(out);
                return;
            }
            self.settle = None;
            self.set_paused(false);
            self.changed = true;
        }
        self.area = Some(area);
    }
}

fn subscribe(target: Target, kind: Kind) -> Result<Duplicated, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let (opened, answer) = sync_channel(1);
    let (gone_tx, gone) = sync_channel::<()>(0);
    let entry = Entry {
        target,
        kind,
        stop: stop.clone(),
        opened: Some(opened),
        _gone: gone_tx,
        changed: true,
        settle: None,
        paused: false,
        area: None,
    };
    {
        let mut hub = HUB.lock().unwrap();
        let unsent = match hub.as_ref() {
            Some(tx) => tx.send(entry).err().map(|e| e.0),
            None => Some(entry),
        };
        // No hub, or it died: start one with this entry.
        if let Some(entry) = unsent {
            let (tx, rx) = channel();
            let _ = tx.send(entry);
            std::thread::Builder::new().name("linkord-duplication".into()).spawn(move || run(rx)).map_err(|e| e.to_string())?;
            *hub = Some(tx);
        }
    }
    answer.recv().map_err(|_| "capture thread stopped".to_string())??;
    Ok(Duplicated { stop, gone: Some(gone) })
}

fn run(rx: Receiver<Entry>) {
    let mut entries: Vec<Entry> = Vec::new();
    let mut outputs: Vec<Output> = Vec::new();
    let mut generation = 0u64;
    loop {
        while let Ok(e) = rx.try_recv() {
            entries.push(e);
        }
        entries.retain(|e| !e.finished());
        if entries.is_empty() {
            // Nobody left: stop, unless someone subscribed in the meantime (they send under this same lock).
            let mut hub = HUB.lock().unwrap();
            match rx.try_recv() {
                Ok(e) => entries.push(e),
                Err(_) => {
                    *hub = None;
                    return;
                }
            }
        }
        unsafe {
            let mut monitors: Vec<usize> = entries.iter().map(|e| monitor_of(e.target)).collect();
            monitors.sort_unstable();
            monitors.dedup();
            outputs.retain(|o| monitors.contains(&o.monitor));
            for &monitor in &monitors {
                if outputs.iter().any(|o| o.monitor == monitor) {
                    continue;
                }
                generation += 1;
                match Output::open(monitor, generation) {
                    Ok(o) => outputs.push(o),
                    // New subscribers hear why (and may fall back); running ones wait (the secure desktop, a mode change).
                    Err(e) => {
                        for entry in entries.iter_mut().filter(|en| monitor_of(en.target) == monitor) {
                            if let Some(opened) = entry.opened.take() {
                                let _ = opened.send(Err(e.clone()));
                                entry.stop.store(true, Ordering::Relaxed);
                            }
                        }
                    }
                }
            }
            for entry in entries.iter_mut() {
                let monitor = monitor_of(entry.target);
                if outputs.iter().any(|o| o.monitor == monitor) {
                    if let Some(opened) = entry.opened.take() {
                        let _ = opened.send(Ok(()));
                    }
                }
            }
            if outputs.is_empty() {
                std::thread::sleep(Duration::from_millis(250));
                continue;
            }

            let wait = entries.iter().map(Entry::until_due).min().unwrap_or_default();
            if wait > Duration::from_millis(2) {
                std::thread::sleep((wait - Duration::from_millis(1)).min(Duration::from_millis(WAIT_MS as u64)));
            }
            let timeout = if outputs.len() == 1 { WAIT_MS } else { WAIT_MANY_MS };
            let mut acquired = false;
            let mut lost = Vec::new();
            for (i, out) in outputs.iter_mut().enumerate() {
                match capture_output(out, &mut entries, timeout) {
                    Captured::Frame => acquired = true,
                    Captured::Nothing => {}
                    Captured::Lost => lost.push(i),
                }
            }
            // The display changed, a game went fullscreen, the desktop switched: open it again next round.
            for i in lost.into_iter().rev() {
                outputs.remove(i);
                std::thread::sleep(Duration::from_millis(50));
            }
            if !acquired {
                std::thread::sleep(Duration::from_millis(30));
            }
        }
    }
}

enum Captured {
    /// A frame was acquired (or waited for).
    Frame,
    /// No subscriber of this monitor could take one.
    Nothing,
    Lost,
}

unsafe fn capture_output(out: &mut Output, entries: &mut [Entry], timeout: u32) -> Captured {
    let mut any = false;
    for entry in entries.iter_mut().filter(|e| monitor_of(e.target) == out.monitor) {
        entry.prepare(out);
        any |= entry.area.is_some();
    }
    if !any {
        return Captured::Nothing;
    }

    let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
    let mut resource = None;
    match out.duplication.AcquireNextFrame(timeout, &mut info, &mut resource) {
        Ok(()) => {}
        Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
            for entry in entries.iter_mut().filter(|e| e.area.is_some() && monitor_of(e.target) == out.monitor) {
                entry.repeat(out);
            }
            return Captured::Frame;
        }
        Err(_) => return Captured::Lost,
    }
    let news = out.pointer.update(&out.duplication, &info) | (info.LastPresentTime != 0);
    let texture: Option<ID3D11Texture2D> = resource.and_then(|r| r.cast().ok());
    let started = Instant::now();
    let mut readback = Vec::new();
    if let Some(texture) = &texture {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut desc);
        for (i, entry) in entries.iter_mut().enumerate() {
            if monitor_of(entry.target) != out.monitor {
                continue;
            }
            entry.changed |= news;
            let Some(mut area) = entry.area else { continue };
            // Checked again now that this image exists: a window that came up meanwhile doesn't get sent.
            if let Target::Window(_) = entry.target {
                match entry.view(out.bounds) {
                    View::Area(a) => area = a,
                    _ => continue,
                }
            }
            if !(entry.changed || entry.wants_frame()) || !entry.due() {
                continue;
            }
            match &mut entry.kind {
                Kind::Cpu { held, .. } => {
                    if held.copy(out, texture).is_ok() {
                        held.area = area;
                        readback.push(i);
                    }
                }
                Kind::Gpu { sink } => {
                    let pointer = out.pointer.visible.then(|| PointerFrame { position: out.pointer.position, shape: out.pointer.shape(), shape_id: out.pointer.shape_id });
                    sink.frame(&GpuFrame {
                        device: &out.device,
                        context: &out.context,
                        generation: out.generation,
                        texture,
                        width: desc.Width,
                        height: desc.Height,
                        area,
                        pointer,
                        at: started,
                    });
                }
            }
            entry.changed = false;
        }
    }
    let _ = out.duplication.ReleaseFrame();
    // Read back after the frame is released: Duplication waits for that before giving out the next one.
    for i in readback {
        if let Kind::Cpu { sink, held } = &mut entries[i].kind {
            held.send(out, sink.as_mut(), true, started);
        }
    }
    Captured::Frame
}

/// The last picture read back for one stream, kept so it can be sent again.
#[derive(Default)]
struct Held {
    staging: Option<(ID3D11Texture2D, u32, u32)>,
    /// The output generation the staging texture was made for.
    generation: u64,
    area: Rect,
    sent: Option<Instant>,
}

impl Held {
    /// Textures of a monitor opened before this one belong to another device.
    fn follow(&mut self, out: &Output) {
        if self.generation != out.generation {
            *self = Held { generation: out.generation, ..Held::default() };
        }
    }

    unsafe fn copy(&mut self, out: &Output, texture: &ID3D11Texture2D) -> windows::core::Result<()> {
        self.follow(out);
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
        out.context.CopyResource(&self.staging.as_ref().unwrap().0, texture);
        Ok(())
    }

    /// Sends the picture again if it's time to, or if a viewer needs one. The cursor is already in it.
    unsafe fn repeat(&mut self, out: &Output, sink: &mut dyn Sink) {
        self.follow(out);
        let late = self.sent.is_some_and(|at| at.elapsed() >= HEARTBEAT);
        if self.staging.is_some() && (late || sink.wants_frame()) && sink.due() {
            self.send(out, sink, false, Instant::now());
        }
    }

    unsafe fn send(&mut self, out: &Output, sink: &mut dyn Sink, draw_pointer: bool, started: Instant) {
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
    generation: u64,
    /// In desktop coordinates.
    bounds: Rect,
    pointer: Pointer,
}

impl Output {
    unsafe fn open(monitor: usize, generation: u64) -> Result<Output, String> {
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
                // BGRA: REC draws the cursor with Direct2D. Video support: REC converts to NV12 with the video processor.
                let flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
                if D3D11CreateDevice(&adapter, D3D_DRIVER_TYPE_UNKNOWN, HMODULE::default(), flags, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut context)).is_err() {
                    D3D11CreateDevice(&adapter, D3D_DRIVER_TYPE_UNKNOWN, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut context))
                        .map_err(text)?;
                }
                let (device, context): (ID3D11Device, ID3D11DeviceContext) = (device.unwrap(), context.unwrap());
                // REC's encoder thread uses this device too.
                if let Ok(mt) = context.cast::<ID3D11Multithread>() {
                    let _ = mt.SetMultithreadProtected(true);
                }
                // Asking for 8 bits gets an HDR monitor's picture converted. Windows 10 before 1703 only has the old call,
                // and the new one refuses processes that aren't per-monitor DPI aware (the app is; tools may not be).
                let duplication = match output.cast::<IDXGIOutput5>().and_then(|o5| o5.DuplicateOutput1(&device, 0, &[DXGI_FORMAT_B8G8R8A8_UNORM])) {
                    Ok(d) => d,
                    Err(_) => output.cast::<IDXGIOutput1>().map_err(text)?.DuplicateOutput(&device).map_err(text)?,
                };
                if duplication.GetDesc().ModeDesc.Format != DXGI_FORMAT_B8G8R8A8_UNORM {
                    return Err("not an 8-bit picture".into());
                }
                let r = desc.DesktopCoordinates;
                let bounds = Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
                return Ok(Output { duplication, device, context, monitor, generation, bounds, pointer: Pointer::default() });
            }
        }
        Err("monitor not found".into())
    }
}

pub fn monitor_of(target: Target) -> usize {
    match target {
        Target::Screen(monitor) => monitor,
        Target::Window(window) => unsafe { MonitorFromWindow(hwnd(window), MONITOR_DEFAULTTONEAREST).0 as usize },
    }
}

fn hwnd(window: usize) -> HWND {
    HWND(window as *mut std::ffi::c_void)
}

/// The size of what `target` captures right now: a window's visible part on its monitor, or the whole monitor.
pub fn capture_size(target: Target) -> Option<(u32, u32)> {
    unsafe {
        let monitor = HMONITOR(monitor_of(target) as *mut std::ffi::c_void);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return None;
        }
        let screen = Rect::from_win(info.rcMonitor);
        let area = match target {
            Target::Screen(_) => screen,
            Target::Window(w) => bounds(hwnd(w)).intersect(screen),
        };
        (!area.is_empty()).then_some((area.w as u32, area.h as u32))
    }
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

/// The window (or one of its own popups) is the one the user is using.
unsafe fn in_front(window: HWND) -> bool {
    let front = GetForegroundWindow();
    !front.is_invalid() && GetAncestor(front, GA_ROOTOWNER) == GetAncestor(window, GA_ROOTOWNER)
}

/// The window's visible part of the monitor, relative to the monitor.
unsafe fn window_area(window: HWND, monitor: Rect) -> Option<Rect> {
    let area = bounds(window).intersect(monitor);
    (!area.is_empty()).then_some(Rect { x: area.x - monitor.x, y: area.y - monitor.y, ..area })
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
    // Click-through layers (Pottira's own overlay, other programs' overlays) aren't content anyone opened.
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
    /// Counts shape changes.
    shape_id: u64,
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
            self.shape_id += 1;
            changed = true;
        }
        changed
    }

    pub fn shape(&self) -> Shape<'_> {
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

/// The cursor as a premultiplied BGRA bitmap (width, height, pixels) for drawing on the GPU (REC). Inverting pixels
/// can't be drawn as a bitmap; they come out white, which is how the usual I-beam shows over a dark game. None for an
/// empty or short shape.
pub fn pointer_bitmap(shape: &Shape) -> Option<(u32, u32, Vec<u8>)> {
    let needed = match shape.kind {
        ShapeKind::Mono => shape.pitch * shape.height * 2,
        _ => shape.pitch * shape.height,
    };
    let row_bytes = if shape.kind == ShapeKind::Mono { shape.width.div_ceil(8) } else { shape.width * 4 };
    if shape.width == 0 || shape.height == 0 || shape.data.len() < needed || shape.pitch < row_bytes {
        return None;
    }
    let mut out = vec![0u8; shape.width * shape.height * 4];
    for row in 0..shape.height {
        for col in 0..shape.width {
            let px: [u8; 4] = match shape.kind {
                ShapeKind::Color => {
                    let s = &shape.data[row * shape.pitch + col * 4..][..4];
                    let a = s[3] as u32;
                    let p = |c: u8| ((c as u32 * a + 127) / 255) as u8;
                    [p(s[0]), p(s[1]), p(s[2]), s[3]]
                }
                ShapeKind::Masked => {
                    let s = &shape.data[row * shape.pitch + col * 4..][..4];
                    // Alpha 0: replace with the colour. Otherwise XOR with it: nothing for black, else drawn as the colour.
                    if s[3] == 0 || s[..3] != [0, 0, 0] {
                        [s[0], s[1], s[2], 255]
                    } else {
                        [0, 0, 0, 0]
                    }
                }
                ShapeKind::Mono => {
                    let bit = 0x80u8 >> (col % 8);
                    let and = shape.data[row * shape.pitch + col / 8] & bit != 0;
                    let xor = shape.data[(row + shape.height) * shape.pitch + col / 8] & bit != 0;
                    match (and, xor) {
                        (true, false) => [0, 0, 0, 0],
                        (false, false) => [0, 0, 0, 255],
                        _ => [255, 255, 255, 255],
                    }
                }
            };
            out[(row * shape.width + col) * 4..][..4].copy_from_slice(&px);
        }
    }
    Some((shape.width as u32, shape.height as u32, out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_bitmaps_are_premultiplied_and_drop_transparent_pixels() {
        let color = [255, 255, 255, 255, 200, 100, 0, 128];
        let shape = Shape { kind: ShapeKind::Color, width: 2, height: 1, pitch: 8, data: &color };
        assert_eq!(pointer_bitmap(&shape).unwrap().2, [255, 255, 255, 255, 100, 50, 0, 128]);
        // Mono: AND 1,0,0,1 then XOR 0,0,1,1: transparent, black, white, inverted (white).
        let mono = [0b1001_0000u8, 0b0011_0000];
        let shape = Shape { kind: ShapeKind::Mono, width: 4, height: 1, pitch: 1, data: &mono };
        assert_eq!(pointer_bitmap(&shape).unwrap().2, [0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
        // Masked: replace (alpha 0), XOR with black (nothing), XOR with white (white).
        let masked = [1, 2, 3, 0, 0, 0, 0, 255, 255, 255, 255, 255];
        let shape = Shape { kind: ShapeKind::Masked, width: 3, height: 1, pitch: 12, data: &masked };
        assert_eq!(pointer_bitmap(&shape).unwrap().2, [1, 2, 3, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
        assert!(pointer_bitmap(&Shape { kind: ShapeKind::Color, width: 2, height: 2, pitch: 8, data: &[0; 4] }).is_none());
    }

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
