// UI translations. The English text is the key: t('Log Out') looks it up in the active language's
// dictionary and falls back to English. `{name}` placeholders are filled from `vars`.
// tests/i18n.test.mjs checks that every t()/msg() string has a translation.
import { msg } from './msg';
import { prefs } from './prefs';
import ptBR from './locales/pt-BR';

export { msg };

export type Lang = 'en' | 'pt-BR';
export type LangPref = 'system' | Lang;

export const LANGUAGES: { id: Lang; name: string; english: string }[] = [
  { id: 'en', name: 'English', english: msg('English') },
  { id: 'pt-BR', name: 'Português (Brasil)', english: msg('Portuguese (Brazil)') },
];

const DICTS: Record<Lang, Record<string, string> | null> = { en: null, 'pt-BR': ptBR };

/** The operating system's language (WebView2 reports the Windows display language), if we have it. */
export function systemLang(): Lang {
  const list = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of list) {
    if (/^pt\b/i.test(l)) return 'pt-BR';
    if (/^en\b/i.test(l)) return 'en';
  }
  return 'en';
}

export const lang = (): Lang => (prefs.language === 'system' || !DICTS.hasOwnProperty(prefs.language) ? systemLang() : prefs.language);

/** Locale for dates and numbers: the system's own (e.g. en-GB) when it speaks the UI language. */
export const dateLocale = (): string | undefined => (lang() === systemLang() ? undefined : lang());

export function t(text: string, vars?: Record<string, string | number>): string {
  const s = DICTS[lang()]?.[text] ?? text;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** t() with the singular or plural form; `{n}` is the count. */
export const plural = (n: number, one: string, other: string, vars?: Record<string, string | number>) => t(n === 1 ? one : other, { n, ...vars });

/** "A, B and C" in the UI language. */
export const joinList = (items: string[]) => new Intl.ListFormat(lang(), { type: 'conjunction' }).format(items);

// Server errors arrive in English; the ones with numbers or names in them are matched by pattern.
const SERVER_PATTERNS: [RegExp, string][] = [
  [/^channels can have up to (\d+) pins$/, msg('channels can have up to {0} pins')],
  [/^delete the servers you own first: (.+)$/, msg('delete the servers you own first: {0}')],
  [/^file exceeds (\d+) MB$/, msg('file exceeds {0} MB')],
  [/^group DMs can have up to (\d+) people$/, msg('group DMs can have up to {0} people')],
  [/^message must be at most (\d+) characters$/, msg('message must be at most {0} characters')],
  [/^servers can have up to (\d+) emoji$/, msg('servers can have up to {0} emoji')],
  [/^unknown setting (.+)$/, msg('unknown setting {0}')],
  [/^you can forward to up to (\d+) places at once$/, msg('you can forward to up to {0} places at once')],
];

export function serverError(text: string): string {
  const dict = DICTS[lang()];
  if (!dict) return text;
  if (dict[text]) return dict[text];
  for (const [re, key] of SERVER_PATTERNS) {
    const m = text.match(re);
    if (m) return t(key, Object.fromEntries(m.slice(1).map((v, i) => [i, v])));
  }
  return text;
}
