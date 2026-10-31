// Server settings, full window like user settings (Discord's layout): Overview, Roles, Emoji,
// Members and Invites, with an unsaved-changes bar for the forms.
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from 'solid-js';
import { api, emojiUrl, media } from '../lib/api';
import { dateLocale, msg, plural, t } from '../lib/i18n';
import { can, hasBit, P, PERM_INFO, topPosition } from '../lib/perms';
import { isMobile } from '../lib/ui';
import { nameColor, nameOf, state } from '../lib/store';
import type { Role, User } from '../lib/types';
import { Kind } from '../lib/types';
import { attempt, setUi, toast } from '../lib/ui';
import { Avatar, GuildIcon } from './Avatar';
import { ColorPicker } from './ColorPicker';
import * as I from './Icons';
import { useSubmit } from './Modals';
import { SoundboardSettings } from './Soundboard';
import { accentCss, canAssign, MemberRoles } from './Profile';

function Toggle(p: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label class="toggle-row" classList={{ disabled: p.disabled }}>
      <span>
        <strong>{p.label}</strong>
        <Show when={p.hint}>
          <small>{p.hint}</small>
        </Show>
      </span>
      <input
        type="checkbox"
        class="switch"
        checked={p.checked}
        disabled={p.disabled}
        onChange={(e) => p.onChange(e.currentTarget.checked)}
      />
    </label>
  );
}

/** Discord's "Careful — you have unsaved changes!" bar at the bottom of a settings page. */
function SaveBar(p: { show: boolean; busy?: boolean; onReset: () => void; onSave: () => void }) {
  return (
    <Show when={p.show}>
      <div class="save-bar">
        <span>{t('Careful — you have unsaved changes!')}</span>
        <button class="link-btn" onClick={p.onReset}>
          {t('Reset')}
        </button>
        <button class="btn primary small-btn" disabled={p.busy} onClick={p.onSave}>
          {t('Save Changes')}
        </button>
      </div>
    </Show>
  );
}

type Page = 'overview' | 'roles' | 'emoji' | 'soundboard' | 'members' | 'invites';

export function ServerSettings(p: { guildId: string; tab?: string }) {
  const g = () => state.guilds[p.guildId];
  const pages = (): [Page, string, number, (p: { size?: number }) => JSX.Element][] =>
    (
      [
        ['overview', t('Overview'), P.MANAGE_GUILD, I.Gear],
        ['roles', t('Roles'), P.MANAGE_ROLES, I.Users],
        ['emoji', t('Emoji'), P.MANAGE_EMOJIS, I.Smile],
        ['soundboard', t('Soundboard'), P.MANAGE_EMOJIS, I.Music],
        ['members', t('Members'), P.KICK_MEMBERS, I.Account],
        ['invites', t('Invites'), P.MANAGE_GUILD, I.Link],
      ] as [Page, string, number, (p: { size?: number }) => JSX.Element][]
    ).filter(([, , perm]) => can(p.guildId, perm) || (perm === P.KICK_MEMBERS && can(p.guildId, P.MANAGE_ROLES)));
  const [page, setPage] = createSignal<Page>((p.tab as Page) ?? pages()[0]?.[0] ?? 'overview');
  const [navOpen, setNavOpen] = createSignal(isMobile() && !p.tab);
  const open = (id: Page) => {
    setPage(id);
    setNavOpen(false);
  };
  const close = () => setUi('modal', null);
  const onKey = (e: KeyboardEvent) =>
    e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.context-menu') && close();
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));
  // Leaving or deleting the server closes its settings.
  createEffect(() => !g() && close());
  const title = () => pages().find(([id]) => id === page())?.[1] ?? '';
  return (
    <Show when={g()}>
      <div
        class="settings-screen"
        classList={{ 'nav-open': navOpen() }}
        role="dialog"
        aria-label={t('Server settings')}
      >
        <aside class="settings-side">
          <nav class="settings-nav">
            <div class="settings-group server-group">
              <span class="settings-server-icon">
                <GuildIcon name={g()!.name} icon={g()!.icon} />
              </span>
              <span>{g()!.name}</span>
            </div>
            <For each={pages()}>
              {([id, label, , Icon]) => (
                <button classList={{ active: page() === id && !navOpen() }} onClick={() => open(id)}>
                  <Icon size={18} />
                  {label}
                </button>
              )}
            </For>
          </nav>
          <Show when={g()!.owner_id === state.me?.id}>
            <div class="settings-foot">
              <button
                class="settings-logout"
                onClick={() =>
                  setUi('modal', {
                    type: 'confirm',
                    title: t('Delete {name}', { name: g()!.name }),
                    body: t('This permanently deletes the server, its channels and all messages.'),
                    action: t('Delete server'),
                    run: () => api('DELETE', `/guilds/${p.guildId}`),
                  })
                }
              >
                <I.Trash size={17} /> {t('Delete Server')}
              </button>
            </div>
          </Show>
        </aside>
        <main class="settings-main">
          <div class="settings-content" classList={{ wide: page() === 'roles' || page() === 'members' }}>
            <h1>
              <button class="icon-btn settings-back" aria-label={t('All settings')} onClick={() => setNavOpen(true)}>
                <I.Back size={22} />
              </button>
              {title()}
            </h1>
            <Switch>
              <Match when={page() === 'overview'}>
                <OverviewPage guildId={p.guildId} />
              </Match>
              <Match when={page() === 'roles'}>
                <RolesPage guildId={p.guildId} />
              </Match>
              <Match when={page() === 'emoji'}>
                <EmojiPage guildId={p.guildId} />
              </Match>
              <Match when={page() === 'soundboard'}>
                <SoundboardSettings guildId={p.guildId} />
              </Match>
              <Match when={page() === 'members'}>
                <MembersPage guildId={p.guildId} />
              </Match>
              <Match when={page() === 'invites'}>
                <InvitesPage guildId={p.guildId} />
              </Match>
            </Switch>
          </div>
        </main>
        <button class="settings-close" onClick={close} aria-label={t('Close settings')}>
          <span>
            <I.Close size={18} />
          </span>
          ESC
        </button>
      </div>
    </Show>
  );
}

