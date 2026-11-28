// Discord inside Linkord (Windows app): Discord's own web app in a second WebView2 view below the title bar
// (src-tauri/src/discord.rs). The switch beside REC swaps Linkord and Discord; in Discord, the way back is in the title
// bar (or Ctrl+Alt+D on either side).
//
// The native view always draws over this page, so the motion plays on a still picture of Discord (the "stage", a layer
// of this page under the view) and the live view takes over on its last frame. Going back, the picture is taken first.
// Motion: "Rise" (owner, 2026-11-28, picked from four in a mockup): Discord comes up as a sheet while Linkord steps
// back; a short crossfade with reduced motion.
import { createEffect, createRoot, on } from 'solid-js';
import { createStore } from 'solid-js/store';
import { notify, isTauri } from './platform';
import { t } from './i18n';
import { prefs, setPrefs } from './prefs';
import { ui } from './ui';

/** Windows app only (desktop.ts isWindows, not imported: desktop.ts imports this). */
export const discordAvailable = isTauri && navigator.userAgent.includes('Windows');

export const [discord, setDiscord] = createStore({
  /** What the window shows below the title bar. */
  mode: 'linkord' as 'linkord' | 'discord',
  /** The view exists (signed in or not). */
  running: false,
  /** Discord's badge: mentions, and unread messages without one. */
  mentions: 0,
  unread: false,
  /** A switch is playing. */
  moving: false,
  /** The last picture of Discord (an object URL), for the stage. */
  shot: '',
});

const RISE = { ms: 320, ease: 'cubic-bezier(.2,.8,.2,1)' };
const FADE = { ms: 140, ease: 'linear' };

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** The title bar's bottom edge in the window's pixels: where Discord's view starts (zoom and DPI included). */
function viewTop(): number {
  const bar = document.querySelector('.titlebar');
  return Math.round((bar?.getBoundingClientRect().bottom ?? 0) * devicePixelRatio);
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Whether Discord's view should be on screen now: in Discord, not mid-switch (the stage shows its picture then). */
const wanted = () => prefs.discord.enabled && discord.mode === 'discord' && !discord.moving;

/** Makes sure the view exists (it shows if wanted() says so, also when it arrives later). */
function start() {
  return invoke('discord_start', { top: viewTop(), visible: wanted(), keep: prefs.discord.background }).catch(() => {});
}

/** The stage still says "Opening Discord…" after a while: asks again. */
export function retryDiscord() {
  void start();
}

/** Plays the switch; resolves on the last frame with a function that lets go of it, to call once the screen has
 *  swapped (before that, the stage and the desk hold their final look). */
function play(entering: boolean): Promise<() => void> {
  const stage = document.querySelector<HTMLElement>('.discord-stage');
  const desk = document.querySelector<HTMLElement>('.layout');
  if (!stage) return Promise.resolve(() => {});
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const m = reduced ? FADE : RISE;
  const opts: KeyframeAnimationOptions = {
    duration: m.ms,
    easing: m.ease,
    direction: entering ? 'normal' : 'reverse',
    fill: 'both',
  };
  const anims = [
    stage.animate(
      reduced
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { transform: 'translateY(28px) scale(.975)', opacity: 0 },
            { transform: 'none', opacity: 1 },
          ],
      opts,
    ),
  ];
  if (desk && !reduced)
    anims.push(
      desk.animate(
        [
          { transform: 'scale(1)', filter: 'brightness(1)' },
          { transform: 'scale(.97)', filter: 'brightness(.55)' },
        ],
        opts,
      ),
    );
  return Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => () => anims.forEach((a) => a.cancel()));
}

/** To Discord. Off: the stage shows the introduction (turning it on starts Discord there). */
export async function openDiscord() {
  if (!discordAvailable || discord.mode !== 'linkord' || discord.moving) return;
  setDiscord({ mode: 'discord', moving: true });
  if (prefs.discord.enabled) void start();
  await frame();
  const done = await play(true);
  setDiscord('moving', false);
  done();
  // A Linkord call rang during the motion: straight back.
  if (closeAfter) {
    closeAfter = false;
    return closeDiscord(true);
  }
  if (prefs.discord.enabled) await showView(wanted());
}

/** An instant close asked for while the switch to Discord was still playing. */
let closeAfter = false;

