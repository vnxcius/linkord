// Browser end-to-end test: two users exercise the main flows in the real UI.
//   LINKORD_TEST_URL=http://localhost:7701 CHROMIUM=/path/to/chrome node tests/ui.e2e.mjs [screenshot-dir]
// Needs a server with LINKORD_DEV_LOGIN=true (never production).
// While iterating: E2E_ONLY=<regex> runs only matching steps (plus the setup steps), E2E_FAILFAST=1 stops
// at the first failure, E2E_TIMEOUT=<ms> shortens Playwright's waits (tests/run-local.sh --ui does all three).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const BASE = process.env.LINKORD_TEST_URL ?? 'http://localhost:7701';
const SHOTS = process.argv[2];
const run = Math.random().toString(36).slice(2, 6);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const errors = [];
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY, 'i') : null;
const FAILFAST = !!process.env.E2E_FAILFAST;
const TIMEOUT = Number(process.env.E2E_TIMEOUT) || 0;
/** Steps the others build on (a shared server with both users in it). */
const SETUP = /^(create a server from the UI|second user joins with an invite)$/;
let failed = false;
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
/** Waits until a canvas shows a picture (any non-black pixel), so a newly mounted player isn't left blank. */
const waitForPicture = (page, selector) =>
  page.waitForFunction(
    (sel) => {
      const c = document.querySelector(sel);
      if (!c?.width) return false;
      const t = document.createElement('canvas');
      t.width = 32;
      t.height = 18;
      const g = t.getContext('2d');
      g.drawImage(c, 0, 0, 32, 18);
      return g.getImageData(0, 0, 32, 18).data.some((v, i) => i % 4 !== 3 && v > 40);
    },
    selector,
    { timeout: 5000 },
  );
const toSec = (m) => m.split(':').reduce((s, x) => s * 60 + +x, 0);
const step = async (name, fn) => {
  if (name !== 'no uncaught page errors' && ((ONLY && !ONLY.test(name) && !SETUP.test(name)) || (FAILFAST && failed))) return;
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (e) {
    const waiting = e.message.split('\n').find((l) => /waiting for|locator\(/.test(l));
    console.log(`✘ ${name}: ${e.message.split('\n')[0]}${waiting ? ` (${waiting.trim()})` : ''}`);
    process.exitCode = 1;
    failed = true;
    // With a screenshot dir, keep what both users saw when a step failed.
    const slug = name.replace(/\W+/g, '-').slice(0, 40);
    await Promise.all([shot(a?.page, `fail-${slug}-a`), shot(b?.page, `fail-${slug}-b`)].map((p) => p?.catch(() => {})));
  }
};

async function user(name, prefs) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'] });
  if (TIMEOUT) ctx.setDefaultTimeout(TIMEOUT);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.text().includes('noise suppression unavailable') && errors.push(`${name}: ${m.text()}`));
  await page.goto(BASE);
  if (prefs) {
    await page.evaluate((p) => localStorage.setItem('linkord.prefs', JSON.stringify(p)), prefs);
    await page.reload();
  }
  await page.fill('.dev-login input', `${name}.${run}`);
  await page.click('.dev-login button');
  await page.waitForSelector('.layout');
  return { page, name: `${name}.${run}` };
}

// The fake microphone plays a steady tone. Aria uses the browser's standard noise suppression so the
// tone gets through; Bram uses the default RNNoise, which should treat that tone as noise.
const a = await user('aria', { noiseMode: 'standard' });
const b = await user('bram');

await step('create a server from the UI', async () => {
  await a.page.click('[aria-label="Add a server"]');
  await a.page.fill('.modal .icon-upload .field input', `Keep ${run}`);
  await a.page.click('.modal button.primary');
  await a.page.waitForSelector('.chat-header h2:has-text("general")');
  await a.page.waitForSelector(`.rail-btn[aria-label="Keep ${run}"]`);
});

await step('second user joins with an invite', async () => {
  await a.page.click('.guild-header');
  await a.page.click('.context-menu button:has-text("Invite People")');
  await a.page.waitForFunction(() => document.querySelector('.copy-row input')?.value.includes('/invite/'));
  const link = await a.page.inputValue('.copy-row input');
  await a.page.keyboard.press('Escape');
  // Escape usually closed it already; don't sit out the 30 s default waiting for the button.
  await a.page.click('.modal-close', { timeout: 1000 }).catch(() => {});
  await b.page.click('[aria-label="Add a server"]');
  await b.page.fill('.modal form:nth-of-type(2) input', link);
  await b.page.click('.modal form:nth-of-type(2) button');
  await b.page.click('.modal button.primary:has-text("Accept invite")');
  await b.page.waitForSelector('.chat-header h2:has-text("general")');
});

await step('nameplates: a WebM default plays behind your name in everyone\'s member list', async () => {
  const webm = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=264x48:d=2', '-c:v', 'libvpx-vp9', '-f', 'webm', 'pipe:1']);
  fs.writeFileSync(path.join(process.env.LINKORD_TEST_DATA_DIR, 'nameplates', 'zz-e2e.webm'), webm);
  await a.page.click('[aria-label="Settings"]');
  await a.page.click('.settings-nav button:has-text("Profile")');
  // Picker videos only load while on screen; data-src says which nameplate each one is.
  await a.page.click('.nameplate-option:has(video[data-src$="zz-e2e.webm"])');
  await a.page.waitForSelector('.nameplate-option.current:has(video[data-src$="zz-e2e.webm"])');
  await a.page.click('.settings-close');
  const plate = `.members .member:has-text("${a.name}") video.nameplate[src$="zz-e2e.webm"]`;
  const video = await b.page.waitForSelector(plate);
  await b.page.waitForFunction((v) => !v.paused && v.currentTime > 0, video, { timeout: 8000 });
  await shot(b.page, 'e2e-nameplate-video');
});

await step('profile: click the picture to set a GIF (stays animated), × removes it; change the username in My Account', async () => {
  const gif = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=200x150:rate=10', '-t', '1', '-f', 'gif', 'pipe:1']);
  await a.page.click('[aria-label="Settings"]');
  await a.page.click('.settings-nav button:has-text("Profile")');
  // Only the nameplate keeps an upload row; the picture and banner are changed by clicking them.
  assert.equal(await a.page.locator('.image-slot').count(), 1);
  await a.page.locator('.edit-avatar input[type=file]').setInputFiles({ name: 'a.gif', mimeType: 'image/gif', buffer: gif });
  await a.page.waitForSelector('.img-editor:has-text("GIFs stay animated")');
  await a.page.click('.img-editor .btn.primary');
  await a.page.waitForSelector('.img-editor', { state: 'detached', timeout: 15000 });
  await a.page.waitForSelector('.edit-avatar img[src$=".webp"]');
  await shot(a.page, 'e2e-profile-gif');
  await a.page.click('.edit-avatar-wrap .edit-remove');
  await a.page.waitForSelector('.edit-avatar-wrap .edit-remove', { state: 'detached' });

  await a.page.click('.settings-nav button:has-text("My Account")');
  const renamed = `${a.name}_x`;
  for (const name of [renamed, a.name]) {
    await a.page.click('.username-row button:has-text("Edit")');
    await a.page.fill('.username-input input', name);
    await a.page.click('.username-form button.primary');
    await a.page.waitForSelector(`.account-names span:text-is("@${name}")`);
  }
  await a.page.click('.settings-close');
});

await step('messages, link preview, reactions via context menu', async () => {
  await a.page.fill('.composer textarea', 'Map of the ruins https://example.com');
  await a.page.keyboard.press('Enter');
  await b.page.waitForSelector('.message:has-text("Map of the ruins")');
  await b.page.waitForSelector('.embed .embed-title', { timeout: 10000 }).catch(() => console.log('  (link preview skipped: no internet from server?)'));
  await b.page.click('.message:has-text("Map of the ruins")', { button: 'right' });
  await b.page.click('.menu-reactions button >> nth=1');
  await a.page.waitForSelector('.message:has-text("Map of the ruins") .reaction');
  // Emoji come from the bundled Twemoji font, so they look the same on every OS.
  await a.page.fill('.composer textarea', 'Emoji check 😀 1️⃣ 🏳️‍🌈 ❤️‍🔥');
  await a.page.keyboard.press('Enter');
  await b.page.waitForSelector('.message:has-text("Emoji check")');
  const loaded = await b.page.evaluate(async () => (await document.fonts.load('16px "Linkord Twemoji"', '😀')).length);
  assert.ok(loaded > 0, 'Twemoji font did not load');
  await shot(b.page, 'e2e-emoji');
});

