// Voice and video. Audio is Opus (WASM) relayed by the pottira server over a websocket, so it works
// wherever the app itself loads: no ports, TURN or media server to configure.

import { t } from './i18n';
import { createEffect, createRoot, createSignal, untrack } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import workletUrl from './voice-worklets.ts?worker&url';
import type { StreamAudioStats, WorkerIn, WorkerOut } from './voice-worker';
import { api, getToken, serverUrl } from './api';
import { getCamera, getMic, isChosenMic, outputSinkId } from './media-devices';
import { prefs, setPrefs } from './prefs';
import { sounds } from './sounds';
import { nameOf, state } from './store';
import type { VoiceState } from './types';
import { toast } from './ui';
import { report } from './report';
import type { Sound } from './soundboard';
import {
  captureAudioStats,
  captureVideoStats,
  nativeCaptureAvailable,
  nativeCommand,
  setNativeQuality,
  startNativeCapture,
  switchNativeSource,
  type CaptureAudioStats,
  type CaptureInfo,
  type CaptureVideoStats,
} from './native-capture';

export interface VideoTile {
  key: string;
  identity: string;
  source: 'camera' | 'screen';
  /** Local preview of our own camera/screen. Remote tiles render into a registered canvas. */
  stream?: MediaStream;
}

export const [voiceUi, setVoiceUi] = createStore({
  channelId: null as string | null,
  connecting: false,
  muted: false,
  deafened: false,
  camera: false,
  screen: false,
  error: null as string | null,
  speaking: {} as Record<string, boolean>,
  /** Shown briefly when you talk while muted. */
  mutedTalking: false,
  /** Live mic level and the current voice-activity threshold, for the settings meter. */
  level: 0,
  threshold: 0,
  pttActive: false,
  /** When this call started (survives automatic reconnects), for the call timer. */
  joinedAt: null as number | null,
  /** Push-to-mute key held. */
  pushMuted: false,
  /** Streamers whose screen share we're watching. */
  watching: {} as Record<string, boolean>,
  /** Focused tile key (`<user>-screen` / `<user>-camera`), shown large. */
  focus: null as string | null,
  /** Collapse the participant strip under a focused stream. */
  hideStrip: false,
  /** What the call grid shows: everyone, only streams and cameras (watch several at once), or only people. */
  gridShow: 'all' as 'all' | 'video' | 'people',
  streamQuality: null as StreamQuality | null,
  stats: {} as Record<string, StreamStats>,
  /** Our own stream's audio path and echo-canceller readout (Windows 10 echo diagnostics). */
  streamAudio: null as StreamAudioDiag | null,
  /** Our native stream's per-stage timings (desktop capture), refreshed every second. */
  captureTimings: null as CaptureVideoStats | null,
  /** Streams this device can't decode, with their codec. */
  unsupported: {} as Record<string, string>,
  /** Noise suppression model actually running in the voice pipeline. */
  denoiser: null as string | null,
  /** Video key (`<user>-screen`) playing in the OS picture-in-picture window; players in the app show a placeholder. */
  poppedOut: null as string | null,
  /** Who is playing a soundboard sound right now (user id -> its emoji). */
  soundPlaying: {} as Record<string, string | undefined>,
  /** Our own stream's preview is hidden (saves decoding it). */
  hidePreview: false,
  /** Round-trip time to the voice server (ms) and recent history for the graph. */
  ping: null as number | null,
  pingHistory: [] as number[],
});

const [tiles, setTiles] = createSignal<VideoTile[]>([]);
export { tiles as videoTiles };

export const canSendVideo = typeof VideoEncoder !== 'undefined';
export const canShareScreen = canSendVideo && !!navigator.mediaDevices?.getDisplayMedia;
export const canReceiveVideo = typeof VideoDecoder !== 'undefined';

let worker: Worker | null = null;
let audio: AudioContext | null = null;
let mic: MediaStream | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
let captureNode: AudioWorkletNode | null = null;
let generation = 0;
let retries = 0;
/** The worker is getting our seat back after a dropped connection (or a server restart). */
let reconnecting = false;
/** Shows "connecting" only if getting the seat back takes a while: a restart takes well under a second. */
let reconnectingTimer: number | undefined;
let droppedAt = 0;

const send = (m: WorkerIn, transfer: Transferable[] = []) => worker?.postMessage(m, transfer);

/** REC: whether the voice chat goes into the recording, and whose voice stays out (lib/rec.ts decides). */
let recordingVoices: { on: boolean; exclude: string[] } = { on: false, exclude: [] };
/** Recording mix frames waiting to go to the desktop shell: sent ~100 ms at a time instead of 50 calls a second. */
let recPending: Float32Array[] = [];
const REC_BATCH = 5;

/** REC records the voice chat (on) without the people in `exclude` (they opted out of recordings). */
export function setRecordingVoices(on: boolean, exclude: string[]) {
  const same =
    on === recordingVoices.on &&
    exclude.length === recordingVoices.exclude.length &&
    exclude.every((id, i) => id === recordingVoices.exclude[i]);
  if (same) return;
  recordingVoices = { on, exclude };
  if (!on) recPending = [];
  send({ type: 'recording', on, exclude });
}

function sendRecAudio(data: ArrayBuffer) {
  if (!recordingVoices.on) return;
  recPending.push(new Float32Array(data));
  if (recPending.length < REC_BATCH) return;
  const out = new Float32Array(recPending.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of recPending) {
    out.set(f, at);
    at += f.length;
  }
  recPending = [];
  void import('@tauri-apps/api/core').then(({ invoke }) =>
    invoke('rec_voice_audio', new Uint8Array(out.buffer)).catch(() => {}),
  );
}

let mediaPlaying = false;
/**
 * Watch together is playing out loud here: its sound reaches the mic, and the voice gate eases up so it doesn't
 * swallow words under it (voice-worker.ts). Streams we watch are noticed by the worker itself.
 */
export function setMediaPlaying(on: boolean) {
  if (on === mediaPlaying) return;
  mediaPlaying = on;
  send({ type: 'media_playing', on });
}

/** A server's AFK channel: everyone in it is muted. */
export const isAfkChannel = (channelId: string | null) => {
  const g = channelId ? state.channels[channelId]?.guild_id : null;
  return !!g && state.guilds[g]?.afk_channel_id === channelId;
};
/** Our mute before entering an AFK channel, put back when we leave it for another channel. */
let mutedBeforeAfk: boolean | null = null;

// The channel we're in becoming the AFK channel mutes us too.
createRoot(() =>
  createEffect(() => {
    if (!isAfkChannel(voiceUi.channelId) || untrack(() => voiceUi.muted)) return;
    mutedBeforeAfk ??= false;
    setVoiceUi('muted', true);
    send({ type: 'mute', muted: true });
    syncState();
  }),
);

