// Activities, like Discord's: "Playing <game>", "Listening to Spotify" and the custom status. The line under
// someone's name in lists (custom status, else a game, else Spotify), the icon at the end of member rows, and
// the cards on profiles.
import { createSignal, For, Show, type JSX } from 'solid-js';
import { setUi } from '../lib/ui';
import { emojiUrl } from '../lib/api';
import { msg, t } from '../lib/i18n';
import { art, askToJoin, type LeagueActivity, leagueMe, phaseName, queueName, splashOf } from '../lib/league';
import { isTauri, openExternal } from '../lib/platform';
import { customStatusOf, gameOf, spotifyOf, state } from '../lib/store';
import type { Activity, StatusEmoji } from '../lib/types';
import * as I from './Icons';
import { formatDuration } from './VideoPlayer';

// One shared clock for every progress bar on screen.
const [now, setNow] = createSignal(Date.now());
export { now as clock };
setInterval(() => setNow(Date.now()), 1000);

/** Spotify's mark (shown with Spotify activities and the Spotify connection, as Discord does). */
export function SpotifyIcon(p: { size?: number; class?: string }) {
  return (
    <svg
      class={`spotify-icon ${p.class ?? ''}`}
      width={p.size ?? 16}
      height={p.size ?? 16}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
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
    <Show
      when={p.emoji.id}
      fallback={
        <span class="status-emoji" style={{ 'font-size': size() }}>
          {p.emoji.name}
        </span>
      }
    >
      {(id) => (
        <img
          class="status-emoji custom"
          src={emojiUrl(id(), p.emoji.animated)}
          alt={`:${p.emoji.name}:`}
          style={{ width: size(), height: size() }}
        />
      )}
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
export const elapsedSince = (start: number | undefined, at: number) =>
  formatDuration(Math.max(0, at - (start ?? at)) / 1000);

/** The steps of a League match, for the card's progress strip (TFT and ARAM go through the same ones). */
const LEAGUE_STEPS = [
  { phase: 'lobby', label: msg('Lobby') },
  { phase: 'queue', label: msg('Queue') },
  { phase: 'champ_select', label: msg('Pick') },
  { phase: 'in_game', label: msg('Match') },
] as const;

/** How long League has been in this phase. */
const leagueTimer = (l: LeagueActivity, at: number) => elapsedSince(l.since, at);

/** Opens the game modal (Game.tsx) for this card's game, unless the card is already in it. */
function opener(p: { activity: Activity; userId?: string; inModal?: boolean }) {
  return () =>
    p.userId && !p.inModal
      ? () => {
          // From the profile popout: the popout gives way to the modal.
          setUi('profile', null);
          setUi('modal', { type: 'game', userId: p.userId!, activity: p.activity });
        }
      : undefined;
}

/** The game's icon or name, as a button that opens the game modal (plain when there's nothing to open). */
function GameLink(p: { open: () => (() => void) | undefined; title?: boolean; class?: string; children: JSX.Element }) {
  return (
    <Show when={p.open()} fallback={<span class={p.class}>{p.children}</span>}>
      {(run) => (
        <button
          class={`game-link ${p.class ?? ''}`}
          classList={{ 'game-link-title': p.title }}
          data-tip={t('View game')}
          onClick={() => run()()}
        >
          {p.children}
        </button>
      )}
    </Show>
  );
}

/** "Playing a game": icon, name and time played, for profiles and the Active Now column. League and TFT get their
 *  own card (LeagueGameCard). */
export function GameCard(p: { activity: Activity; userId?: string; compact?: boolean; inModal?: boolean }) {
  return (
    <Show
      when={p.activity.league}
      fallback={<PlainGameCard activity={p.activity} userId={p.userId} compact={p.compact} inModal={p.inModal} />}
    >
      {(l) => (
        <LeagueGameCard activity={p.activity} league={l()} userId={p.userId} compact={p.compact} inModal={p.inModal} />
      )}
    </Show>
  );
}

function PlainGameCard(p: { activity: Activity; userId?: string; compact?: boolean; inModal?: boolean }) {
  const open = opener(p);
  return (
    <div class="game-card" classList={{ compact: p.compact }}>
      <Show when={!p.compact}>
        <div class="activity-head">
          <span>{t('Playing a game')}</span>
        </div>
      </Show>
      <div class="game-body">
        <GameLink open={open}>
          <GameIcon src={p.activity.icon} size={p.compact ? 40 : 64} />
        </GameLink>
        <div class="game-text">
          <GameLink open={open} title>
            <strong title={p.activity.name}>{p.activity.name}</strong>
          </GameLink>
          <span class="game-elapsed">
            <I.Gamepad size={14} /> {t('{time} elapsed', { time: elapsedSince(p.activity.timestamps?.start, now()) })}
          </span>
        </div>
      </div>
    </div>
  );
}

/** League of Legends / TFT, like Discord's rich presence: the champion's splash behind the card once one is picked,
 *  the phase as a pill with its own timer, queue and champion, the party as seats and where the match is at. In
 *  someone else's lobby with room, "Ask to join" (their League client invites you: lib/league.ts askToJoin). */
function LeagueGameCard(p: {
  activity: Activity;
  league: LeagueActivity;
  userId?: string;
  compact?: boolean;
  inModal?: boolean;
}) {
  const l = () => p.league;
  const open = opener(p);
  const [splashOk, setSplashOk] = createSignal(true);
  const splash = () => (l().champion && splashOk() ? splashOf(l().champion!.id) : undefined);
  const step = () => LEAGUE_STEPS.findIndex((s) => s.phase === l().phase);
  const queue = () => queueName(l().queue_id, l().queue, l().mode);
  const party = () => (l().party && l().party!.max > 1 ? l().party : undefined);
  const live = () => l().phase === 'queue' || l().phase === 'in_game';
  const joinable = () =>
    isTauri &&
    !!p.userId &&
    p.userId !== state.me?.id &&
    l().phase === 'lobby' &&
    (!party() || party()!.size < party()!.max);
  const [asked, setAsked] = createSignal(false);
  const ask = async () => {
    if (p.userId && (await askToJoin(p.userId))) {
      setAsked(true);
      setTimeout(() => setAsked(false), 15_000);
    }
  };
  return (
    <div
      class="game-card league-activity"
      classList={{ compact: p.compact, 'has-splash': !!splash() }}
      data-phase={l().phase}
    >
      <Show when={splash()}>
        {(src) => (
          <div class="league-splash" aria-hidden="true">
            <img src={src()} alt="" onError={() => setSplashOk(false)} />
          </div>
        )}
      </Show>
      <Show when={!p.compact}>
        <div class="activity-head">
          <span>{t('Playing a game')}</span>
          <span class="league-phase" classList={{ live: live() }}>
            <i />
            {phaseName(l().phase)}
          </span>
        </div>
      </Show>
      <div class="game-body">
        <GameLink open={open} class="activity-art">
          <GameIcon src={p.activity.icon} size={p.compact ? 44 : 64} />
          <Show when={l().champion}>
            {(c) => <img class="game-badge" src={art(c().icon)} alt="" data-tip={c().name} />}
          </Show>
        </GameLink>
        <div class="game-text">
          <GameLink open={open} title>
            <strong title={p.activity.name}>{p.activity.name}</strong>
          </GameLink>
          <Show when={queue()}>{(q) => <span class="game-detail">{q()}</span>}</Show>
          <Show when={l().champion}>
            {(c) => (
              <span class="game-detail league-champion">{t('Playing as {champion}', { champion: c().name })}</span>
            )}
          </Show>
          <Show when={p.compact}>
            <span class="game-detail">{phaseName(l().phase)}</span>
          </Show>
          <span class="game-elapsed">
            <I.Gamepad size={14} />{' '}
            {l().since
              ? leagueTimer(l(), now())
              : t('{time} elapsed', { time: elapsedSince(p.activity.timestamps?.start, now()) })}
          </span>
        </div>
      </div>
      <Show when={!p.compact && (step() >= 0 || party())}>
        <div class="league-foot">
          <Show when={step() >= 0}>
            <ol class="league-steps" aria-label={phaseName(l().phase)}>
              <For each={LEAGUE_STEPS}>
                {(s, i) => (
                  <li classList={{ done: i() < step(), current: i() === step() }}>
                    <span>{t(s.label)}</span>
                  </li>
                )}
              </For>
            </ol>
          </Show>
          <Show when={party()}>
            {(pt) => (
              <span class="league-party" data-tip={t('{size} of {max}', { size: pt().size, max: pt().max })}>
                <For each={Array.from({ length: pt().max }, (_, i) => i < pt().size)}>
                  {(filled) => <i classList={{ filled }} />}
                </For>
                <small>
                  {pt().size}/{pt().max}
                </small>
              </span>
            )}
          </Show>
        </div>
      </Show>
      <Show when={joinable()}>
        <button
          class="btn league-join"
          classList={{ 'small-btn': p.compact }}
          disabled={asked() || !leagueMe()}
          data-tip={leagueMe() ? undefined : t('Open League of Legends to join')}
          onClick={() => void ask()}
        >
          <I.UserPlus size={15} /> {asked() ? t('Asked to join') : t('Ask to join')}
        </button>
      </Show>
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
  const artists = () =>
    a().artists ??
    (a().state
      ? a()
          .state!.split('; ')
          .map((name) => ({ name, url: undefined as string | undefined }))
      : []);
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
