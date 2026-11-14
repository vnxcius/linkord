//! REC's video: Desktop Duplication frames encoded to H.264 without ever leaving the GPU (Windows).
//!
//! Per frame, on the capture thread (duplication.rs hub), only GPU commands, nothing waits:
//! 1. copy the duplicated monitor into our own texture (the duplication's is only lent for the call);
//! 2. draw the cursor on it with Direct2D, when "record cursor" is on (Duplication leaves the hardware cursor out);
//! 3. the D3D11 video processor crops the game's area, scales it to the recording size (letterboxed if the window's
//!    shape changed) and converts it to NV12 (BT.709, studio range) into a free texture of a small pool.
//!
//! The encoder thread wraps that texture in a tracked Media Foundation sample (it goes back to the pool when the
//! encoder lets go of it) and feeds the hardware encoder, which shares the device. If the pool is all in use (the
//! encoder is behind), the frame is dropped rather than waited for. The stream path reads every frame back to the CPU
//! instead; recording all the time while gaming can't afford that.
//!
//! The size is fixed for the whole recording: the quality the user picked, within the monitor's size (never the
//! window's: League's client would keep its game at 1600x900), so a recording is one picture size whatever the game's
//! window does, and a smaller window is scaled up into it. Variable frame rate: Duplication only gives changed frames.

use std::mem::ManuallyDrop;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::{implement, Interface, Ref};
use windows::Win32::Foundation::{E_NOTIMPL, RECT};
use windows::Win32::Graphics::Direct2D::Common::{D2D1_ALPHA_MODE_IGNORE, D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_PIXEL_FORMAT, D2D_RECT_F, D2D_SIZE_U};
use windows::Win32::Graphics::Direct2D::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::{IDXGIDevice, IDXGISurface};
use windows::Win32::Media::MediaFoundation::*;

use crate::capture::convert::target_size;
use crate::capture::duplication::{self, pointer_bitmap, Duplicated, GpuFrame, GpuSink, PointerFrame, Rect, Target};
use crate::capture::encoder::{Encoder, Packet, Tuning};

#[derive(Clone, Copy, Debug)]
pub struct VideoSettings {
    /// Largest recorded height (16:9 box), 0 = as captured. Never upscaled.
    pub max_height: u32,
    pub fps: u32,
    /// Average bits per second.
    pub bitrate: u32,
    pub cursor: bool,
}

/// Where encoded video goes (the recording's segment writer). Called on the encoder thread.
pub trait VideoOut: Send + 'static {
    /// A (new) encoder: what follows starts with a keyframe of this size.
    fn start(&mut self, width: u32, height: u32);
    /// `packet.time` is in 100 ns units since the recording started.
    fn packet(&mut self, packet: Packet);
}

/// Counters for the REC readout and the game-cost measurements.
#[derive(Default)]
pub struct Stats {
    /// Frames converted and queued for the encoder.
    pub captured: AtomicU32,
    /// Frames dropped because every pool texture was still with the encoder.
    pub dropped: AtomicU32,
    pub encoded: AtomicU32,
    /// Time spent on the capture thread per frame (queuing GPU work), total microseconds.
    pub submit_us: AtomicU32,
}

struct Shared {
    stop: AtomicBool,
    /// The game's window is covered or minimized: the recording holds its last picture.
    paused: AtomicBool,
    error: Mutex<Option<String>>,
    stats: Stats,
    started: Instant,
    /// A keyframe on the next frame (a clip is being saved: its segment can close right away).
    keyframe_now: AtomicBool,
    /// Pictures wanted from the next frame.
    grabs: Mutex<Vec<Grab>>,
}

/// A picture of the recorded area (no cursor), read back once from the GPU.
pub enum Grab {
    /// Full size, PNG; the result goes back on the channel.
    Screenshot(std::path::PathBuf, std::sync::mpsc::Sender<Result<(), String>>),
    /// 320 px wide JPEG (the VOD's timeline previews).
    Thumbnail(std::path::PathBuf),
}

