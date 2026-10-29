import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from 'solid-js';
import { api } from '../lib/api';
import { jumpToMessage, jumpToPresent, loadMessages, loadNewer, markRead, selectChannel } from '../lib/actions';
import { dateLocale, joinList, plural, t } from '../lib/i18n';
import { cmpId } from '../lib/ids';
import { dmName, dmRecipient, nameOf, state } from '../lib/store';
import type { Channel, Message } from '../lib/types';
import { Kind } from '../lib/types';
import { attempt, focusComposer, isNarrow, setUi, ui } from '../lib/ui';
import { Avatar } from './Avatar';
import { Composer } from './Composer';
import * as I from './Icons';
import { formatTime, MessageItem, onContentClick, renderContent } from './MessageItem';
import { VoiceStatusHeader } from './VoiceStatus';
import { VoiceView } from './VoiceView';

const GROUP_WINDOW = 7 * 60_000;

/** Phones only: back from a chat to the server and channel lists. */
export function MobileBack() {
  return (
    <button class="icon-btn mobile-back" aria-label={t('Back to channels')} onClick={() => setUi('mobilePane', 'nav')}>
      <I.Back size={22} />
    </button>
  );
}

export function ChatHeader(p: { channel: Channel }) {
  const parent = () => (p.channel.parent_id ? state.channels[p.channel.parent_id] : undefined);
  const togglePanel = (panel: 'search' | 'pins') => setUi('panel', ui.panel === panel ? null : panel);
  return (
    <header class="chat-header">
      <MobileBack />
      <Switch>
        <Match when={p.channel.kind === Kind.Dm}>
          <Avatar user={dmRecipient(p.channel)} size={26} presence />
          <h2>{dmName(p.channel)}</h2>
        </Match>
        <Match when={p.channel.kind === Kind.GroupDm}>
          <I.Users size={22} class="muted" />
          <h2>{dmName(p.channel)}</h2>
          <span class="header-sep" />
          <span class="topic">{plural(p.channel.recipients?.length ?? 0, '{n} member', '{n} members')}</span>
        </Match>
        <Match when={p.channel.kind === Kind.Voice}>
          <I.Speaker size={22} class="muted" />
          <h2>{p.channel.name}</h2>
          <VoiceStatusHeader channel={p.channel} />
        </Match>
        <Match when={p.channel.kind === Kind.Thread}>
          <Show when={parent()}>
            <button class="crumb" onClick={() => selectChannel(parent()!.id)}>
              <I.Hash size={20} class="muted" /> {parent()!.name}
            </button>
            <I.Chevron size={14} class="muted crumb-sep" />
          </Show>
          <I.Thread size={20} class="muted" />
          <h2>{p.channel.name}</h2>
          <Show when={p.channel.archived}>
            <span class="tag">{t('Archived')}</span>
          </Show>
        </Match>
        <Match when={true}>
          <I.Hash size={22} class="muted" />
          <h2>{p.channel.name}</h2>
          <Show when={p.channel.topic}>
            <span class="header-sep" />
            <span
              class="topic"
              innerHTML={renderContent(p.channel.topic, p.channel.guild_id)}
              onClick={(e) => onContentClick(e, p.channel.guild_id)}
            />
          </Show>
        </Match>
      </Switch>
      <div class="header-actions">
        <Show when={p.channel.kind !== Kind.Voice}>
          <button
            class="icon-btn"
            classList={{ on: ui.panel === 'pins' }}
            aria-label={t('Pinned messages')}
            data-tip={t('Pinned messages')}
            onClick={() => togglePanel('pins')}
          >
            <I.Pin size={20} />
          </button>
        </Show>
        <Show when={p.channel.guild_id && p.channel.kind === Kind.Text}>
          <button
            class="icon-btn"
            classList={{ on: isNarrow() ? ui.membersDrawer : ui.showMembers }}
            aria-label={t('Member list')}
            data-tip={t('Member list')}
            onClick={() =>
              isNarrow() ? setUi('membersDrawer', !ui.membersDrawer) : setUi('showMembers', !ui.showMembers)
            }
          >
            <I.Users size={20} />
          </button>
        </Show>
        <Show when={p.channel.kind !== Kind.Voice}>
          <SearchBox channel={p.channel} />
        </Show>
      </div>
    </header>
  );
}

