//! The MP4 boxes REC writes and reads back. No Windows APIs and no dependencies, so it's tested anywhere.
//!
//! - Recording: an init segment (`init_segment`: ftyp + moov with empty tables + mvex) and ~2 s media segments
//!   (`media_segment`: moof + mdat), each starting on a video keyframe. A killed app loses at most the segment being
//!   written. Media Source Extensions play them as they are (init, then segments), so VODs need no merged copy.
//! - Reading back: `parse_init` / `parse_segment` (only what this file writes; anything else is an error, never a
//!   panic), giving every sample's position in its file.
//! - Clips and exports: `write_mp4`, one ordinary MP4 with the moov first (plays while it downloads, which shared links
//!   need), samples interleaved in ~1 s chunks, copied from the segments without re-encoding. A trim that doesn't start
//!   on a keyframe starts at the keyframe before it and an edit list (elst) hides the frames up to the cut.
//!
//! Video is H.264 (avc1, 4-byte lengths), audio AAC (mp4a). No B-frames (the encoder is set up without them), so
//! decode order = presentation order and there are no composition offsets.

use std::io::{self, Write};

/// Timescale of movie headers (mvhd, tkhd, elst durations): milliseconds.
pub const MOVIE_TIMESCALE: u32 = 1000;
/// Video track timescale.
pub const VIDEO_TIMESCALE: u32 = 90_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Codec {
    /// H.264: picture size and the parameter sets (without start codes).
    Avc { width: u16, height: u16, sps: Vec<u8>, pps: Vec<u8> },
    /// AAC-LC: AudioSpecificConfig, channels, sample rate.
    Aac { config: Vec<u8>, channels: u16, sample_rate: u32 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Track {
    /// 1-based.
    pub id: u32,
    pub timescale: u32,
    pub codec: Codec,
}

impl Track {
    fn is_video(&self) -> bool {
        matches!(self.codec, Codec::Avc { .. })
    }
}

/// A sample to write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sample {
    pub data: Vec<u8>,
    /// In the track's timescale.
    pub duration: u32,
    pub key: bool,
}

/// A sample read back: where it is in the file it was read from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SampleRef {
    pub offset: u64,
    pub size: u32,
    pub duration: u32,
    pub key: bool,
}

/// One track's samples in a media segment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Run {
    pub track_id: u32,
    /// Decode time of the first sample, in the track's timescale.
    pub start: u64,
    pub samples: Vec<SampleRef>,
}

// ---------- writing ----------

/// Writes boxes into a buffer; `open` returns a mark that `close` turns into the box's size.
struct Boxes {
    buf: Vec<u8>,
}

impl Boxes {
    fn new() -> Boxes {
        Boxes { buf: Vec::new() }
    }
    fn open(&mut self, kind: &[u8; 4]) -> usize {
        let at = self.buf.len();
        self.u32(0);
        self.buf.extend_from_slice(kind);
        at
    }
    /// A full box: version and flags after the type.
    fn open_full(&mut self, kind: &[u8; 4], version: u8, flags: u32) -> usize {
        let at = self.open(kind);
        self.u32((version as u32) << 24 | (flags & 0xff_ffff));
        at
    }
    fn close(&mut self, at: usize) {
        let size = (self.buf.len() - at) as u32;
        self.buf[at..at + 4].copy_from_slice(&size.to_be_bytes());
    }
    fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }
    fn u16(&mut self, v: u16) {
        self.buf.extend_from_slice(&v.to_be_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_be_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.buf.extend_from_slice(&v.to_be_bytes());
    }
    fn bytes(&mut self, v: &[u8]) {
        self.buf.extend_from_slice(v);
    }
    fn zeros(&mut self, n: usize) {
        self.buf.resize(self.buf.len() + n, 0);
    }
    /// The identity transform of tkhd/mvhd.
    fn matrix(&mut self) {
        for v in [0x0001_0000u32, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] {
            self.u32(v);
        }
    }
}

fn ftyp(b: &mut Boxes, fragmented: bool) {
    let at = b.open(b"ftyp");
    b.bytes(b"isom");
    b.u32(0x200);
    let brands: &[&[u8; 4]] = if fragmented { &[b"isom", b"iso6", b"avc1", b"mp41"] } else { &[b"isom", b"iso2", b"avc1", b"mp41"] };
    for brand in brands {
        b.bytes(*brand);
    }
    b.close(at);
}

fn mvhd(b: &mut Boxes, duration_ms: u64, next_track: u32) {
    let at = b.open_full(b"mvhd", 1, 0);
    b.u64(0); // created
    b.u64(0); // modified
    b.u32(MOVIE_TIMESCALE);
    b.u64(duration_ms);
    b.u32(0x0001_0000); // rate 1.0
    b.u16(0x0100); // volume 1.0
    b.zeros(10);
    b.matrix();
    b.zeros(24);
    b.u32(next_track);
    b.close(at);
}

