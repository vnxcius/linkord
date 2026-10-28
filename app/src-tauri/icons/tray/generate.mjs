// Regenerates the tray icons (64x64 PNG) from SVG with the test suite's headless Chromium:
//   CHROMIUM=/path/to/chrome node app/src-tauri/icons/tray/generate.mjs
// They must read at 16px in the Windows tray: muted and deafened turn the whole icon red with a large
// white glyph instead of a small corner badge. Glyphs are Lucide's mic-off and headphone-off (ISC).
import { writeFileSync } from 'node:fs';
import { chromium } from '../../../../tests/node_modules/playwright-core/index.mjs';

const tile = (fill) => `<rect x="1" y="1" width="62" height="62" rx="15" fill="${fill}"/>`;
const defs = '';
// The Triforce from assets/icon.svg, flat gold on the dark tile, large enough to read at 16px.
const emblem = `<g transform="translate(9 12.1) scale(0.23)" fill="#e3b341">
  <path d="M100 0 150 86.6H50Z"/><path d="M50 86.6 100 173.2H0Z"/><path d="M150 86.6 200 173.2H100Z"/>
</g>`;
const glyph = (paths) =>
  `<g transform="translate(9 9) scale(1.9166)" fill="none" stroke="#fff" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round">${paths
    .map((d) => `<path d="${d}"/>`)
    .join('')}</g>`;
const MIC_OFF = ['M12 19v3', 'M15 9.34V5a3 3 0 0 0-5.68-1.33', 'M16.95 16.95A7 7 0 0 1 5 12v-2', 'M18.89 13.23A7 7 0 0 0 19 12v-2', 'm2 2 20 20', 'M9 9v3a3 3 0 0 0 5.12 2.12'];
const HEADPHONE_OFF = [
  'M21 14h-1.343',
  'M9.128 3.47A9 9 0 0 1 21 12v3.343',
  'm2 2 20 20',
  'M20.414 20.414A2 2 0 0 1 19 21h-1a2 2 0 0 1-2-2v-3',
  'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364',
];

const icons = {
  idle: tile('#111214') + emblem,
  // In voice: a green dot with a dark rim so it separates from the tile on any taskbar.
  connected: tile('#111214') + emblem + '<circle cx="50" cy="50" r="12" fill="#111214"/><circle cx="50" cy="50" r="8.5" fill="#3ba55d"/>',
  speaking: tile('#111214') + emblem + '<rect x="3.5" y="3.5" width="57" height="57" rx="13" fill="none" stroke="#3ba55d" stroke-width="7"/>',
  muted: tile('#d83c3e') + glyph(MIC_OFF),
  deafened: tile('#d83c3e') + glyph(HEADPHONE_OFF),
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
for (const [name, body] of Object.entries(icons)) {
  await page.setContent(`<body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${defs}${body}</svg></body>`);
  writeFileSync(new URL(`${name}.png`, process.env.OUT ? `file://${process.env.OUT}/` : import.meta.url), await page.screenshot({ omitBackground: true }));
}
await browser.close();
console.log('tray icons written:', Object.keys(icons).join(', '));
