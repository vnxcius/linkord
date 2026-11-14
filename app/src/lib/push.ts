// Push notifications on phones and in browsers (server/src/push.rs): the web app registers a service worker
// (public/sw.js), subscribes with the server's key and hands the subscription to the server, which sends DMs,
// mentions and the like while Pottira isn't in use. Web only: the desktop app has its own notifications.
// iPhone/iPad: only once Pottira is added to the Home Screen (Safari doesn't offer push in a tab).

import { createSignal } from 'solid-js';
import { api, getToken } from './api';
import { lang } from './i18n';
import { isTauri, openNotificationTarget } from './platform';
import { report } from './report';

/** unsupported: this browser can't; install: iPhone/iPad, add to the Home Screen first; blocked: denied in the
 * browser's settings; off / on; working: turning on or off. */
export type PushState = 'unsupported' | 'install' | 'blocked' | 'off' | 'on' | 'working';
const [pushState, setPushState] = createSignal<PushState>('off');
export { pushState };

export const isIos =
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** Opened from the Home Screen (installed), not in a browser tab. */
export const installed =
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
const supported = !isTauri && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let registration: ServiceWorkerRegistration | null = null;
/** Part of the service worker's address: a new value makes every browser fetch it again, past any cache. */
const SW_VERSION = 4;

export async function initPush() {
  if (isTauri || !('serviceWorker' in navigator)) return setPushState('unsupported');
  // Versioned: Cloudflare keeps /sw.js for hours whatever the server says (a zone cache rule). Bump SW_VERSION with
  // every change to public/sw.js, or phones keep the old one.
  registration = await navigator.serviceWorker.register(`/sw.js?v=${SW_VERSION}`).catch((e) => {
    console.warn('service worker', e);
    return null;
  });
  navigator.serviceWorker.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.type === 'push-received') received?.(m);
    else if (m?.type === 'open' && typeof m.channelId === 'string')
      openNotificationTarget({ channelId: m.channelId, messageId: m.messageId ?? undefined });
    else if (m?.type === 'resubscribe') void sync();
  });
  await refresh();
  // Ties the subscription to the current login (after signing out and back in, or a new key on the server).
  if (pushState() === 'on') void sync();
}

async function refresh() {
  if (!supported) return setPushState(isIos && !installed ? 'install' : 'unsupported');
  if (Notification.permission === 'denied') return setPushState('blocked');
  const sub = await registration?.pushManager.getSubscription().catch(() => null);
  setPushState(sub && Notification.permission === 'granted' ? 'on' : 'off');
}

const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) =>
  !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

/** The browser's subscription for the server's current key, made if needed. */
async function subscription(reg: ServiceWorkerRegistration) {
  const { public_key } = await api<{ public_key: string }>('GET', '/push/key');
  const key = fromB64(public_key);
  const existing = await reg.pushManager.getSubscription();
  if (existing && sameKey(existing.options.applicationServerKey, key)) return existing;
  await existing?.unsubscribe();
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

async function upload(sub: PushSubscription) {
  const json = sub.toJSON();
  await api('POST', '/push/subscriptions', { endpoint: json.endpoint, keys: json.keys, lang: lang() });
}

async function sync() {
  if (!registration || !getToken() || Notification.permission !== 'granted') return;
  try {
    await upload(await subscription(registration));
  } catch (e) {
    report('warn', 'Push: keeping the subscription failed', e);
  }
}

/** Turns notifications on for this device. Call from a click: browsers only ask for permission after one. */
export async function enablePush(): Promise<boolean> {
  if (!supported) return false;
  setPushState('working');
  try {
    if ((await Notification.requestPermission()) !== 'granted') return false;
    const reg = registration ?? (await navigator.serviceWorker.ready);
    await upload(await subscription(reg));
    return true;
  } catch (e) {
    report('warn', 'Push: turning on failed', e);
    throw e;
  } finally {
    await refresh();
  }
}

export async function disablePush() {
  setPushState('working');
  try {
    const sub = await registration?.pushManager.getSubscription();
    if (sub) {
      await api('DELETE', '/push/subscriptions', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } finally {
    await refresh();
  }
}

let received: ((m: { shown: boolean; error?: string }) => void) | null = null;

/** Seconds a test waits before it's sent, so Pottira can be closed and it arrives like a real notification. */
export const TEST_DELAY = 10;

/** What happened to a test: 'shown' (the device showed it), 'not-shown' (it arrived but showing failed: the error),
 * or 'not-arrived' (the push service took it but it never reached this browser in time, or the app was closed). */
export async function testPush(): Promise<{ result: 'shown' | 'not-shown' | 'not-arrived'; error?: string }> {
  const arrived = new Promise<{ shown: boolean; error?: string } | null>((resolve) => {
    received = resolve;
    setTimeout(() => resolve(null), (TEST_DELAY + 20) * 1000);
  });
  await api('POST', '/push/test', { delay: TEST_DELAY });
  const m = await arrived;
  received = null;
  if (!m) return { result: 'not-arrived' };
  return m.shown ? { result: 'shown' } : { result: 'not-shown', error: m.error };
}

/** A channel was opened: its notifications on this device go away. */
export function clearPushNotifications(channelId: string) {
  void registration
    ?.getNotifications({ tag: channelId })
    .then((list) => list.forEach((n) => n.close()))
    .catch(() => {});
}
