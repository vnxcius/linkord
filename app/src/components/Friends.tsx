import { createSignal, For, Match, Show, Switch } from 'solid-js';
import { friendRequest, friendRequestByName, openDm, removeRelationship } from '../lib/actions';
import { msg, t } from '../lib/i18n';
import { customStatusOf, gameOf, nameOf, presenceOf, spotifyOf, state } from '../lib/store';
import { Rel } from '../lib/types';
import { attempt, isNarrow, openMenu, openProfile } from '../lib/ui';
import { CustomStatusView, GameCard, GameIcon, SpotifyCard, SpotifyIcon } from './Activity';
import { Avatar } from './Avatar';
import { ChristmasTree } from './ChristmasArt';
import { HolidayCountdown } from './Christmas';
import { SidebarResize } from './SidebarResize';
import * as I from './Icons';
import { MobileBack } from './Chat';
import { friendItems } from './Profile';

type Tab = 'online' | 'all' | 'pending' | 'blocked' | 'add';

const STATUS_LABEL: Record<string, string> = {
  online: msg('Online'),
  idle: msg('Idle'),
  dnd: msg('Do Not Disturb'),
  offline: msg('Offline'),
};

export function Friends() {
  const [tab, setTab] = createSignal<Tab>('online');
  const ids = (pred: (r: Rel) => boolean) =>
    Object.entries(state.relationships)
      .filter(([, r]) => pred(r))
      .map(([id]) => id)
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const friends = () => ids((r) => r === Rel.Friend);
  const online = () => friends().filter((id) => presenceOf(id) !== 'offline');
  const pending = () => ids((r) => r === Rel.Incoming || r === Rel.Outgoing);
  const blocked = () => ids((r) => r === Rel.Blocked);
  const incoming = () => pending().filter((id) => state.relationships[id] === Rel.Incoming).length;

  const list = () => ({ online: online(), all: friends(), pending: pending(), blocked: blocked(), add: [] })[tab()];
  const title = () =>
    ({
      online: t('Online — {n}', { n: online().length }),
      all: t('All friends — {n}', { n: friends().length }),
      pending: t('Pending — {n}', { n: pending().length }),
      blocked: t('Blocked — {n}', { n: blocked().length }),
      add: '',
    })[tab()];

  return (
    <div class="friends">
      <header class="chat-header friends-header">
        <MobileBack />
        <I.Users size={22} class="muted friends-head-icon" />
        <h2>{t('Friends')}</h2>
        <span class="header-sep" />
        <nav class="tabs">
          <button classList={{ active: tab() === 'online' }} onClick={() => setTab('online')}>
            {t('Online')}
          </button>
          <button classList={{ active: tab() === 'all' }} onClick={() => setTab('all')}>
            {t('All')}
          </button>
          <button classList={{ active: tab() === 'pending' }} onClick={() => setTab('pending')}>
            {t('Pending')}
            <Show when={incoming()}>
              <span class="badge">{incoming()}</span>
            </Show>
          </button>
          <button classList={{ active: tab() === 'blocked' }} onClick={() => setTab('blocked')}>
            {t('Blocked')}
          </button>
          <button class="add-friend-tab" classList={{ active: tab() === 'add' }} onClick={() => setTab('add')}>
            {t('Add Friend')}
          </button>
        </nav>
      </header>
      <HolidayCountdown />
      <div class="friends-main">
        <div class="friends-body">
          <Show when={tab() !== 'add'} fallback={<AddFriend />}>
            <div class="group-title">{title()}</div>
            <For
              each={list()}
              fallback={
                <div class="friends-empty">
                  <p class="muted">
                    <Switch>
                      <Match when={tab() === 'pending'}>{t('No pending friend requests.')}</Match>
                      <Match when={tab() === 'blocked'}>{t("You haven't blocked anyone.")}</Match>
                      <Match when={tab() === 'online'}>{t('None of your friends are online right now.')}</Match>
                      <Match when={true}>{t('No friends yet. Add someone by their Discord username.')}</Match>
                    </Switch>
                  </p>
                  <Show when={tab() !== 'blocked'}>
                    <button class="btn primary" onClick={() => setTab('add')}>
                      {t('Add Friend')}
                    </button>
                  </Show>
                </div>
              }
            >
              {(id) => <FriendRow id={id} />}
            </For>
          </Show>
        </div>
        <Show when={!isNarrow()}>
          <ActiveNow />
        </Show>
      </div>
    </div>
  );
}

