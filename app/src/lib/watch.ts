// Watch together (server/src/watch.rs): what each call is watching, in sync with the server's clock.
import { createStore, produce } from 'solid-js/store';
import { api } from './api';

export interface Watch {
  provider: 'youtube' | 'twitch' | 'kick';
  media: string;
  url: string;
  live: boolean;
  started_by: string;
  playing: boolean;
  /** Seconds into the video at `updated_at` (server unix ms). */
  position: number;
  updated_at: number;
  /** It played to the end: "Video ended" for everyone until someone plays it again. */
  ended?: boolean;
  /** Who has it open (servers before 0.2.15 don't say). */
  viewers?: string[];
}

export const [watches, setWatches] = createStore<Record<string, Watch>>({});
/** Server clock minus ours (ms), from the last message that carried the server's time. */
let offset = 0;

export function setServerNow(serverNow: number | undefined) {
  if (serverNow) offset = serverNow - Date.now();
}

/** The desktop pop-out window has no connection of its own: the main window hands it the clock offset. */
export const serverOffset = () => offset;
export const setServerOffset = (ms: number) => void (offset = ms);

export function putWatch(channelId: string, w: Watch | null) {
  if (w) setWatches(channelId, w);
  else setWatches(produce((m) => delete m[channelId]));
}

/** Where everyone should be right now, in seconds. */
export function expectedPosition(w: Watch): number {
  if (!w.playing || w.live) return w.position;
  return w.position + (Date.now() + offset - w.updated_at) / 1000;
}

export const startWatch = (channelId: string, url: string) => api('PUT', `/channels/${channelId}/watch`, { url });
export type WatchPatch = { playing?: boolean; position?: number; ended?: boolean; live?: boolean };
let sendControl = (channelId: string, patch: WatchPatch): Promise<unknown> =>
  api('PATCH', `/channels/${channelId}/watch`, patch).catch(() => {});
/** Play, pause, seek or end for everyone. */
export const controlWatch = (channelId: string, patch: WatchPatch) => sendControl(channelId, patch);
/** The desktop pop-out sends these through the main window instead of the API. */
export function routeWatchControl(fn: (channelId: string, patch: WatchPatch) => Promise<unknown>) {
  sendControl = fn;
}
export const stopWatch = (channelId: string) => api('DELETE', `/channels/${channelId}/watch`);

const hms = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 3600)}h${Math.floor((t % 3600) / 60)}m${t % 60}s`;
};

/** The embed to load for a watch, starting at `at` seconds (muted: without sound, for our own stream's sake). */
export function embedSrc(w: Watch, at: number, hostname = location.hostname, muted = false): string {
  if (w.provider === 'youtube')
    return `https://www.youtube.com/embed/${w.media}?enablejsapi=1&autoplay=1&playsinline=1&rel=0&start=${Math.floor(at)}&origin=${encodeURIComponent(location.origin)}${muted ? '&mute=1' : ''}`;
  if (w.provider === 'twitch')
    return w.media.startsWith('v')
      ? `https://player.twitch.tv/?video=${w.media}&time=${hms(at)}&parent=${hostname}&autoplay=true&muted=${muted}`
      : `https://player.twitch.tv/?channel=${w.media}&parent=${hostname}&autoplay=true&muted=${muted}`;
  return `https://player.kick.com/${w.media}?autoplay=true${muted ? '&muted=true' : ''}`;
}

/**
 * Keeps a YouTube embed on the shared position through the iframe's postMessage protocol (the same one the
 * IFrame API script uses, without loading Google's script). What the viewer does in the player (pause, play,
 * seek) is sent to everyone; what we do to follow the others is not.
 */
export class YouTubeSync {
  private time = 0;
  private timeAt = 0;
  private state = -1;
  /** Length of the video once the player says (0 = not yet). */
  private duration = 0;
  /** The player says it's a live stream (a watch?v= link doesn't tell the server), before the server knows too. */
  private live = false;
  /** The player answered (it reports "unstarted", -1, until something plays). */
  private ready = false;
  private ours = 0;
  private timer: number;
  private listening: number;
  /** The window the player's messages arrive at: ours, or the pop-out window's once it moved there. */
  private view: Window = window;
  private attached = false;

  constructor(
    private frame: HTMLIFrameElement,
    private watch: () => Watch | undefined,
    private channelId: string,
  ) {
    this.attach();
    // The player only reports once we say we're listening; keep saying it until it answers.
    this.listening = window.setInterval(() => {
      this.attach();
      this.post({ event: 'listening', id: 1, channel: 'widget' });
    }, 500);
    this.timer = window.setInterval(() => (this.attach(), this.sync()), 1000);
  }

