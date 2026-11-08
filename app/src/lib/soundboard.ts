// Soundboard sounds: the default ones (files on the server) and each server's own, loaded when the picker
// or the server settings need them and kept current by GUILD_SOUNDBOARD_UPDATE.
import { createStore } from 'solid-js/store';
import { api } from './api';
import { patchSettings } from './actions';
import { t } from './i18n';
import { state } from './store';
import { toast } from './ui';

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

/** Starred sounds; kept in the synced settings so they follow you to every device. */
export const MAX_FAVORITE_SOUNDS = 100;
export const favoriteSounds = () => state.settings.favorite_sounds ?? [];
export const isFavoriteSound = (id: string) => favoriteSounds().includes(id);

export function toggleFavoriteSound(id: string) {
  const list = favoriteSounds();
  if (list.includes(id)) return void patchSettings({ favorite_sounds: list.filter((x) => x !== id) }).catch(() => {});
  if (list.length >= MAX_FAVORITE_SOUNDS)
    return toast(t('You have {n} favorite sounds — remove one to add another', { n: MAX_FAVORITE_SOUNDS }));
  void patchSettings({ favorite_sounds: [...list, id] }).catch(() => toast(t("Couldn't save your favorites")));
}
