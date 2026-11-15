// Onboarding. New accounts get a guided tour of the app: a spotlight on each part of the window with a card beside it,
// plus cards with screenshots for what has no fixed place (calls, Kass, watch together, soundboard). Accounts that have
// had the tour get the release dialog once per big release instead (2.0: REC first, then the new look),
// with confetti, a fanfare and the highlights. Both are remembered per account in the synced settings (tour_done,
// release_seen); Settings has links to see either again.
import { createEffect, createSignal, For, type JSX, on, onCleanup, onMount, Show } from 'solid-js';
import { patchSettings, selectView } from '../lib/actions';
import { msg, t } from '../lib/i18n';
import { confetti } from '../lib/confetti';
import { christmasSeason } from '../lib/holidays';
import { prefs, setPrefs } from '../lib/prefs';
import { page } from '../lib/route';
import { sounds } from '../lib/sounds';
import { displayName } from '../lib/types';
import { state } from '../lib/store';
import { isTauri } from '../lib/platform';
import { recAvailable } from '../lib/rec';
import { openPage } from '../lib/route';
import { isMobile, setUi, ui } from '../lib/ui';
import * as I from './Icons';
import { Emblem } from './Icons';
import { Snow } from './Christmas';
import {
  CallArt,
  KassArt,
  KeysArt,
  LeagueArt,
  LookArt,
  NameArt,
  OverlayArt,
  RecArt,
  ShareArt,
  SoundboardArt,
  StudioArt,
  WatchArt,
} from './ReleaseArt';
import shotXmasLook from '../assets/whats-new/christmas-look.webp';
import shotXmasSnowball from '../assets/whats-new/christmas-snowball.webp';
import shotXmasSanta from '../assets/whats-new/christmas-santa.webp';
import shotXmasToys from '../assets/whats-new/christmas-toys.webp';
import shotXmasCountdown from '../assets/whats-new/christmas-countdown.webp';
import shotXmasMusic from '../assets/whats-new/christmas-music.webp';

/** The release whose "what's new" dialog existing accounts see once. */
export const RELEASE = '2.0.0';
/** "2.0", as the dialog, the tour and Settings name it. */
export const RELEASE_NAME = RELEASE.split('.').slice(0, 2).join('.');

const [mode, setMode] = createSignal<'tour' | 'release' | 'christmas' | null>(null);
/** Settings → "Take the tour" / "What's new in 2.0". */
export const startTour = () => setMode('tour');
export const showRelease = () => setMode('release');
export const showChristmas = () => setMode('christmas');

/** What this launch should show, if anything. One at a time: the Christmas greeting waits its turn for the next launch. */
function dueNow(): 'tour' | 'release' | 'christmas' | null {
  const s = state.settings;
  if (!s.tour_done) return 'tour';
  if (s.release_seen !== RELEASE) return 'release';
  const season = christmasSeason(new Date());
  return season && s.christmas_seen !== season ? 'christmas' : null;
}

