// REC's player (owner, 2026-11-13: VODs can be hours long, so it must make them easy to get around): our own controls,
// and under the picture two lanes.
// - Overview: the whole recording, its moments (bookmarks, clips, screenshots, game events), what's buffered, the zoom
//   window as a bracket, and a picture of the moment under the mouse.
// - Detail (anything over a minute): a zoomed filmstrip of the recording's own thumbnails (one every 10 s) with a time
//   ruler. It follows the playhead; the wheel pans and Ctrl+wheel (or the +/- buttons) zooms from 15 s to 1 h.
// The clip being cut has handles on both lanes (I / O set them at the playhead). A VOD plays straight from its
// segments (lib/vod-player.ts, MSE); a single file (a clip, a shared clip) plays from its URL, with hover pictures
// taken from a second, hidden copy of the video.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { msg, t } from '../lib/i18n';
import { prefs, setPrefs } from '../lib/prefs';
import { VodPlayer, type VodPart } from '../lib/vod-player';
import * as I from './Icons';
import { VolumeControl } from './VolumeControl';

export interface Mark {
  ms: number;
  kind: string;
  label: string;
}

export interface PlayerControl {
  seek: (ms: number) => void;
  time: () => number;
  playing: () => boolean;
}

/** Ticks with a name of their own; League's carry their label already translated (lib/rec-league.ts). */
export const MARK_NAMES: Record<string, string> = {
  bookmark: msg('Bookmark'),
  clip: msg('Clip saved'),
  screenshot: msg('Screenshot'),
};
export const markText = (m: Mark) =>
  MARK_NAMES[m.kind] ? `${t(MARK_NAMES[m.kind])}${m.label ? ` · ${m.label}` : ''}` : m.label || m.kind;

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
/** Detail lane window lengths, ms. */
const SPANS = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800].map((s) => s * 1000);
const TILE_PX = 92;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** 1:02:03 / 4:05. */
export function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function RecPlayer(p: {
  /** A VOD's parts, or a file's URL. */
  source: { parts: VodPart[] } | { url: string };
  /** Length in ms as recorded (the video's own wins once it's known). */
  duration: number;
  /** [ms, picture URL]: a VOD's thumbnails. */
  thumbs?: [number, string][];
  marks?: Mark[];
  /** The clip being cut, ms. */
  cut?: [number, number] | null;
  onCut?: (c: [number, number]) => void;
  autoplay?: boolean;
  control?: (c: PlayerControl) => void;
}) {
  let root!: HTMLDivElement;
  let video!: HTMLVideoElement;
  let vod: VodPlayer | null = null;
  const [time, setTime] = createSignal(0);
  const [length, setLength] = createSignal(p.duration);
  const [paused, setPaused] = createSignal(true);
  const [started, setStarted] = createSignal(false);
  const [waiting, setWaiting] = createSignal(false);
  /** Played to the end: a "watch again" state instead of a spinner. */
  const [ended, setEnded] = createSignal(false);
  const [buffered, setBuffered] = createSignal<[number, number][]>([]);
  const [volume, setVolume] = createSignal(prefs.mediaVolume ?? 1);
  const [muted, setMuted] = createSignal(false);
  const [rate, setRate] = createSignal(1);
  const [speedMenu, setSpeedMenu] = createSignal(false);
  const [fullscreen, setFullscreen] = createSignal(false);
  const [idle, setIdle] = createSignal(false);
  const [hover, setHover] = createSignal<{ ms: number; lane: 'overview' | 'detail'; x: number } | null>(null);
  const [span, setSpan] = createSignal(120_000);
  const [winStart, setWinStart] = createSignal(0);
  const [detailWidth, setDetailWidth] = createSignal(800);

  const dur = () => Math.max(1, length());
  const zoomable = () => dur() > 60_000;
  const effSpan = () => Math.min(span(), dur());
  const marks = createMemo(() => [...(p.marks ?? [])].sort((a, b) => a.ms - b.ms));

  // ---------- media ----------
  onMount(() => {
    if ('parts' in p.source) vod = new VodPlayer(video, p.source.parts);
    else video.src = p.source.url;
    video.volume = volume();
    if (p.autoplay) void video.play().catch(() => {});
    p.control?.({ seek, time, playing: () => !paused() });
    const fs = () => setFullscreen(document.fullscreenElement === root);
    document.addEventListener('fullscreenchange', fs);
    onCleanup(() => document.removeEventListener('fullscreenchange', fs));
  });
  // The detail lane shows up once the length is known: watch its width from when it's there.
  const ro = new ResizeObserver(() => detail && setDetailWidth(detail.clientWidth));
  onCleanup(() => {
    ro.disconnect();
    vod?.dispose();
    clearTimeout(idleTimer);
  });
  // Where it plays: REC's own choice, else Linkord's output device.
  createEffect(() => {
    const id = prefs.rec.playbackDevice || prefs.outputDevice;
    const v = video as HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> };
    if (v?.setSinkId) void v.setSinkId(id && id !== 'default' ? id : '').catch(() => {});
  });

  function seek(ms: number) {
    const to = clamp(ms, 0, dur() - 50);
    video.currentTime = to / 1000;
    setTime(to);
  }
  const play = () => void video.play().catch(() => {});
  const toggle = () => (video.paused ? play() : video.pause());
  const step = (frames: number) => {
    video.pause();
    seek(time() + frames * (1000 / 60));
  };

  // Smooth playhead while playing.
  let raf = 0;
  const tick = () => {
    setTime(video.currentTime * 1000);
    raf = requestAnimationFrame(tick);
  };
  onCleanup(() => cancelAnimationFrame(raf));

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const wake = () => {
    setIdle(false);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => !video.paused && setIdle(true), 2500);
  };

  // The detail window keeps the playhead in view while playing (and after a seek from elsewhere).
  createEffect(
    on([time, effSpan], ([now, s]) => {
      if (dragging) return;
      const start = winStart();
      if (now < start || now > start + s) setWinStart(clamp(now - s * 0.2, 0, Math.max(0, dur() - s)));
    }),
  );

  // ---------- moments ----------
  const nextMark = (dir: 1 | -1) => {
    const now = time();
    const list = marks();
    const m = dir > 0 ? list.find((x) => x.ms > now + 1500) : [...list].reverse().find((x) => x.ms < now - 3000);
    if (m) seek(Math.max(0, m.ms - 3000));
  };

  // ---------- keys ----------
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    const handled = (() => {
      switch (k) {
        case ' ':
        case 'k':
          return (toggle(), true);
        case 'arrowleft':
          return (seek(time() - (e.shiftKey ? 30_000 : 5_000)), true);
        case 'arrowright':
          return (seek(time() + (e.shiftKey ? 30_000 : 5_000)), true);
        case 'j':
          return (seek(time() - 10_000), true);
        case 'l':
          return (seek(time() + 10_000), true);
        case ',':
          return (step(-1), true);
        case '.':
          return (step(1), true);
        case 'm':
          return ((video.muted = !video.muted), true);
        case 'f':
          return (toggleFullscreen(), true);
        case '[':
          return (nextMark(-1), true);
        case ']':
          return (nextMark(1), true);
        case '+':
        case '=':
          return (zoom(-1), true);
        case '-':
          return (zoom(1), true);
        case 'i':
          return p.cut && p.onCut ? (p.onCut([Math.min(time(), p.cut[1] - 1000), p.cut[1]]), true) : false;
        case 'o':
          return p.cut && p.onCut ? (p.onCut([p.cut[0], Math.max(time(), p.cut[0] + 1000)]), true) : false;
        case 'home':
          return (seek(0), true);
        case 'end':
          return (seek(dur()), true);
      }
      return false;
    })();
    if (handled) {
      e.preventDefault();
      wake();
    }
  };

  const toggleFullscreen = () =>
    document.fullscreenElement ? void document.exitFullscreen() : void root.requestFullscreen().catch(() => {});

  // ---------- zoom ----------
  const zoom = (dir: 1 | -1) => {
    const i = SPANS.findIndex((s) => s >= span());
    const next = SPANS[clamp((i < 0 ? SPANS.length - 1 : i) + dir, 0, SPANS.length - 1)];
    // Zoom around the playhead.
    const now = time();
    const frac = clamp((now - winStart()) / effSpan(), 0, 1);
    setSpan(next);
    setWinStart(clamp(now - frac * Math.min(next, dur()), 0, Math.max(0, dur() - Math.min(next, dur()))));
  };
  const spanLabel = () => {
    const s = effSpan() / 1000;
    return s >= 60 ? t('{n} min', { n: Math.round(s / 60) }) : t('{n} s', { n: Math.round(s) });
  };

  // ---------- lanes ----------
  let overview!: HTMLDivElement;
  let detail: HTMLDivElement | undefined;
  let dragging = false;
  const msOnOverview = (x: number) => {
    const r = overview.getBoundingClientRect();
    return clamp((x - r.left) / r.width, 0, 1) * dur();
  };
  const msOnDetail = (x: number) => {
    const r = detail!.getBoundingClientRect();
    return winStart() + clamp((x - r.left) / r.width, 0, 1) * effSpan();
  };
  const pctAll = (ms: number) => `${(100 * ms) / dur()}%`;
  const pctWin = (ms: number) => `${(100 * (ms - winStart())) / effSpan()}%`;
  const inWin = (ms: number) => ms >= winStart() && ms <= winStart() + effSpan();

  /** Press on a lane: seek (and keep seeking while dragging). */
  const scrub = (toMs: (x: number) => number) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const wasPlaying = !video.paused;
    video.pause();
    dragging = true;
    seek(toMs(e.clientX));
    const move = (ev: PointerEvent) => seek(toMs(ev.clientX));
    const up = () => {
      dragging = false;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (wasPlaying) play();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  /** The bracket on the overview: drag to move the detail window. */
  const dragWindow = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const from = msOnOverview(e.clientX) - winStart();
    const x0 = e.clientX;
    let moved = false;
    dragging = true;
    const move = (ev: PointerEvent) => {
      moved ||= Math.abs(ev.clientX - x0) > 3;
      if (moved) setWinStart(clamp(msOnOverview(ev.clientX) - from, 0, Math.max(0, dur() - effSpan())));
    };
    const up = (ev: PointerEvent) => {
      dragging = false;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      // A click on the bracket (no drag) is a click on the timeline.
      if (!moved) seek(msOnOverview(ev.clientX));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  /** A cut handle, on either lane. */
  const dragHandle = (which: 0 | 1, toMs: (x: number) => number) => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    video.pause();
    dragging = true;
    const move = (ev: PointerEvent) => {
      const c = p.cut;
      if (!c || !p.onCut) return;
      const ms = toMs(ev.clientX);
      p.onCut(which === 0 ? [clamp(ms, 0, c[1] - 1000), c[1]] : [c[0], clamp(ms, c[0] + 1000, dur())]);
      seek(ms);
    };
    const up = () => {
      dragging = false;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey) return zoom(e.deltaY > 0 ? 1 : -1);
    const delta = (e.deltaX || e.deltaY) / Math.max(1, detailWidth());
    setWinStart(clamp(winStart() + delta * effSpan(), 0, Math.max(0, dur() - effSpan())));
  };

  // ---------- pictures ----------
  const thumbAt = (ms: number) => {
    const list = p.thumbs ?? [];
    let best: string | null = null;
    for (const [at, path] of list) {
      if (at > ms + 5000) break;
      best = path;
    }
    return best ?? list[0]?.[1] ?? null;
  };
  const tiles = createMemo(() => {
    if (!p.thumbs?.length) return [];
    const n = Math.max(1, Math.round(detailWidth() / TILE_PX));
    const each = effSpan() / n;
    return Array.from({ length: n }, (_, i) => ({
      at: winStart() + i * each,
      pic: thumbAt(winStart() + (i + 0.5) * each),
    }));
  });
  const ruler = createMemo(() => {
    const s = effSpan();
    const stepMs = RULER_STEPS.find((x) => s / x <= 8) ?? 3_600_000;
    const first = Math.ceil(winStart() / stepMs) * stepMs;
    const out: number[] = [];
    for (let ms = first; ms <= winStart() + s; ms += stepMs) out.push(ms);
    return out;
  });

  return (
    <div
      class="rp"
      classList={{ fullscreen: fullscreen(), idle: idle() && !paused() }}
      ref={root}
      tabIndex={0}
      onKeyDown={onKey}
      onMouseMove={wake}
    >
      <div
        class="rp-stage"
        onClick={() => (root.focus({ preventScroll: true }), toggle())}
        onDblClick={toggleFullscreen}
      >
        <video
          ref={video}
          playsinline
          onPlay={() => {
            setPaused(false);
            setStarted(true);
            setEnded(false);
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(tick);
            wake();
          }}
          onPause={() => {
            setPaused(true);
            setIdle(false);
            cancelAnimationFrame(raf);
            setTime(video.currentTime * 1000);
          }}
          onTimeUpdate={() => paused() && setTime(video.currentTime * 1000)}
          onDurationChange={() =>
            Number.isFinite(video.duration) && video.duration > 0 && setLength(video.duration * 1000)
          }
          onProgress={() =>
            setBuffered(
              Array.from({ length: video.buffered.length }, (_, i) => [
                video.buffered.start(i) * 1000,
                video.buffered.end(i) * 1000,
              ]),
            )
          }
          onVolumeChange={() => {
            setVolume(video.volume);
            setMuted(video.muted);
          }}
          onRateChange={() => setRate(video.playbackRate)}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onCanPlay={() => setWaiting(false)}
          onEnded={() => (setEnded(true), setWaiting(false))}
          onSeeking={() => video.currentTime < video.duration - 0.05 && setEnded(false)}
        />
        <Show when={!started() && paused()}>
          <span class="rp-big-play" aria-hidden="true">
            <I.Play size={30} />
          </span>
        </Show>
        <Show when={waiting() && !paused() && !ended()}>
          <span class="rp-spinner" aria-hidden="true" />
        </Show>
        {/* A click anywhere on the picture (or Space) plays it again from the start. */}
        <Show when={ended()}>
          <span class="rp-replay" aria-hidden="true">
            <I.Refresh size={22} />
            {t('Watch again')}
          </span>
        </Show>
        <div class="rp-controls" onClick={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
          <button
            class="rp-btn"
            aria-label={ended() ? t('Watch again') : paused() ? t('Play') : t('Pause')}
            onClick={toggle}
          >
            <Show when={paused()} fallback={<I.Pause size={20} />}>
              <Show when={ended()} fallback={<I.Play size={20} />}>
                <I.Refresh size={20} />
              </Show>
            </Show>
          </button>
          <button
            class="rp-btn"
            aria-label={t('Back 10 seconds')}
            data-tip={t('Back 10 seconds (J)')}
            onClick={() => seek(time() - 10_000)}
          >
            <I.SeekBack size={18} />
          </button>
          <button
            class="rp-btn"
            aria-label={t('Forward 10 seconds')}
            data-tip={t('Forward 10 seconds (L)')}
            onClick={() => seek(time() + 10_000)}
          >
            <I.SeekForward size={18} />
          </button>
          <span class="rp-time">
            {clock(time())} <span class="rp-time-total">/ {clock(dur())}</span>
          </span>
          <Show when={marks().length}>
            <span class="rp-sep" />
            <button
              class="rp-btn"
              aria-label={t('Previous moment')}
              data-tip={t('Previous moment ([)')}
              onClick={() => nextMark(-1)}
            >
              <I.Chevron size={18} style={{ transform: 'rotate(90deg)' }} />
            </button>
            <button
              class="rp-btn"
              aria-label={t('Next moment')}
              data-tip={t('Next moment (])')}
              onClick={() => nextMark(1)}
            >
              <I.Chevron size={18} style={{ transform: 'rotate(-90deg)' }} />
            </button>
          </Show>
          <span class="grow" />
          <div class="rp-speed">
            <button class="rp-btn rp-text" aria-label={t('Speed')} onClick={() => setSpeedMenu(!speedMenu())}>
              {rate()}×
            </button>
            <Show when={speedMenu()}>
              <div class="rp-menu" role="menu">
                <For each={SPEEDS}>
                  {(s) => (
                    <button
                      role="menuitemradio"
                      aria-checked={rate() === s}
                      classList={{ active: rate() === s }}
                      onClick={() => ((video.playbackRate = s), setSpeedMenu(false))}
                    >
                      {s === 1 ? t('Normal') : `${s}×`}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <VolumeControl
            value={volume()}
            muted={muted()}
            tip={t('Volume')}
            onChange={(v) => {
              video.volume = v;
              video.muted = false;
              setPrefs({ mediaVolume: v });
            }}
            onToggleMute={() => (video.muted = !video.muted)}
          />
          <button
            class="rp-btn"
            aria-label={fullscreen() ? t('Exit fullscreen') : t('Fullscreen')}
            data-tip={t('Fullscreen (F)')}
            onClick={toggleFullscreen}
          >
            <Show when={fullscreen()} fallback={<I.EnterFullscreen size={18} />}>
              <I.ExitFullscreen size={18} />
            </Show>
          </button>
        </div>
      </div>

      <div class="rp-track">
        {/* The whole recording. */}
        <div
          class="rp-overview"
          ref={overview}
          onPointerDown={scrub(msOnOverview)}
          onPointerMove={(e) => setHover({ ms: msOnOverview(e.clientX), lane: 'overview', x: e.clientX })}
          onPointerLeave={() => setHover(null)}
        >
          <div class="rp-rail">
            <For each={buffered()}>
              {([a, b]) => (
                <span class="rp-buffered" style={{ left: pctAll(a), width: `calc(${pctAll(b)} - ${pctAll(a)})` }} />
              )}
            </For>
            <span class="rp-played" style={{ width: pctAll(time()) }} />
          </div>
          <Show when={zoomable() && effSpan() < dur()}>
            <span
              class="rp-window"
              style={{
                left: pctAll(winStart()),
                width: `calc(${pctAll(winStart() + effSpan())} - ${pctAll(winStart())})`,
              }}
              onPointerDown={dragWindow}
            />
          </Show>
          <Show when={p.cut}>
            {(c) => (
              <span
                class="rp-cut"
                style={{ left: pctAll(c()[0]), width: `calc(${pctAll(c()[1])} - ${pctAll(c()[0])})` }}
              >
                <span class="rp-handle start" onPointerDown={dragHandle(0, msOnOverview)} />
                <span class="rp-handle end" onPointerDown={dragHandle(1, msOnOverview)} />
              </span>
            )}
          </Show>
          <For each={marks()}>{(m) => <span class={`rp-mark ${m.kind}`} style={{ left: pctAll(m.ms) }} />}</For>
          <span class="rp-head" style={{ left: pctAll(time()) }} />
        </div>

        {/* Zoomed in around the playhead. */}
        <Show when={zoomable()}>
          <div class="rp-detail-wrap">
            <div
              class="rp-detail"
              ref={(el) => ((detail = el), ro.observe(el))}
              onPointerDown={scrub(msOnDetail)}
              onPointerMove={(e) => setHover({ ms: msOnDetail(e.clientX), lane: 'detail', x: e.clientX })}
              onPointerLeave={() => setHover(null)}
              onWheel={onWheel}
            >
              <div class="rp-strip">
                <For each={tiles()}>
                  {(tile) => (
                    <span class="rp-tile">
                      <Show when={tile.pic}>{(pic) => <img src={pic()} alt="" draggable={false} />}</Show>
                    </span>
                  )}
                </For>
              </div>
              <div class="rp-ruler">
                <For each={ruler()}>
                  {(ms) => (
                    <span class="rp-tick" style={{ left: pctWin(ms) }}>
                      {clock(ms)}
                    </span>
                  )}
                </For>
              </div>
              <Show when={p.cut}>
                {(c) => (
                  <span
                    class="rp-cut detail"
                    style={{
                      left: pctWin(Math.max(c()[0], winStart())),
                      width: `calc(${pctWin(Math.min(c()[1], winStart() + effSpan()))} - ${pctWin(Math.max(c()[0], winStart()))})`,
                    }}
                  >
                    <Show when={inWin(c()[0])}>
                      <span class="rp-handle start" onPointerDown={dragHandle(0, msOnDetail)} />
                    </Show>
                    <Show when={inWin(c()[1])}>
                      <span class="rp-handle end" onPointerDown={dragHandle(1, msOnDetail)} />
                    </Show>
                  </span>
                )}
              </Show>
              <For each={marks().filter((m) => inWin(m.ms))}>
                {(m) => (
                  <span
                    class={`rp-flag ${m.kind}`}
                    style={{ left: pctWin(m.ms) }}
                    data-tip={`${markText(m)} · ${clock(m.ms)}`}
                    onPointerDown={(e) => (e.stopPropagation(), seek(Math.max(0, m.ms - 3000)))}
                  />
                )}
              </For>
              <Show when={inWin(time())}>
                <span class="rp-head detail" style={{ left: pctWin(time()) }} />
              </Show>
            </div>
            <div class="rp-zoom">
              <button
                class="rp-btn small"
                aria-label={t('Zoom out')}
                data-tip={t('Zoom out (-)')}
                onClick={() => zoom(1)}
              >
                <I.ZoomOut size={16} />
              </button>
              <span>{spanLabel()}</span>
              <button
                class="rp-btn small"
                aria-label={t('Zoom in')}
                data-tip={t('Zoom in (+)')}
                onClick={() => zoom(-1)}
              >
                <I.ZoomIn size={16} />
              </button>
            </div>
          </div>
        </Show>

        <Show when={hover()}>
          {(h) => (
            <HoverPicture
              x={h().x}
              root={root}
              ms={h().ms}
              pic={p.thumbs?.length ? thumbAt(h().ms) : null}
              url={'url' in p.source ? p.source.url : null}
              mark={marks().find((m) => Math.abs(m.ms - h().ms) < (h().lane === 'detail' ? effSpan() : dur()) / 120)}
            />
          )}
        </Show>
      </div>
    </div>
  );
}

/** The picture above the lanes for the moment under the mouse: a VOD's thumbnail, or a frame of a file. */
function HoverPicture(p: {
  x: number;
  root: HTMLElement;
  ms: number;
  pic: string | null;
  url: string | null;
  mark?: Mark;
}) {
  const left = () => {
    const r = p.root.getBoundingClientRect();
    return clamp(p.x - r.left, 90, r.width - 90);
  };
  return (
    <div class="rp-hover" style={{ left: `${left()}px` }}>
      <Show when={p.pic} fallback={<Show when={p.url}>{(url) => <FramePicture url={url()} ms={p.ms} />}</Show>}>
        {(pic) => <img src={pic()} alt="" />}
      </Show>
      <span class="rp-hover-time">
        <Show when={p.mark}>{(m) => <strong>{markText(m())}</strong>}</Show>
        {clock(p.ms)}
      </span>
    </div>
  );
}

/** One frame of a file at `ms`, from a hidden copy of the video (seeks at most once per frame of the mouse). */
function FramePicture(p: { url: string; ms: number }) {
  let canvas!: HTMLCanvasElement;
  const probe = document.createElement('video');
  probe.muted = true;
  probe.preload = 'auto';
  probe.src = p.url;
  let pending: number | null = null;
  let busy = false;
  const draw = () => {
    const ctx = canvas?.getContext('2d');
    if (ctx && probe.videoWidth) ctx.drawImage(probe, 0, 0, canvas.width, canvas.height);
    busy = false;
    if (pending !== null) go(pending);
  };
  const go = (ms: number) => {
    if (busy) return void (pending = ms);
    pending = null;
    busy = true;
    probe.currentTime = ms / 1000;
  };
  probe.addEventListener('seeked', draw);
  probe.addEventListener('loadeddata', () => go(p.ms), { once: true });
  createEffect(() => probe.readyState >= 2 && go(p.ms));
  onCleanup(() => {
    probe.removeEventListener('seeked', draw);
    probe.removeAttribute('src');
    probe.load();
  });
  return <canvas ref={canvas} width={192} height={108} />;
}
