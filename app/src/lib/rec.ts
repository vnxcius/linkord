// REC on the app's side (Windows desktop app). The shell (src-tauri/src/rec) records; this decides what and when:
// settings (prefs.rec) go to the shell, every game games.ts finds is recorded (following League from its client to the
// game and back, like streams), the voice chat's recording mix is switched on without the people who opted out of
// recordings, and the REC hotkeys' actions live here. Nothing here shows anything while you play: saving plays a
// sound, and only the REC overlay says it's recording.

import { createEffect, createRoot, createSignal, on } from 'solid-js';
import { currentGame, scanApps, type CurrentGame } from './games';
import { linkedAppOf, linkedTarget } from './game-match';
import { isTauri } from './platform';
import { MOD, sameCombo, type Combo, type Keybind } from './keys';
import { prefs, setPrefs, type RecPrefs } from './prefs';
import { state, voiceMembers } from './store';
import { setRecordingVoices, voiceUi } from './voice';

export const recAvailable = isTauri && navigator.userAgent.includes('Windows');

export interface RecStatus {
  recording: boolean;
  game: string | null;
  /** Unix ms the recording started. */
  since: number | null;
  /** The game's window is covered or minimized: the recording holds its last picture. */
  paused: boolean;
  /** The voice chat goes into this recording. */
  voices: boolean;
  folder: string;
  /** Why the last recording stopped by itself, or couldn't start. */
  error: string | null;
  /** Your mic / the voice chat go into the recording right now (the overlay's switches); null = not recorded. */
  mic_on?: boolean | null;
  voices_on?: boolean | null;
}

const IDLE: RecStatus = {
  recording: false,
  game: null,
  since: null,
  paused: false,
  voices: false,
  folder: '',
  error: null,
};
const [recStatus, setStatusSignal] = createSignal<RecStatus>(IDLE);

/** Recordings already reported to the server (by start time), so each one counts once whichever way it ended. */
const reported = new Set<number>();

/** Every status change goes through here: a recording that just ended reports its length (the `recorded` badge). */
function setRecStatus(next: RecStatus) {
  const prev = recStatus();
  setStatusSignal(next);
  const since = prev.since;
  if (prev.recording && !next.recording && since && !reported.has(since)) {
    reported.add(since);
    const seconds = Math.round((Date.now() - since) / 1000);
    if (seconds >= 10)
      void import('./api').then(({ api }) => api('POST', '/users/@me/rec/recorded', { seconds }).catch(() => {}));
  }
}
export { recStatus };

/** What was saved last (the REC page and overlay list it first). */
export interface RecSaved {
  kind: 'clip' | 'screenshot' | 'bookmark';
  path: string | null;
  error: string | null;
}
const [lastSaved, setLastSaved] = createSignal<RecSaved | null>(null);
export { lastSaved };

type Invoke = typeof import('@tauri-apps/api/core').invoke;
let invokeFn: Invoke | null = null;
export async function recCall<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  invokeFn ??= (await import('@tauri-apps/api/core')).invoke;
  return invokeFn<T>(cmd, args);
}

/** Device names seen before, by kind + id (ids are stable per app, names are hidden until the mic has been used). */
const NAMES_KEY = 'linkord.deviceNames';
const pseudo = (d: MediaDeviceInfo) => d.deviceId === 'default' || d.deviceId === 'communications';

