// The dashboard's marks. Thin lines and bars, hairline grid, one y axis per chart, a crosshair that lists every series,
// a legend from two series up and a table view of the same numbers. Series colors passed the palette validator on the
// page surface (--s1, --s2); status colors only ever mean status.
import { type Accessor, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { api, type J, usePoll } from './lib';

export interface SeriesDef {
  key: string;
  label: string;
  /** Series slot: 1 = gold, 2 = blue. Follows the series, never its rank. */
  slot?: 1 | 2;
  /** Multiplies stored values for display. */
  scale?: number;
  /** Show each bucket's worst value rather than its average (errors, drops, lag). */
  peak?: boolean;
}

const niceStep = (range: number, ticks: number) => {
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
};
/** Steps that make sense for bytes (powers of 1024) so axes read 512 MB, 1 GB rather than 1.07 GB. */
const niceByteStep = (range: number, ticks: number) => {
  const raw = range / ticks;
  const unit = 1024 ** Math.floor(Math.log(raw || 1) / Math.log(1024));
  const n = raw / unit;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : n <= 10 ? 10 : n <= 25 ? 25 : n <= 50 ? 50 : n <= 100 ? 100 : n <= 250 ? 250 : n <= 512 ? 512 : 1024;
  return step * unit;
};

const timeLabel = (ts: number, span: number) => {
  const d = new Date(ts * 1000);
  return span > 2 * 86400
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
};
const fullTime = (ts: number) =>
  new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export const RANGES = ['15m', '1h', '6h', '24h', '7d', '30d'];

export function RangePicker(p: { value: string; onChange: (r: string) => void }) {
  return (
    <div class="seg" role="group" aria-label="Time range">
      <For each={RANGES}>
        {(r) => (
          <button classList={{ active: p.value === r }} aria-pressed={p.value === r} onClick={() => p.onChange(r)}>
            {r}
          </button>
        )}
      </For>
    </div>
  );
}

const H = 170;
const PAD = { top: 10, right: 12, bottom: 22, left: 66 };

export function TimeChart(p: {
  title: string;
  note?: string;
  series: SeriesDef[];
  range: Accessor<string>;
  format: (n: number) => string;
  /** Top of the axis when the measure has a natural end (100%). */
  max?: number;
  /** Axis steps in powers of 1024. */
  byteAxis?: boolean;
  /** Counts of whole things: no axis step under 1. */
  whole?: boolean;
  height?: number;
}) {
  const keys = p.series.map((s) => s.key).join(',');
  const poll = usePoll<J>(() => api('GET', `/series?keys=${keys}&range=${p.range()}`), 20000);
  createEffect(on(p.range, () => void poll.refresh(), { defer: true }));

  const [width, setWidth] = createSignal(600);
  let box!: HTMLDivElement;
  onMount(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(box);
    onCleanup(() => ro.disconnect());
  });
  const [hover, setHover] = createSignal<number | null>(null);
  const [asTable, setAsTable] = createSignal(false);
  const height = () => p.height ?? H;

  const model = createMemo(() => {
    const d = poll.data();
    if (!d) return null;
    const ts: number[] = d.ts ?? [];
    const lines = p.series.map((s) => {
      const raw: (number | null)[] = d.series?.[s.key]?.[s.peak ? 'max' : 'avg'] ?? [];
      return { def: s, values: raw.map((v) => (v == null ? null : v * (s.scale ?? 1))) };
    });
    const all = lines.flatMap((l) => l.values).filter((v): v is number => v != null);
    const top = p.max ?? Math.max(...all, 0);
    const raw = (p.byteAxis ? niceByteStep : niceStep)(top || 1, 4);
    const step = p.whole ? Math.max(1, Math.ceil(raw)) : raw;
    const yMax = p.max ?? Math.ceil((top || 1) / step) * step;
    return { ts, lines, from: d.from as number, to: d.to as number, yMax, step, hasData: all.length > 0 };
  });

  const x = (t: number) => {
    const m = model()!;
    return PAD.left + ((t - m.from) / (m.to - m.from)) * (width() - PAD.left - PAD.right);
  };
  const y = (v: number) => {
    const m = model()!;
    return PAD.top + (1 - v / (m.yMax || 1)) * (height() - PAD.top - PAD.bottom);
  };
  /** A gap in the data (monitor off, app down) stays a gap, it isn't drawn over. */
  const pathOf = (values: (number | null)[]) => {
    const m = model()!;
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(m.ts[i]).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const areaOf = (values: (number | null)[]) => {
    const m = model()!;
    const base = y(0).toFixed(1);
    let d = '';
    let start = -1;
    let last = -1;
    const close = () => {
      if (start >= 0) d += `L${x(m.ts[last]).toFixed(1)} ${base}L${x(m.ts[start]).toFixed(1)} ${base}Z`;
    };
    values.forEach((v, i) => {
      if (v == null) {
        close();
        start = -1;
        return;
      }
      d += `${start < 0 ? `M${x(m.ts[i]).toFixed(1)} ${y(v).toFixed(1)}` : `L${x(m.ts[i]).toFixed(1)} ${y(v).toFixed(1)}`}`;
      if (start < 0) start = i;
      last = i;
    });
    close();
    return d;
  };
  const ticks = () => {
    const m = model()!;
    const out = [];
    for (let v = 0; v <= m.yMax + 1e-9; v += m.step) out.push(v);
    return out.slice(0, 7);
  };
  const xTicks = () => {
    const m = model()!;
    const n = Math.max(2, Math.floor(width() / 130));
    return Array.from({ length: n }, (_, i) => m.from + ((m.to - m.from) * (i + 0.5)) / n);
  };
  const nearest = (clientX: number) => {
    const m = model();
    if (!m?.ts.length) return null;
    const rect = box.getBoundingClientRect();
    const t = m.from + ((clientX - rect.left - PAD.left) / (width() - PAD.left - PAD.right)) * (m.to - m.from);
    let best = 0;
    m.ts.forEach((v, i) => {
      if (Math.abs(v - t) < Math.abs(m.ts[best] - t)) best = i;
    });
    return best;
  };
  const onKey = (e: KeyboardEvent) => {
    const m = model();
    if (!m?.ts.length) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      const cur = hover() ?? (dir < 0 ? m.ts.length : -1);
      setHover(Math.max(0, Math.min(m.ts.length - 1, cur + dir)));
    } else if (e.key === 'Escape') setHover(null);
  };
  /** Axis labels stay short: 50 MB/s, not 50.0 MB/s, which wouldn't fit. */
  const tick = (v: number) => p.format(v).replace(/\.0(?=\D|$)/, '');
  /** A point with no neighbors draws no line, so it gets a dot of its own. */
  const lonely = (values: (number | null)[]) =>
    values.flatMap((v, i) => (v != null && values[i - 1] == null && values[i + 1] == null ? [{ i, v }] : []));
  const latest = (values: (number | null)[]) => {
    for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return values[i];
    return null;
  };

  return (
    <figure class="chart" classList={{ refreshing: poll.loading() && !!poll.data() }}>
      <figcaption>
        <div class="chart-title">
          <strong>{p.title}</strong>
          <Show when={p.note}>
            <span class="muted small">{p.note}</span>
          </Show>
        </div>
        <button class="link-btn" onClick={() => setAsTable(!asTable())} aria-pressed={asTable()}>
          {asTable() ? 'Chart' : 'Table'}
        </button>
      </figcaption>
      <Show when={p.series.length > 1}>
        <ul class="legend">
          <For each={model()?.lines ?? []}>
            {(l) => (
              <li>
                <i class={`key s${l.def.slot ?? 1}`} />
                <span>{l.def.label}</span>
                <b>{latest(l.values) == null ? '–' : p.format(latest(l.values)!)}</b>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={p.series.length === 1 && model()}>
        <p class="chart-now">{latest(model()!.lines[0].values) == null ? '–' : p.format(latest(model()!.lines[0].values)!)}</p>
      </Show>
      <div class="chart-box" ref={box} style={{ height: `${height()}px` }} hidden={asTable()}>
        <Show when={model()?.hasData} fallback={<p class="chart-empty">{poll.data() ? 'No history for this range yet. It builds up from when the monitor started.' : 'Loading…'}</p>}>
          <svg
            role="img"
            aria-label={`${p.title}. Use the left and right arrow keys to read values.`}
            tabindex="0"
            width={width()}
            height={height()}
            onPointerMove={(e) => setHover(nearest(e.clientX))}
            onPointerLeave={() => setHover(null)}
            onKeyDown={onKey}
            onBlur={() => setHover(null)}
          >
            <For each={ticks()}>
              {(v) => (
                <>
                  <line class="grid" x1={PAD.left} x2={width() - PAD.right} y1={y(v)} y2={y(v)} />
                  <text class="axis" x={PAD.left - 8} y={y(v) + 4} text-anchor="end">
                    {tick(v)}
                  </text>
                </>
              )}
            </For>
            <For each={xTicks()}>
              {(t) => (
                <text class="axis" x={x(t)} y={height() - 6} text-anchor="middle">
                  {timeLabel(t, model()!.to - model()!.from)}
                </text>
              )}
            </For>
            <For each={model()!.lines}>
              {(l) => (
                <>
                  <Show when={p.series.length === 1}>
                    <path class={`area s${l.def.slot ?? 1}`} d={areaOf(l.values)} />
                  </Show>
                  <path class={`line s${l.def.slot ?? 1}`} d={pathOf(l.values)} />
                  <For each={lonely(l.values)}>
                    {(pt) => <circle class={`dot s${l.def.slot ?? 1}`} cx={x(model()!.ts[pt.i])} cy={y(pt.v)} r="4" />}
                  </For>
                </>
              )}
            </For>
            <Show when={hover() != null}>
              <line class="crosshair" x1={x(model()!.ts[hover()!])} x2={x(model()!.ts[hover()!])} y1={PAD.top} y2={height() - PAD.bottom} />
              <For each={model()!.lines}>
                {(l) => (
                  <Show when={l.values[hover()!] != null}>
                    <circle class={`dot s${l.def.slot ?? 1}`} cx={x(model()!.ts[hover()!])} cy={y(l.values[hover()!]!)} r="4" />
                  </Show>
                )}
              </For>
            </Show>
          </svg>
          <Show when={hover() != null}>
            <div
              class="chart-tip"
              style={{
                left: `${x(model()!.ts[hover()!])}px`,
                transform: x(model()!.ts[hover()!]) > width() - 180 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
              }}
            >
              <time>{fullTime(model()!.ts[hover()!])}</time>
              <For each={model()!.lines}>
                {(l) => (
                  <div class="tip-row">
                    <i class={`key s${l.def.slot ?? 1}`} />
                    <b>{l.values[hover()!] == null ? 'no data' : p.format(l.values[hover()!]!)}</b>
                    <span>{l.def.label}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
      <Show when={asTable()}>
        <div class="table-wrap chart-table">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <For each={p.series}>{(s) => <th class="r">{s.label}</th>}</For>
              </tr>
            </thead>
            <tbody>
              <For each={(model()?.ts ?? []).map((t, i) => ({ t, i })).reverse().slice(0, 60)}>
                {(row) => (
                  <tr>
                    <td class="mono">{fullTime(row.t)}</td>
                    <For each={model()!.lines}>
                      {(l) => <td class="r mono">{l.values[row.i] == null ? '–' : p.format(l.values[row.i]!)}</td>}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </figure>
  );
}

/** Small trend beside a number, in the de-emphasis gray. */
export function Sparkline(p: { values: (number | null)[]; max?: number }) {
  const W = 92;
  const H2 = 26;
  const path = () => {
    const vals = p.values;
    const top = p.max ?? Math.max(...vals.map((v) => v ?? 0), 0.0001);
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      const xp = (i / Math.max(1, vals.length - 1)) * W;
      const yp = H2 - 2 - (v / top) * (H2 - 4);
      d += `${pen ? 'L' : 'M'}${xp.toFixed(1)} ${yp.toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  return (
    <svg class="spark" width={W} height={H2} viewBox={`0 0 ${W} ${H2}`} aria-hidden="true">
      <path d={path()} />
    </svg>
  );
}

/** Columns from a shared baseline; segments stack with a 2px surface gap. `parts` go bottom to top. */
export function Columns(p: {
  rows: { label: string; parts: number[] }[];
  parts: { name: string; cls: string }[];
  format?: (n: number) => string;
  height?: number;
  title: string;
}) {
  const fmt = p.format ?? ((n: number) => n.toLocaleString('en-US'));
  const height = () => p.height ?? 96;
  const top = () => Math.max(1, ...p.rows.map((r) => r.parts.reduce((a, b) => a + b, 0)));
  const [tip, setTip] = createSignal<{ i: number } | null>(null);
  return (
    <figure class="columns-fig">
      <Show when={p.parts.length > 1}>
        <ul class="legend">
          <For each={p.parts}>
            {(part) => (
              <li>
                <i class={`key box ${part.cls}`} />
                <span>{part.name}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="columns" style={{ height: `${height()}px` }} role="list" aria-label={p.title}>
        <For each={p.rows}>
          {(row, i) => {
            const total = () => row.parts.reduce((a, b) => a + b, 0);
            return (
              <div
                class="col"
                role="listitem"
                tabindex="0"
                aria-label={`${row.label}: ${p.parts.map((part, n) => `${fmt(row.parts[n])} ${part.name}`).join(', ')}`}
                onPointerEnter={() => setTip({ i: i() })}
                onPointerLeave={() => setTip(null)}
                onFocus={() => setTip({ i: i() })}
                onBlur={() => setTip(null)}
              >
                <div class="col-stack">
                  <For each={[...p.parts.keys()].reverse()}>
                    {(n) => (
                      <Show when={row.parts[n] > 0}>
                        <span class={`col-part ${p.parts[n].cls}`} style={{ height: `${Math.max(2, (row.parts[n] / top()) * (height() - 4))}px` }} />
                      </Show>
                    )}
                  </For>
                  <Show when={total() === 0}>
                    <span class="col-zero" />
                  </Show>
                </div>
                <Show when={tip()?.i === i()}>
                  <div class="col-tip" classList={{ flip: i() > p.rows.length / 2 }}>
                    <time>{row.label}</time>
                    <For each={p.parts}>
                      {(part, n) => (
                        <div class="tip-row">
                          <i class={`key box ${part.cls}`} />
                          <b>{fmt(row.parts[n()])}</b>
                          <span>{part.name}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
      <div class="col-axis">
        <span>{p.rows[0]?.label}</span>
        <span>{p.rows[p.rows.length - 1]?.label}</span>
      </div>
    </figure>
  );
}

/** Ranked horizontal bars: one color, value at the end. */
export function RankBars(p: { rows: { label: string; value: number; note?: string }[]; format: (n: number) => string }) {
  const top = () => Math.max(1, ...p.rows.map((r) => r.value));
  return (
    <ul class="rank">
      <For each={p.rows}>
        {(r) => (
          <li>
            <span class="rank-label">
              {r.label}
              <Show when={r.note}>
                <span class="muted small"> {r.note}</span>
              </Show>
            </span>
            <span class="rank-track">
              <i style={{ width: `${Math.max(0.5, (r.value / top()) * 100)}%` }} />
            </span>
            <b class="mono">{p.format(r.value)}</b>
          </li>
        )}
      </For>
    </ul>
  );
}

/** Fill = how full; turns to warning and critical past its thresholds. */
export function Meter(p: { value: number | null | undefined; warn?: number; danger?: number; label?: string }) {
  const v = () => Math.max(0, Math.min(100, p.value ?? 0));
  const level = () => (v() >= (p.danger ?? 95) ? 'critical' : v() >= (p.warn ?? 85) ? 'warning' : 'normal');
  return (
    <div class={`meter ${level()}`} role="meter" aria-valuenow={Math.round(v())} aria-valuemin={0} aria-valuemax={100} aria-label={p.label}>
      <i style={{ width: `${v()}%` }} />
    </div>
  );
}

/** One thin slot per period: green = all fine, amber = some failures, red = mostly failed, gray = wasn't watching. */
export function StatusBars(p: { history: J; count: number; label: (slot: number) => string }) {
  const slots = createMemo(() => {
    const out: (J | null)[] = Array(p.count).fill(null);
    for (const s of p.history?.slots ?? []) if (s.slot >= 0 && s.slot < p.count) out[s.slot] = s;
    return out;
  });
  const cls = (s: J | null) => (!s ? 'none' : s.fail === 0 ? 'ok' : s.fail / (s.ok + s.fail) >= 0.5 ? 'bad' : 'some');
  const text = (s: J | null, i: number) => {
    if (!s) return `${p.label(i)}: not watching`;
    const up = ((s.ok * 100) / (s.ok + s.fail)).toFixed(s.fail ? 1 : 0);
    return `${p.label(i)}: ${up}% up, ${Math.round(s.ms)} ms average`;
  };
  return (
    <div class="status-bars">
      <For each={slots()}>{(s, i) => <i class={cls(s)} title={text(s, i())} />}</For>
    </div>
  );
}
