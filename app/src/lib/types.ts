import { t } from './i18n';

export type Status = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';

export interface User {
  id: string;
  username: string;
  display_name?: string | null;
  avatar?: string | null;
  banner?: string | null;
  nameplate?: string | null;
  accent_color?: number | null;
  bio: string;
  status?: Status;
  /** Bot account (Kass, the music bot): BOT tag, answers slash commands. */
  bot?: boolean;
  /** Only on your own user: you signed up with a taken username and must pick another. */
  needs_username?: boolean;
}

export const enum Kind {
  Text = 0,
  Dm = 1,
  Voice = 2,
  GroupDm = 3,
  Category = 4,
  Thread = 11,
}

export const isPrivate = (k: Kind) => k === Kind.Dm || k === Kind.GroupDm;

export interface Channel {
  id: string;
  guild_id?: string | null;
  kind: Kind;
  name: string;
  topic: string;
  position: number;
  parent_id?: string | null;
  last_message_id?: string | null;
  owner_id?: string | null;
  thread_message_id?: string | null;
  archived?: boolean;
  message_count?: number;
  recipients?: User[];
}

export interface GuildInfo {
  id: string;
  name: string;
  icon?: string | null;
  owner_id: string;
  /** Where "joined the server" messages go (none = the first text channel), and whether they're posted. */
  system_channel_id?: string | null;
  join_messages?: boolean;
  /** Picture at the top of the channel list, behind the server name. */
  banner?: string | null;
  /** Voice channel people are moved to after `afk_timeout` seconds without talking. */
  afk_channel_id?: string | null;
  afk_timeout?: number;
}

export interface Role {
  id: string;
  guild_id: string;
  name: string;
  color?: number | null;
  permissions: number;
  position: number;
  hoist: boolean;
  mentionable: boolean;
}

export interface Emoji {
  id: string;
  guild_id: string;
  name: string;
  animated: boolean;
}

export interface Member {
  user: User;
  nickname?: string | null;
  joined_at: string;
  roles: string[];
}

export interface Guild extends GuildInfo {
  channels: Channel[];
  members: Member[];
  roles: Role[];
  emojis: Emoji[];
}

export interface Attachment {
  id: string;
  filename: string;
  url: string;
  size: number;
  content_type: string;
  /** Voice messages only. */
  duration_secs?: number;
  waveform?: string;
}

export interface Embed {
  /** rich = a card a bot made (no link preview player). */
  type: 'link' | 'image' | 'video' | 'rich';
  url: string;
  title?: string | null;
  description?: string | null;
  site_name?: string | null;
  image?: string | null;
  large_image?: boolean;
  color?: number | null;
  author?: string | null;
  /** Where a short link (youtu.be, vm.tiktok.com...) redirected to. */
  resolved_url?: string | null;
}

export interface Reaction {
  emoji: string;
  users: string[];
}

export interface Forwarded {
  message_id: string;
  channel_id: string;
  guild_id?: string | null;
  content: string;
  attachments: Attachment[];
  embeds: Embed[];
  created_at: string;
  edited_at?: string | null;
}

export interface Message {
  id: string;
  /** 0 (or missing) = a normal message; 6 = "pinned a message" (reply_to = the pin); 7 = "joined the server". */
  type?: number;
  channel_id: string;
  author: User;
  content: string;
  reply_to?: string | null;
  referenced_message?: { id: string; author: User; content: string } | null;
  attachments: Attachment[];
  embeds: Embed[];
  reactions: Reaction[];
  mention_everyone?: boolean;
  pinned?: boolean;
  thread_id?: string | null;
  edited_at?: string | null;
  created_at: string;
  /** A forward: the original as it was when it was forwarded, and where it came from. */
  forwarded?: Forwarded | null;
  /** A bot's answer to a slash command: who used which one. */
  interaction?: { name: string; user: User } | null;
  nonce?: string;
  /** Client-only: optimistic message not yet confirmed by the server. */
  pending?: boolean;
  failed?: boolean;
}

export interface VoiceState {
  user_id: string;
  /** Null for calls in DMs and group DMs. */
  guild_id: string | null;
  channel_id: string | null;
  self_mute: boolean;
  self_deaf: boolean;
  /** Sharing their screen (LIVE). */
  self_stream?: boolean;
  self_video?: boolean;
  /** Streamers this user is watching. */
  watching?: string[];
  /** When the call in this channel started (unix ms), the same for everyone in it. */
  call_started_at?: number | null;
}

export const enum Rel {
  Friend = 1,
  Blocked = 2,
  Incoming = 3,
  Outgoing = 4,
}

/** What someone is doing, shown under their name and on their profile (Discord's activities). */
export interface Activity {
  /** 0 = "Playing" (a game), 2 = "Listening to" (Spotify), 4 = custom status (`state` = its text). */
  type: number;
  name: string;
  /** Games: Discord application id and icon URL (detected games only). */
  application_id?: string;
  icon?: string;
  /** Spotify: song title; `state`: artists joined with "; ". */
  details?: string;
  state?: string;
  artists?: { name: string; url?: string }[];
  album?: string;
  album_url?: string;
  image?: string;
  url?: string;
  sync_id?: string;
  /** Unix ms. */
  timestamps?: { start?: number; end?: number };
  /** Custom status: a Unicode emoji (name only) or a server emoji, and when it clears itself (unix ms). */
  emoji?: StatusEmoji;
  expires_at?: number;
}

export interface StatusEmoji {
  id?: string;
  name: string;
  animated?: boolean;
}

/** A server list entry: a lone server (no id) or a folder of servers, like Discord's guild_folders. */
export interface GuildFolder {
  id?: string;
  name?: string;
  color?: number | null;
  guild_ids: string[];
}

/** How much a server or channel notifies you, like Discord's notification settings. */
export type NotifyLevel = 'all' | 'mentions' | 'none';

export interface Settings {
  muted_guilds?: string[];
  muted_channels?: string[];
  /** Per server; servers without an entry notify for all messages. */
  guild_notifications?: Record<string, NotifyLevel>;
  /** Per channel or category, overriding the server's level. */
  channel_notifications?: Record<string, NotifyLevel>;
  guild_folders?: GuildFolder[];
  collapsed_categories?: string[];
}

export const displayName = (u?: Pick<User, 'username' | 'display_name'> | null) =>
  u?.display_name || u?.username || t('Unknown');
