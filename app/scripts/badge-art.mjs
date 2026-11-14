// Draws the profile badge art (owner, 2026-11-12: playful and colored, like Discord's): 8 milestones x 5 tiers
// (<id>-<tier>.svg: the same object in Bronze..Diamond, sparkles from Silver, wings from Platinum) + the single badges
// (<id>.svg), as 48x48 SVGs. Ids match server/src/badges.rs and lib/badges.ts.
// Run: node app/scripts/badge-art.mjs app/src/assets/badges   (sheet.html there previews all of them; delete it after)
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
mkdirSync(out, { recursive: true });

const TIERS = [
  { id: 'bronze', main: '#d4874a', light: '#f6bd86', dark: '#a05a2a', deep: '#6f3a17' },
  { id: 'silver', main: '#c7d0dc', light: '#f5f8fc', dark: '#8e99a9', deep: '#5c6676' },
  { id: 'gold', main: '#f5b935', light: '#ffe28c', dark: '#c98417', deep: '#8c560c' },
  { id: 'platinum', main: '#7fe0d2', light: '#dffff9', dark: '#3fae9f', deep: '#23756b' },
  { id: 'diamond', main: '#b7a4ff', light: '#f4f0ff', dark: '#7d66f2', deep: '#4a39b6' },
];

const sparkle = (x, y, r, fill = '#fff8d6') =>
  `<path d="M${x} ${y - r}Q${x + r * 0.18} ${y - r * 0.18} ${x + r} ${y}Q${x + r * 0.18} ${y + r * 0.18} ${x} ${y + r}Q${x - r * 0.18} ${y + r * 0.18} ${x - r} ${y}Q${x - r * 0.18} ${y - r * 0.18} ${x} ${y - r}Z" fill="${fill}"/>`;

const wing = (m) => {
  const one = `<path d="M17 21C12 18 6 15.5 1.5 10.5C1.5 17 4 22 8.5 25C5 25.5 3 27 1.5 29.5C6 31.5 11 31 14.5 29C12.5 31.5 11.5 33.5 11 36C15 35.5 18 33 19.5 29Z" fill="${m.main}"/>
<path d="M17 21C12 18 6 15.5 1.5 10.5C3.5 15 7 18.5 11.5 21Z" fill="${m.light}"/>
<path d="M8.5 25C10.5 25.5 13 25.3 15.5 24.5" stroke="${m.dark}" stroke-width="1.2" fill="none" stroke-linecap="round"/>
<path d="M14.5 29C15.8 28.5 17 27.8 18 27" stroke="${m.dark}" stroke-width="1.2" fill="none" stroke-linecap="round"/>`;
  return `<g>${one}</g><g transform="translate(48 0) scale(-1 1)">${one}</g>`;
};

// ---------- tiered objects (m = tier material) ----------

const hourglass = (m) => `
<rect x="13" y="36" width="22" height="5.5" rx="2.5" fill="${m.dark}"/>
<rect x="13" y="35" width="22" height="4.5" rx="2.2" fill="${m.main}"/>
<rect x="14.5" y="11" width="3" height="25" rx="1.2" fill="${m.dark}"/>
<rect x="30.5" y="11" width="3" height="25" rx="1.2" fill="${m.dark}"/>
<path d="M17.8 11.5H30.2C30.2 18 26 20.6 25 24C26 27.4 30.2 30 30.2 36H17.8C17.8 30 22 27.4 23 24C22 20.6 17.8 18 17.8 11.5Z" fill="#d7f0ff"/>
<path d="M19.6 14.2H28.4C28 18 25.6 20.3 24 22.6C22.4 20.3 20 18 19.6 14.2Z" fill="#ffcf4a"/>
<rect x="23.4" y="22" width="1.2" height="8.5" rx=".6" fill="#ffcf4a"/>
<path d="M18.7 35.6C19.6 31.2 22 29.6 24 29.6C26 29.6 28.4 31.2 29.3 35.6Z" fill="#f4a321"/>
<path d="M19.8 13.4C20 16.4 21.2 18.4 22.4 19.6" stroke="#fff" stroke-width="1.3" fill="none" stroke-linecap="round" opacity=".85"/>
<rect x="13" y="6.5" width="22" height="5.5" rx="2.5" fill="${m.main}"/>
<rect x="15.5" y="7.6" width="11" height="1.6" rx=".8" fill="${m.light}"/>
<rect x="13" y="10" width="22" height="2" rx="1" fill="${m.dark}"/>`;

