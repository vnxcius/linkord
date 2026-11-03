// Builds the desktop icons from assets/icon.png (the app icon, a gold tile with the Triforce) with the test suite's
// headless Chromium:
//   CHROMIUM=/path/to/chrome node app/src-tauri/icons/tray/generate.mjs
//   cd app && bun tauri icon ../assets/icon-square.png      (then every app icon size)
// Writes the tray icons (64x64, next to this file) and assets/icon-square.png (the icon centred on a transparent
// 1024 square, which `tauri icon` needs). Tray icons must read at 16px: in voice adds a green dot, speaking a green
// outline around the icon's shape, and muted/deafened turn the whole shape red with a large white glyph instead of
// a small badge. Glyphs are Lucide's mic-off and headphone-off (ISC).
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from '../../../../tests/node_modules/playwright-core/index.mjs';

const root = new URL('../../../../', import.meta.url);
const source = `data:image/png;base64,${readFileSync(new URL(process.env.SOURCE ?? 'assets/icon.png', root)).toString('base64')}`;

const MIC_OFF = ['M12 19v3', 'M15 9.34V5a3 3 0 0 0-5.68-1.33', 'M16.95 16.95A7 7 0 0 1 5 12v-2', 'M18.89 13.23A7 7 0 0 0 19 12v-2', 'm2 2 20 20', 'M9 9v3a3 3 0 0 0 5.12 2.12'];
const HEADPHONE_OFF = [
  'M21 14h-1.343',
  'M9.128 3.47A9 9 0 0 1 21 12v3.343',
  'm2 2 20 20',
  'M20.414 20.414A2 2 0 0 1 19 21h-1a2 2 0 0 1-2-2v-3',
  'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364',
];

// Runs in the page: each icon is drawn on a canvas and returned as a PNG data URL.
async function render({ source, glyphs }) {
  const img = new Image();
  img.src = source;
  await img.decode();
  const canvas = (size) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return [c, c.getContext('2d')];
  };
  /** The icon fitted into `box` px, centred on a `size` square. */
  const place = (size, box) => {
    const s = Math.min(box / img.width, box / img.height);
    const w = img.width * s;
    const h = img.height * s;
    return { x: (size - w) / 2, y: (size - h) / 2, w, h };
  };
  /** The icon's shape in one colour. */
  const silhouette = (size, at, color) => {
    const [c, g] = canvas(size);
    g.drawImage(img, at.x, at.y, at.w, at.h);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, size, size);
    return c;
  };
  const glyph = (g, paths, size, scale) => {
    const px = 24 * scale;
    g.save();
    g.translate((size - px) / 2, (size - px) / 2 + 1);
    g.scale(scale, scale);
    g.strokeStyle = '#fff';
    g.lineWidth = 2.6;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const d of paths) g.stroke(new Path2D(d));
    g.restore();
  };
  const out = {};
  const S = 64;

  // The app icon source: centred on a transparent square with a little room around it.
  {
    const [c, g] = canvas(1024);
    const at = place(1024, 1024 * 0.92);
    g.drawImage(img, at.x, at.y, at.w, at.h);
    out.square = c.toDataURL('image/png');
  }
  // Idle: the icon as large as the tray allows.
  const full = place(S, 62);
  {
    const [c, g] = canvas(S);
    g.drawImage(img, full.x, full.y, full.w, full.h);
    out.idle = c.toDataURL('image/png');
  }
  // In voice: a green dot with a dark rim, bottom right.
  {
    const [c, g] = canvas(S);
    g.drawImage(img, full.x, full.y, full.w, full.h);
    g.fillStyle = '#111214';
    g.beginPath();
    g.arc(51, 49, 12.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3ba55d';
    g.beginPath();
    g.arc(51, 49, 9, 0, Math.PI * 2);
    g.fill();
    out.connected = c.toDataURL('image/png');
  }
  // Speaking: a green outline that follows the icon's shape (its silhouette drawn around it, then the icon).
  {
    const at = place(S, 54);
    const green = silhouette(S, at, '#3ba55d');
    const [c, g] = canvas(S);
    const r = 4;
    for (let a = 0; a < 32; a++) {
      const t = (a / 32) * Math.PI * 2;
      g.drawImage(green, Math.cos(t) * r, Math.sin(t) * r);
    }
    g.drawImage(img, at.x, at.y, at.w, at.h);
    out.speaking = c.toDataURL('image/png');
  }
  // Muted / deafened: the whole shape red with a big white glyph.
  for (const [name, paths] of Object.entries(glyphs)) {
    const [c, g] = canvas(S);
    g.drawImage(silhouette(S, full, '#d83c3e'), 0, 0);
    glyph(g, paths, S, 1.55);
    out[name] = c.toDataURL('image/png');
  }
  return out;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const page = await browser.newPage();
const icons = await page.evaluate(render, { source, glyphs: { muted: MIC_OFF, deafened: HEADPHONE_OFF } });
await browser.close();
const png = (url) => Buffer.from(url.split(',')[1], 'base64');
if (!process.env.SQUARE) writeFileSync(new URL('assets/icon-square.png', root), png(icons.square));
for (const name of ['idle', 'connected', 'speaking', 'muted', 'deafened'])
  writeFileSync(new URL(`${name}.png`, process.env.OUT ? pathToFileURL(`${process.env.OUT}/`) : import.meta.url), png(icons[name]));
console.log('written: assets/icon-square.png and tray icons idle, connected, speaking, muted, deafened');
