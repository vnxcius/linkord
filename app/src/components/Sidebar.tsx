import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { api } from '../lib/api';
import { currentOrder, logout, markRead, openFriends, saveChannelOrder, selectChannel, toggleAllCategories, toggleCategory, toggleMuteChannel, toggleMuteGuild } from '../lib/actions';
import { msg, plural, t } from '../lib/i18n';
import { can, P } from '../lib/perms';
import { prefs, setPrefs } from '../lib/prefs';
import {
  activeThreads,
  dmName,
  dmRecipient,
  channelLayout,
  isMuted,
  isUnread,
  nameOf,
  presenceOf,
  sortedDms,
  state,
  voiceMembers,
} from '../lib/store';
import type { Channel, Status } from '../lib/types';
import { Kind, Rel } from '../lib/types';
import { attempt, openMenu, openProfile, setUi, type MenuEntry } from '../lib/ui';
import {
  canSendVideo,
  joinVoice,
  leaveVoice,
  restartMic,
  setOutputDevice,
  setUserVolume,
  setVoiceUi,
  stopScreenShare,
  switchScreenSource,
  toggleCamera,
  toggleDeafen,
  toggleMute,
  voiceUi,
  watchStream,
} from '../lib/voice';
import { nativeCaptureAvailable } from '../lib/native-capture';
import { canShareScreen, liveFirst, viewersOf } from './VoiceView';
import { ActivityLine, CustomStatusView, elapsedSince, GameIcon } from './Activity';
import { clearCustomStatusNow, openCustomStatus } from './CustomStatus';
import { Avatar } from './Avatar';
import * as I from './Icons';
import { comboLabel } from '../lib/keys';
import { currentGame, toggleGameStream } from '../lib/games';

export function Sidebar() {
  return (
    <aside class="sidebar">
      <Show when={state.view === '@me'} fallback={<GuildSidebar guildId={state.view} />}>
        <DmSidebar />
      </Show>
    </aside>
  );
}

/** Game, voice and your user controls in one floating panel across the bottom of the rail and channel list.
 *  Publishes its height as --dock-h on the nav pane so both columns can scroll clear of it. */
export function Dock() {
  let el!: HTMLDivElement;
  onMount(() => {
    const ro = new ResizeObserver(() => el.parentElement?.style.setProperty('--dock-h', `${el.offsetHeight}px`));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });
  return (
    <div class="dock" ref={el}>
      <GamePanel />
      <VoicePanel />
      <UserPanel />
    </div>
  );
}

function DmSidebar() {
  const pending = () => Object.values(state.relationships).filter((r) => r === Rel.Incoming).length;
  return (
    <>
      <header class="sidebar-header">
        <span class="sidebar-title">{t('Direct Messages')}</span>
        <button class="icon-btn tiny" aria-label={t('New group')} data-tip={t('New group DM')} onClick={() => setUi('modal', { type: 'create-group' })}>
          <I.Plus size={16} />
        </button>
      </header>
      <div class="channel-list">
        <button class="dm-item friends-item" classList={{ active: !state.selected['@me'] }} onClick={openFriends}>
          <span class="friends-icon">
            <I.Users size={20} />
          </span>
          <span class="dm-name">{t('Friends')}</span>
          <Show when={pending()}>
            <span class="badge">{pending()}</span>
          </Show>
        </button>
        <div class="group-title">
          <span>{t('Conversations')}</span>
        </div>
        <For each={sortedDms()} fallback={<p class="empty-hint">{t('No conversations yet. Message a friend or someone from a server.')}</p>}>
          {(c) => <DmItem c={c} />}
        </For>
      </div>
    </>
  );
}

function DmItem(p: { c: Channel }) {
  const group = () => p.c.kind === Kind.GroupDm;
  const menu = (): MenuEntry[] => {
    const items: MenuEntry[] = [{ label: t('Mark As Read'), run: () => markRead([p.c.id]) }];
    items.push({ label: isMuted(p.c) ? t('Unmute Conversation') : t('Mute Conversation'), run: () => attempt(() => toggleMuteChannel(p.c.id)) });
    if (group()) {
      items.push('separator');
      items.push({
        label: t('Leave Group'),
        danger: true,
        run: () =>
          setUi('modal', {
            type: 'confirm',
            title: t('Leave {name}', { name: dmName(p.c) }),
            body: t("You won't be able to rejoin unless someone adds you back."),
            action: t('Leave group'),
            run: () => api('DELETE', `/channels/${p.c.id}/recipients/${state.me!.id}`),
          }),
      });
    }
    return items;
  };
  return (
    <button
      class="dm-item"
      classList={{ active: state.selected['@me'] === p.c.id, unread: isUnread(p.c) && !isMuted(p.c), muted: isMuted(p.c) }}
      onClick={() => selectChannel(p.c.id)}
      onContextMenu={(e) => openMenu(e, menu())}
    >
      <Show
        when={!group()}
        fallback={
          <span class="group-icon">
            <I.Users size={18} />
          </span>
        }
      >
        <Avatar user={dmRecipient(p.c)} size={32} presence />
      </Show>
      <span class="dm-text">
        <span class="dm-name">{dmName(p.c)}</span>
        <Show when={group()} fallback={<ActivityLine userId={dmRecipient(p.c)?.id ?? ''} />}>
          <span class="dm-sub">{plural(p.c.recipients?.length ?? 0, '{n} member', '{n} members')}</span>
        </Show>
      </span>
      <Show when={state.mentions[p.c.id]}>
        <span class="badge">{state.mentions[p.c.id]}</span>
      </Show>
    </button>
  );
}

