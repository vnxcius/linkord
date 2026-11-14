import { createEffect, createResource, createSignal, For, type JSX, Match, onMount, Show, Switch } from 'solid-js';
import { onOutsideMouseDown } from '../lib/outside-click';
import { api, media } from '../lib/api';
import { blockUser, friendRequest, openDm, removeRelationship, selectView } from '../lib/actions';
import { dateLocale, plural, t } from '../lib/i18n';
import { can, P, topPosition } from '../lib/perms';
import { gameOf, memberRoles, nameOf, profileOf, spotifyOf, state } from '../lib/store';
import { openExternal } from '../lib/platform';
import { displayName, Kind, Rel, type SharedClip, type User } from '../lib/types';
import { attempt, isMobile, setUi, ui, type MenuEntry } from '../lib/ui';
import { LeagueCard, type LeagueAccount } from './League';
import { GameCard, SpotifyCard, SpotifyIcon, StatusBubble } from './Activity';
import { Avatar, GuildIcon } from './Avatar';
import { MyStatusBubble } from './CustomStatus';
import { Snowman } from './ChristmasArt';
import { isChristmas } from '../lib/theme';
import * as I from './Icons';
import { inviteToLobby, leagueCanInvite } from '../lib/league';
import { soundboardMenu, volumeMenu } from './Sidebar';
import { type FavoriteGame, FavoriteGamesCard } from './FavoriteGames';
import { voiceUi } from '../lib/voice';
import { confetti } from '../lib/confetti';
import { BirthdayCake, formatBirthday, isBirthdayToday } from './Birthday';
import { BadgeChips, BadgeStrip } from './Badges';
import { type Badge, rememberBadges } from '../lib/badges';
import {
  NoteField,
  ProfileLinks,
  type ProfileLink,
  type ProfileSong,
  type PublicStats,
  SongPlayer,
  StatsCard,
  type TopSong,
  RecentClipsCard,
  TopSongsCard,
  SnowballsCard,
  type Snowballs,
} from './ProfileWidgets';

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
  else if (rel !== Rel.Blocked && !state.users[userId]?.bot)
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

/** Right-click on someone anywhere (voice tiles, the voice list): their profile, then what the ⋯ menu offers. */
export function userMenu(userId: string, guildId?: string | null): MenuEntry[] {
  return [
    {
      label: t('View Profile'),
      icon: () => <I.Eye size={16} />,
      run: () => setUi('modal', { type: 'user-profile', userId, guildId: guildId ?? undefined }),
    },
    'separator',
    ...memberMenu(userId, guildId ?? undefined),
  ];
}

