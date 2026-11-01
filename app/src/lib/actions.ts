import { batch } from 'solid-js';
import { produce } from 'solid-js/store';
import { api, setToken } from './api';
import { cmpId } from './ids';
import { addDm, addGuild, channelLayout, setState, state } from './store';
import { setUi, toast, ui } from './ui';
import type { Channel, Guild, Message, NotifyLevel, Settings } from './types';
import { Kind } from './types';

export function selectView(view: string) {
  setState('view', view);
  if (view !== '@me' && !state.selected[view]) {
    const { top, categories } = channelLayout(view);
    const first = [...top, ...categories.flatMap((c) => c.channels)].find((c) => c.kind === Kind.Text);
    if (first) setState('selected', view, first.id);
  }
  const ch = state.selected[view];
  if (ch) onChannelViewed(ch);
}

export function selectChannel(channelId: string) {
  const ch = state.channels[channelId];
  if (!ch) return;
  const view = ch.guild_id ?? '@me';
  batch(() => {
    setState('view', view);
    setState('selected', view, channelId);
    setUi({ mobilePane: 'main', membersDrawer: false });
  });
  onChannelViewed(channelId);
}

/** Calls everyone in a DM or group DM (joining its call; others get rung), optionally with the camera on. */
export async function startCall(channelId: string, video = false) {
  const { joinVoice, toggleCamera, voiceUi } = await import('./voice');
  selectChannel(channelId);
  await joinVoice(channelId);
  if (!video) return;
  for (let i = 0; i < 50 && voiceUi.connecting; i++) await new Promise((r) => setTimeout(r, 100));
  if (voiceUi.channelId === channelId && !voiceUi.camera) await toggleCamera();
}

/** Opens a voice channel's chat beside the call (without joining the call). */
export function openVoiceChat(channelId: string) {
  setUi('voiceChat', channelId);
  selectChannel(channelId);
}

/** Shows the friends page. */
export function openFriends() {
  batch(() => {
    setState('view', '@me');
    setState('selected', '@me', undefined);
    setUi('mobilePane', 'main');
  });
}

function onChannelViewed(channelId: string) {
  const ch = state.channels[channelId];
  // A voice channel's chat loads when it's opened (openVoiceChat).
  if (!ch || (ch.kind === Kind.Voice && ui.voiceChat !== channelId)) return;
  if (!state.messages[channelId]?.loaded) void loadMessages(channelId);
  maybeAck(channelId);
}

export function ensureMessages(channelId: string) {
  if (!state.messages[channelId])
    setState('messages', channelId, { list: [], loaded: false, hasMore: true, hasNewer: false, loading: false });
}

const PAGE = 50;
/** Older messages are dropped from memory beyond this, while reading the latest messages. */
const KEEP = 200;

export async function loadMessages(channelId: string, before?: string) {
  ensureMessages(channelId);
  if (state.messages[channelId].loading) return;
  setState('messages', channelId, 'loading', true);
  try {
    const page = await api<Message[]>(
      'GET',
      `/channels/${channelId}/messages?limit=${PAGE}${before ? `&before=${before}` : ''}`,
    );
    setState('messages', channelId, (m) => ({
      ...m,
      list: before ? [...page, ...m.list] : [...page, ...m.list.filter((x) => x.pending || x.failed)],
      loaded: true,
      hasMore: page.length === PAGE,
      hasNewer: before ? m.hasNewer : false,
      loading: false,
    }));
  } catch (e) {
    setState('messages', channelId, 'loading', false);
    throw e;
  }
}

/** Loads the next page after the newest loaded message (when viewing history). */
export async function loadNewer(channelId: string) {
  const b = state.messages[channelId];
  if (!b?.hasNewer || b.loading || !b.list.length) return;
  setState('messages', channelId, 'loading', true);
  try {
    const page = await api<Message[]>(
      'GET',
      `/channels/${channelId}/messages?limit=${PAGE}&after=${b.list[b.list.length - 1].id}`,
    );
    setState('messages', channelId, (m) => ({
      ...m,
      list: [...m.list, ...page],
      hasNewer: page.length === PAGE,
      loading: false,
    }));
  } catch {
    setState('messages', channelId, 'loading', false);
  }
}

/** Keeps memory bounded in busy channels: trims old messages once you're reading the latest ones. */
export function trimHistory(channelId: string) {
  const b = state.messages[channelId];
  if (!b || b.hasNewer || b.list.length <= KEEP) return;
  setState('messages', channelId, (m) => ({ ...m, list: m.list.slice(-KEEP), hasMore: true }));
}

