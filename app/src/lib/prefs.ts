// Per-device preferences (audio devices, keybinds...). Synced account settings live in state.settings.
import { createStore } from 'solid-js/store';
import { DEFAULT_KEYBINDS, type Keybind } from './keys';

export type SoundKind = 'messages' | 'voice' | 'mute' | 'ptt' | 'stream' | 'calls';

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
  /** Sound chosen per capture card: video device id -> audio input id ('' = none). */
  captureAudio: Record<string, string>;
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
  /** Light or dark; 'system' follows Windows (or the browser). Christmas is a dark theme with decorations. */
  theme: 'system' | 'light' | 'dark' | 'christmas';
  /** With the Christmas theme: falling snow. */
  christmasSnow: boolean;
  /** With the Christmas theme: its sound pack instead of the usual sounds. */
  christmasSounds: boolean;
  /** With the Christmas theme: background music, and how loud (0-1). */
  christmasMusic: boolean;
  christmasMusicVolume: number;
  /** With the Christmas theme: hats on everyone's picture, Santa's flights, the countdown in channel headers. */
  christmasHats: boolean;
  christmasSanta: boolean;
  christmasCountdown: boolean;
  /** How many times you've caught Santa. */
  santaCaught: number;
  /** Desktop app zoom (Ctrl + / Ctrl -), 1 = 100%. */
  zoom: number;
  /** Skin tone for emoji picked in the picker: 0 = default yellow, 1-5 light to dark. */
  emojiTone: number;
  /** Web: the "get the desktop app" banner was closed. */
  downloadBannerDismissed: boolean;
  /** Last version whose "Linkord was updated" banner was seen ('' = first run). */
  lastSeenVersion: string;
  /** Show the "Linkord was updated" banner after each update. */
  updateBanner: boolean;
  /** Stream/camera debug info (bitrate, codec, audio and capture diagnostics) over the video. */
  streamDebug: boolean;
  /** Windows app: Linkord gets quieter while another app's call (WhatsApp, Teams...) rings or is on. */
  duckOtherCalls: boolean;
  /** Soundboard volume (0-1) for everyone's sounds, and per person (0 = muted). */
  soundboardVolume: number;
  soundboardUserVolumes: Record<string, number>;
  /** In-game overlay (Windows app): who's in the call, over borderless games. */
  overlay: boolean;
  overlayCorner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** Only rows for people talking right now. */
  overlayOnlySpeaking: boolean;
  /** Profile songs start by themselves (quietly) when you open someone's full profile. Off: they wait for a click. */
  profileSongAutoplay: boolean;
  /** Spellcheck in the message box, its language ('auto' = the app's language) and words you added. */
  spellcheck: boolean;
  spellLanguage: 'auto' | 'en' | 'pt' | 'es';
  spellWords: string[];
  /** Height of the call above DM chats, set by dragging its edge (0 = automatic). */
  dmCallHeight: number;
  /** Width of a voice channel's chat beside the call (px; 0 = the default). */
  voiceChatWidth: number;
  /** Sidebar widths in px (channel list, right sidebar); 0 = default. */
  navWidth: number;
  marginWidth: number;
  /** The channel list is hidden while a voice channel is open (the header's sidebar button). */
  voiceNavCollapsed: boolean;
  /** REC (Windows app): game recording, set on the REC page. */
  rec: RecPrefs;
  /** REC's default hotkeys were added (once, so removing one sticks). */
  recHotkeysAdded: boolean;
  /** REC's defaults were updated for this device (2 = auto-recording on, only the overlay hotkey set). */
  recDefaults: number;
}