/** Decides once per launch, after the app has settled: the tour, a greeting or nothing. */
export function Onboarding() {
  let decided = false;
  let timer: number | undefined;
  createEffect(() => {
    if (decided || !state.ready || !state.me || state.me.needs_username || ui.modal || page()) return;
    if (!dueNow()) return void (decided = true);
    // A moment for the layout (and an invite dialog after login) before taking over the window.
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (decided || ui.modal || page()) return;
      decided = true;
      setMode(dueNow());
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
      <Show when={mode() === 'christmas'}>
        <ChristmasGreeting />
      </Show>
    </>
  );
}

// ---------- the highlights ----------

interface Feature {
  id: string;
  title: string;
  text: string;
  /** A screenshot, or a scene drawn in the app's own colours (ReleaseArt.tsx). */
  shot?: string;
  art?: () => JSX.Element;
  /** Only the Windows app does this: anywhere else the slide gets a "Windows app" tag. */
  windows?: boolean;
}

/** 2.0: REC first (most of the release), then the new name and look. */
const FEATURES: Feature[] = [
  {
    id: 'rec',
    title: msg('Your games, recorded'),
    text: msg(
      'Turn on REC and Linkord records every game you play, quietly, in the background. Nothing shows on your screen while it does, and the recordings stay on your PC.',
    ),
    art: RecArt,
    windows: true,
  },
  {
    id: 'rec-keys',
    title: msg('Clips with one key'),
    text: msg(
      'Something great just happened? A key keeps the last seconds as a clip, another takes a screenshot or marks the moment for later. A soft chime confirms it, even in fullscreen.',
    ),
    art: KeysArt,
    windows: true,
  },
  {
    id: 'rec-studio',
    title: msg('The studio'),
    text: msg(
      'Every session waits in your library, hours long if you like. Skim it by its thumbnails, jump from moment to moment and cut a clip from any part of it, instantly.',
    ),
    art: StudioArt,
    windows: true,
  },
  {
    id: 'rec-overlay',
    title: msg('Over your game'),
    text: msg(
      'Shift and the key left of 1 open REC on top of the game: save a clip, take a screenshot, see your latest clips. Close it and the game gets its focus back. It never shows up in the recording.',
    ),
    art: OverlayArt,
    windows: true,
  },
  {
    id: 'rec-share',
    title: msg('Share with a link'),
    text: msg(
      'Share a clip in a chat and it plays right there. Its link opens in any browser, no account needed, and in a call you can watch it together.',
    ),
    art: ShareArt,
  },
  {
    id: 'rec-league',
    title: msg('League and badges'),
    text: msg(
      'In League, kills, multikills and objectives land on the timeline by themselves, and REC can clip them for you. New badges for clips, views, hours recorded and a real pentakill.',
    ),
    art: LeagueArt,
    windows: true,
  },
  {
    id: 'name',
    title: msg('A new icon'),
    text: msg(
      'Wings around the Triforce, drawn to read at any size, from the taskbar to the tray. Same app, same friends, same servers.',
    ),
    art: NameArt,
  },
  {
    id: 'look',
    title: msg('Cotton on steel'),
    text: msg(
      'Gold gave way to Algodão: cotton white on steel-tinted grays, or ink on paper in the light theme.',
    ),
    art: LookArt,
  },
];

const MORE = [
  msg('Record your desktop too'),
  msg('Recent clips on profiles'),
  msg('Keep your voice out of recordings'),
  msg('Search every server'),
];

// ---------- the release dialog ----------

const SLIDE_MS = 7000;

/** The dialog itself: confetti, the fanfare and slides that move on by themselves until you pick one. */
function Showcase(p: {
  features: Feature[];
  more: string[];
  kicker: string;
  title: string;
  intro: string;
  emblem: JSX.Element;
  onClose: () => void;
  footer: JSX.Element;
  /** Drawn over the dialog, and a class that dresses it up. */
  decor?: JSX.Element;
  class?: string;
}) {
  const [index, setIndex] = createSignal(0);
  /** Slides move on by themselves until you pick one. */
  const [auto, setAuto] = createSignal(true);
  const [paused, setPaused] = createSignal(false);
  const current = () => p.features[index()];
  const pick = (i: number) => {
    setAuto(false);
    setIndex((i + p.features.length) % p.features.length);
  };

  let stopConfetti: (() => void) | undefined;
  let stopFanfare: (() => void) | undefined;
  onMount(() => {
    // Preload every screenshot so switching slides never shows an empty frame.
    for (const f of p.features) if (f.shot) new Image().src = f.shot;
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
      if (auto() && !paused()) timer = window.setTimeout(() => setIndex((i) => (i + 1) % p.features.length), SLIDE_MS);
    }),
  );
  onCleanup(() => clearTimeout(timer));

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') p.onClose();
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') pick(index() + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') pick(index() - 1);
    else return;
    e.preventDefault();
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));

  return (
    <div
      class={`modal-backdrop release-backdrop ${p.class ?? ''}`}
      onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}
    >
      <div class="modal release" role="dialog" aria-modal="true" aria-label={p.title}>
        <button class="icon-btn modal-close" aria-label={t('Close')} onClick={() => p.onClose()}>
          <I.Close size={18} />
        </button>
        <header class="release-head">
          <div class="release-emblem">{p.emblem}</div>
          <div>
            <p class="showcase-kicker">{p.kicker}</p>
            <h2>{p.title}</h2>
            <p class="muted">{p.intro}</p>
          </div>
        </header>
        <div class="release-body" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
          <ol class="release-list" role="tablist" aria-label={t("What's new")}>
            <For each={p.features}>
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
                <div class="release-shot" classList={{ 'release-art': !f.shot }}>
                  <Show when={f.shot} fallback={f.art?.()}>
                    {(src) => <img src={src()} alt={t(f.title)} draggable={false} />}
                  </Show>
                </div>
                <figcaption>
                  <h3>
                    {t(f.title)}
                    <Show when={f.windows && !recAvailable}>
                      <span class="release-tag">{t('Windows app')}</span>
                    </Show>
                  </h3>
                  <p>{t(f.text)}</p>
                </figcaption>
              </figure>
            )}
          </Show>
        </div>
        <div class="release-more">
          <span class="kicker">{t('And also')}</span>
          <For each={p.more}>{(m) => <span class="release-chip">{t(m)}</span>}</For>
        </div>
        <div class="modal-footer release-foot">{p.footer}</div>
      </div>
      {p.decor}
    </div>
  );
}

