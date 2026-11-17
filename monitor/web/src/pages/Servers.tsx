// Every server, who created it and who's in it. A server opens on its own page (#/servers/<id>) with its people,
// channels and invites; people link on to theirs. Message text is deliberately not available here.
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { Columns } from '../charts';
import { ago, api, bytes, count, date, dateTime, go, href, type J, route, setCrumb, usePoll } from '../lib';
import { Avatar, I, Notice, Page, Section, Stat } from '../ui';

const KIND: Record<number, string> = { 0: 'Text', 2: 'Voice', 4: 'Category', 11: 'Thread' };

/** Search that waits for a pause in typing. */
export function useDebounced(ms = 250) {
  const [query, setQuery] = createSignal('');
  const [debounced, setDebounced] = createSignal('');
  let timer: number | undefined;
  createEffect(
    on(query, (q) => {
      clearTimeout(timer);
      timer = window.setTimeout(() => setDebounced(q.trim()), ms);
    }),
  );
  onCleanup(() => clearTimeout(timer));
  return { query, setQuery, debounced };
}

/** A person, linking to their page. */
export function PersonLink(p: { id: string; name?: string | null; username: string; avatar?: string | null; tags?: string[] }) {
  return (
    <a class="person person-link" href={href('people', p.id)} onClick={(e) => e.stopPropagation()}>
      <Avatar url={p.avatar} name={p.username} />
      <span>
        <span class="cell-name">{p.name ?? p.username}</span>
        <Show when={p.name && p.name !== p.username}>
          <span class="muted small mono"> {p.username}</span>
        </Show>
        <For each={p.tags ?? []}>{(t) => <span class="tag">{t}</span>}</For>
      </span>
    </a>
  );
}

function ServerPage(p: { id: string }) {
  const [d] = createResource(
    () => p.id,
    (id) => api<J>('GET', `/moderation/servers/${id}`),
  );
  createEffect(() => setCrumb(d()?.server?.name ?? ''));
  const g = () => d()?.server;
  return (
    <Page
      back={{ href: href('servers'), label: 'All servers' }}
      title={g()?.name ?? (d.error ? 'Server' : '…')}
      figure={<Show when={g()}>{(s) => <Avatar url={s().icon} name={s().name} size="lg" />}</Show>}
      lead={
        <Show when={g()}>
          {(s) => (
            <span class="lead-line">
              Created by{' '}
              <a class="inline-link" href={href('people', s().owner.id)}>
                {s().owner.name ?? s().owner.username}
              </a>{' '}
              on {date(s().created_at)}
              <Show when={s().owner.deleted}>
                <span class="tag">Deleted</span>
              </Show>
            </span>
          )}
        </Show>
      }
      actions={
        <Show when={g()}>
          <a class="btn" href={href('media', p.id)}>
            <I.photo size={16} /> See this server's media
          </a>
        </Show>
      }
    >
      <Show when={d.error}>
        <Notice level="warning">{String(d.error?.message ?? d.error)}</Notice>
      </Show>
      <Show when={d()}>
        <dl class="stats">
          <Stat label="People" value={count(d()!.members.length)} />
          <Stat label="Channels" value={count(d()!.channels.filter((c: J) => c.kind !== 4).length)} />
          <Stat label="Messages" value={count(g().messages)} />
          <Stat label="Media" value={bytes(g().media_bytes, 0)} />
          <Stat label="Invites" value={count(d()!.invites.length)} />
        </dl>
        <Section title="People" note="Click someone to see everything about them.">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th class="r">Messages here</th>
                  <th class="r">Roles</th>
                  <th class="r">Joined</th>
                </tr>
              </thead>
              <tbody>
                <For each={d()!.members as J[]}>
                  {(m: J) => (
                    <tr class="clickable" onClick={() => go('people', m.id)}>
                      <td class="wrap">
                        <PersonLink
                          id={m.id}
                          name={m.nickname ?? m.name}
                          username={m.username}
                          avatar={m.avatar}
                          tags={[m.owner && 'Creator', m.bot && 'Bot', m.deleted && 'Deleted'].filter(Boolean) as string[]}
                        />
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
        </Section>
        <Section title="Channels">
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
                    <tr classList={{ category: c.kind === 4 }}>
                      <td class="wrap">{c.name || '(no name)'}</td>
                      <td class="small muted nowrap">{KIND[c.kind] ?? c.kind}</td>
                      <td class="r mono">{c.kind === 4 ? '' : count(c.messages)}</td>
                      <td class="r mono">{c.kind === 4 ? '' : count(c.media)}</td>
                      <td class="r mono nowrap">{c.last_message ? ago(c.last_message) : '–'}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Section>
        <Section title="Invites">
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
        </Section>
      </Show>
    </Page>
  );
}

function ServerList() {
  const summary = usePoll<J>(() => api('GET', '/moderation/summary'), 60000);
  const { query, setQuery, debounced } = useDebounced();
  const servers = usePoll<J>(() => api('GET', `/moderation/servers?q=${encodeURIComponent(debounced())}`), 60000);
  createEffect(on(debounced, () => void servers.refresh(), { defer: true }));
  const s = () => summary.data();
  const days = () => {
    const counts = new Map(((s()?.messages_per_day ?? []) as J[]).map((d) => [d.day, d.count]));
    if (!s()) return [];
    return Array.from({ length: 30 }, (_, i) => {
      const day = new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10);
      return { label: day, parts: [counts.get(day) ?? 0] };
    });
  };
  const open = (id: string) => go('servers', id);

  return (
    <Page title="Servers" lead="Every server, who created it and who's in it. Message text isn't available here.">
      <Show when={summary.error()}>
        <Notice level="critical">{summary.error()}</Notice>
      </Show>
      <Section title="In total">
        <dl class="stats">
          <Stat label="Servers" value={count(s()?.servers)} note={s() ? `${count(s().channels)} channels` : undefined} />
          <Stat
            label="Accounts"
            value={
              <a class="stat-link" href={href('people')}>
                {count(s()?.accounts)}
              </a>
            }
            note={s() ? `${s().new_accounts_7d} new this week, ${s().deleted_accounts} deleted` : undefined}
          />
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
        <div class="search-field grow">
          <I.search size={16} />
          <input type="search" placeholder="Search by server or creator" aria-label="Search servers" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
        </div>
        <span class="muted small mono">{servers.data() ? `${count(servers.data().servers.length)} shown` : ''}</span>
      </div>

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
            <For
              each={(servers.data()?.servers ?? []) as J[]}
              fallback={
                <tr>
                  <td colspan="8" class="empty">
                    {servers.loading() ? 'Loading…' : debounced() ? 'No server matches that.' : 'There are no servers yet.'}
                  </td>
                </tr>
              }
            >
              {(g: J) => (
                <tr class="clickable" tabindex="0" onClick={() => open(g.id)} onKeyDown={(e) => e.key === 'Enter' && open(g.id)}>
                  <td>
                    <a class="person" href={href('servers', g.id)} tabindex="-1">
                      <Avatar url={g.icon} name={g.name} />
                      <b class="cell-name">{g.name}</b>
                    </a>
                  </td>
                  <td>
                    <PersonLink id={g.owner.id} name={g.owner.name} username={g.owner.username} avatar={g.owner.avatar} tags={g.owner.deleted ? ['Deleted'] : []} />
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
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Page>
  );
}

export function Servers() {
  return (
    <Show when={route().arg} keyed fallback={<ServerList />}>
      {(id) => <ServerPage id={id} />}
    </Show>
  );
}
