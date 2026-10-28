// Mirrors server/src/perms.rs. The server enforces these; the client only uses them to hide controls.
import { msg } from './msg';
import { state } from './store';

export const P = {
  CREATE_INVITE: 1 << 0,
  KICK_MEMBERS: 1 << 1,
  ADMINISTRATOR: 1 << 3,
  MANAGE_CHANNELS: 1 << 4,
  MANAGE_GUILD: 1 << 5,
  ADD_REACTIONS: 1 << 6,
  SEND_MESSAGES: 1 << 11,
  MANAGE_MESSAGES: 1 << 13,
  ATTACH_FILES: 1 << 15,
  MENTION_EVERYONE: 1 << 17,
  CONNECT: 1 << 20,
  SPEAK: 1 << 21,
  CHANGE_NICKNAME: 1 << 26,
  MANAGE_NICKNAMES: 1 << 27,
  MANAGE_ROLES: 1 << 28,
  MANAGE_EMOJIS: 2 ** 30,
  MANAGE_THREADS: 2 ** 34,
  CREATE_THREADS: 2 ** 35,
} as const;

/** Permission names shown in role settings, grouped like Discord. */
export const PERM_INFO: { group: string; items: [keyof typeof P, string, string][] }[] = [
  {
    group: msg('General'),
    items: [
      ['ADMINISTRATOR', msg('Administrator'), msg('Every permission, and can reorder roles. Dangerous.')],
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
      ['SPEAK', msg('Speak'), msg('Talk and share video in voice channels.')],
    ],
  },
];

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

export function guildPerms(guildId: string, userId = state.me?.id ?? ''): number {
  const g = state.guilds[guildId];
  if (!g) return 0;
  if (g.owner_id === userId) return ALL;
  const roles = state.roles[guildId] ?? {};
  const mine = state.members[guildId]?.[userId]?.roles ?? [];
  return combine([roles[guildId]?.permissions ?? 0, ...mine.map((r) => roles[r]?.permissions ?? 0)]);
}

export function can(guildId: string | null | undefined, p: number): boolean {
  if (!guildId) return true;
  const bits = guildPerms(guildId);
  return hasBit(bits, P.ADMINISTRATOR) || hasBit(bits, p);
}

/** Highest role position the user holds (owner: Infinity). */
export function topPosition(guildId: string, userId = state.me?.id ?? ''): number {
  if (state.guilds[guildId]?.owner_id === userId) return Infinity;
  const roles = state.roles[guildId] ?? {};
  return Math.max(0, ...(state.members[guildId]?.[userId]?.roles ?? []).map((r) => roles[r]?.position ?? 0));
}
