// Voice messages, WhatsApp-style. In the composer: hold the mic to record and release to send, slide
// left to cancel, slide up to lock; a mouse click starts a locked (hands-free) recording like WhatsApp
// Web. Locked: discard, pause to listen back, resume, send. In chat: a bubble with play/pause, a
// seekable waveform, the time, and a speed button (1×/1.5×/2×) in place of the avatar while playing.

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { t } from '../lib/i18n';
import { state } from '../lib/store';
import type { Attachment, User } from '../lib/types';
import { toast } from '../lib/ui';
import {
  BARS,
  decodeWaveform,
  MIN_MS,
  packWaveform,
  startRecording,
  type Recorder,
  type VoiceClip,
} from '../lib/voice-note';
import { Avatar } from './Avatar';
import * as I from './Icons';
import { pauseChatVideo, formatDuration } from './VideoPlayer';

const CANCEL_PX = 110;
const LOCK_PX = 70;
/** A press shorter than this is a click (mouse: start hands-free) or a tap (touch: show the hint). */
const TAP_MS = 350;

// ---------- recording ----------

export function createVoiceRecording(send: (clip: VoiceClip) => void) {
  const [rec, setRec] = createSignal<Recorder | null>(null);
  const [locked, setLocked] = createSignal(false);
  const [drag, setDrag] = createSignal({ x: 0, y: 0 });
  const [starting, setStarting] = createSignal(false);
  let held = false;
  let downAt = 0;
  let origin = { x: 0, y: 0 };
  let pointerType = 'mouse';

  const reset = () => {
    setRec(null);
    setLocked(false);
    setDrag({ x: 0, y: 0 });
  };
  const cancel = () => {
    rec()?.cancel();
    reset();
  };
  const finish = async () => {
    const r = rec();
    if (!r) return;
    reset();
    const clip = await r.finish();
    if (clip.duration * 1000 < MIN_MS) return;
    send(clip);
  };
  const lock = () => {
    setLocked(true);
    setDrag({ x: 0, y: 0 });
  };
  /** Release (or a click/tap) after recording has started. */
  const released = () => {
    if (!rec() || locked()) return;
    if (performance.now() - downAt >= TAP_MS) return void finish();
    if (pointerType === 'mouse') return lock();
    cancel();
    toast(t('Hold to record, release to send'));
  };

  const onPointerDown = async (e: PointerEvent) => {
    if (e.button !== 0 || rec() || starting()) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    held = true;
    downAt = performance.now();
    origin = { x: e.clientX, y: e.clientY };
    pointerType = e.pointerType;
    setStarting(true);
    try {
      const r = await startRecording();
      r.onLimit = () => void finish();
      setRec(r);
      navigator.vibrate?.(25);
    } catch {
      toast(t("Pottira can't use your microphone. Check your browser or system permissions."));
      return;
    } finally {
      setStarting(false);
    }
    // Let go while the mic was opening (e.g. a permission prompt): treat it as a click.
    if (!held) released();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!held || !rec() || locked()) return;
    const x = Math.min(0, e.clientX - origin.x);
    const y = Math.min(0, e.clientY - origin.y);
    if (x < -CANCEL_PX) {
      held = false;
      return cancel();
    }
    if (y < -LOCK_PX) return lock();
    // Follow the finger along one axis at a time, like WhatsApp.
    setDrag(Math.abs(x) > Math.abs(y) ? { x, y: 0 } : { x: 0, y });
  };
  const onPointerUp = () => {
    if (!held) return;
    held = false;
    released();
  };

  // Keyboard while hands-free: Enter sends, Escape discards.
  const onKey = (e: KeyboardEvent) => {
    if (!rec() || !locked()) return;
    if (e.key === 'Escape') cancel();
    else if (e.key === 'Enter') void finish();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);
  onCleanup(() => {
    window.removeEventListener('keydown', onKey, true);
    rec()?.cancel();
  });

  return {
    rec,
    locked,
    drag,
    starting,
    cancel,
    finish,
    micProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp },
  };
}

export type VoiceRecording = ReturnType<typeof createVoiceRecording>;