const cartridge = (body, shade, label, art) => `
<path d="M14 11a2 2 0 0 1 2-2H30L34 13V39a2 2 0 0 1-2 2H16a2 2 0 0 1-2-2Z" fill="${body}"/>
<path d="M30.5 9.3L34 13V39a2 2 0 0 1-2 2H30.5Z" fill="${shade}"/>
<rect x="17" y="13" width="13.5" height="13" rx="2" fill="${label}"/>
${art}
<rect x="17.5" y="30" width="12.5" height="1.8" rx=".9" fill="${shade}"/>
<rect x="17.5" y="33.5" width="12.5" height="1.8" rx=".9" fill="${shade}"/>
<rect x="17.5" y="37" width="12.5" height="1.8" rx=".9" fill="${shade}"/>`;

const games = (m) => `
<g transform="rotate(-16 24 26) translate(-4.5 0)">${cartridge(m.dark, m.deep, '#5b8cff', `<circle cx="23.7" cy="19.5" r="3.2" fill="#ffd23f"/>`)}</g>
<g transform="rotate(10 24 26) translate(3 1)">${cartridge(m.main, m.dark, '#ff5d73', `<path d="M17 26L21.5 19L24.5 23L26.5 20.5L30.5 26Z" fill="#ffd8de"/><circle cx="27" cy="16.5" r="1.8" fill="#ffe07a"/>`)}
<rect x="15.6" y="10.6" width="1.6" height="9" rx=".8" fill="${m.light}" transform="rotate(0)"/></g>`;

const gamepad = (m) => `
<path d="M12 20C12 16 15 15 18 15H30C33 15 36 16 36 20L39 32.5C40 37.5 36 40.5 32.5 38L29 35H19L15.5 38C12 40.5 8 37.5 9 32.5Z" fill="${m.deep}"/>
<path d="M12 18C12 14 15 13 18 13H30C33 13 36 14 36 18L39 30.5C40 35.5 36 38.5 32.5 36L29 33H19L15.5 36C12 38.5 8 35.5 9 30.5Z" fill="${m.main}"/>
<path d="M15.5 15.6H32.5" stroke="${m.light}" stroke-width="1.6" stroke-linecap="round"/>
<rect x="14.8" y="21.2" width="8.4" height="2.8" rx=".9" fill="#2f3138"/>
<rect x="17.6" y="18.4" width="2.8" height="8.4" rx=".9" fill="#2f3138"/>
<circle cx="30" cy="19.4" r="2" fill="#ffd23f"/>
<circle cx="33.4" cy="22.6" r="2" fill="#ff5d73"/>
<circle cx="26.6" cy="22.6" r="2" fill="#5b8cff"/>
<circle cx="30" cy="25.8" r="2" fill="#c08cff"/>
<rect x="21" y="27.4" width="2.6" height="1.6" rx=".8" fill="${m.dark}"/>
<rect x="24.4" y="27.4" width="2.6" height="1.6" rx=".8" fill="${m.dark}"/>`;

const microphone = (m) => `
<path d="M12.5 20V23.5C12.5 30.5 17.5 34 24 34C30.5 34 35.5 30.5 35.5 23.5V20" stroke="${m.dark}" stroke-width="3" fill="none" stroke-linecap="round"/>
<rect x="22.4" y="33" width="3.2" height="5" fill="${m.dark}"/>
<ellipse cx="24" cy="40.3" rx="8.5" ry="2.8" fill="${m.dark}"/>
<ellipse cx="24" cy="39.6" rx="8.5" ry="2.4" fill="${m.main}"/>
<rect x="16" y="5.5" width="16" height="23" rx="8" fill="${m.main}"/>
<path d="M24 5.5A8 8 0 0 1 32 13.5V20.5A8 8 0 0 1 24 28.5Z" fill="${m.dark}" opacity=".55"/>
<path d="M17.5 11.5H30.5M16.5 15.5H31.5M16.5 19.5H31.5M17 23.5H31" stroke="${m.deep}" stroke-width="1.1" opacity=".7"/>
<rect x="18.4" y="8.4" width="2.6" height="13" rx="1.3" fill="${m.light}" opacity=".9"/>
<rect x="15" y="25.5" width="18" height="4" rx="2" fill="${m.dark}"/>
<circle cx="38.5" cy="9.5" r="4.6" fill="#ff3b5c"/>
<circle cx="38.5" cy="9.5" r="4.6" fill="none" stroke="#ff9db0" stroke-width="1.2"/>
<circle cx="37.2" cy="8.2" r="1.3" fill="#ffe1e7"/>`;