function SearchBox(p: { channel: Channel }) {
  const [value, setValue] = createSignal('');
  const run = async () => {
    const q = value().trim();
    if (!q) return;
    setUi('panel', 'search');
    setUi('search', { query: q, loading: true, results: null });
    const filters = parseFilters(q);
    const params = new URLSearchParams();
    if (filters.text) params.set('q', filters.text);
    if (filters.author) params.set('author_id', filters.author);
    if (filters.has) params.set('has', filters.has);
    const path = p.channel.guild_id
      ? `/guilds/${p.channel.guild_id}/messages/search?${params}`
      : `/channels/${p.channel.id}/messages/search?${params}`;
    await attempt(async () => setUi('search', 'results', await api('GET', path)));
    setUi('search', 'loading', false);
  };
  // Supports "from:username" and "has:image|file|link", like Discord.
  const parseFilters = (q: string) => {
    let author: string | undefined;
    let has: string | undefined;
    const text = q
      .replace(/from:(\S+)/i, (_, name: string) => {
        const n = name.replace(/^@/, '').toLowerCase();
        author = Object.values(state.users).find(
          (u) => u.username === n || nameOf(u.id, p.channel.guild_id).toLowerCase() === n,
        )?.id;
        return '';
      })
      .replace(/has:(image|file|link)/i, (_, h: string) => ((has = h.toLowerCase()), ''))
      .trim();
    return { text, author, has };
  };
  return (
    <label class="search-box">
      <input
        placeholder={t('Search')}
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Enter' && void run()}
      />
      <I.Search size={16} />
    </label>
  );
}

export function SidePanel(p: { channel: Channel }) {
  return (
    <aside class="side-panel">
      <Show when={ui.panel === 'search'} fallback={<PinsPanel channel={p.channel} />}>
        <div class="panel-head">
          <span>
            {ui.search.results ? plural(ui.search.results.total, '{n} result', '{n} results') : t('Searching…')}
          </span>
          <button class="icon-btn tiny" aria-label={t('Close')} onClick={() => setUi('panel', null)}>
            <I.Close size={14} />
          </button>
        </div>
        <p class="panel-hint">{t('Tip: use from:username, has:image, has:file or has:link')}</p>
        <div class="panel-list">
          <For
            each={(ui.search.results?.messages ?? []) as Message[]}
            fallback={<p class="empty-hint">{ui.search.loading ? '' : t('Nothing found.')}</p>}
          >
            {(m) => <ResultCard m={m} />}
          </For>
        </div>
      </Show>
    </aside>
  );
}

function PinsPanel(p: { channel: Channel }) {
  // Refetch when a message in this channel gets pinned/unpinned.
  const pinnedKey = () =>
    (state.messages[p.channel.id]?.list ?? [])
      .filter((m) => m.pinned)
      .map((m) => m.id)
      .join();
  const [pins] = createResource(
    () => [p.channel.id, pinnedKey()] as const,
    ([id]) => api<Message[]>('GET', `/channels/${id}/pins`),
  );
  return (
    <>
      <div class="panel-head">
        <span>{t('Pinned Messages')}</span>
        <button class="icon-btn tiny" aria-label={t('Close')} onClick={() => setUi('panel', null)}>
          <I.Close size={14} />
        </button>
      </div>
      <div class="panel-list">
        <For
          each={pins() ?? []}
          fallback={
            <p class="empty-hint">
              {pins.loading ? '' : t('No pinned messages yet. Right-click a message to pin it.')}
            </p>
          }
        >
          {(m) => <ResultCard m={m} />}
        </For>
      </div>
    </>
  );
}

function ResultCard(p: { m: Message }) {
  const ch = () => state.channels[p.m.channel_id];
  return (
    <button class="result-card" onClick={() => void jumpToMessage(p.m.channel_id, p.m.id)}>
      <div class="result-meta">
        <Show when={ch()?.guild_id}>
          <span class="muted">#{ch()?.name}</span>
        </Show>
        <span class="muted small">{formatTime(p.m.created_at)}</span>
      </div>
      <div class="result-body">
        <Avatar user={state.users[p.m.author.id] ?? p.m.author} size={28} />
        <div>
          <strong>{nameOf(p.m.author.id, ch()?.guild_id)}</strong>
          <div class="content" innerHTML={renderContent(p.m.content || t('(attachment)'), ch()?.guild_id)} />
        </div>
      </div>
    </button>
  );
}

export function ChatView(p: { channel: Channel }) {
  return (
    <Show when={p.channel.kind !== Kind.Voice} fallback={<VoiceView channel={p.channel} />}>
      <section class="chat">
        <MessageList channel={p.channel} />
        <TypingBar channelId={p.channel.id} />
        <Show when={ui.selection?.channelId === p.channel.id} fallback={<Composer channel={p.channel} />}>
          <SelectionBar channelId={p.channel.id} />
        </Show>
      </section>
    </Show>
  );
}

