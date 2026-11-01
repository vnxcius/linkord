import { createMemo, For, Show } from 'solid-js';
import { Meter, Sparkline, TimeChart } from '../charts';
import { api, bytes, count, duration, go, type J, ms, num, pct, rate, usePoll } from '../lib';
import { checkLevel, checkWord, Glyph, Page, Section, Stat, Status } from '../ui';

const HEADLINES: Record<string, string> = {
  ok: 'Everything is running.',
  warning: 'Running, with something to look at.',
  critical: 'Something is broken.',
  starting: 'Taking the first readings…',
};

export function Overview(p: { now: J }) {
  const spark = usePoll<J>(() => api('GET', '/series?keys=cpu,mem_used,req_rate,lat_p95,ws_online,voice_users,err_rate&range=1h'), 30000);
  const line = (key: string) => (spark.data()?.series?.[key]?.avg ?? []) as (number | null)[];
  const memPct = () => {
    const m = p.now?.memory;
    return m ? ((m.total - m.available) / m.total) * 100 : null;
  };
  const diskPct = () => {
    const d = p.now?.data_disk;
    return d ? (d.used / d.total) * 100 : null;
  };
  const groups = createMemo(() => {
    const checks: J[] = p.now?.checks ?? [];
    return [
      { name: 'The app', list: checks.filter((c) => c.group === 'app') },
      { name: 'How people reach it', list: checks.filter((c) => c.group === 'access') },
      { name: 'What it depends on', list: checks.filter((c) => c.group === 'internet') },
    ].filter((g) => g.list.length);
  });
  const downCount = () => (p.now?.checks ?? []).filter((c: J) => c.status === 'down').length;
  const a = () => p.now?.app;

  return (
    <Page title="Overview">
      <div class={`verdict ${p.now?.verdict ?? 'starting'}`}>
        <Glyph level={p.now?.verdict === 'ok' ? 'ok' : p.now?.verdict === 'critical' ? 'critical' : p.now?.verdict === 'warning' ? 'warning' : 'none'} />
        <div>
          <p class="verdict-line">{HEADLINES[p.now?.verdict ?? 'starting']}</p>
          <p class="muted">
            <Show when={a()} fallback="The app's live numbers aren't available.">
              App up for {duration(a().uptime_s)}. {a().gateway.online_users} online, {a().voice.users} in voice
              <Show when={a().voice.streams}>, {a().voice.streams} streaming</Show>.
            </Show>{' '}
            <Show when={downCount() > 0}>{downCount()} checks failing.</Show>
          </p>
        </div>
      </div>

      <Section title="Right now">
        <dl class="stats">
          <Stat label="People online" value={a() ? a().gateway.online_users : '–'} note={a() ? `${a().gateway.attached} connections` : undefined}>
            <Sparkline values={line('ws_online')} />
          </Stat>
          <Stat label="In voice" value={a() ? a().voice.users : '–'} note={a() ? `${a().voice.calls} calls, ${a().voice.streams} streams` : undefined}>
            <Sparkline values={line('voice_users')} />
          </Stat>
          <Stat label="Requests" value={num(a()?.rates?.req, '/s')} note={a() ? `${a().in_flight} in progress` : undefined}>
            <Sparkline values={line('req_rate')} />
          </Stat>
          <Stat label="Slowest 5%" value={ms(a()?.rates?.p95)} note="of requests take longer">
            <Sparkline values={line('lat_p95')} />
          </Stat>
          <Stat label="Failed requests" value={num(a()?.rates?.server_err, '/s')} note="server errors">
            <Sparkline values={line('err_rate')} />
          </Stat>
          <Stat label="CPU" value={pct(p.now?.cpu?.total)} note={p.now?.app_process ? `app ${pct(p.now.app_process.cpu, 1)}` : undefined}>
            <Sparkline values={line('cpu')} max={100} />
          </Stat>
          <Stat label="Memory" value={pct(memPct())} note={`${bytes(p.now?.memory?.used)} of ${bytes(p.now?.memory?.total)}`}>
            <Sparkline values={line('mem_used')} max={p.now?.memory?.total} />
          </Stat>
          <Stat label="Disk" value={pct(diskPct())} note={`${bytes(p.now?.data_disk?.free)} free`}>
            <Meter value={diskPct()} label="Disk used" />
          </Stat>
          <Stat label="Network" value={rate(p.now?.net?.tx)} note={`out; ${rate(p.now?.net?.rx)} in`} />
        </dl>
      </Section>

      <Section title="Checks" note="Each is tried for real every 30 seconds." actions={<button class="link-btn" onClick={() => go('availability')}>History</button>}>
        <div class="check-groups">
          <For each={groups()}>
            {(g) => (
              <div>
                <h3 class="label">{g.name}</h3>
                <ul class="checks">
                  <For each={g.list}>
                    {(c: J) => (
                      <li title={c.detail}>
                        <Status level={checkLevel(c.status)}>{c.name}</Status>
                        <span class="mono small muted">{c.status === 'waiting' ? checkWord(c.status) : c.status === 'down' ? 'Down' : ms(c.ms)}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            )}
          </For>
        </div>
      </Section>

      <Section title="Last 24 hours">
        <div class="chart-grid">
          <TimeChart title="People online" series={[{ key: 'ws_online', label: 'Online' }]} range={() => '24h'} format={(n) => count(n)} whole height={130} />
          <TimeChart title="CPU" series={[{ key: 'cpu', label: 'CPU' }]} range={() => '24h'} format={(n) => `${Math.round(n)}%`} max={100} height={130} />
        </div>
      </Section>
    </Page>
  );
}
