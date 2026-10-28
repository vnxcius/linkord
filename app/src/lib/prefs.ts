// Per-device preferences (audio devices, keybinds...). Synced account settings live in state.settings.
import { createStore } from 'solid-js/store';
import { DEFAULT_KEYBINDS, type Keybind } from './keys';

export type SoundKind = 'messages' | 'voice' | 'mute' | 'ptt' | 'stream';

export interface Prefs {
  inputDevice: string;
  outputDevice: string;
  /** Voice activity threshold as an RMS level, 0.001-0.2. */
  sensitivity: number;
  autoSensitivity: boolean;
  /** off | standard (browser's built-in) | advanced (RNNoise) */
  noiseMode: 'off' | 'standard' | 'advanced';
  echoCancellation: boolean;
  inputMode: 'voice' | 'ptt';
  /** Global keybinds (push-to-talk, toggle mute...); several per action are fine. */
  keybinds: Keybind[];
  pttReleaseDelay: number;
  /** Camera for video calls. */
  videoDevice: string;
  userVolumes: Record<string, number>;
  closeToTray: boolean;
  /** Starting with the computer keeps Linkord in the tray (off: opens the window). */
  startMinimized: boolean;
  /** Master switch for UI sounds, plus each kind. */
  sounds: boolean;
  soundKinds: Record<SoundKind, boolean>;
  desktopNotifications: boolean;
  /** Last used Go Live settings. */
  screenQuality: { height: 720 | 1080; fps: 15 | 30 | 60; optimize: 'clarity' | 'motion'; audio: boolean };
  /** Volume for videos in chat, 0-1. */
  mediaVolume: number;
  /** Width of the floating stream player (px). */
  miniPlayerWidth: number;
  /** Show the game you're playing to others ("Playing ..."). */
  shareActivity: boolean;
  /** Games added by hand in Registered Games (full executable path, lowercase with /). */
  customGames: { name: string; path: string }[];
  /** Detected games (application ids) the user removed from Registered Games. */
  hiddenGames: string[];
  /** UI language; 'system' follows the Windows (or browser) language. */
  language: 'system' | 'en' | 'pt-BR';
  /** Desktop app zoom (Ctrl + / Ctrl -), 1 = 100%. */
  zoom: number;
}

const DEFAULTS: Prefs = {
  inputDevice: 'default',
  outputDevice: 'default',
  sensitivity: 0.01,
  autoSensitivity: true,
  noiseMode: 'advanced',
  echoCancellation: true,
  inputMode: 'voice',
  keybinds: DEFAULT_KEYBINDS,
  pttReleaseDelay: 150,
  videoDevice: 'default',
  userVolumes: {},
  closeToTray: true,
  startMinimized: true,
  sounds: true,
  soundKinds: { messages: true, voice: true, mute: true, ptt: true, stream: true },
  desktopNotifications: true,
  screenQuality: { height: 1080, fps: 30, optimize: 'clarity', audio: true },
  mediaVolume: 1,
  miniPlayerWidth: 320,
  shareActivity: true,
  customGames: [],
  hiddenGames: [],
  language: 'system',
  zoom: 1,
};

const KEY = 'linkord.prefs';

function load(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    // Older versions stored a simple on/off switch.
    if (saved.noiseMode === undefined && saved.noiseSuppression === false) saved.noiseMode = 'off';
    delete saved.noiseSuppression;
    // Up to 0.1.8 there was a single push-to-talk key.
    if (saved.keybinds === undefined && saved.pttKey) {
      saved.keybinds = [
        ...DEFAULT_KEYBINDS,
        { id: 'ptt', action: 'ptt', combo: { vk: saved.pttKey, mods: 0, label: saved.pttLabel || 'Key' } },
      ];
    }
    delete saved.pttKey;
    delete saved.pttLabel;
    saved.soundKinds = { ...DEFAULTS.soundKinds, ...saved.soundKinds };
    return { ...DEFAULTS, ...saved };
  } catch {
    return DEFAULTS;
  }
}

const [prefs, setPrefsStore] = createStore<Prefs>(load());
export { prefs };

export function setPrefs(patch: Partial<Prefs>) {
  setPrefsStore(patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {}
}
