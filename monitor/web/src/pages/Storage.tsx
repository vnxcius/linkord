import { createSignal, For, Show } from 'solid-js';
import { Meter, RangePicker, RankBars, TimeChart } from '../charts';
import { ago, api, bytes, count, go, type J, pct, usePoll } from '../lib';
import { Page, Section, Stat } from '../ui';

const perDay = (n: number | null | undefined) => (n == null ? 'Not enough history yet' : `${n < 0 ? '' : '+'}${bytes(n)} a day`);

export function Storage() {
  const poll = usePoll<J>(() => api('GET', '/storage'), 30000);
  const [range, setRange] = createSignal('7d');
  const d = () => poll.data();
  const g = () => d()?.growth;
  const usedPct = (x: J) => (x.used / x.total) * 100;
  const daysLeft = () => g()?.days_until_full;
  return (
    <Page title="Storage" lead="How full the disks are, what's taking the space, and how long it lasts at this rate." actions={<RangePicker value={range()} onChange={setRange} />}>
      <Section title="Disks">
        <ul class="disks">
          <For each={(d()?.disks ?? []) as J[]}>
            {(x: J) => (
              <li>
                <div class="disk-head">
                  <strong class="mono">{x.mount}</strong>
                  <Show when={d()?.data_disk?.mount === x.mount}>
                    <span class="tag">Pottira's data</span>
                  </Show>
                  <span class="muted small">
                    {x.kind !== 'Unknown' ? `${x.kind}, ` : ''}
                    {x.fs}
                  </span>
                  <span class="disk-nums mono">
                    {bytes(x.free)} free of {bytes(x.total)}, {pct(usedPct(x))} used
                  </span>
                </div>
                <Meter value={usedPct(x)} label={`Disk ${x.mount} used`} />
              </li>
            )}
          </For>
        </ul>
      </Section>

      <Section title="Growth" note="Trend over the last 14 days.">
        <dl class="stats">
          <Stat label="Full in" value={daysLeft() == null ? '–' : daysLeft() > 3650 ? '10+ years' : `${Math.round(daysLeft())} days`} note={daysLeft() == null ? 'Not growing, or too little history' : 'at this rate'} />
          <Stat label="The disk" value={bytes(d()?.data_disk?.used)} note={perDay(g()?.disk_per_day)} />
          <Stat label="Database" value={bytes(d()?.database_bytes)} note={perDay(g()?.database_per_day)} />
          <Stat label="Uploads" value={bytes(d()?.scan?.uploads_bytes)} note={perDay(g()?.uploads_per_day)} />
        </dl>
        <div class="chart-grid">
          <TimeChart title="Disk used" series={[{ key: 'disk_used', label: 'Used' }]} range={range} format={(n) => bytes(n, 0)} byteAxis />
          <TimeChart title="Pottira's data" series={[{ key: 'uploads_bytes', label: 'Uploads', slot: 1 }, { key: 'pg_size', label: 'Database', slot: 2 }]} range={range} format={(n) => bytes(n, 0)} byteAxis />
        </div>
      </Section>

      <Section title="Pottira's folders" note={d()?.scan?.scanned ? `Measured ${ago(d().scan.scanned)}; every 10 minutes.` : 'First measurement in progress.'}>
        <RankBars
          rows={[
            ...((d()?.scan?.app ?? []) as J[]).map((a) => ({ label: a.name, value: a.bytes, note: `${count(a.files)} files` })),
            ...(d()?.database_bytes != null ? [{ label: 'Database', value: d().database_bytes }] : []),
            ...(d()?.monitor_bytes ? [{ label: "This monitor's history", value: d().monitor_bytes }] : []),
          ].sort((a, b) => b.value - a.value)}
          format={(n) => bytes(n)}
        />
      </Section>

      <Section
        title="What people uploaded"
        note={d()?.scan ? `${count(d().scan.uploads_files)} files, ${bytes(d().scan.uploads_bytes)}.` : undefined}
        actions={<button class="link-btn" onClick={() => go('media')}>See the files</button>}
      >
        <RankBars rows={((d()?.scan?.uploads ?? []) as J[]).map((a) => ({ label: a.name, value: a.bytes, note: `${count(a.files)} files` }))} format={(n) => bytes(n)} />
      </Section>
    </Page>
  );
}
