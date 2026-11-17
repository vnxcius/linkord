// End-to-end API tests. Run against a server with LINKORD_DEV_LOGIN=true (never production):
//   LINKORD_TEST_URL=http://localhost:7701 node --test tests/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const BASE = process.env.LINKORD_TEST_URL ?? 'http://localhost:7701';
const run = Math.random().toString(36).slice(2, 7);

async function call(token, method, path, body) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}/api${path}`, { method, headers, body: payload });
  const text = await res.text();
  const out = { status: res.status, body: text ? JSON.parse(text) : null };
  // Behave like the real client: wait out rate limits (except where a test wants to see them).
  if (res.status === 429 && !call.noRetry) {
    await new Promise((r) => setTimeout(r, out.body.retry_after * 1000 + 20));
    return call(token, method, path, body);
  }
  return out;
}

async function ok(token, method, path, body) {
  const r = await call(token, method, path, body);
  assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function login(name) {
  const { token } = await ok(null, 'POST', '/auth/dev', { username: `${name}.${run}` });
  const me = await ok(token, 'GET', '/users/@me');
  return { token, id: me.id, username: me.username };
}

/** Opens a gateway session and collects events. */
function gateway(token, resume) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/gateway`);
    const events = [];
    let seq = resume?.seq ?? 0;
    ws.onopen = () => ws.send(JSON.stringify(resume ? { op: 'resume', token, ...resume } : { op: 'identify', token }));
    ws.onerror = reject;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.s) seq = m.s;
      events.push(m);
      if (m.t === 'READY' || m.t === 'RESUMED') resolve({ ws, events, first: m, seq: () => seq });
    };
  });
}

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting');
};

const [owner, member, outsider] = await Promise.all([login('owner'), login('member'), login('outsider')]);
const guild = await ok(owner.token, 'POST', '/guilds', { name: `Test ${run}` });
const general = guild.channels.find((c) => c.kind === 0);
const invite = await ok(owner.token, 'POST', `/guilds/${guild.id}/invites`, {});
await ok(member.token, 'POST', `/invites/${invite.code}`);

test('usernames follow Discord rules', async () => {
  assert.equal((await call(null, 'POST', '/auth/dev', { username: 'a..b' })).status, 400);
  assert.equal((await call(null, 'POST', '/auth/dev', { username: 'Upper' })).status, 400);
});

test('new servers get an @everyone role with default permissions', () => {
  const everyone = guild.roles.find((r) => r.id === guild.id);
  assert.ok(everyone);
  assert.ok(everyone.permissions & (1 << 11), 'SEND_MESSAGES');
  assert.ok(!(everyone.permissions & (1 << 4)), 'not MANAGE_CHANNELS');
});

test('non-members cannot read or post', async () => {
  assert.equal((await call(outsider.token, 'GET', `/channels/${general.id}/messages`)).status, 404);
  assert.equal((await call(outsider.token, 'POST', `/channels/${general.id}/messages`, { content: 'hi' })).status, 404);
});

test('roles grant permissions, respecting hierarchy', async () => {
  assert.equal((await call(member.token, 'POST', `/guilds/${guild.id}/channels`, { name: 'nope', kind: 0 })).status, 403);
  const mod = await ok(owner.token, 'POST', `/guilds/${guild.id}/roles`, { name: 'Mod', color: 0x62d3d8, permissions: 1 << 4, hoist: true });
  await ok(owner.token, 'PATCH', `/guilds/${guild.id}/members/${member.id}`, { roles: [mod.id] });
  const ch = await ok(member.token, 'POST', `/guilds/${guild.id}/channels`, { name: 'Mod Talk', kind: 0 });
  assert.equal(ch.name, 'mod-talk');
  // Can't grant permissions you don't have, or edit your own top role.
  assert.equal((await call(member.token, 'POST', `/guilds/${guild.id}/roles`, { permissions: 1 << 3 })).status, 403);
  assert.equal((await call(owner.token, 'DELETE', `/guilds/${guild.id}/members/${owner.id}`)).status, 400);
});

test('nicknames', async () => {
  const m = await ok(member.token, 'PATCH', `/guilds/${guild.id}/members/@me`, { nickname: 'Sir Member' });
  assert.equal(m.nickname, 'Sir Member');
});

test('messages: replies, edits, reactions, pins, @everyone', async () => {
  const a = await ok(owner.token, 'POST', `/channels/${general.id}/messages`, { content: 'hello @everyone', nonce: 'n1' });
  assert.equal(a.nonce, 'n1');
  assert.equal(a.mention_everyone, true, 'owner may mention everyone');
  const b = await ok(member.token, 'POST', `/channels/${general.id}/messages`, { content: '@everyone hi', reply_to: a.id });
  assert.equal(b.mention_everyone, false, 'members may not by default');
  assert.equal(b.referenced_message.id, a.id);
  await ok(member.token, 'PUT', `/channels/${general.id}/messages/${a.id}/reactions/${encodeURIComponent('🔥')}`);
  await ok(owner.token, 'PATCH', `/channels/${general.id}/messages/${a.id}`, { content: 'hello again' });
  // Pinning needs Manage Messages.
  assert.equal((await call(member.token, 'PUT', `/channels/${general.id}/pins/${a.id}`)).status, 403);
  await ok(owner.token, 'PUT', `/channels/${general.id}/pins/${a.id}`);
  const pins = await ok(member.token, 'GET', `/channels/${general.id}/pins`);
  assert.deepEqual(pins.map((m) => m.id), [a.id]);
  const page = await ok(owner.token, 'GET', `/channels/${general.id}/messages`);
  const got = page.find((m) => m.id === a.id);
  assert.equal(got.content, 'hello again');
  assert.ok(got.edited_at && got.pinned);
  assert.deepEqual(got.reactions, [{ emoji: '🔥', users: [member.id] }]);
  assert.equal((await call(member.token, 'DELETE', `/channels/${general.id}/messages/${a.id}`)).status, 403);
});

test('messages around an anchor', async () => {
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push((await ok(owner.token, 'POST', `/channels/${general.id}/messages`, { content: `n${i}` })).id);
  const around = await ok(owner.token, 'GET', `/channels/${general.id}/messages?around=${ids[3]}&limit=4`);
  assert.ok(around.some((m) => m.id === ids[3]));
  assert.ok(around.some((m) => m.id === ids[4]));
  const after = await ok(owner.token, 'GET', `/channels/${general.id}/messages?after=${ids[3]}`);
  assert.deepEqual(after.map((m) => m.id), ids.slice(4));
});

test('search with prefix matching and filters', async () => {
  await ok(member.token, 'POST', `/channels/${general.id}/messages`, { content: `the triforce of ${run}xyz` });
  const r = await ok(owner.token, 'GET', `/guilds/${guild.id}/messages/search?q=trifor`);
  assert.ok(r.total >= 1 && r.messages[0].content.includes('triforce'));
  const byAuthor = await ok(owner.token, 'GET', `/guilds/${guild.id}/messages/search?q=${run}xyz&author_id=${owner.id}`);
  assert.equal(byAuthor.total, 0);
  assert.equal((await call(outsider.token, 'GET', `/guilds/${guild.id}/messages/search?q=x`)).status, 404);
});

test('threads from a message', async () => {
  const m = await ok(owner.token, 'POST', `/channels/${general.id}/messages`, { content: 'Plan for the dungeon' });
  const thread = await ok(member.token, 'POST', `/channels/${general.id}/messages/${m.id}/threads`, {});
  assert.equal(thread.kind, 11);
  assert.equal(thread.name, 'Plan for the dungeon');
  assert.equal(thread.parent_id, general.id);
  await ok(owner.token, 'POST', `/channels/${thread.id}/messages`, { content: 'in the thread' });
  const starter = (await ok(owner.token, 'GET', `/channels/${general.id}/messages?around=${m.id}&limit=2`)).find((x) => x.id === m.id);
  assert.equal(starter.thread_id, thread.id);
  assert.equal((await call(member.token, 'POST', `/channels/${general.id}/messages/${m.id}/threads`, {})).status, 400);
});

test('custom emoji', async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const fd = new FormData();
  fd.append('name', 'rupee');
  fd.append('file', new Blob([png], { type: 'image/png' }), 'rupee.png');
  const e = await ok(owner.token, 'POST', `/guilds/${guild.id}/emojis`, fd);
  assert.equal(e.name, 'rupee');
  const img = await fetch(`${BASE}/uploads/emojis/${e.id}.png`);
  assert.equal(img.status, 200);
  const fd2 = new FormData();
  fd2.append('name', 'nope');
  fd2.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
  assert.equal((await call(member.token, 'POST', `/guilds/${guild.id}/emojis`, fd2)).status, 403);
});

test('friends, blocks and DMs', async () => {
  // Outsider shares no server with owner: DM requires friendship.
  assert.equal((await call(outsider.token, 'POST', '/users/@me/channels', { recipient_id: owner.id })).status, 400);
  await ok(outsider.token, 'POST', '/users/@me/relationships', { username: owner.username });
  await ok(owner.token, 'PUT', `/users/@me/relationships/${outsider.id}`);
  const rels = await ok(owner.token, 'GET', '/users/@me').then(() => gateway(owner.token)).then((g) => (g.ws.close(), g.first.d.relationships));
  assert.equal(rels.find((r) => r.id === outsider.id)?.type, 1);
  const dm = await ok(outsider.token, 'POST', '/users/@me/channels', { recipient_id: owner.id });
  await ok(owner.token, 'POST', `/channels/${dm.id}/messages`, { content: 'hey friend' });
  // Blocking stops DMs both ways.
  await ok(outsider.token, 'PUT', `/users/@me/relationships/${owner.id}`, { type: 2 });
  assert.equal((await call(owner.token, 'POST', `/channels/${dm.id}/messages`, { content: 'hello?' })).status, 400);
  await ok(outsider.token, 'DELETE', `/users/@me/relationships/${owner.id}`);
});

test('group DMs only with friends', async () => {
  assert.equal((await call(owner.token, 'POST', '/users/@me/channels', { recipients: [member.id, outsider.id] })).status, 400);
  await ok(owner.token, 'POST', '/users/@me/relationships', { username: member.username });
  await ok(member.token, 'PUT', `/users/@me/relationships/${owner.id}`);
  await ok(owner.token, 'POST', '/users/@me/relationships', { username: outsider.username });
  await ok(outsider.token, 'PUT', `/users/@me/relationships/${owner.id}`);
  const group = await ok(owner.token, 'POST', '/users/@me/channels', { recipients: [member.id, outsider.id] });
  assert.equal(group.kind, 3);
  assert.equal(group.recipients.length, 3);
  await ok(member.token, 'PATCH', `/channels/${group.id}`, { name: 'Party' });
  await ok(outsider.token, 'DELETE', `/channels/${group.id}/recipients/${outsider.id}`);
  assert.equal((await call(outsider.token, 'GET', `/channels/${group.id}/messages`)).status, 404);
});

test('synced settings', async () => {
  const s = await ok(owner.token, 'PATCH', '/users/@me/settings', { muted_channels: [general.id] });
  assert.deepEqual(s.muted_channels, [general.id]);
  assert.equal((await call(owner.token, 'PATCH', '/users/@me/settings', { evil: 1 })).status, 400);
});

test('gateway resume replays missed events', async () => {
  const g = await gateway(member.token);
  const sessionId = g.first.d.session_id;
  await ok(owner.token, 'POST', `/channels/${general.id}/messages`, { content: 'before drop' });
  await until(() => g.events.some((e) => e.t === 'MESSAGE_CREATE'));
  const seq = g.seq();
  g.ws.close();
  await new Promise((r) => setTimeout(r, 200));
  await ok(owner.token, 'POST', `/channels/${general.id}/messages`, { content: 'while away' });
  const r = await gateway(member.token, { session_id: sessionId, seq });
  assert.equal(r.first.t, 'RESUMED');
  await until(() => r.events.some((e) => e.t === 'MESSAGE_CREATE' && e.d.content === 'while away'));
  r.ws.close();
});

test('rate limits return 429 with retry_after', async () => {
  let limited;
  call.noRetry = true;
  for (let i = 0; i < 20 && !limited; i++) {
    const r = await call(outsider.token, 'POST', `/users/@me/relationships`, { username: 'nobody.here' });
    if (r.status === 429) limited = r.body;
  }
  call.noRetry = false;
  assert.ok(limited?.retry_after > 0);
});

test('update feed: nothing newer than the running version', async () => {
  const r = await fetch(`${BASE}/api/updates/windows/x86_64/99.0.0`);
  assert.equal(r.status, 204);
});

test('update feed: Linux apps get the .deb and .rpm of linux.json', { skip: !process.env.LINKORD_TEST_DATA_DIR }, async () => {
  const dir = path.join(process.env.LINKORD_TEST_DATA_DIR, 'updates');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'linux.json'), JSON.stringify({
    version: '1.2.3', notes: 'n', pub_date: '2026-10-28T00:00:00.000Z',
    deb: 'Linkord_1.2.3_amd64.deb', deb_signature: 'sig-deb', rpm: 'Linkord-1.2.3-1.x86_64.rpm', rpm_signature: 'sig-rpm',
  }));
  try {
    const r = await fetch(`${BASE}/api/updates/linux/x86_64/1.2.2`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.version, '1.2.3');
    assert.equal(body.platforms['linux-x86_64-rpm'].signature, 'sig-rpm');
    assert.match(body.platforms['linux-x86_64-rpm'].url, /\/api\/updates\/download\/Linkord-1\.2\.3-1\.x86_64\.rpm$/);
    assert.equal(body.platforms['linux-x86_64-deb'].signature, 'sig-deb');
    assert.equal((await fetch(`${BASE}/api/updates/linux/x86_64/1.2.3`)).status, 204);
    assert.equal((await fetch(`${BASE}/api/updates/windows/x86_64/1.2.2`)).status, 204);
    assert.equal((await (await fetch(`${BASE}/api/downloads`)).json()).rpm.version, '1.2.3');
  } finally {
    fs.rmSync(path.join(dir, 'linux.json'));
  }
});

test('update feed: the Android app gets android.json by version code, and every app hears of it', { skip: !process.env.LINKORD_TEST_DATA_DIR }, async () => {
  const dir = path.join(process.env.LINKORD_TEST_DATA_DIR, 'updates');
  fs.mkdirSync(dir, { recursive: true });
  const u = await login('androidfeed');
  const gw = await gateway(u.token);
  fs.writeFileSync(path.join(dir, 'Linkord-0.2.0.apk'), Buffer.alloc(1234));
  fs.writeFileSync(path.join(dir, 'android.json'), JSON.stringify({
    version: '0.2.0', version_code: 5, notes: 'n', pub_date: '2026-11-15T00:00:00.000Z', file: 'Linkord-0.2.0.apk', sha256: 'ab'.repeat(32),
  }));
  try {
    const r = await fetch(`${BASE}/api/updates/android/arm64-v8a/4`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.version, '0.2.0');
    assert.equal(body.version_code, 5);
    assert.equal(body.sha256, 'ab'.repeat(32));
    assert.equal(body.size, 1234);
    assert.match(body.url, /\/api\/updates\/download\/Linkord-0\.2\.0\.apk$/);
    assert.equal((await fetch(body.url)).status, 200);
    assert.equal((await fetch(`${BASE}/api/updates/android/arm64-v8a/5`)).status, 204, 'not newer');
    assert.equal((await fetch(`${BASE}/api/updates/android/x86_64/4`)).status, 204, 'arm64 only');
    assert.equal((await (await fetch(`${BASE}/api/downloads`)).json()).android.version, '0.2.0');
    const ev = await until(() => gw.events.find((e) => e.t === 'APP_UPDATE' && e.d.version === '0.2.0'), 10000);
    assert.equal(ev.d.android, true);
  } finally {
    gw.ws.close();
    fs.rmSync(path.join(dir, 'android.json'));
    fs.rmSync(path.join(dir, 'Linkord-0.2.0.apk'));
  }
});

