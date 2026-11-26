// Plays a REC VOD straight from its segments (src-tauri/src/rec/vod.rs) with Media Source Extensions: no merged copy
// on disk, and a six-hour session starts at once. Keeps a window around the playhead in the buffer (up to half a
// minute ahead, less at high bitrates: Chromium refuses appends past ~150 MB), drops the rest, follows seeks at once,
// and steps over gaps (where the game was swapped for its client, or the recording's first moments before the first
// frame).
//
// What's in the buffer is read from the buffer itself (`buffered`), never remembered: the browser may evict data on
// its own, and a segment it dropped must load again when the playhead comes back to it.

import { convertFileSrc } from '@tauri-apps/api/core';

export interface VodSegment {
  path: string;
  start_ms: number;
  end_ms: number;
}

export interface VodPart {
  init: string;
  codecs: string;
  segments: VodSegment[];
}

/** Seconds kept ahead of the playhead (at most / at least), and behind it before being dropped. */
const AHEAD_MAX = 30;
const AHEAD_MIN = 6;
const BEHIND_MAX = 30;
const BEHIND_MIN = 3;
/** Bytes the window may hold ahead / behind, together well under Chromium's limit for one SourceBuffer. */
const AHEAD_BYTES = 70e6;
const BEHIND_BYTES = 25e6;
/** Room past the window before data ahead is dropped (a segment straddling its edge stays). */
const SLACK = 5;

interface Seg extends VodSegment {
  part: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export class VodPlayer {
  private source = new MediaSource();
  private buffer: SourceBuffer | null = null;
  private segs: Seg[];
  /** Which part's init the buffer was last given. */
  private initPart = -1;
  private working = false;
  /** Asked to work while working: go round again (a seek during a fetch must never be lost). */
  private again = false;
  private closed = false;
  /** Segments that can't be read or appended: skipped. */
  private failed = new Set<number>();
  /** Appended, yet not reported as buffered (no audio there, say): not appended again until the next seek. */
  private stuck = new Set<number>();
  /** The recording's bytes per second, learned from what's appended (0 = not yet). */
  private rate = 0;
  /** Shrinks the window after the browser refused an append for lack of room. */
  private squeeze = 1;
  private timer: number;
  readonly url: string;

  constructor(
    private video: HTMLVideoElement,
    private parts: VodPart[],
  ) {
    this.segs = parts.flatMap((p, part) => p.segments.map((s) => ({ ...s, part })));
    this.url = URL.createObjectURL(this.source);
    this.source.addEventListener('sourceopen', () => this.open(), { once: true });
    video.src = this.url;
    for (const ev of ['seeking', 'timeupdate', 'waiting', 'play'] as const) video.addEventListener(ev, this.onTime);
    video.addEventListener('seeking', this.onSeek);
    // A safety net: whatever an event missed, the buffer catches up within a second.
    this.timer = window.setInterval(this.onTime, 1000);
  }

  /** Length in seconds. */
  get duration() {
    return (this.segs.at(-1)?.end_ms ?? 0) / 1000;
  }

  private open() {
    const first = this.parts[0];
    if (!first) return;
    this.buffer = this.source.addSourceBuffer(`video/mp4; codecs="${first.codecs}"`);
    this.source.duration = this.duration;
    const start = (this.segs[0]?.start_ms ?? 0) / 1000;
    if (start > 0) this.video.currentTime = start;
    void this.pump();
  }

  private onTime = () => {
    if (this.closed) return;
    this.skipGap();
    void this.pump();
  };

  private onSeek = () => this.stuck.clear();

  /** Inside a hole between segments: go to the next one. */
  private skipGap() {
    const t = this.video.currentTime * 1000;
    if (!this.segs.length || this.segs.some((s) => s.start_ms <= t + 50 && t < s.end_ms)) return;
    const next = this.segs.find((s) => s.start_ms > t);
    if (next) this.video.currentTime = next.start_ms / 1000 + 0.01;
  }

  private ahead() {
    const s = this.rate ? AHEAD_BYTES / this.rate : AHEAD_MIN * 2;
    return clamp(s * this.squeeze, AHEAD_MIN, AHEAD_MAX);
  }

  private behind() {
    const s = this.rate ? BEHIND_BYTES / this.rate : BEHIND_MAX;
    return clamp(s * this.squeeze, BEHIND_MIN, BEHIND_MAX);
  }

  /** The segment's middle is in the buffer (its edges may differ a little from the index's times). */
  private has(s: Seg) {
    const b = this.buffer!.buffered;
    const mid = (s.start_ms + s.end_ms) / 2000;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= mid && mid < b.end(i)) return true;
    return false;
  }

