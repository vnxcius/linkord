// Mirrors server/src/perms.rs. The server enforces these; the client only uses them to hide controls.
import { msg } from './msg';
import { state } from './store';
import { Kind, type Overwrite } from './types';

export const P = {
  CREATE_INVITE: 1 << 0,
  KICK_MEMBERS: 1 << 1,
  ADMINISTRATOR: 1 << 3,
  MANAGE_CHANNELS: 1 << 4,
  MANAGE_GUILD: 1 << 5,
  ADD_REACTIONS: 1 << 6,
  STREAM: 1 << 9,
  VIEW_CHANNEL: 1 << 10,
  SEND_MESSAGES: 1 << 11,
  MANAGE_MESSAGES: 1 << 13,
  ATTACH_FILES: 1 << 15,
  READ_MESSAGE_HISTORY: 1 << 16,
  MENTION_EVERYONE: 1 << 17,
  CONNECT: 1 << 20,
  SPEAK: 1 << 21,
  MOVE_MEMBERS: 1 << 24,
  CHANGE_NICKNAME: 1 << 26,
  MANAGE_NICKNAMES: 1 << 27,
  MANAGE_ROLES: 1 << 28,
  MANAGE_EMOJIS: 2 ** 30,
  MANAGE_THREADS: 2 ** 34,
  CREATE_THREADS: 2 ** 35,
  USE_SOUNDBOARD: 2 ** 42,
} as const;

export type PermKey = keyof typeof P;

/** Permission names shown in role settings, grouped like Discord. */
export const PERM_INFO: { group: string; items: [PermKey, string, string][] }[] = [
  {
    group: msg('General'),
    items: [
      ['ADMINISTRATOR', msg('Administrator'), msg('Every permission, and can reorder roles. Dangerous.')],
      ['VIEW_CHANNEL', msg('View Channels'), msg('See channels (unless a channel says otherwise).')],
      ['MANAGE_GUILD', msg('Manage Server'), msg('Rename the server and change its icon.')],
      ['MANAGE_CHANNELS', msg('Manage Channels'), msg('Create, edit and delete channels.')],
      ['MANAGE_ROLES', msg('Manage Roles'), msg('Create roles below their own and assign them.')],
      ['MANAGE_EMOJIS', msg('Manage Emoji'), msg('Upload, rename and delete custom emoji.')],
    ],
  },
  {
    group: msg('Members'),
    items: [
      ['CREATE_INVITE', msg('Create Invite'), msg('Invite new people.')],
      ['CHANGE_NICKNAME', msg('Change Nickname'), msg('Change their own nickname.')],
      ['MANAGE_NICKNAMES', msg('Manage Nicknames'), msg("Change other members' nicknames.")],
      ['KICK_MEMBERS', msg('Kick Members'), msg('Remove members below them.')],
    ],
  },
  {
    group: msg('Text'),
    items: [
      ['SEND_MESSAGES', msg('Send Messages'), ''],
      ['ATTACH_FILES', msg('Attach Files'), ''],
      ['ADD_REACTIONS', msg('Add Reactions'), ''],
      ['READ_MESSAGE_HISTORY', msg('Read Message History'), msg('See messages sent before they opened the channel.')],
      ['MENTION_EVERYONE', msg('Mention @everyone'), msg('Notify everyone with @everyone or @here.')],
      ['MANAGE_MESSAGES', msg('Manage Messages'), msg("Delete others' messages and pin messages.")],
      ['CREATE_THREADS', msg('Create Threads'), ''],
      ['MANAGE_THREADS', msg('Manage Threads'), msg('Rename, archive and delete any thread.')],
    ],
  },
  {
    group: msg('Voice'),
    items: [
      ['CONNECT', msg('Connect'), msg('Join voice channels.')],
      ['SPEAK', msg('Speak'), msg('Talk in voice channels.')],
      ['STREAM', msg('Video'), msg('Share their screen or turn on their camera.')],
      ['USE_SOUNDBOARD', msg('Use Soundboard'), msg('Play soundboard sounds in calls.')],
      ['MOVE_MEMBERS', msg('Move Members'), msg('Drag people between voice channels and disconnect them from calls.')],
    ],
  },
];

/** Permissions a channel overwrite can set (in that channel, Manage Roles reads "Manage Permissions"). */
const CHANNEL_PERMS: PermKey[] = [
  'VIEW_CHANNEL',
  'MANAGE_CHANNELS',
  'MANAGE_ROLES',
  'CREATE_INVITE',
  'SEND_MESSAGES',
  'ATTACH_FILES',
  'ADD_REACTIONS',
  'READ_MESSAGE_HISTORY',
  'MENTION_EVERYONE',
  'MANAGE_MESSAGES',
  'CREATE_THREADS',
  'MANAGE_THREADS',
  'CONNECT',
  'SPEAK',
  'STREAM',
  'USE_SOUNDBOARD',
  'MOVE_MEMBERS',
];

/** The permission list in a channel's (or category's) Permissions page, by channel kind. */
export function channelPermInfo(kind: Kind): { group: string; items: [PermKey, string, string][] }[] {
  const general: [PermKey, string, string][] = [
    ['VIEW_CHANNEL', msg('View Channel'), msg('See this channel and, for text, read its messages.')],
    ['MANAGE_CHANNELS', msg('Manage Channel'), msg('Rename it, change its topic and delete it.')],
    ['MANAGE_ROLES', msg('Manage Permissions'), msg("Change this channel's permissions.")],
    ['CREATE_INVITE', msg('Create Invite'), ''],
  ];
  const text = PERM_INFO.find((g) => g.group === 'Text')!.items.filter(([k]) => CHANNEL_PERMS.includes(k));
  const voice = PERM_INFO.find((g) => g.group === 'Voice')!.items;
  const out = [{ group: msg('General'), items: general }];
  if (kind !== Kind.Voice) out.push({ group: msg('Text'), items: text });
  if (kind !== Kind.Text) out.push({ group: msg('Voice'), items: voice });
  // Voice channels have their own chat.
  if (kind === Kind.Voice) out.push({ group: msg('Text'), items: text });
  return out;
}

