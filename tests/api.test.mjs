// End-to-end API tests. Run against a server with LINKORD_DEV_LOGIN=true (never production):
//   LINKORD_TEST_URL=http://localhost:7701 node --test tests/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
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
    const v = fn();
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

test('servers from a Discord template: bad links are refused before anything is created', async () => {
  const u = await login('templater');
  const r = await call(u.token, 'POST', '/guilds', { name: 'Templated', template: 'https://evil.example/abc123' });
  assert.equal(r.status, 400);
  assert.equal((await call(u.token, 'GET', '/guild-templates/a%20b')).status, 400);
  // Live Discord fetch (skipped offline): channels and roles arrive, categories flattened.
  if (process.env.LINKORD_TEST_DISCORD) {
    const g = await ok(u.token, 'POST', '/guilds', { name: 'Templated', template: 'https://discord.new/hgM48av5Q69A' });
    assert.deepEqual(
      g.channels.map((c) => c.name),
      ['general', 'games', 'music', 'Lounge', 'Stream Room'],
    );
  }
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

test('avatar history keeps the last 8 uploads, restores one, and ignores banners', async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const send = (which) => {
    const fd = new FormData();
    fd.append('file', new Blob([png], { type: 'image/png' }), 'a.png');
    return ok(member.token, 'POST', `/users/@me/${which}`, fd);
  };
  await send('banner');
  const first = (await send('avatar')).avatar;
  for (let i = 0; i < 9; i++) await send('avatar');
  const list = await ok(member.token, 'GET', '/users/@me/avatars');
  assert.equal(list.length, 8);
  assert.ok(!list.includes(first), 'the oldest picture is dropped');
  const old = list[7];
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

test('nameplates: defaults come from the server folder, can be picked, uploaded and removed', async () => {
  const defaults = await ok(member.token, 'GET', '/nameplates');
  assert.ok(defaults.length >= 1 && defaults.every((u) => u.startsWith('/nameplates/')));
  assert.equal((await ok(member.token, 'PUT', '/users/@me/nameplate', { url: defaults[0] })).nameplate, defaults[0]);
  assert.equal((await fetch(`${BASE}${defaults[0]}`)).status, 200);
  const res = await fetch(`${BASE}/api/users/@me/nameplate`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${member.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url: '/nameplates/../../etc/passwd' }),
  });
  assert.equal(res.status, 400);
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'n.png');
  assert.match((await ok(member.token, 'POST', '/users/@me/nameplate', fd)).nameplate, /^\/uploads\/nameplates\//);
  assert.equal((await ok(member.token, 'DELETE', '/users/@me/nameplate')).nameplate, null);
});

test('nameplates: WebM videos work as defaults and uploads; a fake WebM is refused', { skip: !process.env.LINKORD_TEST_DATA_DIR }, async () => {
  const webm = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0xe3b341:s=132x24:d=1', '-c:v', 'libvpx-vp9', '-f', 'webm', 'pipe:1']);
  fs.writeFileSync(path.join(process.env.LINKORD_TEST_DATA_DIR, 'nameplates', 'zz-shimmer.webm'), webm);
  const defaults = await ok(member.token, 'GET', '/nameplates');
  assert.equal(defaults.at(-1), '/nameplates/zz-shimmer.webm');
  const served = await fetch(`${BASE}/nameplates/zz-shimmer.webm`);
  assert.equal(served.headers.get('content-type'), 'video/webm');
  assert.equal((await ok(member.token, 'PUT', '/users/@me/nameplate', { url: '/nameplates/zz-shimmer.webm' })).nameplate, '/nameplates/zz-shimmer.webm');

  // Uploaded ones are saved as .webm whatever the file was called, so every client knows to play them.
  const fd = new FormData();
  fd.append('file', new Blob([webm], { type: 'video/webm' }), 'loop.png');
  assert.match((await ok(member.token, 'POST', '/users/@me/nameplate', fd)).nameplate, /^\/uploads\/nameplates\/.+\/nameplate\.webm$/);
  const fake = new FormData();
  fake.append('file', new Blob(['not a video'], { type: 'video/webm' }), 'fake.webm');
  assert.equal((await call(member.token, 'POST', '/users/@me/nameplate', fake)).body.error, "that file isn't a WebM video");
  // Only nameplates can be videos.
  const avatar = new FormData();
  avatar.append('file', new Blob([webm], { type: 'video/webm' }), 'a.webm');
  assert.equal((await call(member.token, 'POST', '/users/@me/avatar', avatar)).status, 400);
  await ok(member.token, 'DELETE', '/users/@me/nameplate');
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

test('channel reordering needs Manage Channels and every channel once', async () => {
  const g = await ok(owner.token, 'POST', '/guilds', { name: `Order ${run}` });
  const inv = await ok(owner.token, 'POST', `/guilds/${g.id}/invites`, {});
  await ok(member.token, 'POST', `/invites/${inv.code}`);
  const extra = await ok(owner.token, 'POST', `/guilds/${g.id}/channels`, { name: 'second', kind: 0 });
  const ids = [extra.id, ...g.channels.map((c) => c.id)];
  assert.equal((await call(member.token, 'PUT', `/guilds/${g.id}/channels`, { ids })).status, 403);
  assert.equal((await call(owner.token, 'PUT', `/guilds/${g.id}/channels`, { ids: ids.slice(1) })).status, 400);
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
  assert.equal(pv.member_count, 1);
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

test('custom status: friends see emoji + text, your own sessions get it, it survives in READY, clears itself when it expires', async () => {
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

    // Kass becomes a member of the server, joins the member's channel (deafened) and his music arrives as kind 5.
    await until(() => watch.events.some((e) => e.t === 'GUILD_MEMBER_ADD' && e.d.member.user.id === bot));
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

test('logs: only admins can read them, clients can report errors', async () => {
  assert.equal((await call(owner.token, 'GET', '/admin/logs/days')).status, 403);
  assert.equal((await call(owner.token, 'POST', '/logs/client', { level: 'error', message: 'test error from api tests' })).status, 204);
  assert.equal((await call(owner.token, 'POST', '/logs/client', { level: 'shout', message: 'x' })).status, 400);
});

test('soundboard: default sounds, server sounds need Manage Emojis, everyone in the call gets a played sound', { skip: !process.env.LINKORD_TEST_DATA_DIR }, async () => {
  const defaults = await ok(member.token, 'GET', '/soundboard/default');
  assert.ok(defaults.some((s) => s.name === 'quack' && s.emoji === '🦆'), JSON.stringify(defaults.slice(0, 2)));
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
  } finally {
    a.close();
  }
  await until(() => watch.events.some((e) => e.t === 'WATCH_UPDATE' && e.d.watch === null));
  watch.ws.close();
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
