// The admin's view of the server log (/logs): pick a day, filter by level, area and text, newest first.
// Only admins (LINKORD_ADMINS on the server) get anything back; everything in it is already redacted.
import { createEffect, createResource, createSignal, For, on, Show } from 'solid-js';
import { api, ApiError, getToken } from '../lib/api';
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
  const [open, setOpen] = createSignal<number | null>(null);
  createEffect(() => !day() && days()?.[0] && setDay(days()![0].day));

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
            <For each={days() ?? []}>
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
          <button class="btn small-btn" onClick={() => void load()} disabled={loading()}>
            {t('Refresh')}
          </button>
        </div>
        <div class="logs-table" role="table">
          <For each={lines()} fallback={<p class="muted">{loading() ? t('Loading…') : t('Nothing logged here.')}</p>}>
            {(l, i) => (
              <div
                class={`log-row level-${l.level.toLowerCase()}`}
                role="row"
                onClick={() => setOpen(open() === i() ? null : i())}
              >
                <time>{time(l.t)}</time>
                <span class="log-level">{l.level}</span>
                <span class="log-target">{l.target}</span>
                <span class="log-msg">
                  {l.msg}
                  <Show when={l.fields}>
                    <span class="log-fields">
                      <For each={Object.entries(l.fields!).filter(([k]) => open() === i() || k !== 'context')}>
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
