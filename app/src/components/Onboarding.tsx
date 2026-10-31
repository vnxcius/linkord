// Onboarding (1.0). New accounts get a guided tour of the app: a spotlight on each part of the window with a card
// beside it, plus cards with screenshots for what has no fixed place (calls, Kass, watch together, soundboard).
// Accounts that existed before 1.0 (migration 0017 marked them tour_done) get the "Version 1.0 is here!" dialog
// instead, with confetti, a fanfare and the highlights. Both are remembered per account in the synced settings
// (tour_done, release_seen); Settings has links to see either again.
import { createEffect, createSignal, For, type JSX, on, onCleanup, onMount, Show } from 'solid-js';
import { patchSettings, selectView } from '../lib/actions';
import { msg, t } from '../lib/i18n';
import { confetti } from '../lib/confetti';
import { page } from '../lib/route';
import { sounds } from '../lib/sounds';
import { displayName } from '../lib/types';
import { state } from '../lib/store';
import { isMobile, ui } from '../lib/ui';
import * as I from './Icons';
import { Emblem } from './Icons';
import shotLook from '../assets/whats-new/look.webp';
import shotCall from '../assets/whats-new/call.webp';
import shotWatch from '../assets/whats-new/watch.webp';
import shotKass from '../assets/whats-new/kass.webp';
import shotSoundboard from '../assets/whats-new/soundboard.webp';
import shotDmCall from '../assets/whats-new/dm-call.webp';
import shotStats from '../assets/whats-new/stats.webp';

/** The release whose "what's new" dialog existing accounts see once. */
export const RELEASE = '1.0.0';

const [mode, setMode] = createSignal<'tour' | 'release' | null>(null);
/** Settings → "Take the tour" / "What's new in 1.0". */
export const startTour = () => setMode('tour');
export const showRelease = () => setMode('release');

/** Decides once per launch, after the app has settled: the tour, the 1.0 dialog or nothing. */
export function Onboarding() {
  let decided = false;
  let timer: number | undefined;
  createEffect(() => {
    if (decided || !state.ready || !state.me || state.me.needs_username || ui.modal || page()) return;
    const s = state.settings;
    if (s.tour_done && s.release_seen === RELEASE) return void (decided = true);
    // A moment for the layout (and an invite dialog after login) before taking over the window.
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (decided || ui.modal || page()) return;
      decided = true;
      setMode(state.settings.tour_done ? 'release' : 'tour');
    }, 700);
  });
  onCleanup(() => clearTimeout(timer));
  return (
    <>
      <Show when={mode() === 'tour'}>
        <Tour />
      </Show>
      <Show when={mode() === 'release'}>
        <Release />
      </Show>
    </>
  );
}

// ---------- the highlights (dialog slides and tour cards share them) ----------

interface Feature {
  id: string;
  title: string;
  text: string;
  shot: string;
}

const FEATURES: Feature[] = [
  {
    id: 'look',
    title: msg('A look of its own'),
    text: msg(
      'Three panels on a darker desk: channels numbered like a table of contents, the chat as a page, and people, pins and search in the margin beside it.',
    ),
    shot: shotLook,
  },
  {
    id: 'watch',
    title: msg('Watch together'),
    text: msg(
      'Share a YouTube, Twitch or Kick link in a call and everyone watches in sync. People join when they want, with theater mode, fullscreen and a pop-out player.',
    ),
    shot: shotWatch,
  },
  {
    id: 'kass',
    title: msg('Kass, the music bot'),
    text: msg(
      'Type /play with a YouTube or Spotify link, or just the name of a song, and Kass joins your call. /skip, /pause, /queue and /stop do the rest.',
    ),
    shot: shotKass,
  },
  {
    id: 'soundboard',
    title: msg('Soundboard'),
    text: msg(
      'Quick sounds for the call. Upload your own, trim them on the waveform and give each one an emoji. Everyone hears it at once.',
    ),
    shot: shotSoundboard,
  },
  {
    id: 'calls',
    title: msg('Calls in DMs'),
    text: msg(
      'Call a friend or a whole group from their DM. It rings on their side, and camera and screen sharing work there too.',
    ),
    shot: shotDmCall,
  },
  {
    id: 'stats',
    title: msg('Your stats'),
    text: msg(
      "Messages, words, favorite emoji, hours in voice, streams and the hours you're most active. In Settings, under Stats.",
    ),
    shot: shotStats,
  },
];

