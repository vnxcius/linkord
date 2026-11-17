import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource/instrument-serif/400.css';
import './styles.css';

import { createEffect, createSignal, For, type JSX, Match, on, onCleanup, onMount, Show, Switch } from 'solid-js';
import { render } from 'solid-js/web';
import emblem from './assets/emblem.png';
import { ago, api, clock, crumb, dismiss, go, href, type J, route, setSignedIn, signedIn, type Tab, toasts, usePoll } from './lib';
import { Availability } from './pages/Availability';
import { Database } from './pages/Database';
import { Diagnostics } from './pages/Diagnostics';
import { Logs } from './pages/Logs';
import { Media } from './pages/Media';
import { Network } from './pages/Network';
import { Overview } from './pages/Overview';
import { People } from './pages/People';
import { Performance } from './pages/Performance';
import { Servers } from './pages/Servers';
import { Storage } from './pages/Storage';
import { Avatar, Glyph, I, type Level } from './ui';

function Login() {
  const [password, setPassword] = createSignal('');
  const [error, setError] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('POST', '/login', { password: password() });
      setSignedIn(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main class="login">
      <form onSubmit={submit}>
        <img src={emblem} alt="" width="52" height="52" />
        <h1>Linkord Monitor</h1>
        <p class="muted small">How the box is doing, and who's on it.</p>
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" autofocus value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
        <Show when={error()}>
          <p class="error" role="alert">
            {error()}
          </p>
        </Show>
        <button class="btn primary" disabled={busy() || !password()}>
          Sign in
        </button>
      </form>
    </main>
  );
}

type Item = { tab: Tab; label: string; icon: (p: { size?: number }) => JSX.Element; hint: string };
const NAV: { group: string; items: Item[] }[] = [
  {
    group: 'Health',
    items: [
      { tab: 'overview', label: 'Overview', icon: I.home, hint: 'How everything is, right now' },
      { tab: 'availability', label: 'Availability', icon: I.signal, hint: 'Checks, uptime and incidents' },
      { tab: 'performance', label: 'Performance', icon: I.bolt, hint: 'CPU, memory, requests' },
      { tab: 'network', label: 'Network', icon: I.globe, hint: 'Traffic, voice and streams' },
      { tab: 'storage', label: 'Storage', icon: I.database, hint: 'Disks and what fills them' },
      { tab: 'database', label: 'Database', icon: I.table, hint: 'Postgres size and activity' },
      { tab: 'logs', label: 'Logs', icon: I.logs, hint: 'Live and past lines' },
      { tab: 'diagnostics', label: 'Diagnostics', icon: I.wrench, hint: 'Self-checks and network tools' },
    ],
  },
  {
    group: 'Moderation',
    items: [
      { tab: 'servers', label: 'Servers', icon: I.servers, hint: 'Every server and its people' },
      { tab: 'people', label: 'People', icon: I.people, hint: 'Every account: suspend, badges, delete' },
      { tab: 'media', label: 'Media', icon: I.photo, hint: 'Everything people uploaded' },
    ],
  },
];
const ITEMS = NAV.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group })));
const itemOf = (tab: Tab) => ITEMS.find((i) => i.tab === tab)!;

const verdictLevel = (v?: string): Level => (v === 'ok' ? 'ok' : v === 'critical' ? 'critical' : v === 'warning' ? 'warning' : 'none');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** The column on the right: what needs you, whatever tab you're on. */
function Margin(p: { now: J; onPick?: () => void }) {
  const pick = (tab: Tab) => {
    go(tab);
    p.onPick?.();
  };
  return (
    <>
      <section>
        <h3>Needs attention</h3>
        <For
          each={p.now?.attention ?? []}
          fallback={
            <p class="margin-empty">
              <Glyph level="ok" /> Nothing right now.
            </p>
          }
        >
          {(a: J) => (
            <button class={`attention ${a.level}`} onClick={() => pick(a.tab)}>
              <Glyph level={a.level} />
              <span>
                <b>{a.title}</b>
                <small>{a.detail}</small>
              </span>
            </button>
          )}
        </For>
      </section>
      <section>
        <h3>Incidents</h3>
        <For each={(p.now?.incidents ?? []) as J[]} fallback={<p class="margin-empty">None recorded.</p>}>
          {(i: J) => (
            <button class="margin-row" onClick={() => pick('availability')}>
              <span>
                <b>{i.name}</b>
                <small>{i.ended ? `Down for ${Math.max(1, Math.round((i.ended - i.started) / 60))} min` : 'Still down'}</small>
              </span>
              <time>{ago(i.started)}</time>
            </button>
          )}
        </For>
      </section>
      <section>
        <h3>Latest problems</h3>
        <For each={(p.now?.problems ?? []) as J[]} fallback={<p class="margin-empty">No warnings or errors logged today.</p>}>
          {(l: J) => (
            <button class="margin-row problem" onClick={() => pick('logs')}>
              <span>
                <b>
                  <Glyph level={l.level.toLowerCase() === 'error' ? 'critical' : 'warning'} /> {l.target}
                </b>
                <small>{l.msg}</small>
              </span>
              <time>{clock(l.t)}</time>
            </button>
          )}
        </For>
      </section>
    </>
  );
}

