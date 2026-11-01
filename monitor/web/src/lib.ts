// Talking to the monitor, polling and number formatting. API responses are plain JSON read straight into the pages.
import { createSignal, onCleanup, onMount } from 'solid-js';

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type J = any;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const [signedIn, setSignedIn] = createSignal<boolean | null>(null);
export { setSignedIn, signedIn };

export async function api<T = J>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    // The header is what proves this isn't a form on another site.
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-monitor': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && path !== '/login') setSignedIn(false);
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error ?? `The monitor answered ${res.status}.`);
  }
  return res.json();
}

/**
 * Polls while the tab is visible, keeping the last answer on screen while fetching (no flash) and when a poll fails.
 * `refresh()` asks again right away.
 */
export function usePoll<T = J>(fetcher: () => Promise<T>, every: number) {
  const [data, setData] = createSignal<T | undefined>(undefined);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  let stopped = false;
  let timer: number | undefined;
  let run = 0;
  const refresh = async () => {
    clearTimeout(timer);
    const mine = ++run;
    setLoading(true);
    try {
      const v = await fetcher();
      if (stopped || mine !== run) return;
      setData(() => v);
      setError(null);
    } catch (e) {
      if (stopped || mine !== run) return;
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
    if (every > 0 && !stopped) timer = window.setTimeout(tick, every);
  };
  const tick = () => {
    if (document.hidden) timer = window.setTimeout(tick, every);
    else void refresh();
  };
  onMount(() => void refresh());
  onCleanup(() => {
    stopped = true;
    clearTimeout(timer);
  });
  return { data, error, loading, refresh };
}

// ---------- formatting ----------

export const dash = '–';

export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return dash;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${n < 0 ? '-' : ''}${v.toFixed(i === 0 || v >= 100 ? 0 : digits)} ${units[i]}`;
}

export const rate = (n: number | null | undefined) => (n == null ? dash : `${bytes(n)}/s`);

/** 12.9K, 1.2M; in full under 10,000. */
export function count(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return dash;
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString('en-US');
}

/** Few decimals for small values, none for big ones. */
export function num(n: number | null | undefined, unit = ''): string {
  if (n == null || !Number.isFinite(n)) return dash;
  const a = Math.abs(n);
  const digits = a === 0 ? 0 : a < 1 ? 2 : a < 10 ? 1 : 0;
  return `${n.toFixed(digits)}${unit}`;
}

export const pct = (n: number | null | undefined, digits = 0) => (n == null ? dash : `${n.toFixed(digits)}%`);
export const ms = (n: number | null | undefined) => (n == null ? dash : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n < 10 ? n.toFixed(1) : Math.round(n)} ms`);

export function duration(seconds: number | null | undefined): string {
  if (seconds == null) return dash;
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

const toDate = (v: string | number) => (typeof v === 'number' ? new Date(v * 1000) : new Date(v));

export function ago(v: string | number | null | undefined): string {
  if (v == null) return 'never';
  const s = (Date.now() - toDate(v).getTime()) / 1000;
  if (s < 5) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)}d ago`;
  return toDate(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const dateTime = (v: string | number | null | undefined) =>
  v == null ? dash : toDate(v).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const date = (v: string | number | null | undefined) =>
  v == null ? dash : toDate(v).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export const clock = (v: string | number) =>
  toDate(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** A file from the app's uploads, through the monitor (it never touches the app). */
export const mediaUrl = (url: string | null | undefined) => (url?.startsWith('/uploads/') ? `/media/${url.slice('/uploads/'.length)}` : undefined);

export const tabs = ['overview', 'availability', 'performance', 'network', 'storage', 'database', 'logs', 'diagnostics', 'servers', 'media'] as const;
export type Tab = (typeof tabs)[number];

const parseHash = (): { tab: Tab; arg: string } => {
  const [tab, arg] = location.hash.replace(/^#\/?/, '').split('/');
  return { tab: tabs.includes(tab as Tab) ? (tab as Tab) : 'overview', arg: arg ? decodeURIComponent(arg) : '' };
};
const [route, setRoute] = createSignal(parseHash());
window.addEventListener('hashchange', () => setRoute(parseHash()));
export { route };
export const go = (tab: Tab, arg = '') => {
  location.hash = `/${tab}${arg ? `/${encodeURIComponent(arg)}` : ''}`;
};