fn tkhd(b: &mut Boxes, track: &Track, duration_ms: u64) {
    // Enabled, in the movie, in previews.
    let at = b.open_full(b"tkhd", 1, 7);
    b.u64(0);
    b.u64(0);
    b.u32(track.id);
    b.u32(0);
    b.u64(duration_ms);
    b.zeros(8);
    b.u16(0); // layer
    b.u16(if track.is_video() { 0 } else { 1 }); // alternate group
    b.u16(if track.is_video() { 0 } else { 0x0100 }); // volume
    b.u16(0);
    b.matrix();
    let (w, h) = match &track.codec {
        Codec::Avc { width, height, .. } => (*width as u32, *height as u32),
        Codec::Aac { .. } => (0, 0),
    };
    b.u32(w << 16);
    b.u32(h << 16);
    b.close(at);
}

fn mdhd(b: &mut Boxes, track: &Track, duration: u64) {
    let at = b.open_full(b"mdhd", 1, 0);
    b.u64(0);
    b.u64(0);
    b.u32(track.timescale);
    b.u64(duration);
    b.u16(0x55c4); // "und"
    b.u16(0);
    b.close(at);
}

fn hdlr(b: &mut Boxes, track: &Track) {
    let at = b.open_full(b"hdlr", 0, 0);
    b.u32(0);
    b.bytes(if track.is_video() { b"vide" } else { b"soun" });
    b.zeros(12);
    b.bytes(if track.is_video() { b"Pottira video\0" } else { b"Pottira audio\0" });
    b.close(at);
}

/// AAC's esds: ES_Descriptor > DecoderConfigDescriptor > DecoderSpecificInfo, then SLConfigDescriptor.
fn esds(b: &mut Boxes, config: &[u8]) {
    let at = b.open_full(b"esds", 0, 0);
    let descriptor = |b: &mut Boxes, tag: u8, len: usize| {
        b.u8(tag);
        // Four length bytes, 7 bits each, so the size never depends on the contents.
        b.bytes(&[0x80 | ((len >> 21) & 0x7f) as u8, 0x80 | ((len >> 14) & 0x7f) as u8, 0x80 | ((len >> 7) & 0x7f) as u8, (len & 0x7f) as u8]);
    };
    let specific = 5 + config.len();
    let decoder = 13 + specific;
    let es = 3 + (5 + decoder) + (5 + 1);
    descriptor(b, 3, es);
    b.u16(0); // ES_ID
    b.u8(0); // flags
    descriptor(b, 4, decoder);
    b.u8(0x40); // MPEG-4 audio
    b.u8(0x15); // audio stream
    b.bytes(&[0, 0, 0]); // buffer size
    b.u32(0); // max bitrate
    b.u32(0); // average bitrate
    descriptor(b, 5, config.len());
    b.bytes(config);
    descriptor(b, 6, 1);
    b.u8(2);
    b.close(at);
}

fn stsd(b: &mut Boxes, track: &Track) {
    let at = b.open_full(b"stsd", 0, 0);
    b.u32(1);
    match &track.codec {
        Codec::Avc { width, height, sps, pps } => {
            let entry = b.open(b"avc1");
            b.zeros(6);
            b.u16(1); // data reference
            b.zeros(16);
            b.u16(*width);
            b.u16(*height);
            b.u32(0x0048_0000); // 72 dpi
            b.u32(0x0048_0000);
            b.u32(0);
            b.u16(1); // frames per sample
            b.zeros(32); // compressor name
            b.u16(0x18); // depth
            b.u16(0xffff);
            let avcc = b.open(b"avcC");
            b.u8(1);
            b.u8(sps.get(1).copied().unwrap_or(100));
            b.u8(sps.get(2).copied().unwrap_or(0));
            b.u8(sps.get(3).copied().unwrap_or(41));
            b.u8(0xfc | 3); // 4-byte lengths
            b.u8(0xe0 | 1);
            b.u16(sps.len() as u16);
            b.bytes(sps);
            b.u8(1);
            b.u16(pps.len() as u16);
            b.bytes(pps);
            b.close(avcc);
            // BT.709, studio range: what the encoder makes.
            let colr = b.open(b"colr");
            b.bytes(b"nclx");
            b.u16(1);
            b.u16(1);
            b.u16(1);
            b.u8(0);
            b.close(colr);
            b.close(entry);
        }
        Codec::Aac { config, channels, sample_rate } => {
            let entry = b.open(b"mp4a");
            b.zeros(6);
            b.u16(1);
            b.zeros(8);
            b.u16(*channels);
            b.u16(16);
            b.u16(0);
            b.u16(0);
            b.u32((*sample_rate).min(0xffff) << 16);
            esds(b, config);
            b.close(entry);
        }
    }
    b.close(at);
}

