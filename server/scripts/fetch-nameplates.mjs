#!/usr/bin/env node
// Downloads every nameplate in Discord's shop into the default nameplates folder (server/nameplates), as
// <name>.webm (the animated version). Files that are already there are skipped, so it can be rerun when the
// shop adds new ones.
//
// The shop catalog needs a signed-in Discord session. Either:
//   1. In Discord (browser), open DevTools -> Network, open the Shop, find the request to
//      "collectibles-categories", and save its response as a file; then
//        node server/scripts/fetch-nameplates.mjs --from shop.json
//   2. Or pass your own session token (it is only sent to discord.com, never stored):
//        DISCORD_TOKEN=... node server/scripts/fetch-nameplates.mjs
// Options: --out <dir> (default: server/nameplates), --static (also save <name>.png still frames), --dry-run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = resolve(opt('--out') ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'nameplates'));
const dryRun = args.includes('--dry-run');
const withStatic = args.includes('--static');
const CDN = 'https://cdn.discordapp.com/assets/collectibles/';

async function catalog() {
  const from = opt('--from');
  if (from) return JSON.parse(readFileSync(from, 'utf8'));
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('Give the shop catalog with --from <file>, or set DISCORD_TOKEN (see the top of this file).');
    process.exit(1);
  }
  const res = await fetch('https://discord.com/api/v9/collectibles-categories?include_unpublished=false', {
    headers: { authorization: token, 'user-agent': 'Mozilla/5.0 linkord-nameplates' },
  });
  if (!res.ok) throw new Error(`Discord answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Every nameplate in the catalog: its asset path ("nameplates/.../") and a name for the file. */
function nameplates(data) {
  const found = new Map();
  const walk = (node, productName) => {
    if (Array.isArray(node)) return node.forEach((x) => walk(x, productName));
    if (!node || typeof node !== 'object') return;
    const name = typeof node.name === 'string' ? node.name : productName;
    if (typeof node.asset === 'string' && node.asset.startsWith('nameplates/')) {
      const asset = node.asset.endsWith('/') ? node.asset : `${node.asset}/`;
      if (!found.has(asset)) found.set(asset, node.label || name || asset.split('/').filter(Boolean).pop());
    }
    for (const v of Object.values(node)) walk(v, name);
  };
  walk(data);
  return [...found].map(([asset, name]) => ({ asset, name }));
}

/** "Andy's Room Clouds" -> "andy's_room_clouds", like the files already in the folder. */
const slug = (name) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9'_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'nameplate';

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

const list = nameplates(await catalog());
if (!list.length) {
  console.error('No nameplates found in that catalog (is it the collectibles-categories response?).');
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const used = new Set();
const jobs = list.map(({ asset, name }) => {
  let base = slug(name);
  for (let n = 2; used.has(base); n++) base = `${slug(name)}_${n}`;
  used.add(base);
  return { asset, base };
});
let saved = 0;
let skipped = 0;
let failed = 0;
// A few at a time: friendly to the CDN, still quick.
const queue = [...jobs];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const files = [[`${job.base}.webm`, `${CDN}${job.asset}asset.webm`]];
      if (withStatic) files.push([`${job.base}.png`, `${CDN}${job.asset}static.png`]);
      for (const [file, url] of files) {
        const path = join(out, file);
        if (existsSync(path)) {
          skipped++;
          continue;
        }
        if (dryRun) {
          console.log(`would save ${file} <- ${url}`);
          continue;
        }
        try {
          await download(url, path);
          saved++;
          console.log(`saved ${file}`);
        } catch (e) {
          failed++;
          console.warn(`failed ${file}: ${e.message}`);
        }
      }
    }
  }),
);
console.log(`${list.length} nameplates in the shop: ${saved} saved, ${skipped} already there, ${failed} failed -> ${out}`);