function savedNames(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(NAMES_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function rememberNames(devices: MediaDeviceInfo[]) {
  const names = savedNames();
  let changed = false;
  for (const d of devices) {
    const key = `${d.kind}:${d.deviceId}`;
    if (d.label && d.deviceId && !pseudo(d) && names[key] !== d.label) {
      names[key] = d.label;
      changed = true;
    }
  }
  try {
    if (changed) localStorage.setItem(NAMES_KEY, JSON.stringify(names));
  } catch {
    // Storage blocked: the names are asked for again next time.
  }
}

/** Asked for the mic once this run, to learn the devices' names. */
let askedForNames = false;

/**
 * The name Windows gives a device the app knows by id (the shell finds devices by name); '' = not found. Until the mic
 * has been used, WebView2 lists devices without names (and without ids): before a call, REC got '' and recorded
 * Windows' communications mic instead of the voice chat's (owner, 2026-11-13: a silent capture card input). So the
 * names are remembered once seen, and asked for (the mic opened and closed at once) when they aren't known yet.
 */
async function deviceName(kind: MediaDeviceKind, id: string): Promise<string> {
  const list = async () => {
    const all = (await navigator.mediaDevices?.enumerateDevices().catch(() => [])) ?? [];
    rememberNames(all);
    return all.filter((d) => d.kind === kind);
  };
  let devices = await list();
  if (!devices.some((d) => d.label)) {
    const saved = id && id !== 'default' ? savedNames()[`${kind}:${id}`] : undefined;
    if (saved) return clean(saved);
    if (askedForNames) return '';
    askedForNames = true;
    const stream = await navigator.mediaDevices?.getUserMedia({ audio: true }).catch(() => null);
    stream?.getTracks().forEach((t) => t.stop());
    devices = await list();
  }
  const chosen = devices.find((d) => d.deviceId === id) ?? devices.find((d) => d.deviceId === 'default');
  if (!chosen) return '';
  // "Default - X" / "Communications - X": the actual device in the same group (labels are localized, ids aren't).
  const real = pseudo(chosen) ? devices.find((d) => d.groupId === chosen.groupId && !pseudo(d)) : chosen;
  return clean(real?.label ?? '');
}

/** Chromium adds the USB ids to some labels ("Mic (Brand) (2b89:5854)"); Windows' name doesn't have them. */
const clean = (label: string) => label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '');

/** The microphone recorded: REC's own choice, else the one used for voice ('' = Windows' communications mic, null =
 * no mic). */
async function micName(rec: RecPrefs): Promise<string | null> {
  if (rec.mic === 'off') return null;
  return deviceName('audioinput', rec.micDevice || prefs.inputDevice);
}

async function configure() {
  const rec = { ...prefs.rec };
  const mic = await micName(rec);
  const status = await recCall<RecStatus>('rec_configure', {
    config: {
      folder: rec.folder,
      maxHeight: rec.maxHeight,
      fps: rec.fps,
      bitrateKbps: rec.bitrateKbps,
      cursor: rec.cursor,
      gameAudio: rec.gameAudio,
      mic,
      output: rec.outputDevice ? await deviceName('audiooutput', rec.outputDevice) : '',
      voices: rec.voices,
      clipSeconds: rec.clipSeconds,
      vodCapGb: rec.vodCapGb,
      clipCapGb: rec.clipCapGb,
      minFreeGb: rec.minFreeGb,
    },
  });
  setRecStatus(status);
}

// ---------- what to record ----------

/** What's being recorded: the game (or 'manual', a desktop recording) and the window or display followed. */
let recording: { key: string; window: string } | null = null;
/** Stopped by hand while this game was running: don't start it again until another game comes. */
let stoppedByHand: string | null = null;
/** Started by hand (auto-recording off, a game left out, or after stopping it): recorded until it closes. */
let startedByHand: string | null = null;
const FOLLOW_MS = 3000;

/** The window to record for a game now: League's game window during a match, else its client. */
async function windowOf(game: CurrentGame) {
  const apps = await scanApps();
  const app = apps.find((a) => a.pid === game.pid);
  const linked = app ? linkedAppOf(app.path) : undefined;
  const id = (linked && linkedTarget(linked, apps)) ?? app?.window?.id ?? game.window?.id;
  const target = apps.find((a) => a.window?.id === id);
  return id && target?.window && !target.window.minimized ? { id, pid: target.pid } : null;
}

let busy: Promise<void> | null = null;
/** Starts, follows or stops the recording to match the game being played. One at a time. */
function sync(): Promise<void> {
  return (busy ??= reconcile().finally(() => (busy = null)));
}

async function reconcile() {
  const game = currentGame();
  // Turned off: nothing records, a desktop recording included.
  if (!prefs.rec.enabled) {
    if (recording || recStatus().recording) await stop();
    return;
  }
  if (recording?.key === 'manual') return;
  if (stoppedByHand && stoppedByHand !== game?.key) stoppedByHand = null;
  if (startedByHand && startedByHand !== game?.key) startedByHand = null;
  const wanted =
    game &&
    (startedByHand === game.key ||
      (prefs.rec.auto && !prefs.rec.ignoredGames.includes(game.key) && stoppedByHand !== game.key));
  if (!wanted) {
    if (recording) await stop();
    return;
  }
  const win = await windowOf(game);
  // No window yet (still loading) or minimized: try again on the next round.
  if (!win) return;
  if (recording?.key === game.key) {
    if (win.id !== recording.window) {
      recording.window = win.id;
      await recCall('rec_retarget', { window: win.id, pid: win.pid }).catch(() => {});
    }
    return;
  }
  if (recording) await stop();
  recording = { key: game.key, window: win.id };
  try {
    setRecStatus(
      await recCall<RecStatus>('rec_start', { game: { name: game.name, key: game.key, pid: win.pid, window: win.id } }),
    );
  } catch (e) {
    recording = null;
    setRecStatus({ ...recStatus(), recording: false, error: String(e) });
  }
}

async function stop() {
  recording = null;
  setRecStatus(await recCall<RecStatus>('rec_stop'));
}

// ---------- actions (hotkeys, the REC page, the overlay) ----------

async function saved(kind: RecSaved['kind'], run: () => Promise<string | number | null>) {
  // REC off: its hotkeys do nothing (a screenshot would still work without a recording).
  if (!prefs.rec.enabled) return;
  try {
    const result = await run();
    setLastSaved({ kind, path: typeof result === 'string' ? result : null, error: null });
    void import('./sounds').then((s) => prefs.rec.sounds && s.sounds.recSaved());
  } catch (e) {
    setLastSaved({ kind, path: null, error: String(e) });
    void import('./sounds').then((s) => prefs.rec.sounds && s.sounds.recFailed());
  }
}

/** Saves the last seconds of the recording (the clip length setting). */
export const recClip = () => saved('clip', () => recCall<string>('rec_clip', {}));
export const recScreenshot = () => saved('screenshot', () => recCall<string>('rec_screenshot'));
export const recBookmark = () => saved('bookmark', () => recCall<number>('rec_bookmark'));

/** A display a desktop recording can record ("screen:<hmonitor>", as in the stream picker). */
export interface RecDisplay {
  id: string;
  name: string;
  width: number;
  height: number;
  thumbnail?: string | null;
}

export const listDisplays = () => recCall<RecDisplay[]>('list_capture_screens');

/** The REC page shows the display picker while this is true (Record now, or the hotkey with no display to reuse). */
const [displayPicker, setDisplayPicker] = createSignal(false);
export { displayPicker, setDisplayPicker };

/** Records the desktop on `display` (only ever by hand: REC records nothing but games by itself). */
export async function recDesktop(display: RecDisplay) {
  setDisplayPicker(false);
  setRecPrefs({ display: { id: display.id, name: display.name } });
  if (recStatus().recording) await stop();
  recording = { key: 'manual', window: display.id };
  try {
    setRecStatus(
      await recCall<RecStatus>('rec_start', { game: { name: 'Desktop', key: 'manual', pid: 0, window: display.id } }),
    );
  } catch (e) {
    recording = null;
    setRecStatus({ ...recStatus(), recording: false, error: String(e) });
  }
}

/**
 * Start/stop by hand. Recording: stops it (a game stays stopped until it closes). Not recording: the game you're
 * playing if there is one, else the desktop on a display you pick. With one display there's nothing to pick; the
 * hotkey (`ask` false) reuses the display picked last while it's still connected, else it brings up the picker.
 */
export async function recToggle(ask = true) {
  // REC off: the start/stop key brings up its page (the introduction), never a recording.
  if (!prefs.rec.enabled && !recStatus().recording) return openRec();
  if (recStatus().recording) {
    stoppedByHand = recording?.key === 'manual' ? null : (recording?.key ?? null);
    startedByHand = null;
    return stop();
  }
  const game = currentGame();
  if (game) {
    stoppedByHand = null;
    startedByHand = game.key;
    return sync();
  }
  const displays = await listDisplays().catch(() => [] as RecDisplay[]);
  if (displays.length === 1) return recDesktop(displays[0]);
  const last = prefs.rec.display;
  const again = !ask && last && (displays.find((d) => d.id === last.id) ?? displays.find((d) => d.name === last.name));
  if (again) return recDesktop(again);
  await showMain();
  const { ui, setUi } = await import('./ui');
  if (ui.modal?.type !== 'rec') setUi('modal', { type: 'rec' });
  setDisplayPicker(true);
}

async function openRec() {
  await showMain();
  const { ui, setUi } = await import('./ui');
  if (ui.modal?.type !== 'rec') setUi('modal', { type: 'rec' });
}

async function showMain() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const w = getCurrentWindow();
  await w.show().catch(() => {});
  await w.unminimize().catch(() => {});
  await w.setFocus().catch(() => {});
}

