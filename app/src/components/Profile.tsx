import { createEffect, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { api, media } from '../lib/api';
import { blockUser, friendRequest, openDm, removeRelationship, selectView } from '../lib/actions';
import { dateLocale, plural, t } from '../lib/i18n';
import { can, P, topPosition } from '../lib/perms';
import { gameOf, memberRoles, nameOf, spotifyOf, state } from '../lib/store';
import { openExternal } from '../lib/platform';
import { displayName, Rel, type User } from '../lib/types';
import { attempt, isMobile, setUi, ui, type MenuEntry } from '../lib/ui';
import { GameCard, SpotifyCard, SpotifyIcon, StatusBubble } from './Activity';
import { Avatar, GuildIcon } from './Avatar';
import { MyStatusBubble } from './CustomStatus';
import * as I from './Icons';
import { volumeMenu } from './Sidebar';
import { voiceUi } from '../lib/voice';

export function accentCss(color?: number | null) {
  return color != null ? `#${color.toString(16).padStart(6, '0')}` : undefined;
}

/** Friend actions for someone, based on your relationship. */
export function friendItems(userId: string): MenuEntry[] {
  if (userId === state.me?.id) return [];
  const rel = state.relationships[userId];
  const items: MenuEntry[] = [];
  if (rel === Rel.Friend)
    items.push({ label: t('Remove Friend'), danger: true, run: () => attempt(() => removeRelationship(userId)) });
  else if (rel === Rel.Incoming)
    items.push({
      label: t('Accept Friend Request'),
      run: () => attempt(() => friendRequest(userId), t('Friend added')),
    });
  else if (rel === Rel.Outgoing)
    items.push({ label: t('Cancel Friend Request'), run: () => attempt(() => removeRelationship(userId)) });
  else if (rel !== Rel.Blocked)
    items.push({
      label: t('Add Friend'),
      icon: () => <I.UserPlus size={16} />,
      run: () => attempt(() => friendRequest(userId), t('Friend request sent')),
    });
  items.push(
    rel === Rel.Blocked
      ? { label: t('Unblock'), run: () => attempt(() => removeRelationship(userId)) }
      : { label: t('Block'), danger: true, run: () => attempt(() => blockUser(userId), t('Blocked')) },
  );
  return items;
}

/** Right-click menu for a member in a server. */
export function memberMenu(userId: string, guildId?: string): MenuEntry[] {
  const me = state.me?.id;
  const items: MenuEntry[] = [];
  if (userId !== me) items.push({ label: t('Message'), run: () => attempt(() => openDm(userId)) });
  if (guildId && voiceUi.channelId && userId !== me && state.voice[userId]?.channel_id === voiceUi.channelId) {
    items.push('separator', ...volumeMenu(userId));
  }
  if (guildId) {
    const outranks = topPosition(guildId) > topPosition(guildId, userId);
    const canNick = userId === me ? can(guildId, P.CHANGE_NICKNAME) : can(guildId, P.MANAGE_NICKNAMES) && outranks;
    if (canNick || (can(guildId, P.MANAGE_ROLES) && (outranks || userId === me))) {
      items.push('separator', {
        label: t('Edit Nickname & Roles'),
        icon: () => <I.Edit size={16} />,
        run: () => setUi('modal', { type: 'nickname', guildId, userId }),
      });
    }
    if (userId !== me && can(guildId, P.KICK_MEMBERS) && outranks && state.guilds[guildId]?.owner_id !== userId) {
      items.push({
        label: t('Kick {name}', { name: nameOf(userId, guildId) }),
        danger: true,
        run: () =>
          setUi('modal', {
            type: 'confirm',
            title: t('Kick {name}', { name: nameOf(userId, guildId) }),
            body: t('They can rejoin with a new invite.'),
            action: t('Kick'),
            run: () => api('DELETE', `/guilds/${guildId}/members/${userId}`),
          }),
      });
    }
  }
  const friends = friendItems(userId);
  if (friends.length) items.push('separator', ...friends);
  items.push('separator', {
    label: t('Copy User ID'),
    icon: () => <I.Copy size={16} />,
    run: () => navigator.clipboard.writeText(userId),
  });
  return items;
}

/** Roles you can hand out or take away from members: below your highest role, with Manage Roles. */
export function canAssign(guildId: string, roleId: string) {
  const r = state.roles[guildId]?.[roleId];
  return !!r && r.id !== guildId && can(guildId, P.MANAGE_ROLES) && r.position < topPosition(guildId);
}

function setMemberRoles(guildId: string, userId: string, roles: string[]) {
  return attempt(() => api('PATCH', `/guilds/${guildId}/members/${userId}`, { roles }));
}

/** A member's roles as pills, like Discord: hover a role you can manage to remove it (×), "+" adds one. */
export function MemberRoles(p: { guildId: string; userId: string }) {
  const roles = () => memberRoles(p.guildId, p.userId);
  const held = () => state.members[p.guildId]?.[p.userId]?.roles ?? [];
  const addable = () =>
    Object.values(state.roles[p.guildId] ?? {})
      .filter((r) => !held().includes(r.id) && canAssign(p.guildId, r.id))
      .sort((a, b) => b.position - a.position);
  const addMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setUi('menu', {
      x: r.left,
      y: r.bottom + 4,
      items: addable().map((role) => ({
        label: role.name,
        icon: () => <i class="role-dot" style={{ background: accentCss(role.color) ?? 'var(--text-3)' }} />,
        run: () => setMemberRoles(p.guildId, p.userId, [...held(), role.id]),
      })),
    });
  };
  return (
    <div class="role-pills">
      <For each={roles()}>
        {(r) => (
          <span class="role-pill" classList={{ removable: canAssign(p.guildId, r.id) }}>
            <Show
              when={canAssign(p.guildId, r.id)}
              fallback={<i style={{ background: accentCss(r.color) ?? 'var(--text-3)' }} />}
            >
              <button
                class="role-remove"
                style={{ background: accentCss(r.color) ?? 'var(--text-3)' }}
                aria-label={t('Remove role {role}', { role: r.name })}
                title={t('Remove role')}
                onClick={() =>
                  void setMemberRoles(
                    p.guildId,
                    p.userId,
                    held().filter((x) => x !== r.id),
                  )
                }
              >
                <I.Close size={9} stroke-width={3.5} />
              </button>
            </Show>
            {r.name}
          </span>
        )}
      </For>
      <Show when={addable().length}>
        <button class="role-pill role-add" aria-label={t('Add role')} title={t('Add role')} onClick={addMenu}>
          <I.Plus size={13} />
        </button>
      </Show>
    </div>
  );
}

