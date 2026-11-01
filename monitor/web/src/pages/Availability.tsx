import { createSignal, For, Show } from 'solid-js';
import { StatusBars } from '../charts';
import { ago, api, date, dateTime, duration, type J, ms, usePoll } from '../lib';
import { checkLevel, checkWord, Page, Section, Status } from '../ui';

const uptimeText = (v: number | null | undefined) => (v == null ? '–' : `${v >= 99.995 ? '100' : v.toFixed(2)}%`);

export function Availability() {
  const poll = usePoll<J>(() => api('GET', '/availability'), 30000);
  const [span, setSpan] = createSignal<'today' | 'days'>('today');
  const d = () => poll.data();
  const history = (id: string) => d()?.history?.[span()]?.[id];
  const slotCount = () => (span() === 'today' ? 96 : 90);
  const slotLabel = (id: string) => (slot: number) => {
    const h = history(id);
    const at = (h?.from ?? 0) + slot * (h?.step ?? 0);
    return span() === 'today' ? dateTime(at) : date(at);
  };
  return (
    <Page title="Availability" lead="Is each part reachable, and has it been? Time the monitor wasn't running counts as unknown, not as up.">
      <Section
        title="Every check"
        note={span() === 'today' ? 'Last 24 hours, 15 minutes per bar.' : 'Last 90 days, one day per bar.'}
        actions={
          <div class="seg" role="group" aria-label="History span">
            <button classList={{ active: span() === 'today' }} onClick={() => setSpan('today')}>
              24 hours
            </button>
            <button classList={{ active: span() === 'days' }} onClick={() => setSpan('days')}>
              90 days
            </button>
          </div>
        }
      >
        <div class="bar-legend">
          <span>
            <i class="ok" /> All fine
          </span>
          <span>
            <i class="some" /> Some failures
          </span>
          <span>
            <i class="bad" /> Mostly failing
          </span>
          <span>
            <i class="none" /> Not watching
          </span>
        </div>
        <ul class="avail">
          <For each={(d()?.checks ?? []) as J[]}>
            {(c: J) => (
              <li>
                <div class="avail-head">
                  <div class="avail-name">
                    <Status level={checkLevel(c.status)}>
                      <b>{c.name}</b>
                    </Status>
                    <span class="muted small mono">{c.what}</span>
                  </div>
                  <dl class="avail-nums">
                    <div>
                      <dt>Now</dt>
                      <dd>{c.status === 'down' || c.status === 'waiting' ? checkWord(c.status) : ms(c.ms)}</dd>
                    </div>
                    <div>
                      <dt>24 h</dt>
                      <dd>{uptimeText(d()?.uptime?.[c.id]?.d1)}</dd>
                    </div>
                    <div>
                      <dt>7 d</dt>
                      <dd>{uptimeText(d()?.uptime?.[c.id]?.d7)}</dd>
                    </div>
                    <div>
                      <dt>30 d</dt>
                      <dd>{uptimeText(d()?.uptime?.[c.id]?.d30)}</dd>
                    </div>
                  </dl>
                </div>
                <StatusBars history={history(c.id)} count={slotCount()} label={slotLabel(c.id)} />
                <Show when={c.status === 'down' || (c.fails > 0 && c.detail)}>
                  <p class="avail-error mono small">{c.detail}</p>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Section>

      <Section title="Incidents" note="A check failing twice in a row opens one; its first success closes it.">
        <Show when={(d()?.incidents ?? []).length} fallback={<p class="empty">Nothing has gone down since the monitor started watching.</p>}>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>What</th>
                  <th>Started</th>
                  <th class="r">Down for</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                <For each={(d()?.incidents ?? []) as J[]}>
                  {(i: J) => (
                    <tr>
                      <td>
                        <Status level={i.ended ? 'none' : 'critical'}>{i.name}</Status>
                      </td>
                      <td class="mono nowrap" title={dateTime(i.started)}>
                        {ago(i.started)}
                      </td>
                      <td class="r mono nowrap">{i.ended ? duration(i.ended - i.started) : 'Still down'}</td>
                      <td class="wrap small">{i.error}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Section>
      <Show when={poll.error()}>
        <p class="error">{poll.error()}</p>
      </Show>
    </Page>
  );
}
