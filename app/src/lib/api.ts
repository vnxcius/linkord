import { serverError, t } from './i18n';
import { isTauri } from './platform';

/** A web login started in this tab (see App.tsx captureUrlState). */
export const LOGIN_PENDING_KEY = 'linkord.loginPending';
/** The invite link this person arrived through; it lets Discord login create their account. */
export const INVITE_KEY = 'linkord.pendingInvite';

const SERVER_KEY = 'linkord.server';
const TOKEN_KEY = 'linkord.token';

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

// Desktop, this session only: the direct address when the usual one is unreachable (see pickReachableServer).
let fallback: string | null = null;

/** Base URL of the linkord server. The web build is served by the server itself. */
export function serverUrl(): string {
  if (!isTauri) return window.location.origin;
  return fallback || load(SERVER_KEY) || import.meta.env.VITE_DEFAULT_SERVER || '';
}

export const defaultServer = (): string => import.meta.env.VITE_DEFAULT_SERVER || '';

/** Direct access that skips Cloudflare (server/src/direct.rs), for ISPs that block Cloudflare's addresses. */
export const directServer = (): string => import.meta.env.VITE_DIRECT_SERVER || '';

/** Every address this server is reachable at (the current one first), e.g. to recognize its invite links. */
export function knownServers(): string[] {
  const all = [serverUrl(), defaultServer(), directServer(), isTauri ? '' : window.location.origin];
  return [...new Set(all.filter(Boolean))];
}

const reachable = (base: string) =>
  fetch(`${base}/api/health`, { signal: AbortSignal.timeout(6000) })
    .then((r) => r.ok)
    .catch(() => false);

/**
 * Desktop app: if the usual address doesn't answer but the direct one does, use the direct one for this
 * session. Both are checked at once, so a reachable server costs no extra wait.
 */
export async function pickReachableServer() {
  if (!isTauri) return;
  const usual = load(SERVER_KEY) || defaultServer();
  const direct = directServer();
  if (!usual || !direct || normalizeServerUrl(usual) !== normalizeServerUrl(defaultServer())) return;
  const [main, alt] = [reachable(usual), reachable(direct)];
  if (await main) return;
  if (await alt) fallback = direct;
}

/**
 * Turns whatever someone typed or pasted ("linkord.example.com", an invite link, ".../api") into
 * the server's origin, e.g. "https://linkord.example.com". Returns '' if it isn't usable.
 */
export function normalizeServerUrl(input: string): string {
  const t = input.trim();
  if (!t) return '';
  try {
    const u = new URL(/^[a-z][\w+.-]*:\/\//i.test(t) ? t : `https://${t}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
}

export function setServerUrl(url: string) {
  store(SERVER_KEY, normalizeServerUrl(url));
}

export type ServerCheck = { ok: true; discord: boolean; dev_login: boolean } | { ok: false; reason: string };

/** Probes a server and explains in plain words why it can't be used, if it can't. */
export async function checkServer(url: string): Promise<ServerCheck> {
  if (!url)
    return {
      ok: false,
      reason: t("That doesn't look like a server address. It should look like https://linkord.example.com"),
    };
  const host = new URL(url).host;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(`${url}/api/auth/config`, { signal: ctl.signal });
  } catch (e) {
    return {
      ok: false,
      reason:
        (e as Error).name === 'AbortError'
          ? t('{host} took too long to answer. Check your internet connection and try again.', { host })
          : t(
              'Couldn\'t connect to {host}. Check the address and your internet. Antivirus, a firewall or a network filter can also block it: try opening {url}/api/health in your browser, it should show "ok".',
              { host, url },
            ),
    };
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || typeof body.discord !== 'boolean') {
    return {
      ok: false,
      reason: t(
        '{host} answered, but not like a Linkord server (HTTP {status}). If opening {url} in your browser shows a security check, complete it, or ask the server owner.',
        { host, url, status: res.status },
      ),
    };
  }
  return { ok: true, discord: body.discord, dev_login: body.dev_login };
}

export function getToken() {
  return load(TOKEN_KEY);
}

export function setToken(token: string | null) {
  store(TOKEN_KEY, token);
}

/** Resolves a server-relative path like /uploads/... to an absolute URL. */
export function emojiUrl(id: string, animated = false): string {
  return `${serverUrl()}/uploads/emojis/${id}.${animated ? 'gif' : 'png'}`;
}

export function media(path?: string | null): string | undefined {
  if (!path) return undefined;
  return path.startsWith('/') ? serverUrl() + path : path;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body instanceof Blob) {
    headers['content-type'] = body.type || 'application/octet-stream';
    payload = body;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${serverUrl()}/api${path}`, { method, headers, body: payload });
  const text = await res.text();
  // Rate limited: wait the time the server asks for and try once more.
  if (res.status === 429 && retry) {
    const wait = Math.min(10, JSON.parse(text || '{}').retry_after ?? 1);
    await new Promise((r) => setTimeout(r, wait * 1000 + 50));
    return api<T>(method, path, body, false);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = JSON.parse(text).error ?? msg;
    } catch {}
    throw new ApiError(res.status, serverError(msg));
  }
  return text ? JSON.parse(text) : (undefined as T);
}

/** Like `api` for an answer that's a file, not JSON. */
export async function apiBlob(method: string, path: string, body: unknown): Promise<Blob> {
  const res = await fetch(`${serverUrl()}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return res.blob();
  let msg = res.statusText;
  try {
    msg = (await res.json()).error ?? msg;
  } catch {}
  throw new ApiError(res.status, serverError(msg));
}

/** Uploads a form with progress (fetch can't report it). `onProgress` gets 0..1 of the bytes sent; abort with `signal`. */
export function uploadForm<T = any>(
  method: string,
  path: string,
  body: FormData,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `${serverUrl()}/api${path}`);
    const token = getToken();
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          return resolve(xhr.responseText ? JSON.parse(xhr.responseText) : (undefined as T));
        } catch (e) {
          return reject(e);
        }
      }
      let msg = xhr.statusText || `HTTP ${xhr.status}`;
      try {
        msg = JSON.parse(xhr.responseText).error ?? msg;
      } catch {}
      reject(new ApiError(xhr.status, serverError(msg)));
    };
    xhr.onerror = () => reject(new ApiError(0, t("Couldn't reach the server. Check your connection and try again.")));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(body);
  });
}
