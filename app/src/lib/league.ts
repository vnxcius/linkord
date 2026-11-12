// League of Legends: rich presence read from the League client (Windows app; src-tauri/src/league.rs) and the names
// and art both it and the profile widget (ProfileWidgets.tsx LeagueCard) show. Server side: server/src/league.rs.
//
// While LeagueClientUx.exe runs, games.ts calls watchLeague() with its path; we ask the shell every 3 s (every 15 s in
// a match, so a game never pays for it) what the client is doing and hand games.ts a summary when it changes. It goes
// out with the "Playing" report, so it follows the same "share my activity" setting.
import { createSignal } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { api, serverUrl } from './api';
import { msg, t } from './i18n';
import { isTauri } from './platform';
import { nameOf } from './store';
import { toast } from './ui';

/** What the shell reads from the League client. */
interface LeagueStatus {
  phase: string;
  queue_id?: number | null;
  queue?: string | null;
  mode?: string | null;
  party_size?: number | null;
  party_max?: number | null;
  queue_seconds?: number | null;
  champion_id?: number | null;
  game_time?: number | null;
  game_name?: string | null;
  tag_line?: string | null;
  summoner_id?: number | null;
  puuid?: string | null;
  can_invite?: boolean | null;
}

export type LeaguePhase = 'client' | 'lobby' | 'queue' | 'champ_select' | 'in_game' | 'post_game';

/** As reported with "Playing" (PUT /activities/playing `league`). */
export interface LeagueReport {
  phase: LeaguePhase;
  queue_id?: number;
  queue?: string;
  mode?: string;
  party_size?: number;
  party_max?: number;
  /** Unix ms when this phase started. */
  since?: number;
  champion_id?: number;
}

/** As everyone gets it in the activity (`activity.league`): the server adds the champion's name and icon. */
export interface LeagueActivity {
  phase: LeaguePhase;
  queue_id?: number;
  queue?: string;
  mode?: string;
  party?: { size: number; max: number };
  since?: number;
  champion?: { id: number; name: string; icon: string };
}

const POLL_MS = 3000;
/** In a match: rarely, the game is what matters. */
const IN_GAME_POLL_MS = 15_000;

const PHASES: Record<string, LeaguePhase> = {
  None: 'client',
  Lobby: 'lobby',
  CheckedIntoTournament: 'lobby',
  Matchmaking: 'queue',
  ReadyCheck: 'queue',
  ChampSelect: 'champ_select',
  GameStart: 'in_game',
  InProgress: 'in_game',
  Reconnect: 'in_game',
  WaitingForStats: 'post_game',
  PreEndOfGame: 'post_game',
  EndOfGame: 'post_game',
};

const [leagueReport, setLeagueReport] = createSignal<LeagueReport | null>(null);
/** The Riot ID signed in to the League client on this PC (Settings -> Profile offers to link it). */
const [leagueSignedIn, setLeagueSignedIn] = createSignal<string | null>(null);
/** The summoner signed in on this PC (lobby invites through Linkord go by it), while the client runs. */
const [leagueMe, setLeagueMe] = createSignal<{ summoner_id: number; puuid?: string } | null>(null);
/** You're in a lobby and allowed to invite (the leader, or invites open to everyone). */
const [leagueCanInvite, setLeagueCanInvite] = createSignal(false);
export { leagueReport, leagueSignedIn, leagueMe, leagueCanInvite };

/** The client's folder (null: only its file name was readable; the shell then tries the default folder). */
let dir: string | null = null;
let active = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let onChange: () => void = () => {};
let phaseStart: { phase: LeaguePhase; at: number } | null = null;
let last = '';

/** Starts or stops reading the client: `clientPath` = LeagueClientUx.exe's path while it runs, else null. */
export function watchLeague(clientPath: string | null, changed: () => void) {
  onChange = changed;
  if (!clientPath) {
    active = false;
    if (timer) clearTimeout(timer);
    timer = null;
    dir = null;
    phaseStart = null;
    setLeagueMe(null);
    setLeagueCanInvite(false);
    if (leagueReport()) {
      setLeagueReport(null);
      last = '';
      onChange();
    }
    return;
  }
  const slash = Math.max(clientPath.lastIndexOf('\\'), clientPath.lastIndexOf('/'));
  dir = slash > 0 ? clientPath.slice(0, slash) : null;
  if (!active) {
    active = true;
    void poll();
  }
}