/** Shown instead of the composer while picking messages to delete in bulk. */
function SelectionBar(p: { channelId: string }) {
  const ids = () => ui.selection?.ids ?? [];
  const cancel = () => {
    setUi('selection', null);
    focusComposer();
  };
  const remove = () => {
    const list = ids();
    if (!list.length) return;
    setUi('modal', {
      type: 'confirm',
      title: plural(list.length, 'Delete {n} message', 'Delete {n} messages'),
      body: t("Are you sure? This can't be undone."),
      action: t('Delete'),
      run: async () => {
        for (let i = 0; i < list.length; i += 100) {
          await api('POST', `/channels/${p.channelId}/messages/bulk-delete`, { messages: list.slice(i, i + 100) });
        }
        cancel();
      },
    });
  };
  const onKey = (e: KeyboardEvent) => {
    if (ui.modal || (e.target as HTMLElement).closest?.('input, textarea')) return;
    if (e.key === 'Escape') cancel();
    else if (e.key === 'Delete' || e.key === 'Backspace') remove();
  };
  window.addEventListener('keydown', onKey);
  onCleanup(() => window.removeEventListener('keydown', onKey));
  // Leaving the channel ends the selection.
  onCleanup(() => ui.selection?.channelId === p.channelId && setUi('selection', null));
  return (
    <div class="selection-bar">
      <span class="selection-count">
        <strong>{ids().length}</strong> {t('selected')}
      </span>
      <span class="muted small selection-hint">{t('Click messages to select them · Shift-click for a range')}</span>
      <span class="grow" />
      <button class="btn" onClick={cancel}>
        {t('Cancel')}
      </button>
      <button class="btn danger" disabled={!ids().length} onClick={remove}>
        <I.Trash size={16} /> {t('Delete')}
      </button>
    </div>
  );
}

function dayKey(iso: string) {
  return new Date(iso).toDateString();
}

