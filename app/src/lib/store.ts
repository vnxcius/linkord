import { t } from './i18n';
import { batch } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import { cmpId } from './ids';
import type { Activity, Channel, Emoji, Guild, GuildInfo, Member, Message, Rel, Role, Settings, Status, User, VoiceState } from './types';
import { Kind, isPrivate } from './types';

export interface ChannelMessages {
  list: Message[];
  loaded: boolean;
  /** Older messages exist on the server. */
  hasMore: boolean;
  /** Newer messages exist (after jumping back to an old message). */
  hasNewer: boolean;
  loading: boolean;
}

export interface State {
  connection: 'idle' | 'connecting' | 'open' | 'reconnecting';
  ready: boolean;
  sessionId: string | null;
  me: User | null;
  users: Record<string, User>;
  guilds: Record<string, GuildInfo>;
  guildOrder: string[];
  channels: Record<string, Channel>;
  /** guild id -> user id -> membership */
  members: Record<string, Record<string, Omit<Member, 'user'>>>;
  /** guild id -> role id -> role */
  roles: Record<string, Record<string, Role>>;
  emojis: Record<string, Emoji[]>;
  dmOrder: string[];
  relationships: Record<string, Rel>;
  settings: Settings;
  features: { gifs: boolean };
  presences: Record<string, Status>;
  /** user id -> what they're doing (listening to Spotify...). */
  activities: Record<string, Activity[]>;
  /** Your own custom status (also while invisible, when it isn't in `activities`). */
  customStatus: Activity | null;
  /** Bumped when your linked accounts change (Spotify connected elsewhere, token revoked...). */
  connectionsVersion: number;
  readStates: Record<string, string>;
  messages: Record<string, ChannelMessages>;
  /** channel id -> user id -> expiry timestamp */
  typing: Record<string, Record<string, number>>;
  voice: Record<string, VoiceState>;
  mentions: Record<string, number>;
  /** '@me' for DMs/home, otherwise a guild id */
  view: string;
  /** Last selected channel per view; '@me' with no channel shows the friends page. */
  selected: Record<string, string | undefined>;
  /** Message to highlight after a jump (search result, reply, pin). */
  highlight: string | null;
}

export const [state, setState] = createStore<State>({
  connection: 'idle',
  ready: false,
  sessionId: null,
  me: null,
  users: {},
  guilds: {},
  guildOrder: [],
  channels: {},
  members: {},
  roles: {},
  emojis: {},
  dmOrder: [],
  relationships: {},
  settings: {},
  features: { gifs: false },
  presences: {},
  activities: {},
  customStatus: null,
  connectionsVersion: 0,
  readStates: {},
  messages: {},
  typing: {},
  voice: {},
  mentions: {},
  view: '@me',
  selected: {},
  highlight: null,
});

export function putUser(u: User) {
  const prev = state.users[u.id];
  // Keep the private status field we only get for ourselves.
  setState('users', u.id, prev ? { ...u, status: u.status ?? prev.status } : u);
}

export function putMember(guildId: string, m: Member) {
  putUser(m.user);
  setState('members', guildId, m.user.id, { nickname: m.nickname, joined_at: m.joined_at, roles: m.roles });
}

export function setRoles(guildId: string, roles: Role[]) {
  setState('roles', guildId, reconcile(Object.fromEntries(roles.map((r) => [r.id, r]))));
}

export function addGuild(g: Guild) {
  batch(() => {
    const { channels, members, roles, emojis, ...info } = g;
    setState('guilds', g.id, info);
    if (!state.guildOrder.includes(g.id)) setState('guildOrder', (o) => [...o, g.id]);
    for (const c of channels) setState('channels', c.id, c);
    setState('members', g.id, reconcile({}));
    for (const m of members) putMember(g.id, m);
    setRoles(g.id, roles);
    setState('emojis', g.id, emojis);
  });
}

export function removeGuild(id: string) {
  batch(() => {
    for (const c of Object.values(state.channels)) if (c.guild_id === id) setState('channels', produce((cs) => delete cs[c.id]));
    setState('guilds', produce((m) => delete m[id]));
    setState('members', produce((m) => delete m[id]));
    setState('roles', produce((m) => delete m[id]));
    setState('emojis', produce((m) => delete m[id]));
    setState('guildOrder', (o) => o.filter((x) => x !== id));
    if (state.view === id) setState('view', '@me');
  });
}

export function addDm(c: Channel) {
  batch(() => {
    for (const u of c.recipients ?? []) putUser(u);
    setState('channels', c.id, c);
    if (!state.dmOrder.includes(c.id)) setState('dmOrder', (o) => [c.id, ...o]);
  });
}

const inOrder = (a: Channel, b: Channel) => Number(a.kind === Kind.Voice) - Number(b.kind === Kind.Voice) || a.position - b.position || cmpId(a.id, b.id);

/**
 * A server's sidebar, like Discord's: channels without a category first, then each category with its
 * channels. Text channels come before voice channels at each level.
 */
export function channelLayout(guildId: string): { top: Channel[]; categories: { category: Channel; channels: Channel[] }[] } {
  const all = guildChannels(guildId);
  const cats = all.filter((c) => c.kind === Kind.Category);
  const isCat = (id?: string | null) => !!id && cats.some((c) => c.id === id);
  const chans = all.filter((c) => c.kind === Kind.Text || c.kind === Kind.Voice);
  return {
    top: chans.filter((c) => !isCat(c.parent_id)).sort(inOrder),
    categories: cats.map((category) => ({ category, channels: chans.filter((c) => c.parent_id === category.id).sort(inOrder) })),
  };
}

