import {
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  type JSX,
} from 'solid-js';
import { api, serverUrl } from '../lib/api';
import { createGroupDm, dmChannel, selectChannel, selectView, sendMessage } from '../lib/actions';
import { plural, t } from '../lib/i18n';
import { can, P, topPosition } from '../lib/perms';
import { addGuild, dmName, nameOf, state } from '../lib/store';
import type { Channel, Guild, GuildInfo, User } from '../lib/types';
import { displayName, Kind, Rel } from '../lib/types';
import { attempt, setUi, toast, ui, type Modal } from '../lib/ui';
import { Avatar, GuildIcon } from './Avatar';
import * as I from './Icons';
import { CustomStatusModal } from './CustomStatus';
import { ForwardModal } from './Forward';
import { accentCss, ProfileModal } from './Profile';
import { railEntries, updateFolder } from './Rail';
import { Settings } from './Settings';
import { ServerSettings } from './SettingsModals';
import { prefs } from '../lib/prefs';
import { startScreenShare, switchScreenSource, updateStreamQuality, voiceUi, type StreamQuality } from '../lib/voice';
import {
  captureCapabilities,
  listCaptureSources,
  nativeCaptureAvailable,
  type CaptureSource,
} from '../lib/native-capture';

export function ModalHost() {
  const close = () => setUi('modal', null);
  // Escape closes dialogs even when focus has left them (e.g. the clicked button got disabled).
  // The full-window settings screens handle their own Escape.
  const onKey = (e: KeyboardEvent) => {
    const type = ui.modal?.type;
    if (e.key !== 'Escape' || e.defaultPrevented || !type || type === 'settings' || type === 'server-settings') return;
    if (document.querySelector('.context-menu')) return;
    close();
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));
  return (
    <Show when={ui.modal}>
      {(m) => (
        // User and server settings take the whole window rather than a dialog.
        <Show
          when={m().type !== 'settings' && m().type !== 'server-settings'}
          fallback={
            <Switch>
              <Match when={m().type === 'settings' && (m() as Extract<Modal, { type: 'settings' }>)}>
                {(x) => <Settings tab={x().tab} />}
              </Match>
              <Match
                when={m().type === 'server-settings' && (m() as Extract<Modal, { type: 'server-settings' }>)}
                keyed
              >
                {(x) => <ServerSettings guildId={x.guildId} tab={x.tab} />}
              </Match>
            </Switch>
          }
        >
          <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
            <Switch>
              <Match when={m().type === 'add-server'}>
                <AddServer />
              </Match>
              <Match when={m().type === 'invite' && (m() as Extract<Modal, { type: 'invite' }>)}>
                {(x) => <Invite guildId={x().guildId} />}
              </Match>
              <Match when={m().type === 'create-channel' && (m() as Extract<Modal, { type: 'create-channel' }>)}>
                {(x) => <CreateChannel guildId={x().guildId} kind={x().kind} parentId={x().parentId} />}
              </Match>
              <Match when={m().type === 'channel-settings' && (m() as Extract<Modal, { type: 'channel-settings' }>)}>
                {(x) => <ChannelSettings channelId={x().channelId} />}
              </Match>
              <Match when={m().type === 'go-live' && (m() as Extract<Modal, { type: 'go-live' }>)}>
                {(x) => <GoLive update={!!x().update} switchSource={!!x().switchSource} />}
              </Match>
              <Match when={m().type === 'folder-settings' && (m() as Extract<Modal, { type: 'folder-settings' }>)}>
                {(x) => <FolderSettings folderId={x().folderId} />}
              </Match>
              <Match when={m().type === 'user-profile' && (m() as Extract<Modal, { type: 'user-profile' }>)}>
                {(x) => <ProfileModal userId={x().userId} guildId={x().guildId} />}
              </Match>
              <Match when={m().type === 'custom-status'}>
                <CustomStatusModal />
              </Match>
              <Match when={m().type === 'create-group' && (m() as Extract<Modal, { type: 'create-group' }>)}>
                {(x) => <CreateGroup channelId={x().channelId} />}
              </Match>
              <Match when={m().type === 'forward' && (m() as Extract<Modal, { type: 'forward' }>)}>
                {(x) => <ForwardModal message={x().message} />}
              </Match>
              <Match when={m().type === 'nickname' && (m() as Extract<Modal, { type: 'nickname' }>)}>
                {(x) => <MemberEditor guildId={x().guildId} userId={x().userId} />}
              </Match>
              <Match when={m().type === 'join-invite' && (m() as Extract<Modal, { type: 'join-invite' }>)}>
                {(x) => <JoinInvite code={x().code} />}
              </Match>
              <Match when={m().type === 'confirm' && (m() as Extract<Modal, { type: 'confirm' }>)}>
                {(x) => <Confirm {...x()} />}
              </Match>
            </Switch>
          </div>
        </Show>
      )}
    </Show>
  );
}