test('account stats count messages, reactions, servers, friends and time in voice', async () => {
  const u = await login('stats');
  const g = await ok(u.token, 'POST', '/guilds', { name: `Stats ${run}` });
  const text = g.channels.find((c) => c.kind === 0);
  const voiceCh = g.channels.find((c) => c.kind === 2);
  const m1 = await ok(u.token, 'POST', `/channels/${text.id}/messages`, { content: 'one' });
  await ok(u.token, 'POST', `/channels/${text.id}/messages`, { content: 'two' });
  await ok(u.token, 'PUT', `/channels/${text.id}/messages/${m1.id}/reactions/${encodeURIComponent('👍')}`);
  // A short voice session counts its seconds once the socket closes.
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/voice/connect`);
  await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ token: u.token, channel_id: voiceCh.id }));
    ws.onmessage = (e) => typeof e.data === 'string' && JSON.parse(e.data).op === 'ready' && resolve();
    ws.onerror = reject;
  });
  await new Promise((r) => setTimeout(r, 1100));
  ws.close();
  let stats;
  for (let i = 0; i < 40; i++) {
    stats = await ok(u.token, 'GET', '/users/@me/stats');
    if (stats.voice_seconds >= 1) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(stats.messages, 2);
  assert.equal(stats.reactions, 1);
  assert.equal(stats.servers, 1);
  assert.equal(stats.friends, 0);
  assert.equal(stats.attachments, 0);
  assert.ok(stats.voice_seconds >= 1, `voice_seconds = ${stats.voice_seconds}`);
  assert.ok(stats.upload_quota > 0 && Date.parse(stats.created_at) > 0);
  // The fuller report (Settings -> Stats).
  assert.equal(stats.servers_owned, 1);
  assert.equal(stats.message_stats.words, 2);
  assert.equal(stats.message_stats.active_days, 1);
  assert.deepEqual(stats.top_emoji, [{ emoji: '👍', count: 1 }]);
  assert.deepEqual(stats.top_channels, [{ channel_id: text.id, count: 2 }]);
  assert.equal(stats.activity.reduce((n, [, , c]) => n + c, 0), 2);
  assert.equal(stats.counters.voice_sessions, 1);
});

test('Kass is in every server: kicking him opts the server out, Manage Server adds him back; new servers follow your setting', async () => {
  const u = await login('kassowner');
  const g = await ok(u.token, 'POST', '/guilds', { name: `Kass ${run}` });
  // A server's members as a fresh session sees them (READY).
  const membersOf = async (gid) => {
    const gw = await gateway(u.token);
    gw.ws.close();
    return gw.first.d.guilds.find((x) => x.id === gid).members;
  };
  const members = () => membersOf(g.id);
  assert.ok(g.members.some((m) => m.user.bot), 'the new server comes with Kass');
  const kass = (await members()).find((m) => m.user.bot);
  assert.ok(kass, 'Kass joins new servers');
  assert.equal(kass.user.username, 'kass');
  const text = g.channels.find((c) => c.kind === 0);
  // Kicking him is the opt-out: commands say how to bring him back.
  await ok(u.token, 'DELETE', `/guilds/${g.id}/members/${kass.user.id}`);
  assert.ok(!(await members()).some((m) => m.user.bot));
  const r = await call(u.token, 'POST', `/channels/${text.id}/commands`, { name: 'queue', query: '' });
  assert.match(r.body.error, /Kass isn't in this server/);
  // Only Manage Server adds him back.
  const other = await login('kassmember');
  const inv = await ok(u.token, 'POST', `/guilds/${g.id}/invites`, {});
  await ok(other.token, 'POST', `/invites/${inv.code}`);
  assert.equal((await call(other.token, 'POST', `/guilds/${g.id}/bots/music`)).status, 403);
  await ok(u.token, 'POST', `/guilds/${g.id}/bots/music`);
  assert.ok((await members()).some((m) => m.user.bot));
  await ok(u.token, 'DELETE', `/guilds/${g.id}/bots/music`);
  assert.ok(!(await members()).some((m) => m.user.bot));
  // Settings -> Kass: servers you create start without him.
  assert.deepEqual(await ok(u.token, 'GET', '/users/@me/kass'), { new_servers: true });
  await ok(u.token, 'PUT', '/users/@me/kass', { new_servers: false });
  const g2 = await ok(u.token, 'POST', '/guilds', { name: `No Kass ${run}` });
  assert.ok(!g2.members.some((m) => m.user.bot));
  await ok(u.token, 'POST', `/guilds/${g2.id}/bots/music`);
  assert.ok((await membersOf(g2.id)).some((m) => m.user.bot));
});

test('connections: dev logins have no Discord link', async () => {
  assert.deepEqual(await ok(owner.token, 'GET', '/users/@me/connections'), []);
});

test('avatar and banner can be removed', async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'b.png');
  assert.ok((await ok(member.token, 'POST', '/users/@me/banner', fd)).banner);
  assert.equal((await ok(member.token, 'DELETE', '/users/@me/banner')).banner, null);
});

test('avatar history keeps the last 5 uploads, restores one, removes one, and ignores banners', async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const send = (which) => {
    const fd = new FormData();
    fd.append('file', new Blob([png], { type: 'image/png' }), 'a.png');
    return ok(member.token, 'POST', `/users/@me/${which}`, fd);
  };
  await send('banner');
  const first = (await send('avatar')).avatar;
  for (let i = 0; i < 6; i++) await send('avatar');
  const list = await ok(member.token, 'GET', '/users/@me/avatars');
  assert.equal(list.length, 5);
  assert.ok(!list.includes(first), 'the oldest picture is dropped');
  // The one in use can't be removed; another one can, and is gone from the list.
  assert.equal((await call(member.token, 'DELETE', '/users/@me/avatars', { url: list[0] })).status, 400);
  await ok(member.token, 'DELETE', '/users/@me/avatars', { url: list[1] });
  const kept = await ok(member.token, 'GET', '/users/@me/avatars');
  assert.ok(!kept.includes(list[1]));
  const old = kept[kept.length - 1];
  assert.equal((await ok(member.token, 'PUT', '/users/@me/avatar', { url: old })).avatar, old);
  assert.equal((await ok(member.token, 'GET', '/users/@me/avatars'))[0], old);
  const bad = await fetch(`${BASE}/api/users/@me/avatar`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${member.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url: first }),
  });
  assert.equal(bad.status, 400);
  await ok(member.token, 'DELETE', '/users/@me/banner');
});

test('nameplates: defaults come from the server folder, can be picked, uploaded and removed', { skip: !process.env.LINKORD_TEST_DATA_DIR }, async () => {
  // The folder ships empty (Discord's nameplates were removed in the rebrand), so the test puts one there.
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  fs.writeFileSync(path.join(process.env.LINKORD_TEST_DATA_DIR, 'nameplates', 'aa-plain.png'), png);
  const defaults = await ok(member.token, 'GET', '/nameplates');
  assert.ok(defaults.includes('/nameplates/aa-plain.png') && defaults.every((u) => u.startsWith('/nameplates/')));
  assert.equal((await ok(member.token, 'PUT', '/users/@me/nameplate', { url: defaults[0] })).nameplate, defaults[0]);
  assert.equal((await fetch(`${BASE}${defaults[0]}`)).status, 200);
  const res = await fetch(`${BASE}/api/users/@me/nameplate`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${member.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url: '/nameplates/../../etc/passwd' }),
  });
  assert.equal(res.status, 400);
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'n.png');
  assert.match((await ok(member.token, 'POST', '/users/@me/nameplate', fd)).nameplate, /^\/uploads\/nameplates\//);
  assert.equal((await ok(member.token, 'DELETE', '/users/@me/nameplate')).nameplate, null);
});

test('nameplates: WebM videos work as defaults and uploads; a fake WebM is refused', { skip: !process.env.LINKORD_TEST_DATA_DIR }, async () => {
  // Its own user: uploads are rate limited per person, and the shared test users have spent theirs by now.
  const u = await login('webm');
  const webm = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xe3b341:s=132x24:d=1', '-c:v', 'libvpx-vp9', '-f', 'webm', 'pipe:1']);
  fs.writeFileSync(path.join(process.env.LINKORD_TEST_DATA_DIR, 'nameplates', 'zz-shimmer.webm'), webm);
  const defaults = await ok(u.token, 'GET', '/nameplates');
  assert.equal(defaults.at(-1), '/nameplates/zz-shimmer.webm');
  const served = await fetch(`${BASE}/nameplates/zz-shimmer.webm`);
  assert.equal(served.headers.get('content-type'), 'video/webm');
  assert.equal((await ok(u.token, 'PUT', '/users/@me/nameplate', { url: '/nameplates/zz-shimmer.webm' })).nameplate, '/nameplates/zz-shimmer.webm');

  // Uploaded ones are saved as .webm whatever the file was called, so every client knows to play them.
  const fd = new FormData();
  fd.append('file', new Blob([webm], { type: 'video/webm' }), 'loop.png');
  assert.match((await ok(u.token, 'POST', '/users/@me/nameplate', fd)).nameplate, /^\/uploads\/nameplates\/.+\/nameplate\.webm$/);
  const fake = new FormData();
  fake.append('file', new Blob(['not a video'], { type: 'video/webm' }), 'fake.webm');
  assert.equal((await call(u.token, 'POST', '/users/@me/nameplate', fake)).body.error, "that file isn't a WebM video");
  // Only nameplates can be videos.
  const avatar = new FormData();
  avatar.append('file', new Blob([webm], { type: 'video/webm' }), 'a.webm');
  assert.equal((await call(u.token, 'POST', '/users/@me/avatar', avatar)).status, 400);
  await ok(u.token, 'DELETE', '/users/@me/nameplate');
});

test('GIF pictures and banners stay animated: the server crops them into animated WebP', async () => {
  // Its own user: uploads are rate limited per person, and the shared test users have spent theirs by now.
  const u = await login('gif');
  const gif = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=240x135:rate=10', '-t', '1', '-f', 'gif', 'pipe:1']);
  const frames = async (url) => {
    const webp = Buffer.from(await (await fetch(`${BASE}${url}`)).arrayBuffer());
    assert.equal(webp.subarray(8, 12).toString(), 'WEBP');
    // Canvas size (VP8X) and animation frames (ANMF chunks).
    const at = webp.indexOf('VP8X');
    return { w: webp.readUIntLE(at + 12, 3) + 1, h: webp.readUIntLE(at + 15, 3) + 1, n: webp.toString('latin1').split('ANMF').length - 1 };
  };
  const fd = new FormData();
  fd.append('crop', JSON.stringify({ x: 60, y: 0, w: 135, h: 135, rotate: 90 }));
  fd.append('file', new Blob([gif], { type: 'image/gif' }), 'a.gif');
  const me = await ok(u.token, 'POST', '/users/@me/avatar', fd);
  assert.match(me.avatar, /\.webp$/);
  assert.deepEqual(await frames(me.avatar), { w: 135, h: 135, n: 10 });
  // No crop: the largest centred 3:1 frame.
  const banner = new FormData();
  banner.append('file', new Blob([gif], { type: 'image/gif' }), 'b.gif');
  const withBanner = await ok(u.token, 'POST', '/users/@me/banner', banner);
  assert.deepEqual(await frames(withBanner.banner), { w: 240, h: 80, n: 10 });
  const fake = new FormData();
  fake.append('file', new Blob(['not a gif'], { type: 'image/gif' }), 'f.gif');
  assert.equal((await call(u.token, 'POST', '/users/@me/avatar', fake)).body.error, "couldn't read that GIF");
  await ok(u.token, 'DELETE', '/users/@me/avatar');
  await ok(u.token, 'DELETE', '/users/@me/banner');
});

test('usernames: change yours (unique, Discord rules); signing up with a taken one links the account and asks for another', async () => {
  const a = await login('rename');
  const wanted = `picked.${run}`;
  assert.equal((await call(a.token, 'PATCH', '/users/@me', { username: 'Bad Name' })).status, 400);
  assert.equal((await call(a.token, 'PATCH', '/users/@me', { username: owner.username })).body.error, 'that username is taken');
  assert.equal((await ok(a.token, 'PATCH', '/users/@me', { username: wanted })).username, wanted);
  // Signing in again keeps the name you picked (it no longer follows the Discord one).
  const again = await ok(null, 'POST', '/auth/dev', { username: `rename.${run}` });
  assert.equal((await ok(again.token, 'GET', '/users/@me')).username, wanted);
  // Someone new whose username is taken still gets an account, with a stand-in name, and is asked to pick one.
  const { token } = await ok(null, 'POST', '/auth/dev', { username: wanted });
  const fresh = await ok(token, 'GET', '/users/@me');
  assert.notEqual(fresh.id, a.id);
  assert.equal(fresh.needs_username, true);
  assert.match(fresh.username, new RegExp(`^picked\\.${run}_\\d{4}$`));
  // Only they see the flag.
  assert.equal((await ok(owner.token, 'GET', `/users/${fresh.id}`)).needs_username, undefined);
  const picked = await ok(token, 'PATCH', '/users/@me', { username: `other.${run}` });
  assert.equal(picked.username, `other.${run}`);
  assert.equal(picked.needs_username, false);
});

test('deleting an account leaves servers and friendships, keeps messages, unlinks the login', async () => {
  const leaver = await login('leaver');
  await ok(leaver.token, 'POST', `/invites/${invite.code}`);
  const msg = await ok(leaver.token, 'POST', `/channels/${general.id}/messages`, { content: 'goodbye' });
  await ok(leaver.token, 'POST', '/users/@me/relationships', { username: owner.username });
  const watcher = await gateway(owner.token);

  // Owners must delete their servers first.
  const own = await ok(leaver.token, 'POST', '/guilds', { name: 'Mine' });
  const blocked = await call(leaver.token, 'DELETE', '/users/@me', { confirm: leaver.username });
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.message ?? JSON.stringify(blocked.body), /Mine/);
  await ok(leaver.token, 'DELETE', `/guilds/${own.id}`);

  assert.equal((await call(leaver.token, 'DELETE', '/users/@me', { confirm: 'wrong' })).status, 400);
  await ok(leaver.token, 'DELETE', '/users/@me', { confirm: leaver.username });

  assert.equal((await call(leaver.token, 'GET', '/users/@me')).status, 401, 'sessions are revoked');
  const gone = await ok(owner.token, 'GET', `/users/${leaver.id}`);
  assert.equal(gone.display_name, 'Deleted User');
  assert.equal(gone.avatar, null);
  const members = await ok(owner.token, 'GET', `/guilds/${guild.id}/members`).catch(() => null);
  if (members) assert.ok(!members.some((m) => (m.user?.id ?? m.user_id) === leaver.id));
  const history = await ok(owner.token, 'GET', `/channels/${general.id}/messages?limit=50`);
  assert.ok(history.some((m) => m.id === msg.id), 'messages stay');
  await until(() => watcher.events.some((e) => e.t === 'GUILD_MEMBER_REMOVE' && e.d.user_id === leaver.id));
  await until(() => watcher.events.some((e) => e.t === 'RELATIONSHIP_REMOVE' && e.d.id === leaver.id));
  watcher.ws.close();

  // Signing in again with the same external account starts a fresh user.
  const again = await login('leaver');
  assert.notEqual(again.id, leaver.id);
});

test('bulk delete: own messages, or anyone\'s with Manage Messages; all or nothing', async () => {
  const send = (u, content) => ok(u.token, 'POST', `/channels/${general.id}/messages`, { content });
  const [m1, m2, o1] = [await send(member, 'bulk 1'), await send(member, 'bulk 2'), await send(owner, 'bulk owner')];
  assert.equal((await call(member.token, 'POST', `/channels/${general.id}/messages/bulk-delete`, { messages: [m1.id, o1.id] })).status, 403);
  await ok(member.token, 'POST', `/channels/${general.id}/messages/bulk-delete`, { messages: [m1.id, m2.id] });
  let ids = (await ok(owner.token, 'GET', `/channels/${general.id}/messages?limit=50`)).map((m) => m.id);
  assert.ok(!ids.includes(m1.id) && !ids.includes(m2.id) && ids.includes(o1.id));
  const m3 = await send(member, 'bulk 3');
  await ok(owner.token, 'POST', `/channels/${general.id}/messages/bulk-delete`, { messages: [o1.id, m3.id] });
  ids = (await ok(owner.token, 'GET', `/channels/${general.id}/messages?limit=50`)).map((m) => m.id);
  assert.ok(!ids.includes(o1.id) && !ids.includes(m3.id));
  assert.equal((await call(owner.token, 'POST', `/channels/${general.id}/messages/bulk-delete`, { messages: [] })).status, 400);
});

test('forwarding: a copy that outlives the original, to channels and DMs, with a comment; all or nothing', async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({ content: 'forward me' }));
  fd.append('file', new Blob([png], { type: 'image/png' }), 'f.png');
  const orig = await ok(owner.token, 'POST', `/channels/${general.id}/messages`, fd);
  const url = orig.attachments[0].url;
  const file = () => fetch(`${BASE}${url}`).then((r) => r.status);
  const path = `/channels/${general.id}/messages/${orig.id}/forward`;
  const latest = async () => (await ok(owner.token, 'GET', `/channels/${general.id}/messages?limit=1`))[0].id;

  // Every destination is checked first: one you can't post in stops them all. You must be able to read the original.
  const other = await ok(outsider.token, 'POST', '/guilds', { name: `Other ${run}` });
  const otherCh = other.channels.find((c) => c.kind === 0);
  assert.equal((await call(member.token, 'POST', path, { channel_ids: [general.id, otherCh.id] })).status, 404);
  assert.equal(await latest(), orig.id);
  assert.equal((await call(outsider.token, 'POST', path, { channel_ids: [otherCh.id] })).status, 404);
  assert.equal((await call(member.token, 'POST', path, {})).status, 400);
  assert.equal((await call(member.token, 'POST', path, { channel_ids: Array(6).fill(general.id) })).status, 400);

  // To a channel and to someone (their DM is opened), each followed by the comment.
  const sent = await ok(member.token, 'POST', path, { channel_ids: [general.id], user_ids: [owner.id], content: 'look' });
  assert.equal(sent.length, 4);
  const [fwd, comment, dmFwd, dmComment] = sent;
  assert.equal(fwd.content, '');
  assert.equal(fwd.author.id, member.id);
  assert.equal(fwd.forwarded.message_id, orig.id);
  assert.equal(fwd.forwarded.channel_id, general.id);
  assert.equal(fwd.forwarded.guild_id, guild.id);
  assert.equal(fwd.forwarded.content, 'forward me');
  assert.equal(fwd.forwarded.attachments[0].url, url);
  assert.equal(comment.content, 'look');
  assert.equal(comment.forwarded, undefined);
  assert.notEqual(dmFwd.channel_id, general.id);
  assert.equal(dmComment.channel_id, dmFwd.channel_id);
  const dmPage = await ok(owner.token, 'GET', `/channels/${dmFwd.channel_id}/messages`);
  assert.deepEqual(dmPage.map((m) => m.id), [dmFwd.id, dmComment.id]);

  // Forwards can't be edited; forwarding a forward passes the original on; replies preview the forwarded text.
  assert.equal((await call(member.token, 'PATCH', `/channels/${general.id}/messages/${fwd.id}`, { content: 'x' })).status, 400);
  const [again] = await ok(owner.token, 'POST', `/channels/${dmFwd.channel_id}/messages/${dmFwd.id}/forward`, { channel_ids: [general.id] });
  assert.equal(again.forwarded.message_id, orig.id);
  const reply = await ok(owner.token, 'POST', `/channels/${general.id}/messages`, { content: 'nice', reply_to: fwd.id });
  assert.equal(reply.referenced_message.content, 'forward me');

  // The copy stays as it was when the original is edited or deleted, and so do its files, until nothing shows them.
  await ok(owner.token, 'PATCH', `/channels/${general.id}/messages/${orig.id}`, { content: 'changed' });
  await ok(owner.token, 'DELETE', `/channels/${general.id}/messages/${orig.id}`);
  const page = await ok(owner.token, 'GET', `/channels/${general.id}/messages?limit=10`);
  assert.equal(page.find((m) => m.id === fwd.id).forwarded.content, 'forward me');
  assert.equal(await file(), 200);
  await ok(member.token, 'DELETE', `/channels/${general.id}/messages/${fwd.id}`);
  await ok(owner.token, 'DELETE', `/channels/${general.id}/messages/${again.id}`);
  assert.equal(await file(), 200, 'the DM copy still shows it');
  await ok(member.token, 'DELETE', `/channels/${dmFwd.channel_id}/messages/${dmFwd.id}`);
  assert.equal(await file(), 404);
});

test('channel reordering needs Manage Channels and lists each channel once', async () => {
  const g = await ok(owner.token, 'POST', '/guilds', { name: `Order ${run}` });
  const inv = await ok(owner.token, 'POST', `/guilds/${g.id}/invites`, {});
  await ok(member.token, 'POST', `/invites/${inv.code}`);
  const extra = await ok(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'second', kind: 0 });
  const ids = [extra.id, ...g.channels.map((c) => c.id)];
  assert.equal((await call(member.token, 'PUT', `/guilds/${g.id}/channels`, { ids })).status, 403);
  assert.equal((await call(owner.token, 'PUT', `/guilds/${g.id}/channels`, { ids: [...ids, ids[0]] })).status, 400);
  assert.equal((await call(owner.token, 'PUT', `/guilds/${g.id}/channels`, { ids: [...ids, '123'] })).status, 400);
  const watcher = await gateway(member.token);
  await ok(owner.token, 'PUT', `/guilds/${g.id}/channels`, { ids });
  await until(() => watcher.events.some((e) => e.t === 'CHANNEL_UPDATE' && e.d.id === extra.id && e.d.position === 0));
  watcher.ws.close();
});

test('categories: new servers get Text/Voice categories; channels move between them; deleting one keeps its channels', async () => {
  const owner = await login('catowner'); // own user: guild creation is rate limited per user
  const g = await ok(owner.token, 'POST', '/guilds', { name: `Cats ${run}` });
  const cats = g.channels.filter((c) => c.kind === 4);
  assert.deepEqual(
    cats.map((c) => c.name),
    ['Text Channels', 'Voice Channels'],
  );
  const general = g.channels.find((c) => c.name === 'general');
  assert.equal(general.parent_id, cats[0].id);
  const quests = await ok(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'Quests', kind: 4, parent_id: cats[0].id });
  assert.equal(quests.parent_id, null, 'categories do not nest');
  const lore = await ok(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'Lore Room', kind: 0, parent_id: quests.id });
  assert.equal(lore.name, 'lore-room');
  assert.equal(lore.parent_id, quests.id);
  assert.equal((await call(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'x', kind: 0, parent_id: general.id })).status, 400);

  const all = [...g.channels, quests, lore].map((c) => c.id);
  // Moving a category into a category, or a channel into a text channel, is refused.
  assert.equal((await call(owner.token, 'PUT', `/guilds/${g.id}/channels`, { ids: all, parents: { [quests.id]: cats[0].id } })).status, 400);
  assert.equal((await call(owner.token, 'PUT', `/guilds/${g.id}/channels`, { ids: all, parents: { [lore.id]: general.id } })).status, 400);
  await ok(owner.token, 'PUT', `/guilds/${g.id}/channels`, { ids: all, parents: { [general.id]: quests.id } });
  await ok(owner.token, 'DELETE', `/channels/${quests.id}`);
  const after = await ok(owner.token, 'POST', `/invites/${(await ok(owner.token, 'POST', `/guilds/${g.id}/invites`, {})).code}`);
  const byName = Object.fromEntries(after.channels.map((c) => [c.name, c]));
  assert.equal(byName.general.parent_id, null);
  assert.equal(byName['lore-room'].parent_id, null);
  assert.ok(!byName.Quests);
});

test('invites: preview counts, list and revoke', async () => {
  const owner = await login('invowner');
  const g = await ok(owner.token, 'POST', '/guilds', { name: `Inv ${run}` });
  const inv = await ok(owner.token, 'POST', `/guilds/${g.id}/invites`, {});
  const pv = await ok(outsider.token, 'GET', `/invites/${inv.code}`);
  assert.equal(pv.member_count, 2, "the owner and Kass, who comes with every server");
  assert.equal(typeof pv.online_count, 'number');
  assert.equal((await call(member.token, 'GET', `/guilds/${g.id}/invites`)).status, 404);
  const list = await ok(owner.token, 'GET', `/guilds/${g.id}/invites`);
  assert.ok(list.some((r) => r.invite.code === inv.code && r.inviter.id === owner.id));
  assert.equal((await call(outsider.token, 'DELETE', `/invites/${inv.code}`)).status, 404);
  await ok(owner.token, 'DELETE', `/invites/${inv.code}`);
  assert.equal((await call(outsider.token, 'GET', `/invites/${inv.code}`)).status, 404);
});

test('profiles show mutual friends and servers', async () => {
  const p = await ok(owner.token, 'GET', `/users/${member.id}/profile`);
  assert.equal(p.user.id, member.id);
  assert.ok(p.mutual_guilds.includes(guild.id));
  assert.ok(Array.isArray(p.mutual_friends));
  assert.ok(p.created_at);
});

test('server folders are a synced setting', async () => {
  const folders = [{ id: '1', name: 'Mine', color: 0x62d3d8, guild_ids: [guild.id] }];
  await ok(owner.token, 'PATCH', '/users/@me/settings', { guild_folders: folders });
  const me = await ok(owner.token, 'PATCH', '/users/@me/settings', { collapsed_categories: [] });
  assert.deepEqual(me.guild_folders, folders);
});

test('spotify: connect, "Listening to Spotify" reaches friends, seeks and song changes update it, pausing or hiding clears it', async () => {
  const MOCK = 'http://localhost:7702';
  const play = (track) => fetch(`${MOCK}/mock/playing`, { method: 'POST', body: JSON.stringify({ track }) });
  await play(null);
  const dj = await login('dj');
  const fan = await login('fan');
  await ok(dj.token, 'POST', '/users/@me/relationships', { username: fan.username });
  await ok(fan.token, 'POST', '/users/@me/relationships', { username: dj.username });

  // OAuth: our authorize URL -> Spotify consent (auto-approved by the mock) -> our callback.
  const { url } = await ok(dj.token, 'GET', '/connections/spotify/authorize');
  assert.ok(url.startsWith(`${MOCK}/authorize?client_id=test-client`), url);
  const consent = await fetch(url, { redirect: 'manual' });
  const page = await (await fetch(consent.headers.get('location'))).text();
  assert.match(page, /Mock Listener/);
  const conns = await ok(dj.token, 'GET', '/users/@me/connections');
  assert.deepEqual(
    conns.map((c) => [c.type, c.username, c.show_activity, c.show_on_profile]),
    [['spotify', 'Mock Listener', true, true]],
  );
  assert.ok(!JSON.stringify(conns).includes('at-'), 'tokens never leave the server');
  // A second visit to the callback can't reuse the state.
  assert.match(await (await fetch(consent.headers.get('location'))).text(), /expired/);

  const djWs = await gateway(dj.token);
  const fanWs = await gateway(fan.token);
  const activityOf = (ws) => {
    const ev = ws.events.filter((e) => e.t === 'PRESENCE_UPDATE' && e.d.user_id === dj.id).pop();
    return ev?.d.activities?.[0];
  };
  await play({ id: 'song1', name: 'First Song', artists: ['Alpha', 'Beta'], album: 'Debut' });
  const a = await until(() => activityOf(fanWs), 4000);
  assert.equal(a.name, 'Spotify');
  assert.equal(a.details, 'First Song');
  assert.equal(a.state, 'Alpha; Beta');
  assert.equal(a.album, 'Debut');
  assert.equal(a.url, 'https://open.spotify.com/track/song1');
  assert.ok(a.timestamps.end - a.timestamps.start === 180000);

  await play({ id: 'song2', name: 'Second Song' });
  await until(() => activityOf(fanWs)?.details === 'Second Song', 4000);
  // A fresh READY includes it too.
  const late = await gateway(fan.token);
  assert.equal(late.first.d.activities[dj.id][0].details, 'Second Song');
  late.ws.close();

  // "Display on profile" -> the profile lists the account.
  const prof = await ok(fan.token, 'GET', `/users/${dj.id}/profile`);
  assert.deepEqual(prof.connections, [{ type: 'spotify', id: 'mock-listener', name: 'Mock Listener' }]);

  // Paused: the activity goes away (like Discord).
  await play({ id: 'song2', name: 'Second Song', is_playing: false });
  await until(() => fanWs.events.at(-1)?.t === 'PRESENCE_UPDATE' && activityOf(fanWs) === undefined, 4000);

  // "Display Spotify as your status" off: nothing shown even while playing.
  await play({ id: 'song3', name: 'Third Song' });
  await until(() => activityOf(fanWs)?.details === 'Third Song', 4000);
  await ok(dj.token, 'PATCH', '/users/@me/connections/spotify', { show_activity: false, show_on_profile: false });
  await until(() => activityOf(fanWs) === undefined, 4000);
  assert.deepEqual((await ok(fan.token, 'GET', `/users/${dj.id}/profile`)).connections, []);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(activityOf(fanWs), undefined);
  await ok(dj.token, 'PATCH', '/users/@me/connections/spotify', { show_activity: true });
  await until(() => activityOf(fanWs)?.details === 'Third Song', 4000);

  // Disconnecting removes the account and the activity.
  await ok(dj.token, 'DELETE', '/users/@me/connections/spotify');
  await until(() => activityOf(fanWs) === undefined, 4000);
  assert.deepEqual(await ok(dj.token, 'GET', '/users/@me/connections'), []);
  assert.ok(djWs.events.some((e) => e.t === 'USER_CONNECTIONS_UPDATE'));
  await play(null);
  djWs.ws.close();
  fanWs.ws.close();
});

test('games: detectable list for the desktop app; "Playing" reaches friends with the real name and icon; custom games; clearing', async () => {
  // Served once the server has fetched Discord's list (from the mock): Windows games only, no launcher-only apps.
  let list;
  for (let i = 0; i < 150 && !list; i++) {
    const r = await call(null, 'GET', '/activities/detectable');
    if (r.status === 200) list = r.body;
    else await new Promise((res) => setTimeout(res, 100));
  }
  assert.deepEqual(
    list.map((g) => g[1]),
    ['Counter-Strike 2', 'VALORANT'],
  );
  assert.deepEqual(list[0], ['1158877933042143272', 'Counter-Strike 2', '558f5a26ecb3b17c3dea3d15c1df537a', ['win64/cs2.exe']]);

  const gamer = await login('gamer');
  const pal = await login('pal');
  await ok(gamer.token, 'POST', '/users/@me/relationships', { username: pal.username });
  await ok(pal.token, 'POST', '/users/@me/relationships', { username: gamer.username });
  // Activities only show while you're online.
  const gamerWs = await gateway(gamer.token);
  const palWs = await gateway(pal.token);
  try {
    const playing = () =>
      palWs.events
        .filter((e) => e.t === 'PRESENCE_UPDATE' && e.d.user_id === gamer.id)
        .pop()
        ?.d.activities?.find((a) => a.type === 0);

    // A known game: the server uses the list's name and icon, whatever the client sent.
    const start = Date.now() - 60_000;
    await ok(gamer.token, 'PUT', '/activities/playing', { application_id: '1158877933042143272', name: 'cs2', started_at: start });
    const a = await until(() => playing(), 4000);
    assert.equal(a.name, 'Counter-Strike 2');
    assert.equal(a.icon, 'https://cdn.discordapp.com/app-icons/1158877933042143272/558f5a26ecb3b17c3dea3d15c1df537a.png?size=128');
    assert.equal(a.timestamps.start, start);
    // Refreshing the same game tells nobody.
    const before = palWs.events.length;
    await ok(gamer.token, 'PUT', '/activities/playing', { application_id: '1158877933042143272', name: 'cs2', started_at: start });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(palWs.events.length, before);
    // A fresh READY includes it.
    const late = await gateway(pal.token);
    assert.equal(late.first.d.activities[gamer.id][0].name, 'Counter-Strike 2');
    late.ws.close();

    // A game the user added themselves: name only, validated.
    await ok(gamer.token, 'PUT', '/activities/playing', { name: '  My Indie Game  ' });
    await until(() => playing()?.name === 'My Indie Game' && !playing().icon, 4000);
    assert.equal((await call(gamer.token, 'PUT', '/activities/playing', { name: '   ' })).status, 400);

    await ok(gamer.token, 'DELETE', '/activities/playing');
    await until(() => palWs.events.at(-1)?.t === 'PRESENCE_UPDATE' && playing() === undefined, 4000);
  } finally {
    palWs.ws.close();
    gamerWs.ws.close();
  }
});

// Its own time limit: the expiry sweep runs every 15 s, so waiting for it alone can take most of the default 20 s.
test('custom status: friends see emoji + text, your own sessions get it, it survives in READY, clears itself when it expires', { timeout: 45_000 }, async () => {
  const me = await login('statusy');
  const pal = await login('statuspal');
  await ok(me.token, 'POST', '/users/@me/relationships', { username: pal.username });
  await ok(pal.token, 'POST', '/users/@me/relationships', { username: me.username });
  const meWs = await gateway(me.token);
  const palWs = await gateway(pal.token);
  try {
    const seen = () =>
      palWs.events
        .filter((e) => e.t === 'PRESENCE_UPDATE' && e.d.user_id === me.id)
        .pop()
        ?.d.activities?.find((a) => a.type === 4);

    const saved = await ok(me.token, 'PUT', '/activities/custom', { text: '  Support has arrived!  ', emoji: { name: '🎮' }, expires_at: null });
    assert.equal(saved.state, 'Support has arrived!');
    assert.deepEqual(saved.emoji, { name: '🎮' });
    const a = await until(() => seen(), 4000);
    assert.equal(a.state, 'Support has arrived!');
    await until(() => meWs.events.some((e) => e.t === 'CUSTOM_STATUS_UPDATE' && e.d.custom_status?.state === 'Support has arrived!'), 4000);
    const late = await gateway(me.token);
    assert.equal(late.first.d.custom_status.state, 'Support has arrived!');
    late.ws.close();

    // Validation: too long, unknown server emoji; nothing at all clears it.
    assert.equal((await call(me.token, 'PUT', '/activities/custom', { text: 'x'.repeat(129) })).status, 400);
    assert.equal((await call(me.token, 'PUT', '/activities/custom', { emoji: { id: '123', name: 'nope' } })).status, 400);
    // Server emoji take their real name.
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
    const fd = new FormData();
    fd.append('name', 'shard');
    fd.append('file', new Blob([png], { type: 'image/png' }), 'shard.png');
    const em = await ok(owner.token, 'POST', `/guilds/${guild.id}/emojis`, fd);
    const withEmoji = await ok(me.token, 'PUT', '/activities/custom', { emoji: { id: em.id, name: 'renamed' } });
    assert.deepEqual(withEmoji.emoji, { id: em.id, name: 'shard', animated: false });

    // Expiry: the sweep (every 15 s) clears it and tells everyone.
    await ok(me.token, 'PUT', '/activities/custom', { text: 'brb', expires_at: Date.now() + 1000 });
    await until(() => seen()?.state === 'brb', 4000);
    await until(() => palWs.events.at(-1)?.t === 'PRESENCE_UPDATE' && !seen(), 20_000);
    assert.equal((await gateway(me.token).then((g) => (g.ws.close(), g.first.d.custom_status))) ?? null, null);

    await ok(me.token, 'PUT', '/activities/custom', { text: 'again' });
    await until(() => seen()?.state === 'again', 4000);
    await ok(me.token, 'DELETE', '/activities/custom');
    await until(() => palWs.events.at(-1)?.t === 'PRESENCE_UPDATE' && !seen(), 4000);
  } finally {
    palWs.ws.close();
    meWs.ws.close();
  }
});

test('call timer: everyone in a voice channel gets the same call start; it survives a quick rejoin and ends when the channel empties', async () => {
  const voiceCh = guild.channels.find((c) => c.kind === 2);
  const watch = await gateway(owner.token);
  const join = (u) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/voice/connect`);
      ws.onopen = () => ws.send(JSON.stringify({ token: u.token, channel_id: voiceCh.id }));
      ws.onmessage = (e) => typeof e.data === 'string' && JSON.parse(e.data).op === 'ready' && resolve(ws);
      ws.onerror = reject;
    });
  const stateOf = (u) =>
    watch.events
      .filter((e) => e.t === 'VOICE_STATE_UPDATE' && e.d.user_id === u.id)
      .pop()?.d;
  try {
    const a = await join(owner);
    const start = (await until(() => stateOf(owner)?.channel_id && stateOf(owner))).call_started_at;
    assert.ok(Math.abs(start - Date.now()) < 5000, `call_started_at = ${start}`);
    await new Promise((r) => setTimeout(r, 50));
    const b = await join(member);
    assert.equal((await until(() => stateOf(member)?.channel_id && stateOf(member))).call_started_at, start);
    // The first person leaving doesn't end the call, nor does the last one reconnecting right away.
    a.close();
    await until(() => stateOf(owner)?.channel_id === null);
    assert.equal(stateOf(owner).call_started_at, null);
    b.close();
    await until(() => stateOf(member)?.channel_id === null);
    const c = await join(member);
    assert.equal((await until(() => stateOf(member)?.channel_id && stateOf(member))).call_started_at, start);
    c.close();
    await until(() => stateOf(member)?.channel_id === null);
  } finally {
    watch.ws.close();
  }
});