/** Opens or closes the REC overlay over the game (src-tauri/src/rec/overlay.rs). Only while you're in a game. */
export async function toggleRecOverlay() {
  if (!currentGame() || !prefs.rec.enabled) return recCall('rec_overlay_close').catch(() => {});
  await recCall('rec_overlay_toggle').catch(() => {});
}

/** The keys clip, screenshot and bookmark had by default before (owner, 2026-11-13: now unset, only the overlay). */
const OLD_DEFAULTS: [Keybind['action'], number][] = [
  ['rec-clip', 0x77],
  ['rec-screenshot', 0x78],
  ['rec-bookmark', 0x76],
];

/** Devices set up with the old defaults: auto-recording on, and those three keys cleared if they were never changed. */
function updateDefaults() {
  if (prefs.recDefaults >= 2) return;
  const keybinds = prefs.keybinds.map((b) =>
    OLD_DEFAULTS.some(([action, vk]) => b.id === `default-${action}` && b.combo?.vk === vk && !b.combo.mods)
      ? { ...b, combo: null }
      : b,
  );
  setPrefs({ keybinds, rec: { ...prefs.rec, auto: true }, recDefaults: 2 });
}

/**
 * REC's default hotkeys, added once: only the overlay, on Shift + the key left of 1 (owner: "~" on a US keyboard, '"'
 * on ABNT2; the shell finds that key in the current layout), left out if those keys are taken. Clip, screenshot,
 * bookmark and start/stop are listed unset.
 */