export function guildMenu(guildId: string): MenuEntry[] {
  const g = state.guilds[guildId];
  const owner = g?.owner_id === state.me?.id;
  const items: MenuEntry[] = [
    { label: t('Mark As Read'), run: () => markRead(Object.values(state.channels).filter((c) => c.guild_id === guildId).map((c) => c.id)) },
  ];
  if (can(guildId, P.CREATE_INVITE)) items.push({ label: t('Invite People'), icon: () => <I.Link size={16} />, run: () => setUi('modal', { type: 'invite', guildId }) });
  items.push({
    label: state.settings.muted_guilds?.includes(guildId) ? t('Unmute Server') : t('Mute Server'),
    icon: () => (state.settings.muted_guilds?.includes(guildId) ? <I.Bell size={16} /> : <I.BellOff size={16} />),
    run: () => attempt(() => toggleMuteGuild(guildId)),
  });
  items.push({ label: t('Edit Server Profile'), icon: () => <I.Edit size={16} />, run: () => setUi('modal', { type: 'nickname', guildId, userId: state.me!.id }) });
  const manage = [P.MANAGE_GUILD, P.MANAGE_ROLES, P.MANAGE_EMOJIS, P.KICK_MEMBERS].some((p) => can(guildId, p));
  if (manage || can(guildId, P.MANAGE_CHANNELS)) items.push('separator');
  if (manage) items.push({ label: t('Server Settings'), icon: () => <I.Gear size={16} />, run: () => setUi('modal', { type: 'server-settings', guildId }) });
  if (can(guildId, P.MANAGE_CHANNELS))
    items.push(
      { label: t('Create Channel'), icon: () => <I.Plus size={16} />, run: () => setUi('modal', { type: 'create-channel', guildId, kind: 0 }) },
      { label: t('Create Category'), icon: () => <I.Folder size={16} />, run: () => setUi('modal', { type: 'create-channel', guildId, kind: 4 }) },
    );
  items.push('separator');
  items.push(
    owner
      ? {
          label: t('Delete Server'),
          danger: true,
          icon: () => <I.Trash size={16} />,
          run: () =>
            setUi('modal', {
              type: 'confirm',
              title: t('Delete {name}', { name: g?.name ?? '' }),
              body: t('This permanently deletes the server, its channels and all messages.'),
              action: t('Delete server'),
              run: () => api('DELETE', `/guilds/${guildId}`),
            }),
        }
      : {
          label: t('Leave Server'),
          danger: true,
          icon: () => <I.Logout size={16} />,
          run: () =>
            setUi('modal', {
              type: 'confirm',
              title: t('Leave {name}', { name: g?.name ?? '' }),
              body: t("You won't be able to rejoin unless you get a new invite."),
              action: t('Leave server'),
              run: () => api('DELETE', `/guilds/${guildId}/members/@me`),
            }),
        },
  );
  return items;
}

function GuildSidebar(p: { guildId: string }) {
  const g = () => state.guilds[p.guildId];
  const layout = () => channelLayout(p.guildId);
  const muted = () => state.settings.muted_guilds?.includes(p.guildId);
  return (
    <Show when={g()}>
      <header
        class="sidebar-header guild-header"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setUi('menu', { x: r.left + 10, y: r.bottom + 4, items: guildMenu(p.guildId) });
        }}
      >
        <span class="sidebar-title">{g()!.name}</span>
        <Show when={muted()}>
          <I.BellOff size={14} class="muted" />
        </Show>
        <I.Chevron size={16} class="chev" />
      </header>
      <div
        class="channel-list"
        onContextMenu={(e) => e.target === e.currentTarget && openMenu(e, guildMenu(p.guildId))}
        {...channelDnd(p.guildId)}
      >
        <div class="channel-group">
          <For each={layout().top}>{(c) => <ChannelRow channel={c} />}</For>
        </div>
        <For each={layout().categories}>{(c) => <Category guildId={p.guildId} category={c.category} channels={c.channels} />}</For>
      </div>
    </Show>
  );
}

