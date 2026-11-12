// Slash commands, answered by Kass (the music bot, server/src/music.rs) and by bots driven from outside, like Steve
// (the Minecraft bot, server/src/steve.rs: his commands come from the panel that drives him, in READY and
// BOT_COMMANDS_UPDATE). Typing "/" in a server channel lists them.
import { msg } from './msg';
import { state } from './store';

export interface SlashCommand {
  name: string;
  /** Placeholder for the text after the command, if it takes any. */
  option?: string;
  /** The command also works without it (Enter runs it right away). */
  optional?: boolean;
  description: string;
  /** Commands of another bot (Steve): offered only where that bot is, and their texts aren't translated. */
  botId?: string;
}

export const COMMANDS: SlashCommand[] = [
  {
    name: 'play',
    option: msg('link or search'),
    description: msg('Play YouTube or Spotify (songs, albums, playlists) in your voice channel'),
  },
  { name: 'skip', description: msg('Skip the current song') },
  { name: 'pause', description: msg('Pause the music') },
  { name: 'resume', description: msg('Resume the music') },
  { name: 'queue', description: msg('Show what is playing and what is next') },
  {
    name: 'repeat',
    option: msg('song, queue or off'),
    optional: true,
    description: msg('Repeat the current song or the whole queue'),
  },
  { name: 'remove', option: msg('number or name'), description: msg('Remove a song from the queue') },
  { name: 'stop', description: msg('Stop the music and make Kass leave') },
  { name: 'snowball', option: msg('@someone'), description: msg('Throw a snowball at someone') },
];

/** Kass's, then those of the other bots in this server (none outside servers). */
export function commandsIn(guildId?: string | null): SlashCommand[] {
  if (!guildId) return COMMANDS;
  const others = state.botCommands
    .filter((c) => !!state.members[guildId]?.[c.bot_id])
    .map((c) => ({
      name: c.name,
      description: c.description,
      option: c.option ?? undefined,
      optional: c.optional,
      botId: c.bot_id,
    }));
  return [...COMMANDS, ...others];
}

/** "/play never gonna" -> the command and its text; anything else (including unknown commands) is a message. */
export function parseCommand(
  content: string,
  guildId?: string | null,
): { command: SlashCommand; query: string } | null {
  const m = content.match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
  const command = m && commandsIn(guildId).find((c) => c.name === m[1].toLowerCase());
  return command ? { command, query: (m[2] ?? '').trim() } : null;
}