export async function joinVoice(channelId: string) {
  if (voiceUi.channelId === channelId && worker) return;
  if (isAfkChannel(channelId)) {
    mutedBeforeAfk ??= voiceUi.muted;
    setVoiceUi('muted', true);
  } else if (mutedBeforeAfk !== null) {
    setVoiceUi('muted', mutedBeforeAfk);
    mutedBeforeAfk = null;
  }
  const gen = ++generation;
  teardown();
  if (voiceUi.channelId !== channelId) setVoiceUi('joinedAt', null);
  setVoiceUi({ channelId, connecting: true, error: null });
  try {
    mic = await openMic();
    if (gen !== generation) return mic?.getTracks().forEach((t) => t.stop());
    if (!mic) {
      toast(t('No microphone access — joined listen-only'));
      setVoiceUi('muted', true);
    }

    audio = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await applyOutputDevice();
    await audio.audioWorklet.addModule(workletUrl);
    if (gen !== generation) return;

    const playback = new AudioWorkletNode(audio, 'pottira-playback', { numberOfInputs: 0, outputChannelCount: [2] });
    playback.connect(audio.destination);
    const playCh = new MessageChannel();
    playback.port.postMessage({ port: playCh.port1 }, [playCh.port1]);

    let capturePort: MessagePort | null = null;
    if (mic) {
      capturePort = newCapture(audio);
      plugMic(mic);
    }

    worker = new Worker(new URL('./voice-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerOut>) => gen === generation && onWorker(e.data, channelId);
    send({ type: 'mute', muted: voiceUi.muted });
    send({ type: 'deafen', deafened: voiceUi.deafened });
    send({ type: 'recording', ...recordingVoices });
    syncVad();
    for (const [id, v] of Object.entries(prefs.userVolumes)) send({ type: 'gain', id, gain: v });
    const url = serverUrl().replace(/^http/, 'ws') + '/api/voice/connect';
    const transfer: Transferable[] = capturePort ? [capturePort, playCh.port2] : [playCh.port2];
    send(
      { type: 'connect', url, token: getToken() ?? '', channelId, capture: capturePort, playback: playCh.port2 },
      transfer,
    );
    await audio.resume();
  } catch (e) {
    if (gen !== generation) return;
    console.error('voice join failed', e);
    report('error', 'Voice: joining failed', e);
    teardown();
    setVoiceUi({
      channelId: null,
      connecting: false,
      joinedAt: null,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function onWorker(m: WorkerOut, channelId: string) {
  switch (m.type) {
    case 'rec_audio':
      return sendRecAudio(m.data);
    case 'ready': {
      const again = retries > 0 || reconnecting;
      if (!again) sounds.selfJoin();
      if (reconnecting && !m.resumed)
        report('warn', 'Voice: seat was gone after reconnecting', { ms: Date.now() - droppedAt });
      retries = 0;
      reconnecting = false;
      clearTimeout(reconnectingTimer);
      if (!voiceUi.joinedAt) setVoiceUi('joinedAt', Date.now());
      setVoiceUi('connecting', false);
      // After a reconnect, resume watching what we were watching.
      for (const [id, on] of Object.entries(voiceUi.watching)) if (on) send({ type: 'watch', user_id: id, on: true });
      send({ type: 'media_playing', on: mediaPlaying });
      // A kept seat has the state from before the drop; anything changed meanwhile is sent now.
      if (again || voiceUi.muted || voiceUi.deafened) syncState();
      return;
    }
    case 'reconnecting':
      // Mic, audio and our own stream keep running: the worker reconnects and the server kept our seat.
      reconnecting = true;
      droppedAt = Date.now();
      clearTimeout(reconnectingTimer);
      reconnectingTimer = window.setTimeout(() => reconnecting && setVoiceUi('connecting', true), 1500);
      // 4100 = a server restart (expected); anything else is worth knowing about (logs.rs, the monitor).
      if (m.code !== 4100) report('warn', 'Voice: connection dropped, reconnecting', { code: m.code });
      return;
    case 'speaking':
      return setVoiceUi('speaking', m.id === 'me' ? state.me!.id : m.id, m.on);
    case 'level':
      return setVoiceUi({ level: m.rms, threshold: m.threshold });
    case 'denoiser':
      return setVoiceUi('denoiser', m.kind);
    case 'stream_audio':
      return onStreamAudioStats(m.stats);
    case 'ping':
      setVoiceUi('ping', m.ms);
      setVoiceUi('pingHistory', (h) => [...h.slice(-29), m.ms]);
      return;
    case 'muted_talking':
      // Once per MUTED_HINT_GAP at most: talking while muted on purpose shouldn't nag.
      if (voiceUi.mutedTalking || Date.now() - lastMutedHint < MUTED_HINT_GAP) return;
      lastMutedHint = Date.now();
      setVoiceUi('mutedTalking', true);
      clearTimeout(mutedHintTimer);
      mutedHintTimer = window.setTimeout(() => setVoiceUi('mutedTalking', false), 3000);
      return;
    case 'video':
      return onRemoteVideo(m.id, m.source, m.data);
    case 'video_stop':
      return removeRemoteVideo(`${m.id}-${m.source}`);
    case 'keyframe':
      return onKeyframeRequest(m.source);
    case 'sound':
      return void playSoundboard(m.userId, m.sound);
    case 'move': {
      const by = m.by ? nameOf(m.by, state.channels[channelId]?.guild_id) : '';
      if (!m.channelId) {
        void leaveVoice();
        return toast(by ? t('{name} disconnected you from the call', { name: by }) : t('You were disconnected'), 6000);
      }
      if (m.reason === 'afk') toast(t('You were moved to the AFK channel after a while without talking'), 6000);
      else if (by)
        toast(t('{name} moved you to {channel}', { name: by, channel: state.channels[m.channelId]?.name ?? '' }), 6000);
      return void joinVoice(m.channelId);
    }
    case 'video_dropped':
      return onVideoDropped(m.kind);
    case 'closed': {
      const intentional = m.code === 4002 || m.code === 4001 || m.code === 4004 || m.code === 4006;
      reconnecting = false;
      clearTimeout(reconnectingTimer);
      teardown();
      if (m.code === 4002 || m.code === 4006) toast(t('Voice moved to another session'));
      // Network blip: rejoin quietly a few times before giving up.
      if (!intentional && retries < 5) {
        retries++;
        setVoiceUi('connecting', true);
        const gen = generation;
        setTimeout(() => gen === generation && void joinVoice(channelId), 1000 * retries);
        return;
      }
      if (!intentional) report('warn', 'Voice: connection lost after retries', { code: m.code });
      setVoiceUi({
        channelId: null,
        connecting: false,
        joinedAt: null,
        error: intentional ? null : t('Voice connection lost'),
      });
    }
  }
}

let mutedHintTimer: number | undefined;
let lastMutedHint = 0;
const MUTED_HINT_GAP = 60_000;

function teardown() {
  closePopOut();
  stopPublish('camera');
  stopPublish('screen');
  if (worker) {
    // The worker tells the server we left (or the seat would wait for a reconnect) and then closes itself.
    const w = worker;
    w.onmessage = null;
    w.postMessage({ type: 'leave' } satisfies WorkerIn);
    setTimeout(() => w.terminate(), 1500);
  }
  worker = null;
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
  micSource = null;
  captureNode = null;
  micGone = false;
  void audio?.close();
  audio = null;
  for (const r of remotes.values()) r.decoder.state !== 'closed' && r.decoder.close();
  remotes.clear();
  setTiles([]);
  setVoiceUi({ focus: null, streamQuality: null, ping: null, pingHistory: [], pushMuted: false, pttActive: false });
  setVoiceUi('stats', reconcile({}));
  setVoiceUi('streamAudio', null);
  setVoiceUi('unsupported', reconcile({}));
  setVoiceUi(
    'speaking',
    produce((s) => Object.keys(s).forEach((k) => delete s[k])),
  );
}

export async function leaveVoice() {
  if (voiceUi.channelId) sounds.disconnect();
  setVoiceUi('watching', reconcile({}));
  generation++;
  retries = 0;
  teardown();
  setVoiceUi({ channelId: null, connecting: false, joinedAt: null });
  // Leaving from the AFK channel: back to how you were.
  if (mutedBeforeAfk !== null) {
    setVoiceUi('muted', mutedBeforeAfk);
    mutedBeforeAfk = null;
  }
}

function syncState() {
  send({ type: 'state', self_mute: voiceUi.muted, self_deaf: voiceUi.deafened });
}

export async function toggleMute() {
  if (!mic && voiceUi.channelId) return toast(t('No microphone available'));
  if (isAfkChannel(voiceUi.channelId)) return toast(t('Everyone is muted in the AFK channel'));
  const muted = !voiceUi.muted;
  (muted ? sounds.mute : sounds.unmute)();
  // Unmuting while deafened also undeafens, like Discord.
  setVoiceUi({ muted, deafened: muted ? voiceUi.deafened : false, mutedTalking: false });
  send({ type: 'mute', muted });
  send({ type: 'deafen', deafened: voiceUi.deafened });
  syncState();
}

export async function toggleDeafen() {
  const deafened = !voiceUi.deafened;
  (deafened ? sounds.deafen : sounds.undeafen)();
  setVoiceUi({ deafened, muted: deafened || (!mic && !!voiceUi.channelId) || isAfkChannel(voiceUi.channelId) });
  send({ type: 'deafen', deafened });
  send({ type: 'mute', muted: voiceUi.muted });
  syncState();
}

// ---------- video: WebCodecs over the same socket ----------
//
// Senders: capture track -> (MediaStreamTrackProcessor) VideoFrames -> hardware H.264 when available
// (VP9/VP8 otherwise) -> worker -> server. Receivers decode only streams they watch, ask for a fresh
// keyframe whenever a frame goes missing, and draw into a canvas.

export type VideoSource = 'camera' | 'screen';

export interface StreamQuality {
  height: 720 | 1080;
  fps: 15 | 30 | 60;
  optimize: 'clarity' | 'motion';
  audio: boolean;
}

export interface StreamAudioDiag {
  /** native = desktop capture; browser = getDisplayMedia (no echo canceller). */
  path: 'native' | 'browser';
  /** Native: what the audio contains (see CaptureInfo). Browser: whether a track was shared. */
  mode: CaptureInfo['audio'] | 'browser' | 'device' | 'none';
  /** Why native capture failed, when the browser path is a fallback. */
  fallback: string | null;
  stats: StreamAudioStats | null;
  device: CaptureAudioStats | null;
  /** Voice plays on the Windows default output (the device a Windows 10 system capture records). */
  defaultOutput: boolean;
}

export interface StreamStats {
  width: number;
  height: number;
  fps: number;
  kbps: number;
  codec: string;
}

/** Hardware H.264 is available on nearly every GPU; VP9/VP8 are software fallbacks. */
const CODECS: { codec: string; extra?: Record<string, unknown> }[] = [
  { codec: 'avc1.64002a', extra: { avc: { format: 'annexb' } } },
  { codec: 'vp09.00.50.08' },
  { codec: 'vp8' },
];

// Periodic keyframes are a safety net only; lost frames are repaired by keyframe requests.
// Rare keyframes avoid the once-every-few-seconds blur "pulse" on screen content.
const KEYFRAME_EVERY_S = 10;
const MIN_KEYFRAME_GAP_MS = 400;

/**
 * Target bitrate. Screen content needs more bits per pixel at low frame rates (each frame must stay sharp),
 * so this scales with sqrt(fps) rather than linearly: 1080p60 ≈ 10 Mbps, 1080p30 ≈ 7 Mbps, 720p30 ≈ 3.2 Mbps.
 */
export function bitrateFor(w: number, h: number, fps: number, optimize: 'clarity' | 'motion') {
  // Every viewer receives a full copy through the server, so stay modest: 1080p60 ≈ 6.4 Mbps, 720p30 ≈ 2 Mbps.
  const bits = w * h * 0.42 * Math.sqrt(fps) * (optimize === 'motion' ? 1.15 : 1);
  return Math.round(Math.min(8_000_000, Math.max(1_500_000, bits)));
}

async function pickEncoderConfig(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<VideoEncoderConfig | null> {
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
    for (const c of CODECS) {
      const cfg = {
        codec: c.codec,
        ...c.extra,
        width,
        height,
        framerate: fps,
        bitrate,
        bitrateMode: 'variable',
        latencyMode: 'realtime',
        hardwareAcceleration,
      } as VideoEncoderConfig;
      try {
        const res = await VideoEncoder.isConfigSupported(cfg);
        if (res.supported) return res.config ?? cfg;
      } catch {}
    }
  }
  return null;
}

interface Publisher {
  source: VideoSource;
  stream: MediaStream;
  track: MediaStreamTrack;
  fps: number;
  optimize: 'clarity' | 'motion';
  encoder: VideoEncoder | null;
  config: VideoEncoderConfig | null;
  configuring: boolean;
  seq: number;
  frames: number;
  lastFrameAt: number;
  lastKeyAt: number;
  forceKey: boolean;
  /** After a dropped frame, nothing but a keyframe may be sent. */
  awaitKey: boolean;
  stopped: boolean;
  stats: { frames: number; bytes: number; since: number };
  audio?: { source: MediaStreamAudioSourceNode; node: AudioWorkletNode };
  /** Video device id, when this is a capture card instead of a shared screen. */
  device?: string;
}

const publishers: Partial<Record<VideoSource, Publisher>> = {};
const textEncoder = new TextEncoder();
const kindOf = (s: VideoSource) => (s === 'camera' ? 2 : 3);

/** Frame header: [flags][seq u16][codec (keyframes only)] then the encoded frame. */
function packFrame(pub: Publisher, chunk: EncodedVideoChunk): ArrayBuffer {
  const key = chunk.type === 'key';
  const codec = key ? textEncoder.encode(pub.config!.codec) : new Uint8Array(0);
  const head = 3 + (key ? 1 + codec.length : 0);
  const out = new Uint8Array(head + chunk.byteLength);
  out[0] = (key ? 1 : 0) | (key ? 2 : 0);
  pub.seq = (pub.seq + 1) & 0xffff;
  out[1] = pub.seq >> 8;
  out[2] = pub.seq & 0xff;
  if (key) {
    out[3] = codec.length;
    out.set(codec, 4);
  }
  chunk.copyTo(out.subarray(head));
  return out.buffer;
}

async function configure(pub: Publisher, width: number, height: number) {
  pub.configuring = true;
  const bitrate = bitrateFor(width, height, pub.fps, pub.optimize);
  const config = await pickEncoderConfig(width, height, pub.fps, bitrate);
  if (pub.stopped) return;
  if (!config) {
    toast(t("This device can't encode video"));
    return stopPublish(pub.source);
  }
  if (pub.encoder && pub.encoder.state !== 'closed') pub.encoder.close();
  pub.encoder = new VideoEncoder({
    output: (chunk) => {
      if (pub.awaitKey && chunk.type !== 'key') return;
      if (chunk.type === 'key') pub.awaitKey = false;
      const data = packFrame(pub, chunk);
      pub.stats.bytes += data.byteLength;
      send({ type: 'video', kind: kindOf(pub.source), data }, [data]);
    },
    error: (e) => {
      console.warn('video encoder', e);
      pub.config = null;
    },
  });
  pub.encoder.configure(config);
  pub.config = config;
  pub.forceKey = true;
  pub.configuring = false;
}

function encodeFrame(pub: Publisher, frame: VideoFrame) {
  const now = performance.now();
  // Capture may run faster than the chosen frame rate (and backlogged encoders skip frames).
  if (
    pub.stopped ||
    pub.configuring ||
    now - pub.lastFrameAt < 1000 / pub.fps - 2 ||
    (pub.encoder?.encodeQueueSize ?? 0) > 2
  ) {
    return frame.close();
  }
  // H.264 needs even dimensions; crop the odd pixel instead of rescaling.
  const w = frame.displayWidth & ~1;
  const h = frame.displayHeight & ~1;
  if (!pub.config || pub.config.width !== w || pub.config.height !== h) {
    frame.close();
    void configure(pub, w, h);
    return;
  }
  const input =
    w !== frame.displayWidth || h !== frame.displayHeight
      ? new VideoFrame(frame, { visibleRect: { x: 0, y: 0, width: w, height: h } })
      : frame;
  pub.lastFrameAt = now;
  const keyFrame = pub.forceKey || pub.frames % (pub.fps * KEYFRAME_EVERY_S) === 0;
  if (keyFrame) {
    pub.forceKey = false;
    pub.lastKeyAt = now;
  }
  pub.frames++;
  pub.stats.frames++;
  try {
    pub.encoder!.encode(input, { keyFrame });
  } finally {
    if (input !== frame) input.close();
    frame.close();
  }
}

/** Pulls frames straight from the track (Chromium/WebView2), or samples a video element elsewhere. */
function pump(pub: Publisher) {
  const Processor = (
    window as unknown as {
      MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };
    }
  ).MediaStreamTrackProcessor;
  // Each loop stops once its track is replaced (switching source) or the stream ends.
  const track = pub.track;
  const current = () => !pub.stopped && pub.track === track;
  if (Processor) {
    const reader = new Processor({ track }).readable.getReader();
    void (async () => {
      while (current()) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        if (current()) encodeFrame(pub, value);
        else value.close();
      }
      reader.cancel().catch(() => {});
    })();
    return;
  }
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = pub.stream;
  void video.play();
  const tick = () => {
    if (!current()) return void (video.srcObject = null);
    if (video.videoWidth) encodeFrame(pub, new VideoFrame(video, { timestamp: Math.round(performance.now() * 1000) }));
    setTimeout(tick, 1000 / pub.fps / 2);
  };
  tick();
}

function displayConstraints(q: StreamQuality) {
  const width = q.height === 1080 ? 1920 : 1280;
  return { width: { max: width }, height: { max: q.height }, frameRate: { ideal: q.fps, max: q.fps } };
}

async function publish(source: VideoSource, stream: MediaStream, fps: number, optimize: 'clarity' | 'motion') {
  const track = stream.getVideoTracks()[0] as MediaStreamTrack;
  track.contentHint = optimize === 'motion' ? 'motion' : 'detail';
  const pub: Publisher = {
    source,
    stream,
    track,
    fps,
    optimize,
    encoder: null,
    config: null,
    configuring: false,
    seq: 0,
    frames: 0,
    lastFrameAt: 0,
    lastKeyAt: 0,
    forceKey: true,
    awaitKey: false,
    stopped: false,
    stats: { frames: 0, bytes: 0, since: performance.now() },
  };
  publishers[source] = pub;
  track.addEventListener('ended', () => pub.track === track && stopPublish(source));
  pump(pub);
  setVoiceUi(source, true);
  if (source === 'screen') schedulePreview();
  setTiles((t) => [
    ...t.filter((x) => x.key !== `me-${source}`),
    { key: `me-${source}`, identity: state.me!.id, source, stream },
  ]);
  return pub;
}

// ---------- native capture (Windows desktop) ----------

/** H.264 High profile from the GPU encoder, Annex B with parameter sets on every keyframe. */
const NATIVE_CODEC = 'avc1.64002a';

interface NativeStream {
  seq: number;
  awaitKey: boolean;
  lastKeyRequest: number;
  stats: { frames: number; bytes: number; since: number };
  encoder: string;
  /** What's being captured ("screen:<hmonitor>" / "window:<hwnd>"). */
  source: string;
  /** The shared window was closed and we're deciding what to do. */
  closing?: boolean;
}

let native: NativeStream | null = null;

/** The native stream's current source, if we're streaming natively. */
export const nativeSource = () => native?.source ?? null;

/** Called when the shared window was closed; may switch the stream elsewhere (games.ts follows League's
 * client and game). If the stream is still on the closed window afterwards, it ends. */
let onSourceClosed: (source: string) => Promise<void> = async () => {};
export const setSourceClosedHandler = (fn: typeof onSourceClosed) => (onSourceClosed = fn);

function onNativeVideo(buf: ArrayBuffer) {
  const n = native;
  if (!n) return;
  const bytes = new Uint8Array(buf);
  const key = bytes[0] === 1;
  if (n.awaitKey && !key) return;
  if (key) n.awaitKey = false;
  const codec = key ? textEncoder.encode(NATIVE_CODEC) : new Uint8Array(0);
  const head = 3 + (key ? 1 + codec.length : 0);
  const out = new Uint8Array(head + bytes.length - 1);
  out[0] = key ? 3 : 0;
  n.seq = (n.seq + 1) & 0xffff;
  out[1] = n.seq >> 8;
  out[2] = n.seq & 0xff;
  if (key) {
    out[3] = codec.length;
    out.set(codec, 4);
  }
  out.set(bytes.subarray(1), head);
  n.stats.frames++;
  n.stats.bytes += out.byteLength;
  // Preview: decode our own stream (exactly what viewers see), but only while it's on screen.
  const ownKey = `${state.me!.id}-screen`;
  if (canvases.get(ownKey)?.size) onRemoteVideo(state.me!.id, 'screen', out.slice().buffer);
  else if (remotes.has(ownKey)) removeRemoteVideo(ownKey);
  send({ type: 'video', kind: 3, data: out.buffer }, [out.buffer]);
}

function nativeKeyframe() {
  if (!native || performance.now() - native.lastKeyRequest < MIN_KEYFRAME_GAP_MS) return;
  native.lastKeyRequest = performance.now();
  void nativeCommand('capture_keyframe');
}

async function startNativeScreenShare(q: StreamQuality, source: string): Promise<boolean> {
  const bitrate = bitrateFor(q.height === 1080 ? 1920 : 1280, q.height, q.fps, q.optimize);
  native = {
    seq: 0,
    awaitKey: false,
    lastKeyRequest: 0,
    stats: { frames: 0, bytes: 0, since: performance.now() },
    encoder: '',
    source,
  };
  if (q.audio) send({ type: 'screen_audio_native', on: true });
  try {
    const info = await startNativeCapture(
      { source, height: q.height, fps: q.fps, bitrate, audio: q.audio },
      onNativeVideo,
      (pcm) => send({ type: 'screen_audio_pcm', data: pcm }, [pcm]),
    );
    native.encoder = info.encoder;
    if (q.audio) setStreamAudio('native', info.audio);
    if (q.audio && info.audio === 'none')
      toast(t("Couldn't capture stream audio on this PC. Your stream has video only."), 8000);
    // Windows 10 can only capture all PC sound: strip our own voice chat back out of it.
    if (info.audio === 'system') send({ type: 'echo_cancel', on: true });
  } catch (e) {
    native = null;
    nativeFailure = String(e);
    send({ type: 'screen_audio_native', on: false });
    toast(t('Native capture failed ({error}). Using the Windows picker instead.', { error: String(e) }), 9000);
    return false;
  }
  setPrefs({ screenQuality: q });
  setVoiceUi({ screen: true, streamQuality: q, focus: `${state.me!.id}-screen` });
  schedulePreview();
  return true;
}

function stopNativeScreenShare(keepViewers = false) {
  if (!native) return;
  native = null;
  void nativeCommand('stop_capture');
  send({ type: 'echo_cancel', on: false });
  send({ type: 'screen_audio_native', on: false });
  setVoiceUi({ streamAudio: null, captureTimings: null });
  if (!keepViewers) send({ type: 'video_stop', source: 'screen' });
  removeRemoteVideo(`${state.me?.id}-screen`);
  setVoiceUi('screen', false);
  setVoiceUi(
    'stats',
    produce((s) => delete s[`${state.me?.id}-screen`]),
  );
  if (voiceUi.focus === `${state.me?.id}-screen`) setVoiceUi('focus', null);
}

/**
 * Starts screen sharing with the chosen quality (called from the Go Live dialog's click).
 * With a `source` from the in-app picker, the desktop app captures natively; otherwise the browser's capture is used.
 */
export async function startScreenShare(q: StreamQuality, source?: string) {
  if (!worker || voiceUi.connecting) return;
  stopPublish('screen');
  nativeFailure = null;
  if (source && nativeCaptureAvailable && (await startNativeScreenShare(q, source))) return;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions(q));
  } catch (e) {
    if ((e as DOMException)?.name !== 'NotAllowedError') toast(t('Could not start screen share'));
    return;
  }
  setPrefs({ screenQuality: q });
  const pub = await publish('screen', stream, q.fps, q.optimize);
  attachStreamAudio(pub, stream, q.audio);
  setVoiceUi({ streamQuality: q, focus: `${state.me!.id}-screen` });
}

// Raw stream audio: voice processing would mangle music and game sound.
const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 };

function displayMediaOptions(q: StreamQuality): DisplayMediaStreamOptions {
  return {
    video: displayConstraints(q),
    audio: q.audio
      ? ({
          ...RAW_AUDIO,
          restrictOwnAudio: true,
          suppressLocalAudioPlayback: false,
        } as MediaTrackConstraints)
      : false,
    systemAudio: q.audio ? 'include' : 'exclude',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
  } as DisplayMediaStreamOptions;
}

// ---------- capture cards ----------
// Windows sees a capture card as a camera plus a separate audio input. Going live with one publishes both as a
// stream (forwarded only to viewers, like a screen), unlike the camera button: no audio, 720p.

export interface CaptureDevice {
  video: string;
  /** Audio input id; null shares no sound. */
  audio: string | null;
}

/** The devices the Go Live dialog offers. Labels stay empty until the browser has been allowed to use that kind once. */
export async function listCaptureDevices() {
  let all = await navigator.mediaDevices.enumerateDevices();
  const unnamed = (kind: MediaDeviceKind) => all.some((d) => d.kind === kind && !d.label);
  if (unnamed('videoinput') || unnamed('audioinput')) {
    const asked = await navigator.mediaDevices
      .getUserMedia({ video: unnamed('videoinput'), audio: unnamed('audioinput') })
      .catch(() => null);
    asked?.getTracks().forEach((t) => t.stop());
    all = await navigator.mediaDevices.enumerateDevices();
  }
  const list = (kind: MediaDeviceKind) =>
    all.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return { videos: list('videoinput'), inputs: list('audioinput') };
}

function deviceVideoConstraints(q: StreamQuality, deviceId: string): MediaTrackConstraints {
  return {
    deviceId: { exact: deviceId },
    width: { ideal: q.height === 1080 ? 1920 : 1280 },
    height: { ideal: q.height },
    frameRate: { ideal: q.fps },
  };
}

/** Opens a capture card; if its sound won't open, the picture still goes out. Null (after a toast) when it can't open. */
async function openCaptureDevice(q: StreamQuality, d: CaptureDevice): Promise<MediaStream | null> {
  const video = deviceVideoConstraints(q, d.video);
  try {
    return await navigator.mediaDevices.getUserMedia({
      video,
      audio: d.audio ? { deviceId: { exact: d.audio }, ...RAW_AUDIO } : false,
    });
  } catch (e) {
    console.warn('capture device', e);
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video });
    if (d.audio) toast(t("Couldn't open its sound. Your stream has video only."), 8000);
    return stream;
  } catch (e) {
    console.warn('capture device', e);
    toast(t("Couldn't open this device. Another app may be using it."), 8000);
    return null;
  }
}

