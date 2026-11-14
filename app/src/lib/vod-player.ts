// Plays a REC VOD straight from its segments (src-tauri/src/rec/vod.rs) with Media Source Extensions: no merged copy
// on disk, and a three-hour session starts at once. Keeps about half a minute ahead of the playhead in the buffer and
// drops what's long behind, follows seeks, and steps over gaps (where the game was swapped for its client, or the
// recording's first moments before the first frame).

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

/** Seconds kept ahead of the playhead, and behind it before being dropped. */
const AHEAD = 30;
const BEHIND = 60;

interface Seg extends VodSegment {
  part: number;
}

export class VodPlayer {
  private source = new MediaSource();
  private buffer: SourceBuffer | null = null;
  private segs: Seg[];
  private loaded = new Set<number>();
  /** Which part's init the buffer was last given. */
  private initPart = -1;
  private working = false;
  private closed = false;
  readonly url: string;

  constructor(
    private video: HTMLVideoElement,
    private parts: VodPart[],
  ) {
    this.segs = parts.flatMap((p, part) => p.segments.map((s) => ({ ...s, part })));
    this.url = URL.createObjectURL(this.source);
    this.source.addEventListener('sourceopen', () => this.open(), { once: true });
    video.src = this.url;
    for (const ev of ['seeking', 'timeupdate', 'waiting'] as const) video.addEventListener(ev, this.onTime);
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
    this.skipGap();
    void this.pump();
  };

  /** Inside a hole between segments: go to the next one. */
  private skipGap() {
    const t = this.video.currentTime * 1000;
    if (this.segs.some((s) => s.start_ms <= t + 50 && t < s.end_ms)) return;
    const next = this.segs.find((s) => s.start_ms > t);
    if (next) this.video.currentTime = next.start_ms / 1000 + 0.01;
  }

  private async pump() {
    if (this.working || this.closed || !this.buffer) return;
    this.working = true;
    try {
      const now = this.video.currentTime * 1000;
      // Drop what's long behind (keeps memory flat on a long session).
      if (
        now / 1000 > BEHIND + 5 &&
        this.buffer.buffered.length &&
        this.buffer.buffered.start(0) < now / 1000 - BEHIND
      ) {
        await this.run(() => this.buffer!.remove(0, now / 1000 - BEHIND));
        // Deleting while iterating a Set is fine.
        for (const i of this.loaded) if (this.segs[i].end_ms < now - BEHIND * 1000) this.loaded.delete(i);
      }
      for (let i = 0; i < this.segs.length && !this.closed; i++) {
        const s = this.segs[i];
        if (this.loaded.has(i) || s.end_ms < now || s.start_ms > now + AHEAD * 1000) continue;
        if (s.part !== this.initPart) {
          const part = this.parts[s.part];
          if (this.initPart >= 0 && part.codecs !== this.parts[this.initPart].codecs) {
            this.buffer.changeType(`video/mp4; codecs="${part.codecs}"`);
          }
          await this.append(part.init);
          this.initPart = s.part;
        }
        await this.append(s.path);
        this.loaded.add(i);
      }
      // The last segment is in: tell the browser that's the end, or it waits there for more (a spinner forever, never
      // `ended`). Appending again (a seek back) reopens the source by itself.
      const last = this.segs.length - 1;
      if (last >= 0 && this.loaded.has(last) && this.source.readyState === 'open' && !this.buffer.updating) {
        this.source.endOfStream();
      }
    } catch (e) {
      console.warn('vod player', e);
    } finally {
      this.working = false;
    }
  }

  private async append(path: string) {
    const data = await (await fetch(convertFileSrc(path))).arrayBuffer();
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
      op();
    });
  }

  dispose() {
    this.closed = true;
    for (const ev of ['seeking', 'timeupdate', 'waiting'] as const) this.video.removeEventListener(ev, this.onTime);
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
  }
}
