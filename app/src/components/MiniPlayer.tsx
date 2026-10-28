import { createSignal, onCleanup, Show } from 'solid-js';
import { selectChannel } from '../lib/actions';
import { t } from '../lib/i18n';
import { prefs, setPrefs } from '../lib/prefs';
import { currentChannel, nameOf, state } from '../lib/store';
import { registerCanvas, setStreamVolume, setVoiceUi, streamVolume, toggleStreamMute, voiceUi, watchStream } from '../lib/voice';
import * as I from './Icons';
import { canPopOut, popOut, Viewers } from './VoiceView';
import { VolumeControl } from './VolumeControl';

const MIN_WIDTH = 240;
/** Pointer movement (px) that turns a click into a drag. */
const DRAG_SLOP = 4;

/**
 * Floating player for the stream you're watching while you browse other channels (like Discord's).
 * Drag it anywhere, resize it from the top-left corner, click it to go back to the stream in the call.
 */
export function MiniPlayer() {
  // The stream to show: the focused one if we're watching it, otherwise any stream we're watching.
  const streamer = () => {
    const live = (id: string) => voiceUi.watching[id] && state.voice[id]?.self_stream;
    const focused = voiceUi.focus?.endsWith('-screen') ? voiceUi.focus.slice(0, -'-screen'.length) : null;
    if (focused && live(focused)) return focused;
    return Object.keys(voiceUi.watching).find(live) ?? null;
  };
  const visible = () => !!voiceUi.channelId && currentChannel()?.id !== voiceUi.channelId && !!streamer();
  const [pos, setPos] = createSignal({ right: 20, bottom: 90 });
  const [dragging, setDragging] = createSignal(false);
  const maxWidth = () => Math.max(MIN_WIDTH, Math.min(innerWidth - 16, 960));
  const width = () => Math.max(MIN_WIDTH, Math.min(maxWidth(), prefs.miniPlayerWidth));
  let canvas: HTMLCanvasElement | undefined;

  const openStream = (id: string) => {
    selectChannel(voiceUi.channelId!);
    setVoiceUi('focus', `${id}-screen`);
  };

  /** Follows the pointer after it moved a few px; a plain click opens the stream instead. */
  const track = (e: PointerEvent, onMove: (dx: number, dy: number) => void, onClick?: () => void) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      moved = true;
      setDragging(true);
      onMove(dx, dy);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragging(false);
      if (!moved) onClick?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const drag = (e: PointerEvent, id: string) => {
    if ((e.target as HTMLElement).closest('button, .vp-volume, .mini-resize')) return;
    const start = pos();
    const w = width();
    track(
      e,
      (dx, dy) =>
        setPos({
          right: Math.max(8, Math.min(innerWidth - w - 8, start.right - dx)),
          bottom: Math.max(8, Math.min(innerHeight - (w * 9) / 16 - 48, start.bottom - dy)),
        }),
      () => openStream(id),
    );
  };

  // Anchored bottom-right, so pulling the top-left corner out (left/up) makes it bigger.
  const resize = (e: PointerEvent) => {
    e.stopPropagation();
    const w0 = width();
    track(e, (dx, dy) => setPrefs({ miniPlayerWidth: Math.round(Math.max(MIN_WIDTH, Math.min(maxWidth(), w0 - Math.min(dx, (dy * 16) / 9)))) }));
  };

  return (
    <Show when={visible() && streamer()} keyed>
      {(id) => (
        <div
          class="mini-player"
          classList={{ dragging: dragging() }}
          style={{ right: `${pos().right}px`, bottom: `${pos().bottom}px`, width: `${width()}px` }}
          title={t('Open the stream in the call')}
          onPointerDown={(e) => drag(e, id)}
        >
          <div class="mini-resize" onPointerDown={resize} title={t('Resize')} />
          <canvas
            ref={(c) => {
              canvas = c;
              registerCanvas(`${id}-screen`, c, true);
              onCleanup(() => registerCanvas(`${id}-screen`, c, false));
            }}
          />
          <div class="mini-bar">
            <span class="video-label">
              <span class="name">{nameOf(id, state.voice[id]?.guild_id)}</span> <span class="live-badge">{t('LIVE')}</span>
              <Viewers userId={id} guildId={state.voice[id]?.guild_id} />
            </span>
            <span class="grow" />
            <VolumeControl value={streamVolume(id)} max={2} tip={t('Stream volume')} onChange={(v) => setStreamVolume(id, v)} onToggleMute={() => toggleStreamMute(id)} />
            <Show when={canPopOut}>
              <button class="vp-btn" data-tip={t('Pop out')} onClick={() => void popOut(canvas)}>
                <I.PopOut size={16} />
              </button>
            </Show>
            <button class="vp-btn danger" data-tip={t('Stop watching')} onClick={() => watchStream(id, false)}>
              <I.Close size={16} />
            </button>
          </div>
        </div>
      )}
    </Show>
  );
}
