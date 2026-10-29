// Voice channel status, like Discord's: a line of text about what the call is up to, shown under the channel
// in the sidebar and in the header. Anyone in the call can set it (and channel managers while it's going on);
// it ends with the call.
import { createEffect, createSignal, Show } from 'solid-js';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { can, P } from '../lib/perms';
import { state, voiceMembers } from '../lib/store';
import type { Channel } from '../lib/types';
import { attempt, setUi, ui } from '../lib/ui';
import { voiceUi } from '../lib/voice';
import { pickerSpot } from './CustomStatus';
import { EmojiPicker } from './EmojiPicker';
import * as I from './Icons';
import { onContentClick, renderContent } from './MessageItem';

const MAX = 500;

/** The status of a call going on in the channel. */
export const voiceStatusOf = (channelId: string) =>
  voiceMembers(channelId).length ? state.voiceStatus[channelId] : undefined;

export const canSetVoiceStatus = (c: Channel) =>
  voiceUi.channelId === c.id || (voiceMembers(c.id).length > 0 && can(c.guild_id, P.MANAGE_CHANNELS));

/** Opens the channel and starts editing its status in the header. */
export const editVoiceStatus = (channelId: string) => setUi('editVoiceStatus', channelId);

const saveStatus = (channelId: string, status: string) =>
  attempt(() => api('PUT', `/channels/${channelId}/voice-status`, { status: status.trim() || null }));

/** Under the voice channel's name in the sidebar. */
export function VoiceStatusLine(p: { channel: Channel }) {
  return (
    <Show when={voiceStatusOf(p.channel.id)}>
      {(s) => <div class="voice-status-line" title={s()} innerHTML={renderContent(s(), p.channel.guild_id)} />}
    </Show>
  );
}

/** In the voice channel's header: the status, or "Set a channel status" for people who can. */
export function VoiceStatusHeader(p: { channel: Channel }) {
  const editing = () => ui.editVoiceStatus === p.channel.id && canSetVoiceStatus(p.channel);
  const status = () => voiceStatusOf(p.channel.id);
  return (
    <Show
      when={editing()}
      fallback={
        <Show when={status() || canSetVoiceStatus(p.channel)}>
          <span class="header-sep" />
          <Show
            when={canSetVoiceStatus(p.channel)}
            fallback={
              <span
                class="topic"
                innerHTML={renderContent(status()!, p.channel.guild_id)}
                onClick={(e) => onContentClick(e, p.channel.guild_id)}
              />
            }
          >
            <button
              class="voice-status-btn"
              classList={{ empty: !status() }}
              title={t('Set a channel status')}
              onClick={() => editVoiceStatus(p.channel.id)}
            >
              <Show when={status()} fallback={<span>{t('Set a channel status')}</span>}>
                {(s) => <span class="voice-status-text" innerHTML={renderContent(s(), p.channel.guild_id)} />}
              </Show>
              <I.Edit size={14} />
            </button>
          </Show>
        </Show>
      }
    >
      <span class="header-sep" />
      <VoiceStatusInput channel={p.channel} />
    </Show>
  );
}

function VoiceStatusInput(p: { channel: Channel }) {
  const [text, setText] = createSignal(state.voiceStatus[p.channel.id] ?? '');
  const [picker, setPicker] = createSignal<{ x: number; y: number } | null>(null);
  let input!: HTMLInputElement;
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save && text().trim() !== (state.voiceStatus[p.channel.id] ?? '')) void saveStatus(p.channel.id, text());
    setUi('editVoiceStatus', null);
  };
  createEffect(() => input.focus());

  return (
    <div class="voice-status-edit">
      <input
        ref={input}
        value={text()}
        maxLength={MAX}
        placeholder={t("What's the call about?")}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(true);
          else if (e.key === 'Escape') finish(false);
        }}
        // Picking an emoji moves focus to the picker; saving then happens on Enter or a later blur.
        onBlur={() => !picker() && finish(true)}
      />
      <button
        class="icon-btn tiny"
        aria-label={t('Choose an emoji')}
        data-tip={t('Choose an emoji')}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          setPicker(picker() ? null : pickerSpot(e.currentTarget));
        }}
      >
        <I.Smile size={16} />
      </button>
      <Show when={picker()}>
        {(at) => (
          <EmojiPicker
            class="message-picker"
            style={{ left: `${at().x}px`, top: `${at().y}px` }}
            guildId={p.channel.guild_id}
            onClose={() => {
              setPicker(null);
              input.focus();
            }}
            onPick={(e) => {
              const pos = input.selectionStart ?? text().length;
              const next = (text().slice(0, pos) + e.text + text().slice(input.selectionEnd ?? pos)).slice(0, MAX);
              setText(next);
              setPicker(null);
              input.focus();
            }}
          />
        )}
      </Show>
      <span class="voice-status-count muted small">{MAX - text().length}</span>
    </div>
  );
}
