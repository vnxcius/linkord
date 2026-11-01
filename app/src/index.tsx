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
import { initTheme } from './lib/theme';

initTheme();
installContextMenu();
installErrorReporting();
initTooltips();

const root = document.getElementById('root')!;
// The desktop app's watch-together pop-out window loads this same page and shows only the player. Both are loaded
// on demand, so the pop-out never runs the app's own start-up code (which, among others, closes stray pop-outs).
const label = (window as { __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } } })
  .__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
if (label === 'watch-popout')
  void import('./components/WatchPopout').then(({ WatchPopout }) => render(() => <WatchPopout />, root));
// The desktop app may need the direct address before anything connects (ISPs that block Cloudflare).
else
  void Promise.all([import('./App'), pickReachableServer()]).then(([{ default: App }]) => render(() => <App />, root));