/** Discord's "Active Now" column: friends who are doing something (playing a game, listening to Spotify). */
function ActiveNow() {
  const active = () =>
    Object.entries(state.relationships)
      .filter(([id, r]) => r === Rel.Friend && (gameOf(id) || spotifyOf(id)))
      .map(([id]) => id)
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  return (
    <>
      <SidebarResize side="margin" inline />
      <aside class="active-now">
        <h3>{t('Active Now')}</h3>
        <For
          each={active()}
          fallback={
            <div class="active-empty">
              <strong>{t("It's quiet for now…")}</strong>
              <p class="muted small">
                {t("When a friend starts playing a game or listening to Spotify, you'll see it here.")}
              </p>
            </div>
          }
        >
          {(id) => (
            <div class="active-card">
              <button class="active-user" onClick={(e) => openProfile(id, e)}>
                <Avatar user={state.users[id]} size={32} presence />
                <span class="grow">
                  <strong>{nameOf(id)}</strong>
                  <span class="muted small">{gameOf(id)?.name ?? 'Spotify'}</span>
                </span>
                <Show when={gameOf(id)} fallback={<SpotifyIcon size={16} />}>
                  {(g) => <GameIcon src={g().icon} size={20} />}
                </Show>
              </button>
              <Show when={gameOf(id)}>{(a) => <GameCard activity={a()} userId={id} compact />}</Show>
              <Show when={spotifyOf(id)}>{(a) => <SpotifyCard activity={a()} compact />}</Show>
            </div>
          )}
        </For>
        <ChristmasTree />
      </aside>
    </>
  );
}

function FriendRow(p: { id: string }) {
  const rel = () => state.relationships[p.id];
  const u = () => state.users[p.id];
  const sub = () => {
    if (rel() === Rel.Incoming) return t('Incoming friend request');
    if (rel() === Rel.Outgoing) return t('Outgoing friend request');
    if (rel() === Rel.Blocked) return t('Blocked');
    const custom = customStatusOf(p.id);
    if (custom) return <CustomStatusView status={custom} />;
    const game = gameOf(p.id);
    if (game) return t('Playing {name}', { name: game.name });
    if (spotifyOf(p.id)) return t('Listening to {name}', { name: 'Spotify' });
    return t(STATUS_LABEL[presenceOf(p.id)]);
  };
  return (
    <div
      class="friend-row"
      onContextMenu={(e) => openMenu(e, friendItems(p.id))}
      onClick={() => rel() === Rel.Friend && void attempt(() => openDm(p.id))}
    >
      <Avatar user={u()} size={36} presence={rel() === Rel.Friend} />
      <div class="friend-names">
        <strong>{nameOf(p.id)}</strong>
        <span class="muted small">
          {u()?.username} · {sub()}
        </span>
      </div>
      <div class="friend-actions" onClick={(e) => e.stopPropagation()}>
        <Switch>
          <Match when={rel() === Rel.Friend}>
            <button class="round-icon" data-tip={t('Message')} onClick={() => void attempt(() => openDm(p.id))}>
              <I.Thread size={18} />
            </button>
            <button class="round-icon" data-tip={t('More')} onClick={(e) => openMenu(e, friendItems(p.id))}>
              ⋯
            </button>
          </Match>
          <Match when={rel() === Rel.Incoming}>
            <button
              class="round-icon accept"
              data-tip={t('Accept')}
              onClick={() => void attempt(() => friendRequest(p.id), t('Friend added'))}
            >
              ✓
            </button>
            <button
              class="round-icon decline"
              data-tip={t('Ignore')}
              onClick={() => void attempt(() => removeRelationship(p.id))}
            >
              <I.Close size={16} />
            </button>
          </Match>
          <Match when={rel() === Rel.Outgoing}>
            <button
              class="round-icon decline"
              data-tip={t('Cancel')}
              onClick={() => void attempt(() => removeRelationship(p.id))}
            >
              <I.Close size={16} />
            </button>
          </Match>
          <Match when={rel() === Rel.Blocked}>
            <button class="btn ghost" onClick={() => void attempt(() => removeRelationship(p.id))}>
              {t('Unblock')}
            </button>
          </Match>
        </Switch>
      </div>
    </div>
  );
}

function AddFriend() {
  const [name, setName] = createSignal('');
  const [result, setResult] = createSignal<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: Event) => {
    e.preventDefault();
    const username = name().trim();
    if (!username) return;
    try {
      await friendRequestByName(username);
      setResult({ ok: true, text: t('Success! Your friend request to {username} was sent.', { username }) });
      setName('');
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    }
  };
  return (
    <div class="add-friend">
      <h3>{t('Add Friend')}</h3>
      <p class="muted">
        {t('You can add friends with their Discord username. They need to have signed in to Pottira once.')}
      </p>
      <form class="add-friend-box" classList={{ ok: result()?.ok, err: result()?.ok === false }} onSubmit={submit}>
        <input
          value={name()}
          onInput={(e) => (setName(e.currentTarget.value), setResult(null))}
          placeholder={t('You can add friends with their username.')}
          autofocus
        />
        <button class="btn primary" disabled={!name().trim()}>
          {t('Send Friend Request')}
        </button>
      </form>
      <Show when={result()}>
        <p class={result()!.ok ? 'success' : 'error'}>{result()!.text}</p>
      </Show>
      <div class="divider" />
      <p class="muted small">
        {t('Tip: group chats with up to 10 friends start from the')} <strong>+</strong> {t('next to Direct Messages.')}
      </p>
    </div>
  );
}