async function ensureHotkeys() {
  if (prefs.recHotkeysAdded) return;
  const overlay = await recCall<{ vk: number; label: string } | null>('rec_overlay_key').catch(() => null);
  const defaults: [Keybind['action'], Combo | null][] = [
    ['rec-overlay', overlay && { vk: overlay.vk, mods: MOD.shift, label: overlay.label }],
    ['rec-clip', null],
    ['rec-screenshot', null],
    ['rec-bookmark', null],
    ['rec-toggle', null],
  ];
  const binds = [...prefs.keybinds];
  for (const [action, combo] of defaults) {
    if (binds.some((b) => b.action === action)) continue;
    const taken = combo && binds.some((b) => sameCombo(b.combo, combo));
    binds.push({ id: `default-${action}`, action, combo: taken ? null : combo });
  }
  setPrefs({ keybinds: binds, recHotkeysAdded: true });
}

export function setRecPrefs(patch: Partial<RecPrefs>) {
  setPrefs({ rec: { ...prefs.rec, ...patch } });
}

// ---------- start ----------

export async function initRec() {
  if (!recAvailable) return;
  const { listen } = await import('@tauri-apps/api/event');
  await listen<RecStatus>('rec-status', (e) => setRecStatus(e.payload));
  // The overlay's buttons that need the main window: start/stop (it knows what's recorded), and "open REC".
  await listen<'toggle' | 'open'>('rec-action', async (e) => {
    if (e.payload === 'toggle') return recToggle(false);
    await recCall('rec_overlay_close').catch(() => {});
    await openRec();
  });
  updateDefaults();
  await ensureHotkeys();
  // League matches: their moments on the timeline, auto-clips, the pentakill claim.
  void import('./rec-league').then((m) => m.initRecLeague());
  createRoot(() => {
    // Settings: every change goes to the shell (the mic follows the voice input device).
    createEffect(
      on(
        () => [JSON.stringify(prefs.rec), prefs.inputDevice],
        () => void configure().then(sync),
        { defer: false },
      ),
    );
    createEffect(on(currentGame, () => void sync(), { defer: true }));
    // The overlay belongs to the game: it goes when the game does.
    createEffect(
      on(currentGame, (game) => !game && void recCall('rec_overlay_close').catch(() => {}), { defer: true }),
    );
    // The voice chat in the recording: only during a call, never the people who said no.
    createEffect(() => {
      const s = recStatus();
      const channel = voiceUi.channelId;
      const on = s.recording && s.voices && !!channel;
      const me = state.me?.id;
      const exclude = on
        ? voiceMembers(channel!)
            .map((v) => v.user_id)
            .filter((id) => id !== me && state.users[id]?.rec_opt_out)
            .sort()
        : [];
      setRecordingVoices(on, exclude);
    });
  });
  // The window to follow can change without the game changing (League: client -> game).
  setInterval(() => recording && recording.key !== 'manual' && void sync(), FOLLOW_MS);
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void configure());
}