const headphones = (m) => `
<path d="M11 28V22C11 13 17 7.5 24 7.5C31 7.5 37 13 37 22V28" stroke="${m.dark}" stroke-width="4.6" fill="none" stroke-linecap="round"/>
<path d="M11 27V22C11 13 17 7.5 24 7.5C31 7.5 37 13 37 22V27" stroke="${m.main}" stroke-width="3.2" fill="none" stroke-linecap="round"/>
<path d="M13.6 18.5C15 12.6 19 10 24 10" stroke="${m.light}" stroke-width="1.3" fill="none" stroke-linecap="round"/>
<rect x="15" y="25" width="6" height="13" rx="3" fill="#3b3e48"/>
<rect x="27" y="25" width="6" height="13" rx="3" fill="#3b3e48"/>
<rect x="7" y="23.5" width="10" height="16" rx="4.5" fill="${m.main}"/>
<rect x="31" y="23.5" width="10" height="16" rx="4.5" fill="${m.main}"/>
<path d="M7 33.5H17V35a4.5 4.5 0 0 1-4.5 4.5H11.5A4.5 4.5 0 0 1 7 35Z" fill="${m.dark}"/>
<path d="M31 33.5H41V35a4.5 4.5 0 0 1-4.5 4.5H35.5A4.5 4.5 0 0 1 31 35Z" fill="${m.dark}"/>
<rect x="9" y="25.5" width="2" height="6" rx="1" fill="${m.light}"/>
<rect x="33" y="25.5" width="2" height="6" rx="1" fill="${m.light}"/>
<path d="M24 31.5C22.2 30 21 29 21 27.6C21 26.6 21.8 25.9 22.7 25.9C23.3 25.9 23.7 26.2 24 26.7C24.3 26.2 24.7 25.9 25.3 25.9C26.2 25.9 27 26.6 27 27.6C27 29 25.8 30 24 31.5Z" fill="#ff5d8f"/>`;

const popcorn = (m) => {
  const top = [13, 17.4, 21.8, 26.2, 30.6, 35];
  const bot = [16, 19.2, 22.4, 25.6, 28.8, 32];
  let stripes = '';
  for (let i = 0; i < 5; i++) {
    const c = i % 2 ? '#fff4e8' : m.main;
    stripes += `<path d="M${top[i]} 21L${top[i + 1]} 21L${bot[i + 1]} 42L${bot[i]} 42Z" fill="${c}"/>`;
  }
  const puffs = [
    [15.5, 17.5, 4.4], [33, 17.5, 4.4], [20.5, 13.5, 5], [27.5, 13.5, 5], [24, 9.5, 4.2], [24, 18, 5], [18, 19.5, 4], [30, 19.5, 4],
  ]
    .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff1c2"/><circle cx="${x + r * 0.25}" cy="${y + r * 0.3}" r="${r * 0.55}" fill="#f6d77e"/>`)
    .join('');
  return `${puffs}
<circle cx="22" cy="12" r="1.2" fill="#ffc23a"/><circle cx="29" cy="16" r="1" fill="#ffc23a"/><circle cx="16" cy="16" r="1" fill="#ffc23a"/>
${stripes}
<path d="M30.6 21L35 21L32 42L28.8 42Z" fill="#000" opacity=".12"/>
<rect x="11.5" y="19" width="25" height="4" rx="2" fill="${m.dark}"/>
<rect x="13" y="19.6" width="10" height="1.2" rx=".6" fill="${m.light}"/>`;
};

const megaphone = (m) => `
<path d="M37 16.5C40 19.5 40 28.5 37 31.5" stroke="#ff7ac6" stroke-width="2.4" fill="none" stroke-linecap="round"/>
<path d="M41 12.5C46 18.5 46 29.5 41 35.5" stroke="#6fd0ff" stroke-width="2.4" fill="none" stroke-linecap="round"/>
<path d="M16.5 29L14.8 37.2A1.5 1.5 0 0 0 16.3 39H18.6A1.5 1.5 0 0 0 20 37.9L21.6 31Z" fill="${m.dark}"/>
<rect x="6.5" y="19" width="6.5" height="10" rx="2.2" fill="${m.dark}"/>
<path d="M12 19.5L31 10.5V37.5L12 28.5Z" fill="${m.main}"/>
<path d="M12 24L31 24V37.5L12 28.5Z" fill="${m.dark}" opacity=".45"/>
<path d="M14 20.6L28.8 13.6" stroke="${m.light}" stroke-width="1.5" stroke-linecap="round"/>
<ellipse cx="31" cy="24" rx="3.8" ry="13.5" fill="${m.light}"/>
<ellipse cx="31.7" cy="24" rx="2.2" ry="10.5" fill="${m.deep}"/>`;