await step('pin a message and see it in the pins panel', async () => {
  await a.page.click('.message:has-text("Map of the ruins")', { button: 'right' });
  await a.page.click('.context-menu button:has-text("Pin Message")');
  await a.page.click('[aria-label="Pinned messages"]');
  await a.page.waitForSelector('.side-panel .result-card:has-text("Map of the ruins")');
  await shot(a.page, 'e2e-pins');
  await a.page.click('.side-panel [aria-label="Close"]');
});

await step('forward a message with a comment; the copy links back to the original', async () => {
  await b.page.click('.message:has-text("Map of the ruins") >> nth=0', { button: 'right' });
  await b.page.click('.context-menu button:has-text("Forward")');
  await b.page.waitForSelector('.modal h2:has-text("Forward To")');
  await b.page.fill('.modal-body .filter-input', 'general');
  await b.page.click('.forward-list .pick-row:has-text("#general") input');
  await b.page.fill('.forward-footer .filter-input', 'look at this');
  await b.page.click('.forward-footer button.primary');
  await b.page.waitForSelector('.modal', { state: 'detached' });
  const copy = a.page.locator('.message:has(.forwarded:has-text("Map of the ruins"))');
  await copy.waitFor();
  await a.page.waitForSelector('.message .content:has-text("look at this")');
  assert.equal(await copy.locator('.forwarded-label').innerText(), 'Forwarded');
  await shot(a.page, 'e2e-forward');
  await copy.locator('.forwarded-link').click();
  await a.page.waitForSelector('.message.highlight:has-text("Map of the ruins")');
});

await step('hover toolbar draws over the message above it', async () => {
  await a.page.fill('.composer textarea', 'Second message for the toolbar');
  await a.page.keyboard.press('Enter');
  const msg = a.page.locator('.message:has-text("Second message for the toolbar")');
  await msg.hover();
  const bar = await msg.locator('.message-actions').boundingBox();
  const onTop = await a.page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.message-actions'), { x: bar.x + bar.width / 2, y: bar.y + 3 });
  assert.ok(onTop, 'toolbar top edge is covered (content-visibility clipping?)');
});