/** Opens the channel scrolled to a specific message, loading the page around it. */
export async function jumpToMessage(channelId: string, messageId: string) {
  selectChannel(channelId);
  ensureMessages(channelId);
  const have = state.messages[channelId].list.some((m) => m.id === messageId);
  if (!have) {
    setState('messages', channelId, 'loading', true);
    const page = await api<Message[]>('GET', `/channels/${channelId}/messages?around=${messageId}&limit=${PAGE}`);
    const latest = state.channels[channelId]?.last_message_id;
    setState('messages', channelId, {
      list: page,
      loaded: true,
      hasMore: true,
      hasNewer: !!latest && !page.some((m) => m.id === latest),
      loading: false,
    });
  }
  setState('highlight', messageId);
  setTimeout(() => state.highlight === messageId && setState('highlight', null), 2500);
}

/** Back to the newest messages after reading history. */
export async function jumpToPresent(channelId: string) {
  setState('messages', channelId, { list: [], loaded: false, hasMore: true, hasNewer: false, loading: false });
  await loadMessages(channelId);
}

let ackTimer: number | undefined;

/** Marks the channel as read if it is on screen and the window has focus. */
export function maybeAck(channelId: string) {
  clearTimeout(ackTimer);
  ackTimer = window.setTimeout(() => {
    const ch = state.channels[channelId];
    if (!ch?.last_message_id || !document.hasFocus()) return;
    if (state.selected[state.view] !== channelId || state.messages[channelId]?.hasNewer) return;
    // A voice channel's chat counts as read only while it's open.
    if (ch.kind === Kind.Voice && ui.voiceChat !== channelId) return;
    setState('mentions', channelId, 0);
    const read = state.readStates[channelId];
    if (read && cmpId(read, ch.last_message_id) >= 0) return;
    setState('readStates', channelId, ch.last_message_id);
    api('POST', `/channels/${channelId}/ack`, { message_id: ch.last_message_id }).catch(() => {});
  }, 250);
}

export function markRead(channelIds: string[]) {
  for (const id of channelIds) {
    const ch = state.channels[id];
    if (!ch?.last_message_id) continue;
    setState('mentions', id, 0);
    setState('readStates', id, ch.last_message_id);
    api('POST', `/channels/${id}/ack`, { message_id: ch.last_message_id }).catch(() => {});
  }
}

export interface VoiceMeta {
  duration_secs: number;
  waveform: string;
}

export async function sendMessage(
  channelId: string,
  content: string,
  replyTo?: string,
  files: File[] = [],
  voice?: VoiceMeta,
) {
  const me = state.me!;
  const nonce = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  ensureMessages(channelId);
  if (state.messages[channelId].hasNewer) await jumpToPresent(channelId);
  const temp: Message = {
    id: `pending-${nonce}`,
    channel_id: channelId,
    author: me,
    content,
    reply_to: replyTo ?? null,
    referenced_message: replyTo ? referenced(channelId, replyTo) : null,
    // A voice message shows (and plays) right away from the local recording while it uploads.
    attachments:
      voice && files[0]
        ? [
            {
              id: `pending-${nonce}`,
              filename: files[0].name,
              url: URL.createObjectURL(files[0]),
              size: files[0].size,
              content_type: files[0].type,
              ...voice,
            },
          ]
        : [],
    embeds: [],
    reactions: [],
    created_at: new Date().toISOString(),
    nonce,
    pending: true,
  };
  setUi('sent', { channelId, n: ui.sent.n + 1 });
  setState('messages', channelId, 'list', (l) => [...l, temp]);
  const payload = { content, reply_to: replyTo, nonce, voice };
  let body: unknown = payload;
  if (files.length) {
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify(payload));
    files.forEach((f, i) => fd.append(`files[${i}]`, f, f.name));
    body = fd;
  }
  try {
    const msg = await api<Message>('POST', `/channels/${channelId}/messages`, body);
    receiveMessage(msg);
  } catch {
    setState(
      'messages',
      channelId,
      'list',
      (m) => m.nonce === nonce && m.pending === true,
      produce((m) => {
        m.pending = false;
        m.failed = true;
      }),
    );
  }
}

/** Runs a slash command (/play...). The bot answers in the channel; mistakes come back as a toast only you see. */
export async function runCommand(channelId: string, name: string, query: string) {
  try {
    receiveMessage(await api<Message>('POST', `/channels/${channelId}/commands`, { name, query }));
  } catch (e) {
    toast((e as Error).message);
  }
}