/// Encodes a grabbed BGRA picture (tightly packed) on a short-lived thread, off the capture thread.
fn save_grabs(grabs: Vec<Grab>, mut bgra: Vec<u8>, width: u32, height: u32) {
    std::thread::spawn(move || {
        for px in bgra.as_chunks_mut::<4>().0 {
            px.swap(0, 2);
            px[3] = 255;
        }
        let Some(image) = image::RgbaImage::from_raw(width, height, bgra) else { return };
        for grab in grabs {
            match grab {
                Grab::Screenshot(path, done) => {
                    let result = save_png(&image, &path).map_err(|e| e.to_string());
                    let _ = done.send(result);
                }
                Grab::Thumbnail(path) => {
                    let w = 320.min(width).max(1);
                    let small = image::imageops::thumbnail(&image, w, (w * height / width.max(1)).max(1));
                    let rgb = image::DynamicImage::ImageRgba8(small).to_rgb8();
                    let _ = rgb.save_with_format(&path, image::ImageFormat::Jpeg);
                }
            }
        }
    });
}

fn save_png(image: &image::RgbaImage, path: &std::path::Path) -> image::ImageResult<()> {
    use image::ImageEncoder;
    let tmp = path.with_extension("tmp");
    let file = std::io::BufWriter::new(std::fs::File::create(&tmp)?);
    let rgb = image::DynamicImage::ImageRgba8(image.clone()).to_rgb8();
    image::codecs::png::PngEncoder::new_with_quality(file, image::codecs::png::CompressionType::Fast, image::codecs::png::FilterType::Adaptive)
        .write_image(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// A running video recording. Dropping it stops it (and writes out what's left in the encoder).
pub struct VideoRecorder {
    shared: Arc<Shared>,
    capture: Option<Duplicated>,
    encoder: Option<JoinHandle<()>>,
    pub width: u32,
    pub height: u32,
}

/// NV12 textures handed between the video processor and the encoder: one being filled, one or two with the encoder,
/// some slack for a hiccup.
const POOL: usize = 6;
/// A keyframe at least this often (100 ns), so segments are ~2 s.
const KEYFRAME_EVERY: i64 = 20_000_000;
/// H.264 hardware encoders stop at 4096 pixels wide.
const MAX_WIDTH: u32 = 4096;

impl VideoRecorder {
    /// `origin`: the recording's time zero, shared with its audio.
    pub fn start(target: Target, settings: VideoSettings, origin: Instant, out: impl VideoOut) -> Result<VideoRecorder, String> {
        // The user's quality within the monitor's size; a smaller window is scaled up into it.
        let (w, h) = duplication::monitor_size(target).ok_or("nothing to record")?;
        let (width, height) = recording_size(w, h, settings.max_height);
        let shared = Arc::new(Shared { stop: AtomicBool::new(false), paused: AtomicBool::new(false), error: Mutex::new(None), stats: Stats::default(), started: origin, keyframe_now: AtomicBool::new(false), grabs: Mutex::new(Vec::new()) });
        let (jobs, rx) = sync_channel::<Job>(POOL + 1);
        let enc_shared = shared.clone();
        let encoder = std::thread::Builder::new()
            .name("pottira-rec-encoder".into())
            .spawn(move || encode_loop(enc_shared, rx, out, (width, height), settings))
            .map_err(|e| e.to_string())?;
        let frames = Frames { shared: shared.clone(), settings, size: (width, height), jobs, next: None, gpu: None };
        let capture = match duplication::start_gpu(target, frames) {
            Ok(c) => c,
            Err(e) => {
                shared.stop.store(true, Ordering::Relaxed);
                let _ = encoder.join();
                return Err(e);
            }
        };
        Ok(VideoRecorder { shared, capture: Some(capture), encoder: Some(encoder), width, height })
    }

    pub fn stats(&self) -> &Stats {
        &self.shared.stats
    }

    /// The next frame becomes a keyframe (a clip's end: its segment can be closed at once).
    pub fn keyframe_now(&self) {
        self.shared.keyframe_now.store(true, Ordering::Relaxed);
    }

    /// Asks for a picture of the next frame.
    pub fn grab(&self, grab: Grab) {
        self.shared.grabs.lock().unwrap().push(grab);
    }

    pub fn paused(&self) -> bool {
        self.shared.paused.load(Ordering::Relaxed)
    }

    /// Why it stopped by itself (no hardware encoder for this GPU, ...), if it did.
    pub fn error(&self) -> Option<String> {
        self.shared.error.lock().unwrap().clone()
    }
}

impl Drop for VideoRecorder {
    fn drop(&mut self) {
        // The capture first: once it's gone, the encoder thread sees its channel close, drains and ends.
        drop(self.capture.take());
        if let Some(t) = self.encoder.take() {
            let _ = t.join();
        }
    }
}

/// The recording's size for a capture of `w` x `h`: within `max_height` (0 = as is) and the encoder's width limit, even.
pub fn recording_size(w: u32, h: u32, max_height: u32) -> (u32, u32) {
    // As captured: any shape. Otherwise the same 16:9 box as streams.
    let (mut tw, mut th) = if max_height == 0 { (w.max(2) & !1, h.max(2) & !1) } else { target_size(w, h, max_height) };
    if tw > MAX_WIDTH {
        th = ((th as u64 * MAX_WIDTH as u64 / tw as u64) as u32).max(2) & !1;
        tw = MAX_WIDTH;
    }
    (tw, th)
}

/// Where a `w` x `h` picture goes inside the recording's `size`: as big as fits, centred.
fn letterbox(w: i32, h: i32, size: (u32, u32)) -> RECT {
    let (sw, sh) = (size.0 as i64, size.1 as i64);
    let (w, h) = (w.max(1) as i64, h.max(1) as i64);
    let (dw, dh) = if w * sh > h * sw { (sw, (h * sw / w).max(2)) } else { ((w * sh / h).max(2), sh) };
    let (x, y) = ((sw - dw) / 2, (sh - dh) / 2);
    RECT { left: x as i32, top: y as i32, right: (x + dw) as i32, bottom: (y + dh) as i32 }
}

enum Job {
    /// The monitor was (re)opened on this device: the encoder must be made on it.
    Device(ID3D11Device),
    Frame { texture: ID3D11Texture2D, busy: Arc<AtomicBool>, time: i64 },
}

// ---------- capture thread ----------

struct Frames {
    shared: Arc<Shared>,
    settings: VideoSettings,
    size: (u32, u32),
    jobs: SyncSender<Job>,
    next: Option<Instant>,
    gpu: Option<Gpu>,
}

/// Frames arriving this early are still taken, so a 60 Hz display can feed a 60 fps recording.
const SLACK: Duration = Duration::from_micros(1500);

impl GpuSink for Frames {
    fn stopped(&self) -> bool {
        self.shared.stop.load(Ordering::Relaxed)
    }

    fn until_due(&self) -> Duration {
        self.next.map_or(Duration::ZERO, |due| due.saturating_duration_since(Instant::now() + SLACK))
    }

    fn due(&mut self) -> bool {
        let interval = Duration::from_micros(1_000_000 / self.settings.fps.max(1) as u64);
        let now = Instant::now();
        if self.next.is_some_and(|due| now + SLACK < due) {
            return false;
        }
        self.next = Some(match self.next {
            Some(due) if now < due + interval => due + interval,
            _ => now + interval,
        });
        true
    }

    fn frame(&mut self, frame: &GpuFrame) {
        let began = Instant::now();
        if let Err(e) = self.submit(frame) {
            // A broken device (driver reset): start over on the next frame, which comes on a fresh one.
            eprintln!("rec: frame failed: {e}");
            self.gpu = None;
        }
        self.shared.stats.submit_us.fetch_add(began.elapsed().as_micros() as u32, Ordering::Relaxed);
    }

    fn set_paused(&mut self, paused: bool) {
        self.shared.paused.store(paused, Ordering::Relaxed);
    }
}

impl Frames {
    fn submit(&mut self, frame: &GpuFrame) -> windows::core::Result<()> {
        let stale = self.gpu.as_ref().is_none_or(|g| g.generation != frame.generation || g.source != (frame.width, frame.height));
        if stale {
            self.gpu = None;
            let gpu = unsafe { Gpu::new(frame, self.size, self.settings)? };
            // Tell the encoder before the first frame made on it.
            if self.jobs.send(Job::Device(frame.device.clone())).is_err() {
                return Ok(());
            }
            self.gpu = Some(gpu);
        }
        let gpu = self.gpu.as_mut().unwrap();
        let Some(slot) = gpu.slots.iter().position(|s| !s.busy.load(Ordering::Acquire)) else {
            self.shared.stats.dropped.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        };
        unsafe {
            frame.context.CopyResource(&gpu.latest, frame.texture);
            // Pictures without the cursor, like screenshots usually are.
            let grabs = std::mem::take(&mut *self.shared.grabs.lock().unwrap());
            if !grabs.is_empty() {
                match gpu.read_area(frame.context, frame.area) {
                    Ok((bgra, w, h)) => save_grabs(grabs, bgra, w, h),
                    Err(e) => {
                        for g in grabs {
                            if let Grab::Screenshot(_, done) = g {
                                let _ = done.send(Err(e.to_string()));
                            }
                        }
                    }
                }
            }
            if let (Some(cursor), Some(pointer)) = (gpu.cursor.as_mut(), frame.pointer.as_ref()) {
                cursor.draw(pointer);
            }
            gpu.convert(frame.area, slot, self.size)?;
        }
        let s = &gpu.slots[slot];
        s.busy.store(true, Ordering::Release);
        let time = frame.at.saturating_duration_since(self.shared.started).as_nanos() as i64 / 100;
        match self.jobs.try_send(Job::Frame { texture: s.texture.clone(), busy: s.busy.clone(), time }) {
            Ok(()) => {
                self.shared.stats.captured.fetch_add(1, Ordering::Relaxed);
            }
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                s.busy.store(false, Ordering::Release);
                self.shared.stats.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
        Ok(())
    }
}

struct Slot {
    texture: ID3D11Texture2D,
    view: ID3D11VideoProcessorOutputView,
    /// With the encoder; cleared when Media Foundation releases the sample.
    busy: Arc<AtomicBool>,
}

/// Everything made on one device for one monitor size.
struct Gpu {
    generation: u64,
    source: (u32, u32),
    /// For reading pictures back (screenshots, thumbnails); made on first use.
    staging: Option<ID3D11Texture2D>,
    latest: ID3D11Texture2D,
    video: ID3D11VideoContext,
    processor: ID3D11VideoProcessor,
    input: ID3D11VideoProcessorInputView,
    slots: Vec<Slot>,
    cursor: Option<Cursor>,
}

impl Gpu {
    unsafe fn new(frame: &GpuFrame, size: (u32, u32), settings: VideoSettings) -> windows::core::Result<Gpu> {
        let device = frame.device;
        let video_device: ID3D11VideoDevice = device.cast()?;
        let video: ID3D11VideoContext = frame.context.cast()?;
        let desc = D3D11_TEXTURE2D_DESC {
            Width: frame.width,
            Height: frame.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut latest = None;
        device.CreateTexture2D(&desc, None, Some(&mut latest))?;
        let latest = latest.unwrap();

        let rate = DXGI_RATIONAL { Numerator: settings.fps.max(1), Denominator: 1 };
        let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: rate,
            InputWidth: frame.width,
            InputHeight: frame.height,
            OutputFrameRate: rate,
            OutputWidth: size.0,
            OutputHeight: size.1,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
        };
        let enumerator = video_device.CreateVideoProcessorEnumerator(&content)?;
        let processor = video_device.CreateVideoProcessor(&enumerator, 0)?;
        let input_desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
        };
        let mut input = None;
        video_device.CreateVideoProcessorInputView(&latest, &enumerator, &input_desc, Some(&mut input))?;
        let input = input.unwrap();

        video.VideoProcessorSetStreamFrameFormat(&processor, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
        // No driver "enhancements" (sharpening, denoise): the game as it was.
        video.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
        // Bits: usage, RGB range (0 = full 0-255), YCbCr matrix (1 = BT.709), xvYCC, nominal range (2 bits, 1 = 16-235).
        video.VideoProcessorSetStreamColorSpace(&processor, 0, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: 0 });
        video.VideoProcessorSetOutputColorSpace(&processor, &D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: 0b01_0100 });
        // Black bars, in YCbCr (studio black).
        let black = D3D11_VIDEO_COLOR { Anonymous: D3D11_VIDEO_COLOR_0 { YCbCr: D3D11_VIDEO_COLOR_YCbCrA { Y: 16.0 / 255.0, Cb: 0.5, Cr: 0.5, A: 1.0 } } };
        video.VideoProcessorSetOutputBackgroundColor(&processor, true, &black);
        video.VideoProcessorSetOutputTargetRect(&processor, true, Some(&RECT { left: 0, top: 0, right: size.0 as i32, bottom: size.1 as i32 }));

        let nv12 = D3D11_TEXTURE2D_DESC { Width: size.0, Height: size.1, Format: DXGI_FORMAT_NV12, BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32, ..desc };
        let output_desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
        };
        let mut slots = Vec::with_capacity(POOL);
        for _ in 0..POOL {
            let mut texture = None;
            device.CreateTexture2D(&nv12, None, Some(&mut texture))?;
            let texture = texture.unwrap();
            let mut view = None;
            video_device.CreateVideoProcessorOutputView(&texture, &enumerator, &output_desc, Some(&mut view))?;
            slots.push(Slot { texture, view: view.unwrap(), busy: Arc::new(AtomicBool::new(false)) });
        }
        // Without the cursor the recording still works.
        let cursor = if settings.cursor { Cursor::new(device, &latest).map_err(|e| eprintln!("rec: no cursor: {e}")).ok() } else { None };
        Ok(Gpu { generation: frame.generation, source: (frame.width, frame.height), staging: None, latest, video, processor, input, slots, cursor })
    }

    /// `latest`'s `area` as tightly packed BGRA. Waits for the GPU (a few ms, only when a picture is wanted).
    unsafe fn read_area(&mut self, context: &ID3D11DeviceContext, area: Rect) -> windows::core::Result<(Vec<u8>, u32, u32)> {
        if self.staging.is_none() {
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            self.latest.GetDesc(&mut desc);
            desc.Usage = D3D11_USAGE_STAGING;
            desc.BindFlags = 0;
            desc.MiscFlags = 0;
            desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            let mut staging = None;
            context.GetDevice()?.CreateTexture2D(&desc, None, Some(&mut staging))?;
            self.staging = staging;
        }
        let staging = self.staging.as_ref().unwrap();
        context.CopyResource(staging, &self.latest);
        let mut map = D3D11_MAPPED_SUBRESOURCE::default();
        context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut map))?;
        let (sw, sh) = (self.source.0 as i32, self.source.1 as i32);
        let (x, y) = (area.x.clamp(0, sw - 1), area.y.clamp(0, sh - 1));
        let (w, h) = ((area.w).clamp(1, sw - x) as usize, (area.h).clamp(1, sh - y) as usize);
        let stride = map.RowPitch as usize;
        let src = std::slice::from_raw_parts(map.pData as *const u8, stride * sh as usize);
        let mut out = Vec::with_capacity(w * h * 4);
        for row in 0..h {
            let start = (y as usize + row) * stride + x as usize * 4;
            out.extend_from_slice(&src[start..start + w * 4]);
        }
        context.Unmap(staging, 0);
        Ok((out, w as u32, h as u32))
    }

    /// `latest`'s `area` -> slot `slot`'s NV12 texture, letterboxed into the recording's size.
    unsafe fn convert(&self, area: Rect, slot: usize, size: (u32, u32)) -> windows::core::Result<()> {
        // Never outside the picture: the window may have moved since the area was worked out.
        let (sw, sh) = (self.source.0 as i32, self.source.1 as i32);
        let left = area.x.clamp(0, sw - 1);
        let top = area.y.clamp(0, sh - 1);
        let src = RECT { left, top, right: (area.x + area.w).clamp(left + 1, sw), bottom: (area.y + area.h).clamp(top + 1, sh) };
        let dst = letterbox(src.right - src.left, src.bottom - src.top, size);
        self.video.VideoProcessorSetStreamSourceRect(&self.processor, 0, true, Some(&src));
        self.video.VideoProcessorSetStreamDestRect(&self.processor, 0, true, Some(&dst));
        let mut stream = D3D11_VIDEO_PROCESSOR_STREAM { Enable: true.into(), pInputSurface: ManuallyDrop::new(Some(self.input.clone())), ..Default::default() };
        let result = self.video.VideoProcessorBlt(&self.processor, &self.slots[slot].view, 0, std::slice::from_ref(&stream));
        ManuallyDrop::drop(&mut stream.pInputSurface);
        result
    }
}

