//! A recording on disk, one folder:
//! - `NN-init.mp4` + `NN-NNNNNN.m4s` (part, segment): video and the audio mix, what players play (MSE takes them as
//!   they are). A new part starts whenever the encoder does (its parameter sets may change).
//! - `NN-stems.mp4` + `NN-NNNNNN.stems.m4s`: each audio source on its own (game, mic, voice chat), for the editor's
//!   volume sliders. Kept apart so the playable files have one audio track (players only play the first).
//!
//! Segments are ~2 s and each starts on a video keyframe. Times are relative to the start of the recording, so parts
//! follow each other on one timeline. A closed segment waits (up to 3 s) for audio to catch up before it's written,
//! since audio comes from other threads.
//!
//! `Writer` turns encoder output into segments; `export` copies a time range out into one MP4 (a clip).
//! No Windows APIs here.

use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use super::mp4::{self, Codec, Export, Run, Sample, SampleRef, Track, VIDEO_TIMESCALE};

/// A segment closes at the first keyframe after this much video.
const SEGMENT_TICKS: u64 = 2 * VIDEO_TIMESCALE as u64;
/// Longest a closed segment waits for audio to catch up (audio that stopped coming mustn't stop the recording).
const AUDIO_WAIT_TICKS: u64 = 3 * VIDEO_TIMESCALE as u64;
const VIDEO_TRACK: u32 = 1;
const MIX_TRACK: u32 = 2;
pub const AUDIO_TIMESCALE: u32 = 48_000;
/// AAC-LC, 48 kHz, stereo (AudioSpecificConfig).
pub const AAC_CONFIG: [u8; 2] = [0x11, 0x90];
/// Samples per AAC frame.
pub const AAC_FRAME: u32 = 1024;

/// 100 ns units (Media Foundation) -> video ticks.
pub fn ticks(time_100ns: i64) -> u64 {
    (time_100ns.max(0) as u64) * VIDEO_TIMESCALE as u64 / 10_000_000
}

/// Audio time (48 kHz samples) -> video ticks (90 kHz).
fn audio_ticks(time: u64) -> u64 {
    time * 15 / 8
}

fn aac_track(id: u32) -> Track {
    Track { id, timescale: AUDIO_TIMESCALE, codec: Codec::Aac { config: AAC_CONFIG.to_vec(), channels: 2, sample_rate: AUDIO_TIMESCALE } }
}

#[derive(Default)]
struct AudioState {
    /// (time in samples, AAC frame), not yet written.
    pending: VecDeque<(u64, Vec<u8>)>,
    /// End of the newest frame received.
    end: u64,
}

/// A closed video segment waiting for its audio.
struct Closed {
    name: String,
    start: u64,
    end: u64,
    samples: Vec<Sample>,
}

pub struct Writer {
    dir: PathBuf,
    /// Duration of the last frame of a part (its real one isn't known): one frame at the target rate.
    frame_ticks: u32,
    part: u32,
    size: (u16, u16),
    init: Option<Track>,
    /// The newest frame: its duration is only known when the next one arrives.
    held: Option<(Vec<u8>, bool, u64)>,
    pending: Vec<Sample>,
    pending_start: u64,
    pending_ticks: u64,
    index: u32,
    sequence: u32,
    /// [0] = the mix, then the stems.
    audio: Vec<AudioState>,
    closed: VecDeque<Closed>,
    /// Newest video time seen.
    video_end: u64,
    /// Close the segment at the next keyframe, however short (a clip wants everything up to now on disk).
    cut: bool,
    /// Where the written segments end (video ticks).
    written_end: u64,
    /// The first error writing to disk; nothing more is written after it.
    pub error: Option<io::Error>,
}

