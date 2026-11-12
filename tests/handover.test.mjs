// Restarts without dropping anyone (server/src/handover.rs): a second server takes over from a running one while
// people are in a call, then a plain stop + start picks the saved state up. Runs its own servers on :7706/:7707 with
// their own data folder (never server/, whose .env is production's). Started by tests/run-local.sh.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = process.env.LINKORD_SERVER_BIN;
const DB = process.env.LINKORD_TEST_DATABASE_URL;
const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = 'http://127.0.0.1:7706';
const WS = BASE.replace(/^http/, 'ws');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'linkord-handover-'));
const run = Math.random().toString(36).slice(2, 7);

function start(name, extra = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    RUST_LOG: 'linkord_server=info',
    DATABASE_URL: DB,
    LINKORD_BIND: '127.0.0.1:7706',
    LINKORD_PUBLIC_URL: BASE,
    LINKORD_INTERNAL_BIND: '127.0.0.1:7707',
    LINKORD_DATA_DIR: data,
    LINKORD_WEB_DIR: path.join(ROOT, 'app/dist'),
    LINKORD_SOUNDS_DIR: path.join(ROOT, 'server/soundboard'),
    LINKORD_NAMEPLATES_DIR: path.join(data, 'nameplates'),
    LINKORD_DEV_LOGIN: 'true',
    LINKORD_SIGNUP: 'open',
    LINKORD_GAME_INFO: 'off',
    LINKORD_DETECTABLE_URL: 'http://localhost:7702/detectable',
    LINKORD_YTDLP: process.env.LINKORD_YTDLP ?? 'true',
    ...extra,
  };
  const log = fs.openSync(path.join(data, `${name}.log`), 'a');
  const child = spawn(BIN, [], { cwd: data, env, stdio: ['ignore', log, log] });
  child.exited = new Promise((r) => child.on('exit', (code) => r(code)));
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(50);
  }
  throw new Error('timed out waiting');
}
const healthy = () => until(async () => (await fetch(`${BASE}/api/health`)).ok, 30000);

async function api(token, method, p, body) {
  const res = await fetch(`${BASE}/api${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  assert.ok(res.ok, `${method} ${p} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function login(name) {
  const { token } = await api(null, 'POST', '/auth/dev', { username: `${name}.${run}` });
  const me = await api(token, 'GET', '/users/@me');
  return { token, id: me.id };
}

/** A gateway client that resumes after a 4100 like the app does, keeping every event it ever got. */
function gatewayClient(token) {
  const c = { events: [], closes: [], seq: 0, session: null, resumed: 0 };
  const open = () =>
    new Promise((resolve) => {
      const ws = new WebSocket(`${WS}/api/gateway`);
      c.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify(c.session ? { op: 'resume', token, session_id: c.session, seq: c.seq } : { op: 'identify', token }));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.s) c.seq = m.s;
        c.events.push(m);
        if (m.t === 'READY') c.session = m.d.session_id;
        if (m.t === 'RESUMED') c.resumed++;
        if (m.t === 'READY' || m.t === 'RESUMED') resolve();
      };
      ws.onclose = (e) => {
        c.closes.push(e.code);
        if (!c.stopped) setTimeout(open, 100);
      };
    });
  c.ready = open();
  return c;
}

/** A v2 voice client that takes its seat back after a drop, like the app's worker. */
function voiceClient(u, channelId) {
  const c = { readies: [], closes: [], audio: [] };
  const open = () => {
    const ws = new WebSocket(`${WS}/api/voice/connect`);
    ws.binaryType = 'arraybuffer';
    c.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ token: u.token, channel_id: channelId, v: 2 }));
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return c.audio.push(new Uint8Array(e.data));
      const m = JSON.parse(e.data);
      if (m.op === 'ready') c.readies.push(m);
    };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      c.closes.push(e.code);
      if (!c.stopped) setTimeout(open, e.code === 4100 ? 50 : 200);
    };
  };
  open();
  return c;
}

const left = (watcher, user) => watcher.events.some((e) => e.t === 'VOICE_STATE_UPDATE' && e.d.user_id === user && e.d.channel_id === null);
const parity = (id) => Number(BigInt(id) & 1n);