/// Draws the cursor onto `latest` with Direct2D (on the GPU, no read back).
struct Cursor {
    context: ID2D1DeviceContext,
    _target: ID2D1Bitmap1,
    /// (bitmap, width, height, shape id)
    bitmap: Option<(ID2D1Bitmap1, u32, u32, u64)>,
    shape_id: u64,
}

impl Cursor {
    unsafe fn new(device: &ID3D11Device, latest: &ID3D11Texture2D) -> windows::core::Result<Cursor> {
        // Multi-threaded: the device is shared with the encoder thread.
        let factory: ID2D1Factory1 = D2D1CreateFactory(D2D1_FACTORY_TYPE_MULTI_THREADED, None)?;
        let dxgi: IDXGIDevice = device.cast()?;
        let context = factory.CreateDevice(&dxgi)?.CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)?;
        let surface: IDXGISurface = latest.cast()?;
        let props = D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT { format: DXGI_FORMAT_B8G8R8A8_UNORM, alphaMode: D2D1_ALPHA_MODE_IGNORE },
            dpiX: 96.0,
            dpiY: 96.0,
            bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
            colorContext: ManuallyDrop::new(None),
        };
        let target = context.CreateBitmapFromDxgiSurface(&surface, Some(&props))?;
        context.SetTarget(&target);
        Ok(Cursor { context, _target: target, bitmap: None, shape_id: u64::MAX })
    }

    unsafe fn draw(&mut self, pointer: &PointerFrame) {
        if self.shape_id != pointer.shape_id {
            self.shape_id = pointer.shape_id;
            self.bitmap = pointer_bitmap(&pointer.shape).and_then(|(w, h, pixels)| {
                let props = D2D1_BITMAP_PROPERTIES1 {
                    pixelFormat: D2D1_PIXEL_FORMAT { format: DXGI_FORMAT_B8G8R8A8_UNORM, alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED },
                    dpiX: 96.0,
                    dpiY: 96.0,
                    bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
                    colorContext: ManuallyDrop::new(None),
                };
                self.context.CreateBitmap(D2D_SIZE_U { width: w, height: h }, Some(pixels.as_ptr() as *const _), w * 4, &props).ok().map(|b| (b, w, h, pointer.shape_id))
            });
        }
        let Some((bitmap, w, h, _)) = &self.bitmap else { return };
        let (x, y) = (pointer.position.0 as f32, pointer.position.1 as f32);
        let rect = D2D_RECT_F { left: x, top: y, right: x + *w as f32, bottom: y + *h as f32 };
        self.context.BeginDraw();
        self.context.DrawBitmap(bitmap, Some(&rect), 1.0, D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR, None, None);
        let _ = self.context.EndDraw(None, None);
    }
}

