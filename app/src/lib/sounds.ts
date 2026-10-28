// UI sounds: Discord's own sound effects (private app, the owner's choice), decoded once and played
// through a small Web Audio graph so they can overlap and start without delay.
import { prefs, type SoundKind } from './prefs';
import cameraOffUrl from '../assets/sounds/camera-off.mp3';
import cameraOnUrl from '../assets/sounds/camera-on.mp3';
import deafenUrl from '../assets/sounds/deafen.mp3';
import disconnectUrl from '../assets/sounds/disconnect.mp3';
import joinUrl from '../assets/sounds/join.mp3';
import leaveUrl from '../assets/sounds/leave.mp3';
import messageUrl from '../assets/sounds/message.mp3';
import muteUrl from '../assets/sounds/mute.mp3';
import pttOffUrl from '../assets/sounds/ptt-off.mp3';
import pttOnUrl from '../assets/sounds/ptt-on.mp3';
import streamStartUrl from '../assets/sounds/stream-start.mp3';
import streamStopUrl from '../assets/sounds/stream-stop.mp3';
import undeafenUrl from '../assets/sounds/undeafen.mp3';
import unmuteUrl from '../assets/sounds/unmute.mp3';
import viewerJoinUrl from '../assets/sounds/viewer-join.mp3';
import viewerLeaveUrl from '../assets/sounds/viewer-leave.mp3';

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

export const sounds = {
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
};