function attachDeviceAudio(pub: Publisher, stream: MediaStream) {
  attachStreamAudio(pub, stream, false);
  setStreamAudio('browser', stream.getAudioTracks()[0] ? 'device' : 'none');
}

/** The dialog's audio choice isn't the screen share's "Share audio" setting: keep that one out of the prefs. */
function rememberDevice(q: StreamQuality, d: CaptureDevice) {
  setPrefs({
    screenQuality: { ...q, audio: prefs.screenQuality.audio },
    captureAudio: { ...prefs.captureAudio, [d.video]: d.audio ?? '' },
  });
}

async function publishDevice(q: StreamQuality, d: CaptureDevice, stream: MediaStream) {
  nativeFailure = null;
  rememberDevice(q, d);
  const pub = await publish('screen', stream, q.fps, q.optimize);
  pub.device = d.video;
  attachDeviceAudio(pub, stream);
  setVoiceUi({
    streamQuality: { ...q, audio: !!stream.getAudioTracks()[0] },
    focus: `${state.me!.id}-screen`,
  });
}

/** Goes live with a capture card (called from the Go Live dialog). */
export async function startDeviceShare(q: StreamQuality, d: CaptureDevice) {
  if (!worker || voiceUi.connecting) return;
  const stream = await openCaptureDevice(q, d);
  if (!stream) return;
  // Left the call while it was opening.
  if (!voiceUi.channelId) return stream.getTracks().forEach((t) => t.stop());
  stopPublish('screen');
  await publishDevice(q, d, stream);
}