function Release() {
  const close = (then?: () => void) => {
    void patchSettings({ release_seen: RELEASE }).catch(() => {});
    setMode(null);
    then?.();
  };
  return (
    <Showcase
      features={FEATURES}
      more={MORE}
      kicker={t('Linkord {version}', { version: RELEASE_NAME })}
      title={t('Meet REC')}
      intro={t(
        '{name}, Linkord now records your games and turns your best moments into clips. And it has a new look: that comes right after.',
        { name: displayName(state.me) },
      )}
      emblem={
        <>
          <Emblem size={52} />
          <span class="release-rec-tag">
            <i /> REC
          </span>
        </>
      }
      onClose={() => close()}
      footer={
        <>
          <Show when={!isTauri}>
            <button class="btn ghost" onClick={() => close(() => openPage('download'))}>
              <I.Download size={16} /> {t('Download the app')}
            </button>
          </Show>
          <span class="grow" />
          <Show
            when={recAvailable}
            fallback={
              <button class="btn primary" onClick={() => close()}>
                {t("Let's go")}
              </button>
            }
          >
            <button class="btn ghost" onClick={() => close()}>
              {t('Maybe later')}
            </button>
            <button class="btn primary" onClick={() => close(() => setUi('modal', { type: 'rec' }))}>
              <I.Rec size={16} /> {prefs.rec.enabled ? t('Open REC') : t('Try REC')}
            </button>
          </Show>
        </>
      }
    />
  );
}

// ---------- the Christmas greeting ----------

const CHRISTMAS: Feature[] = [
  {
    id: 'christmas-look',
    title: msg('Linkord in evergreen'),
    text: msg(
      'A Christmas theme with falling snow, string lights, a tree, Santa hats on everyone and snow that slowly piles up behind the message box. Click the snow to clear it.',
    ),
    shot: shotXmasLook,
  },
  {
    id: 'christmas-snowball',
    title: msg('Snowball fights'),
    text: msg(
      'Type /snowball @name or right-click a message to hit someone with a snowball. Everyone in the channel sees it land, and the score goes on your profile.',
    ),
    shot: shotXmasSnowball,
  },
  {
    id: 'christmas-santa',
    title: msg('Santa flies by'),
    text: msg('Every so often Santa crosses the window. Click him if you can: every catch counts.'),
    shot: shotXmasSanta,
  },
  {
    id: 'christmas-toys',
    title: msg('Things to click'),
    text: msg(
      'Gifts hop and burst into confetti, ornaments swing, the star spins and the tree sheds its snow. There is a snowman on every full profile, too.',
    ),
    shot: shotXmasToys,
  },
  {
    id: 'christmas-countdown',
    title: msg('Counting down'),
    text: msg(
      'See the time left until Christmas and New Year above every chat, with fireworks when midnight arrives wherever you are.',
    ),
    shot: shotXmasCountdown,
  },
  {
    id: 'christmas-music',
    title: msg('Carols while you chat'),
    text: msg(
      'Christmas songs play softly and pause for calls, videos and other windows. Skip one from above the tree, or change the volume or turn them off in Appearance.',
    ),
    shot: shotXmasMusic,
  },
];

