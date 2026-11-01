import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource/instrument-serif/400.css';
import './styles.css';

import { createEffect, createSignal, For, Match, onMount, Show, Switch } from 'solid-js';
import { render } from 'solid-js/web';
import emblem from './assets/emblem.png';
import { ago, api, clock, go, type J, route, setSignedIn, signedIn, type Tab, usePoll } from './lib';
import { Availability } from './pages/Availability';
import { Database } from './pages/Database';
import { Diagnostics } from './pages/Diagnostics';
import { Logs } from './pages/Logs';
import { Media } from './pages/Media';
import { Network } from './pages/Network';
import { Overview } from './pages/Overview';
import { Performance } from './pages/Performance';
import { Servers } from './pages/Servers';
import { Storage } from './pages/Storage';
import { Glyph, type Level } from './ui';

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
        <img src={emblem} alt="" width="44" height="44" />
        <h1>Linkord Monitor</h1>
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
        <p class="muted small">The password is LINKORD_MONITOR_PASSWORD in monitor/.env on the server.</p>
      </form>
    </main>
  );
}

const NAV: { group: string; items: { tab: Tab; label: string }[] }[] = [
  {
    group: 'Health',
    items: [
      { tab: 'overview', label: 'Overview' },
      { tab: 'availability', label: 'Availability' },
      { tab: 'performance', label: 'Performance' },
      { tab: 'network', label: 'Network' },
      { tab: 'storage', label: 'Storage' },
      { tab: 'database', label: 'Database' },
      { tab: 'logs', label: 'Logs' },
      { tab: 'diagnostics', label: 'Diagnostics' },
    ],
  },
  {
    group: 'Moderation',
    items: [
      { tab: 'servers', label: 'Servers & people' },
      { tab: 'media', label: 'Media' },
    ],
  },
];

const verdictLevel = (v?: string): Level => (v === 'ok' ? 'ok' : v === 'critical' ? 'critical' : v === 'warning' ? 'warning' : 'none');

/** The column on the right: what needs you, whatever tab you're on. */
function Margin(p: { now: J }) {
  return (
    <aside class="margin" aria-label="What needs attention">
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
            <button class={`attention ${a.level}`} onClick={() => go(a.tab)}>
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
            <button class="margin-row" onClick={() => go('availability')}>
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
            <button class="margin-row problem" onClick={() => go('logs')}>
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
    </aside>
  );
}

function Shell() {
  const now = usePoll<J>(() => api('GET', '/now'), 5000);
  const tabLevel = (tab: Tab): Level | null => {
    const list: J[] = now.data()?.attention ?? [];
    const here = list.filter((a) => a.tab === tab);
    if (here.some((a) => a.level === 'critical')) return 'critical';
    return here.length ? 'warning' : null;
  };
  const host = () => now.data()?.host?.name ?? '';
  const signOut = async () => {
    await api('POST', '/logout');
    setSignedIn(false);
  };
  let page!: HTMLElement;
  createEffect(() => {
    route();
    page?.scrollTo(0, 0);
  });
  return (
    <div class="desk">
      <nav class="rail" aria-label="Sections">
        <button class="brand" onClick={() => go('overview')}>
          <img src={emblem} alt="" width="26" height="26" />
          <span>Monitor</span>
        </button>
        <For each={NAV}>
          {(g) => (
            <div class="nav-group">
              <h3>{g.group}</h3>
              <For each={g.items}>
                {(item) => (
                  <a href={`#/${item.tab}`} classList={{ active: route().tab === item.tab }} aria-current={route().tab === item.tab ? 'page' : undefined}>
                    <span>{item.label}</span>
                    <Show when={tabLevel(item.tab)}>{(l) => <Glyph level={l()} />}</Show>
                  </a>
                )}
              </For>
            </div>
          )}
        </For>
        <div class="dock">
          <span class={`dock-state ${verdictLevel(now.data()?.verdict)}`}>
            <Glyph level={now.error() ? 'critical' : verdictLevel(now.data()?.verdict)} />
            <span class="mono small">{now.error() ? 'Monitor not answering' : host()}</span>
          </span>
          <button class="link-btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      </nav>
      <main class="page" ref={page}>
        <div class="running-head">
          <span>Linkord Monitor</span>
          <Show when={host()}>
            <span>{host()}</span>
          </Show>
        </div>
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
          <Match when={route().tab === 'media'}>
            <Media />
          </Match>
        </Switch>
      </main>
      <Margin now={now.data()} />
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
