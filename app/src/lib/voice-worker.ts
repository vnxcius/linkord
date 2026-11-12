// Voice transport: owns the voice websocket and the Opus codecs, so audio never waits on the UI thread.

import {
  Application,
  createDecoder,
  createEncoder,
  Signal,
  type OpusDecoderHandle,
  type OpusEncoderHandle,
} from 'libopus-wasm';
import type { Denoiser, DenoiseKind } from './denoise';
import { EchoCanceller } from './echo-canceller';

export type WorkerIn =
  | {
      type: 'connect';
      url: string;
      token: string;
      channelId: string;
      capture: MessagePort | null;
      playback: MessagePort;
    }
  /** A microphone that became available after connecting (joined listen-only, or it came back). */
  | { type: 'capture'; port: MessagePort }
  | { type: 'screen_audio'; port: MessagePort | null }
  | { type: 'screen_audio_native'; on: boolean }
  | { type: 'screen_audio_pcm'; data: ArrayBuffer }
  | { type: 'echo_cancel'; on: boolean }
  | { type: 'mute'; muted: boolean }
  | { type: 'deafen'; deafened: boolean }
  | { type: 'state'; self_mute: boolean; self_deaf: boolean }
  | { type: 'video'; kind: 2 | 3; data: ArrayBuffer }
  | { type: 'video_stop'; source: string }
  | { type: 'watch'; user_id: string; on: boolean }
  | { type: 'request_keyframe'; user_id: string; source: string }
  | { type: 'gain'; id: string; gain: number }
  | { type: 'vad'; threshold: number; auto: boolean; ptt: boolean }
  | { type: 'ptt'; active: boolean }
  | { type: 'denoise'; kind: DenoiseKind | null }
  /** Watch together is playing out loud here (its audio can reach the mic and confuse speech detection). */
  | { type: 'media_playing'; on: boolean }
  /** Play a soundboard sound for everyone in the channel. */
  | { type: 'sound'; sound_id: string }
  /** Leaving the call: tells the server (so the seat ends now, not after the reconnect grace) and closes. */
  | { type: 'leave' };

export type WorkerOut =
  /** Connected. `resumed`: the server kept our seat (after a dropped connection or a server restart). */
  | { type: 'ready'; resumed: boolean }
  /** The connection dropped; the worker is getting the seat back by itself. */
  | { type: 'reconnecting'; code: number }
  | { type: 'closed'; code: number }
  | { type: 'speaking'; id: string; on: boolean }
  | { type: 'video'; id: string; source: 'camera' | 'screen'; data: ArrayBuffer }
  | { type: 'video_stop'; id: string; source: string }
  | { type: 'video_dropped'; kind: number }
  | { type: 'keyframe'; source: string }
  | { type: 'level'; rms: number; threshold: number }
  | { type: 'muted_talking' }
  | { type: 'ping'; ms: number }
  | { type: 'denoiser'; kind: DenoiseKind | null }
  | { type: 'stream_audio'; stats: StreamAudioStats }
  /** The server moves us to another channel (the AFK channel after a while without talking, or someone with
   * Move Members dragged us), or disconnects us (channelId null). `by` = who did it. */
  | { type: 'move'; channelId: string | null; reason?: string; by?: string }
  /** Someone in the channel (maybe us) played a soundboard sound. */
  | { type: 'sound'; userId: string; sound: import('./soundboard').Sound };

/** Once a second while streaming audio: what the capture delivers and what the echo canceller does with it. */
export interface StreamAudioStats {
  /** Captured frames per second (48000 when the capture keeps up) and reference (our playback) frames per second. */
  rate: number;
  refRate: number;
  /** Levels in dBFS: captured, after cancelling, and our playback. */
  inDb: number;
  outDb: number;
  refDb: number;
  /** Captured vs cancelled level over chunks while the voice chat was playing; null when it was silent. */
  suppressionDb: number | null;
  canceller: {
    locked: boolean;
    delayMs: number;
    confidence: number;
    realigns: number;
    rejects: number;
    tries: number;
    misses: number;
  } | null;
}

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