const snowball = (m) => `
<circle cx="24" cy="28.5" r="13" fill="#f4f9ff"/>
<path d="M35.5 22.5A13 13 0 0 1 14 37.5C22 39 31.5 34 35.5 22.5Z" fill="#c8dbf2"/>
<ellipse cx="17.5" cy="25.5" rx="2.6" ry="1.6" fill="#fff" transform="rotate(-30 17.5 25.5)"/>
<circle cx="20" cy="30" r="1.5" fill="#3a3d46"/>
<circle cx="28" cy="30" r="1.5" fill="#3a3d46"/>
<circle cx="17.3" cy="33" r="1.7" fill="#ffb3c7"/>
<circle cx="30.7" cy="33" r="1.7" fill="#ffb3c7"/>
<path d="M22 33.2C23.2 34.5 24.8 34.5 26 33.2" stroke="#3a3d46" stroke-width="1.3" fill="none" stroke-linecap="round"/>
<path d="M12.5 22C13 13.5 18 10 24 10C30 10 35 13.5 35.5 22Z" fill="${m.main}"/>
<path d="M24 10C30 10 35 13.5 35.5 22H28C28.5 16 27 12 24 10Z" fill="${m.dark}" opacity=".5"/>
<path d="M17 14.5C18.5 12.5 20.5 11.5 22.5 11.2" stroke="${m.light}" stroke-width="1.4" fill="none" stroke-linecap="round"/>
<rect x="11" y="19.5" width="26" height="5.5" rx="2.75" fill="${m.dark}"/>
<path d="M14 20.5V24M17 20.5V24M20 20.5V24M23 20.5V24M26 20.5V24M29 20.5V24M32 20.5V24M35 20.5V24" stroke="${m.deep}" stroke-width="1" opacity=".6"/>
<circle cx="24" cy="8.2" r="3.8" fill="${m.light}"/>
<circle cx="25" cy="9.2" r="2" fill="${m.main}" opacity=".6"/>`;

// REC (2.0): clips shared, views of them, hours recorded.
const clapper = (m) => `
<rect x="8.5" y="20" width="31" height="21" rx="3.2" fill="${m.dark}"/>
<rect x="8.5" y="18.5" width="31" height="20.5" rx="3.2" fill="${m.main}"/>
<path d="M12.5 35.5H35.5" stroke="${m.dark}" stroke-width="1.4" stroke-linecap="round" opacity=".6"/>
<path d="M12 23.4H22" stroke="${m.light}" stroke-width="1.6" stroke-linecap="round"/>
<circle cx="24" cy="29.5" r="5.4" fill="#2f3138"/>
<path d="M22.4 26.9L27 29.5L22.4 32.1Z" fill="#ffd23f"/>
<rect x="8.5" y="15.5" width="31" height="5.5" rx="1.6" fill="#2f3138"/>
<path d="M12.5 15.5L15.5 21M19.5 15.5L22.5 21M26.5 15.5L29.5 21M33.5 15.5L36.5 21" stroke="#f4f4f6" stroke-width="2.2"/>
<g transform="rotate(-16 9 14)"><rect x="8.5" y="9" width="31" height="5.5" rx="1.6" fill="#2f3138"/>
<path d="M12.5 9L15.5 14.5M19.5 9L22.5 14.5M26.5 9L29.5 14.5M33.5 9L36.5 14.5" stroke="#f4f4f6" stroke-width="2.2"/></g>
<circle cx="9.8" cy="14.6" r="1.6" fill="${m.light}"/>`;

