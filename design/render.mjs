// Renders the app's PNG icons from the SVGs in this folder, with the test suite's headless Chromium:
//   node design/render.mjs        (CHROMIUM=/path/to/chrome to use another browser)
// Writes assets/icon.png (1024, the source of everything the desktop scripts make), the in-app emblem
// (app/src/assets/emblem.png) and the web icons in app/public: the favicon, the PWA icons, the maskable one (the
// tile to the edges, the mark inside the safe circle), the Apple touch icon (the tile to the edges: iOS rounds it)
// and the notification badge (the mark alone in white: Android shows only its alpha).
// Then run the desktop steps in README.md (tray icons, `tauri icon`, the Christmas set).
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '../tests/node_modules/playwright-core/index.mjs';

const root = new URL('../', import.meta.url);
const icon = readFileSync(new URL('design/linkord-icon.svg', root), 'utf8');
const mark = readFileSync(new URL('design/linkord-mark.svg', root), 'utf8');

const sized = (svg, w, h = w) => svg.replace(/ width="\d+" height="\d+"/, ` width="${w}" height="${h}"`);
/** The icon with its tile running to the edges and the mark at `scale` (0.903 in the app icon). */
const fullBleed = (scale) =>
  icon.replace(' rx="108"', '').replace('scale(0.903)', `scale(${scale})`);
/** The mark in one colour, centred in a square with `pad` (fraction of the side) around it. */
const badge = (color, size, pad) => {
  const inner = mark.replace(/fill="#[0-9a-f]+"/g, `fill="${color}"`).replace(/stroke="#[0-9a-f]+"/g, `stroke="${color}"`);
  const body = inner.slice(inner.indexOf('>') + 1, inner.lastIndexOf('</svg>'));
  // The mark's viewBox is 444 x 262: centre it vertically in a square one.
  const side = 444 / (1 - 2 * pad);
  const x = 34 - (side - 444) / 2;
  const y = 100 - (side - 262) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${side} ${side}" width="${size}" height="${size}">${body}</svg>`;
};

const outputs = [
  ['assets/icon.png', sized(icon, 1024)],
  ['app/src/assets/emblem.png', sized(icon, 512)],
  ['app/public/icon.png', sized(icon, 256)],
  ['app/public/icon-192.png', sized(icon, 192)],
  ['app/public/icon-512.png', sized(icon, 512)],
  ['app/public/apple-touch-icon.png', sized(fullBleed(0.903), 180)],
  // The maskable safe zone is a circle 80% wide; the wide mark fits it at 0.72.
  ['app/public/icon-maskable-512.png', sized(fullBleed(0.72), 512)],
  ['app/public/badge-96.png', badge('#ffffff', 96, 0.06)],
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [file, svg] of outputs) {
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
  writeFileSync(new URL(file, root), await page.locator('svg').screenshot({ omitBackground: true }));
  console.log('written', file);
}
await browser.close();