async function poll() {
  timer = null;
  let next = POLL_MS;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const status = await invoke<LeagueStatus | null>('league_status', { dir }).catch(() => null);
    const report = status ? toReport(status) : null;
    if (status?.game_name && status.tag_line) setLeagueSignedIn(`${status.game_name}#${status.tag_line}`);
    if (active) {
      setLeagueMe(status?.summoner_id ? { summoner_id: status.summoner_id, puuid: status.puuid ?? undefined } : null);
      setLeagueCanInvite(report?.phase === 'lobby' && !!status?.can_invite);
    }
    if (report?.phase === 'in_game') next = IN_GAME_POLL_MS;
    const key = JSON.stringify(report);
    if (active && key !== last) {
      last = key;
      setLeagueReport(report);
      onChange();
    }
  } finally {
    // Stopped meanwhile (the client closed): don't start again.
    if (active) timer = setTimeout(() => void poll(), next);
  }
}

function toReport(s: LeagueStatus): LeagueReport {
  const phase = PHASES[s.phase] ?? 'client';
  const now = Date.now();
  if (phaseStart?.phase !== phase) phaseStart = { phase, at: now };
  // The queue and the match know how long they've been going (even when Linkord started late); keep the first
  // estimate unless it's off by more than a few seconds, so the report doesn't change on every poll.
  const known =
    phase === 'queue' && s.queue_seconds != null
      ? now - s.queue_seconds * 1000
      : phase === 'in_game' && s.game_time
        ? now - s.game_time * 1000
        : null;
  if (known != null && Math.abs(known - phaseStart.at) > 5000) phaseStart.at = Math.round(known / 1000) * 1000;
  const r: LeagueReport = { phase, since: phase === 'client' ? undefined : phaseStart.at };
  if (phase !== 'client') {
    if (s.queue_id != null) r.queue_id = s.queue_id;
    if (s.queue) r.queue = s.queue;
    if (s.mode) r.mode = s.mode;
  }
  if (s.party_size && s.party_max && (phase === 'lobby' || phase === 'queue' || phase === 'champ_select')) {
    r.party_size = s.party_size;
    r.party_max = s.party_max;
  }
  if (s.champion_id && (phase === 'champ_select' || phase === 'in_game')) r.champion_id = s.champion_id;
  return r;
}

// ---------- names ----------

/** Queues by id (Riot's queues.json), in English for t(); anything else shows the client's own name for it. */
const QUEUES: Record<number, string> = {
  400: msg('Normal Draft'),
  420: msg('Ranked Solo/Duo'),
  430: msg('Normal Blind'),
  440: msg('Ranked Flex'),
  450: msg('ARAM'),
  480: msg('Swiftplay'),
  490: msg('Quickplay'),
  700: msg('Clash'),
  720: msg('ARAM Clash'),
  830: msg('Co-op vs. AI'),
  840: msg('Co-op vs. AI'),
  850: msg('Co-op vs. AI'),
  870: msg('Co-op vs. AI'),
  880: msg('Co-op vs. AI'),
  890: msg('Co-op vs. AI'),
  900: msg('ARURF'),
  1020: msg('One for All'),
  1300: msg('Nexus Blitz'),
  1700: msg('Arena'),
  1710: msg('Arena'),
  1090: msg('Normal'),
  1100: msg('Ranked'),
  1130: msg('Hyper Roll'),
  1160: msg('Double Up'),
};

/** "Ranked Solo/Duo", "ARAM", "Practice Tool"... for a queue id and the client's own name and mode. */
export function queueName(id?: number | null, fallback?: string | null, mode?: string | null): string | undefined {
  if (id != null && QUEUES[id]) return t(QUEUES[id]);
  if (mode === 'PRACTICETOOL') return t('Practice Tool');
  if (fallback) return fallback;
  if (id === -1 || id === 0) return t('Custom Game');
  return undefined;
}

/** "In Lobby", "In Queue"... */
export function phaseName(phase: LeaguePhase): string {
  switch (phase) {
    case 'lobby':
      return t('In Lobby');
    case 'queue':
      return t('In Queue');
    case 'champ_select':
      return t('Champion Select');
    case 'in_game':
      return t('In Game');
    case 'post_game':
      return t('Game Over');
    default:
      return t('In Client');
  }
}

// ---------- ranks ----------

const TIERS: Record<string, string> = {
  IRON: msg('Iron'),
  BRONZE: msg('Bronze'),
  SILVER: msg('Silver'),
  GOLD: msg('Gold'),
  PLATINUM: msg('Platinum'),
  EMERALD: msg('Emerald'),
  DIAMOND: msg('Diamond'),
  MASTER: msg('Master'),
  GRANDMASTER: msg('Grandmaster'),
  CHALLENGER: msg('Challenger'),
};

/** Master and above have no divisions. */
const APEX = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);

/** "Diamond IV", "Challenger". */
export function rankName(tier: string, division?: string): string {
  const name = TIERS[tier] ? t(TIERS[tier]) : tier;
  return APEX.has(tier) || !division ? name : `${name} ${division}`;
}

/** The rank's crest from CommunityDragon. */
export const rankEmblem = (tier: string) =>
  art(
    `${CDRAGON}plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-${tier.toLowerCase()}.png`,
  );