impl Writer {
    /// `audio_tracks`: 0 = video only, 1 = video + mix, n = video + mix + n - 1 stems.
    pub fn new(dir: PathBuf, fps: u32, audio_tracks: usize) -> io::Result<Writer> {
        fs::create_dir_all(&dir)?;
        Ok(Writer {
            dir,
            frame_ticks: VIDEO_TIMESCALE / fps.max(1),
            part: 0,
            size: (0, 0),
            init: None,
            held: None,
            pending: Vec::new(),
            pending_start: 0,
            pending_ticks: 0,
            index: 0,
            sequence: 0,
            audio: (0..audio_tracks).map(|_| AudioState::default()).collect(),
            closed: VecDeque::new(),
            video_end: 0,
            cut: false,
            written_end: 0,
            error: None,
        })
    }

    /// A new encoder starts: what follows is a new part.
    pub fn start(&mut self, width: u32, height: u32) {
        self.end_part();
        self.part += 1;
        self.index = 0;
        self.size = (width.min(u16::MAX as u32) as u16, height.min(u16::MAX as u32) as u16);
    }

    /// One encoded frame (Annex B), `time` in video ticks from the start of the recording.
    pub fn frame(&mut self, annexb: &[u8], key: bool, time: u64) {
        let (data, sps, pps) = mp4::annexb_to_sample(annexb);
        if self.init.is_none() {
            // A part starts at a keyframe carrying its parameter sets.
            let (Some(sps), Some(pps), true) = (sps, pps, key) else { return };
            let video = Track { id: VIDEO_TRACK, timescale: VIDEO_TIMESCALE, codec: Codec::Avc { width: self.size.0, height: self.size.1, sps, pps } };
            let mut tracks = vec![video.clone()];
            if !self.audio.is_empty() {
                tracks.push(aac_track(MIX_TRACK));
            }
            let init = mp4::init_segment(&tracks);
            self.write(&format!("{:02}-init.mp4", self.part), &init);
            if self.audio.len() > 1 {
                let stems: Vec<Track> = (1..self.audio.len() as u32).map(aac_track).collect();
                let init = mp4::init_segment(&stems);
                self.write(&format!("{:02}-stems.mp4", self.part), &init);
            }
            self.init = Some(video);
        }
        if let Some((data, key, at)) = self.held.take() {
            let duration = time.saturating_sub(at).clamp(1, u32::MAX as u64) as u32;
            self.push(Sample { data, duration, key }, at);
        }
        self.held = Some((data, key, time));
        self.video_end = self.video_end.max(time);
        self.write_ready(false);
    }

    /// One AAC frame of audio track `index` (0 = mix), `time` in samples from the start of the recording.
    pub fn audio(&mut self, index: usize, frame: Vec<u8>, time: u64) {
        let Some(a) = self.audio.get_mut(index) else { return };
        a.end = a.end.max(time + AAC_FRAME as u64);
        a.pending.push_back((time, frame));
        self.write_ready(false);
    }

    fn push(&mut self, sample: Sample, at: u64) {
        if sample.key && (self.pending_ticks >= SEGMENT_TICKS || self.cut) {
            self.close();
            self.cut = false;
        }
        if self.pending.is_empty() {
            self.pending_start = at;
            self.pending_ticks = 0;
        }
        self.pending_ticks += sample.duration as u64;
        self.pending.push(sample);
    }

    fn close(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let name = format!("{:02}-{:06}", self.part, self.index);
        self.index += 1;
        let samples = std::mem::take(&mut self.pending);
        self.closed.push_back(Closed { name, start: self.pending_start, end: self.pending_start + self.pending_ticks, samples });
        self.pending_ticks = 0;
    }

