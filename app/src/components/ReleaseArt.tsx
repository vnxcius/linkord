// The drawn scenes of the 2.0 "what's new" dialog and of the tour (Onboarding.tsx). Each one fills a 16:10 frame, is
// made of the app's own tokens (so light and dark both work) and plays once when it comes in. aria-hidden: the slide's
// or step's title and text say the same in words. A screenshot can replace any of them later (Feature.shot).

import { For, type JSX } from 'solid-js';
import { t } from '../lib/i18n';
import { comboLabel, type KeyAction } from '../lib/keys';
import { prefs } from '../lib/prefs';
import * as I from './Icons';
import { Emblem } from './Icons';
import { Frame, Scene } from './RecIntro';
import badgeClips from '../assets/badges/clips-gold.svg?url';
import badgeViews from '../assets/badges/views-silver.svg?url';
import badgeRecorded from '../assets/badges/recorded-platinum.svg?url';
import badgePremiere from '../assets/badges/premiere.svg?url';
import badgePentakill from '../assets/badges/pentakill.svg?url';

/** Your key for an action, or nothing when it has none (REC's clip/screenshot/bookmark keys start unset). */
const keyOf = (action: KeyAction) => {
  const combo = prefs.keybinds.find((b) => b.action === action)?.combo;
  return combo ? comboLabel(combo, t) : '';
};

function Art(p: { class: string; children: JSX.Element }) {
  return (
    <div class={`ra ${p.class}`} aria-hidden="true">
      {p.children}
    </div>
  );
}

/** REC itself: the introduction's scene (the tape rolls, the bracket closes, the clip lifts out). */
export function RecArt() {
  return (
    <Art class="ra-rec">
      <Scene />
    </Art>
  );
}

/** The hotkeys: three keys pressed in turn, each confirmed by its card. */
export function KeysArt() {
  const keys: { action: KeyAction; icon: JSX.Element; label: string; done: string }[] = [
    { action: 'rec-clip', icon: <I.Scissors size={22} />, label: t('Save a Clip'), done: t('Clip saved') },
    {
      action: 'rec-screenshot',
      icon: <I.Photo size={22} />,
      label: t('Take a Screenshot'),
      done: t('Screenshot saved'),
    },
    { action: 'rec-bookmark', icon: <I.Bookmark size={22} />, label: t('Bookmark'), done: t('Bookmarked') },
  ];
  return (
    <Art class="ra-keys">
      <For each={keys}>
        {(k, i) => (
          <div class="ra-key" style={{ '--i': i() }}>
            <span class="ra-cap">{k.icon}</span>
            <strong>{k.label}</strong>
            <small>{keyOf(k.action) || ' '}</small>
            <span class="ra-done">
              <I.Check size={13} /> {k.done}
            </span>
          </div>
        )}
      </For>
    </Art>
  );
}

const STRIP = Array.from({ length: 9 }, (_, i) => i + 2);

/** The studio: a VOD playing, its filmstrip with moments, and a clip being cut from it. */
export function StudioArt() {
  return (
    <Art class="ra-studio">
      <div class="ra-screen">
        <Frame i={7} />
        <span class="ra-play">
          <I.Play size={20} />
        </span>
        <span class="ra-time">1:24:07 / 2:10:45</span>
      </div>
      <div class="ra-lane">
        <div class="ra-strip">
          <For each={STRIP}>{(i) => <Frame i={i} />}</For>
        </div>
        <span class="ra-flag" style={{ left: '17%' }}>
          <I.Bookmark size={11} />
        </span>
        <span class="ra-flag" style={{ left: '46%' }}>
          <I.Bookmark size={11} />
        </span>
        <span class="ra-flag" style={{ left: '79%' }}>
          <I.Bookmark size={11} />
        </span>
        <span class="ra-cut">
          <i />
          <i />
        </span>
        <span class="ra-head" />
      </div>
      <div class="ra-studio-foot">
        <span class="ra-pill">
          <I.Scissors size={13} /> {t('Make a clip here')}
        </span>
        <span class="ra-pill quiet">{t('Instant, no re-encoding')}</span>
      </div>
    </Art>
  );
}

