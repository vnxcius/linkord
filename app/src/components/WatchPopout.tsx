// The desktop app's watch-together pop-out: a small always-on-top window (lib.rs watch_popout_open) that shows
// only the player. It has no server connection: the main window sends it the watch as it changes (with the server
// clock offset and whether to stay muted for our stream), and plays, pauses, seeks and stops on its behalf.
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { t } from '../lib/i18n';
import { putWatch, routeWatchControl, setServerOffset, watches, type Watch, type WatchPatch } from '../lib/watch';
import * as I from './Icons';
import { Player, WatchEnded } from './WatchPlayer';

const PROVIDERS = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' } as const;

interface PopOutState {
  channelId: string;
  watch: Watch | null;
  offset: number;
  muted: boolean;
}

const close = () => void invoke('watch_popout_close').catch(() => {});

export function WatchPopout() {
  const [view, setView] = createSignal<{ channelId: string; muted: boolean } | null>(null);
  routeWatchControl((channelId: string, patch: WatchPatch) =>
    emitTo('main', 'watch-popout-control', { channelId, patch }).catch(() => {}),
  );
  let off: (() => void) | undefined;
  onMount(async () => {
    off = await listen<PopOutState>('watch-popout-state', ({ payload: m }) => {
      setServerOffset(m.offset);
      putWatch(m.channelId, m.watch);
      // Stopped for everyone, or the call ended: nothing left to show.
      if (!m.watch) return close();
      const cur = view();
      if (!cur || cur.channelId !== m.channelId || cur.muted !== m.muted)
        setView({ channelId: m.channelId, muted: m.muted });
    });
    await emitTo('main', 'watch-popout-ready').catch(() => {});
  });
  onCleanup(() => off?.());

  const w = () => (view() ? watches[view()!.channelId] : undefined);
  return (
    <div class="watch-popout">
      {/* Its own strip above the video (over it, it covered YouTube's controls): move the window by it, or send the
          video back to the app. */}
      <div class="watch-popout-bar" data-tauri-drag-region>
        <Show when={w()}>
          {(watch) => (
            <span class={`watch-provider ${watch().provider}`} data-tauri-drag-region>
              {PROVIDERS[watch().provider]}
            </span>
          )}
        </Show>
        <Show when={view()?.muted}>
          <span
            class="watch-muted"
            title={t("Muted while you stream: Windows 10 would send it to your stream's viewers")}
          >
            <I.VolumeMute size={15} />
          </span>
        </Show>
        <span class="grow" data-tauri-drag-region />
        <button class="vp-btn" title={t('Bring it back')} aria-label={t('Bring it back')} onClick={close}>
          <I.PopOut size={16} />
        </button>
        <button
          class="vp-btn"
          title={t('Hide for me')}
          aria-label={t('Hide for me')}
          onClick={() => view() && void emitTo('main', 'watch-popout-hide', { channelId: view()!.channelId })}
        >
          <I.Close size={16} />
        </button>
      </div>
      <div class="watch-popout-video">
        <Show when={view() && w()} fallback={<div class="watch-popout-wait spinner" />}>
          {/* A new link or the stream mute loads the player again; play, pause and seeks only move it. */}
          <Show when={`${view()!.channelId}|${w()!.url}|${view()!.muted}`} keyed>
            {(_key) => <Player channelId={view()!.channelId} muted={view()!.muted} />}
          </Show>
          <Show when={w()!.ended}>
            <WatchEnded
              channelId={view()!.channelId}
              onStop={() => void emitTo('main', 'watch-popout-stop', { channelId: view()!.channelId })}
            />
          </Show>
        </Show>
      </div>
    </div>
  );
}