export function Dialog(p: {
  title: string;
  subtitle?: string;
  children: JSX.Element;
  footer?: JSX.Element;
  wide?: boolean;
}) {
  return (
    <div class="modal" classList={{ wide: p.wide }} role="dialog" aria-label={p.title}>
      <button class="icon-btn modal-close" aria-label={t('Close')} onClick={() => setUi('modal', null)}>
        <I.Close size={18} />
      </button>
      <h2>{p.title}</h2>
      <Show when={p.subtitle}>
        <p class="muted">{p.subtitle}</p>
      </Show>
      <div class="modal-body">{p.children}</div>
      <Show when={p.footer}>
        <div class="modal-footer">{p.footer}</div>
      </Show>
    </div>
  );
}

export function useSubmit() {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** Accepts a bare code or any URL ending in /invite/<code>. */
export function parseInvite(input: string): string | null {
  const s = input.trim();
  const m = s.match(/\/invite\/([A-Za-z0-9]+)\/?$/) ?? s.match(/^([A-Za-z0-9]{4,32})$/);
  return m ? m[1] : null;
}

const FOLDER_COLORS = [0x62d3d8, 0xdcb862, 0x5fb878, 0xe0574f, 0xb07ad8, 0x5b8def, 0xe08a4f, 0x8a9a92];

function FolderSettings(p: { folderId: string }) {
  const folder = () => railEntries().find((f) => f.id === p.folderId);
  const [name, setName] = createSignal(folder()?.name ?? '');
  const [color, setColor] = createSignal<number | null>(folder()?.color ?? FOLDER_COLORS[0]);
  const { busy, run } = useSubmit();
  const save = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      await updateFolder(p.folderId, { name: name().trim() || undefined, color: color() });
      setUi('modal', null);
    });
  };
  return (
    <Dialog title={t('Folder settings')}>
      <form class="stack" onSubmit={save}>
        <label class="field">
          <span>{t('Folder name')}</span>
          <input
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            maxLength={40}
            placeholder={t('Name your folder')}
            autofocus
          />
        </label>
        <div class="field">
          <span>{t('Folder color')}</span>
          <div class="swatches">
            <For each={FOLDER_COLORS}>
              {(c) => (
                <button
                  type="button"
                  class="swatch"
                  classList={{ on: color() === c }}
                  style={{ background: accentCss(c) }}
                  aria-label={accentCss(c)}
                  onClick={() => setColor(c)}
                />
              )}
            </For>
          </div>
        </div>
        <button class="btn primary" disabled={busy()}>
          {t('Done')}
        </button>
      </form>
    </Dialog>
  );
}

interface TemplatePreview {
  name: string;
  description: string;
  roles: { name: string; color: number | null }[];
  channels: { kind: number; name: string }[];
}

/** The code from a Discord template link (discord.new/…, discord.com/template/…). */
export function templateCode(input: string): string | null {
  const s = input.trim().replace(/\/+$/, '');
  const m = s.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:discord\.new|(?:ptb\.|canary\.)?discord(?:app)?\.com\/template)\/([A-Za-z0-9]+)$/,
  );
  return m ? m[1] : null;
}