/** The overlay: a panel over the game, opened with a key, never in the recording. */
export function OverlayArt() {
  return (
    <Art class="ra-overlay">
      <div class="ra-game">
        <Frame i={13} />
      </div>
      <div class="ra-panel">
        <div class="ra-panel-head">
          <span class="ra-dot" />
          <strong>{t('Recording')}</strong>
          <span class="ra-mono">00:42:10</span>
        </div>
        <div class="ra-panel-actions">
          <span>
            <I.Scissors size={16} /> {t('Save clip')}
          </span>
          <span>
            <I.Photo size={16} /> {t('Screenshot')}
          </span>
          <span>
            <I.Bookmark size={16} /> {t('Bookmark')}
          </span>
        </div>
        <div class="ra-panel-clips">
          <For each={[3, 9, 5]}>
            {(i) => (
              <span>
                <Frame i={i} />
              </span>
            )}
          </For>
        </div>
      </div>
      <span class="ra-hint">
        <kbd>{keyOf('rec-overlay') || 'Shift + ~'}</kbd>
      </span>
    </Art>
  );
}

/** Sharing: the clip plays in the chat, and its link opens for anyone. */
export function ShareArt() {
  return (
    <Art class="ra-share">
      <div class="ra-msg">
        <span class="ra-avatar">
          <I.Mark size={18} />
        </span>
        <div class="ra-msg-body">
          <span class="ra-msg-name">
            <strong />
            <small />
          </span>
          <div class="ra-clipcard">
            <Frame i={7} />
            <span class="ra-play">
              <I.Play size={18} />
            </span>
            <span class="ra-time">0:30</span>
          </div>
          <div class="ra-link">
            <I.Link size={15} />
            <span class="ra-mono">/clip/x7Kp2qLm9aZ4</span>
            <span class="ra-link-note">{t('No account needed')}</span>
          </div>
          <div class="ra-together">
            <span class="ra-faces">
              <i />
              <i />
              <i />
            </span>
            {t('Watching together')}
          </div>
        </div>
      </div>
    </Art>
  );
}

/** League: the match's moments land on the timeline, and the new badges. */
export function LeagueArt() {
  const moments = [
    { at: '22%', label: t('Double kill') },
    { at: '51%', label: t('Dragon') },
    { at: '83%', label: t('Pentakill') },
  ];
  return (
    <Art class="ra-league">
      <div class="ra-moments">
        <span class="ra-track" />
        <For each={moments}>
          {(m, i) => (
            <span class="ra-moment" style={{ left: m.at, '--i': i() }}>
              <span class="ra-pill" classList={{ quiet: i() < moments.length - 1 }}>
                {m.label}
              </span>
              <i />
            </span>
          )}
        </For>
      </div>
      <div class="ra-badges">
        <For each={[badgeClips, badgeViews, badgeRecorded, badgePremiere, badgePentakill]}>
          {(src, i) => <img src={src} alt="" draggable={false} style={{ '--i': i() }} />}
        </For>
      </div>
    </Art>
  );
}

/** The new icon. */
export function NameArt() {
  return (
    <Art class="ra-name">
      <div class="ra-word">
        <Emblem size={88} />
        <span>Linkord</span>
      </div>
    </Art>
  );
}

/** The new colours (live tokens, so it shows the theme you're on). */
export function LookArt() {
  return (
    <Art class="ra-look">
      <div class="ra-cotton">
        <span class="ra-swatch" />
        <strong>Algodão</strong>
        <small>{t('cotton, the accent')}</small>
      </div>
      <div class="ra-steel">
        <For each={['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--bg-4']}>
          {(v) => <span style={{ background: `var(${v})` }} />}
        </For>
        <strong>Aço</strong>
        <small>{t('steel, the grays')}</small>
      </div>
    </Art>
  );
}