// Drag channels to reorder them or move them to another category, and categories to reorder them
// (needs Manage Channels). Dropping on a category header puts a channel at the top of it.
const [dragging, setDragging] = createSignal<string | null>(null);
const [dropMark, setDropMark] = createSignal<{ id: string; before: boolean; into?: boolean } | null>(null);

/** Props for a draggable sidebar row (a channel, or a category header). */
function dragProps(c: Channel) {
  return {
    draggable: can(c.guild_id, P.MANAGE_CHANNELS),
    'data-channel-id': c.id,
    classList: {
      dragging: dragging() === c.id,
      'drop-before': dropMark()?.id === c.id && dropMark()!.before && !dropMark()!.into,
      'drop-after': dropMark()?.id === c.id && !dropMark()!.before && !dropMark()!.into,
      'drop-into': dropMark()?.id === c.id && !!dropMark()!.into,
    },
  };
}

function channelDnd(guildId: string) {
  const row = (e: DragEvent) => (e.target as HTMLElement).closest<HTMLElement>('[data-channel-id]');
  const kindOf = (id: string | null) => (id ? state.channels[id]?.kind : undefined);
  const clear = () => {
    setDragging(null);
    setDropMark(null);
  };
  return {
    onDragStart: (e: DragEvent) => {
      const id = row(e)?.dataset.channelId ?? null;
      if (!id) return;
      setDragging(id);
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', id);
    },
    onDragOver: (e: DragEvent) => {
      const el = row(e);
      const from = dragging();
      if (!el || !from) return;
      const target = el.dataset.channelId!;
      const draggingCategory = kindOf(from) === Kind.Category;
      const onCategory = kindOf(target) === Kind.Category;
      // Categories only go between categories.
      if (draggingCategory && !onCategory) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const before = e.clientY < r.top + r.height / 2;
      setDropMark({ id: target, before, into: onCategory && !draggingCategory });
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const from = dragging();
      const mark = dropMark();
      clear();
      if (!from || !mark || from === mark.id) return;
      const order = currentOrder(guildId);
      if (kindOf(from) === Kind.Category) {
        const cat = order.categories.find((c) => c.id === from)!;
        const rest = order.categories.filter((c) => c.id !== from);
        rest.splice(rest.findIndex((c) => c.id === mark.id) + (mark.before ? 0 : 1), 0, cat);
        order.categories = rest;
      } else {
        const lists = [order.top, ...order.categories.map((c) => c.channels)];
        for (const l of lists) if (l.includes(from)) l.splice(l.indexOf(from), 1);
        if (mark.into) order.categories.find((c) => c.id === mark.id)!.channels.unshift(from);
        else {
          const l = lists.find((x) => x.includes(mark.id))!;
          l.splice(l.indexOf(mark.id) + (mark.before ? 0 : 1), 0, from);
        }
      }
      void attempt(() => saveChannelOrder(guildId, order));
    },
    onDragEnd: clear,
  };
}

/** Move Up / Move Down from a channel's menu: among the same kind in the same category. */
function moveChannel(c: Channel, dir: -1 | 1) {
  const order = currentOrder(c.guild_id!);
  const list = [order.top, ...order.categories.map((x) => x.channels)].find((l) => l.includes(c.id))!;
  const same = list.filter((id) => state.channels[id].kind === c.kind);
  const i = same.indexOf(c.id);
  const other = same[i + dir];
  if (!other) return;
  const a = list.indexOf(c.id);
  const b = list.indexOf(other);
  [list[a], list[b]] = [list[b], list[a]];
  void attempt(() => saveChannelOrder(c.guild_id!, order));
}

function ChannelRow(p: { channel: Channel }) {
  return p.channel.kind === Kind.Voice ? <VoiceChannelItem channel={p.channel} /> : <TextChannelItem channel={p.channel} />;
}