// ---------- overview ----------

function OverviewPage(p: { guildId: string }) {
  const g = () => state.guilds[p.guildId];
  const [name, setName] = createSignal(g()?.name ?? '');
  const { busy, error, run } = useSubmit();
  const uploadIcon = (file?: File) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    void run(() => api('POST', `/guilds/${p.guildId}/icon`, fd));
  };
  const dirty = () => name().trim() !== g()?.name;
  return (
    <div class="stack">
      <div class="overview-card">
        <label class="upload-circle" title={t('Upload icon')}>
          <GuildIcon name={g()?.name ?? ''} icon={g()?.icon} />
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => uploadIcon(e.currentTarget.files?.[0])}
          />
          <span class="upload-hint">{t('Change')}</span>
        </label>
        <div class="stack grow">
          <p class="muted small">{t('We recommend an image of at least 512×512 for the server.')}</p>
          <label class="field">
            <span>{t('Server name')}</span>
            <input value={name()} onInput={(e) => setName(e.currentTarget.value)} maxLength={100} />
          </label>
        </div>
      </div>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
      <ServerBanner guildId={p.guildId} />
      <SystemAndAfk guildId={p.guildId} />
      <SaveBar
        show={dirty()}
        busy={busy()}
        onReset={() => setName(g()?.name ?? '')}
        onSave={() =>
          void run(async () => (await api('PATCH', `/guilds/${p.guildId}`, { name: name() }), toast(t('Saved'))))
        }
      />
    </div>
  );
}

/** The picture at the top of the channel list, with the same fade the sidebar draws over it. */
function ServerBanner(p: { guildId: string }) {
  const g = () => state.guilds[p.guildId];
  const { busy, error, run } = useSubmit();
  const upload = (file?: File) => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    void run(() => api('POST', `/guilds/${p.guildId}/banner`, fd));
  };
  return (
    <section class="set-section">
      <h2>{t('Server banner')}</h2>
      <p class="muted small">
        {t('Shown at the top of the channel list, behind the server name. Wide pictures work best (at least 960×540).')}
      </p>
      <div class="banner-setting">
        <div
          class="banner-preview"
          style={{ 'background-image': g()?.banner ? `url(${media(g()!.banner)})` : undefined }}
        >
          <span>{g()?.name}</span>
        </div>
        <div class="banner-actions">
          <label class="btn primary small-btn" classList={{ disabled: busy() }}>
            {g()?.banner ? t('Change banner') : t('Upload banner')}
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => upload(e.currentTarget.files?.[0])}
            />
          </label>
          <Show when={g()?.banner}>
            <button class="link-btn" onClick={() => void run(() => api('DELETE', `/guilds/${p.guildId}/banner`))}>
              {t('Remove')}
            </button>
          </Show>
        </div>
      </div>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </section>
  );
}

