// Sends this client's errors (and a few notable events, like voice failing) to the server's log, which the
// admin reads at /logs. The server redacts ids and secrets; message contents are never sent from here.
import { api, getToken } from './api';
import { isTauri } from './platform';

const CLIENT = `${__APP_VERSION__} ${isTauri ? 'desktop' : 'web'} ${navigator.platform || ''}`.trim();
let sent = 0;
let windowStart = Date.now();
const recent = new Set<string>();

export function report(level: 'error' | 'warn' | 'info', message: string, context?: unknown) {
  if (!getToken()) return;
  // At most 15 reports a minute, and the same one only once a minute.
  if (Date.now() - windowStart > 60_000) {
    windowStart = Date.now();
    sent = 0;
    recent.clear();
  }
  const key = `${level}:${message}`;
  if (sent >= 15 || recent.has(key)) return;
  sent++;
  recent.add(key);
  const ctx =
    context instanceof Error
      ? `${context.name}: ${context.message}\n${context.stack ?? ''}`
      : context === undefined
        ? undefined
        : typeof context === 'string'
          ? context
          : JSON.stringify(context);
  void api('POST', '/logs/client', {
    level,
    message: message.slice(0, 1000),
    context: ctx?.slice(0, 2000),
    client: CLIENT,
  }).catch(() => {});
}

/** Uncaught errors and rejected promises anywhere in the app. */
export function installErrorReporting() {
  window.addEventListener('error', (e) =>
    report('error', `Uncaught: ${e.message}`, `${e.filename}:${e.lineno}:${e.colno}\n${e.error?.stack ?? ''}`),
  );
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    report(
      'error',
      `Unhandled rejection: ${r instanceof Error ? r.message : String(r)}`,
      r instanceof Error ? r : undefined,
    );
  });
}