function categoryMenu(c: Channel): MenuEntry[] {
  const gid = c.guild_id!;
  const ids = channelLayout(gid).categories.find((x) => x.category.id === c.id)?.channels.map((x) => x.id) ?? [];
  const collapsed = state.settings.collapsed_categories?.includes(c.id);
  const items: MenuEntry[] = [
    { label: t('Mark As Read'), run: () => markRead(ids) },
    { label: isMuted(c) ? t('Unmute Category') : t('Mute Category'), icon: () => <I.BellOff size={16} />, run: () => attempt(() => toggleMuteChannel(c.id)) },
    'separator',
    { label: t('Collapse Category'), checked: !!collapsed, run: () => attempt(() => toggleCategory(c.id)) },
    { label: t('Collapse All Categories'), run: () => attempt(() => toggleAllCategories(gid)) },
  ];
  if (can(gid, P.MANAGE_CHANNELS)) {
    items.push(
      'separator',
      { label: t('Create Channel'), icon: () => <I.Plus size={16} />, run: () => setUi('modal', { type: 'create-channel', guildId: gid, kind: 0, parentId: c.id }) },
      { label: t('Edit Category'), icon: () => <I.Gear size={16} />, run: () => setUi('modal', { type: 'channel-settings', channelId: c.id }) },
      {
        label: t('Delete Category'),
        danger: true,
        icon: () => <I.Trash size={16} />,
        run: () =>
          setUi('modal', {
            type: 'confirm',
            title: t('Delete {name}', { name: c.name }),
            body: t('Its channels stay, without a category.'),
            action: t('Delete'),
            run: () => api('DELETE', `/channels/${c.id}`),
          }),
      },
    );
  }
  items.push('separator', { label: t('Copy Category ID'), icon: () => <I.Copy size={16} />, run: () => navigator.clipboard.writeText(c.id) });
  return items;
}

function Category(p: { guildId: string; category: Channel; channels: Channel[] }) {
  const collapsed = () => !!state.settings.collapsed_categories?.includes(p.category.id);
  // Collapsed, a category still shows the open channel and the voice channel you're in, like Discord.
  const shown = () =>
    collapsed()
      ? p.channels.filter((c) => state.selected[p.guildId] === c.id || voiceUi.channelId === c.id || (state.mentions[c.id] ?? 0) > 0)
      : p.channels;
  return (
    <div class="channel-group" classList={{ collapsed: collapsed() }}>
      <div
        class="group-title category-title"
        {...dragProps(p.category)}
        classList={{ ...dragProps(p.category).classList }}
        onClick={() => void attempt(() => toggleCategory(p.category.id))}
        onContextMenu={(e) => openMenu(e, categoryMenu(p.category))}
        role="button"
        aria-expanded={!collapsed()}
      >
        <I.Chevron size={12} class="category-chev" />
        <span>{p.category.name}</span>
        <Show when={can(p.guildId, P.MANAGE_CHANNELS)}>
          <button
            class="icon-btn tiny"
            aria-label={t('Create channel')}
            data-tip={t('Create channel')}
            onClick={(e) => {
              e.stopPropagation();
              setUi('modal', { type: 'create-channel', guildId: p.guildId, kind: 0, parentId: p.category.id });
            }}
          >
            <I.Plus size={14} />
          </button>
        </Show>
      </div>
      <For each={shown()}>{(c) => <ChannelRow channel={c} />}</For>
    </div>
  );
}

function channelMenu(c: Channel): MenuEntry[] {
  const items: MenuEntry[] = [];
  if (c.kind !== Kind.Voice) items.push({ label: t('Mark As Read'), run: () => markRead([c.id]) });
  items.push({ label: isMuted(c) ? t('Unmute Channel') : t('Mute Channel'), icon: () => <I.BellOff size={16} />, run: () => attempt(() => toggleMuteChannel(c.id)) });
  const manage = c.kind === Kind.Thread ? c.owner_id === state.me?.id || can(c.guild_id, P.MANAGE_THREADS) : can(c.guild_id, P.MANAGE_CHANNELS);
  if (manage) {
    items.push('separator');
    items.push({ label: c.kind === Kind.Thread ? t('Edit Thread') : t('Edit Channel'), icon: () => <I.Gear size={16} />, run: () => setUi('modal', { type: 'channel-settings', channelId: c.id }) });
    if (c.kind !== Kind.Thread) {
      const order = currentOrder(c.guild_id!);
      const list = [order.top, ...order.categories.map((x) => x.channels)].find((l) => l.includes(c.id)) ?? [];
      const same = list.filter((id) => state.channels[id]?.kind === c.kind);
      const i = same.indexOf(c.id);
      items.push({ label: t('Move Up'), disabled: i <= 0, run: () => moveChannel(c, -1) });
      items.push({ label: t('Move Down'), disabled: i >= same.length - 1, run: () => moveChannel(c, 1) });
    }
    if (c.kind === Kind.Thread)
      items.push({ label: t('Archive Thread'), run: () => attempt(() => api('PATCH', `/channels/${c.id}`, { archived: true })) });
    items.push({
      label: c.kind === Kind.Thread ? t('Delete Thread') : t('Delete Channel'),
      danger: true,
      icon: () => <I.Trash size={16} />,
      run: () =>
        setUi('modal', {
          type: 'confirm',
          title: t('Delete {name}', { name: c.name }),
          body: t('All of its messages will be deleted. This cannot be undone.'),
          action: t('Delete'),
          run: () => api('DELETE', `/channels/${c.id}`),
        }),
    });
  }
  items.push('separator');
  items.push({ label: t('Copy Channel ID'), icon: () => <I.Copy size={16} />, run: () => navigator.clipboard.writeText(c.id) });
  return items;
}

