// Spellcheck for the message box: on/off and the language are per device (prefs), with a personal dictionary.
// The webview's own spellchecker can't change language from the page and its suggestions live in the native
// right-click menu we replace, so Pottira checks words itself (lib/spell-worker.ts) and draws the underline.
import { createSignal } from 'solid-js';
import { serverUrl } from './api';
import { lang } from './i18n';
import { prefs, setPrefs } from './prefs';
import type { SpellIn, SpellOut } from './spell-worker';

export const SPELL_LANGUAGES = {
  en: { name: 'English' },
  pt: { name: 'Português' },
  es: { name: 'Español' },
} as const;
export type SpellLanguage = keyof typeof SPELL_LANGUAGES;

/** The language actually checked: the chosen one, or the app's language. */
export const spellLanguage = (): SpellLanguage =>
  prefs.spellLanguage !== 'auto' ? prefs.spellLanguage : lang().startsWith('pt') ? 'pt' : 'en';

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, (m: SpellOut) => void>();
/** Bumped when a dictionary finishes loading, so the message box checks again. */
const [loadedVersion, setLoadedVersion] = createSignal(0);
export { loadedVersion };
const loaded = new Set<string>();

function send(m: SpellIn) {
  if (!worker) {
    worker = new Worker(new URL('./spell-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<SpellOut>) => {
      const m = e.data;
      if (m.type === 'loaded') {
        if (m.ok) loaded.add(m.lang);
        setLoadedVersion((n) => n + 1);
      } else waiting.get(m.id)?.(m);
    };
    worker.postMessage({ type: 'personal', words: [...prefs.spellWords] } satisfies SpellIn);
  }
  worker.postMessage(m);
}

function ensure(l: SpellLanguage) {
  if (loaded.has(l)) return;
  // Served by the server (the web build's /dictionaries; the desktop app doesn't carry them).
  const base = `${serverUrl()}/dictionaries/${l}`;
  send({ type: 'load', lang: l, aff: `${base}.aff`, dic: `${base}.dic` });
}

type Question = { type: 'check'; lang: string; words: string[] } | { type: 'suggest'; lang: string; word: string };

function ask<T extends SpellOut>(m: Question): Promise<T> {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, (out) => {
      waiting.delete(id);
      resolve(out as T);
    });
    send({ ...m, id } as SpellIn);
  });
}

/** Words to check in a message: letters only, skipping links, mentions, :emoji:, code and short words. */
export function wordsIn(text: string): { word: string; start: number; end: number }[] {
  const skip: [number, number][] = [];
  for (const m of text.matchAll(/```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+|<[^>\s]+>|[@#][\p{L}\p{N}_.]+|:[\w+-]+:/gu))
    skip.push([m.index!, m.index! + m[0].length]);
  const out: { word: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(/[\p{L}][\p{L}'’]*[\p{L}]|[\p{L}]/gu)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (m[0].length < 2 || skip.some(([a, b]) => start < b && end > a)) continue;
    // Words glued to digits or underscores (codes, usernames) aren't prose.
    if (/[\p{N}_]/u.test(text[start - 1] ?? '') || /[\p{N}_]/u.test(text[end] ?? '')) continue;
    out.push({ word: m[0].replace(/’/g, "'"), start, end });
  }
  return out;
}

const cache = new Map<string, boolean>();

/** Misspelled words in `text` (their positions), [] while the dictionary loads or when spellcheck is off. */
export async function misspelled(text: string) {
  if (!prefs.spellcheck) return [];
  const l = spellLanguage();
  ensure(l);
  if (!loaded.has(l)) return [];
  const words = wordsIn(text);
  const unknown = [...new Set(words.map((w) => w.word))].filter((w) => !cache.has(`${l}:${w}`));
  if (unknown.length) {
    const { wrong } = await ask<Extract<SpellOut, { type: 'checked' }>>({ type: 'check', lang: l, words: unknown });
    for (const w of unknown) cache.set(`${l}:${w}`, wrong.includes(w));
  }
  return words.filter((w) => cache.get(`${l}:${w.word}`) && !prefs.spellWords.includes(w.word));
}

export async function suggestions(word: string): Promise<string[]> {
  const l = spellLanguage();
  if (!loaded.has(l)) return [];
  return (await ask<Extract<SpellOut, { type: 'suggested' }>>({ type: 'suggest', lang: l, word })).list;
}

/** Remembers a word as correct (on this device, every language). */
export function addToDictionary(word: string) {
  if (prefs.spellWords.includes(word)) return;
  setPrefs({ spellWords: [...prefs.spellWords, word] });
  send({ type: 'personal', words: [...prefs.spellWords] });
  for (const k of cache.keys()) if (k.endsWith(`:${word}`)) cache.delete(k);
  setLoadedVersion((n) => n + 1);
}

export function clearDictionary() {
  setPrefs({ spellWords: [] });
  cache.clear();
  worker?.terminate();
  worker = null;
  loaded.clear();
  setLoadedVersion((n) => n + 1);
}