    /// Writes the closed segments whose audio is in (or has waited long enough, or `all`).
    fn write_ready(&mut self, all: bool) {
        while let Some(front) = self.closed.front() {
            let audio_in = self.audio.iter().all(|a| audio_ticks(a.end) >= front.end);
            let waited = self.video_end.saturating_sub(front.end) > AUDIO_WAIT_TICKS;
            if !(all || audio_in || waited) {
                return;
            }
            let seg = self.closed.pop_front().unwrap();
            // Each audio track's frames that start before the segment's video ends.
            let mut tracks: Vec<(u64, Vec<Sample>)> = Vec::new();
            for a in &mut self.audio {
                let mut frames: Vec<(u64, Vec<u8>)> = Vec::new();
                while a.pending.front().is_some_and(|(t, _)| audio_ticks(*t) < seg.end) {
                    frames.push(a.pending.pop_front().unwrap());
                }
                let start = frames.first().map_or(0, |f| f.0);
                let samples = frames
                    .iter()
                    .enumerate()
                    .map(|(i, (t, data))| {
                        let next = frames.get(i + 1).map_or(t + AAC_FRAME as u64, |n| n.0);
                        Sample { data: data.clone(), duration: next.saturating_sub(*t).clamp(1, u32::MAX as u64) as u32, key: true }
                    })
                    .collect();
                tracks.push((start, samples));
            }
            self.sequence += 1;
            let mut runs: Vec<(u32, u64, &[Sample])> = vec![(VIDEO_TRACK, seg.start, &seg.samples)];
            if let Some((start, samples)) = tracks.first().filter(|t| !t.1.is_empty()) {
                runs.push((MIX_TRACK, *start, samples));
            }
            let main = mp4::media_segment(self.sequence, &runs);
            self.write(&format!("{}.m4s", seg.name), &main);
            self.written_end = self.written_end.max(seg.end);
            let stems: Vec<(u32, u64, &[Sample])> =
                tracks.iter().enumerate().skip(1).filter(|(_, t)| !t.1.is_empty()).map(|(i, (start, samples))| (i as u32, *start, samples.as_slice())).collect();
            if !stems.is_empty() {
                let file = mp4::media_segment(self.sequence, &stems);
                self.write(&format!("{}.stems.m4s", seg.name), &file);
            }
        }
    }

    fn end_part(&mut self) {
        if let Some((data, key, at)) = self.held.take() {
            self.push(Sample { data, duration: self.frame_ticks, key }, at);
        }
        self.close();
        self.init = None;
    }

    /// Written whole under a temporary name first: a crash never leaves half a segment that looks complete.
    fn write(&mut self, name: &str, data: &[u8]) {
        if self.error.is_some() {
            return;
        }
        let path = self.dir.join(name);
        let tmp = path.with_extension("tmp");
        if let Err(e) = fs::write(&tmp, data).and_then(|_| fs::rename(&tmp, &path)) {
            let _ = fs::remove_file(&tmp);
            self.error = Some(e);
        }
    }

    /// The segment being filled ends at the next keyframe (ask the encoder for one too).
    pub fn cut_soon(&mut self) {
        self.cut = true;
    }

    /// Up to where (video ticks) the recording is on disk.
    pub fn written_end(&self) -> u64 {
        self.written_end
    }

    /// Writes everything still held. Also done on drop.
    pub fn finish(&mut self) {
        self.end_part();
        self.write_ready(true);
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        self.finish();
    }
}

/// One part of a recording as read back: its playable tracks (video, maybe the mix) and segments.
struct Part {
    tracks: Vec<Track>,
    /// (file, runs with offsets into that file)
    segments: Vec<(PathBuf, Vec<Run>)>,
}

impl Part {
    fn run(&self, segment: usize, track: u32) -> Option<&Run> {
        self.segments[segment].1.iter().find(|r| r.track_id == track)
    }
}

fn parts(dir: &Path) -> io::Result<Vec<Part>> {
    let mut names: Vec<String> = fs::read_dir(dir)?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| (n.ends_with("-init.mp4") || n.ends_with(".m4s")) && !n.contains("stems"))
        .collect();
    // Each part's init before its segments ("01-000000.m4s" would sort before "01-init.mp4").
    names.sort_by_key(|n| (n.split('-').next().unwrap_or("").to_string(), !n.ends_with("-init.mp4"), n.clone()));
    let mut parts: Vec<Part> = Vec::new();
    for name in names {
        let path = dir.join(&name);
        if name.ends_with("-init.mp4") {
            let tracks = mp4::parse_init(&fs::read(&path)?).map_err(io::Error::other)?;
            if tracks.iter().any(|t| t.id == VIDEO_TRACK) {
                parts.push(Part { tracks, segments: Vec::new() });
            }
        } else {
            let Some(part) = parts.last_mut() else { continue };
            // A damaged segment (power cut) is skipped, not the whole recording.
            let Ok(runs) = read_runs(&path) else { continue };
            if runs.iter().any(|r| r.track_id == VIDEO_TRACK) {
                part.segments.push((path, runs));
            }
        }
    }
    Ok(parts)
}

