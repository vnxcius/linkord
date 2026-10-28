//! H.264 encoding through Media Foundation. Prefers the GPU's hardware encoder (NVENC, AMF, Quick Sync
//! all register as MF transforms) and falls back to Microsoft's software encoder.
//! Output is Annex B byte stream; SPS/PPS are guaranteed in front of every keyframe so viewers can
//! start decoding at any keyframe.

use std::mem::ManuallyDrop;

use windows::core::{Interface, GUID};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VARIANT;

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
    // Last, so it is released after the transform (fields drop in declaration order).
    _mf: MfSession,
}

/// Media Foundation (and COM on this thread) for as long as an encoder lives: every MFStartup needs its
/// MFShutdown, and encoders are rebuilt on every quality or size change.
struct MfSession {
    com: bool,
}

impl MfSession {
    unsafe fn start() -> windows::core::Result<MfSession> {
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

unsafe fn find_encoder(hardware: bool) -> windows::core::Result<Option<IMFTransform>> {
    let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
    let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
    let flags = if hardware { MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER } else { MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER };
    let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;
    MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags, Some(&input), Some(&output), &mut activates, &mut count)?;
    let list = std::slice::from_raw_parts_mut(activates, count as usize);
    let mut found = None;
    for a in list.iter_mut() {
        if let Some(act) = a.take() {
            if found.is_none() {
                found = act.ActivateObject::<IMFTransform>().ok();
            }
        }
    }
    CoTaskMemFree(Some(activates as *const _));
    Ok(found)
}

unsafe fn set_codec(codec: &ICodecAPI, api: &GUID, value: u32) {
    // Not every encoder supports every knob; unsupported ones are simply skipped.
    let _ = codec.SetValue(api, &VARIANT::from(value));
}

impl Encoder {
    pub fn new(width: u32, height: u32, fps: u32, bitrate: u32) -> windows::core::Result<Encoder> {
        unsafe {
            let mf = MfSession::start()?;
            let (transform, hardware) = match find_encoder(true)? {
                Some(t) => (t, true),
                None => (find_encoder(false)?.ok_or_else(|| windows::core::Error::from(MF_E_TOPO_CODEC_NOT_FOUND))?, false),
            };
            if hardware {
                // Hardware encoders are asynchronous MFTs and must be unlocked before use.
                let attrs = transform.GetAttributes()?;
                attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
                let _ = attrs.SetUINT32(&MF_LOW_LATENCY, 1);
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
            transform.SetOutputType(0, &out, 0)?;

            let inp = MFCreateMediaType()?;
            inp.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            inp.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            inp.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
            inp.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
            inp.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
            inp.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            inp.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
            transform.SetInputType(0, &inp, 0)?;

            // Streaming settings: constant bitrate (predictable for the relay), lowest latency,
            // no B-frames, and rare periodic keyframes (viewers request one when they need it).
            let codec = transform.cast::<ICodecAPI>().ok();
            if let Some(c) = &codec {
                set_codec(c, &CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR.0 as u32);
                set_codec(c, &CODECAPI_AVEncCommonMeanBitRate, bitrate);
                set_codec(c, &CODECAPI_AVLowLatencyMode, 1);
                set_codec(c, &CODECAPI_AVEncMPVDefaultBPictureCount, 0);
                set_codec(c, &CODECAPI_AVEncMPVGOPSize, fps * 10);
                set_codec(c, &CODECAPI_AVEncCommonQualityVsSpeed, 70);
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
                _mf: mf,
            })
        }
    }

    pub fn force_keyframe(&self) {
        if let Some(c) = &self.codec {
            unsafe { set_codec(c, &CODECAPI_AVEncVideoForceKeyFrame, 1) };
        }
    }

    /// Encodes one NV12 frame; `out` receives every finished frame as (annex-b data, is_keyframe).
    pub fn encode(&mut self, nv12: &[u8], time_100ns: i64, duration_100ns: i64, out: &mut dyn FnMut(Vec<u8>, bool)) -> windows::core::Result<()> {
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

            match self.events.clone() {
                // Asynchronous (hardware): only feed input when asked, collect output when announced.
                Some(events) => {
                    while self.need_input == 0 {
                        let ev = events.GetEvent(MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS(0))?;
                        self.handle_event(&ev, out)?;
                    }
                    self.need_input -= 1;
                    self.transform.ProcessInput(0, &sample, 0)?;
                    // Pick up anything already finished without waiting.
                    while let Ok(ev) = events.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                        self.handle_event(&ev, out)?;
                    }
                }
                None => {
                    self.transform.ProcessInput(0, &sample, 0)?;
                    while let Some((data, key)) = self.process_output()? {
                        out(data, key);
                    }
                }
            }
        }
        Ok(())
    }

    unsafe fn handle_event(&mut self, ev: &IMFMediaEvent, out: &mut dyn FnMut(Vec<u8>, bool)) -> windows::core::Result<()> {
        let kind = ev.GetType()?;
        if kind == METransformNeedInput.0 as u32 {
            self.need_input += 1;
        } else if kind == METransformHaveOutput.0 as u32 {
            if let Some((data, key)) = self.process_output()? {
                out(data, key);
            }
        }
        Ok(())
    }

    unsafe fn process_output(&mut self) -> windows::core::Result<Option<(Vec<u8>, bool)>> {
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
        let media = sample.ConvertToContiguousBuffer()?;
        let mut ptr = std::ptr::null_mut();
        let mut len = 0u32;
        media.Lock(&mut ptr, None, Some(&mut len))?;
        let mut data = std::slice::from_raw_parts(ptr, len as usize).to_vec();
        media.Unlock()?;
        if key {
            self.ensure_parameter_sets(&mut data);
        }
        Ok(Some((data, key)))
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
