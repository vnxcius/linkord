// Message info, WhatsApp-style: when your DM was sent, and when each person got it and read it (server receipts.rs
// GET /channels/{id}/messages/{mid}/receipts), and for voice messages when they played it. Asked again whenever a
// receipt in the conversation moves.
import { createResource, For, Show, type JSX } from 'solid-js';
import { api } from '../lib/api';
import { dateLocale, t } from '../lib/i18n';
import { isVoiceMessage } from '../lib/receipts';
import { nameOf, state } from '../lib/store';
import type { Message } from '../lib/types';
import { Avatar } from './Avatar';
import * as I from './Icons';
import { Dialog } from './Modals';

interface MessageReceipt {
  user_id: string;
  delivered: boolean;
  read: boolean;
  /** False when either of you has read receipts off (Privacy): then there's no Read line. */
  read_receipts?: boolean;
  delivered_at: string | null;
  read_at: string | null;
  /** Voice messages: when they played it. */
  played_at?: string | null;
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' }) : '';

function Line(p: { icon: JSX.Element; label: string; time?: string | null; read?: boolean }) {
  // undefined/null = not yet; '' = it happened before times were kept.
  const done = () => p.time != null;
  return (
    <div class="info-line" classList={{ done: done(), read: p.read && done() }}>
      <span class="info-tick">{p.icon}</span>
      <span class="info-label">{p.label}</span>
      <span class="info-time">{done() ? p.time : t('Not yet')}</span>
    </div>
  );
}

export function MessageInfoModal(p: { message: Message }) {
  const [list] = createResource(
    () => JSON.stringify([state.receipts[p.message.channel_id] ?? {}, p.message.played_by ?? []]),
    () => api<MessageReceipt[]>('GET', `/channels/${p.message.channel_id}/messages/${p.message.id}/receipts`),
  );
  return (
    <Dialog title={t('Message info')}>
      <div class="message-info">
        <Line icon={<I.Check size={16} />} label={t('Sent')} time={when(p.message.created_at)} />
        <Show
          when={list.latest}
          fallback={
            <Show when={list.error} fallback={<div class="spinner" />}>
              <p class="muted small">{t("Couldn't reach the server. Check your connection and try again.")}</p>
            </Show>
          }
        >
          {(people) => (
            <For each={people()}>
              {(r) => (
                <>
                  <Show when={people().length > 1}>
                    <div class="info-person">
                      <Avatar user={state.users[r.user_id] ?? { id: r.user_id, username: '' }} size={20} />
                      <strong>{nameOf(r.user_id)}</strong>
                    </div>
                  </Show>
                  <Line
                    icon={<I.CheckDouble size={16} />}
                    label={t('Delivered')}
                    time={r.delivered ? when(r.delivered_at) : null}
                  />
                  <Show when={r.read_receipts !== false}>
                    <Line
                      icon={<I.CheckDouble size={16} />}
                      label={t('Read')}
                      time={r.read ? when(r.read_at) : null}
                      read
                    />
                    <Show when={isVoiceMessage(p.message)}>
                      <Line
                        icon={<I.Mic size={16} />}
                        label={t('Played')}
                        time={r.played_at ? when(r.played_at) : null}
                        read
                      />
                    </Show>
                  </Show>
                </>
              )}
            </For>
          )}
        </Show>
      </div>
    </Dialog>
  );
}
