// Keeps the open server and channel in the address bar, like Discord's /channels/<server>/<channel>,
// so a reload (or the back button) lands where you were. The desktop app has no address bar to speak
// of, so the last place is also remembered per device and reopened on start.

import { createEffect, createRoot, on } from 'solid-js';
import { selectChannel, selectView, openFriends } from './actions';
import { isTauri } from './platform';
import { state } from './store';

const KEY = 'linkord.lastRoute';

function pathOf(view: string, channelId: string | undefined) {
  return `/channels/${view}${channelId ? `/${channelId}` : ''}`;
}

function parse(path: string): { view: string; channelId?: string } | null {
  const m = path.match(/^\/channels\/(@me|\d+)(?:\/(\d+))?\/?$/);
  return m ? { view: m[1], channelId: m[2] } : null;
}

function remembered(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function apply(path: string) {
  const r = parse(path);
  if (!r) return;
  const ch = r.channelId ? state.channels[r.channelId] : undefined;
  if (ch && (ch.guild_id ?? '@me') === r.view) selectChannel(ch.id);
  else if (r.view === '@me') openFriends();
  else if (state.guilds[r.view]) selectView(r.view);
}

let started = false;

/** Call once the first READY has filled the store. */
export function initRoute() {
  if (started) return;
  started = true;
  // The web URL wins (a shared or reloaded link); a bare "/" (or the desktop app) reopens the last place.
  const start = !isTauri && parse(location.pathname) ? location.pathname : remembered();
  if (start) apply(start);

  createRoot(() =>
    createEffect(
      on(
        () => pathOf(state.view, state.selected[state.view]),
        (path) => {
          try {
            localStorage.setItem(KEY, path);
          } catch {}
          if (isTauri || location.pathname === path) return;
          // Moving between channels is a history step; the first sync just tidies the URL.
          if (parse(location.pathname)) history.pushState(null, '', path);
          else history.replaceState(null, '', path);
        },
      ),
    ),
  );
  if (!isTauri) window.addEventListener('popstate', () => apply(location.pathname));
}