/** Moves a running stream onto a capture card; viewers keep watching. */
export async function switchToDevice(d: CaptureDevice) {
  const q = voiceUi.streamQuality ?? prefs.screenQuality;
  const stream = await openCaptureDevice(q, d);
  if (!stream) return;
  if (!voiceUi.screen) return stream.getTracks().forEach((t) => t.stop());
  const pub = publishers.screen;
  if (!pub) {
    stopNativeScreenShare(true);
    return publishDevice(q, d, stream);
  }
  rememberDevice(q, d);
  replacePublishedStream(pub, stream);
  pub.device = d.video;
  attachDeviceAudio(pub, stream);
  setVoiceUi('streamQuality', { ...q, audio: !!stream.getAudioTracks()[0] });
}

// Last native capture error, shown in the stream-audio diagnostics when the browser capture took over.
let nativeFailure: string | null = null;

function setStreamAudio(path: StreamAudioDiag['path'], mode: StreamAudioDiag['mode']) {
  const defaultOutput = !prefs.outputDevice || prefs.outputDevice === 'default';
  setVoiceUi('streamAudio', {
    path,
    mode,
    fallback: path === 'browser' ? nativeFailure : null,
    stats: null,
    device: null,
    defaultOutput,
  });
}

async function onStreamAudioStats(stats: StreamAudioStats) {
  if (!voiceUi.streamAudio) return;
  const device = voiceUi.streamAudio.path === 'native' ? await captureAudioStats() : null;
  if (voiceUi.streamAudio) setVoiceUi('streamAudio', { stats, device });
}

