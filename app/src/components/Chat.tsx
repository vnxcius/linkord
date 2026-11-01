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
import {
  jumpToMessage,
  jumpToPresent,
  loadMessages,
  loadNewer,
  markRead,
  openDm,
  selectChannel,
  startCall,
} from '../lib/actions';
import { dateLocale, joinList, msg, plural, t } from '../lib/i18n';
import { cmpId } from '../lib/ids';
import { channelNumber, dmName, dmRecipient, nameOf, presenceOf, state, voiceMembers } from '../lib/store';
import type { Channel, Message } from '../lib/types';
import { isPrivate, Kind } from '../lib/types';
import { canSendVideo, voiceUi } from '../lib/voice';
import { prefs, setPrefs } from '../lib/prefs';
import { watches } from '../lib/watch';
import { watchExpanded, watchTheater } from './Watch';
import {
  attempt,
  focusComposer,
  isMobile,
  isNarrow,
  openMenu,
  openProfile,
  setUi,
  ui,
  type MenuEntry,
} from '../lib/ui';
import { Avatar } from './Avatar';
import { Composer } from './Composer';
import { Members } from './Members';
import { PrivateBadge } from './PrivateBadge';
import * as I from './Icons';
import { formatTime, MessageItem, onContentClick, renderContent } from './MessageItem';
import { VoiceStatusHeader } from './VoiceStatus';
import { VoiceView } from './VoiceView';