// ---------- the tour's scenes (Onboarding.tsx STEPS): what has no fixed place in the window ----------

/** A made-up friend's square avatar: initial on a muted tone (the same tones as the download page's picture). */
function Face(p: { name: string; tone: number; speaking?: boolean; big?: boolean }) {
  return (
    <span class={`ra-face tone-${p.tone}`} classList={{ speaking: p.speaking, big: p.big }}>
      {p.name[0].toUpperCase()}
    </span>
  );
}

/** A call: a friend's stream large, the others beside it (one talking), the call's buttons below. */
export function CallArt() {
  const people = [
    { name: 'ana', tone: 1, speaking: true },
    { name: 'bia', tone: 3 },
    { name: 'caio', tone: 4 },
  ];
  return (
    <Art class="ra-call">
      <div class="ra-call-stage">
        <div class="ra-stream">
          <Frame i={7} />
          <span class="ra-stream-name">
            theo <span class="ra-live">{t('LIVE')}</span>
          </span>
        </div>
        <div class="ra-people">
          <For each={people}>
            {(u) => (
              <div class="ra-person" classList={{ speaking: u.speaking }}>
                <Face name={u.name} tone={u.tone} big />
                <span>{u.name}</span>
              </div>
            )}
          </For>
        </div>
      </div>
      <div class="ra-call-bar">
        <span>
          <I.Mic size={16} />
        </span>
        <span>
          <I.Headphones size={16} />
        </span>
        <span>
          <I.Camera size={16} />
        </span>
        <span class="on">
          <I.Screen size={16} />
        </span>
        <span class="hangup">
          <I.Hangup size={16} />
        </span>
      </div>
    </Art>
  );
}

/** Kass: a /play in the message box, and his card for the song now playing. */
export function KassArt() {
  return (
    <Art class="ra-kass">
      <div class="ra-kass-card">
        <span class="ra-kass-avatar">
          <I.Music size={20} />
        </span>
        <div class="ra-kass-body">
          <span class="ra-kass-kicker">{t('Now playing')}</span>
          <span class="ra-bar" style={{ width: '70%' }} />
          <span class="ra-bar quiet" style={{ width: '42%' }} />
          <span class="ra-kass-progress">
            <i />
          </span>
        </div>
      </div>
      <div class="ra-command">
        <span class="ra-slash">/play</span>
        <span class="ra-bar quiet" style={{ width: '34%' }} />
        <span class="ra-caret" />
      </div>
    </Art>
  );
}

/** Watch together: one player, everyone at the same moment. */
export function WatchArt() {
  return (
    <Art class="ra-watch">
      <div class="ra-watch-player">
        <Frame i={13} />
        <span class="ra-play">
          <I.Play size={20} />
        </span>
        <div class="ra-watch-bar">
          <span class="ra-watch-track">
            <i />
          </span>
          <span class="ra-mono">12:48</span>
        </div>
      </div>
      <div class="ra-together">
        <span class="ra-faces">
          <i />
          <i />
          <i />
        </span>
        {t('Watching together')}
      </div>
    </Art>
  );
}

/** The soundboard: a grid of sounds, one being played, and who played it lighting up. */
export function SoundboardArt() {
  const sounds = ['🎺', '🥁', '👏', '🔔', '🐐', '🎉'];
  return (
    <Art class="ra-board">
      <div class="ra-sounds">
        <For each={sounds}>
          {(e, i) => (
            <span class="ra-sound-btn" classList={{ played: i() === 0 }}>
              <span class="ra-emoji">{e}</span>
              <span class="ra-bar quiet" style={{ width: `${46 + ((i() * 17) % 30)}%` }} />
            </span>
          )}
        </For>
      </div>
      <div class="ra-board-who">
        <Face name="bia" tone={3} speaking big />
        <span class="ra-sound-bubble">🎺</span>
      </div>
    </Art>
  );
}
