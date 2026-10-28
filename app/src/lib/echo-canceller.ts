// Removes Linkord's own playback (the voice chat) from whole-system loopback audio. Used on Windows 10,
// where Windows can't leave one app's sound out of a capture.
//
// The "echo" here is digital: the loopback contains exactly the samples we played, delayed by the output
// pipeline and scaled by the app volume. So we find the delay with an FFT cross-correlation, then fit a
// short filter around it by least squares over the last couple of seconds. Other sound in the capture
// (games, music) is uncorrelated with our playback, so it averages out of the fit instead of disturbing it.

const RATE = 48000;
const RING = RATE * 3; // reference history per channel
const MAX_DELAY = Math.round(RATE * 0.4); // output + capture latency we search over
const SEG = 8192; // loopback samples used per correlation
const FFT_SIZE = 32768;
const TAPS = 8;
const PRE = 3; // taps before the estimated delay (fractional delay / resampling smear)
/** Per-sample forgetting factor: the fit follows the last ~2 s (volume changes, drift). */
const LAMBDA = Math.exp(-1 / (RATE * 2));
const REGULARIZE = 1e-4;
const RECHECK_EVERY = RATE * 3;
/**
 * Loopback chunks held back before cancelling. Our playback reference reaches the worker about when the
 * loopback containing it does (measured on a Windows 10 PC), sometimes later; a reference sample that hasn't
 * arrived can't be subtracted. 3 chunks = 60 ms more stream-audio latency on Windows 10 only.
 */
export const HOLD_CHUNKS = 3;

/** In-place radix-2 complex FFT. `inverse` returns the unscaled inverse. */
function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

export class EchoCanceller {
  private readonly channels: number;
  private readonly ref: Float32Array[];
  /** Reference samples (per channel) received so far. */
  private refCount = 0;
  /** Loopback samples (per channel) processed so far. */
  private loopCount = 0;
  /** Reference index = loopback index + offset, once locked. */
  private offset: number | null = null;
  /** First estimate of offset ignoring latency: reference written minus loopback received, at arrival. */
  private anchor: number | null = null;
  private readonly weights: Float64Array[];
  /** Exponentially weighted reference autocorrelation (TAPS x TAPS) and reference/loopback cross-correlation. */
  private readonly rxx: Float64Array[];
  private readonly rxy: Float64Array[];
  private readonly loopHistory: Float32Array;
  private sinceCheck = 0;
  private readonly held: Float32Array[] = [];
  /** The captured chunk the last process() output was made from (it lags the input by HOLD_CHUNKS). */
  lastInput: Float32Array | null = null;
  /** Exposed for diagnostics/tests: last measured delay in samples and correlation confidence. */
  delay = 0;
  confidence = 0;
  /** Times the measured delay changed after locking (drift or a changed output path). */
  realigns = 0;
  /** Alignment attempts, and how many found no clear match. */
  alignTries = 0;
  alignMisses = 0;
  /** Re-checks that found a different delay but not a better one (kept the current lock). */
  alignRejects = 0;

  /** True once a delay was found; until then loopback passes through unchanged. */
  get locked() {
    return this.offset !== null;
  }

  constructor(channels = 2) {
    this.channels = channels;
    this.ref = Array.from({ length: channels }, () => new Float32Array(RING));
    this.weights = Array.from({ length: channels }, () => new Float64Array(TAPS));
    this.rxx = Array.from({ length: channels }, () => new Float64Array(TAPS * TAPS));
    this.rxy = Array.from({ length: channels }, () => new Float64Array(TAPS));
    this.loopHistory = new Float32Array(SEG);
  }

  /** Our own playback, interleaved, in the order it was rendered. */
  pushReference(chunk: Float32Array) {
    const ch = this.channels;
    const frames = chunk.length / ch;
    for (let i = 0; i < frames; i++) {
      const at = (this.refCount + i) % RING;
      for (let c = 0; c < ch; c++) this.ref[c][at] = chunk[i * ch + c];
    }
    this.refCount += frames;
  }

