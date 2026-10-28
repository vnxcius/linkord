// Activities, like Discord's: "Playing <game>", "Listening to Spotify" and the custom status. The line under
// someone's name in lists (custom status, else a game, else Spotify), the icon at the end of member rows, and
// the cards on profiles.
import { createSignal, For, Show } from 'solid-js';
import { emojiUrl } from '../lib/api';
import { t } from '../lib/i18n';
import { openExternal } from '../lib/platform';
import { customStatusOf, gameOf, spotifyOf } from '../lib/store';
import type { Activity, StatusEmoji } from '../lib/types';
import * as I from './Icons';
import { formatDuration } from './VideoPlayer';

// One shared clock for every progress bar on screen.
const [now, setNow] = createSignal(Date.now());
setInterval(() => setNow(Date.now()), 1000);

/** Spotify's mark (shown with Spotify activities and the Spotify connection, as Discord does). */
export function SpotifyIcon(p: { size?: number; class?: string }) {
  return (
    <svg class={`spotify-icon ${p.class ?? ''}`} width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#1ed760" />
      <path
        fill="none"
        stroke="#000"
        stroke-linecap="round"
        d="M6.2 9.2c3.9-1.2 8.4-.9 11.7 1.1M6.9 12.5c3.2-.9 6.8-.6 9.6 1M7.5 15.6c2.5-.7 5.2-.5 7.4.8"
        stroke-width="1.6"
      />
    </svg>
  );
}

/** A game's icon from Discord's CDN, or a controller for games without one (added by hand). */
export function GameIcon(p: { src?: string; size: number; class?: string }) {
  const [failed, setFailed] = createSignal(false);
  return (
    <span class={`game-icon ${p.class ?? ''}`} style={{ width: `${p.size}px`, height: `${p.size}px` }}>
      <Show when={p.src && !failed()} fallback={<I.Gamepad size={Math.round(p.size * 0.6)} />}>
        <img src={p.src} alt="" onError={() => setFailed(true)} />
      </Show>
    </span>
  );
}

/** A custom status's emoji: a server emoji image or a Unicode emoji (Twemoji). */
export function StatusEmojiView(p: { emoji: StatusEmoji; size?: number }) {
  const size = () => `${p.size ?? 14}px`;
  return (
    <Show when={p.emoji.id} fallback={<span class="status-emoji" style={{ 'font-size': size() }}>{p.emoji.name}</span>}>
      {(id) => <img class="status-emoji custom" src={emojiUrl(id(), p.emoji.animated)} alt={`:${p.emoji.name}:`} style={{ width: size(), height: size() }} />}
    </Show>
  );
}

/** Emoji and text of a custom status, on one line. */
export function CustomStatusView(p: { status: Activity; size?: number }) {
  return (
    <span class="custom-status" title={p.status.state}>
      <Show when={p.status.emoji}>{(e) => <StatusEmojiView emoji={e()} size={p.size} />}</Show>
      <Show when={p.status.state}>
        <span class="custom-status-text">{p.status.state}</span>
      </Show>
    </span>
  );
}

/** The custom status, else "Playing <game>", else "Listening to Spotify", under a name in the member list and DMs. */
export function ActivityLine(p: { userId: string }) {
  return (
    <Show
      when={customStatusOf(p.userId)}
      fallback={
        <Show
          when={gameOf(p.userId)}
          fallback={
            <Show when={spotifyOf(p.userId)}>
              <span class="activity-line">
                {t('Listening to')} <strong>Spotify</strong>
              </span>
            </Show>
          }
        >
          {(g) => (
            <span class="activity-line">
              {t('Playing')} <strong>{g().name}</strong>
            </span>
          )}
        </Show>
      }
    >
      {(s) => (
        <span class="activity-line">
          <CustomStatusView status={s()} />
        </span>
      )}
    </Show>
  );
}

/** The custom status as a speech bubble next to the avatar on profiles, like Discord. */
export function StatusBubble(p: { userId: string; big?: boolean }) {
  return (
    <Show when={customStatusOf(p.userId)}>
      {(s) => (
        <div class="status-bubble" classList={{ big: p.big }}>
          <CustomStatusView status={s()} size={p.big ? 18 : 16} />
        </div>
      )}
    </Show>
  );
}

