// Runs keybind actions. Two sources feed it:
//  - the desktop app's native hook (Windows): works in games, minimized and from the tray;
//  - key and mouse events in the Linkord window (everywhere, and a backup while Linkord is focused).
// A press seen by both counts once; a hold lasts until both sources saw the release.

import { t } from './i18n';
import { createEffect, createRoot, createSignal } from 'solid-js';
import { ACTIONS, keyFromEvent, keyFromMouse, modifierOf, modsFromEvent, type KeyAction, type Keybind } from './keys';
import { isTauri } from './platform';
import { prefs } from './prefs';
import { setUi, toast } from './ui';
import {
  canShareScreen,
  leaveVoice,
  setPtt,
  setPushToMute,
  stopScreenShare,
  toggleCamera,
  toggleDeafen,
  toggleMute,
  voiceUi,
} from './voice';

export const nativeKeybinds = isTauri && navigator.userAgent.includes('Windows');

/** While a keybind is being recorded in settings, nothing fires. */
const [recording, setRecording] = createSignal(false);
export { recording, setRecording };

type Source = 'native' | 'window';
const held = new Map<string, Record<Source, boolean>>();
const lastPress = new Map<string, { at: number; source: Source }>();
/** Two sources report the same physical press a few ms apart. */
const SAME_PRESS_MS = 300;

async function showWindow() {
  if (!isTauri) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const w = getCurrentWindow();
  await w.show().catch(() => {});
  await w.unminimize().catch(() => {});
  await w.setFocus().catch(() => {});
}

function hold(action: KeyAction, on: boolean) {
  if (action === 'ptt') setPtt(on);
  else if (action === 'ptm') setPushToMute(on);
}

function press(action: KeyAction) {
  switch (action) {
    case 'toggle-mute':
      return void toggleMute();
    case 'toggle-deafen':
      return void toggleDeafen();
    case 'toggle-camera':
      if (!voiceUi.channelId) return toast(t('Join a voice channel to turn on your camera'));
      return void toggleCamera();
    case 'disconnect':
      return void leaveVoice();
    case 'stream-game':
      return void import('./games').then((g) => g.toggleGameStream());
    case 'toggle-stream':
      if (voiceUi.screen) return stopScreenShare();
      if (!voiceUi.channelId) return toast(t('Join a voice channel to go live'));
      if (!canShareScreen) return toast(t("Screen sharing isn't supported here"));
      // Picking what to share needs the window.
      void showWindow();
      return setUi('modal', { type: 'go-live' });
  }
}

function trigger(bind: Keybind, down: boolean, source: Source) {
  if (recording()) return;
  if (ACTIONS[bind.action].hold) {
    const s = held.get(bind.id) ?? { native: false, window: false };
    const was = s.native || s.window;
    s[source] = down;
    held.set(bind.id, s);
    if (was !== (s.native || s.window)) hold(bind.action, !was);
    return;
  }
  if (!down) return;
  const now = performance.now();
  const last = lastPress.get(bind.id);
  if (last && last.source !== source && now - last.at < SAME_PRESS_MS) return;
  lastPress.set(bind.id, { at: now, source });
  press(bind.action);
}

/** Holds released when the window loses focus (we'll never see their keyup). */
function releaseWindowHolds() {
  for (const b of prefs.keybinds) if (held.get(b.id)?.window) trigger(b, false, 'window');
}

const typingIn = (e: Event) => !!(e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]');

function onWindowDown(key: { vk: number } | null, mods: number, e: Event) {
  if (!key || recording()) return;
  for (const b of prefs.keybinds) {
    const c = b.combo;
    if (!c || c.vk !== key.vk) continue;
    const hold = ACTIONS[b.action].hold;
    if (hold ? (mods & c.mods) !== c.mods : mods !== c.mods) continue;
    // A bare letter while typing a message is just typing (the native hook decides on desktop).
    if (!nativeKeybinds && c.mods === 0 && typingIn(e) && key.vk >= 0x20 && key.vk <= 0xe2 && !modifierOf(key.vk))
      continue;
    trigger(b, true, 'window');
  }
}

function onWindowUp(vk: number, mods: number) {
  for (const b of prefs.keybinds) {
    const c = b.combo;
    if (!c || !held.get(b.id)?.window) continue;
    const lostModifier = modifierOf(vk) & c.mods && !(mods & modifierOf(vk));
    if (c.vk === vk || lostModifier) trigger(b, false, 'window');
  }
}

export async function initKeybinds() {
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const key = keyFromEvent(e);
    onWindowDown(key, modsFromEvent(e, key?.vk), e);
  });
  window.addEventListener('keyup', (e) => {
    const key = keyFromEvent(e);
    if (key) onWindowUp(key.vk, modsFromEvent(e, key.vk));
  });
  window.addEventListener('mousedown', (e) => onWindowDown(keyFromMouse(e), modsFromEvent(e), e));
  window.addEventListener('mouseup', (e) => {
    const key = keyFromMouse(e);
    if (key) onWindowUp(key.vk, modsFromEvent(e));
  });
  window.addEventListener('blur', releaseWindowHolds);

  if (!nativeKeybinds) return;
  const { invoke } = await import('@tauri-apps/api/core');
  const { listen } = await import('@tauri-apps/api/event');
  // The native side numbers binds by their position in the list we last sent.
  let sent: Keybind[] = [];
  createRoot(() =>
    createEffect(() => {
      sent = prefs.keybinds.filter((b) => b.combo).map((b) => ({ ...b, combo: { ...b.combo! } }));
      const binds = sent.map((b, id) => ({ id, vk: b.combo!.vk, mods: b.combo!.mods, hold: ACTIONS[b.action].hold }));
      void invoke('set_keybinds', { binds }).catch((e) => console.warn('set_keybinds', e));
    }),
  );
  await listen<{ id: number; down: boolean }>('keybind', (e) => {
    const b = sent[e.payload.id];
    if (b) trigger(b, e.payload.down, 'native');
  });
}