function TextChannelItem(p: { channel: Channel }) {
  const active = () => state.selected[p.channel.guild_id!] === p.channel.id;
  const threads = () => activeThreads(p.channel.id);
  return (
    <>
      <button
        class="channel-item"
        {...dragProps(p.channel)}
        classList={{ ...dragProps(p.channel).classList, active: active(), unread: isUnread(p.channel) && !active() && !isMuted(p.channel), muted: isMuted(p.channel) }}
        onClick={() => selectChannel(p.channel.id)}
        onContextMenu={(e) => openMenu(e, channelMenu(p.channel))}
      >
        <I.Hash size={18} class="channel-icon" />
        <span class="channel-name">{p.channel.name}</span>
        <Show when={state.mentions[p.channel.id]}>
          <span class="badge">{state.mentions[p.channel.id]}</span>
        </Show>
      </button>
      <For each={threads()}>
        {(th) => {
          const tActive = () => state.selected[th.guild_id!] === th.id;
          return (
            <button
              class="channel-item thread-item"
              classList={{ active: tActive(), unread: isUnread(th) && !tActive() && !isMuted(th), muted: isMuted(th) }}
              onClick={() => selectChannel(th.id)}
              onContextMenu={(e) => openMenu(e, channelMenu(th))}
            >
              <span class="thread-branch" />
              <span class="channel-name">{th.name}</span>
              <Show when={state.mentions[th.id]}>
                <span class="badge">{state.mentions[th.id]}</span>
              </Show>
            </button>
          );
        }}
      </For>
    </>
  );
}

export function volumeMenu(userId: string): MenuEntry[] {
  const [v, setV] = createSignal(prefs.userVolumes[userId] ?? 1);
  return [
    {
      label: t('User Volume'),
      render: () => (
        <label class="volume-slider">
          <span>
            {t('User Volume')} <strong>{Math.round(v() * 100)}%</strong>
          </span>
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            value={v()}
            onInput={(e) => {
              setV(+e.currentTarget.value);
              setUserVolume(userId, +e.currentTarget.value);
            }}
          />
        </label>
      ),
    },
    { label: v() === 0 ? t('Unmute') : t('Mute (just for you)'), run: () => setUserVolume(userId, v() === 0 ? 1 : 0) },
  ];
}

function VoiceChannelItem(p: { channel: Channel }) {
  // People streaming move to the top.
  const members = () => liveFirst(voiceMembers(p.channel.id));
  const connected = () => voiceUi.channelId === p.channel.id;
  const gid = () => p.channel.guild_id!;
  // The call's age, the same for everyone (servers before 0.1.26 only gave us our own join time).
  const callStart = () => {
    const starts = members().flatMap((v) => (v.call_started_at ? [v.call_started_at] : []));
    return starts.length ? Math.min(...starts) : connected() ? voiceUi.joinedAt : null;
  };
  return (
    <div class="voice-channel">
      <button
        class="channel-item"
        {...dragProps(p.channel)}
        classList={{ ...dragProps(p.channel).classList, active: state.selected[gid()] === p.channel.id, connected: connected() }}
        disabled={!can(gid(), P.CONNECT)}
        onClick={() => {
          selectChannel(p.channel.id);
          void joinVoice(p.channel.id);
        }}
        onContextMenu={(e) => openMenu(e, channelMenu(p.channel))}
      >
        <I.Speaker size={18} class="channel-icon" />
        <span class="channel-name">{p.channel.name}</span>
        <Show when={callStart()}>{(since) => <CallTimer since={since()} />}</Show>
      </button>
      <For each={members()}>
        {(v) => {
          const u = () => state.users[v.user_id];
          return (
            <button
              class="voice-user"
              title={v.self_stream ? t("Watch {name}'s stream", { name: nameOf(v.user_id, gid()) }) : undefined}
              onClick={(e) => (v.self_stream ? void goToStream(p.channel.id, v.user_id) : openProfile(v.user_id, e, gid()))}
              onContextMenu={(e) => v.user_id !== state.me?.id && openMenu(e, volumeMenu(v.user_id))}
            >
              <Avatar user={u()} size={22} speaking={!!voiceUi.speaking[v.user_id] && !v.self_mute} />
              <span>{nameOf(v.user_id, gid())}</span>
              <span class="voice-flags">
                <Show when={v.self_video}>
                  <I.Camera size={14} />
                </Show>
                <Show when={v.self_stream}>
                  <span class="live-badge">{t('LIVE')}</span>
                </Show>
                <Show when={prefs.userVolumes[v.user_id] === 0}>
                  <I.Speaker size={14} class="off" />
                </Show>
                <Show when={v.self_deaf} fallback={<Show when={v.self_mute}><I.MicOff size={14} /></Show>}>
                  <I.HeadphonesOff size={14} />
                </Show>
              </span>
            </button>
          );
        }}
      </For>
    </div>
  );
}

