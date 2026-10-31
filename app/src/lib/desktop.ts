// Native integrations for the desktop app: tray icon, taskbar badge, close-to-tray, start with the OS,
// global keybinds (see keybinds.ts) and auto-update.

import { createEffect, createRoot, createSignal, on } from 'solid-js';
import { initGames } from './games';
import { msg, t } from './i18n';
import { initKeybinds } from './keybinds';
import { isTauri } from './platform';
import { prefs } from './prefs';
import { anyAlert, state, totalMentions } from './store';
import { voiceUi } from './voice';
import { initZoom } from './zoom';

export const isWindows = navigator.userAgent.includes('Windows');

export interface PendingUpdate {
  version: string;
  notes?: string;
  /** Downloads (progress 0-1), installs and restarts. */
  install: (onProgress?: (fraction: number) => void) => Promise<void>;
}

const [update, setUpdate] = createSignal<PendingUpdate | null>(null);
const [updating, setUpdating] = createSignal(false);
/** Updating by itself right after launch, before you start using the app (download progress 0-1). */
const [launchUpdate, setLaunchUpdate] = createSignal<{ version: string; progress: number } | null>(null);
export { launchUpdate, update, updating };

/** Set for the life of the window, so a reload isn't mistaken for a launch. */
const LAUNCHED = 'linkord.launched';
/** An update found later than this after launch waits for the banner: you may be using the app by then. */
const LAUNCH_WINDOW = 15_000;

/** Tray icon state, like Discord's: a green ring while you talk, red when muted or deafened. */
function trayState(): string {
  if (!voiceUi.channelId) return 'idle';
  if (voiceUi.deafened) return 'deafened';
  if (voiceUi.muted) return 'muted';
  return state.me && voiceUi.speaking[state.me.id] ? 'speaking' : 'connected';
}

const TRAY_TIPS: Record<string, string> = {
  speaking: msg('Linkord — speaking'),
  muted: msg('Linkord — muted'),
  deafened: msg('Linkord — deafened'),
  connected: msg('Linkord — in voice'),
};

/** A red count badge for the taskbar button (Windows overlay icon). */
function badgePng(count: number): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e0574f';
  g.beginPath();
  g.arc(16, 16, 15, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  // No count (only server messages): a white dot, like the server list's badge.
  if (!count) {
    g.beginPath();
    g.arc(16, 16, 6, 0, Math.PI * 2);
    g.fill();
  }
  g.font = `bold ${count > 9 ? 16 : 20}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (count) g.fillText(count > 99 ? '99+' : String(count), 16, 17);
  return new Promise((resolve) =>
    c.toBlob((b) => b!.arrayBuffer().then((a) => resolve(new Uint8Array(a))), 'image/png'),
  );
}

export async function initDesktop() {
  void initKeybinds();
  if (!isTauri) return;
  void initZoom();
  const { invoke } = await import('@tauri-apps/api/core');
  const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();

  createRoot(() => {
    createEffect(() => {
      const tray = trayState();
      void invoke('set_tray_state', { state: tray, tooltip: TRAY_TIPS[tray] ? t(TRAY_TIPS[tray]) : 'Linkord' }).catch(
        () => {},
      );
    });
    createEffect(
      () => void invoke('set_tray_menu', { open: t('Open Linkord'), quit: t('Quit Linkord') }).catch(() => {}),
    );
    createEffect(() => void invoke('set_close_to_tray', { enabled: prefs.closeToTray }).catch(() => {}));
    createEffect(() => void invoke('set_start_minimized', { enabled: prefs.startMinimized }).catch(() => {}));
    createEffect(
      on(
        () => [totalMentions(), anyAlert()] as const,
        async ([count, alert], prev) => {
          if (isWindows) await win.setOverlayIcon(count || alert ? await badgePng(count) : undefined).catch(() => {});
          if ((count > (prev?.[0] ?? 0) || (alert && !prev?.[1])) && !document.hasFocus())
            await win.requestUserAttention(UserAttentionType.Informational).catch(() => {});
        },
      ),
    );
  });

  // At launch (not a reload of the window) an update installs right away; once the app is in use, the banner
  // offers it instead.
  let launch = false;
  try {
    launch = !sessionStorage.getItem(LAUNCHED);
    sessionStorage.setItem(LAUNCHED, '1');
  } catch {}
  const started = Date.now();
  void checkForUpdates().then((found) => {
    if (found && launch && Date.now() - started < LAUNCH_WINDOW && !voiceUi.channelId) void installAtLaunch();
  });
  setInterval(checkForUpdates, 30 * 60_000);
  initGames();
}

export async function checkForUpdates(): Promise<boolean> {
  if (!isTauri || update()) return !!update();
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const u = await check();
    if (!u) return false;
    setUpdate({
      version: u.version,
      notes: u.body,
      install: async (onProgress) => {
        setUpdating(true);
        try {
          let total = 0;
          let done = 0;
          await u.downloadAndInstall((e) => {
            if (e.event === 'Started') total = e.data.contentLength ?? 0;
            else if (e.event === 'Progress') {
              done += e.data.chunkLength;
              if (total) onProgress?.(Math.min(1, done / total));
            } else onProgress?.(1);
          });
          const { relaunch } = await import('@tauri-apps/plugin-process');
          await relaunch();
        } finally {
          setUpdating(false);
        }
      },
    });
    return true;
  } catch (e) {
    console.warn('update check failed', e);
    return false;
  }
}

async function installAtLaunch() {
  const u = update();
  if (!u) return;
  setLaunchUpdate({ version: u.version, progress: 0 });
  try {
    await u.install((progress) => setLaunchUpdate({ version: u.version, progress }));
  } catch (e) {
    // The banner still offers it.
    console.warn('update at launch failed', e);
    setLaunchUpdate(null);
  }
}

export async function autostartEnabled(): Promise<boolean> {
  if (!isTauri) return false;
  const { isEnabled } = await import('@tauri-apps/plugin-autostart');
  return isEnabled().catch(() => false);
}

export async function setAutostart(on: boolean) {
  const a = await import('@tauri-apps/plugin-autostart');
  await (on ? a.enable() : a.disable());
}
