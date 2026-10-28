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

export async function notify(title: string, body: string, icon?: string) {
  if (isTauri) {
    const n = await import('@tauri-apps/plugin-notification');
    if (notifyPermission === undefined) {
      notifyPermission = (await n.isPermissionGranted()) || (await n.requestPermission()) === 'granted';
    }
    if (notifyPermission) n.sendNotification({ title, body });
    return;
  }
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission === 'granted') new Notification(title, { body, icon, silent: false });
}

export async function windowControl(action: 'minimize' | 'toggleMaximize' | 'close') {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow()[action]();
}
