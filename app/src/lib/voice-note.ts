// Voice messages (WhatsApp-style): records the mic with MediaRecorder, keeps a loudness level every
// 100 ms for the live waveform, and packs a fixed-size waveform for the message bubble.

import { createSignal } from 'solid-js';
import { prefs } from './prefs';

/** Bars in a voice message's waveform (one byte each, like Discord's voice messages). */
export const BARS = 48;
/** Shorter recordings are discarded, like WhatsApp. */
export const MIN_MS = 1000;
/** The server refuses longer ones. */
export const MAX_MS = 20 * 60_000;
const TICK_MS = 100;

export interface VoiceClip {
  file: File;
  duration: number;
  /** Base64, BARS bytes of loudness 0–255. */
  waveform: string;
}

function mimeType() {
  for (const t of ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4'])
    if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}

/** Loudness 0–1 from an RMS level, on a dB scale so quiet speech still shows. */
const loudness = (rms: number) => Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-9) + 55) / 50));

/** Resamples levels to n bars (peak per bucket), scaled so the loudest bar is full height. */
export function packWaveform(levels: number[], n = BARS): Uint8Array {
  const out = new Uint8Array(n);
  if (!levels.length) return out;
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * levels.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / n));
    let peak = 0;
    for (let j = a; j < b && j < levels.length; j++) peak = Math.max(peak, levels[j]);
    out[i] = Math.round(peak * 255);
  }
  const max = Math.max(...out, 1);
  return out.map((v) => Math.round((v / max) * 255));
}

export const encodeWaveform = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

export function decodeWaveform(b64?: string): number[] {
  try {
    return b64 ? [...atob(b64)].map((c) => c.charCodeAt(0) / 255) : [];
  } catch {
    return [];
  }
}

export type Recorder = Awaited<ReturnType<typeof startRecording>>;

export async function startRecording() {
  const device = prefs.inputDevice && prefs.inputDevice !== 'default' ? { deviceId: { exact: prefs.inputDevice } } : {};
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { ...device, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const type = mimeType();
  const rec = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 32_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  const [elapsed, setElapsed] = createSignal(0);
  const [paused, setPaused] = createSignal(false);
  const [levels, setLevels] = createSignal<number[]>([]);
  let runStart = performance.now();
  let banked = 0;
  let onLimit: (() => void) | undefined;

  const timer = setInterval(() => {
    if (paused()) return;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const x of buf) sum += x * x;
    setLevels((l) => [...l, loudness(Math.sqrt(sum / buf.length))]);
    setElapsed(banked + performance.now() - runStart);
    if (elapsed() >= MAX_MS) onLimit?.();
  }, TICK_MS);
  rec.start(1000);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
  const stopped = () =>
    new Promise<void>((resolve) => {
      if (rec.state === 'inactive') return resolve();
      rec.onstop = () => resolve();
      rec.stop();
    });
  const blob = () => new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' });

  return {
    elapsed,
    paused,
    levels,
    /** Called once when the recording reaches MAX_MS. */
    set onLimit(fn: () => void) {
      onLimit = fn;
    },
    pause() {
      if (paused() || rec.state !== 'recording') return;
      rec.pause();
      banked += performance.now() - runStart;
      setElapsed(banked);
      setPaused(true);
    },
    resume() {
      if (!paused()) return;
      rec.resume();
      runStart = performance.now();
      setPaused(false);
    },
    /** What's been recorded so far (while paused), to listen back before sending. */
    async snapshot(): Promise<Blob> {
      if (rec.state === 'inactive') return blob();
      const flushed = new Promise<void>((r) => rec.addEventListener('dataavailable', () => r(), { once: true }));
      rec.requestData();
      await flushed;
      return blob();
    },
    async finish(): Promise<VoiceClip> {
      if (!paused()) setElapsed(banked + performance.now() - runStart);
      await stopped();
      close();
      const b = blob();
      const ext = b.type.includes('ogg') ? 'ogg' : b.type.includes('mp4') ? 'm4a' : 'webm';
      return {
        file: new File([b], `voice-message.${ext}`, { type: b.type.split(';')[0] }),
        duration: elapsed() / 1000,
        waveform: encodeWaveform(packWaveform(levels())),
      };
    },
    cancel() {
      void stopped().then(close);
      close();
    },
  };
}