test('voice channel status: people in the call set it, everyone in the server sees it, it shows in READY while the call goes on', async () => {
  const voiceCh = guild.channels.find((c) => c.kind === 2);
  const textCh = guild.channels.find((c) => c.kind === 0);
  const watch = await gateway(owner.token);
  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/voice/connect`);
    s.onopen = () => s.send(JSON.stringify({ token: member.token, channel_id: voiceCh.id }));
    s.onmessage = (e) => typeof e.data === 'string' && JSON.parse(e.data).op === 'ready' && resolve(s);
    s.onerror = reject;
  });
  const url = `/channels/${voiceCh.id}/voice-status`;
  const last = () => watch.events.filter((e) => e.t === 'VOICE_CHANNEL_STATUS_UPDATE').pop()?.d;
  try {
    // Not in the server / not a voice channel / too long.
    assert.equal((await call(outsider.token, 'PUT', url, { status: 'hi' })).status, 404);
    assert.equal((await call(member.token, 'PUT', `/channels/${textCh.id}/voice-status`, { status: 'hi' })).status, 400);
    assert.equal((await call(member.token, 'PUT', url, { status: 'x'.repeat(501) })).status, 400);

    const set = await ok(member.token, 'PUT', url, { status: '  ranked grind :3  ' });
    assert.equal(set.status, 'ranked grind :3');
    await until(() => last()?.status === 'ranked grind :3');
    assert.equal(last().channel_id, voiceCh.id);
    const ready = await gateway(outsider.token).then((g) => (g.ws.close(), g.first.d));
    assert.ok(!ready.voice_channel_statuses.some((s) => s.channel_id === voiceCh.id), 'only for members of the server');
    const mine = await gateway(owner.token).then((g) => (g.ws.close(), g.first.d));
    assert.deepEqual(
      mine.voice_channel_statuses.find((s) => s.channel_id === voiceCh.id),
      { guild_id: guild.id, channel_id: voiceCh.id, status: 'ranked grind :3' },
    );

    // The owner isn't in the call but manages channels; an empty status clears it.
    await ok(owner.token, 'PUT', url, { status: '' });
    await until(() => last() && last().status === null);
  } finally {
    ws.close();
    watch.ws.close();
  }
  // Nobody in the call: only people in it could set it now.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await call(owner.token, 'PUT', url, { status: 'hello?' })).status, 400);
});

test('direct access (skips Cloudflare): client IP from the connection, not headers; links point back to the address used', async () => {
  const DIRECT = 'http://localhost:7703';
  assert.equal(await (await fetch(`${DIRECT}/api/health`)).text(), 'ok');

  // Sign-in is rate limited per client IP. Behind the tunnel the server trusts CF-Connecting-IP...
  const start = (base, ip) => fetch(`${base}/api/auth/discord/start`, { headers: { 'cf-connecting-ip': ip }, redirect: 'manual' }).then((r) => r.status);
  const viaTunnel = [];
  for (let i = 0; i < 14; i++) viaTunnel.push(await start(BASE, `198.51.100.${i}`));
  assert.ok(!viaTunnel.includes(429), `tunnel: ${viaTunnel}`);
  // ...but on direct access anyone could send it, so a fresh fake IP per request must not dodge the limit.
  const direct = [];
  for (let i = 0; i < 14; i++) direct.push(await start(DIRECT, `203.0.113.${i}`));
  assert.ok(direct.includes(429), `direct access trusted a spoofed IP: ${direct}`);

  // Spotify sends people back to the address they came from.
  const u = await login('direct');
  const authUrl = async (base) => {
    const r = await fetch(`${base}/api/connections/spotify/authorize`, { headers: { authorization: `Bearer ${u.token}` } });
    return new URL((await r.json()).url).searchParams.get('redirect_uri');
  };
  assert.equal(await authUrl(BASE), 'http://localhost:7701/api/connections/spotify/callback');
  assert.equal(await authUrl(DIRECT), 'http://localhost:7703/api/connections/spotify/callback');
});

test('Kass, the music bot: /play joins your voice channel and streams music; queue, remove, repeat, pause, skip and stop', { skip: !process.env.LINKORD_TEST_DATA_DIR, timeout: 60000 }, async () => {
  // run-local.sh points LINKORD_YTDLP at tests/ytdlp-mock.sh: every "video" is 8 s of a tone.
  const voiceCh = guild.channels.find((c) => c.kind === 2);
  const cmd = (u, name, query = '') => call(u.token, 'POST', `/channels/${general.id}/commands`, { name, query });
  const watch = await gateway(owner.token);
  const packets = [];
  let ws;
  try {
    assert.equal((await cmd(outsider, 'play', 'x')).status, 404);
    assert.equal((await cmd(member, 'play', 'some song')).body.error, 'join a voice channel first');

    ws = await new Promise((resolve, reject) => {
      const s = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/voice/connect`);
      s.binaryType = 'arraybuffer';
      s.onopen = () => s.send(JSON.stringify({ token: member.token, channel_id: voiceCh.id }));
      s.onmessage = (e) => {
        if (typeof e.data === 'string') return JSON.parse(e.data).op === 'ready' && resolve(s);
        const v = new DataView(e.data);
        packets.push({ kind: v.getUint8(0), from: v.getBigUint64(1).toString(), at: Date.now() });
      };
      s.onerror = reject;
    });
    assert.equal((await cmd(member, 'play', 'https://example.com/song.mp3')).body.error, 'only YouTube and Spotify links can be played');
    assert.equal((await cmd(member, 'play', 'nothing at all')).body.error, "couldn't find that video");
    assert.equal((await cmd(member, 'play', '   ')).status, 400);

    const first = await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'play', query: 'https://youtu.be/x?v=one' });
    assert.ok(first.author.bot);
    assert.equal(first.author.username, 'kass');
    assert.equal(first.interaction.name, 'play');
    assert.equal(first.interaction.user.id, member.id);
    assert.equal(first.embeds[0].type, 'rich');
    assert.equal(first.embeds[0].site_name, 'Now playing');
    assert.equal(first.embeds[0].title, 'Mock Song one');
    const bot = first.author.id;
    assert.equal((await call(owner.token, 'PUT', `/users/@me/relationships/${bot}`)).body.error, "bots can't be friends");

    // Kass is already in the server (he comes with every one), joins the member's channel (deafened) and his music
    // arrives as kind 5.
    assert.ok(watch.first.d.guilds.find((g) => g.id === guild.id).members.some((m) => m.user.id === bot));
    const botState = await until(() => watch.events.filter((e) => e.t === 'VOICE_STATE_UPDATE' && e.d.user_id === bot).pop()?.d);
    assert.equal(botState.channel_id, voiceCh.id);
    assert.ok(botState.self_deaf);
    await until(() => packets.filter((p) => p.kind === 5 && p.from === bot).length >= 10);
    // Paced in real time: ~50 packets a second, not the whole song at once.
    const music = () => packets.filter((p) => p.kind === 5);
    assert.ok(music().length < 40, `${music().length} packets right after starting`);
    const presence = (await gateway(owner.token).then((g) => (g.ws.close(), g.first.d))).presences;
    assert.equal(presence[bot], 'online');

    const queued = await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'play', query: 'never gonna' });
    assert.equal(queued.embeds[0].site_name, 'Queued · #1');
    assert.equal(queued.embeds[0].title, 'Mock Song search');
    const q = await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'queue' });
    assert.match(q.content, /\*\*Now playing:\*\* \[Mock Song one\]/);
    assert.match(q.content, /`1\.` \[Mock Song search\]/);

    // /remove takes a song out of the queue by its number in /queue or by part of its name.
    await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'play', query: 'https://youtu.be/x?v=two' });
    await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'play', query: 'https://youtu.be/x?v=three' });
    assert.equal((await cmd(member, 'remove', '4')).body.error, 'no song with that number in the queue');
    assert.equal((await cmd(member, 'remove', 'zzz')).body.error, 'no song in the queue matches that');
    assert.equal((await cmd(member, 'remove')).body.error, 'tell me which song to remove: its number in /queue or part of its name');
    assert.equal((await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'remove', query: '3' })).content, 'Removed **Mock Song three** from the queue');
    assert.equal((await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'remove', query: 'SONG TWO' })).content, 'Removed **Mock Song two** from the queue');
    const left = await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'queue' });
    assert.doesNotMatch(left.content, /Mock Song (two|three)/);
    assert.match(left.content, /`1\.` \[Mock Song search\]/);

    // Only people in Kass's channel control him.
    assert.equal((await cmd(owner, 'skip')).body.error, "join Kass's voice channel first");

    await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'pause' });
    assert.equal((await cmd(member, 'pause')).body.error, 'already paused');
    await new Promise((r) => setTimeout(r, 150));
    const paused = music().length;
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(music().length - paused <= 1, 'no music while paused');
    await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'resume' });
    await until(() => music().length > paused + 5);

    const skipped = await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'skip' });
    assert.equal(skipped.content, 'Skipped **Mock Song one**');
    // The queued song starts with its own "Now playing", credited to whoever asked for it.
    const next = await until(() =>
      watch.events.find((e) => e.t === 'MESSAGE_CREATE' && e.d.author.id === bot && e.d.embeds[0]?.title === 'Mock Song search' && e.d.embeds[0].site_name === 'Now playing'),
    );
    assert.equal(next.d.interaction.user.id, member.id);

    // /repeat on its own repeats the current song: it plays past its end with no new "Now playing" and /queue says so.
    assert.equal((await cmd(member, 'repeat', 'sometimes')).body.error, 'repeat takes song, queue or off');
    const started = music().length;
    const nowPlaying = () => watch.events.filter((e) => e.t === 'MESSAGE_CREATE' && e.d.author.id === bot && e.d.embeds[0]?.site_name === 'Now playing').length;
    const announced = nowPlaying();
    assert.equal((await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'repeat' })).content, 'Repeating **Mock Song search**');
    assert.match((await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'queue' })).content, /\*\*Repeating\*\* this song/);
    await until(() => music().length > started + 450, 15000); // past the 8 s song
    assert.equal(nowPlaying(), announced);
    // A song that played (not one skipped right away) counts for the profile's top songs, for whoever asked.
    const top = await until(async () => (await ok(owner.token, 'GET', `/users/${member.id}/profile`)).top_songs.find((s) => s.title === 'Mock Song search'));
    assert.ok(top.plays >= 1);
    assert.match((await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'queue' })).content, /Now playing:\*\* \[Mock Song search\]/);
    // Repeating the queue: a skipped song goes to the back and comes round again (here, right away: it's alone).
    assert.equal((await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'repeat', query: 'queue' })).content, 'Repeating the queue');
    await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'skip' });
    await until(() => nowPlaying() === announced + 1);
    assert.equal((await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'repeat', query: 'off' })).content, 'Stopped repeating');

    const stopped = await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'stop' });
    assert.match(stopped.content, /Stopped/);
    await until(() => watch.events.filter((e) => e.t === 'VOICE_STATE_UPDATE' && e.d.user_id === bot).pop()?.d.channel_id === null);
    const history = await ok(member.token, 'GET', `/channels/${general.id}/messages`);
    assert.equal(history.find((m) => m.id === first.id).interaction.user.id, member.id, 'interactions are stored');

    // YouTube refusing the download (e.g. its bot check) is reported in the channel.
    await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'play', query: 'https://www.youtube.com/watch?v=broken' });
    await until(() => watch.events.find((e) => e.t === 'MESSAGE_CREATE' && e.d.author.id === bot && /^Couldn't play \*\*Mock Song broken\*\*/.test(e.d.content)));
    await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'stop' });
  } finally {
    ws?.close();
    watch.ws.close();
  }
});