  /** Listens where the frame lives now (a pop-out window is a different window). */
  private attach() {
    const view = this.frame.ownerDocument.defaultView ?? window;
    if (this.attached && view === this.view) return;
    this.view.removeEventListener('message', this.onMessage);
    this.view = view;
    this.view.addEventListener('message', this.onMessage);
    this.attached = true;
  }

  dispose() {
    this.view.removeEventListener('message', this.onMessage);
    clearInterval(this.timer);
    clearInterval(this.listening);
  }

  private post(msg: object) {
    this.frame.contentWindow?.postMessage(JSON.stringify(msg), 'https://www.youtube.com');
  }

  private command(func: string, args: unknown[] = []) {
    this.ours = Date.now() + 1500;
    this.post({ event: 'command', func, args, id: 1, channel: 'widget' });
  }

  private isLive(w: Watch) {
    return w.live || this.live;
  }

  private current() {
    return this.state === 1 ? this.time + (Date.now() - this.timeAt) / 1000 : this.time;
  }

  private onMessage = (e: MessageEvent) => {
    if (e.source !== this.frame.contentWindow || typeof e.data !== 'string') return;
    let m: { event?: string; info?: any };
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    clearInterval(this.listening);
    const first = !this.ready;
    this.ready = true;
    const w = this.watch();
    if (!w) return;
    if (m.event === 'infoDelivery' && m.info) {
      // Live streams have no end and no shared position: tell everyone, once.
      if (m.info.videoData?.isLive === true && !this.live) {
        this.live = true;
        if (!w.live) void controlWatch(this.channelId, { live: true });
      }
      if (typeof m.info.duration === 'number' && m.info.duration > 0) this.duration = m.info.duration;
      if (typeof m.info.currentTime === 'number') {
        const expected = this.current();
        const jumped = this.timeAt && Math.abs(m.info.currentTime - expected) > 3;
        this.time = m.info.currentTime;
        this.timeAt = Date.now();
        // A seek in the player (not one we made): everyone goes there. Not the jump back to the start that
        // follows the end of the video, nor anything once it has ended.
        const atEnd = this.state === 0 || w.ended || (this.duration > 0 && expected >= this.duration - 1.5);
        if (jumped && !atEnd && Date.now() > this.ours && !this.isLive(w)) {
          this.ours = Date.now() + 1500;
          void controlWatch(this.channelId, { position: this.time });
        }
      }
      if (typeof m.info.playerState === 'number') this.onState(m.info.playerState, w);
    } else if (m.event === 'onStateChange' && typeof m.info === 'number') this.onState(m.info, w);
    if (first || m.event === 'onReady') this.sync();
  };

  /** 1 playing, 2 paused, 3 buffering, 0 ended. */
  private onState(s: number, w: Watch) {
    const was = this.state;
    this.state = s;
    // Played to the end: everyone gets "Video ended" (reported once; the server ignores repeats).
    if (s === 0 && !w.ended && !this.isLive(w)) {
      void controlWatch(this.channelId, { ended: true, position: this.duration || this.current() });
      return;
    }
    // Leaving "unstarted" is the player catching up with us, not a choice.
    if (s === was || was === -1 || Date.now() < this.ours || this.isLive(w)) return;
    if (s === 2 && w.playing) void controlWatch(this.channelId, { playing: false, position: this.current() });
    else if (s === 1 && !w.playing) void controlWatch(this.channelId, { playing: true, position: this.current() });
  }

  /** Follows the shared state: play/pause, and seek when we drifted. */
  sync() {
    const w = this.watch();
    if (!w || !this.ready) return;
    // Ended: stay on the last frame (the "Video ended" screen covers it) instead of following the clock.
    if (w.ended && !this.isLive(w)) {
      if (this.state === 1 || this.state === 3) this.command('pauseVideo');
      return;
    }
    // Joined after the end, or the clock ran past it: that's the end too.
    if (!this.isLive(w) && w.playing && this.duration > 0 && expectedPosition(w) >= this.duration) {
      if (this.state !== 0) void controlWatch(this.channelId, { ended: true, position: this.duration });
      return;
    }
    if (w.playing && this.state !== 1 && this.state !== 3 && this.state !== 0) this.command('playVideo');
    if (!w.playing && (this.state === 1 || this.state === 3)) this.command('pauseVideo');
    if (this.isLive(w)) return;
    const target = expectedPosition(w);
    const drift = Math.abs(this.current() - target);
    if (drift > (w.playing ? 2 : 0.6)) {
      this.command('seekTo', [target, true]);
      this.time = target;
      this.timeAt = Date.now();
    }
  }
}
