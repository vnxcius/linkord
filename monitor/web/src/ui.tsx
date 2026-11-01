// Small pieces every tab uses.
import { type JSX, Show } from 'solid-js';

export type Level = 'ok' | 'warning' | 'critical' | 'info' | 'none';

/** Status is never color alone: each level has its own shape and a word. */
export function Glyph(p: { level: Level }) {
  return (
    <svg class={`glyph ${p.level}`} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <Show when={p.level === 'ok'}>
        <circle cx="8" cy="8" r="7" />
        <path d="M4.8 8.3 7 10.5l4.2-4.8" />
      </Show>
      <Show when={p.level === 'warning'}>
        <path class="solid" d="M8 1.6 15.2 14H.8Z" />
        <path class="mark" d="M8 6v3.6M8 11.6v.4" />
      </Show>
      <Show when={p.level === 'critical'}>
        <circle cx="8" cy="8" r="7" />
        <path d="m5.2 5.2 5.6 5.6m0-5.6-5.6 5.6" />
      </Show>
      <Show when={p.level === 'info'}>
        <circle cx="8" cy="8" r="7" />
        <path d="M8 7.2v4M8 4.6v.4" />
      </Show>
      <Show when={p.level === 'none'}>
        <circle cx="8" cy="8" r="7" />
        <path d="M5 8h6" />
      </Show>
    </svg>
  );
}

export function Status(p: { level: Level; children: JSX.Element }) {
  return (
    <span class={`status ${p.level}`}>
      <Glyph level={p.level} />
      <span>{p.children}</span>
    </span>
  );
}

/** A check's state, in words. */
export const checkLevel = (status: string): Level =>
  status === 'up' ? 'ok' : status === 'slow' ? 'warning' : status === 'down' ? 'critical' : 'none';
export const checkWord = (status: string) => ({ up: 'Up', slow: 'Slow', down: 'Down', waiting: 'Waiting' })[status] ?? status;

export function Stat(p: { label: string; value: JSX.Element; note?: JSX.Element; children?: JSX.Element }) {
  return (
    <div class="stat">
      <dt>{p.label}</dt>
      <dd>{p.value}</dd>
      <Show when={p.note}>
        <p class="stat-note">{p.note}</p>
      </Show>
      {p.children}
    </div>
  );
}

export function Section(p: { title: string; note?: JSX.Element; actions?: JSX.Element; children: JSX.Element; id?: string }) {
  return (
    <section class="section" id={p.id}>
      <header class="section-head">
        <div>
          <h2>{p.title}</h2>
          <Show when={p.note}>
            <p class="muted">{p.note}</p>
          </Show>
        </div>
        <Show when={p.actions}>
          <div class="section-actions">{p.actions}</div>
        </Show>
      </header>
      {p.children}
    </section>
  );
}

export function Page(p: { title: string; lead?: JSX.Element; children: JSX.Element; actions?: JSX.Element }) {
  return (
    <div class="page-body">
      <header class="page-head">
        <div>
          <h1>{p.title}</h1>
          <Show when={p.lead}>
            <p class="lead">{p.lead}</p>
          </Show>
        </div>
        <Show when={p.actions}>
          <div class="page-actions">{p.actions}</div>
        </Show>
      </header>
      {p.children}
    </div>
  );
}

export function Notice(p: { level?: Level; children: JSX.Element }) {
  return (
    <div class={`notice ${p.level ?? 'info'}`} role="status">
      <Glyph level={p.level ?? 'info'} />
      <div>{p.children}</div>
    </div>
  );
}