const AFK_TIMEOUTS: [number, string][] = [
  [60, msg('1 minute')],
  [300, msg('5 minutes')],
  [900, msg('15 minutes')],
  [1800, msg('30 minutes')],
  [3600, msg('1 hour')],
];

/** Join messages (where they go) and the AFK channel, saved as soon as they change. */
function SystemAndAfk(p: { guildId: string }) {
  const g = () => state.guilds[p.guildId];
  const channels = (kind: Kind) =>
    Object.values(state.channels)
      .filter((c) => c.guild_id === p.guildId && c.kind === kind)
      .sort((a, b) => a.position - b.position);
  const save = (patch: Record<string, unknown>) =>
    attempt(() => api('PATCH', `/guilds/${p.guildId}`, patch), t('Saved'));
  return (
    <>
      <section class="set-section">
        <h2>{t('System messages')}</h2>
        <Toggle
          label={t('Send a message when someone joins this server')}
          checked={g()?.join_messages ?? true}
          onChange={(v) => void save({ join_messages: v })}
        />
        <label class="field">
          <span>{t('Channel for system messages')}</span>
          <select
            value={g()?.system_channel_id ?? ''}
            disabled={g()?.join_messages === false}
            onChange={(e) => void save({ system_channel_id: e.currentTarget.value || null })}
          >
            <option value="">{t('First text channel (default)')}</option>
            <For each={channels(Kind.Text)}>{(c) => <option value={c.id}>#{c.name}</option>}</For>
          </select>
        </label>
      </section>
      <section class="set-section">
        <h2>{t('AFK channel')}</h2>
        <p class="muted small">
          {t("People who haven't talked for a while are moved to this voice channel. Off by default.")}
        </p>
        <div class="row-fields">
          <label class="field grow">
            <span>{t('AFK channel')}</span>
            <select
              value={g()?.afk_channel_id ?? ''}
              onChange={(e) => void save({ afk_channel_id: e.currentTarget.value || null })}
            >
              <option value="">{t('No AFK channel')}</option>
              <For each={channels(Kind.Voice)}>{(c) => <option value={c.id}>{c.name}</option>}</For>
            </select>
          </label>
          <label class="field">
            <span>{t('AFK timeout')}</span>
            <select
              value={String(g()?.afk_timeout ?? 300)}
              disabled={!g()?.afk_channel_id}
              onChange={(e) => void save({ afk_timeout: Number(e.currentTarget.value) })}
            >
              <For each={AFK_TIMEOUTS}>{([secs, label]) => <option value={secs}>{t(label)}</option>}</For>
            </select>
          </label>
        </div>
      </section>
    </>
  );
}

// ---------- roles ----------

const ROLE_COLORS = [
  0x62d3d8, 0x5fb878, 0x5b8def, 0xb07ad8, 0xe06c9f, 0xdcb862, 0xe08a4f, 0xe0574f, 0x8a9a92, 0x4e6b5f,
];

function RolesPage(p: { guildId: string }) {
  const roles = () =>
    Object.values(state.roles[p.guildId] ?? {})
      .filter((r) => r.id !== p.guildId)
      .sort((a, b) => b.position - a.position);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [filter, setFilter] = createSignal('');
  const role = () => (selected() ? state.roles[p.guildId]?.[selected()!] : undefined);
  const memberCount = (rid: string) =>
    Object.values(state.members[p.guildId] ?? {}).filter((m) => m.roles.includes(rid)).length;
  const canReorder = () => can(p.guildId, P.ADMINISTRATOR);

  const create = () =>
    attempt(async () =>
      setSelected((await api<Role>('POST', `/guilds/${p.guildId}/roles`, { name: t('new role') })).id),
    );

  // Drag roles to reorder them (Administrator).
  const [dragging, setDragging] = createSignal<string | null>(null);
  const [over, setOver] = createSignal<{ id: string; before: boolean } | null>(null);
  const dropRole = () => {
    const from = dragging();
    const to = over();
    setDragging(null);
    setOver(null);
    if (!from || !to || from === to.id) return;
    const ids = roles()
      .map((r) => r.id)
      .filter((id) => id !== from);
    ids.splice(ids.indexOf(to.id) + (to.before ? 0 : 1), 0, from);
    void attempt(() => api('PUT', `/guilds/${p.guildId}/roles`, { ids }));
  };

  const list = () => roles().filter((r) => r.name.toLowerCase().includes(filter()));

  return (
    <Show
      when={selected() && (role() || selected() === p.guildId)}
      fallback={
        <div class="stack">
          <p class="set-desc">
            {t(
              'Use roles to group your members and give them permissions. Members get the permissions of all their roles.',
            )}
          </p>
          <button class="everyone-card" onClick={() => setSelected(p.guildId)}>
            <span class="everyone-icon">
              <I.Users size={20} />
            </span>
            <span class="grow">
              <strong>{t('Default Permissions')}</strong>
              <span class="muted small">{t('@everyone · applies to all server members')}</span>
            </span>
            <I.Chevron size={16} class="chev-right" />
          </button>
          <div class="row">
            <input
              class="filter-input grow"
              placeholder={t('Search roles')}
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value.toLowerCase())}
            />
            <button class="btn primary" onClick={() => void create()}>
              {t('Create Role')}
            </button>
          </div>
          <Show when={canReorder() && roles().length > 1}>
            <p class="muted small">{t('Members use the color of their highest role. Drag roles to reorder them.')}</p>
          </Show>
          <div class="role-table">
            <div class="role-table-head">
              <span>{plural(roles().length, '{n} role', '{n} roles')}</span>
              <span>{t('Members')}</span>
            </div>
            <For each={list()} fallback={<p class="empty-hint">{t('No roles yet.')}</p>}>
              {(r) => (
                <button
                  class="role-table-row"
                  draggable={canReorder() && !filter()}
                  classList={{
                    dragging: dragging() === r.id,
                    'drop-before': over()?.id === r.id && over()!.before,
                    'drop-after': over()?.id === r.id && !over()!.before,
                  }}
                  onDragStart={(e) => {
                    setDragging(r.id);
                    e.dataTransfer!.effectAllowed = 'move';
                  }}
                  onDragOver={(e) => {
                    if (!dragging()) return;
                    e.preventDefault();
                    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setOver({ id: r.id, before: e.clientY < b.top + b.height / 2 });
                  }}
                  onDrop={(e) => (e.preventDefault(), dropRole())}
                  onDragEnd={() => (setDragging(null), setOver(null))}
                  onClick={() => setSelected(r.id)}
                >
                  <Show when={canReorder()}>
                    <span class="drag-handle">⋮⋮</span>
                  </Show>
                  <i class="role-dot big" style={{ background: accentCss(r.color) ?? 'var(--text-3)' }} />
                  <span class="grow role-table-name" style={{ color: accentCss(r.color) }}>
                    {r.name}
                  </span>
                  <span class="role-table-count">
                    {memberCount(r.id)} <I.Account size={15} />
                  </span>
                  <I.Chevron size={16} class="chev-right" />
                </button>
              )}
            </For>
          </div>
        </div>
      }
    >
      <div class="role-split">
        <div class="role-side">
          <button class="link-btn role-back" onClick={() => setSelected(null)}>
            <I.Back size={16} /> {t('Back')}
          </button>
          <button
            class="role-side-row"
            classList={{ active: selected() === p.guildId }}
            onClick={() => setSelected(p.guildId)}
          >
            <i class="role-dot" style={{ background: 'var(--text-3)' }} />
            @everyone
          </button>
          <For each={roles()}>
            {(r) => (
              <button
                class="role-side-row"
                classList={{ active: selected() === r.id }}
                onClick={() => setSelected(r.id)}
              >
                <i class="role-dot" style={{ background: accentCss(r.color) ?? 'var(--text-3)' }} />
                <span class="grow">{r.name}</span>
              </button>
            )}
          </For>
          <button class="role-side-row add" onClick={() => void create()}>
            <I.Plus size={14} /> {t('Create Role')}
          </button>
        </div>
        <Show when={state.roles[p.guildId]?.[selected()!]} keyed>
          {(r) => <RoleEditor guildId={p.guildId} role={r} onDeleted={() => setSelected(null)} />}
        </Show>
      </div>
    </Show>
  );
}