// Voice activity gate: only frames louder than the threshold (after the browser's noise suppression) are sent.
const VAD_HANGOVER_MS = 350;
/** While other audio plays (watch together, a stream), words trail off under it: hold the gate open longer. */
const VAD_HANGOVER_MEDIA_MS = 600;
/** RNNoise's speech probability that opens the gate, normally and while other audio plays. */
const SPEECH_OPEN = 0.5;
const SPEECH_OPEN_MEDIA = 0.25;
/** Stream audio we received within this long counts as playing. */
const STREAM_AUDIO_RECENT_MS = 400;
const MUTED_HINT_EVERY_MS = 4000;
const SPEAKING_TIMEOUT_MS = 250;
/** Voice is dropped (not queued) beyond this, so a slow uplink never adds delay to speech. */
const MAX_VOICE_BUFFER = 256 * 1024;
/**
 * Video has its own socket, but its queue still has to stay short: anything that can't go out within about
 * a second is stale. One 1080p keyframe fits; a backlog doesn't.
 */
const MAX_VIDEO_BUFFER = 768 * 1024;

const KIND_VOICE = 1;
const KIND_SCREEN_AUDIO = 4;
/** Music from a bot (Kass): stereo Opus on the voice socket, played and volume-controlled like their voice. */
const KIND_MUSIC = 5;

let ws: WebSocket | null = null;
/** Second connection for video and stream audio, so they never delay voice. */
let media: WebSocket | null = null;
let connectMsg: Extract<WorkerIn, { type: 'connect' }> | null = null;
let encoder: OpusEncoderHandle | null = null;
let screenEncoder: OpusEncoderHandle | null = null;
const decoders = new Map<string, Promise<OpusDecoderHandle>>();
let playback: MessagePort | null = null;
let muted = false;
let deafened = false;
let gateUntil = 0;
let selfSpeaking = false;
let threshold = 0.01;
let autoThreshold = true;
let pushToTalk = false;
let pttActive = false;
// Auto sensitivity tracks the background noise floor and opens the gate well above it.
let noiseFloor = 0.003;
let frameCount = 0;
let lastMutedHint = 0;
const lastHeard = new Map<string, number>();
/** Per-user volumes. They arrive before `connect` hands us the mixer, so they're kept and applied once it does. */
const gains = new Map<string, number>();
/** Streamers we're watching; stream audio from anyone else is dropped. */
const watched = new Set<string>();
// Advanced noise suppression (RNNoise) and its speech probability for the current frame.
let denoiser: Denoiser | null = null;
let denoiseKind: DenoiseKind | null = null;
/**
 * RNNoise's probability jumps around from frame to frame, and music under a voice pulls it down: a decaying peak
 * keeps one weak frame mid-word from closing the gate (which swallowed syllables during watch together).
 */
let speechHold = 0;
let mediaPlaying = false;
let lastStreamAudio = -Infinity;
// Windows 10 stream audio contains our own playback; this removes it (see echo-canceller.ts).
let canceller: EchoCanceller | null = null;

function sumSquares(frame: Float32Array) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return sum;
}

function rms(frame: Float32Array) {
  return Math.sqrt(sumSquares(frame) / frame.length);
}

const dbfs = (sq: number, n: number) => (n ? Math.max(-100, Math.round(10 * Math.log10(sq / n + 1e-10))) : -100);

// Stream-audio diagnostics (Windows 10 echo): sums over the current one-second window.
const REF_ACTIVE_MS = 300;
const emptyDiag = () => ({
  since: performance.now(),
  frames: 0,
  refFrames: 0,
  inSq: 0,
  outSq: 0,
  refSq: 0,
  echoInSq: 0,
  echoOutSq: 0,
});
let diag = emptyDiag();
let lastLoudRef = -Infinity;

