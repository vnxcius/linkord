// Ctrl+K, like Discord's quick switcher: type to jump to a friend or DM, a channel, a server, or a message
// anywhere. "@" narrows to people, "#" to channels, "*" to servers.
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { api } from '../lib/api';
import { jumpToMessage, openDm, openFriends, selectChannel, selectView } from '../lib/actions';
import { t } from '../lib/i18n';
import { dmName, nameOf, sortedDms, state } from '../lib/store';
import { Kind, Rel, type Message } from '../lib/types';
import { attempt, setUi } from '../lib/ui';
import { Avatar, GuildIcon } from './Avatar';
import * as I from './Icons';
import { formatTime, renderContent } from './MessageItem';

interface Result {
  key: string;
  label: string;
  hint?: string;
  icon: () => any;
  run: () => unknown;
}

/** 0 = no match; higher is better (whole name, then start of the name, then start of a word, then anywhere). */
function score(name: string, q: string): number {
  const n = name.toLowerCase();
  if (!q) return 1;
  if (n === q) return 4;
  if (n.startsWith(q)) return 3;
  if (n.split(/[\s_.-]+/).some((w) => w.startsWith(q))) return 2;
  return n.includes(q) ? 1 : 0;
}

function ranked<T>(items: T[], name: (x: T) => string, q: string, max: number): T[] {
  return items
    .map((x) => [x, score(name(x), q)] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([x]) => x);
}