function AddServer() {
  const [name, setName] = createSignal(t("{name}'s server", { name: displayName(state.me) }));
  const [nameEdited, setNameEdited] = createSignal(false);
  const [icon, setIcon] = createSignal<File | null>(null);
  const [link, setLink] = createSignal('');
  const [invite, setInvite] = createSignal('');
  const { busy, error, run } = useSubmit();
  const code = () => templateCode(link());
  const [template] = createResource(code, async (c) => {
    const tp = await api<TemplatePreview>('GET', `/guild-templates/${c}`);
    if (!nameEdited()) setName(tp.name);
    return tp;
  });
  const iconUrl = createMemo(() => {
    const f = icon();
    if (!f) return null;
    const url = URL.createObjectURL(f);
    onCleanup(() => URL.revokeObjectURL(url));
    return url;
  });
  const create = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      const g = await api<Guild>('POST', '/guilds', { name: name(), template: code() ?? undefined });
      addGuild(g);
      const f = icon();
      if (f) {
        const fd = new FormData();
        fd.append('file', f);
        // The server is made either way; a failed icon upload just leaves the initials.
        await api('POST', `/guilds/${g.id}/icon`, fd).catch((err) =>
          toast(err instanceof Error ? err.message : String(err)),
        );
      }
      setUi('modal', null);
      selectView(g.id);
    });
  };
  const join = (e: Event) => {
    e.preventDefault();
    const code = parseInvite(invite());
    if (!code) return toast(t('That does not look like an invite link'));
    setUi('modal', { type: 'join-invite', code });
  };
  return (
    <Dialog
      title={t('Start an adventure')}
      subtitle={t('Create a server for you and your friends, or join one with an invite.')}
    >
      <form class="stack" onSubmit={create}>
        <div class="icon-upload">
          <label class="upload-circle" title={t('Upload icon')}>
            <Show
              when={iconUrl()}
              fallback={
                <span class="upload-empty">
                  <I.AddImage size={22} />
                  <small>{t('Icon')}</small>
                </span>
              }
            >
              {(src) => <img src={src()} alt="" />}
            </Show>
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => setIcon(e.currentTarget.files?.[0] ?? null)}
            />
            <span class="upload-hint">{icon() ? t('Change') : t('Upload')}</span>
          </label>
          <label class="field grow">
            <span>{t('Server name')}</span>
            <input
              value={name()}
              onInput={(e) => {
                setName(e.currentTarget.value);
                setNameEdited(true);
              }}
              maxLength={100}
              autofocus
            />
          </label>
        </div>
        <label class="field">
          <span>{t('Discord template (optional)')}</span>
          <input value={link()} onInput={(e) => setLink(e.currentTarget.value)} placeholder="https://discord.new/…" />
        </label>
        <Show when={link().trim() && !code()}>
          <p class="error">{t('That does not look like a Discord template link')}</p>
        </Show>
        <Show when={code()}>
          <Show when={!template.loading} fallback={<p class="muted template-preview">{t('Loading template…')}</p>}>
            <Show when={!template.error} fallback={<p class="error">{template.error?.message}</p>}>
              <Show when={template()}>
                {(tp) => (
                  <div class="template-preview">
                    <strong>{tp().name}</strong>
                    <span class="muted">
                      {plural(
                        tp().channels.filter((c) => c.kind === Kind.Text).length,
                        '{n} text channel',
                        '{n} text channels',
                      )}{' '}
                      ·{' '}
                      {plural(
                        tp().channels.filter((c) => c.kind === Kind.Voice).length,
                        '{n} voice channel',
                        '{n} voice channels',
                      )}{' '}
                      · {plural(tp().roles.length, '{n} role', '{n} roles')}
                    </span>
                    <span class="muted small">{t("Per-channel permissions aren't copied.")}</span>
                  </div>
                )}
              </Show>
            </Show>
          </Show>
        </Show>
        <button class="btn primary" disabled={busy() || !name().trim() || (!!code() && !template())}>
          {busy() ? t('Creating…') : t('Create server')}
        </button>
      </form>
      <div class="divider">
        <span>{t('or')}</span>
      </div>
      <form class="stack" onSubmit={join}>
        <label class="field">
          <span>{t('Invite link')}</span>
          <input
            value={invite()}
            onInput={(e) => setInvite(e.currentTarget.value)}
            placeholder={`${serverUrl()}/invite/AbC123xY`}
          />
        </label>
        <button class="btn" disabled={!invite().trim()}>
          {t('Join server')}
        </button>
      </form>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </Dialog>
  );
}

