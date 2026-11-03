// Feeds the native in-game overlay (src-tauri/src/overlay.rs, Windows app): who's in the call and who's talking.
// The shell does the drawing; this only sends it what changed, and each person's picture once.

import { createEffect, createRoot } from 'solid-js';
import { media } from './api';
import { prefs } from './prefs';
import { nameOf, profileOf, state, voiceMembers } from './store';
import { voiceUi } from './voice';

const AVATAR_SIDE = 64;
/** Several people starting to talk at once are one update. */
const SEND_DELAY_MS = 40;

type Invoke = typeof import('@tauri-apps/api/core').invoke;

/** Decoded here, where the app already reads every image format people upload. */
async function sendAvatar(invoke: Invoke, id: string, url: string) {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob, {
    resizeWidth: AVATAR_SIDE,
    resizeHeight: AVATAR_SIDE,
    resizeQuality: 'high',
  });
  const canvas = new OffscreenCanvas(AVATAR_SIDE, AVATAR_SIDE);
  const context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = context.getImageData(0, 0, AVATAR_SIDE, AVATAR_SIDE);
  await invoke('overlay_avatar', new Uint8Array(data.buffer), {
    headers: { 'x-id': id, 'x-side': String(AVATAR_SIDE) },
  });
}

export async function initOverlay() {
  const { invoke } = await import('@tauri-apps/api/core');
  let last = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Picture sent for each person this call. The shell forgets them when the call ends. */
  const sent = new Map<string, string>();

  createRoot(() => {
    createEffect(() => {
      const channel = prefs.overlay ? voiceUi.channelId : null;
      const me = state.me?.id;
      const members = channel ? voiceMembers(channel) : [];
      const people = members
        .map((v) => ({
          id: v.user_id,
          name: nameOf(v.user_id, v.guild_id),
          speaking: !!voiceUi.speaking[v.user_id],
          muted: v.user_id === me ? voiceUi.muted : v.self_mute,
          deafened: v.user_id === me ? voiceUi.deafened : v.self_deaf,
        }))
        // A stable order: rows don't jump around while people talk.
        .sort((a, b) => a.name.localeCompare(b.name));

      if (!people.length) sent.clear();
      for (const v of members) {
        const url = media(profileOf(v.user_id, v.guild_id)?.avatar);
        if (url && sent.get(v.user_id) !== url) {
          sent.set(v.user_id, url);
          // Without it the row shows their initial.
          void sendAvatar(invoke, v.user_id, url).catch(() => {});
        }
      }

      const view = JSON.stringify({ people, corner: prefs.overlayCorner, only_speaking: prefs.overlayOnlySpeaking });
      if (view === last) return;
      last = view;
      clearTimeout(timer);
      timer = setTimeout(
        () => void invoke('overlay_update', { view: JSON.parse(last) }).catch(() => {}),
        SEND_DELAY_MS,
      );
    });
  });
}