/** The game's icon (or Spotify's mark) at the end of a member list row, like Discord. */
export function ActivityBadge(p: { userId: string }) {
  return (
    <Show
      when={gameOf(p.userId)}
      fallback={
        <Show when={spotifyOf(p.userId)}>
          <span class="activity-badge" title={spotifyOf(p.userId)?.details}>
            <SpotifyIcon size={14} />
          </span>
        </Show>
      }
    >
      {(g) => (
        <span class="activity-badge" title={g().name}>
          <GameIcon src={g().icon} size={18} />
        </span>
      )}
    </Show>
  );
}

/** h:mm:ss (or m:ss) since `start`. */
export const elapsedSince = (start: number | undefined, at: number) => formatDuration(Math.max(0, at - (start ?? at)) / 1000);

/** "Playing a game": icon, name and time played, for profiles and the Active Now column. */
export function GameCard(p: { activity: Activity; compact?: boolean }) {
  return (
    <div class="game-card" classList={{ compact: p.compact }}>
      <Show when={!p.compact}>
        <div class="activity-head">
          <span>{t('Playing a game')}</span>
        </div>
      </Show>
      <div class="game-body">
        <GameIcon src={p.activity.icon} size={p.compact ? 40 : 64} />
        <div class="game-text">
          <strong title={p.activity.name}>{p.activity.name}</strong>
          <span class="game-elapsed">
            <I.Gamepad size={14} /> {t('{time} elapsed', { time: elapsedSince(p.activity.timestamps?.start, now()) })}
          </span>
        </div>
      </div>
    </div>
  );
}

const open = (url?: string) => url && void openExternal(url);

/** Song, artists, album art and progress, for profiles and the Active Now column. */
export function SpotifyCard(p: { activity: Activity; compact?: boolean }) {
  const a = () => p.activity;
  const start = () => a().timestamps?.start ?? now();
  const end = () => a().timestamps?.end ?? now();
  const elapsed = () => Math.max(0, Math.min(end() - start(), now() - start()));
  const total = () => Math.max(1, end() - start());
  const artists = () => a().artists ?? (a().state ? a().state!.split('; ').map((name) => ({ name, url: undefined as string | undefined })) : []);
  return (
    <div class="spotify-card" classList={{ compact: p.compact }}>
      <Show when={!p.compact}>
        <div class="activity-head">
          <span>{t('Listening to Spotify')}</span>
          <SpotifyIcon size={18} />
        </div>
      </Show>
      <div class="spotify-body">
        <button class="spotify-cover" onClick={() => open(a().album_url ?? a().url)} title={a().album}>
          <Show when={a().image} fallback={<SpotifyIcon size={28} />}>
            <img src={a().image} alt="" />
          </Show>
          <Show when={p.compact}>
            <span class="cover-badge">
              <SpotifyIcon size={14} />
            </span>
          </Show>
        </button>
        <div class="spotify-text">
          <button class="spotify-title" onClick={() => open(a().url)} title={a().details}>
            {a().details}
          </button>
          <div class="spotify-sub">
            {t('by')}{' '}
            <For each={artists()}>
              {(artist, i) => (
                <>
                  {i() > 0 ? ', ' : ''}
                  <button class="spotify-link" onClick={() => open(artist.url)}>
                    {artist.name}
                  </button>
                </>
              )}
            </For>
          </div>
          <Show when={a().album && !p.compact}>
            <div class="spotify-sub">
              {t('on')}{' '}
              <button class="spotify-link" onClick={() => open(a().album_url)}>
                {a().album}
              </button>
            </div>
          </Show>
        </div>
      </div>
      <div class="spotify-progress">
        <div class="spotify-bar">
          <div style={{ width: `${(elapsed() / total()) * 100}%` }} />
        </div>
        <div class="spotify-times">
          <span>{formatDuration(elapsed() / 1000)}</span>
          <span>{formatDuration(total() / 1000)}</span>
        </div>
      </div>
      <Show when={!p.compact}>
        <button class="btn spotify-play" onClick={() => open(a().url)}>
          <SpotifyIcon size={16} /> {t('Play on Spotify')}
        </button>
      </Show>
    </div>
  );
}