/** Joins a voice channel (or DM call) over the voice socket; resolves once the server says ready. */
function voiceJoin(u, channelId, onText) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/voice/connect`);
    ws.onopen = () => ws.send(JSON.stringify({ token: u.token, channel_id: channelId }));
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      if (m.op === 'ready') resolve(ws);
      else onText?.(m);
    };
    ws.onerror = reject;
    ws.onclose = (e) => reject(new Error(`closed ${e.code}`));
  });
}

test('system messages: joining a server posts in the first text channel; pinning posts a "pinned" message', async () => {
  const g = await ok(owner.token, 'POST', '/guilds', { name: `Sys ${run}` });
  const text = g.channels.find((c) => c.kind === 0);
  const inv = await ok(owner.token, 'POST', `/guilds/${g.id}/invites`, {});
  await ok(member.token, 'POST', `/invites/${inv.code}`);
  const msgs = await ok(owner.token, 'GET', `/channels/${text.id}/messages`);
  const join = msgs.find((m) => m.type === 7);
  assert.equal(join?.author.id, member.id);
  const m = await ok(owner.token, 'POST', `/channels/${text.id}/messages`, { content: 'pin me' });
  await ok(owner.token, 'PUT', `/channels/${text.id}/pins/${m.id}`);
  await ok(owner.token, 'PUT', `/channels/${text.id}/pins/${m.id}`);
  const after = await ok(owner.token, 'GET', `/channels/${text.id}/messages`);
  const pins = after.filter((x) => x.type === 6);
  assert.equal(pins.length, 1, 'pinning twice posts once');
  assert.equal(pins[0].reply_to, m.id);
  assert.equal((await call(owner.token, 'PATCH', `/channels/${text.id}/messages/${pins[0].id}`, { content: 'x' })).status, 400);
  // Turned off: nothing is posted.
  await ok(owner.token, 'PATCH', `/guilds/${g.id}`, { join_messages: false });
  await ok(outsider.token, 'POST', `/invites/${inv.code}`);
  const last = await ok(owner.token, 'GET', `/channels/${text.id}/messages`);
  assert.ok(!last.some((x) => x.type === 7 && x.author.id === outsider.id));
  await ok(owner.token, 'DELETE', `/guilds/${g.id}`);
});

test('server settings: system channel, AFK channel and timeout are checked', async () => {
  const voice = guild.channels.find((c) => c.kind === 2);
  assert.equal((await call(owner.token, 'PATCH', `/guilds/${guild.id}`, { afk_channel_id: general.id })).status, 400);
  assert.equal((await call(owner.token, 'PATCH', `/guilds/${guild.id}`, { afk_timeout: 7 })).status, 400);
  const g = await ok(owner.token, 'PATCH', `/guilds/${guild.id}`, { afk_channel_id: voice.id, afk_timeout: 900, system_channel_id: general.id });
  assert.equal(g.afk_channel_id, voice.id);
  assert.equal(g.afk_timeout, 900);
  assert.equal(g.system_channel_id, general.id);
  const cleared = await ok(owner.token, 'PATCH', `/guilds/${guild.id}`, { afk_channel_id: null, system_channel_id: null });
  assert.equal(cleared.afk_channel_id, null);
  assert.equal((await call(member.token, 'PATCH', `/guilds/${guild.id}`, { afk_timeout: 60 })).status, 403);
});

test('voice channels have their own chat', async () => {
  const voice = guild.channels.find((c) => c.kind === 2);
  const m = await ok(member.token, 'POST', `/channels/${voice.id}/messages`, { content: 'in the call chat' });
  assert.equal(m.channel_id, voice.id);
});

test('search: everywhere you are, and the mentions/pinned/date filters', async () => {
  await ok(owner.token, 'POST', `/channels/${general.id}/messages`, { content: `hey <@${member.id}> zebracorn` });
  const all = await ok(member.token, 'GET', '/users/@me/messages/search?q=zebracorn');
  assert.ok(all.total >= 1);
  const mentions = await ok(owner.token, 'GET', `/guilds/${guild.id}/messages/search?mentions=${member.id}`);
  assert.ok(mentions.messages.every((m) => m.content.includes(`<@${member.id}>`)) && mentions.total >= 1);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  assert.ok((await ok(owner.token, 'GET', `/guilds/${guild.id}/messages/search?q=zebracorn&before=${tomorrow}`)).total >= 1);
  assert.equal((await ok(owner.token, 'GET', `/guilds/${guild.id}/messages/search?q=zebracorn&after=${tomorrow}`)).total, 0);
  assert.equal((await ok(owner.token, 'GET', `/guilds/${guild.id}/messages/search?q=zebracorn&pinned=true`)).total, 0);
  assert.equal((await ok(outsider.token, 'GET', '/users/@me/messages/search?q=zebracorn')).total, 0);
});

test('notification levels are synced settings', async () => {
  const s = await ok(member.token, 'PATCH', '/users/@me/settings', {
    guild_notifications: { [guild.id]: 'mentions' },
    channel_notifications: { [general.id]: 'all' },
  });
  assert.equal(s.guild_notifications[guild.id], 'mentions');
});

test('logs: clients report errors into the log files, the app no longer serves them', async () => {
  assert.equal((await call(owner.token, 'POST', '/logs/client', { level: 'error', message: 'test error from api tests' })).status, 204);
  assert.equal((await call(owner.token, 'POST', '/logs/client', { level: 'shout', message: 'x' })).status, 400);
  // Reading them is the monitor's job now (tests/monitor.test.mjs), even for admins.
  const { token: admin } = await ok(null, 'POST', '/auth/dev', { username: 'logadmin' });
  const res = await fetch(`${BASE}/api/admin/logs/days`, { headers: { authorization: `Bearer ${admin}` } });
  assert.doesNotMatch(res.headers.get('content-type') ?? '', /json/, 'the old logs route must be gone');
});

test('soundboard: default sounds, server sounds need Manage Emojis, everyone in the call gets a played sound', { skip: !process.env.LINKORD_TEST_DATA_DIR }, async () => {
  const defaults = await ok(member.token, 'GET', '/soundboard/default');
  assert.ok(defaults.some((s) => s.name === 'sleigh bells' && s.emoji === '🔔'), JSON.stringify(defaults.slice(0, 2)));
  const mp3 = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=1', '-f', 'mp3', 'pipe:1']);
  const form = () => {
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({ name: 'beep', emoji: '🔔', volume: 0.5 }));
    fd.append('file', new Blob([mp3], { type: 'audio/mpeg' }), 'beep.mp3');
    return fd;
  };
  assert.equal((await call(member.token, 'POST', `/guilds/${guild.id}/soundboard`, form())).status, 403);
  const sound = await ok(owner.token, 'POST', `/guilds/${guild.id}/soundboard`, form());
  assert.equal(sound.volume, 0.5);
  // A long file is cut: the part you pick (5.2 s at most), and it can be trimmed again later from the original.
  const long = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=8', '-b:a', '32k', '-f', 'mp3', 'pipe:1']);
  const lf = new FormData();
  lf.append('payload_json', JSON.stringify({ name: 'long one', trim_start: 1, trim_end: 4 }));
  lf.append('file', new Blob([long], { type: 'audio/mpeg' }), 'long.mp3');
  const cut = await ok(owner.token, 'POST', `/guilds/${guild.id}/soundboard`, lf);
  assert.equal(cut.trim_start, 1);
  assert.equal(cut.trim_end, 4);
  assert.ok(cut.source && cut.source !== cut.url);
  const lengthOf = (url) =>
    Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(process.env.LINKORD_TEST_DATA_DIR, 'uploads', url.replace('/uploads/', ''))]).toString());
  assert.ok(Math.abs(lengthOf(cut.url) - 3) < 0.2, `cut is ${lengthOf(cut.url)} s`);
  const retrimmed = await ok(owner.token, 'PATCH', `/guilds/${guild.id}/soundboard/${cut.id}`, { trim_start: 6, trim_end: 7.5, volume: 0.3 });
  assert.notEqual(retrimmed.url, cut.url);
  assert.equal(retrimmed.volume, 0.3);
  assert.ok(Math.abs(lengthOf(retrimmed.url) - 1.5) < 0.2);
  assert.equal((await call(owner.token, 'PATCH', `/guilds/${guild.id}/soundboard/${cut.id}`, { trim_start: 0, trim_end: 7 })).body.error, 'sounds can be at most 5 seconds long');
  await ok(owner.token, 'DELETE', `/guilds/${guild.id}/soundboard/${cut.id}`);
  const voice = guild.channels.find((c) => c.kind === 2);
  const heard = [];
  const a = await voiceJoin(owner, voice.id);
  const b = await voiceJoin(member, voice.id, (m) => m.op === 'sound' && heard.push(m));
  try {
    a.send(JSON.stringify({ op: 'sound', sound_id: sound.id }));
    a.send(JSON.stringify({ op: 'sound', sound_id: defaults[0].id }));
    await until(() => heard.length === 2);
    assert.equal(heard[0].user_id, owner.id);
    assert.equal(heard[0].sound.name, 'beep');
  } finally {
    a.close();
    b.close();
  }
  await ok(owner.token, 'DELETE', `/guilds/${guild.id}/soundboard/${sound.id}`);
  assert.equal((await ok(owner.token, 'GET', `/guilds/${guild.id}/soundboard`)).length, 0);
});

test('watch together: only people in the call start or control it; it ends with the call', async () => {
  const voice = guild.channels.find((c) => c.kind === 2);
  const url = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  assert.equal((await call(owner.token, 'PUT', `/channels/${voice.id}/watch`, { url })).body.error, 'join the call first');
  const watch = await gateway(member.token);
  const a = await voiceJoin(owner, voice.id);
  try {
    assert.equal((await call(owner.token, 'PUT', `/channels/${voice.id}/watch`, { url: 'https://evil.example/x' })).status, 400);
    const w = await ok(owner.token, 'PUT', `/channels/${voice.id}/watch`, { url });
    assert.equal(w.provider, 'youtube');
    assert.equal(w.media, 'aqz-KE-bpKQ');
    const paused = await ok(owner.token, 'PATCH', `/channels/${voice.id}/watch`, { playing: false, position: 42 });
    assert.equal(paused.playing, false);
    assert.equal(paused.position, 42);
    await until(() => watch.events.some((e) => e.t === 'WATCH_UPDATE' && e.d.watch?.position === 42));
    // Reaching the end: "ended" for everyone (reported once), until someone plays it again.
    const ended = await ok(owner.token, 'PATCH', `/channels/${voice.id}/watch`, { ended: true, position: 635 });
    assert.equal(ended.ended, true);
    assert.equal(ended.playing, false);
    const again = await ok(owner.token, 'PATCH', `/channels/${voice.id}/watch`, { position: 0, playing: true });
    assert.equal(again.ended, false);
    assert.equal(again.playing, true);
    // A player finds out it's a live stream: it never ends.
    await ok(owner.token, 'PATCH', `/channels/${voice.id}/watch`, { ended: true, position: 635 });
    const live = await ok(owner.token, 'PATCH', `/channels/${voice.id}/watch`, { live: true });
    assert.equal(live.live, true);
    assert.equal(live.ended, false);
    assert.equal(live.playing, true);
    const still = await ok(owner.token, 'PATCH', `/channels/${voice.id}/watch`, { ended: true, position: 10 });
    assert.equal(still.ended, false);
    assert.equal(still.playing, true);
  } finally {
    a.close();
  }
  await until(() => watch.events.some((e) => e.t === 'WATCH_UPDATE' && e.d.watch === null));
  watch.ws.close();
});

test('watch together: opt-in, the server keeps who is watching; leaving the call takes you off the list', async () => {
  const voice = guild.channels.find((c) => c.kind === 2);
  const url = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  const watch = await gateway(owner.token);
  const a = await voiceJoin(owner, voice.id);
  let b;
  try {
    const w = await ok(owner.token, 'PUT', `/channels/${voice.id}/watch`, { url });
    assert.deepEqual(w.viewers, [owner.id], 'whoever shares it is watching');
    assert.equal((await call(member.token, 'PUT', `/channels/${voice.id}/watch/view`, { on: true })).body.error, 'join the call first');
    b = await voiceJoin(member, voice.id);
    const viewers = () => watch.events.filter((e) => e.t === 'WATCH_UPDATE' && e.d.channel_id === voice.id).pop()?.d.watch?.viewers;
    await ok(member.token, 'PUT', `/channels/${voice.id}/watch/view`, { on: true });
    await until(() => viewers()?.includes(member.id));
    await ok(member.token, 'PUT', `/channels/${voice.id}/watch/view`, { on: false });
    await until(() => viewers() && !viewers().includes(member.id));
    await ok(member.token, 'PUT', `/channels/${voice.id}/watch/view`, { on: true });
    await until(() => viewers()?.includes(member.id));
    // A new link keeps who already had the player open.
    assert.deepEqual((await ok(owner.token, 'PUT', `/channels/${voice.id}/watch`, { url })).viewers.sort(), [owner.id, member.id].sort());
    b.close();
    b = null;
    await until(() => viewers() && !viewers().includes(member.id));
  } finally {
    b?.close();
    a.close();
  }
  await until(() => watch.events.some((e) => e.t === 'WATCH_UPDATE' && e.d.channel_id === voice.id && e.d.watch === null));
  watch.ws.close();
});

test('stream previews: only someone live can send one; people who see the channel can fetch it', async () => {
  const voice = guild.channels.find((c) => c.kind === 2);
  const outsider = await login('previewout');
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const put = (token, body) =>
    fetch(`${BASE}/api/voice/preview`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' }, body });
  const get = (token) => fetch(`${BASE}/api/users/${owner.id}/stream-preview`, { headers: { authorization: `Bearer ${token}` } });
  const a = await voiceJoin(owner, voice.id);
  try {
    assert.equal((await put(owner.token, jpeg)).status, 400, 'not streaming yet');
    // The first screen frame makes us live.
    a.send(new Uint8Array([3, 3, 0, 1, 0, 0, 0, 1]));
    await until(async () => (await put(owner.token, jpeg)).status === 200);
    assert.equal((await put(owner.token, new Uint8Array([1, 2, 3]))).status, 400, 'only JPEGs');
    const res = await get(member.token);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), jpeg);
    assert.notEqual((await get(outsider.token)).status, 200, 'not in the server');
  } finally {
    a.close();
  }
  await until(async () => (await get(member.token)).status === 404);
});

test('DM calls: starting one rings the other person; joining or declining stops it', async () => {
  const x = await login('callx');
  const y = await login('cally');
  await ok(x.token, 'PUT', `/users/@me/relationships/${y.id}`, {});
  await ok(y.token, 'PUT', `/users/@me/relationships/${x.id}`, {});
  const dm = await ok(x.token, 'POST', '/users/@me/channels', { recipient_id: y.id });
  const gw = await gateway(y.token);
  const ringing = () => gw.events.filter((e) => e.t === 'CALL_UPDATE' && e.d.channel_id === dm.id).pop()?.d.ringing;
  const a = await voiceJoin(x, dm.id);
  try {
    await until(() => ringing()?.includes(y.id));
    await ok(y.token, 'POST', `/channels/${dm.id}/call/decline`);
    await until(() => ringing()?.length === 0);
    await ok(x.token, 'POST', `/channels/${dm.id}/call/ring`, {});
    await until(() => ringing()?.includes(y.id));
    const b = await voiceJoin(y, dm.id);
    await until(() => ringing()?.length === 0);
    const vs = gw.events.filter((e) => e.t === 'VOICE_STATE_UPDATE' && e.d.user_id === x.id).pop()?.d;
    assert.equal(vs.guild_id, null);
    assert.equal(vs.channel_id, dm.id);
    b.close();
  } finally {
    a.close();
    gw.ws.close();
  }
  // Outsiders can't join someone else's DM call.
  await assert.rejects(voiceJoin(outsider, dm.id), /closed 4004/);
});

test('DM receipts: sent, delivered once a device of theirs has it, read once they read it', async () => {
  const x = await login('rcptx');
  const y = await login('rcpty');
  await ok(x.token, 'PUT', `/users/@me/relationships/${y.id}`, {});
  await ok(y.token, 'PUT', `/users/@me/relationships/${x.id}`, {});
  const dm = await ok(x.token, 'POST', '/users/@me/channels', { recipient_id: y.id });
  const gx = await gateway(x.token);
  const receipt = (key) => gx.events.filter((e) => e.t === 'DM_RECEIPT' && e.d.channel_id === dm.id && e.d.user_id === y.id && e.d[key]).pop()?.d[key];
  try {
    // y has no socket open: sent only.
    const first = await ok(x.token, 'POST', `/channels/${dm.id}/messages`, { content: 'one' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(receipt('delivered_id'), undefined);
    // Their phone got the push (the Android app says so)...
    await ok(y.token, 'POST', `/channels/${dm.id}/delivered`, { message_id: first.id });
    await until(() => receipt('delivered_id') === first.id);
    // ...but never past the newest message.
    await ok(y.token, 'POST', `/channels/${dm.id}/delivered`, { message_id: '999999999999999999' });
    // With a socket open, a new message is delivered at once.
    const gy = await gateway(y.token);
    try {
      const second = await ok(x.token, 'POST', `/channels/${dm.id}/messages`, { content: 'two' });
      await until(() => receipt('delivered_id') === second.id);
      await ok(y.token, 'POST', `/channels/${dm.id}/ack`, { message_id: second.id });
      await until(() => receipt('read_id') === second.id);
    } finally {
      gy.ws.close();
    }
    // Message info (the author only): when each was delivered and read.
    const info = await ok(x.token, 'GET', `/channels/${dm.id}/messages/${first.id}/receipts`);
    assert.equal(info.length, 1);
    assert.equal(info[0].user_id, y.id);
    assert.ok(info[0].delivered && info[0].read && info[0].delivered_at && info[0].read_at);
    assert.ok(Date.parse(info[0].delivered_at) <= Date.parse(info[0].read_at));
    assert.equal((await call(y.token, 'GET', `/channels/${dm.id}/messages/${first.id}/receipts`)).status, 404);
    // READY has where they are.
    const ready = await gateway(x.token).then((g) => (g.ws.close(), g.first.d));
    const mine = ready.dm_receipts[dm.id].find((r) => r.user_id === y.id);
    assert.equal(mine.read_id, receipt('read_id'));
    assert.equal(mine.delivered_id, receipt('delivered_id'));
    // Privacy: with read receipts off, y's reads are hidden from x (and x's from y); delivered still shows.
    const before = gx.events.length;
    await ok(y.token, 'PATCH', '/users/@me', { read_receipts: false });
    await until(() => gx.events.slice(before).some((e) => e.t === 'DM_RECEIPTS'));
    const reset = gx.events.slice(before).find((e) => e.t === 'DM_RECEIPTS').d.receipts[dm.id].find((r) => r.user_id === y.id);
    assert.equal(reset.read_id, null);
    assert.ok(reset.delivered_id);
    const hidden = await ok(x.token, 'GET', `/channels/${dm.id}/messages/${first.id}/receipts`);
    assert.equal(hidden[0].read_receipts, false);
    assert.equal(hidden[0].read, false);
    assert.equal(hidden[0].read_at, null);
    assert.equal(hidden[0].delivered, true);
    const third = await ok(x.token, 'POST', `/channels/${dm.id}/messages`, { content: 'three' });
    const seen = gx.events.length;
    await ok(y.token, 'POST', `/channels/${dm.id}/ack`, { message_id: third.id });
    // Reading still counts as delivered, but no read receipt goes out.
    await until(() => receipt('delivered_id') === third.id);
    assert.ok(!gx.events.slice(seen).some((e) => e.t === 'DM_RECEIPT' && e.d.read_id));
    assert.equal((await ok(y.token, 'GET', '/users/@me')).read_receipts, false);
    await ok(y.token, 'PATCH', '/users/@me', { read_receipts: true });
    // Outsiders can't mark someone else's DM.
    assert.equal((await call(outsider.token, 'POST', `/channels/${dm.id}/delivered`, { message_id: first.id })).status, 204);
    const again = await gateway(x.token).then((g) => (g.ws.close(), g.first.d));
    assert.equal(again.dm_receipts[dm.id].length, 1);
  } finally {
    gx.ws.close();
  }
});

test('DM voice messages: read once played, like WhatsApp; the author sees who played it and when', async () => {
  const x = await login('playx');
  const y = await login('playy');
  await ok(x.token, 'PUT', `/users/@me/relationships/${y.id}`, {});
  await ok(y.token, 'PUT', `/users/@me/relationships/${x.id}`, {});
  const dm = await ok(x.token, 'POST', '/users/@me/channels', { recipient_id: y.id });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkord-voice-'));
  const file = path.join(dir, 'note.ogg');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', '-b:a', '32k', file]);
  const note = new FormData();
  note.append('payload_json', JSON.stringify({ voice: { duration_secs: 1, waveform: 'AAECAwQ=' } }));
  note.append('files[0]', new Blob([fs.readFileSync(file)], { type: 'audio/ogg' }), 'voice-message.ogg');
  const voice = await ok(x.token, 'POST', `/channels/${dm.id}/messages`, note);
  fs.rmSync(dir, { recursive: true });
  const text = await ok(x.token, 'POST', `/channels/${dm.id}/messages`, { content: 'not a voice message' });
  const gx = await gateway(x.token);
  try {
    const playedBy = async () => (await ok(x.token, 'GET', `/channels/${dm.id}/messages`)).find((m) => m.id === voice.id).played_by;
    assert.deepEqual(await playedBy(), []);
    // Only the recipients' plays of a voice message count; the author's own is ignored.
    assert.equal((await call(y.token, 'POST', `/channels/${dm.id}/messages/${text.id}/played`)).status, 404);
    assert.equal((await call(outsider.token, 'POST', `/channels/${dm.id}/messages/${voice.id}/played`)).status, 404);
    assert.equal((await call(x.token, 'POST', `/channels/${dm.id}/messages/${voice.id}/played`)).status, 204);
    assert.deepEqual(await playedBy(), []);
    await ok(y.token, 'POST', `/channels/${dm.id}/messages/${voice.id}/played`);
    await until(() => gx.events.some((e) => e.t === 'VOICE_PLAYED' && e.d.message_id === voice.id && e.d.user_id === y.id));
    assert.deepEqual(await playedBy(), [y.id]);
    // Only the author's own messages carry it.
    assert.equal((await ok(y.token, 'GET', `/channels/${dm.id}/messages`)).find((m) => m.id === voice.id).played_by, undefined);
    const [info] = await ok(x.token, 'GET', `/channels/${dm.id}/messages/${voice.id}/receipts`);
    assert.ok(info.played_at);
    // Privacy: with read receipts off, plays are hidden too, and new ones aren't announced.
    await ok(y.token, 'PATCH', '/users/@me', { read_receipts: false });
    assert.deepEqual(await playedBy(), []);
    assert.equal((await ok(x.token, 'GET', `/channels/${dm.id}/messages/${voice.id}/receipts`))[0].played_at, null);
    await ok(y.token, 'PATCH', '/users/@me', { read_receipts: true });
    assert.deepEqual(await playedBy(), [y.id]);
  } finally {
    gx.ws.close();
  }
});

test('changelog: the Android app has its own patch notes', async () => {
  assert.ok(Array.isArray(await ok(null, 'GET', '/changelog?app=android')));
  assert.ok(Array.isArray(await ok(null, 'GET', '/changelog')));
});

test('group DMs: the owner can hand the group over and remove people', async () => {
  const [p, q, r] = await Promise.all([login('gp'), login('gq'), login('gr')]);
  for (const u of [q, r]) {
    await ok(p.token, 'PUT', `/users/@me/relationships/${u.id}`, {});
    await ok(u.token, 'PUT', `/users/@me/relationships/${p.id}`, {});
  }
  const g = await ok(p.token, 'POST', '/users/@me/channels', { recipients: [q.id, r.id] });
  assert.equal((await call(q.token, 'PATCH', `/channels/${g.id}`, { owner_id: q.id })).status, 400);
  assert.equal((await ok(p.token, 'PATCH', `/channels/${g.id}`, { owner_id: q.id })).owner_id, q.id);
  assert.equal((await call(p.token, 'DELETE', `/channels/${g.id}/recipients/${r.id}`)).status, 403);
  await ok(q.token, 'DELETE', `/channels/${g.id}/recipients/${r.id}`);
});

// ---------- channel permissions (perms.rs) ----------

const VIEW = 1 << 10;
const SEND = 1 << 11;
const HISTORY = 1 << 16;
const MOVE = 1 << 24;
const MANAGE_ROLES = 1 << 28;

/** A new server with its owner and a member (creating and joining servers are rate limited per person). */
async function permGuild(name) {
  const [o, m] = await Promise.all([login(`${name.toLowerCase()}o`), login(`${name.toLowerCase()}m`)]);
  const g = await ok(o.token, 'POST', '/guilds', { name: `${name} ${run}` });
  const inv = await ok(o.token, 'POST', `/guilds/${g.id}/invites`, {});
  await ok(m.token, 'POST', `/invites/${inv.code}`);
  return [g, m, o];
}

test('new servers let everyone view channels and read history, but not move members', () => {
  const everyone = guild.roles.find((r) => r.id === guild.id);
  assert.ok(everyone.permissions & VIEW);
  assert.ok(everyone.permissions & HISTORY);
  assert.ok(!(everyone.permissions & MOVE));
});

test('private channels: hidden from members until a role or member overwrite lets them in; access changes arrive live', async () => {
  const [g, m, o] = await permGuild('Private');
  const secret = await ok(o.token, 'POST', `/guilds/${g.id}/channels`, {
    name: 'secret',
    kind: 0,
    permission_overwrites: [{ id: g.id, type: 0, allow: 0, deny: VIEW }],
  });
  assert.deepEqual(secret.permission_overwrites, [{ id: g.id, type: 0, allow: 0, deny: VIEW }]);
  await ok(o.token, 'POST', `/channels/${secret.id}/messages`, { content: 'hush hush' });
  // Hidden: not in READY, can't be read, written, or found by search.
  const s1 = await gateway(m.token);
  const mine = s1.first.d.guilds.find((x) => x.id === g.id);
  assert.ok(!mine.channels.some((c) => c.id === secret.id));
  assert.equal((await call(m.token, 'GET', `/channels/${secret.id}/messages`)).status, 404);
  assert.equal((await call(m.token, 'POST', `/channels/${secret.id}/messages`, { content: 'hi' })).status, 404);
  const found = await ok(m.token, 'GET', `/guilds/${g.id}/messages/search?q=hush`);
  assert.equal(found.total, 0);
  // A role allowed to see it: giving it to the member shows the channel right away.
  const role = await ok(o.token, 'POST', `/guilds/${g.id}/roles`, { name: 'Insider' });
  await ok(o.token, 'PUT', `/channels/${secret.id}/permissions`, {
    permission_overwrites: [
      { id: g.id, type: 0, allow: 0, deny: VIEW },
      { id: role.id, type: 0, allow: VIEW, deny: 0 },
    ],
  });
  await ok(o.token, 'PATCH', `/guilds/${g.id}/members/${m.id}`, { roles: [role.id] });
  await until(() => s1.events.some((e) => e.t === 'CHANNEL_CREATE' && e.d.id === secret.id));
  assert.equal((await ok(m.token, 'GET', `/channels/${secret.id}/messages`))[0].content, 'hush hush');
  // A member overwrite beats the role.
  await ok(o.token, 'PUT', `/channels/${secret.id}/permissions`, {
    permission_overwrites: [
      { id: g.id, type: 0, allow: 0, deny: VIEW },
      { id: role.id, type: 0, allow: VIEW, deny: 0 },
      { id: m.id, type: 1, allow: 0, deny: VIEW },
    ],
  });
  await until(() => s1.events.some((e) => e.t === 'CHANNEL_DELETE' && e.d.id === secret.id && e.d.hidden));
  assert.equal((await call(m.token, 'GET', `/channels/${secret.id}/messages`)).status, 404);
  s1.ws.close();
});

test('channel overwrites: Manage Permissions needed, only for permissions you have, never on threads', async () => {
  const [g, m, o] = await permGuild('Overwrites');
  const text = g.channels.find((c) => c.kind === 0);
  const body = { permission_overwrites: [{ id: g.id, type: 0, allow: 0, deny: SEND }] };
  assert.equal((await call(m.token, 'PUT', `/channels/${text.id}/permissions`, body)).status, 403);
  // A channel-level Manage Permissions lets the member edit this channel, but not hand out what they lack.
  await ok(o.token, 'PUT', `/channels/${text.id}/permissions`, {
    permission_overwrites: [{ id: m.id, type: 1, allow: MANAGE_ROLES, deny: 0 }],
  });
  const bad = await call(m.token, 'PUT', `/channels/${text.id}/permissions`, {
    permission_overwrites: [
      { id: m.id, type: 1, allow: MANAGE_ROLES, deny: 0 },
      { id: g.id, type: 0, allow: MOVE, deny: 0 },
    ],
  });
  assert.equal(bad.status, 400);
  await ok(m.token, 'PUT', `/channels/${text.id}/permissions`, {
    permission_overwrites: [
      { id: m.id, type: 1, allow: MANAGE_ROLES, deny: 0 },
      { id: g.id, type: 0, allow: 0, deny: SEND },
    ],
  });
  assert.equal((await call(o.token, 'POST', `/channels/${text.id}/messages`, { content: 'still me' })).status, 200);
  assert.equal((await call(m.token, 'POST', `/channels/${text.id}/messages`, { content: 'muted' })).status, 403);
  // Unknown targets are refused; server-only permissions are dropped.
  const unknown = { permission_overwrites: [{ id: '42', type: 0, allow: 0, deny: 0 }] };
  assert.equal((await call(o.token, 'PUT', `/channels/${text.id}/permissions`, unknown)).status, 400);
  const cleaned = await ok(o.token, 'PUT', `/channels/${text.id}/permissions`, {
    permission_overwrites: [{ id: g.id, type: 0, allow: 1 << 3, deny: 0 }],
  });
  assert.deepEqual(cleaned, [{ id: g.id, type: 0, allow: 0, deny: 0 }]);
  const msg = await ok(o.token, 'POST', `/channels/${text.id}/messages`, { content: 'thread me' });
  const thread = await ok(o.token, 'POST', `/channels/${text.id}/messages/${msg.id}/threads`, {});
  assert.equal((await call(o.token, 'PUT', `/channels/${thread.id}/permissions`, body)).status, 400);
});

test('categories: new channels sync with them, category changes reach synced channels only, Sync Now', async () => {
  const [g, m, o] = await permGuild('Sync');
  const cat = await ok(o.token, 'POST', `/guilds/${g.id}/channels`, { name: 'Staff', kind: 4 });
  const locked = [{ id: g.id, type: 0, allow: 0, deny: VIEW }];
  await ok(o.token, 'PUT', `/channels/${cat.id}/permissions`, { permission_overwrites: locked });
  const synced = await ok(o.token, 'POST', `/guilds/${g.id}/channels`, { name: 'synced', kind: 0, parent_id: cat.id });
  assert.deepEqual(synced.permission_overwrites, locked);
  const own = await ok(o.token, 'POST', `/guilds/${g.id}/channels`, {
    name: 'own',
    kind: 2,
    parent_id: cat.id,
    permission_overwrites: [{ id: g.id, type: 0, allow: 0, deny: VIEW | SEND }],
  });
  // Opening the category to everyone opens the synced channel, not the one with its own permissions.
  await ok(o.token, 'PUT', `/channels/${cat.id}/permissions`, { permission_overwrites: [] });
  const s = await gateway(m.token);
  const ids = s.first.d.guilds.find((x) => x.id === g.id).channels.map((c) => c.id);
  assert.ok(ids.includes(synced.id));
  assert.ok(!ids.includes(own.id));
  await ok(o.token, 'POST', `/channels/${own.id}/permissions/sync`);
  await until(() => s.events.some((e) => e.t === 'CHANNEL_CREATE' && e.d.id === own.id));
  s.ws.close();
  // Duplicating a channel (Clone) keeps its permissions.
  const copy = await ok(o.token, 'POST', `/guilds/${g.id}/channels`, {
    name: 'own',
    kind: 2,
    parent_id: cat.id,
    permission_overwrites: locked,
  });
  assert.deepEqual(copy.permission_overwrites, locked);
});

test('Read Message History: without it a channel shows no past messages', async () => {
  const [g, m, o] = await permGuild('History');
  const text = g.channels.find((c) => c.kind === 0);
  await ok(o.token, 'POST', `/channels/${text.id}/messages`, { content: 'before you came' });
  await ok(o.token, 'PUT', `/channels/${text.id}/permissions`, {
    permission_overwrites: [{ id: g.id, type: 0, allow: 0, deny: HISTORY }],
  });
  assert.deepEqual(await ok(m.token, 'GET', `/channels/${text.id}/messages`), []);
  assert.ok((await ok(o.token, 'GET', `/channels/${text.id}/messages`)).length > 0);
});

test('Move Members: drag someone to another voice channel or disconnect them; nobody can by default', async () => {
  const [g, m, o] = await permGuild('Move');
  const lounge = g.channels.find((c) => c.kind === 2);
  const other = await ok(o.token, 'POST', `/guilds/${g.id}/channels`, { name: 'Other', kind: 2 });
  const msgs = [];
  const ws = await new Promise((resolve, reject) => {
    const sock = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/voice/connect`);
    sock.onopen = () => sock.send(JSON.stringify({ token: m.token, channel_id: lounge.id }));
    sock.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      msgs.push(m);
      if (m.op === 'ready') resolve(sock);
    };
    sock.onerror = reject;
  });
  const closed = new Promise((r) => (ws.onclose = r));
  const third = await login('mover');
  const inv = await ok(o.token, 'POST', `/guilds/${g.id}/invites`, {});
  await ok(third.token, 'POST', `/invites/${inv.code}`);
  const path = `/guilds/${g.id}/members/${m.id}/voice`;
  assert.equal((await call(third.token, 'PATCH', path, { channel_id: other.id })).status, 403);
  const role = await ok(o.token, 'POST', `/guilds/${g.id}/roles`, { name: 'Mover', permissions: MOVE });
  await ok(o.token, 'PATCH', `/guilds/${g.id}/members/${third.id}`, { roles: [role.id] });
  await ok(third.token, 'PATCH', path, { channel_id: other.id });
  const move = await until(() => msgs.find((m) => m.op === 'move'));
  assert.equal(move.channel_id, other.id);
  assert.equal(move.by, third.id);
  // Not into a text channel; disconnecting ends their session.
  const text = g.channels.find((c) => c.kind === 0);
  assert.equal((await call(third.token, 'PATCH', path, { channel_id: text.id })).status, 400);
  await ok(third.token, 'PATCH', path, { channel_id: null });
  await until(() => msgs.some((m) => m.op === 'move' && m.channel_id === null));
  await closed;
  assert.equal((await call(third.token, 'PATCH', path, { channel_id: null })).status, 400);
});