await step('chat: sending jumps to the bottom, reply/edit/upload focus the composer, bulk delete', async () => {
  const pg = b.page;
  const composerFocused = () => pg.evaluate(() => document.activeElement?.matches('.composer textarea'));
  for (let i = 1; i <= 4; i++) {
    await pg.fill('.composer textarea', `tall ${i}\n` + Array.from({ length: 14 }, (_, j) => `line ${j}`).join('\n'));
    await pg.keyboard.press('Enter');
    await pg.waitForSelector(`.message:has-text("tall ${i}"):not(.pending)`);
  }
  await pg.evaluate(() => (document.querySelector('.messages').scrollTop = 0));
  await pg.waitForTimeout(300);
  await pg.fill('.composer textarea', 'bottom check');
  await pg.keyboard.press('Enter');
  await pg.waitForSelector('.message:has-text("bottom check")');
  await pg.waitForFunction(() => {
    const s = document.querySelector('.messages');
    return s.scrollHeight - s.scrollTop - s.clientHeight < 60;
  }, null, { timeout: 3000 });

  await pg.click('.messages-inner');
  const tall = pg.locator('.message:has-text("tall 2")');
  await tall.hover();
  await tall.locator('[data-tip="Reply"]').click();
  assert.ok(await composerFocused(), 'reply should focus the composer');
  await pg.keyboard.press('Escape');

  await tall.hover();
  await tall.locator('[data-tip="Edit"]').click();
  // The edit box takes focus a tick after it appears; Escape before that never reaches it.
  await pg.waitForFunction(() => document.activeElement?.closest('.edit-box'));
  await pg.keyboard.press('Escape');
  assert.ok(await composerFocused(), 'cancelling an edit should focus the composer');
  assert.equal(await pg.locator('.edit-box').count(), 0);
  await pg.click('.composer textarea');
  await pg.keyboard.press('ArrowUp');
  await pg.waitForSelector('.edit-box textarea');
  assert.notEqual(await pg.inputValue('.edit-box textarea'), '', '↑ should open the last message with its text');
  await pg.waitForFunction(() => document.activeElement?.closest('.edit-box'));
  await pg.keyboard.press('Escape');
  await pg.waitForSelector('.edit-box', { state: 'detached' });

  await pg.click('.messages-inner');
  await pg.locator('.composer-wrap input[type=file]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  assert.ok(await composerFocused(), 'picking a file should focus the composer');
  await pg.click('.upload-chip [aria-label="Remove"]');

  await pg.click('.message:has-text("tall 1")', { button: 'right' });
  await pg.click('.context-menu button:has-text("Select Messages")');
  await pg.click('.message:has-text("tall 3")', { modifiers: ['Shift'] });
  await pg.waitForSelector('.selection-count strong:has-text("3")');
  await pg.click('.message:has-text("tall 2")');
  await pg.waitForSelector('.selection-count strong:has-text("2")');
  await pg.click('.selection-bar .btn.danger');
  await pg.click('.modal .btn.danger');
  await pg.waitForFunction(() => ![...document.querySelectorAll('.message')].some((m) => /tall [13]\b/.test(m.textContent)));
  await a.page.waitForFunction(() => ![...document.querySelectorAll('.message')].some((m) => /tall [13]\b/.test(m.textContent)));
  assert.equal(await pg.locator('.message:has-text("tall 2")').count(), 1, 'deselected message stays');
  await pg.waitForSelector('.composer textarea');
});

await step('channels: categories, drag to reorder and between categories, Move Up, collapse', async () => {
  const textCat = '.channel-group:has(.category-title:has-text("Text Channels"))';
  await a.page.click(`${textCat} [aria-label="Create channel"]`);
  await a.page.fill('.modal input', 'lore');
  await a.page.click('.modal button.primary');
  await b.page.waitForSelector('.channel-item:has-text("lore")');
  await a.page.waitForSelector('.channel-item:has-text("lore")');
  const order = (pg) => pg.$$eval(`${textCat} .channel-item:not(.thread-item) .channel-name`, (els) => els.map((e) => e.textContent));
  assert.deepEqual((await order(a.page)).slice(0, 2), ['general', 'lore']);
  await a.page.dragAndDrop('.channel-item:has-text("lore")', '.channel-item:has-text("general")', { targetPosition: { x: 20, y: 3 } });
  const firstIn = (cat) => [...document.querySelectorAll('.channel-group')].find((g) => g.querySelector('.category-title')?.textContent.includes(cat))?.querySelector('.channel-item .channel-name')?.textContent;
  await b.page.waitForFunction(`(${firstIn})('Text Channels') === 'lore'`);
  await a.page.click('.channel-item:has-text("general")', { button: 'right' });
  await a.page.click('.context-menu button:has-text("Move Up")');
  await b.page.waitForFunction(`(${firstIn})('Text Channels') === 'general'`);

  // A new category; drop "lore" on its header to move it in.
  await a.page.click('.guild-header');
  await a.page.click('.context-menu button:has-text("Create Category")');
  await a.page.fill('.modal input', 'Quests');
  await a.page.click('.modal button.primary');
  await a.page.dragAndDrop('.channel-item:has-text("lore")', '.category-title:has-text("Quests")');
  const quests = '.channel-group:has(.category-title:has-text("Quests"))';
  await b.page.waitForSelector(`${quests} .channel-item:has-text("lore")`);
  // Collapsing hides its channels (except the open one); it syncs to your other devices.
  await a.page.click('.channel-item:has-text("general")');
  await a.page.click('.category-title:has-text("Quests")');
  await a.page.waitForSelector(`${quests} .channel-item:has-text("lore")`, { state: 'detached' });
  await a.page.click('.category-title:has-text("Quests")');
  await a.page.waitForSelector(`${quests} .channel-item:has-text("lore")`);
  await a.page.click('.channel-item:has-text("general")');
});

await step('Escape marks the channel read and removes the "new" divider', async () => {
  // Aria has read #general up to here.
  await b.page.click('.channel-item:has-text("general")');
  await b.page.fill('.composer textarea', 'Read before');
  await b.page.keyboard.press('Enter');
  await a.page.click('.channel-item:has-text("general")');
  await a.page.waitForSelector('.message:has-text("Read before")');
  await a.page.keyboard.press('Escape');
  await a.page.click('.channel-item:has-text("lore")');
  await b.page.fill('.composer textarea', 'Unread check');
  await b.page.keyboard.press('Enter');
  await a.page.waitForSelector('.channel-item.unread:has-text("general")');
  await a.page.click('.channel-item:has-text("general")');
  await a.page.waitForSelector('.unread-divider');
  await a.page.keyboard.press('Escape');
  await a.page.waitForSelector('.unread-divider', { state: 'detached', timeout: 2000 });
  // The read state reached the server: leaving and coming back shows no divider.
  await a.page.click('.channel-item:has-text("lore")');
  await a.page.click('.channel-item:has-text("general")');
  await a.page.waitForSelector('.message:has-text("Unread check")');
  assert.equal(await a.page.locator('.unread-divider').count(), 0);
});

await step('start a thread from a message', async () => {
  await a.page.hover('.message:has-text("Map of the ruins")');
  await a.page.click('.message:has-text("Map of the ruins") [data-tip="Create thread"]');
  await a.page.waitForSelector('.chat-header .crumb');
  await a.page.fill('.composer textarea', 'Meet at the old well');
  await a.page.keyboard.press('Enter');
  await b.page.waitForSelector('.thread-item');
  await shot(a.page, 'e2e-thread');
  await a.page.click('.crumb');
});

await step('search with prefix matching', async () => {
  await a.page.fill('.search-box input', 'rui');
  await a.page.keyboard.press('Enter');
  await a.page.waitForSelector('.side-panel .result-card:has-text("ruins")');
  await a.page.click('.side-panel [aria-label="Close"]');
});

await step('voice messages: click to record hands-free, listen back, send; hold to send, slide to cancel; play at 1.5×', async () => {
  await a.page.click('.channel-item:has-text("general")');
  await b.page.click(`.rail-btn[aria-label="Keep ${run}"]`);
  await b.page.click('.channel-item:has-text("general")');
  // A mouse click records hands-free (WhatsApp Web); pause, listen back, then send.
  await a.page.click('.composer-mic');
  await a.page.waitForSelector('.rec-bar.locked');
  await a.page.waitForTimeout(1500);
  await shot(a.page, 'e2e-voice-recording');
  await a.page.click('.rec-pause');
  await a.page.click('.rec-play');
  await a.page.waitForSelector('.rec-play[aria-label="Pause"]');
  await shot(a.page, 'e2e-voice-paused');
  await a.page.click('.rec-send');
  await b.page.waitForSelector('.voice-note');
  // The server rewrites the browser's WebM as seekable Ogg.
  assert.match(await b.page.$eval('.voice-note audio', (el) => el.src), /\.ogg$/);
  await b.page.click('.voice-note .vn-play');
  await b.page.waitForSelector('.voice-note.playing .vn-speed');
  await shot(b.page, 'e2e-voice-playing');
  await b.page.click('.vn-speed');
  assert.equal((await b.page.textContent('.vn-speed')).trim(), '1.5×');
  await b.page.click('.voice-note .vn-play');
  await b.page.waitForSelector('.voice-note .vn-mic.heard');

  const mic = await b.page.locator('.composer-mic').boundingBox();
  const hold = async (dx) => {
    await b.page.mouse.move(mic.x + mic.width / 2, mic.y + mic.height / 2);
    await b.page.mouse.down();
    await b.page.waitForSelector('.rec-bar.holding');
    await b.page.waitForTimeout(1300);
    if (!dx) await shot(b.page, 'e2e-voice-holding');
    if (dx) await b.page.mouse.move(mic.x + mic.width / 2 + dx, mic.y + mic.height / 2, { steps: 8 });
    await b.page.mouse.up();
  };
  await hold(-160); // slid left: cancelled
  await hold(0); // released: sent
  await a.page.waitForFunction(() => document.querySelectorAll('.voice-note').length === 2);
  await b.page.waitForTimeout(300);
  assert.equal(await b.page.locator('.voice-note').count(), 2);
  await shot(b.page, 'e2e-voice-messages');
});

await step('roles: server settings, create a colored hoisted role, add a member; remove it with × on the user card', async () => {
  await a.page.click('.guild-header');
  await a.page.click('.context-menu button:has-text("Server Settings")');
  await a.page.click('.settings-nav button:has-text("Roles")');
  await a.page.click('.settings-content button:has-text("Create Role")');
  await a.page.fill('.role-editor input[maxlength="100"]', 'Ranger');
  await a.page.click('.role-color:nth-child(3)');
  await a.page.click('.toggle-row:has-text("Display role members separately")');
  await a.page.waitForSelector('.save-bar');
  await shot(a.page, 'e2e-roles');
  await a.page.click('.save-bar .btn.primary');
  await a.page.waitForSelector('.role-side-row:has-text("Ranger")');
  await a.page.waitForSelector('.save-bar', { state: 'detached' });
  await a.page.click('.role-tabs button:has-text("Manage Members")');
  await a.page.click('button:has-text("Add Members")');
  await a.page.click(`.context-menu button:has-text("${b.name}")`);
  await a.page.waitForSelector(`.member-admin-row:has-text("${b.name}")`);
  await a.page.keyboard.press('Escape');
  await a.page.waitForSelector('.settings-screen', { state: 'detached' });
  await a.page.waitForSelector('.members .group-title:has-text("Ranger")');
  // The user card's role list: hover the role and click its × to take it away.
  await a.page.click(`.members .member:has-text("${b.name}")`);
  await a.page.hover('.profile-card .role-pill:has-text("Ranger")');
  await a.page.click('.profile-card .role-pill:has-text("Ranger") .role-remove');
  await a.page.waitForSelector('.members .group-title:has-text("Ranger")', { state: 'detached' });
  // ...and "+" gives it back.
  await a.page.click('.profile-card .role-add');
  await a.page.click('.context-menu button:has-text("Ranger")');
  await a.page.waitForSelector('.members .group-title:has-text("Ranger")');
  await a.page.keyboard.press('Escape');
  await a.page.mouse.click(700, 400);
});

await step('friends: request by username and accept', async () => {
  await b.page.click('.rail-item:first-child .rail-btn');
  await b.page.click('.tabs .add-friend-tab');
  await b.page.fill('.add-friend-box input', a.name);
  await b.page.click('.add-friend-box button');
  await b.page.waitForSelector('.add-friend .success');
  await a.page.click('.rail-item:first-child .rail-btn');
  await a.page.click('.tabs button:has-text("Pending")');
  await a.page.click(`.friend-row:has-text("${b.name}") .accept`);
  await a.page.click('.tabs button:has-text("All")');
  await a.page.waitForSelector(`.friend-row:has-text("${b.name}")`);
  await shot(a.page, 'e2e-friends');
});

await step('spotify: connect in Settings → Connections; friends see "Listening to Spotify", the song card and Active Now', async () => {
  const play = (track) => fetch('http://localhost:7702/mock/playing', { method: 'POST', body: JSON.stringify({ track }) });
  await play(null);
  await a.page.click('[aria-label="Settings"]');
  await a.page.click('.settings-nav button:has-text("Connections")');
  // The button opens Spotify's consent page in a new tab; the fake one approves and returns to Linkord.
  const [consent] = await Promise.all([a.page.context().waitForEvent('page'), a.page.click('[aria-label="Connect Spotify"]')]);
  await consent.waitForURL(/\/api\/connections\/spotify\/callback/);
  assert.match(await consent.textContent('body'), /Mock Listener.*connected/);
  await consent.close();
  await a.page.waitForSelector('.conn-account:has-text("Mock Listener")');
  await shot(a.page, 'e2e-spotify-settings');
  await a.page.click('.settings-close');

  await play({ id: 'trk1', name: 'Song of the Wind', artists: ['Kaepora', 'Saria'], album: 'Ocarina Nights', duration_ms: 200000 });
  // b sees it on the friends page (row + Active Now) and on a's profile card.
  await b.page.click('.rail-item:first-child .rail-btn');
  await b.page.click('.tabs button:has-text("Online")');
  await b.page.waitForSelector(`.friend-row:has-text("${a.name}"):has-text("Listening to Spotify")`);
  await b.page.waitForSelector('.active-now .active-card:has-text("Song of the Wind")');
  await shot(b.page, 'e2e-spotify-active-now');
  await b.page.click(`.rail-btn[aria-label="Keep ${run}"]`);
  await b.page.waitForSelector(`.members .member:has-text("${a.name}") .activity-line:has-text("Listening to Spotify")`);
  await b.page.click(`.members .member:has-text("${a.name}")`);
  await b.page.waitForSelector('.profile-card .spotify-card:has-text("Song of the Wind")');
  assert.match(await b.page.textContent('.profile-card .spotify-card'), /Kaepora, Saria/);
  assert.match(await b.page.textContent('.profile-card .spotify-times'), /0:[2-4]\d.*3:20/);
  await b.page.waitForTimeout(300); // let the card's pop-in animation finish
  await shot(b.page, 'e2e-spotify-card');
  await b.page.keyboard.press('Escape');
  await b.page.mouse.click(700, 400);
  // Stopping playback clears it everywhere.
  await play(null);
  await b.page.waitForSelector(`.members .member:has-text("${a.name}") .activity-line`, { state: 'detached' });
});

await step('games: "Playing <game>" (as the Windows app reports it) shows in lists, Active Now and the profile, before Spotify', async () => {
  // The browser can't detect games, so report one the way the desktop app does.
  const play = (track) => fetch('http://localhost:7702/mock/playing', { method: 'POST', body: JSON.stringify({ track }) });
  const token = await a.page.evaluate(() => localStorage.getItem('linkord.token'));
  const playing = (method, body) =>
    fetch(`${BASE}/api/activities/playing`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  await play({ id: 'trk2', name: 'Gerudo Valley', artists: ['Koume'], duration_ms: 200000 });
  await playing('PUT', { application_id: '1158877933042143272', name: 'cs2', started_at: Date.now() - 65 * 60_000 });
  await b.page.waitForSelector(`.members .member:has-text("${a.name}") .activity-line:has-text("Playing Counter-Strike 2")`);
  await b.page.waitForSelector(`.members .member:has-text("${a.name}") .activity-badge .game-icon`);
  await b.page.click(`.members .member:has-text("${a.name}")`);
  await b.page.waitForSelector('.profile-card .game-card:has-text("Counter-Strike 2")');
  assert.match(await b.page.textContent('.profile-card .game-elapsed'), /1:0[4-6]:\d\d elapsed/);
  // Spotify is still there, under the game.
  await b.page.waitForSelector('.profile-card .spotify-card:has-text("Gerudo Valley")');
  await b.page.waitForTimeout(300);
  await shot(b.page, 'e2e-game-card');
  await b.page.keyboard.press('Escape');
  await b.page.mouse.click(700, 400);
  await b.page.click('.rail-item:first-child .rail-btn');
  await b.page.waitForSelector(`.friend-row:has-text("${a.name}"):has-text("Playing Counter-Strike 2")`);
  await b.page.waitForSelector('.active-now .active-card .game-card:has-text("Counter-Strike 2")');
  await shot(b.page, 'e2e-game-active-now');
  await playing('DELETE');
  await play(null);
  await b.page.waitForSelector('.active-now .active-card', { state: 'detached' });
  await b.page.click(`.rail-btn[aria-label="Keep ${run}"]`);
});

await step('custom status: set it from the status menu with an emoji; it replaces the activity line and shows on the profile', async () => {
  await a.page.click('.me-btn');
  await a.page.click('.context-menu button:has-text("Set Custom Status")');
  await a.page.click('.status-emoji-btn');
  // The picker floats over the dialog: nothing clips it and the grid shows under the search box.
  const box = await a.page.locator('.message-picker').boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height <= 860, `picker off screen: ${JSON.stringify(box)}`);
  const searchHeight = (await a.page.locator('.message-picker .emoji-search').boundingBox()).height;
  assert.ok(searchHeight < 60, `search box stretched to ${searchHeight}px`);
  const topmost = await a.page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.message-picker'), { x: box.x + 24, y: box.y + box.height - 20 });
  assert.ok(topmost, 'something covers the bottom of the picker');
  await a.page.fill('.message-picker .emoji-search', 'fire');
  await a.page.click('.message-picker .emoji-grid button >> nth=0');
  await a.page.fill('.status-input input', 'Exploring the ruins');
  await a.page.selectOption('.custom-status-modal select', '1h');
  await shot(a.page, 'e2e-custom-status-modal');
  await a.page.click('.modal-footer button:has-text("Save")');
  await a.page.waitForSelector('.me-names .custom-status:has-text("Exploring the ruins") .status-emoji');
  // Friends see it in place of "Playing ..." in the member list, and as a bubble on the profile.
  const token = await a.page.evaluate(() => localStorage.getItem('linkord.token'));
  await fetch(`${BASE}/api/activities/playing`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Some Game' }) });
  await b.page.click('.rail-item:first-child .rail-btn');
  await b.page.click('.tabs button:has-text("All")');
  await b.page.waitForSelector(`.friend-row:has-text("${a.name}") .custom-status:has-text("Exploring the ruins")`);
  await b.page.click(`.rail-btn[aria-label="Keep ${run}"]`);
  await b.page.waitForSelector(`.members .member:has-text("${a.name}") .activity-line .custom-status:has-text("Exploring the ruins")`);
  await b.page.waitForSelector(`.members .member:has-text("${a.name}") .activity-badge .game-icon`);
  await b.page.click(`.members .member:has-text("${a.name}")`);
  await b.page.waitForSelector('.profile-card .status-bubble:has-text("Exploring the ruins")');
  await b.page.waitForTimeout(300);
  await shot(b.page, 'e2e-custom-status-profile');
  await b.page.keyboard.press('Escape');
  await b.page.mouse.click(700, 400);
  // Clear it from the menu.
  await a.page.click('.me-btn');
  await a.page.waitForSelector('.context-menu .menu-custom-status');
  await a.page.waitForTimeout(250);
  await shot(a.page, 'e2e-custom-status-menu');
  await a.page.click('.context-menu [aria-label="Clear Custom Status"]');
  await a.page.waitForSelector('.me-names .custom-status', { state: 'detached' });
  await b.page.waitForSelector(`.members .member:has-text("${a.name}") .activity-line:has-text("Playing Some Game")`);
  await fetch(`${BASE}/api/activities/playing`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
});

await step('own user card: edit the custom status right in the bubble; the presence dot stays above "View profile"', async () => {
  for (const u of [a, b]) {
    await u.page.click(`.rail-btn[aria-label="Keep ${run}"]`);
    await u.page.click('.channel-item:has-text("general")');
  }
  await a.page.click(`.members .member:has-text("${a.name}")`);
  await a.page.click('.profile-card .status-bubble.mine .status-bubble-edit');
  await a.page.fill('.profile-card .status-bubble.editing input', 'Back in 5');
  await a.page.keyboard.press('Escape');
  // Escape only leaves editing.
  await a.page.waitForSelector('.profile-card .status-bubble.mine.empty');
  await a.page.click('.profile-card .status-bubble.mine .status-bubble-edit');
  await a.page.fill('.profile-card .status-bubble.editing input', 'Back in 5');
  await a.page.keyboard.press('Enter');
  await a.page.waitForSelector('.profile-card .status-bubble.mine:not(.empty):has-text("Back in 5")');
  await a.page.waitForSelector('.me-names .custom-status:has-text("Back in 5")');
  await b.page.waitForSelector(`.members .member:has-text("${a.name}") .custom-status:has-text("Back in 5")`);
  // Hovering the avatar: the dot is still what's on top at its center.
  await a.page.hover('.profile-card .profile-avatar');
  const onTop = await a.page.evaluate(() => {
    const r = document.querySelector('.profile-card .profile-avatar .presence').getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.classList.contains('presence');
  });
  assert.ok(onTop, 'the "View profile" overlay covers the presence dot');
  await shot(a.page, 'e2e-own-card-status');
  await a.page.hover('.profile-card .status-bubble.mine');
  await a.page.click('.profile-card .status-bubble-clear');
  await a.page.waitForSelector('.me-names .custom-status', { state: 'detached' });
  await a.page.keyboard.press('Escape');
});

await step('invites: invite a friend from the list; the DM shows an invite card whose Join button opens the server', async () => {
  await a.page.click('[aria-label="Add a server"]');
  await a.page.fill('.modal .icon-upload .field input', `Outpost ${run}`);
  await a.page.click('.modal button.primary:has-text("Create server")');
  await a.page.waitForSelector(`.rail-btn[aria-label="Outpost ${run}"]`);
  await a.page.click('.guild-header');
  await a.page.click('.context-menu button:has-text("Invite People")');
  await a.page.click(`.invite-friend:has-text("${b.name}") button:has-text("Invite")`);
  await a.page.waitForSelector(`.invite-friend:has-text("${b.name}") button:has-text("Sent")`);
  await a.page.keyboard.press('Escape');
  await b.page.click('[aria-label="Direct Messages"]');
  await b.page.click(`.dm-item:has-text("${a.name}")`);
  await b.page.waitForSelector(`.invite-card:has-text("Outpost ${run}")`);
  assert.equal(await b.page.locator('.invite-card .embed').count(), 0);
  await shot(b.page, 'e2e-invite-card');
  await b.page.click('.invite-card .invite-join');
  await b.page.waitForSelector(`.sidebar-title:has-text("Outpost ${run}")`);
  await b.page.click('[aria-label="Direct Messages"]');
  await b.page.waitForSelector('.invite-card .invite-join:has-text("Joined")');
});

await step('server folders: drop a server on another to make a folder, open it', async () => {
  await a.page.dragAndDrop(`.rail-item:has(.rail-btn[aria-label="Outpost ${run}"])`, `.rail-item:has(.rail-btn[aria-label="Keep ${run}"])`, { targetPosition: { x: 19, y: 19 } });
  await a.page.waitForSelector('.rail-folder');
  assert.equal(await a.page.locator(`.rail-btn[aria-label="Keep ${run}"]`).count(), 0, 'closed folder hides its servers');
  await a.page.click('.rail-folder .folder-btn');
  await a.page.waitForSelector(`.rail-folder.open .rail-btn[aria-label="Keep ${run}"]`);
  await shot(a.page, 'e2e-folder');
  await a.page.click(`.rail-btn[aria-label="Keep ${run}"]`);
});

await step('profile modal: avatar on the user card opens it, with mutual servers', async () => {
  await a.page.click(`.members .member:has-text("${b.name}")`);
  await a.page.click('.profile-card .profile-avatar');
  await a.page.waitForSelector('.profile-modal');
  await a.page.click('.profile-tabs button:has-text("Mutual Servers")');
  await a.page.waitForSelector(`.profile-list-row:has-text("Outpost ${run}")`);
  await shot(a.page, 'e2e-profile');
  await a.page.keyboard.press('Escape');
  await a.page.waitForSelector('.profile-modal', { state: 'detached' });
});

await step('voice settings show a live mic level', async () => {
  await a.page.click('[aria-label="Settings"]');
  await a.page.click('.settings-nav button:has-text("Voice & Video")');
  await a.page.waitForFunction(() => parseFloat(document.querySelector('.meter-fill')?.style.width ?? '0') > 1, null, { timeout: 8000 });
  await shot(a.page, 'e2e-voice-settings');
  await a.page.click('.settings-close');
});

await step('voice: both connect, hear each other, mute, per-user volume', async () => {
  for (const u of [a, b]) {
    await u.page.click(`.rail-btn[aria-label="Keep ${run}"]`);
    await u.page.click('.channel-item:has-text("Campfire")');
    await u.page.waitForSelector('.voice-status strong:has-text("Voice online")', { timeout: 15000 });
  }
  // Aria's tone reaches Bram.
  await b.page.waitForSelector(`.voice-tile.speaking:has-text("${a.name}")`, { timeout: 8000 });
  // Aria heard Bram join: the join sound file was loaded and decoded.
  await a.page.waitForFunction(() => performance.getEntriesByType('resource').some((e) => /\/join[^/]*\.(mp3|wav)/.test(e.name)), null, { timeout: 5000 });
  // Bram's RNNoise is running and keeps the tone (not speech) from opening his mic.
  await b.page.click('[aria-label="Settings"]');
  await b.page.click('.settings-nav button:has-text("Voice & Video")');
  await b.page.waitForSelector('.tag:has-text("RNNoise active")', { timeout: 10000 });
  await b.page.keyboard.press('Escape');
  await b.page.waitForSelector('.settings-screen', { state: 'detached' });
  await a.page.waitForTimeout(3000);
  assert.equal(await a.page.locator(`.voice-tile.speaking:has-text("${b.name}")`).count(), 0, 'RNNoise let a pure tone through');
  // The call timer is the call's age, the same for both (not each person's own time in it).
  const timer = async (u) => (await u.page.textContent('.channel-item:has-text("Campfire") .call-timer')).trim();
  const [ta, tb] = [await timer(a), await timer(b)];
  assert.ok(Math.abs(toSec(ta) - toSec(tb)) <= 1, `timers ${ta} vs ${tb}`);
  await a.page.click('[aria-label="Mute"]');
  await b.page.waitForSelector(`.voice-tile:not(.speaking):has-text("${a.name}") svg`, { timeout: 5000 });
  await a.page.click(`.voice-tile:has-text("${b.name}")`, { button: 'right' });
  await a.page.waitForSelector('.context-menu .uv');
  // Any whole percentage: typed into the number (the slider follows), kept when the menu opens again, 100% one click away.
  await a.page.fill('.uv-value input', '137');
  assert.equal(await a.page.inputValue('.uv-range'), '137');
  await shot(a.page, 'e2e-voice');
  await a.page.keyboard.press('Escape');
  await a.page.click(`.voice-tile:has-text("${b.name}")`, { button: 'right' });
  assert.equal(await a.page.inputValue('.uv-value input'), '137');
  await a.page.focus('.uv-range');
  await a.page.keyboard.press('ArrowRight');
  assert.equal(await a.page.inputValue('.uv-value input'), '138');
  await a.page.click('.uv-scale button:has-text("100%")');
  assert.equal(await a.page.inputValue('.uv-range'), '100');
  await a.page.keyboard.press('Escape');
});

await step('Kass, the music bot: "/" lists his commands; /play brings him into the call and everyone hears him; /stop', async () => {
  await a.page.click('.channel-item:has-text("general")');
  await a.page.fill('.composer textarea', '/');
  await a.page.waitForSelector('.autocomplete-title:has-text("Commands")');
  await a.page.waitForSelector('.autocomplete button:has-text("/play")');
  await a.page.keyboard.type('pl');
  await a.page.keyboard.press('Enter');
  assert.equal(await a.page.inputValue('.composer textarea'), '/play ');
  // tests/ytdlp-mock.sh stands in for YouTube: any search is an 8 s tone.
  await a.page.keyboard.type('never gonna give you up');
  await a.page.keyboard.press('Enter');
  const card = '.message:has(.bot-tag):has(.interaction-name:has-text("/play"))';
  await a.page.waitForSelector(`${card} .embed-title:has-text("Mock Song search")`, { timeout: 10000 });
  assert.equal(await a.page.inputValue('.composer textarea'), '', 'a command is not sent as a message');
  // Bram (still looking at the call) sees Kass's tile light up: the music reached his browser and was decoded.
  await b.page.waitForSelector('.voice-tile.speaking:has-text("Kass")', { timeout: 10000 });
  await shot(b.page, 'e2e-music');
  await shot(a.page, 'e2e-music-chat');
  await a.page.fill('.composer textarea', '/stop');
  await a.page.keyboard.press('Enter');
  await a.page.waitForSelector('.message:has-text("Stopped the music")');
  await b.page.waitForSelector('.voice-tile:has-text("Kass")', { state: 'detached', timeout: 5000 });
  await a.page.click('.channel-item:has-text("Campfire")');
});

await step('voice channel status: set it from the header; everyone sees it under the channel and in the header', async () => {
  await a.page.click('.chat-header .voice-status-btn:has-text("Set a channel status")');
  await a.page.fill('.voice-status-edit input', 'Dungeon run 🗡️');
  await a.page.keyboard.press('Enter');
  await a.page.waitForSelector('.chat-header .voice-status-btn .voice-status-text:has-text("Dungeon run")');
  await b.page.waitForSelector('.voice-channel:has-text("Campfire") .voice-status-line:has-text("Dungeon run")');
  await b.page.waitForSelector('.chat-header .voice-status-text:has-text("Dungeon run")');
  await shot(b.page, 'e2e-voice-channel-status');
  // Escape leaves editing without saving; clearing it removes the line for everyone.
  await b.page.click('.chat-header .voice-status-btn');
  await b.page.fill('.voice-status-edit input', 'nope');
  await b.page.keyboard.press('Escape');
  await b.page.waitForSelector('.chat-header .voice-status-text:has-text("Dungeon run")');
  await b.page.click('.chat-header .voice-status-btn');
  await b.page.fill('.voice-status-edit input', '');
  await b.page.keyboard.press('Enter');
  await a.page.waitForSelector('.voice-status-line', { state: 'detached' });
  await a.page.waitForSelector('.chat-header .voice-status-btn.empty');
});

await step('voice channel: hide the channel list from the header; watch together theater mode hides it too', async () => {
  const navShown = () => a.page.locator('.nav-pane').isVisible();
  await a.page.click('.chat-header [aria-label="Hide channel list"]');
  await a.page.waitForSelector('.layout.nav-hidden .nav-pane', { state: 'hidden' });
  await a.page.click('.chat-header [aria-label="Show channel list"]');
  await a.page.waitForSelector('.nav-pane', { state: 'visible' });

  const token = await a.page.evaluate(() => localStorage.getItem('linkord.token'));
  const channelId = a.page.url().split('/').pop();
  const watch = (method, body) =>
    fetch(`${BASE}/api/channels/${channelId}/watch`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  assert.equal((await watch('PUT', { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' })).status, 200);
  await a.page.click('.watch-invite button:has-text("Watch together")');
  await a.page.click('.watch-bar [aria-label="Theater mode"]');
  await a.page.waitForSelector('.watch-party.expanded');
  await a.page.waitForSelector('.nav-pane', { state: 'hidden' });
  // The header's own button steps aside while theater mode has the list hidden.
  assert.equal(await a.page.locator('.chat-header [aria-label="Show channel list"]').count(), 0);
  await shot(a.page, 'e2e-watch-theater');
  await a.page.click('.watch-bar [aria-label="Exit theater mode"]');
  await a.page.waitForSelector('.nav-pane', { state: 'visible' });
  assert.ok(await navShown());
  // The soundboard from the voice panel reaches over the player: it must draw on top of it.
  await a.page.click('.dock .soundboard-toggle');
  const box = await a.page.locator('.soundboard').boundingBox();
  const player = await a.page.locator('.watch-host').boundingBox();
  const [x, y] = [box.x + box.width - 10, Math.max(box.y, player.y) + 20];
  assert.ok(x > player.x, 'the soundboard should overlap the player in this layout');
  assert.ok(await a.page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.soundboard'), [x, y]), 'soundboard is under the player');
  await a.page.keyboard.press('Escape');
  await watch('DELETE');
  await a.page.waitForSelector('.watch-party', { state: 'detached' });
});

await step('keybinds: Ctrl+Shift+M toggles mute; a recorded push-to-talk key opens the mic only while held', async () => {
  const muted = () => a.page.locator('[aria-label="Mute"].off').count();
  const before = await muted();
  await a.page.keyboard.press('Control+Shift+KeyM');
  await a.page.waitForFunction((n) => document.querySelectorAll('[aria-label="Mute"].off').length !== n, before);
  await a.page.keyboard.press('Control+Shift+KeyM');
  await a.page.waitForFunction((n) => document.querySelectorAll('[aria-label="Mute"].off').length === n, before);
  if (await muted()) await a.page.click('[aria-label="Mute"]');

  await a.page.click('[aria-label="Settings"]');
  await a.page.click('.settings-nav button:has-text("Keybinds")');
  await a.page.click('.add-kb');
  await a.page.keyboard.press('KeyV');
  await a.page.locator('.kb-row').last().locator('select').selectOption('ptt');
  await a.page.locator('.kb-row').last().locator('.key-recorder:has-text("V")').waitFor();
  await a.page.keyboard.press('Escape');
  // Push to talk is now the input mode: the steady tone no longer reaches Bram...
  await b.page.waitForSelector(`.voice-tile:not(.speaking):has-text("${a.name}")`, { timeout: 5000 });
  await a.page.keyboard.down('KeyV');
  await b.page.waitForSelector(`.voice-tile.speaking:has-text("${a.name}")`, { timeout: 5000 });
  await a.page.keyboard.up('KeyV');
  await b.page.waitForSelector(`.voice-tile:not(.speaking):has-text("${a.name}")`, { timeout: 5000 });

  await a.page.click('[aria-label="Settings"]');
  await a.page.click('.settings-nav button:has-text("Keybinds")');
  await a.page.locator('.kb-row').last().locator('[aria-label="Remove keybind"]').click();
  await a.page.keyboard.press('Escape');
});

await step('screen share: go live, LIVE badge, click name to watch, stats, hide strip, stop', async () => {
  await a.page.click('[data-tip="Share your screen"]');
  await a.page.click('.go-live .seg button:has-text("720p")');
  await a.page.click('.go-live .seg button:has-text("30 fps")');
  // Audio stays on: the fake capture has no audio track, so the streamer's readout says so.
  await a.page.click('.modal-footer button:has-text("Go Live")');
  await a.page.waitForSelector('.video-card.large video', { timeout: 10000 });
  // The viewer sees the LIVE badge and jumps straight into the stream by clicking the name.
  await b.page.waitForSelector(`.voice-user:has-text("${a.name}") .live-badge`, { timeout: 10000 });
  await b.page.click(`.voice-user:has-text("${a.name}")`);
  await b.page.waitForSelector('.video-card.large canvas');
  await b.page.waitForFunction(() => /\d+p \d+fps/.test(document.querySelector('.video-card.large .video-stats')?.textContent ?? ''), null, { timeout: 15000 });
  const stats = await b.page.textContent('.video-card.large .video-stats');
  console.log(`  viewer stats: ${stats}`);
  // Resolution and frame rate only; bitrate and codec are debug info now.
  assert.ok(!/Mbps|kbps|H\.264|VP[89]/.test(stats ?? ''), `stats still show bitrate/codec: ${stats}`);
  // The streamer's own tile carries the stream-audio diagnostics (Windows 10 echo investigation), shown from the
  // stream's right-click menu, which also changes the stream's settings live.
  await a.page.click('.video-card.large', { button: 'right' });
  await a.page.waitForSelector('.context-menu .menu-choice:has-text("1080p")');
  await a.page.click('.context-menu button:has-text("Show debug info")');
  const diag = await a.page.waitForSelector('.video-card.large .audio-diag', { state: 'attached', timeout: 5000 }).then((el) => el.textContent());
  assert.match(diag, /Stream audio: browser capture/);
  console.log(`  streamer audio: ${diag}`);
  // The streamer sees who's watching.
  await a.page.waitForSelector('.streaming-note:has-text("1 watching")', { timeout: 5000 });
  // Ping indicator has a real reading.
  await b.page.waitForSelector('.ping.good, .ping.ok, .ping.bad', { timeout: 8000 });
  await b.page.click('.ping');
  await b.page.waitForSelector('.ping-popover .ping-value:has-text("ms")');
  await b.page.click('.ping-popover');
  // Browsing elsewhere keeps the stream in a floating mini player.
  await b.page.click('.channel-item:has-text("general")');
  await b.page.waitForSelector('.mini-player canvas', { timeout: 5000 });
  await waitForPicture(b.page, '.mini-player canvas');
  await shot(b.page, 'e2e-mini-player');
  // Resizable from the top-left corner; a plain click goes back to the stream in the call.
  const w0 = await b.page.$eval('.mini-player', (el) => el.getBoundingClientRect().width);
  await b.page.hover('.mini-player');
  const corner = await b.page.$eval('.mini-resize', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + 6, y: r.y + 6 }; });
  await b.page.mouse.move(corner.x, corner.y);
  await b.page.mouse.down();
  await b.page.mouse.move(corner.x - 120, corner.y - 20, { steps: 5 });
  await b.page.mouse.up();
  const w1 = await b.page.$eval('.mini-player', (el) => el.getBoundingClientRect().width);
  assert.ok(w1 > w0 + 100, `mini player did not grow: ${w0} -> ${w1}`);
  await b.page.click('.mini-player canvas');
  await b.page.waitForSelector('.video-card.large canvas');
  // Switching what's shared keeps the stream (and the viewer) going.
  await a.page.click('.panel-btn:has-text("Switch")');
  await b.page.waitForTimeout(2500);
  assert.equal(await b.page.locator('.video-card.large canvas').count(), 1, 'viewer lost the stream on switch');
  assert.ok(/\d+fps/.test((await b.page.textContent('.video-card.large .video-stats')) ?? ''), 'no frames after switch');
  await b.page.click('.strip-toggle');
  await b.page.waitForSelector('.strip-wrap.hidden');
  await shot(b.page, 'e2e-stream-viewer');
  await shot(a.page, 'e2e-stream-owner');
  // Clicking the big stream goes back to the grid; the grid can show only streams or only people.
  await b.page.click('.video-card.large canvas');
  await b.page.waitForSelector('.grid-show');
  await b.page.click('.grid-show button:has-text("Streams")');
  await b.page.waitForSelector('.stream-grid .video-card canvas');
  await waitForPicture(b.page, '.stream-grid .video-card canvas');
  assert.equal(await b.page.locator('.voice-tile').count(), 0, 'people shown in Streams view');
  await shot(b.page, 'e2e-stream-grid');
  await b.page.click('.grid-show button:has-text("People")');
  await b.page.waitForSelector('.voice-tile');
  assert.equal(await b.page.locator('.video-card').count(), 0, 'stream shown in People view');
  await b.page.click('.grid-show button:has-text("Everyone")');
  await b.page.waitForSelector('.voice-grid .video-card');
  // A small window: the stream's name, badges and buttons stay on one line.
  await b.page.setViewportSize({ width: 900, height: 640 });
  await b.page.hover('.voice-grid .video-card');
  const bar = await b.page.$eval('.voice-grid .video-card .video-overlay', (el) => ({ h: el.querySelector('.video-label').getBoundingClientRect().height, w: el.scrollWidth - el.clientWidth }));
  assert.ok(bar.h < 30 && bar.w <= 0, `stream overlay wraps or overflows: ${JSON.stringify(bar)}`);
  await shot(b.page, 'e2e-stream-small');
  await b.page.setViewportSize({ width: 1400, height: 860 });
  await a.page.click('.pill-btn:has-text("Stop streaming")');
  await b.page.waitForFunction(() => !document.querySelector('.video-card, .mini-player'), null, { timeout: 8000 }).catch(async (e) => {
    const html = await b.page.evaluate(() => document.querySelector('.video-card')?.outerHTML.slice(0, 200));
    const live = await b.page.locator('.live-badge').count();
    throw new Error(`${e.message.split('\n')[0]} | card: ${html} | live badges: ${live}`);
  });
  // Going live again doesn't silently send the new stream to last time's viewer.
  await a.page.click('[data-tip="Share your screen"]');
  await a.page.click('.modal-footer button:has-text("Go Live")');
  await a.page.waitForSelector('.video-card.large video', { timeout: 10000 });
  await b.page.waitForSelector(`.voice-user:has-text("${a.name}") .live-badge`, { timeout: 10000 });
  await a.page.waitForTimeout(1500);
  await a.page.waitForSelector('.streaming-note:has-text("0 watching")', { timeout: 5000 });
  await a.page.click('.pill-btn:has-text("Stop streaming")');
  await a.page.click('.voice-controls .hangup');
  await b.page.waitForFunction((n) => ![...document.querySelectorAll('.voice-user')].some((x) => x.textContent.includes(n)), a.name);
});

await step('reload keeps the channel in the URL and rejoins voice; leaving on purpose does not', async () => {
  await b.page.click('.channel-item:has-text("Campfire")');
  await b.page.waitForSelector('.voice-status strong:has-text("Voice online")', { timeout: 15000 });
  const url = b.page.url();
  assert.match(new URL(url).pathname, /^\/channels\/\d+\/\d+$/);
  await b.page.reload();
  await b.page.waitForSelector('.voice-status strong:has-text("Voice online")', { timeout: 15000 });
  assert.equal(b.page.url(), url);
  assert.equal(await b.page.locator('.channel-item.active:has-text("Campfire")').count(), 1);
  await b.page.click('[aria-label="Disconnect"]');
  await b.page.reload();
  await b.page.waitForSelector('.layout');
  await b.page.waitForTimeout(1000);
  assert.equal(await b.page.locator('.reconnect-banner').count(), 0);
});

await step('desktop app: dismissable banner, download page with this computer first, patch notes, "updated" banner; Back returns to the app', async () => {
  // A release in the test server's update feed (the browser here reports Linux, so the .deb/.rpm come first).
  const dir = path.join(process.env.LINKORD_TEST_DATA_DIR, 'updates');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Linkord_9.9.9_amd64.deb'), Buffer.alloc(3 * 1048576));
  fs.writeFileSync(path.join(dir, 'Linkord-9.9.9-1.x86_64.rpm'), Buffer.alloc(1024));
  fs.writeFileSync(path.join(dir, 'Linkord_9.9.9_x64-setup.exe'), Buffer.alloc(1024));
  const date = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'linux.json'), JSON.stringify({ version: '9.9.9', notes: 'x', pub_date: date, deb: 'Linkord_9.9.9_amd64.deb', rpm: 'Linkord-9.9.9-1.x86_64.rpm' }));
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({ version: '9.9.9', notes: 'x', pub_date: date, platforms: { 'windows-x86_64': { signature: 's', file: 'Linkord_9.9.9_x64-setup.exe' } } }));
  fs.writeFileSync(path.join(dir, 'changelog.json'), JSON.stringify([
    { version: '9.9.9', date, notes: 'First change\n- Second change' },
    { version: '9.9.8', date, notes: 'Older change' },
  ]));
  const c = await user('cleo', { lastSeenVersion: '0.0.1' });
  const pg = c.page;
  try {
    await pg.waitForSelector('.download-banner:has-text("Get the desktop app")');
    await pg.waitForSelector('.update-banner:has-text("Linkord was updated to")');
    await shot(pg, 'e2e-download-banner');
    await pg.click('.download-banner-btn');
    await pg.waitForSelector('.site-page .dl-primary a:has-text("Download .deb")');
    assert.equal(new URL(pg.url()).pathname, '/download');
    assert.match(await pg.getAttribute('.dl-primary a:has-text("Download .deb")', 'href'), /\/api\/updates\/download\/Linkord_9\.9\.9_amd64\.deb$/);
    assert.match(await pg.textContent('.dl-primary .dl-meta'), /Version 9\.9\.9 · 3\.0 MB/);
    await pg.waitForSelector('.dl-platform.mine:has-text("Linux")');
    await shot(pg, 'e2e-download-page');
    // "What's new" opens the patch notes; the browser's Back goes back to the download page.
    // Switching pages keeps the same frame (a new one faded in over the app, which flashed through).
    await pg.evaluate(() => (document.querySelector('.site-page').dataset.mark = 'same'));
    await pg.click('.dl-whats-new');
    await pg.waitForSelector('.notes-release.latest:has-text("9.9.9") li:has-text("Second change")');
    assert.equal(await pg.getAttribute('.site-page', 'data-mark'), 'same', 'the page frame was rebuilt');
    assert.equal(await pg.locator('.notes-release').count(), 2);
    assert.equal(new URL(pg.url()).pathname, '/changelog');
    await pg.goBack();
    await pg.waitForSelector('.dl-hero');
    await pg.click('.site-back');
    await pg.waitForSelector('.site-page', { state: 'detached' });
    assert.match(new URL(pg.url()).pathname, /^\/channels\//);
    // Seeing the patch notes retired the "updated" banner.
    await pg.waitForSelector('.update-banner:has-text("Linkord was updated to")', { state: 'detached' });
    // Opened straight from a link: Back to Linkord still lands in the app, even after switching pages.
    await pg.goto(`${BASE}/changelog`);
    await pg.waitForSelector('.notes-release');
    await pg.click('.site-links button:has-text("Download")');
    await pg.waitForSelector('.dl-hero');
    await pg.click('.site-back');
    await pg.waitForSelector('.site-page', { state: 'detached' });
    await pg.waitForSelector('.layout');
    // Dismissed for good on this device.
    await pg.click('.download-banner-close');
    await pg.waitForSelector('.download-banner', { state: 'detached' });
    await pg.reload();
    await pg.waitForSelector('.layout');
    await pg.waitForTimeout(800);
    assert.equal(await pg.locator('.download-banner').count(), 0);
  } finally {
    await pg.context().close();
  }
});

await step('narrow window: the member list opens as a drawer', async () => {
  await a.page.setViewportSize({ width: 900, height: 860 });
  await a.page.click('.rail-btn[aria-label="Keep ' + run + '"]');
  await a.page.click('.channel-item:has-text("general")');
  assert.equal(await a.page.locator('.members').count(), 0);
  await a.page.click('[aria-label="Member list"]');
  await a.page.waitForSelector('.members.drawer');
  // A member's user card opens on top of the drawer, not behind it.
  await a.page.click('.members.drawer .member');
  await a.page.waitForSelector('.profile-card');
  const onTop = await a.page.evaluate(() => {
    const r = document.querySelector('.profile-card').getBoundingClientRect();
    return !!document.elementFromPoint(r.left + r.width / 2, r.top + 40)?.closest('.profile-card');
  });
  assert.ok(onTop, 'user card is covered by the member drawer');
  await a.page.keyboard.press('Escape');
  await a.page.mouse.click(20, 400);
  if (await a.page.locator('.members.drawer').count()) await a.page.click('.drawer-backdrop', { position: { x: 20, y: 400 } });
  await a.page.waitForSelector('.members', { state: 'detached' });
  await a.page.setViewportSize({ width: 1400, height: 860 });
});

await step('phone layout: one pane at a time, back button, no sideways scrolling', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
  await pg.goto(BASE);
  await pg.fill('.dev-login input', `phone.${run}`);
  await pg.click('.dev-login button');
  await pg.waitForSelector('.sidebar');
  assert.equal(await pg.locator('.main').isVisible(), false, 'lists first');
  await pg.click('.friends-item');
  await pg.waitForSelector('.main .mobile-back');
  assert.equal(await pg.locator('.sidebar').isVisible(), false);
  await pg.click('.mobile-back');
  await pg.waitForSelector('.sidebar');
  assert.equal(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');

  // Own user card from the avatar in the user panel.
  await pg.tap('.me-avatar');
  await pg.waitForSelector('.profile-card');
  await pg.tap('.sidebar', { position: { x: 150, y: 120 } });
  await pg.waitForSelector('.profile-card', { state: 'detached' });

  // Swipes: real touch events, sideways from (x0, y) to (x1, y).
  const cdp = await ctx.newCDPSession(pg);
  const swipe = async (x0, x1, y) => {
    const at = (x) => [{ x, y, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(x0) });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(x0 + ((x1 - x0) * i) / 8) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const token = await pg.evaluate(() => localStorage.getItem('linkord.token'));
  await fetch(`${BASE}/api/guilds`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: `Swipe ${run}` }) });
  await pg.tap(`.rail-btn[aria-label="Swipe ${run}"]`);
  await pg.tap('.channel-item:has-text("general")');
  await pg.fill('.composer textarea', 'swipe me');
  await pg.keyboard.press('Enter');
  const msg = pg.locator('.message:has-text("swipe me")');
  await msg.waitFor();
  const box = await msg.boundingBox();
  await pg.keyboard.press('Escape');
  await swipe(300, 180, box.y + box.height / 2);
  await pg.waitForSelector('.reply-bar');
  await pg.tap('.reply-bar .icon-btn');
  // Left on the chat (not on a message): member list; tapping outside a member's card closes only the card; right closes the list.
  await swipe(300, 150, 300);
  await pg.waitForSelector('.members.drawer');
  await pg.tap('.members.drawer .member');
  await pg.waitForSelector('.profile-card');
  await pg.tap('.chat-header', { position: { x: 20, y: 20 }, force: true });
  await pg.waitForSelector('.profile-card', { state: 'detached' });
  assert.equal(await pg.locator('.members.drawer').count(), 1, 'tapping outside the card kept the member list open');
  await swipe(200, 360, 300);
  await pg.waitForSelector('.members.drawer', { state: 'detached' });
  // Right on the chat: back to the channel list; left there: back to the chat.
  await swipe(80, 300, 30);
  await pg.waitForSelector('.sidebar');
  await swipe(300, 80, 400);
  await pg.waitForSelector('.main .chat-header');
  await ctx.close();
});

await step('language: follows the browser (pt-BR), can be switched in settings; account stats show', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, locale: 'pt-BR' });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(`pt-BR: ${e.message}`));
  await pg.goto(BASE);
  await pg.waitForSelector('text=Reúna seu grupo.');
  await pg.fill('.dev-login input', `lang.${run}`);
  await pg.click('.dev-login button');
  await pg.waitForSelector('.layout');
  assert.equal(await pg.evaluate(() => document.documentElement.lang), 'pt-BR');
  await pg.waitForSelector('.sidebar-title:text("Mensagens diretas")');
  await pg.click('[aria-label="Configurações"]');
  await pg.waitForSelector('.settings-content h1:text("Minha conta")');
  await pg.waitForSelector('.stat-label:text("Tempo em chamadas")');
  await pg.waitForFunction(() => [...document.querySelectorAll('.stat strong')].every((s) => s.textContent !== '…'));
  await shot(pg, 'settings-account-pt');
  await pg.click('.settings-nav button:has-text("Idioma")');
  await shot(pg, 'settings-language-pt');
  await pg.click('.lang-row:has-text("English")');
  await pg.waitForSelector('.settings-content h1:text("Language")');
  await pg.waitForSelector('.settings-nav button:has-text("My Account")');
  assert.equal(await pg.evaluate(() => JSON.parse(localStorage.getItem('linkord.prefs')).language), 'en');
  await pg.click('.lang-row:has-text("System default")');
  await pg.waitForSelector('.settings-content h1:text("Idioma")');
  await ctx.close();
});

await step('logs page: an admin sees new lines appear live', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  if (TIMEOUT) ctx.setDefaultTimeout(TIMEOUT);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`logadmin: ${e.message}`));
  await page.goto(BASE);
  await page.fill('.dev-login input', 'logadmin');
  await page.click('.dev-login button');
  await page.waitForSelector('.layout');
  await page.goto(`${BASE}/logs`);
  await page.waitForSelector('.logs-live.on');
  const token = await a.page.evaluate(() => localStorage.getItem('linkord.token'));
  const report = () =>
    fetch(`${BASE}/api/logs/client`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ level: 'warn', message: `ui live ${run}` }) });
  // The page may still be connecting: report until a line shows up, without reloading.
  for (let i = 0; ; i++) {
    await report();
    const seen = await page.waitForSelector(`.log-row.fresh:has-text("ui live ${run}")`, { timeout: 1500 }).catch(() => null);
    if (seen) break;
    assert.ok(i < 8, 'no live line arrived');
  }
  await shot(page, 'e2e-logs-live');
  await ctx.close();
});

await step('no uncaught page errors', async () => assert.deepEqual(errors, [], errors.join('\n')));
await browser.close();