/** Feeds a shared tab/screen's audio track into the stream-audio encoder. */
function attachStreamAudio(pub: Publisher, stream: MediaStream, wanted: boolean) {
  if (pub.audio) {
    pub.audio.source.disconnect();
    pub.audio.node.disconnect();
    pub.audio = undefined;
    send({ type: 'screen_audio', port: null });
  }
  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack && audio) {
    const node = new AudioWorkletNode(audio, 'pottira-capture', {
      processorOptions: { channels: 2 },
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    const src = audio.createMediaStreamSource(new MediaStream([audioTrack]));
    const sink = audio.createGain();
    sink.gain.value = 0;
    src.connect(node).connect(sink).connect(audio.destination);
    const ch = new MessageChannel();
    node.port.postMessage({ port: ch.port1 }, [ch.port1]);
    send({ type: 'screen_audio', port: ch.port2 }, [ch.port2]);
    pub.audio = { source: src, node };
    setStreamAudio('browser', 'browser');
  } else if (wanted) {
    setStreamAudio('browser', 'none');
    toast(t('No audio was shared. To include it, tick "Share audio" in the picker (a tab or your entire screen).'));
  }
}

/**
 * Changes what's being shared without ending the stream: viewers keep watching.
 * `source` comes from the in-app picker (desktop); without it the browser's picker opens.
 */
export async function switchScreenSource(source?: string) {
  // From a capture card to an app or screen: native capture takes over the same stream.
  if (source && publishers.screen?.device && nativeCaptureAvailable) {
    const q = { ...(voiceUi.streamQuality ?? prefs.screenQuality), audio: prefs.screenQuality.audio };
    stopPublish('screen', true);
    nativeFailure = null;
    if (!(await startNativeScreenShare(q, source))) send({ type: 'video_stop', source: 'screen' });
    return;
  }
  if (native && source) {
    try {
      const info = await switchNativeSource(source);
      send({ type: 'echo_cancel', on: info.audio === 'system' });
      if (voiceUi.streamAudio) setStreamAudio('native', info.audio);
      if (!native) return;
      native.awaitKey = false;
      native.source = source;
    } catch (e) {
      toast(t("Couldn't switch: {error}", { error: String(e) }), 6000);
    }
    return;
  }
  const pub = publishers.screen;
  if (!pub) return;
  const q = voiceUi.streamQuality ?? prefs.screenQuality;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions(q));
  } catch {
    return;
  }
  replacePublishedStream(pub, stream);
  pub.device = undefined;
  attachStreamAudio(pub, stream, q.audio);
}

function replacePublishedStream(pub: Publisher, stream: MediaStream) {
  const old = pub.stream;
  pub.stream = stream;
  pub.track = stream.getVideoTracks()[0];
  pub.track.contentHint = pub.optimize === 'motion' ? 'motion' : 'detail';
  pub.track.addEventListener('ended', () => pub.track === stream.getVideoTracks()[0] && stopPublish('screen'));
  pub.config = null; // new size: reconfigure and start with a keyframe
  old.getTracks().forEach((t) => t.stop());
  pump(pub);
  setTiles((t) => t.map((x) => (x.key === 'me-screen' ? { ...x, stream } : x)));
}

/** Changes resolution/frame rate/optimization of the running stream without restarting it. */
export async function updateStreamQuality(q: StreamQuality) {
  if (native) {
    await setNativeQuality(q.height, q.fps, bitrateFor(q.height === 1080 ? 1920 : 1280, q.height, q.fps, q.optimize));
    setPrefs({ screenQuality: { ...q, audio: prefs.screenQuality.audio } });
    setVoiceUi('streamQuality', {
      ...(voiceUi.streamQuality ?? q),
      ...q,
      audio: voiceUi.streamQuality?.audio ?? false,
    });
    return;
  }
  const pub = publishers.screen;
  if (!pub) return;
  await pub.track
    .applyConstraints(pub.device ? deviceVideoConstraints(q, pub.device) : displayConstraints(q))
    .catch(() => {});
  pub.track.contentHint = q.optimize === 'motion' ? 'motion' : 'detail';
  pub.fps = q.fps;
  pub.optimize = q.optimize;
  pub.config = null; // reconfigure (bitrate, size) on the next frame
  setPrefs({ screenQuality: { ...q, audio: prefs.screenQuality.audio } });
  setVoiceUi('streamQuality', { ...q, audio: !!pub.audio });
}