const eye = (m) => `
<path d="M4 25C9 15.5 16 11 24 11C32 11 39 15.5 44 25C39 34.5 32 39 24 39C16 39 9 34.5 4 25Z" fill="${m.main}"/>
<path d="M4 25C9 34.5 16 39 24 39C32 39 39 34.5 44 25Z" fill="${m.dark}" opacity=".45"/>
<path d="M8.5 25C12.5 18 18 14.6 24 14.6C30 14.6 35.5 18 39.5 25C35.5 32 30 35.4 24 35.4C18 35.4 12.5 32 8.5 25Z" fill="#fdfcf7"/>
<circle cx="24" cy="25" r="8" fill="#4da3ff"/>
<circle cx="24" cy="25" r="8" fill="none" stroke="#2c6fd0" stroke-width="1.2"/>
<circle cx="24" cy="25" r="4.2" fill="#22252c"/>
<circle cx="26.4" cy="22.6" r="1.9" fill="#fff"/>
<circle cx="21.6" cy="27.6" r=".9" fill="#fff" opacity=".8"/>
<path d="M10.5 18.6C14 14.6 18.5 12.7 23 12.4" stroke="${m.light}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;

const camcorder = (m) => `
<path d="M31 21L42 14.5V34.5L31 28Z" fill="${m.dark}"/>
<path d="M31 21L42 14.5V19.5L31 25Z" fill="${m.light}" opacity=".55"/>
<rect x="5.5" y="15" width="27" height="20" rx="4.2" fill="${m.main}"/>
<path d="M5.5 26H32.5V30.8A4.2 4.2 0 0 1 28.3 35H9.7A4.2 4.2 0 0 1 5.5 30.8Z" fill="${m.dark}" opacity=".5"/>
<circle cx="14.5" cy="25" r="6" fill="#2f3138"/>
<circle cx="14.5" cy="25" r="3.2" fill="#6fd0ff"/>
<circle cx="15.6" cy="23.9" r="1.1" fill="#fff"/>
<circle cx="26.3" cy="20.3" r="2.5" fill="#ff4d6d"/>
<circle cx="25.7" cy="19.7" r=".8" fill="#ffd0da"/>
<path d="M9 18.4H19.5" stroke="${m.light}" stroke-width="1.5" stroke-linecap="round"/>
<rect x="12" y="10.5" width="13" height="4.5" rx="1.6" fill="${m.dark}"/>`;

const TIERED = { member: hourglass, games, played: gamepad, live: microphone, calls: headphones, watch: popcorn, sounds: megaphone, snowball, clips: clapper, views: eye, recorded: camcorder };

const tiered = (draw, t) => {
  const m = TIERS[t];
  const winged = t >= 3;
  let s = '';
  if (winged) s += wing(m);
  s += winged ? `<g transform="translate(24 25) scale(.87) translate(-24 -25)">${draw(m)}</g>` : draw(m);
  if (t >= 1) s += sparkle(40.5, 7.5, t >= 4 ? 4.6 : 3.6);
  if (t >= 2) s += sparkle(7.5, 40, 3);
  if (t >= 4) s += sparkle(42, 39.5, 3.2, '#ffd6f2') + sparkle(6.5, 7.5, 2.6, '#d9f6ff');
  return s;
};

// ---------- single badges ----------

const SINGLE = {
  admin: () => `
<path d="M24 4.5L38.5 9.8V22C38.5 31 32.5 38.5 24 43.5C15.5 38.5 9.5 31 9.5 22V9.8Z" fill="#f5b935"/>
<path d="M24 4.5L38.5 9.8V22C38.5 31 32.5 38.5 24 43.5Z" fill="#c98417"/>
<path d="M24 8.3L35.2 12.4V22C35.2 29.4 30.8 35.4 24 39.6C17.2 35.4 12.8 29.4 12.8 22V12.4Z" fill="#3e5be0"/>
<path d="M24 8.3L35.2 12.4V22C35.2 29.4 30.8 35.4 24 39.6Z" fill="#2c42b0"/>
<path d="M24 13.5L27.6 19.8H20.4Z M20.4 19.8L24 26.1H16.8Z M27.6 19.8L31.2 26.1H24Z" fill="#ffd65c"/>
<path d="M11.5 11.6L22 7.8" stroke="#ffe28c" stroke-width="1.4" stroke-linecap="round"/>
${sparkle(39.5, 6.5, 3.6)}`,
  early: () => `
<circle cx="24" cy="23" r="10.5" fill="#ffd23f"/>
<path d="M33.6 19A10.5 10.5 0 0 1 20 32.5C27 32 32 27 33.6 19Z" fill="#f2b51d"/>
<path d="M16.3 15.2L19.3 12.4L22.3 15.2L25.3 12.4L28.3 15.2L31.4 13.2C30 9 27.5 6.8 24 6.8C20.2 6.8 17.2 9.6 16.3 15.2Z" fill="#fff3e0"/>
<path d="M28.3 15.2L31.4 13.2C30 9 27.5 6.8 24 6.8C26.6 8.5 28 11.4 28.3 15.2Z" fill="#e8d4b4"/>
<circle cx="20.6" cy="22" r="1.6" fill="#2f3138"/><circle cx="27.4" cy="22" r="1.6" fill="#2f3138"/>
<circle cx="21.1" cy="21.4" r=".5" fill="#fff"/><circle cx="27.9" cy="21.4" r=".5" fill="#fff"/>
<path d="M22.4 24.6H25.6L24 27.2Z" fill="#ff8a3d"/>
<circle cx="18.2" cy="25.6" r="1.6" fill="#ffad7a"/><circle cx="29.8" cy="25.6" r="1.6" fill="#ffad7a"/>
<path d="M11 29.5L15 26.5L18.5 30.5L24 26.5L29.5 30.5L33 26.5L37 29.5C37 37 31.5 42 24 42C16.5 42 11 37 11 29.5Z" fill="#fff3e0"/>
<path d="M29.5 30.5L33 26.5L37 29.5C37 37 31.5 42 24 42C30 40 32.5 35.5 29.5 30.5Z" fill="#e8d4b4"/>
<path d="M14.5 33C15.3 36 17.3 38.3 20 39.4" stroke="#fff" stroke-width="1.3" fill="none" stroke-linecap="round"/>
${sparkle(39.5, 9, 3.4)}${sparkle(8.5, 13, 2.4, '#ffe9a8')}`,
  owner: () => `
