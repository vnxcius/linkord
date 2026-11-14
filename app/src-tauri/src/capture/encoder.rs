//! H.264 encoding through Media Foundation. Prefers the GPU's hardware encoder (NVENC, AMF, Quick Sync
//! all register as MF transforms) and falls back to Microsoft's software encoder.
//! Output is Annex B byte stream; SPS/PPS are guaranteed in front of every keyframe so viewers can
//! start decoding at any keyframe.
//!
//! Two ways in: NV12 bytes from the CPU (streams, `new` + `encode`), or NV12 textures that never leave the GPU (REC,
//! `new_gpu` + `encode_sample` with a DXGI surface buffer). The GPU one only takes a hardware encoder on the same
//! adapter as the device, since a software encoder would cost games CPU for as long as they're recorded.

use std::mem::ManuallyDrop;

use windows::core::{Interface, GUID};
use windows::Win32::Graphics::Direct3D11::ID3D11Device;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VARIANT;

/// What the encoder is tuned for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tuning {
    /// Constant bitrate (predictable for the relay), rare keyframes (viewers ask for one when they need it).
    Stream,
    /// Variable bitrate under a peak; the caller forces a keyframe every couple of seconds so recordings can be cut
    /// and played from any segment.
    Record,
}

pub struct Encoder {
    transform: IMFTransform,
    events: Option<IMFMediaEventGenerator>,
    codec: Option<ICodecAPI>,
    provides_samples: bool,
    output_size: u32,
    need_input: u32,
    sequence_header: Vec<u8>,
    pub hardware: bool,
    pub width: u32,
    pub height: u32,
    /// The GPU encoder's device manager; released after the transform (fields drop in declaration order).
    _manager: Option<IMFDXGIDeviceManager>,
    // Last, so it is released after the transform.
    _mf: MfSession,
}

/// A finished frame: Annex B data, whether it's a keyframe, and the time it was given (100 ns units).
pub struct Packet {
    pub data: Vec<u8>,
    pub key: bool,
    pub time: i64,
}

/// Media Foundation (and COM on this thread) for as long as an encoder lives: every MFStartup needs its
/// MFShutdown, and encoders are rebuilt on every quality or size change.
pub(crate) struct MfSession {
    com: bool,
}

impl MfSession {
    pub(crate) unsafe fn start() -> windows::core::Result<MfSession> {
        // S_FALSE (already initialized) also needs a CoUninitialize; RPC_E_CHANGED_MODE (an STA thread) doesn't.
        let com = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
            if com {
                CoUninitialize();
            }
            return Err(e);
        }
        Ok(MfSession { com })
    }
}

impl Drop for MfSession {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            if self.com {
                CoUninitialize();
            }
        }
    }
}

fn pack(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | lo as u64
}

/// Every registered H.264 encoder of that kind, best first.
unsafe fn candidates(hardware: bool) -> windows::core::Result<Vec<IMFActivate>> {
    let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
    let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
    let flags = if hardware { MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER } else { MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER };
    let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags, Some(&input), Some(&output), &mut activates, &mut count)?;
    let list = std::slice::from_raw_parts_mut(activates, count as usize);
    let found = list.iter_mut().filter_map(Option::take).collect();
    CoTaskMemFree(Some(activates as *const _));
    Ok(found)
}

unsafe fn find_encoder(hardware: bool) -> windows::core::Result<Option<IMFTransform>> {
    Ok(candidates(hardware)?.into_iter().find_map(|a| a.ActivateObject::<IMFTransform>().ok()))
}

unsafe fn set_codec(codec: &ICodecAPI, api: &GUID, value: u32) {
    // Not every encoder supports every knob; unsupported ones are simply skipped.
    let _ = codec.SetValue(api, &VARIANT::from(value));
}

