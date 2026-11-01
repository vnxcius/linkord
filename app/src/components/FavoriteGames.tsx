// Favorite games, the first profile widget: up to 20 games a person loves, picked in Settings -> Favorite Games
// from Discord's game catalog (or typed by hand), shown as posters in a card to the right of their full profile;
// clicking one turns that card into the game's own card (Steam's store details when it's on Steam). Art: Steam's 2:3 library poster when the game is on Steam, else Discord's 3:4 cover,
// else its icon, else its initials.
import { createEffect, createResource, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { api } from '../lib/api';
import { lang, plural, t } from '../lib/i18n';
import { openExternal } from '../lib/platform';
import { displayName, type User } from '../lib/types';
import { state } from '../lib/store';
import { setUi, toast } from '../lib/ui';
import { Avatar } from './Avatar';
import * as I from './Icons';
import { duration } from './StatsPage';

export const MAX_FAVORITE_GAMES = 20;

export interface FavoriteGame {
  /** Discord application id; null for a game typed by hand. */
  id: string | null;
  name: string;
  icon?: string | null;
  cover?: string | null;
  poster?: string | null;
  /** Time Linkord saw them play it (desktop app game detection). */
  seconds?: number;
  /** Games found on Wikipedia: its short description ("1998 video game"). */
  description?: string | null;
}

const initials = (name: string) =>
  name
    .split(/[\s:\-–—]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

/** A game's poster, falling back through its art until one loads. */
export function GameArt(p: { game: FavoriteGame; class?: string }) {
  const sources = () => [p.game.poster, p.game.cover, p.game.icon].filter((s): s is string => !!s);
  const [i, setI] = createSignal(0);
  createEffect(on(sources, () => setI(0), { defer: true }));
  const src = () => sources()[i()];
  return (
    <span class={`game-art ${p.class ?? ''}`} classList={{ 'icon-only': src() === p.game.icon && !!p.game.icon }}>
      <Show when={src()} fallback={<span class="game-initials">{initials(p.game.name)}</span>}>
        {(s) => <img src={s()} alt="" loading="lazy" draggable={false} onError={() => setI((n) => n + 1)} />}
      </Show>
    </span>
  );
}

const played = (g: FavoriteGame) =>
  g.seconds && g.seconds >= 60 ? t('{time} played', { time: duration(g.seconds) }) : '';

/** A numbered poster with its name under it (Settings). */
function GameTile(p: { game: FavoriteGame; rank: number }) {
  return (
    <div class="game-tile">
      <GameArt game={p.game} />
      <span class="game-tile-name">
        <em>{String(p.rank).padStart(2, '0')}</em>
        {p.game.name}
      </span>
    </div>
  );
}

/**
 * Their favorite games, and a game's own card when one is clicked. `bare`: without its own card around it (the full
 * profile's side card, Profile.tsx SideCard, frames it).
 */
export function FavoriteGamesCard(p: {
  userId: string;
  name: string;
  games: FavoriteGame[];
  isMe: boolean;
  bare?: boolean;
}) {
  const [open, setOpen] = createSignal<number | null>(null);
  // A new person's profile (or their list changing) goes back to the grid.
  createEffect(
    on(
      () => p.userId,
      () => setOpen(null),
      { defer: true },
    ),
  );
  const editGames = () => setUi('modal', { type: 'settings', tab: 'favorite-games' });
  const content = (
    <Show
      when={open() !== null && p.games[open()!]}
      keyed
      fallback={
        <div class="games-card-list">
          <header class="games-card-head">
            <div class="grow">
              <span class="label">{t('Favorite games')}</span>
              <h3>{p.games.length ? plural(p.games.length, '{n} game', '{n} games') : t('No games yet')}</h3>
            </div>
            <Show when={p.isMe && p.games.length}>
              <button
                class="icon-btn"
                aria-label={t('Edit favorite games')}
                data-tip={t('Edit favorite games')}
                onClick={editGames}
              >
                <I.Edit size={16} />
              </button>
            </Show>
          </header>
          <Show
            when={p.games.length}
            fallback={
              <button class="widget-empty" onClick={editGames}>
                <I.Gamepad size={22} />
                {t('Add the games you love')}
              </button>
            }
          >
            <div class="games-card-grid">
              <For each={p.games}>
                {(g, i) => (
                  <button class="game-pick" onClick={() => setOpen(i())} aria-label={g.name}>
                    <GameArt game={g} />
                    <span class="game-pick-name">
                      <em>{String(i() + 1).padStart(2, '0')}</em>
                      {g.name}
                    </span>
                    <Show when={played(g)}>
                      <small class="game-pick-time">{played(g)}</small>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      }
    >
      {(g) => (
        <GameCard
          game={g}
          rank={open()! + 1}
          owner={p.name}
          ownerId={p.userId}
          count={p.games.length}
          onBack={() => setOpen(null)}
          onStep={(d) => setOpen((i) => ((i ?? 0) + d + p.games.length) % p.games.length)}
        />
      )}
    </Show>
  );
  if (p.bare) return content;
  return (
    <aside class="modal games-card" aria-label={t('Favorite games')}>
      <div class="games-card-inner">{content}</div>
    </aside>
  );
}

interface GameInfo {
  id: string;
  name: string;
  cover?: string | null;
  poster?: string | null;
  icon?: string | null;
  themes?: string[];
  store_url?: string;
  fans?: User[];
  details?: {
    description?: string | null;
    developers?: string[];
    publishers?: string[];
    release_date?: string | null;
    coming_soon?: boolean;
    genres?: string[];
    free?: boolean;
    website?: string | null;
    header?: string | null;
    background?: string | null;
    screenshots?: { thumb: string; full: string }[];
    metacritic?: number | null;
    /** Where the facts and the description came from (Wikipedia for games that aren't on Steam). */
    source?: 'steam' | 'wikipedia';
    description_source?: 'wikipedia';
    source_url?: string | null;
  } | null;
}

/** One game: art, who makes it, when it came out, what it's about, and who else loves it. */
function GameCard(p: {
  game: FavoriteGame;
  rank: number;
  owner: string;
  ownerId: string;
  count: number;
  onBack: () => void;
  onStep: (d: -1 | 1) => void;
}) {
  const [info] = createResource(
    () => (p.game.id ? ([p.game.id, lang()] as const) : null),
    ([id, l]) =>
      api<GameInfo>('GET', `/games/${encodeURIComponent(id)}?lang=${encodeURIComponent(l)}`).catch(() => null),
  );
  const d = () => info()?.details ?? null;
  const hero = () => d()?.background || d()?.header || p.game.cover || p.game.poster || null;
  const genres = () => (d()?.genres?.length ? d()!.genres! : (info()?.themes ?? []));
  const makers = () => {
    const dev = d()?.developers ?? [];
    const pub = (d()?.publishers ?? []).filter((x) => !dev.includes(x));
    return [...dev, ...pub].slice(0, 3).join(' · ');
  };
  const fans = () => (info()?.fans ?? []).filter((u) => u.id !== p.ownerId);
  const wikiUrl = () =>
    d()?.source === 'wikipedia' || d()?.description_source === 'wikipedia' ? (d()?.source_url ?? null) : null;
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea')) return;
    if (e.key === 'ArrowLeft') p.onStep(-1);
    else if (e.key === 'ArrowRight') p.onStep(1);
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));
  return (
    <article class="game-card">
      <div class="game-hero">
        <Show when={hero()}>{(src) => <img src={src()} alt="" />}</Show>
        <div class="game-hero-bar">
          <button class="icon-btn" aria-label={t('Back')} data-tip={t('All games')} onClick={p.onBack}>
            <I.Back size={18} />
          </button>
          <span class="grow" />
          <Show when={p.count > 1}>
            <button class="icon-btn" aria-label={t('Previous game')} onClick={() => p.onStep(-1)}>
              <I.Chevron size={16} class="chev-left" />
            </button>
            <span class="game-step">
              {String(p.rank).padStart(2, '0')}/{String(p.count).padStart(2, '0')}
            </span>
            <button class="icon-btn" aria-label={t('Next game')} onClick={() => p.onStep(1)}>
              <I.Chevron size={16} class="chev-right" />
            </button>
          </Show>
        </div>
      </div>
      <div class="game-card-head">
        <GameArt game={p.game} class="game-card-poster" />
        <div class="game-card-title">
          <span class="label">{t("No. {n} in {name}'s favorites", { n: p.rank, name: p.owner })}</span>
          <h2>{p.game.name}</h2>
          <Show when={makers()}>
            <span class="muted small">{makers()}</span>
          </Show>
        </div>
      </div>
      <div class="game-card-body">
        <Show when={info.loading}>
          <p class="muted small">{t('Loading…')}</p>
        </Show>
        <div class="game-facts">
          <Show when={p.game.seconds && p.game.seconds >= 60}>
            <div>
              <dt>{t('{name} played', { name: p.owner })}</dt>
              <dd>{duration(p.game.seconds)}</dd>
            </div>
          </Show>
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
        <Show when={genres().length}>
          <div class="game-genres">
            <For each={genres().slice(0, 6)}>{(g) => <span class="chip">{g}</span>}</For>
          </div>
        </Show>
        <Show when={d()?.description}>
          <p class="game-description">{d()!.description}</p>
          {/* Wikipedia's text is CC BY-SA: say where it's from. */}
          <Show when={wikiUrl()}>
            <button class="link-btn game-source" onClick={() => void openExternal(wikiUrl()!)}>
              {t('From Wikipedia')}
            </button>
          </Show>
        </Show>
        <Show when={d()?.screenshots?.length}>
          <div class="game-shots">
            <For each={d()!.screenshots}>
              {(s) => (
                <button class="game-shot" aria-label={t('Screenshot')} onClick={() => setUi('lightbox', s.full)}>
                  <img src={s.thumb} alt="" loading="lazy" />
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={fans().length}>
          <div class="game-fans">
            <span class="label">{t('Also a favorite of')}</span>
            <div class="game-fans-list">
              <For each={fans()}>
                {(u) => (
                  <button
                    class="game-fan"
                    data-tip={displayName(state.users[u.id] ?? u)}
                    onClick={() => setUi('modal', { type: 'user-profile', userId: u.id })}
                  >
                    <Avatar user={state.users[u.id] ?? u} size={30} />
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={!p.game.id}>
          <p class="muted small">{t('{name} added this game by hand.', { name: p.owner })}</p>
        </Show>
        <Show when={info()?.store_url || d()?.website || wikiUrl()}>
          <div class="game-links">
            <Show when={info()?.store_url}>
              <button class="btn small-btn" onClick={() => void openExternal(info()!.store_url!)}>
                <I.External size={14} /> {t('Steam store')}
              </button>
            </Show>
            <Show when={d()?.website}>
              <button class="btn small-btn ghost" onClick={() => void openExternal(d()!.website!)}>
                <I.Link size={14} /> {t('Website')}
              </button>
            </Show>
            <Show when={wikiUrl()}>
              <button class="btn small-btn ghost" onClick={() => void openExternal(wikiUrl()!)}>
                <I.External size={14} /> Wikipedia
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </article>
  );
}

// ---------- Settings -> Favorite Games ----------

export function FavoriteGamesSettings() {
  const [games, setGames] = createSignal<FavoriteGame[]>([]);
  const [loaded] = createResource(async () => {
    const p = await api<{ favorite_games?: FavoriteGame[] }>('GET', `/users/${state.me!.id}/profile`);
    setGames(p.favorite_games ?? []);
    return true;
  });
  // Shown right away; put back if the server refuses it.
  const save = async (list: FavoriteGame[]) => {
    const before = games();
    setGames(list);
    try {
      setGames(
        await api<FavoriteGame[]>('PUT', '/users/@me/favorite-games', {
          games: list.map((g) => ({ id: g.id, name: g.name })),
        }),
      );
    } catch (e) {
      setGames(before);
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  const full = () => games().length >= MAX_FAVORITE_GAMES;
  const has = (g: FavoriteGame) =>
    games().some((x) => (g.id && x.id === g.id) || x.name.toLowerCase() === g.name.toLowerCase());
  const add = (g: FavoriteGame) => {
    if (full() || has(g)) return;
    void save([...games(), g]);
  };
  const remove = (i: number) => void save(games().filter((_, j) => j !== i));

  // Search as you type: Discord's game list right away, and Wikipedia alongside for games it doesn't have (older
  // and console games), shown under it.
  const [query, setQuery] = createSignal('');
  const [results, setResults] = createSignal<FavoriteGame[]>([]);
  const [wiki, setWiki] = createSignal<FavoriteGame[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [searchingWiki, setSearchingWiki] = createSignal(false);
  let timer: number | undefined;
  let seq = 0;
  createEffect(
    on(query, (q) => {
      clearTimeout(timer);
      const mine = ++seq;
      if (!q.trim()) {
        setResults([]);
        setWiki([]);
        setSearching(false);
        setSearchingWiki(false);
        return;
      }
      setSearching(true);
      setSearchingWiki(q.trim().length >= 3);
      const query = encodeURIComponent(q.trim());
      timer = window.setTimeout(() => {
        void api<FavoriteGame[]>('GET', `/games/search?q=${query}`)
          .catch(() => [])
          .then((found) => mine === seq && (setResults(found), setSearching(false)));
        if (q.trim().length < 3) return setWiki([]);
        void api<FavoriteGame[]>('GET', `/games/search/wikipedia?q=${query}`)
          .catch(() => [])
          .then((found) => mine === seq && (setWiki(found), setSearchingWiki(false)));
      }, 220);
    }),
  );
  onCleanup(() => clearTimeout(timer));
  const key = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  // Wikipedia hits Discord's list already has (same name) are left out.
  const moreGames = () => wiki().filter((w) => !results().some((r) => key(r.name) === key(w.name)));
  const custom = () => {
    const q = query().trim().replace(/\s+/g, ' ');
    return q && ![...results(), ...moreGames()].some((r) => key(r.name) === key(q)) ? q : '';
  };

  // Drag posters to reorder.
  const [dragging, setDragging] = createSignal<number | null>(null);
  const [over, setOver] = createSignal<{ i: number; before: boolean } | null>(null);
  const drop = () => {
    const from = dragging();
    const to = over();
    setDragging(null);
    setOver(null);
    if (from === null || !to) return;
    const list = [...games()];
    const [g] = list.splice(from, 1);
    let at = to.i + (to.before ? 0 : 1);
    if (from < at) at--;
    if (at === from) return;
    list.splice(at, 0, g!);
    void save(list);
  };

  return (
    <div class="stack favorite-games-settings">
      <p class="set-desc">
        {t('Up to 20 games you love, in your order. They show on the right of your full profile.')}
      </p>
      <div class="game-search">
        <I.Search size={16} />
        <input
          value={query()}
          placeholder={full() ? t('You have 20 favorite games — remove one to add another') : t('Search for a game')}
          disabled={full()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Escape' && query() && (e.preventDefault(), setQuery(''))}
        />
        <Show when={searching() || searchingWiki()}>
          <span class="spinner small" />
        </Show>
      </div>
      <Show when={query().trim()}>
        <div class="game-results">
          <For each={results()}>
            {(g) => (
              <button class="game-result" disabled={has(g) || full()} onClick={() => add(g)}>
                <GameArt game={g} class="small" />
                <span class="grow">{g.name}</span>
                <Show when={has(g)} fallback={<I.Plus size={16} />}>
                  <I.Check size={16} />
                </Show>
              </button>
            )}
          </For>
          <Show when={moreGames().length}>
            <div class="game-results-title">{t('More games · from Wikipedia')}</div>
            <For each={moreGames()}>
              {(g) => (
                <button class="game-result" disabled={has(g) || full()} onClick={() => add(g)}>
                  <GameArt game={g} class="small" />
                  <span class="grow">
                    {g.name}
                    <Show when={g.description}>
                      <small>{g.description}</small>
                    </Show>
                  </span>
                  <Show when={has(g)} fallback={<I.Plus size={16} />}>
                    <I.Check size={16} />
                  </Show>
                </button>
              )}
            </For>
          </Show>
          <Show when={custom()}>
            <button
              class="game-result custom"
              disabled={full()}
              onClick={() => (add({ id: null, name: custom() }), setQuery(''))}
            >
              <span class="game-art small">
                <span class="game-initials">{initials(custom())}</span>
              </span>
              <span class="grow">{t('Add “{name}” as your own game', { name: custom() })}</span>
              <I.Plus size={16} />
            </button>
          </Show>
          <Show when={!searching() && !searchingWiki() && !results().length && !moreGames().length && !custom()}>
            <p class="empty-hint">{t('No games found.')}</p>
          </Show>
        </div>
      </Show>
      <div class="field-label favorite-games-head">
        {t('Your games')} <em class="counter">{games().length}/20</em>
        <Show when={games().length > 1}>
          <span class="muted small">{t('Drag to reorder')}</span>
        </Show>
      </div>
      <Show when={loaded()} fallback={<p class="muted">{t('Loading…')}</p>}>
        <div class="games-grid editable">
          <For
            each={games()}
            fallback={<p class="empty-hint">{t('No favorite games yet. Search above to add some.')}</p>}
          >
            {(g, i) => (
              <div
                class="game-slot"
                draggable={true}
                classList={{
                  dragging: dragging() === i(),
                  'drop-before': over()?.i === i() && over()!.before,
                  'drop-after': over()?.i === i() && !over()!.before,
                }}
                onDragStart={(e) => {
                  setDragging(i());
                  e.dataTransfer!.effectAllowed = 'move';
                  e.dataTransfer!.setData('text/plain', g.name);
                }}
                onDragOver={(e) => {
                  if (dragging() === null) return;
                  e.preventDefault();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setOver({ i: i(), before: e.clientX < r.left + r.width / 2 });
                }}
                onDrop={(e) => (e.preventDefault(), drop())}
                onDragEnd={() => (setDragging(null), setOver(null))}
              >
                <GameTile game={g} rank={i() + 1} />
                <button
                  class="game-remove"
                  aria-label={t('Remove {name}', { name: g.name })}
                  data-tip={t('Remove')}
                  onClick={() => remove(i())}
                >
                  <I.Close size={12} />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