fn minf_head(b: &mut Boxes, track: &Track) {
    if track.is_video() {
        let at = b.open_full(b"vmhd", 0, 1);
        b.zeros(8);
        b.close(at);
    } else {
        let at = b.open_full(b"smhd", 0, 0);
        b.zeros(4);
        b.close(at);
    }
    let dinf = b.open(b"dinf");
    let dref = b.open_full(b"dref", 0, 0);
    b.u32(1);
    let url = b.open_full(b"url ", 0, 1); // the data is in this file
    b.close(url);
    b.close(dref);
    b.close(dinf);
}

/// ftyp + moov for a fragmented recording: empty sample tables, the samples come in media segments.
pub fn init_segment(tracks: &[Track]) -> Vec<u8> {
    let mut b = Boxes::new();
    ftyp(&mut b, true);
    let moov = b.open(b"moov");
    mvhd(&mut b, 0, tracks.iter().map(|t| t.id).max().unwrap_or(0) + 1);
    for track in tracks {
        let trak = b.open(b"trak");
        tkhd(&mut b, track, 0);
        let mdia = b.open(b"mdia");
        mdhd(&mut b, track, 0);
        hdlr(&mut b, track);
        let minf = b.open(b"minf");
        minf_head(&mut b, track);
        let stbl = b.open(b"stbl");
        stsd(&mut b, track);
        for kind in [b"stts", b"stsc", b"stco"] {
            let at = b.open_full(kind, 0, 0);
            b.u32(0);
            b.close(at);
        }
        let stsz = b.open_full(b"stsz", 0, 0);
        b.u32(0);
        b.u32(0);
        b.close(stsz);
        b.close(stbl);
        b.close(minf);
        b.close(mdia);
        b.close(trak);
    }
    let mvex = b.open(b"mvex");
    for track in tracks {
        let at = b.open_full(b"trex", 0, 0);
        b.u32(track.id);
        b.u32(1);
        b.u32(0);
        b.u32(0);
        b.u32(0);
        b.close(at);
    }
    b.close(mvex);
    b.close(moov);
    b.buf
}

const FLAGS_KEY: u32 = 0x0200_0000; // depends on no other sample
const FLAGS_DELTA: u32 = 0x0101_0000; // depends on others, not a sync sample

/// moof + mdat holding each track's samples; `runs` = (track id, decode time of its first sample, samples).
pub fn media_segment(sequence: u32, runs: &[(u32, u64, &[Sample])]) -> Vec<u8> {
    let mut b = Boxes::new();
    let moof = b.open(b"moof");
    let mfhd = b.open_full(b"mfhd", 0, 0);
    b.u32(sequence);
    b.close(mfhd);
    let mut offsets = Vec::new();
    for (track_id, start, samples) in runs {
        let traf = b.open(b"traf");
        let tfhd = b.open_full(b"tfhd", 0, 0x02_0000); // offsets from the moof
        b.u32(*track_id);
        b.close(tfhd);
        let tfdt = b.open_full(b"tfdt", 1, 0);
        b.u64(*start);
        b.close(tfdt);
        // data offset, duration, size and flags per sample
        let trun = b.open_full(b"trun", 0, 0x0701);
        b.u32(samples.len() as u32);
        offsets.push(b.buf.len());
        b.u32(0);
        for s in samples.iter() {
            b.u32(s.duration);
            b.u32(s.data.len() as u32);
            b.u32(if s.key { FLAGS_KEY } else { FLAGS_DELTA });
        }
        b.close(trun);
        b.close(traf);
    }
    b.close(moof);
    let moof_size = b.buf.len();
    let total: usize = runs.iter().flat_map(|r| r.2.iter()).map(|s| s.data.len()).sum();
    let mut data_at = moof_size + 8;
    for ((_, _, samples), at) in runs.iter().zip(offsets) {
        b.buf[at..at + 4].copy_from_slice(&(data_at as u32).to_be_bytes());
        data_at += samples.iter().map(|s| s.data.len()).sum::<usize>();
    }
    b.u32((total + 8) as u32);
    b.bytes(b"mdat");
    b.buf.reserve(total);
    for (_, _, samples) in runs {
        for s in samples.iter() {
            b.bytes(&s.data);
        }
    }
    b.buf
}

/// A clip/export: which samples of each track, and where the picture starts and ends.
pub struct Export<'a> {
    pub tracks: &'a [Track],
    /// Per track (same order), in decode order. The first video sample must be a keyframe.
    pub samples: &'a [Vec<SampleRef>],
    /// Per track: how much of its start to hide (track timescale), for a cut between keyframes. 0 = none.
    pub skip: &'a [u64],
}

/// About this long per chunk: players reading the file front to back get every track's data close together.
const CHUNK_SECONDS: u64 = 1;