function JoinInvite(p: { code: string }) {
  const [preview] = createResource(
    () => p.code,
    (code) => api<{ guild: GuildInfo; member_count: number; inviter: User }>('GET', `/invites/${code}`),
  );
  const { busy, error, run } = useSubmit();
  const accept = () =>
    run(async () => {
      const g = await api<Guild>('POST', `/invites/${p.code}`);
      addGuild(g);
      setUi('modal', null);
      selectView(g.id);
    });
  return (
    <Dialog title={t("You've been invited")}>
      <Show when={!preview.error} fallback={<p class="error">{t('This invite is invalid or has expired.')}</p>}>
        <Show when={preview()} fallback={<div class="spinner" />}>
          {(pv) => (
            <div class="invite-preview">
              <div class="invite-icon">
                <GuildIcon name={pv().guild.name} icon={pv().guild.icon} />
              </div>
              <div>
                <p class="muted small">{t('{name} invited you to join', { name: displayName(pv().inviter) })}</p>
                <h3>{pv().guild.name}</h3>
                <p class="muted small">{plural(pv().member_count, '{n} member', '{n} members')}</p>
              </div>
            </div>
          )}
        </Show>
        <button class="btn primary full" disabled={busy() || !preview()} onClick={accept}>
          {state.guilds[preview()?.guild.id ?? ''] ? t('Go to server') : t('Accept invite')}
        </button>
      </Show>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </Dialog>
  );
}

function Invite(p: { guildId: string }) {
  const [maxAge, setMaxAge] = createSignal(7 * 86400);
  const [invite] = createResource(maxAge, (age) =>
    api<{ code: string }>('POST', `/guilds/${p.guildId}/invites`, { max_age: age || null }),
  );
  const link = () => (invite() ? `${serverUrl()}/invite/${invite()!.code}` : '');
  const [filter, setFilter] = createSignal('');
  const [sent, setSent] = createSignal<string[]>([]);
  const friends = () =>
    Object.entries(state.relationships)
      .filter(([id, r]) => r === Rel.Friend && !state.members[p.guildId]?.[id])
      .map(([id]) => id)
      .filter(
        (id) =>
          !filter() || nameOf(id).toLowerCase().includes(filter()) || state.users[id]?.username.includes(filter()),
      )
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const copy = async () => {
    await navigator.clipboard.writeText(link());
    toast(t('Invite link copied'));
  };
  // Sends the link in your DM with them; the message shows as an invite card.
  const send = (id: string) =>
    attempt(async () => {
      const ch = await dmChannel(id);
      await sendMessage(ch.id, link());
      setSent((l) => [...l, id]);
    });
  return (
    <Dialog title={t('Invite friends to {server}', { server: state.guilds[p.guildId]?.name ?? '' })}>
      <input
        class="filter-input"
        placeholder={t('Search for friends')}
        value={filter()}
        onInput={(e) => setFilter(e.currentTarget.value.toLowerCase())}
      />
      <div class="invite-friends">
        <For
          each={friends()}
          fallback={
            <p class="empty-hint">{filter() ? t('No friends found.') : t('All your friends are already here.')}</p>
          }
        >
          {(id) => (
            <div class="invite-friend">
              <Avatar user={state.users[id]} size={32} presence />
              <span class="grow">
                <strong>{nameOf(id)}</strong> <span class="muted small">{state.users[id]?.username}</span>
              </span>
              <button
                class="btn small-btn"
                classList={{ primary: !sent().includes(id) }}
                disabled={!invite() || sent().includes(id)}
                onClick={() => void send(id)}
              >
                {sent().includes(id) ? t('Sent') : t('Invite')}
              </button>
            </div>
          )}
        </For>
      </div>
      <div class="field invite-link">
        <span>{t('Or, send a server invite link to a friend')}</span>
        <div class="copy-row">
          <input readOnly value={link() || t('Creating invite…')} onFocus={(e) => e.currentTarget.select()} />
          <button class="btn primary" disabled={!invite()} onClick={copy}>
            {t('Copy')}
          </button>
        </div>
      </div>
      <label class="field inline">
        <span>{t('Expires after')}</span>
        <select value={maxAge()} onChange={(e) => setMaxAge(+e.currentTarget.value)}>
          <option value={3600}>{t('1 hour')}</option>
          <option value={86400}>{t('1 day')}</option>
          <option value={7 * 86400}>{t('7 days')}</option>
          <option value={0}>{t('Never')}</option>
        </select>
      </label>
    </Dialog>
  );
}

