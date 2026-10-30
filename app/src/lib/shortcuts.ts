// App-wide keyboard shortcuts, like Discord's:
//   Ctrl+K                    quick switcher (people, channels, servers, messages everywhere)
//   Ctrl+Tab / Ctrl+Shift+Tab next / previous place in the server list (Friends first); Ctrl+Alt+↑/↓ too
//   Alt+↑ / Alt+↓             previous / next channel in the server, or conversation on the Friends side
import { openFriends, selectChannel, selectView } from './actions';
import { channelLayout, sortedDms, state } from './store';
import { Kind } from './types';
import { setUi, ui } from './ui';
import { railEntries } from '../components/Rail';

/** Friends, then every server in the order of the server list. */
function views(): string[] {
  return ['@me', ...railEntries().flatMap((f) => f.guild_ids)];
}

function stepView(dir: 1 | -1) {
  const list = views();
  const i = list.indexOf(state.view);
  const next = list[(i + dir + list.length) % list.length];
  if (next === '@me') openFriends();
  else selectView(next);
}

/** Channels you can step through with Alt+↑/↓: a server's text and voice channels, or Friends + your DMs. */
function stepChannel(dir: 1 | -1) {
  if (state.view === '@me') {
    const list: (string | undefined)[] = [undefined, ...sortedDms().map((c) => c.id)];
    const i = list.indexOf(state.selected['@me']);
    const next = list[Math.min(list.length - 1, Math.max(0, i + dir))];
    return next ? selectChannel(next) : openFriends();
  }
  const l = channelLayout(state.view);
  const collapsed = state.settings.collapsed_categories ?? [];
  const list = [...l.top, ...l.categories.flatMap((c) => (collapsed.includes(c.category.id) ? [] : c.channels))].filter(
    (c) => c.kind === Kind.Text || c.kind === Kind.Voice,
  );
  let cur = state.selected[state.view];
  // In a thread: step from its channel.
  const sel = cur ? state.channels[cur] : undefined;
  if (sel?.kind === Kind.Thread && sel.parent_id) cur = sel.parent_id;
  const i = list.findIndex((c) => c.id === cur);
  const next = list[Math.min(list.length - 1, Math.max(0, i + dir))];
  if (next && next.id !== cur) selectChannel(next.id);
}

export function installShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (!state.ready || e.defaultPrevented) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl && !e.altKey && !e.shiftKey && key === 'k') {
      e.preventDefault();
      setUi('quickSwitcher', !ui.quickSwitcher);
      return;
    }
    // Dialogs, settings and the image viewer keep their keys.
    if (ui.modal || ui.lightbox || ui.quickSwitcher) return;
    if (ctrl && !e.altKey && e.key === 'Tab') {
      e.preventDefault();
      return stepView(e.shiftKey ? -1 : 1);
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    if (ctrl && e.altKey) {
      e.preventDefault();
      stepView(dir);
    } else if (e.altKey && !ctrl && !e.shiftKey) {
      e.preventDefault();
      stepChannel(dir);
    }
  });
}
