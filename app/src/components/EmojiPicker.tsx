import { createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { emojiUrl } from '../lib/api';
import { EMOJI_GROUPS, searchEmoji } from '../lib/emoji-data';
import { t } from '../lib/i18n';
import { state } from '../lib/store';
import type { Emoji } from '../lib/types';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '👀', '🎉'];

/** What a pick produces: text to insert into a message, and the key used for reactions. */
export interface Picked {
  text: string;
  reaction: string;
}

export const customPick = (e: Emoji): Picked => ({ text: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`, reaction: `${e.name}:${e.id}` });
const unicodePick = (c: string): Picked => ({ text: c, reaction: c });

export function useOutsideClose(el: () => HTMLElement, onClose: () => void) {
  const onDoc = (e: MouseEvent) => !el().contains(e.target as Node) && onClose();
  onMount(() => setTimeout(() => document.addEventListener('mousedown', onDoc)));
  onCleanup(() => document.removeEventListener('mousedown', onDoc));
}

export function EmojiPicker(p: { onPick: (e: Picked) => void; onClose: () => void; class?: string; style?: JSX.CSSProperties; guildId?: string | null }) {
  const [query, setQuery] = createSignal('');
  let root!: HTMLDivElement;
  useOutsideClose(() => root, p.onClose);

  // Custom emoji from every server you're in (current server first), like Discord.
  const servers = () =>
    Object.entries(state.emojis)
      .filter(([, list]) => list.length)
      .sort(([a], [b]) => (a === p.guildId ? -1 : b === p.guildId ? 1 : 0))
      .map(([gid, list]) => ({ name: state.guilds[gid]?.name ?? t('Server'), list }));
  const q = () => query().trim().toLowerCase().replace(/^:/, '');
  const customMatches = () => servers().flatMap((s) => s.list).filter((e) => e.name.toLowerCase().includes(q()));

  return (
    <div class={`emoji-picker ${p.class ?? ''}`} style={p.style} ref={root} onKeyDown={(e) => e.key === 'Escape' && p.onClose()}>
      <input class="emoji-search" placeholder={t('Find the perfect emoji')} value={query()} onInput={(e) => setQuery(e.currentTarget.value)} autofocus />
      <div class="emoji-scroll">
        <Show
          when={!q()}
          fallback={
            <div class="emoji-grid">
              <For each={customMatches()}>
                {(e) => (
                  <button title={`:${e.name}:`} onClick={() => p.onPick(customPick(e))}>
                    <img class="emoji custom" src={emojiUrl(e.id, e.animated)} alt={e.name} />
                  </button>
                )}
              </For>
              <For each={searchEmoji(q(), 64)}>
                {(e) => (
                  <button title={`:${e.names[0]}:`} onClick={() => p.onPick(unicodePick(e.char))}>
                    {e.char}
                  </button>
                )}
              </For>
            </div>
          }
        >
          <For each={servers()}>
            {(s) => (
              <>
                <div class="emoji-group">{s.name}</div>
                <div class="emoji-grid">
                  <For each={s.list}>
                    {(e) => (
                      <button title={`:${e.name}:`} onClick={() => p.onPick(customPick(e))}>
                        <img class="emoji custom" src={emojiUrl(e.id, e.animated)} alt={e.name} loading="lazy" />
                      </button>
                    )}
                  </For>
                </div>
              </>
            )}
          </For>
          <For each={EMOJI_GROUPS}>
            {(g) => (
              <>
                <div class="emoji-group">{t(g.name)}</div>
                <div class="emoji-grid">
                  <For each={g.emojis}>
                    {(e) => (
                      <button title={`:${e.names[0]}:`} onClick={() => p.onPick(unicodePick(e.char))}>
                        {e.char}
                      </button>
                    )}
                  </For>
                </div>
              </>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
