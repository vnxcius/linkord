// Spellchecking off the main thread: real Hunspell (WebAssembly, hunspell-asm) with the Hunspell dictionaries,
// loaded once per language on demand. nspell (pure JS) never finished loading the Portuguese dictionary; Hunspell
// loads it in a fraction of a second.
import { loadModule, type Hunspell, type HunspellFactory } from 'hunspell-asm';

export type SpellIn =
  | { type: 'load'; lang: string; aff: string; dic: string }
  | { type: 'check'; id: number; lang: string; words: string[] }
  | { type: 'suggest'; id: number; lang: string; word: string }
  | { type: 'personal'; words: string[] };

export type SpellOut =
  | { type: 'loaded'; lang: string; ok: boolean }
  | { type: 'checked'; id: number; wrong: string[] }
  | { type: 'suggested'; id: number; list: string[] };

let factory: Promise<HunspellFactory> | null = null;
const spellers = new Map<string, Promise<Hunspell | null>>();
let personal: string[] = [];

const post = (m: SpellOut) => postMessage(m);
const bytes = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.arrayBuffer();
  });

async function open(lang: string, affUrl: string, dicUrl: string): Promise<Hunspell | null> {
  try {
    factory ??= loadModule();
    const [f, aff, dic] = await Promise.all([factory, bytes(affUrl), bytes(dicUrl)]);
    const h = f.create(
      f.mountBuffer(new Uint8Array(aff), `${lang}.aff`),
      f.mountBuffer(new Uint8Array(dic), `${lang}.dic`),
    );
    for (const w of personal) h.addWord(w);
    return h;
  } catch (e) {
    console.warn('spellcheck', lang, e);
    return null;
  }
}

self.onmessage = async (e: MessageEvent<SpellIn>) => {
  const m = e.data;
  if (m.type === 'load') {
    if (!spellers.has(m.lang)) spellers.set(m.lang, open(m.lang, m.aff, m.dic));
    post({ type: 'loaded', lang: m.lang, ok: !!(await spellers.get(m.lang)) });
  } else if (m.type === 'personal') {
    const added = m.words.filter((w) => !personal.includes(w));
    const removed = personal.filter((w) => !m.words.includes(w));
    personal = m.words;
    for (const s of spellers.values())
      void s.then((h) => {
        added.forEach((w) => h?.addWord(w));
        removed.forEach((w) => h?.removeWord(w));
      });
  } else if (m.type === 'check') {
    const s = await spellers.get(m.lang);
    post({ type: 'checked', id: m.id, wrong: s ? m.words.filter((w) => !s.spell(w)) : [] });
  } else if (m.type === 'suggest') {
    const s = await spellers.get(m.lang);
    post({ type: 'suggested', id: m.id, list: s ? s.suggest(m.word).slice(0, 5) : [] });
  }
};
