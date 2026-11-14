//! AAC-LC through Windows' own encoder (Media Foundation), 48 kHz stereo, one raw AAC frame (1024 samples) per output.
//! Synchronous and cheap (about 1% of a core per track), so it runs on the mixer thread.

use std::mem::ManuallyDrop;

use windows::core::Interface;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::CoTaskMemFree;

use crate::capture::encoder::MfSession;

pub struct Aac {
    transform: IMFTransform,
    output_size: u32,
    provides_samples: bool,
    /// Stereo frames given so far: input samples need a time (100 ns units).
    frames_in: u64,
    // Last, so it is released after the transform.
    _mf: MfSession,
}

/// Bitrates Windows' AAC encoder accepts, in bytes per second.
pub const KBPS_128: u32 = 16_000;
pub const KBPS_160: u32 = 20_000;

impl Aac {
    pub fn new(bytes_per_second: u32) -> windows::core::Result<Aac> {
        unsafe {
            let mf = MfSession::start()?;
            let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Audio, guidSubtype: MFAudioFormat_PCM };
            let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Audio, guidSubtype: MFAudioFormat_AAC };
            let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
            let mut count = 0u32;
            MFTEnumEx(MFT_CATEGORY_AUDIO_ENCODER, MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER, Some(&input), Some(&output), &mut activates, &mut count)?;
            let list = std::slice::from_raw_parts_mut(activates, count as usize);
            let transform = list.iter_mut().filter_map(Option::take).find_map(|a| a.ActivateObject::<IMFTransform>().ok());
            CoTaskMemFree(Some(activates as *const _));
            let transform = transform.ok_or_else(|| windows::core::Error::from(MF_E_TOPO_CODEC_NOT_FOUND))?;

            let pcm = MFCreateMediaType()?;
            pcm.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            pcm.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
            pcm.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            pcm.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 48_000)?;
            pcm.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)?;
            pcm.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 4)?;
            pcm.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 192_000)?;
            transform.SetInputType(0, &pcm, 0)?;

            let aac = MFCreateMediaType()?;
            aac.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            aac.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
            aac.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            aac.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 48_000)?;
            aac.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)?;
            aac.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, bytes_per_second)?;
            // Raw frames (the MP4 holds the config), AAC-LC.
            aac.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)?;
            aac.SetUINT32(&MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29)?;
            transform.SetOutputType(0, &aac, 0)?;

            let info = transform.GetOutputStreamInfo(0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            Ok(Aac {
                transform,
                output_size: info.cbSize.max(8192),
                provides_samples: info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 != 0,
                frames_in: 0,
                _mf: mf,
            })
        }
    }

    /// Encodes interleaved stereo 16-bit PCM (any length); `out` gets every finished AAC frame.
    pub fn encode(&mut self, pcm: &[i16], out: &mut dyn FnMut(Vec<u8>)) -> windows::core::Result<()> {
        unsafe {
            let bytes = std::mem::size_of_val(pcm);
            let buffer = MFCreateMemoryBuffer(bytes as u32)?;
            let mut ptr = std::ptr::null_mut();
            buffer.Lock(&mut ptr, None, None)?;
            std::ptr::copy_nonoverlapping(pcm.as_ptr() as *const u8, ptr, bytes);
            buffer.Unlock()?;
            buffer.SetCurrentLength(bytes as u32)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            let frames = (pcm.len() / 2) as u64;
            sample.SetSampleTime((self.frames_in * 10_000_000 / 48_000) as i64)?;
            sample.SetSampleDuration((frames * 10_000_000 / 48_000) as i64)?;
            self.frames_in += frames;
            if let Err(e) = self.transform.ProcessInput(0, &sample, 0) {
                if e.code() != MF_E_NOTACCEPTING {
                    return Err(e);
                }
                // Full: take what's ready, then it accepts.
                self.collect(out)?;
                self.transform.ProcessInput(0, &sample, 0)?;
            }
            self.collect(out)
        }
    }

    /// Hands out what's still inside (the end of a recording).
    pub fn drain(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> windows::core::Result<()> {
        unsafe {
            self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)?;
            self.collect(out)
        }
    }

    unsafe fn collect(&mut self, out: &mut dyn FnMut(Vec<u8>)) -> windows::core::Result<()> {
        loop {
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
                Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => return Ok(()),
                Err(e) => return Err(e),
            }
            let Some(sample) = sample else { continue };
            let media = sample.ConvertToContiguousBuffer()?;
            let mut ptr = std::ptr::null_mut();
            let mut len = 0u32;
            media.Lock(&mut ptr, None, Some(&mut len))?;
            let frame = std::slice::from_raw_parts(ptr, len as usize).to_vec();
            media.Unlock()?;
            if !frame.is_empty() {
                out(frame);
            }
        }
    }
}

impl Drop for Aac {
    fn drop(&mut self) {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.transform.cast::<IMFShutdown>().map(|s| s.Shutdown());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_of_tone_comes_out_as_about_47_frames() {
        let mut aac = Aac::new(KBPS_160).expect("Windows has an AAC encoder");
        let pcm: Vec<i16> = (0..48_000 * 2).map(|i| ((i / 2) as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin()).map(|s| (s * 8000.0) as i16).collect();
        let mut frames = Vec::new();
        for chunk in pcm.chunks(960 * 2) {
            aac.encode(chunk, &mut |f| frames.push(f)).unwrap();
        }
        aac.drain(&mut |f| frames.push(f)).unwrap();
        // 48000 / 1024 = 46.9, plus the encoder's priming frame.
        assert!((46..=49).contains(&frames.len()), "{} frames", frames.len());
        let bytes: usize = frames.iter().map(Vec::len).sum();
        assert!((15_000..25_000).contains(&bytes), "about 160 kbit/s, got {bytes} bytes");
    }
}