function onReference(chunk: Float32Array) {
  const sq = sumSquares(chunk);
  diag.refFrames += chunk.length / 2;
  diag.refSq += sq;
  if (sq / chunk.length > 1e-6) lastLoudRef = performance.now();
  canceller?.pushReference(chunk);
}

function reportStreamAudio() {
  const d = diag;
  diag = emptyDiag();
  if (!screenEncoder) return;
  const secs = (diag.since - d.since) / 1000;
  const c = canceller;
  post({
    type: 'stream_audio',
    stats: {
      rate: Math.round(d.frames / secs),
      refRate: Math.round(d.refFrames / secs),
      inDb: dbfs(d.inSq, d.frames * 2),
      outDb: dbfs(d.outSq, d.frames * 2),
      refDb: dbfs(d.refSq, d.refFrames * 2),
      suppressionDb:
        d.echoInSq > 1e-6 ? Math.round(10 * Math.log10((d.echoInSq + 1e-10) / (d.echoOutSq + 1e-10))) : null,
      canceller: c && {
        locked: c.locked,
        delayMs: Math.round(c.delay / 48),
        confidence: Math.round(c.confidence),
        realigns: c.realigns,
        rejects: c.alignRejects,
        tries: c.alignTries,
        misses: c.alignMisses,
      },
    },
  });
}
setInterval(reportStreamAudio, 1000);

function setSelfSpeaking(on: boolean) {
  if (on !== selfSpeaking) post({ type: 'speaking', id: 'me', on: (selfSpeaking = on) });
}

function currentThreshold() {
  return autoThreshold ? Math.min(0.08, Math.max(0.006, noiseFloor * 4)) : threshold;
}

function sendPacket(kind: number, packet: Uint8Array, limit: number) {
  const sock = kind === KIND_VOICE ? ws : media;
  if (sock?.readyState !== WebSocket.OPEN || sock.bufferedAmount > limit) return false;
  const msg = new Uint8Array(packet.length + 1);
  msg[0] = kind;
  msg.set(packet, 1);
  sock.send(msg);
  return true;
}

function onCapture(frame: Float32Array) {
  const now = performance.now();
  const speech = denoiser ? denoiser.process(frame) : -1;
  const level = rms(frame);
  noiseFloor = level < noiseFloor ? noiseFloor * 0.9 + level * 0.1 : noiseFloor + (level - noiseFloor) * 0.002;
  if (++frameCount % 5 === 0) post({ type: 'level', rms: level, threshold: currentThreshold() });
  if (muted || deafened) {
    if (!pushToTalk && level > currentThreshold() * 1.5 && now - lastMutedHint > MUTED_HINT_EVERY_MS && !deafened) {
      lastMutedHint = now;
      post({ type: 'muted_talking' });
    }
    return setSelfSpeaking(false);
  }
  // With RNNoise and automatic sensitivity, its speech detection decides; otherwise the level threshold does.
  // Under other audio, speech scores lower, so the bar drops, and a clearly loud voice opens the gate by itself.
  const media = mediaPlaying || now - lastStreamAudio < STREAM_AUDIO_RECENT_MS;
  speechHold = Math.max(speech, speechHold * 0.8);
  const talking =
    speech >= 0 && autoThreshold
      ? (speechHold > (media ? SPEECH_OPEN_MEDIA : SPEECH_OPEN) && level > 0.002) ||
        (media && level > currentThreshold() * 2.5)
      : level > currentThreshold();
  if (pushToTalk ? pttActive : talking)
    gateUntil = now + (pushToTalk ? 0 : media ? VAD_HANGOVER_MEDIA_MS : VAD_HANGOVER_MS);
  const open = pushToTalk ? pttActive : now < gateUntil;
  setSelfSpeaking(open);
  if (open && encoder) sendPacket(KIND_VOICE, encoder.encodeFloat(frame), MAX_VOICE_BUFFER);
}