impl Encoder {
    /// For NV12 frames from the CPU (streams). Hardware if there is one, else Microsoft's software encoder.
    pub fn new(width: u32, height: u32, fps: u32, bitrate: u32) -> windows::core::Result<Encoder> {
        unsafe {
            let mf = MfSession::start()?;
            let (transform, hardware) = match find_encoder(true)? {
                Some(t) => (t, true),
                None => (find_encoder(false)?.ok_or_else(|| windows::core::Error::from(MF_E_TOPO_CODEC_NOT_FOUND))?, false),
            };
            if hardware {
                unlock(&transform)?;
            }
            Self::configure(transform, None, mf, hardware, width, height, fps, bitrate, Tuning::Stream)
        }
    }

    /// For NV12 textures of `device` (REC): only a hardware encoder that accepts this device, so frames stay on the GPU.
    pub fn new_gpu(device: &ID3D11Device, width: u32, height: u32, fps: u32, bitrate: u32, tuning: Tuning) -> windows::core::Result<Encoder> {
        unsafe {
            let mf = MfSession::start()?;
            let mut token = 0u32;
            let mut manager = None;
            MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
            let manager = manager.ok_or_else(|| windows::core::Error::from(MF_E_TOPO_CODEC_NOT_FOUND))?;
            manager.ResetDevice(device, token)?;
            let mut last = windows::core::Error::from(MF_E_TOPO_CODEC_NOT_FOUND);
            // On a PC with two GPUs every one registers an encoder; only the one on the device's adapter takes it.
            for activate in candidates(true)? {
                let Ok(transform) = activate.ActivateObject::<IMFTransform>() else { continue };
                let attached = unlock(&transform).and_then(|_| {
                    let aware = transform.GetAttributes()?.GetUINT32(&MF_SA_D3D11_AWARE).unwrap_or(0) != 0;
                    if !aware {
                        return Err(windows::core::Error::from(MF_E_TOPO_CODEC_NOT_FOUND));
                    }
                    transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)
                });
                match attached {
                    Ok(()) => return Self::configure(transform, Some(manager), mf, true, width, height, fps, bitrate, tuning),
                    Err(e) => {
                        last = e;
                        let _ = activate.ShutdownObject();
                    }
                }
            }
            Err(last)
        }
    }

    #[allow(clippy::too_many_arguments)]
    unsafe fn configure(
        transform: IMFTransform,
        manager: Option<IMFDXGIDeviceManager>,
        mf: MfSession,
        hardware: bool,
        width: u32,
        height: u32,
        fps: u32,
        bitrate: u32,
        tuning: Tuning,
    ) -> windows::core::Result<Encoder> {
        {
            // Some encoders (NVIDIA's) only take the GOP length before the media types are set.
            if tuning == Tuning::Record {
                if let Ok(c) = transform.cast::<ICodecAPI>() {
                    set_codec(&c, &CODECAPI_AVEncMPVGOPSize, fps * 10);
                }
            }
            let out = MFCreateMediaType()?;
            out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            out.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
            out.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
            out.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
            out.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            out.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            out.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
            out.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
            // Said in the stream (VUI), so players that would guess BT.601 (ffmpeg-based ones) show the right colours.
            let _ = out.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32);
            let _ = out.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32);
            let _ = out.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32);
            transform.SetOutputType(0, &out, 0)?;

            let inp = MFCreateMediaType()?;
            inp.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            inp.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            inp.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
            inp.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
            inp.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            inp.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            inp.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
            let _ = inp.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32);
            transform.SetInputType(0, &inp, 0)?;

            // Both: lowest latency (one frame in, one out, so the GPU texture pool stays small) and no B-frames (output
            // order = input order, which the recorder's muxer relies on).
            let codec = transform.cast::<ICodecAPI>().ok();
            if let Some(c) = &codec {
                set_codec(c, &CODECAPI_AVLowLatencyMode, 1);
                set_codec(c, &CODECAPI_AVEncMPVDefaultBPictureCount, 0);
                set_codec(c, &CODECAPI_AVEncCommonMeanBitRate, bitrate);
                match tuning {
                    Tuning::Stream => {
                        set_codec(c, &CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR.0 as u32);
                        set_codec(c, &CODECAPI_AVEncMPVGOPSize, fps * 10);
                        set_codec(c, &CODECAPI_AVEncCommonQualityVsSpeed, 70);
                    }
                    Tuning::Record => {
                        set_codec(c, &CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_PeakConstrainedVBR.0 as u32);
                        set_codec(c, &CODECAPI_AVEncCommonMaxBitRate, bitrate.saturating_mul(3) / 2);
                        // Long: the recorder forces a keyframe every 2 s of real time itself (frame rates vary), and
                        // the encoder's own count would add more on top.
                        set_codec(c, &CODECAPI_AVEncMPVGOPSize, fps * 10);
                        // Faster presets: the GPU is shared with the game being recorded.
                        set_codec(c, &CODECAPI_AVEncCommonQualityVsSpeed, 50);
                    }
                }
            }

            let info = transform.GetOutputStreamInfo(0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            let events = if hardware { Some(transform.cast::<IMFMediaEventGenerator>()?) } else { None };
            Ok(Encoder {
                transform,
                events,
                codec,
                provides_samples: info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0,
                output_size: info.cbSize.max(width * height),
                need_input: 0,
                sequence_header: Vec::new(),
                hardware,
                width,
                height,
                _manager: manager,
                _mf: mf,
            })
        }
    }

    pub fn force_keyframe(&self) {
        if let Some(c) = &self.codec {
            unsafe { set_codec(c, &CODECAPI_AVEncVideoForceKeyFrame, 1) };
        }
    }

    /// Encodes one NV12 frame; `out` receives every finished frame.
    pub fn encode(&mut self, nv12: &[u8], time_100ns: i64, duration_100ns: i64, out: &mut dyn FnMut(Packet)) -> windows::core::Result<()> {
        unsafe {
            let buffer = MFCreateMemoryBuffer(nv12.len() as u32)?;
            let mut ptr = std::ptr::null_mut();
            buffer.Lock(&mut ptr, None, None)?;
            std::ptr::copy_nonoverlapping(nv12.as_ptr(), ptr, nv12.len());
            buffer.Unlock()?;
            buffer.SetCurrentLength(nv12.len() as u32)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(time_100ns)?;
            sample.SetSampleDuration(duration_100ns)?;
            self.encode_sample(&sample, out)
        }
    }

    /// Encodes a sample the caller built (REC: a tracked sample around a DXGI surface, with its time set).
    pub fn encode_sample(&mut self, sample: &IMFSample, out: &mut dyn FnMut(Packet)) -> windows::core::Result<()> {
        unsafe {
            match self.events.clone() {
                // Asynchronous (hardware): only feed input when asked, collect output when announced.
                Some(events) => {
                    while self.need_input == 0 {
                        let ev = events.GetEvent(MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS(0))?;
                        self.handle_event(&ev, out)?;
                    }
                    self.need_input -= 1;
                    self.transform.ProcessInput(0, sample, 0)?;
                    // Pick up anything already finished without waiting.
                    while let Ok(ev) = events.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                        self.handle_event(&ev, out)?;
                    }
                }
                None => {
                    self.transform.ProcessInput(0, sample, 0)?;
                    while let Some(packet) = self.process_output()? {
                        out(packet);
                    }
                }
            }
        }
        Ok(())
    }

    /// Hands out the frames still inside the encoder (the end of a recording). Gives up after half a second: a
    /// driver that never says it's done mustn't hang the recorder.
    pub fn drain(&mut self, out: &mut dyn FnMut(Packet)) -> windows::core::Result<()> {
        unsafe {
            self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)?;
            let Some(events) = self.events.clone() else {
                while let Some(packet) = self.process_output()? {
                    out(packet);
                }
                return Ok(());
            };
            let until = std::time::Instant::now() + std::time::Duration::from_millis(500);
            while std::time::Instant::now() < until {
                match events.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                    Ok(ev) => {
                        if ev.GetType()? == METransformDrainComplete.0 as u32 {
                            break;
                        }
                        self.handle_event(&ev, out)?;
                    }
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(2)),
                }
            }
            Ok(())
        }
    }

    unsafe fn handle_event(&mut self, ev: &IMFMediaEvent, out: &mut dyn FnMut(Packet)) -> windows::core::Result<()> {
        let kind = ev.GetType()?;
        if kind == METransformNeedInput.0 as u32 {
            self.need_input += 1;
        } else if kind == METransformHaveOutput.0 as u32 {
            if let Some(packet) = self.process_output()? {
                out(packet);
            }
        }
        Ok(())
    }

    unsafe fn process_output(&mut self) -> windows::core::Result<Option<Packet>> {
        let sample = if self.provides_samples {
            None
        } else {
            let s = MFCreateSample()?;
            s.AddBuffer(&MFCreateMemoryBuffer(self.output_size)?)?;
            Some(s)
        };
        let mut buf = [MFT_OUTPUT_DATA_BUFFER { dwStreamID: 0, pSample: ManuallyDrop::new(sample), dwStatus: 0, pEvents: ManuallyDrop::new(None) }];
        let mut status = 0u32;
        let result = self.transform.ProcessOutput(0, &mut buf, &mut status);
        let sample = ManuallyDrop::take(&mut buf[0].pSample);
        drop(ManuallyDrop::take(&mut buf[0].pEvents));
        match result {
            Ok(()) => {}
            Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(None),
            Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => {
                // The encoder picked new output parameters; accept them and carry on.
                let t = self.transform.GetOutputAvailableType(0, 0)?;
                self.transform.SetOutputType(0, &t, 0)?;
                return Ok(None);
            }
            Err(e) => return Err(e),
        }
        let Some(sample) = sample else { return Ok(None) };
        let key = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) == 1;
        let time = sample.GetSampleTime().unwrap_or(0);
        let media = sample.ConvertToContiguousBuffer()?;
        let mut ptr = std::ptr::null_mut();
        let mut len = 0u32;
        media.Lock(&mut ptr, None, Some(&mut len))?;
        let mut data = std::slice::from_raw_parts(ptr, len as usize).to_vec();
        media.Unlock()?;
        if key {
            self.ensure_parameter_sets(&mut data);
        }
        Ok(Some(Packet { data, key, time }))
    }

    /// Some encoders only put SPS/PPS in the media type; prepend them so every keyframe is self-contained.
    unsafe fn ensure_parameter_sets(&mut self, frame: &mut Vec<u8>) {
        if has_sps(frame) {
            return;
        }
        if self.sequence_header.is_empty() {
            if let Ok(t) = self.transform.GetOutputCurrentType(0) {
                let mut blob = std::ptr::null_mut();
                let mut size = 0u32;
                if t.GetAllocatedBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut blob, &mut size).is_ok() {
                    self.sequence_header = std::slice::from_raw_parts(blob, size as usize).to_vec();
                    CoTaskMemFree(Some(blob as *const _));
                }
            }
        }
        if !self.sequence_header.is_empty() {
            frame.splice(0..0, self.sequence_header.iter().copied());
        }
    }
}

/// Hardware encoders are asynchronous MFTs and must be unlocked before use.
unsafe fn unlock(transform: &IMFTransform) -> windows::core::Result<()> {
    let attrs = transform.GetAttributes()?;
    attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
    let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
    Ok(())
}

/// Looks for an SPS NAL unit (type 7) among the first few NAL units.
fn has_sps(data: &[u8]) -> bool {
    let mut i = 0;
    while i + 4 < data.len().min(512) {
        if data[i] == 0 && data[i + 1] == 0 && (data[i + 2] == 1 || (data[i + 2] == 0 && data[i + 3] == 1)) {
            let start = if data[i + 2] == 1 { i + 3 } else { i + 4 };
            if data.get(start).is_some_and(|b| b & 0x1f == 7) {
                return true;
            }
            i = start;
        } else {
            i += 1;
        }
    }
    false
}

impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            if let Some(events) = &self.events {
                // Release the async encoder's queue so it doesn't keep the GPU session alive.
                let _ = events.cast::<IMFShutdown>().map(|s| s.Shutdown());
            }
        }
    }
}