/** Right-click menu for a member in a server. */
export function memberMenu(userId: string, guildId?: string): MenuEntry[] {
  const me = state.me?.id;
  const items: MenuEntry[] = [];
  if (userId !== me) items.push({ label: t('Message'), run: () => attempt(() => openDm(userId)) });
  // You're in a League lobby and may invite: invite them through Pottira (they accept, your client invites them).
  if (userId !== me && !state.users[userId]?.bot && leagueCanInvite()) {
    items.push({
      label: t('Invite to League lobby'),
      icon: () => <I.UserPlus size={16} />,
      run: () => void inviteToLobby(userId, nameOf(userId, guildId)),
    });
  }
  if (voiceUi.channelId && userId !== me && state.voice[userId]?.channel_id === voiceUi.channelId) {
    items.push('separator', ...volumeMenu(userId));
  } else if (state.users[userId]?.bot && state.users[userId]?.username === 'steve') {
    // Steve is never in the call, but his sound commands play in it.
    items.push(...soundboardMenu(userId));
  }
  if (guildId) items.push(...voiceModItems(userId, guildId));
  if (guildId) {
    const outranks = topPosition(guildId) > topPosition(guildId, userId);
    const canNick = userId === me ? can(guildId, P.CHANGE_NICKNAME) : can(guildId, P.MANAGE_NICKNAMES) && outranks;
    const ownRoles = userId === me && (state.members[guildId]?.[me]?.roles.length ?? 0) > 0;
    // Your own server profile (picture, banner, about me) is always yours to edit.
    if (userId === me || canNick || ownRoles || (can(guildId, P.MANAGE_ROLES) && outranks)) {
      items.push('separator', {
        label: userId === me ? t('Edit Server Profile') : t('Edit Nickname & Roles'),
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
      items.push({
        label: t('Ban {name}', { name: nameOf(userId, guildId) }),
        danger: true,
        run: () =>
          setUi('modal', {
            type: 'confirm',
            title: t('Ban {name}', { name: nameOf(userId, guildId) }),
            body: t(
              "They're removed and can't come back, even with an invite, until you unban them in Server Settings.",
            ),
            action: t('Ban'),
            run: () => api('PUT', `/guilds/${guildId}/bans/${userId}`),
          }),
      });
    }
  }
  if (state.users[userId]?.bot && state.admin) items.push('separator', ...botPictureItems(userId));
  const friends = state.users[userId]?.bot ? [] : friendItems(userId);
  if (friends.length) items.push('separator', ...friends);
  items.push('separator', {
    label: t('Copy User ID'),
    icon: () => <I.Copy size={16} />,
    run: () => navigator.clipboard.writeText(userId),
  });
  return items;
}

/** Move Members in their voice channel: move them to another voice channel, or disconnect them. */
export function moveMember(guildId: string, userId: string, channelId: string | null) {
  return attempt(() => api('PATCH', `/guilds/${guildId}/members/${userId}/voice`, { channel_id: channelId }));
}

function voiceModItems(userId: string, guildId: string): MenuEntry[] {
  const from = state.voice[userId]?.channel_id;
  if (!from || state.channels[from]?.guild_id !== guildId || !can(guildId, P.MOVE_MEMBERS, from)) return [];
  const targets = Object.values(state.channels)
    .filter(
      (c) =>
        c.guild_id === guildId &&
        c.kind === Kind.Voice &&
        c.id !== from &&
        can(guildId, P.MOVE_MEMBERS, c.id) &&
        can(guildId, P.CONNECT, c.id),
    )
    .sort((a, b) => a.position - b.position);
  const items: MenuEntry[] = ['separator'];
  if (targets.length && !state.users[userId]?.bot)
    items.push({
      label: t('Move To'),
      icon: () => <I.Speaker size={16} />,
      run: (at) =>
        setUi('menu', {
          ...at,
          items: targets.map((c) => ({
            label: c.name,
            icon: () => <I.Speaker size={16} />,
            run: () => moveMember(guildId, userId, c.id),
          })),
        }),
    });
  items.push({
    label: t('Disconnect'),
    danger: true,
    icon: () => <I.Hangup size={16} />,
    run: () => moveMember(guildId, userId, null),
  });
  return items;
}

/** Each bot's own picture endpoint (Kass: music.rs, Steve: steve.rs). */
const BOT_AVATAR: Record<string, string> = { kass: '/bots/music/avatar', steve: '/bots/steve/avatar' };

/** Admins (LINKORD_ADMINS) choose the bots' pictures. */
function botPictureItems(userId: string): MenuEntry[] {
  const path = BOT_AVATAR[state.users[userId]?.username ?? ''];
  if (!path) return [];
  const pick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file, file.name);
      void attempt(() => api('POST', path, fd), t('Picture updated'));
    };
    input.click();
  };
  return [
    { label: t('Change Picture'), icon: () => <I.AddImage size={16} />, run: pick },
    { label: t('Reset Picture'), run: () => attempt(() => api('DELETE', path)) },
  ];
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
  onOutsideMouseDown(onDoc);

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
  // Their server profile (picture, banner, about me) in this server.
  const shown = () => profileOf(p().userId, gid()) ?? user();
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
              <Show when={media(shown()?.banner)}>{(src) => <BannerImage src={src()} />}</Show>
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
                <Avatar user={u()} size={84} presence guildId={gid()} />
                <span class="profile-avatar-hint">{t('View profile')}</span>
              </button>
              <Show when={isMe()} fallback={<StatusBubble userId={u().id} />}>
                <MyStatusBubble />
              </Show>
            </div>
            <div class="profile-body">
              <h3>
                {nameOf(u().id, gid())}
                <BirthdayCake userId={u().id} />
              </h3>
              <div class="profile-username">
                {u().username}
                <Show when={u().pronouns}>
                  <span class="pronouns">{u().pronouns}</span>
                </Show>
                <Show when={u().bot}>
                  <span class="bot-tag">{t('BOT')}</span>
                </Show>
                <Show when={rel() === Rel.Friend}>
                  <span class="tag">{t('Friend')}</span>
                </Show>
              </div>
              <BadgeStrip userId={u().id} />
              <Show when={gameOf(u().id)}>
                {(a) => (
                  <div class="profile-section">
                    <GameCard activity={a()} userId={u().id} />
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
              <Show when={shown()?.bio}>
                <div class="profile-section">
                  <div class="label">{t('About me')}</div>
                  <p class="bio">{shown()!.bio}</p>
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
                  <Show when={!u().bot && rel() !== Rel.Friend && rel() !== Rel.Blocked && rel() !== Rel.Outgoing}>
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

/** A profile's banner: clicking it opens it like an attachment. */
function BannerImage(p: { src: string }) {
  return (
    <button class="profile-banner-open" aria-label={t('View banner')} onClick={() => setUi('lightbox', p.src)}>
      <img src={p.src} alt="" />
    </button>
  );
}

/** The other person in a direct message, in the panel on the right. */
export function DmProfile(p: { userId: string }) {
  const [full] = createResource(
    () => p.userId,
    (id) => api<FullProfile>('GET', `/users/${id}/profile`).catch(() => undefined),
  );
  const user = () => state.users[p.userId] ?? full()?.user;
  const rel = () => state.relationships[p.userId];
  const open = () => setUi('modal', { type: 'user-profile', userId: p.userId });
  const servers = () => (full()?.mutual_guilds ?? []).filter((id) => state.guilds[id]);
  return (
    <Show when={user()}>
      {(u) => (
        <div class="dm-profile">
          <div class="profile-banner" style={{ 'background-color': accentCss(u().accent_color) }}>
            <Show when={media(u().banner)}>{(src) => <BannerImage src={src()} />}</Show>
          </div>
          <div class="profile-avatar-row">
            <button class="profile-avatar" title={t('View full profile')} onClick={open}>
              <Avatar user={u()} size={84} presence />
              <span class="profile-avatar-hint">{t('View profile')}</span>
            </button>
            <StatusBubble userId={u().id} />
          </div>
          <div class="profile-body">
            <h3>
              {nameOf(u().id)}
              <BirthdayCake userId={u().id} />
            </h3>
            <div class="profile-username">
              {u().username}
              <Show when={u().pronouns}>
                <span class="pronouns">{u().pronouns}</span>
              </Show>
              <Show when={u().bot}>
                <span class="bot-tag">{t('BOT')}</span>
              </Show>
              <Show when={rel() === Rel.Friend}>
                <span class="tag">{t('Friend')}</span>
              </Show>
            </div>
            <BadgeStrip userId={u().id} />
            <Show when={gameOf(u().id)}>
              {(a) => (
                <div class="profile-section">
                  <GameCard activity={a()} userId={u().id} />
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
            <Show when={full()?.links?.length}>
              <div class="profile-section">
                <ProfileLinks links={full()!.links!} />
              </div>
            </Show>
            <Show when={full()}>
              <div class="profile-section">
                <div class="label">{t('Pottira member since')}</div>
                <p>{longDate(full()!.created_at)}</p>
              </div>
              <Show when={servers().length || full()!.mutual_friends?.length}>
                <div class="profile-section">
                  <button class="dm-profile-mutual" onClick={open}>
                    {[
                      servers().length ? plural(servers().length, '{n} Mutual Server', '{n} Mutual Servers') : '',
                      full()!.mutual_friends?.length
                        ? plural(full()!.mutual_friends.length, '{n} Mutual Friend', '{n} Mutual Friends')
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </button>
                </div>
              </Show>
            </Show>
            <div class="profile-actions">
              <button class="btn" onClick={open}>
                {t('View full profile')}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

/**
 * The card on the right of a full profile, as tall as the profile card: favorite games, Kass's top songs and the
 * stats card, one at a time (tabs when there's more than one), each scrolling inside.
 */
function SideCard(p: { tabs: { id: string; label: string; body: () => JSX.Element }[] }) {
  const [tab, setTab] = createSignal('');
  const current = () => p.tabs.find((x) => x.id === tab()) ?? p.tabs[0];
  return (
    <aside class="modal games-card side-card" aria-label={current()?.label}>
      <div class="games-card-inner">
        <Show when={p.tabs.length > 1}>
          <nav class="side-card-tabs">
            <div class="side-card-tabs-track" role="tablist">
              <For each={p.tabs}>
                {(x) => (
                  <button
                    role="tab"
                    aria-selected={current()?.id === x.id}
                    classList={{ active: current()?.id === x.id }}
                    onClick={(e) => {
                      setTab(x.id);
                      // Only matters when the labels overflow (long translations): keep the chosen one in view.
                      e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                    }}
                  >
                    {x.label}
                  </button>
                )}
              </For>
            </div>
          </nav>
        </Show>
        <Show when={current()} keyed>
          {(c) => c.body()}
        </Show>
      </div>
    </aside>
  );
}

interface FullProfile {
  user: User;
  /** Older servers leave it out. */
  favorite_games?: FavoriteGame[];
  links?: ProfileLink[];
  /** Your private note about them ('' = none). */
  note?: string;
  song?: ProfileSong | null;
  /** Present when they show it (yours always, with show_top_songs / show_stats saying whether others see it). */
  top_songs?: TopSong[];
  stats?: PublicStats;
  /** Older servers leave it out. */
  snowballs?: Snowballs;
  /** The badges they show (older servers leave it out). */
  badges?: Badge[];
  show_top_songs?: boolean;
  show_stats?: boolean;
  /** The linked Riot ID, when they show the League widget (yours always, with show_league). */
  league?: LeagueAccount | null;
  show_league?: boolean;
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
    (id) =>
      api<FullProfile>('GET', `/users/${id}/profile`).then((f) => {
        if (f.badges) rememberBadges(id, f.badges);
        return f;
      }),
  );
  const user = () => state.users[p.userId] ?? full()?.user;
  // Their server profile (picture, banner, about me) when opened from a server.
  const shown = () => profileOf(p.userId, p.guildId) ?? user();
  const isMe = () => p.userId === state.me?.id;
  // Happy birthday: confetti once, as the profile opens.
  onMount(() => isBirthdayToday(user()?.birthday) && confetti(2));
  const rel = () => state.relationships[p.userId];
  const joined = () => (p.guildId ? state.members[p.guildId]?.[p.userId]?.joined_at : undefined);
  const close = () => setUi('modal', null);
  const servers = () => (full()?.mutual_guilds ?? []).filter((id) => state.guilds[id]);
  const friends = () => full()?.mutual_friends ?? [];
  // The card on the right is always there, from the first frame: the profile moving over once it had loaded was a
  // visible jump. It starts on favorite games, which are worth a card even when there are none yet.
  const games = () => full()?.favorite_games ?? [];
  // Others' Kass songs only when there are some; yours always (it says how to fill it).
  const songs = () => full()?.top_songs;
  const showSongs = () => !!songs() && (songs()!.length > 0 || isMe());
  // REC clips: a tab when they shared some (yours always, it says how).
  const [clips] = createResource(
    () => p.userId,
    (id) => api<{ clips: SharedClip[]; hidden: boolean }>('GET', `/users/${id}/clips`).catch(() => null),
  );
  const showClips = () => !!clips() && (clips()!.clips.length > 0 || isMe());
  const picture = () => media(shown()?.avatar);
  return (
    <div class="profile-modal-wrap">
      <div class="modal profile-modal" role="dialog" aria-label={t('Profile')}>
        <Show when={user()}>
          {(u) => (
            <>
              <div class="profile-banner big" style={{ 'background-color': accentCss(u().accent_color) }}>
                <Show when={media(shown()?.banner)}>{(src) => <BannerImage src={src()} />}</Show>
                <button class="icon-btn modal-close" aria-label={t('Close')} onClick={close}>
                  <I.Close size={18} />
                </button>
              </div>
              <div class="profile-modal-head">
                <div class="profile-avatar-row">
                  <button
                    class="profile-avatar big"
                    aria-label={t('View picture')}
                    disabled={!picture()}
                    onClick={() => setUi('lightbox', picture()!)}
                  >
                    <Avatar user={u()} size={120} presence guildId={p.guildId} />
                  </button>
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
                    <Show when={!u().bot && rel() !== Rel.Friend && rel() !== Rel.Blocked && rel() !== Rel.Outgoing}>
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
                <h2>
                  {nameOf(u().id, p.guildId)}
                  <BirthdayCake userId={u().id} />
                </h2>
                <div class="profile-username">
                  {u().username}
                  <Show when={u().pronouns}>
                    <span class="pronouns">{u().pronouns}</span>
                  </Show>
                  <Show when={rel() === Rel.Friend}>
                    <span class="tag">{t('Friend')}</span>
                  </Show>
                </div>
                <BadgeChips userId={u().id} badges={full()?.badges} />
                <Show when={full()?.song}>
                  {(song) => <SongPlayer song={song()} autoplay={isMe() ? false : undefined} />}
                </Show>
                <nav class="profile-tabs">
                  <button classList={{ active: tab() === 'about' }} onClick={() => setTab('about')}>
                    {t('About Me')}
                  </button>
                  <Show when={!isMe()}>
                    <button classList={{ active: tab() === 'servers' }} onClick={() => setTab('servers')}>
                      {full()
                        ? plural(servers().length, '{n} Mutual Server', '{n} Mutual Servers')
                        : t('Mutual Servers')}
                    </button>
                    <button classList={{ active: tab() === 'friends' }} onClick={() => setTab('friends')}>
                      {full()
                        ? plural(friends().length, '{n} Mutual Friend', '{n} Mutual Friends')
                        : t('Mutual Friends')}
                    </button>
                  </Show>
                </nav>
                <div class="profile-tab-body">
                  <Switch>
                    <Match when={tab() === 'about'}>
                      <Show when={gameOf(u().id)}>
                        {(a) => (
                          <div class="profile-section">
                            <GameCard activity={a()} userId={u().id} />
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
                      <Show when={shown()?.bio}>
                        <div class="profile-section">
                          <p class="bio">{shown()!.bio}</p>
                        </div>
                      </Show>
                      <Show when={full()?.links?.length}>
                        <div class="profile-section">
                          <ProfileLinks links={full()!.links!} />
                        </div>
                      </Show>
                      <div class="profile-dates">
                        <Show when={full()}>
                          <div class="profile-section">
                            <div class="label">{t('Pottira member since')}</div>
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
                        <Show when={formatBirthday(u().birthday)}>
                          <div class="profile-section">
                            <div class="label">{t('Birthday')}</div>
                            <p>
                              {formatBirthday(u().birthday)}
                              <BirthdayCake userId={u().id} />
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
                      <Show when={!isMe() && !u().bot && full()}>
                        <div class="profile-section">
                          <NoteField userId={u().id} initial={full()!.note ?? ''} />
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
        <Snowman />
      </div>
      <Show when={user()}>
        {(u) => (
          <SideCard
            tabs={[
              {
                id: 'games',
                label: t('Games'),
                body: () => (
                  <FavoriteGamesCard
                    bare
                    userId={u().id}
                    name={nameOf(u().id, p.guildId)}
                    games={games()}
                    isMe={isMe()}
                    loading={!full()}
                  />
                ),
              },
              ...(showSongs()
                ? [
                    {
                      id: 'songs',
                      label: t('Top songs'),
                      body: () => <TopSongsCard songs={songs()!} isMe={isMe()} shown={full()?.show_top_songs} />,
                    },
                  ]
                : []),
              ...(showClips()
                ? [
                    {
                      id: 'clips',
                      label: t('Clips'),
                      body: () => <RecentClipsCard clips={clips()!.clips} isMe={isMe()} hidden={clips()!.hidden} />,
                    },
                  ]
                : []),
              ...(full()?.snowballs && (isChristmas() || full()!.snowballs!.thrown || full()!.snowballs!.taken)
                ? [
                    {
                      id: 'snowballs',
                      label: t('Snowballs'),
                      body: () => <SnowballsCard snowballs={full()!.snowballs!} />,
                    },
                  ]
                : []),
              ...(full()?.league
                ? [
                    {
                      id: 'league',
                      label: t('League'),
                      body: () => (
                        <LeagueCard
                          userId={u().id}
                          account={full()!.league!}
                          isMe={isMe()}
                          shown={full()?.show_league}
                        />
                      ),
                    },
                  ]
                : []),
              ...(full()?.stats
                ? [
                    {
                      id: 'stats',
                      label: t('Stats'),
                      body: () => <StatsCard stats={full()!.stats!} isMe={isMe()} shown={full()?.show_stats} />,
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Show>
    </div>
  );
}
