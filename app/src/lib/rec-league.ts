// REC + League of Legends (Windows app): while a League match is being recorded, the match's events (Live Client Data,
// every 2 s, only then) put your kills, deaths, multikills, aces and objectives on the VOD's timeline, and, if you turned
// them on (REC -> League), save a clip by themselves 5 s after the moment. A pentakill caught this way is claimed for the
// badge once the match is over; the server checks it against Riot's match (server/src/league.rs pentakill).
import { createEffect, createRoot, on } from 'solid-js';
import { api } from './api';
import { msg, t } from './i18n';
import { leagueGameId } from './league';
import { clipSpan, momentOf, type Moment, type RiotEvent } from './league-events';
import { prefs } from './prefs';
import { recCall, recStatus } from './rec';

const POLL_MS = 2000;
const CLAIMS_KEY = 'pottira.pentakills';

interface Events {
  active: string;
  game_time: number;
  events: RiotEvent[];
}

const MULTI = ['', '', msg('Double kill'), msg('Triple kill'), msg('Quadra kill'), msg('Pentakill')];
const OBJECTIVE: Record<NonNullable<Moment['objective']>, string> = {
  dragon: msg('Dragon'),
  baron: msg('Baron Nashor'),
  herald: msg('Rift Herald'),
  grubs: msg('Voidgrubs'),
  atakhan: msg('Atakhan'),
};

/** The tick's label (and an auto-clip's title), in the app's language when it happened. */
function labelOf(m: Moment): string {
  switch (m.kind) {
    case 'kill':
      return m.other ? t('Killed {name}', { name: m.other }) : t('Kill');
    case 'death':
      return m.other ? t('Killed by {name}', { name: m.other }) : t('Death');
    case 'multikill':
      return t(MULTI[m.streak ?? 2]);
    case 'ace':
      return t('Ace');
    case 'steal':
      return t('Stole {objective}', { objective: t(OBJECTIVE[m.objective!]) });
    case 'objective':
      return t(OBJECTIVE[m.objective!]);
  }
}

// ---------- the pentakill claim ----------

function claims(): number[] {
  try {
    return (JSON.parse(localStorage.getItem(CLAIMS_KEY) ?? '[]') as number[]).filter(Number.isFinite);
  } catch {
    return [];
  }
}
function saveClaims(ids: number[]) {
  try {
    localStorage.setItem(CLAIMS_KEY, JSON.stringify(ids.slice(-10)));
  } catch {}
}

/** Asks the server about every match still waiting; Riot's match exists only a little after it ended. */
async function sendClaims() {
  for (const game_id of claims()) {
    const answer = await api<{ status: string }>('POST', '/league/pentakill', { game_id }).catch(
      (e: { status?: number }) => (e?.status === 400 ? { status: 'refused' } : null),
    );
    if (answer && answer.status !== 'pending') saveClaims(claims().filter((id) => id !== game_id));
  }
}

// ---------- following the match ----------

let after = -1;
let match: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** The auto-clip being waited for: moments within its span join it. */
let pending: { ats: number[]; best: Moment; timer: ReturnType<typeof setTimeout> } | null = null;

function saveClip() {
  const p = pending;
  pending = null;
  if (!p || !recStatus().recording) return;
  const { seconds } = clipSpan(p.ats, prefs.rec.clipSeconds);
  void recCall<string>('rec_clip', { seconds, title: labelOf(p.best) })
    .then(() => {
      if (prefs.rec.sounds) void import('./sounds').then((s) => s.sounds.recSaved());
    })
    .catch(() => {});
}

function wantsClip(m: Moment) {
  const l = prefs.rec.league;
  return l.auto && m.auto !== null && l[m.auto];
}

function onMoment(m: Moment, at: number) {
  const ago = Math.max(0, Date.now() - at);
  void recCall('rec_event', { kind: m.kind, label: labelOf(m), agoMs: ago }).catch(() => {});
  if (m.kind === 'multikill' && m.streak === 5 && match) saveClaims([...claims().filter((id) => id !== match), match]);
  if (!wantsClip(m)) return;
  const ats = pending ? [...pending.ats, at] : [at];
  const best = pending && pending.best.rank >= m.rank ? pending.best : m;
  if (pending) clearTimeout(pending.timer);
  const { end } = clipSpan(ats, prefs.rec.clipSeconds);
  pending = { ats, best, timer: setTimeout(saveClip, Math.max(0, end - Date.now())) };
}

async function poll() {
  timer = null;
  try {
    const data = await recCall<Events | null>('league_events', { after });
    const since = recStatus().since ?? Date.now();
    for (const e of data?.events ?? []) {
      after = Math.max(after, e.EventID);
      const at = Date.now() - Math.max(0, data!.game_time - e.EventTime) * 1000;
      // Only what the recording holds (a recording started mid-match gets the earlier events once, skipped).
      if (at < since) continue;
      const m = momentOf(e, data!.active);
      if (m) onMoment(m, at);
    }
  } catch {}
  if (match) timer = setTimeout(() => void poll(), POLL_MS);
}

function follow(game: number | null) {
  if (game === match) return;
  if (timer) clearTimeout(timer);
  timer = null;
  const ended = match;
  match = game;
  after = -1;
  if (game) void poll();
  // The match ended: its clip still saves (the recording keeps going a bit); claims go out now and again later.
  if (ended) setTimeout(() => void sendClaims(), 60_000);
}

export function initRecLeague() {
  createRoot(() => {
    // A League match, recorded by REC.
    createEffect(on([leagueGameId, () => recStatus().recording], ([game, rec]) => follow(rec ? game : null)));
  });
  void sendClaims();
  setInterval(() => void sendClaims(), 10 * 60_000);
}
