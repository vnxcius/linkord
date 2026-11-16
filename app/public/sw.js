// Linkord's service worker (web only; lib/push.ts registers it). It only shows push notifications (server/src/push.rs)
// and opens the right channel when one is clicked: no caching, the app always loads fresh from the server.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let n = {};
  try {
    n = e.data ? e.data.json() : {};
  } catch {}
  // Every push shows a notification (browsers, Safari especially, revoke push for sites that stay silent).
  const shown = self.registration.showNotification(n.title || 'Linkord', {
    body: n.body || '',
    icon: n.icon || '/icon-192.png',
    badge: '/badge-96.png',
    // One per channel: a newer message replaces the older one, and it buzzes again.
    tag: String(n.tag || 'linkord'),
    renotify: true,
    requireInteraction: !!n.call,
    data: {
      url: n.url || '/',
      channelId: n.channel_id ? String(n.channel_id) : null,
      messageId: n.message_id ? String(n.message_id) : null,
      // A friend request (push.rs on_friend_request): a click opens the friends list.
      friends: !!n.friend_request,
    },
  });
  e.waitUntil(
    shown.then(
      () => report(true),
      (err) => report(false, String(err && err.message ? err.message : err)),
    ),
  );
});

// Tells the server (and an open page) a push arrived and whether it could be shown: "Google accepted it" doesn't
// mean the phone showed anything (server push.rs `received`).
async function report(shown, error) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const visible = windows.some((w) => w.visibilityState === 'visible');
  // What the browser itself says is on screen now (0 = it dropped the notification).
  const listed = await self.registration.getNotifications().then(
    (l) => l.length,
    () => null,
  );
  for (const w of windows) w.postMessage({ type: 'push-received', shown, error, visible, listed });
  const sub = await self.registration.pushManager.getSubscription();
  if (!sub) return;
  await fetch('/api/push/received', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint, shown, error, visible, listed, browser: navigator.userAgent }),
  }).catch(() => {});
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        if (data.channelId) open.postMessage({ type: 'open', channelId: data.channelId, messageId: data.messageId });
        else if (data.friends) open.postMessage({ type: 'open', friends: true });
        return;
      }
      await self.clients.openWindow(data.url || '/');
    })(),
  );
});

// The browser renewed the subscription by itself: tell the server (the page isn't necessarily open).
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil(
    (async () => {
      const old = e.oldSubscription;
      const sub = e.newSubscription || (old && (await self.registration.pushManager.subscribe(old.options)));
      if (!sub) return;
      for (const w of await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
        w.postMessage({ type: 'resubscribe' });
    })(),
  );
});