/** The ranked queues the widget shows. */
export const rankedQueueName = (queue: string) =>
  queue === 'RANKED_SOLO_5x5' ? t('Ranked Solo/Duo') : queue === 'RANKED_FLEX_SR' ? t('Ranked Flex') : queue;

// ---------- pictures ----------

const CDRAGON = 'https://raw.communitydragon.org/latest/';

/** CommunityDragon pictures come through the server's copy (server/src/league.rs art: fetched once, kept by the
 *  browser for 30 days), so champion icons draw at once instead of each one waiting on CommunityDragon. */
export function art(url: string): string;
export function art(url?: string | null): string | undefined;
export function art(url?: string | null): string | undefined {
  if (!url) return undefined;
  return url.startsWith(CDRAGON) ? `${serverUrl()}/api/league/art/${url.slice(CDRAGON.length)}` : url;
}

/** The champion's splash art (CommunityDragon, through the server's copy). */
export const splashOf = (id: number) =>
  art(`${CDRAGON}plugins/rcp-be-lol-game-data/global/default/v1/champion-splashes/${id}/${id}000.jpg`);

// ---------- lobby invites through Linkord ----------
// Ask to join from someone's League card, or invite someone from their menu (server/src/league.rs join/invite).
// The League client does the actual inviting: only the host's desktop app, with League open, can.

export interface LeaguePrompt {
  key: string;
  kind: 'join' | 'invite';
  user_id: string;
  /** join: who's asking, to invite them. */
  summoner_id?: number;
  puuid?: string;
  /** invite: the host's lobby when they invited you. */
  league?: LeagueActivity;
  at: number;
}

const [prompts, setPrompts] = createStore<LeaguePrompt[]>([]);
export { prompts as leaguePrompts };

const JOIN_TTL = 60_000;
const INVITE_TTL = 10 * 60_000;

export function dismissLeaguePrompt(key: string) {
  setPrompts((list) => list.filter((p) => p.key !== key));
}

function addPrompt(p: Omit<LeaguePrompt, 'key' | 'at'>) {
  const key = `${p.kind}:${p.user_id}`;
  const at = Date.now();
  setPrompts(
    produce((list) => {
      const i = list.findIndex((x) => x.key === key);
      if (i >= 0) list.splice(i, 1);
      list.push({ ...p, key, at });
    }),
  );
  // Gone after a while (unless a newer one from the same person replaced it).
  setTimeout(
    () => setPrompts((list) => list.filter((x) => x.key !== key || x.at !== at)),
    p.kind === 'join' ? JOIN_TTL : INVITE_TTL,
  );
}

/** Has your League client invite them. */
export async function inviteSummoner(summonerId: number, puuid?: string) {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('league_invite', { dir, summonerId, puuid: puuid ?? null });
}

/** LEAGUE_JOIN_REQUEST: someone asks to join your lobby (already approved when you invited them). */
export function onLeagueJoinRequest(d: {
  user_id: string;
  summoner_id: number;
  puuid?: string | null;
  auto?: boolean;
}) {
  // Only the app with League open can invite.
  if (!isTauri || !leagueReport()) return;
  if (d.auto) {
    inviteSummoner(d.summoner_id, d.puuid ?? undefined).then(
      () => toast(t('Invited {name} to your lobby', { name: nameOf(d.user_id) })),
      (e) => toast(String(e)),
    );
    return;
  }
  addPrompt({ kind: 'join', user_id: d.user_id, summoner_id: d.summoner_id, puuid: d.puuid ?? undefined });
}

/** LEAGUE_INVITE: someone invites you to their lobby. */
export function onLeagueInvite(d: { user_id: string; league?: LeagueActivity }) {
  // Joining needs League open on this PC: the browser can't.
  if (!isTauri) return;
  addPrompt({ kind: 'invite', user_id: d.user_id, league: d.league });
}

/** Asks them to invite you; true when it went out. `messageId`: from their invite message in a chat (no need for
 *  them to approve it). */
export async function askToJoin(userId: string, messageId?: string): Promise<boolean> {
  const me = leagueMe();
  if (!me) {
    toast(t('Open League of Legends to join'));
    return false;
  }
  try {
    await api('POST', '/league/join', {
      user_id: userId,
      summoner_id: me.summoner_id,
      puuid: me.puuid,
      message_id: messageId,
    });
    return true;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Invites them to your lobby through Linkord (they accept in Linkord, then your League client invites them). */
export async function inviteToLobby(userId: string, name: string) {
  try {
    await api('POST', '/league/invite', { user_id: userId });
    toast(t('Invite sent to {name}', { name }));
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

/** Posts "join my lobby" in a chat (the composer's League button). */
export async function inviteChat(channelId: string) {
  try {
    await api('POST', '/league/invite/chat', { channel_id: channelId });
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}
