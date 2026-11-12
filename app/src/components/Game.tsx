// The game modal (owner, 2026-11-12): clicking the game on someone's "Playing" card (its icon or name) opens the game
// itself, with their side of it: what they're doing in it now (League: lobby, queue, champion...), how long they've
// played it and when, where it ranks among their games and favorites, their League widget for League / TFT, then
// what the game is (Steam or Wikipedia, like the favorites card: FavoriteGames.tsx GameAbout) and who else is in it.
import { createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { api } from '../lib/api';
import { dateLocale, lang, t } from '../lib/i18n';
import { gameOf, nameOf, state } from '../lib/store';
import type { Activity } from '../lib/types';
import { setUi } from '../lib/ui';
import { clock, elapsedSince, GameCard } from './Activity';
import { Avatar } from './Avatar';
import { type FavoriteGame, GameAbout, GameArt, type GameInfo } from './FavoriteGames';
import * as I from './Icons';
import { type LeagueAccount, LeagueCard } from './League';
import { Duration } from './StatsPage';

/** GET /users/{id}/game: their side of the game. */
interface TheirGame {
  seconds: number;
  last_played?: string | null;
  rank?: number | null;
  games: number;
  favorite?: number | null;
  favorites?: number;
  league?: LeagueAccount | null;
}

const longDate = (d: string) =>
  new Date(d).toLocaleDateString(dateLocale(), { year: 'numeric', month: 'short', day: 'numeric' });

export function GameModal(p: {
  userId: string;
  /** Opened from a "Playing" card. */
  activity?: Activity;
  /** Opened from their favorites: the list (arrows step through it) and which one. */
  favorites?: FavoriteGame[];
  index?: number;
  guildId?: string;
}) {
  const [idx, setIdx] = createSignal(p.index ?? 0);
  const count = () => p.favorites?.length ?? 0;
  const fav = () => p.favorites?.[idx()];
  const step = (d: -1 | 1) => count() > 1 && setIdx((i) => (i + d + count()) % count());
  const base = (): Activity =>
    fav()
      ? { type: 0, name: fav()!.name, application_id: fav()!.id ?? undefined, icon: fav()!.icon ?? undefined }
      : p.activity!;
  // Their live activity while it's this game; else the one it was opened with (or the favorite).
  const live = () => {
    const a = gameOf(p.userId);
    return a && a.name === base().name ? a : undefined;
  };
  const activity = () => live() ?? base();
  const name = () => activity().name;
  const who = () => nameOf(p.userId, p.guildId);
  const isMe = () => p.userId === state.me?.id;
  // TFT reports League's application id: its details would be League's.
  const appId = () => (activity().league?.mode === 'TFT' ? undefined : activity().application_id);
  const [info] = createResource(
    () => (appId() ? ([appId()!, lang()] as const) : null),
    ([id, l]) =>
      api<GameInfo>('GET', `/games/${encodeURIComponent(id)}?lang=${encodeURIComponent(l)}`).catch(() => null),
  );
  const [theirs] = createResource(
    () => [p.userId, name()] as const,
    ([id, n]) => api<TheirGame>('GET', `/users/${id}/game?name=${encodeURIComponent(n)}`).catch(() => null),
  );
  const d = () => info()?.details ?? null;
  const hero = () => d()?.background || d()?.header || info()?.cover || info()?.poster || null;
  const makers = () => {
    const dev = d()?.developers ?? [];
    const pub = (d()?.publishers ?? []).filter((x) => !dev.includes(x));
    return [...dev, ...pub].slice(0, 3).join(' · ');
  };
  const art = () => ({
    id: appId() ?? null,
    name: name(),
    icon: activity().icon ?? info()?.icon,
    // Their favorite's own art (picked in Settings) first.
    cover: fav()?.cover ?? info()?.cover,
    poster: fav()?.poster ?? info()?.poster,
  });
  // Others you can see playing it right now.
  const alsoPlaying = () =>
    Object.keys(state.activities).filter(
      (id) => id !== p.userId && !state.users[id]?.bot && gameOf(id)?.name === name(),
    );
  const close = () => setUi('modal', null);
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));
  const openProfile = (id: string) => setUi('modal', { type: 'user-profile', userId: id, guildId: p.guildId });
  return (
    <div class="modal game-modal" role="dialog" aria-label={name()}>
      <div class="game-hero">
        <Show when={hero()}>{(src) => <img src={src()} alt="" />}</Show>
        <Show when={count() > 1}>
          <div class="game-hero-bar">
            <button class="icon-btn" aria-label={t('Previous game')} onClick={() => step(-1)}>
              <I.Chevron size={16} class="chev-left" />
            </button>
            <span class="game-step">
              {String(idx() + 1).padStart(2, '0')}/{String(count()).padStart(2, '0')}
            </span>
            <button class="icon-btn" aria-label={t('Next game')} onClick={() => step(1)}>
              <I.Chevron size={16} class="chev-right" />
            </button>
          </div>
        </Show>
        <button class="icon-btn modal-close" aria-label={t('Close')} onClick={close}>
          <I.Close size={18} />
        </button>
      </div>
      <div class="game-card-head">
        <GameArt game={art()} class="game-card-poster" />
        <div class="game-card-title">
          <span class="label">
            {live()
              ? t('Playing now')
              : fav()
                ? t("No. {n} in {name}'s favorites", { n: idx() + 1, name: who() })
                : t('Game')}
          </span>
          <h2>{name()}</h2>
          <Show when={makers()}>
            <span class="muted small">{makers()}</span>
          </Show>
        </div>
      </div>
      <div class="game-card-body">
        {/* Them: who, what they're doing in it right now, and their numbers. */}
        <section class="game-player">
          <button class="game-player-who" onClick={() => openProfile(p.userId)}>
            <Show when={state.users[p.userId]}>
              {(u) => <Avatar user={u()} size={36} presence guildId={p.guildId} />}
            </Show>
            <span class="grow">
              <strong>{who()}</strong>
              <small>
                {live()
                  ? t('Playing for {time}', { time: elapsedSince(activity().timestamps?.start, clock()) })
                  : t('Not playing right now')}
              </small>
            </span>
            <I.Chevron size={16} class="chev-right" />
          </button>
          <Show when={live()?.league}>
            <GameCard activity={live()!} userId={p.userId} inModal />
          </Show>
          <div class="game-facts">
            <Show when={(theirs()?.seconds ?? 0) >= 60}>
              <div>
                <dt>{isMe() ? t('You played') : t('{name} played', { name: who() })}</dt>
                <dd>
                  <Duration seconds={theirs()!.seconds} />
                </dd>
              </div>
            </Show>
            <Show when={!live() && theirs()?.last_played}>
              <div>
                <dt>{t('Last played')}</dt>
                <dd>{longDate(theirs()!.last_played!)}</dd>
              </div>
            </Show>
            <Show when={theirs()?.rank && theirs()!.games > 1}>
              <div>
                <dt>{t('Most played')}</dt>
                <dd>{t('No. {n} of {total}', { n: theirs()!.rank!, total: theirs()!.games })}</dd>
              </div>
            </Show>
            <Show when={theirs()?.favorite}>
              <div>
                <dt>{t('Favorites')}</dt>
                <dd>{t('No. {n} of {total}', { n: theirs()!.favorite!, total: theirs()!.favorites ?? 0 })}</dd>
              </div>
            </Show>
          </div>
        </section>

        <Show when={theirs()?.league}>
          {(acc) => (
            <div class="game-league">
              <LeagueCard userId={p.userId} account={acc()} isMe={isMe()} />
            </div>
          )}
        </Show>

        <Show when={info.loading}>
          <p class="muted small">{t('Loading…')}</p>
        </Show>
        <div class="game-facts">
          <Show when={d()?.release_date}>
            <div>
              <dt>{d()!.coming_soon ? t('Coming') : t('Released')}</dt>
              <dd>{d()!.release_date}</dd>
            </div>
          </Show>
          <Show when={d()?.free}>
            <div>
              <dt>{t('Price')}</dt>
              <dd>{t('Free to play')}</dd>
            </div>
          </Show>
          <Show when={d()?.metacritic}>
            <div>
              <dt>Metacritic</dt>
              <dd>{d()!.metacritic}</dd>
            </div>
          </Show>
        </div>
        <Show when={fav() && !fav()!.id}>
          <p class="muted small">{t('{name} added this game by hand.', { name: who() })}</p>
        </Show>
        <GameAbout info={info()} ownerId={p.userId} />

        <Show when={alsoPlaying().length}>
          <div class="game-fans">
            <span class="label">{t('Also playing now')}</span>
            <div class="game-fans-list">
              <For each={alsoPlaying()}>
                {(id) => (
                  <button class="game-fan" data-tip={nameOf(id, p.guildId)} onClick={() => openProfile(id)}>
                    <Show when={state.users[id]}>{(u) => <Avatar user={u()} size={30} presence />}</Show>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}

/** Opens the game modal for what `userId` is playing. */
export function openGame(userId: string, activity: Activity, guildId?: string) {
  setUi('modal', { type: 'game', userId, activity, guildId });
}
