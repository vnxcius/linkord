// The monitor (monitor/), against a throwaway app + monitor (tests/run-local.sh --monitor): login, live numbers, logs,
// moderation and removing media, then every tab in a browser.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';

const APP = process.env.LINKORD_TEST_URL ?? 'http://localhost:7701';
const MON = process.env.MONITOR_TEST_URL ?? 'http://localhost:7705';
const PASSWORD = process.env.MONITOR_TEST_PASSWORD ?? 'monitor-test-password';
const SHOTS = process.env.SHOTS;
const run = Math.random().toString(36).slice(2, 7);

let cookie = '';

async function mon(method, path, body, headers = {}) {
  const res = await fetch(`${MON}/api${path}`, {
    method,
    headers: { cookie, ...(method === 'POST' ? { 'content-type': 'application/json', 'x-monitor': '1' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data, res };
}
async function monOk(method, path, body) {
  const r = await mon(method, path, body);
  assert.equal(r.status, 200, `${method} ${path}: ${JSON.stringify(r.data)}`);
  return r.data;
}
async function app(token, method, path, body) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${APP}/api${path}`, { method, headers, body: payload });
  const text = await res.text();
  assert.ok(res.ok, `${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const until = async (what, fn, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

function upload(content, name, type, data) {
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({ content }));
  fd.append('files[0]', new Blob([data], { type }), name);
  return fd;
}

let owner, guild, general;

before(async () => {
  owner = await app(null, 'POST', '/auth/dev', { username: `mon${run}` });
  guild = await app(owner.token, 'POST', '/guilds', { name: `Moderated ${run}` });
  general = guild.channels.find((c) => c.kind === 0);
});

test('everything needs the password, and it is rate limited', async () => {
  assert.equal((await mon('GET', '/now')).status, 401);
  assert.equal((await mon('GET', '/moderation/media')).status, 401);
  assert.equal((await fetch(`${MON}/media/x/y.png`)).status, 401);
  assert.equal((await mon('GET', '/session')).data.signed_in, false);
  assert.equal((await mon('POST', '/login', { password: 'wrong' })).status, 401);

  const good = await mon('POST', '/login', { password: PASSWORD });
  assert.equal(good.status, 200);
  const set = good.res.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  cookie = set.split(';')[0];
  assert.equal((await mon('GET', '/session')).data.signed_in, true);
  assert.equal((await mon('GET', '/now')).status, 200);
});

test('anything that changes something needs a header other sites cannot send', async () => {
  const res = await fetch(`${MON}/api/moderation/media/remove`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('pages get security headers', async () => {
  const res = await fetch(`${MON}/`);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('the app has no public address for its counters', async () => {
  const res = await fetch(`${APP}/metrics`);
  assert.doesNotMatch(await res.text(), /in_flight/);
  const inner = process.env.LINKORD_INTERNAL_TEST_URL;
  if (inner) assert.equal((await fetch(`${inner}/metrics`)).status, 401, 'needs the token');
});

test('live numbers: the machine, the app and its checks', async () => {
  const now = await until('the first readings', async () => {
    const n = await monOk('GET', '/now');
    return n.app && n.checks.some((c) => c.last_run) ? n : null;
  });
  assert.ok(now.cpu.total != null);
  assert.ok(now.memory.total > 0);
  assert.ok(now.host.cores > 0);
  assert.ok(now.app.uptime_s >= 0);
  const byId = Object.fromEntries(now.checks.map((c) => [c.id, c]));
  for (const id of ['app', 'web', 'gateway', 'database', 'counters']) assert.notEqual(byId[id]?.status, 'down', `${id}: ${byId[id]?.detail}`);
  assert.equal(byId.internet, undefined, 'internet checks are off in tests');

  const sys = await monOk('GET', '/system');
  assert.ok(sys.top_cpu.length > 0);
  assert.ok(sys.disks.length > 0);
  assert.ok(sys.app_process?.pid, 'found the app process');
  assert.equal(sys.app_process.pid, sys.app.pid);

  // The app's own counters move.
  await app(owner.token, 'GET', `/channels/${general.id}/messages`);
  const routes = await until('the request in the counters', async () => {
    const list = (await monOk('GET', '/system')).app.http.routes;
    return list.some((r) => r.route === '/api/channels/:id/messages') ? list : null;
  });
  assert.ok(!routes.some((r) => /\d{6}/.test(r.route)), 'ids stay out of route names');
});

test('history: samples are saved and asked for by name', async () => {
  const s = await until('a saved sample', async () => {
    const v = await monOk('GET', '/series?keys=cpu,mem_used,nope&range=1h');
    return v.ts.length ? v : null;
  });
  assert.ok(s.series.cpu.avg.length > 0);
  assert.equal(s.series.nope, undefined);
  const a = await monOk('GET', '/availability');
  assert.ok(a.checks.length >= 5);
  assert.ok(a.history.today.app);
});

test('database: read through a connection that cannot write', async () => {
  const d = await monOk('GET', '/database');
  assert.equal(d.read_only, true);
  assert.ok(d.size > 0);
  assert.ok(d.tables.some((t) => t.name === 'messages'));
  assert.ok(d.migrations.applied > 0);
  assert.equal(d.migrations.failed, 0);
});

test('storage: disks and folders', async () => {
  const s = await monOk('GET', '/storage');
  assert.ok(s.disks.length > 0);
  assert.ok(s.data_disk?.total > 0, 'knows which disk holds the data');
});

test('logs: read from the files, filtered, and followed live', async () => {
  const token = owner.token;
  await app(token, 'POST', '/logs/client', { level: 'error', message: `boom ${run} 123` });
  const today = new Date().toISOString().slice(0, 10);
  const lines = await until('the line in the file', async () => {
    const r = await monOk('GET', `/logs?day=${today}&q=${encodeURIComponent(`boom ${run}`)}`);
    return r.lines.length ? r.lines : null;
  });
  assert.equal(lines[0].level, 'ERROR');
  assert.equal(lines[0].target, 'client');
  assert.ok((await monOk('GET', '/logs/days')).some((d) => d.day === today));
  assert.equal((await monOk('GET', `/logs?day=${today}&level=error&target=nothing-here`)).lines.length, 0);
  assert.equal((await mon('GET', '/logs?day=..%2F..%2Fsecret')).status, 400);
  const stats = await monOk('GET', `/logs/stats?day=${today}`);
  assert.ok(stats.errors >= 1);
  assert.ok(stats.problems.some((p) => p.msg.includes(`boom ${run}`)));

  // Live: new lines arrive as server-sent events.
  const ctrl = new AbortController();
  const res = await fetch(`${MON}/api/logs/live`, { headers: { cookie }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  await new Promise((r) => setTimeout(r, 200));
  await app(token, 'POST', '/logs/client', { level: 'warn', message: `live check ${run}` });
  let text = '';
  while (!text.includes(`live check ${run}`)) text += (await reader.read()).value;
  assert.match(text, /^data: \{/m);
  ctrl.abort();
});

test('moderation: how many servers, who created them, who is in them', async () => {
  const sum = await monOk('GET', '/moderation/summary');
  assert.ok(sum.servers >= 1);
  assert.ok(sum.accounts >= 1);
  const { servers } = await monOk('GET', `/moderation/servers?q=${encodeURIComponent(`Moderated ${run}`)}`);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].owner.username, `mon${run}`);
  assert.ok(servers[0].members >= 1);
  assert.equal(servers[0].id, guild.id);
  const detail = await monOk('GET', `/moderation/servers/${guild.id}`);
  assert.ok(detail.members.some((m) => m.username === `mon${run}` && m.owner));
  assert.ok(detail.channels.some((c) => c.id === general.id));
  const { accounts } = await monOk('GET', `/moderation/accounts?q=mon${run}`);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].servers_owned, 1);
  assert.equal(JSON.stringify(detail).includes('content'), false, 'message text is not part of this');
});

async function findMedia(params) {
  const r = await monOk('GET', `/moderation/media?${new URLSearchParams(params)}`);
  return r;
}

test('media: every upload is listed with who and where, and served safely', async () => {
  const pic = await app(owner.token, 'POST', `/channels/${general.id}/messages`, upload(`look ${run}`, `cat-${run}.png`, 'image/png', PNG));
  const page = await app(owner.token, 'POST', `/channels/${general.id}/messages`, upload('', `page-${run}.html`, 'text/html', '<script>alert(1)</script>'));
  const { items, total } = await findMedia({ q: `cat-${run}` });
  assert.equal(total, 1);
  const m = items[0];
  assert.equal(m.kind, 'attachment');
  assert.equal(m.class, 'image');
  assert.equal(m.username, `mon${run}`);
  assert.equal(m.server, `Moderated ${run}`);
  assert.equal(m.channel, general.name);
  assert.equal(m.size, PNG.length);
  assert.equal(m.item_id, pic.id);

  // Filters
  assert.equal((await findMedia({ q: `cat-${run}`, class: 'video' })).total, 0);
  assert.equal((await findMedia({ q: `cat-${run}`, class: 'image', source: 'attachment', server: guild.id })).total, 1);
  assert.equal((await findMedia({ q: `cat-${run}`, server: 'dm' })).total, 0);
  const totals = await monOk('GET', '/moderation/media/totals');
  assert.ok(totals.breakdown.some((b) => b.kind === 'attachment' && b.class === 'image'));
  assert.ok(totals.servers.some((g) => g.id === guild.id));

  // The picture plays inline, can't run anything, and seeks.
  const img = await fetch(`${MON}${m.file}`, { headers: { cookie, range: 'bytes=0-3' } });
  assert.equal(img.status, 206);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.match(img.headers.get('content-security-policy'), /sandbox/);
  assert.equal(img.headers.get('content-disposition'), null);

  // An uploaded page must never render on the dashboard's origin.
  const html = (await findMedia({ q: `page-${run}` })).items[0];
  assert.equal(html.class, 'file');
  const served = await fetch(`${MON}${html.file}`, { headers: { cookie } });
  assert.equal(served.headers.get('content-disposition'), 'attachment');
  assert.match(served.headers.get('content-security-policy'), /sandbox/);
  assert.equal(page.attachments.length, 1);

  // Nothing outside the uploads folder.
  // (http.get sends the path as written; fetch would tidy it up first.)
  const raw = (path) =>
    new Promise((resolve, reject) => {
      const u = new URL(MON);
      http.get({ host: u.hostname, port: u.port, path, headers: { cookie } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
  for (const p of ['/media/..%2f..%2f.env', '/media/..%5c..%5c.env', '/media/../../.env', '/media/%2e%2e/%2e%2e/.env', '/media/%2e%2e%2f%2e%2e%2finternal-token', '/media/..%2finternal-token']) {
    const res = await raw(p);
    // A path the router folds away lands on the dashboard's page, never on the file.
    assert.ok(res.status === 404 || res.status === 400 || res.body.includes('<!doctype html>'), `${p}: ${res.status} ${res.body.slice(0, 80)}`);
    assert.doesNotMatch(res.body, /DATABASE_URL/);
  }
});

test('media: removing a file takes it away everywhere, through the app', async () => {
  const before = (await app(owner.token, 'GET', '/users/@me')).upload_bytes;
  const keepText = await app(owner.token, 'POST', `/channels/${general.id}/messages`, upload(`keep me ${run}`, `rm-a-${run}.png`, 'image/png', PNG));
  const onlyFile = await app(owner.token, 'POST', `/channels/${general.id}/messages`, upload('', `rm-b-${run}.png`, 'image/png', PNG));

  const a = (await findMedia({ q: `rm-a-${run}` })).items[0];
  const fileUrl = `${MON}${a.file}`;
  assert.equal((await fetch(fileUrl, { headers: { cookie } })).status, 200);
  const payload = (m) => ({ kind: m.kind, url: m.url, item_id: m.item_id, user_id: m.user_id, guild_id: m.guild_id });
  const r = await monOk('POST', '/moderation/media/remove', payload(a));
  assert.equal(r.freed, PNG.length);
  assert.equal((await fetch(fileUrl, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(`${APP}${a.url}`)).status, 404, 'gone from the app as well');
  assert.equal((await findMedia({ q: `rm-a-${run}` })).total, 0);

  // The text stays when there is some; a message with nothing left goes away.
  const msgs = await app(owner.token, 'GET', `/channels/${general.id}/messages?limit=50`);
  const kept = msgs.find((m) => m.id === keepText.id);
  assert.equal(kept.content, `keep me ${run}`);
  assert.equal(kept.attachments.length, 0);
  const b = (await findMedia({ q: `rm-b-${run}` })).items[0];
  await monOk('POST', '/moderation/media/remove', payload(b));
  const msgs2 = await app(owner.token, 'GET', `/channels/${general.id}/messages?limit=50`);
  assert.equal(msgs2.find((m) => m.id === onlyFile.id), undefined);

  // The quota comes back.
  assert.equal((await app(owner.token, 'GET', '/users/@me')).upload_bytes, before);

  // Removing it twice says so instead of failing strangely.
  const again = await mon('POST', '/moderation/media/remove', payload(a));
  assert.equal(again.status, 502);
  assert.match(again.data.error, /already gone/);

  // The removal is on the record, without the file's name.
  const today = new Date().toISOString().slice(0, 10);
  const log = await until('the moderation line', async () => {
    const l = await monOk('GET', `/logs?day=${today}&target=moderation`);
    return l.lines.length ? l.lines : null;
  });
  assert.equal(log[0].fields.kind, 'attachment');
});

test('media: emoji and server pictures can be removed too', async () => {
  const fd = new FormData();
  fd.append('name', `e${run}`);
  fd.append('image', new Blob([PNG], { type: 'image/png' }), 'e.png');
  const emoji = await app(owner.token, 'POST', `/guilds/${guild.id}/emojis`, fd);
  const e = (await findMedia({ source: 'emoji', q: `e${run}` })).items[0];
  assert.equal(e.item_id, emoji.id);
  assert.equal(e.class, 'image');
  await monOk('POST', '/moderation/media/remove', { kind: e.kind, url: e.url, item_id: e.item_id, user_id: e.user_id, guild_id: e.guild_id });
  assert.equal((await findMedia({ source: 'emoji', q: `e${run}` })).total, 0);
  assert.equal((await fetch(`${MON}${e.file}`, { headers: { cookie } })).status, 404);

  const icon = new FormData();
  icon.append('file', new Blob([PNG], { type: 'image/png' }), 'icon.png');
  await app(owner.token, 'POST', `/guilds/${guild.id}/icon`, icon);
  const i = (await findMedia({ source: 'server_icon', server: guild.id })).items[0];
  assert.equal(i.username, `mon${run}`);
  await monOk('POST', '/moderation/media/remove', { kind: i.kind, url: i.url, item_id: i.item_id, user_id: i.user_id, guild_id: i.guild_id });
  assert.equal((await findMedia({ source: 'server_icon', server: guild.id })).total, 0);
});

test('diagnostics: every group reports, and the tools work', async () => {
  const d = await monOk('POST', '/diagnostics/run');
  const groups = new Set(d.results.map((r) => r.group));
  for (const g of ['Configuration', 'App', 'Database', 'Storage', 'Tools', 'System']) assert.ok(groups.has(g), g);
  for (const r of d.results) assert.ok(['pass', 'warn', 'fail', 'info'].includes(r.status), JSON.stringify(r));
  // Whatever fails says what to do about it.
  for (const r of d.results.filter((x) => x.status === 'fail' || x.status === 'warn')) assert.ok(r.fix, r.name);
  // Dev login on a local server is expected, not an alarm.
  assert.equal(d.results.find((r) => r.name === 'Dev login').status, 'info');

  assert.equal((await mon('POST', '/tools/dns', { host: '' })).status, 400);
  assert.equal((await monOk('POST', '/tools/dns', { host: 'localhost' })).ok, true);
  const url = new URL(APP);
  const tcp = await monOk('POST', '/tools/tcp', { host: url.hostname, port: Number(url.port) });
  assert.equal(tcp.answered, 4);
  const http = await monOk('POST', '/tools/http', { url: `${APP}/api/health` });
  assert.equal(http.status, 200);
  assert.equal((await mon('POST', '/tools/http', { url: 'file:///etc/passwd' })).status, 400);
});

let browser;
after(async () => browser?.close());

test('in a browser: sign in, every tab, a removal, live logs', { skip: !process.env.CHROMIUM }, async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  ctx.setDefaultTimeout(8000);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // A failing fetch logs itself; the app's answers are checked by the tests above.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });

  await page.goto(MON);
  await page.waitForSelector('.login');
  await page.fill('#password', 'not it');
  await page.click('.login .btn');
  await page.waitForSelector('.login .error');
  await page.fill('#password', PASSWORD);
  await page.click('.login .btn');
  await page.waitForSelector('.desk');

  const tabs = {
    overview: '.verdict-line',
    availability: '.avail li',
    performance: '.stats .stat',
    network: '.stats .stat',
    storage: '.disks li',
    database: '.stats .stat',
    logs: '.log-row',
    diagnostics: '.diag-group li',
    servers: '.server-table tbody tr',
    media: '.gallery li',
  };
  for (const [tab, selector] of Object.entries(tabs)) {
    await page.goto(`${MON}/#/${tab}`);
    await page.waitForSelector(selector);
    await page.waitForTimeout(tab === 'diagnostics' ? 1200 : 500);
    await shot(`monitor-${tab}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${tab} scrolls sideways`);
  }

  // A server opens up, and leads to its media.
  await page.goto(`${MON}/#/servers`);
  await page.fill('.filters input[type=search]', `Moderated ${run}`);
  await page.click(`.server-table tbody tr.clickable:has-text("Moderated ${run}")`);
  await page.waitForSelector('.detail table');
  await shot('monitor-server-detail');
  await page.click('.detail-actions .btn');
  await page.waitForFunction(() => location.hash.startsWith('#/media/'));
  await page.waitForSelector(`.media-card:has-text("cat-${run}")`);

  // Remove one, confirming first.
  await page.click(`.media-card:has-text("cat-${run}")`);
  await page.waitForSelector('.viewer');
  await shot('monitor-media-viewer');
  await page.click('.remove-box .btn.danger');
  await page.waitForSelector('.remove-box .btn:has-text("Keep it")');
  await page.click('.remove-box .btn:has-text("Remove for good")');
  await page.waitForSelector(`.status.ok:has-text("cat-${run}")`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.viewer'));
  assert.equal(await page.locator(`.media-card:has-text("cat-${run}")`).count(), 0);

  // Live logs.
  await page.goto(`${MON}/#/logs`);
  await page.waitForSelector('.logs-live.on');
  for (let i = 0; ; i++) {
    await app(owner.token, 'POST', '/logs/client', { level: 'warn', message: `ui live ${run}` });
    const seen = await page.waitForSelector(`.log-row.fresh:has-text("ui live ${run}")`, { timeout: 1500 }).catch(() => null);
    if (seen) break;
    assert.ok(i < 8, 'no live line arrived');
  }

  // Phone width: no sideways scrolling.
  await page.setViewportSize({ width: 390, height: 800 });
  for (const tab of ['overview', 'media', 'servers', 'logs']) {
    await page.goto(`${MON}/#/${tab}`);
    await page.waitForTimeout(400);
    await shot(`monitor-phone-${tab}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${tab} on a phone scrolls sideways`);
  }

  // Sign out.
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.click('.dock .link-btn');
  await page.waitForSelector('.login');
  assert.deepEqual(errors, []);
});