/// Writes `export` as one MP4 with the moov first; `copy` writes a sample's bytes (read from wherever `offset` points).
/// Returns the file's size.
pub fn write_mp4(out: &mut impl Write, export: &Export, mut copy: impl FnMut(&mut dyn Write, usize, &SampleRef) -> io::Result<()>) -> io::Result<u64> {
    let chunks = plan_chunks(export);
    let data: u64 = export.samples.iter().flatten().map(|s| s.size as u64).sum();
    // Offsets fit in 32 bits unless the file is over 4 GB; the moov is sized the same either way.
    let wide = data > u32::MAX as u64 - 64 * 1024 * 1024;
    let moov = |offsets: &[Vec<u64>]| moov_box(export, &chunks, offsets, wide);
    let mut b = Boxes::new();
    ftyp(&mut b, false);
    let head = b.buf;
    let dry = moov(&chunks.iter().map(|c| vec![0; c.len()]).collect::<Vec<_>>());
    let mdat_header = if wide { 16 } else { 8 };
    let mut at = (head.len() + dry.len() + mdat_header) as u64;
    // Chunks are written in time order across tracks.
    let order = chunk_order(export, &chunks);
    let mut offsets: Vec<Vec<u64>> = chunks.iter().map(|c| vec![0; c.len()]).collect();
    for &(track, chunk) in &order {
        offsets[track][chunk] = at;
        let (first, count) = chunks[track][chunk];
        at += export.samples[track][first..first + count].iter().map(|s| s.size as u64).sum::<u64>();
    }
    let moov = moov(&offsets);
    debug_assert_eq!(moov.len(), dry.len());
    out.write_all(&head)?;
    out.write_all(&moov)?;
    if wide {
        out.write_all(&1u32.to_be_bytes())?;
        out.write_all(b"mdat")?;
        out.write_all(&(data + 16).to_be_bytes())?;
    } else {
        out.write_all(&((data + 8) as u32).to_be_bytes())?;
        out.write_all(b"mdat")?;
    }
    for &(track, chunk) in &order {
        let (first, count) = chunks[track][chunk];
        for s in &export.samples[track][first..first + count] {
            copy(out, track, s)?;
        }
    }
    Ok(at)
}

/// Per track: (first sample, count) of each chunk.
fn plan_chunks(export: &Export) -> Vec<Vec<(usize, usize)>> {
    export
        .tracks
        .iter()
        .zip(export.samples)
        .map(|(track, samples)| {
            let limit = track.timescale as u64 * CHUNK_SECONDS;
            let mut chunks = Vec::new();
            let (mut first, mut time) = (0, 0u64);
            for (i, s) in samples.iter().enumerate() {
                if i > first && time >= limit {
                    chunks.push((first, i - first));
                    first = i;
                    time = 0;
                }
                time += s.duration as u64;
            }
            if first < samples.len() {
                chunks.push((first, samples.len() - first));
            }
            chunks
        })
        .collect()
}

/// Every (track, chunk), ordered by the chunk's start time.
fn chunk_order(export: &Export, chunks: &[Vec<(usize, usize)>]) -> Vec<(usize, usize)> {
    let mut order = Vec::new();
    for (t, track_chunks) in chunks.iter().enumerate() {
        let scale = export.tracks[t].timescale as u128;
        let mut time = 0u64;
        let mut next = 0;
        for (c, &(first, _)) in track_chunks.iter().enumerate() {
            while next < first {
                time += export.samples[t][next].duration as u64;
                next += 1;
            }
            // Compared in a common unit: seconds scaled by 10^6.
            order.push(((time as u128 * 1_000_000 / scale) as u64, t, c));
        }
    }
    order.sort();
    order.into_iter().map(|(_, t, c)| (t, c)).collect()
}