/** Screen-share audio: stereo, music quality, sent continuously (silence is skipped). */
function onScreenAudio(frame: Float32Array) {
  // Every chunk goes through the canceller, silent or not, so its sample counts stay aligned.
  let inSq = sumSquares(frame);
  if (canceller) {
    frame = canceller.process(frame);
    // The output lags the input (see HOLD_CHUNKS): compare it with the chunk it came from.
    inSq = canceller.lastInput ? sumSquares(canceller.lastInput) : 0;
  }
  const outSq = canceller ? sumSquares(frame) : inSq;
  diag.frames += frame.length / 2;
  diag.inSq += inSq;
  diag.outSq += outSq;
  if (performance.now() - lastLoudRef < REF_ACTIVE_MS) {
    diag.echoInSq += inSq;
    diag.echoOutSq += outSq;
  }
  if (!screenEncoder || rms(frame) < 0.0002) return;
  sendPacket(KIND_SCREEN_AUDIO, screenEncoder.encodeFloat(frame), MAX_VIDEO_BUFFER);
}

function decoderFor(key: string, channels: 1 | 2) {
  let d = decoders.get(key);
  if (!d) decoders.set(key, (d = createDecoder({ sampleRate: 48000, channels })));
  return d;
}

async function onAudio(id: string, packet: Uint8Array) {
  if (deafened) return;
  const pcm = (await decoderFor(id, 1)).decodeFloat(packet);
  playback?.postMessage({ id, pcm, channels: 1 }, [pcm.buffer]);
  if (!lastHeard.has(id)) post({ type: 'speaking', id, on: true });
  lastHeard.set(id, performance.now());
}

async function onStreamAudio(id: string, packet: Uint8Array) {
  // Only streams we chose to watch, even if the server still sends one (older servers kept old viewers).
  if (deafened || !watched.has(id)) return;
  const key = `${id}:screen`;
  const pcm = (await decoderFor(key, 2)).decodeFloat(packet);
  playback?.postMessage({ id: key, pcm, channels: 2 }, [pcm.buffer]);
}

async function onMusic(id: string, packet: Uint8Array) {
  if (deafened) return;
  const pcm = (await decoderFor(`${id}:music`, 2)).decodeFloat(packet);
  playback?.postMessage({ id, pcm, channels: 2 }, [pcm.buffer]);
  if (!lastHeard.has(id)) post({ type: 'speaking', id, on: true });
  lastHeard.set(id, performance.now());
}

function onBinary(buf: ArrayBuffer) {
  const view = new DataView(buf);
  const kind = view.getUint8(0);
  const id = view.getBigUint64(1).toString();
  if (kind === KIND_VOICE) void onAudio(id, new Uint8Array(buf, 9));
  else if (kind === KIND_SCREEN_AUDIO) {
    if (watched.has(id)) lastStreamAudio = performance.now();
    void onStreamAudio(id, new Uint8Array(buf, 9));
  } else if (kind === KIND_MUSIC) void onMusic(id, new Uint8Array(buf, 9));
  else if (kind === 2 || kind === 3) {
    const data = buf.slice(9);
    post({ type: 'video', id, source: kind === 2 ? 'camera' : 'screen', data }, [data]);
  }
}

function sendJson(msg: object) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function openMedia() {
  const msg = connectMsg;
  if (!msg || ws?.readyState !== WebSocket.OPEN) return;
  const sock = new WebSocket(msg.url.replace('/voice/connect', '/voice/media'));
  media = sock;
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => sock.send(JSON.stringify({ token: msg.token, channel_id: msg.channelId }));
  sock.onmessage = (e) => typeof e.data !== 'string' && onBinary(e.data);
  sock.onclose = () => {
    if (media !== sock) return;
    media = null;
    // Keep video flowing after network blips, as long as voice itself is still connected.
    setTimeout(openMedia, 300);
  };
}

let pingTimer: ReturnType<typeof setInterval> | undefined;

/** Closes after which we don't reconnect: signed out, the session moved to another device, not allowed in the
 * channel, or our seat was taken back by another connection of this login. */
