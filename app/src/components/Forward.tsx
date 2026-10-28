import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { forwardMessage } from '../lib/actions';
import { plural, t } from '../lib/i18n';
import { can, P } from '../lib/perms';
import { dmName, dmRecipient, isBlocked, nameOf, sortedDms, state } from '../lib/store';
import type { Message } from '../lib/types';
import { Kind, Rel } from '../lib/types';
import { setUi, toast } from '../lib/ui';
import { Avatar } from './Avatar';
import * as I from './Icons';
import { renderContent } from './MessageItem';
import { Dialog, useSubmit } from './Modals';

const MAX_TARGETS = 5;

interface Target {
  /** 'c:<channel id>' or 'u:<user id>' (a friend without a DM yet). */
  key: string;
  name: string;
  sub?: string;
  icon: () => JSX.Element;
}

/** Places you can forward to: DMs first (most recent), then friends you haven't messaged, then server channels. */
function targets(withFiles: boolean): Target[] {
  const out: Target[] = [];
  const dmWith = new Set<string>();
  for (const c of sortedDms()) {
    const other = dmRecipient(c);
    if (c.kind === Kind.Dm && other) {
      dmWith.add(other.id);
      if (isBlocked(other.id)) continue;
    }
    out.push({
      key: `c:${c.id}`,
      name: dmName(c),
      sub: c.kind === Kind.GroupDm ? plural(c.recipients?.length ?? 0, '{n} member', '{n} members') : other?.username,
      icon: () =>
        c.kind === Kind.GroupDm ? (
          <span class="group-icon">
            <I.Users size={18} />
          </span>
        ) : (
          <Avatar user={other} size={32} />
        ),
    });
  }
  const friends = Object.entries(state.relationships)
    .filter(([id, r]) => r === Rel.Friend && !dmWith.has(id))
    .map(([id]) => id)
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  for (const id of friends) {
    out.push({ key: `u:${id}`, name: nameOf(id), sub: state.users[id]?.username, icon: () => <Avatar user={state.users[id]} size={32} /> });
  }
  for (const gid of state.guildOrder) {
    if (!can(gid, P.SEND_MESSAGES) || (withFiles && !can(gid, P.ATTACH_FILES))) continue;
    const guild = state.guilds[gid]?.name;
    const channels = Object.values(state.channels)
      .filter((c) => c.guild_id === gid && c.kind === Kind.Text)
      .sort((a, b) => a.position - b.position);
    for (const c of channels) {
      out.push({
        key: `c:${c.id}`,
        name: `#${c.name}`,
        sub: guild,
        icon: () => (
          <span class="group-icon">
            <I.Hash size={18} />
          </span>
        ),
      });
    }
  }
  return out;
}

/** Discord-style "Forward To": pick up to 5 places, optionally add a message, send. */
export function ForwardModal(p: { message: Message }) {
  const snapshot = () => p.message.forwarded ?? p.message;
  const all = createMemo(() => targets(snapshot().attachments.length > 0));
  const [picked, setPicked] = createSignal<string[]>([]);
  const [filter, setFilter] = createSignal('');
  const [comment, setComment] = createSignal('');
  const { busy, error, run } = useSubmit();
  const shown = () => {
    const q = filter().trim().toLowerCase();
    return q ? all().filter((x) => x.name.toLowerCase().includes(q) || x.sub?.toLowerCase().includes(q)) : all();
  };
  const toggle = (key: string) =>
    setPicked((l) => (l.includes(key) ? l.filter((x) => x !== key) : l.length < MAX_TARGETS ? [...l, key] : l));
  const preview = () => snapshot().content.split('\n')[0] || (snapshot().attachments.length ? t('Attachment') : '');
  const guildId = () => p.message.forwarded?.guild_id ?? state.channels[p.message.channel_id]?.guild_id;
  const send = () =>
    run(async () => {
      const keys = picked();
      const ids = (prefix: string) => keys.filter((k) => k.startsWith(prefix)).map((k) => k.slice(2));
      await forwardMessage(p.message, { channelIds: ids('c:'), userIds: ids('u:') }, comment().trim());
      setUi('modal', null);
      toast(plural(keys.length, 'Message forwarded to {n} place', 'Message forwarded to {n} places'));
    });
  return (
    <Dialog
      title={t('Forward To')}
      subtitle={t('Select where you want to share this message.')}
      footer={
        <div class="forward-footer">
          <input
            class="filter-input"
            placeholder={t('Add an optional message...')}
            maxLength={4000}
            value={comment()}
            onInput={(e) => setComment(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && picked().length && !busy() && send()}
          />
          <button class="btn primary" disabled={busy() || !picked().length} onClick={send}>
            {picked().length > 1 ? t('Send ({n})', { n: picked().length }) : t('Send')}
          </button>
        </div>
      }
    >
      <input class="filter-input" placeholder={t('Search')} value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} autofocus />
      <div class="pick-list forward-list">
        <For each={shown()} fallback={<p class="empty-hint">{t('No results')}</p>}>
          {(x) => {
            const on = () => picked().includes(x.key);
            return (
              <label class="pick-row" classList={{ disabled: !on() && picked().length >= MAX_TARGETS }}>
                {x.icon()}
                <span class="grow">
                  {x.name} <Show when={x.sub}><span class="muted small">{x.sub}</span></Show>
                </span>
                <input type="checkbox" checked={on()} disabled={!on() && picked().length >= MAX_TARGETS} onChange={() => toggle(x.key)} />
              </label>
            );
          }}
        </For>
      </div>
      <div class="forward-preview">
        <I.Forward size={14} />
        <span class="forward-preview-text" innerHTML={renderContent(preview(), guildId())} />
      </div>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </Dialog>
  );
}
