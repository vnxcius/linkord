// DM and group DM calls: the "<friend> is calling" card with Discord's ringtone, and the ringing you hear
// while you wait for someone to pick up.
import { createMemo, For, onCleanup, Show } from 'solid-js';
import { api, media } from '../lib/api';
import { selectChannel } from '../lib/actions';
import { t } from '../lib/i18n';
import { notify } from '../lib/platform';
import { sounds } from '../lib/sounds';
import { dmName, state, voiceMembers } from '../lib/store';
import { Kind } from '../lib/types';
import { attempt } from '../lib/ui';
import { joinVoice, toggleCamera, voiceUi } from '../lib/voice';
import { Avatar } from './Avatar';
import * as I from './Icons';

/** The DM call ringing us right now, if any (and we're not in it). */
function incoming(): string | undefined {
  const me = state.me?.id;
  return Object.entries(state.calls).find(
    ([ch, ringing]) => !!me && ringing.includes(me) && voiceUi.channelId !== ch && !!state.channels[ch],
  )?.[0];
}

function IncomingCall(p: { channelId: string }) {
  const ch = () => state.channels[p.channelId];
  const callers = () => voiceMembers(p.channelId).map((v) => v.user_id);
  const stop = sounds.ringIncoming();
  onCleanup(stop);
  if (!document.hasFocus()) {
    const who = callers()[0];
    void notify(dmName(ch()!), t('Incoming call'), media(state.users[who ?? '']?.avatar));
  }
  const accept = async (video = false) => {
    stop();
    selectChannel(p.channelId);
    await joinVoice(p.channelId);
    if (video) {
      for (let i = 0; i < 50 && voiceUi.connecting; i++) await new Promise((r) => setTimeout(r, 100));
      if (voiceUi.channelId === p.channelId && !voiceUi.camera) await toggleCamera();
    }
  };
  const decline = () => attempt(() => api('POST', `/channels/${p.channelId}/call/decline`));
  return (
    <div class="incoming-call" role="alertdialog" aria-label={t('Incoming call')}>
      <div class="incoming-avatars">
        <For each={callers().slice(0, 3)}>{(id) => <Avatar user={state.users[id]} size={72} />}</For>
      </div>
      <strong class="incoming-name">{dmName(ch()!)}</strong>
      <span class="incoming-sub">{ch()?.kind === Kind.GroupDm ? t('Incoming group call…') : t('Incoming call…')}</span>
      <div class="incoming-actions">
        <button
          class="call-btn decline"
          aria-label={t('Decline')}
          data-tip={t('Decline')}
          onClick={() => void decline()}
        >
          <I.Hangup size={22} />
        </button>
        <button
          class="call-btn accept video"
          aria-label={t('Join with video')}
          data-tip={t('Join with video')}
          onClick={() => void accept(true)}
        >
          <I.Camera size={22} />
        </button>
        <button
          class="call-btn accept"
          aria-label={t('Join call')}
          data-tip={t('Join call')}
          onClick={() => void accept()}
        >
          <I.Phone size={22} />
        </button>
      </div>
    </div>
  );
}

/** Rings while we wait in a DM call nobody else has joined yet. */
function OutgoingRing() {
  const stop = sounds.ringOutgoing();
  onCleanup(stop);
  return null;
}

export function Calls() {
  const ringingUs = createMemo(incoming);
  const waiting = () => {
    const ch = voiceUi.channelId;
    if (!ch || voiceUi.connecting || !state.calls[ch]?.length) return false;
    return voiceMembers(ch).every((v) => v.user_id === state.me?.id);
  };
  return (
    <>
      <Show when={ringingUs()} keyed>
        {(ch) => <IncomingCall channelId={ch} />}
      </Show>
      <Show when={waiting()}>
        <OutgoingRing />
      </Show>
    </>
  );
}
