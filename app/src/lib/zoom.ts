// App zoom on the desktop app (Ctrl + / Ctrl - / Ctrl 0, like Discord). Browsers zoom pages themselves.

import { t } from './i18n';
import { prefs, setPrefs } from './prefs';
import { toast, ui } from './ui';

const STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
// tauri.conf.json's minWidth/minHeight, in CSS pixels: the window's minimum grows with the zoom so the layout
// never gets narrower than this (the phone layout would kick in).
const MIN_W = 940;
const MIN_H = 560;

export async function initZoom() {
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  const { getCurrentWindow, currentMonitor, LogicalSize } = await import('@tauri-apps/api/window');
  const webview = getCurrentWebview();
  const win = getCurrentWindow();

  /** The largest zoom whose minimum window size still fits on the current monitor. */
  async function maxZoom() {
    const m = await currentMonitor().catch(() => null);
    if (!m) return STEPS[STEPS.length - 1];
    const size = m.workArea.size.toLogical(m.scaleFactor);
    return Math.min(size.width / MIN_W, size.height / MIN_H);
  }

  async function apply(zoom: number) {
    await win.setMinSize(new LogicalSize(Math.round(MIN_W * zoom), Math.round(MIN_H * zoom))).catch(() => {});
    await webview.setZoom(zoom).catch((e) => console.warn('setZoom', e));
  }

  async function step(dir: -1 | 0 | 1) {
    const max = await maxZoom();
    const cur = prefs.zoom;
    const allowed = STEPS.filter((s) => s <= max || s <= 1);
    const next =
      dir > 0
        ? allowed.find((s) => s > cur + 0.001)
        : dir < 0
          ? [...allowed].reverse().find((s) => s < cur - 0.001)
          : 1;
    const zoom = next ?? cur;
    if (zoom !== cur) {
      setPrefs({ zoom });
      await apply(zoom);
    }
    toast(t('Zoom: {n}%', { n: Math.round(zoom * 100) }), 1500);
  }

  if (prefs.zoom !== 1) await apply(Math.min(prefs.zoom, Math.max(1, await maxZoom())));

  window.addEventListener(
    'keydown',
    (e) => {
      // The image viewer zooms its picture instead.
      if (!(e.ctrlKey || e.metaKey) || e.altKey || ui.lightbox) return;
      const dir =
        e.key === '=' || e.key === '+'
          ? 1
          : e.key === '-' || e.key === '_'
            ? -1
            : e.key === '0' && !e.shiftKey
              ? 0
              : null;
      if (dir === null) return;
      e.preventDefault();
      if (!e.repeat || dir) void step(dir);
    },
    true,
  );
}