/** With `keepViewers`, another source takes over the stream right after, so nobody stops watching. */
export function stopPublish(source: VideoSource, keepViewers = false) {
  if (source === 'screen') stopNativeScreenShare(keepViewers);
  const pub = publishers[source];
  if (!pub) return;
  delete publishers[source];
  pub.stopped = true;
  if (pub.encoder && pub.encoder.state !== 'closed') pub.encoder.close();
  pub.stream.getTracks().forEach((t) => t.stop());
  if (pub.audio) {
    pub.audio.source.disconnect();
    pub.audio.node.disconnect();
    send({ type: 'screen_audio', port: null });
  }
  if (!keepViewers) send({ type: 'video_stop', source });
  if (source === 'screen') setVoiceUi('streamAudio', null);
  setVoiceUi(source, false);
  setVoiceUi(
    'stats',
    produce((s) => delete s[`${state.me?.id}-${source}`]),
  );
  if (source === 'screen' && voiceUi.focus === `${state.me?.id}-screen`) setVoiceUi('focus', null);
  setTiles((t) => t.filter((x) => x.key !== `me-${source}`));
}

export async function toggleCamera() {
  if (!worker || voiceUi.connecting) return;
  if (publishers.camera) return stopPublish('camera');
  try {
    const stream = await openCamera();
    await publish('camera', stream, 30, 'motion');
  } catch (e) {
    if ((e as DOMException)?.name !== 'NotAllowedError') toast(t('Could not start camera'));
  }
}

export const stopScreenShare = () => stopPublish('screen');

// ---------- stream preview ----------
// While we stream, a small picture of it goes to the server now and then: people hovering us in the channel list
// see it (StreamPreview.tsx), like Discord.

const PREVIEW_FIRST_MS = 3000;
const PREVIEW_EVERY_MS = 45_000;
const PREVIEW_WIDTH = 480;
let previewTimer: number | undefined;

function schedulePreview(delay = PREVIEW_FIRST_MS) {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(async () => {
    if (!voiceUi.screen) return;
    await sendPreview().catch(() => {});
    if (voiceUi.screen) schedulePreview(PREVIEW_EVERY_MS);
  }, delay);
}

async function sendPreview() {
  const jpeg = await grabOwnStream();
  if (jpeg && voiceUi.screen) await api('PUT', '/voice/preview', jpeg);
}

/** A frame of what we stream, as a small JPEG: decoded from our own native stream, or grabbed from the track. */
async function grabOwnStream(): Promise<Blob | null> {
  const out = document.createElement('canvas');
  const draw = (src: CanvasImageSource, w: number, h: number) => {
    if (!w || !h) return false;
    out.width = Math.min(PREVIEW_WIDTH, w);
    out.height = Math.round((out.width * h) / w);
    out.getContext('2d')!.drawImage(src, 0, 0, out.width, out.height);
    return true;
  };
  if (native) {
    // Our own stream is decoded while a canvas shows it: lend it one until a frame lands (a keyframe is asked for).
    const key = `${state.me!.id}-screen`;
    const c = document.createElement('canvas');
    c.width = c.height = 0;
    registerCanvas(key, c, true);
    try {
      for (let i = 0; i < 40 && !c.width; i++) await new Promise((r) => setTimeout(r, 100));
    } finally {
      registerCanvas(key, c, false);
    }
    if (!draw(c, c.width, c.height)) return null;
  } else {
    const track = publishers.screen?.track;
    const Capture = (
      window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> } }
    ).ImageCapture;
    if (!track || track.readyState !== 'live' || !Capture) return null;
    const frame = await new Capture(track).grabFrame();
    const ok = draw(frame, frame.width, frame.height);
    frame.close();
    if (!ok) return null;
  }
  return new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', 0.72));
}

// ---------- soundboard ----------

const soundBuffers = new Map<string, Promise<AudioBuffer>>();

function soundBuffer(ctx: BaseAudioContext, url: string) {
  let p = soundBuffers.get(url);
  if (!p) {
    p = fetch(serverUrl() + url)
      .then((r) => r.arrayBuffer())
      .then((b) => ctx.decodeAudioData(b));
    p.catch(() => soundBuffers.delete(url));
    soundBuffers.set(url, p);
  }
  return p;
}

/** Plays a soundboard sound for everyone in the call (they hear it from us). */
export function sendSound(sound: Sound) {
  if (!worker || voiceUi.connecting) return toast(t('Join a voice channel to play sounds'));
  send({ type: 'sound', sound_id: sound.id });
}

/** Each person's sound that is playing; a new one from them cuts it off (spamming plays only the latest). */
const playingSounds = new Map<string, { seq: number; src?: AudioBufferSourceNode }>();
let soundSeq = 0;

/** A sound someone played: at its volume, times our soundboard volume and our volume for them. */
async function playSoundboard(userId: string, sound: Sound) {
  if (!audio || voiceUi.deafened) return;
  const volume = sound.volume * prefs.soundboardVolume * (prefs.soundboardUserVolumes[userId] ?? 1);
  const seq = ++soundSeq;
  const prev = playingSounds.get(userId);
  if (prev?.src) {
    prev.src.onended = null;
    try {
      prev.src.stop();
    } catch {}
  }
  playingSounds.set(userId, { seq });
  const current = () => playingSounds.get(userId)?.seq === seq;
  const done = () => {
    if (!current()) return;
    playingSounds.delete(userId);
    setVoiceUi('soundPlaying', userId, undefined!);
  };
  setVoiceUi('soundPlaying', userId, sound.emoji || '🔊');
  try {
    if (volume <= 0) return void setTimeout(done, 1500);
    const buf = await soundBuffer(audio, sound.url);
    // A newer sound from them arrived while this one was loading.
    if (!audio || !current()) return;
    const src = audio.createBufferSource();
    const gain = audio.createGain();
    gain.gain.value = Math.min(2, volume);
    src.buffer = buf;
    src.connect(gain).connect(audio.destination);
    src.onended = done;
    playingSounds.set(userId, { seq, src });
    src.start();
  } catch (e) {
    console.warn('soundboard', e);
    done();
  }
}

let previewCtx: AudioContext | null = null;

/** Plays a sound only for us (the speaker button in the picker), on our output device. */
export async function previewSound(sound: Sound) {
  const ctx = audio ?? (previewCtx ??= new AudioContext());
  const sinked = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (ctx === previewCtx && sinked.setSinkId) await sinked.setSinkId(await outputSinkId()).catch(() => {});
  await ctx.resume().catch(() => {});
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = sound.volume * prefs.soundboardVolume;
  src.buffer = await soundBuffer(ctx, sound.url);
  src.connect(gain).connect(ctx.destination);
  src.start();
}

/** Picks another camera; a running camera switches over to it. */
export async function switchCamera(deviceId: string) {
  setPrefs({ videoDevice: deviceId });
  if (!publishers.camera) return;
  stopPublish('camera');
  await toggleCamera();
}

/** The camera chosen in settings (or the default one if it's unplugged), at 720p30. */
export function openCamera(): Promise<MediaStream> {
  return getCamera({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } });
}

function onKeyframeRequest(source: string) {
  if (source === 'screen' && native) return nativeKeyframe();
  const pub = publishers[source as VideoSource];
  if (pub && performance.now() - pub.lastKeyAt > MIN_KEYFRAME_GAP_MS) pub.forceKey = true;
}

function onVideoDropped(kind: number) {
  if (kind === 3 && native) {
    native.awaitKey = true;
    return nativeKeyframe();
  }
  const pub = publishers[kind === 2 ? 'camera' : 'screen'];
  if (pub) {
    pub.awaitKey = true;
    pub.forceKey = true;
  }
}

// ---------- receiving ----------

interface Remote {
  decoder: VideoDecoder;
  codec: string;
  seq: number;
  waitingKey: boolean;
  timestamp: number;
  lastFrame: number;
  lastRequest: number;
  stats: { frames: number; bytes: number; since: number };
  width: number;
  height: number;
}

const remotes = new Map<string, Remote>();
/** Canvases showing each stream (the call view and the pop-out player can both show one). */
const canvases = new Map<string, Set<HTMLCanvasElement>>();
const textDecoder = new TextDecoder();

