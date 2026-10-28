// "Playing <game>" on the Windows desktop app: every few seconds the shell lists running processes, we match
// them against Discord's detectable-games list (game-match.ts) plus games added by hand, report the game as
// your activity, and offer to stream its window straight away (the panel above Voice Connected, a keybind).
import { createSignal } from 'solid-js';
import { api, getToken } from './api';
import { buildIndex, gameIconUrl, matchPath, normalizePath, type DetectableGame, type GameIndex } from './game-match';
import { t } from './i18n';
import { isTauri } from './platform';
import { prefs } from './prefs';
import { toast } from './ui';
import { startScreenShare, stopScreenShare, voiceUi } from './voice';

export interface RunningApp {
  pid: number;
  path: string;
  window: { id: string; title: string; width: number; height: number; minimized: boolean } | null;
}

export interface CurrentGame {
  /** Detectable application id, or `custom:<path>` for games added by hand. */
  key: string;
  applicationId?: string;
  name: string;
  icon?: string;
  pid: number;
  window: RunningApp['window'];
  /** Unix ms when we first saw it running. */
  startedAt: number;
}

const SCAN_MS = 15_000;
/** The server drops a game it doesn't hear about for 150 s. */
const REPORT_MS = 60_000;

export const gameDetectionAvailable = isTauri && navigator.userAgent.includes('Windows');

const [currentGame, setCurrentGame] = createSignal<CurrentGame | null>(null);
const [runningApps, setRunningApps] = createSignal<RunningApp[]>([]);
export { currentGame, runningApps };

let index: GameIndex | null = null;
let names = new Map<string, string>();

async function loadList() {
  if (index) return;
  const list = await api<DetectableGame[]>('GET', '/activities/detectable').catch(() => null);
  if (!list) return;
  index = buildIndex(list);
  names = new Map(list.map((g) => [g[0], g[1]]));
}

/** A detectable game's name by application id (for the removed-games list). */
export const detectableName = (id: string) => names.get(id) ?? id;

/** What a process is, if it's a game we show: a hand-added one first, then the detectable list. */
export function gameFor(app: RunningApp): Omit<CurrentGame, 'pid' | 'window' | 'startedAt'> | null {
  const path = normalizePath(app.path);
  const custom = prefs.customGames.find((g) => g.path === path);
  if (custom) return { key: `custom:${custom.path}`, name: custom.name };
  const game = index && matchPath(index, app.path);
  if (!game || prefs.hiddenGames.includes(game[0])) return null;
  return { key: game[0], applicationId: game[0], name: game[1], icon: gameIconUrl(game) };
}

export async function scanApps(): Promise<RunningApp[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  const apps = await invoke<RunningApp[]>('running_apps').catch(() => [] as RunningApp[]);
  setRunningApps(apps);
  return apps;
}

let lastReport = 0;
let reported: string | null = null;

async function report(game: CurrentGame | null) {
  const key = game && prefs.shareActivity ? `${game.key}|${game.startedAt}` : null;
  const now = Date.now();
  if (key === reported && (!key || now - lastReport < REPORT_MS)) return;
  try {
    if (game && key) await api('PUT', '/activities/playing', { application_id: game.applicationId, name: game.name, started_at: game.startedAt });
    else await api('DELETE', '/activities/playing');
    reported = key;
    lastReport = now;
  } catch {
    // Offline or logged out: try again next scan.
  }
}

async function scan() {
  if (!getToken()) return;
  await loadList();
  const apps = await scanApps();
  // Several matches: prefer one with a window you can see (the game, not a helper process).
  const found = apps
    .map((app) => ({ app, game: gameFor(app) }))
    .filter((x) => x.game)
    .sort((a, b) => Number(!!b.app.window && !b.app.window.minimized) - Number(!!a.app.window && !a.app.window.minimized))[0];
  const prev = currentGame();
  if (!found) setCurrentGame(null);
  else {
    const same = prev?.key === found.game!.key;
    setCurrentGame({ ...found.game!, pid: found.app.pid, window: found.app.window, startedAt: same ? prev!.startedAt : Date.now() });
  }
  await report(currentGame());
}

/** Starts detection (desktop app on Windows). */
export function initGames() {
  if (!gameDetectionAvailable) return;
  void scan();
  setInterval(() => void scan(), SCAN_MS);
}

/** Re-reports right away (sharing toggled, a game added or removed). */
export async function refreshGames() {
  reported = null;
  await scan();
}

/** Streams the current game's window with your last Go Live settings, or stops your stream. */
export async function toggleGameStream() {
  if (voiceUi.screen) return stopScreenShare();
  const game = currentGame();
  if (!game) return toast(t('No game detected'));
  if (!voiceUi.channelId) return toast(t('Join a voice channel to go live'));
  // The window may have changed since the last scan (game restarted, launcher closed).
  const app = (await scanApps()).find((a) => a.pid === game.pid);
  const win = app?.window ?? game.window;
  if (!win) return toast(t("{game} has no window to stream yet", { game: game.name }));
  if (win.minimized) return toast(t('Restore the {game} window to stream it', { game: game.name }));
  await startScreenShare(prefs.screenQuality, win.id);
}
