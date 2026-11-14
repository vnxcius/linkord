//! REC's audio (Windows): the game's sound, the microphone and the voice chat, mixed on a wall-clock tick and encoded
//! to AAC: track 0 = the mix (what players play), then one track per source (stems, for the editor's sliders).
//!
//! - Game: process loopback of the game's process tree (Windows 11). Windows 10 can only capture everything the PC
//!   plays, which already holds the voice chat, so the voice source stays off there (it would be heard twice).
//! - Mic: its own WASAPI capture of the device the app uses for voice (by name), so it works outside calls too.
//! - Voice chat: the app's playback worklet makes a separate mix without the people who opted out of being recorded and
//!   sends it here (`push_voice`, from the `rec_voice_audio` command). Nothing comes outside calls: silence.
//!
//! Every source goes through a `mix::Ring`; the mixer pulls 20 ms from each per tick, so gaps become silence and the
//! audio stays on the same clock as the video (both count from the recording's `origin`).

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::aac::{Aac, KBPS_128, KBPS_160};
use super::mix::{self, Ring, CHANNELS, LATENCY, RATE, TICK};
use crate::capture::audio::AudioCapture;
pub use crate::capture::audio::Source;

/// What goes into the recording's audio.
#[derive(Clone, Debug, Default)]
pub struct AudioSettings {
    /// The game's sound.
    pub game: Option<Source>,
    /// The microphone: Some(name) for that device, Some("") for Windows' communications mic, None = off.
    pub mic: Option<String>,
    /// The output device recorded for `Source::System` ('' = the default one).
    pub output: String,
    /// The voice chat (others in the call).
    pub voices: bool,
}

impl AudioSettings {
    /// Audio tracks a recording with these settings has: the mix plus one per source, or none at all.
    pub fn tracks(&self) -> usize {
        let sources = self.game.is_some() as usize + self.mic.is_some() as usize + self.voices as usize;
        if sources == 0 {
            0
        } else {
            1 + sources
        }
    }
}

/// Where encoded audio goes (the recording's segment writer). Called on the mixer thread.
pub trait AudioOut: Send + 'static {
    /// One AAC frame of `track` (0 = mix), `time` in samples since the recording started.
    fn audio(&mut self, track: usize, frame: Vec<u8>, time: u64);
}

/// Per-source volume, changed live (the overlay's mic toggle); stored as f32 bits.
pub struct Gains {
    pub game: AtomicU32,
    pub mic: AtomicU32,
    pub voices: AtomicU32,
}

impl Gains {
    fn new() -> Gains {
        let one = 1.0f32.to_bits();
        Gains { game: AtomicU32::new(one), mic: AtomicU32::new(one), voices: AtomicU32::new(one) }
    }
}

fn gain(a: &AtomicU32) -> f32 {
    f32::from_bits(a.load(Ordering::Relaxed))
}

/// The voice chat ring of the recording in progress, for `push_voice`.
static VOICE: Mutex<Option<Arc<Ring>>> = Mutex::new(None);

/// Voice chat audio from the app: little-endian f32, interleaved stereo, 48 kHz. Ignored when nothing records it.
pub fn push_voice(bytes: &[u8]) {
    if let Some(ring) = VOICE.lock().unwrap().as_ref() {
        ring.push(&mix::f32_from_le(bytes));
    }
}

/// Whether a recording wants the voice chat right now (the app only sends it then).
pub fn wants_voice() -> bool {
    VOICE.lock().unwrap().is_some()
}

pub struct AudioRecorder {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    _captures: Vec<AudioCapture>,
    /// The game's sound: its ring stays (same track), the capture can be swapped (League: client -> game).
    game: Option<(Arc<Ring>, Mutex<Option<AudioCapture>>)>,
    pub gains: Arc<Gains>,
    pub error: Arc<Mutex<Option<String>>>,
    /// The output device for the game's sound when it is the whole PC's (set_game keeps it).
    output: String,
}

enum Kind {
    Game,
    Mic,
    Voice,
}

