// The REC overlay's page (its window: src-tauri/src/rec/overlay.rs), over the game when you press its hotkey: whether
// it's recording (the only place that says so in game), save a clip / screenshot / bookmark, start or stop, leave
// your mic or the voice chat out from now on, and the latest clips. Esc, the hotkey again or a click outside closes it
// and gives the game its focus back. Start/stop runs in the main window (lib/rec.ts knows what's being recorded).
// The panel moves (drag its header) and resizes (its edges and corners) like a window, within MIN/MAX; double-click
// the header to put it back in the middle. Where it is stays in this device's storage (its own key: the main window
// rewrites prefs as a whole and would undo the overlay's changes).

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { createResource, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { t } from '../lib/i18n';
import { comboLabel, type KeyAction } from '../lib/keys';
import { prefs } from '../lib/prefs';
import type { RecStatus } from '../lib/rec';
import * as I from './Icons';
import { clock } from './Rec';

/** The panel's place and size in the overlay window (CSS px). */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const MIN = { w: 480, h: 340 };
const MAX = { w: 1200, h: 1000 };
/** Kept clear of the screen's edges. */
const MARGIN = 8;
const BOX_KEY = 'pottira.recOverlayBox';
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type Edge = (typeof EDGES)[number];

function loadBox(): Box | null {
  try {
    const b = JSON.parse(localStorage.getItem(BOX_KEY) ?? 'null');
    return b && [b.x, b.y, b.w, b.h].every(Number.isFinite) ? b : null;
  } catch {
    return null;
  }
}

function saveBox(b: Box | null) {
  try {
    if (b) localStorage.setItem(BOX_KEY, JSON.stringify(b));
    else localStorage.removeItem(BOX_KEY);
  } catch {
    // Storage blocked: it just won't be remembered.
  }
}

/** Within the size limits and on screen (the overlay can open on a smaller monitor than last time). */
function fit(b: Box): Box {
  const maxW = Math.max(MIN.w, Math.min(MAX.w, innerWidth - 2 * MARGIN));
  const maxH = Math.max(MIN.h, Math.min(MAX.h, innerHeight - 2 * MARGIN));
  const w = Math.min(maxW, Math.max(MIN.w, b.w));
  const h = Math.min(maxH, Math.max(MIN.h, b.h));
  const x = Math.min(Math.max(MARGIN, b.x), Math.max(MARGIN, innerWidth - w - MARGIN));
  const y = Math.min(Math.max(MARGIN, b.y), Math.max(MARGIN, innerHeight - h - MARGIN));
  return { x, y, w, h };
}

interface Clip {
  path: string;
  meta: { game: string; title: string; created: number; duration_ms: number };
}

export function RecOverlay() {
  const [status, setStatus] = createSignal<RecStatus | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [note, setNote] = createSignal<{ text: string; bad?: boolean } | null>(null);
  const [playing, setPlaying] = createSignal<string | null>(null);
  const [clips, { refetch }] = createResource(() =>
    invoke<{ clips: Clip[] }>('rec_library')
      .then((l) => l.clips.slice(0, 4))
      .catch(() => [] as Clip[]),
  );
  const close = () => void invoke('rec_overlay_close');
  // ---------- moving and resizing ----------
  /** null = the default: centered, as tall as its content. */
  const [box, setBox] = createSignal<Box | null>(null);
  const placeBox = () => {
    const saved = loadBox();
    setBox(saved && fit(saved));
  };
  let panel!: HTMLDivElement;
  /** Drags the header (edge null) or an edge/corner; the box is saved when the pointer is let go. */
  const grab = (e: PointerEvent, edge: Edge | null) => {
    if (e.button !== 0) return;
    if (!edge && (e.target as HTMLElement).closest('button, input, a')) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const r = panel.getBoundingClientRect();
    const start = { x: r.left, y: r.top, w: r.width, h: r.height };
    const from = { x: e.clientX, y: e.clientY };
    const move = (m: PointerEvent) => {
      const dx = m.clientX - from.x;
      const dy = m.clientY - from.y;
      if (!edge) return setBox(fit({ ...start, x: start.x + dx, y: start.y + dy }));
      let { x, y, w, h } = start;
      if (edge.includes('e')) w = start.w + dx;
      if (edge.includes('s')) h = start.h + dy;
      // West and north move the left/top edge: the opposite edge stays where it was.
      if (edge.includes('w')) {
        w = Math.min(MAX.w, Math.max(MIN.w, start.w - dx));
        x = start.x + start.w - w;
      }
      if (edge.includes('n')) {
        h = Math.min(MAX.h, Math.max(MIN.h, start.h - dy));
        y = start.y + start.h - h;
      }
      setBox(fit({ x, y, w, h }));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      saveBox(box());
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const resetBox = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, a')) return;
    setBox(null);
    saveBox(null);
  };
  const refresh = () => void invoke<RecStatus>('rec_status').then(setStatus);
  let noteTimer: number | undefined;
  const say = (text: string, bad = false) => {
    setNote({ text, bad });
    clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => setNote(null), 2500);
  };
  const run = async (what: 'clip' | 'screenshot' | 'bookmark') => {
    const cmd = { clip: 'rec_clip', screenshot: 'rec_screenshot', bookmark: 'rec_bookmark' }[what];
    try {
      await invoke(cmd, what === 'clip' ? {} : undefined);
      say({ clip: t('Clip saved'), screenshot: t('Screenshot saved'), bookmark: t('Bookmarked') }[what]);
      if (prefs.rec.sounds) void import('../lib/sounds').then((s) => s.sounds.recSaved());
      if (what === 'clip') void refetch();
    } catch (e) {
      say(String(e) === 'not recording' ? t('Not recording') : String(e), true);
      if (prefs.rec.sounds) void import('../lib/sounds').then((s) => s.sounds.recFailed());
    }
  };
  const toggle = () => void emitTo('main', 'rec-action', 'toggle');
  const live = (patch: { mic?: boolean; voices?: boolean }) =>
    void invoke<RecStatus>('rec_live', patch).then(setStatus);
  const key = (action: KeyAction) => {
    const combo = prefs.keybinds.find((b) => b.action === action)?.combo;
    return combo ? comboLabel(combo, t) : null;
  };

  /** The shell shows the window once the page has drawn (two frames: laid out, then painted). */
  const drawn = () => requestAnimationFrame(() => requestAnimationFrame(() => void invoke('rec_overlay_ready')));

  onMount(() => {
    document.documentElement.classList.add('rec-overlay-window');
    refresh();
    placeBox();
    drawn();
    // The window takes the size of the game's monitor each time it opens: keep the panel on it.
    const onResize = () => box() && setBox(fit(box()!));
    window.addEventListener('resize', onResize);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    const offs = [
      listen<RecStatus>('rec-status', (e) => setStatus(e.payload)),
      // Opened again: fresh state, and nothing left playing from last time.
      listen('rec-overlay-shown', () => (refresh(), void refetch(), setPlaying(null), placeBox(), drawn())),
    ];
    onCleanup(() => {
      clearInterval(timer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      for (const off of offs) void off.then((f) => f());
    });
  });

  const s = () => status();
  return (
    <div class="rov" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        class="rov-panel"
        classList={{ placed: !!box() }}
        role="dialog"
        aria-label="REC"
        ref={panel}
        style={
          box() ? { left: `${box()!.x}px`, top: `${box()!.y}px`, width: `${box()!.w}px`, height: `${box()!.h}px` } : {}
        }
      >
        <For each={EDGES}>{(edge) => <span class={`rov-grip ${edge}`} onPointerDown={(e) => grab(e, edge)} />}</For>
        <header class="rov-head" onPointerDown={(e) => grab(e, null)} onDblClick={resetBox}>
          <span class="rov-brand">
            <I.Rec size={18} /> REC
          </span>
          <span class="rov-state" classList={{ on: !!s()?.recording }}>
            <span class="rec-glyph" classList={{ off: !s()?.recording }} />
            <Show when={s()?.recording} fallback={t('Not recording')}>
              {t('Recording')} · {s()!.game} · {clock(now() - (s()!.since ?? now()))}
            </Show>
          </span>
          <button class="icon-btn" aria-label={t('Close')} onClick={close}>
            <I.Close size={18} />
          </button>
        </header>

        <div class="rov-body">
          <div class="rov-actions">
            <button class="rov-action" disabled={!s()?.recording} onClick={() => void run('clip')}>
              <I.Scissors size={22} />
              <span>{t('Save a Clip')}</span>
              <Show when={key('rec-clip')}>{(k) => <kbd>{k()}</kbd>}</Show>
            </button>
            <button class="rov-action" onClick={() => void run('screenshot')}>
              <I.Photo size={22} />
              <span>{t('Take a Screenshot')}</span>
              <Show when={key('rec-screenshot')}>{(k) => <kbd>{k()}</kbd>}</Show>
            </button>
            <button class="rov-action" disabled={!s()?.recording} onClick={() => void run('bookmark')}>
              <I.Bookmark size={22} />
              <span>{t('Bookmark')}</span>
              <Show when={key('rec-bookmark')}>{(k) => <kbd>{k()}</kbd>}</Show>
            </button>
            <button class="rov-action" classList={{ stop: !!s()?.recording }} onClick={toggle}>
              <I.Rec size={22} />
              <span>{s()?.recording ? t('Stop recording') : t('Start recording')}</span>
              <Show when={key('rec-toggle')}>{(k) => <kbd>{k()}</kbd>}</Show>
            </button>
          </div>

          <Show when={note()}>
            {(n) => (
              <div class="rov-note" classList={{ bad: !!n().bad }} role="status">
                {n().text}
              </div>
            )}
          </Show>

          <Show when={s()?.recording && (s()?.mic_on != null || s()?.voices_on != null)}>
            <div class="rov-switches">
              <Show when={s()?.mic_on != null}>
                <label class="set-row">
                  <span class="set-row-text">
                    <strong>{t('Your microphone')}</strong>
                  </span>
                  <input
                    type="checkbox"
                    class="switch"
                    checked={!!s()?.mic_on}
                    onChange={(e) => live({ mic: e.currentTarget.checked })}
                  />
                </label>
              </Show>
              <Show when={s()?.voices_on != null}>
                <label class="set-row">
                  <span class="set-row-text">
                    <strong>{t('Voice chat')}</strong>
                  </span>
                  <input
                    type="checkbox"
                    class="switch"
                    checked={!!s()?.voices_on}
                    onChange={(e) => live({ voices: e.currentTarget.checked })}
                  />
                </label>
              </Show>
            </div>
          </Show>

          <section class="rov-clips">
            <h2>{t('Latest clips')}</h2>
            <Show when={playing()}>
              {(path) => <video class="rov-player" src={convertFileSrc(path())} controls autoplay />}
            </Show>
            <Show when={clips()?.length} fallback={<p class="muted small">{t('Clips you save show up here.')}</p>}>
              <div class="rov-clip-list">
                <For each={clips()}>
                  {(c) => (
                    <button
                      class="rov-clip"
                      classList={{ active: playing() === c.path }}
                      onClick={() => setPlaying(c.path)}
                    >
                      <video src={`${convertFileSrc(c.path)}#t=0.5`} preload="metadata" muted />
                      <span>{c.meta.title || c.meta.game}</span>
                      <small>{clock(c.meta.duration_ms)}</small>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </section>

          <footer class="rov-foot">
            <button class="btn" onClick={() => void emitTo('main', 'rec-action', 'open')}>
              {t('Open REC in Pottira')}
            </button>
            <span class="muted small">{t('Esc to close')}</span>
          </footer>
        </div>
      </div>
    </div>
  );
}
