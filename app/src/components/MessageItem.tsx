import DOMPurify from 'dompurify';
import { createEffect, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { api, emojiUrl, media } from '../lib/api';
import { filenameFromUrl } from '../lib/download';
import {
  dismissMessage,
  failedFileNames,
  jumpToMessage,
  retryMessage,
  selectChannel,
  startThread,
  togglePin,
  toggleReaction,
} from '../lib/actions';
import { dateLocale, msg, plural, t } from '../lib/i18n';
import { isJumbo, renderMarkdown } from '../lib/markdown';
import { can, P } from '../lib/perms';
import { openExternal } from '../lib/platform';
import { messageLink, openAppLink } from '../lib/route';
import { toDisplay, toRaw, type Tokens } from '../lib/mentions';
import { dmName, findEmoji, isBlocked, nameColor, nameOf, state } from '../lib/store';
import type { Attachment, Channel, Embed, Forwarded, Message } from '../lib/types';
import { videoPlayer, type VideoPlayer as LinkPlayer } from '../lib/video-links';
import { isPrivate, Kind } from '../lib/types';
import {
  attempt,
  focusComposer,
  isMobile,
  openMenu,
  openProfile,
  replyTo,
  setUi,
  toast,
  ui,
  type MenuEntry,
} from '../lib/ui';
import { Avatar } from './Avatar';
import { BirthdayCake } from './Birthday';
import { EmojiPicker, QUICK_REACTIONS } from './EmojiPicker';
import * as I from './Icons';
import { throwSnowball } from '../lib/snowball';
import { isChristmas } from '../lib/theme';
import { pauseChatVideo, VideoPlayer } from './VideoPlayer';
import { VoiceMessage } from './VoiceNote';
import { InviteCard, inviteCodes, isInviteUrl } from './InviteCard';

export function formatTime(iso: string, withDate = true) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
  if (!withDate) return time;
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return t('Today at {time}', { time });
  if (d.toDateString() === yesterday.toDateString()) return t('Yesterday at {time}', { time });
  return `${d.toLocaleDateString(dateLocale())} ${time}`;
}

// A second lock on everything rendered from messages: only what the markdown renderer itself writes gets through.
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'style' && !/^--role:#[0-9a-f]{6}$/.test(data.attrValue)) data.keepAttr = false;
});
const SANITIZE = {
  ALLOWED_TAGS: ['a', 'span', 'img', 'strong', 'em', 'u', 's', 'code', 'pre', 'blockquote', 'br', 'div'],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'data-user', 'style', 'src', 'alt', 'draggable'],
  ALLOW_DATA_ATTR: false,
};

export function renderContent(content: string, guildId?: string | null) {
  const html = renderMarkdown(content, {
    userName: (id) => nameOf(id, guildId),
    meId: state.me?.id,
    role: (id) => {
      const r = guildId ? state.roles[guildId]?.[id] : undefined;
      return r && { name: r.name, color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : undefined };
    },
    emojiUrl,
  });
  return DOMPurify.sanitize(html, SANITIZE);
}

/** Click handling for rendered markdown: spoilers, mentions and external links. */
export function onContentClick(e: MouseEvent, guildId?: string | null) {
  const t = e.target as HTMLElement;
  const spoiler = t.closest('.spoiler');
  if (spoiler) return spoiler.classList.add('revealed');
  const mention = t.closest<HTMLElement>('.mention');
  if (mention?.dataset.user) return openProfile(mention.dataset.user, e, guildId ?? undefined);
  const a = t.closest('a');
  if (a?.href) {
    e.preventDefault();
    if (!openAppLink(a.href)) void openExternal(a.href);
  }
}

/** How far from the newest message a picture still loads right away, since opening the channel shows it. */
const NEAR_LATEST = 20;

function nearLatest(channelId: string, id: string) {
  const list = state.messages[channelId]?.list ?? [];
  for (let i = list.length - 1; i >= 0 && i >= list.length - NEAR_LATEST; i--) if (list[i].id === id) return true;
  return false;
}

/** Sizes of pictures seen this session whose size the server doesn't know (link previews, some older files). */
const seenSizes = new Map<string, { width: number; height: number }>();
const SEEN_SIZES = 3000;

/**
 * A picture in the chat, in its final size from the first frame when that's known, so nothing jumps while it loads. The
 * newest ones are fetched straight away and painted with the message, which is what opening a channel needs.
 */
