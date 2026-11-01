// Birthdays on profiles: stored as 'MM-DD' or 'YYYY-MM-DD' (users.birthday). On the day (the viewer's own date) the
// person gets a small cake next to their name, and opening their full profile throws confetti.
import { Show } from 'solid-js';
import { dateLocale, t } from '../lib/i18n';
import { state } from '../lib/store';

export interface Birthday {
  month: number;
  day: number;
  year?: number;
}

export function parseBirthday(b?: string | null): Birthday | null {
  const m = b?.match(/^(?:(\d{4})-)?(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: m[1] ? +m[1] : undefined, month: +m[2], day: +m[3] };
}

export function isBirthdayToday(b?: string | null, now = new Date()): boolean {
  const d = parseBirthday(b);
  if (!d) return false;
  const leap = new Date(now.getFullYear(), 1, 29).getMonth() === 1;
  // 29 February is celebrated on the 28th in other years.
  const day = d.month === 2 && d.day === 29 && !leap ? 28 : d.day;
  return now.getMonth() + 1 === d.month && now.getDate() === day;
}

/** "14 March" / "March 14, 1999", in the app's language. */
export function formatBirthday(b?: string | null): string {
  const d = parseBirthday(b);
  if (!d) return '';
  const date = new Date(d.year ?? 2000, d.month - 1, d.day);
  return date.toLocaleDateString(dateLocale(), {
    month: 'long',
    day: 'numeric',
    ...(d.year ? { year: 'numeric' } : {}),
  });
}

/** 🎂 next to someone's name on their birthday. */
export function BirthdayCake(p: { userId: string }) {
  return (
    <Show when={isBirthdayToday(state.users[p.userId]?.birthday)}>
      <span class="birthday-cake" data-tip={t("It's their birthday today!")} aria-label={t('Birthday today')}>
        🎂
      </span>
    </Show>
  );
}
