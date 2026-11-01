// Everyone and everything on the server: how many servers, who created them, who's in them. Clicking a server opens
// its people, channels and invites. Message text is deliberately not available here.
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { Columns } from '../charts';
import { ago, api, bytes, count, date, dateTime, go, type J, mediaUrl, route, usePoll } from '../lib';
import { Notice, Page, Section, Stat } from '../ui';

const KIND: Record<number, string> = { 0: 'Text', 2: 'Voice', 4: 'Category', 11: 'Thread' };

export function Avatar(p: { url?: string | null; name: string; square?: boolean }) {
  const [failed, setFailed] = createSignal(false);
  const src = () => mediaUrl(p.url);
  return (
    <span class="avatar" aria-hidden="true">
      <Show when={src() && !failed()} fallback={<span>{p.name.slice(0, 1).toUpperCase()}</span>}>
        <img src={src()} alt="" loading="lazy" onError={() => setFailed(true)} />
      </Show>
    </span>
  );
}

function ServerDetail(p: { id: string; server: J }) {
  const [d] = createResource(
    () => p.id,
    (id) => api<J>('GET', `/moderation/servers/${id}`),
  );
  return (
    <div class="detail">
      <Show when={d.error}>
        <Notice level="warning">{String(d.error?.message ?? d.error)}</Notice>
      </Show>
      <div class="detail-actions">
        <button class="btn" onClick={() => go('media', p.id)}>
          See this server's media
        </button>
      </div>
      <Show when={d()}>
        <div class="two-col">
          <div>
            <h3 class="label">Channels ({d()!.channels.length})</h3>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Type</th>
                    <th class="r">Messages</th>
                    <th class="r">Media</th>
                    <th class="r">Last message</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={d()!.channels as J[]}>
                    {(c: J) => (
                      <tr>
                        <td class="wrap">{c.name || '(no name)'}</td>
                        <td class="small muted nowrap">{KIND[c.kind] ?? c.kind}</td>
                        <td class="r mono">{count(c.messages)}</td>
                        <td class="r mono">{count(c.media)}</td>
                        <td class="r mono nowrap">{c.last_message ? ago(c.last_message) : '–'}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <h3 class="label">People ({d()!.members.length})</h3>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Person</th>
                    <th class="r">Messages</th>
                    <th class="r">Roles</th>
                    <th class="r">Joined</th>
                <th><span class="sr-only">Actions</span></th>
              </tr>
                </thead>
                <tbody>
                  <For each={d()!.members as J[]}>
                    {(m: J) => (
                      <tr>
                        <td class="wrap">
                          <span class="person">
                            <Avatar url={m.avatar} name={m.username} />
                            <span>
                              {m.nickname ?? m.name ?? m.username}
                              <span class="muted small mono"> {m.username}</span>
                              <Show when={m.owner}>
                                <span class="tag">Creator</span>
                              </Show>
                              <Show when={m.bot}>
                                <span class="tag">Bot</span>
                              </Show>
                              <Show when={m.deleted}>
                                <span class="tag">Deleted</span>
                              </Show>
                            </span>
                          </span>
                        </td>
                        <td class="r mono">{count(m.messages)}</td>
                        <td class="r mono">{m.roles}</td>
                        <td class="r mono nowrap" title={dateTime(m.joined_at)}>
                          {date(m.joined_at)}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <h3 class="label">Invites ({d()!.invites.length})</h3>
        <Show when={d()!.invites.length} fallback={<p class="empty">No invites.</p>}>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Created by</th>
                  <th class="r">Used</th>
                  <th class="r">Expires</th>
                  <th class="r">Created</th>
                </tr>
              </thead>
              <tbody>
                <For each={d()!.invites as J[]}>
                  {(i: J) => (
                    <tr>
                      <td class="mono">{i.code}</td>
                      <td class="mono small">{i.creator}</td>
                      <td class="r mono">
                        {i.uses}
                        {i.max_uses ? ` / ${i.max_uses}` : ''}
                      </td>
                      <td class="r mono nowrap">{i.expires_at ? date(i.expires_at) : 'Never'}</td>
                      <td class="r mono nowrap">{date(i.created_at)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Show>
    </div>
  );
}

export function Servers() {
  const summary = usePoll<J>(() => api('GET', '/moderation/summary'), 60000);
  const [view, setView] = createSignal<'servers' | 'accounts'>(route().arg === 'accounts' ? 'accounts' : 'servers');
  const [query, setQuery] = createSignal('');
  const [debounced, setDebounced] = createSignal('');
  let timer: number | undefined;
  createEffect(
    on(query, (q) => {
      clearTimeout(timer);
      timer = window.setTimeout(() => setDebounced(q), 250);
    }),
  );
  onCleanup(() => clearTimeout(timer));
  const servers = usePoll<J>(() => api('GET', `/moderation/servers?q=${encodeURIComponent(debounced())}`), 60000);
  const accounts = usePoll<J>(() => api('GET', `/moderation/accounts?q=${encodeURIComponent(debounced())}`), 60000);
  const setSuspended = async (u: J) => {
    const suspend = !u.suspended_at;
    if (suspend && !confirm(`Suspend ${u.username}? They're signed out everywhere and can't sign in until restored.`)) return;
    try {
      await api('POST', '/moderation/accounts/suspend', { user_id: u.id, suspended: suspend });
      void accounts.refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  };
  createEffect(
    on(
      debounced,
      () => {
        void servers.refresh();
        void accounts.refresh();
      },
      { defer: true },
    ),
  );
  const [open, setOpen] = createSignal<string | null>(null);
  const s = () => summary.data();
  const days = () => {
    const counts = new Map(((s()?.messages_per_day ?? []) as J[]).map((d) => [d.day, d.count]));
    if (!s()) return [];
    return Array.from({ length: 30 }, (_, i) => {
      const day = new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10);
      return { label: day, parts: [counts.get(day) ?? 0] };
    });
  };

  return (
    <Page title="Servers and people" lead="Every server, who created it and who's in it. Message text isn't available here.">
      <Show when={summary.error()}>
        <Notice level="critical">{summary.error()}</Notice>
      </Show>
      <Section title="In total">
        <dl class="stats">
          <Stat label="Servers" value={count(s()?.servers)} note={s() ? `${count(s().channels)} channels` : undefined} />
          <Stat label="Accounts" value={count(s()?.accounts)} note={s() ? `${s().new_accounts_7d} new this week, ${s().deleted_accounts} deleted` : undefined} />
          <Stat label="Messages" value={count(s()?.messages)} note={s() ? `${count(s().messages_24h)} today, ${count(s().messages_7d)} this week` : undefined} />
          <Stat label="Direct conversations" value={count(s()?.direct_channels)} />
          <Stat label="Open invites" value={count(s()?.invites)} />
          <Stat label="Custom emoji" value={count(s()?.emojis)} note={s() ? `${s().sounds} sounds` : undefined} />
          <Stat label="Upload space used" value={bytes(s()?.quota_used)} />
        </dl>
        <Show when={days().length}>
          <h3 class="label">Messages per day, last 30 days</h3>
          <Columns title="Messages per day" rows={days()} parts={[{ name: 'Messages', cls: 'fill-s1' }]} height={72} />
        </Show>
      </Section>

      <div class="filters" role="search">
        <div class="seg" role="group" aria-label="What to list">
          <button classList={{ active: view() === 'servers' }} aria-pressed={view() === 'servers'} onClick={() => setView('servers')}>
            Servers
          </button>
          <button classList={{ active: view() === 'accounts' }} aria-pressed={view() === 'accounts'} onClick={() => setView('accounts')}>
            Accounts
          </button>
        </div>
        <input class="grow" type="search" placeholder={view() === 'servers' ? 'Search by server or creator' : 'Search by name or Discord username'} aria-label="Search" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
      </div>

      <Show when={view() === 'servers'}>
        <div class="table-wrap" classList={{ refreshing: servers.loading() && !!servers.data() }}>
          <table class="server-table">
            <thead>
              <tr>
                <th>Server</th>
                <th>Created by</th>
                <th class="r">Created</th>
                <th class="r">People</th>
                <th class="r">Channels</th>
                <th class="r">Messages</th>
                <th class="r">Media</th>
                <th class="r">Last message</th>
              </tr>
            </thead>
            <tbody>
              <For each={(servers.data()?.servers ?? []) as J[]} fallback={<tr><td colspan="8" class="empty">{servers.loading() ? 'Loading…' : debounced() ? 'No server matches that.' : 'There are no servers yet.'}</td></tr>}>
                {(g: J) => (
                  <>
                    <tr class="clickable" classList={{ open: open() === g.id }} onClick={() => setOpen(open() === g.id ? null : g.id)} tabindex="0" aria-expanded={open() === g.id} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(open() === g.id ? null : g.id))}>
                      <td>
                        <span class="person">
                          <Avatar url={g.icon} name={g.name} />
                          <b class="cell-name">{g.name}</b>
                        </span>
                      </td>
                      <td>
                        <span class="person">
                          <Avatar url={g.owner.avatar} name={g.owner.username} />
                          <span>
                            {g.owner.name ?? g.owner.username}
                            <span class="muted small mono"> {g.owner.username}</span>
                            <Show when={g.owner.deleted}>
                              <span class="tag">Deleted</span>
                            </Show>
                          </span>
                        </span>
                      </td>
                      <td class="r mono nowrap" title={dateTime(g.created_at)}>
                        {date(g.created_at)}
                      </td>
                      <td class="r mono">{count(g.members)}</td>
                      <td class="r mono">{g.text_channels + g.voice_channels}</td>
                      <td class="r mono">{count(g.messages)}</td>
                      <td class="r mono nowrap" title={`${g.media} files`}>
                        {bytes(g.media_bytes, 0)}
                      </td>
                      <td class="r mono nowrap">{g.last_message ? ago(g.last_message) : 'Never'}</td>
                    </tr>
                    <Show when={open() === g.id}>
                      <tr class="detail-row">
                        <td colspan="8">
                          <ServerDetail id={g.id} server={g} />
                        </td>
                      </tr>
                    </Show>
                  </>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>

      <Show when={view() === 'accounts'}>
        <div class="table-wrap" classList={{ refreshing: accounts.loading() && !!accounts.data() }}>
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Discord</th>
                <th class="r">Joined</th>
                <th class="r">Created</th>
                <th class="r">In</th>
                <th class="r">Messages</th>
                <th class="r">Media</th>
                <th class="r">Upload space</th>
                <th class="r">Voice</th>
                <th class="r">Last message</th>
              </tr>
            </thead>
            <tbody>
              <For each={(accounts.data()?.accounts ?? []) as J[]} fallback={<tr><td colspan="11" class="empty">{accounts.loading() ? 'Loading…' : 'No account matches that.'}</td></tr>}>
                {(u: J) => (
                  <tr>
                    <td>
                      <span class="person">
                        <Avatar url={u.avatar} name={u.username} />
                        <span>
                          {u.name ?? u.username}
                          <span class="muted small mono"> {u.username}</span>
                          <Show when={u.bot}>
                            <span class="tag">Bot</span>
                          </Show>
                          <Show when={u.deleted_at}>
                            <span class="tag">Deleted</span>
                          </Show>
                          <Show when={u.suspended_at}>
                            <span class="tag">Suspended</span>
                          </Show>
                        </span>
                      </span>
                    </td>
                    <td class="mono small">{u.discord_username ?? '–'}</td>
                    <td class="r mono nowrap" title={dateTime(u.created_at)}>
                      {date(u.created_at)}
                    </td>
                    <td class="r mono">{u.servers_owned}</td>
                    <td class="r mono">{u.servers_joined}</td>
                    <td class="r mono">{count(u.messages)}</td>
                    <td class="r mono">{count(u.media)}</td>
                    <td class="r mono nowrap">{bytes(u.upload_bytes, 0)}</td>
                    <td class="r mono nowrap">{Math.round(u.voice_seconds / 3600)} h</td>
                    <td class="r mono nowrap">{u.last_message ? ago(u.last_message) : 'Never'}</td>
                    <td class="r">
                      <Show when={!u.bot && !u.deleted_at}>
                        <button class="btn" classList={{ danger: !u.suspended_at }} onClick={() => setSuspended(u)}>
                          {u.suspended_at ? 'Restore' : 'Suspend'}
                        </button>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </Page>
  );
}
