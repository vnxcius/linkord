// The Christmas theme's falling snow (the lights and snow on the panels are plain CSS, see styles.css). Pottira often
// runs beside a game, so this costs nothing unless you're looking at it: it stops drawing while the window is hidden
// or unfocused, and stays away from calls so it never falls over someone's stream.
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { countdown } from '../lib/holidays';
import { t } from '../lib/i18n';
import { prefs } from '../lib/prefs';
import { currentChannel } from '../lib/store';
import { Kind } from '../lib/types';
import { isMobile, ui } from '../lib/ui';

const FRAME_MS = 1000 / 30;

interface Flake {
  x: number;
  y: number;
  r: number;
  alpha: number;
  fall: number;
  sway: number;
  phase: number;
}

export function Snow(p: { awake: boolean }) {
  let canvas!: HTMLCanvasElement;
  let raf = 0;
  let last = 0;
  let flakes: Flake[] = [];

  const flake = (w: number, h: number, anywhere: boolean): Flake => {
    const near = Math.random();
    return {
      x: Math.random() * w,
      y: anywhere ? Math.random() * h : -6,
      r: 0.9 + near * 1.7,
      alpha: 0.18 + near * 0.42,
      fall: 12 + near * 26,
      sway: 6 + Math.random() * 14,
      phase: Math.random() * Math.PI * 2,
    };
  };

  const size = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (now - last < FRAME_MS) return;
    const dt = Math.min(now - last, 100) / 1000;
    last = now;
    const { width: w, height: h } = canvas;
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#fff';
    flakes.forEach((f, i) => {
      f.y += f.fall * dt;
      f.phase += dt * 0.8;
      if (f.y > h + 6) flakes[i] = flake(w, h, false);
      g.globalAlpha = f.alpha;
      g.beginPath();
      g.arc(f.x + Math.sin(f.phase) * f.sway, f.y, f.r, 0, Math.PI * 2);
      g.fill();
    });
  };

  onMount(() => {
    size();
    window.addEventListener('resize', size);
    flakes = Array.from({ length: isMobile() ? 22 : 46 }, () => flake(canvas.width, canvas.height, true));
  });
  createEffect(() => {
    cancelAnimationFrame(raf);
    raf = 0;
    if (p.awake) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  });
  onCleanup(() => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', size);
  });
  return <canvas ref={canvas} class="xmas-snow" aria-hidden="true" />;
}

/** Days to Christmas and New Year, in a strip of its own under the header so it can't get lost among the decorations. */
export function HolidayCountdown() {
  return (
    <Show when={countdown()}>
      {(both) => (
        <div class="xmas-countdown" role="timer">
          <For each={both()}>
            {(c) => (
              <span class="xmas-countdown-item" classList={{ soon: c.soon }}>
                <span class="xmas-countdown-icon" aria-hidden="true">
                  {c.holiday === 'christmas' ? '🎄' : '🎆'}
                </span>
                {c.holiday === 'christmas' ? t('Christmas in') : t('New Year in')} <strong>{c.left}</strong>
              </span>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}

const PILE_FULL_MS = 60 * 60_000;
const PILE_STEP_MS = 20_000;
const [pile, setPile] = createSignal(0);

/** Snow slowly builds up behind the message box while you're here. Click it to clear it. */
export function SnowPile() {
  const on = () => prefs.theme === 'christmas' && prefs.christmasSnow && currentChannel()?.kind !== Kind.Voice;
  const timer = setInterval(() => {
    if (on() && document.visibilityState === 'visible' && document.hasFocus())
      setPile((v) => Math.min(1, v + PILE_STEP_MS / PILE_FULL_MS));
  }, PILE_STEP_MS);
  onCleanup(() => clearInterval(timer));
  return (
    <Show when={on()}>
      <div
        class="xmas-pile"
        classList={{ cleared: pile() === 0 }}
        style={{ '--pile': pile() }}
        aria-hidden="true"
        onClick={() => setPile(0)}
      />
    </Show>
  );
}

export function ChristmasDecor() {
  const awakeNow = () => document.visibilityState === 'visible' && document.hasFocus();
  const [awake, setAwake] = createSignal(awakeNow());
  const update = () => setAwake(awakeNow());
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  const [reduced, setReduced] = createSignal(calm.matches);
  const onCalm = (e: MediaQueryListEvent) => setReduced(e.matches);

  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  calm.addEventListener('change', onCalm);
  onCleanup(() => {
    window.removeEventListener('focus', update);
    window.removeEventListener('blur', update);
    document.removeEventListener('visibilitychange', update);
    calm.removeEventListener('change', onCalm);
    document.documentElement.classList.remove('xmas-idle');
  });
  // The string lights twinkle with a CSS animation: it rests along with the snow.
  createEffect(() => document.documentElement.classList.toggle('xmas-idle', !awake()));
  createEffect(() => document.documentElement.classList.toggle('xmas-hats', prefs.christmasHats));
  onCleanup(() => document.documentElement.classList.remove('xmas-hats'));

  // A full profile covers the call, so it can snow on that.
  const inCall = () => currentChannel()?.kind === Kind.Voice && ui.modal?.type !== 'user-profile';
  return (
    <Show when={prefs.christmasSnow && !reduced() && !inCall()}>
      <Snow awake={awake()} />
    </Show>
  );
}
