import { createSignal, For, Show } from 'solid-js';
import { RangePicker, TimeChart } from '../charts';
import { ago, api, bytes, date, dateTime, type J, ms, num, pct, rate, usePoll } from '../lib';
import { checkLevel, Notice, Page, Section, Stat, Status } from '../ui';

export function Network() {
  const poll = usePoll<J>(() => api('GET', '/network'), 10000);
  const [range, setRange] = createSignal('6h');
  const [testing, setTesting] = createSignal(false);
  const [testError, setTestError] = createSignal('');
  const d = () => poll.data();
  const internet = () => (d()?.checks ?? []).find((c: J) => c.id === 'internet');
  const latestSpeed = () => d()?.speedtests?.[0];
  const runTest = async () => {
    setTesting(true);
    setTestError('');
    try {
      await api('POST', '/tools/speedtest');
      await poll.refresh();
    } catch (e) {
      setTestError(e instanceof Error ? e.message : 'The speed test failed.');
    } finally {
      setTesting(false);
    }
  };
  const realInterfaces = () => (d()?.interfaces ?? []).filter((i: J) => !i.virtual || i.rx_total + i.tx_total > 0);
  return (
    <Page title="Network" lead="This machine's connection, and whether what Linkord depends on answers." actions={<RangePicker value={range()} onChange={setRange} />}>
      <Section title="The connection">
        <dl class="stats">
          <Stat label="Going out" value={rate(d()?.net?.tx)} note="streams and voice to people" />
          <Stat label="Coming in" value={rate(d()?.net?.rx)} note="streams and uploads from people" />
          <Stat label="Round trip" value={ms(internet()?.ms)} note={internet() ? 'to the nearest well-known address' : 'Internet checks are off'} />
          <Stat label="Loss" value={pct(internet()?.loss)} note="test connections that failed" />
          <Stat label="Public IP" value={<span class="mono value-small">{d()?.trace?.ip ?? '–'}</span>} note={d()?.trace?.colo ? `through Cloudflare ${d().trace.colo}, ${d().trace.country}` : undefined} />
          <Show when={d()?.trace?.direct_host}>
            <Stat label="Direct address" value={<span class="mono value-small">{d().trace.direct_ips?.join(', ') || 'No answer'}</span>} note={d().trace.direct_ips?.includes(d().trace.ip) ? 'matches the public IP' : 'does not match the public IP'} />
          </Show>
        </dl>
        <div class="chart-grid">
          <TimeChart title="Traffic" series={[{ key: 'net_tx', label: 'Going out', slot: 1 }, { key: 'net_rx', label: 'Coming in', slot: 2 }]} range={range} format={(n) => rate(n)} byteAxis />
          <TimeChart title="Round trip" series={[{ key: 'net_latency', label: 'Round trip' }]} range={range} format={(n) => ms(n)} />
          <TimeChart title="Loss" note="worst moment of each period" series={[{ key: 'net_loss', label: 'Loss', peak: true }]} range={range} format={(n) => `${Math.round(n)}%`} max={100} />
        </div>
      </Section>

      <Section
        title="Speed test"
        note="On demand only: it downloads about 25 MB and uploads about 10 MB over the same connection as the calls, through Cloudflare."
        actions={
          <button class="btn" disabled={testing() || d()?.probing === false} onClick={runTest}>
            {testing() ? 'Testing, about 20 s…' : 'Run speed test'}
          </button>
        }
      >
        <Show when={testError()}>
          <Notice level="warning">{testError()}</Notice>
        </Show>
        <Show when={latestSpeed()} fallback={<p class="empty">No test run yet.</p>}>
          <dl class="stats">
            <Stat label="Download" value={num(latestSpeed().down, ' Mbps')} note={ago(latestSpeed().ts)} />
            <Stat label="Upload" value={num(latestSpeed().up, ' Mbps')} note="what limits streams" />
            <Stat label="Round trip" value={ms(latestSpeed().latency)} note={latestSpeed().colo ? `to Cloudflare ${latestSpeed().colo}` : undefined} />
          </dl>
          <Show when={(d()?.speedtests ?? []).length > 1}>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th class="r">Download</th>
                    <th class="r">Upload</th>
                    <th class="r">Round trip</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={d().speedtests as J[]}>
                    {(t: J) => (
                      <tr>
                        <td class="mono">{dateTime(t.ts)}</td>
                        <td class="r mono">{num(t.down, ' Mbps')}</td>
                        <td class="r mono">{num(t.up, ' Mbps')}</td>
                        <td class="r mono">{ms(t.latency)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>
      </Section>

      <Section title="Addresses and services">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>What</th>
                <th>Used for</th>
                <th>State</th>
                <th class="r">Answered in</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              <For each={(d()?.checks ?? []) as J[]} fallback={<tr><td colspan="5" class="empty">Internet checks are off and no public address is configured.</td></tr>}>
                {(c: J) => (
                  <tr>
                    <td class="nowrap">{c.name}</td>
                    <td class="wrap small muted">{c.what}</td>
                    <td class="nowrap">
                      <Status level={checkLevel(c.status)}>{c.status}</Status>
                    </td>
                    <td class="r mono">{ms(c.ms)}</td>
                    <td class="wrap small">{c.detail}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Certificates" note="Read from what each address presents, hourly. The direct address renews itself 30 days before expiry.">
        <Show when={(d()?.certs ?? []).length} fallback={<p class="empty">No https addresses configured here.</p>}>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Issuer</th>
                  <th>Expires</th>
                  <th class="r">Days left</th>
                </tr>
              </thead>
              <tbody>
                <For each={d().certs as J[]}>
                  {(c: J) => (
                    <tr>
                      <td class="wrap">
                        {c.label}
                        <span class="muted small mono"> {c.host}:{c.port}</span>
                      </td>
                      <td class="wrap small">{c.cert?.issuer ?? c.error}</td>
                      <td class="mono nowrap">{c.cert ? date(c.cert.not_after) : '–'}</td>
                      <td class="r nowrap">
                        <Show when={c.cert} fallback="–">
                          <Status level={c.cert.days_left < 7 ? 'critical' : c.cert.days_left < 20 ? 'warning' : 'ok'}>{c.cert.days_left}</Status>
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Section>

      <Section title="Network interfaces">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Interface</th>
                <th>Addresses</th>
                <th class="r">Out</th>
                <th class="r">In</th>
                <th class="r">Total out</th>
                <th class="r">Total in</th>
                <th class="r">Errors</th>
              </tr>
            </thead>
            <tbody>
              <For each={realInterfaces() as J[]}>
                {(i: J) => (
                  <tr>
                    <td class="wrap">{i.name}</td>
                    <td class="wrap small mono muted">{i.ips.join(', ')}</td>
                    <td class="r mono">{rate(i.tx)}</td>
                    <td class="r mono">{rate(i.rx)}</td>
                    <td class="r mono">{bytes(i.tx_total)}</td>
                    <td class="r mono">{bytes(i.rx_total)}</td>
                    <td class="r mono">{i.errors}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Section>
    </Page>
  );
}
