// Small pieces every tab uses.
import { createSignal, type JSX, onCleanup, onMount, Show, splitProps } from 'solid-js';
import arrowLeft from 'heroicons/24/outline/arrow-left.svg?raw';
import arrowRightStart from 'heroicons/24/outline/arrow-right-start-on-rectangle.svg?raw';
import bars3 from 'heroicons/24/outline/bars-3.svg?raw';
import bell from 'heroicons/24/outline/bell.svg?raw';
import bolt from 'heroicons/24/outline/bolt.svg?raw';
import chevronRight from 'heroicons/24/outline/chevron-right.svg?raw';
import circleStack from 'heroicons/24/outline/circle-stack.svg?raw';
import commandLine from 'heroicons/24/outline/command-line.svg?raw';
import globe from 'heroicons/24/outline/globe-alt.svg?raw';
import home from 'heroicons/24/outline/home.svg?raw';
import magnifier from 'heroicons/24/outline/magnifying-glass.svg?raw';
import photo from 'heroicons/24/outline/photo.svg?raw';
import serverStack from 'heroicons/24/outline/server-stack.svg?raw';
import signal from 'heroicons/24/outline/signal.svg?raw';
import squares from 'heroicons/24/outline/squares-2x2.svg?raw';
import tableCells from 'heroicons/24/outline/table-cells.svg?raw';
import trash from 'heroicons/24/outline/trash.svg?raw';
import users from 'heroicons/24/outline/users.svg?raw';
import user from 'heroicons/24/outline/user.svg?raw';
import wrench from 'heroicons/24/outline/wrench-screwdriver.svg?raw';
import xMark from 'heroicons/24/outline/x-mark.svg?raw';
import { mediaUrl } from './lib';

const body = (svg: string) =>
  svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim();

type IconProps = JSX.SvgSVGAttributes<SVGSVGElement> & { size?: number };
/** Heroicons outline (the app's set), 1.5 stroke on the 24px grid. */
const icon = (svg: string) => {
  const shapes = body(svg);
  return (p: IconProps) => {
    const [own, rest] = splitProps(p, ['size']);
    return <svg class="icon" width={own.size ?? 18} height={own.size ?? 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={1.5} aria-hidden="true" {...rest} innerHTML={shapes} />;
  };
};

export const I = {
  back: icon(arrowLeft),
  signOut: icon(arrowRightStart),
  menu: icon(bars3),
  bell: icon(bell),
  bolt: icon(bolt),
  chevron: icon(chevronRight),
  database: icon(circleStack),
  logs: icon(commandLine),
  globe: icon(globe),
  home: icon(home),
  search: icon(magnifier),
  photo: icon(photo),
  servers: icon(serverStack),
  signal: icon(signal),
  squares: icon(squares),
  table: icon(tableCells),
  trash: icon(trash),
  people: icon(users),
  person: icon(user),
  wrench: icon(wrench),
  close: icon(xMark),
};

/** A picture from the app's uploads, or the first letter: rounded squares, like the app. */
export function Avatar(p: { url?: string | null; name: string; size?: 'lg' }) {
  const [failed, setFailed] = createSignal(false);
  const src = () => mediaUrl(p.url);
  return (
    <span class="avatar" classList={{ lg: p.size === 'lg' }} aria-hidden="true">
      <Show when={src() && !failed()} fallback={<span>{p.name.slice(0, 1).toUpperCase()}</span>}>
        <img src={src()} alt="" loading="lazy" onError={() => setFailed(true)} />
      </Show>
    </span>
  );
}

/** A modal: Escape or a click outside closes it, focus starts inside and goes back where it was. */
export function Dialog(p: { title: string; onClose: () => void; children: JSX.Element; danger?: boolean }) {
  let box!: HTMLDivElement;
  const before = document.activeElement as HTMLElement | null;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      p.onClose();
    }
    if (e.key !== 'Tab') return;
    const items = [...box.querySelectorAll<HTMLElement>('button, input, select, a[href], [tabindex="0"]')].filter((el) => !el.hasAttribute('disabled'));
    if (!items.length) return;
    const [first, last] = [items[0], items[items.length - 1]];
    if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
  };
  onMount(() => {
    (box.querySelector<HTMLElement>('[autofocus]') ?? box.querySelector<HTMLElement>('input, button'))?.focus();
  });
  onCleanup(() => before?.focus?.());
  return (
    <div class="scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="dialog" classList={{ danger: p.danger }} role="dialog" aria-modal="true" aria-label={p.title} ref={box} onKeyDown={onKey}>
        <header class="dialog-head">
          <h2>{p.title}</h2>
          <button class="icon-btn" aria-label="Close" onClick={() => p.onClose()}>
            <I.close />
          </button>
        </header>
        {p.children}
      </div>
    </div>
  );
}

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

export function Page(p: { title: string; lead?: JSX.Element; children: JSX.Element; actions?: JSX.Element; back?: { href: string; label: string }; figure?: JSX.Element }) {
  return (
    <div class="page-body">
      <Show when={p.back}>
        {(b) => (
          <a class="back-link" href={b().href}>
            <I.back size={15} /> {b().label}
          </a>
        )}
      </Show>
      <header class="page-head" classList={{ 'with-figure': !!p.figure }}>
        {p.figure}
        <div class="page-title">
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
