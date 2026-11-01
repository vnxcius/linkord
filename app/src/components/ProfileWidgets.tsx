// Pieces of the full profile (Profile.tsx ProfileModal): links, your private note about someone, their profile song,
// and the widget cards beside it (Kass's top songs, the stats card). Server side: users.rs profile().
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { api, media } from '../lib/api';
import { brandOf } from '../lib/brand-icons';
import { plural, t } from '../lib/i18n';
import { openExternal } from '../lib/platform';
import { prefs } from '../lib/prefs';
import { setState, state } from '../lib/store';
import { attempt, setUi } from '../lib/ui';
import * as I from './Icons';
import { duration, num, ReactionEmoji } from './StatsPage';

export interface ProfileLink {
  label: string;
  url: string;
}

export interface ProfileSong {
  url: string;
  title: string;
  volume: number;
  duration: number;
  /** Only on your own: the original it was cut from, and the part that plays. */
  source?: string;
  trim_start?: number;
  trim_end?: number;
}

export interface TopSong {
  title: string;
  url: string;
  uploader?: string | null;
  thumbnail?: string | null;
  plays: number;
}

export interface PublicStats {
  voice_seconds: number;
  messages: number;
  active_days: number;
  counters: Record<string, number>;
  top_emoji: { emoji: string; count: number }[];
  top_game?: { name: string; icon?: string | null; seconds: number } | null;
}

/** "github.com" for https://www.github.com/someone: what a link without a name shows. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** "instagram.com/someone": the address without its scheme, www or trailing slash, for under a link's name. */
export function shortLink(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    const s = u.hostname.replace(/^www\./, '') + (path === '/' ? '' : path);
    return s.length > 42 ? `${s.slice(0, 41)}…` : s;
  } catch {
    return url;
  }
}

/** A link's name when it has none of its own: the site's ("Instagram"), else its address. */
export function linkName(l: ProfileLink): string {
  return l.label || brandOf(l.url)?.name || linkHost(l.url);
}

/** Links as chips side by side (icon and name), wrapping; the address shows on hover. */
export function ProfileLinks(p: { links: ProfileLink[] }) {
  return (
    <div class="profile-links">
      <For each={p.links}>
        {(l) => (
          <button class="profile-link" data-tip={shortLink(l.url)} onClick={() => void openExternal(l.url)}>
            <I.SiteIcon url={l.url} size={17} />
            <span>{linkName(l)}</span>
          </button>
        )}
      </For>
    </div>
  );
}

const MAX_NOTE = 256;

/** Your note about someone: only you see it. Saved when you click away. */
export function NoteField(p: { userId: string; initial: string }) {
  const saved = () => state.notes[p.userId] ?? p.initial;
  const [text, setText] = createSignal(saved());
  let el!: HTMLTextAreaElement;
  // Another session (or the profile loading) changed it while you weren't typing.
  createEffect(() => {
    const s = saved();
    if (document.activeElement !== el) setText(s);
  });
  const fit = () => {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  const save = () => {
    const note = text().trim();
    if (note === saved()) return;
    void attempt(async () => {
      const r = await api<{ note: string }>('PUT', `/users/${p.userId}/note`, { note });
      setState('notes', p.userId, r.note);
    });
  };
  onMount(() => queueMicrotask(fit));
  return (
    <label class="note-field">
      <span class="label">
        {t('Note')} <em>{t('only visible to you')}</em>
      </span>
      <textarea
        ref={el}
        rows={1}
        maxLength={MAX_NOTE}
        value={text()}
        placeholder={t('Click to add a note')}
        onInput={(e) => (setText(e.currentTarget.value), fit())}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            el.blur();
          }
          if (e.key === 'Escape') e.stopPropagation();
        }}
      />
    </label>
  );
}

/** How loud profile songs play next to the person's own volume: a profile is no place for full blast. */
const SONG_LEVEL = 0.45;

/**
 * Someone's profile song: a small player on their profile. It waits for a click unless you turned on autoplay
 * (Settings -> Profile, prefs.profileSongAutoplay), loops quietly, and stops when the profile closes.
 */
