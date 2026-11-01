import { createSignal, For, Show } from 'solid-js';
import { RangePicker, TimeChart } from '../charts';
import { ago, api, bytes, count, duration, type J, num, pct, usePoll } from '../lib';
import { Notice, Page, Section, Stat, Status } from '../ui';

export function Database() {
  const poll = usePoll<J>(() => api('GET', '/database'), 15000);
  const [range, setRange] = createSignal('6h');
  const d = () => poll.data();
  const tables = () => (d()?.tables ?? []) as J[];
  const totalRows = () => tables().reduce((a, t) => a + t.rows, 0);
  return (
    <Page title="Database" lead="Postgres, read through its own statistics. The monitor's connection can't write and gives up on anything over 8 seconds." actions={<RangePicker value={range()} onChange={setRange} />}>
      <Show when={poll.error()}>
        <Notice level="critical">
          {poll.error()} If Postgres is down the app can't work either. Check <code>docker ps</code> on the server.
        </Notice>
      </Show>
      <Section title="State" note={d() ? d().version.split(' on ')[0] : undefined}>
        <dl class="stats">
          <Stat label="Size" value={bytes(d()?.size)} note={d() ? `about ${count(totalRows())} rows` : undefined} />
          <Stat label="Connections" value={d() ? `${d().backends} / ${d().max_connections}` : '–'} note={(d()?.states ?? []).map((s: J) => `${s.count} ${s.state}`).join(', ')} />
          <Stat label="Read from memory" value={pct(d()?.cache_hit, 1)} note="below 90% means it's going to disk a lot" />
          <Stat label="Waiting for locks" value={d()?.waiting_locks ?? '–'} note="queries right now" />
          <Stat label="Deadlocks" value={count(d()?.deadlocks)} note={d()?.stats_reset ? `since ${ago(d().stats_reset)}` : 'since the start'} />
          <Stat label="Undone transactions" value={count(d()?.rollbacks)} note={d() ? `of ${count(d().commits + d().rollbacks)}` : undefined} />
          <Stat label="Temporary files" value={bytes(d()?.temp_bytes)} note="queries too big for memory" />
          <Stat label="Up for" value={d() ? duration((Date.now() - new Date(d().started).getTime()) / 1000) : '–'} />
        </dl>
        <div class="chart-grid">
          <TimeChart title="Transactions" series={[{ key: 'pg_tps', label: 'Transactions/s' }]} range={range} format={(n) => num(n, '/s')} />
          <TimeChart title="Connections" series={[{ key: 'pg_conns', label: 'All', slot: 1 }, { key: 'pool_size', label: "The app's", slot: 2 }]} range={range} format={(n) => count(n)} whole />
          <TimeChart title="Size" series={[{ key: 'pg_size', label: 'Size' }]} range={range} format={(n) => bytes(n, 0)} byteAxis />
          <TimeChart title="Slow queries" note="running over 5 s when checked" series={[{ key: 'pg_slow', label: 'Slow', peak: true }]} range={range} format={(n) => count(n)} whole />
        </div>
      </Section>

      <Section title="Running now" note="Everything not idle, oldest first. Values aren't shown: only the statement's shape, with its $1 placeholders.">
        <Show when={(d()?.activity ?? []).length} fallback={<p class="empty">Nothing running right now.</p>}>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>From</th>
                  <th>State</th>
                  <th class="r">For</th>
                  <th>Waiting on</th>
                  <th>Statement</th>
                </tr>
              </thead>
              <tbody>
                <For each={d().activity as J[]}>
                  {(a: J) => (
                    <tr>
                      <td class="nowrap small">{a.app || 'unnamed'}</td>
                      <td class="nowrap small">{a.state}</td>
                      <td class="r mono nowrap">{a.seconds == null ? '–' : `${a.seconds.toFixed(1)} s`}</td>
                      <td class="wrap small">{a.waiting}</td>
                      <td class="mono wrap small">{a.query}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Section>

      <Section title="Tables" note="Largest first. Row counts are Postgres's estimates. Many dead rows mean cleanup isn't keeping up.">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Table</th>
                <th class="r">Rows</th>
                <th class="r">Total</th>
                <th class="r">Indexes</th>
                <th class="r">Dead rows</th>
                <th class="r">Full scans</th>
                <th class="r">Index scans</th>
                <th class="r">Cleaned</th>
              </tr>
            </thead>
            <tbody>
              <For each={tables()}>
                {(t: J) => (
                  <tr>
                    <td class="mono">{t.name}</td>
                    <td class="r mono">{count(t.rows)}</td>
                    <td class="r mono">{bytes(t.total)}</td>
                    <td class="r mono">{bytes(t.indexes)}</td>
                    <td class="r mono">{count(t.dead)}</td>
                    <td class="r mono">{count(t.seq_scan)}</td>
                    <td class="r mono">{count(t.idx_scan)}</td>
                    <td class="r mono nowrap">{ago(t.last_vacuum)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Section>

      <div class="two-col">
        <Section title="Migrations">
          <Show when={d()?.migrations} fallback={<p class="empty">No migrations table in this database.</p>}>
            <dl class="stats">
              <Stat label="Applied" value={d().migrations.applied} note={d().migrations.latest_name} />
              <Stat
                label="Failed"
                value={
                  <Status level={d().migrations.failed ? 'critical' : 'ok'}>
                    {d().migrations.failed}
                  </Status>
                }
                note={d().migrations.installed_on ? `last one ${ago(d().migrations.installed_on)}` : undefined}
              />
            </dl>
          </Show>
        </Section>
        <Section title="Unused indexes" note="Never scanned since the statistics were reset. They slow writes and take space.">
          <Show when={(d()?.unused_indexes ?? []).length} fallback={<p class="empty">Every index has been used.</p>}>
            <ul class="plain-list">
              <For each={d().unused_indexes as J[]}>
                {(i: J) => (
                  <li>
                    <span class="mono small">{i.index}</span>
                    <span class="mono small muted">{bytes(i.size)}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Section>
      </div>
    </Page>
  );
}
