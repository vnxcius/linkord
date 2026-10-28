// Translations: every string the client passes to t()/msg()/plural() has a pt-BR entry with the same
// {placeholders}, the dictionary has no leftovers, and every server error message is covered.
// Run: cd tests && node --test i18n.test.mjs
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SERVER, UI } from '../app/src/lib/locales/pt-BR.ts';

const root = new URL('..', import.meta.url).pathname;

function files(dir, ext) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === 'locales' ? [] : files(p, ext);
    return ext.some((e) => d.name.endsWith(e)) ? [p] : [];
  });
}

/** String literals passed to t()/msg()/plural(): first arguments and ternary branches at the call's top level. */
export function extractKeys(src) {
  const keys = [];
  const call = /\b(t|msg|plural)\(/g;
  let m;
  while ((m = call.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 0;
    let prev = '(';
    while (i < src.length) {
      const c = src[i];
      if (c === "'" || c === '"' || c === '`') {
        let j = i + 1;
        while (src[j] !== c) j += src[j] === '\\' ? 2 : 1;
        const lit = src.slice(i, j + 1);
        const after = src.slice(j + 1).trimStart();
        if (depth === 0 && '(?:,'.includes(prev) && !/^(===|!==|\?)/.test(after) && !(c === '`' && lit.includes('${'))) {
          keys.push(Function(`return ${lit}`)());
        }
        prev = 'x';
        i = j + 1;
        continue;
      }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) {
        if (depth === 0) break;
        depth--;
      }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return keys;
}

const used = new Map();
for (const f of files(join(root, 'app/src'), ['.ts', '.tsx'])) {
  for (const k of extractKeys(readFileSync(f, 'utf8'))) used.set(k, f.slice(root.length));
}
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join();

test('finds the strings in the client', () => {
  assert.ok(used.size > 400, `only ${used.size} strings found`);
  assert.ok(used.has('Log Out') && used.has('{n} members') && used.has('Avatar updated'));
});

test('every UI string has a pt-BR translation with the same placeholders', () => {
  const missing = [...used].filter(([k]) => !(k in UI) && !(k in SERVER)).map(([k, f]) => `${f}: ${k}`);
  assert.deepEqual(missing, []);
  for (const k of used.keys()) {
    const tr = UI[k] ?? SERVER[k];
    assert.equal(placeholders(tr), placeholders(k), `placeholders differ for "${k}"`);
  }
});

test('no unused UI translations', () => {
  assert.deepEqual(Object.keys(UI).filter((k) => !used.has(k)), []);
});

test('every server error message is translated', () => {
  const server = files(join(root, 'server/src'), ['.rs']).map((f) => readFileSync(f, 'utf8')).join('\n');
  const literal = [...server.matchAll(/\b(?:bad|Err)\("([^"]+)"\)/g)].map((x) => x[1]).filter((s) => !s.includes('{'));
  const formatted = [...server.matchAll(/bad\(format!\("([^"]+)"/g)].map((x) => x[1]);
  const fixed = [...server.matchAll(/#\[error\("([^"{}]+)"\)\]/g)].map((x) => x[1]).concat('internal error');
  const missing = [...literal, ...fixed].filter((s) => /^[a-zA-Z@]/.test(s) && !(s in SERVER));
  assert.deepEqual([...new Set(missing)], []);
  const i18n = readFileSync(join(root, 'app/src/lib/i18n.ts'), 'utf8');
  for (const f of formatted) {
    const prefix = f.split('{')[0];
    assert.ok(i18n.includes(`/^${prefix}`), `no SERVER_PATTERNS entry for "${f}"`);
  }
});