/** Top-level channels of a guild (threads are listed under their parent). */
export function guildChannels(guildId: string): Channel[] {
  return Object.values(state.channels)
    .filter((c) => c.guild_id === guildId && c.kind !== Kind.Thread)
    .sort((a, b) => a.position - b.position || cmpId(a.id, b.id));
}

export function activeThreads(parentId: string): Channel[] {
  return Object.values(state.channels)
    .filter((c) => c.kind === Kind.Thread && c.parent_id === parentId && !c.archived)
    .sort((a, b) => cmpId(b.last_message_id ?? b.id, a.last_message_id ?? a.id));
}

export function dmRecipient(c: Channel): User | undefined {
  const other = c.recipients?.find((u) => u.id !== state.me?.id) ?? c.recipients?.[0];
  return other ? (state.users[other.id] ?? other) : undefined;
}

export function dmName(c: Channel): string {
  if (c.kind === Kind.GroupDm) {
    if (c.name) return c.name;
    const others = (c.recipients ?? []).filter((u) => u.id !== state.me?.id).map((u) => nameOf(u.id));
    return others.join(', ') || t('Empty group');
  }
  return nameOf(dmRecipient(c)?.id ?? '');
}

export function sortedDms(): Channel[] {
  return state.dmOrder
    .map((id) => state.channels[id])
    .filter(Boolean)
    .sort((a, b) => cmpId(b.last_message_id ?? b.id, a.last_message_id ?? a.id));
}

export function isMuted(c: Channel): boolean {
  const s = state.settings;
  return (
    !!s.muted_channels?.includes(c.id) ||
    (!!c.parent_id && !!s.muted_channels?.includes(c.parent_id)) ||
    (!!c.guild_id && !!s.muted_guilds?.includes(c.guild_id))
  );
}

export function isUnread(c: Channel): boolean {
  if (c.kind === Kind.Voice || !c.last_message_id) return false;
  const read = state.readStates[c.id];
  return !read || cmpId(c.last_message_id, read) > 0;
}

export function guildUnread(guildId: string): boolean {
  if (state.settings.muted_guilds?.includes(guildId)) return false;
  return Object.values(state.channels).some((c) => c.guild_id === guildId && !isMuted(c) && isUnread(c));
}

export function guildMentions(guildId: string): number {
  return Object.values(state.channels).reduce((n, c) => n + (c.guild_id === guildId ? (state.mentions[c.id] ?? 0) : 0), 0);
}

/** Total badge count: DMs plus mentions, like Discord's taskbar badge. */
export function totalMentions(): number {
  return Object.entries(state.mentions).reduce((n, [, v]) => n + (v ?? 0), 0);
}

export function presenceOf(userId: string): Status {
  return state.presences[userId] ?? 'offline';
}

/** Someone's Spotify activity, if they're listening and not offline. */
/** The game someone is playing ("Playing ..."), shown before Spotify like Discord. */
export function gameOf(userId: string): Activity | undefined {
  return state.activities[userId]?.find((a) => a.type === 0);
}

/** Someone's custom status (emoji + text), shown in place of the activity line. */
export function customStatusOf(userId: string): Activity | undefined {
  if (userId === state.me?.id) return state.customStatus ?? undefined;
  return state.activities[userId]?.find((a) => a.type === 4);
}

export function spotifyOf(userId: string): Activity | undefined {
  if (presenceOf(userId) === 'offline') return undefined;
  return state.activities[userId]?.find((a) => a.name === 'Spotify');
}

export function voiceMembers(channelId: string): VoiceState[] {
  return Object.values(state.voice).filter((v) => v.channel_id === channelId);
}

export function currentChannel(): Channel | undefined {
  const id = state.selected[state.view];
  return id ? state.channels[id] : undefined;
}

/** Roles of a member, highest first. */
export function memberRoles(guildId: string, userId: string): Role[] {
  const roles = state.roles[guildId] ?? {};
  return (state.members[guildId]?.[userId]?.roles ?? [])
    .map((r) => roles[r])
    .filter(Boolean)
    .sort((a, b) => b.position - a.position);
}

/** Name color from the member's highest colored role. */
export function nameColor(guildId: string | null | undefined, userId: string): string | undefined {
  if (!guildId) return undefined;
  const c = memberRoles(guildId, userId).find((r) => r.color)?.color;
  return c ? `#${c.toString(16).padStart(6, '0')}` : undefined;
}

/** Nickname in the guild, else display name, else username. */
export function nameOf(userId: string, guildId?: string | null): string {
  const nick = guildId ? state.members[guildId]?.[userId]?.nickname : null;
  const u = state.users[userId];
  return nick || u?.display_name || u?.username || t('Unknown');
}

export function findEmoji(id: string): Emoji | undefined {
  for (const list of Object.values(state.emojis)) {
    const e = list.find((x) => x.id === id);
    if (e) return e;
  }
}

export function isBlocked(userId: string): boolean {
  return state.relationships[userId] === 2;
}

export { isPrivate };
