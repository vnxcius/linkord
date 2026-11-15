// Offers to rejoin voice after Linkord closed while connected without the user leaving: a crash, an
// update restart or a killed process. A plain page reload (F5 / Ctrl+R) rejoins by itself, like Discord. Leaving on purpose (Disconnect, tray Quit,
// closing the window without close-to-tray) forgets the session, so no banner shows next time.

import { createEffect, createRoot, createSignal, on } from 'solid-js';
import { isTauri } from './platform';
import { state } from './store';
import { joinVoice, leaveVoice, voiceUi } from './voice';

const KEY = 'linkord.voiceSession';
/** Don't offer channels from long ago; the update and crash cases come back within minutes. */
const MAX_AGE = 2 * 60 * 60_000;

const [resumable, setResumable] = createSignal<string | null>(null);
export { resumable };

function read(): { channelId: string; at: number } | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}

function write(channelId: string | null) {
  try {
    if (channelId) localStorage.setItem(KEY, JSON.stringify({ channelId, at: Date.now() }));
    else localStorage.removeItem(KEY);
  } catch {}
}

export function dismissResume() {
  setResumable(null);
  write(null);
}

export async function initVoiceResume() {
  const saved = read();
  if (saved?.channelId && Date.now() - saved.at < MAX_AGE) setResumable(saved.channelId);
  else write(null);

  createRoot(() =>
    createEffect(
      on(
        () => voiceUi.channelId,
        (id, prev) => {
          if (id) {
            setResumable(null);
            write(id);
          } else if (prev) write(null);
        },
      ),
    ),
  );
  // Keep the timestamp fresh while connected so the age counts from when we were last in voice.
  setInterval(() => voiceUi.channelId && write(voiceUi.channelId), 30_000);

  if (isTauri) {
    const { listen } = await import('@tauri-apps/api/event');
    await listen('quitting', () => {
      write(null);
      void leaveVoice();
    });
  }
}

/** Whether the page may start audio without a click (the autoplay policy usually allows it for a site you use). */
async function audioAllowed() {
  const ctx = new AudioContext();
  try {
    await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
    return ctx.state === 'running';
  } finally {
    void ctx.close();
  }
}

/** Call once the first READY has filled the store: after a reload, goes straight back into the call. */
export async function rejoinAfterReload() {
  const id = resumable();
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (!id || nav?.type !== 'reload' || !state.channels[id] || voiceUi.channelId) return;
  // Otherwise the banner stays: its click is the gesture audio needs.
  if (!(await audioAllowed())) return;
  dismissResume();
  void joinVoice(id);
}