  /** The segments the window wants, in time order. */
  private wanted(now: number) {
    const to = now + this.ahead() * 1000;
    return this.segs.findIndex(
      (s, i) => s.end_ms > now && s.start_ms <= to && !this.failed.has(i) && !this.stuck.has(i) && !this.has(s),
    );
  }

  private async pump() {
    this.again = true;
    if (this.working || this.closed || !this.buffer) return;
    this.working = true;
    try {
      while (this.again && !this.closed) {
        this.again = false;
        if (await this.work()) this.again = true;
      }
    } catch (e) {
      console.warn('vod player', e);
    } finally {
      this.working = false;
    }
  }

  /** One step towards the window around the playhead (read afresh each time). True when there may be more to do. */
  private async work(): Promise<boolean> {
    const b = this.buffer!;
    // Something else is running on the buffer: the next event or tick comes back (going round now would spin).
    if (b.updating) return false;
    const now = this.video.currentTime * 1000;

    // Drop what's outside the window: long behind, or far ahead (left there by a seek back).
    const from = now / 1000 - this.behind();
    const to = now / 1000 + this.ahead() + SLACK;
    for (let i = 0; i < b.buffered.length; i++) {
      const [start, end] = [b.buffered.start(i), b.buffered.end(i)];
      if (start < from - 1) {
        await this.run(() => b.remove(start, Math.min(end, from)));
        return true;
      }
      if (end > to + 1) {
        await this.run(() => b.remove(Math.max(start, to), end));
        return true;
      }
    }

    const i = this.wanted(now);
    if (i >= 0) {
      const s = this.segs[i];
      try {
        if (s.part !== this.initPart) {
          const part = this.parts[s.part];
          if (this.initPart >= 0 && part.codecs !== this.parts[this.initPart].codecs) {
            b.changeType(`video/mp4; codecs="${part.codecs}"`);
          }
          await this.append(await this.read(part.init));
          this.initPart = s.part;
        }
        const data = await this.read(s.path);
        if (this.closed) return false;
        // Seeked away during the read: don't fill the buffer with what's no longer wanted.
        if (!this.inWindow(s)) return true;
        await this.append(data);
        const secs = Math.max(0.2, (s.end_ms - s.start_ms) / 1000);
        const r = data.byteLength / secs;
        this.rate = this.rate ? this.rate * 0.8 + r * 0.2 : r;
        if (!this.has(s)) this.stuck.add(i);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'QuotaExceededError') {
          // Full: a smaller window from now on, and drop what's behind before trying again. Already as small as it
          // gets: this segment won't fit (skipped, rather than trying forever).
          if (this.squeeze <= 0.1) {
            this.failed.add(i);
            return true;
          }
          this.squeeze = Math.max(0.1, this.squeeze / 2);
          const keep = this.video.currentTime - 1;
          if (b.buffered.length && b.buffered.start(0) < keep) await this.run(() => b.remove(0, keep));
          return true;
        }
        console.warn('vod player: segment', s.path, e);
        this.failed.add(i);
      }
      return true;
    }

    // Everything from here to the end is in: tell the browser that's the end, or it waits there for more (a spinner
    // forever, never `ended`). Only then: ended with a hole ahead, the video track would stop at the hole while the
    // audio plays on. Appending again (a seek back) reopens the source by itself.
    if (
      this.source.readyState === 'open' &&
      !b.updating &&
      this.segs.every((s, j) => s.end_ms <= now || this.failed.has(j) || this.has(s))
    ) {
      this.source.endOfStream();
    }
    return false;
  }

  private inWindow(s: Seg) {
    const now = this.video.currentTime * 1000;
    return s.end_ms > now && s.start_ms <= now + this.ahead() * 1000;
  }

  private async read(path: string) {
    const res = await fetch(convertFileSrc(path));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.arrayBuffer();
  }

  private async append(data: ArrayBuffer) {
    if (this.closed) return;
    await this.run(() => this.buffer!.appendBuffer(data));
  }

  /** Runs a SourceBuffer operation and waits for it to finish. */
  private run(op: () => void) {
    return new Promise<void>((resolve, reject) => {
      const b = this.buffer!;
      const done = () => (b.removeEventListener('updateend', done), b.removeEventListener('error', fail), resolve());
      const fail = () => (
        b.removeEventListener('updateend', done),
        b.removeEventListener('error', fail),
        reject(new Error('buffer error'))
      );
      b.addEventListener('updateend', done);
      b.addEventListener('error', fail);
      try {
        op();
      } catch (e) {
        b.removeEventListener('updateend', done);
        b.removeEventListener('error', fail);
        reject(e);
      }
    });
  }

  dispose() {
    this.closed = true;
    clearInterval(this.timer);
    for (const ev of ['seeking', 'timeupdate', 'waiting', 'play'] as const)
      this.video.removeEventListener(ev, this.onTime);
    this.video.removeEventListener('seeking', this.onSeek);
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
  }
}