test('your own roles: rename and recolor them without Manage Roles, but not their permissions', async () => {
  const [g, m, o] = await permGuild('OwnRoles');
  const role = await ok(o.token, 'POST', `/guilds/${g.id}/roles`, { name: 'Friend' });
  const notMine = await ok(o.token, 'POST', `/guilds/${g.id}/roles`, { name: 'Other' });
  await ok(o.token, 'PATCH', `/guilds/${g.id}/members/${m.id}`, { roles: [role.id] });
  const renamed = await ok(m.token, 'PATCH', `/guilds/${g.id}/roles/${role.id}`, { name: 'Best Friend', color: 0xff8800 });
  assert.equal(renamed.name, 'Best Friend');
  assert.equal(renamed.color, 0xff8800);
  const roleUrl = `/guilds/${g.id}/roles/${role.id}`;
  assert.equal((await call(m.token, 'PATCH', roleUrl, { permissions: 8 })).status, 403);
  assert.equal((await call(m.token, 'PATCH', roleUrl, { name: 'x', hoist: true })).status, 403);
  assert.equal((await call(m.token, 'PATCH', `/guilds/${g.id}/roles/${notMine.id}`, { name: 'Mine now' })).status, 403);
  assert.equal((await call(m.token, 'PATCH', `/guilds/${g.id}/roles/${g.id}`, { name: 'everyone!' })).status, 403);
});

test('role order: Manage Roles reorders roles below their own highest role', async () => {
  const [g, m, o] = await permGuild('RoleOrder');
  const roles = {};
  for (const name of ['Top', 'Manager', 'A', 'B']) roles[name] = await ok(o.token, 'POST', `/guilds/${g.id}/roles`, { name });
  const order = (names) => names.map((n) => roles[n].id);
  await ok(o.token, 'PUT', `/guilds/${g.id}/roles`, { ids: order(['Top', 'Manager', 'A', 'B']) });
  await ok(o.token, 'PATCH', `/guilds/${g.id}/roles/${roles.Manager.id}`, { permissions: MANAGE_ROLES });
  await ok(o.token, 'PATCH', `/guilds/${g.id}/members/${m.id}`, { roles: [roles.Manager.id] });
  const after = await ok(m.token, 'PUT', `/guilds/${g.id}/roles`, { ids: order(['Top', 'Manager', 'B', 'A']) });
  assert.deepEqual(
    after.filter((r) => r.id !== g.id).map((r) => r.name),
    ['Top', 'Manager', 'B', 'A'],
  );
  const url = `/guilds/${g.id}/roles`;
  assert.equal((await call(m.token, 'PUT', url, { ids: order(['Manager', 'Top', 'B', 'A']) })).status, 400);
  assert.equal((await call(m.token, 'PUT', url, { ids: order(['Top', 'B', 'Manager', 'A']) })).status, 400);
});

// ---------- profile: pronouns and favorite games ----------

test('pronouns: up to 40 characters, shown with the user', async () => {
  const u = await login('pronouns');
  await ok(u.token, 'POST', `/invites/${invite.code}`); // profiles show in full to people who share a server
  const me = await ok(u.token, 'PATCH', '/users/@me', { pronouns: '  she /  her  ' });
  assert.equal(me.pronouns, 'she / her');
  assert.equal((await call(u.token, 'PATCH', '/users/@me', { pronouns: 'x'.repeat(41) })).status, 400);
  assert.equal((await ok(owner.token, 'GET', `/users/${u.id}/profile`)).user.pronouns, 'she / her');
  // Other changes keep them.
  assert.equal((await ok(u.token, 'PATCH', '/users/@me', { bio: 'hi' })).pronouns, 'she / her');
});

test('favorite games: search the catalog, pick up to 20 in order, own games by name, on the profile with time played', async () => {
  const u = await login('gamer');
  await ok(u.token, 'POST', `/invites/${invite.code}`); // profiles show in full to people who share a server
  // The catalog comes from the same list as game detection (the mock), loaded in the background.
  const hits = await until(async () => {
    const r = await ok(u.token, 'GET', '/games/search?q=mine');
    return r.length ? r : null;
  }, 8000);
  assert.equal(hits[0].name, 'Minecraft');
  assert.match(hits[0].cover, /cdn\.discordapp\.com\/app-icons\/1402418491272986635\/.+keep_aspect_ratio=true/);
  const cs = (await ok(u.token, 'GET', '/games/search?q=counter'))[0];
  assert.equal(cs.poster, 'https://cdn.cloudflare.steamstatic.com/steam/apps/730/library_600x900.jpg');
  assert.equal((await ok(u.token, 'GET', '/games/search?q=valorant'))[0].id, '700136079562375258');

  const saved = await ok(u.token, 'PUT', '/users/@me/favorite-games', {
    games: [{ id: cs.id }, { id: null, name: '  Hollow   Knight ' }, { id: hits[0].id }, { id: cs.id }],
  });
  assert.deepEqual(
    saved.map((g) => g.name),
    ['Counter-Strike 2', 'Hollow Knight', 'Minecraft'],
    'duplicates dropped, names from the catalog, own games tidied',
  );
  assert.equal(saved[1].id, null);
  assert.equal((await call(u.token, 'PUT', '/users/@me/favorite-games', { games: [{ id: '123' }] })).status, 400);
  const many = Array.from({ length: 21 }, (_, i) => ({ id: null, name: `Game ${i}` }));
  assert.equal((await call(u.token, 'PUT', '/users/@me/favorite-games', { games: many })).status, 400);

  // Time played comes from game detection.
  await ok(u.token, 'PUT', '/activities/playing', { application_id: cs.id, name: 'Counter-Strike 2' });
  const profile = await ok(owner.token, 'GET', `/users/${u.id}/profile`);
  assert.deepEqual(
    profile.favorite_games.map((g) => g.name),
    ['Counter-Strike 2', 'Hollow Knight', 'Minecraft'],
  );
  assert.ok(profile.favorite_games[0].icon);
  // A game's card: catalog info, and the people you know who love it too (here: yourself).
  const card = await ok(u.token, 'GET', `/games/${hits[0].id}?lang=pt-BR`);
  assert.equal(card.name, 'Minecraft');
  assert.deepEqual(card.aliases, ['Minecraft Launcher']);
  assert.ok(!card.store_url, 'not on Steam');
  assert.deepEqual(card.fans.map((f) => f.id), [u.id]);
  assert.equal((await call(u.token, 'GET', '/games/123')).status, 404);
  await ok(u.token, 'DELETE', '/activities/playing');
  await ok(u.token, 'PUT', '/users/@me/favorite-games', { games: [] });
  assert.deepEqual((await ok(owner.token, 'GET', `/users/${u.id}/profile`)).favorite_games, []);
});


// ---------- profile extras: notes, links, birthday, server profiles, widgets, profile song ----------

test('notes: private to whoever wrote them, up to 256 characters, empty deletes', async () => {
  const u = await login('noted');
  await ok(owner.token, 'PUT', `/users/${u.id}/note`, { note: '  plays support  ' });
  assert.equal((await ok(owner.token, 'GET', `/users/${u.id}/profile`)).note, 'plays support');
  assert.equal((await ok(member.token, 'GET', `/users/${u.id}/profile`)).note, '', 'only the writer sees it');
  assert.equal((await ok(u.token, 'GET', `/users/${u.id}/profile`)).note, '', 'not even the person it is about');
  assert.equal((await call(owner.token, 'PUT', `/users/${u.id}/note`, { note: 'x'.repeat(257) })).status, 400);
  assert.equal((await call(owner.token, 'PUT', `/users/${owner.id}/note`, { note: 'me' })).status, 400);
  await ok(owner.token, 'PUT', `/users/${u.id}/note`, { note: '' });
  assert.equal((await ok(owner.token, 'GET', `/users/${u.id}/profile`)).note, '');
});

test('profile links and birthday', async () => {
  const u = await login('linked');
  await ok(u.token, 'POST', `/invites/${invite.code}`); // profiles show in full to people who share a server
  await ok(u.token, 'PATCH', '/users/@me', {
    links: [{ label: '', url: 'github.com/someone' }, { label: '  My   blog ', url: 'http://blog.example.org/x' }],
  });
  const links = (await ok(owner.token, 'GET', `/users/${u.id}/profile`)).links;
  assert.deepEqual(links, [
    { label: '', url: 'https://github.com/someone' },
    { label: 'My blog', url: 'http://blog.example.org/x' },
  ]);
  for (const bad of [[{ url: 'javascript:alert(1)' }], [{ url: 'ftp://example.com' }], Array.from({ length: 6 }, (_, i) => ({ url: `e${i}.com` }))]) {
    assert.equal((await call(u.token, 'PATCH', '/users/@me', { links: bad })).status, 400);
  }
  // Other changes keep them.
  await ok(u.token, 'PATCH', '/users/@me', { bio: 'hi' });
  assert.equal((await ok(owner.token, 'GET', `/users/${u.id}/profile`)).links.length, 2);

  // The birthday travels with the user (clients show a cake on the day).
  assert.equal((await ok(u.token, 'PATCH', '/users/@me', { birthday: '02-29' })).birthday, '02-29');
  assert.equal((await ok(u.token, 'PATCH', '/users/@me', { birthday: '1999-03-14' })).birthday, '1999-03-14');
  assert.equal((await ok(owner.token, 'GET', `/users/${u.id}`)).birthday, '1999-03-14');
  for (const bad of ['2001-02-29', '13-01', '1850-01-01', 'soon']) {
    assert.equal((await call(u.token, 'PATCH', '/users/@me', { birthday: bad })).status, 400, bad);
  }
  assert.equal((await ok(u.token, 'PATCH', '/users/@me', { pronouns: 'they/them' })).birthday, '1999-03-14');
  assert.equal((await ok(u.token, 'PATCH', '/users/@me', { birthday: '' })).birthday, null);
});

test('server profiles: a picture, banner and about me only in that server', async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const watch = await gateway(owner.token);
  try {
    const m = await ok(member.token, 'PATCH', `/guilds/${guild.id}/members/@me`, { bio: 'only here' });
    assert.equal(m.bio, 'only here');
    assert.equal((await call(member.token, 'PATCH', `/guilds/${guild.id}/members/@me`, { bio: 'x'.repeat(191) })).status, 400);
    for (const which of ['avatar', 'banner']) {
      const fd = new FormData();
      fd.append('file', new Blob([png], { type: 'image/png' }), `${which}.png`);
      const after = await ok(member.token, 'POST', `/guilds/${guild.id}/members/@me/${which}`, fd);
      assert.match(after[which], new RegExp(`^/uploads/member-profiles/${guild.id}/${member.id}/${which}s/`));
      assert.equal((await fetch(`${BASE}${after[which]}`)).status, 200);
    }
    // Everyone in the server hears about it; the account itself is untouched.
    const update = await until(() => watch.events.find((e) => e.t === 'GUILD_MEMBER_UPDATE' && e.d.member.user.id === member.id && e.d.member.banner));
    assert.ok(update.d.member.avatar);
    assert.equal(update.d.member.bio, 'only here');
    assert.doesNotMatch((await ok(owner.token, 'GET', `/users/${member.id}`)).avatar ?? '', /member-profiles/);
    assert.equal((await call(outsider.token, 'PATCH', `/guilds/${guild.id}/members/@me`, { bio: 'nope' })).status, 404);

    const cleared = await ok(member.token, 'DELETE', `/guilds/${guild.id}/members/@me/avatar`);
    assert.equal(cleared.avatar, undefined, 'back to the account picture');
    await ok(member.token, 'DELETE', `/guilds/${guild.id}/members/@me/banner`);
    const plain = await ok(member.token, 'PATCH', `/guilds/${guild.id}/members/@me`, { bio: '' });
    assert.equal(plain.bio, undefined);
  } finally {
    watch.ws.close();
  }
});

test('profile widgets: the stats card is opt-in, Kass songs opt-out; you always see yours', async () => {
  const u = await login('widgets');
  await ok(u.token, 'POST', `/invites/${invite.code}`); // profiles show in full to people who share a server
  let theirs = await ok(owner.token, 'GET', `/users/${u.id}/profile`);
  assert.equal(theirs.stats, undefined);
  assert.deepEqual(theirs.top_songs, [], 'Kass songs show (none yet)');
  assert.equal(theirs.show_stats, undefined, 'settings only for yourself');
  const mine = await ok(u.token, 'GET', `/users/${u.id}/profile`);
  assert.equal(mine.show_stats, false);
  assert.equal(mine.show_top_songs, true);
  assert.equal(typeof mine.stats.voice_seconds, 'number');

  await ok(u.token, 'PATCH', '/users/@me', { show_stats: true, show_top_songs: false });
  theirs = await ok(owner.token, 'GET', `/users/${u.id}/profile`);
  assert.equal(typeof theirs.stats.messages, 'number');
  assert.ok(Array.isArray(theirs.stats.top_emoji));
  assert.equal(theirs.top_songs, undefined);
});

