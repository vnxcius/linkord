export const isTauri = '__TAURI_INTERNALS__' in window;

export async function openExternal(url: string) {
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

let notifyPermission: boolean | undefined;

/** Where a notification leads: clicking it opens that channel (at the message, when there is one). */
export interface NotifyTarget {
  channelId: string;
  messageId?: string;
}

let onNotificationClick: ((target: NotifyTarget) => void) | null = null;
let actionListener: Promise<unknown> | null = null;

/** What a click on a notification does (desktop.ts / App: bring the window up and go there). */
export function setNotificationClickHandler(handler: (target: NotifyTarget) => void) {
  onNotificationClick = handler;
}

const isTarget = (x: unknown): x is NotifyTarget =>
  !!x && typeof x === 'object' && typeof (x as NotifyTarget).channelId === 'string';

export async function notify(title: string, body: string, icon?: string, target?: NotifyTarget) {
  if (isTauri) {
    const n = await import('@tauri-apps/plugin-notification');
    if (notifyPermission === undefined) {
      notifyPermission = (await n.isPermissionGranted()) || (await n.requestPermission()) === 'granted';
    }
    if (!notifyPermission) return;
    // The plugin only reports clicks while a listener exists (Windows: while the toast is on screen).
    actionListener ??= n
      .onAction((e) => {
        const extra = e.notification?.extra;
        if (isTarget(extra)) onNotificationClick?.(extra);
      })
      .catch(() => null);
    await actionListener;
    n.sendNotification({ title, body, extra: target ? { ...target } : undefined });
    return;
  }
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') return;
  const shown = new Notification(title, { body, icon, silent: false });
  if (target)
    shown.onclick = () => {
      window.focus();
      shown.close();
      onNotificationClick?.(target);
    };
}

export async function windowControl(action: 'minimize' | 'toggleMaximize' | 'close') {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow()[action]();
}