export function registerCanvas(key: string, el: HTMLCanvasElement, on: boolean) {
  const set = canvases.get(key) ?? new Set<HTMLCanvasElement>();
  if (on) set.add(el);
  else set.delete(el);
  if (set.size) canvases.set(key, set);
  else canvases.delete(key);
  // Our own preview starts decoding when it becomes visible: it needs a keyframe to begin.
  if (on && native && key === `${state.me?.id}-screen`) nativeKeyframe();
}

function requestKeyframe(userId: string, source: VideoSource, r?: Remote) {
  const now = performance.now();
  if (r && now - r.lastRequest < 1000) return;
  if (r) r.lastRequest = now;
  send({ type: 'request_keyframe', user_id: userId, source });
}

function createRemote(key: string, codec: string): Remote | null {
  const r: Remote = {
    decoder: null as unknown as VideoDecoder,
    codec,
    seq: 0,
    waitingKey: false,
    timestamp: 0,
    lastFrame: 0,
    lastRequest: 0,
    stats: { frames: 0, bytes: 0, since: performance.now() },
    width: 0,
    height: 0,
  };
  const decoder = new VideoDecoder({
    output: (frame) => {
      r.width = frame.displayWidth;
      r.height = frame.displayHeight;
      r.stats.frames++;
      for (const c of canvases.get(key) ?? []) {
        if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
          c.width = frame.displayWidth;
          c.height = frame.displayHeight;
        }
        (c.getContext('2d', { alpha: false }) as CanvasRenderingContext2D).drawImage(frame, 0, 0);
      }
      frame.close();
    },
    error: (e) => {
      console.warn('video decoder', key, e);
      remotes.delete(key);
    },
  });
  try {
    decoder.configure({ codec, optimizeForLatency: true });
  } catch {
    setVoiceUi('unsupported', key, codec);
    return null;
  }
  r.decoder = decoder;
  return r;
}

function onRemoteVideo(id: string, source: VideoSource, data: ArrayBuffer) {
  if (!canReceiveVideo) return;
  const key = `${id}-${source}`;
  const bytes = new Uint8Array(data);
  const flags = bytes[0];
  const isKey = (flags & 1) === 1;
  const seq = (bytes[1] << 8) | bytes[2];
  let offset = 3;
  let codec: string | undefined;
  if (flags & 2) {
    codec = textDecoder.decode(bytes.subarray(4, 4 + bytes[3]));
    offset = 4 + bytes[3];
  }

  let r = remotes.get(key);
  if (source === 'camera' && !tiles().some((t) => t.key === key))
    setTiles((t) => [...t, { key, identity: id, source }]);
  if (!r || (codec && codec !== r.codec)) {
    if (!isKey || !codec) return requestKeyframe(id, source, r);
    if (r && r.decoder.state !== 'closed') r.decoder.close();
    const created = createRemote(key, codec);
    if (!created) return;
    remotes.set(key, (r = created));
  } else if (!isKey && ((r.seq + 1) & 0xffff) !== seq) {
    // A frame was lost on the way: wait for a keyframe instead of showing a smeared picture.
    r.waitingKey = true;
    requestKeyframe(id, source, r);
  }
  r.seq = seq;
  r.lastFrame = performance.now();
  r.stats.bytes += bytes.byteLength;
  if (isKey) r.waitingKey = false;
  if (r.waitingKey || r.decoder.state !== 'configured') return;
  if (!isKey && r.decoder.decodeQueueSize > 6) {
    // The decoder is falling behind (slow machine): skip ahead to the next keyframe.
    r.waitingKey = true;
    return requestKeyframe(id, source, r);
  }
  r.decoder.decode(
    new EncodedVideoChunk({
      type: isKey ? 'key' : 'delta',
      timestamp: (r.timestamp += 16_667),
      data: bytes.subarray(offset),
    }),
  );
}

function removeRemoteVideo(key: string) {
  if (voiceUi.poppedOut === key) closePopOut();
  const r = remotes.get(key);
  if (r && r.decoder.state !== 'closed') r.decoder.close();
  remotes.delete(key);
  setVoiceUi(
    'stats',
    produce((s) => delete s[key]),
  );
  if (key.endsWith('-camera')) setTiles((t) => t.filter((x) => x.key !== key));
}

/** Start/stop receiving someone's screen share (only watched streams use bandwidth). */
/** Starts or stops watching a stream; `focus` shows it large (the grid's Streams view watches several side by side). */
export function watchStream(userId: string, on = true, focus = true) {
  setVoiceUi('watching', userId, on);
  send({ type: 'watch', user_id: userId, on });
  const key = `${userId}-screen`;
  if (on && focus) setVoiceUi('focus', key);
  else {
    removeRemoteVideo(key);
    if (voiceUi.focus === key) setVoiceUi('focus', null);
  }
}

/** Floats a stream over other apps (OS picture-in-picture), where the webview supports it. */
export const canPopOut =
  typeof document !== 'undefined' &&
  !!document.pictureInPictureEnabled &&
  'captureStream' in HTMLCanvasElement.prototype;

let popVideo: HTMLVideoElement | null = null;

/**
 * Plays a stream in a picture-in-picture window. It draws into its own off-screen canvas, so it keeps going
 * whichever player in the app is mounted; those show a placeholder meanwhile instead of the same picture twice.
 */
export async function popOut(key: string) {
  closePopOut();
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  registerCanvas(key, canvas, true);
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = canvas.captureStream(60);
  popVideo = video;
  const done = () => {
    registerCanvas(key, canvas, false);
    video.srcObject = null;
    if (popVideo === video) popVideo = null;
    if (voiceUi.poppedOut === key) setVoiceUi('poppedOut', null);
  };
  video.addEventListener('leavepictureinpicture', done, { once: true });
  // A fresh keyframe so the window shows a picture right away instead of waiting for the next one.
  const i = key.lastIndexOf('-');
  requestKeyframe(key.slice(0, i), key.slice(i + 1) as VideoSource);
  try {
    await video.play();
    await video.requestPictureInPicture();
    setVoiceUi('poppedOut', key);
  } catch {
    done();
  }
}

/** Ends the picture-in-picture window, if one is open. */
export function closePopOut() {
  if (popVideo && document.pictureInPictureElement === popVideo) void document.exitPictureInPicture().catch(() => {});
}

export function setStreamVolume(userId: string, volume: number) {
  setUserVolume(`${userId}:screen`, volume);
}

export const streamVolume = (userId: string) => prefs.userVolumes[`${userId}:screen`] ?? 1;

// Volume a muted stream returns to.
const unmutedStreamVolume = new Map<string, number>();

export function toggleStreamMute(userId: string) {
  const v = streamVolume(userId);
  if (v > 0) unmutedStreamVolume.set(userId, v);
  setStreamVolume(userId, v > 0 ? 0 : (unmutedStreamVolume.get(userId) ?? 1));
}

// Per-second stream stats, and cleanup of streams whose sender vanished without a stop message.
setInterval(() => {
  const now = performance.now();
  for (const [key, r] of remotes) {
    if (now - r.lastFrame > 8000) {
      removeRemoteVideo(key);
      continue;
    }
    // Our own stream's preview reports the sender-side stats below instead.
    if (native && key === `${state.me?.id}-screen`) continue;
    const secs = (now - r.stats.since) / 1000;
    setVoiceUi('stats', key, {
      width: r.width,
      height: r.height,
      fps: Math.round(r.stats.frames / secs),
      kbps: Math.round((r.stats.bytes * 8) / 1000 / secs),
      codec: r.codec,
    });
    r.stats = { frames: 0, bytes: 0, since: now };
  }
  for (const pub of Object.values(publishers)) {
    if (!pub) continue;
    const secs = (now - pub.stats.since) / 1000;
    setVoiceUi('stats', `${state.me?.id}-${pub.source}`, {
      width: pub.config?.width ?? 0,
      height: pub.config?.height ?? 0,
      fps: Math.round(pub.stats.frames / secs),
      kbps: Math.round((pub.stats.bytes * 8) / 1000 / secs),
      codec: pub.config?.codec ?? '',
    });
    pub.stats = { frames: 0, bytes: 0, since: now };
  }
  if (native) {
    const secs = (now - native.stats.since) / 1000;
    const r = remotes.get(`${state.me?.id}-screen`);
    setVoiceUi('stats', `${state.me?.id}-screen`, {
      width: r?.width ?? 0,
      height: r?.height ?? 0,
      fps: Math.round(native.stats.frames / secs),
      kbps: Math.round((native.stats.bytes * 8) / 1000 / secs),
      codec: `${NATIVE_CODEC} ${native.encoder}`,
    });
    native.stats = { frames: 0, bytes: 0, since: now };
    void refreshCaptureTimings();
  }
}, 1000);

