// "Playing <game>" on the Windows desktop app: every few seconds the shell lists running processes, we match
// them against Discord's detectable-games list (game-match.ts) plus games added by hand, report the game as
// your activity, and offer to stream its window straight away (the panel above Voice Connected, a keybind).
import { createSignal } from 'solid-js';
import { api, getToken } from './api';
import {
  buildIndex,
  gameIconUrl,
  linkedAppOf,
  linkedTarget,
  matchPath,
  normalizePath,
  type DetectableGame,
  type GameIndex,
  type LinkedApp,
} from './game-match';
import { t } from './i18n';
import { leagueReport, watchLeague, type LeagueReport } from './league';
import { isTauri } from './platform';
import { prefs } from './prefs';
import { toast } from './ui';
import {
  nativeSource,
  setSourceClosedHandler,
  startScreenShare,
  stopScreenShare,
  switchScreenSource,
  voiceUi,
} from './voice';

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
  /** League of Legends: what its client is doing (lobby, queue, champion select...). */
  league?: LeagueReport;
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
/** League of Legends in the detectable list: its client counts as the game too (lobby, queue...). */
let leagueGame: DetectableGame | null = null;
const LEAGUE_CLIENT = /(^|[\\/])leagueclientux\.exe$/i;

async function loadList() {
  if (index) return;
  const list = await api<DetectableGame[]>('GET', '/activities/detectable').catch(() => null);
  if (!list) return;
  index = buildIndex(list);
  names = new Map(list.map((g) => [g[0], g[1]]));
  leagueGame = list.find((g) => g[1] === 'League of Legends') ?? null;
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
  const key =
    game && prefs.shareActivity ? `${game.key}|${game.startedAt}|${JSON.stringify(game.league ?? null)}` : null;
  const now = Date.now();
  if (key === reported && (!key || now - lastReport < REPORT_MS)) return;
  try {
    if (game && key)
      await api('PUT', '/activities/playing', {
        application_id: game.applicationId,
        name: game.name,
        started_at: game.startedAt,
        league: game.league,
      });
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
  watchLeague(apps.find((a) => LEAGUE_CLIENT.test(a.path))?.path ?? null, () => void leagueChanged());
  pick(apps);
  await report(currentGame());
}

/** The League client changed phase, party or champion: report it now, not at the next scan. */
async function leagueChanged() {
  if (!getToken()) return;
  pick(runningApps());
  await report(currentGame());
}

function pick(apps: RunningApp[]) {
  // Several matches: prefer one with a window you can see (the game, not a helper process).
  const found = apps
    .map((app) => ({ app, game: gameFor(app) }))
    .filter((x) => x.game)
    .sort(
      (a, b) => Number(!!b.app.window && !b.app.window.minimized) - Number(!!a.app.window && !a.app.window.minimized),
    )[0];
  let next: Omit<CurrentGame, 'startedAt'> | null = found
    ? { ...found.game!, pid: found.app.pid, window: found.app.window }
    : null;
  // League's client (lobby, queue, champion select) is League too, like on Discord; sitting idle in it gives way
  // to another game you're playing.
  const league = leagueReport();
  const client = apps.find((a) => LEAGUE_CLIENT.test(a.path));
  const lg = leagueGame;
  if (league && lg && !prefs.hiddenGames.includes(lg[0])) {
    const isLeague = next?.key === lg[0];
    if (isLeague) next = { ...next!, league };
    else if (client && (!next || league.phase !== 'client'))
      next = {
        key: lg[0],
        applicationId: lg[0],
        name: lg[1],
        icon: gameIconUrl(lg),
        pid: client.pid,
        window: client.window,
        league,
      };
  }
  const prev = currentGame();
  if (!next) setCurrentGame(null);
  else setCurrentGame({ ...next, startedAt: prev?.key === next.key ? prev.startedAt : Date.now() });
}

/** Starts detection (desktop app on Windows). */
export function initGames() {
  if (!gameDetectionAvailable) return;
  void scan();
  setInterval(() => void scan(), SCAN_MS);
  setInterval(() => void followStream(), FOLLOW_MS);
  // The shared window closed: let a check already under way finish, then look again.
  setSourceClosedHandler(async (source) => {
    await inFlight;
    await followStream();
    // League's client comes back a few seconds after a match (restored, or relaunched if it closed during the
    // game): keep the stream until it does instead of ending it.
    const until = Date.now() + RETURN_WAIT_MS;
    while (nativeSource() === source && followed?.source === source && followed.linked && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      await followStream();
    }
  });
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
  if (!win) return toast(t('{game} has no window to stream yet', { game: game.name }));
  if (win.minimized) return toast(t('Restore the {game} window to stream it', { game: game.name }));
  await startScreenShare(prefs.screenQuality, win.id);
}

// ---------- streams that follow their app (League of Legends: client -> game -> client) ----------

const FOLLOW_MS = 3000;
/** How long a closed linked window (League's game) waits for the other one (its client) before the stream ends. */
const RETURN_WAIT_MS = 60_000;
/** The window stream we last looked at, and the linked app it belongs to (null: none, nothing to follow). */
let followed: { source: string; linked: LinkedApp | null } | null = null;
let inFlight: Promise<void> | null = null;

/** Moves a native window stream to where its linked app is now. */
function followStream(): Promise<void> {
  return (inFlight ??= follow().finally(() => (inFlight = null)));
}

async function follow() {
  const source = nativeSource();
  if (!source?.startsWith('window:')) return void (followed = null);
  if (followed?.source === source && !followed.linked) return;
  const apps = await scanApps();
  if (followed?.source !== source) {
    const app = apps.find((a) => a.window?.id === source);
    followed = { source, linked: app ? (linkedAppOf(app.path) ?? null) : null };
  }
  const target = followed.linked && linkedTarget(followed.linked, apps);
  if (!target || target === source || nativeSource() !== source) return;
  await switchScreenSource(target);
  if (nativeSource() === target) followed = { source: target, linked: followed.linked };
}
