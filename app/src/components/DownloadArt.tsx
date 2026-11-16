// The download page's picture of the app (Pages.tsx): the desktop window as it looks today, drawn with the app's own
// tokens (so light and dark both work) and laid out in em on a 100 x 62 em stage, so it scales with its frame. Made-up
// people and server; a clip shared in the chat ties it to REC. aria-hidden: the page's text says the same in words.

import { For, Show } from 'solid-js';
import { t } from '../lib/i18n';
import * as I from './Icons';
import { Emblem, Mark } from './Icons';
import { Frame } from './RecIntro';

const PEOPLE = [
  { name: 'ana', tone: 1, speaking: true },
  { name: 'theo', tone: 2, live: true },
  { name: 'bia', tone: 3 },
];

function Face(p: { name: string; tone: number; speaking?: boolean }) {
  return (
    <span class={`mk-face tone-${p.tone}`} classList={{ speaking: p.speaking }}>
      {p.name[0].toUpperCase()}
    </span>
  );
}

export function DesktopMock() {
  return (
    <div class="mk" aria-hidden="true">
      <div class="mk-bar">
        <Emblem size={14} />
        <span>Linkord</span>
        <span class="mk-controls">
          <I.Minimize size={12} />
          <I.Maximize size={12} />
          <I.Close size={12} />
        </span>
      </div>
      <div class="mk-desk">
        <div class="mk-left">
          <div class="mk-strip">
            <span class="mk-tile mk-home">
              <Mark size={14} />
            </span>
            <span class="mk-sep" />
            <span class="mk-tile mk-on">F</span>
            <span class="mk-tile">S</span>
            <span class="mk-tile mk-add">
              <I.Plus size={12} />
            </span>
          </div>
          <div class="mk-panel">
            <div class="mk-server">Friday Night</div>
            <div class="mk-kicker">{t('Text channels')}</div>
            <For each={[t('general'), t('clips'), t('games')]}>
              {(c, i) => (
                <div class="mk-channel" classList={{ active: i() === 1 }}>
                  <span class="mk-num">{String(i() + 1).padStart(2, '0')}</span>
                  {c}
                </div>
              )}
            </For>
            <div class="mk-kicker">{t('Voice channels')}</div>
            <div class="mk-call">
              <div class="mk-call-head">
                <I.Speaker size={12} /> {t('Lounge')}
                <span class="mk-mono">0:42</span>
              </div>
              <For each={PEOPLE}>
                {(u) => (
                  <div class="mk-person">
                    <Face {...u} />
                    <span>{u.name}</span>
                    <Show when={u.live}>
                      <span class="mk-live">{t('LIVE')}</span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
            <div class="mk-dock">
              <span class="mk-online">{t('Voice online')}</span>
              <div class="mk-me">
                <Face name="you" tone={4} />
                <span class="mk-lines">
                  <i />
                  <i />
                </span>
                <span class="mk-rec">
                  <I.Rec size={13} />
                </span>
                <I.Gear size={13} />
              </div>
            </div>
          </div>
        </div>
        <div class="mk-page">
          <div class="mk-head">
            <span class="mk-running">No. 02 · Friday Night</span>
            <span class="mk-title">{t('clips')}</span>
          </div>
          <div class="mk-messages">
            <div class="mk-msg">
              <Face name="bia" tone={3} />
              <div>
                <strong>bia</strong>
                <span class="mk-text" style={{ width: '62%' }} />
                <span class="mk-text" style={{ width: '38%' }} />
              </div>
            </div>
            <div class="mk-msg">
              <Face name="theo" tone={2} />
              <div>
                <strong>theo</strong>
                <span class="mk-text" style={{ width: '46%' }} />
                <div class="mk-clip">
                  <Frame i={7} />
                  <span class="mk-play">
                    <I.Play size={14} />
                  </span>
                  <span class="mk-clip-time">0:30</span>
                </div>
              </div>
            </div>
          </div>
          <div class="mk-composer">
            <I.Plus size={13} />
            <span class="mk-text" style={{ width: '30%' }} />
          </div>
        </div>
        <div class="mk-margin">
          <div class="mk-tabs">
            <span class="active">{t('People')}</span>
            <span>{t('Pins')}</span>
          </div>
          <For each={[...PEOPLE, { name: 'caio', tone: 4 }]}>
            {(u) => (
              <div class="mk-person">
                <Face name={u.name} tone={u.tone} />
                <span>{u.name}</span>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

/**
 * The Android app on a phone, for the download page's mobile section: a chat with a voice message, and an incoming
 * call ringing over it the way the app's call notification does. Same tokens and em stage as DesktopMock (here
 * 100 x 205 em), made-up people. aria-hidden: the section's text says it in words.
 */
export function PhoneMock() {
  const bars = [3, 6, 9, 5, 8, 12, 7, 4, 9, 11, 6, 3, 7, 10, 5, 8, 4, 6, 9, 5];
  return (
    <div class="mk-phone" aria-hidden="true">
      <div class="mkp-screen">
        <div class="mkp-status">
          <span>9:41</span>
          <span class="mkp-notch" />
          <I.SignalGood size={10} />
        </div>
        <div class="mkp-call">
          <Face name="ana" tone={1} />
          <div class="mkp-call-text">
            <strong>ana</strong>
            <span>{t('is calling you')}</span>
          </div>
          <span class="mkp-btn decline">
            <I.Hangup size={12} />
          </span>
          <span class="mkp-btn answer">
            <I.Phone size={12} />
          </span>
        </div>
        <div class="mkp-head">
          <I.Back size={12} />
          <div>
            <small>No. 01 · Lost Woods</small>
            <strong>general</strong>
          </div>
        </div>
        <div class="mkp-chat">
          <div class="mkp-msg">
            <Face name="theo" tone={2} />
            <div>
              <b>theo</b>
              <p>{t('anyone up for a match tonight?')}</p>
            </div>
          </div>
          <div class="mkp-msg">
            <Face name="bia" tone={3} />
            <div>
              <b>bia</b>
              <div class="mkp-voice">
                <span class="mkp-play">
                  <I.Play size={10} />
                </span>
                <For each={bars}>{(h) => <i style={{ height: `${h * 0.45}em` }} />}</For>
                <small>0:07</small>
              </div>
            </div>
          </div>
          <div class="mkp-msg">
            <Face name="ana" tone={1} />
            <div>
              <b>ana</b>
              <p>{t("I'm in, calling you now")}</p>
            </div>
          </div>
        </div>
        <div class="mkp-composer">
          <I.Plus size={12} />
          <span>{t('Message {name}', { name: '#general' })}</span>
          <I.Mic size={12} />
        </div>
      </div>
    </div>
  );
}
