// The app's log: pick a day, filter by level, area and text, newest first. Today's is live: new lines stream in and
// appear on top if they pass the filters. Everything in it was already redacted by the server when it was written.
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { Columns } from '../charts';
import { api, bytes, clock, type J, usePoll } from '../lib';
import { Glyph, Page, Section, Stat } from '../ui';

interface LogLine {
  t: string;
  level: string;
  target: string;
  msg: string;
  fields?: Record<string, string>;
}

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const PAGE = 300;
const rank = (level: string) => LEVELS.indexOf(level.toLowerCase() as (typeof LEVELS)[number]);
/** The server's days are UTC. */
const today = () => new Date().toISOString().slice(0, 10);

/** Calls `onLine` for each new line until `signal` aborts; reconnects (calling `onReconnect`) after drops. */
async function follow(signal: AbortSignal, onLine: (l: LogLine) => void, onReconnect: () => void) {
  for (let attempt = 0; !signal.aborted; attempt++) {
    if (attempt) {
      await new Promise((r) => setTimeout(r, 3000));
      if (signal.aborted) return;
      onReconnect();
    }
    try {
      const res = await fetch('/api/logs/live', { signal });
      if (!res.ok || !res.body) continue;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let end;
        while ((end = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const data = event
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          try {
            onLine(JSON.parse(data));
          } catch {}
        }
      }
    } catch {
      if (signal.aborted) return;
    }
  }
}