test('profile song: up to 30 s of an audio file, trimmed again later, removed', { skip: !process.env.LINKORD_TEST_DATA_DIR }, async () => {
  const u = await login('songbird');
  await ok(u.token, 'POST', `/invites/${invite.code}`); // profiles show in full to people who share a server
  const mp3 = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=40', '-b:a', '32k', '-f', 'mp3', 'pipe:1']);
  const form = (fields, name = 'tune.mp3') => {
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify(fields));
    fd.append('file', new Blob([mp3], { type: 'audio/mpeg' }), name);
    return fd;
  };
  assert.equal((await call(u.token, 'POST', '/users/@me/profile-song', form({ trim_start: 0, trim_end: 35 }))).status, 400);
  assert.equal((await call(u.token, 'POST', '/users/@me/profile-song', form({}, 'tune.exe'))).status, 400);
  const song = await ok(u.token, 'POST', '/users/@me/profile-song', form({ title: '  Mock   Tune ', volume: 0.5, trim_start: 2, trim_end: 12 }));
  assert.equal(song.title, 'Mock Tune');
  assert.equal(song.duration, 10);
  assert.equal(song.trim_start, 2);
  assert.ok(song.source);
  assert.equal((await fetch(`${BASE}${song.url}`)).status, 200);
  // Others get what plays, not the original.
  const seen = (await ok(owner.token, 'GET', `/users/${u.id}/profile`)).song;
  assert.equal(seen.url, song.url);
  assert.equal(seen.source, undefined);

  const trimmed = await ok(u.token, 'PATCH', '/users/@me/profile-song', { trim_start: 20, trim_end: 40, volume: 0.8 });
  assert.equal(trimmed.duration, 20);
  assert.equal(trimmed.title, 'Mock Tune');
  assert.notEqual(trimmed.url, song.url);
  assert.equal((await call(u.token, 'PATCH', '/users/@me/profile-song', { trim_start: 0, trim_end: 31 })).status, 400);
  await ok(u.token, 'DELETE', '/users/@me/profile-song');
  assert.equal((await ok(owner.token, 'GET', `/users/${u.id}/profile`)).song, null);
  assert.equal((await fetch(`${BASE}${song.source}`)).status, 404);
});

// ---------- security regressions ----------

const png1 = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const voiceSocket = (token, channelId, path = 'connect') =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/voice/${path}`);
    const state = { ws, closed: null, ops: [], binary: 0 };
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify({ token, channel_id: channelId }));
    ws.onerror = reject;
    ws.onclose = (e) => {
      state.closed = e.code;
      resolve(state);
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') state.binary += 1;
      else {
        const m = JSON.parse(e.data);
        state.ops.push(m);
        if (m.op === 'ready') resolve(state);
      }
    };
  });
const eventually = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
async function serverWithVoice(owner) {
  const g = await ok(owner.token, 'POST', '/guilds', { name: `Sec ${run}` });
  const voice = await ok(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'call', kind: 2 });
  const text = await ok(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'sec-text', kind: 0 });
  const invite = await ok(owner.token, 'POST', `/guilds/${g.id}/invites`, {});
  return { g, voice, text, invite };
}

test('uploads can never run on the app origin', async () => {
  const u = await login('secupload');
  const { text } = await serverWithVoice(u);
  for (const [name, type, body] of [['evil.html', 'text/html', '<script>alert(1)</script>'], ['evil.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'], ['evil.js', 'text/javascript', 'alert(1)']]) {
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({ content: 'x' }));
    fd.append('file', new Blob([body], { type }), name);
    const msg = await ok(u.token, 'POST', `/channels/${text.id}/messages`, fd);
    const res = await fetch(BASE + msg.attachments[0].url);
    assert.equal(res.status, 200, 'a posted attachment stays on disk');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.equal(res.headers.get('content-disposition'), 'attachment', name);
    assert.match(res.headers.get('cache-control'), /private/);
  }
  const pic = new FormData();
  pic.append('payload_json', '{}');
  pic.append('file', new Blob([png1], { type: 'image/png' }), 'cat.png');
  const msg = await ok(u.token, 'POST', `/channels/${text.id}/messages`, pic);
  const res = await fetch(BASE + msg.attachments[0].url);
  assert.equal(res.headers.get('content-disposition'), null, 'pictures still show inline');
  assert.equal(res.headers.get('content-type'), 'image/png');
});

test('picture uploads take their type from the bytes, not the client', async () => {
  const u = await login('secavatar');
  const fake = new FormData();
  fake.append('file', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'x.html');
  assert.equal((await call(u.token, 'POST', '/users/@me/avatar', fake)).status, 400);
  const named = new FormData();
  named.append('file', new Blob([png1], { type: 'image/png' }), 'x.html');
  const me = await ok(u.token, 'POST', '/users/@me/avatar', named);
  assert.match(me.avatar, /\/avatar\.png$/);
});

test('the web client sends security headers', async () => {
  const res = await fetch(`${BASE}/`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp));
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('a rejected message keeps no files and costs no quota', async () => {
  const u = await login('secquota');
  const { text } = await serverWithVoice(u);
  const before = (await ok(u.token, 'GET', '/users/@me/stats?tz=0')).upload_bytes;
  const fd = new FormData();
  fd.append('payload_json', '{}');
  for (let i = 0; i < 11; i++) fd.append('file', new Blob([new Uint8Array(1000)]), `f${i}.bin`);
  assert.equal((await call(u.token, 'POST', `/channels/${text.id}/messages`, fd)).status, 400);
  const dir = path.join(process.env.LINKORD_TEST_DATA_DIR ?? '', 'uploads', 'attachments', String(text.id));
  assert.ok(await eventually(() => !fs.existsSync(dir) || fs.readdirSync(dir).length === 0), 'saved files are removed');
  assert.equal(before, (await ok(u.token, 'GET', '/users/@me/stats?tz=0')).upload_bytes);
});

test('uploads that are really playlists never reach ffmpeg as playlists', async () => {
  const u = await login('secff');
  const { g, text } = await serverWithVoice(u);
  const playlist = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:1.0,\nfile:///etc/hostname.ogg\n#EXT-X-ENDLIST\n';
  const note = new FormData();
  note.append('payload_json', JSON.stringify({ voice: { duration_secs: 1, waveform: 'AA==' } }));
  note.append('file', new Blob([playlist], { type: 'audio/webm' }), 'x.m3u8');
  const r = await call(u.token, 'POST', `/channels/${text.id}/messages`, note);
  if (r.status === 200) assert.notEqual(r.body.attachments[0].filename, 'voice-message.ogg', 'not converted');
  for (const [route, label] of [[`/guilds/${g.id}/soundboard`, 'sound'], ['/users/@me/profile-song', 'song']]) {
    for (const body of [playlist, 'ffconcat version 1.0\nfile loop.mp3\n']) {
      const fd = new FormData();
      fd.append('payload_json', JSON.stringify({ name: 'loop', title: 'loop' }));
      fd.append('file', new Blob([body], { type: 'audio/mpeg' }), 'loop.mp3');
      assert.equal((await call(u.token, 'POST', route, fd)).status, 400, label);
    }
  }
});

test('App Links: assetlinks.json names the Android app and its release certificate', async () => {
  const res = await fetch(`${BASE}/.well-known/assetlinks.json`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const [link] = await res.json();
  assert.deepEqual(link.relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(link.target.package_name, 'com.linkord.app');
  assert.deepEqual(link.target.sha256_cert_fingerprints, [Array(32).fill('AB').join(':')]);
});

test('a voice message recorded on Android (Ogg/Opus) is kept as it is, with its waveform', async () => {
  const u = await login('phonevoice');
  const { text } = await serverWithVoice(u);
  // What Android's MediaRecorder writes (OutputFormat.OGG + AudioEncoder.OPUS): a second of Opus in Ogg.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkord-voice-'));
  const file = path.join(dir, 'note.ogg');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', '-b:a', '32k', file]);
  const note = new FormData();
  note.append('payload_json', JSON.stringify({ voice: { duration_secs: 1.02, waveform: 'AAECAwQ=' } }));
  note.append('files[0]', new Blob([fs.readFileSync(file)], { type: 'audio/ogg' }), 'voice-message.ogg');
  const m = await ok(u.token, 'POST', `/channels/${text.id}/messages`, note);
  const a = m.attachments[0];
  assert.equal(a.content_type, 'audio/ogg');
  assert.equal(a.duration_secs, 1.02);
  assert.equal(a.waveform, 'AAECAwQ=');
  const res = await fetch(BASE + a.url);
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString(), 'OggS');
  fs.rmSync(dir, { recursive: true });
});

test('a GIF that declares enormous frames is refused before ffmpeg', async () => {
  const u = await login('secgif');
  const gif = new Uint8Array(32);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x4e, 0x20, 0x4e]);
  const fd = new FormData();
  fd.append('file', new Blob([gif], { type: 'image/gif' }), 'huge.gif');
  const started = Date.now();
  const r = await call(u.token, 'POST', '/users/@me/banner', fd);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /dimensions/);
  assert.ok(Date.now() - started < 1000);
});

test('small routes refuse large bodies', async () => {
  const u = await login('secbody');
  // Only the declared size: the server answers without reading the rest.
  const { request } = await import('node:http');
  const declared = (method, route) =>
    new Promise((resolve, reject) => {
      const req = request(`${BASE}/api${route}`, { method, headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json', 'content-length': 2 * 1024 * 1024 } }, (res) => {
        res.resume();
        req.destroy();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.flushHeaders();
    });
  assert.equal(await declared('PUT', '/voice/preview'), 413);
  assert.equal(await declared('PATCH', '/users/@me/settings'), 413);
});

test('the API limits one address, and a /64 counts as one', async () => {
  call.noRetry = true;
  try {
    const hit = (ip) => fetch(`${BASE}/api/health`, { headers: { 'cf-connecting-ip': ip } }).then((r) => r.status);
    const results = await Promise.all(Array.from({ length: 400 }, (_, i) => hit(`2001:db8:${run.length}:1::${(i + 1).toString(16)}`)));
    assert.ok(results.includes(429), 'rotating inside a /64 is still limited');
  } finally {
    call.noRetry = false;
  }
});

test('Manage Channels can\'t expose a hidden channel by moving it', async () => {
  const owner = await login('secreorder');
  const mod = await login('secreordermod');
  const { g } = await serverWithVoice(owner);
  const invite = await ok(owner.token, 'POST', `/guilds/${g.id}/invites`, {});
  await ok(mod.token, 'POST', `/invites/${invite.code}`);
  const role = await ok(owner.token, 'POST', `/guilds/${g.id}/roles`, { name: 'chan', permissions: 1 << 4 });
  await ok(owner.token, 'PATCH', `/guilds/${g.id}/members/${mod.id}`, { roles: [role.id] });
  const open = await ok(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'open', kind: 4 });
  const staff = await ok(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'staff', kind: 4 });
  const secret = await ok(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'secret', kind: 0, parent_id: staff.id });
  const hide = [{ id: g.id, type: 0, allow: 0, deny: 1 << 10 }];
  await ok(owner.token, 'PUT', `/channels/${staff.id}/permissions`, { permission_overwrites: hide });
  await ok(owner.token, 'PUT', `/channels/${secret.id}/permissions`, { permission_overwrites: hide });
  await ok(owner.token, 'POST', `/channels/${secret.id}/messages`, { content: 'staff only' });
  assert.equal((await call(mod.token, 'GET', `/channels/${secret.id}/messages`)).status, 404);
  const moved = await call(mod.token, 'PUT', `/guilds/${g.id}/channels`, { ids: [secret.id], parents: { [secret.id]: open.id } });
  assert.ok(moved.status === 403 || moved.status === 404, `reorder -> ${moved.status}`);
  assert.equal((await call(mod.token, 'GET', `/channels/${secret.id}/messages`)).status, 404);
});

test('Read Message History can\'t be sidestepped', async () => {
  const owner = await login('sechistory');
  const reader = await login('sechistoryreader');
  const { g, text, invite } = await serverWithVoice(owner);
  await ok(reader.token, 'POST', `/invites/${invite.code}`);
  const old = await ok(owner.token, 'POST', `/channels/${text.id}/messages`, { content: 'old secret' });
  await ok(owner.token, 'PUT', `/channels/${text.id}/permissions`, { permission_overwrites: [{ id: g.id, type: 0, allow: 0, deny: 1 << 16 }] });
  assert.equal((await call(reader.token, 'POST', `/channels/${text.id}/messages/${old.id}/forward`, { channel_ids: [text.id] })).status, 403);
  assert.equal((await call(reader.token, 'POST', `/channels/${text.id}/messages/${old.id}/threads`, {})).status, 403);
  const reply = await ok(reader.token, 'POST', `/channels/${text.id}/messages`, { content: 'hm', reply_to: old.id });
  assert.ok(!JSON.stringify(reply).includes('old secret'));
});

test('strangers only see a name and a picture', async () => {
  const owner = await login('secprofile');
  const stranger = await login('secstranger');
  await ok(owner.token, 'PATCH', '/users/@me', { bio: 'private bio', birthday: '1990-05-01', pronouns: 'they' });
  const seen = await ok(stranger.token, 'GET', `/users/${owner.id}/profile`);
  assert.equal(seen.user.username, owner.username);
  for (const leaked of ['private bio', '1990-05-01']) assert.ok(!JSON.stringify(seen).includes(leaked), leaked);
  assert.ok(!JSON.stringify(await ok(stranger.token, 'GET', `/users/${owner.id}`)).includes('private bio'));
  // Friends of friends stay strangers, but a shared server makes the profile visible.
  const { invite } = await serverWithVoice(owner);
  await ok(stranger.token, 'POST', `/invites/${invite.code}`);
  assert.equal((await ok(stranger.token, 'GET', `/users/${owner.id}/profile`)).user.bio, 'private bio');
});

test('a one-use invite lets in exactly one person, racing or not', async () => {
  const owner = await login('secrace');
  const { g } = await serverWithVoice(owner);
  const invite = await ok(owner.token, 'POST', `/guilds/${g.id}/invites`, { max_uses: 1 });
  const people = await Promise.all(Array.from({ length: 6 }, (_, i) => login(`secrace${i}`)));
  const results = await Promise.all(people.map((p) => call(p.token, 'POST', `/invites/${invite.code}`)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
});

test('bans keep someone out until they\'re lifted', async () => {
  const owner = await login('secban');
  const member = await login('secbanned');
  const outsider = await login('secbanother');
  const { g, invite } = await serverWithVoice(owner);
  await ok(member.token, 'POST', `/invites/${invite.code}`);
  await ok(outsider.token, 'POST', `/invites/${invite.code}`);
  assert.equal((await call(outsider.token, 'PUT', `/guilds/${g.id}/bans/${member.id}`)).status, 403);
  await ok(owner.token, 'PUT', `/guilds/${g.id}/bans/${member.id}`);
  assert.equal((await call(member.token, 'GET', `/guilds/${g.id}/bans`)).status, 404);
  const rejoin = await call(member.token, 'POST', `/invites/${invite.code}`);
  assert.equal(rejoin.status, 400);
  assert.match(rejoin.body.error, /banned/);
  assert.deepEqual((await ok(owner.token, 'GET', `/guilds/${g.id}/bans`)).map((u) => u.id), [member.id]);
  await ok(owner.token, 'DELETE', `/guilds/${g.id}/bans/${member.id}`);
  await ok(member.token, 'POST', `/invites/${invite.code}`);
});

test('logging out closes the session\'s sockets; logging out everywhere ends every session', async () => {
  const name = `seclogout.${run}`;
  const first = (await ok(null, 'POST', '/auth/dev', { username: name })).token;
  const second = (await ok(null, 'POST', '/auth/dev', { username: name })).token;
  const a = await gateway(first);
  const b = await gateway(second);
  const closed = (g) => new Promise((resolve) => g.ws.addEventListener('close', (e) => resolve(e.code)));
  const aClosed = closed(a);
  await ok(first, 'POST', '/auth/logout');
  assert.equal(await aClosed, 4001);
  assert.equal(b.ws.readyState, WebSocket.OPEN, 'other sessions stay');
  assert.equal((await call(second, 'GET', '/users/@me')).status, 200);
  const bClosed = closed(b);
  await ok(second, 'POST', '/auth/logout-all');
  assert.equal(await bClosed, 4001);
  assert.equal((await call(second, 'GET', '/users/@me')).status, 401);
});

test('losing access to a call ends it; losing Speak stops the audio', async () => {
  const owner = await login('seccall');
  const member = await login('seccallmember');
  const { g, voice, invite } = await serverWithVoice(owner);
  await ok(member.token, 'POST', `/invites/${invite.code}`);
  const o = await voiceSocket(owner.token, voice.id);
  const m = await voiceSocket(member.token, voice.id);
  const audio = new Uint8Array([1, 9, 9, 9]);
  m.ws.send(audio);
  assert.ok(await eventually(() => o.binary > 0), 'audio flows at first');

  await ok(owner.token, 'PUT', `/channels/${voice.id}/permissions`, { permission_overwrites: [{ id: g.id, type: 0, allow: 0, deny: 1 << 21 }] });
  await new Promise((r) => setTimeout(r, 200));
  const before = o.binary;
  m.ws.send(audio);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(o.binary, before, 'no audio after losing Speak');
  assert.equal(m.ws.readyState, WebSocket.OPEN, 'still in the call');

  await ok(owner.token, 'PUT', `/channels/${voice.id}/permissions`, { permission_overwrites: [{ id: g.id, type: 0, allow: 0, deny: 1 << 20 }] });
  assert.ok(await eventually(() => m.closed !== null), 'out of the call after losing Connect');
  o.ws.close();
});

test('leaving a group DM ends your part in its call, and blocks cover DM calls', async () => {
  const a = await login('secgroupa');
  const b = await login('secgroupb');
  const c = await login('secgroupc');
  for (const other of [b, c]) {
    await ok(a.token, 'POST', '/users/@me/relationships', { username: other.username });
    await ok(other.token, 'PUT', `/users/@me/relationships/${a.id}`, {});
  }
  const group = await ok(a.token, 'POST', '/users/@me/channels', { recipients: [b.id, c.id] });
  const inCall = await voiceSocket(b.token, group.id);
  await ok(a.token, 'DELETE', `/channels/${group.id}/recipients/${b.id}`);
  assert.ok(await eventually(() => inCall.closed !== null), 'removed person is out of the call');

  const dm = await ok(a.token, 'POST', '/users/@me/channels', { recipient_id: c.id });
  await ok(c.token, 'PUT', `/users/@me/relationships/${a.id}`, { type: 2 });
  const blocked = await voiceSocket(a.token, dm.id);
  assert.equal(blocked.closed, 4004);
});

test('Discord sign-in: anyone can sign up, from the browser that started it, and only the app that started it', async () => {
  // A new address each time: sign-ins are limited per address, and this test does many.
  let address = 0;
  const from = () => ({ 'cf-connecting-ip': `198.51.100.${++address}` });
  const start = (query, cookie) => fetch(`${BASE}/api/auth/discord/start${query}`, { redirect: 'manual', headers: { ...from(), ...(cookie ? { cookie } : {}) } });
  const stateOf = (res) => new URL(res.headers.get('location')).searchParams.get('state');
  const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];
  const callback = (state, name, cookie) => fetch(`${BASE}/api/auth/discord/callback?code=user-${name}&state=${state}`, { redirect: 'manual', headers: { ...from(), ...(cookie ? { cookie } : {}) } });
  const name = `newcomer${run}`;

  // Old desktop apps chose the secret themselves: whoever sent the link would get the session.
  const old = await start(`?nonce=${'a'.repeat(40)}`);
  assert.equal(old.status, 200);
  assert.match(await old.text(), /can't sign in any more/);
  assert.ok(!(await (await fetch(`${BASE}/api/auth/poll?nonce=${'a'.repeat(40)}`)).text()).includes('"token"'), 'polling is gone');

  // The callback must come back to the browser that started the sign-in.
  let s = await start('');
  assert.match(s.headers.get('location'), /prompt=none/);
  let res = await callback(stateOf(s), name);
  assert.match(await res.text(), /expired/, 'no cookie');
  s = await start('');
  res = await callback(stateOf(s), name, 'linkord_login=someone-elses');
  assert.match(await res.text(), /expired/, 'wrong cookie');

  // No invite needed: the web sign-in creates the account and lands in the client.
  s = await start('');
  res = await callback(stateOf(s), name, cookieOf(s));
  assert.equal(res.status, 303);
  const webToken = res.headers.get('location').match(/#token=([\w-]+)/)[1];
  const me = await ok(webToken, 'GET', '/users/@me');
  assert.equal(me.username, name.toLowerCase());

  // Signing in again finds the same account. Desktop: the code only goes to the local callback...
  const verifier = 'v'.repeat(43);
  const challenge = (await import('node:crypto')).createHash('sha256').update(verifier).digest('base64url');
  const clientState = 's'.repeat(40);
  s = await start(`?port=45123&state=${clientState}&challenge=${challenge}`);
  assert.ok(!s.headers.get('location').includes('prompt=none'), 'desktop always asks');
  res = await callback(stateOf(s), name, cookieOf(s));
  const local = new URL(res.headers.get('location'));
  assert.equal(local.origin, 'http://127.0.0.1:45123');
  assert.equal(local.searchParams.get('state'), clientState);
  const code = local.searchParams.get('code');
  // ...and is only good with the secret behind the challenge, and only once.
  assert.equal((await call(null, 'POST', '/auth/exchange', { code, verifier: 'wrong' })).status, 401);
  s = await start(`?port=45123&state=${clientState}&challenge=${challenge}`);
  res = await callback(stateOf(s), name, cookieOf(s));
  const code2 = new URL(res.headers.get('location')).searchParams.get('code');
  const { token } = await ok(null, 'POST', '/auth/exchange', { code: code2, verifier });
  assert.equal((await ok(token, 'GET', '/users/@me')).id, me.id);
  assert.equal((await call(null, 'POST', '/auth/exchange', { code: code2, verifier })).status, 401, 'one time');

  for (const bad of ['?port=80&state=' + clientState + '&challenge=' + challenge, '?port=45123&state=short&challenge=' + challenge, `?port=45123&state=${clientState}`]) {
    assert.equal((await start(bad)).status, 400, bad);
  }
});

test('Discord sign-in from the Android app: the code goes to its own scheme and needs the verifier', async () => {
  let address = 0;
  const from = () => ({ 'cf-connecting-ip': `198.51.101.${++address}` });
  const start = (query) => fetch(`${BASE}/api/auth/discord/start${query}`, { redirect: 'manual', headers: from() });
  const stateOf = (res) => new URL(res.headers.get('location')).searchParams.get('state');
  const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];
  const callback = (state, name, cookie) =>
    fetch(`${BASE}/api/auth/discord/callback?code=user-${name}&state=${state}`, { redirect: 'manual', headers: { ...from(), cookie } });
  const name = `phone${run}`;
  const verifier = 'p'.repeat(43);
  const challenge = (await import('node:crypto')).createHash('sha256').update(verifier).digest('base64url');
  const clientState = 'a'.repeat(40);
  for (const [client, scheme] of [['android', 'linkord:'], ['android-dev', 'linkord-dev:']]) {
    const s = await start(`?client=${client}&state=${clientState}&challenge=${challenge}`);
    assert.ok(!s.headers.get('location').includes('prompt=none'), 'the app always asks');
    const res = await callback(stateOf(s), name, cookieOf(s));
    const back = new URL(res.headers.get('location'));
    assert.equal(back.protocol, scheme);
    assert.equal(back.host, 'auth');
    assert.equal(back.searchParams.get('state'), clientState);
    const code = back.searchParams.get('code');
    assert.equal((await call(null, 'POST', '/auth/exchange', { code, verifier: 'wrong' })).status, 401);
  }
  const s = await start(`?client=android&state=${clientState}&challenge=${challenge}`);
  const code = new URL((await callback(stateOf(s), name, cookieOf(s))).headers.get('location')).searchParams.get('code');
  const { token } = await ok(null, 'POST', '/auth/exchange', { code, verifier });
  assert.equal((await ok(token, 'GET', '/users/@me')).username, name.toLowerCase());
  // The phone's gateway says it's the Android app, and Settings -> Sessions shows it so.
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/api/gateway`);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.send(JSON.stringify({ op: 'identify', token, client: 'android' }));
  await new Promise((r) => ws.addEventListener('message', r, { once: true }));
  const sessions = await ok(token, 'GET', '/auth/sessions');
  assert.equal(sessions.find((x) => x.current).client, 'android');
  ws.close();

  for (const bad of [
    `?client=ios&state=${clientState}&challenge=${challenge}`,
    `?client=android&state=short&challenge=${challenge}`,
    `?client=android&state=${clientState}`,
    `?client=android&port=45123&state=${clientState}&challenge=${challenge}`,
  ]) {
    assert.equal((await start(bad)).status, 400, bad);
  }
});