const FINAL_CODES = new Set([4001, 4002, 4004, 4006]);
/** How long to keep trying to get the seat back before telling the app the connection is lost. */
const RECONNECT_FOR_MS = 60_000;
/** Nothing at all from the server for this long (pongs come every 2 s) = a dead connection the OS hasn't noticed. */
const SILENT_MS = 7000;
let leaving = false;
/** When the connection dropped (0 = connected). */
let lostAt = 0;
let attempt = 0;
let lastHeardAt = 0;

async function connect(msg: Extract<WorkerIn, { type: 'connect' }>) {
  connectMsg = msg;
  playback = msg.playback;
  playback.onmessage = (e) => onReference(e.data);
  for (const [id, gain] of gains) playback.postMessage({ id, gain });
  encoder = await createEncoder({
    sampleRate: 48000,
    channels: 1,
    application: Application.Voip,
    signal: Signal.Voice,
    bitrate: 40000,
    complexity: 8,
  });
  if (msg.capture) msg.capture.onmessage = (e) => onCapture(e.data);
  openVoice();
}

/** Opens the voice socket. `v: 2` = we reconnect by ourselves and say `leave` when leaving, so a dropped connection
 * keeps our seat on the server for a while and nobody sees us leave. */
function openVoice() {
  const msg = connectMsg;
  if (!msg || leaving) return;
  const sock = new WebSocket(msg.url);
  ws = sock;
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => sock.send(JSON.stringify({ token: msg.token, channel_id: msg.channelId, v: 2 }));
  sock.onmessage = (e) => {
    lastHeardAt = performance.now();
    if (typeof e.data !== 'string') return onBinary(e.data);
    const m = JSON.parse(e.data);
    if (m.op === 'ready') {
      lostAt = 0;
      attempt = 0;
      post({ type: 'ready', resumed: !!m.resumed });
      openMedia();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (performance.now() - lastHeardAt > SILENT_MS) return lose(sock, 4000);
        sendJson({ op: 'ping', t: performance.now() });
      }, 2000);
      sendJson({ op: 'ping', t: performance.now() });
    } else if (m.op === 'pong') post({ type: 'ping', ms: Math.round(performance.now() - m.t) });
    else if (m.op === 'video_stop') {
      // Drop whatever stream audio is still buffered, so it stops right away.
      if (m.source === 'screen') playback?.postMessage({ id: `${m.user_id}:screen`, remove: true });
      post({ type: 'video_stop', id: m.user_id, source: m.source });
    } else if (m.op === 'keyframe') post({ type: 'keyframe', source: m.source });
    else if (m.op === 'move') post({ type: 'move', channelId: m.channel_id, reason: m.reason, by: m.by });
    else if (m.op === 'sound') post({ type: 'sound', userId: m.user_id, sound: m.sound });
  };
  sock.onclose = (e) => lose(sock, e.code);
}

/** The voice socket is gone (closed, or silent too long): try to get the seat back, unless it's over for good. */
function lose(sock: WebSocket, code: number) {
  if (ws !== sock) return;
  ws = null;
  clearInterval(pingTimer);
  sock.onclose = null;
  sock.close();
  const m = media;
  media = null;
  m?.close();
  if (leaving) return;
  const now = performance.now();
  if (FINAL_CODES.has(code) || (lostAt && now - lostAt > RECONNECT_FOR_MS)) {
    lostAt = 0;
    return post({ type: 'closed', code });
  }
  if (!lostAt) {
    lostAt = now;
    post({ type: 'reconnecting', code });
  }
  // 4100: the server is restarting and the next one is already listening; spread the reconnects a little.
  const delay =
    attempt === 0 ? (code === 4100 ? 50 + Math.random() * 250 : 100) : Math.min(2000, 250 * 2 ** (attempt - 1));
  attempt++;
  setTimeout(openVoice, delay);
}