<path d="M10 33L7.5 15.5L17 23.5L24 11L31 23.5L40.5 15.5L38 33Z" fill="#f5b935"/>
<path d="M24 11L31 23.5L40.5 15.5L38 33H24Z" fill="#e0a024"/>
<rect x="9.5" y="31" width="29" height="8" rx="2.2" fill="#f5b935"/>
<rect x="9.5" y="35.5" width="29" height="3.5" rx="1.6" fill="#c98417"/>
<circle cx="7.5" cy="14.5" r="2.6" fill="#ffe28c"/><circle cx="24" cy="10" r="2.9" fill="#ffe28c"/><circle cx="40.5" cy="14.5" r="2.6" fill="#ffe28c"/>
<circle cx="16.5" cy="35" r="2.3" fill="#ff4d6d"/>
<path d="M24 31.6L26.8 35L24 38.4L21.2 35Z" fill="#4da3ff"/>
<circle cx="31.5" cy="35" r="2.3" fill="#ff4d6d"/>
<circle cx="15.8" cy="34.3" r=".7" fill="#ffd0da"/><circle cx="30.8" cy="34.3" r=".7" fill="#ffd0da"/>
<path d="M12 29.5L10.6 19.5" stroke="#ffe28c" stroke-width="1.4" stroke-linecap="round"/>
${sparkle(41, 6.5, 3.2)}`,
  christmas: () => `
<rect x="10" y="22" width="28" height="19" rx="2" fill="#e23b4a"/>
<path d="M26.5 22H36a2 2 0 0 1 2 2V39a2 2 0 0 1-2 2H26.5Z" fill="#b82a3a"/>
<rect x="21.5" y="22" width="5" height="19" fill="#f5c542"/>
<rect x="8" y="17" width="32" height="7" rx="2" fill="#ff5466"/>
<rect x="21.5" y="17" width="5" height="7" fill="#ffd65c"/>
<path d="M8 19.5C9.5 16.6 12.5 18.2 14.5 16.9C16.5 18.2 19 16.4 21.5 17.4V19.8C19.5 21 17 19.4 15 20.6C12.5 19.4 10.2 21.6 8 21Z" fill="#ffffff"/>
<path d="M26.5 17.4C29 16.4 31 18.2 33.5 16.9C35.5 18.2 38.5 16.6 40 19.5V21C37.8 21.6 35.5 19.4 33 20.6C31 19.4 28.5 21 26.5 19.8Z" fill="#ffffff"/>
<path d="M24 17C18 8.5 11.5 10.5 13.5 14.8C14.8 17.6 20 18 24 17Z" fill="#ffd65c"/>
<path d="M24 17C30 8.5 36.5 10.5 34.5 14.8C33.2 17.6 28 18 24 17Z" fill="#ffd65c"/>
<path d="M24 17C20 12 16 11.5 15.4 13.8" stroke="#e0a12a" stroke-width="1.2" fill="none"/>
<path d="M24 17C28 12 32 11.5 32.6 13.8" stroke="#e0a12a" stroke-width="1.2" fill="none"/>
<circle cx="24" cy="16.6" r="2.6" fill="#e0a12a"/>
<path d="M11 37C13 34 15.5 33.5 17 35.5C15 38 13 38.5 11 37Z" fill="#2fa36b"/>
<path d="M17 35.5C18.5 33 21 33 22 35C20.5 37.5 18.5 37.5 17 35.5Z" fill="#26895a"/>
<circle cx="17" cy="37.3" r="1.5" fill="#ff2d48"/><circle cx="19.2" cy="38.2" r="1.3" fill="#ff2d48"/>
${sparkle(40.5, 8, 3.2)}${sparkle(6.5, 9, 2.4, '#ffffff')}`,
  bug_hunter: () => `