/** Switch what's being shared: in-app picker on the desktop app, the system picker in browsers. */
export function openSwitchSource() {
  if (nativeCaptureAvailable) setUi('modal', { type: 'go-live', update: true, switchSource: true });
  else void switchScreenSource();
}

/** Opens a voice channel focused on someone's stream, joining the channel first if needed. */
async function goToStream(channelId: string, userId: string) {
  selectChannel(channelId);
  if (voiceUi.channelId !== channelId) {
    await joinVoice(channelId);
    // Wait for the voice connection before asking for the stream.
    for (let i = 0; i < 50 && voiceUi.connecting; i++) await new Promise((r) => setTimeout(r, 100));
  }
  if (voiceUi.channelId !== channelId) return;
  if (userId === state.me?.id) setVoiceUi('focus', `${userId}-screen`);
  else watchStream(userId);
}

/** Connection quality like Discord's: signal bars by ping, click for the number and a short graph. */
function PingIndicator() {
  const [open, setOpen] = createSignal(false);
  const quality = () => {
    const p = voiceUi.ping;
    if (p == null) return 'unknown';
    return p < 100 ? 'good' : p < 250 ? 'ok' : 'bad';
  };
  const path = () => {
    const h = voiceUi.pingHistory;
    if (h.length < 2) return '';
    const max = Math.max(150, ...h);
    return h.map((v, i) => `${i ? 'L' : 'M'}${(i / 29) * 200},${48 - (v / max) * 44}`).join(' ');
  };
  return (
    <span class="ping-wrap">
      <button class={`ping ${quality()}`} aria-label={t('Connection info')} onClick={() => setOpen(!open())}>
        <Switch fallback={<I.Signal size={18} />}>
          <Match when={quality() === 'good'}>
            <I.SignalGood size={18} />
          </Match>
          <Match when={quality() === 'ok'}>
            <I.SignalOk size={18} />
          </Match>
          <Match when={quality() === 'bad'}>
            <I.SignalBad size={18} />
          </Match>
        </Switch>
      </button>
      <Show when={open()}>
        <div class="ping-popover" onClick={() => setOpen(false)}>
          <strong>{t('Voice connection')}</strong>
          <div class="ping-value">
            {t('Ping')} <span class={quality()}>{voiceUi.ping ?? '—'} ms</span>
          </div>
          <svg viewBox="0 0 200 50" class="ping-graph" preserveAspectRatio="none">
            <path d={path()} />
          </svg>
          <small class="muted">{t("Last 60 seconds. Under 100 ms is great; above 250 ms you'll notice delay.")}</small>
        </div>
      </Show>
    </span>
  );
}

/**
 * The game you're playing, above Voice Connected (like Discord): one click (or the "Stream Your Game"
 * keybind) goes live with its window, using your last Go Live settings.
 */
function GamePanel() {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const key = () => prefs.keybinds.find((b) => b.action === 'stream-game' && b.combo)?.combo;
  const tip = (game: string) => {
    if (voiceUi.screen) return t('Stop streaming');
    if (!voiceUi.channelId) return t('Join a voice channel to stream {game}', { game });
    return key() ? t('Stream {game} ({key})', { game, key: comboLabel(key(), t) }) : t('Stream {game}', { game });
  };
  return (
    <Show when={currentGame()}>
      {(g) => (
        <div class="game-panel">
          <GameIcon src={g().icon} size={32} />
          <div class="game-panel-text">
            <strong title={g().name}>{g().name}</strong>
            <span classList={{ live: voiceUi.screen }}>{voiceUi.screen ? t('Streaming to {channel}', { channel: state.channels[voiceUi.channelId!]?.name ?? '' }) : elapsedSince(g().startedAt, now())}</span>
          </div>
          <button
            class="icon-btn game-stream"
            classList={{ live: voiceUi.screen }}
            aria-label={tip(g().name)}
            data-tip={tip(g().name)}
            disabled={!voiceUi.channelId || voiceUi.connecting}
            onClick={() => void toggleGameStream()}
          >
            <I.Screen size={20} />
          </button>
        </div>
      )}
    </Show>
  );
}