const MORE = [
  msg('Ctrl+K quick switcher'),
  msg('Voice messages'),
  msg('Spellcheck'),
  msg('Custom status'),
  msg('Stream previews'),
  msg('Animated avatars'),
  msg('Nameplates'),
  msg('Pick your username'),
];

const feature = (id: string) => FEATURES.find((f) => f.id === id)!;

// ---------- "Version 1.0 is here!" ----------

const SLIDE_MS = 7000;

function Release() {
  const [index, setIndex] = createSignal(0);
  /** Slides move on by themselves until you pick one. */
  const [auto, setAuto] = createSignal(true);
  const [paused, setPaused] = createSignal(false);
  const current = () => FEATURES[index()];
  const close = (tour = false) => {
    void patchSettings({ release_seen: RELEASE }).catch(() => {});
    setMode(tour ? 'tour' : null);
  };
  const pick = (i: number) => {
    setAuto(false);
    setIndex((i + FEATURES.length) % FEATURES.length);
  };

  let stopConfetti: (() => void) | undefined;
  let stopFanfare: (() => void) | undefined;
  onMount(() => {
    // Preload every screenshot so switching slides never shows an empty frame.
    for (const f of FEATURES) new Image().src = f.shot;
    stopFanfare = sounds.fanfare();
    stopConfetti = confetti();
  });
  onCleanup(() => {
    stopFanfare?.();
    stopConfetti?.();
  });

  let timer: number | undefined;
  createEffect(
    on([index, auto, paused], () => {
      clearTimeout(timer);
      if (auto() && !paused()) timer = window.setTimeout(() => setIndex((i) => (i + 1) % FEATURES.length), SLIDE_MS);
    }),
  );
  onCleanup(() => clearTimeout(timer));

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') pick(index() + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') pick(index() - 1);
    else return;
    e.preventDefault();
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));

  return (
    <div class="modal-backdrop release-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="modal release" role="dialog" aria-modal="true" aria-label={t('Version 1.0 is here!')}>
        <button class="icon-btn modal-close" aria-label={t('Close')} onClick={() => close()}>
          <I.Close size={18} />
        </button>
        <header class="release-head">
          <div class="release-emblem">
            <Emblem size={52} />
          </div>
          <div>
            <p class="showcase-kicker">{t('Linkord {version}', { version: '1.0' })}</p>
            <h2>{t('Version 1.0 is here!')}</h2>
            <p class="muted">
              {t('Thanks for being here since the early days, {name}. This is what came with it.', {
                name: displayName(state.me),
              })}
            </p>
          </div>
        </header>
        <div class="release-body" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
          <ol class="release-list" role="tablist" aria-label={t("What's new")}>
            <For each={FEATURES}>
              {(f, i) => (
                <li>
                  <button
                    role="tab"
                    aria-selected={index() === i()}
                    classList={{ active: index() === i() }}
                    onClick={() => pick(i())}
                    ref={(el) =>
                      // Phones show the list as a row of tabs: keep the current one in view as the slides move on.
                      createEffect(
                        () =>
                          index() === i() && isMobile() && el.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
                      )
                    }
                  >
                    <span class="release-num">{String(i() + 1).padStart(2, '0')}</span>
                    <span class="release-name">{t(f.title)}</span>
                    <Show when={index() === i() && auto()}>
                      {/* Keyed on the slide, so the bar starts over each time. */}
                      <Show when={current()} keyed>
                        <i
                          class="release-progress"
                          classList={{ paused: paused() }}
                          style={{ '--slide': `${SLIDE_MS}ms` }}
                        />
                      </Show>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ol>
          <Show when={current()} keyed>
            {(f) => (
              <figure class="release-slide" role="tabpanel">
                <div class="release-shot">
                  <img src={f.shot} alt={t(f.title)} draggable={false} />
                </div>
                <figcaption>
                  <h3>{t(f.title)}</h3>
                  <p>{t(f.text)}</p>
                </figcaption>
              </figure>
            )}
          </Show>
        </div>
        <div class="release-more">
          <span class="kicker">{t('And also')}</span>
          <For each={MORE}>{(m) => <span class="release-chip">{t(m)}</span>}</For>
        </div>
        <div class="modal-footer release-foot">
          <button class="btn ghost" onClick={() => close(true)}>
            <I.Compass size={16} /> {t('Take the tour')}
          </button>
          <span class="grow" />
          <button class="btn primary" onClick={() => close()}>
            {t("Let's go")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- the tour ----------

interface Step {
  title: string;
  text: string;
  /** The part of the window to point at; without one (or when it isn't on screen) the card sits in the middle. */
  target?: string;
  shot?: string;
  /** Keys to show as keycaps under the text. */
  keys?: string[];
  hero?: boolean;
}

const STEPS: Step[] = [
  {
    hero: true,
    title: msg('Welcome to Linkord'),
    text: msg("Here's a quick look at where everything is. It takes a minute, and you can leave whenever you like."),
  },
  {
    target: '.rail',
    title: msg('Your servers'),
    text: msg(
      'Your servers line up here. The emblem opens your friends and direct messages, and + creates a server or joins one with an invite link.',
    ),
  },
  {
    target: '.sidebar .channel-list',
    title: msg('Channels'),
    text: msg(
      "Text channels are numbered like a table of contents. Voice channels show who's in the call; click one to join.",
    ),
  },
  {
    shot: shotCall,
    title: msg('Voice, video and your screen'),
    text: msg(
      "Calls need no setup. Turn on your camera, go live with a window or a game (sound included) and click Watch on a friend's stream.",
    ),
  },
  {
    target: '.dock .user-panel',
    title: msg("That's you"),
    text: msg('Mute, deafen and your settings. Click your name to set a status or edit your profile.'),
  },
  {
    target: '.composer',
    title: msg('Say something'),
    text: msg(
      'Send files, emoji and voice messages (the mic button). Type / for commands, @ to mention someone and : for emoji.',
    ),
  },
  {
    target: '.margin',
    title: msg('The margin'),
    text: msg('People, pinned messages and search sit beside the chat. Right-click almost anything for more options.'),
  },
  { shot: shotKass, title: feature('kass').title, text: feature('kass').text },
  { shot: shotWatch, title: feature('watch').title, text: feature('watch').text },
  { shot: shotSoundboard, title: feature('soundboard').title, text: feature('soundboard').text },
  {
    keys: ['Ctrl', 'K'],
    title: msg('Jump anywhere'),
    text: msg('Ctrl+K finds any person, channel, server or message. Alt+↑ and Alt+↓ move between channels.'),
  },
  {
    target: '.user-panel [aria-label="Settings"]',
    title: msg('Make it yours'),
    text: msg(
      'Keybinds (push to talk works inside games in the desktop app), mic and camera, notifications, profile, nameplate and language.',
    ),
  },
  {
    hero: true,
    title: msg("You're all set"),
    text: msg('Have fun, traveler. You can take this tour again from Settings.'),
  },
];

const CARD_W = 340;
const GAP = 14;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function Tour() {
  const [index, setIndex] = createSignal(0);
  const [rect, setRect] = createSignal<Rect | null>(null);
  const [cardH, setCardH] = createSignal(220);
  const step = () => STEPS[index()];
  const last = () => index() === STEPS.length - 1;
  // Phones show one pane at a time: the cards stay in the middle there.
  const anchored = () => !isMobile() && !!rect();

  const finish = () => {
    void patchSettings({ tour_done: true, release_seen: RELEASE }).catch(() => {});
    setMode(null);
  };
  const go = (d: number) => {
    const i = index() + d;
    if (i >= STEPS.length) return finish();
    if (i >= 0) setIndex(i);
  };

  onMount(() => {
    // Show a server rather than the empty home page, so there are channels and a chat to point at.
    if (state.view === '@me' && state.guildOrder.length) selectView(state.guildOrder[0]);
  });

  // Follows the target every frame: panels resize, lists load, the window moves.
  let raf = 0;
  const measure = () => {
    const sel = step().target;
    const el = sel ? (document.querySelector(sel) as HTMLElement | null) : null;
    const r = el?.getBoundingClientRect();
    const next =
      r && r.width > 0 && r.height > 0 ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
    const prev = rect();
    if (
      !next !== !prev ||
      (next &&
        prev &&
        (next.top !== prev.top || next.left !== prev.left || next.width !== prev.width || next.height !== prev.height))
    )
      setRect(next);
    raf = requestAnimationFrame(measure);
  };
  onMount(() => (raf = requestAnimationFrame(measure)));
  onCleanup(() => cancelAnimationFrame(raf));

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') finish();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  onMount(() => window.addEventListener('keydown', onKey, true));
  onCleanup(() => window.removeEventListener('keydown', onKey, true));

  /** The spotlight: the target with some room around it, kept inside the window. */
  const hole = () => {
    const r = rect()!;
    const pad = 6;
    const top = Math.max(4, r.top - pad);
    const left = Math.max(4, r.left - pad);
    return {
      top,
      left,
      width: Math.min(window.innerWidth - 4, r.left + r.width + pad) - left,
      height: Math.min(window.innerHeight - 4, r.top + r.height + pad) - top,
    };
  };

  /** The card goes beside the spotlight where there's room: right, left, below, above. */
  const cardStyle = (): JSX.CSSProperties => {
    const h = hole();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const ch = cardH();
    const clampY = (y: number) => Math.max(12, Math.min(vh - ch - 12, y));
    const clampX = (x: number) => Math.max(12, Math.min(vw - CARD_W - 12, x));
    if (h.left + h.width + GAP + CARD_W + 12 <= vw)
      return { left: `${h.left + h.width + GAP}px`, top: `${clampY(h.top)}px` };
    if (h.left - GAP - CARD_W >= 12) return { left: `${h.left - GAP - CARD_W}px`, top: `${clampY(h.top)}px` };
    if (h.top + h.height + GAP + ch + 12 <= vh)
      return { left: `${clampX(h.left)}px`, top: `${h.top + h.height + GAP}px` };
    return { left: `${clampX(h.left)}px`, top: `${Math.max(12, h.top - GAP - ch)}px` };
  };

  let card!: HTMLDivElement;
  const ro = new ResizeObserver(() => card && setCardH(card.offsetHeight));
  onCleanup(() => ro.disconnect());
  // Focus moves to the card so Enter and the screen reader follow along.
  createEffect(on(index, () => queueMicrotask(() => card?.querySelector<HTMLElement>('.tour-next')?.focus())));

  return (
    <div
      class="tour"
      classList={{ anchored: anchored() }}
      role="dialog"
      aria-modal="true"
      aria-label={t('Linkord tour')}
    >
      <Show when={anchored()} fallback={<div class="tour-dim" />}>
        <div
          class="tour-spot"
          style={{
            top: `${hole().top}px`,
            left: `${hole().left}px`,
            width: `${hole().width}px`,
            height: `${hole().height}px`,
          }}
        />
      </Show>
      <div
        class="tour-card"
        classList={{ hero: !!step().hero, 'with-shot': !anchored() && !!step().shot }}
        style={anchored() ? cardStyle() : undefined}
        ref={(el) => {
          card = el;
          ro.observe(el);
        }}
      >
        <Show when={!step().hero}>
          <i class="tour-progress" style={{ width: `${(index() / (STEPS.length - 1)) * 100}%` }} />
        </Show>
        <Show when={step()} keyed>
          {(_step) => (
            <div class="tour-content">
              <Show when={step().hero}>
                <div class="tour-emblem">
                  <Emblem size={56} />
                </div>
              </Show>
              <Show when={!anchored() && step().shot}>
                {(src) => (
                  <div class="tour-shot">
                    <img src={src()} alt="" draggable={false} />
                  </div>
                )}
              </Show>
              <p class="tour-kicker">
                <Show
                  when={!step().hero}
                  fallback={index() === 0 ? t('Linkord {version}', { version: '1.0' }) : t('Tour complete')}
                >
                  {t('Step {n} of {total}', {
                    n: String(index()).padStart(2, '0'),
                    total: String(STEPS.length - 2).padStart(2, '0'),
                  })}
                </Show>
              </p>
              <h2>
                {index() === 0 && state.me
                  ? t('Welcome to Linkord, {name}', { name: displayName(state.me) })
                  : t(step().title)}
              </h2>
              <p class="tour-text">{t(step().text)}</p>
              <Show when={step().keys}>
                {(keys) => (
                  <div class="tour-keys">
                    <For each={keys()}>{(k) => <kbd>{k}</kbd>}</For>
                  </div>
                )}
              </Show>
            </div>
          )}
        </Show>
        <div class="tour-foot">
          <Show when={!last()}>
            <button class="btn ghost tour-skip" onClick={finish}>
              {index() === 0 ? t('Skip') : t('End tour')}
            </button>
          </Show>
          <span class="grow" />
          <Show when={index() > 0 && !last()}>
            <button class="btn tour-back" onClick={() => go(-1)}>
              {t('Back')}
            </button>
          </Show>
          <button class="btn primary tour-next" onClick={() => go(1)}>
            {index() === 0 ? t('Show me around') : last() ? t('Start chatting') : t('Next')}
          </button>
        </div>
      </div>
    </div>
  );
}
