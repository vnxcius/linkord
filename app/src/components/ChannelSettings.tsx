// Channel and category settings, full window like server settings: Overview (name, topic) and Permissions
// (Discord's overwrites: private channel toggle, sync with the category, allow / neutral / deny per role or
// member). Threads and group DMs keep the small dialog in Modals.tsx.
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from 'solid-js';
import { api } from '../lib/api';
import { plural, t } from '../lib/i18n';
import {
  applyOverwrites,
  can,
  channelPermInfo,
  channelPerms,
  guildPerms,
  hasBit,
  isSynced,
  P,
  sameOverwrites,
  withBit,
} from '../lib/perms';
import { nameColor, nameOf, state } from '../lib/store';
import { Kind, type Overwrite } from '../lib/types';
import { attempt, isMobile, setUi, toast } from '../lib/ui';
import { Avatar } from './Avatar';
import * as I from './Icons';
import { useSubmit } from './Modals';
import { accentCss } from './Profile';
import { SaveBar, Toggle } from './SettingsModals';

type Page = 'overview' | 'permissions';

export function ChannelSettingsScreen(p: { channelId: string }) {
  const ch = () => state.channels[p.channelId];
  const gid = () => ch()?.guild_id ?? '';
  const category = () => ch()?.kind === Kind.Category;
  const pages = (): [Page, string, (p: { size?: number }) => JSX.Element][] =>
    (
      [
        ['overview', t('Overview'), I.Gear],
        ['permissions', t('Permissions'), I.Lock],
      ] as [Page, string, (p: { size?: number }) => JSX.Element][]
    ).filter(([id]) => can(gid(), id === 'overview' ? P.MANAGE_CHANNELS : P.MANAGE_ROLES, p.channelId));
  const [page, setPage] = createSignal<Page>(pages()[0]?.[0] ?? 'overview');
  const [navOpen, setNavOpen] = createSignal(isMobile());
  const open = (id: Page) => {
    setPage(id);
    setNavOpen(false);
  };
  const close = () => setUi('modal', null);
  const onKey = (e: KeyboardEvent) =>
    e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.context-menu') && close();
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));
  // Deleted, or you can't see it any more.
  createEffect(() => !ch() && close());
  const title = () => pages().find(([id]) => id === page())?.[1] ?? '';
  const remove = () =>
    setUi('modal', {
      type: 'confirm',
      title: t('Delete {name}', { name: ch()!.name }),
      body: category()
        ? t('Its channels stay, without a category.')
        : t('All of its messages will be deleted. This cannot be undone.'),
      action: t('Delete'),
      run: () => api('DELETE', `/channels/${p.channelId}`),
    });
  return (
    <Show when={ch()}>
      <div
        class="settings-screen"
        classList={{ 'nav-open': navOpen() }}
        role="dialog"
        aria-label={category() ? t('Edit category') : t('Edit channel')}
      >
        <aside class="settings-side">
          <nav class="settings-nav">
            <div class="settings-group server-group">
              <Switch fallback={<I.Hash size={16} />}>
                <Match when={ch()!.kind === Kind.Voice}>
                  <I.Speaker size={16} />
                </Match>
                <Match when={category()}>
                  <I.Folder size={16} />
                </Match>
              </Switch>
              <span>{ch()!.name}</span>
            </div>
            <For each={pages()}>
              {([id, label, Icon]) => (
                <button classList={{ active: page() === id && !navOpen() }} onClick={() => open(id)}>
                  <Icon size={18} />
                  {label}
                </button>
              )}
            </For>
          </nav>
          <Show when={can(gid(), P.MANAGE_CHANNELS, p.channelId)}>
            <div class="settings-foot">
              <button class="settings-logout" onClick={remove}>
                <I.Trash size={17} /> {category() ? t('Delete Category') : t('Delete Channel')}
              </button>
            </div>
          </Show>
        </aside>
        <main class="settings-main">
          <div class="settings-content" classList={{ wide: page() === 'permissions' }}>
            <h1>
              <button class="icon-btn settings-back" aria-label={t('All settings')} onClick={() => setNavOpen(true)}>
                <I.Back size={22} />
              </button>
              {title()}
            </h1>
            <Switch>
              <Match when={page() === 'overview'}>
                <OverviewPage channelId={p.channelId} />
              </Match>
              <Match when={page() === 'permissions'}>
                <PermissionsPage channelId={p.channelId} />
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

function OverviewPage(p: { channelId: string }) {
  const ch = () => state.channels[p.channelId]!;
  const initial = () => ({ name: ch().name, topic: ch().topic ?? '' });
  const [draft, setDraft] = createSignal(initial());
  const dirty = () => JSON.stringify(draft()) !== JSON.stringify(initial());
  const { busy, error, run } = useSubmit();
  const save = () =>
    run(async () => {
      await api('PATCH', `/channels/${p.channelId}`, {
        name: draft().name,
        ...(ch().kind === Kind.Text ? { topic: draft().topic } : {}),
      });
      toast(t('Saved'));
    });
  // After saving (or someone else's edit), show what the server has.
  createEffect(on(initial, (v) => setDraft(v), { defer: true }));
  return (
    <div class="stack">
      <label class="field">
        <span>{ch().kind === Kind.Category ? t('Category name') : t('Channel name')}</span>
        <input
          value={draft().name}
          onInput={(e) => setDraft((d) => ({ ...d, name: e.currentTarget.value }))}
          maxLength={100}
        />
      </label>
      <Show when={ch().kind === Kind.Text}>
        <label class="field">
          <span>{t('Topic')}</span>
          <textarea
            value={draft().topic}
            onInput={(e) => setDraft((d) => ({ ...d, topic: e.currentTarget.value }))}
            maxLength={1024}
            rows={3}
            placeholder={t('Let everyone know how to use this channel')}
          />
        </label>
      </Show>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
      <SaveBar
        show={dirty() && !!draft().name.trim()}
        busy={busy()}
        onReset={() => setDraft(initial())}
        onSave={save}
      />
    </div>
  );
}

type Tri = 'allow' | 'deny' | 'inherit';

function PermissionsPage(p: { channelId: string }) {
  const ch = () => state.channels[p.channelId]!;
  const gid = () => ch().guild_id!;
  const me = () => state.me!.id;
  const saved = () => ch().permission_overwrites ?? [];
  const [draft, setDraft] = createSignal<Overwrite[]>(saved().map((o) => ({ ...o })));
  // What the server has changed (a save, a sync, someone else): start from it.
  createEffect(
    on(
      () => JSON.stringify(saved()),
      () => setDraft(saved().map((o) => ({ ...o }))),
      { defer: true },
    ),
  );
  const dirty = createMemo(() => !sameOverwrites(draft(), saved()));
  const [selected, setSelected] = createSignal(gid());
  const { busy, error, run } = useSubmit();
  const parent = () => (ch().parent_id ? state.channels[ch().parent_id!] : undefined);
  const synced = () => isSynced(p.channelId);
  const admin = () => state.guilds[gid()]?.owner_id === me() || hasBit(guildPerms(gid()), P.ADMINISTRATOR);
  // Like Discord: you can only allow or deny what you have here yourself.
  const canChange = (bit: number) => admin() || hasBit(channelPerms(p.channelId), bit);

  const find = (id: string) => draft().find((o) => o.id === id);
  const stateOf = (id: string, bit: number): Tri => {
    const o = find(id);
    return o && hasBit(o.allow, bit) ? 'allow' : o && hasBit(o.deny, bit) ? 'deny' : 'inherit';
  };
  const setBit = (id: string, type: 0 | 1, bit: number, to: Tri) =>
    setDraft((list) => {
      const o = list.find((x) => x.id === id) ?? { id, type, allow: 0, deny: 0 };
      const next = { ...o, allow: withBit(o.allow, bit, to === 'allow'), deny: withBit(o.deny, bit, to === 'deny') };
      return [...list.filter((x) => x.id !== id), next];
    });

  const isPrivate = () => stateOf(gid(), P.VIEW_CHANNEL) === 'deny';
  const setPrivate = (on: boolean) => {
    setBit(gid(), 0, P.VIEW_CHANNEL, on ? 'deny' : 'inherit');
    // Don't lock yourself out: keep seeing it through your own overwrite.
    if (on && !admin()) {
      const roles = state.members[gid()]?.[me()]?.roles ?? [];
      if (!hasBit(applyOverwrites(guildPerms(gid()), gid(), me(), roles, draft()), P.VIEW_CHANNEL))
        setBit(me(), 1, P.VIEW_CHANNEL, 'allow');
    }
  };

  const roles = () => state.roles[gid()] ?? {};
  // @everyone first, then roles highest first, then members.
  const targets = () => {
    const list = draft();
    const rs = list
      .filter((o) => o.type === 0 && o.id !== gid() && roles()[o.id])
      .sort((a, b) => roles()[b.id].position - roles()[a.id].position);
    const ms = list.filter((o) => o.type === 1).sort((a, b) => nameOf(a.id, gid()).localeCompare(nameOf(b.id, gid())));
    return [
      { id: gid(), type: 0 as const },
      ...rs.map((o) => ({ id: o.id, type: 0 as const })),
      ...ms.map((o) => ({ id: o.id, type: 1 as const })),
    ];
  };
  const current = () => targets().find((x) => x.id === selected()) ?? targets()[0];
  const label = (x: { id: string; type: 0 | 1 }) =>
    x.id === gid() ? '@everyone' : x.type === 0 ? (roles()[x.id]?.name ?? '?') : nameOf(x.id, gid());

  const add = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const have = new Set(draft().map((o) => o.id));
    const roleItems = Object.values(roles())
      .filter((x) => x.id !== gid() && !have.has(x.id))
      .sort((a, b) => b.position - a.position)
      .map((x) => ({
        label: x.name,
        icon: () => <i class="role-dot" style={{ background: accentCss(x.color) ?? 'var(--text-3)' }} />,
        run: () => addTarget(x.id, 0),
      }));
    const memberItems = Object.keys(state.members[gid()] ?? {})
      .filter((id) => !have.has(id))
      .sort((a, b) => nameOf(a, gid()).localeCompare(nameOf(b, gid())))
      .map((id) => ({
        label: nameOf(id, gid()),
        icon: () => <Avatar user={state.users[id]} size={20} />,
        run: () => addTarget(id, 1),
      }));
    setUi('menu', {
      x: r.left,
      y: r.bottom + 4,
      items:
        roleItems.length || memberItems.length
          ? [...roleItems, ...(roleItems.length && memberItems.length ? ['separator' as const] : []), ...memberItems]
          : [{ label: t('Everyone is already here'), disabled: true }],
    });
  };
  const addTarget = (id: string, type: 0 | 1) => {
    setDraft((l) => [...l, { id, type, allow: 0, deny: 0 }]);
    setSelected(id);
  };
  const removeTarget = (id: string) => {
    setDraft((l) => l.filter((o) => o.id !== id));
    setSelected(gid());
  };

  const save = () =>
    run(async () => {
      await api('PUT', `/channels/${p.channelId}/permissions`, { permission_overwrites: draft() });
      toast(t('Permissions saved'));
    });
  const sync = () => attempt(() => api('POST', `/channels/${p.channelId}/permissions/sync`), t('Synced'));

  return (
    <div class="stack">
      <Show when={parent()}>
        {(cat) => (
          <div class="perm-sync" classList={{ off: !synced() }}>
            <I.Folder size={18} />
            <span class="grow">
              {synced()
                ? t('Permissions synced with category: {name}', { name: cat().name })
                : t('Permissions not synced with category: {name}', { name: cat().name })}
            </span>
            <Show when={!synced() && !dirty()}>
              <button class="btn small-btn" onClick={() => void sync()}>
                {t('Sync Now')}
              </button>
            </Show>
          </div>
        )}
      </Show>
      <Show when={ch().kind === Kind.Category}>
        <p class="muted small">{t('Channels synced with this category get the same permissions.')}</p>
      </Show>
      <div class="perm-private">
        <Toggle
          label={ch().kind === Kind.Category ? t('Private Category') : t('Private Channel')}
          hint={t('Only the roles and members you add below can see it.')}
          checked={isPrivate()}
          onChange={setPrivate}
          disabled={!canChange(P.VIEW_CHANNEL)}
        />
      </div>
      <div class="role-split">
        <div class="role-side">
          <div class="perm-side-head">
            <span>{t('Roles / Members')}</span>
            <button
              class="icon-btn"
              aria-label={t('Add a role or member')}
              data-tip={t('Add a role or member')}
              onClick={add}
            >
              <I.Plus size={16} />
            </button>
          </div>
          <For each={targets()}>
            {(x) => (
              <button
                class="role-side-row"
                classList={{ active: current().id === x.id }}
                onClick={() => setSelected(x.id)}
              >
                <Show
                  when={x.type === 1}
                  fallback={
                    <i
                      class="role-dot"
                      style={{ background: accentCss(x.id === gid() ? null : roles()[x.id]?.color) ?? 'var(--text-3)' }}
                    />
                  }
                >
                  <Avatar user={state.users[x.id]} size={18} />
                </Show>
                <span class="grow" style={{ color: x.type === 1 ? nameColor(gid(), x.id) : undefined }}>
                  {label(x)}
                </span>
              </button>
            )}
          </For>
        </div>
        <div class="role-editor">
          <div class="role-editor-head">
            <h2>{label(current())}</h2>
            <Show when={current().id !== gid()}>
              <button
                class="icon-btn danger"
                aria-label={t('Remove')}
                data-tip={t('Remove')}
                onClick={() => removeTarget(current().id)}
              >
                <I.Trash size={18} />
              </button>
            </Show>
          </div>
          <p class="muted small">
            {plural(
              draft().filter((o) => o.allow || o.deny).length,
              '{n} role or member has changes here',
              '{n} roles or members have changes here',
            )}
          </p>
          <For each={channelPermInfo(ch().kind)}>
            {(g) => (
              <div class="perm-group">
                <div class="group-title">{t('{group} permissions', { group: t(g.group) })}</div>
                <For each={g.items}>
                  {([key, name, hint]) => (
                    <div class="perm-row" classList={{ disabled: !canChange(P[key]) }}>
                      <span>
                        <strong>{t(name)}</strong>
                        <Show when={hint}>
                          <small>{t(hint)}</small>
                        </Show>
                      </span>
                      <div class="perm-tri" role="radiogroup" aria-label={t(name)}>
                        <For each={['deny', 'inherit', 'allow'] as Tri[]}>
                          {(v) => (
                            <button
                              role="radio"
                              aria-checked={stateOf(current().id, P[key]) === v}
                              class={v}
                              classList={{ on: stateOf(current().id, P[key]) === v }}
                              disabled={!canChange(P[key])}
                              aria-label={v === 'allow' ? t('Allow') : v === 'deny' ? t('Deny') : t('Inherit')}
                              data-tip={v === 'allow' ? t('Allow') : v === 'deny' ? t('Deny') : t('Inherit')}
                              onClick={() => setBit(current().id, current().type, P[key], v)}
                            >
                              <Switch fallback={<span class="slash">/</span>}>
                                <Match when={v === 'allow'}>
                                  <I.Check size={15} />
                                </Match>
                                <Match when={v === 'deny'}>
                                  <I.Close size={15} />
                                </Match>
                              </Switch>
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
      <SaveBar show={dirty()} busy={busy()} onReset={() => setDraft(saved().map((o) => ({ ...o })))} onSave={save} />
    </div>
  );
}