function CreateChannel(p: { guildId: string; kind: 0 | 2 | 4; parentId?: string }) {
  const [kind, setKind] = createSignal<0 | 2 | 4>(p.kind);
  const [name, setName] = createSignal('');
  const { busy, error, run } = useSubmit();
  const category = () => (p.parentId ? state.channels[p.parentId] : undefined);
  const isCategory = p.kind === Kind.Category;
  const submit = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      const ch = await api<Channel>('POST', `/guilds/${p.guildId}/channels`, {
        name: name(),
        kind: kind(),
        parent_id: p.parentId,
      });
      setUi('modal', null);
      if (ch.kind === 0) selectChannel(ch.id);
    });
  };
  if (isCategory)
    return (
      <Dialog title={t('Create category')}>
        <form class="stack" onSubmit={submit}>
          <label class="field">
            <span>{t('Category name')}</span>
            <input
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              placeholder={t('New category')}
              maxLength={100}
              autofocus
            />
          </label>
          <Show when={error()}>
            <p class="error">{error()}</p>
          </Show>
          <button class="btn primary" disabled={busy() || !name().trim()}>
            {t('Create category')}
          </button>
        </form>
      </Dialog>
    );
  return (
    <Dialog
      title={t('Create channel')}
      subtitle={category() ? t('in {category}', { category: category()!.name }) : undefined}
    >
      <form class="stack" onSubmit={submit}>
        <div class="kind-picker">
          <button type="button" classList={{ active: kind() === 0 }} onClick={() => setKind(0)}>
            <I.Hash />{' '}
            <span>
              <strong>{t('Text')}</strong>
              <small>{t('Messages, images, emoji and banter')}</small>
            </span>
          </button>
          <button type="button" classList={{ active: kind() === 2 }} onClick={() => setKind(2)}>
            <I.Speaker />{' '}
            <span>
              <strong>{t('Voice')}</strong>
              <small>{t('Hang out with voice, video and screen share')}</small>
            </span>
          </button>
        </div>
        <label class="field">
          <span>{t('Channel name')}</span>
          <input
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder={kind() === 0 ? t('new-channel') : t('Hangout')}
            maxLength={100}
            autofocus
          />
        </label>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
        <button class="btn primary" disabled={busy() || !name().trim()}>
          {t('Create channel')}
        </button>
      </form>
    </Dialog>
  );
}

function Confirm(p: { title: string; body: string; action: string; run: () => Promise<unknown> }) {
  const { busy, error, run } = useSubmit();
  return (
    <Dialog
      title={p.title}
      footer={
        <>
          <button class="btn ghost" onClick={() => setUi('modal', null)}>
            {t('Cancel')}
          </button>
          <button
            class="btn danger"
            disabled={busy()}
            onClick={() =>
              run(async () => {
                await p.run();
                setUi('modal', null);
              })
            }
            autofocus
          >
            {p.action}
          </button>
        </>
      }
    >
      <p>{p.body}</p>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </Dialog>
  );
}

