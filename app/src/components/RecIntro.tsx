// REC is opt-in (owner, 2026-11-14). Until it's turned on, the REC page is this introduction: what REC does, told by one
// short scene (a recording rolls by, its last seconds are bracketed and lift out as a clip with a link), three facts,
// and the switch for your voice in other people's recordings (that one works whether REC is on or not). Turning it on
// the first time goes through a three-step setup (when to record, quality, sound); after that, turning it on again
// opens the studio straight away. Nothing here records: lib/rec.ts only starts once prefs.rec.enabled is set.

import { createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import { t } from '../lib/i18n';
import { comboLabel } from '../lib/keys';
import { prefs } from '../lib/prefs';
import { setRecPrefs } from '../lib/rec';
import * as I from './Icons';
import { clock } from './RecPlayer';
import { fmt1, gbPerHour, PRESETS, Toggle, VoiceConsent } from './Rec';

/** A made-up game frame for the scene: ground of three heights and sometimes a player (index-driven, so stable). */
export function Frame(p: { i: number }) {
  const h = (k: number) => 18 + ((p.i * 7 + k * 11) % 5) * 7;
  return (
    <span class="rx-frame" classList={{ moment: p.i % 6 === 4 }}>
      <i style={{ height: `${h(0)}%`, left: '0', width: '38%' }} />
      <i style={{ height: `${h(1)}%`, left: '38%', width: '30%' }} />
      <i style={{ height: `${h(2)}%`, left: '68%', width: '32%' }} />
      <Show when={p.i % 3 === 1}>
        <b style={{ left: `${20 + ((p.i * 13) % 55)}%`, bottom: `${h(1) + 4}%` }} />
      </Show>
    </span>
  );
}

const FRAMES = Array.from({ length: 14 }, (_, i) => i);

/** The one moving part: the tape rolls (it's recording), the bracket closes over its last seconds, the clip lifts out. */
export function Scene() {
  // The recording clock runs from a made-up 42 minutes in.
  const start = Date.now() - (42 * 60 + 10) * 1000;
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const seconds = () => prefs.rec.clipSeconds;
  return (
    <div class="rx-scene" aria-hidden="true">
      <div class="rx-live">
        <span class="rs-dot" />
        <span>{t('Recording')}</span>
        <span class="rx-time">{clock(now() - start)}</span>
      </div>
      <div class="rx-clip">
        <span class="rx-clip-shot">
          <Frame i={4} />
        </span>
        <span class="rx-clip-text">
          <strong>{t('Clip saved')}</strong>
          <small>{clock(seconds() * 1000)}</small>
        </span>
        <span class="rx-link">
          <I.Link size={13} /> {t('Link copied')}
        </span>
      </div>
      <div class="rx-tape">
        <div class="rx-reel">
          <For each={[...FRAMES, ...FRAMES]}>{(i) => <Frame i={i} />}</For>
        </div>
        <div class="rx-bracket">
          <span>{t('Last {n} s', { n: seconds() })}</span>
        </div>
        <span class="rx-now" />
      </div>
    </div>
  );
}

export function RecIntro(p: { onAccept: () => void; onLater: () => void }) {
  return (
    <div class="rx">
      <div class="rx-page">
        <h1 class="rx-title">{t('Your games, recorded while you play')}</h1>
        <p class="rx-lead">
          {t(
            'REC records your games on this PC in the background. When something good happens, a key keeps the last {n} seconds as a clip you can share with a link.',
            { n: prefs.rec.clipSeconds },
          )}
        </p>
        <Scene />
        <ul class="rx-facts">
          <li>
            <I.Rec size={20} />
            <strong>{t('Starts by itself')}</strong>
            <span>{t('When Linkord sees a game, REC records it. Nothing shows on your screen while it does.')}</span>
          </li>
          <li>
            <I.Scissors size={20} />
            <strong>{t('Clips from a key')}</strong>
            <span>{t('Save the last seconds while you play, or cut a clip from the full recording later.')}</span>
          </li>
          <li>
            <I.Link size={20} />
            <strong>{t('Share with a link')}</strong>
            <span>{t('Anyone can watch a clip you share, even without Linkord.')}</span>
          </li>
        </ul>
        <div class="rx-actions">
          <button class="btn primary" onClick={p.onAccept}>
            {t('Turn on REC')}
          </button>
          <button class="btn ghost" onClick={p.onLater}>
            {t('Not now')}
          </button>
        </div>
        <p class="rx-fine">
          {t(
            'Recordings stay on this PC. A clip only leaves it when you share it. You can turn REC off at any time in its settings.',
          )}
        </p>
        <section class="rx-privacy">
          <h2>{t('Your voice in other recordings')}</h2>
          <div class="rs-box">
            <VoiceConsent />
          </div>
        </section>
      </div>
    </div>
  );
}

/** One choice in a setup step: a row you click, the picked one outlined in gold. */
function Choice(p: { title: string; hint: string; icon: JSX.Element; picked: boolean; onPick: () => void }) {
  return (
    <button class="rx-choice" classList={{ picked: p.picked }} role="radio" aria-checked={p.picked} onClick={p.onPick}>
      <span class="rx-choice-icon">{p.icon}</span>
      <span class="rx-choice-text">
        <strong>{p.title}</strong>
        <small>{p.hint}</small>
      </span>
      <span class="rx-choice-mark" aria-hidden="true">
        <Show when={p.picked}>
          <I.Check size={14} />
        </Show>
      </span>
    </button>
  );
}

const STEPS = 3;

/** The first time REC is turned on: three short questions, each saved as it's answered. */
export function RecSetup(p: { onDone: () => void; onBack: () => void }) {
  const [step, setStep] = createSignal(1);
  const r = () => prefs.rec;
  const preset = () =>
    PRESETS.find((x) => x.height === r().maxHeight && x.fps === r().fps && x.kbps === r().bitrateKbps);
  const overlayKey = () => {
    const combo = prefs.keybinds.find((b) => b.action === 'rec-overlay')?.combo;
    return combo ? comboLabel(combo, t) : null;
  };
  const back = () => (step() > 1 ? setStep(step() - 1) : p.onBack());
  const next = () => (step() < STEPS ? setStep(step() + 1) : p.onDone());
  return (
    <div class="rx">
      <div class="rx-page rx-setup">
        <p class="rx-step">{t('Step {n} of {total}', { n: step(), total: STEPS })}</p>
        <div class="rx-progress" aria-hidden="true">
          <For each={Array.from({ length: STEPS }, (_, i) => i + 1)}>
            {(n) => <span classList={{ done: n <= step() }} />}
          </For>
        </div>
        {/* Keyed by step, so each answer brings the next question in. */}
        <Show when={step()} keyed>
          {(n) => (
            <div class="rx-step-body">
              <Show when={n === 1}>
                <h1 class="rx-title small">{t('When should REC record?')}</h1>
                <div class="rx-choices" role="radiogroup">
                  <Choice
                    title={t('Every game I play')}
                    hint={t('Starts when a game opens and stops when it closes.')}
                    icon={<I.Rec size={20} />}
                    picked={r().auto}
                    onPick={() => setRecPrefs({ auto: true })}
                  />
                  <Choice
                    title={t('Only when I start it')}
                    hint={t('Press Record now on this page, or set a start/stop hotkey.')}
                    icon={<I.Play size={20} />}
                    picked={!r().auto}
                    onPick={() => setRecPrefs({ auto: false })}
                  />
                </div>
              </Show>
              <Show when={n === 2}>
                <h1 class="rx-title small">{t('How should recordings look?')}</h1>
                <p class="rx-lead">
                  {t('Recording uses your graphics card, not your processor. Higher takes more space.')}
                </p>
                <div class="rx-presets">
                  <For each={PRESETS}>
                    {(x) => (
                      <button
                        class="rs-preset"
                        classList={{ active: preset()?.id === x.id }}
                        onClick={() => setRecPrefs({ maxHeight: x.height, fps: x.fps, bitrateKbps: x.kbps })}
                      >
                        <strong>{t(x.name)}</strong>
                        <span>
                          {x.height ? `${x.height}p` : t('Native')} · {x.fps} fps
                        </span>
                        <small>{t('about {gb} GB an hour', { gb: fmt1(gbPerHour(x.kbps)) })}</small>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={n === 3}>
                <h1 class="rx-title small">{t('What should recordings hear?')}</h1>
                <div class="rs-box">
                  <Toggle
                    label={t("The game's sound")}
                    checked={r().gameAudio}
                    onChange={(v) => setRecPrefs({ gameAudio: v })}
                  />
                  <Toggle
                    label={t('My microphone')}
                    hint={t('The one you use for voice chat. You can pick another in the settings.')}
                    checked={r().mic !== 'off'}
                    onChange={(v) => setRecPrefs({ mic: v ? 'voice' : 'off' })}
                  />
                  <Toggle
                    label={t('People in my call')}
                    hint={t("Everyone you hear in your call, except people who don't want to be recorded.")}
                    checked={r().voices}
                    onChange={(v) => setRecPrefs({ voices: v })}
                  />
                </div>
                <Show when={overlayKey()}>
                  {(k) => (
                    <p class="rx-tip">
                      <kbd>{k()}</kbd>
                      <span>
                        {t('In a game, this opens REC over it: save clips, take screenshots, stop recording.')}
                      </span>
                    </p>
                  )}
                </Show>
              </Show>
            </div>
          )}
        </Show>
        <div class="rx-actions">
          <button class="btn ghost" onClick={back}>
            {t('Back')}
          </button>
          <span class="grow" />
          <Show when={step() < STEPS}>
            <button class="btn ghost" onClick={p.onDone}>
              {t('Skip setup')}
            </button>
          </Show>
          <button class="btn primary" onClick={next}>
            {step() < STEPS ? t('Next') : t('Turn on REC')}
          </button>
        </div>
      </div>
    </div>
  );
}