function RoleEditor(p: { guildId: string; role: Role; onDeleted: () => void }) {
  const everyone = p.role.id === p.guildId;
  const editable = everyone ? can(p.guildId, P.MANAGE_ROLES) : p.role.position < topPosition(p.guildId);
  const [tab, setTab] = createSignal<'display' | 'permissions' | 'members'>(everyone ? 'permissions' : 'display');
  const initial = () => ({
    name: p.role.name,
    color: p.role.color ?? null,
    hoist: p.role.hoist,
    mentionable: p.role.mentionable,
    permissions: p.role.permissions,
  });
  const [draft, setDraft] = createSignal(initial());
  const set = <K extends keyof ReturnType<typeof initial>>(k: K, v: ReturnType<typeof initial>[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const dirty = createMemo(() => JSON.stringify(draft()) !== JSON.stringify(initial()));
  const { busy, error, run } = useSubmit();
  const canGrant = (bit: number) => can(p.guildId, P.ADMINISTRATOR) || can(p.guildId, bit);
  const [permFilter, setPermFilter] = createSignal('');
  const save = () =>
    run(async () => {
      await api(
        'PATCH',
        `/guilds/${p.guildId}/roles/${p.role.id}`,
        everyone ? { permissions: draft().permissions } : draft(),
      );
      toast(t('Role saved'));
    });
  const holders = () =>
    Object.keys(state.members[p.guildId] ?? {}).filter((id) => state.members[p.guildId][id].roles.includes(p.role.id));
  const addMembers = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const others = Object.keys(state.members[p.guildId] ?? {})
      .filter((id) => !state.members[p.guildId][id].roles.includes(p.role.id))
      .sort((a, b) => nameOf(a, p.guildId).localeCompare(nameOf(b, p.guildId)));
    setUi('menu', {
      x: r.left,
      y: r.bottom + 4,
      items: others.length
        ? others.map((id) => ({
            label: nameOf(id, p.guildId),
            icon: () => <Avatar user={state.users[id]} size={20} />,
            run: () =>
              attempt(() =>
                api('PATCH', `/guilds/${p.guildId}/members/${id}`, {
                  roles: [...state.members[p.guildId][id].roles, p.role.id],
                }),
              ),
          }))
        : [{ label: t('Everyone already has this role'), disabled: true }],
    });
  };
  const removeMember = (id: string) =>
    attempt(() =>
      api('PATCH', `/guilds/${p.guildId}/members/${id}`, {
        roles: state.members[p.guildId][id].roles.filter((x) => x !== p.role.id),
      }),
    );

  return (
    <div class="role-editor">
      <div class="role-editor-head">
        <h2>
          {t('Edit role')} —{' '}
          <span style={{ color: accentCss(draft().color) }}>{everyone ? '@everyone' : draft().name}</span>
        </h2>
        <Show when={!everyone && editable}>
          <button
            class="icon-btn danger"
            aria-label={t('Delete role')}
            data-tip={t('Delete role')}
            onClick={() =>
              setUi('menu', {
                x: innerWidth / 2,
                y: innerHeight / 3,
                items: [
                  {
                    label: t('Delete {name}', { name: p.role.name }),
                    danger: true,
                    icon: () => <I.Trash size={16} />,
                    run: () =>
                      attempt(
                        async () => (await api('DELETE', `/guilds/${p.guildId}/roles/${p.role.id}`), p.onDeleted()),
                        t('Role deleted'),
                      ),
                  },
                ],
              })
            }
          >
            <I.Trash size={18} />
          </button>
        </Show>
      </div>
      <Show when={!editable}>
        <p class="notice">{t('You can only edit roles below your highest role.')}</p>
      </Show>
      <nav class="profile-tabs role-tabs">
        <Show when={!everyone}>
          <button classList={{ active: tab() === 'display' }} onClick={() => setTab('display')}>
            {t('Display')}
          </button>
        </Show>
        <button classList={{ active: tab() === 'permissions' }} onClick={() => setTab('permissions')}>
          {t('Permissions')}
        </button>
        <Show when={!everyone}>
          <button classList={{ active: tab() === 'members' }} onClick={() => setTab('members')}>
            {t('Manage Members ({n})', { n: holders().length })}
          </button>
        </Show>
      </nav>
      <Switch>
        <Match when={tab() === 'display'}>
          <div class="stack">
            <label class="field">
              <span>{t('Role name')}</span>
              <input
                value={draft().name}
                disabled={!editable}
                onInput={(e) => set('name', e.currentTarget.value)}
                maxLength={100}
              />
            </label>
            <div class="field">
              <span>{t('Role color')}</span>
              <p class="muted small">{t('Members use the color of the highest role they have.')}</p>
              <div class="role-colors">
                <button
                  class="role-color none"
                  classList={{ on: draft().color == null }}
                  disabled={!editable}
                  title={t('Default')}
                  onClick={() => set('color', null)}
                />
                <For each={ROLE_COLORS}>
                  {(c) => (
                    <button
                      class="role-color"
                      classList={{ on: draft().color === c }}
                      style={{ background: accentCss(c) }}
                      disabled={!editable}
                      aria-label={accentCss(c)}
                      onClick={() => set('color', c)}
                    />
                  )}
                </For>
                <Show when={editable}>
                  <ColorPicker
                    value={accentCss(draft().color) ?? '#99aab5'}
                    onChange={(hex) => set('color', parseInt(hex.slice(1), 16))}
                    label={t('Custom color')}
                  />
                </Show>
              </div>
            </div>
            <div class="role-preview">
              <Avatar user={state.me} size={36} />
              <div>
                <strong style={{ color: accentCss(draft().color) }}>{nameOf(state.me!.id, p.guildId)}</strong>
                <div class="muted small">{t('This is how names with this role look in chat.')}</div>
              </div>
            </div>
            <Toggle
              label={t('Display role members separately')}
              hint={t('Members with this role get their own group in the member list.')}
              checked={draft().hoist}
              onChange={(v) => set('hoist', v)}
              disabled={!editable}
            />
            <Toggle
              label={t('Allow anyone to @mention this role')}
              checked={draft().mentionable}
              onChange={(v) => set('mentionable', v)}
              disabled={!editable}
            />
          </div>
        </Match>
        <Match when={tab() === 'permissions'}>
          <div class="stack">
            <Show when={everyone}>
              <p class="muted small">{t('@everyone applies to every member of the server.')}</p>
            </Show>
            <div class="row">
              <input
                class="filter-input grow"
                placeholder={t('Search permissions')}
                value={permFilter()}
                onInput={(e) => setPermFilter(e.currentTarget.value.toLowerCase())}
              />
              <Show when={editable}>
                <button class="link-btn" onClick={() => set('permissions', 0)}>
                  {t('Clear permissions')}
                </button>
              </Show>
            </div>
            <For each={PERM_INFO}>
              {(g) => {
                const items = () =>
                  g.items.filter(
                    ([, label, hint]) =>
                      !permFilter() || `${t(label)} ${hint && t(hint)}`.toLowerCase().includes(permFilter()),
                  );
                return (
                  <Show when={items().length}>
                    <div class="perm-group">
                      <div class="group-title">{t('{group} permissions', { group: t(g.group) })}</div>
                      <For each={items()}>
                        {([key, label, hint]) => (
                          <Toggle
                            label={t(label)}
                            hint={hint && t(hint)}
                            checked={hasBit(draft().permissions, P[key])}
                            disabled={!editable || !canGrant(P[key])}
                            onChange={() =>
                              set(
                                'permissions',
                                hasBit(draft().permissions, P[key])
                                  ? draft().permissions - P[key]
                                  : draft().permissions + P[key],
                              )
                            }
                          />
                        )}
                      </For>
                    </div>
                  </Show>
                );
              }}
            </For>
          </div>
        </Match>
        <Match when={tab() === 'members'}>
          <div class="stack">
            <Show when={canAssign(p.guildId, p.role.id)}>
              <button class="btn primary self-start" onClick={addMembers}>
                <I.UserPlus size={16} /> {t('Add Members')}
              </button>
            </Show>
            <div class="member-admin">
              <For each={holders()} fallback={<p class="empty-hint">{t('No members have this role yet.')}</p>}>
                {(id) => (
                  <div class="member-admin-row">
                    <Avatar user={state.users[id]} size={32} />
                    <span class="grow">
                      <strong style={{ color: nameColor(p.guildId, id) }}>{nameOf(id, p.guildId)}</strong>{' '}
                      <span class="muted small">{state.users[id]?.username}</span>
                    </span>
                    <Show when={canAssign(p.guildId, p.role.id)}>
                      <button
                        class="icon-btn"
                        aria-label={t('Remove member')}
                        data-tip={t('Remove member')}
                        onClick={() => void removeMember(id)}
                      >
                        <I.Close size={16} />
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Match>
      </Switch>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
      <SaveBar show={dirty() && editable} busy={busy()} onReset={() => setDraft(initial())} onSave={save} />
    </div>
  );
}

// ---------- emoji ----------

function EmojiPage(p: { guildId: string }) {
  const [name, setName] = createSignal('');
  const [file, setFile] = createSignal<File | null>(null);
  const { busy, error, run } = useSubmit();
  const list = () => state.emojis[p.guildId] ?? [];
  const upload = () =>
    run(async () => {
      const fd = new FormData();
      fd.append(
        'name',
        name() ||
          file()!
            .name.replace(/\.\w+$/, '')
            .replace(/[^\w]/g, '_'),
      );
      fd.append('file', file()!);
      await api('POST', `/guilds/${p.guildId}/emojis`, fd);
      setName('');
      setFile(null);
    });
  return (
    <div class="stack">
      <p class="muted small">
        {t(
          'Add up to 100 custom emoji anyone in this server can use. PNG, GIF or WebP, up to 256 KB. Animated GIFs stay animated.',
        )}
      </p>
      <div class="row">
        <label class="btn">
          {file() ? file()!.name : t('Choose image')}
          <input
            type="file"
            accept="image/png,image/gif,image/webp,image/jpeg"
            hidden
            onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)}
          />
        </label>
        <input
          class="inline-input"
          placeholder={t('emoji_name')}
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          maxLength={32}
        />
        <button class="btn primary" disabled={busy() || !file()} onClick={upload}>
          {t('Upload')}
        </button>
      </div>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
      <div class="emoji-admin">
        <For each={list()} fallback={<p class="empty-hint">{t('No custom emoji yet.')}</p>}>
          {(e) => (
            <div class="emoji-admin-row">
              <img class="emoji custom" src={emojiUrl(e.id, e.animated)} alt="" />
              <code>:{e.name}:</code>
              <span class="grow" />
              <button
                class="icon-btn danger"
                aria-label={t('Delete')}
                onClick={() => void attempt(() => api('DELETE', `/guilds/${p.guildId}/emojis/${e.id}`))}
              >
                <I.Trash size={16} />
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

// ---------- members ----------

function MembersPage(p: { guildId: string }) {
  const [filter, setFilter] = createSignal('');
  const ids = () =>
    Object.keys(state.members[p.guildId] ?? {})
      .filter(
        (id) => nameOf(id, p.guildId).toLowerCase().includes(filter()) || state.users[id]?.username.includes(filter()),
      )
      .sort((a, b) => nameOf(a, p.guildId).localeCompare(nameOf(b, p.guildId)));
  const joined = (id: string) =>
    new Date(state.members[p.guildId][id].joined_at).toLocaleDateString(dateLocale(), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  return (
    <div class="stack">
      <input
        class="filter-input"
        placeholder={t('Search members')}
        value={filter()}
        onInput={(e) => setFilter(e.currentTarget.value.toLowerCase())}
      />
      <div class="member-table">
        <div class="member-table-head">
          <span>{plural(ids().length, '{n} member', '{n} members')}</span>
          <span>{t('Member since')}</span>
          <span>{t('Roles')}</span>
          <span />
        </div>
        <For each={ids()}>
          {(id) => (
            <div class="member-table-row">
              <span class="member-cell">
                <Avatar user={state.users[id]} size={32} presence />
                <span class="member-names">
                  <strong style={{ color: nameColor(p.guildId, id) }}>
                    {nameOf(id, p.guildId)}
                    <Show when={state.guilds[p.guildId]?.owner_id === id}>
                      <span class="owner-crown" title={t('Server owner')}>
                        {' '}
                        ♛
                      </span>
                    </Show>
                  </strong>
                  <span class="muted small">{state.users[id]?.username}</span>
                </span>
              </span>
              <span class="muted small">{joined(id)}</span>
              <MemberRoles guildId={p.guildId} userId={id} />
              <span class="member-actions">
                <Show when={topPosition(p.guildId) > topPosition(p.guildId, id) || id === state.me?.id}>
                  <button
                    class="icon-btn"
                    aria-label={t('Edit')}
                    data-tip={t('Edit nickname')}
                    onClick={() => setUi('modal', { type: 'nickname', guildId: p.guildId, userId: id })}
                  >
                    <I.Edit size={16} />
                  </button>
                </Show>
                <Show
                  when={
                    id !== state.me?.id &&
                    can(p.guildId, P.KICK_MEMBERS) &&
                    topPosition(p.guildId) > topPosition(p.guildId, id)
                  }
                >
                  <button
                    class="icon-btn danger"
                    aria-label={t('Kick')}
                    data-tip={t('Kick {name}', { name: nameOf(id, p.guildId) })}
                    onClick={() =>
                      setUi('modal', {
                        type: 'confirm',
                        title: t('Kick {name}', { name: nameOf(id, p.guildId) }),
                        body: t('They can rejoin with a new invite.'),
                        action: t('Kick'),
                        run: () => api('DELETE', `/guilds/${p.guildId}/members/${id}`),
                      })
                    }
                  >
                    <I.Logout size={16} />
                  </button>
                </Show>
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

// ---------- invites ----------

interface InviteRow {
  invite: { code: string; uses: number; max_uses: number | null; expires_at: string | null; creator_id: string };
  inviter: User | null;
}

function InvitesPage(p: { guildId: string }) {
  const [list, { refetch }] = createResource(() => api<InviteRow[]>('GET', `/guilds/${p.guildId}/invites`));
  const expires = (at: string | null) => {
    if (!at) return t('Never');
    const h = (new Date(at).getTime() - Date.now()) / 3_600_000;
    return h < 1
      ? t('Under an hour')
      : h < 48
        ? plural(Math.round(h), '{n} hour', '{n} hours')
        : plural(Math.round(h / 24), '{n} day', '{n} days');
  };
  return (
    <div class="stack">
      <p class="set-desc">{t('Active invite links to this server. Revoking one stops it working right away.')}</p>
      <div class="invite-table">
        <div class="invite-table-head">
          <span>{t('Inviter')}</span>
          <span>{t('Invite code')}</span>
          <span>{t('Uses')}</span>
          <span>{t('Expires')}</span>
          <span />
        </div>
        <Show when={!list.loading} fallback={<div class="spinner" />}>
          <For each={list()} fallback={<p class="empty-hint">{t('No active invites.')}</p>}>
            {(row) => (
              <div class="invite-table-row">
                <span class="member-cell">
                  <Avatar user={row.inviter} size={24} />
                  <span>{row.inviter ? nameOf(row.inviter.id, p.guildId) : t('Unknown')}</span>
                </span>
                <code>{row.invite.code}</code>
                <span>{row.invite.max_uses ? `${row.invite.uses}/${row.invite.max_uses}` : row.invite.uses}</span>
                <span class="muted">{expires(row.invite.expires_at)}</span>
                <button
                  class="icon-btn danger"
                  aria-label={t('Revoke invite')}
                  data-tip={t('Revoke invite')}
                  onClick={() =>
                    void attempt(
                      async () => (await api('DELETE', `/invites/${row.invite.code}`), refetch()),
                      t('Invite revoked'),
                    )
                  }
                >
                  <I.Close size={16} />
                </button>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
