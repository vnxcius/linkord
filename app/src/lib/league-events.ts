// REC + League of Legends: which of the match's events (Live Client Data, src-tauri/src/league.rs league_events) are
// yours and what they mean for the recording: a tick on the VOD timeline, maybe a clip. Pure, so it's unit-tested
// (tests/league-events.test.mjs); lib/rec-league.ts does the polling and saving.

/** One event as Riot sends it (only the fields we read). */
export interface RiotEvent {
  EventID: number;
  EventName: string;
  /** Seconds into the match. */
  EventTime: number;
  KillerName?: string;
  VictimName?: string;
  KillStreak?: number;
  Acer?: string;
  Stolen?: string | boolean;
}

/** Which setting decides whether it saves a clip by itself (prefs.rec.league). */
export type AutoKind = 'multikill' | 'ace' | 'steal' | 'kill' | 'death';

export interface Moment {
  /** The timeline tick's kind: kill, death, multikill, ace, objective, steal. */
  kind: 'kill' | 'death' | 'multikill' | 'ace' | 'objective' | 'steal';
  /** What it was: the other player for kills/deaths, the objective, or the multikill's size (2-5). */
  other?: string;
  objective?: 'dragon' | 'baron' | 'herald' | 'grubs' | 'atakhan';
  streak?: number;
  auto: AutoKind | null;
  /** How notable it is: the clip saved for several moments close together is named after the best one. */
  rank: number;
}

const OBJECTIVES: Record<string, Moment['objective']> = {
  DragonKill: 'dragon',
  BaronKill: 'baron',
  HeraldKill: 'herald',
  HordeKill: 'grubs',
  AtakhanKill: 'atakhan',
};

/** Events name players by Riot ID ("Name#TAG") or only its name, depending on the game version. */
export function samePlayer(a: string | undefined, me: string): boolean {
  if (!a || !me) return false;
  const norm = (s: string) => s.trim().toLowerCase();
  const [x, y] = [norm(a), norm(me)];
  return x === y || x === y.split('#')[0] || x.split('#')[0] === y;
}

/** The event as a moment of yours, or null when it isn't about you (or isn't worth a tick). */
export function momentOf(e: RiotEvent, me: string): Moment | null {
  switch (e.EventName) {
    case 'ChampionKill':
      if (samePlayer(e.KillerName, me)) return { kind: 'kill', other: e.VictimName, auto: 'kill', rank: 1 };
      if (samePlayer(e.VictimName, me)) return { kind: 'death', other: e.KillerName, auto: 'death', rank: 0 };
      return null;
    case 'Multikill': {
      const streak = Math.min(5, Math.max(2, Number(e.KillStreak) || 2));
      return samePlayer(e.KillerName, me) ? { kind: 'multikill', streak, auto: 'multikill', rank: 3 + streak } : null;
    }
    case 'Ace':
      return samePlayer(e.Acer, me) ? { kind: 'ace', auto: 'ace', rank: 3 } : null;
    default: {
      const objective = OBJECTIVES[e.EventName];
      if (!objective || !samePlayer(e.KillerName, me)) return null;
      const stolen = e.Stolen === true || String(e.Stolen).toLowerCase() === 'true';
      return stolen
        ? { kind: 'steal', objective, auto: 'steal', rank: 2 }
        : { kind: 'objective', objective, auto: null, rank: 1 };
    }
  }
}

/** Seconds a moment's clip keeps going after it. */
export const AFTER_SECONDS = 5;

/**
 * Moments close together make one clip: it ends AFTER_SECONDS after the last one and starts `clipSeconds` before the
 * first one's end (the clip length setting is the pre-roll), so a kill then a double kill a few seconds later isn't
 * two clips with the same fight. `at` = wall-clock ms of each moment.
 */
export function clipSpan(ats: number[], clipSeconds: number): { end: number; seconds: number } {
  const first = Math.min(...ats);
  const end = Math.max(...ats) + AFTER_SECONDS * 1000;
  const seconds = Math.min(300, Math.round(clipSeconds + (end - (first + AFTER_SECONDS * 1000)) / 1000));
  return { end, seconds };
}
