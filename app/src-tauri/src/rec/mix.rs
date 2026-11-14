//! REC's audio mixing, without Windows APIs (tested anywhere). Sources (game, mic, voice chat) arrive at their own pace
//! into a `Ring` each; the mixer (audio.rs) pulls 20 ms from every ring on a wall-clock tick, so the recording's audio
//! timeline is continuous and lines up with the video's, whatever a source does: a silent game whose loopback sends
//! nothing, a voice chat that only exists during calls, a mic unplugged mid-game.

use std::collections::VecDeque;
use std::sync::Mutex;

pub const RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;
/// One mixer tick: 20 ms.
pub const TICK: usize = 960;
/// A source starts (and restarts after running dry) once this much is buffered: smooths jittery sources (the voice
/// chat comes over the app's IPC) without much delay.
const PRIME: usize = RATE as usize * 40 / 1000;
/// Never more than this buffered: a source that runs fast (its clock drifts) drops its oldest audio.
const MAX: usize = RATE as usize * 300 / 1000;
/// How late mixed audio is compared to when it was heard (priming + the source's own buffering). The mixer writes
/// audio this much earlier so it lines up with the video.
pub const LATENCY: u64 = (PRIME + RATE as usize / 100) as u64;

/// Interleaved stereo f32 from one source.
#[derive(Default)]
pub struct Ring {
    inner: Mutex<RingInner>,
}

#[derive(Default)]
struct RingInner {
    samples: VecDeque<f32>,
    primed: bool,
}

impl Ring {
    pub fn new() -> Ring {
        Ring::default()
    }

    /// Adds interleaved stereo samples.
    pub fn push(&self, samples: &[f32]) {
        let mut r = self.inner.lock().unwrap();
        r.samples.extend(samples.iter().map(|s| if s.is_finite() { *s } else { 0.0 }));
        let max = MAX * CHANNELS;
        if r.samples.len() > max {
            let extra = r.samples.len() - max;
            // Whole frames only, so left and right stay in place.
            r.samples.drain(..extra + extra % CHANNELS);
        }
    }

    /// Fills `out` (interleaved stereo) with the oldest audio, silence where there isn't enough. Returns whether any
    /// audio came out.
    pub fn pull(&self, out: &mut [f32]) -> bool {
        let mut r = self.inner.lock().unwrap();
        if !r.primed {
            if r.samples.len() < PRIME * CHANNELS {
                out.fill(0.0);
                return false;
            }
            r.primed = true;
        }
        let n = out.len().min(r.samples.len());
        for (o, s) in out.iter_mut().zip(r.samples.drain(..n)) {
            *o = s;
        }
        out[n..].fill(0.0);
        if n < out.len() {
            // Ran dry: wait for a cushion again before resuming.
            r.primed = false;
        }
        n > 0
    }

    pub fn clear(&self) {
        let mut r = self.inner.lock().unwrap();
        r.samples.clear();
        r.primed = false;
    }
}

/// Adds `src` x `gain` into `dst`.
pub fn add(dst: &mut [f32], src: &[f32], gain: f32) {
    for (d, s) in dst.iter_mut().zip(src) {
        *d += s * gain;
    }
}

/// Float -> 16-bit PCM (what the AAC encoder takes). Loud mixes are limited softly above 0.9 instead of clipping
/// hard, so a shout over a loud game doesn't crackle.
pub fn to_pcm16(src: &[f32], dst: &mut Vec<i16>) {
    dst.clear();
    dst.extend(src.iter().map(|&s| {
        let a = s.abs();
        let limited = if a <= 0.9 { s } else { s.signum() * (0.9 + 0.1 * ((a - 0.9) / 0.1).tanh()) };
        (limited.clamp(-1.0, 1.0) * 32767.0).round() as i16
    }));
}

/// Little-endian f32 bytes (as sent over IPC) -> samples. A trailing partial sample is ignored.
pub fn f32_from_le(bytes: &[u8]) -> Vec<f32> {
    bytes.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_source_starts_once_primed_and_rebuffers_when_dry() {
        let ring = Ring::new();
        let mut out = vec![1.0; TICK * CHANNELS];
        ring.push(&vec![0.5; (PRIME - 10) * CHANNELS]);
        assert!(!ring.pull(&mut out), "not primed yet");
        assert!(out.iter().all(|s| *s == 0.0));
        ring.push(&[0.5; 10 * CHANNELS]);
        // Primed: 40 ms in, 20 ms out, twice.
        assert!(ring.pull(&mut out));
        assert!(out.iter().all(|s| *s == 0.5));
        assert!(ring.pull(&mut out));
        assert!(out.iter().all(|s| *s == 0.5));
        ring.push(&[0.25; 4]);
        assert!(ring.pull(&mut out), "what's left still plays");
        assert_eq!(&out[..4], &[0.25; 4]);
        assert!(out[4..].iter().all(|s| *s == 0.0));
        ring.push(&[0.25; 4]);
        assert!(!ring.pull(&mut out), "ran dry: needs a cushion first");
    }

    #[test]
    fn a_fast_source_drops_its_oldest_audio_and_keeps_channels_in_place() {
        let ring = Ring::new();
        let frames = MAX + 1001;
        let mut samples = Vec::with_capacity(frames * 2);
        for i in 0..frames {
            samples.push(i as f32);
            samples.push(-(i as f32));
        }
        ring.push(&samples);
        let mut out = vec![0.0; 4];
        ring.pull(&mut out);
        assert_eq!(out[0], 1001.0);
        assert_eq!(out[1], -1001.0);
    }

    #[test]
    fn loud_mixes_are_limited_not_wrapped() {
        let mut pcm = Vec::new();
        to_pcm16(&[0.0, 0.5, -0.5, 0.95, 3.0, -3.0, f32::MAX], &mut pcm);
        assert_eq!(pcm[0], 0);
        assert_eq!(pcm[1], 16384);
        assert_eq!(pcm[2], -16384);
        assert!(pcm[3] > 29490 && pcm[3] < 31130);
        assert!(pcm[4] > 32000 && pcm[5] < -32000);
        assert!(pcm[6] > 0);
    }

    #[test]
    fn ipc_bytes_become_samples_and_bad_values_go_quiet() {
        let mut bytes = Vec::new();
        for v in [0.25f32, -1.0, f32::NAN] {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        bytes.push(7);
        let samples = f32_from_le(&bytes);
        assert_eq!(samples.len(), 3);
        let ring = Ring::new();
        ring.push(&samples);
        ring.push(&vec![0.0; PRIME * 2]);
        let mut out = vec![9.0; 4];
        ring.pull(&mut out);
        assert_eq!(out, [0.25, -1.0, 0.0, 0.0]);
    }
}
