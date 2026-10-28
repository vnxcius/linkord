// Audio worklets for voice: capture in 20 ms frames (mono mic or stereo screen audio), and a
// jitter-buffered stereo mixer for everyone you hear.

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: { processorOptions?: Record<string, unknown> });
}

const FRAME = 960; // 20 ms at 48 kHz, one Opus frame

/** Posts interleaved Float32 frames of FRAME samples per channel. */
class Capture extends AudioWorkletProcessor {
  private out: MessagePort | null = null;
  private readonly channels: number;
  private buf: Float32Array;
  private n = 0;

  constructor(options?: { processorOptions?: { channels?: number } }) {
    super(options);
    this.channels = options?.processorOptions?.channels ?? 1;
    this.buf = new Float32Array(FRAME * this.channels);
    this.port.onmessage = (e) => (this.out = e.data.port);
  }

  process(inputs: Float32Array[][]) {
    const input = inputs[0];
    if (!input?.length || !this.out) return true;
    const len = input[0].length;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < this.channels; c++) this.buf[this.n * this.channels + c] = (input[c] ?? input[0])[i];
      if (++this.n === FRAME) {
        this.out.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(FRAME * this.channels);
        this.n = 0;
      }
    }
    return true;
  }
}

class Source {
  chunks: Float32Array[] = [];
  channels = 1;
  /** Read position in frames within chunks[0]. */
  offset = 0;
  /** Buffered audio in frames (samples per channel). */
  buffered = 0;
  primed = false;
  gain = 1;
}

class Playback extends AudioWorkletProcessor {
  // Start playing a source once 60 ms is buffered; never let latency grow past 300 ms.
  private readonly target = Math.round(sampleRate * 0.06);
  private readonly max = Math.round(sampleRate * 0.3);
  private sources = new Map<string, Source>();
  private worker: MessagePort | null = null;
  /** When on, everything we play is sent back to the worker (reference for removing it from system audio). */
  private captureRef = false;
  private ref = new Float32Array(FRAME * 2);
  private refN = 0;

  constructor() {
    super();
    this.port.onmessage = (e) => {
      const port: MessagePort = e.data.port;
      this.worker = port;
      port.onmessage = (m) => this.onMessage(m.data);
    };
  }

  private onMessage(msg: { id: string; pcm?: Float32Array; channels?: number; gain?: number; remove?: boolean; captureRef?: boolean }) {
    if (msg.captureRef !== undefined) {
      this.captureRef = msg.captureRef;
      this.refN = 0;
      return;
    }
    if (msg.remove) return void this.sources.delete(msg.id);
    let s = this.sources.get(msg.id);
    if (!s) this.sources.set(msg.id, (s = new Source()));
    if (msg.gain !== undefined) s.gain = msg.gain;
    if (!msg.pcm) return;
    s.channels = msg.channels ?? 1;
    s.chunks.push(msg.pcm);
    s.buffered += msg.pcm.length / s.channels;
    while (s.buffered > this.max && s.chunks.length > 1) {
      const dropped = s.chunks.shift()!;
      s.buffered -= dropped.length / s.channels - s.offset;
      s.offset = 0;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] ?? out[0];
    const len = left.length;
    left.fill(0);
    if (right !== left) right.fill(0);
    for (const s of this.sources.values()) {
      if (!s.primed) {
        if (s.buffered < this.target) continue;
        s.primed = true;
      }
      const ch = s.channels;
      let i = 0;
      while (i < len && s.chunks.length) {
        const c = s.chunks[0];
        const frames = c.length / ch;
        const take = Math.min(len - i, frames - s.offset);
        for (let k = 0; k < take; k++) {
          const at = (s.offset + k) * ch;
          left[i + k] += c[at] * s.gain;
          if (right !== left) right[i + k] += c[at + (ch > 1 ? 1 : 0)] * s.gain;
        }
        i += take;
        s.offset += take;
        s.buffered -= take;
        if (s.offset === frames) {
          s.chunks.shift();
          s.offset = 0;
        }
      }
      // Ran dry: rebuffer before resuming so playback stays smooth.
      if (i < len) s.primed = false;
    }
    for (let i = 0; i < len; i++) {
      left[i] = Math.max(-1, Math.min(1, left[i]));
      if (right !== left) right[i] = Math.max(-1, Math.min(1, right[i]));
    }
    if (this.captureRef && this.worker) {
      for (let i = 0; i < len; i++) {
        this.ref[this.refN * 2] = left[i];
        this.ref[this.refN * 2 + 1] = right[i];
        if (++this.refN === FRAME) {
          this.worker.postMessage(this.ref, [this.ref.buffer]);
          this.ref = new Float32Array(FRAME * 2);
          this.refN = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('linkord-capture', Capture);
registerProcessor('linkord-playback', Playback);