test('a new server takes over without anyone leaving the call; a stop and start keeps it too', { skip: !BIN || !DB }, async (t) => {
  fs.mkdirSync(path.join(data, 'nameplates'), { recursive: true });
  const a1 = start('a');
  await healthy();
  const [a, b] = await Promise.all([login('hoa'), login('hob')]);
  const g = await api(a.token, 'POST', '/guilds', { name: `Handover ${run}` });
  const text = g.channels.find((c) => c.kind === 0);
  const voice = await api(a.token, 'POST', `/guilds/${g.id}/channels`, { name: 'call', kind: 2 });
  const invite = await api(a.token, 'POST', `/guilds/${g.id}/invites`, {});
  await api(b.token, 'POST', `/invites/${invite.code}`);

  const ga = gatewayClient(a.token);
  const gb = gatewayClient(b.token);
  await Promise.all([ga.ready, gb.ready]);
  const va = voiceClient(a, voice.id);
  const vb = voiceClient(b, voice.id);
  await until(async () => va.readies.length && vb.readies.length);
  await until(async () => gb.events.some((e) => e.t === 'VOICE_STATE_UPDATE' && e.d.user_id === a.id && e.d.channel_id === voice.id));
  const startedAt = gb.events.findLast((e) => e.t === 'VOICE_STATE_UPDATE' && e.d.user_id === a.id).d.call_started_at;
  const before = await api(a.token, 'POST', `/channels/${text.id}/messages`, { content: 'before' });
  assert.equal(parity(before.id), 0);

  // Without LINKORD_TAKEOVER=1 a second server refuses to start, and the running one doesn't notice.
  const stray = start('stray');
  assert.notEqual(await stray.exited, 0);
  assert.equal(va.closes.length, 0);

  // The deploy: the new server takes over.
  const a2 = start('b', { LINKORD_TAKEOVER: '1' });
  await until(async () => va.closes.includes(4100) && ga.closes.includes(4100), 30000);
  const cut = Date.now();
  assert.equal(await a1.exited, 0, 'the old server finished and stopped');
  await until(async () => va.readies.length >= 2 && vb.readies.length >= 2 && ga.resumed >= 1 && gb.resumed >= 1);
  assert.equal(va.readies.at(-1).resumed, true, 'voice took its seat back');
  t.diagnostic(`voice back ${Date.now() - cut} ms after the old server closed it (or less: checked every 50 ms)`);
  assert.equal(vb.readies.at(-1).resumed, true);

  // Everything goes on: events reach the resumed sessions, voice is relayed, nobody left, the call kept its start.
  const after = await api(b.token, 'POST', `/channels/${text.id}/messages`, { content: 'after' });
  assert.equal(parity(after.id), 1, "the new server's ids can't collide with the old one's");
  await until(async () => ga.events.some((e) => e.t === 'MESSAGE_CREATE' && e.d.id === after.id));
  va.ws.send(new Uint8Array([1, 7, 7, 7]));
  await until(async () => vb.audio.some((p) => p[0] === 1 && p.at(-1) === 7));
  assert.ok(!left(gb, a.id) && !left(ga, b.id), 'nobody saw anyone leave');
  const fresh = gatewayClient(b.token);
  await fresh.ready;
  const vs = fresh.events[0].d.voice_states.find((v) => v.user_id === a.id);
  assert.equal(vs?.channel_id, voice.id);
  assert.equal(vs.call_started_at, startedAt);
  fresh.stopped = true;
  fresh.ws.close();

  // A plain stop (SIGTERM) saves the state; the next start picks it up.
  a2.kill('SIGTERM');
  assert.equal(await a2.exited, 0);
  assert.ok(fs.existsSync(path.join(data, 'run/snapshot.json')));
  const a3 = start('c');
  await healthy();
  await until(async () => va.readies.length >= 3 && va.readies.at(-1).resumed === true, 15000);
  await until(async () => ga.resumed >= 2, 15000);
  assert.ok(!left(gb, a.id), 'still nobody left');

  for (const c of [ga, gb, va, vb]) {
    c.stopped = true;
    c.ws.close();
  }
  a3.kill('SIGTERM');
  await a3.exited;
  if (process.env.KEEP_HANDOVER_LOGS) t.diagnostic(`logs in ${data}`);
  else fs.rmSync(data, { recursive: true, force: true });
});