function ChatImage(p: {
  class: string;
  src: string;
  alt: string;
  eager: boolean;
  /** On another site: it doesn't need to know where it's shown. */
  external?: boolean;
  size?: { width: number; height: number };
  max: [number, number];
  onClick: () => void;
}) {
  const style = () => {
    const s = p.size ?? seenSizes.get(p.src);
    if (!s) return undefined;
    const scale = Math.min(1, p.max[0] / s.width, p.max[1] / s.height);
    // "auto": once it has loaded its real shape wins, if this was wrong (a rotated photo).
    return {
      width: `${Math.round(s.width * scale)}px`,
      'aspect-ratio': `auto ${s.width} / ${s.height}`,
      height: 'auto',
    };
  };
  return (
    <img
      class={p.class}
      loading={p.eager ? 'eager' : 'lazy'}
      decoding={p.eager ? 'sync' : 'async'}
      referrerpolicy={p.external ? 'no-referrer' : undefined}
      style={style()}
      src={p.src}
      alt={p.alt}
      onLoad={(e) => {
        if (p.size || seenSizes.has(p.src)) return;
        if (seenSizes.size >= SEEN_SIZES) seenSizes.delete(seenSizes.keys().next().value!);
        seenSizes.set(p.src, { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight });
      }}
      onClick={p.onClick}
    />
  );
}

/** Renders a reaction emoji: unicode as text, custom (`name:id`) as an image. */
export function ReactionEmoji(p: { emoji: string }) {
  const custom = () => p.emoji.match(/^(\w+):(\d+)$/);
  return (
    <Show when={custom()} fallback={<span class="reaction-emoji">{p.emoji}</span>}>
      {(m) => (
        <img
          class="emoji custom reaction-img"
          src={emojiUrl(m()[2], findEmoji(m()[2])?.animated)}
          alt={`:${m()[1]}:`}
          title={`:${m()[1]}:`}
        />
      )}
    </Show>
  );
}

/** Messages that are nothing but one image/GIF link show just the image, like Discord. */
function linkOnlyImage(m: Pick<Message, 'content' | 'embeds'>): boolean {
  const c = m.content.trim();
  return /^https?:\/\/\S+$/.test(c) && m.embeds.length === 1 && m.embeds[0].type !== 'link' && m.embeds[0].url === c;
}

/** Discord-style welcome lines for "joined the server", one picked per message. */
const JOIN_LINES = [
  msg('{name} joined the party.'),
  msg('{name} just showed up!'),
  msg('Welcome, {name}. We hope you brought pizza.'),
  msg('A wild {name} appeared.'),
  msg('{name} just landed.'),
  msg('Good to see you, {name}.'),
  msg('{name} hopped into the server.'),
  msg('Everyone welcome {name}!'),
];

/** System messages: someone joined the server, or pinned a message (click to see it highlighted). */
function SystemMessage(p: { message: Message; guildId?: string | null }) {
  const m = () => p.message;
  const name = () => nameOf(m().author.id, p.guildId);
  const line = () => {
    const tpl = t(JOIN_LINES[Number(BigInt(m().id) % BigInt(JOIN_LINES.length))]);
    const [before, after] = tpl.split('{name}');
    return { before, after: after ?? '' };
  };
  const menu = (e: MouseEvent) => {
    const items: MenuEntry[] = [
      {
        label: t('Copy Message ID'),
        icon: () => <I.Copy size={16} />,
        run: () => navigator.clipboard.writeText(m().id),
      },
    ];
    if (p.guildId && can(p.guildId, P.MANAGE_MESSAGES, m().channel_id))
      items.push({
        label: t('Delete Message'),
        danger: true,
        icon: () => <I.Trash size={16} />,
        run: () => attempt(() => api('DELETE', `/channels/${m().channel_id}/messages/${m().id}`)),
      });
    openMenu(e, items);
  };
  const who = () => (
    <button
      class="system-name"
      style={{ color: nameColor(p.guildId, m().author.id) }}
      onClick={(e) => openProfile(m().author.id, e, p.guildId ?? undefined)}
    >
      {name()}
    </button>
  );
  return (
    <div
      class="message system-message"
      classList={{ highlight: state.highlight === m().id }}
      id={`msg-${m().id}`}
      onContextMenu={menu}
    >
      <Switch>
        <Match when={m().type === 7}>
          <span class="system-icon join">
            <I.ArrowRight size={16} />
          </span>
          <span class="system-text">
            {line().before}
            {who()}
            {line().after}
          </span>
        </Match>
        <Match when={m().type === 6}>
          <span class="system-icon">
            <I.Pin size={16} />
          </span>
          <span class="system-text">
            {who()} {t('pinned')}{' '}
            <button
              class="system-link"
              onClick={() => m().reply_to && void jumpToMessage(m().channel_id, m().reply_to!)}
            >
              {t('a message')}
            </button>{' '}
            {t('to this channel.')}{' '}
            <button class="system-link" onClick={() => setUi('panel', 'pins')}>
              {t('See all pinned messages.')}
            </button>
          </span>
        </Match>
      </Switch>
      <time class="system-time" title={new Date(m().created_at).toLocaleString(dateLocale())}>
        {formatTime(m().created_at)}
      </time>
    </div>
  );
}

