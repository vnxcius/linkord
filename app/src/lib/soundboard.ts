// Soundboard sounds: the default ones (files on the server) and each server's own, loaded when the picker
// or the server settings need them and kept current by GUILD_SOUNDBOARD_UPDATE.
import { createStore } from 'solid-js/store';
import { api } from './api';

export interface Sound {
  /** A snowflake for server sounds, "default:<file>" for default ones. */
  id: string;
  guild_id?: string | null;
  name: string;
  emoji?: string | null;
  /** 0-1. */
  volume: number;
  url: string;
  /** Server sounds: the uploaded original and the part of it that plays (seconds). */
  source?: string | null;
  trim_start: number;
  trim_end?: number | null;
}

export const [sounds, setSounds] = createStore({
  defaults: null as Sound[] | null,
  guilds: {} as Record<string, Sound[]>,
});

const loading = new Set<string>();

export function loadDefaultSounds() {
  if (sounds.defaults || loading.has('default')) return;
  loading.add('default');
  void api<Sound[]>('GET', '/soundboard/default')
    .then((s) => setSounds('defaults', s))
    .finally(() => loading.delete('default'));
}

export function loadGuildSounds(guildId: string, force = false) {
  if ((!force && sounds.guilds[guildId]) || loading.has(guildId)) return;
  loading.add(guildId);
  void api<Sound[]>('GET', `/guilds/${guildId}/soundboard`)
    .then((s) => setSounds('guilds', guildId, s))
    .catch(() => {})
    .finally(() => loading.delete(guildId));
}