export function SongPlayer(p: { song: ProfileSong; autoplay?: boolean }) {
  const audio = new Audio();
  audio.preload = 'auto';
  audio.loop = true;
  const [playing, setPlaying] = createSignal(false);
  const [at, setAt] = createSignal(0);
  createEffect(() => {
    audio.src = media(p.song.url) ?? '';
    audio.volume = Math.min(1, Math.max(0, p.song.volume * SONG_LEVEL));
  });
  audio.onplay = () => setPlaying(true);
  audio.onpause = () => setPlaying(false);
  audio.ontimeupdate = () => setAt(audio.currentTime);
  const toggle = () => (audio.paused ? void audio.play().catch(() => {}) : audio.pause());
  onMount(() => {
    if (p.autoplay ?? prefs.profileSongAutoplay) void audio.play().catch(() => {});
  });
  onCleanup(() => {
    audio.pause();
    audio.src = '';
  });
  const progress = () => (p.song.duration > 0 ? Math.min(1, at() / p.song.duration) : 0);
  return (
    <button
      class="song-player"
      classList={{ playing: playing() }}
      onClick={toggle}
      aria-label={playing() ? t('Pause profile song') : t('Play profile song')}
      data-tip={playing() ? t('Pause') : t('Play their profile song')}
    >
      <span class="song-player-btn">
        <Show when={playing()} fallback={<I.Play size={14} />}>
          <I.Pause size={14} />
        </Show>
      </span>
      <span class="song-player-text">
        <span class="song-player-kicker">{t('Profile song')}</span>
        <span class="song-player-title">{p.song.title || t('Untitled')}</span>
      </span>
      <span class="song-player-bars" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span class="song-player-progress" style={{ width: `${progress() * 100}%` }} />
    </button>
  );
}

/** The note under a widget only you can see right now. */
function HiddenHint(p: { shown?: boolean }) {
  return (
    <Show when={p.shown === false}>
      <button class="widget-hidden" onClick={() => setUi('modal', { type: 'settings', tab: 'profile' })}>
        <I.EyeOff size={14} /> {t('Only you can see this. Show it in Settings → Profile.')}
      </button>
    </Show>
  );
}

/** Kass's most played songs for someone: what they queue the most (a tab of the profile's side card). */
export function TopSongsCard(p: { songs: TopSong[]; isMe: boolean; shown?: boolean }) {
  return (
    <section class="widget-card" aria-label={t('Top songs')}>
      <header class="widget-head">
        <span class="label">{t('Kass · most played')}</span>
        <h3>{t('Top songs')}</h3>
      </header>
      <Show
        when={p.songs.length}
        fallback={
          <p class="widget-empty static">
            <I.Music size={22} />
            {t('Songs you play with Kass (/play) show up here.')}
          </p>
        }
      >
        <ol class="top-songs">
          <For each={p.songs}>
            {(s, i) => (
              <li>
                <button class="top-song" onClick={() => void openExternal(s.url)} data-tip={s.url}>
                  <em>{String(i() + 1).padStart(2, '0')}</em>
                  <span class="top-song-art">
                    <Show when={s.thumbnail} fallback={<I.Music size={16} />}>
                      <img src={s.thumbnail!} alt="" loading="lazy" referrerpolicy="no-referrer" />
                    </Show>
                  </span>
                  <span class="top-song-text">
                    <strong>{s.title}</strong>
                    <Show when={s.uploader}>
                      <small>{s.uploader}</small>
                    </Show>
                  </span>
                  <span class="top-song-plays">{plural(s.plays, '{n} play', '{n} plays')}</span>
                </button>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={p.isMe}>
        <HiddenHint shown={p.shown} />
      </Show>
    </section>
  );
}

/** A few numbers from Settings -> Stats, when the person shows them on their profile (a side card tab). */
export function StatsCard(p: { stats: PublicStats; isMe: boolean; shown?: boolean }) {
  const c = (k: string) => p.stats.counters?.[k] ?? 0;
  const tiles = () =>
    [
      [t('Time in voice'), duration(p.stats.voice_seconds)],
      [t('Messages sent'), num(p.stats.messages)],
      [t('Days active'), num(p.stats.active_days)],
      [t('Longest call'), duration(c('longest_voice_seconds'))],
      [t('Time streaming'), duration(c('stream_seconds'))],
      [t('Sounds played'), num(c('sounds_played'))],
      [t('Songs queued for Kass'), num(c('songs_queued'))],
      [t('Time playing games'), duration(c('game_seconds'))],
    ] as const;
  return (
    <section class="widget-card" aria-label={t('Stats')}>
      <header class="widget-head">
        <span class="label">{t('By the numbers')}</span>
        <h3>{t('Stats')}</h3>
      </header>
      <div class="profile-stats">
        <For each={tiles()}>
          {([label, value]) => (
            <div>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          )}
        </For>
      </div>
      <Show when={p.stats.top_game}>
        {(g) => (
          <div class="profile-stats-row">
            <span class="label">{t('Most played game')}</span>
            <span class="grow">
              <strong>{g().name}</strong>
            </span>
            <span class="mono">{duration(g().seconds)}</span>
          </div>
        )}
      </Show>
      <Show when={p.stats.top_emoji?.length}>
        <div class="profile-stats-row">
          <span class="label">{t('Favourite reactions')}</span>
          <span class="grow profile-stats-emoji">
            <For each={p.stats.top_emoji}>{(e) => <ReactionEmoji emoji={e.emoji} />}</For>
          </span>
        </div>
      </Show>
      <Show when={p.isMe}>
        <HiddenHint shown={p.shown} />
      </Show>
    </section>
  );
}