  private refAt(c: number, index: number): number {
    if (index < 0 || index >= this.refCount || this.refCount - index > RING) return 0;
    return this.ref[c][index % RING];
  }

  /** Cancels our playback from a loopback chunk (interleaved), returning a new chunk HOLD_CHUNKS behind it. */
  process(input: Float32Array): Float32Array {
    this.held.push(input);
    if (this.held.length <= HOLD_CHUNKS) {
      this.lastInput = null;
      return new Float32Array(input.length);
    }
    const chunk = this.held.shift()!;
    this.lastInput = chunk;
    const ch = this.channels;
    const frames = chunk.length / ch;
    // Remember recent loopback (mono) for alignment.
    this.loopHistory.copyWithin(0, frames);
    for (let i = 0; i < frames; i++) {
      let m = 0;
      for (let c = 0; c < ch; c++) m += chunk[i * ch + c];
      this.loopHistory[SEG - frames + i] = m / ch;
    }
    this.anchor ??= this.refCount - this.loopCount - frames;
    this.sinceCheck += frames;
    if (this.offset === null ? this.sinceCheck >= SEG : this.sinceCheck >= RECHECK_EVERY) {
      this.sinceCheck = 0;
      this.align(frames);
    }

    const out = new Float32Array(chunk.length);
    if (this.offset === null) {
      out.set(chunk);
      this.loopCount += frames;
      return out;
    }
    const xs = new Float64Array(TAPS);
    for (let c = 0; c < ch; c++) {
      const w = this.weights[c];
      const R = this.rxx[c];
      const r = this.rxy[c];
      for (let i = 0; i < frames; i++) {
        const j = this.loopCount + i + this.offset - PRE;
        let est = 0;
        let energy = 0;
        for (let t = 0; t < TAPS; t++) {
          const x = this.refAt(c, j + t);
          xs[t] = x;
          est += w[t] * x;
          energy += x * x;
        }
        const y = chunk[i * ch + c];
        out[i * ch + c] = y - est;
        // Accumulate statistics only while we're actually playing something.
        if (energy > 1e-7) {
          for (let a = 0; a < TAPS; a++) {
            r[a] = LAMBDA * r[a] + xs[a] * y;
            for (let b = 0; b <= a; b++) R[a * TAPS + b] = LAMBDA * R[a * TAPS + b] + xs[a] * xs[b];
          }
        }
      }
      this.solve(c);
    }
    this.loopCount += frames;
    return out;
  }

