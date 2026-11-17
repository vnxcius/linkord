// Every account, and one page per person (#/people/<id>): what they have and did, the servers they're in, their badges,
// suspending them, and deleting their account for good. Changes go through the app (internal.rs), so connected apps
// hear about them. Message text is deliberately not available here.
import { createEffect, createResource, createSignal, For, on, Show } from 'solid-js';
import { ago, api, bytes, count, date, dateTime, duration, failed, go, href, type J, route, setCrumb, toast, usePoll } from '../lib';
import { Avatar, Dialog, I, Notice, Page, Section, Stat } from '../ui';
import { useDebounced } from './Servers';

/** The badges an admin gives (the app's badges.rs MANUAL), as the app names them. */
const MANUAL_BADGES: [string, string][] = [
  ['bug_hunter', 'Bug Hunter'],
  ['tester', 'Tester'],
  ['contributor', 'Contributor'],
  ['helper', 'Helper'],
];

const FILTERS = [
  { id: 'all', label: 'Everyone' },
  { id: 'active', label: 'Active' },
  { id: 'suspended', label: 'Suspended' },
  { id: 'deleted', label: 'Deleted' },
  { id: 'bots', label: 'Bots' },
] as const;

const tagsOf = (u: J) => [u.bot && 'Bot', u.deleted_at && 'Deleted', u.suspended_at && 'Suspended'].filter(Boolean) as string[];
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