function VoicePanel() {
  const ch = () => (voiceUi.channelId ? state.channels[voiceUi.channelId] : undefined);
  return (
    <Show when={voiceUi.channelId || voiceUi.error}>
      <div class="dock-voice">
      <div class="voice-panel">
        <Switch>
          <Match when={voiceUi.error && !voiceUi.channelId}>
            <div class="voice-status error">
              <strong>{t('Voice failed')}</strong>
              <span>{voiceUi.error}</span>
            </div>
          </Match>
          <Match when={ch()}>
            <PingIndicator />
            <div class="voice-status" onClick={() => selectChannel(ch()!.id)}>
              <strong classList={{ connecting: voiceUi.connecting }}>{voiceUi.connecting ? t('Connecting…') : t('Voice Connected')}</strong>
              <span>
                {ch()!.name} / {state.guilds[ch()!.guild_id!]?.name}
              </span>
            </div>
            <Show when={prefs.inputMode === 'ptt'}>
              <span class="ptt-indicator" classList={{ on: voiceUi.pttActive }} title={t('Push to talk: {key}', { key: comboLabel(prefs.keybinds.find((b) => b.action === 'ptt')?.combo, t) })}>
                PTT
              </span>
            </Show>
            <button class="icon-btn" aria-label={t('Disconnect')} data-tip={t('Disconnect')} onClick={() => void leaveVoice()}>
              <I.Hangup size={20} />
            </button>
          </Match>
        </Switch>
      </div>
      {/* Like Discord: camera and screen share without opening the voice channel. */}
      <Show when={voiceUi.channelId && !voiceUi.connecting}>
        <div class="voice-panel-actions">
          <Show when={canSendVideo}>
            <button class="panel-btn" classList={{ on: voiceUi.camera }} onClick={() => void toggleCamera()}>
              <I.Camera size={18} /> {t('Video')}
            </button>
          </Show>
          <Show when={canShareScreen}>
            <button
              class="panel-btn"
              classList={{ on: voiceUi.screen }}
              onClick={() => (voiceUi.screen ? stopScreenShare() : setUi('modal', { type: 'go-live' }))}
            >
              <I.Screen size={18} /> {voiceUi.screen ? t('Stop') : t('Screen')}
            </button>
            <Show when={voiceUi.screen}>
              <button class="panel-btn" title={t('Share something else without ending the stream')} onClick={openSwitchSource}>
                <I.Switch size={18} /> {t('Switch')}
              </button>
            </Show>
          </Show>
        </div>
        <Show when={voiceUi.screen}>
          <div class="streaming-note">
            <span class="live-badge">{t('LIVE')}</span>
            <I.Eye size={14} /> {t('{n} watching', { n: viewersOf(state.me!.id).length })}
          </div>
        </Show>
      </Show>
      </div>
    </Show>
  );
}

const STATUSES: { id: Status; label: string }[] = [
  { id: 'online', label: msg('Online') },
  { id: 'idle', label: msg('Idle') },
  { id: 'dnd', label: msg('Do Not Disturb') },
  { id: 'invisible', label: msg('Invisible') },
];