/// A segment file's samples, reading only its moof (at the start).
fn read_runs(path: &Path) -> io::Result<Vec<Run>> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let mut head = [0u8; 8];
    file.read_exact(&mut head)?;
    let size = (u32::from_be_bytes(head[..4].try_into().unwrap()) as usize).clamp(8, 16 << 20);
    let mut moof = vec![0u8; size];
    moof[..8].copy_from_slice(&head);
    file.read_exact(&mut moof[8..])?;
    mp4::parse_segment_head(&moof, len).map_err(io::Error::other)
}

/// How long the recording in `dir` is, in video ticks (from its start to the end of its last frame).
pub fn duration(dir: &Path) -> io::Result<u64> {
    let parts = parts(dir)?;
    Ok(parts
        .iter()
        .flat_map(|p| (0..p.segments.len()).rev().find_map(|s| p.run(s, VIDEO_TRACK)))
        .map(|run| run.start + run.samples.iter().map(|s| s.duration as u64).sum::<u64>())
        .max()
        .unwrap_or(0))
}

/// One part of a recording for the player: its init file, the codecs to tell Media Source Extensions, and its
/// segments with their times (ms from the start of the recording).
#[derive(serde::Serialize)]
pub struct PartIndex {
    pub init: String,
    pub codecs: String,
    pub segments: Vec<SegmentIndex>,
}

