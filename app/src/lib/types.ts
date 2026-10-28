import { t } from './i18n';

export type Status = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline';

export interface User {
  id: string;
  username: string;
  display_name?: string | null;
  avatar?: string | null;
  banner?: string | null;
  accent_color?: number | null;
  bio: string;
  status?: Status;
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
  type: 'link' | 'image' | 'video';
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

export interface Message {
  id: string;
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
  nonce?: string;
  /** Client-only: optimistic message not yet confirmed by the server. */
  pending?: boolean;
  failed?: boolean;
}

export interface VoiceState {
  user_id: string;
  guild_id: string;
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

export interface Settings {
  muted_guilds?: string[];
  muted_channels?: string[];
  favorite_gifs?: string[];
  guild_folders?: GuildFolder[];
  collapsed_categories?: string[];
}

export const displayName = (u?: Pick<User, 'username' | 'display_name'> | null) => u?.display_name || u?.username || t('Unknown');