// ---------- encoder thread ----------

/// Gives a pool texture back when Media Foundation lets go of the sample wrapping it.
#[implement(IMFAsyncCallback)]
struct Release(Arc<AtomicBool>);

impl IMFAsyncCallback_Impl for Release_Impl {
    fn GetParameters(&self, _flags: *mut u32, _queue: *mut u32) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Invoke(&self, _result: Ref<IMFAsyncResult>) -> windows::core::Result<()> {
        self.0.store(false, Ordering::Release);
        Ok(())
    }
}

unsafe fn sample_for(texture: &ID3D11Texture2D, busy: &Arc<AtomicBool>, time: i64, duration: i64) -> windows::core::Result<IMFSample> {
    let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, texture, 0, false)?;
    if let Ok(len) = buffer.cast::<IMF2DBuffer>().and_then(|b| b.GetContiguousLength()) {
        let _ = buffer.SetCurrentLength(len);
    }
    let tracked = MFCreateTrackedSample()?;
    let sample: IMFSample = tracked.cast()?;
    sample.AddBuffer(&buffer)?;
    sample.SetSampleTime(time)?;
    sample.SetSampleDuration(duration)?;
    let callback: IMFAsyncCallback = Release(busy.clone()).into();
    tracked.SetAllocator(&callback, None)?;
    Ok(sample)
}