test('sessions: your devices are listed without their tokens, and one can be logged out without the others', async () => {
  const name = `devices.${run}`;
  const signIn = async () => (await call(null, 'POST', '/auth/dev', { username: name })).body.token;
  const [mine, other] = [await signIn(), await signIn()];
  const stranger = await login('devstranger');

  // A connection says what it's running on; only known kinds of client are kept.
  const connect = (token, client) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/gateway`);
      ws.onopen = () => ws.send(JSON.stringify({ op: 'identify', token, client }));
      ws.onerror = reject;
      ws.onmessage = (e) => JSON.parse(e.data).t === 'READY' && resolve(ws);
    });
  const socket = await connect(other, 'desktop');
  const closed = new Promise((resolve) => (socket.onclose = (e) => resolve(e.code)));
  (await connect(mine, 'made up')).close();

  const list = await ok(mine, 'GET', '/auth/sessions');
  assert.equal(list.length, 2);
  const here = list.find((s) => s.current);
  const there = list.find((s) => !s.current);
  assert.ok(here && there, 'one of them is this device');
  assert.equal(there.client, 'desktop');
  assert.equal(there.online, true);
  assert.equal(here.client, null, 'a client name that isn\'t known is left out');
  assert.ok(Date.parse(there.last_seen_at) > 0);
  assert.ok(!JSON.stringify(list).includes(other), 'never the token');
  assert.ok(!('token_hash' in there));

  // Someone else's session can't be touched, or even found.
  assert.equal((await call(stranger.token, 'DELETE', `/auth/sessions/${there.id}`)).status, 404);
  assert.equal((await call(other, 'GET', '/users/@me')).status, 200);

  await ok(mine, 'DELETE', `/auth/sessions/${there.id}`);
  assert.equal(await closed, 4001, 'its socket closes right away');
  assert.equal((await call(other, 'GET', '/users/@me')).status, 401);
  assert.equal((await call(mine, 'GET', '/users/@me')).status, 200, 'this device stays signed in');
  assert.equal((await ok(mine, 'GET', '/auth/sessions')).length, 1);
  assert.equal((await call(mine, 'DELETE', `/auth/sessions/${there.id}`)).status, 404, 'already gone');
});

test('soundboard: a big upload is kept smaller, its quota given back, and it can still be trimmed', { skip: !process.env.LINKORD_TEST_DATA_DIR }, async () => {
  const u = await login('soundsize');
  const g = await ok(u.token, 'POST', '/guilds', { name: `Sizes ${run}` });
  const wav = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-ac', '2', '-ar', '48000', '-f', 'wav', 'pipe:1'], { maxBuffer: 32 * 1024 * 1024 });
  const upload = async (name, bytes, file) => {
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({ name, trim_start: 0, trim_end: 2 }));
    fd.append('file', new Blob([bytes], { type: 'audio/wav' }), file);
    return call(u.token, 'POST', `/guilds/${g.id}/soundboard`, fd);
  };
  const quotaBefore = (await ok(u.token, 'GET', '/users/@me/stats')).upload_bytes;
  const r = await upload('tone', wav, 'tone.wav');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const size = (url) => fs.statSync(path.join(process.env.LINKORD_TEST_DATA_DIR, url.replace(/^\/+/, ''))).size;
  assert.match(r.body.source, /\.mp3$/, 'the original is replaced');
  assert.ok(size(r.body.source) < wav.length / 5, `${size(r.body.source)} of ${wav.length} bytes`);
  assert.ok(size(r.body.url) < 30 * 1024, `2 s clip is ${size(r.body.url)} bytes`);
  const used = (await ok(u.token, 'GET', '/users/@me/stats')).upload_bytes - quotaBefore;
  assert.ok(used < wav.length / 5, `the quota only counts what's kept: ${used}`);
  const retrimmed = await ok(u.token, 'PATCH', `/guilds/${g.id}/soundboard/${r.body.id}`, { trim_start: 5, trim_end: 7 });
  assert.notEqual(retrimmed.url, r.body.url, 'trims again from the smaller copy');

  // Already small: encoding it again would only lose quality.
  const mp3 = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', 'pipe:1'], { maxBuffer: 32 * 1024 * 1024 });
  const small = await upload('small', mp3, 'small.mp3');
  assert.equal(small.status, 200, JSON.stringify(small.body));
  assert.equal(size(small.body.source), mp3.length, 'left as it was');

});

test('profile song search: finds songs, offers what can be used, and hands back audio that can be uploaded', async () => {
  const u = await login('songsearch');
  const hits = await ok(u.token, 'GET', `/users/@me/profile-song/search?q=${encodeURIComponent('a song')}`);
  assert.deepEqual(hits.map((h) => h.id), ['mockSong001', 'brokenbroke'], 'not the live one or the one too long');
  assert.equal(hits[0].title, 'Mock One');
  assert.equal(hits[0].uploader, 'Mock Channel');
  assert.equal(hits[0].thumbnail, 'https://i.ytimg.com/vi/mockSong001/mqdefault.jpg');
  assert.equal((await call(u.token, 'GET', '/users/@me/profile-song/search?q=a')).status, 400);
  assert.deepEqual(await ok(u.token, 'GET', '/users/@me/profile-song/search?q=nothing'), []);
  assert.equal((await call(null, 'GET', '/users/@me/profile-song/search?q=a+song')).status, 401);

  // Only an id: never an address someone typed.
  for (const id of ['https://evil.example/x.mp3', '--exec=calc', 'short', '../../etc/x']) {
    assert.equal((await call(u.token, 'POST', '/users/@me/profile-song/audio', { id })).status, 400, id);
  }

  const res = await fetch(`${BASE}/api/users/@me/profile-song/audio`, {
    method: 'POST',
    headers: { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'mockSong001' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  const audio = await res.arrayBuffer();
  assert.ok(audio.byteLength > 10_000, `${audio.byteLength} bytes`);

  // It isn't saved until it's uploaded like any other file.
  assert.equal((await ok(u.token, 'GET', `/users/${(await ok(u.token, 'GET', '/users/@me')).id}/profile`)).song, null);
  const fd = new FormData();
  fd.append('payload_json', JSON.stringify({ title: 'Mock One', trim_start: 1, trim_end: 4 }));
  fd.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'Mock One.mp3');
  const song = await ok(u.token, 'POST', '/users/@me/profile-song', fd);
  assert.equal(song.title, 'Mock One');
  assert.ok(Math.abs(song.duration - 3) < 0.1);

  assert.equal((await call(u.token, 'POST', '/users/@me/profile-song/audio', { id: 'brokenbroke' })).status, 400, 'a video that fails to download');
});

test('attachments: pictures say their size, so clients can keep their place; other files do not', async () => {
  const u = await login('imgsize');
  const g = await ok(u.token, 'POST', '/guilds', { name: `Sizes ${run}` });
  const text = g.channels.find((c) => c.kind === 0);
  // A 3x2 PNG's header is all the server reads.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEUlEQVR42mNk+M/AwMDAwAAABgYBAf7z0H0AAAAASUVORK5CYII=', 'base64');
  const fd = new FormData();
  fd.append('files[0]', new Blob([png], { type: 'image/png' }), 'a.png');
  fd.append('files[1]', new Blob(['just text'], { type: 'text/plain' }), 'message.txt');
  const m = await ok(u.token, 'POST', `/channels/${text.id}/messages`, fd);
  assert.equal(m.attachments[0].width, 3);
  assert.equal(m.attachments[0].height, 2);
  assert.equal(m.attachments[1].width, undefined);
  assert.equal(m.attachments[1].content_type, 'text/plain');
});

test('league: asking to join a lobby, then the host app says it invited you, so your app accepts by itself', async () => {
  const host = await login('lolhost');
  const joiner = await login('loljoin');
  const stranger = await login('lolother');
  const g = await ok(host.token, 'POST', '/guilds', { name: 'Rift' });
  const invite = await ok(host.token, 'POST', `/guilds/${g.id}/invites`, {});
  await ok(joiner.token, 'POST', `/invites/${invite.code}`);
  await ok(stranger.token, 'POST', `/invites/${invite.code}`);
  const hostWs = await gateway(host.token);
  const joinWs = await gateway(joiner.token);
  try {
    const lobby = { phase: 'lobby', party_size: 1, party_max: 5 };
    await ok(host.token, 'PUT', '/activities/playing', { name: 'League of Legends', league: lobby });
    // Nobody asked yet: the host's app can't make anyone accept anything.
    const invited = (who, body) => call(host.token, 'POST', '/league/invited', { summoner_id: 777, ...body, user_id: who.id });
    assert.equal((await invited(joiner)).status, 404);

    await ok(joiner.token, 'POST', '/league/join', { user_id: host.id, summoner_id: 4242, puuid: 'joiner-puuid' });
    const req = await until(() => hostWs.events.find((e) => e.t === 'LEAGUE_JOIN_REQUEST'));
    assert.deepEqual([req.d.user_id, req.d.summoner_id, req.d.auto], [joiner.id, 4242, false]);

    // Only for whoever asked, and only once.
    assert.equal((await invited(stranger)).status, 404);
    assert.equal((await invited(joiner, { summoner_id: 0 })).status, 400);
    assert.equal((await invited(joiner, { puuid: 'host-puuid' })).status, 204);
    const done = await until(() => joinWs.events.find((e) => e.t === 'LEAGUE_INVITED'));
    assert.deepEqual(done.d, { user_id: host.id, summoner_id: 777, puuid: 'host-puuid' });
    assert.equal((await invited(joiner)).status, 404);
  } finally {
    hostWs.ws.close();
    joinWs.ws.close();
    await call(host.token, 'DELETE', '/activities/playing');
  }
});

test('snowballs: only at people who can see the channel, and the score reaches the profile', async () => {
  const a = await login('snowa');
  const b = await login('snowb');
  const stranger = await login('snowc');
  const g = await ok(a.token, 'POST', '/guilds', { name: 'Snow' });
  const text = g.channels.find((c) => c.kind === 0);
  const invite = await ok(a.token, 'POST', `/guilds/${g.id}/invites`, {});
  await ok(b.token, 'POST', `/invites/${invite.code}`);
  const throwAt = (who, target) => call(who.token, 'POST', `/channels/${text.id}/snowball`, { target });
  assert.equal((await throwAt(a, a.id)).status, 400);
  assert.equal((await throwAt(a, stranger.id)).status, 400);
  assert.notEqual((await throwAt(stranger, a.id)).status, 204);
  assert.equal((await throwAt(a, b.id)).status, 204);
  // The score is saved in the background.
  let profile;
  for (let i = 0; i < 20; i++) {
    profile = await ok(a.token, 'GET', `/users/${b.id}/profile`);
    if (profile.snowballs.taken && profile.snowballs.top.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(profile.snowballs.taken, 1);
  assert.equal(profile.snowballs.top[0].user.id, a.id);
});

test('Steve: mc-manager drives him over the internal listener', async (t) => {
  const INTERNAL = process.env.LINKORD_INTERNAL_TEST_URL ?? 'http://127.0.0.1:7704';
  const dataDir = process.env.LINKORD_TEST_DATA_DIR;
  const token = fs.readFileSync(path.join(dataDir, 'steve-token'), 'utf8').trim();
  const bot = (method, p, body, tok = token) =>
    fetch(`${INTERNAL}/bots/steve${p}`, {
      method,
      headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  // Neither a wrong token nor the monitor's speaks as Steve.
  assert.equal((await bot('GET', '/guilds', undefined, 'nope')).status, 401);
  const monitorToken = fs.readFileSync(path.join(dataDir, 'internal-token'), 'utf8').trim();
  assert.equal((await bot('GET', '/guilds', undefined, monitorToken)).status, 401);

  const g = await gateway(member.token);
  t.after(() => {
    g.ws.close();
    ws.close();
  });
  const ws = new WebSocket(`${INTERNAL.replace(/^http/, 'ws')}/bots/steve/gateway`, { headers: { authorization: `Bearer ${token}` } });
  const inbox = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(e.data));
  const hello = await until(() => inbox.find((m) => m.op === 'hello'));
  assert.equal(hello.user.username, 'steve');
  const steve = hello.user.id;
  ws.send(
    JSON.stringify({
      op: 'commands',
      commands: [
        { name: 'status', description: 'Se o servidor está online' },
        { name: 'play', description: "Kass's: dropped" },
        { name: 'Não vale', description: 'bad name: dropped' },
        { name: 'jockey-de-galinha', description: 'JOCKEY DE GALINHA!' },
        { name: 'mods', description: 'A lista de mods', option: 'página', optional: true },
      ],
    }),
  );
  const update = await until(() => g.events.find((e) => e.t === 'BOT_COMMANDS_UPDATE' && e.d.commands.length));
  assert.deepEqual(
    update.d.commands.map((c) => c.name),
    ['status', 'jockey-de-galinha', 'mods'],
  );
  assert.equal(update.d.commands[0].bot_id, steve);

  // Not in the server yet; only Manage Server adds him.
  let r = await call(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'status', query: '' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /isn't in this server/);
  assert.equal((await call(member.token, 'POST', `/guilds/${guild.id}/bots/steve`)).status, 403);
  await ok(owner.token, 'POST', `/guilds/${guild.id}/bots/steve`);
  await until(() => g.events.find((e) => e.t === 'GUILD_MEMBER_ADD' && e.d.member.user.id === steve));

  const seen = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.op !== 'interaction') return;
    seen.push(m);
    const reply =
      m.command === 'mods'
        ? { ephemeral: true, content: `página ${m.query}`, embeds: [] }
        : m.command === 'jockey-de-galinha'
          ? { error: 'Calma aí: tente de novo em 5 s.' }
          : {
              embeds: [
                {
                  title: 'Servidor',
                  description: '🟢 **Online** desde <t:1700000000:R>',
                  color: 0x2ecc71,
                  url: 'javascript:alert(1)',
                  fields: [{ name: 'Jogadores', value: '**2**/20', inline: true }],
                  footer: 'Status',
                  timestamp: Date.now(),
                },
              ],
              files: [{ name: 'Servidor-1.21.1.mrpack', data: Buffer.from('PK modpack').toString('base64') }],
            };
    ws.send(JSON.stringify({ op: 'reply', id: m.id, ...reply }));
  };

  const msg = await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'status', query: '' });
  assert.equal(msg.author.id, steve);
  assert.equal(msg.interaction.name, 'status');
  assert.equal(msg.interaction.user.id, member.id);
  assert.equal(msg.embeds[0].type, 'rich');
  assert.equal(msg.embeds[0].url, '', 'only http(s) links');
  assert.deepEqual(msg.embeds[0].fields, [{ name: 'Jogadores', value: '**2**/20', inline: true }]);
  assert.equal(msg.attachments[0].filename, 'Servidor-1.21.1.mrpack');
  assert.equal(seen[0].user.id, member.id);
  assert.equal(seen[0].guild_id, guild.id);
  assert.equal(seen[0].channel_id, general.id);
  assert.equal(seen[0].voice_channel_id, null);
  // The same file in the same channel isn't stored twice.
  const again = await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'status', query: '' });
  assert.equal(again.attachments[0].url, msg.attachments[0].url);

  // Ephemeral: only the caller gets it, and it isn't stored.
  const eph = await ok(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'mods', query: '2' });
  assert.equal(eph.ephemeral, true);
  assert.equal(eph.content, 'página 2');
  const list = await ok(member.token, 'GET', `/channels/${general.id}/messages?limit=10`);
  assert.ok(!list.some((m) => m.id === eph.id));
  // His errors are the caller's alone.
  r = await call(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'jockey-de-galinha', query: '' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Calma aí/);

  // His own messages: the live status is posted once and then edited; others' messages aren't his to touch.
  const live = await (await bot('POST', `/channels/${general.id}/messages`, { content: '', embeds: [{ title: 'Status ao vivo', description: 'x' }] })).json();
  assert.equal(live.author.id, steve);
  const edited = await (await bot('PATCH', `/channels/${general.id}/messages/${live.id}`, { content: '', embeds: [{ title: 'Status ao vivo', description: 'y' }] })).json();
  assert.equal(edited.embeds[0].description, 'y');
  assert.ok(edited.edited_at);
  assert.equal((await bot('GET', `/channels/${general.id}/messages/${live.id}`)).status, 200);
  const someone = await ok(member.token, 'POST', `/channels/${general.id}/messages`, { content: 'hi' });
  assert.equal((await bot('GET', `/channels/${general.id}/messages/${someone.id}`)).status, 404);
  assert.equal((await bot('PATCH', `/channels/${general.id}/messages/${someone.id}`, { content: 'x' })).status, 403);
  const guilds = await (await bot('GET', '/guilds')).json();
  const mine = guilds.find((x) => x.id === guild.id);
  assert.ok(mine.channels.some((c) => c.id === general.id));

  // Clips: Ogg or MP3 only.
  const ogg = await fetch(`${INTERNAL}/bots/steve/sounds/o-nether`, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: Buffer.from('OggS\0\x02rest') });
  assert.match((await ogg.json()).url, /^\/uploads\/bots\/steve\/o-nether-[0-9a-f]+\.ogg$/);
  const html = await fetch(`${INTERNAL}/bots/steve/sounds/evil`, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: '<html>' });
  assert.equal(html.status, 400);

  // Presence mirrors the Minecraft server; going away shows him offline and takes his commands off.
  ws.send(JSON.stringify({ op: 'presence', status: 'dnd', text: '🔴 Offline' }));
  await until(() => g.events.find((e) => e.t === 'PRESENCE_UPDATE' && e.d.user_id === steve && e.d.status === 'dnd' && e.d.activities?.[0]?.state === '🔴 Offline'));
  ws.close();
  await until(() => g.events.find((e) => e.t === 'PRESENCE_UPDATE' && e.d.user_id === steve && e.d.status === 'offline'));
  await until(() => g.events.findLast((e) => e.t === 'BOT_COMMANDS_UPDATE')?.d.commands.length === 0);
  r = await call(member.token, 'POST', `/channels/${general.id}/commands`, { name: 'status', query: '' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /away/);
  // Steve can't be banned, only removed.
  assert.equal((await call(owner.token, 'PUT', `/guilds/${guild.id}/bans/${steve}`)).status, 400);
  await ok(owner.token, 'DELETE', `/guilds/${guild.id}/bots/steve`);
});