function UserPanel() {
  const me = () => state.users[state.me!.id] ?? state.me!;
  const statusLabel = () => {
    const s = STATUSES.find((x) => x.id === presenceOf(me().id));
    return s ? t(s.label) : me().status === 'invisible' ? t('Invisible') : me().username;
  };
  const setStatus = (status: Status) => attempt(() => api('PATCH', '/users/@me', { status }));
  /** Quick microphone / speaker switch from the mute and deafen buttons. */
  const deviceMenu = async (e: MouseEvent, kind: 'audioinput' | 'audiooutput') => {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).closest('.split-btn')!.getBoundingClientRect();
    const input = kind === 'audioinput';
    const devices = (await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])).filter(
      (d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications',
    );
    const current = input ? prefs.inputDevice : prefs.outputDevice;
    const pick = (id: string) => (input ? (setPrefs({ inputDevice: id }), void restartMic()) : void setOutputDevice(id));
    const options = [{ deviceId: 'default', label: t('System default') }, ...devices.map((d) => ({ deviceId: d.deviceId, label: d.label || (input ? t('Microphone') : t('Speakers')) }))];
    const items: MenuEntry[] = [
      { label: t(input ? 'Input device' : 'Output device'), render: () => <div class="menu-title">{t(input ? 'Input device' : 'Output device')}</div> },
      ...options.map((d) => ({ label: d.label, checked: current === d.deviceId, run: () => pick(d.deviceId) })),
      'separator',
      { label: t('Voice settings'), icon: () => <I.Gear size={16} />, run: () => setUi('modal', { type: 'settings', tab: 'voice' }) },
    ];
    setUi('menu', { x: r.left, y: r.top - 8 - (options.length * 36 + 90), items });
  };
  const statusMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const custom = state.customStatus;
    const items: MenuEntry[] = [
      custom
        ? {
            label: t('Edit Custom Status'),
            render: () => (
              <div class="menu-custom-status">
                <button class="grow" onClick={() => (setUi('menu', null), openCustomStatus())}>
                  <CustomStatusView status={custom} size={16} />
                </button>
                <button class="icon-btn" aria-label={t('Clear Custom Status')} data-tip={t('Clear Custom Status')} onClick={() => (setUi('menu', null), void clearCustomStatusNow())}>
                  <I.Close size={14} />
                </button>
              </div>
            ),
          }
        : { label: t('Set Custom Status'), icon: () => <I.Smile size={16} />, run: openCustomStatus },
      'separator',
    ];
    setUi('menu', {
      x: r.left,
      y: r.top - 230 - 44,
      items: [
        ...items,
        ...STATUSES.map((s) => ({
          label: t(s.label),
          icon: () => <span class={`presence-dot ${s.id === 'invisible' ? 'offline' : s.id}`} />,
          run: () => setStatus(s.id),
        })),
        'separator' as const,
        { label: t('Copy Username'), icon: () => <I.Copy size={16} />, run: () => navigator.clipboard.writeText(me().username) },
        { label: t('Log Out'), danger: true, icon: () => <I.Logout size={16} />, run: () => logout() },
      ],
    });
  };
  return (
    <div class="user-panel">
      <Show when={voiceUi.mutedTalking}>
        <div class="muted-hint" onClick={() => void toggleMute()}>
          {t("You're muted — click to unmute")}
        </div>
      </Show>
      <button class="me-btn" onClick={statusMenu}>
        <Avatar user={me()} size={34} presence speaking={!!voiceUi.speaking[me().id]} />
        <span class="me-names">
          <strong>{nameOf(me().id)}</strong>
          <Show when={state.customStatus} fallback={<span>{statusLabel()}</span>}>
            {(s) => <CustomStatusView status={s()} />}
          </Show>
        </span>
      </button>
      <div class="split-btn" classList={{ off: voiceUi.muted }}>
        <button class="icon-btn" classList={{ off: voiceUi.muted }} aria-label={t('Mute')} data-tip={voiceUi.muted ? t('Unmute') : t('Mute')} onClick={() => void toggleMute()} onContextMenu={(e) => void deviceMenu(e, 'audioinput')}>
          <Show when={voiceUi.muted} fallback={<I.Mic size={19} />}>
            <I.MicOff size={19} />
          </Show>
        </button>
        <button class="split-chevron" aria-label={t('Microphone options')} onClick={(e) => void deviceMenu(e, 'audioinput')}>
          <I.Chevron size={13} />
        </button>
      </div>
      <div class="split-btn" classList={{ off: voiceUi.deafened }}>
        <button class="icon-btn" classList={{ off: voiceUi.deafened }} aria-label={t('Deafen')} data-tip={voiceUi.deafened ? t('Undeafen') : t('Deafen')} onClick={() => void toggleDeafen()} onContextMenu={(e) => void deviceMenu(e, 'audiooutput')}>
          <Show when={voiceUi.deafened} fallback={<I.Headphones size={19} />}>
            <I.HeadphonesOff size={19} />
          </Show>
        </button>
        <button class="split-chevron" aria-label={t('Speaker options')} onClick={(e) => void deviceMenu(e, 'audiooutput')}>
          <I.Chevron size={13} />
        </button>
      </div>
      <button class="icon-btn" aria-label={t('Settings')} data-tip={t('Settings')} onClick={() => setUi('modal', { type: 'settings' })}>
        <I.Gear size={19} />
      </button>
    </div>
  );
}

/** How long you've been in the call: m:ss, or h:mm:ss after an hour. */
function CallTimer(p: { since: number }) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const text = () => {
    const s = Math.max(0, Math.floor((now() - p.since) / 1000));
    const h = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  };
  return (
    <span class="call-timer" title={t('Call duration')}>
      {text()}
    </span>
  );
}