const GROUP_WINDOW = 7 * 60_000;
/** Within this many pixels of the newest message, new messages keep the chat scrolled to the bottom. */
const NEAR_BOTTOM = 240;

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
  const guild = () => (p.channel.guild_id ? state.guilds[p.channel.guild_id]?.name : undefined);
  const togglePanel = (panel: 'search' | 'pins') => setUi('panel', ui.panel === panel ? null : panel);
  const number = () => channelNumber(p.channel);
  return (
    <header class="chat-header">
      <MobileBack />
      <div class="header-title">
        {/* A small line above the name: where this is, like a page's running head. */}
        <span class="header-kicker">
          <Switch>
            <Match when={p.channel.kind === Kind.Dm}>{t('Direct Messages')}</Match>
            <Match when={p.channel.kind === Kind.GroupDm}>
              {plural(p.channel.recipients?.length ?? 0, '{n} member', '{n} members')}
            </Match>
            <Match when={p.channel.kind === Kind.Voice}>
              {t('Voice channel')}
              <Show when={guild()}> · {guild()}</Show>
            </Match>
            <Match when={p.channel.kind === Kind.Thread}>
              <Show when={parent()}>
                <button class="crumb" onClick={() => selectChannel(parent()!.id)}>
                  <Show when={number()} fallback={<I.Hash size={12} />}>
                    {t('No. {n}', { n: number()! })}
                  </Show>{' '}
                  · {parent()!.name}
                </button>
                <I.Chevron size={12} class="crumb-sep" />
              </Show>
              {t('Thread')}
            </Match>
            <Match when={true}>
              <Show when={number()}>{t('No. {n}', { n: number()! })}</Show>
              <Show when={guild()}> · {guild()}</Show>
            </Match>
          </Switch>
        </span>
        <div class="header-line">
          <Switch>
            <Match when={p.channel.kind === Kind.Dm}>
              <Avatar user={dmRecipient(p.channel)} size={26} presence />
              <h2>{dmName(p.channel)}</h2>
            </Match>
            <Match when={p.channel.kind === Kind.GroupDm}>
              <h2
                class="editable-title"
                title={t('Change group name')}
                onClick={() => setUi('modal', { type: 'channel-settings', channelId: p.channel.id })}
              >
                {dmName(p.channel)}
              </h2>
            </Match>
            <Match when={p.channel.kind === Kind.Voice}>
              <h2>{p.channel.name}</h2>
              <VoiceStatusHeader channel={p.channel} />
            </Match>
            <Match when={p.channel.kind === Kind.Thread}>
              <h2>{p.channel.name}</h2>
              <Show when={p.channel.archived}>
                <span class="tag">{t('Archived')}</span>
              </Show>
            </Match>
            <Match when={true}>
              <h2>{p.channel.name}</h2>
              <Show when={p.channel.topic}>
                <span
                  class="topic"
                  innerHTML={renderContent(p.channel.topic, p.channel.guild_id)}
                  onClick={(e) => onContentClick(e, p.channel.guild_id)}
                />
              </Show>
            </Match>
          </Switch>
        </div>
      </div>
      <div class="header-actions">
        <Show when={isPrivate(p.channel.kind) && voiceUi.channelId !== p.channel.id}>
          <button
            class="icon-btn"
            aria-label={t('Start Voice Call')}
            data-tip={t('Start Voice Call')}
            onClick={() => void startCall(p.channel.id)}
          >
            <I.Phone size={20} />
          </button>
          <Show when={canSendVideo}>
            <button
              class="icon-btn"
              aria-label={t('Start Video Call')}
              data-tip={t('Start Video Call')}
              onClick={() => void startCall(p.channel.id, true)}
            >
              <I.Camera size={20} />
            </button>
          </Show>
        </Show>
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
        <Show when={(p.channel.guild_id && p.channel.kind === Kind.Text) || p.channel.kind === Kind.GroupDm}>
          <button
            class="icon-btn"
            classList={{ on: isNarrow() ? ui.membersDrawer : ui.showMembers && !ui.panel }}
            aria-label={t('Member list')}
            data-tip={t('Member list')}
            onClick={() => {
              if (isNarrow()) return setUi('membersDrawer', !ui.membersDrawer);
              // From pins or search, the members button brings the margin back to people.
              if (ui.panel) return setUi({ panel: null, showMembers: true });
              setUi('showMembers', !ui.showMembers);
            }}
          >
            <I.Users size={20} />
          </button>
        </Show>
        <Show when={p.channel.kind !== Kind.Voice}>
          <SearchBox channel={p.channel} />
        </Show>
        <Show when={p.channel.kind === Kind.Voice}>
          <button
            class="icon-btn"
            classList={{ on: ui.voiceChat === p.channel.id }}
            aria-label={ui.voiceChat === p.channel.id ? t('Close chat') : t('Open chat')}
            data-tip={ui.voiceChat === p.channel.id ? t('Close chat') : t('Open chat')}
            onClick={() => setUi('voiceChat', ui.voiceChat === p.channel.id ? null : p.channel.id)}
          >
            <I.ChatBubble size={19} />
          </button>
        </Show>
        {/* Theater mode hides the list by itself; its own button brings it back. */}
        <Show when={p.channel.kind === Kind.Voice && !isMobile() && !watchTheater(p.channel.id)}>
          <button
            class="icon-btn"
            classList={{ on: prefs.voiceNavCollapsed }}
            aria-label={prefs.voiceNavCollapsed ? t('Show channel list') : t('Hide channel list')}
            data-tip={prefs.voiceNavCollapsed ? t('Show channel list') : t('Hide channel list')}
            onClick={() => setPrefs({ voiceNavCollapsed: !prefs.voiceNavCollapsed })}
          >
            <I.Sidebar size={20} />
          </button>
        </Show>
      </div>
    </header>
  );
}

/** Search filters, like Discord's: what each one takes and how it reads in the suggestions. */
const FILTERS = [
  ['from:', msg('user'), msg('Messages sent by someone')],
  ['mentions:', msg('user'), msg('Messages that mention someone')],
  ['has:', msg('link, embed, file, image, video or sound'), msg('Messages with an attachment or link')],
  ['in:', msg('channel'), msg('Messages in a channel')],
  ['before:', msg('date'), msg('Sent before a day')],
  ['after:', msg('date'), msg('Sent after a day')],
  ['during:', msg('date'), msg('Sent on a day')],
  ['pinned:', msg('true or false'), msg('Pinned messages')],
] as const;
const HAS = ['link', 'embed', 'file', 'image', 'video', 'sound'] as const;