function MessageList(p: { channel: Channel }) {
  let scroller!: HTMLDivElement;
  let stickToBottom = true;
  const bucket = () => state.messages[p.channel.id];
  const list = () => bucket()?.list ?? [];

  // First unread message, captured when the channel opens so the divider doesn't jump while reading.
  const [unreadFrom, setUnreadFrom] = createSignal<string | undefined>();
  createEffect(
    on(
      () => p.channel.id,
      () => {
        setUnreadFrom(state.readStates[p.channel.id]);
        stickToBottom = !state.highlight;
      },
    ),
  );

  // Escape marks the channel read and drops the "new" divider (like Discord), unless it is closing
  // something else first: a menu, dialog, picker, profile, reply, message edit or fullscreen video.
  // Capture phase, so we see those still open before their own Escape handlers close them.
  const onEscape = (e: KeyboardEvent) => {
    if (
      e.key !== 'Escape' ||
      e.defaultPrevented ||
      ui.modal ||
      ui.menu ||
      ui.lightbox ||
      ui.replyTo[p.channel.id] ||
      document.fullscreenElement
    )
      return;
    if (document.querySelector('.context-menu, .emoji-picker, .profile-card, .settings-screen')) return;
    if ((e.target as HTMLElement).closest?.('.message textarea, .vp')) return;
    setUnreadFrom(undefined);
    markRead([p.channel.id]);
  };
  window.addEventListener('keydown', onEscape, true);
  onCleanup(() => window.removeEventListener('keydown', onEscape, true));

  const items = createMemo(() => {
    const out: { m: Message; grouped: boolean; newDay: boolean; firstUnread: boolean }[] = [];
    let prev: Message | undefined;
    let unreadMarked = false;
    const read = unreadFrom();
    for (const m of list()) {
      const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
      const grouped =
        !!prev &&
        !newDay &&
        !m.reply_to &&
        prev.author.id === m.author.id &&
        new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < GROUP_WINDOW;
      const firstUnread =
        !!read && !unreadMarked && !m.pending && cmpId(m.id, read) > 0 && m.author.id !== state.me?.id;
      if (firstUnread) unreadMarked = true;
      out.push({ m, grouped: grouped && !firstUnread, newDay, firstUnread });
      prev = m;
    }
    return out;
  });

  const scrollToBottom = () => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  };

  createEffect(
    on(
      () => list().length,
      () => {
        if (stickToBottom) queueMicrotask(scrollToBottom);
      },
    ),
  );

  // Sending a message always brings you back to the newest messages.
  createEffect(
    on(
      () => ui.sent.n,
      () => {
        if (ui.sent.channelId !== p.channel.id) return;
        stickToBottom = true;
        queueMicrotask(scrollToBottom);
      },
      { defer: true },
    ),
  );

  // Jumps (search, pins, replies) center the target message once it's rendered.
  createEffect(() => {
    const id = state.highlight;
    if (!id || !list().some((m) => m.id === id)) return;
    stickToBottom = false;
    queueMicrotask(() => document.getElementById(`msg-${id}`)?.scrollIntoView({ block: 'center' }));
  });

  // Images load after layout; re-pin when they do.
  const ro = new ResizeObserver(() => stickToBottom && scrollToBottom());
  createEffect(() => {
    const inner = scroller?.firstElementChild;
    if (inner) ro.observe(inner);
  });
  onCleanup(() => ro.disconnect());

  const onScroll = async () => {
    const fromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    stickToBottom = fromBottom < 40 && !bucket()?.hasNewer;
    const b = bucket();
    if (!b?.loaded || b.loading || !list().length) return;
    if (scroller.scrollTop < 400 && b.hasMore) {
      const prevHeight = scroller.scrollHeight;
      await loadMessages(p.channel.id, list()[0].id);
      scroller.scrollTop += scroller.scrollHeight - prevHeight;
    } else if (fromBottom < 400 && b.hasNewer) {
      await loadNewer(p.channel.id);
    }
  };

  return (
    <div class="messages-wrap">
      <Show when={bucket()?.hasNewer}>
        <div class="history-bar">
          <span>{t("You're viewing older messages")}</span>
          <button
            class="link-btn"
            onClick={() => void jumpToPresent(p.channel.id).then(() => ((stickToBottom = true), scrollToBottom()))}
          >
            {t('Jump to present')}
          </button>
        </div>
      </Show>
      <div class="messages" ref={scroller} onScroll={onScroll}>
        <div class="messages-inner">
          <Show when={bucket()?.loaded && !bucket()?.hasMore}>
            <ChannelWelcome channel={p.channel} />
          </Show>
          <Show when={!bucket()?.loaded || (bucket()?.loading && bucket()?.hasMore)}>
            <div class="loading-messages">
              <div class="spinner" />
            </div>
          </Show>
          <For each={items()}>
            {(it) => (
              <>
                <Show when={it.newDay}>
                  <div class="day-divider">
                    <span>
                      {new Date(it.m.created_at).toLocaleDateString(dateLocale(), {
                        weekday: 'long',
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </span>
                  </div>
                </Show>
                <Show when={it.firstUnread}>
                  <div class="unread-divider">
                    <span>{t('new')}</span>
                  </div>
                </Show>
                <MessageItem message={it.m} grouped={it.grouped} guildId={p.channel.guild_id} />
              </>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

function ChannelWelcome(p: { channel: Channel }) {
  const starter = () => p.channel.thread_message_id;
  return (
    <div class="welcome">
      <Switch>
        <Match when={p.channel.kind === Kind.Dm}>
          <Avatar user={dmRecipient(p.channel)} size={80} />
          <h1>{dmName(p.channel)}</h1>
          <p class="muted">
            {t('This is the beginning of your direct message history with {name}.', { name: dmName(p.channel) })}
          </p>
        </Match>
        <Match when={p.channel.kind === Kind.GroupDm}>
          <div class="welcome-icon">
            <I.Users size={36} />
          </div>
          <h1>{dmName(p.channel)}</h1>
          <p class="muted">{t('Welcome to the beginning of this group.')}</p>
        </Match>
        <Match when={p.channel.kind === Kind.Thread}>
          <div class="welcome-icon">
            <I.Thread size={36} />
          </div>
          <h1>{p.channel.name}</h1>
          <p class="muted">
            {t('Started by {name}.', { name: nameOf(p.channel.owner_id ?? '', p.channel.guild_id) })}{' '}
            <Show when={starter() && p.channel.parent_id}>
              <button class="link-btn" onClick={() => void jumpToMessage(p.channel.parent_id!, starter()!)}>
                {t('See the original message')}
              </button>
            </Show>
          </p>
        </Match>
        <Match when={true}>
          <div class="welcome-icon">
            <I.Hash size={36} />
          </div>
          <h1>{t('Welcome to #{name}', { name: p.channel.name })}</h1>
          <p class="muted">{t('This is the start of the #{name} channel.', { name: p.channel.name })}</p>
        </Match>
      </Switch>
    </div>
  );
}

function TypingBar(p: { channelId: string }) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const gid = () => state.channels[p.channelId]?.guild_id;
  const typers = () =>
    Object.entries(state.typing[p.channelId] ?? {})
      .filter(([id, exp]) => exp > now() && id !== state.me?.id)
      .map(([id]) => nameOf(id, gid()));
  const text = () => {
    const names = typers();
    if (names.length === 0) return '';
    if (names.length === 1) return t('{name} is typing…', { name: names[0] });
    if (names.length <= 3) return t('{names} are typing…', { names: joinList(names) });
    return t('Several people are typing…');
  };
  return (
    <div class="typing-bar">
      <Show when={text()}>
        <span class="typing-dots">
          <i />
          <i />
          <i />
        </span>
        <span>{text()}</span>
      </Show>
    </div>
  );
}
