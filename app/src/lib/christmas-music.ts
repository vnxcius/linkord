// The Christmas theme's background music: public domain recordings by US Air Force bands (app/music/christmas), shuffled,
// one after another. Only the web build carries the files, so the desktop installer stays small; the app streams them
// from the server, like the spellcheck dictionaries.
// It's background music, so anything else you're listening to comes first: it pauses during calls and while a call
// rings, while a video or voice message plays, and while Pottira isn't the window you're using (a game, say).
import { createEffect, createRoot, createSignal, onCleanup } from 'solid-js';
import { serverUrl } from './api';
import { prefs } from './prefs';
import { isChristmas } from './theme';
import { voiceUi } from './voice';
import { state } from './store';

const TRACKS = ['carol-of-the-bells', 'deck-the-halls', 'celebration-of-carols', 'silent-nights', 'jingle-bells'];
const TITLES: Record<string, string> = {
  'carol-of-the-bells': 'Carol of the Bells',
  'deck-the-halls': 'Deck the Halls',
  'celebration-of-carols': 'Celebration of Carols',
  'silent-nights': 'Silent Nights',
  'jingle-bells': 'Jingle Bells',
};
const FADE_MS = 800;
const FADE_STEP_MS = 40;

const urlOf = (track: string) => `${import.meta.env.DEV ? '' : serverUrl()}/christmas-music/${track}.mp3`;

function shuffled() {
  const list = [...TRACKS];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

const [track, setTrack] = createSignal<string | null>(null);
/** The song that's on (or paused for now), once the music has started. */
export const musicTitle = () => (isChristmas() && prefs.christmasMusic && track() ? TITLES[track()!] : null);
let skip = () => {};
/** On to the next song. */
export const nextSong = () => skip();

/** Started once, at launch. Nothing is created or downloaded until the music should actually play. */
export function initChristmasMusic() {
  createRoot(() => {
    const [windowInUse, setWindowInUse] = createSignal(false);
    const update = () => setWindowInUse(document.visibilityState === 'visible' && document.hasFocus());
    update();
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);

    // Other media playing with sound. `play` and `pause` don't bubble, but they can be caught on the way down.
    const others = new Set<HTMLMediaElement>();
    const [otherPlaying, setOtherPlaying] = createSignal(false);
    let audio: HTMLAudioElement | null = null;
    const onMedia = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLMediaElement) || el === audio) return;
      if (e.type === 'play' && !el.muted) others.add(el);
      else if (e.type !== 'play') others.delete(el);
      setOtherPlaying(others.size > 0);
    };
    for (const type of ['play', 'pause', 'ended', 'emptied']) document.addEventListener(type, onMedia, true);

    const callRinging = () => {
      const me = state.me?.id;
      return !!me && Object.values(state.calls).some((ringing) => ringing.includes(me));
    };
    const wanted = () =>
      isChristmas() &&
      prefs.christmasMusic &&
      prefs.christmasMusicVolume > 0 &&
      windowInUse() &&
      !voiceUi.channelId &&
      !callRinging() &&
      !otherPlaying();

    let queue: string[] = [];
    let failures = 0;
    let gain = 0;
    let fade: ReturnType<typeof setInterval> | undefined;
    let shouldPlay = false;

    const applyVolume = () => {
      if (audio) audio.volume = gain * gain * prefs.christmasMusicVolume;
    };
    const next = () => {
      if (!audio) return;
      if (!queue.length) {
        queue = shuffled();
        // A new round never starts with the song that just ended.
        if (queue[0] === track()) queue.push(queue.shift()!);
      }
      const song = queue.shift()!;
      setTrack(song);
      audio.src = urlOf(song);
    };

    /** Browsers refuse to start sound before the first click or key press: tries again at that moment. */
    const afterGesture = () => {
      for (const type of ['pointerdown', 'keydown']) window.removeEventListener(type, afterGesture, true);
      if (shouldPlay) void start();
    };
    const start = async () => {
      if (!audio) {
        audio = new Audio();
        audio.preload = 'auto';
        audio.addEventListener('ended', next);
        audio.addEventListener('canplay', () => shouldPlay && void audio!.play().catch(() => {}));
        audio.addEventListener('playing', () => (failures = 0));
        // One bad file skips to the next. All of them failing (server not updated yet, offline) ends it until the
        // next time it should start, instead of asking the server forever.
        audio.addEventListener('error', () => {
          if (++failures < TRACKS.length) next();
        });
        next();
      }
      try {
        await audio.play();
      } catch (e) {
        if ((e as Error).name === 'NotAllowedError')
          for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, afterGesture, true);
      }
    };

    skip = () => {
      failures = 0;
      next();
    };

    const fadeTo = (target: number, then?: () => void) => {
      clearInterval(fade);
      const step = FADE_STEP_MS / FADE_MS;
      fade = setInterval(() => {
        gain = target > gain ? Math.min(target, gain + step) : Math.max(target, gain - step);
        applyVolume();
        if (gain === target) {
          clearInterval(fade);
          then?.();
        }
      }, FADE_STEP_MS);
    };

    createEffect(() => {
      shouldPlay = wanted();
      if (shouldPlay) {
        failures = 0;
        void start();
        fadeTo(1);
      } else if (audio) {
        fadeTo(0, () => audio?.pause());
      }
    });
    createEffect(applyVolume);

    onCleanup(() => clearInterval(fade));
  });
}