  /** Solves R w = r (Gaussian elimination on a small symmetric system), keeping the old fit if singular. */
  private solve(c: number) {
    const n = TAPS;
    const R = this.rxx[c];
    const a = new Float64Array(n * (n + 1));
    let trace = 0;
    for (let i = 0; i < n; i++) trace += R[i * n + i];
    if (trace < 1e-3) return; // not enough of our playback heard yet
    const reg = (trace / n) * REGULARIZE;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) a[i * (n + 1) + j] = i >= j ? R[i * n + j] : R[j * n + i];
      a[i * (n + 1) + i] += reg;
      a[i * (n + 1) + n] = this.rxy[c][i];
    }
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let row = col + 1; row < n; row++) if (Math.abs(a[row * (n + 1) + col]) > Math.abs(a[piv * (n + 1) + col])) piv = row;
      if (Math.abs(a[piv * (n + 1) + col]) < 1e-12) return;
      if (piv !== col) for (let k = 0; k <= n; k++) [a[col * (n + 1) + k], a[piv * (n + 1) + k]] = [a[piv * (n + 1) + k], a[col * (n + 1) + k]];
      for (let row = col + 1; row < n; row++) {
        const f = a[row * (n + 1) + col] / a[col * (n + 1) + col];
        for (let k = col; k <= n; k++) a[row * (n + 1) + k] -= f * a[col * (n + 1) + k];
      }
    }
    const w = this.weights[c];
    for (let row = n - 1; row >= 0; row--) {
      let v = a[row * (n + 1) + n];
      for (let k = row + 1; k < n; k++) v -= a[row * (n + 1) + k] * w[k];
      w[row] = v / a[row * (n + 1) + row];
    }
  }

  /** Single-tap least-squares fit of the loopback segment to the reference at `offset`: gain and share of energy explained. */
  private fit(loopStart: number, offset: number, loopEnergy: number) {
    let num = 0;
    let den = 1e-9;
    for (let i = 0; i < SEG; i++) {
      let x = 0;
      for (let c = 0; c < this.channels; c++) x += this.refAt(c, loopStart + i + offset);
      x /= this.channels;
      num += x * this.loopHistory[i];
      den += x * x;
    }
    return { gain: Math.max(0, Math.min(2, num / den)), explained: (num * num) / den / loopEnergy };
  }

  /** Finds the delay between reference and loopback with a PHAT-weighted cross-correlation. */
  private align(frames: number) {
    // loopHistory already ends with the current chunk, which loopCount doesn't include yet.
    const loopStart = this.loopCount + frames - SEG;
    let loopEnergy = 0;
    for (const v of this.loopHistory) loopEnergy += v * v;
    if (loopEnergy < 1e-3 || this.anchor === null) return;
    // Reference window that could contain the loopback segment: up to MAX_DELAY earlier than the anchor.
    const refStart = loopStart + this.anchor - MAX_DELAY;
    const re1 = new Float64Array(FFT_SIZE);
    const im1 = new Float64Array(FFT_SIZE);
    const re2 = new Float64Array(FFT_SIZE);
    const im2 = new Float64Array(FFT_SIZE);
    let refEnergy = 0;
    for (let i = 0; i < SEG + MAX_DELAY + 2048 && i < FFT_SIZE; i++) {
      let m = 0;
      for (let c = 0; c < this.channels; c++) m += this.refAt(c, refStart + i);
      re1[i] = m / this.channels;
      refEnergy += re1[i] * re1[i];
    }
    if (refEnergy < 1e-3) return;
    this.alignTries++;
    for (let i = 0; i < SEG; i++) re2[i] = this.loopHistory[i];
    fft(re1, im1);
    fft(re2, im2);
    // cross-spectrum R * conj(L), whitened (PHAT) so the peak is sharp regardless of content.
    for (let k = 0; k < FFT_SIZE; k++) {
      const r = re1[k] * re2[k] + im1[k] * im2[k];
      const i = im1[k] * re2[k] - re1[k] * im2[k];
      const mag = Math.hypot(r, i) + 1e-12;
      re1[k] = r / mag;
      im1[k] = i / mag;
    }
    fft(re1, im1, true);
    let best = 0;
    let bestLag = 0;
    let sum = 0;
    const lags = MAX_DELAY + 2048;
    for (let lag = 0; lag < lags; lag++) {
      const v = re1[lag];
      sum += Math.abs(v);
      if (v > best) {
        best = v;
        bestLag = lag;
      }
    }
    const confidence = best / (sum / lags);
    if (confidence < 8) return void this.alignMisses++; // no clear match (e.g. the voice chat is silent)
    const offset = refStart + bestLag - loopStart;
    if (offset === this.offset) {
      this.confidence = confidence;
      return;
    }
    const next = this.fit(loopStart, offset, loopEnergy);
    if (this.offset !== null) {
      // A re-check only moves a working lock when the new delay explains clearly more of what we captured.
      // Single weak peaks (a pause in the voice chat, repetitive game music) used to replace a good lock
      // and wipe the filter every few seconds, so nothing was ever removed.
      const now = this.fit(loopStart, this.offset, loopEnergy);
      if (next.explained < 0.05 || next.explained < now.explained * 1.5) return void this.alignRejects++;
      this.realigns++;
    }
    this.confidence = confidence;
    this.delay = this.anchor - offset;
    this.offset = offset;
    // Start the filter at the measured gain on the centre tap; the least-squares fit refines it.
    for (let c = 0; c < this.channels; c++) {
      this.weights[c].fill(0);
      this.weights[c][PRE] = next.gain;
      this.rxx[c].fill(0);
      this.rxy[c].fill(0);
    }
  }
}