function referenced(channelId: string, id: string) {
  const m = state.messages[channelId]?.list.find((x) => x.id === id);
  return m ? { id: m.id, author: m.author, content: m.content || m.forwarded?.content || '' } : null;
}

/** Inserts a message, replacing the optimistic copy with the same nonce. */
export function receiveMessage(msg: Message) {
  const bucket = state.messages[msg.channel_id];
  // While viewing history the new message isn't adjacent to what's loaded; "jump to present" picks it up.
  if (!bucket?.loaded || bucket.hasNewer) return;
  const list = bucket.list;
  if (list.some((m) => m.id === msg.id)) return;
  const pendingIdx = msg.nonce ? list.findIndex((m) => m.nonce === msg.nonce && m.author.id === msg.author.id) : -1;
  if (pendingIdx >= 0)
    setState('messages', msg.channel_id, 'list', pendingIdx, { ...msg, pending: false, failed: false });
  else setState('messages', msg.channel_id, 'list', (l) => [...l, msg]);
}

export async function retryMessage(m: Message) {
  setState('messages', m.channel_id, 'list', (l) => l.filter((x) => x.id !== m.id));
  // A failed voice message still has its recording locally.
  const v = m.attachments[0];
  if (v?.waveform && v.url.startsWith('blob:')) {
    const file = new File([await (await fetch(v.url)).blob()], v.filename, { type: v.content_type });
    return sendMessage(m.channel_id, '', m.reply_to ?? undefined, [file], {
      duration_secs: v.duration_secs!,
      waveform: v.waveform,
    });
  }
  void sendMessage(m.channel_id, m.content, m.reply_to ?? undefined);
}

export async function toggleReaction(m: Message, emoji: string) {
  const mine = m.reactions.find((r) => r.emoji === emoji)?.users.includes(state.me!.id);
  const path = `/channels/${m.channel_id}/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`;
  await api(mine ? 'DELETE' : 'PUT', path);
}

export async function togglePin(m: Message) {
  await api(m.pinned ? 'DELETE' : 'PUT', `/channels/${m.channel_id}/pins/${m.id}`);
}

export async function startThread(m: Message, name?: string) {
  const thread = await api<Channel>('POST', `/channels/${m.channel_id}/messages/${m.id}/threads`, { name });
  setState('channels', thread.id, thread);
  selectChannel(thread.id);
}

/** Forwards a message to channels/DMs and to friends (their DM is opened if needed), with an optional comment. */
export async function forwardMessage(m: Message, to: { channelIds: string[]; userIds: string[] }, content: string) {
  await api('POST', `/channels/${m.channel_id}/messages/${m.id}/forward`, {
    channel_ids: to.channelIds,
    user_ids: to.userIds,
    content,
  });
}

let lastTyping = 0;

export function sendTyping(channelId: string) {
  if (Date.now() - lastTyping < 8000) return;
  lastTyping = Date.now();
  api('POST', `/channels/${channelId}/typing`).catch(() => {});
}

export function resetTyping() {
  lastTyping = 0;
}

/** The DM channel with someone (created if needed), without opening it. */
export async function dmChannel(userId: string): Promise<Channel> {
  const ch = await api<Channel>('POST', '/users/@me/channels', { recipient_id: userId });
  addDm(ch);
  return ch;
}

export async function openDm(userId: string) {
  selectChannel((await dmChannel(userId)).id);
}

/** Joins a server from an invite code and opens it. */
export async function acceptInvite(code: string) {
  const g = await api<Guild>('POST', `/invites/${code}`);
  addGuild(g);
  selectView(g.id);
}

export async function createGroupDm(userIds: string[]) {
  const ch = await api<Channel>('POST', '/users/@me/channels', { recipients: userIds });
  addDm(ch);
  selectChannel(ch.id);
}

export async function patchSettings(patch: Partial<Settings>) {
  setState('settings', (s) => ({ ...s, ...patch }));
  await api('PATCH', '/users/@me/settings', patch);
}

function toggleIn(list: string[] | undefined, id: string): string[] {
  const l = list ?? [];
  return l.includes(id) ? l.filter((x) => x !== id) : [...l, id];
}

export const toggleMuteGuild = (id: string) =>
  patchSettings({ muted_guilds: toggleIn(state.settings.muted_guilds, id) });
export const toggleCategory = (id: string) =>
  patchSettings({ collapsed_categories: toggleIn(state.settings.collapsed_categories, id) });