test("Steve's picture is his own: admins change it without touching Kass's", async () => {
  const png = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
  const form = () => {
    const fd = new FormData();
    fd.append('file', new Blob([png], { type: 'image/png' }), 'steve.png');
    return fd;
  };
  assert.equal((await call(member.token, 'POST', '/bots/steve/avatar', form())).status, 403);
  const { token: admin } = await ok(null, 'POST', '/auth/dev', { username: 'logadmin' });
  const kassAvatar = async () => {
    const g = await gateway(owner.token);
    g.ws.close();
    return g.first.d.guilds.find((x) => x.id === guild.id).members.find((m) => m.user.username === 'kass').user.avatar;
  };
  const kassBefore = await kassAvatar();
  const steve = await ok(admin, 'POST', '/bots/steve/avatar', form());
  assert.equal(steve.username, 'steve');
  assert.match(steve.avatar, /^\/uploads\/bots\//);
  const reset = await ok(admin, 'DELETE', '/bots/steve/avatar');
  assert.equal(reset.avatar, '/uploads/bots/steve.svg');
  assert.equal(await kassAvatar(), kassBefore, "Kass's picture didn't change");
});

/** A v2 voice client (reconnects by itself, says `leave`): resolves with the socket, its `ready` and its close code. */
function voiceV2(u, channelId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/voice/connect`);
    const closed = new Promise((r) => ws.addEventListener('close', (e) => r(e.code)));
    ws.onopen = () => ws.send(JSON.stringify({ token: u.token, channel_id: channelId, v: 2 }));
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      if (m.op === 'ready') resolve({ ws, ready: m, closed });
    };
    ws.onerror = reject;
  });
}

test('voice: a dropped connection keeps the seat for a reconnect, quietly; leaving ends it at once', async () => {
  const [a, b] = await Promise.all([login('seata'), login('seatb')]);
  const { voice, invite } = await serverWithVoice(a);
  await ok(b.token, 'POST', `/invites/${invite.code}`);
  const watcher = await gateway(b.token);
  const states = (from) => watcher.events.slice(from).filter((e) => e.t === 'VOICE_STATE_UPDATE' && e.d.user_id === a.id);
  const left = (from) => states(from).some((e) => e.d.channel_id === null);

  const first = await voiceV2(a, voice.id);
  assert.equal(first.ready.resumed, false);
  await until(() => states(0).some((e) => e.d.channel_id === voice.id));
  const mark = watcher.events.length;
  // The connection drops (no `leave`): the seat waits and nobody hears about it.
  first.ws.close();
  await new Promise((r) => setTimeout(r, 400));
  const back = await voiceV2(a, voice.id);
  assert.equal(back.ready.resumed, true, 'the seat was kept');
  // The same login taking a seat that still has a live socket (the client noticed a dead connection first).
  const again = await voiceV2(a, voice.id);
  assert.equal(again.ready.resumed, true);
  assert.equal(await back.closed, 4006, 'the replaced socket is told why');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(states(mark).length, 0, 'nobody saw a leave or a join');
  // Saying leave ends it right away.
  again.ws.send(JSON.stringify({ op: 'leave' }));
  assert.equal(await again.closed, 1000);
  await until(() => left(mark));

  // Nobody coming back: the seat ends after the grace (1.5 s in tests).
  const lone = await voiceV2(a, voice.id);
  assert.equal(lone.ready.resumed, false);
  const mark2 = watcher.events.length;
  lone.ws.close();
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(!left(mark2), 'still seated during the grace');
  await until(() => left(mark2), 4000);

  // Older clients (no `v`) leave as soon as their socket closes, as before.
  const old = await voiceJoin(a, voice.id);
  const mark3 = watcher.events.length;
  old.onclose = null;
  old.close();
  await until(() => left(mark3), 1500);
  watcher.ws.close();
});

test('push: the Android app gets the same sealed notifications through FCM', { skip: !process.env.LINKORD_TEST_DATA_DIR }, async () => {
  const http = await import('node:http');
  const crypto = await import('node:crypto');
  const dir = process.env.LINKORD_TEST_DATA_DIR;
  const publicKey = fs.readFileSync(path.join(dir, 'fcm-public.pem'));
  // Google: the OAuth token endpoint and FCM's send, on :7709 (LINKORD_FCM_URL and the credentials' token_uri).
  const sends = [];
  let tokens = 0;
  const google = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      res.setHeader('content-type', 'application/json');
      if (req.url === '/token') {
        const assertion = new URLSearchParams(body).get('assertion');
        const [h, c, sig] = assertion.split('.');
        const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url'));
        const claims = JSON.parse(Buffer.from(c, 'base64url'));
        tokens++;
        if (!ok || claims.scope !== 'https://www.googleapis.com/auth/firebase.messaging') return res.writeHead(401).end('{}');
        return res.end(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }));
      }
      const msg = JSON.parse(body).message;
      sends.push({ url: req.url, auth: req.headers.authorization, msg });
      if (msg.token.startsWith('gone')) return res.writeHead(404).end(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }));
      res.end(JSON.stringify({ name: 'projects/linkord-test/messages/1' }));
    });
  });
  await new Promise((r) => google.listen(7709, '127.0.0.1', r));
  try {
    // The app starts Firebase with the server's public settings for its package.
    assert.deepEqual(await ok(null, 'GET', '/push/fcm?package=com.linkord.app'), { project_id: 'linkord-test', app_id: '1:123456789:android:abc', api_key: 'test-api-key', sender_id: '123456789' });
    assert.equal((await call(null, 'GET', '/push/fcm?package=com.other.app')).status, 404);

    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const auth = crypto.randomBytes(16);
    const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
    const [a, b] = await Promise.all([login('fcma'), login('fcmb')]);
    await ok(a.token, 'PUT', `/users/@me/relationships/${b.id}`);
    await ok(b.token, 'PUT', `/users/@me/relationships/${a.id}`);
    const dm = await ok(b.token, 'POST', '/users/@me/channels', { recipient_id: a.id });
    assert.equal((await call(a.token, 'POST', '/push/subscriptions', { endpoint: 'fcm:bad/token', keys })).status, 400);
    await ok(a.token, 'POST', '/push/subscriptions', { endpoint: 'fcm:phone-token_1', keys, lang: 'pt-BR' });

    await ok(b.token, 'POST', `/channels/${dm.id}/messages`, { content: 'oi do celular' });
    await until(() => sends.length === 1);
    const s = sends[0];
    assert.equal(s.url, '/v1/projects/linkord-test/messages:send');
    assert.equal(s.auth, 'Bearer tok-1');
    assert.equal(s.msg.token, 'phone-token_1');
    assert.equal(s.msg.android.priority, 'HIGH');
    assert.equal(s.msg.android.collapse_key, undefined, 'no collapse key: an offline phone gets every message to stack');
    assert.equal(s.msg.notification, undefined, 'a data message only: Google never sees the text');
    // Opened like the phone does it (RFC 8291), with Node's own crypto.
    const open = (sent) => {
      const body = Buffer.from(sent.msg.data.p, 'base64');
      const salt = body.subarray(0, 16);
      const keyid = body.subarray(21, 21 + body[20]);
      const ct = body.subarray(21 + body[20]);
      const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdh.computeSecret(keyid), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), keyid]), 32));
      const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
      return JSON.parse(plain.subarray(0, -1));
    };
    const note = open(s);
    assert.equal(note.body, 'oi do celular');
    assert.equal(note.channel_id, dm.id);
    assert.equal(note.author_id, b.id);
    assert.ok(note.author, 'the author on its own, for the stacked notification');
    assert.equal(note.conversation, null, 'a DM has no conversation title');

    // A second send reuses the access token; a token FCM says is gone is forgotten.
    await ok(a.token, 'POST', '/push/subscriptions', { endpoint: 'fcm:gone-token', keys });
    await ok(b.token, 'POST', `/channels/${dm.id}/messages`, { content: 'de novo' });
    await until(() => sends.length === 3);
    assert.equal(tokens, 1, 'one access token for both');
    await ok(b.token, 'POST', `/channels/${dm.id}/messages`, { content: 'e mais uma' });
    await until(() => sends.filter((x) => x.msg.token === 'phone-token_1').length === 3);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sends.filter((x) => x.msg.token === 'gone-token').length, 1, 'the gone token got nothing more');

    // A DM call rings the phone, and when the caller hangs up the phone hears it stopped (call_end), so a closed app
    // can take its "is calling you" down.
    const before = sends.length;
    const phone = () => sends.slice(before).filter((x) => x.msg.token === 'phone-token_1').map(open);
    const ws = await voiceJoin(b, dm.id);
    await until(() => phone().some((n) => n.call && n.channel_id === dm.id));
    ws.close();
    await until(() => phone().some((n) => n.call_end && n.channel_id === dm.id));
  } finally {
    google.close();
  }
});

test('push: encrypted notifications reach a phone when it should, and only then', async () => {
  const http = await import('node:http');
  const crypto = await import('node:crypto');
  // A push service (LINKORD_PUSH_HOSTS=localhost:7708 in run-local.sh); /gone answers like an expired subscription.
  const got = [];
  const service = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = req.url.includes('gone') ? 410 : 201;
      res.end();
    });
  });
  await new Promise((r) => service.listen(7708, '127.0.0.1', r));
  const b64 = (x) => Buffer.from(x).toString('base64url');
  const device = () => {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return { ecdh, auth: crypto.randomBytes(16) };
  };
  // RFC 8291 decryption with Node's own crypto: an independent check of the server's encryption.
  const open = (body, { ecdh, auth }) => {
    const salt = body.subarray(0, 16);
    const idlen = body[20];
    const keyid = body.subarray(21, 21 + idlen);
    const ct = body.subarray(21 + idlen);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), keyid]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdh.computeSecret(keyid), auth, info, 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    assert.equal(plain.at(-1), 2, 'last-record delimiter');
    return JSON.parse(plain.subarray(0, -1));
  };
  const sub = (path, dev, lang) => ({ endpoint: `http://localhost:7708/push/${path}`, keys: { p256dh: b64(dev.ecdh.getPublicKey()), auth: b64(dev.auth) }, lang });
  const pushesTo = (path) => got.filter((g) => g.url === `/push/${path}`);
  const settle = () => new Promise((r) => setTimeout(r, 400));

  const [a, b] = await Promise.all([login('pusha'), login('pushb')]);
  const { g, text, invite } = await serverWithVoice(b);
  await ok(a.token, 'POST', `/invites/${invite.code}`);
  const dm = await ok(b.token, 'POST', '/users/@me/channels', { recipient_id: a.id });
  const { public_key } = await ok(a.token, 'GET', '/push/key');
  const phone = device();

  assert.equal((await call(a.token, 'POST', '/push/subscriptions', { ...sub('x', phone), endpoint: 'https://evil.example/x' })).status, 400, 'unknown push services are refused');
  assert.equal((await call(a.token, 'POST', '/push/subscriptions', { ...sub('x', phone), keys: { p256dh: 'AAAA', auth: b64(phone.auth) } })).status, 400);
  await ok(a.token, 'POST', '/push/subscriptions', sub('a', phone, 'pt-BR'));

  // A DM: one push, signed with the server's key, encrypted for this phone only.
  await ok(b.token, 'POST', `/channels/${dm.id}/messages`, { content: 'oi <@' + a.id + '>' });
  await until(() => pushesTo('a').length === 1);
  const first = pushesTo('a')[0];
  assert.equal(first.headers['content-encoding'], 'aes128gcm');
  assert.equal(first.headers.urgency, 'high');
  const [, t, k] = first.headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, public_key);
  const [h, c, sig] = t.split('.');
  const raw = Buffer.from(k, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(raw.subarray(1, 33)), y: b64(raw.subarray(33)) }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')), 'VAPID signature');
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).aud, 'http://localhost:7708');
  const n = open(first.body, phone);
  assert.match(n.title, /pushb/);
  assert.match(n.body, /^oi @pusha/, 'mentions written out');
  assert.equal(n.url, `/channels/@me/${dm.id}`);
  assert.equal(n.channel_id, dm.id);

  // Using Linkord on another device: no push. In the background: pushes again.
  const desk = await gateway(a.token);
  desk.ws.send(JSON.stringify({ op: 'active' }));
  await settle();
  await ok(b.token, 'POST', `/channels/${dm.id}/messages`, { content: 'are you there?' });
  await settle();
  assert.equal(pushesTo('a').length, 1, 'no push while in use');
  desk.ws.send(JSON.stringify({ op: 'away' }));
  await settle();
  await ok(b.token, 'POST', `/channels/${dm.id}/messages`, { content: '' , attachments: [] }).catch(() => {});
  await ok(b.token, 'POST', `/channels/${dm.id}/messages`, { content: 'now?' });
  await until(() => pushesTo('a').some((p) => open(p.body, phone).body === 'now?'));
  desk.ws.close();

  // Server channels follow the notification level: "All messages" by default, then mentions only.
  const before = pushesTo('a').length;
  await ok(b.token, 'POST', `/channels/${text.id}/messages`, { content: 'hello server' });
  await until(() => pushesTo('a').length === before + 1);
  assert.match(open(pushesTo('a').at(-1).body, phone).title, new RegExp(`#sec-text, Sec ${run}`));
  await ok(a.token, 'PATCH', '/users/@me/settings', { guild_notifications: { [g.id]: 'mentions' } });
  await ok(b.token, 'POST', `/channels/${text.id}/messages`, { content: 'no ping' });
  await settle();
  assert.equal(pushesTo('a').length, before + 1, 'mentions only: a plain message stays quiet');
  await ok(b.token, 'POST', `/channels/${text.id}/messages`, { content: `<@${a.id}> look` });
  await until(() => pushesTo('a').length === before + 2);
  // Muted server: even mentions are quiet... except direct ones (like the app).
  await ok(a.token, 'PATCH', '/users/@me/settings', { guild_notifications: { [g.id]: 'none' } });
  await ok(b.token, 'POST', `/channels/${text.id}/messages`, { content: `<@${a.id}> nothing` });
  await settle();
  assert.equal(pushesTo('a').length, before + 2, '"Nothing" silences mentions too');

  // "Send a test", in the phone's language.
  const sent = await ok(a.token, 'POST', '/push/test');
  assert.equal(sent.sent, 1);
  assert.match(open(pushesTo('a').at(-1).body, phone).body, /funcionando/);

  // The service worker's receipt: only for a real subscription, no login needed.
  assert.equal((await call(null, 'POST', '/push/received', { endpoint: sub('a', phone).endpoint, shown: true })).status, 204);
  assert.equal((await call(null, 'POST', '/push/received', { endpoint: 'http://localhost:7708/push/nobody', shown: false, error: 'x' })).status, 204);

  // An expired subscription is dropped after the first 410.
  const old = device();
  await ok(a.token, 'POST', '/push/subscriptions', sub('gone', old));
  await ok(b.token, 'POST', `/channels/${dm.id}/messages`, { content: 'one' });
  await until(() => pushesTo('gone').length === 1);
  await ok(b.token, 'POST', `/channels/${dm.id}/messages`, { content: 'two' });
  await settle();
  assert.equal(pushesTo('gone').length, 1);

  // Signing out removes this login's subscription.
  const tablet = await ok(null, 'POST', '/auth/dev', { username: `pusha.${run}` });
  await ok(tablet.token, 'POST', '/push/subscriptions', sub('tablet', device()));
  await call(tablet.token, 'POST', '/auth/logout');
  await ok(b.token, 'POST', `/channels/${dm.id}/messages`, { content: 'three' });
  await until(() => pushesTo('a').length >= before + 5);
  assert.equal(pushesTo('tablet').length, 0, 'gone with its login');
  service.close();
});

test('REC: opting out of other people\'s recordings is on everyone\'s copy of the user', async () => {
  const quiet = await login('recquiet');
  const friend = await login('recfriend');
  await ok(quiet.token, 'POST', '/users/@me/relationships', { username: friend.username });
  await ok(friend.token, 'PUT', `/users/@me/relationships/${quiet.id}`, {});
  assert.equal((await ok(friend.token, 'GET', `/users/${quiet.id}`)).rec_opt_out, false, 'recorded unless they say no');
  const me = await ok(quiet.token, 'PATCH', '/users/@me', { rec_opt_out: true });
  assert.equal(me.rec_opt_out, true);
  assert.equal((await ok(friend.token, 'GET', `/users/${quiet.id}`)).rec_opt_out, true);
  // Other profile changes leave it alone.
  await ok(quiet.token, 'PATCH', '/users/@me', { bio: 'shy' });
  assert.equal((await ok(friend.token, 'GET', `/users/${quiet.id}`)).rec_opt_out, true);
  assert.equal((await ok(quiet.token, 'PATCH', '/users/@me', { rec_opt_out: false })).rec_opt_out, false);
});

test('REC: a clip uploads in chunks, plays for anyone at its link, counts viewers once and unfurls in chat', async () => {
  const owner = await login('recsharer');
  const stranger = await login('recstranger');
  const { text, voice, invite } = await serverWithVoice(owner);
  // A real H.264 + AAC MP4, like the app's clips.
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const file = join(mkdtempSync(join(tmpdir(), 'linkord-clip-')), 'clip.mp4');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:d=2', '-f', 'lavfi', '-i', 'sine=d=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', file]);
  const bytes = readFileSync(file);
  const put = (token, id, offset, body) =>
    fetch(`${BASE}/api/clips/uploads/${id}?offset=${offset}`, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body });

  // Too big for one person's share, before anything is sent.
  assert.equal((await call(owner.token, 'POST', '/clips', { size: 2 * 1024 ** 3 })).status, 400);
  const start = await ok(owner.token, 'POST', '/clips', { size: bytes.length, title: 'Clutch <3', game: 'Stand-in' });
  const half = Math.floor(bytes.length / 2);
  assert.equal((await put(owner.token, start.upload_id, 0, bytes.subarray(0, half))).status, 200);
  // Resending from the wrong place says where the upload is.
  const wrong = await put(owner.token, start.upload_id, 0, bytes.subarray(0, 10));
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).received, half);
  assert.equal((await put(stranger.token, start.upload_id, half, bytes.subarray(half))).status, 404, 'not theirs');
  assert.equal((await put(owner.token, start.upload_id, half, bytes.subarray(half))).status, 200);
  const clip = await ok(owner.token, 'POST', `/clips/uploads/${start.upload_id}/finish`);
  assert.equal(clip.title, 'Clutch <3');
  assert.deepEqual([clip.width, clip.height], [320, 180]);
  assert.ok(clip.duration_ms > 1500 && clip.duration_ms < 2500, `${clip.duration_ms}`);
  assert.match(clip.slug, /^[A-Za-z0-9]{12}$/);
  // The first shared clip earns the bronze Clip maker badge.
  assert.ok(JSON.stringify(await ok(owner.token, 'GET', '/users/@me/badges')).includes('"clips"'), 'clips badge');

  // Not a video from REC: refused, and nothing kept.
  const junk = Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF\nfile:///etc/passwd\n');
  const bad = await ok(owner.token, 'POST', '/clips', { size: junk.length });
  await put(owner.token, bad.upload_id, 0, junk);
  assert.equal((await call(owner.token, 'POST', `/clips/uploads/${bad.upload_id}/finish`)).status, 400);

  // Anyone with the link: details, the page (no login, Open Graph video, only our own player's script), the file with
  // seeking.
  assert.equal((await call(null, 'GET', `/clips/${clip.slug}`)).body.id, clip.id);
  const page = await fetch(`${BASE}/clip/${clip.slug}`, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/130', 'cf-connecting-ip': '198.51.100.70' } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /property="og:video" content="[^"]+\/uploads\/clips\/[A-Za-z0-9]{12}\.mp4"/);
  assert.match(html, /Clutch &lt;3/, 'escaped');
  assert.match(html, /Download Linkord/);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc="\/assets\/)/, 'no inline or outside scripts');
  assert.match(html, /<div id="clip-player"[^>]*><video src=/, 'plays without the script too');
  const pageCsp = page.headers.get('content-security-policy');
  assert.match(pageCsp, /default-src 'none'/);
  assert.match(pageCsp, /script-src 'self';/);
  // The same viewer again, and a link preview bot: still one view.
  await fetch(`${BASE}/clip/${clip.slug}`, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/130', 'cf-connecting-ip': '198.51.100.70' } });
  await fetch(`${BASE}/clip/${clip.slug}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0)', 'cf-connecting-ip': '198.51.100.71' } });
  assert.equal((await call(null, 'GET', `/clips/${clip.slug}`)).body.views, 1);
  assert.equal((await fetch(`${BASE}/clip/${clip.id}`)).status, 404, 'ids are guessable, only the slug opens it');
  const range = await fetch(`${BASE}${clip.video}`, { headers: { range: 'bytes=0-99' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-type'), 'video/mp4');
  assert.equal((await fetch(`${BASE}${clip.thumbnail}`)).headers.get('content-type'), 'image/jpeg');

  // In chat, the link becomes a clip embed.
  const message = await ok(owner.token, 'POST', `/channels/${text.id}/messages`, { content: `look ${clip.url}` });
  await until(async () => (await ok(owner.token, 'GET', `/channels/${text.id}/messages?limit=5`)).find((m) => m.id === message.id)?.embeds?.length);
  const [embed] = (await ok(owner.token, 'GET', `/channels/${text.id}/messages?limit=5`)).find((m) => m.id === message.id).embeds;
  assert.equal(embed.type, 'clip');
  assert.equal(embed.clip.slug, clip.slug);

  // Watched together: the link plays as a clip in the call; three people watching is its author's premiere.
  const friends = [await login('recfan1'), await login('recfan2')];
  for (const f of friends) await ok(f.token, 'POST', `/invites/${invite.code}`);
  const sockets = [await voiceJoin(owner, voice.id), ...(await Promise.all(friends.map((f) => voiceJoin(f, voice.id))))];
  try {
    const w = await ok(friends[0].token, 'PUT', `/channels/${voice.id}/watch`, { url: clip.url });
    assert.deepEqual([w.provider, w.media, w.live], ['clip', clip.slug, false]);
    await ok(owner.token, 'PUT', `/channels/${voice.id}/watch/view`, { on: true });
    const premiere = async () => JSON.stringify(await ok(owner.token, 'GET', '/users/@me/badges')).includes('"premiere"');
    assert.equal(await premiere(), false, 'two viewers are not a premiere');
    await ok(friends[1].token, 'PUT', `/channels/${voice.id}/watch/view`, { on: true });
    await until(premiere);
  } finally {
    for (const ws of sockets) ws.close();
  }

  // Listed for its owner with their space; only they can change or delete it.
  const mine = await ok(owner.token, 'GET', '/users/@me/clips');
  assert.equal(mine.clips.length, 1);
  assert.ok(mine.used >= bytes.length && mine.quota > mine.used);
  assert.equal((await call(stranger.token, 'DELETE', `/clips/${clip.id}`)).status, 403);
  assert.equal((await ok(owner.token, 'PATCH', `/clips/${clip.id}`, { title: 'Ace' })).title, 'Ace');
  assert.equal((await call(owner.token, 'DELETE', `/clips/${clip.id}`)).status, 204);
  assert.equal((await fetch(`${BASE}/clip/${clip.slug}`)).status, 404);
  assert.equal((await fetch(`${BASE}${clip.video}`)).status, 404);
});

test('REC: recorded time counts toward its badge only up to the time played', async () => {
  const u = await login('recrecorder');
  // Nothing played yet: a recording can't count.
  assert.equal((await ok(u.token, 'POST', '/users/@me/rec/recorded', { seconds: 3600 })).counted, 0);
  assert.equal((await ok(u.token, 'POST', '/users/@me/rec/recorded', { seconds: -50 })).counted, 0);
});

test('REC: a pentakill is only claimed through Riot, with a linked League account', async () => {
  const u = await login('recpenta');
  assert.equal((await call(u.token, 'POST', '/league/pentakill', { game_id: -1 })).status, 400);
  const r = await call(u.token, 'POST', '/league/pentakill', { game_id: 123 });
  // Without a Riot key the route is off; with one (server/.env on a dev PC), an account that linked none gets no
  // badge and Riot is never asked.
  if (r.status === 400) assert.match(r.body.error, /League profiles/);
  else assert.equal(r.body.status, 'no_account');
  assert.ok(!JSON.stringify(await ok(u.token, 'GET', '/users/@me/badges')).includes('"pentakill"'));
});

test('videos: a format browsers cannot show gets a copy every app plays; the original stays the download', async () => {
  const u = await login('videoposter');
  const { text } = await serverWithVoice(u);
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'linkord-video-'));
  const make = (name, args) => {
    const file = join(dir, name);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-shortest', ...args, file]);
    return readFileSync(file);
  };
  const files = {
    // An iPhone-style video (HEVC in a MOV): encoded again.
    hevc: make('phone.mov', ['-c:v', 'libx265', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', '-c:a', 'aac']),
    // OBS's MKV: H.264 already, only rewrapped.
    mkv: make('obs.mkv', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']),
    // What every app plays: left alone.
    mp4: make('fine.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']),
  };
  const gw = await gateway(u.token);
  const posted = {};
  for (const [name, bytes] of Object.entries(files)) {
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({ content: name }));
    fd.append('file', new Blob([bytes], { type: name === 'mkv' ? 'video/x-matroska' : name === 'hevc' ? 'video/quicktime' : 'video/mp4' }), `${name}.video`);
    posted[name] = await ok(u.token, 'POST', `/channels/${text.id}/messages`, fd);
  }
  const checked = (name) => gw.events.filter((e) => e.t === 'MESSAGE_UPDATE' && e.d.id === posted[name].id).pop()?.d.attachments[0];
  await until(() => Object.keys(files).every(checked), 18_000);
  assert.equal(checked('mp4').codec, 'h264');
  assert.equal(checked('mp4').playable, undefined);
  for (const name of ['hevc', 'mkv']) {
    const a = checked(name);
    assert.ok(a.playable?.endsWith('/playable.mp4'), `${name}: ${JSON.stringify(a)}`);
    assert.equal(a.url, posted[name].attachments[0].url, 'the original stays');
    const res = await fetch(`${BASE}${a.playable}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
  }
  assert.equal(checked('hevc').codec, 'hevc');
  gw.ws.close();
});
