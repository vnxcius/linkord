// WhatsApp-style ticks on your DMs (server receipts.rs): sent, delivered (a device of theirs got it), read. Mirrors
// android core Store.kt tickFor / withReceipt.
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
  if (others.every((r) => reached(r.read_id))) return 'read';
  if (others.every((r) => reached(r.read_id) || reached(r.delivered_id))) return 'delivered';
  return 'sent';
}