/** Collapses every category of a server (or expands them all when they already are). */
export function toggleAllCategories(guildId: string) {
  const ids = channelLayout(guildId).categories.map((c) => c.category.id);
  const collapsed = state.settings.collapsed_categories ?? [];
  const all = ids.every((id) => collapsed.includes(id));
  return patchSettings({
    collapsed_categories: all ? collapsed.filter((id) => !ids.includes(id)) : [...new Set([...collapsed, ...ids])],
  });
}
/** A server's notification level (servers without one notify for every message). */
export const setGuildNotify = (id: string, level: NotifyLevel | undefined) =>
  patchSettings({ guild_notifications: withEntry(state.settings.guild_notifications, id, level) });
/** A channel's (or category's) own level; undefined follows the server. */
export const setChannelNotify = (id: string, level: NotifyLevel | undefined) =>
  patchSettings({ channel_notifications: withEntry(state.settings.channel_notifications, id, level) });

function withEntry<T>(map: Record<string, T> | undefined, id: string, value: T | undefined): Record<string, T> {
  const out = { ...map };
  if (value === undefined) delete out[id];
  else out[id] = value;
  return out;
}

export const toggleMuteChannel = (id: string) =>
  patchSettings({ muted_channels: toggleIn(state.settings.muted_channels, id) });

export const friendRequest = (userId: string) => api('PUT', `/users/@me/relationships/${userId}`);
export const friendRequestByName = (username: string) => api('POST', '/users/@me/relationships', { username });
export const removeRelationship = (userId: string) => api('DELETE', `/users/@me/relationships/${userId}`);
export const blockUser = (userId: string) => api('PUT', `/users/@me/relationships/${userId}`, { type: 2 });

export async function logoutEverywhere() {
  await api('POST', '/auth/logout-all');
  await logout();
}

export async function logout() {
  await api('POST', '/auth/logout').catch(() => {});
  setToken(null);
  location.reload();
}

/** A server's sidebar order: channel ids without a category, then each category with its channel ids. */
export interface ChannelOrder {
  top: string[];
  categories: { id: string; channels: string[] }[];
}

export function currentOrder(guildId: string): ChannelOrder {
  const l = channelLayout(guildId);
  return {
    top: l.top.map((c) => c.id),
    categories: l.categories.map((c) => ({ id: c.category.id, channels: c.channels.map((x) => x.id) })),
  };
}

/** Saves a new sidebar order (positions and categories), showing it right away. */
export async function saveChannelOrder(guildId: string, order: ChannelOrder) {
  const ids = [...order.top, ...order.categories.flatMap((c) => [c.id, ...c.channels])];
  const parentOf = new Map<string, string | null>(order.top.map((id) => [id, null]));
  for (const c of order.categories) for (const id of c.channels) parentOf.set(id, c.id);
  const parents: Record<string, string | null> = {};
  for (const [id, parent] of parentOf) if ((state.channels[id]?.parent_id ?? null) !== parent) parents[id] = parent;
  const before = ids.map((id) => [id, state.channels[id].position, state.channels[id].parent_id ?? null] as const);
  // Channels hidden from you keep their places: yours take the positions they had, in the new order (the
  // server does the same).
  const slots = before.map(([, pos]) => pos).sort((x, y) => x - y);
  batch(() =>
    ids.forEach((id, i) => {
      setState('channels', id, 'position', slots[i]);
      if (id in parents) setState('channels', id, 'parent_id', parents[id]);
    }),
  );
  try {
    await api('PUT', `/guilds/${guildId}/channels`, { ids, parents });
  } catch (e) {
    batch(() => before.forEach(([id, pos, parent]) => setState('channels', id, { position: pos, parent_id: parent })));
    throw e;
  }
}

/** Discord's "Clone Channel": same kind, name, topic, category and permissions, placed right below it. */
export async function duplicateChannel(channelId: string) {
  const c = state.channels[channelId];
  if (!c?.guild_id) return;
  const guildId = c.guild_id;
  const copy = await api<Channel>('POST', `/guilds/${guildId}/channels`, {
    name: c.name,
    kind: c.kind,
    topic: c.topic,
    parent_id: c.parent_id ?? undefined,
    permission_overwrites: c.permission_overwrites ?? [],
  });
  if (!state.channels[copy.id]) setState('channels', copy.id, copy);
  const order = currentOrder(guildId);
  for (const list of [order.top, ...order.categories.map((x) => x.channels)]) {
    const from = list.indexOf(copy.id);
    if (from >= 0) list.splice(from, 1);
  }
  for (const list of [order.top, ...order.categories.map((x) => x.channels)]) {
    const at = list.indexOf(channelId);
    if (at >= 0) list.splice(at + 1, 0, copy.id);
  }
  await saveChannelOrder(guildId, order);
}
