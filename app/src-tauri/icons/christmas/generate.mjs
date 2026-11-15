// Builds the Christmas app icon from assets/icon.png: the same tile and mark, the tile in evergreen, wearing a Santa hat.
//   CHROMIUM=/path/to/chrome node app/src-tauri/icons/christmas/generate.mjs
//   cd app && bun tauri icon ../assets/icon-christmas-square.png -o src-tauri/icons/christmas/tmp
//   (keep tmp/icon.ico as icons/christmas/icon.ico, delete the rest)
// Writes assets/icon-christmas.png, assets/icon-christmas-square.png, the tray icons next to this file, the in-app
// copy (app/src/assets/emblem-christmas.png) and the web favicon (app/public/icon-christmas.png).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../../tests/node_modules/playwright-core/index.mjs';

const root = new URL('../../../../', import.meta.url);
const source = `data:image/png;base64,${readFileSync(new URL('assets/icon.png', root)).toString('base64')}`;

async function render(source) {
  const img = new Image();
  img.src = source;
  await img.decode();
  const W = 860;
  const H = 860;
  // The square app icon is drawn 640 px wide, so the hat and the snow keep their proportions whatever its source size.
  const TILE = 640;
  const left = (W - TILE) / 2;
  const top = 197;

  const tile = document.createElement('canvas');
  tile.width = TILE;
  tile.height = TILE;
  const t = tile.getContext('2d', { willReadFrequently: true });
  t.imageSmoothingQuality = 'high';
  t.drawImage(img, 0, 0, TILE, TILE);
  const data = t.getImageData(0, 0, TILE, TILE);
  // The graphite tile turns evergreen, in proportion to how close each pixel is to the tile's colour (#18181c), so
  // the edges of the white wings and the gold triforce blend; the wings stay white and the triforce gold.
  for (let i = 0; i < data.data.length; i += 4) {
    const [r, g, b] = [data.data[i], data.data[i + 1], data.data[i + 2]];
    const keep = Math.min(1, Math.max(0, (Math.abs(r - 24) + Math.abs(g - 24) + Math.abs(b - 28) - 30) / 150));
    data.data[i] = 18 * (1 - keep) + r * keep;
    data.data[i + 1] = 84 * (1 - keep) + g * keep;
    data.data[i + 2] = 54 * (1 - keep) + b * keep;
  }
  t.putImageData(data, 0, 0);

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.drawImage(tile, left, top);

  // The hat, sitting on the tile's top edge and leaning to the right. Thick shapes: it has to read at 16 px.
  g.save();
  g.translate(W / 2 - 50, top + 38);
  g.rotate(-0.08);
  const cone = new Path2D('M-225 8C-200 -90 -110 -190 30 -195 130 -198 215 -130 248 -52 200 -88 160 -90 135 -70 155 -45 168 -18 178 8Z');
  g.fillStyle = '#d42a39';
  g.fill(cone);
  g.save();
  g.clip(cone);
  g.fillStyle = '#a81c2b';
  g.beginPath();
  g.moveTo(10, 20);
  g.bezierCurveTo(40, -70, 40, -140, 20, -210);
  g.lineTo(300, -210);
  g.lineTo(300, 20);
  g.closePath();
  g.fill();
  g.restore();
  g.fillStyle = '#f4f8f5';
  g.beginPath();
  g.roundRect(-262, -14, 470, 72, 36);
  g.fill();
  g.beginPath();
  g.arc(262, -36, 50, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // Snow on the bottom of the tile.
  g.save();
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = '#f4f8f5';
  const y = top + TILE;
  g.beginPath();
  g.moveTo(0, H);
  g.lineTo(0, y - 72);
  g.bezierCurveTo(150, y - 112, 240, y - 40, 370, y - 58);
  g.bezierCurveTo(500, y - 76, 620, y - 26, W, y - 92);
  g.lineTo(W, H);
  g.closePath();
  g.fill();
  g.restore();

  const square = document.createElement('canvas');
  square.width = square.height = 1024;
  const s = square.getContext('2d');
  s.imageSmoothingQuality = 'high';
  s.drawImage(c, 512 - W * 0.55, 512 - H * 0.55, W * 1.1, H * 1.1);

  const small = document.createElement('canvas');
  small.width = small.height = 256;
  const m = small.getContext('2d');
  m.imageSmoothingQuality = 'high';
  m.drawImage(c, 0, 0, 256, 256);
  return { icon: c.toDataURL('image/png'), square: square.toDataURL('image/png'), small: small.toDataURL('image/png') };
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const page = await browser.newPage();
const out = await page.evaluate(render, source);
await browser.close();
const png = (url) => Buffer.from(url.split(',')[1], 'base64');
writeFileSync(new URL('assets/icon-christmas.png', root), png(out.icon));
writeFileSync(new URL('assets/icon-christmas-square.png', root), png(out.square));
writeFileSync(new URL('app/src/assets/emblem-christmas.png', root), png(out.small));
writeFileSync(new URL('app/public/icon-christmas.png', root), png(out.small));
// The tray states, by the same rules as the normal icon.
execFileSync(process.execPath, [fileURLToPath(new URL('../tray/generate.mjs', import.meta.url))], {
  stdio: 'inherit',
  env: { ...process.env, SOURCE: 'assets/icon-christmas.png', SQUARE: 'assets/icon-christmas-square.png', OUT: fileURLToPath(new URL('.', import.meta.url)) },
});