setInterval(() => {
  const now = performance.now();
  for (const [id, t] of lastHeard) {
    if (now - t > SPEAKING_TIMEOUT_MS) {
      lastHeard.delete(id);
      post({ type: 'speaking', id, on: false });
    }
  }
}, 100);

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  switch (m.type) {
    case 'connect':
      return void connect(m);
    case 'capture':
      if (connectMsg) connectMsg.capture = m.port;
      m.port.onmessage = (e) => onCapture(e.data);
      return;
    case 'screen_audio':
      if (!m.port) {
        screenEncoder?.free();
        screenEncoder = null;
        return;
      }
      screenEncoder ??= await createEncoder({
        sampleRate: 48000,
        channels: 2,
        application: Application.Audio,
        signal: Signal.Music,
        bitrate: 128000,
        complexity: 8,
      });
      diag = emptyDiag();
      m.port.onmessage = (ev) => onScreenAudio(ev.data);
      return;
    case 'screen_audio_native':
      if (m.on) {
        screenEncoder ??= await createEncoder({
          sampleRate: 48000,
          channels: 2,
          application: Application.Audio,
          signal: Signal.Music,
          bitrate: 128000,
          complexity: 8,
        });
        diag = emptyDiag();
      } else {
        screenEncoder?.free();
        screenEncoder = null;
      }
      return;
    case 'screen_audio_pcm':
      return onScreenAudio(new Float32Array(m.data));
    case 'echo_cancel':
      canceller = m.on ? new EchoCanceller(2) : null;
      playback?.postMessage({ captureRef: m.on });
      return;
    case 'mute':
      muted = m.muted;
      return;
    case 'deafen':
      deafened = m.deafened;
      return;
    case 'state':
      return sendJson({ op: 'state', self_mute: m.self_mute, self_deaf: m.self_deaf });
    case 'video':
      // Dropping a frame breaks the decode chain; the sender restarts it with a keyframe.
      if (!sendPacket(m.kind, new Uint8Array(m.data), MAX_VIDEO_BUFFER)) post({ type: 'video_dropped', kind: m.kind });
      return;
    case 'video_stop':
      return sendJson({ op: 'video_stop', source: m.source });
    case 'watch':
      if (m.on) watched.add(m.user_id);
      else {
        watched.delete(m.user_id);
        playback?.postMessage({ id: `${m.user_id}:screen`, remove: true });
      }
      return sendJson({ op: 'watch', user_id: m.user_id, on: m.on });
    case 'request_keyframe':
      return sendJson({ op: 'request_keyframe', user_id: m.user_id, source: m.source });
    case 'sound':
      return sendJson({ op: 'sound', sound_id: m.sound_id });
    case 'leave': {
      leaving = true;
      sendJson({ op: 'leave' });
      const sock = ws;
      ws = null;
      clearInterval(pingTimer);
      media?.close();
      media = null;
      // A normal close sends what's queued (the leave) first.
      sock?.close(1000);
      setTimeout(() => self.close(), 500);
      return;
    }
    case 'gain':
      gains.set(m.id, m.gain);
      playback?.postMessage({ id: m.id, gain: m.gain });
      return;
    case 'vad':
      threshold = m.threshold;
      autoThreshold = m.auto;
      pushToTalk = m.ptt;
      return;
    case 'ptt':
      pttActive = m.active;
      return;
    case 'media_playing':
      mediaPlaying = m.on;
      return;
    case 'denoise': {
      if (m.kind === denoiseKind) return;
      denoiseKind = m.kind;
      const old = denoiser;
      denoiser = null;
      old?.dispose();
      if (m.kind) {
        const kind = m.kind;
        const { createDenoiser } = await import('./denoise');
        const d = await createDenoiser(kind).catch((e) => (console.warn('noise suppression unavailable', e), null));
        // Ignore if the setting changed again while loading.
        if (denoiseKind === kind) denoiser = d;
        else d?.dispose();
      }
      post({ type: 'denoiser', kind: denoiser ? denoiseKind : null });
      return;
    }
  }
};