type Hit = { key: string; label: string; detail: string; go: () => void; icon?: JSX.Element; group: string };

/** Ctrl/⌘ K or "/": jump to a tab, a person or a server by typing. */
function Palette(p: { onClose: () => void }) {
  const [q, setQ] = createSignal('');
  const [found, setFound] = createSignal<Hit[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [sel, setSel] = createSignal(0);
  let input!: HTMLInputElement;
  let list!: HTMLUListElement;
  let timer: number | undefined;
  let run = 0;
  const tabHits = (): Hit[] => {
    const t = q().trim().toLowerCase();
    return ITEMS.filter((i) => !t || i.label.toLowerCase().includes(t) || i.hint.toLowerCase().includes(t)).map((i) => ({
      key: `tab:${i.tab}`,
      label: i.label,
      detail: i.hint,
      group: 'Go to',
      icon: <i.icon size={17} />,
      go: () => go(i.tab),
    }));
  };
  createEffect(
    on(q, (text) => {
      clearTimeout(timer);
      const t = text.trim();
      setSel(0);
      if (t.length < 2) {
        setFound([]);
        return;
      }
      timer = window.setTimeout(async () => {
        const mine = ++run;
        setSearching(true);
        try {
          const [people, servers] = await Promise.all([api('GET', `/moderation/accounts?q=${encodeURIComponent(t)}`), api('GET', `/moderation/servers?q=${encodeURIComponent(t)}`)]);
          if (mine !== run) return;
          const ppl: Hit[] = ((people.accounts ?? []) as J[]).slice(0, 6).map((u) => ({
            key: `person:${u.id}`,
            label: u.name ?? u.username,
            detail: [u.username, u.discord_username && `Discord ${u.discord_username}`, u.deleted_at && 'deleted', u.suspended_at && 'suspended'].filter(Boolean).join(' · '),
            group: 'People',
            icon: <Avatar url={u.avatar} name={u.username} />,
            go: () => go('people', u.id),
          }));
          const srv: Hit[] = ((servers.servers ?? []) as J[]).slice(0, 6).map((g) => ({
            key: `server:${g.id}`,
            label: g.name,
            detail: `${g.members} people · by ${g.owner.username}`,
            group: 'Servers',
            icon: <Avatar url={g.icon} name={g.name} />,
            go: () => go('servers', g.id),
          }));
          setFound([...ppl, ...srv]);
        } catch {
          if (mine === run) setFound([]);
        } finally {
          if (mine === run) setSearching(false);
        }
      }, 180);
    }),
  );
  onCleanup(() => clearTimeout(timer));
  const hits = () => [...tabHits(), ...found()];
  const choose = (h: Hit | undefined) => {
    if (!h) return;
    h.go();
    p.onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    const n = hits().length;
    if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => (s + 1) % Math.max(1, n)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => (s - 1 + n) % Math.max(1, n)));
    else if (e.key === 'Enter') (e.preventDefault(), choose(hits()[sel()]));
    else if (e.key === 'Escape') (e.preventDefault(), p.onClose());
  };
  createEffect(() => {
    sel();
    list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  });
  onMount(() => input.focus());
  return (
    <div class="scrim palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Jump to">
        <div class="palette-input">
          <I.search size={18} />
          <input
            ref={input}
            type="text"
            placeholder="Jump to a tab, or find a person or server…"
            aria-label="Jump to"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={hits()[sel()] ? `hit-${sel()}` : undefined}
            value={q()}
            onInput={(e) => setQ(e.currentTarget.value)}
            onKeyDown={onKey}
          />
          <kbd>Esc</kbd>
        </div>
        <ul class="palette-list" id="palette-list" role="listbox" ref={list}>
          <For each={hits()}>
            {(h, i) => (
              <>
                <Show when={i() === 0 || hits()[i() - 1].group !== h.group}>
                  <li class="palette-group" role="presentation">
                    {h.group}
                  </li>
                </Show>
                <li id={`hit-${i()}`} role="option" aria-selected={sel() === i()} class="palette-hit" onMouseMove={() => setSel(i())} onClick={() => choose(h)}>
                  <span class="palette-icon">{h.icon}</span>
                  <span class="palette-text">
                    <b>{h.label}</b>
                    <small>{h.detail}</small>
                  </span>
                  <I.chevron size={14} />
                </li>
              </>
            )}
          </For>
          <Show when={q().trim().length >= 2 && !searching() && !found().length}>
            <li class="palette-empty">No person or server matches “{q().trim()}”.</li>
          </Show>
          <Show when={searching() && !found().length}>
            <li class="palette-empty">Looking…</li>
          </Show>
        </ul>
        <footer class="palette-foot mono small">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to open
          </span>
        </footer>
      </div>
    </div>
  );
}