/** Eats the click that follows a mousedown/tap (it fires on whatever is under the finger). */
function swallowNextClick() {
  const stop = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  document.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => document.removeEventListener('click', stop, { capture: true }), 600);
}

export function ProfilePopout() {
  let el!: HTMLDivElement;
  const [pos, setPos] = createSignal({ x: 0, y: 0 });
  const p = () => ui.profile!;
  const user = () => state.users[p().userId];
  const close = () => setUi('profile', null);
  const onDoc = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (el.contains(target) || target.closest('.context-menu')) return;
    // On phones (a sheet over a dimmed page) and over the member drawer, tapping outside only closes the card:
    // the click mustn't also land on what's underneath (the drawer's backdrop would close the member list).
    if (isMobile() || target.closest('.drawer-backdrop')) swallowNextClick();
    close();
  };
  onMount(() => setTimeout(() => document.addEventListener('mousedown', onDoc)));
  onCleanup(() => document.removeEventListener('mousedown', onDoc));

  // Keep the card on screen.
  createEffect(() => {
    const { x, y } = p();
    const w = 320;
    const h = el.offsetHeight || 380;
    const bottom = p().bottom;
    setPos({
      x: x + w > innerWidth - 12 ? Math.max(12, x - w - 60) : x,
      y: Math.max(12, Math.min(bottom !== undefined ? bottom - h : y, innerHeight - h - 12)),
    });
  });

  const gid = () => p().guildId;
  const joined = () => (gid() ? state.members[gid()!]?.[p().userId]?.joined_at : undefined);
  const roles = () => (gid() ? memberRoles(gid()!, p().userId) : []);
  const isMe = () => p().userId === state.me?.id;
  const rel = () => state.relationships[p().userId];

  return (
    <div
      class="profile-card"
      ref={el}
      style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
      onKeyDown={(e) => e.key === 'Escape' && close()}
    >
      <Show when={user()}>
        {(u) => (
          <>
            <div class="profile-banner" style={{ 'background-color': accentCss(u().accent_color) }}>
              <Show when={media(u().banner)}>{(src) => <img src={src()} alt="" />}</Show>
            </div>
            <div class="profile-avatar-row">
              <button
                class="profile-avatar"
                title={t('View full profile')}
                onClick={() => {
                  const modal = { type: 'user-profile' as const, userId: u().id, guildId: gid() };
                  close();
                  setUi('modal', modal);
                }}
              >
                <Avatar user={u()} size={84} presence />
                <span class="profile-avatar-hint">{t('View profile')}</span>
              </button>
              <Show when={isMe()} fallback={<StatusBubble userId={u().id} />}>
                <MyStatusBubble />
              </Show>
            </div>
            <div class="profile-body">
              <h3>{nameOf(u().id, gid())}</h3>
              <div class="profile-username">
                {u().username}
                <Show when={rel() === Rel.Friend}>
                  <span class="tag">{t('Friend')}</span>
                </Show>
              </div>
              <Show when={gameOf(u().id)}>
                {(a) => (
                  <div class="profile-section">
                    <GameCard activity={a()} />
                  </div>
                )}
              </Show>
              <Show when={spotifyOf(u().id)}>
                {(a) => (
                  <div class="profile-section">
                    <SpotifyCard activity={a()} />
                  </div>
                )}
              </Show>
              <Show when={u().bio}>
                <div class="profile-section">
                  <div class="label">{t('About me')}</div>
                  <p class="bio">{u().bio}</p>
                </div>
              </Show>
              <Show when={joined()}>
                <div class="profile-section">
                  <div class="label">{t('Member since')}</div>
                  <p>
                    {new Date(joined()!).toLocaleDateString(dateLocale(), {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </p>
                </div>
              </Show>
              <Show when={gid() && (roles().length || can(gid(), P.MANAGE_ROLES))}>
                <div class="profile-section">
                  <div class="label">{roles().length ? t('Roles') : t('No roles')}</div>
                  <MemberRoles guildId={gid()!} userId={u().id} />
                </div>
              </Show>
              <div class="profile-actions">
                <Show
                  when={!isMe()}
                  fallback={
                    <button class="btn" onClick={() => (close(), setUi('modal', { type: 'settings' }))}>
                      {t('Edit profile')}
                    </button>
                  }
                >
                  <button class="btn primary" onClick={() => (close(), void attempt(() => openDm(u().id)))}>
                    {t('Message')}
                  </button>
                  <Show when={rel() !== Rel.Friend && rel() !== Rel.Blocked && rel() !== Rel.Outgoing}>
                    <button
                      class="btn"
                      title={rel() === Rel.Incoming ? t('Accept friend request') : t('Add friend')}
                      onClick={() =>
                        void attempt(
                          () => friendRequest(u().id),
                          rel() === Rel.Incoming ? t('Friend added') : t('Friend request sent'),
                        )
                      }
                    >
                      <I.UserPlus size={18} />
                    </button>
                  </Show>
                  <button
                    class="btn"
                    aria-label={t('More')}
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setUi('menu', { x: r.left, y: r.bottom + 4, items: memberMenu(u().id, gid()) });
                    }}
                  >
                    ⋯
                  </button>
                </Show>
              </div>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

interface FullProfile {
  user: User;
  connections?: { type: string; id: string; name: string }[];
  mutual_friends: User[];
  mutual_guilds: string[];
  created_at: string;
}

const longDate = (d: string) =>
  new Date(d).toLocaleDateString(dateLocale(), { year: 'numeric', month: 'short', day: 'numeric' });

/** The full profile (Discord's profile modal): opened from the avatar on a user card. */
export function ProfileModal(p: { userId: string; guildId?: string }) {
  const [tab, setTab] = createSignal<'about' | 'servers' | 'friends'>('about');
  const [full] = createResource(
    () => p.userId,
    (id) => api<FullProfile>('GET', `/users/${id}/profile`),
  );
  const user = () => state.users[p.userId] ?? full()?.user;
  const isMe = () => p.userId === state.me?.id;
  const rel = () => state.relationships[p.userId];
  const joined = () => (p.guildId ? state.members[p.guildId]?.[p.userId]?.joined_at : undefined);
  const close = () => setUi('modal', null);
  const servers = () => (full()?.mutual_guilds ?? []).filter((id) => state.guilds[id]);
  const friends = () => full()?.mutual_friends ?? [];
  return (
    <div class="modal profile-modal" role="dialog" aria-label={t('Profile')}>
      <Show when={user()}>
        {(u) => (
          <>
            <div class="profile-banner big" style={{ 'background-color': accentCss(u().accent_color) }}>
              <Show when={media(u().banner)}>{(src) => <img src={src()} alt="" />}</Show>
              <button class="icon-btn modal-close" aria-label={t('Close')} onClick={close}>
                <I.Close size={18} />
              </button>
            </div>
            <div class="profile-modal-head">
              <div class="profile-avatar-row">
                <div class="profile-avatar big">
                  <Avatar user={u()} size={120} presence />
                </div>
                <StatusBubble userId={u().id} big />
              </div>
              <div class="profile-modal-actions">
                <Show
                  when={!isMe()}
                  fallback={
                    <button class="btn" onClick={() => setUi('modal', { type: 'settings', tab: 'profile' })}>
                      <I.EditProfile size={16} /> {t('Edit profile')}
                    </button>
                  }
                >
                  <button class="btn primary" onClick={() => (close(), void attempt(() => openDm(u().id)))}>
                    {t('Message')}
                  </button>
                  <Show when={rel() !== Rel.Friend && rel() !== Rel.Blocked && rel() !== Rel.Outgoing}>
                    <button
                      class="btn"
                      onClick={() =>
                        void attempt(
                          () => friendRequest(u().id),
                          rel() === Rel.Incoming ? t('Friend added') : t('Friend request sent'),
                        )
                      }
                    >
                      <I.UserPlus size={16} /> {rel() === Rel.Incoming ? t('Accept friend request') : t('Add friend')}
                    </button>
                  </Show>
                  <button
                    class="btn"
                    aria-label={t('More')}
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setUi('menu', { x: r.left, y: r.bottom + 4, items: memberMenu(u().id, p.guildId) });
                    }}
                  >
                    ⋯
                  </button>
                </Show>
              </div>
            </div>
            <div class="profile-modal-body">
              <h2>{nameOf(u().id, p.guildId)}</h2>
              <div class="profile-username">
                {u().username}
                <Show when={rel() === Rel.Friend}>
                  <span class="tag">{t('Friend')}</span>
                </Show>
              </div>
              <nav class="profile-tabs">
                <button classList={{ active: tab() === 'about' }} onClick={() => setTab('about')}>
                  {t('About Me')}
                </button>
                <Show when={!isMe()}>
                  <button classList={{ active: tab() === 'servers' }} onClick={() => setTab('servers')}>
                    {full() ? plural(servers().length, '{n} Mutual Server', '{n} Mutual Servers') : t('Mutual Servers')}
                  </button>
                  <button classList={{ active: tab() === 'friends' }} onClick={() => setTab('friends')}>
                    {full() ? plural(friends().length, '{n} Mutual Friend', '{n} Mutual Friends') : t('Mutual Friends')}
                  </button>
                </Show>
              </nav>
              <div class="profile-tab-body">
                <Switch>
                  <Match when={tab() === 'about'}>
                    <Show when={gameOf(u().id)}>
                      {(a) => (
                        <div class="profile-section">
                          <GameCard activity={a()} />
                        </div>
                      )}
                    </Show>
                    <Show when={spotifyOf(u().id)}>
                      {(a) => (
                        <div class="profile-section">
                          <SpotifyCard activity={a()} />
                        </div>
                      )}
                    </Show>
                    <Show when={u().bio}>
                      <div class="profile-section">
                        <p class="bio">{u().bio}</p>
                      </div>
                    </Show>
                    <div class="profile-dates">
                      <Show when={full()}>
                        <div class="profile-section">
                          <div class="label">{t('Linkord member since')}</div>
                          <p>{longDate(full()!.created_at)}</p>
                        </div>
                      </Show>
                      <Show when={joined()}>
                        <div class="profile-section">
                          <div class="label">{t('Member since')}</div>
                          <p>
                            <span class="profile-server-icon">
                              <GuildIcon
                                name={state.guilds[p.guildId!]?.name ?? ''}
                                icon={state.guilds[p.guildId!]?.icon}
                              />
                            </span>
                            {longDate(joined()!)}
                          </p>
                        </div>
                      </Show>
                    </div>
                    <Show when={p.guildId && state.members[p.guildId]?.[u().id]}>
                      <div class="profile-section">
                        <div class="label">{t('Roles')}</div>
                        <MemberRoles guildId={p.guildId!} userId={u().id} />
                      </div>
                    </Show>
                    <Show when={full()?.connections?.length}>
                      <div class="profile-section">
                        <div class="label">{t('Connections')}</div>
                        <div class="profile-connections">
                          <For each={full()!.connections}>
                            {(c) => (
                              <button
                                class="profile-connection"
                                onClick={() =>
                                  void openExternal(`https://open.spotify.com/user/${encodeURIComponent(c.id)}`)
                                }
                              >
                                <SpotifyIcon size={22} />
                                <span class="grow">{c.name}</span>
                                <I.External size={14} />
                              </button>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>
                  </Match>
                  <Match when={tab() === 'servers'}>
                    <For each={servers()} fallback={<p class="empty-hint">{t('No servers in common.')}</p>}>
                      {(id) => (
                        <button class="profile-list-row" onClick={() => (close(), selectView(id))}>
                          <span class="profile-server-icon big">
                            <GuildIcon name={state.guilds[id].name} icon={state.guilds[id].icon} />
                          </span>
                          <span class="grow">
                            <strong>{state.guilds[id].name}</strong>
                            <Show when={state.members[id]?.[p.userId]?.nickname}>
                              <span class="muted small"> · {state.members[id][p.userId].nickname}</span>
                            </Show>
                          </span>
                        </button>
                      )}
                    </For>
                  </Match>
                  <Match when={tab() === 'friends'}>
                    <For each={friends()} fallback={<p class="empty-hint">{t('No friends in common.')}</p>}>
                      {(f) => (
                        <button
                          class="profile-list-row"
                          onClick={() => setUi('modal', { type: 'user-profile', userId: f.id })}
                        >
                          <Avatar user={state.users[f.id] ?? f} size={36} presence />
                          <span class="grow">
                            <strong>{displayName(state.users[f.id] ?? f)}</strong>{' '}
                            <span class="muted small">{f.username}</span>
                          </span>
                        </button>
                      )}
                    </For>
                  </Match>
                </Switch>
              </div>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
