// Profile badges (owner, 2026-11-12): server/src/badges.rs awards and stores them; this names, labels and draws them,
// keeps other people's lists for a few minutes and your own (with progress) live from BADGES_UPDATE.
// Art: assets/badges (app/scripts/badge-art.mjs): milestones are <id>-<tier>.svg, single badges <id>.svg.
import { createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { api } from './api';
import { dateLocale, msg, plural, t } from './i18n';
import { state } from './store';

export interface Badge {
  id: string;
  tier: number;
  earned_at?: string;
  /** Only in your own list. */
  hidden?: boolean;
}

export interface Progress {
  id: string;
  /** Tier reached (null = none yet). */
  tier: number | null;
  value: number;
  /** The next tier and its threshold (null = Diamond reached). */
  next: number | null;
  target: number | null;
}

export interface MyBadges {
  badges: Badge[];
  progress: Progress[];
}

const ART = import.meta.glob<string>('../assets/badges/*.svg', { eager: true, query: '?url', import: 'default' });
const art = (name: string) => ART[`../assets/badges/${name}.svg`] ?? '';

const TIER_IDS = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
export const TIER_NAMES = [msg('Bronze'), msg('Silver'), msg('Gold'), msg('Platinum'), msg('Diamond')];

const HOUR = 3600;
const num = (n: number) => n.toLocaleString(dateLocale());

type Unit = 'days' | 'seconds' | 'count';

interface Ladder {
  name: string;
  unit: Unit;
  /** Same thresholds as badges.rs LADDERS (days, seconds or a count). */
  thresholds: number[];
  /** "500 hours in calls", from hours / a count (days are handled by `age`). */
  amount: (n: number) => string;
}

const age = (days: number) =>
  days >= 365
    ? plural(Math.floor(days / 365), '{n} year on Linkord', '{n} years on Linkord', { n: num(Math.floor(days / 365)) })
    : plural(Math.max(1, Math.floor(days / 30)), '{n} month on Linkord', '{n} months on Linkord', {
        n: num(Math.max(1, Math.floor(days / 30))),
      });

const hours = (h: number[]) => h.map((x) => x * HOUR);

const LADDERS: Record<string, Ladder> = {
  member: { name: msg('Member since'), unit: 'days', thresholds: [30, 90, 180, 365, 730], amount: age },
  calls: {
    name: msg('In calls'),
    unit: 'seconds',
    thresholds: hours([10, 50, 100, 500, 1000]),
    amount: (n) => plural(n, '{n} hour in calls', '{n} hours in calls', { n: num(n) }),
  },
  played: {
    name: msg('Time played'),
    unit: 'seconds',
    thresholds: hours([10, 50, 100, 500, 1000]),
    amount: (n) => plural(n, '{n} hour played', '{n} hours played', { n: num(n) }),
  },
  games: {
    name: msg('Game library'),
    unit: 'count',
    thresholds: [5, 10, 25, 50, 100],
    amount: (n) => plural(n, '{n} game played', '{n} games played', { n: num(n) }),
  },
  live: {
    name: msg('On air'),
    unit: 'seconds',
    thresholds: hours([1, 10, 50, 100, 250]),
    amount: (n) => plural(n, '{n} hour streaming', '{n} hours streaming', { n: num(n) }),
  },
  watch: {
    name: msg('Watch party'),
    unit: 'seconds',
    thresholds: hours([1, 10, 25, 50, 100]),
    amount: (n) => plural(n, '{n} hour watching together', '{n} hours watching together', { n: num(n) }),
  },
  sounds: {
    name: msg('Soundboard'),
    unit: 'count',
    thresholds: [10, 100, 500, 1000, 5000],
    amount: (n) => plural(n, '{n} sound played', '{n} sounds played', { n: num(n) }),
  },
  snowball: {
    name: msg('Snowball fighter'),
    unit: 'count',
    thresholds: [1, 10, 50, 100, 500],
    amount: (n) => plural(n, '{n} snowball thrown', '{n} snowballs thrown', { n: num(n) }),
  },
};

const SINGLES: Record<string, { name: string; about: string }> = {
  admin: { name: msg('Linkord Admin'), about: msg('Runs this Linkord') },
  early: { name: msg('Early Member'), about: msg('Here before Linkord 1.0') },
  owner: { name: msg('Server Owner'), about: msg('Created a server') },
  bug_hunter: { name: msg('Bug Hunter'), about: msg('Found and reported a bug') },
  tester: { name: msg('Tester'), about: msg('Tried new builds before release') },
  contributor: { name: msg('Contributor'), about: msg('Helped build Linkord') },
  helper: { name: msg('Helper'), about: msg('Helped others in the community') },
};

/** A milestone's number in words ("612 hours in calls"), from the raw value the server counts. */
function amountOf(l: Ladder, value: number) {
  return l.unit === 'days' ? age(value) : l.amount(l.unit === 'seconds' ? Math.floor(value / HOUR) : value);
}

export interface BadgeInfo {
  name: string;
  art: string;
  /** Milestones: the tier (0-4), its name and what it took ("500 hours in calls"). */
  tier?: number;
  tierName?: string;
  amount?: string;
  /** Single badges: what it's for. */
  about?: string;
}

/** Names and art for a badge; null for ones this version doesn't know (a newer server's). */
export function describe(b: { id: string; tier: number }): BadgeInfo | null {
  const l = LADDERS[b.id];
  if (l) {
    const tier = Math.max(0, Math.min(4, b.tier));
    return {
      name: t(l.name),
      art: art(`${b.id}-${TIER_IDS[tier]}`),
      tier,
      tierName: t(TIER_NAMES[tier]!),
      amount: amountOf(l, l.thresholds[tier]!),
    };
  }
  const year = /^christmas_(\d{4})$/.exec(b.id)?.[1];
  if (year)
    return {
      name: t('Christmas {year}', { year }),
      art: art('christmas'),
      about: t('Here for Christmas {year}', { year }),
    };
  const s = SINGLES[b.id];
  return s ? { name: t(s.name), art: art(b.id), about: t(s.about) } : null;
}

/** The art of a milestone's tier (for "next tier" previews). */
export const tierArt = (id: string, tier: number) => art(`${id}-${TIER_IDS[tier]}`);

/** "612 / 1,000 h" toward the next tier. */
export function progressText(p: Progress) {
  const l = LADDERS[p.id];
  if (!l || p.target == null) return '';
  if (l.unit === 'seconds')
    return t('{a} / {b} h', { a: num(Math.floor(p.value / HOUR)), b: num(Math.round(p.target / HOUR)) });
  if (l.unit === 'days')
    return t('{a} / {b} months', { a: num(Math.floor(p.value / 30)), b: num(Math.round(p.target / 30)) });
  return `${num(p.value)} / ${num(p.target)}`;
}

/** What you have now in words ("612 hours in calls"). */
export function currentAmount(p: Progress) {
  const l = LADDERS[p.id];
  return l ? amountOf(l, p.value) : '';
}

export const ladderName = (id: string) => (LADDERS[id] ? t(LADDERS[id].name) : id);

export const earnedDate = (at?: string) =>
  at ? new Date(at).toLocaleDateString(dateLocale(), { year: 'numeric', month: 'short', day: 'numeric' }) : '';

// ---------- your own ----------

const [mine, setMine] = createSignal<MyBadges | null>(null);
export { mine as myBadges };
let loadingMine: Promise<void> | null = null;

export function loadMyBadges() {
  loadingMine ??= api<MyBadges>('GET', '/users/@me/badges')
    .then((d) => void setMine(d))
    .catch(() => undefined)
    .finally(() => (loadingMine = null));
  return loadingMine;
}

/** Settings -> Badges: order (every badge, as shown) and which are hidden. */
export async function arrangeBadges(order: string[], hidden: string[]) {
  const before = mine();
  if (before) {
    const by = new Map(before.badges.map((b) => [b.id, b]));
    setMine({
      ...before,
      badges: order.flatMap((id) => (by.has(id) ? [{ ...by.get(id)!, hidden: hidden.includes(id) }] : [])),
    });
  }
  try {
    setMine(await api<MyBadges>('PUT', '/users/@me/badges', { order, hidden }));
  } catch (e) {
    if (before) setMine(before);
    throw e;
  }
}

// ---------- everyone's ----------

const FRESH_MS = 5 * 60_000;
const [cache, setCache] = createStore<Record<string, { at: number; list: Badge[] }>>({});
const fetching = new Set<string>();

/** Someone's shown badges (fetched when missing or a few minutes old); undefined until known. */
export function badgesOf(userId: string): Badge[] | undefined {
  if (userId === state.me?.id && mine()) return mine()!.badges.filter((b) => !b.hidden && describe(b));
  const c = cache[userId];
  if ((!c || Date.now() - c.at > FRESH_MS) && !fetching.has(userId)) {
    fetching.add(userId);
    api<Badge[]>('GET', `/users/${userId}/badges`)
      .then((list) => rememberBadges(userId, list))
      .catch(() => undefined)
      .finally(() => fetching.delete(userId));
  }
  return c?.list.filter((b) => describe(b));
}

/** A list that came with something else (the full profile). */
export const rememberBadges = (userId: string, list: Badge[]) => setCache(userId, { at: Date.now(), list });

// ---------- gateway ----------

/** Badges just earned, for the "New badge" card (App.tsx BadgeEarnedHost). */
const [earned, setEarned] = createSignal<Badge[]>([]);
export { earned as newBadges };
export const dismissNewBadges = () => setEarned([]);

export function onBadgeEarned(list: Badge[]) {
  const known = list.filter((b) => describe(b));
  if (known.length) setEarned((e) => [...known, ...e].slice(0, 20));
}

export function onBadgesUpdate(d: MyBadges) {
  setMine(d);
  if (state.me)
    rememberBadges(
      state.me.id,
      d.badges.filter((b) => !b.hidden),
    );
}
