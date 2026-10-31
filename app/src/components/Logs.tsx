// The admin's view of the server log (/logs): pick a day, filter by level, area and text, newest first.
// Today's log is live: new lines stream in (GET /admin/logs/live) and appear on top if they pass the filters.
// Only admins (LINKORD_ADMINS on the server) get anything back; everything in it is already redacted.
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { api, ApiError, getToken, serverUrl } from '../lib/api';
import { dateLocale, t } from '../lib/i18n';

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

/** Calls `onLine` for each new log line until `signal` aborts; reconnects (calling `onReconnect`) after drops. */
async function followLog(signal: AbortSignal, onLine: (l: LogLine) => void, onReconnect: () => void) {
  for (let attempt = 0; !signal.aborted; attempt++) {
    if (attempt) {
      await new Promise((r) => setTimeout(r, 3000));
      if (signal.aborted) return;
      onReconnect();
    }
    try {
      const res = await fetch(`${serverUrl()}/api/admin/logs/live`, {
        headers: { authorization: `Bearer ${getToken()}` },
        signal,
      });
      if (!res.ok || !res.body) continue;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        // Server-sent events: blank-line separated, the JSON line after "data:" (keep-alives are comments).
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

export function LogsPage() {
  const [days] = createResource(() =>
    getToken()
      ? api<{ day: string; size: number }[]>('GET', '/admin/logs/days')
      : Promise.reject(new ApiError(401, '')),
  );
  const [day, setDay] = createSignal('');
  const [level, setLevel] = createSignal<(typeof LEVELS)[number]>('info');
  const [area, setArea] = createSignal('');
  const [query, setQuery] = createSignal('');
  const [lines, setLines] = createSignal<LogLine[]>([]);
  const [more, setMore] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [open, setOpen] = createSignal<LogLine | null>(null);
  const [live, setLive] = createSignal(true);
  /** Lines that arrived live, highlighted for a moment. */
  const fresh = new WeakSet<LogLine>();
  // Today first, even before anything was written today.
  const dayList = () => {
    const list = days() ?? [];
    return list.some((d) => d.day === today()) ? list : [{ day: today(), size: 0 }, ...list];
  };
  createEffect(() => !day() && days() && setDay(dayList()[0].day));
  const matches = (l: LogLine) => {
    const q = query().trim().toLowerCase();
    return (
      rank(l.level) >= rank(level()) &&
      (!area() || l.target === area()) &&
      (!q || JSON.stringify(l).toLowerCase().includes(q))
    );
  };

  const load = async (append = false) => {
    if (!day()) return;
    setLoading(true);
    const params = new URLSearchParams({
      day: day(),
      level: level(),
      before: String(append ? lines().length : 0),
      limit: String(PAGE),
    });
    if (area()) params.set('target', area());
    if (query().trim()) params.set('q', query().trim());
    try {
      const r = await api<{ lines: LogLine[]; more: boolean }>('GET', `/admin/logs?${params}`);
      setLines(append ? [...lines(), ...r.lines] : r.lines);
      setMore(r.more);
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
  const following = () => live() && day() === today() && !!days() && !denied();
  createEffect(() => {
    if (!following()) return;
    const ctrl = new AbortController();
    void followLog(
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
  const areas = () => [...new Set(lines().map((l) => l.target))].sort();
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const denied = () => days.error instanceof ApiError && (days.error.status === 401 || days.error.status === 403);

  return (
    <section class="logs-page">
      <p class="showcase-kicker">{t('Admin')}</p>
      <h1>{t('Logs')}</h1>
      <Show
        when={!denied()}
        fallback={<p class="muted">{t('Only admins can read the logs. Sign in with an admin account first.')}</p>}
      >
        <p class="dl-lead">
          {t('Everything the server and the apps report, newest first. Kept for 30 days; ids and secrets are cut out.')}
        </p>
        <div class="logs-filters">
          <select value={day()} onChange={(e) => setDay(e.currentTarget.value)}>
            <For each={dayList()}>
              {(d) => (
                <option value={d.day}>
                  {d.day} · {(d.size / 1024).toFixed(0)} KB
                </option>
              )}
            </For>
          </select>
          <div class="seg">
            <For each={LEVELS}>
              {(l) => (
                <button classList={{ active: level() === l }} onClick={() => setLevel(l)}>
                  {l}+
                </button>
              )}
            </For>
          </div>
          <select value={area()} onChange={(e) => setArea(e.currentTarget.value)}>
            <option value="">{t('Everything')}</option>
            <For each={[...new Set([...areas(), area()].filter(Boolean))]}>{(a) => <option value={a}>{a}</option>}</For>
          </select>
          <input
            class="logs-search"
            placeholder={t('Search the logs')}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <Show
            when={day() === today()}
            fallback={
              <button class="btn small-btn" onClick={() => void load()} disabled={loading()}>
                {t('Refresh')}
              </button>
            }
          >
            <button
              class="btn small-btn logs-live"
              classList={{ on: live() }}
              aria-pressed={live()}
              title={
                live() ? t('New lines appear as they happen. Click to pause.') : t('Paused. Click to follow new lines.')
              }
              onClick={() => {
                // Resuming catches up on what was written while paused.
                if (!live()) void load();
                setLive(!live());
              }}
            >
              <i class="logs-live-dot" />
              {live() ? t('Live') : t('Paused')}
            </button>
          </Show>
        </div>
        <div class="logs-table" role="table">
          <For each={lines()} fallback={<p class="muted">{loading() ? t('Loading…') : t('Nothing logged here.')}</p>}>
            {(l) => (
              <div
                class={`log-row level-${l.level.toLowerCase()}`}
                classList={{ fresh: fresh.has(l) }}
                role="row"
                onClick={() => setOpen(open() === l ? null : l)}
              >
                <time>{time(l.t)}</time>
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
          <button class="btn logs-more" disabled={loading()} onClick={() => void load(true)}>
            {t('Older lines')}
          </button>
        </Show>
      </Show>
    </section>
  );
}