/** Replaces the composer's text row while recording. */
export function RecordingBar(p: { v: VoiceRecording }) {
  const r = () => p.v.rec()!;
  const time = () => formatDuration(r().elapsed() / 1000);
  const live = () => r().levels().slice(-40);

  // Listening back while paused.
  let audio: HTMLAudioElement | undefined;
  let url: string | undefined;
  const [previewing, setPreviewing] = createSignal(false);
  const [previewAt, setPreviewAt] = createSignal(0);
  const stopPreview = () => {
    audio?.pause();
    setPreviewing(false);
  };
  const togglePreview = async () => {
    if (previewing()) return stopPreview();
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(await r().snapshot());
    audio = new Audio(url);
    audio.ontimeupdate = () => setPreviewAt(audio!.currentTime);
    audio.onended = () => (setPreviewing(false), setPreviewAt(0));
    pauseActive();
    audio.currentTime = Math.min(previewAt(), r().elapsed() / 1000 - 0.05);
    void audio.play();
    setPreviewing(true);
  };
  createEffect(() => {
    if (!r().paused()) {
      stopPreview();
      setPreviewAt(0);
    }
  });
  onCleanup(() => {
    stopPreview();
    if (url) URL.revokeObjectURL(url);
  });
  const recorded = createMemo(() => (r().paused() ? [...packWaveform(r().levels(), BARS)].map((v) => v / 255) : []));

  return (
    <Show
      when={p.v.locked()}
      fallback={
        // Holding: timer, "slide to cancel" that follows the finger, and the lock above the mic.
        <div class="rec-bar holding">
          <span class="rec-dot" />
          <span class="rec-time">{time()}</span>
          <span
            class="rec-slide"
            style={{ transform: `translateX(${p.v.drag().x}px)`, opacity: 1 + p.v.drag().x / CANCEL_PX }}
          >
            <I.Back size={16} /> {t('Slide to cancel')}
          </span>
          <div class="rec-lock" style={{ transform: `translateY(${Math.max(-LOCK_PX, p.v.drag().y) * 0.6}px)` }}>
            <I.Lock size={16} />
            <I.ChevronUpIcon size={14} />
          </div>
        </div>
      }
    >
      <div class="rec-bar locked">
        <button class="icon-btn rec-trash" aria-label={t('Discard')} data-tip={t('Discard')} onClick={p.v.cancel}>
          <I.Trash size={20} />
        </button>
        <Show
          when={r().paused()}
          fallback={
            <>
              <span class="rec-dot" />
              <span class="rec-time">{time()}</span>
              <div class="rec-live">
                <For each={live()}>{(l) => <span style={{ height: `${Math.max(8, l * 100)}%` }} />}</For>
              </div>
            </>
          }
        >
          <button
            class="icon-btn rec-play"
            aria-label={previewing() ? t('Pause') : t('Play')}
            onClick={() => void togglePreview()}
          >
            <Show when={previewing()} fallback={<I.Play size={18} />}>
              <I.Pause size={18} />
            </Show>
          </button>
          <Waveform levels={recorded()} progress={previewAt() / (r().elapsed() / 1000 || 1)} />
          <span class="rec-time">
            {formatDuration(previewing() || previewAt() ? previewAt() : r().elapsed() / 1000)}
          </span>
        </Show>
        <button
          class="icon-btn rec-pause"
          aria-label={r().paused() ? t('Resume recording') : t('Pause recording')}
          data-tip={r().paused() ? t('Resume recording') : t('Pause recording')}
          onClick={() => (r().paused() ? r().resume() : r().pause())}
        >
          <Show when={r().paused()} fallback={<I.Pause size={20} />}>
            <I.Mic size={20} />
          </Show>
        </button>
        <button class="rec-send" aria-label={t('Send')} data-tip={t('Send')} onClick={() => void p.v.finish()}>
          <I.Send size={20} />
        </button>
      </div>
    </Show>
  );
}

// ---------- playback ----------

const PLAYED_KEY = 'pottira.playedVoice';
const SPEED_KEY = 'pottira.voiceSpeed';
const SPEEDS = [1, 1.5, 2];

function loadPlayed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(PLAYED_KEY) ?? '[]');
  } catch {
    return [];
  }
}
const [played, setPlayed] = createSignal(new Set(loadPlayed()));
function markPlayed(id: string) {
  if (played().has(id)) return;
  const next = new Set(played()).add(id);
  setPlayed(next);
  try {
    localStorage.setItem(PLAYED_KEY, JSON.stringify([...next].slice(-1000)));
  } catch {}
}

const [speed, setSpeedSignal] = createSignal(
  Number(
    (() => {
      try {
        return localStorage.getItem(SPEED_KEY);
      } catch {
        return null;
      }
    })(),
  ) || 1,
);
const setSpeed = (s: number) => {
  setSpeedSignal(s);
  try {
    localStorage.setItem(SPEED_KEY, String(s));
  } catch {}
};