export interface RecPrefs {
  /** REC is opt-in (owner, 2026-11-14): nothing records, and its hotkeys and overlay do nothing, until it's turned on
   * from the REC page's introduction. Turned off again from its settings. */
  enabled: boolean;
  /** The first-time setup was done (or skipped): turning REC on again goes straight back to the studio. */
  setupDone: boolean;
  /** Record every game you play, once REC is on (on by default, the dev app too: it records into its own folder). */
  auto: boolean;
  /** Where recordings go ('' = Videos\Linkord). */
  folder: string;
  /** Largest recorded height (0 = as captured), frames per second, bitrate. */
  maxHeight: number;
  fps: number;
  bitrateKbps: number;
  cursor: boolean;
  gameAudio: boolean;
  /** 'voice' = a microphone is recorded (micDevice says which), 'off' = none. */
  mic: 'voice' | 'off';
  /** The microphone recorded ('' = the one you use for voice chat), a deviceId. */
  micDevice: string;
  /** The output recorded when a game's own sound can't be told apart (Windows 10, desktop recordings): '' = Windows'
   * default, else a deviceId. */
  outputDevice: string;
  /** Where the REC player plays ('' = Linkord's output device). */
  playbackDevice: string;
  /** The voice chat (others in your call, minus anyone who opted out). */
  voices: boolean;
  /** Length of a clip saved with the hotkey, in seconds. */
  clipSeconds: number;
  /** Storage limits in GB: VODs, clips + screenshots, and the free space REC always leaves. */
  vodCapGb: number;
  clipCapGb: number;
  minFreeGb: number;
  /** A short sound when a clip, screenshot or bookmark is saved (the only feedback while the overlay is closed). */
  sounds: boolean;
  /** Games never recorded (games.ts keys). */
  ignoredGames: string[];
  /** League of Legends: which of your moments save a clip by themselves (off by default; ticks on the VOD always). */
  league: LeagueClipPrefs;
  /** The display picked last for a desktop recording (the start/stop hotkey records it again); null = ask. */
  display: { id: string; name: string } | null;
}

export interface LeagueClipPrefs {
  auto: boolean;
  /** Double kill and up. */
  multikill: boolean;
  ace: boolean;
  /** Dragon, Baron, Rift Herald stolen. */
  steal: boolean;
  kill: boolean;
  death: boolean;
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
  captureAudio: {},
  userVolumes: {},
  closeToTray: true,
  startMinimized: true,
  sounds: true,
  soundKinds: { messages: true, voice: true, mute: true, ptt: true, stream: true, calls: true },
  desktopNotifications: true,
  screenQuality: { height: 1080, fps: 30, optimize: 'clarity', audio: true },
  mediaVolume: 1,
  miniPlayerWidth: 320,
  shareActivity: true,
  customGames: [],
  hiddenGames: [],
  language: 'system',
  theme: 'system',
  christmasSnow: true,
  christmasSounds: true,
  christmasMusic: true,
  christmasMusicVolume: 0.2,
  christmasHats: true,
  christmasSanta: true,
  christmasCountdown: true,
  santaCaught: 0,
  zoom: 1,
  emojiTone: 0,
  downloadBannerDismissed: false,
  lastSeenVersion: '',
  updateBanner: true,
  streamDebug: false,
  duckOtherCalls: true,
  soundboardVolume: 0.8,
  soundboardUserVolumes: {},
  overlay: true,
  overlayCorner: 'top-left',
  overlayOnlySpeaking: false,
  profileSongAutoplay: false,
  spellcheck: true,
  spellLanguage: 'auto',
  spellWords: [],
  dmCallHeight: 0,
  voiceChatWidth: 0,
  navWidth: 0,
  marginWidth: 0,
  voiceNavCollapsed: false,
  rec: {
    enabled: false,
    setupDone: false,
    auto: true,
    folder: '',
    maxHeight: 1080,
    fps: 60,
    bitrateKbps: 12000,
    cursor: true,
    gameAudio: true,
    mic: 'voice',
    micDevice: '',
    outputDevice: '',
    playbackDevice: '',
    voices: true,
    clipSeconds: 30,
    vodCapGb: 50,
    clipCapGb: 20,
    minFreeGb: 5,
    sounds: true,
    ignoredGames: [],
    league: { auto: false, multikill: true, ace: true, steal: true, kill: false, death: false },
    display: null,
  },
  recHotkeysAdded: false,
  recDefaults: 0,
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
    saved.rec = { ...DEFAULTS.rec, ...saved.rec, league: { ...DEFAULTS.rec.league, ...saved.rec?.league } };
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