export function QuickSwitcher() {
  const [query, setQuery] = createSignal('');
  const [sel, setSel] = createSignal(0);
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [searching, setSearching] = createSignal(false);
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  const close = () => setUi('quickSwitcher', false);
  onMount(() => input.focus());

  const mode = () => (/^[@#*]/.test(query()) ? query()[0] : '');
  const q = () =>
    query()
      .slice(mode() ? 1 : 0)
      .trim()
      .toLowerCase();

  const people = (): Result[] => {
    const ids = new Set<string>();
    for (const [id, r] of Object.entries(state.relationships)) if (r === Rel.Friend) ids.add(id);
    for (const c of sortedDms())
      if (c.kind === Kind.Dm) c.recipients?.forEach((u) => u.id !== state.me?.id && ids.add(u.id));
    const users = ranked(
      [...ids].filter((id) => state.users[id]),
      (id) => `${nameOf(id)} ${state.users[id].username}`,
      q(),
      8,
    ).map((id) => ({
      key: `u${id}`,
      label: nameOf(id),
      hint: state.users[id].username,
      icon: () => <Avatar user={state.users[id]} size={22} presence />,
      run: () => attempt(() => openDm(id)),
    }));
    const groups = ranked(
      sortedDms().filter((c) => c.kind === Kind.GroupDm),
      (c) => dmName(c),
      q(),
      4,
    ).map((c) => ({
      key: `g${c.id}`,
      label: dmName(c),
      hint: t('Group'),
      icon: () => <I.Users size={20} />,
      run: () => selectChannel(c.id),
    }));
    return [...users, ...groups];
  };

  const channels = (): Result[] =>
    ranked(
      Object.values(state.channels).filter(
        (c) =>
          c.guild_id &&
          state.guilds[c.guild_id] &&
          (c.kind === Kind.Text || c.kind === Kind.Voice || (c.kind === Kind.Thread && !c.archived)),
      ),
      (c) => c.name,
      q(),
      8,
    ).map((c) => ({
      key: `c${c.id}`,
      label: c.name,
      hint: state.guilds[c.guild_id!]?.name,
      icon: () =>
        c.kind === Kind.Voice ? (
          <I.Speaker size={18} />
        ) : c.kind === Kind.Thread ? (
          <I.Thread size={18} />
        ) : (
          <I.Hash size={18} />
        ),
      run: () => selectChannel(c.id),
    }));

  const servers = (): Result[] =>
    ranked(Object.values(state.guilds), (g) => g.name, q(), 5).map((g) => ({
      key: `s${g.id}`,
      label: g.name,
      hint: t('Server'),
      icon: () => <GuildIcon name={g.name} icon={g.icon} size={22} />,
      run: () => selectView(g.id),
    }));

  const results = createMemo((): Result[] => {
    const m = mode();
    if (!q() && !m) {
      // Nothing typed: recent conversations and Friends.
      return [
        { key: 'friends', label: t('Friends'), icon: () => <I.Users size={20} />, run: openFriends },
        ...sortedDms()
          .slice(0, 6)
          .map((c) => ({
            key: `d${c.id}`,
            label: dmName(c),
            icon: () =>
              c.kind === Kind.Dm ? (
                <Avatar user={c.recipients?.find((u) => u.id !== state.me?.id)} size={22} presence />
              ) : (
                <I.Users size={20} />
              ),
            run: () => selectChannel(c.id),
          })),
      ];
    }
    if (m === '@') return people();
    if (m === '#') return channels();
    if (m === '*') return servers();
    return [...people(), ...channels(), ...servers()];
  });

  // Messages everywhere, a moment after typing stops.
  let timer: number | undefined;
  let gen = 0;
  createEffect(
    on(q, (text) => {
      clearTimeout(timer);
      setMessages([]);
      if (mode() || text.length < 2) return setSearching(false);
      setSearching(true);
      const mine = ++gen;
      timer = window.setTimeout(async () => {
        const r = await api<{ messages: Message[] }>(
          'GET',
          `/users/@me/messages/search?q=${encodeURIComponent(text)}`,
        ).catch(() => ({ messages: [] }));
        if (mine !== gen) return;
        setMessages(r.messages.slice(0, 8));
        setSearching(false);
      }, 300);
    }),
  );
  onCleanup(() => clearTimeout(timer));

  const all = (): Result[] => [
    ...results(),
    ...messages().map((m) => ({
      key: `m${m.id}`,
      label: '',
      icon: () => null,
      run: () => jumpToMessage(m.channel_id, m.id),
    })),
  ];
  createEffect(on(query, () => setSel(0)));
  const pick = (r?: Result) => {
    if (!r) return;
    close();
    void r.run();
  };
  createEffect(() => list?.querySelector(`[data-index="${sel()}"]`)?.scrollIntoView({ block: 'nearest' }));

  const onKey = (e: KeyboardEvent) => {
    const n = all().length;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      if (n) setSel((i) => (i + 1) % n);
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      if (n) setSel((i) => (i - 1 + n) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(all()[sel()]);
    }
  };

  const where = (m: Message) => {
    const c = state.channels[m.channel_id];
    if (!c) return '';
    return c.guild_id ? `#${c.name} · ${state.guilds[c.guild_id]?.name ?? ''}` : dmName(c);
  };

  return (
    <div class="modal-backdrop quick-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="quick-switcher" role="dialog" aria-label={t('Quick switcher')}>
        <label class="quick-input">
          <I.Search size={18} />
          <input
            ref={input}
            value={query()}
            placeholder={t('Where would you like to go?')}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onKey}
          />
        </label>
        <div class="quick-list" ref={list}>
          <Show when={!query()}>
            <div class="quick-title">{t('Recent')}</div>
          </Show>
          <For each={results()}>
            {(r, i) => (
              <button
                class="quick-item"
                classList={{ active: sel() === i() }}
                data-index={i()}
                onMouseMove={() => setSel(i())}
                onClick={() => pick(r)}
              >
                <span class="quick-icon">{r.icon()}</span>
                <span class="quick-label">{r.label}</span>
                <Show when={r.hint}>
                  <span class="quick-hint">{r.hint}</span>
                </Show>
              </button>
            )}
          </For>
          <Show when={messages().length || searching()}>
            <div class="quick-title">{searching() ? t('Searching messages…') : t('Messages')}</div>
          </Show>
          <For each={messages()}>
            {(m, i) => (
              <button
                class="quick-item quick-message"
                classList={{ active: sel() === results().length + i() }}
                data-index={results().length + i()}
                onMouseMove={() => setSel(results().length + i())}
                onClick={() => pick(all()[results().length + i()])}
              >
                <span class="quick-icon">
                  <Avatar user={state.users[m.author.id] ?? m.author} size={22} />
                </span>
                <span class="quick-label">
                  <span class="quick-meta">
                    <strong>{nameOf(m.author.id, state.channels[m.channel_id]?.guild_id)}</strong>
                    <span>{where(m)}</span>
                    <span>{formatTime(m.created_at)}</span>
                  </span>
                  <span
                    class="quick-snippet"
                    innerHTML={renderContent(
                      (m.content || t('(attachment)')).split('\n')[0],
                      state.channels[m.channel_id]?.guild_id,
                    )}
                  />
                </span>
              </button>
            )}
          </For>
          <Show when={query() && !all().length && !searching()}>
            <p class="empty-hint">{t('Nothing found.')}</p>
          </Show>
        </div>
        <div class="quick-foot">
          {t('Tip: start with @ for people, # for channels, * for servers')}
          <span class="grow" />
          <kbd>↑↓</kbd> <kbd>↵</kbd> <kbd>Esc</kbd>
        </div>
      </div>
    </div>
  );
}