#[derive(serde::Serialize)]
pub struct SegmentIndex {
    pub path: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// What the player needs to play the recording in `dir` (reads only the segments' heads).
pub fn index(dir: &Path) -> io::Result<Vec<PartIndex>> {
    // One listing gives names and sizes (no file opened); segments the saved index already knows at that size skip
    // their read. A long VOD's thousands of segments took seconds to open one by one (Windows scans every open).
    let mut cache: IndexCache = fs::read(dir.join(INDEX_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(|c: &IndexCache| c.version == INDEX_VERSION)
        .unwrap_or_default();
    let mut fresh: std::collections::HashMap<String, CachedSegment> = std::collections::HashMap::new();
    let mut read_any = false;
    let mut files: Vec<(String, u64)> = fs::read_dir(dir)?
        .filter_map(|e| {
            let e = e.ok()?;
            let name = e.file_name().into_string().ok()?;
            ((name.ends_with("-init.mp4") || name.ends_with(".m4s")) && !name.contains("stems")).then(|| (name, e.metadata().map(|m| m.len()).unwrap_or(0)))
        })
        .collect();
    // Each part's init before its segments ("01-000000.m4s" would sort before "01-init.mp4").
    files.sort_by_key(|(n, _)| (n.split('-').next().unwrap_or("").to_string(), !n.ends_with("-init.mp4"), n.clone()));

    let ms = |ticks: u64| ticks * 1000 / VIDEO_TIMESCALE as u64;
    let mut out: Vec<PartIndex> = Vec::new();
    for (name, size) in files {
        let path = dir.join(&name);
        if name.ends_with("-init.mp4") {
            let tracks = mp4::parse_init(&fs::read(&path)?).map_err(io::Error::other)?;
            let Some(Codec::Avc { sps, .. }) = tracks.iter().find(|t| t.id == VIDEO_TRACK).map(|t| &t.codec) else { continue };
            let avc = format!("avc1.{:02x}{:02x}{:02x}", sps.get(1).copied().unwrap_or(0x64), sps.get(2).copied().unwrap_or(0), sps.get(3).copied().unwrap_or(0x2a));
            let codecs = if tracks.iter().any(|t| t.id == MIX_TRACK) { format!("{avc},mp4a.40.2") } else { avc };
            out.push(PartIndex { init: path.display().to_string(), codecs, segments: Vec::new() });
            continue;
        }
        let Some(part) = out.last_mut() else { continue };
        let known = cache.segments.remove(&name).filter(|c| c.size == size);
        let seg = match known {
            Some(c) => c,
            None => {
                // A damaged segment (power cut), or one without video, is skipped, not the whole recording.
                let Ok(runs) = read_runs(&path) else { continue };
                let Some(run) = runs.iter().find(|r| r.track_id == VIDEO_TRACK) else { continue };
                read_any = true;
                CachedSegment { size, start: run.start, end: run.start + run.samples.iter().map(|x| x.duration as u64).sum::<u64>() }
            }
        };
        part.segments.push(SegmentIndex { path: path.display().to_string(), start_ms: ms(seg.start), end_ms: ms(seg.end) });
        fresh.insert(name, seg);
    }
    // Something new was read, or files went away: save what's there now (written aside, then swapped in).
    if read_any || !cache.segments.is_empty() {
        let saved = IndexCache { version: INDEX_VERSION, segments: fresh };
        if let Ok(bytes) = serde_json::to_vec(&saved) {
            let tmp = dir.join(format!("{INDEX_FILE}.tmp"));
            if fs::write(&tmp, bytes).and_then(|_| fs::rename(&tmp, dir.join(INDEX_FILE))).is_err() {
                let _ = fs::remove_file(&tmp);
            }
        }
    }
    Ok(out)
}

/// Each segment's place on the timeline, saved in the VOD's folder by [index] so the next opening doesn't read every
/// segment again. Keyed by file name, valid while the file keeps its size.
const INDEX_FILE: &str = "index.json";
const INDEX_VERSION: u32 = 1;

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct IndexCache {
    version: u32,
    segments: std::collections::HashMap<String, CachedSegment>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
struct CachedSegment {
    size: u64,
    /// Video ticks.
    start: u64,
    end: u64,
}

/// Every sample of `track` in a part: (segment, time, sample).
fn samples_of(part: &Part, track: u32) -> Vec<(usize, u64, SampleRef)> {
    let mut all = Vec::new();
    for s in 0..part.segments.len() {
        let Some(run) = part.run(s, track) else { continue };
        let mut t = run.start;
        for sample in &run.samples {
            all.push((s, t, *sample));
            t += sample.duration as u64;
        }
    }
    all
}

/// Copies `from..to` (video ticks) of the recording in `dir` into one MP4 at `out` (video + the audio mix), without
/// re-encoding. The video begins at the keyframe before `from`; the part up to `from` is hidden by edit lists. Stays
/// within the part holding `from`. Returns the size written.
pub fn export(dir: &Path, from: u64, to: u64, out: &Path) -> io::Result<u64> {
    let nothing = || io::Error::new(io::ErrorKind::NotFound, "nothing recorded there");
    let parts = parts(dir)?;
    let first_tick = |p: &Part| p.run(0, VIDEO_TRACK).map_or(u64::MAX, |r| r.start);
    let part = parts.iter().rev().find(|p| !p.segments.is_empty() && first_tick(p) <= from).or_else(|| parts.iter().find(|p| !p.segments.is_empty())).ok_or_else(nothing)?;
    let from = from.max(first_tick(part));

    let video = samples_of(part, VIDEO_TRACK);
    let first = video.iter().rposition(|(_, t, s)| s.key && *t <= from).ok_or_else(nothing)?;
    let video: Vec<_> = video[first..].iter().copied().take_while(|(_, t, _)| *t < to).collect();
    let Some(&(_, start, _)) = video.first() else { return Err(nothing()) };

    let mut tracks = vec![part.tracks.iter().find(|t| t.id == VIDEO_TRACK).cloned().ok_or_else(nothing)?];
    let mut chosen = vec![video];
    let mut skip = vec![from - start];
    if let Some(mix) = part.tracks.iter().find(|t| t.id == MIX_TRACK) {
        // The audio of the same stretch: from the video's first frame (so the edit lists cut both at `from`).
        let audio: Vec<_> = samples_of(part, MIX_TRACK).into_iter().filter(|(_, t, _)| audio_ticks(*t) + audio_ticks(AAC_FRAME as u64) > start && audio_ticks(*t) < to).collect();
        if let Some(&(_, audio_start, _)) = audio.first() {
            tracks.push(mix.clone());
            skip.push((from * 8 / 15).saturating_sub(audio_start));
            chosen.push(audio);
        }
    }

    let samples: Vec<Vec<SampleRef>> = chosen.iter().map(|c| c.iter().map(|x| x.2).collect()).collect();
    let export = Export { tracks: &tracks, samples: &samples, skip: &skip };
    let tmp = out.with_extension("part");
    let mut writer = BufWriter::with_capacity(1 << 20, File::create(&tmp)?);
    let mut open: Option<(usize, File)> = None;
    let mut buf = Vec::new();
    // Within a track, samples are copied in order: count them per track to find each one's file.
    let mut next = vec![0usize; chosen.len()];
    let result = mp4::write_mp4(&mut writer, &export, |w, track, s| {
        let segment = chosen[track][next[track]].0;
        next[track] += 1;
        if open.as_ref().is_none_or(|(i, _)| *i != segment) {
            open = Some((segment, File::open(&part.segments[segment].0)?));
        }
        let file = &mut open.as_mut().unwrap().1;
        file.seek(SeekFrom::Start(s.offset))?;
        buf.resize(s.size as usize, 0);
        file.read_exact(&mut buf)?;
        w.write_all(&buf)
    })
    .and_then(|size| writer.flush().map(|_| size));
    drop(writer);
    match result {
        Ok(size) => {
            fs::rename(&tmp, out)?;
            Ok(size)
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An Annex B frame: SPS + PPS before keyframes, like the encoder. The number is carried in two bytes that are
    /// never zero, so it can't look like a start code.
    fn frame(n: u32, key: bool) -> Vec<u8> {
        let mut f = Vec::new();
        if key {
            f.extend_from_slice(&[0, 0, 0, 1, 0x67, 100, 0, 41, 9, 0, 0, 0, 1, 0x68, 1, 2]);
        }
        f.extend_from_slice(&[0, 0, 0, 1, if key { 0x65 } else { 0x41 }]);
        f.extend_from_slice(&[0x80 | (n >> 7) as u8, 0x80 | (n & 0x7f) as u8]);
        f
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("linkord-rec-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    /// 10 s at 30 fps, keyframe every second; frame n carries n.
    fn record(dir: &Path) {
        let mut w = Writer::new(dir.to_path_buf(), 30, 0).unwrap();
        w.start(1280, 720);
        for n in 0..300u32 {
            w.frame(&frame(n, n % 30 == 0), n % 30 == 0, n as u64 * 3000);
        }
        w.finish();
        assert!(w.error.is_none());
    }

    #[test]
    fn recordings_are_cut_in_segments_that_start_on_keyframes() {
        let dir = temp("segments");
        record(&dir);
        let parts = parts(&dir).unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].segments.len(), 5, "2 s each");
        for s in 0..5 {
            let run = parts[0].run(s, VIDEO_TRACK).unwrap();
            assert!(run.samples[0].key);
            assert_eq!(run.start % (2 * VIDEO_TIMESCALE as u64), 0);
        }
        assert_eq!(duration(&dir).unwrap(), 300 * 3000);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn segments_wait_for_late_audio_and_clips_carry_the_mix() {
        let dir = temp("audio");
        let mut w = Writer::new(dir.clone(), 30, 2).unwrap();
        w.start(1280, 720);
        let mut next = 0u64;
        let mut audio_until = |w: &mut Writer, until: u64| {
            while next + AAC_FRAME as u64 <= until {
                w.audio(0, vec![0xa0, 1], next);
                w.audio(1, vec![0xb0, 2], next);
                next += AAC_FRAME as u64;
            }
        };
        for n in 0..300u32 {
            let t = n as u64 * 3000;
            w.frame(&frame(n, n % 30 == 0), n % 30 == 0, t);
            // Audio comes half a second behind the video, as from another thread.
            audio_until(&mut w, (t * 8 / 15).saturating_sub(24_000));
        }
        audio_until(&mut w, 10 * 48_000 + AAC_FRAME as u64);
        w.finish();
        assert!(w.error.is_none());

        let parts = parts(&dir).unwrap();
        assert_eq!(parts[0].tracks.len(), 2, "video + mix in the playable files");
        assert_eq!(parts[0].segments.len(), 5);
        for s in 0..5 {
            let v = parts[0].run(s, VIDEO_TRACK).unwrap();
            let a = parts[0].run(s, MIX_TRACK).expect("every segment has its audio");
            let v_end = v.start + v.samples.iter().map(|x| x.duration as u64).sum::<u64>();
            let a_end = a.start + a.samples.iter().map(|x| x.duration as u64).sum::<u64>();
            assert!(audio_ticks(a.start) >= v.start && audio_ticks(a.start) < v.start + audio_ticks(AAC_FRAME as u64), "segment {s} audio starts with its video");
            assert!(audio_ticks(a_end) >= v_end, "segment {s} audio lasts as long as its video");
        }
        let stems = fs::read_dir(&dir).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".stems.m4s")).count();
        assert_eq!(stems, 5);
        let stem_tracks = mp4::parse_init(&fs::read(dir.join("01-stems.mp4")).unwrap()).unwrap();
        assert_eq!(stem_tracks.len(), 1);

        let out = dir.join("clip.mp4");
        export(&dir, 3 * 90_000 + 45_000, 6 * 90_000 + 18_000, &out).unwrap();
        let tracks = mp4::parse_init(&fs::read(&out).unwrap()).unwrap();
        assert_eq!(tracks.len(), 2);
        assert!(matches!(tracks[1].codec, Codec::Aac { channels: 2, sample_rate: 48_000, .. }));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_clip_starts_at_the_keyframe_before_the_cut_and_hides_the_lead() {
        let dir = temp("clip");
        record(&dir);
        let out = dir.join("clip.mp4");
        // 3.5 s .. 6.2 s: the keyframe before is at 3 s, so 0.5 s is hidden.
        let from = 3 * 90_000 + 45_000;
        let to = 6 * 90_000 + 18_000;
        export(&dir, from, to, &out).unwrap();
        let file = fs::read(&out).unwrap();
        let tracks = mp4::parse_init(&file).unwrap();
        assert!(matches!(&tracks[0].codec, Codec::Avc { width: 1280, height: 720, .. }));
        // Frames 90 (3 s) through 185 (6.17 s) are in it, in order.
        let mut numbers = Vec::new();
        let mut i = 0;
        while let Some(at) = file[i..].windows(4).position(|w| w == [0, 0, 0, 3]).map(|p| p + i) {
            if matches!(file.get(at + 4), Some(0x65 | 0x41)) {
                numbers.push(((file[at + 5] & 0x7f) as u32) << 7 | (file[at + 6] & 0x7f) as u32);
            }
            i = at + 1;
        }
        assert_eq!(numbers.first(), Some(&90));
        assert_eq!(numbers.last(), Some(&185));
        assert!(numbers.windows(2).all(|w| w[1] == w[0] + 1));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_damaged_segment_is_skipped() {
        let dir = temp("damaged");
        record(&dir);
        let victim = dir.join("01-000002.m4s");
        let data = fs::read(&victim).unwrap();
        fs::write(&victim, &data[..data.len() / 2]).unwrap();
        assert_eq!(parts(&dir).unwrap()[0].segments.len(), 4);
        fs::remove_dir_all(&dir).unwrap();
    }
}