function ChannelSettings(p: { channelId: string }) {
  const ch = () => state.channels[p.channelId];
  const [name, setName] = createSignal(ch()?.name ?? '');
  const [topic, setTopic] = createSignal(ch()?.topic ?? '');
  const { busy, error, run } = useSubmit();
  const save = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      await api('PATCH', `/channels/${p.channelId}`, {
        name: name(),
        ...(ch()?.kind === Kind.Text ? { topic: topic() } : {}),
      });
      setUi('modal', null);
    });
  };
  return (
    <Dialog
      title={
        ch()?.kind === Kind.Thread
          ? t('Edit thread')
          : ch()?.kind === Kind.Category
            ? t('Edit category')
            : ch()?.kind === Kind.GroupDm
              ? t('Edit group')
              : t('Edit channel')
      }
    >
      <form class="stack" onSubmit={save}>
        <label class="field">
          <span>{t('Name')}</span>
          <input
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            maxLength={100}
            placeholder={ch()?.kind === Kind.GroupDm ? dmName({ ...ch()!, name: '' }) : undefined}
            autofocus
          />
        </label>
        <Show when={ch()?.kind === Kind.Text}>
          <label class="field">
            <span>{t('Topic')}</span>
            <textarea
              value={topic()}
              onInput={(e) => setTopic(e.currentTarget.value)}
              maxLength={1024}
              rows={3}
              placeholder={t('Let everyone know how to use this channel')}
            />
          </label>
        </Show>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
        <button class="btn primary" disabled={busy() || (!name().trim() && ch()?.kind !== Kind.GroupDm)}>
          {t('Save changes')}
        </button>
      </form>
    </Dialog>
  );
}

/** Pick friends for a new DM or group DM, or (with `channelId`) to add to an existing group. */
function CreateGroup(p: { channelId?: string }) {
  const group = () => (p.channelId ? state.channels[p.channelId] : undefined);
  const inGroup = () => new Set((group()?.recipients ?? []).map((u) => u.id));
  const friends = () =>
    Object.entries(state.relationships)
      .filter(([id, r]) => r === Rel.Friend && !inGroup().has(id))
      .map(([id]) => id)
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  // Group DMs hold 10 people, you included.
  const room = () => (group() ? 10 - (group()!.recipients?.length ?? 0) : 9);
  const [picked, setPicked] = createSignal<string[]>([]);
  const [filter, setFilter] = createSignal('');
  const { busy, error, run } = useSubmit();
  const toggle = (id: string) =>
    setPicked((l) => (l.includes(id) ? l.filter((x) => x !== id) : l.length < room() ? [...l, id] : l));
  return (
    <Dialog
      title={group() ? t('Add friends to {name}', { name: dmName(group()!) }) : t('Select friends')}
      subtitle={plural(room() - picked().length, 'You can add {n} more friend.', 'You can add {n} more friends.')}
      footer={
        <button
          class="btn primary"
          disabled={busy() || !picked().length}
          onClick={() =>
            run(async () => {
              const ids = picked();
              if (p.channelId) {
                for (const id of ids) await api('PUT', `/channels/${p.channelId}/recipients/${id}`);
              } else if (ids.length === 1) {
                const { openDm } = await import('../lib/actions');
                await openDm(ids[0]);
              } else await createGroupDm(ids);
              setUi('modal', null);
            })
          }
        >
          {p.channelId ? t('Add to Group') : picked().length > 1 ? t('Create Group DM') : t('Open DM')}
        </button>
      }
    >
      <input
        class="filter-input"
        placeholder={t('Type the username of a friend')}
        value={filter()}
        onInput={(e) => setFilter(e.currentTarget.value.toLowerCase())}
        autofocus
      />
      <div class="pick-list">
        <For
          each={friends().filter(
            (id) => nameOf(id).toLowerCase().includes(filter()) || state.users[id]?.username.includes(filter()),
          )}
          fallback={<p class="empty-hint">{t('Add some friends first.')}</p>}
        >
          {(id) => (
            <label class="pick-row">
              <Avatar user={state.users[id]} size={32} presence />
              <span class="grow">
                {nameOf(id)} <span class="muted small">{state.users[id]?.username}</span>
              </span>
              <input type="checkbox" checked={picked().includes(id)} onChange={() => toggle(id)} />
            </label>
          )}
        </For>
      </div>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </Dialog>
  );
}

