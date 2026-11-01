// Light / dark theme. prefs.theme 'system' (the default) follows the OS (or browser) and changes with it. The
// resolved theme is html[data-theme], which styles.css keys its light colors on.
import { createEffect, createRoot, createSignal } from 'solid-js';
import { prefs } from './prefs';

const query = window.matchMedia('(prefers-color-scheme: light)');
const [systemLight, setSystemLight] = createSignal(query.matches);
query.addEventListener('change', (e) => setSystemLight(e.matches));

export const systemTheme = () => (systemLight() ? 'light' : 'dark');
export const theme = (): 'light' | 'dark' => (prefs.theme === 'system' ? systemTheme() : prefs.theme);

export function initTheme() {
  createRoot(() =>
    createEffect(() => {
      document.documentElement.dataset.theme = theme();
    }),
  );
}