function Shell() {
  const now = usePoll<J>(() => api('GET', '/now'), 5000);
  const [palette, setPalette] = createSignal(false);
  const [menu, setMenu] = createSignal(false);
  const [drawer, setDrawer] = createSignal(false);
  const attention = () => ((now.data()?.attention ?? []) as J[]).length;
  const tabLevel = (tab: Tab): Level | null => {
    const list: J[] = now.data()?.attention ?? [];
    const here = list.filter((a) => a.tab === tab);
    if (here.some((a) => a.level === 'critical')) return 'critical';
    return here.length ? 'warning' : null;
  };
  const worst = (): Level => {
    const list: J[] = now.data()?.attention ?? [];
    return list.some((a) => a.level === 'critical') ? 'critical' : list.length ? 'warning' : 'ok';
  };
  const host = () => now.data()?.host?.name ?? '';
  const signOut = async () => {
    await api('POST', '/logout');
    setSignedIn(false);
  };
  const onKey = (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLElement && (e.target.matches('input, textarea, select') || e.target.isContentEditable);
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setPalette((v) => !v);
    } else if (e.key === '/' && !typing && !document.querySelector('.scrim')) {
      e.preventDefault();
      setPalette(true);
    }
  };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));
  let page!: HTMLElement;
  createEffect(
    on(
      () => `${route().tab}/${route().arg}`,
      () => {
        page?.scrollTo(0, 0);
        window.scrollTo(0, 0);
        setMenu(false);
        setDrawer(false);
      },
    ),
  );
  createEffect(() => {
    const it = itemOf(route().tab);
    document.title = `${it.label} · Linkord Monitor`;
  });
  const navList = () => (
    <For each={NAV}>
      {(g) => (
        <div class="nav-group">
          <h3>{g.group}</h3>
          <For each={g.items}>
            {(item) => (
              <a href={href(item.tab)} classList={{ active: route().tab === item.tab }} aria-current={route().tab === item.tab ? 'page' : undefined} title={item.hint}>
                <item.icon size={17} />
                <span class="nav-label">{item.label}</span>
                <Show when={tabLevel(item.tab)}>{(l) => <Glyph level={l()} />}</Show>
              </a>
            )}
          </For>
        </div>
      )}
    </For>
  );
  return (
    <div class="desk">
      <nav class="rail" aria-label="Sections">
        <a class="brand" href={href('overview')}>
          <img src={emblem} alt="" width="28" height="28" />
          <span>Monitor</span>
        </a>
        <button class="jump" onClick={() => setPalette(true)}>
          <I.search size={16} />
          <span>Jump to…</span>
          <kbd>{isMac ? '⌘' : 'Ctrl'} K</kbd>
        </button>
        {navList()}
        <div class="dock">
          <span class={`dock-state ${verdictLevel(now.data()?.verdict)}`}>
            <Glyph level={now.error() ? 'critical' : verdictLevel(now.data()?.verdict)} />
            <span class="mono small">{now.error() ? 'Monitor not answering' : host()}</span>
          </span>
          <button class="link-btn sign-out" onClick={signOut}>
            <I.signOut size={15} /> Sign out
          </button>
        </div>
      </nav>
      <main class="page" ref={page}>
        <header class="topbar">
          <button class="icon-btn only-phone" aria-label="Menu" aria-expanded={menu()} onClick={() => setMenu(true)}>
            <I.menu />
          </button>
          <a class="topbar-brand only-phone" href={href('overview')} aria-label="Overview">
            <img src={emblem} alt="" width="24" height="24" />
          </a>
          <nav class="crumbs mono" aria-label="You are here">
            <span class="hide-phone">{itemOf(route().tab).group}</span>
            <span class="crumb-sep hide-phone" aria-hidden="true">
              /
            </span>
            <a href={href(route().tab)} aria-current={route().arg ? undefined : 'page'}>
              {itemOf(route().tab).label}
            </a>
            <Show when={route().arg && route().tab !== 'media'}>
              <span class="crumb-sep" aria-hidden="true">
                /
              </span>
              <span class="crumb-here" aria-current="page">
                {crumb() || '…'}
              </span>
            </Show>
          </nav>
          <span class="topbar-host mono hide-phone">{host()}</span>
          <button class="icon-btn" aria-label="Jump to" title={`Jump to (${isMac ? '⌘' : 'Ctrl'} K)`} onClick={() => setPalette(true)}>
            <I.search />
          </button>
          <button class={`icon-btn attention-btn ${worst()}`} aria-label={`Needs attention: ${attention()}`} onClick={() => setDrawer(true)}>
            <I.bell />
            <Show when={attention()}>
              <span class="count">{attention()}</span>
            </Show>
          </button>
        </header>
        <Switch>
          <Match when={route().tab === 'overview'}>
            <Overview now={now.data()} />
          </Match>
          <Match when={route().tab === 'availability'}>
            <Availability />
          </Match>
          <Match when={route().tab === 'performance'}>
            <Performance />
          </Match>
          <Match when={route().tab === 'network'}>
            <Network />
          </Match>
          <Match when={route().tab === 'storage'}>
            <Storage />
          </Match>
          <Match when={route().tab === 'database'}>
            <Database />
          </Match>
          <Match when={route().tab === 'logs'}>
            <Logs />
          </Match>
          <Match when={route().tab === 'diagnostics'}>
            <Diagnostics />
          </Match>
          <Match when={route().tab === 'servers'}>
            <Servers />
          </Match>
          <Match when={route().tab === 'people'}>
            <People />
          </Match>
          <Match when={route().tab === 'media'}>
            <Media />
          </Match>
        </Switch>
      </main>
      <aside class="margin" aria-label="What needs attention">
        <Margin now={now.data()} />
      </aside>

      <Show when={menu()}>
        <div class="scrim sheet-scrim" onMouseDown={(e) => e.target === e.currentTarget && setMenu(false)} onKeyDown={(e) => e.key === 'Escape' && setMenu(false)}>
          <nav class="sheet sheet-left" aria-label="Sections">
            <header class="sheet-head">
              <span class="brand">
                <img src={emblem} alt="" width="28" height="28" />
                <span>Monitor</span>
              </span>
              <button class="icon-btn" aria-label="Close" ref={(el) => queueMicrotask(() => el.focus())} onClick={() => setMenu(false)}>
                <I.close />
              </button>
            </header>
            {navList()}
            <div class="dock">
              <span class={`dock-state ${verdictLevel(now.data()?.verdict)}`}>
                <Glyph level={now.error() ? 'critical' : verdictLevel(now.data()?.verdict)} />
                <span class="mono small">{now.error() ? 'Monitor not answering' : host()}</span>
              </span>
              <button class="link-btn sign-out" onClick={signOut}>
                <I.signOut size={15} /> Sign out
              </button>
            </div>
          </nav>
        </div>
      </Show>
      <Show when={drawer()}>
        <div class="scrim sheet-scrim" onMouseDown={(e) => e.target === e.currentTarget && setDrawer(false)} onKeyDown={(e) => e.key === 'Escape' && setDrawer(false)}>
          <aside class="sheet sheet-right margin-sheet" aria-label="What needs attention">
            <header class="sheet-head">
              <h2>Attention</h2>
              <button class="icon-btn" aria-label="Close" ref={(el) => queueMicrotask(() => el.focus())} onClick={() => setDrawer(false)}>
                <I.close />
              </button>
            </header>
            <Margin now={now.data()} onPick={() => setDrawer(false)} />
          </aside>
        </div>
      </Show>
      <Show when={palette()}>
        <Palette onClose={() => setPalette(false)} />
      </Show>
      <div class="toasts" role="status" aria-live="polite">
        <For each={toasts()}>
          {(t) => (
            <div class={`toast ${t.level}`}>
              <Glyph level={t.level} />
              <span>{t.text}</span>
              <button class="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <I.close size={15} />
              </button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

function App() {
  onMount(async () => {
    try {
      const s = await api('GET', '/session');
      setSignedIn(!!s.signed_in);
    } catch {
      setSignedIn(false);
    }
  });
  return (
    <Show when={signedIn() !== null}>
      <Show when={signedIn()} fallback={<Login />}>
        <Shell />
      </Show>
    </Show>
  );
}

render(() => <App />, document.getElementById('root')!);
