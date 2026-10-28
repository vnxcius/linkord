import { createResource, createSignal, For, Show } from 'solid-js';
import { api } from '../lib/api';
import { toggleFavoriteGif } from '../lib/actions';
import { t } from '../lib/i18n';
import { state } from '../lib/store';
import { attempt } from '../lib/ui';
import { useOutsideClose } from './EmojiPicker';
import * as I from './Icons';

interface Gif {
  id: string;
  url: string;
  preview: string;
}

/** Favorites always work; search/trending need GIPHY_API_KEY on the server. */
export function GifPicker(p: { onPick: (url: string) => void; onClose: () => void }) {
  const [query, setQuery] = createSignal('');
  const [debounced, setDebounced] = createSignal('');
  const [tab, setTab] = createSignal<'favorites' | 'search'>(state.features.gifs ? 'search' : 'favorites');
  let root!: HTMLDivElement;
  let timer: number | undefined;
  useOutsideClose(() => root, p.onClose);

  const [results] = createResource(
    () => (tab() === 'search' && state.features.gifs ? debounced() || '__trending__' : null),
    (q) => api<Gif[]>('GET', q === '__trending__' ? '/gifs/trending' : `/gifs/search?q=${encodeURIComponent(q)}`).catch(() => []),
  );
  const favorites = () => [...(state.settings.favorite_gifs ?? [])].reverse();

  return (
    <div class="emoji-picker gif-picker composer-picker" ref={root} onKeyDown={(e) => e.key === 'Escape' && p.onClose()}>
      <div class="picker-tabs">
        <Show when={state.features.gifs}>
          <button classList={{ active: tab() === 'search' }} onClick={() => setTab('search')}>
            GIFs
          </button>
        </Show>
        <button classList={{ active: tab() === 'favorites' }} onClick={() => setTab('favorites')}>
          <I.Star size={14} /> {t('Favorites')}
        </button>
      </div>
      <Show when={tab() === 'search'}>
        <input
          class="emoji-search"
          placeholder={t('Search GIFs')}
          value={query()}
          autofocus
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            clearTimeout(timer);
            timer = window.setTimeout(() => setDebounced(query().trim()), 350);
          }}
        />
      </Show>
      <div class="emoji-scroll">
        <div class="gif-grid">
          <Show
            when={tab() === 'search'}
            fallback={
              <For each={favorites()} fallback={<p class="empty-hint">{t('Star a GIF in chat to keep it here.')}</p>}>
                {(url) => (
                  <div class="gif-cell">
                    <img src={url} alt="" loading="lazy" referrerpolicy="no-referrer" onClick={() => p.onPick(url)} />
                    <button class="fav-star on" title={t('Remove from favorites')} onClick={() => void attempt(() => toggleFavoriteGif(url))}>
                      <I.Star size={16} />
                    </button>
                  </div>
                )}
              </For>
            }
          >
            <For each={results() ?? []} fallback={<p class="empty-hint">{results.loading ? t('Loading…') : t('No GIFs found.')}</p>}>
              {(g) => (
                <div class="gif-cell">
                  <img src={g.preview} alt="" loading="lazy" referrerpolicy="no-referrer" onClick={() => p.onPick(g.url)} />
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
