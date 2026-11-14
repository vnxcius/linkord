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
        <span>Pottira</span>
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