impl AudioRecorder {
    /// Starts capturing and mixing. A source that can't start (no mic plugged in) records silence rather than failing.
    pub fn start(settings: &AudioSettings, origin: Instant, out: impl AudioOut) -> AudioRecorder {
        let gains = Arc::new(Gains::new());
        let error = Arc::new(Mutex::new(None));
        let mut sources: Vec<(Kind, Arc<Ring>)> = Vec::new();
        let mut captures = Vec::new();
        let mut failed = Vec::new();
        let mut game = None;
        if let Some(source) = settings.game {
            let ring = Arc::new(Ring::new());
            let capture = match game_capture(source, &settings.output, &ring) {
                Ok(c) => Some(c),
                Err(e) => {
                    failed.push(format!("game audio: {e}"));
                    None
                }
            };
            sources.push((Kind::Game, ring.clone()));
            game = Some((ring, Mutex::new(capture)));
        }
        if let Some(name) = settings.mic.clone() {
            let ring = Arc::new(Ring::new());
            let r = ring.clone();
            match AudioCapture::start_mic(Some(name).filter(|n| !n.is_empty()), move |chunk| r.push(&mix::f32_from_le(&chunk))) {
                Ok(c) => captures.push(c),
                Err(e) => failed.push(format!("microphone: {e}")),
            }
            sources.push((Kind::Mic, ring));
        }
        if settings.voices {
            let ring = Arc::new(Ring::new());
            *VOICE.lock().unwrap() = Some(ring.clone());
            sources.push((Kind::Voice, ring));
        }
        if !failed.is_empty() {
            *error.lock().unwrap() = Some(failed.join("; "));
        }
        let stop = Arc::new(AtomicBool::new(false));
        let thread = (!sources.is_empty()).then(|| {
            let (stop, gains, error) = (stop.clone(), gains.clone(), error.clone());
            std::thread::Builder::new().name("pottira-rec-audio".into()).spawn(move || mix_loop(sources, origin, out, &stop, &gains, &error)).ok()
        });
        AudioRecorder { stop, thread: thread.flatten(), _captures: captures, game, gains, error, output: settings.output.clone() }
    }

    /// The game's sound comes from another process now (same track, no gap in the recording).
    pub fn set_game(&self, source: Source) {
        let Some((ring, capture)) = &self.game else { return };
        let mut capture = capture.lock().unwrap();
        // The old one first: one capture feeding the ring at a time.
        drop(capture.take());
        ring.clear();
        match game_capture(source, &self.output, ring) {
            Ok(c) => *capture = Some(c),
            Err(e) => *self.error.lock().unwrap() = Some(format!("game audio: {e}")),
        }
    }
}

fn game_capture(source: Source, output: &str, ring: &Arc<Ring>) -> Result<AudioCapture, String> {
    let r = ring.clone();
    let push = move |chunk: Vec<u8>| r.push(&mix::f32_from_le(&chunk));
    match source {
        Source::System if !output.is_empty() => AudioCapture::start_output(output.to_string(), push),
        _ => AudioCapture::start_quiet(source, push),
    }
}

impl Drop for AudioRecorder {
    fn drop(&mut self) {
        *VOICE.lock().unwrap() = None;
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn mix_loop(sources: Vec<(Kind, Arc<Ring>)>, origin: Instant, mut out: impl AudioOut, stop: &AtomicBool, gains: &Gains, error: &Mutex<Option<String>>) {
    let mut encoders = Vec::with_capacity(sources.len() + 1);
    for i in 0..=sources.len() {
        match Aac::new(if i == 0 { KBPS_160 } else { KBPS_128 }) {
            Ok(e) => encoders.push(e),
            Err(e) => {
                *error.lock().unwrap() = Some(format!("no AAC encoder: {e}"));
                return;
            }
        }
    }
    // Frames handed out per track: the next one's time.
    let mut times = vec![0u64; encoders.len()];
    let mut emit = |track: usize, frame: Vec<u8>, out: &mut dyn AudioOut| {
        out.audio(track, frame, times[track]);
        times[track] += super::vod::AAC_FRAME as u64;
    };
    let mut buffers = vec![vec![0f32; TICK * CHANNELS]; sources.len()];
    let mut mixed = vec![0f32; TICK * CHANNELS];
    let mut pcm = Vec::with_capacity(TICK * CHANNELS);
    let mut produced = 0u64;
    while !stop.load(Ordering::Relaxed) {
        let due = (origin.elapsed().as_secs_f64() * RATE as f64) as u64;
        while produced + TICK as u64 <= due {
            mixed.fill(0.0);
            for ((kind, ring), buf) in sources.iter().zip(buffers.iter_mut()) {
                ring.pull(buf);
                let g = gain(match kind {
                    Kind::Game => &gains.game,
                    Kind::Mic => &gains.mic,
                    Kind::Voice => &gains.voices,
                });
                for s in buf.iter_mut() {
                    *s *= g;
                }
                mix::add(&mut mixed, buf, 1.0);
            }
            produced += TICK as u64;
            // What the sources gave in the first moments was heard before the recording's start (they're ~LATENCY
            // behind): leave it out, so frame 0 of the audio is the moment of the video's frame 0.
            if produced <= LATENCY {
                continue;
            }
            for (track, samples) in std::iter::once(&mixed).chain(buffers.iter()).enumerate() {
                mix::to_pcm16(samples, &mut pcm);
                let mut frames = Vec::new();
                if let Err(e) = encoders[track].encode(&pcm, &mut |f| frames.push(f)) {
                    *error.lock().unwrap() = Some(format!("audio encoding failed: {e}"));
                }
                for f in frames {
                    emit(track, f, &mut out);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    for (track, encoder) in encoders.iter_mut().enumerate() {
        let mut frames = Vec::new();
        let _ = encoder.drain(&mut |f| frames.push(f));
        for f in frames {
            emit(track, f, &mut out);
        }
    }
}
