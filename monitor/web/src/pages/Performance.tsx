import { createSignal, For, Show } from 'solid-js';
import { Meter, RangePicker, TimeChart } from '../charts';
import { api, bytes, count, duration, type J, ms, num, pct, rate, usePoll } from '../lib';
import { Notice, Page, Section, Stat } from '../ui';

export function Performance() {
  const poll = usePoll<J>(() => api('GET', '/system'), 5000);
  const [range, setRange] = createSignal('1h');
  const [routeSort, setRouteSort] = createSignal<'rate' | 'avg_ms' | 'max_ms' | 'errors'>('rate');
  const s = () => poll.data();
  const app = () => s()?.app;
  const proc = () => s()?.app_process;
  const routes = () => {
    const list: J[] = [...(app()?.http?.routes ?? [])];
    const k = routeSort();
    list.sort((a, b) => (k === 'rate' ? b.rate - a.rate || b.count - a.count : (b[k] ?? 0) - (a[k] ?? 0)));
    return list.slice(0, 15);
  };
  return (
    <Page title="Performance" lead="How hard the machine and the app are working, and where the time goes." actions={<RangePicker value={range()} onChange={setRange} />}>
      <Section title="The machine">
        <dl class="stats">
          <Stat label="CPU" value={pct(s()?.cpu?.total)} note={s() ? `${s().host.cores} cores, ${s().host.cpu_model ?? ''}` : undefined}>
            <Meter value={s()?.cpu?.total} warn={80} danger={95} label="CPU" />
          </Stat>
          <Show when={s()?.cpu?.load}>
            <Stat label="Load" value={num(s().cpu.load[0])} note={`${num(s().cpu.load[1])} over 5 min, ${num(s().cpu.load[2])} over 15`} />
          </Show>
          <Stat label="Memory" value={s() ? pct(((s().memory.total - s().memory.available) / s().memory.total) * 100) : '–'} note={s() ? `${bytes(s().memory.available)} available of ${bytes(s().memory.total)}` : undefined}>
            <Meter value={s() ? ((s().memory.total - s().memory.available) / s().memory.total) * 100 : 0} warn={85} danger={93} label="Memory" />
          </Stat>
          <Stat label="Swap" value={bytes(s()?.memory?.swap_used)} note={s() ? `of ${bytes(s().memory.swap_total)}` : undefined} />
          <Stat label="Disk activity" value={rate(s()?.disk_io?.write)} note={`written; ${rate(s()?.disk_io?.read)} read`} />
          <Stat label="Machine up" value={duration(s()?.host?.uptime)} note={s()?.host?.os} />
        </dl>
        <Show when={s()?.cpu?.cores?.length}>
          <h3 class="label">Each core</h3>
          <ul class="cores">
            <For each={s()!.cpu.cores as number[]}>
              {(c, i) => (
                <li title={`Core ${i() + 1}: ${c.toFixed(0)}%`}>
                  <span style={{ height: `${Math.max(2, c)}%` }} />
                </li>
              )}
            </For>
          </ul>
        </Show>
        <div class="chart-grid">
          <TimeChart title="CPU" note="share of the whole machine" series={[{ key: 'cpu', label: 'Machine', slot: 1 }, { key: 'app_cpu', label: 'Linkord', slot: 2 }]} range={range} format={(n) => `${Math.round(n)}%`} max={100} />
          <TimeChart title="Memory" series={[{ key: 'mem_used', label: 'Machine', slot: 1 }, { key: 'app_rss', label: 'Linkord', slot: 2 }]} range={range} format={(n) => bytes(n, 0)} byteAxis />
          <TimeChart title="Disk activity" series={[{ key: 'disk_write', label: 'Written', slot: 1 }, { key: 'disk_read', label: 'Read', slot: 2 }]} range={range} format={(n) => rate(n)} byteAxis />
          <Show when={s()?.cpu?.load}>
            <TimeChart title="Load" note="1 minute average" series={[{ key: 'load1', label: 'Load' }]} range={range} format={(n) => num(n)} />
          </Show>
        </div>
      </Section>

      <Section title="The app" note={proc() ? `Process ${proc().pid}, running for ${duration(app()?.uptime_s ?? proc().run_time)}.` : undefined}>
        <Show when={app()} fallback={<Notice level="warning">The app's live numbers aren't available: it's down, or its internal address is off. System numbers above still work.</Notice>}>
          <dl class="stats">
            <Stat label="CPU" value={pct(proc()?.cpu, 1)} note="of the whole machine" />
            <Stat label="Memory" value={bytes(proc()?.mem)} note={proc()?.threads ? `${proc().threads} threads` : undefined} />
            <Show when={proc()?.open_files != null}>
              <Stat label="Open files" value={count(proc().open_files)} note="sockets included" />
            </Show>
            <Stat label="Requests" value={num(app().rates.req, '/s')} note={`${count(app().http.requests)} since it started`} />
            <Stat label="Typical request" value={ms(app().rates.p50)} note={`5% over ${ms(app().rates.p95)}, 1% over ${ms(app().rates.p99)}`} />
            <Stat label="Database pool" value={`${app().db_pool.size - app().db_pool.idle} / ${app().db_pool.max}`} note="connections in use" />
            <Stat label="Timers late by" value={ms(app().runtime.lag_ms)} note={`worst lately ${ms(app().runtime.lag_max_ms)}, ${count(app().runtime.tasks)} tasks`} />
            <Stat label="Connected" value={count(app().gateway.attached)} note={`${app().gateway.sessions} sessions, ${app().gateway.online_users} people`} />
          </dl>
        </Show>
        <div class="chart-grid">
          <TimeChart title="Requests" series={[{ key: 'req_rate', label: 'Requests/s' }]} range={range} format={(n) => num(n, '/s')} />
          <TimeChart title="Request time" note="half are faster, 5% are slower" series={[{ key: 'lat_p50', label: 'Typical', slot: 2 }, { key: 'lat_p95', label: 'Slowest 5%', slot: 1 }]} range={range} format={(n) => ms(n)} />
          <TimeChart title="Failed requests" note="worst moment of each period" series={[{ key: 'err_rate', label: 'Server errors', slot: 1, peak: true }, { key: 'client_err_rate', label: 'Refused', slot: 2, peak: true }]} range={range} format={(n) => num(n, '/s')} />
          <TimeChart title="Timers late" note="over about 50 ms, voice starts to suffer" series={[{ key: 'rt_lag', label: 'Lag', peak: true }]} range={range} format={(n) => ms(n)} />
        </div>
      </Section>

      <Section title="Voice and streaming">
        <Show when={app()}>
          <dl class="stats">
            <Stat label="In voice" value={app().voice.users} note={`${app().voice.calls} calls`} />
            <Stat label="Streams" value={app().voice.streams} note={`${app().voice.cameras} cameras`} />
            <Stat label="Voice relayed" value={num(app().rates.voice_pps, '/s')} note={`${rate(app().rates.voice_bps)} incoming`} />
            <Stat label="Video relayed" value={num(app().rates.media_pps, '/s')} note={`${rate(app().rates.media_bps)} incoming`} />
            <Stat label="Dropped: queue full" value={count(app().voice.queue_drops)} note="since the app started" />
            <Stat label="Dropped: too late" value={count(app().voice.stale_media)} note="video over 400 ms old" />
            <Stat label="Kass" value={app().features.music_playing ? 'Playing' : 'Idle'} note={`${app().features.watches} watch together`} />
            <Stat label="Stream previews" value={app().features.previews} note={bytes(app().features.previews_bytes)} />
          </dl>
        </Show>
        <div class="chart-grid">
          <TimeChart title="People in voice" series={[{ key: 'voice_users', label: 'In voice' }]} range={range} format={(n) => count(n)} whole />
          <TimeChart title="Traffic relayed" note="before fan-out to each listener" series={[{ key: 'media_bps', label: 'Video', slot: 1 }, { key: 'voice_bps', label: 'Voice', slot: 2 }]} range={range} format={(n) => rate(n)} byteAxis />
          <TimeChart title="Dropped packets" note="worst moment of each period" series={[{ key: 'queue_drops', label: 'Queue full', slot: 1, peak: true }, { key: 'stale_media', label: 'Too late', slot: 2, peak: true }]} range={range} format={(n) => num(n, '/s')} />
        </div>
      </Section>

      <Section
        title="Where requests go"
        note="Since the app started. Ids are folded into :id."
        actions={
          <div class="seg" role="group" aria-label="Sort routes by">
            <button classList={{ active: routeSort() === 'rate' }} onClick={() => setRouteSort('rate')}>
              Busiest
            </button>
            <button classList={{ active: routeSort() === 'avg_ms' }} onClick={() => setRouteSort('avg_ms')}>
              Slowest
            </button>
            <button classList={{ active: routeSort() === 'max_ms' }} onClick={() => setRouteSort('max_ms')}>
              Worst
            </button>
            <button classList={{ active: routeSort() === 'errors' }} onClick={() => setRouteSort('errors')}>
              Errors
            </button>
          </div>
        }
      >
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Route</th>
                <th class="r">Per second</th>
                <th class="r">Total</th>
                <th class="r">Average</th>
                <th class="r">Worst</th>
                <th class="r">Errors</th>
              </tr>
            </thead>
            <tbody>
              <For each={routes()} fallback={<tr><td colspan="6" class="empty">No requests yet.</td></tr>}>
                {(r: J) => (
                  <tr>
                    <td class="mono wrap">{r.route}</td>
                    <td class="r mono">{num(r.rate)}</td>
                    <td class="r mono">{count(r.count)}</td>
                    <td class="r mono">{ms(r.avg_ms)}</td>
                    <td class="r mono">{ms(r.max_ms)}</td>
                    <td class="r mono">{count(r.errors)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="What's running" note={s() ? `${s().host.processes} processes on this machine.` : undefined}>
        <div class="two-col">
          <ProcessTable title="By CPU" rows={s()?.top_cpu ?? []} />
          <ProcessTable title="By memory" rows={s()?.top_mem ?? []} />
        </div>
        <Show when={s()?.monitor_process}>
          <p class="muted small">
            This monitor itself: {pct(s().monitor_process.cpu, 1)} CPU, {bytes(s().monitor_process.mem)} memory.
          </p>
        </Show>
      </Section>
    </Page>
  );
}

function ProcessTable(p: { title: string; rows: J[] }) {
  return (
    <div>
      <h3 class="label">{p.title}</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Process</th>
              <th class="r">CPU</th>
              <th class="r">Memory</th>
              <th class="r">Disk</th>
            </tr>
          </thead>
          <tbody>
            <For each={p.rows}>
              {(r: J) => (
                <tr>
                  <td class="wrap" title={`pid ${r.pid}`}>
                    {r.name}
                  </td>
                  <td class="r mono">{pct(r.cpu, 1)}</td>
                  <td class="r mono">{bytes(r.mem, 0)}</td>
                  <td class="r mono">{rate(r.read + r.write)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  );
}