interface SearchSuggestion {
  key: string;
  /** Replaces the word being typed. */
  insert: string;
  label: string;
  hint?: string;
  icon?: () => any;
}

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function SearchBox(p: { channel: Channel }) {
  const [value, setValue] = createSignal('');
  const [focused, setFocused] = createSignal(false);
  const [caret, setCaret] = createSignal(0);
  const [sel, setSel] = createSignal(-1);
  let input!: HTMLInputElement;
  const gid = () => p.channel.guild_id ?? null;
  const people = () =>
    gid() ? Object.keys(state.members[gid()!] ?? {}) : (p.channel.recipients ?? []).map((u) => u.id);

  /** The word the caret is in: [start, end, text]. */
  const word = () => {
    const v = value();
    const c = caret();
    const start = v.lastIndexOf(' ', c - 1) + 1;
    const end = v.indexOf(' ', c);
    return [start, end < 0 ? v.length : end, v.slice(start, c)] as const;
  };

  const suggestions = createMemo((): SearchSuggestion[] => {
    if (!focused()) return [];
    const w = word()[2].toLowerCase();
    const m = w.match(/^(from|mentions|has|in|before|after|during|pinned):(.*)$/);
    if (!m) {
      return FILTERS.filter(([f]) => !w || f.startsWith(w))
        .filter(([f]) => f !== 'in:' || gid())
        .map(([f, arg, hint]) => ({ key: f, insert: f, label: `${f} ${t(arg)}`, hint: t(hint) }));
    }
    const [, kind, q] = m;
    if (kind === 'from' || kind === 'mentions')
      return people()
        .filter((id) => state.users[id])
        .filter((id) => !q || state.users[id].username.includes(q) || nameOf(id, gid()).toLowerCase().includes(q))
        .slice(0, 8)
        .map((id) => ({
          key: id,
          insert: `${kind}:${state.users[id].username} `,
          label: nameOf(id, gid()),
          hint: state.users[id].username,
          icon: () => <Avatar user={state.users[id]} size={20} />,
        }));
    if (kind === 'has')
      return HAS.filter((h) => h.startsWith(q)).map((h) => ({ key: h, insert: `has:${h} `, label: h }));
    if (kind === 'pinned')
      return ['true', 'false']
        .filter((x) => x.startsWith(q))
        .map((x) => ({ key: x, insert: `pinned:${x} `, label: x }));
    if (kind === 'in')
      return Object.values(state.channels)
        .filter((c) => c.guild_id === gid() && (c.kind === Kind.Text || c.kind === Kind.Thread) && c.name.includes(q))
        .slice(0, 8)
        .map((c) => ({
          key: c.id,
          insert: `in:${c.name} `,
          label: c.name,
          icon: () => (c.kind === Kind.Thread ? <I.Thread size={16} /> : <I.Hash size={16} />),
        }));
    const day = (ago: number) => isoDay(new Date(Date.now() - ago * 86_400_000));
    return [
      [day(0), t('Today')],
      [day(1), t('Yesterday')],
      [day(7), t('A week ago')],
      [day(30), t('A month ago')],
    ]
      .filter(([d]) => d.startsWith(q))
      .map(([d, label]) => ({ key: d, insert: `${kind}:${d} `, label: d, hint: label }));
  });
  createEffect(on(suggestions, () => setSel(-1)));

  const apply = (s: SearchSuggestion) => {
    const [start, end] = word();
    const v = value();
    const next = v.slice(0, start) + s.insert + v.slice(end).replace(/^ /, s.insert.endsWith(' ') ? '' : ' ');
    const pos = start + s.insert.length;
    setValue(next);
    input.value = next;
    input.setSelectionRange(pos, pos);
    setCaret(pos);
    input.focus();
  };

  const run = async () => {
    const q = value().trim();
    if (!q) return;
    setFocused(false);
    input.blur();
    setUi('panel', 'search');
    setUi('search', { query: q, loading: true, results: null });
    const f = parseFilters(q);
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);
    const path = gid()
      ? `/guilds/${gid()}/messages/search?${params}`
      : `/channels/${p.channel.id}/messages/search?${params}`;
    await attempt(async () => setUi('search', 'results', await api('GET', path)));
    setUi('search', 'loading', false);
  };
  const findUser = (name: string) => {
    const n = name.replace(/^@/, '').toLowerCase();
    return Object.values(state.users).find((u) => u.username === n || nameOf(u.id, gid()).toLowerCase() === n)?.id;
  };
  const parseFilters = (q: string) => {
    const f: Record<string, string | undefined> = {};
    const text = q
      .replace(
        /(?:^|\s)(from|mentions|has|in|before|after|during|pinned):(\S+)/gi,
        (all, kind: string, arg: string) => {
          const k = kind.toLowerCase();
          if (k === 'from') f.author_id = findUser(arg);
          else if (k === 'mentions') f.mentions = findUser(arg);
          else if (k === 'has' && (HAS as readonly string[]).includes(arg.toLowerCase())) f.has = arg.toLowerCase();
          else if (k === 'in')
            f.channel_id = Object.values(state.channels).find(
              (c) => c.guild_id === gid() && c.name === arg.replace(/^#/, '').toLowerCase(),
            )?.id;
          else if (k === 'pinned') f.pinned = /^(true|yes)$/i.test(arg) ? 'true' : 'false';
          else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) f[k] = arg;
          else return all;
          return ' ';
        },
      )
      .replace(/\s+/g, ' ')
      .trim();
    f.q = text || undefined;
    return f;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const list = suggestions();
    if (e.key === 'ArrowDown' && list.length) {
      e.preventDefault();
      setSel((i) => (i + 1) % list.length);
    } else if (e.key === 'ArrowUp' && list.length) {
      e.preventDefault();
      setSel((i) => (i <= 0 ? list.length - 1 : i - 1));
    } else if ((e.key === 'Enter' || e.key === 'Tab') && sel() >= 0 && list[sel()]) {
      e.preventDefault();
      apply(list[sel()]);
    } else if (e.key === 'Enter') void run();
    else if (e.key === 'Escape') input.blur();
  };
  const syncCaret = () => setCaret(input.selectionStart ?? value().length);

  return (
    <label class="search-box" classList={{ open: focused() && suggestions().length > 0 }}>
      <input
        ref={input}
        placeholder={t('Search')}
        value={value()}
        onInput={(e) => (setValue(e.currentTarget.value), syncCaret())}
        onKeyDown={onKeyDown}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onFocus={() => (setFocused(true), syncCaret())}
        onBlur={() => setFocused(false)}
      />
      <I.Search size={16} />
      <Show when={focused() && suggestions().length}>
        <div class="search-suggest" onMouseDown={(e) => e.preventDefault()}>
          <div class="search-suggest-title">{/^\w+:/.test(word()[2]) ? t('Suggestions') : t('Search options')}</div>
          <For each={suggestions()}>
            {(s, i) => (
              <button classList={{ active: sel() === i() }} onMouseMove={() => setSel(i())} onClick={() => apply(s)}>
                <Show when={s.icon}>{s.icon!()}</Show>
                <span class="search-suggest-label">{s.label}</span>
                <Show when={s.hint}>
                  <span class="search-suggest-hint">{s.hint}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </label>
  );
}

export type MarginTab = 'people' | 'pins' | 'search';

/** Which margin tab a channel shows, or none: pins/search when open, else the member list if it's on. */
export function marginTab(c: Channel): MarginTab | null {
  if (c.kind === Kind.Voice) return null;
  if (ui.panel) return ui.panel;
  const people = (c.guild_id && c.kind === Kind.Text) || c.kind === Kind.GroupDm;
  return people && ui.showMembers && !isNarrow() ? 'people' : null;
}

/** The column right of the chat: people, pinned messages and search results, one tab at a time. */
export function Margin(p: { channel: Channel; tab: MarginTab }) {
  const people = () =>
    ((!!p.channel.guild_id && p.channel.kind === Kind.Text) || p.channel.kind === Kind.GroupDm) && !isNarrow();
  const tabs = () =>
    [
      people() && (['people', t('People')] as const),
      ['pins', t('Pins')] as const,
      (ui.search.query || p.tab === 'search') && (['search', t('Search')] as const),
    ].filter((x): x is readonly [MarginTab, string] => !!x);
  const pick = (tab: MarginTab) => (tab === 'people' ? setUi({ panel: null, showMembers: true }) : setUi('panel', tab));
  const close = () => (p.tab === 'people' ? setUi('showMembers', false) : setUi('panel', null));
  return (
    <aside class="margin side-panel">
      <div class="margin-head">
        <div class="margin-tabs" role="tablist">
          <For each={tabs()}>
            {([id, label]) => (
              <button
                role="tab"
                aria-selected={p.tab === id}
                classList={{ active: p.tab === id }}
                onClick={() => pick(id)}
              >
                {label}
              </button>
            )}
          </For>
        </div>
        <button class="icon-btn tiny" aria-label={t('Close')} onClick={close}>
          <I.Close size={14} />
        </button>
      </div>
      <Switch>
        <Match when={p.tab === 'people' && p.channel.kind === Kind.GroupDm}>
          <GroupMembers channel={p.channel} />
        </Match>
        <Match when={p.tab === 'people'}>
          <Members guildId={p.channel.guild_id!} />
        </Match>
        <Match when={p.tab === 'pins'}>
          <PinsPanel channel={p.channel} />
        </Match>
        <Match when={p.tab === 'search'}>
          <div class="panel-head">
            <span>
              {ui.search.results ? plural(ui.search.results.total, '{n} result', '{n} results') : t('Searching…')}
            </span>
          </div>
          <p class="panel-hint">{t('Tip: click the search box for filters like from:, has:, in: and before:')}</p>
          <div class="panel-list">
            <For
              each={(ui.search.results?.messages ?? []) as Message[]}
              fallback={<p class="empty-hint">{ui.search.loading ? '' : t('Nothing found.')}</p>}
            >
              {(m) => <ResultCard m={m} />}
            </For>
          </div>
        </Match>
      </Switch>
    </aside>
  );
}

/** A group DM's people: the owner first (crowned), right-click to remove someone or hand the group over. */
function GroupMembers(p: { channel: Channel }) {
  const owner = () => p.channel.owner_id;
  const people = () =>
    [...(p.channel.recipients ?? [])].sort(
      (a, b) => Number(b.id === owner()) - Number(a.id === owner()) || nameOf(a.id).localeCompare(nameOf(b.id)),
    );
  const amOwner = () => owner() === state.me?.id;
  const menu = (e: MouseEvent, id: string) => {
    const items: MenuEntry[] = [];
    if (id !== state.me?.id) items.push({ label: t('Message'), run: () => attempt(() => openDm(id)) });
    items.push({
      label: t('View Profile'),
      icon: () => <I.Eye size={16} />,
      run: () => setUi('modal', { type: 'user-profile', userId: id }),
    });
    if (amOwner() && id !== state.me?.id)
      items.push(
        'separator',
        {
          label: t('Make Group Owner'),
          run: () =>
            setUi('modal', {
              type: 'confirm',
              title: t('Make {name} the group owner', { name: nameOf(id) }),
              body: t('They will be able to remove people from the group. You will stay in it.'),
              action: t('Make Owner'),
              run: () => api('PATCH', `/channels/${p.channel.id}`, { owner_id: id }),
            }),
        },
        {
          label: t('Remove From Group'),
          danger: true,
          run: () => attempt(() => api('DELETE', `/channels/${p.channel.id}/recipients/${id}`)),
        },
      );
    if (id === state.me?.id)
      items.push('separator', {
        label: t('Leave Group'),
        danger: true,
        run: () =>
          setUi('modal', {
            type: 'confirm',
            title: t('Leave {name}', { name: dmName(p.channel) }),
            body: t("You won't be able to rejoin unless someone adds you back."),
            action: t('Leave group'),
            run: () => api('DELETE', `/channels/${p.channel.id}/recipients/${state.me!.id}`),
          }),
      });
    openMenu(e, items);
  };
  return (
    <div class="members group-members">
      <div class="panel-head">
        <span>{plural(people().length, '{n} member', '{n} members')}</span>
        <button
          class="icon-btn tiny"
          aria-label={t('Add friends to group')}
          data-tip={t('Add friends to group')}
          onClick={() => setUi('modal', { type: 'create-group', channelId: p.channel.id })}
        >
          <I.UserPlus size={15} />
        </button>
      </div>
      <For each={people()}>
        {(u) => (
          <button
            class="member"
            classList={{ offline: presenceOf(u.id) === 'offline' }}
            onClick={(e) => openProfile(u.id, e)}
            onContextMenu={(e) => menu(e, u.id)}
          >
            <Avatar user={state.users[u.id] ?? u} size={32} presence />
            <span class="member-name">{nameOf(u.id)}</span>
            <Show when={u.id === owner()}>
              <span class="owner-crown" title={t('Group Owner')}>
                <I.Crown size={14} />
              </span>
            </Show>
          </button>
        )}
      </For>
    </div>
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
    <Show
      when={p.channel.kind !== Kind.Voice}
      fallback={
        <div class="voice-split">
          <VoiceView channel={p.channel} />
          <Show when={ui.voiceChat === p.channel.id}>
            <VoiceChat channel={p.channel} />
          </Show>
        </div>
      }
    >
      <section class="chat" classList={{ 'call-full': dmCallFull(p.channel) }}>
        <Show
          when={isPrivate(p.channel.kind) && (voiceMembers(p.channel.id).length || voiceUi.channelId === p.channel.id)}
        >
          <DmCall channel={p.channel} />
        </Show>
        <Show when={!dmCallFull(p.channel)}>
          <MessageList channel={p.channel} />
          <TypingBar channelId={p.channel.id} />
          <Show when={ui.selection?.channelId === p.channel.id} fallback={<Composer channel={p.channel} />}>
            <SelectionBar channelId={p.channel.id} />
          </Show>
        </Show>
      </section>
    </Show>
  );
}

const [callFull, setCallFull] = createSignal(false);
/** The DM's call takes the whole chat area: by choice, or while its shared video is expanded. */
const dmCallFull = (c: Channel) =>
  isPrivate(c.kind) && voiceUi.channelId === c.id && (callFull() || watchExpanded(c.id));

/**
 * The call above a DM's messages. Small while it's just people; taller as soon as there's something to watch
 * (a stream, a camera, a shared video). Drag its bottom edge to resize it (remembered on this device), or
 * expand it over the whole chat.
 */
function DmCall(p: { channel: Channel }) {
  let el!: HTMLDivElement;
  const hasVideo = () =>
    !!watches[p.channel.id] ||
    voiceMembers(p.channel.id).some((v) => v.self_stream || v.self_video) ||
    voiceUi.camera ||
    voiceUi.screen;
  const height = () => {
    if (dmCallFull(p.channel)) return undefined;
    if (prefs.dmCallHeight) return `${prefs.dmCallHeight}px`;
    return hasVideo() ? '68%' : undefined;
  };
  const resize = (e: PointerEvent) => {
    e.preventDefault();
    const top = el.getBoundingClientRect().top;
    const room = el.parentElement!.getBoundingClientRect().height;
    const move = (ev: PointerEvent) =>
      setPrefs({ dmCallHeight: Math.round(Math.max(200, Math.min(room - 140, ev.clientY - top))) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div class="dm-call" ref={el} classList={{ full: dmCallFull(p.channel) }} style={{ height: height() }}>
      <VoiceView channel={p.channel} />
      <Show when={voiceUi.channelId === p.channel.id}>
        <button
          class="icon-btn dm-call-expand"
          aria-label={callFull() ? t('Show the chat') : t('Expand the call')}
          data-tip={callFull() ? t('Show the chat') : t('Expand the call')}
          onClick={() => setCallFull(!callFull())}
        >
          <Show when={dmCallFull(p.channel)} fallback={<I.EnterFullscreen size={16} />}>
            <I.ExitFullscreen size={16} />
          </Show>
        </button>
      </Show>
      <Show when={!dmCallFull(p.channel)}>
        <div
          class="dm-call-resize"
          role="separator"
          aria-orientation="horizontal"
          title={t('Drag to resize; double-click to reset')}
          onPointerDown={resize}
          onDblClick={() => setPrefs({ dmCallHeight: 0 })}
        />
      </Show>
    </div>
  );
}

/** A voice channel's own chat, beside the call (Discord's text in voice). Drag its left edge to resize it. */
function VoiceChat(p: { channel: Channel }) {
  let el!: HTMLElement;
  const resize = (e: PointerEvent) => {
    e.preventDefault();
    const right = el.getBoundingClientRect().right;
    const room = el.parentElement!.getBoundingClientRect().width;
    const move = (ev: PointerEvent) =>
      setPrefs({ voiceChatWidth: Math.round(Math.max(280, Math.min(room - 360, right - ev.clientX))) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-x');
    };
    document.body.classList.add('resizing-x');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <aside
      class="chat voice-chat"
      ref={el}
      style={prefs.voiceChatWidth ? { width: `${prefs.voiceChatWidth}px` } : undefined}
    >
      <div
        class="voice-chat-resize"
        role="separator"
        aria-orientation="vertical"
        title={t('Drag to resize; double-click to reset')}
        onPointerDown={resize}
        onDblClick={() => setPrefs({ voiceChatWidth: 0 })}
      />
      <div class="voice-chat-head">
        <I.ChatBubble size={16} />
        <span>{t('Chat')}</span>
        <span class="grow" />
        <button class="icon-btn tiny" aria-label={t('Close chat')} onClick={() => setUi('voiceChat', null)}>
          <I.Close size={14} />
        </button>
      </div>
      <MessageList channel={p.channel} />
      <TypingBar channelId={p.channel.id} />
      <Composer channel={p.channel} />
    </aside>
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

  // Grouping, day breaks and the "new" divider per message id. The list renders the messages themselves (not
  // wrappers made here), so a new message doesn't re-render the others (videos would reload and flicker).
  const layout = createMemo(() => {
    const out = new Map<string, { grouped: boolean; newDay: boolean; firstUnread: boolean }>();
    let prev: Message | undefined;
    let unreadMarked = false;
    const read = unreadFrom();
    for (const m of list()) {
      const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
      const grouped =
        !!prev &&
        !newDay &&
        !m.reply_to &&
        !m.interaction &&
        !m.type &&
        !prev.type &&
        prev.author.id === m.author.id &&
        new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < GROUP_WINDOW;
      const firstUnread =
        !!read && !unreadMarked && !m.pending && cmpId(m.id, read) > 0 && m.author.id !== state.me?.id;
      if (firstUnread) unreadMarked = true;
      out.set(m.id, { grouped: grouped && !firstUnread, newDay, firstUnread });
      prev = m;
    }
    return out;
  });
  const NONE = { grouped: false, newDay: false, firstUnread: false };

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

  // Far up the history: a button back down to the newest messages.
  const [farUp, setFarUp] = createSignal(false);
  createEffect(
    on(
      () => p.channel.id,
      () => setFarUp(false),
    ),
  );
  const jumpToBottom = () => {
    if (bucket()?.hasNewer)
      return void jumpToPresent(p.channel.id).then(() => ((stickToBottom = true), scrollToBottom()));
    stickToBottom = true;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  };

  const onScroll = async () => {
    const fromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    stickToBottom = fromBottom < NEAR_BOTTOM && !bucket()?.hasNewer;
    setFarUp(fromBottom > Math.max(600, scroller.clientHeight * 1.2) || !!bucket()?.hasNewer);
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
      <Show when={farUp()}>
        <button
          class="jump-bottom"
          aria-label={t('Jump to bottom')}
          data-tip={t('Jump to bottom')}
          onClick={jumpToBottom}
        >
          <I.Chevron size={20} />
        </button>
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
          <For each={list()}>
            {(m) => {
              const it = () => layout().get(m.id) ?? NONE;
              return (
                <>
                  <Show when={it().newDay}>
                    <div class="day-divider">
                      <span>
                        {new Date(m.created_at).toLocaleDateString(dateLocale(), {
                          weekday: 'long',
                          month: 'long',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </span>
                    </div>
                  </Show>
                  <Show when={it().firstUnread}>
                    <div class="unread-divider">
                      <span>{t('new')}</span>
                    </div>
                  </Show>
                  <MessageItem message={m} grouped={it().grouped} guildId={p.channel.guild_id} />
                </>
              );
            }}
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
            <PrivateBadge channelId={p.channel.id} />
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