async function refreshCaptureTimings() {
  const timings = await captureVideoStats();
  if (!native) return;
  setVoiceUi('captureTimings', timings);
  // The desktop app stopped capturing (no H.264 encoder): end the share instead of streaming a frozen picture.
  if (timings?.error) {
    toast(t('Your stream stopped: {error}', { error: timings.error }), 9000);
    stopPublish('screen');
    return;
  }
  // The shared app was closed: follow it elsewhere if it has somewhere to go, else end the stream.
  if (timings?.source_closed && !native.closing) {
    const n = native;
    const source = n.source;
    n.closing = true;
    await onSourceClosed(source).catch(() => {});
    if (native !== n) return;
    n.closing = false;
    if (n.source === source) {
      toast(t('The window you were streaming was closed, so your stream ended.'), 6000);
      stopPublish('screen');
    }
  }
}

/** Join/leave sounds for our channel, and drops video from people who left it or stopped streaming. */
export function onVoiceStateFromServer(v: VoiceState, prev?: VoiceState) {
  const mine = voiceUi.channelId;
  const stays = !!mine && !voiceUi.connecting && v.channel_id === mine && prev?.channel_id === mine;
  // Going live / camera on or off, for us and for others in our channel.
  if (stays && !!v.self_stream !== !!prev?.self_stream) (v.self_stream ? sounds.streamStart : sounds.streamStop)();
  if (stays && !!v.self_video !== !!prev?.self_video) (v.self_video ? sounds.cameraOn : sounds.cameraOff)();
  if (v.user_id === state.me?.id) return;
  if (mine && !voiceUi.connecting) {
    if (v.channel_id === mine && prev?.channel_id !== mine) sounds.join();
    if (prev?.channel_id === mine && v.channel_id !== mine) sounds.leave();
    // Someone started or stopped watching our stream.
    const me = state.me!.id;
    if (stays && voiceUi.screen && !!v.watching?.includes(me) !== !!prev?.watching?.includes(me))
      (v.watching?.includes(me) ? sounds.viewerJoin : sounds.viewerLeave)();
  }
  const left = v.channel_id !== mine;
  if ((left || !v.self_stream) && voiceUi.watching[v.user_id]) {
    setVoiceUi('watching', v.user_id, false);
    send({ type: 'watch', user_id: v.user_id, on: false });
    removeRemoteVideo(`${v.user_id}-screen`);
    if (voiceUi.focus === `${v.user_id}-screen`) setVoiceUi('focus', null);
  }
  if (left || !v.self_video) removeRemoteVideo(`${v.user_id}-camera`);
}

// ---------- devices, sensitivity, push-to-talk, per-user volume ----------

function openMic(): Promise<MediaStream | null> {
  return getMic({
    echoCancellation: prefs.echoCancellation,
    // RNNoise wants the raw signal; stacking two suppressors makes voices sound watery.
    noiseSuppression: prefs.noiseMode === 'standard',
    autoGainControl: true,
    channelCount: 1,
  }).catch((e) => (console.warn('microphone', e), null));
}

/** The capture worklet the mic feeds; returns the port the voice worker reads it from. */
function newCapture(ctx: AudioContext): MessagePort {
  const capture = new AudioWorkletNode(ctx, 'pottira-capture');
  captureNode = capture;
  // Route through a silent gain so the capture node is always pulled by the graph.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  capture.connect(sink).connect(ctx.destination);
  const capCh = new MessageChannel();
  capture.port.postMessage({ port: capCh.port1 }, [capCh.port1]);
  return capCh.port2;
}

/** Feeds this stream into the capture node instead of the current mic. */
function plugMic(stream: MediaStream) {
  micSource?.disconnect();
  if (mic !== stream) mic?.getTracks().forEach((t) => t.stop());
  mic = stream;
  micSource = audio!.createMediaStreamSource(stream);
  micSource.connect(captureNode!);
  // The device went away (unplugged, Bluetooth headset switching profile): reopen, falling back to the default.
  stream.getAudioTracks()[0]?.addEventListener('ended', () => mic === stream && void restartMic(true));
}

let micGone = false;

/** Re-opens the microphone after the input device or processing options change, or the device went away. */
export async function restartMic(quiet = false) {
  const ctx = audio;
  if (!ctx) return;
  const gen = generation;
  const fresh = await openMic();
  if (gen !== generation || audio !== ctx) return fresh?.getTracks().forEach((t) => t.stop());
  if (!fresh) {
    if (quiet && mic?.getAudioTracks()[0]?.readyState === 'ended') {
      // Nothing to record from right now; the next device change tries again.
      micSource?.disconnect();
      micSource = null;
      mic = null;
      if (!micGone) toast(t('No microphone available'));
      micGone = true;
    } else if (!quiet) toast(t('Could not open that microphone'));
    return;
  }
  micGone = false;
  if (!captureNode) {
    // Joined listen-only: give the worker a capture port now.
    const port = newCapture(ctx);
    send({ type: 'capture', port }, [port]);
  }
  plugMic(fresh);
}

// Devices come and go (a Bluetooth headset switching between stereo and hands-free swaps its endpoints). Reopen the
// mic when it died, when the chosen one is back while we're on the default, or when "System default" now means
// another device (Chromium keeps the old one otherwise).
let deviceTimer: number | undefined;
navigator.mediaDevices?.addEventListener('devicechange', () => {
  clearTimeout(deviceTimer);
  deviceTimer = window.setTimeout(async () => {
    if (!audio) return;
    // The chosen speakers went away (call moves to the default) or came back (moves back to them).
    void applyOutputDevice();
    const track = mic?.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') return void restartMic(true);
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    const inputs = devices.filter((d) => d.kind === 'audioinput');
    const settings = track.getSettings();
    if (!isChosenMic(track)) {
      if (inputs.some((d) => d.deviceId === prefs.inputDevice)) void restartMic(true);
    } else if (prefs.inputDevice === 'default') {
      const def = inputs.find((d) => d.deviceId === 'default');
      if (def?.groupId && settings.groupId && def.groupId !== settings.groupId) void restartMic(true);
    }
  }, 700);
});

async function applyOutputDevice() {
  const ctx = audio as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
  if (!ctx?.setSinkId) return;
  const id = await outputSinkId();
  if ((ctx as AudioContext & { sinkId?: unknown }).sinkId === id) return;
  await ctx.setSinkId(id).catch((e) => console.warn('output device', e));
}

export async function setOutputDevice(id: string) {
  setPrefs({ outputDevice: id });
  await applyOutputDevice();
}

export function syncVad() {
  send({ type: 'vad', threshold: prefs.sensitivity, auto: prefs.autoSensitivity, ptt: prefs.inputMode === 'ptt' });
  send({ type: 'denoise', kind: prefs.noiseMode === 'advanced' ? 'rnnoise' : null });
}

export function setUserVolume(userId: string, volume: number) {
  setPrefs({ userVolumes: { ...prefs.userVolumes, [userId]: volume } });
  send({ type: 'gain', id: userId, gain: volume });
}

/** Push-to-mute: mutes the mic only while the key is held (others don't see a mute icon). */
export function setPushToMute(active: boolean) {
  if (!voiceUi.channelId || voiceUi.pushMuted === active) return;
  setVoiceUi('pushMuted', active);
  (active ? sounds.mute : sounds.unmute)();
  send({ type: 'mute', muted: active || voiceUi.muted });
}

let pttRelease: number | undefined;

/** Push-to-talk key state, from the global keyboard hook (desktop) or in-window key events. */
export function setPtt(active: boolean) {
  if (prefs.inputMode !== 'ptt' || !voiceUi.channelId) return;
  clearTimeout(pttRelease);
  const apply = () => {
    if (voiceUi.pttActive === active) return;
    setVoiceUi('pttActive', active);
    (active ? sounds.pttOn : sounds.pttOff)();
    send({ type: 'ptt', active });
  };
  if (active) apply();
  else pttRelease = window.setTimeout(apply, prefs.pttReleaseDelay);
}