/** One voice message plays at a time; when it ends the next one right after it starts, like WhatsApp. */
let active: HTMLAudioElement | null = null;
const players = new Map<string, () => void>();
const pauseActive = () => active?.pause();

function playNextAfter(channelId: string, messageId: string) {
  const list = state.messages[channelId]?.list ?? [];
  const next = list[list.findIndex((m) => m.id === messageId) + 1];
  const a = next?.attachments[0];
  if (a?.waveform) players.get(a.id)?.();
}

function Waveform(p: { levels: number[]; progress: number; onSeek?: (f: number) => void }) {
  let el!: HTMLDivElement;
  const at = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const bars = () => (p.levels.length ? p.levels : Array(BARS).fill(0.15));
  return (
    <div
      class="vn-wave"
      classList={{ seekable: !!p.onSeek }}
      ref={el}
      onPointerDown={(e) => {
        if (!p.onSeek) return;
        el.setPointerCapture(e.pointerId);
        p.onSeek(at(e));
      }}
      onPointerMove={(e) => p.onSeek && e.buttons & 1 && p.onSeek(at(e))}
    >
      <For each={bars()}>
        {(l, i) => (
          <span
            classList={{ on: (i() + 0.5) / bars().length <= p.progress }}
            style={{ height: `${Math.max(10, l * 100)}%` }}
          />
        )}
      </For>
      <Show when={p.onSeek}>
        <span class="vn-thumb" style={{ left: `${Math.min(1, p.progress) * 100}%` }} />
      </Show>
    </div>
  );
}

export function VoiceMessage(p: { a: Attachment; src: string; author: User; channelId: string; messageId: string }) {
  let audio!: HTMLAudioElement;
  const duration = () => p.a.duration_secs ?? 0;
  const levels = createMemo(() => decodeWaveform(p.a.waveform));
  const [playing, setPlaying] = createSignal(false);
  const [time, setTime] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const mine = () => p.author.id === state.me?.id;
  const heard = () => mine() || played().has(p.a.id);

  let raf = 0;
  const tick = () => {
    setTime(audio.currentTime);
    raf = requestAnimationFrame(tick);
  };
  const play = () => {
    if (active && active !== audio) active.pause();
    pauseChatVideo();
    audio.playbackRate = speed();
    setLoading(audio.readyState < 2);
    void audio.play().catch(() => setLoading(false));
  };
  const toggle = () => (audio.paused ? play() : audio.pause());
  const seek = (f: number) => {
    const d = Number.isFinite(audio.duration) ? audio.duration : duration();
    audio.currentTime = f * d;
    setTime(audio.currentTime);
  };
  players.set(p.a.id, play);
  onCleanup(() => {
    players.delete(p.a.id);
    cancelAnimationFrame(raf);
    if (active === audio) active = null;
  });
  createEffect(() => audio && (audio.playbackRate = speed()));

  const progress = () => time() / (duration() || 1);
  return (
    <div class="voice-note" classList={{ playing: playing(), mine: mine() }}>
      <button class="vn-play" aria-label={playing() ? t('Pause') : t('Play')} onClick={toggle}>
        <Show
          when={loading()}
          fallback={
            <Show when={playing()} fallback={<I.Play size={20} />}>
              <I.Pause size={20} />
            </Show>
          }
        >
          <span class="spinner small" />
        </Show>
      </button>
      <div class="vn-body">
        <Waveform levels={levels()} progress={progress()} onSeek={seek} />
        <span class="vn-time">{formatDuration(playing() || time() > 0 ? time() : duration())}</span>
      </div>
      <Show
        when={playing()}
        fallback={
          <div class="vn-avatar">
            <Avatar user={p.author} size={40} />
            <span class="vn-mic" classList={{ heard: heard() }}>
              <I.Mic size={13} />
            </span>
          </div>
        }
      >
        <button
          class="vn-speed"
          aria-label={t('Playback speed')}
          onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed()) + 1) % SPEEDS.length])}
        >
          {speed()}×
        </button>
      </Show>
      <audio
        ref={audio}
        src={p.src}
        preload="metadata"
        onPlay={() => {
          active = audio;
          setPlaying(true);
          markPlayed(p.a.id);
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(tick);
        }}
        onPlaying={() => setLoading(false)}
        onPause={() => {
          setPlaying(false);
          setLoading(false);
          cancelAnimationFrame(raf);
          setTime(audio.currentTime);
        }}
        onEnded={() => {
          setTime(0);
          audio.currentTime = 0;
          playNextAfter(p.channelId, p.messageId);
        }}
      />
    </div>
  );
}
