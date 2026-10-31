// Hovering someone who's live in the channel list shows a picture of their stream, like Discord's. Streamers'
// apps send one now and then (voice.ts sendPreview); it's fetched on hover and kept a little while.
import { createResource, createSignal, onCleanup, Show } from 'solid-js';
import { getToken, serverUrl } from '../lib/api';
import { t } from '../lib/i18n';
import { nameOf, state } from '../lib/store';
import { Avatar } from './Avatar';

interface Hover {
  userId: string;
  guildId?: string | null;
  /** Where the row ends (the card opens beside it) and its middle. */
  x: number;
  y: number;
}

const [hover, setHover] = createSignal<Hover | null>(null);

/** Pictures we fetched: object URLs, refreshed after a while (the streamer sends a new one every 45 s). */
const cache = new Map<string, { url: string | null; at: number }>();
const FRESH_MS = 20_000;

async function fetchPreview(userId: string): Promise<string | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.url;
  let url: string | null = null;
  try {
    const res = await fetch(`${serverUrl()}/api/users/${userId}/stream-preview`, {
      headers: { authorization: `Bearer ${getToken()}` },
    });
    if (res.ok) url = URL.createObjectURL(await res.blob());
  } catch {}
  if (hit?.url) URL.revokeObjectURL(hit.url);
  cache.set(userId, { url, at: Date.now() });
  return url;
}

/** Hover handlers for a row of someone in a voice channel: the card shows while they're live. */
export function streamPreviewOn(userId: () => string, guildId: () => string | null | undefined, live: () => boolean) {
  let timer: number | undefined;
  const hide = () => {
    clearTimeout(timer);
    if (hover()?.userId === userId()) setHover(null);
  };
  onCleanup(hide);
  return {
    onMouseEnter: (e: MouseEvent) => {
      if (!live()) return;
      const el = e.currentTarget as HTMLElement;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        setHover({ userId: userId(), guildId: guildId(), x: r.right + 10, y: r.top + r.height / 2 });
      }, 350);
    },
    onMouseLeave: hide,
    onPointerDown: hide,
  };
}

export function StreamPreviewHost() {
  return (
    <Show when={hover()} keyed>
      {(h) => <StreamPreviewCard {...h} />}
    </Show>
  );
}

const CARD_W = 300;
const CARD_H = 222;

function StreamPreviewCard(p: Hover) {
  const [src] = createResource(() => p.userId, fetchPreview);
  const live = () => !!state.voice[p.userId]?.self_stream;
  const top = () => Math.max(8, Math.min(p.y - CARD_H / 2, innerHeight - CARD_H - 8));
  const left = () => Math.min(p.x, innerWidth - CARD_W - 8);
  return (
    <Show when={live()}>
      <div
        class="stream-preview"
        style={{ left: `${left()}px`, top: `${top()}px`, width: `${CARD_W}px` }}
        role="tooltip"
      >
        <div class="stream-preview-shot">
          <Show
            when={src()}
            fallback={
              <div class="stream-preview-empty">
                <Show when={!src.loading} fallback={<div class="spinner" />}>
                  <Avatar user={state.users[p.userId]} size={44} />
                  <span>{t('No preview yet')}</span>
                </Show>
              </div>
            }
          >
            {(url) => <img src={url()} alt="" />}
          </Show>
          <span class="live-badge">{t('LIVE')}</span>
        </div>
        <div class="stream-preview-foot">
          <strong>{nameOf(p.userId, p.guildId)}</strong>
          <span class="muted small">{t('Click to watch the stream')}</span>
        </div>
      </div>
    </Show>
  );
}
