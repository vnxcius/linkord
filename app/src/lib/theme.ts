// Light / dark / Christmas theme. prefs.theme 'system' (the default) follows the OS (or browser) and changes with it.
// html[data-theme] is what styles.css keys its colors on. theme() answers "light or dark?" for things that only know
// those two (embeds), and Christmas counts as dark.
import { createEffect, createRoot, createSignal } from 'solid-js';
import { prefs } from './prefs';

const query = window.matchMedia('(prefers-color-scheme: light)');
const [systemLight, setSystemLight] = createSignal(query.matches);
query.addEventListener('change', (e) => setSystemLight(e.matches));

export const systemTheme = () => (systemLight() ? 'light' : 'dark');
export const theme = (): 'light' | 'dark' =>
  prefs.theme === 'system' ? systemTheme() : prefs.theme === 'christmas' ? 'dark' : prefs.theme;
export const isChristmas = () => prefs.theme === 'christmas';

export function initTheme() {
  createRoot(() =>
    createEffect(() => {
      document.documentElement.dataset.theme = isChristmas() ? 'christmas' : theme();
      document
        .querySelector<HTMLLinkElement>('link[rel="icon"]')
        ?.setAttribute('href', isChristmas() ? '/icon-christmas.png' : '/icon.png');
    }),
  );
}
