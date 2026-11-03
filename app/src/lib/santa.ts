// Santa crosses the top of the window every so often. Clicking him scores a catch and sets off confetti. He only exists while
// he's flying: one animated element that's removed when he lands. "Send Santa now" (Settings -> Appearance) comes here too.
import { createEffect, createRoot, onCleanup } from 'solid-js';
import santaSvg from '../assets/santa.svg?raw';
import { confetti } from './confetti';
import { t } from './i18n';
import { prefs, setPrefs } from './prefs';
import { isChristmas } from './theme';
import { toast, ui } from './ui';
import { voiceUi } from './voice';

const FLIGHT_MS = 11_000;
const MIN_WAIT_MS = 15 * 60_000;
const MAX_WAIT_MS = 45 * 60_000;
const RETRY_MS = 60_000;

let flying = false;

export function flySanta() {
  if (flying) return;
  flying = true;
  const el = document.createElement('button');
  el.className = 'santa';
  el.tabIndex = -1;
  el.setAttribute('aria-label', 'Santa');
  el.innerHTML = santaSvg;
  document.body.append(el);

  // Each trip takes a slightly different line, and half of them go the other way.
  const w = window.innerWidth;
  const width = 190;
  const ltr = Math.random() < 0.5;
  el.classList.toggle('flip', !ltr);
  const [from, to] = ltr ? [-width - 20, w + 20] : [w + 20, -width - 20];
  const base = 34 + Math.random() * 50;
  const steps = 8;
  const frames = Array.from({ length: steps + 1 }, (_, i) => {
    const k = i / steps;
    return { transform: `translate(${from + (to - from) * k}px, ${base + Math.sin(k * Math.PI * 3) * 16}px)` };
  });
  const flight = el.animate(frames, { duration: FLIGHT_MS, easing: 'linear' });
  flight.finished
    .catch(() => {})
    .finally(() => {
      el.remove();
      flying = false;
    });

  el.addEventListener(
    'click',
    () => {
      const caught = prefs.santaCaught + 1;
      setPrefs({ santaCaught: caught });
      toast(t('You caught Santa! ({n} so far)', { n: caught }));
      confetti(1);
      // Off he goes, in a hurry.
      flight.playbackRate = 5;
      el.classList.add('caught');
    },
    { once: true },
  );
}

export function initSanta() {
  createRoot(() =>
    createEffect(() => {
      if (!isChristmas() || !prefs.christmasSanta) return;
      let timer: ReturnType<typeof setTimeout>;
      const wait = () => MIN_WAIT_MS + Math.random() * (MAX_WAIT_MS - MIN_WAIT_MS);
      const due = () => {
        // Not while you're somewhere else, in a call or with Settings or a dialog open: he waits a minute and looks again.
        const free =
          document.visibilityState === 'visible' &&
          document.hasFocus() &&
          !voiceUi.channelId &&
          !ui.modal &&
          !matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (free) flySanta();
        timer = setTimeout(due, free ? wait() : RETRY_MS);
      };
      timer = setTimeout(due, wait());
      onCleanup(() => clearTimeout(timer));
    }),
  );
}
