// Slash commands, answered by Kass (the music bot, server/src/music.rs). Typing "/" in a server channel lists them.
import { msg } from './msg';

export interface SlashCommand {
  name: string;
  /** Placeholder for the text after the command, if it takes any. */
  option?: string;
  /** The command also works without it (Enter runs it right away). */
  optional?: boolean;
  description: string;
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
];

/** "/play never gonna" -> the command and its text; anything else (including unknown commands) is a message. */
export function parseCommand(content: string): { command: SlashCommand; query: string } | null {
  const m = content.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
  const command = m && COMMANDS.find((c) => c.name === m[1].toLowerCase());
  return command ? { command, query: (m[2] ?? '').trim() } : null;
}
