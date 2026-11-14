// UI sounds: the owner's own picks plus original synthesized tones (ringtones, camera, push to talk), decoded once and played
// through a small Web Audio graph so they can overlap and start without delay.
import { prefs, type SoundKind } from './prefs';
import cameraOffUrl from '../assets/sounds/camera-off.wav';
import cameraOnUrl from '../assets/sounds/camera-on.wav';
import deafenUrl from '../assets/sounds/deafen.wav';
import disconnectUrl from '../assets/sounds/disconnect.wav';
import joinUrl from '../assets/sounds/join.wav';
import leaveUrl from '../assets/sounds/leave.wav';
import messageUrl from '../assets/sounds/message.wav';
import muteUrl from '../assets/sounds/mute.wav';
import pttOffUrl from '../assets/sounds/ptt-off.wav';
import pttOnUrl from '../assets/sounds/ptt-on.wav';
import streamStartUrl from '../assets/sounds/stream-start.wav';
import streamStopUrl from '../assets/sounds/stream-stop.wav';
import undeafenUrl from '../assets/sounds/undeafen.wav';
import unmuteUrl from '../assets/sounds/unmute.wav';
import viewerJoinUrl from '../assets/sounds/viewer-join.wav';
import viewerLeaveUrl from '../assets/sounds/viewer-leave.wav';
import ringIncomingUrl from '../assets/sounds/ring-incoming.wav';
import ringOutgoingUrl from '../assets/sounds/ring-outgoing.wav';
import fanfareUrl from '../assets/sounds/fanfare.wav';
import recSavedUrl from '../assets/sounds/rec-saved.wav';
import recFailedUrl from '../assets/sounds/rec-failed.wav';


/** The files are mastered loud; this keeps them in line with voice. */
const GAIN = 0.5;

let ctx: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();

function load(url: string) {
  let b = buffers.get(url);
  if (!b) {
    b = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((data) => ctx!.decodeAudioData(data))
      .catch((e) => (console.warn('sound', url, e), null));
    buffers.set(url, b);
  }
  return b;
}

function play(kind: SoundKind, url: string) {
  if (!prefs.sounds || !prefs.soundKinds[kind]) return;
  ctx ??= new AudioContext();
  void load(url).then((buffer) => {
    if (!buffer || !ctx) return;
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    src.buffer = buffer;
    g.gain.value = GAIN;
    src.connect(g).connect(ctx.destination);
    src.start();
  });
}

/** REC's cues (clip/screenshot/bookmark saved or failed): REC has its own switch (prefs.rec.sounds, checked by the
 * caller), since while you play they're the only sign anything happened. */
function cue(url: string) {
  ctx ??= new AudioContext();
  void ctx.resume().catch(() => {});
  void load(url).then((buffer) => {
    if (!buffer || !ctx) return;
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    src.buffer = buffer;
    g.gain.value = GAIN;
    src.connect(g).connect(ctx.destination);
    src.start();
  });
}

/** Plays a sound over and over (ringtones) until the returned function is called. */
function loop(kind: SoundKind, url: string): () => void {
  if (!prefs.sounds || !prefs.soundKinds[kind]) return () => {};
  ctx ??= new AudioContext();
  let src: AudioBufferSourceNode | null = null;
  let stopped = false;
  void ctx.resume().catch(() => {});
  void load(url).then((buffer) => {
    if (!buffer || !ctx || stopped) return;
    src = ctx.createBufferSource();
    const g = ctx.createGain();
    src.buffer = buffer;
    src.loop = true;
    g.gain.value = GAIN;
    src.connect(g).connect(ctx.destination);
    src.start();
  });
  return () => {
    stopped = true;
    src?.stop();
  };
}

/**
 * A one-off celebration (the 1.0 dialog's fanfare): follows only the master sound switch. Without a click yet
 * (browsers block autoplay) it waits for the first click or key press instead. Returns a cancel function.
 */
function celebrate(url: string): () => void {
  if (!prefs.sounds) return () => {};
  ctx ??= new AudioContext();
  const audio = ctx;
  let done = false;
  const start = () => {
    if (done) return;
    done = true;
    off();
    void audio.resume().catch(() => {});
    void load(url).then((buffer) => {
      if (!buffer) return;
      const src = audio.createBufferSource();
      const g = audio.createGain();
      src.buffer = buffer;
      g.gain.value = GAIN;
      src.connect(g).connect(audio.destination);
      src.start();
    });
  };
  const events = ['pointerdown', 'keydown'] as const;
  const off = () => events.forEach((e) => window.removeEventListener(e, start, true));
  void load(url);
  if (audio.state === 'running') start();
  else {
    events.forEach((e) => window.addEventListener(e, start, true));
    // Allowed without a gesture (the desktop app, or the user already clicked something): plays right away.
    void audio.resume().then(
      () => audio.state === 'running' && start(),
      () => {},
    );
  }
  return () => {
    done = true;
    off();
  };
}

export const sounds = {
  /** Version 1.0 is here! */
  fanfare: () => celebrate(fanfareUrl),
  /** Someone is calling you (loops until stopped). */
  ringIncoming: () => loop('calls', ringIncomingUrl),
  /** You're calling someone and they haven't picked up yet. */
  ringOutgoing: () => loop('calls', ringOutgoingUrl),
  join: () => play('voice', joinUrl),
  leave: () => play('voice', leaveUrl),
  selfJoin: () => play('voice', joinUrl),
  disconnect: () => play('voice', disconnectUrl),
  mute: () => play('mute', muteUrl),
  unmute: () => play('mute', unmuteUrl),
  deafen: () => play('mute', deafenUrl),
  undeafen: () => play('mute', undeafenUrl),
  message: () => play('messages', messageUrl),
  cameraOn: () => play('voice', cameraOnUrl),
  cameraOff: () => play('voice', cameraOffUrl),
  streamStart: () => play('stream', streamStartUrl),
  streamStop: () => play('stream', streamStopUrl),
  viewerJoin: () => play('stream', viewerJoinUrl),
  viewerLeave: () => play('stream', viewerLeaveUrl),
  pttOn: () => play('ptt', pttOnUrl),
  pttOff: () => play('ptt', pttOffUrl),
  recSaved: () => cue(recSavedUrl),
  recFailed: () => cue(recFailedUrl),
};