fn encode_loop(shared: Arc<Shared>, jobs: Receiver<Job>, mut out: impl VideoOut, size: (u32, u32), settings: VideoSettings) {
    let mut encoder: Option<Encoder> = None;
    let mut next_key = 0i64;
    let duration = 10_000_000 / settings.fps.max(1) as i64;
    let emit = |packet: Packet, out: &mut dyn VideoOut| {
        shared.stats.encoded.fetch_add(1, Ordering::Relaxed);
        out.packet(packet);
    };
    loop {
        let job = match jobs.recv_timeout(Duration::from_millis(200)) {
            Ok(job) => job,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        match job {
            Job::Device(device) => {
                if let Some(mut old) = encoder.take() {
                    let _ = old.drain(&mut |p| emit(p, &mut out));
                }
                match Encoder::new_gpu(&device, size.0, size.1, settings.fps, settings.bitrate, Tuning::Record) {
                    Ok(e) => {
                        out.start(size.0, size.1);
                        encoder = Some(e);
                        next_key = i64::MIN;
                    }
                    Err(e) => {
                        // No hardware encoder takes this GPU: stop rather than record on the CPU behind the game's back.
                        *shared.error.lock().unwrap() = Some(format!("no hardware H.264 encoder for this GPU: {e}"));
                        shared.stop.store(true, Ordering::Relaxed);
                        break;
                    }
                }
            }
            Job::Frame { texture, busy, time } => {
                let Some(enc) = encoder.as_mut() else {
                    busy.store(false, Ordering::Release);
                    continue;
                };
                let asked = shared.keyframe_now.swap(false, Ordering::Relaxed);
                if asked || time >= next_key {
                    enc.force_keyframe();
                    next_key = time.max(0) + KEYFRAME_EVERY;
                }
                let sample = match unsafe { sample_for(&texture, &busy, time, duration) } {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("rec: sample: {e}");
                        busy.store(false, Ordering::Release);
                        continue;
                    }
                };
                let result = enc.encode_sample(&sample, &mut |p| emit(p, &mut out));
                drop(sample);
                if let Err(e) = result {
                    eprintln!("rec: encode failed: {e}");
                    *shared.error.lock().unwrap() = Some(format!("encoding failed: {e}"));
                    shared.stop.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }
    }
    if let Some(mut enc) = encoder.take() {
        let _ = enc.drain(&mut |p| emit(p, &mut out));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_sizes_fit_the_box_and_the_encoder() {
        assert_eq!(recording_size(2560, 1440, 1080), (1920, 1080));
        assert_eq!(recording_size(1920, 1080, 0), (1920, 1080));
        assert_eq!(recording_size(1280, 720, 1080), (1280, 720), "never upscaled");
        assert_eq!(recording_size(5120, 1440, 0), (4096, 1152), "super ultrawide stays under 4096");
        assert_eq!(recording_size(1001, 601, 0).0 % 2, 0);
    }

    #[test]
    fn pictures_of_another_shape_are_letterboxed_in_the_middle() {
        let r = letterbox(1000, 1000, (1920, 1080));
        assert_eq!((r.left, r.top, r.right, r.bottom), (420, 0, 1500, 1080));
        let r = letterbox(1920, 1080, (1920, 1080));
        assert_eq!((r.left, r.top, r.right, r.bottom), (0, 0, 1920, 1080));
    }
}