export function Logs() {
  const [days] = createResource(() => api<{ day: string; size: number }[]>('GET', '/logs/days'));
  const [day, setDay] = createSignal(today());
  const [level, setLevel] = createSignal<(typeof LEVELS)[number]>('info');
  const [area, setArea] = createSignal('');
  const [query, setQuery] = createSignal('');
  const [lines, setLines] = createSignal<LogLine[]>([]);
  const [areas, setAreas] = createSignal<string[]>([]);
  const [more, setMore] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [open, setOpen] = createSignal<LogLine | null>(null);
  const [live, setLive] = createSignal(true);
  const fresh = new WeakSet<LogLine>();
  const stats = usePoll<J>(() => api('GET', `/logs/stats?day=${day()}`), 30000);
  createEffect(on(day, () => void stats.refresh(), { defer: true }));

  const dayList = () => {
    const list = days() ?? [];
    return list.some((d) => d.day === today()) ? list : [{ day: today(), size: 0 }, ...list];
  };
  const matches = (l: LogLine) => {
    const q = query().trim().toLowerCase();
    return rank(l.level) >= rank(level()) && (!area() || l.target === area()) && (!q || JSON.stringify(l).toLowerCase().includes(q));
  };
  const load = async (append = false) => {
    setLoading(true);
    const params = new URLSearchParams({ day: day(), level: level(), before: String(append ? lines().length : 0), limit: String(PAGE) });
    if (area()) params.set('target', area());
    if (query().trim()) params.set('q', query().trim());
    try {
      const r = await api<{ lines: LogLine[]; more: boolean; areas: string[] }>('GET', `/logs?${params}`);
      setLines(append ? [...lines(), ...r.lines] : r.lines);
      setMore(r.more);
      setAreas(r.areas);
    } finally {
      setLoading(false);
    }
  };
  let timer: number | undefined;
  createEffect(
    on([day, level, area, query], () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 250);
    }),
  );
  onCleanup(() => clearTimeout(timer));
  const following = () => live() && day() === today();
  createEffect(() => {
    if (!following()) return;
    const ctrl = new AbortController();
    void follow(
      ctrl.signal,
      (l) => {
        if (!matches(l)) return;
        fresh.add(l);
        setLines([l, ...lines()]);
      },
      // Lines written while it was disconnected.
      () => void load(),
    );
    onCleanup(() => ctrl.abort());
  });
  const rows = () =>
    ((stats.data()?.hours ?? []) as J[]).map((h, i) => ({
      label: `${String(i).padStart(2, '0')}:00 UTC`,
      parts: [h.info, h.warn, h.error],
    }));

  return (
    <Page title="Logs" lead="Everything the server and the apps report. Kept for 30 days; ids and secrets are cut out before they're written, and message text is never logged.">
      <Section title={day() === today() ? 'Today' : day()}>
        <dl class="stats">
          <Stat label="Lines" value={stats.data()?.total?.toLocaleString('en-US') ?? '–'} />
          <Stat label="Errors" value={stats.data()?.errors?.toLocaleString('en-US') ?? '–'} />
          <Stat label="Warnings" value={stats.data()?.warnings?.toLocaleString('en-US') ?? '–'} />
        </dl>
        <Show when={rows().length}>
          <Columns
            title="Lines per hour"
            rows={rows()}
            parts={[
              { name: 'Info', cls: 'fill-neutral' },
              { name: 'Warnings', cls: 'fill-warning' },
              { name: 'Errors', cls: 'fill-critical' },
            ]}
          />
        </Show>
        <Show when={(stats.data()?.problems ?? []).length}>
          <h3 class="label">Most repeated problems</h3>
          <ul class="problems">
            <For each={stats.data().problems as J[]}>
              {(x: J) => (
                <li>
                  <button
                    onClick={() => {
                      setLevel('warn');
                      setQuery(x.msg.slice(0, 60));
                    }}
                  >
                    <b class="mono">{x.count}×</b>
                    <Glyph level={x.level === 'error' ? 'critical' : 'warning'} />
                    <span class="mono small log-target">{x.target}</span>
                    <span class="small">{x.msg}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Section>

      <div class="filters" role="search">
        <select aria-label="Day" value={day()} onChange={(e) => setDay(e.currentTarget.value)}>
          <For each={dayList()}>
            {(d) => (
              <option value={d.day}>
                {d.day}, {bytes(d.size, 0)}
              </option>
            )}
          </For>
        </select>
        <div class="seg" role="group" aria-label="Minimum level">
          <For each={LEVELS}>
            {(l) => (
              <button classList={{ active: level() === l }} aria-pressed={level() === l} onClick={() => setLevel(l)}>
                {l}+
              </button>
            )}
          </For>
        </div>
        <select aria-label="Area" value={area()} onChange={(e) => setArea(e.currentTarget.value)}>
          <option value="">Every area</option>
          <For each={[...new Set([...areas(), area()].filter(Boolean))]}>{(a) => <option value={a}>{a}</option>}</For>
        </select>
        <input class="grow" type="search" placeholder="Search the logs" aria-label="Search the logs" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
        <Show
          when={day() === today()}
          fallback={
            <button class="btn" onClick={() => void load()} disabled={loading()}>
              Refresh
            </button>
          }
        >
          <button
            class="btn logs-live"
            classList={{ on: live() }}
            aria-pressed={live()}
            title={live() ? 'New lines appear as they happen. Click to pause.' : 'Paused. Click to follow new lines.'}
            onClick={() => {
              if (!live()) void load();
              setLive(!live());
            }}
          >
            <i class="live-dot" />
            {live() ? 'Live' : 'Paused'}
          </button>
        </Show>
      </div>

      <div class="log-table" role="table">
        <For each={lines()} fallback={<p class="empty">{loading() ? 'Loading…' : 'Nothing logged here.'}</p>}>
          {(l) => (
            <div class={`log-row level-${l.level.toLowerCase()}`} classList={{ fresh: fresh.has(l) }} role="row" onClick={() => setOpen(open() === l ? null : l)}>
              <time>{clock(l.t)}</time>
              <span class="log-level">{l.level}</span>
              <span class="log-target">{l.target}</span>
              <span class="log-msg">
                {l.msg}
                <Show when={l.fields}>
                  <span class="log-fields">
                    <For each={Object.entries(l.fields!).filter(([k]) => open() === l || k !== 'context')}>
                      {([k, v]) => (
                        <span class="log-field" classList={{ block: k === 'context' }}>
                          <b>{k}</b>={v}
                        </span>
                      )}
                    </For>
                  </span>
                </Show>
              </span>
            </div>
          )}
        </For>
      </div>
      <Show when={more()}>
        <button class="btn more" disabled={loading()} onClick={() => void load(true)}>
          Older lines
        </button>
      </Show>
    </Page>
  );
}
