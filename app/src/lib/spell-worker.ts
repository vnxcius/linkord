// Spellchecking off the main thread: Hunspell dictionaries (nspell), loaded once per language on demand.
import nspell from 'nspell';

export type SpellIn =
  | { type: 'load'; lang: string; aff: string; dic: string }
  | { type: 'check'; id: number; lang: string; words: string[] }
  | { type: 'suggest'; id: number; lang: string; word: string }
  | { type: 'personal'; words: string[] };

export type SpellOut =
  | { type: 'loaded'; lang: string; ok: boolean }
  | { type: 'checked'; id: number; wrong: string[] }
  | { type: 'suggested'; id: number; list: string[] };

const spellers = new Map<string, Promise<ReturnType<typeof nspell> | null>>();
let personal: string[] = [];

const post = (m: SpellOut) => postMessage(m);

self.onmessage = async (e: MessageEvent<SpellIn>) => {
  const m = e.data;
  if (m.type === 'load') {
    if (!spellers.has(m.lang)) {
      spellers.set(
        m.lang,
        Promise.all([fetch(m.aff).then((r) => r.text()), fetch(m.dic).then((r) => r.text())])
          .then(([aff, dic]) => {
            const s = nspell(aff, dic);
            for (const w of personal) s.add(w);
            return s;
          })
          .catch(() => null),
      );
    }
    post({ type: 'loaded', lang: m.lang, ok: !!(await spellers.get(m.lang)) });
  } else if (m.type === 'personal') {
    const added = m.words.filter((w) => !personal.includes(w));
    personal = m.words;
    for (const s of spellers.values()) void s.then((x) => added.forEach((w) => x?.add(w)));
  } else if (m.type === 'check') {
    const s = await spellers.get(m.lang);
    post({ type: 'checked', id: m.id, wrong: s ? m.words.filter((w) => !s.correct(w)) : [] });
  } else if (m.type === 'suggest') {
    const s = await spellers.get(m.lang);
    post({ type: 'suggested', id: m.id, list: s ? s.suggest(m.word).slice(0, 5) : [] });
  }
};
