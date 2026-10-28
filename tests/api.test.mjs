// End-to-end API tests. Run against a server with LINKORD_DEV_LOGIN=true (never production):
//   LINKORD_TEST_URL=http://localhost:7701 node --test tests/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

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
