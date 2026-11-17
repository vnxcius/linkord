// WhatsApp-style ticks on your DMs (server receipts.rs): sent, delivered (a device of theirs got it), read; a voice
// message is only read once heard (played_by). Mirrors android core Store.kt tickFor / withReceipt.
import { reconcile } from 'solid-js/store';
import { cmpId } from './ids';
import { setState, state } from './store';
import type { Message, Receipt } from './types';
import { isPrivate } from './types';

export type Tick = 'sent' | 'delivered' | 'read';

/** All of them at once (READY, DM_RECEIPTS). */
export function setReceipts(all: Record<string, Receipt[]>) {
  setState(
    'receipts',
    reconcile(
      Object.fromEntries(
        Object.entries(all).map(([ch, list]) => [ch, Object.fromEntries(list.map((r) => [r.user_id, r]))]),
      ),
    ),
  );
}

/** One moved forward (DM_RECEIPT); positions never go back. */
export function putReceipt(channelId: string, userId: string, delivered?: string | null, read?: string | null) {
  const cur = state.receipts[channelId]?.[userId] ?? { user_id: userId };
  const later = (a?: string | null, b?: string | null) => (!b || (a && cmpId(a, b) >= 0) ? (a ?? null) : b);
  const next = { user_id: userId, delivered_id: later(cur.delivered_id, delivered), read_id: later(cur.read_id, read) };
  if (!state.receipts[channelId]) setState('receipts', channelId, {});
  setState('receipts', channelId, userId, next);
}

/**
 * Your message's tick in a DM: read once everyone else read it, delivered once a device of each of them got it, else
 * sent. Undefined outside DMs, for others' messages and for ones not on the server yet.
 */
export function tickFor(m: Message): Tick | undefined {
  const ch = state.channels[m.channel_id];
  if (!ch || !isPrivate(ch.kind) || m.pending || m.failed || m.ephemeral || m.author.id !== state.me?.id) return;
  const others = Object.values(state.receipts[m.channel_id] ?? {}).filter((r) => r.user_id !== m.author.id);
  if (!others.length) return 'sent';
  const reached = (pos?: string | null) => !!pos && cmpId(pos, m.id) >= 0;
  // Read positions are only there while both of you have read receipts on, and that goes for plays too.
  const heard = (userId: string) => !isVoiceMessage(m) || !!m.played_by?.includes(userId);
  if (others.every((r) => reached(r.read_id) && heard(r.user_id))) return 'read';
  if (others.every((r) => reached(r.read_id) || reached(r.delivered_id))) return 'delivered';
  return 'sent';
}

export const isVoiceMessage = (m: Message) => m.attachments.some((a) => !!a.waveform);

/** Your voice message in a DM: everyone else played it (the mic turns the accent colour, like the read ticks). */
export const heardByAll = (m: Message) => tickFor(m) === 'read' && isVoiceMessage(m);

/** Merges VOICE_PLAYED into the message, if it's loaded. */
export function putPlayed(channelId: string, messageId: string, userId: string) {
  if (!state.messages[channelId]) return;
  setState(
    'messages',
    channelId,
    'list',
    (m) => m.id === messageId,
    'played_by',
    (l) => (l?.includes(userId) ? l : [...(l ?? []), userId]),
  );
}
