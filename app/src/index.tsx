import './lib/storage-migrate';
import { render } from 'solid-js/web';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import './styles.css';
import { pickReachableServer } from './lib/api';
import { installContextMenu } from './lib/contextmenu';
import { installErrorReporting } from './lib/report';
import { initTooltips } from './lib/tooltip';
import { initChristmasMusic } from './lib/christmas-music';
import { initHolidays } from './lib/holidays';
import { initSanta } from './lib/santa';
import { initTheme } from './lib/theme';

initTheme();
initChristmasMusic();
initHolidays();
initSanta();
installContextMenu();
installErrorReporting();
initTooltips();

// The desktop app turns WebView2's browser shortcuts off (src-tauri lib.rs no_browser_keys). Ctrl+R still reloads
// (owner, 2026-11-14); the dev app also keeps F5 and devtools (F12, Ctrl+Shift+I).
if ('__TAURI_INTERNALS__' in window)
  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    if ((ctrl && !e.shiftKey && key === 'r') || (import.meta.env.DEV && e.key === 'F5')) {
      e.preventDefault();
      location.reload();
    } else if (import.meta.env.DEV && (e.key === 'F12' || (ctrl && e.shiftKey && key === 'i'))) {
      e.preventDefault();
      void import('@tauri-apps/api/core').then((c) => c.invoke('dev_tools')).catch(() => {});
    }
  });

const root = document.getElementById('root')!;
// The desktop app's watch-together pop-out window loads this same page and shows only the player. Both are loaded
// on demand, so the pop-out never runs the app's own start-up code (which, among others, closes stray pop-outs).
const label = (window as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
  .__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
if (label === 'watch-popout')
  void import('./components/WatchPopout').then(({ WatchPopout }) => render(() => <WatchPopout />, root));
// The REC overlay over games (src-tauri/src/rec/overlay.rs): only its panel.
else if (label === 'rec-overlay')
  void import('./components/RecOverlay').then(({ RecOverlay }) => render(() => <RecOverlay />, root));
// The desktop app may need the direct address before anything connects (ISPs that block Cloudflare).
else
  void Promise.all([import('./App'), pickReachableServer()]).then(([{ default: App }]) => render(() => <App />, root));