fn moov_box(export: &Export, chunks: &[Vec<(usize, usize)>], offsets: &[Vec<u64>], wide: bool) -> Vec<u8> {
    let mut b = Boxes::new();
    let to_ms = |v: u64, scale: u32| v * MOVIE_TIMESCALE as u64 / scale.max(1) as u64;
    let shown = |t: usize| {
        let total: u64 = export.samples[t].iter().map(|s| s.duration as u64).sum();
        total.saturating_sub(export.skip.get(t).copied().unwrap_or(0))
    };
    let movie = (0..export.tracks.len()).map(|t| to_ms(shown(t), export.tracks[t].timescale)).max().unwrap_or(0);
    let moov = b.open(b"moov");
    mvhd(&mut b, movie, export.tracks.iter().map(|t| t.id).max().unwrap_or(0) + 1);
    for (t, track) in export.tracks.iter().enumerate() {
        let samples = &export.samples[t];
        let total: u64 = samples.iter().map(|s| s.duration as u64).sum();
        let skip = export.skip.get(t).copied().unwrap_or(0);
        let trak = b.open(b"trak");
        tkhd(&mut b, track, to_ms(shown(t), track.timescale));
        // Always an edit list: a fixed size whatever the trim, and players start exactly at `skip`.
        let edts = b.open(b"edts");
        let elst = b.open_full(b"elst", 1, 0);
        b.u32(1);
        b.u64(to_ms(shown(t), track.timescale));
        b.u64(skip);
        b.u16(1);
        b.u16(0);
        b.close(elst);
        b.close(edts);
        let mdia = b.open(b"mdia");
        mdhd(&mut b, track, total);
        hdlr(&mut b, track);
        let minf = b.open(b"minf");
        minf_head(&mut b, track);
        let stbl = b.open(b"stbl");
        stsd(&mut b, track);
        // stts: runs of equal durations.
        let mut runs: Vec<(u32, u32)> = Vec::new();
        for s in samples {
            match runs.last_mut() {
                Some((n, d)) if *d == s.duration => *n += 1,
                _ => runs.push((1, s.duration)),
            }
        }
        let stts = b.open_full(b"stts", 0, 0);
        b.u32(runs.len() as u32);
        for (n, d) in runs {
            b.u32(n);
            b.u32(d);
        }
        b.close(stts);
        if track.is_video() {
            let keys: Vec<u32> = samples.iter().enumerate().filter(|(_, s)| s.key).map(|(i, _)| i as u32 + 1).collect();
            let stss = b.open_full(b"stss", 0, 0);
            b.u32(keys.len() as u32);
            for k in keys {
                b.u32(k);
            }
            b.close(stss);
        }
        // stsc: runs of chunks with the same sample count.
        let mut stsc: Vec<(u32, u32)> = Vec::new();
        for (c, &(_, count)) in chunks[t].iter().enumerate() {
            if stsc.last().is_none_or(|&(_, n)| n != count as u32) {
                stsc.push((c as u32 + 1, count as u32));
            }
        }
        let at = b.open_full(b"stsc", 0, 0);
        b.u32(stsc.len() as u32);
        for (first, count) in stsc {
            b.u32(first);
            b.u32(count);
            b.u32(1);
        }
        b.close(at);
        let stsz = b.open_full(b"stsz", 0, 0);
        b.u32(0);
        b.u32(samples.len() as u32);
        for s in samples {
            b.u32(s.size);
        }
        b.close(stsz);
        let at = b.open_full(if wide { b"co64" } else { b"stco" }, 0, 0);
        b.u32(offsets[t].len() as u32);
        for &o in &offsets[t] {
            if wide {
                b.u64(o);
            } else {
                b.u32(o as u32);
            }
        }
        b.close(at);
        b.close(stbl);
        b.close(minf);
        b.close(mdia);
        b.close(trak);
    }
    b.close(moov);
    b.buf
}

// ---------- H.264 ----------

/// Annex B (start codes, what the encoder gives) -> one MP4 sample (4-byte lengths). Parameter sets and access unit
/// delimiters are left out: they live in the avcC. Returns the sample and any SPS/PPS found.
pub fn annexb_to_sample(data: &[u8]) -> (Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>) {
    let (mut out, mut sps, mut pps) = (Vec::with_capacity(data.len()), None, None);
    for nal in nal_units(data) {
        match nal.first().map(|b| b & 0x1f) {
            Some(7) => sps = Some(nal.to_vec()),
            Some(8) => pps = Some(nal.to_vec()),
            Some(9) | None => {}
            Some(_) => {
                out.extend_from_slice(&(nal.len() as u32).to_be_bytes());
                out.extend_from_slice(nal);
            }
        }
    }
    (out, sps, pps)
}

fn nal_units(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push((i, i + 3));
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    for (n, &(_, begin)) in starts.iter().enumerate() {
        let mut end = starts.get(n + 1).map_or(data.len(), |&(at, _)| at);
        // A 4-byte start code's leading zero belongs to it, not to this unit.
        while end > begin && data[end - 1] == 0 {
            end -= 1;
        }
        if end > begin {
            out.push(&data[begin..end]);
        }
    }
    out
}

// ---------- reading back ----------

#[derive(Debug, PartialEq, Eq)]
pub struct Invalid(pub &'static str);

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "invalid recording file: {}", self.0)
    }
}

impl std::error::Error for Invalid {}

type Parsed<T> = Result<T, Invalid>;

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Reader<'a> {
        Reader { data, at: 0 }
    }
    fn take(&mut self, n: usize) -> Parsed<&'a [u8]> {
        let end = self.at.checked_add(n).filter(|&e| e <= self.data.len()).ok_or(Invalid("truncated"))?;
        let s = &self.data[self.at..end];
        self.at = end;
        Ok(s)
    }
    fn u8(&mut self) -> Parsed<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Parsed<u16> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Parsed<u32> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Parsed<u64> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn skip(&mut self, n: usize) -> Parsed<()> {
        self.take(n).map(|_| ())
    }
}