function DeleteDialog(p: { person: J; onClose: () => void }) {
  const u = () => p.person.account;
  const owned = () => (p.person.servers as J[]).filter((s) => s.owner);
  const [typed, setTyped] = createSignal('');
  const [withServers, setWithServers] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const ready = () => typed().trim() === u().username && (!owned().length || withServers()) && !busy();
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!ready()) return;
    setBusy(true);
    setError('');
    try {
      const done = await api('POST', '/moderation/accounts/delete', { user_id: u().id, confirm: typed().trim(), with_servers: withServers() });
      const parts = [done.messages ? plural(done.messages, 'message') : '', done.servers ? plural(done.servers, 'server') : '', done.clips ? plural(done.clips, 'clip') : ''].filter(Boolean);
      const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
      toast(list ? `${u().username} is deleted for good, along with ${list}.` : `${u().username} is deleted for good.`);
      go('people');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'It could not be deleted.');
      setBusy(false);
    }
  };
  return (
    <Dialog title="Delete this account for good" onClose={p.onClose} danger>
      <form class="dialog-body" onSubmit={submit}>
        <div class="person dialog-person">
          <Avatar url={u().avatar} name={u().username} />
          <span>
            <b>{u().name ?? u().username}</b>
            <Show when={u().name && u().name !== u().username}>
              <span class="muted small mono"> {u().username}</span>
            </Show>
          </span>
        </div>
        <p>This can't be undone. Unlike deleting from the app, nothing of theirs is left behind:</p>
        <ul class="consequences">
          <li>
            <b>{plural(u().messages, 'message')}</b> they wrote, everywhere, and <b>{plural(u().media, 'file')}</b> attached to them
          </li>
          <li>
            <b>{plural(p.person.direct_conversations, 'direct conversation')}</b>, for the other person too
            <Show when={p.person.group_conversations}>; they leave {plural(p.person.group_conversations, 'group')}</Show>
          </li>
          <li>Their profile, pictures, {plural(p.person.clips, 'shared clip')}, friends, notes, badges and settings</li>
          <li>Their place in {plural(u().servers_joined - owned().length, 'server')}. Emoji and sounds they added stay with each server's owner.</li>
        </ul>
        <Show when={owned().length}>
          <div class="owned-box">
            <p>
              <b>They own {plural(owned().length, 'server')}.</b> Those have to go too:
            </p>
            <ul class="plain-list">
              <For each={owned()}>
                {(s: J) => (
                  <li>
                    <span class="person">
                      <Avatar url={s.icon} name={s.name} />
                      {s.name}
                    </span>
                    <span class="muted mono small">{plural(s.members, 'person', 'people')}</span>
                  </li>
                )}
              </For>
            </ul>
            <label class="check">
              <input type="checkbox" checked={withServers()} onChange={(e) => setWithServers(e.currentTarget.checked)} />
              Delete {owned().length === 1 ? 'this server' : `these ${owned().length} servers`} and everything in them
            </label>
          </div>
        </Show>
        <p class="muted small">If they sign in with Discord again, they start over with a new, empty account. To keep them out, suspend them instead.</p>
        <label class="field">
          <span>
            Type <b class="mono">{u().username}</b> to confirm
          </span>
          <input autofocus autocomplete="off" spellcheck={false} value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} />
        </label>
        <Show when={error()}>
          <p class="error" role="alert">
            {error()}
          </p>
        </Show>
        <footer class="dialog-actions">
          <button type="button" class="btn" onClick={p.onClose}>
            Keep it
          </button>
          <button class="btn danger solid" disabled={!ready()}>
            <I.trash size={16} /> {busy() ? 'Deleting…' : 'Delete for good'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

function PersonPage(p: { id: string }) {
  const [d, { refetch }] = createResource(
    () => p.id,
    (id) => api<J>('GET', `/moderation/accounts/${id}`),
  );
  const [deleting, setDeleting] = createSignal(false);
  const u = () => d()?.account;
  createEffect(() => setCrumb(u() ? (u().name ?? u().username) : ''));
  const live = () => u() && !u().bot && !u().deleted_at;

  const setSuspended = async () => {
    const suspend = !u().suspended_at;
    if (suspend && !confirm(`Suspend ${u().username}? They're signed out everywhere and can't sign in until restored.`)) return;
    try {
      await api('POST', '/moderation/accounts/suspend', { user_id: u().id, suspended: suspend });
      toast(suspend ? `${u().username} is suspended.` : `${u().username} can sign in again.`);
      void refetch();
    } catch (e) {
      failed(e);
    }
  };
  const setBadge = async (id: string, label: string, given: boolean) => {
    if (!given && !confirm(`Take ${label} away from ${u().username}?`)) return;
    try {
      await api('POST', '/moderation/accounts/badge', { user_id: u().id, badge: id, given });
      toast(given ? `${label} given to ${u().username}.` : `${label} taken away from ${u().username}.`);
      void refetch();
    } catch (e) {
      failed(e);
    }
  };

  return (
    <Page
      back={{ href: href('people'), label: 'All people' }}
      title={u() ? (u().name ?? u().username) : d.error ? 'Person' : '…'}
      figure={<Show when={u()}>{(a) => <Avatar url={a().avatar} name={a().username} size="lg" />}</Show>}
      lead={
        <Show when={u()}>
          {(a) => (
            <span class="lead-line">
              <span class="mono">{a().username}</span>
              <Show when={a().discord_username}>
                <span class="muted"> · Discord {a().discord_username}</span>
              </Show>
              <span class="muted"> · joined {date(a().created_at)}</span>
              <For each={tagsOf(a())}>{(t) => <span class="tag">{t}</span>}</For>
            </span>
          )}
        </Show>
      }
      actions={
        <Show when={u()}>
          <a class="btn" href={href('media', `user-${p.id}`)}>
            <I.photo size={16} /> Their files
          </a>
          <Show when={live()}>
            <button class="btn" classList={{ danger: !u().suspended_at }} onClick={setSuspended}>
              {u().suspended_at ? 'Restore' : 'Suspend'}
            </button>
          </Show>
        </Show>
      }
    >
      <Show when={d.error}>
        <Notice level="warning">{String(d.error?.message ?? d.error)}</Notice>
      </Show>
      <Show when={u()?.suspended_at}>
        <Notice level="warning">Suspended {ago(u().suspended_at)}: they can't sign in until restored.</Notice>
      </Show>
      <Show when={u()?.deleted_at}>
        <Notice>They deleted their account {ago(u().deleted_at)}. What's left is listed below; it can be cleared for good at the bottom.</Notice>
      </Show>
      <Show when={d()}>
        <dl class="stats">
          <Stat label="Messages" value={count(u().messages)} note={u().last_message ? `last ${ago(u().last_message)}` : 'none yet'} />
          <Stat label="Files" value={count(u().media)} note={`${bytes(u().upload_bytes, 0)} of upload space`} />
          <Stat label="Voice" value={duration(u().voice_seconds)} />
          <Stat label="Servers" value={count(u().servers_joined)} note={u().servers_owned ? `created ${u().servers_owned}` : undefined} />
          <Stat label="Conversations" value={count(d()!.direct_conversations + d()!.group_conversations)} note={`${d()!.group_conversations} groups`} />
          <Stat label="Friends" value={count(d()!.friends)} />
          <Stat label="Shared clips" value={count(d()!.clips)} />
          <Stat label="Signed in on" value={plural(u().sessions, 'device')} />
        </dl>

        <Section title="Servers">
          <Show when={d()!.servers.length} fallback={<p class="empty">Not in any server.</p>}>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Server</th>
                    <th class="r">People</th>
                    <th class="r">Their messages</th>
                    <th class="r">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={d()!.servers as J[]}>
                    {(s: J) => (
                      <tr class="clickable" onClick={() => go('servers', s.id)}>
                        <td>
                          <a class="person" href={href('servers', s.id)} onClick={(e) => e.stopPropagation()}>
                            <Avatar url={s.icon} name={s.name} />
                            <span>
                              <b class="cell-name">{s.name}</b>
                              <Show when={s.nickname}>
                                <span class="muted small"> as {s.nickname}</span>
                              </Show>
                              <Show when={s.owner}>
                                <span class="tag">Creator</span>
                              </Show>
                            </span>
                          </a>
                        </td>
                        <td class="r mono">{count(s.members)}</td>
                        <td class="r mono">{count(s.messages)}</td>
                        <td class="r mono nowrap" title={dateTime(s.joined_at)}>
                          {date(s.joined_at)}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Section>

        <Show when={live()}>
          <Section title="Badges" note="The ones an admin hands out. Their apps show the change right away.">
            <span class="badge-toggles">
              <For each={MANUAL_BADGES}>
                {([id, label]) => {
                  const has = () => (u().badges ?? []).includes(id);
                  return (
                    <button class="badge-toggle" aria-pressed={has()} title={has() ? `Take away ${label}` : `Give ${label}`} onClick={() => setBadge(id, label, !has())}>
                      {label}
                    </button>
                  );
                }}
              </For>
            </span>
          </Section>
        </Show>

        <Show when={!u().bot}>
          <section class="danger-zone">
            <div>
              <h2>Delete for good</h2>
              <p class="muted">
                Their messages, files, conversations and the account itself, gone for everyone.
                <Show when={u().servers_owned}> The servers they created would go too.</Show>
              </p>
            </div>
            <button class="btn danger" onClick={() => setDeleting(true)}>
              <I.trash size={16} /> Delete for good…
            </button>
          </section>
        </Show>
      </Show>
      <Show when={deleting() && d()}>
        <DeleteDialog person={d()} onClose={() => setDeleting(false)} />
      </Show>
    </Page>
  );
}

function PeopleList() {
  const summary = usePoll<J>(() => api('GET', '/moderation/summary'), 60000);
  const { query, setQuery, debounced } = useDebounced();
  const [filter, setFilter] = createSignal<(typeof FILTERS)[number]['id']>('all');
  const accounts = usePoll<J>(() => api('GET', `/moderation/accounts?q=${encodeURIComponent(debounced())}&status=${filter()}`), 60000);
  createEffect(on([debounced, filter], () => void accounts.refresh(), { defer: true }));
  const counts = () => (accounts.data()?.counts ?? {}) as Record<string, number>;
  const shown = () => (accounts.data()?.accounts ?? []) as J[];
  const s = () => summary.data();
  const open = (id: string) => go('people', id);

  return (
    <Page title="People" lead="Every account on the server. Open someone to suspend them, give badges or delete their account for good.">
      <dl class="stats">
        <Stat label="Accounts" value={count(s()?.accounts)} note={s() ? `${s().new_accounts_7d} new this week` : undefined} />
        <Stat label="Suspended" value={count(accounts.data() && !debounced() ? counts().suspended : undefined)} />
        <Stat label="Deleted" value={count(s()?.deleted_accounts)} note="by themselves, from the app" />
      </dl>
      <div class="filters" role="search">
        <div class="seg" role="group" aria-label="Who to list">
          <For each={FILTERS}>
            {(f) => (
              <button classList={{ active: filter() === f.id }} aria-pressed={filter() === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
                <span class="seg-count">{count(counts()[f.id] ?? 0)}</span>
              </button>
            )}
          </For>
        </div>
        <div class="search-field grow">
          <I.search size={16} />
          <input type="search" placeholder="Search by name or Discord username" aria-label="Search people" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
        </div>
      </div>
      <Show when={accounts.error()}>
        <Notice level="critical">{accounts.error()}</Notice>
      </Show>
      <Show when={shown().length === 500}>
        <p class="muted small">The newest 500 are listed; search to find anyone else.</p>
      </Show>
      <div class="table-wrap" classList={{ refreshing: accounts.loading() && !!accounts.data() }}>
        <table class="people-table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Discord</th>
              <th class="r">Joined</th>
              <th class="r">Servers</th>
              <th class="r">Messages</th>
              <th class="r">Upload space</th>
              <th class="r">Voice</th>
              <th class="r">Last message</th>
              <th>
                <span class="visually-hidden">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <For
              each={shown()}
              fallback={
                <tr>
                  <td colspan="9" class="empty">
                    {accounts.loading() ? 'Loading…' : 'Nobody matches that.'}
                  </td>
                </tr>
              }
            >
              {(u: J) => (
                <tr class="clickable" tabindex="0" onClick={() => open(u.id)} onKeyDown={(e) => e.key === 'Enter' && open(u.id)}>
                  <td>
                    <a class="person" href={href('people', u.id)} tabindex="-1">
                      <Avatar url={u.avatar} name={u.username} />
                      <span>
                        <span class="cell-name">{u.name ?? u.username}</span>
                        <Show when={u.name && u.name !== u.username}>
                          <span class="muted small mono"> {u.username}</span>
                        </Show>
                        <For each={tagsOf(u)}>{(t) => <span class="tag">{t}</span>}</For>
                      </span>
                    </a>
                  </td>
                  <td class="mono small">{u.discord_username ?? '–'}</td>
                  <td class="r mono nowrap" title={dateTime(u.created_at)}>
                    {date(u.created_at)}
                  </td>
                  <td class="r mono" title={`${u.servers_owned} created, in ${u.servers_joined}`}>
                    {u.servers_joined}
                  </td>
                  <td class="r mono">{count(u.messages)}</td>
                  <td class="r mono nowrap">{bytes(u.upload_bytes, 0)}</td>
                  <td class="r mono nowrap">{Math.round(u.voice_seconds / 3600)} h</td>
                  <td class="r mono nowrap">{u.last_message ? ago(u.last_message) : 'Never'}</td>
                  <td class="r muted">
                    <I.chevron size={15} />
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Page>
  );
}

export function People() {
  return (
    <Show when={route().arg} keyed fallback={<PeopleList />}>
      {(id) => <PersonPage id={id} />}
    </Show>
  );
}