const ALL = Object.values(P).reduce((a, b) => a + b, 0);

// Permissions exceed 32 bits, so combine with arithmetic instead of `|`.
export function hasBit(bits: number, p: number): boolean {
  return Math.floor(bits / p) % 2 === 1;
}

export function combine(values: number[]): number {
  let out = 0;
  for (const [, bit] of Object.entries(P)) if (values.some((v) => hasBit(v, bit))) out += bit;
  return out;
}

/** `bits` with `p` turned on or off. */
export function withBit(bits: number, p: number, on: boolean): number {
  return hasBit(bits, p) === on ? bits : on ? bits + p : bits - p;
}

/** (bits & ~deny) | allow, per known permission. */
function applyBits(bits: number, allow: number, deny: number): number {
  let out = 0;
  for (const bit of Object.values(P)) if (hasBit(allow, bit) || (hasBit(bits, bit) && !hasBit(deny, bit))) out += bit;
  return out;
}

export function guildPerms(guildId: string, userId = state.me?.id ?? ''): number {
  const g = state.guilds[guildId];
  if (!g) return 0;
  if (g.owner_id === userId) return ALL;
  const roles = state.roles[guildId] ?? {};
  const mine = state.members[guildId]?.[userId]?.roles ?? [];
  return combine([roles[guildId]?.permissions ?? 0, ...mine.map((r) => roles[r]?.permissions ?? 0)]);
}

/** Discord's overwrite algorithm (perms.rs apply_overwrites). */
export function applyOverwrites(
  base: number,
  guildId: string,
  userId: string,
  roles: string[],
  ows: Overwrite[],
): number {
  if (hasBit(base, P.ADMINISTRATOR)) return ALL;
  let p = base;
  const everyone = ows.find((o) => o.type === 0 && o.id === guildId);
  if (everyone) p = applyBits(p, everyone.allow, everyone.deny);
  const mine = ows.filter((o) => o.type === 0 && o.id !== guildId && roles.includes(o.id));
  p = applyBits(p, combine(mine.map((o) => o.allow)), combine(mine.map((o) => o.deny)));
  const member = ows.find((o) => o.type === 1 && o.id === userId);
  if (member) p = applyBits(p, member.allow, member.deny);
  return hasBit(p, P.VIEW_CHANNEL) ? p : 0;
}

/** The overwrites that apply in a channel: a thread's parent's, otherwise its own. */
export function overwritesOf(channelId: string): Overwrite[] {
  const c = state.channels[channelId];
  if (!c) return [];
  const src = c.kind === Kind.Thread && c.parent_id ? state.channels[c.parent_id] : c;
  return src?.permission_overwrites ?? [];
}

export function channelPerms(channelId: string, userId = state.me?.id ?? ''): number {
  const c = state.channels[channelId];
  const guildId = c?.guild_id;
  if (!guildId) return ALL;
  const base = guildPerms(guildId, userId);
  if (state.guilds[guildId]?.owner_id === userId || hasBit(base, P.ADMINISTRATOR)) return ALL;
  const roles = state.members[guildId]?.[userId]?.roles ?? [];
  return applyOverwrites(base, guildId, userId, roles, overwritesOf(channelId));
}

/** Whether you have `p` in the server, or in the channel when one is given. */
export function can(guildId: string | null | undefined, p: number, channelId?: string | null): boolean {
  if (!guildId) return true;
  const bits = channelId && state.channels[channelId]?.guild_id ? channelPerms(channelId) : guildPerms(guildId);
  return hasBit(bits, P.ADMINISTRATOR) || hasBit(bits, p);
}

/** Discord's lock: @everyone can't see the channel (a thread follows its channel). */
export function isPrivateChannel(channelId: string): boolean {
  const c = state.channels[channelId];
  const guildId = c?.guild_id;
  if (!guildId) return false;
  const base = state.roles[guildId]?.[guildId]?.permissions ?? 0;
  if (hasBit(base, P.ADMINISTRATOR)) return false;
  return !hasBit(applyOverwrites(base, guildId, '', [], overwritesOf(channelId)), P.VIEW_CHANNEL);
}

/** Whether a channel's overwrites are the same as its category's (Discord's "synced"). */
export function isSynced(channelId: string): boolean | null {
  const c = state.channels[channelId];
  const parent = c?.parent_id ? state.channels[c.parent_id] : undefined;
  if (!c || !parent || parent.kind !== Kind.Category) return null;
  return sameOverwrites(c.permission_overwrites ?? [], parent.permission_overwrites ?? []);
}

export function sameOverwrites(a: Overwrite[], b: Overwrite[]): boolean {
  const key = (l: Overwrite[]) =>
    JSON.stringify(
      [...l].sort((x, y) => x.type - y.type || (x.id < y.id ? -1 : 1)).map((o) => [o.id, o.type, o.allow, o.deny]),
    );
  return key(a) === key(b);
}

/** Highest role position the user holds (owner: Infinity). */
export function topPosition(guildId: string, userId = state.me?.id ?? ''): number {
  if (state.guilds[guildId]?.owner_id === userId) return Infinity;
  const roles = state.roles[guildId] ?? {};
  return Math.max(0, ...(state.members[guildId]?.[userId]?.roles ?? []).map((r) => roles[r]?.position ?? 0));
}