/// A box read back: (type, contents, offset of the box in what it was read from).
type Found<'a> = ([u8; 4], &'a [u8], usize);

/// The boxes directly inside `data`.
fn children(data: &[u8]) -> Parsed<Vec<Found<'_>>> {
    let mut out = Vec::new();
    let mut r = Reader::new(data);
    while r.at < data.len() {
        let start = r.at;
        let size = r.u32()? as u64;
        let kind: [u8; 4] = r.take(4)?.try_into().unwrap();
        let (header, size) = match size {
            1 => (16, r.u64()?),
            0 => (8, (data.len() - start) as u64),
            n => (8, n),
        };
        if size < header {
            return Err(Invalid("box size"));
        }
        let body = (size - header) as usize;
        out.push((kind, r.take(body)?, start));
    }
    Ok(out)
}

fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Parsed<&'a [u8]> {
    children(data)?.into_iter().find(|c| &c.0 == kind).map(|c| c.1).ok_or(Invalid("missing box"))
}

/// The tracks of an init segment (or of an exported file's moov).
pub fn parse_init(data: &[u8]) -> Parsed<Vec<Track>> {
    let moov = child(data, b"moov")?;
    let mut tracks = Vec::new();
    for (kind, trak, _) in children(moov)? {
        if &kind != b"trak" {
            continue;
        }
        let mut tkhd = Reader::new(child(trak, b"tkhd")?);
        let version = tkhd.u8()?;
        tkhd.skip(3)?;
        tkhd.skip(if version == 1 { 16 } else { 8 })?;
        let id = tkhd.u32()?;
        let mdia = child(trak, b"mdia")?;
        let mut mdhd = Reader::new(child(mdia, b"mdhd")?);
        let version = mdhd.u8()?;
        mdhd.skip(3)?;
        mdhd.skip(if version == 1 { 16 } else { 8 })?;
        let timescale = mdhd.u32()?;
        let stsd = child(child(child(mdia, b"minf")?, b"stbl")?, b"stsd")?;
        let entries = children(stsd.get(8..).ok_or(Invalid("stsd"))?)?;
        let (entry_kind, entry, _) = entries.first().ok_or(Invalid("stsd"))?;
        let codec = match entry_kind {
            b"avc1" => {
                let mut r = Reader::new(entry);
                r.skip(24)?;
                let (width, height) = (r.u16()?, r.u16()?);
                let avcc = child(entry.get(78..).ok_or(Invalid("avc1"))?, b"avcC")?;
                let mut r = Reader::new(avcc);
                r.skip(5)?;
                let _count = r.u8()? & 0x1f;
                let n = r.u16()? as usize;
                let sps = r.take(n)?.to_vec();
                let _count = r.u8()?;
                let n = r.u16()? as usize;
                let pps = r.take(n)?.to_vec();
                Codec::Avc { width, height, sps, pps }
            }
            b"mp4a" => {
                let mut r = Reader::new(entry);
                r.skip(16)?;
                let channels = r.u16()?;
                r.skip(6)?;
                let sample_rate = r.u32()? >> 16;
                let esds = child(entry.get(28..).ok_or(Invalid("mp4a"))?, b"esds")?;
                Codec::Aac { config: aac_config(esds)?, channels, sample_rate }
            }
            _ => return Err(Invalid("codec")),
        };
        tracks.push(Track { id, timescale, codec });
    }
    Ok(tracks)
}

/// The DecoderSpecificInfo inside an esds.
fn aac_config(esds: &[u8]) -> Parsed<Vec<u8>> {
    let mut r = Reader::new(esds);
    r.skip(4)?;
    let len = |r: &mut Reader| -> Parsed<usize> {
        let mut n = 0usize;
        for _ in 0..4 {
            let b = r.u8()?;
            n = n << 7 | (b & 0x7f) as usize;
            if b & 0x80 == 0 {
                break;
            }
        }
        Ok(n)
    };
    loop {
        let tag = r.u8()?;
        let n = len(&mut r)?;
        match tag {
            3 => r.skip(3)?,
            4 => r.skip(13)?,
            5 => return Ok(r.take(n)?.to_vec()),
            _ => r.skip(n)?,
        }
    }
}

/// The samples of one media segment, with offsets into `data`.
pub fn parse_segment(data: &[u8]) -> Parsed<Vec<Run>> {
    let boxes = children(data)?;
    let (_, moof, moof_at) = boxes.iter().find(|b| &b.0 == b"moof").ok_or(Invalid("missing moof"))?;
    runs_of(moof, *moof_at as u64, data.len() as u64)
}