<path d="M21 9.5C20 6.5 17.8 5.2 15.6 5.6M27 9.5C28 6.5 30.2 5.2 32.4 5.6" stroke="#5a5d68" stroke-width="1.7" fill="none" stroke-linecap="round"/>
<circle cx="15.4" cy="5.6" r="1.8" fill="#5a5d68"/><circle cx="32.6" cy="5.6" r="1.8" fill="#5a5d68"/>
<path d="M11.5 24L8 22M11 30.5L7.5 31.5M13.5 36L10.5 39M36.5 24L40 22M37 30.5L40.5 31.5M34.5 36L37.5 39" stroke="#5a5d68" stroke-width="1.8" stroke-linecap="round"/>
<circle cx="24" cy="15" r="7.2" fill="#5a5d68"/>
<circle cx="21" cy="12.8" r="1.7" fill="#fff"/><circle cx="27" cy="12.8" r="1.7" fill="#fff"/>
<circle cx="21.3" cy="13.1" r=".8" fill="#2f3138"/><circle cx="27.3" cy="13.1" r=".8" fill="#2f3138"/>
<circle cx="24" cy="28" r="13.2" fill="#ff3b4f"/>
<path d="M24 14.8A13.2 13.2 0 0 1 24 41.2Z" fill="#d82a3e"/>
<path d="M24 15V41" stroke="#3a1a1f" stroke-width="1.6"/>
<circle cx="18" cy="23" r="2.7" fill="#2f3138"/><circle cx="30" cy="23" r="2.7" fill="#2f3138"/>
<circle cx="17" cy="31.5" r="2.3" fill="#2f3138"/><circle cx="31" cy="31.5" r="2.3" fill="#2f3138"/>
<circle cx="20.5" cy="37" r="1.6" fill="#2f3138"/><circle cx="27.5" cy="37" r="1.6" fill="#2f3138"/>
<ellipse cx="16.5" cy="19.5" rx="3" ry="1.6" fill="#ffc2ca" transform="rotate(-35 16.5 19.5)"/>`,
  tester: () => `
<circle cx="30" cy="5" r="1.8" fill="#e5d4ff"/><circle cx="33.5" cy="9.5" r="1.2" fill="#e5d4ff"/>
<rect x="20" y="8" width="8" height="12" fill="#dff3ff"/>
<circle cx="24" cy="30" r="12.5" fill="#dff3ff"/>
<path d="M11.7 28.5C15.5 26.5 19.5 30.5 24 28.5C28.5 26.5 32.5 30.5 36.3 28.5A12.5 12.5 0 1 1 11.7 28.5Z" fill="#a46bff"/>
<path d="M36.3 28.5A12.5 12.5 0 0 1 16 39.5C26 40 33 36 36.3 28.5Z" fill="#7c4ae0"/>
<circle cx="20" cy="34" r="2.1" fill="#e5d4ff"/><circle cx="27.5" cy="36.5" r="1.4" fill="#e5d4ff"/><circle cx="26.5" cy="31.5" r="1.1" fill="#e5d4ff"/>
<path d="M20 19.5V8.5M28 19.5V8.5" stroke="#9fd4ff" stroke-width="1.4"/>
<circle cx="24" cy="30" r="12.5" fill="none" stroke="#9fd4ff" stroke-width="1.4"/>
<rect x="18" y="5.5" width="12" height="3.6" rx="1.8" fill="#ffffff"/>
<path d="M15 25.5C16 22.8 18 20.8 20.4 20" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/>
${sparkle(39.5, 16, 3)}`,
  contributor: () => `
<path d="M11 15a2 2 0 0 1 2-2H20C19 9 21 6.5 24 6.5C27 6.5 29 9 28 13H35a2 2 0 0 1 2 2V22C41 21 43.5 23 43.5 26C43.5 29 41 31 37 30V37a2 2 0 0 1-2 2H13a2 2 0 0 1-2-2V30C15 31 16.5 28.5 16.5 26C16.5 23.5 15 21 11 22Z" fill="#ff9f43"/>
<path d="M37 22C41 21 43.5 23 43.5 26C43.5 29 41 31 37 30V37a2 2 0 0 1-2 2H13a2 2 0 0 1-2-2V35H33V22Z" fill="#e07b1f" opacity=".9"/>
<path d="M13.5 20V15.5H19.5" stroke="#ffd2a3" stroke-width="1.5" fill="none" stroke-linecap="round"/>
<path d="M24 31.5C21.8 29.7 20.2 28.4 20.2 26.6C20.2 25.3 21.2 24.4 22.4 24.4C23.1 24.4 23.6 24.8 24 25.4C24.4 24.8 24.9 24.4 25.6 24.4C26.8 24.4 27.8 25.3 27.8 26.6C27.8 28.4 26.2 29.7 24 31.5Z" fill="#fff4e6"/>
${sparkle(40, 8, 3.4)}`,
  helper: () => `