/** Nickname for anyone you can manage, plus role assignment if you can manage roles. */
function MemberEditor(p: { guildId: string; userId: string }) {
  const member = () => state.members[p.guildId]?.[p.userId];
  const [nick, setNick] = createSignal(member()?.nickname ?? '');
  const [roles, setRoles] = createSignal<string[]>([...(member()?.roles ?? [])]);
  const { busy, error, run } = useSubmit();
  const self = () => p.userId === state.me?.id;
  const canNick = () => (self() ? can(p.guildId, P.CHANGE_NICKNAME) : can(p.guildId, P.MANAGE_NICKNAMES));
  const canRoles = () => can(p.guildId, P.MANAGE_ROLES);
  const assignable = () =>
    Object.values(state.roles[p.guildId] ?? {})
      .filter((r) => r.id !== p.guildId)
      .sort((a, b) => b.position - a.position);
  const editable = (pos: number) => pos < topPosition(p.guildId);
  const save = () =>
    run(async () => {
      if (self() && !canRoles()) await api('PATCH', `/guilds/${p.guildId}/members/@me`, { nickname: nick() });
      else {
        const body: Record<string, unknown> = {};
        if (canNick() && nick() !== (member()?.nickname ?? '')) body.nickname = nick();
        if (canRoles()) body.roles = roles();
        await api('PATCH', `/guilds/${p.guildId}/members/${p.userId}`, body);
      }
      setUi('modal', null);
      toast(t('Saved'));
    });
  return (
    <Dialog
      title={self() ? t('Server profile') : t('Edit {name}', { name: nameOf(p.userId, p.guildId) })}
      footer={
        <button class="btn primary" disabled={busy()} onClick={save}>
          {t('Save')}
        </button>
      }
    >
      <div class="stack">
        <Show when={canNick()}>
          <label class="field">
            <span>{t('Nickname')}</span>
            <input
              value={nick()}
              onInput={(e) => setNick(e.currentTarget.value)}
              maxLength={32}
              placeholder={state.users[p.userId]?.display_name ?? state.users[p.userId]?.username}
            />
          </label>
        </Show>
        <Show when={canRoles() && assignable().length}>
          <div class="field">
            <span>{t('Roles')}</span>
            <div class="pick-list short">
              <For each={assignable()}>
                {(r) => (
                  <label class="pick-row" classList={{ disabled: !editable(r.position) }}>
                    <i class="role-dot" style={{ background: accentCss(r.color) ?? 'var(--text-3)' }} />
                    <span class="grow">{r.name}</span>
                    <input
                      type="checkbox"
                      disabled={!editable(r.position)}
                      checked={roles().includes(r.id)}
                      onChange={() => setRoles((l) => (l.includes(r.id) ? l.filter((x) => x !== r.id) : [...l, r.id]))}
                    />
                  </label>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
      </div>
    </Dialog>
  );
}

/** Like Discord's "Go Live" dialog: pick quality before choosing what to share. */
function GoLive(p: { update: boolean; switchSource: boolean }) {
  const initial = (p.update && voiceUi.streamQuality) || prefs.screenQuality;
  const [height, setHeight] = createSignal<StreamQuality['height']>(initial.height);
  const [fps, setFps] = createSignal<StreamQuality['fps']>(initial.fps);
  const [optimize, setOptimize] = createSignal<StreamQuality['optimize']>(initial.optimize);
  const [audio, setAudio] = createSignal(initial.audio);
  const quality = (): StreamQuality => ({ height: height(), fps: fps(), optimize: optimize(), audio: audio() });
  // Desktop app on Windows: pick what to share right here instead of the system picker.
  const picker = nativeCaptureAvailable && (!p.update || p.switchSource);
  const [sources, { refetch }] = createResource(() =>
    picker ? listCaptureSources().catch(() => [] as CaptureSource[]) : Promise.resolve([] as CaptureSource[]),
  );
  const [caps] = createResource(captureCapabilities);
  const [tab, setTab] = createSignal<'window' | 'screen'>('window');
  const [selected, setSelected] = createSignal<CaptureSource | null>(null);
  const shown = () => (sources() ?? []).filter((x) => x.kind === tab());
  const go = () => {
    setUi('modal', null);
    if (p.switchSource) return void switchScreenSource(selected()?.id);
    void (p.update ? updateStreamQuality(quality()) : startScreenShare(quality(), selected()?.id));
  };
  const Seg = <T,>(props: { value: T; options: [T, string, string?][]; onChange: (v: T) => void }) => (
    <div class="seg">
      <For each={props.options}>
        {([v, label, hint]) => (
          <button classList={{ active: props.value === v }} title={hint} onClick={() => props.onChange(v)}>
            {label}
          </button>
        )}
      </For>
    </div>
  );
  return (
    <Dialog
      title={p.switchSource ? t('Switch what you share') : p.update ? t('Stream quality') : t('Share your screen')}
      subtitle={
        p.switchSource
          ? t('Your stream keeps going; viewers see the new source right away.')
          : p.update
            ? t('Changes apply right away.')
            : t('Pick the quality, then choose a screen, window or tab.')
      }
      footer={
        <>
          <button class="btn ghost" onClick={() => setUi('modal', null)}>
            {t('Cancel')}
          </button>
          <button class="btn primary" disabled={picker && !selected() && !!sources()?.length} onClick={go}>
            {p.switchSource ? t('Switch') : p.update ? t('Apply') : t('Go Live')}
          </button>
        </>
      }
    >
      <div class="stack go-live">
        <Show when={picker}>
          <div class="source-picker">
            <div class="picker-tabs">
              <button classList={{ active: tab() === 'window' }} onClick={() => setTab('window')}>
                {t('Applications')}
              </button>
              <button classList={{ active: tab() === 'screen' }} onClick={() => setTab('screen')}>
                {t('Screens')}
              </button>
              <span class="grow" />
              <button class="icon-btn tiny" aria-label={t('Refresh')} title={t('Refresh')} onClick={() => refetch()}>
                ↻
              </button>
            </div>
            <Show
              when={!sources.loading}
              fallback={
                <div class="source-loading">
                  <div class="spinner" />
                </div>
              }
            >
              <div class="source-grid">
                <For
                  each={shown()}
                  fallback={
                    <p class="empty-hint">
                      {t('Nothing to share here. Open the app you want to stream, then refresh.')}
                    </p>
                  }
                >
                  {(src) => (
                    <button
                      class="source-card"
                      classList={{ selected: selected()?.id === src.id }}
                      onClick={() => setSelected(src)}
                      onDblClick={() => (setSelected(src), go())}
                    >
                      <div class="source-thumb">
                        <Show when={src.thumbnail} fallback={<I.Screen size={32} />}>
                          <img src={src.thumbnail!} alt="" />
                        </Show>
                      </div>
                      <span class="source-name" title={src.name}>
                        {src.name}
                      </span>
                      <Show when={src.app}>
                        <span class="source-app">{src.app}</span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
        <Show when={!p.switchSource}>
          <div class="quality-row">
            <div class="field">
              <span>{t('Resolution')}</span>
              <Seg
                value={height()}
                options={[
                  [720, '720p'],
                  [1080, '1080p'],
                ]}
                onChange={setHeight}
              />
            </div>
            <div class="field">
              <span>{t('Frame rate')}</span>
              <Seg
                value={fps()}
                options={[
                  [15, '15 fps'],
                  [30, '30 fps'],
                  [60, '60 fps'],
                ]}
                onChange={setFps}
              />
            </div>
            <div class="field">
              <span>{t('Optimize for')}</span>
              <Seg
                value={optimize()}
                options={[
                  ['clarity', t('Clarity'), t('Sharp text, code and slides')],
                  ['motion', t('Motion'), t('Smooth games and video')],
                ]}
                onChange={setOptimize}
              />
            </div>
          </div>
          <label class="toggle-row" classList={{ disabled: p.update }}>
            <span>
              <strong>{t('Share audio')}</strong>
              <small>
                {p.update
                  ? t('Restart the stream to change this.')
                  : !picker
                    ? t('Sound from the tab or your whole screen. Tick "Share audio" in the picker too.')
                    : caps() && !caps()!.per_app_audio
                      ? t(
                          'Windows 10 shares all PC sound (Linkord removes the voice chat from it, so nobody hears themselves). Windows 11 can share just the app.',
                        )
                      : selected()?.kind === 'screen'
                        ? t('Everything you hear except Linkord, so nobody hears the voice chat echoed.')
                        : t('Only the sound of the app you share.')}
              </small>
            </span>
            <input
              type="checkbox"
              class="switch"
              checked={audio()}
              disabled={p.update}
              onChange={(e) => setAudio(e.currentTarget.checked)}
            />
          </label>
        </Show>
      </div>
    </Dialog>
  );
}