/// Like `parse_segment` from only the start of a segment file (`head`, at least its moof, which `media_segment` puts
/// first) and the file's length: listing a long recording reads a few KB per segment, not the video.
pub fn parse_segment_head(head: &[u8], file_len: u64) -> Parsed<Vec<Run>> {
    let mut r = Reader::new(head);
    let size = r.u32()? as usize;
    if r.take(4)? != b"moof" || size < 8 {
        return Err(Invalid("missing moof"));
    }
    runs_of(head.get(8..size).ok_or(Invalid("truncated"))?, 0, file_len)
}

/// The samples described by a moof (its contents, found at `moof_at` in a file `file_len` long).
fn runs_of(moof: &[u8], moof_at: u64, file_len: u64) -> Parsed<Vec<Run>> {
    let mut runs = Vec::new();
    for (kind, traf, _) in children(moof)? {
        if &kind != b"traf" {
            continue;
        }
        let mut tfhd = Reader::new(child(traf, b"tfhd")?);
        tfhd.skip(4)?;
        let track_id = tfhd.u32()?;
        let mut tfdt = Reader::new(child(traf, b"tfdt")?);
        let version = tfdt.u8()?;
        tfdt.skip(3)?;
        let start = if version == 1 { tfdt.u64()? } else { tfdt.u32()? as u64 };
        let mut trun = Reader::new(child(traf, b"trun")?);
        let flags = trun.u32()? & 0xff_ffff;
        if flags != 0x0701 {
            return Err(Invalid("trun flags"));
        }
        let count = trun.u32()? as usize;
        let mut offset = moof_at + trun.u32()? as u64;
        let mut samples = Vec::with_capacity(count.min(100_000));
        for _ in 0..count {
            let (duration, size, flags) = (trun.u32()?, trun.u32()?, trun.u32()?);
            if offset + size as u64 > file_len {
                return Err(Invalid("sample past the end"));
            }
            samples.push(SampleRef { offset, size, duration, key: flags & 0x0001_0000 == 0 });
            offset += size as u64;
        }
        runs.push(Run { track_id, start, samples });
    }
    Ok(runs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video() -> Track {
        Track { id: 1, timescale: VIDEO_TIMESCALE, codec: Codec::Avc { width: 1920, height: 1080, sps: vec![0x67, 100, 0, 42, 1, 2], pps: vec![0x68, 3, 4] } }
    }
    fn audio() -> Track {
        Track { id: 2, timescale: 48_000, codec: Codec::Aac { config: vec![0x11, 0x90], channels: 2, sample_rate: 48_000 } }
    }
    fn sample(byte: u8, len: usize, duration: u32, key: bool) -> Sample {
        Sample { data: vec![byte; len], duration, key }
    }

    #[test]
    fn init_segments_read_back_as_written() {
        let tracks = vec![video(), audio()];
        assert_eq!(parse_init(&init_segment(&tracks)).unwrap(), tracks);
    }

    #[test]
    fn segments_point_at_their_samples() {
        let v = [sample(1, 100, 3000, true), sample(2, 50, 3003, false)];
        let a = [sample(9, 20, 1024, true), sample(8, 30, 1024, true), sample(7, 10, 1024, true)];
        let seg = media_segment(7, &[(1, 90_000, &v), (2, 48_000, &a)]);
        let runs = parse_segment(&seg).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!((runs[0].track_id, runs[0].start, runs[1].start), (1, 90_000, 48_000));
        assert_eq!(runs[0].samples.iter().map(|s| (s.duration, s.key)).collect::<Vec<_>>(), [(3000, true), (3003, false)]);
        for (run, written) in runs.iter().zip([&v[..], &a[..]]) {
            for (r, w) in run.samples.iter().zip(written) {
                assert_eq!(&seg[r.offset as usize..][..r.size as usize], &w.data[..]);
            }
        }
    }

    #[test]
    fn annexb_becomes_length_prefixed_without_parameter_sets() {
        let au = [0, 0, 0, 1, 9, 0xf0, 0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 1, 0x65, 0xaa, 0xbb, 0, 0, 1, 0x06, 5];
        let (sample, sps, pps) = annexb_to_sample(&au);
        assert_eq!(sps.unwrap(), [0x67, 1, 2]);
        assert_eq!(pps.unwrap(), [0x68, 3]);
        assert_eq!(sample, [0, 0, 0, 3, 0x65, 0xaa, 0xbb, 0, 0, 0, 2, 0x06, 5]);
    }

    /// sizes, chunk offsets, stsc (first chunk, samples per chunk), sync samples, edit (duration, media time).
    type Tables = (Vec<u32>, Vec<u64>, Vec<(u32, u32)>, Vec<u32>, (u64, u64));

    /// Reads the sample tables of an exported file back (only for checking `write_mp4`).
    fn tables(file: &[u8], track: usize) -> Tables {
        let moov = child(file, b"moov").unwrap();
        let trak = children(moov).unwrap().into_iter().filter(|c| &c.0 == b"trak").nth(track).unwrap().1;
        let mut elst = Reader::new(child(child(trak, b"edts").unwrap(), b"elst").unwrap());
        elst.skip(8).unwrap();
        let edit = (elst.u64().unwrap(), elst.u64().unwrap());
        let stbl = child(child(child(trak, b"mdia").unwrap(), b"minf").unwrap(), b"stbl").unwrap();
        let mut r = Reader::new(child(stbl, b"stsz").unwrap());
        r.skip(8).unwrap();
        let n = r.u32().unwrap();
        let sizes = (0..n).map(|_| r.u32().unwrap()).collect();
        let mut r = Reader::new(child(stbl, b"stco").unwrap());
        r.skip(4).unwrap();
        let n = r.u32().unwrap();
        let offsets = (0..n).map(|_| r.u32().unwrap() as u64).collect();
        let mut r = Reader::new(child(stbl, b"stsc").unwrap());
        r.skip(4).unwrap();
        let n = r.u32().unwrap();
        let stsc = (0..n)
            .map(|_| {
                let (first, count, _description) = (r.u32().unwrap(), r.u32().unwrap(), r.u32().unwrap());
                (first, count)
            })
            .collect();
        let keys = child(stbl, b"stss").map(|s| {
            let mut r = Reader::new(s);
            r.skip(4).unwrap();
            let n = r.u32().unwrap();
            (0..n).map(|_| r.u32().unwrap()).collect()
        });
        (sizes, offsets, stsc, keys.unwrap_or_default(), edit)
    }

    #[test]
    fn exports_put_the_moov_first_and_every_sample_where_the_tables_say() {
        // 3 s of 30 fps video with a keyframe each second, and 3 s of audio.
        let v: Vec<Sample> = (0..90).map(|i| sample(i as u8, 10 + i % 7, 3000, i % 30 == 0)).collect();
        let a: Vec<Sample> = (0..141).map(|i| sample(200 - (i % 50) as u8, 5 + i % 3, 1024, true)).collect();
        let tracks = [video(), audio()];
        let seg = media_segment(1, &[(1, 0, &v), (2, 0, &a)]);
        let runs = parse_segment(&seg).unwrap();
        let samples: Vec<Vec<SampleRef>> = runs.iter().map(|r| r.samples.clone()).collect();
        let export = Export { tracks: &tracks, samples: &samples, skip: &[45_000, 24_000] };
        let mut file = Vec::new();
        let size = write_mp4(&mut file, &export, |out, _, s| out.write_all(&seg[s.offset as usize..][..s.size as usize])).unwrap();
        assert_eq!(size, file.len() as u64);
        let order: Vec<[u8; 4]> = children(&file).unwrap().iter().map(|c| c.0).collect();
        assert_eq!(order, [*b"ftyp", *b"moov", *b"mdat"]);
        assert_eq!(parse_init(&file).unwrap(), tracks);

        for (t, written) in [&v, &a].into_iter().enumerate() {
            let (sizes, offsets, stsc, keys, edit) = tables(&file, t);
            assert_eq!(sizes.len(), written.len());
            // Walk the chunks as a player would and compare every sample's bytes.
            let mut sample = 0;
            for (c, &offset) in offsets.iter().enumerate() {
                let per_chunk = stsc.iter().rev().find(|(first, _)| *first as usize <= c + 1).unwrap().1;
                let mut at = offset as usize;
                for _ in 0..per_chunk {
                    assert_eq!(&file[at..at + sizes[sample] as usize], &written[sample].data[..]);
                    at += sizes[sample] as usize;
                    sample += 1;
                }
            }
            assert_eq!(sample, written.len());
            if t == 0 {
                assert_eq!(keys, [1, 31, 61]);
                assert_eq!(edit, (2500, 45_000), "half a second hidden, 2.5 s shown");
            }
        }
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        let seg = media_segment(1, &[(1, 0, &[sample(1, 100, 3000, true)])]);
        for cut in [0, 7, 8, 30, seg.len() - 1] {
            assert!(parse_segment(&seg[..cut]).is_err(), "cut at {cut}");
        }
        let init = init_segment(&[video()]);
        for cut in [10, 40, init.len() - 3] {
            assert!(parse_init(&init[..cut]).is_err(), "cut at {cut}");
        }
        assert!(parse_segment(&[0, 0, 0, 3, b'm', b'o', b'o', b'f']).is_err());
        assert!(parse_segment(&[0xff; 64]).is_err());
        let moof_len = u32::from_be_bytes(seg[..4].try_into().unwrap()) as usize;
        assert_eq!(parse_segment_head(&seg[..moof_len], seg.len() as u64).unwrap(), parse_segment(&seg).unwrap(), "the head alone is enough");
        assert!(parse_segment_head(&seg[..moof_len], 20).is_err(), "a file too short for its samples");
    }
}