const CHRISTMAS_MORE = [
  msg('Festive app icon'),
  msg('Winter call sounds'),
  msg('Bells on the soundboard'),
  msg('Works for New Year too'),
];

function ChristmasGreeting() {
  const close = () => {
    const season = christmasSeason(new Date());
    if (season) void patchSettings({ christmas_seen: season }).catch(() => {});
    setMode(null);
  };
  return (
    <Showcase
      features={CHRISTMAS}
      more={CHRISTMAS_MORE}
      kicker={t('Happy holidays from Linkord')}
      title={t('Merry Christmas, {name}!', { name: displayName(state.me) })}
      intro={t('Linkord dressed up for the season. Here is everything that came with it.')}
      emblem={<Emblem size={64} christmas />}
      class="xmas-modal"
      decor={
        <Show when={!matchMedia('(prefers-reduced-motion: reduce)').matches}>
          <Snow awake />
        </Show>
      }
      onClose={close}
      footer={
        <>
          <span class="grow" />
          <Show
            when={prefs.theme !== 'christmas'}
            fallback={
              <button class="btn primary" onClick={close}>
                {t("Let's go")}
              </button>
            }
          >
            <button class="btn ghost" onClick={close}>
              {t('Maybe later')}
            </button>
            <button
              class="btn primary xmas-theme-on"
              onClick={() => {
                setPrefs({ theme: 'christmas' });
                close();
              }}
            >
              <I.Snowflake size={16} /> {t('Turn on the Christmas theme')}
            </button>
          </Show>
        </>
      }
    />
  );
}

// ---------- the tour ----------

interface Step {
  title: string;
  text: string;
  /** The part of the window to point at; without one (or when it isn't on screen) the card sits in the middle. */
  target?: string;
  /** A drawn scene (ReleaseArt.tsx), for the cards in the middle. */
  art?: () => JSX.Element;
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
    art: CallArt,
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
    target: '.dock .rec-btn',
    title: msg('REC is here'),
    // Just that it exists: the REC page introduces itself the first time it's opened.
    text: recAvailable
      ? msg('Record your games and keep the best moments as clips. Turn it on from this button whenever you like.')
      : msg('The Windows app records your games and keeps the best moments as clips. Your shared clips live here.'),
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
  {
    art: KassArt,
    title: msg('Kass, the music bot'),
    text: msg(
      'Type /play with a YouTube or Spotify link, or just the name of a song, and Kass joins your call. /skip, /pause, /queue and /stop do the rest.',
    ),
  },
  {
    art: WatchArt,
    title: msg('Watch together'),
    text: msg(
      'Share a YouTube, Twitch or Kick link in a call and everyone watches in sync. People join when they want, with theater mode, fullscreen and a pop-out player.',
    ),
  },
  {
    art: SoundboardArt,
    title: msg('Soundboard'),
    text: msg(
      'Quick sounds for the call. Upload your own, trim them on the waveform and give each one an emoji. Everyone hears it at once.',
    ),
  },
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
    // Someone who just took the tour has had enough dialogs: no greeting on top of it this season.
    void patchSettings({
      tour_done: true,
      release_seen: RELEASE,
      ...(christmasSeason(new Date()) ? { christmas_seen: christmasSeason(new Date())! } : {}),
    }).catch(() => {});
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
        classList={{ hero: !!step().hero, 'with-shot': !anchored() && !!step().art }}
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
              <Show when={!anchored() && step().art}>{(art) => <div class="tour-shot">{art()()}</div>}</Show>
              <p class="tour-kicker">
                <Show
                  when={!step().hero}
                  fallback={index() === 0 ? t('Linkord {version}', { version: RELEASE_NAME }) : t('Tour complete')}
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
