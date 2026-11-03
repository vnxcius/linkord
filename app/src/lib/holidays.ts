// The countdowns to Christmas and New Year (midnight in your own timezone) and what happens when one reaches zero. The clock
// only ticks while the Christmas theme and its countdown are on: every second on the last day, otherwise twice a minute.
import { createEffect, createRoot, createSignal, onCleanup } from 'solid-js';
import { fireworks } from './fireworks';
import { t } from './i18n';
import { prefs } from './prefs';
import { isChristmas } from './theme';

export type Holiday = 'christmas' | 'new-year';

const DAY_MS = 86_400_000;

/** The season the Christmas greeting belongs to ('2026' from November 2026 to January 6, 2027), or null outside it. */
export function christmasSeason(now: Date): string | null {
  const month = now.getMonth();
  if (month >= 10) return String(now.getFullYear());
  if (month === 0 && now.getDate() <= 6) return String(now.getFullYear() - 1);
  return null;
}

/** The next midnight that starts this holiday, or `now` itself if it hasn't passed. */
export function nextDate(holiday: Holiday, now: Date): Date {
  const [month, day] = holiday === 'christmas' ? [11, 25] : [0, 1];
  const date = new Date(now.getFullYear(), month, day);
  return date.getTime() > now.getTime() ? date : new Date(now.getFullYear() + 1, month, day);
}

/** "51d 5h", or "05:12:33" on the last day. */
export function formatLeft(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  if (ms < DAY_MS)
    return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
  return t('{d}d {h}h', { d: Math.floor(seconds / 86400), h: Math.floor(seconds / 3600) % 24 });
}

const [now, setNow] = createSignal(new Date());
const on = () => isChristmas() && prefs.christmasCountdown;

/** Time left for both, soonest first, for the strip under the header. */
export const countdown = () => {
  if (!on()) return null;
  const left = (['christmas', 'new-year'] as const).map((holiday) => ({
    holiday,
    ms: nextDate(holiday, now()).getTime() - now().getTime(),
  }));
  return left
    .sort((x, y) => x.ms - y.ms)
    .map((x) => ({ holiday: x.holiday, left: formatLeft(x.ms), soon: x.ms < DAY_MS }));
};

export function celebrate(holiday: Holiday) {
  fireworks(
    holiday === 'christmas' ? t('Merry Christmas!') : t('Happy New Year!'),
    holiday === 'new-year' ? String(new Date(Date.now() + DAY_MS).getFullYear()) : undefined,
  );
}

/** The one coming up, for "Preview fireworks". */
export const nextHoliday = (): Holiday =>
  nextDate('christmas', new Date()) < nextDate('new-year', new Date()) ? 'christmas' : 'new-year';

export function initHolidays() {
  createRoot(() =>
    createEffect(() => {
      if (!on()) return;
      setNow(new Date());
      let upcoming = { christmas: nextDate('christmas', now()), 'new-year': nextDate('new-year', now()) };
      let due: { holiday: Holiday; until: number } | null = null;
      let timer: ReturnType<typeof setTimeout>;
      const focused = () => document.visibilityState === 'visible' && document.hasFocus();
      const tick = () => {
        const current = new Date();
        setNow(current);
        for (const holiday of ['christmas', 'new-year'] as const) {
          if (current >= upcoming[holiday]) {
            due = { holiday, until: upcoming[holiday].getTime() + DAY_MS };
            upcoming = { ...upcoming, [holiday]: nextDate(holiday, current) };
          }
        }
        // Midnight passed in another window or a game: it waits until you come back, that same day.
        if (due && current.getTime() >= due.until) due = null;
        else if (due && focused()) {
          celebrate(due.holiday);
          due = null;
        }
        const soonest = Math.min(upcoming.christmas.getTime(), upcoming['new-year'].getTime()) - current.getTime();
        timer = setTimeout(tick, soonest < DAY_MS || due ? 1000 : 30_000);
      };
      timer = setTimeout(tick, 1000);
      onCleanup(() => clearTimeout(timer));
    }),
  );
}