/** Back to Linkord. `instant`: no picture, no motion (a Linkord call ringing, a dialog opening). */
export async function closeDiscord(instant = false) {
  if (discord.mode !== 'discord') return;
  if (discord.moving) {
    if (instant) closeAfter = true;
    return;
  }
  setDiscord('moving', true);
  if (!instant && discord.running) await takeShot();
  await showView(false);
  const done = instant ? () => {} : await play(false);
  setDiscord({ mode: 'linkord', moving: false });
  done();
}

export function toggleDiscord() {
  if (discord.mode === 'discord') void closeDiscord();
  else void openDiscord();
}

function showView(visible: boolean) {
  return invoke('discord_show', { visible, keep: prefs.discord.background }).catch(() => {});
}

/** The picture the stage holds while the view hides; ready on screen before the view goes. */
async function takeShot() {
  const buf = await invoke<ArrayBuffer>('discord_snapshot').catch(() => null);
  if (!buf) return;
  const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
  const img = new Image();
  img.src = url;
  await img.decode().catch(() => {});
  const old = discord.shot;
  setDiscord('shot', url);
  if (old) URL.revokeObjectURL(old);
  await frame();
  await frame();
}

/** Turns Discord on (the introduction's button, Settings) and, from the introduction, shows it. */
export async function enableDiscord() {
  setPrefs({ discord: { ...prefs.discord, enabled: true } });
  await start();
}

/** Turns it off: the view closes, the sign-in stays for next time. */
export async function disableDiscord() {
  setPrefs({ discord: { ...prefs.discord, enabled: false } });
  if (discord.mode === 'discord') await closeDiscord(true);
  await invoke('discord_stop').catch(() => {});
  clearShot();
}

export function setDiscordBackground(background: boolean) {
  setPrefs({ discord: { ...prefs.discord, background } });
  if (discord.running) void showView(wanted());
  else if (background && prefs.discord.enabled) void start();
}

/** "Remove Discord": signs out, removes everything it kept on this computer (Discord's sites only) and turns it off. */
export async function forgetDiscord() {
  if (discord.mode === 'discord') await closeDiscord(true);
  clearShot();
  await invoke('discord_forget').catch(() => {
    throw new Error(t("Couldn't remove all of Discord's data. Try again."));
  });
  setPrefs({ discord: { ...prefs.discord, enabled: false } });
}

function clearShot() {
  if (discord.shot) URL.revokeObjectURL(discord.shot);
  setDiscord('shot', '');
}

/** A Discord notification was clicked: Discord opens that chat, and comes to the front. */
export async function openFromDiscordNotification(id: number) {
  await invoke('discord_notification_clicked', { id }).catch(() => {});
  await openDiscord();
}

export async function initDiscord() {
  if (!discordAvailable) return;
  const { listen } = await import('@tauri-apps/api/event');
  void listen<{ running: boolean }>('discord-state', (e) => {
    setDiscord('running', e.payload.running);
    if (!e.payload.running) clearShot();
  });
  void listen<{ mentions: number; unread: boolean }>('discord-badge', (e) =>
    setDiscord({ mentions: e.payload.mentions, unread: e.payload.unread }),
  );
  void listen<{ id: number; title: string; body: string }>(
    'discord-notification',
    (e) => void notify(e.payload.title, e.payload.body, undefined, { discord: e.payload.id }),
  );
  void listen('discord-toggle', () => toggleDiscord());
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && !e.shiftKey && !e.repeat && e.code === 'KeyD') {
      e.preventDefault();
      toggleDiscord();
    }
  });
  // Zoom or a move to another screen moves the title bar's edge in pixels.
  let pending = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => void invoke('discord_set_top', { top: viewTop() }).catch(() => {}));
  });
  createRoot(() => {
    // Dialogs and Linkord's screens are part of this page, under Discord's view: Linkord comes back for them.
    createEffect(
      on(
        () => !!ui.modal,
        (open) => {
          if (open && discord.mode === 'discord') void closeDiscord(true);
        },
      ),
    );
  });
  // A reload of this page while Discord was in front: the view hides again (it keeps running).
  await showView(false);
  // Shown or not as things stand by then (Discord may have been opened in the meantime).
  if (prefs.discord.enabled && prefs.discord.background) setTimeout(() => void start(), 3000);
}