<path d="M24 9a15 15 0 1 0 .01 0Z M24 17.2a6.8 6.8 0 1 0 .01 0Z" fill="#ff4d5e" fill-rule="evenodd"/>
<circle cx="24" cy="24" r="10.9" fill="none" stroke="#ffffff" stroke-width="8.2" stroke-dasharray="8.56 8.56" stroke-dashoffset="4.28" transform="rotate(45 24 24)"/>
<path d="M24 9a15 15 0 0 1 15 15" stroke="#d93445" stroke-width="0" fill="none"/>
<path d="M24 39a15 15 0 0 0 15-15" stroke="#000" stroke-opacity=".14" stroke-width="3" fill="none" transform="translate(-1.2 -1.2)"/>
<circle cx="24" cy="24" r="14.4" fill="none" stroke="#b82a3a" stroke-width="1.2"/>
<circle cx="24" cy="24" r="7.4" fill="none" stroke="#b82a3a" stroke-width="1.2"/>
<path d="M13 18C14.6 14.2 17.6 11.6 21.4 10.6" stroke="#ffd0d6" stroke-width="1.6" fill="none" stroke-linecap="round"/>
${sparkle(40.5, 8, 3.4)}`,
  // REC: a clip of yours watched together by 3+ people.
  premiere: () => `
<g transform="rotate(-10 24 24)">
<path d="M6.5 14H41.5V20.2A3.8 3.8 0 0 0 41.5 27.8V34H6.5V27.8A3.8 3.8 0 0 0 6.5 20.2Z" fill="#ff4d6d"/>
<path d="M6.5 25H41.5V27.8A3.8 3.8 0 0 0 41.5 34H6.5V27.8A3.8 3.8 0 0 0 6.5 25Z" fill="#d93450" opacity=".55"/>
<path d="M14 14V34" stroke="#ffd0da" stroke-width="1.3" stroke-dasharray="2 2"/>
<path d="M34 14V34" stroke="#ffd0da" stroke-width="1.3" stroke-dasharray="2 2"/>
<path d="M24 16.5L26.4 21.3L31.6 22L27.8 25.6L28.7 30.8L24 28.3L19.3 30.8L20.2 25.6L16.4 22L21.6 21.3Z" fill="#ffd23f"/>
<path d="M24 16.5L26.4 21.3L31.6 22L27.8 25.6L28.7 30.8L24 28.3Z" fill="#f2b51d"/>
<path d="M9 17.2H12" stroke="#ffd0da" stroke-width="1.4" stroke-linecap="round"/>
</g>
${sparkle(40.5, 8, 3.4)}${sparkle(8, 40.5, 2.6, '#ffe9a8')}`,
  // REC: a League pentakill caught on a recording (checked against Riot's match).
  pentakill: () => `
<circle cx="24" cy="25" r="16" fill="#3a2a6e"/>
<circle cx="24" cy="25" r="16" fill="none" stroke="#f5b935" stroke-width="2.4"/>
${[-56, -28, 0, 28, 56].map((a) => `<g transform="rotate(${a} 24 34)"><path d="M24 8.5L26 12V30H22V12Z" fill="#e8eef8"/><path d="M24 8.5L26 12V30H24Z" fill="#b9c4d6"/><rect x="20" y="29.5" width="8" height="2.2" rx="1" fill="#f5b935"/><rect x="23" y="31.5" width="2" height="4" rx=".8" fill="#8c560c"/></g>`).join('')}
<circle cx="24" cy="35" r="6.3" fill="#ff4d6d"/>
<circle cx="24" cy="35" r="6.3" fill="none" stroke="#f5b935" stroke-width="1.6"/>
<text x="24" y="38.6" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="10" fill="#fff">5</text>
${sparkle(40.5, 8, 3.6)}${sparkle(7.5, 9.5, 2.6, '#ffe9a8')}`,
};

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">${body.replace(/\n/g, '')}</svg>\n`;

const files = [];
for (const [cat, draw] of Object.entries(TIERED)) {
  TIERS.forEach((tier, t) => {
    const name = `${cat}-${tier.id}.svg`;
    writeFileSync(join(out, name), svg(tiered(draw, t)));
    files.push(name);
  });
}
for (const [id, draw] of Object.entries(SINGLE)) {
  writeFileSync(join(out, `${id}.svg`), svg(draw()));
  files.push(`${id}.svg`);
}

// Contact sheet: each badge at profile size (22 px), settings size (32 px) and big (96 px).
const rows = files
  .map((f) => `<div class="c"><img src="${f}" width="96"><img src="${f}" width="32"><img src="${f}" width="22"><span>${f.replace('.svg', '')}</span></div>`)
  .join('');
writeFileSync(
  join(out, 'sheet.html'),
  `<!doctype html><style>body{margin:0;padding:16px;background:#16171a;font:11px monospace;color:#8b8e97;display:grid;grid-template-columns:repeat(8,150px);gap:10px}.c{display:flex;flex-direction:column;align-items:center;gap:6px}</style>${rows}`,
);
console.log(files.length, 'files');