export function MessageItem(p: { message: Message; grouped: boolean; guildId?: string | null }) {
  if (p.message.type === 6 || p.message.type === 7) return <SystemMessage message={p.message} guildId={p.guildId} />;
  const m = () => p.message;
  const me = () => state.me!.id;
  const author = () => state.users[m().author.id] ?? m().author;
  const mine = () => m().author.id === me();
  const isVoice = () => !!m().attachments[0]?.waveform;
  // Forwards can't be edited, like Discord.
  const canEdit = () => mine() && !isVoice() && !m().forwarded;
  const text = () => m().content || m().forwarded?.content || '';
  const forward = () => setUi('modal', { type: 'forward', message: m() });
  const channel = () => state.channels[m().channel_id];
  const [picker, setPicker] = createSignal(false);
  const [pickerStyle, setPickerStyle] = createSignal<JSX.CSSProperties>({});
  const [editText, setEditText] = createSignal('');
  const [showBlocked, setShowBlocked] = createSignal(false);
  const editing = () => ui.editing === m().id;
  const myRoles = () => (p.guildId ? (state.members[p.guildId]?.[me()]?.roles ?? []) : []);
  const mentionsMe = () =>
    m().content.includes(`<@${me()}>`) ||
    !!m().mention_everyone ||
    m().referenced_message?.author.id === me() ||
    myRoles().some((r) => m().content.includes(`<@&${r}>`));
  const canManage = () => (p.guildId ? can(p.guildId, P.MANAGE_MESSAGES, m().channel_id) : false);
  const canPin = () => isPrivate(channel()?.kind ?? Kind.Text) || canManage();
  const canThread = () =>
    channel()?.kind === Kind.Text && !m().thread_id && can(p.guildId, P.CREATE_THREADS, m().channel_id);
  const canReact = () => can(p.guildId, P.ADD_REACTIONS, m().channel_id);

  // The reaction picker floats above the message list so neither neighbouring messages nor the
  // list's edges can clip it; it flips above the toolbar when there's no room below.
  let actionsEl!: HTMLDivElement;
  let pickerClosedAt = 0;
  const closePicker = () => {
    setPicker(false);
    pickerClosedAt = performance.now();
  };
  const togglePicker = () => {
    // The click that closed it via "outside click" shouldn't reopen it.
    if (picker() || performance.now() - pickerClosedAt < 250) return closePicker();
    const r = actionsEl.getBoundingClientRect();
    const w = 340;
    const h = 360;
    const top = r.bottom + 6 + h <= innerHeight - 8 ? r.bottom + 6 : Math.max(8, r.top - 6 - h);
    setPickerStyle({ top: `${top}px`, left: `${Math.min(Math.max(8, r.right - w), innerWidth - w - 8)}px` });
    setPicker(true);
  };
  createEffect(() => {
    if (!picker()) return;
    const onScroll = (e: Event) => (e.target as Element).closest?.('.emoji-picker') || closePicker();
    document.addEventListener('scroll', onScroll, true);
    onCleanup(() => document.removeEventListener('scroll', onScroll, true));
  });

  const startEdit = () => setUi('editing', m().id);
  // However editing starts (menu, toolbar, ↑ in an empty composer), the box opens with the message text.
  const editTokens: Tokens = new Map();
  createEffect(on(editing, (on) => on && setEditText(toDisplay(m().content, p.guildId, editTokens))));
  const cancelEdit = () => {
    setUi('editing', null);
    focusComposer();
  };
  const saveEdit = async () => {
    const content = toRaw(editText(), p.guildId, editTokens).trim();
    cancelEdit();
    if (content && content !== m().content)
      await attempt(() => api('PATCH', `/channels/${m().channel_id}/messages/${m().id}`, { content }));
  };
  const remove = (e?: MouseEvent) => {
    const run = () => api('DELETE', `/channels/${m().channel_id}/messages/${m().id}`);
    if (e?.shiftKey) return void attempt(run);
    setUi('modal', {
      type: 'confirm',
      title: t('Delete message'),
      body: t('Are you sure you want to delete this message? (Shift-click the trash icon to skip this.)'),
      action: t('Delete'),
      run,
    });
  };
  const copy = (text: string, done: string) => navigator.clipboard.writeText(text).then(() => toast(done));

  const menu = (e: MouseEvent): MenuEntry[] => {
    // It never reached the server: nothing else on the menu could work on it.
    if (m().failed)
      return [
        { label: t('Retry'), icon: () => <I.Rejoin size={16} />, run: () => void retryMessage(m()) },
        {
          label: t('Copy Text'),
          icon: () => <I.Copy size={16} />,
          run: () => copy(m().content, t('Text copied')),
        },
        {
          label: t('Delete Message'),
          danger: true,
          icon: () => <I.Trash size={16} />,
          run: () => dismissMessage(m()),
        },
      ];
    const items: MenuEntry[] = [];
    // Right-clicked a link: its own actions first, like a browser.
    const link = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (link && /^https?:/.test(link.href))
      items.push(
        { label: t('Copy Link'), icon: () => <I.Link size={16} />, run: () => copy(link.href, t('Link copied')) },
        {
          label: t('Open Link'),
          icon: () => <I.External size={16} />,
          run: () => !openAppLink(link.href) && void openExternal(link.href),
        },
        'separator',
      );
    if (canReact()) {
      items.push({
        label: t('Add Reaction'),
        render: () => (
          <div class="menu-reactions">
            <For each={QUICK_REACTIONS}>
              {(r) => <button onClick={() => (setUi('menu', null), void toggleReaction(m(), r))}>{r}</button>}
            </For>
          </div>
        ),
      });
    }
    items.push({ label: t('Reply'), icon: () => <I.Reply size={16} />, run: () => replyTo(m().channel_id, m().id) });
    items.push({ label: t('Forward'), icon: () => <I.Forward size={16} />, run: forward });
    if (isChristmas() && m().author.id !== state.me?.id)
      items.push({
        label: t('Throw a Snowball'),
        icon: () => <I.Snowflake size={16} />,
        run: () => throwSnowball(m().channel_id, m().author.id, m().id),
      });
    if (canEdit()) items.push({ label: t('Edit Message'), icon: () => <I.Edit size={16} />, run: startEdit });
    if (canThread())
      items.push({
        label: t('Create Thread'),
        icon: () => <I.Thread size={16} />,
        run: () => attempt(() => startThread(m())),
      });
    if (canPin())
      items.push({
        label: m().pinned ? t('Unpin Message') : t('Pin Message'),
        icon: () => <I.Pin size={16} />,
        run: () => attempt(() => togglePin(m())),
      });
    items.push('separator');
    if (text())
      items.push({
        label: t('Copy Text'),
        icon: () => <I.Copy size={16} />,
        run: () => copy(text(), t('Text copied')),
      });
    items.push({
      label: t('Copy Message Link'),
      icon: () => <I.Link size={16} />,
      run: () => copy(messageLink(m().channel_id, m().id), t('Link copied')),
    });
    items.push({
      label: t('Copy Message ID'),
      icon: () => <I.Copy size={16} />,
      run: () => copy(m().id, t('ID copied')),
    });
    if (mine() || canManage()) {
      items.push('separator');
      items.push({
        label: t('Select Messages'),
        icon: () => <I.Check size={16} />,
        run: () => setUi('selection', { channelId: m().channel_id, ids: [m().id], anchor: m().id }),
      });
      items.push({ label: t('Delete Message'), danger: true, icon: () => <I.Trash size={16} />, run: () => remove(e) });
    }
    return items;
  };

  // Touch screens: hold a message to open its menu (iOS never fires contextmenu).
  let pressTimer: number | undefined;
  const cancelPress = () => clearTimeout(pressTimer);
  const onTouchStart = (e: TouchEvent) => {
    if (m().pending || e.touches.length !== 1) return;
    const { clientX: x, clientY: y } = e.touches[0];
    pressTimer = window.setTimeout(() => {
      navigator.vibrate?.(8);
      setUi('menu', { x, y, items: menu({ shiftKey: false } as MouseEvent) });
    }, 450);
  };

  // Bulk delete: while selecting, a click (anywhere on the message) toggles it; shift-click picks a range.
  // Decided once, as the message appears: the newest ones are what opening a channel shows.
  const eager = nearLatest(m().channel_id, m().id);
  const selecting = () => ui.selection?.channelId === m().channel_id;
  const selectable = () => !m().pending && !m().failed && (mine() || canManage());
  const selected = () => selecting() && ui.selection!.ids.includes(m().id);
  const onSelectClick = (e: MouseEvent) => {
    if (!selecting()) return;
    e.preventDefault();
    e.stopPropagation();
    if (selectable()) toggleSelected(m(), e.shiftKey, (x) => x.author.id === me() || canManage());
  };

  return (
    <Show
      when={!isBlocked(m().author.id) || showBlocked()}
      fallback={
        <div class="blocked-message">
          {t('1 blocked message')} —{' '}
          <button class="link-btn" onClick={() => setShowBlocked(true)}>
            {t('Show')}
          </button>
        </div>
      }
    >
      <div
        class="message"
        classList={{
          grouped: p.grouped,
          pending: m().pending,
          failed: m().failed,
          mentioned: mentionsMe(),
          editing: editing(),
          highlight: state.highlight === m().id,
          selecting: selecting(),
          selected: selected(),
          unselectable: selecting() && !selectable(),
        }}
        id={`msg-${m().id}`}
        onContextMenu={(e) => !m().pending && !selecting() && openMenu(e, menu(e))}
        onTouchStart={onTouchStart}
        onTouchMove={cancelPress}
        onTouchEnd={cancelPress}
        onTouchCancel={cancelPress}
        ref={(el) => el.addEventListener('click', onSelectClick, true)}
      >
        <Show when={isMobile()}>
          {/* Revealed when the message is swiped left to reply (lib/swipe.ts). */}
          <span class="swipe-reply" aria-hidden="true">
            <I.Reply size={20} />
          </span>
        </Show>
        <Show when={m().referenced_message}>
          {(ref) => (
            <div class="reply-ref" onClick={() => void jumpToMessage(m().channel_id, ref().id)}>
              <Avatar user={state.users[ref().author.id] ?? ref().author} size={16} />
              <span class="reply-author" style={{ color: nameColor(p.guildId, ref().author.id) }}>
                {nameOf(ref().author.id, p.guildId)}
              </span>
              <span
                class="reply-text"
                innerHTML={renderContent(ref().content.split('\n')[0] || t('Click to see attachment'), p.guildId)}
              />
            </div>
          )}
        </Show>
        <Show when={m().interaction}>
          {(it) => (
            <div class="reply-ref interaction">
              <Avatar user={state.users[it().user.id] ?? it().user} size={16} />
              <span class="reply-author" style={{ color: nameColor(p.guildId, it().user.id) }}>
                {nameOf(it().user.id, p.guildId)}
              </span>
              <span class="reply-text">
                {t('used')} <span class="interaction-name">/{it().name}</span>
              </span>
            </div>
          )}
        </Show>
        <div class="message-row">
          <Show when={selecting()}>
            <span class="select-check" aria-hidden="true">
              <Show when={selected()}>
                <I.Check size={13} />
              </Show>
            </span>
          </Show>
          <div class="message-gutter">
            <Show when={!p.grouped} fallback={<span class="hover-time">{formatTime(m().created_at, false)}</span>}>
              <button class="avatar-btn" onClick={(e) => openProfile(author().id, e, p.guildId ?? undefined)}>
                <Avatar user={author()} size={40} guildId={p.guildId} />
              </button>
            </Show>
          </div>
          <div class="message-body">
            <Show when={!p.grouped}>
              <div class="message-head">
                <button
                  class="author"
                  style={{ color: nameColor(p.guildId, author().id) }}
                  onClick={(e) => openProfile(author().id, e, p.guildId ?? undefined)}
                >
                  {nameOf(author().id, p.guildId)}
                </button>
                <BirthdayCake userId={author().id} />
                <Show when={author().bot}>
                  <span class="bot-tag">{t('BOT')}</span>
                </Show>
                <time title={new Date(m().created_at).toLocaleString(dateLocale())}>{formatTime(m().created_at)}</time>
                <Show when={m().pinned}>
                  <span class="pinned-tag" title={t('Pinned')}>
                    <I.Pin size={12} />
                  </span>
                </Show>
              </div>
            </Show>
            <Show
              when={editing()}
              fallback={
                <Show when={m().content && !linkOnlyImage(m())}>
                  <div
                    class="content"
                    classList={{ jumbo: isJumbo(m().content) }}
                    onClick={(e) => onContentClick(e, p.guildId)}
                  >
                    <span innerHTML={renderContent(m().content, p.guildId)} />
                    <Show when={m().edited_at}>
                      <span class="edited" title={new Date(m().edited_at!).toLocaleString(dateLocale())}>
                        {' '}
                        ({t('edited')})
                      </span>
                    </Show>
                  </div>
                </Show>
              }
            >
              <div class="edit-box">
                <textarea
                  value={editText()}
                  onInput={(e) => setEditText(e.currentTarget.value)}
                  ref={(el) =>
                    setTimeout(() => {
                      el.focus();
                      el.setSelectionRange(el.value.length, el.value.length);
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') cancelEdit();
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void saveEdit();
                    }
                  }}
                />
                <span class="small muted">{t('escape to cancel • enter to save')}</span>
              </div>
            </Show>
            <Show when={m().forwarded}>{(f) => <ForwardedView f={f()} m={m()} />}</Show>
            <For each={m().attachments}>
              {(a) =>
                a.waveform ? (
                  <VoiceMessage
                    a={a}
                    src={media(a.url)!}
                    author={m().author}
                    channelId={m().channel_id}
                    messageId={m().id}
                  />
                ) : (
                  <AttachmentView a={a} eager={eager} />
                )
              }
            </For>
            <For each={inviteCodes(m().content)}>{(code) => <InviteCard code={code} mine={mine()} />}</For>
            <For each={m().embeds.filter((e) => !isInviteUrl(e.url))}>{(e) => <EmbedView e={e} eager={eager} />}</For>
            <Show when={m().thread_id ? state.channels[m().thread_id!] : undefined}>
              {(th) => (
                <button class="thread-chip" onClick={() => selectChannel(th().id)}>
                  <I.Thread size={16} />
                  <strong>{th().name}</strong>
                  <span class="muted">{plural(th().message_count ?? 0, '{n} message', '{n} messages')}</span>
                </button>
              )}
            </Show>
            <Show when={m().failed}>
              <div class="failed-note">
                {failedFileNames(m()).length
                  ? t('Failed to send {files}.', { files: failedFileNames(m()).join(', ') })
                  : t('Failed to send.')}{' '}
                <button class="link-btn" onClick={() => retryMessage(m())}>
                  {t('Retry')}
                </button>{' '}
                ·{' '}
                <button class="link-btn" onClick={() => dismissMessage(m())}>
                  {t('Delete')}
                </button>
              </div>
            </Show>
            <Show when={m().reactions.length}>
              <div class="reactions">
                <For each={m().reactions}>
                  {(r) => (
                    <button
                      class="reaction"
                      classList={{ mine: r.users.includes(me()) }}
                      title={r.users.map((u) => nameOf(u, p.guildId)).join(', ')}
                      onClick={() => void attempt(() => toggleReaction(m(), r.emoji))}
                    >
                      <ReactionEmoji emoji={r.emoji} />
                      <span>{r.users.length}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
        <Show when={!m().pending && !m().failed && !editing() && !selecting()}>
          <div class="message-actions" classList={{ open: picker() }} ref={actionsEl}>
            <Show when={canReact()}>
              <For each={QUICK_REACTIONS.slice(0, 3)}>
                {(e) => (
                  <button class="emoji-quick" onClick={() => void attempt(() => toggleReaction(m(), e))}>
                    {e}
                  </button>
                )}
              </For>
              <button class="icon-btn" data-tip={t('Add reaction')} onClick={togglePicker}>
                <I.Smile size={18} />
              </button>
            </Show>
            <button class="icon-btn" data-tip={t('Reply')} onClick={() => replyTo(m().channel_id, m().id)}>
              <I.Reply size={18} />
            </button>
            <button class="icon-btn" data-tip={t('Forward')} onClick={forward}>
              <I.Forward size={18} />
            </button>
            <Show when={canThread()}>
              <button
                class="icon-btn"
                data-tip={t('Create thread')}
                onClick={() => void attempt(() => startThread(m()))}
              >
                <I.Thread size={18} />
              </button>
            </Show>
            <Show when={canEdit()}>
              <button class="icon-btn" data-tip={t('Edit')} onClick={startEdit}>
                <I.Edit size={18} />
              </button>
            </Show>
            <Show when={mine() || canManage()}>
              <button class="icon-btn danger" data-tip={t('Delete')} onClick={remove}>
                <I.Trash size={18} />
              </button>
            </Show>
            <Show when={picker()}>
              <Portal>
                <EmojiPicker
                  class="message-picker"
                  style={pickerStyle()}
                  guildId={p.guildId}
                  onClose={closePicker}
                  onPick={(e) => {
                    closePicker();
                    void attempt(() => toggleReaction(m(), e.reaction));
                  }}
                />
              </Portal>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}

function toggleSelected(m: Message, range: boolean, deletable: (m: Message) => boolean) {
  const sel = ui.selection!;
  const list = state.messages[m.channel_id]?.list ?? [];
  let ids: string[];
  if (range && sel.anchor) {
    const [a, b] = [list.findIndex((x) => x.id === sel.anchor), list.findIndex((x) => x.id === m.id)].sort(
      (x, y) => x - y,
    );
    const span = a < 0 ? [m] : list.slice(a, b + 1).filter((x) => !x.pending && !x.failed && deletable(x));
    ids = [...new Set([...sel.ids, ...span.map((x) => x.id)])];
  } else {
    ids = sel.ids.includes(m.id) ? sel.ids.filter((id) => id !== m.id) : [...sel.ids, m.id];
  }
  setUi('selection', { ...sel, ids: ids.slice(0, 200), anchor: m.id });
}

/** Where a forward came from, if you can see that channel. */
function originName(ch: Channel): string {
  if (!ch.guild_id) return dmName(ch);
  const guild = state.guilds[ch.guild_id]?.name;
  return guild ? `#${ch.name} • ${guild}` : `#${ch.name}`;
}

/** A forwarded message: "Forwarded", the original as it was, and a link back to it for people who can see it. */
function ForwardedView(p: { f: Forwarded; m: Message }) {
  const guildId = () => p.f.guild_id;
  const origin = () => state.channels[p.f.channel_id];
  return (
    <div class="forwarded">
      <div class="forwarded-label">
        <I.Forward size={14} />
        <span>{t('Forwarded')}</span>
      </div>
      <Show when={p.f.content && !linkOnlyImage(p.f)}>
        <div class="content" classList={{ jumbo: isJumbo(p.f.content) }} onClick={(e) => onContentClick(e, guildId())}>
          <span innerHTML={renderContent(p.f.content, guildId())} />
        </div>
      </Show>
      <For each={p.f.attachments}>
        {(a) =>
          a.waveform ? (
            <VoiceMessage a={a} src={media(a.url)!} author={p.m.author} channelId={p.m.channel_id} messageId={p.m.id} />
          ) : (
            <AttachmentView a={a} eager={false} />
          )
        }
      </For>
      <For each={inviteCodes(p.f.content)}>{(code) => <InviteCard code={code} mine={false} />}</For>
      <For each={p.f.embeds.filter((e) => !isInviteUrl(e.url))}>{(e) => <EmbedView e={e} eager={false} />}</For>
      <div class="forwarded-origin">
        <Show when={origin()}>
          {(ch) => (
            <>
              <button class="forwarded-link" onClick={() => void jumpToMessage(ch().id, p.f.message_id)}>
                {originName(ch())}
              </button>
              <span aria-hidden="true">•</span>
            </>
          )}
        </Show>
        <time title={new Date(p.f.created_at).toLocaleString(dateLocale())}>{formatTime(p.f.created_at)}</time>
      </div>
    </div>
  );
}

export function formatSize(n: number) {
  const num = (x: number) => x.toLocaleString(dateLocale(), { maximumFractionDigits: 1 });
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${num(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${num(n / 1024 ** 2)} MB`;
  return `${num(n / 1024 ** 3)} GB`;
}

/** Any file: its name and size, click to open or save. */
function FileCard(p: { a: Attachment }) {
  const url = () => media(p.a.url)!;
  return (
    <a
      class="file-card"
      href={url()}
      onClick={(e) => {
        e.preventDefault();
        void openExternal(url());
      }}
    >
      <I.Paperclip size={22} />
      <span class="file-info">
        <span class="file-name">{p.a.filename}</span>
        <span class="small muted">{formatSize(p.a.size)}</span>
      </span>
      <I.Download size={18} />
    </a>
  );
}

/** How much of a text file is previewed in the chat. */
const TEXT_PREVIEW_BYTES = 16 * 1024;

/** A .txt file, like the one long messages turn into: the start of it in the chat, fetched once it's on screen. */
function TextFileView(p: { a: Attachment }) {
  const [text, setText] = createSignal<string | null>(null);
  const [open, setOpen] = createSignal(false);
  let el!: HTMLDivElement;
  onMount(() => {
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      void fetch(media(p.a.url)!, { headers: { range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } })
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
        .then((b) => setText(new TextDecoder().decode(b.slice(0, TEXT_PREVIEW_BYTES))))
        .catch(() => setText(''));
    });
    seen.observe(el);
    onCleanup(() => seen.disconnect());
  });
  const long = () => (text() ?? '').length > 600 || (text() ?? '').split('\n').length > 8;
  return (
    <div class="text-file" ref={el}>
      <FileCard a={p.a} />
      <Show when={text() !== ''}>
        <pre class="text-file-body" classList={{ open: open() }}>
          {text() ?? ''}
        </pre>
        <Show when={long()}>
          <div class="text-file-more">
            <button class="link-btn" onClick={() => setOpen(!open())}>
              {open() ? t('Show less') : t('Show more')}
            </button>
            <Show when={open() && p.a.size > TEXT_PREVIEW_BYTES}>
              <span class="muted small">{t('Open the file to read the rest.')}</span>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}

function AttachmentView(p: { a: Attachment; eager: boolean }) {
  const url = () => media(p.a.url)!;
  const kind = () => p.a.content_type.split('/')[0];
  return (
    <Switch fallback={<FileCard a={p.a} />}>
      <Match when={kind() === 'image'}>
        <div class="media-wrap">
          <ChatImage
            class="attachment-media"
            src={url()}
            alt={p.a.filename}
            eager={p.eager}
            size={p.a.width && p.a.height ? { width: p.a.width, height: p.a.height } : undefined}
            max={[440, 340]}
            onClick={() => setUi('lightbox', url())}
          />
        </div>
      </Match>
      <Match when={p.a.content_type.startsWith('text/plain')}>
        <TextFileView a={p.a} />
      </Match>
      <Match when={kind() === 'video'}>
        <VideoPlayer src={url()} filename={p.a.filename} />
      </Match>
      <Match when={kind() === 'audio'}>
        <audio class="attachment-audio" src={url()} controls preload="metadata" />
      </Match>
    </Switch>
  );
}

function EmbedView(p: { e: Embed; eager: boolean }) {
  return (
    <Switch>
      <Match when={p.e.type === 'image'}>
        <div class="media-wrap">
          <ChatImage
            class="attachment-media"
            src={p.e.url}
            alt=""
            eager={p.eager}
            external
            max={[440, 340]}
            onClick={() => setUi('lightbox', p.e.url)}
          />
        </div>
      </Match>
      <Match when={p.e.type === 'video'}>
        <VideoPlayer src={p.e.url} filename={filenameFromUrl(p.e.url)} />
      </Match>
      <Match when={p.e.type === 'link' && videoPlayer(p.e.resolved_url ?? p.e.url)}>
        {(player) => <VideoLinkEmbed e={p.e} player={player()} />}
      </Match>
      <Match when={p.e.type === 'link' || p.e.type === 'rich'}>
        <div
          class="embed"
          classList={{ rich: p.e.type === 'rich' }}
          style={{ 'border-left-color': p.e.color != null ? `#${p.e.color.toString(16).padStart(6, '0')}` : undefined }}
        >
          <div class="embed-text">
            <Show when={p.e.site_name}>
              <div class="embed-site">{p.e.site_name}</div>
            </Show>
            <Show when={p.e.title}>
              <a
                class="embed-title"
                href={p.e.url}
                onClick={(ev) => {
                  ev.preventDefault();
                  void openExternal(p.e.url);
                }}
              >
                {p.e.title}
              </a>
            </Show>
            <Show when={p.e.description}>
              <div class="embed-desc">{p.e.description}</div>
            </Show>
            <Show when={p.e.image && p.e.large_image}>
              <ChatImage
                class="embed-image large"
                src={p.e.image!}
                alt=""
                eager={p.eager}
                external
                max={[1000, 300]}
                onClick={() => setUi('lightbox', p.e.image!)}
              />
            </Show>
          </div>
          <Show when={p.e.image && !p.e.large_image}>
            <img
              class="embed-image thumb"
              src={p.e.image!}
              alt=""
              loading="lazy"
              referrerpolicy="no-referrer"
              onClick={() => setUi('lightbox', p.e.image!)}
            />
          </Show>
        </div>
      </Match>
    </Switch>
  );
}

/** YouTube, TikTok, Reels...: a poster with a play button that turns into the site's own player. */
function VideoLinkEmbed(p: { e: Embed; player: LinkPlayer }) {
  const [playing, setPlaying] = createSignal(false);
  const open = (ev: MouseEvent) => {
    ev.preventDefault();
    void openExternal(p.e.url);
  };
  return (
    <div class="embed video-embed" style={{ 'border-left-color': p.player.color }}>
      <div class="embed-text">
        <div class="embed-site video-embed-site">
          <span>
            {p.e.site_name ?? p.player.provider}
            <Show when={p.e.author}> · {p.e.author}</Show>
          </span>
          <a
            class="video-external"
            href={p.e.url}
            title={t('Open on {site}', { site: p.player.provider })}
            aria-label={t('Open on {site}', { site: p.player.provider })}
            onClick={open}
          >
            <I.External size={15} />
          </a>
        </div>
        <Show when={p.e.title}>
          <a class="embed-title" href={p.e.url} onClick={open}>
            {p.e.title}
          </a>
        </Show>
        <Show when={p.e.description && !p.player.vertical}>
          <div class="embed-desc clamp-2">{p.e.description}</div>
        </Show>
        <div class="video-frame" classList={{ vertical: p.player.vertical }}>
          <Show
            when={playing()}
            fallback={
              <button
                class="video-poster"
                aria-label={p.e.title ? t('Play {title}', { title: p.e.title }) : t('Play video')}
                onClick={() => {
                  pauseChatVideo();
                  setPlaying(true);
                }}
              >
                <Show when={p.e.image}>
                  <img src={p.e.image!} alt="" loading="lazy" referrerpolicy="no-referrer" />
                </Show>
                <span class="video-play">
                  <I.Play size={26} />
                </span>
              </button>
            }
          >
            <iframe
              src={p.player.src}
              title={p.e.title ?? p.player.provider}
              allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write; web-share"
              allowfullscreen
              referrerpolicy="strict-origin-when-cross-origin"
            />
          </Show>
        </div>
      </div>
    </div>
  );
}
