// Watch together in a call: share a YouTube, Twitch or Kick link and everyone who opens it watches the same
// moment (YouTube follows play, pause and seeks; streams are live for everyone). Volume stays each person's own.
// Opening it is a choice, like watching a stream: the call shows it as a tile, and only a click plays it.
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { api } from '../lib/api';
import { selectChannel } from '../lib/actions';
import { t } from '../lib/i18n';
import { isTauri, openExternal } from '../lib/platform';
import { nameOf, state } from '../lib/store';
import { theme } from '../lib/theme';
import { attempt, isMobile, setUi, toast, type MenuEntry } from '../lib/ui';
import { twitchChatFrames, watchChat } from '../lib/video-links';
import { setMediaPlaying, setVoiceUi, voiceUi } from '../lib/voice';
import { controlWatch, expectedPosition, serverOffset, startWatch, stopWatch, watches, type Watch } from '../lib/watch';
import * as I from './Icons';
import { Viewers } from './VoiceView';
import { Player, WatchEnded } from './WatchPlayer';

const PROVIDERS = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick', clip: 'REC' } as const;
/** The shared video's key among the call's tiles (voiceUi.focus), next to `<user>-screen` / `<user>-camera`. */
export const WATCH_KEY = 'watch';

/** Channels whose shared video we opened (per session; hiding it only hides it for us). */
const [opened, setOpened] = createSignal<Record<string, boolean>>({});
/** Channels in theater mode: the video fills the call and the channel list is hidden too. */
const [theater, setTheater] = createSignal<Record<string, boolean>>({});
const showing = (channelId: string) => !!opened()[channelId] && !!watches[channelId] && voiceUi.channelId === channelId;
/** The shared video is the call's focused tile (it fills the call). */
export const watchExpanded = (channelId: string) => voiceUi.focus === WATCH_KEY && showing(channelId);
export const watchTheater = (channelId: string) => !!theater()[channelId] && watchExpanded(channelId);
/** Channels with the stream's chat turned on (per session, like opening the video). */
const [chatOn, setChatOn] = createSignal<Record<string, boolean>>({});
/** The chat of this call's shared video, if it has one. */
const chatFor = (w: Watch | undefined) =>
  w ? watchChat(w, location.hostname, !isTauri && twitchChatFrames(location), theme() === 'dark') : null;
/** A chat in the page needs the room of the focused video; one in its own window only has to be on. */
function chatShown(channelId: string) {
  const chat = chatFor(watches[channelId]);
  return !!chat && !!chatOn()[channelId] && showing(channelId) && (!chat.framed || watchExpanded(channelId));
}
/** Where the player sits in the call view, when the call view is on screen. */
const [slot, setSlot] = createSignal<HTMLElement | null>(null);
/** The Document Picture-in-Picture window the player was popped out to (web). */
const [popped, setPopped] = createSignal<Window | null>(null);
/** The desktop app's own pop-out window is open (WebView2 has no Document Picture-in-Picture). */
const [nativePopped, setNativePopped] = createSignal(false);
const poppedOut = () => !!popped() || nativePopped();
const pipApi = () =>
  (window as unknown as { documentPictureInPicture?: { requestWindow: (o: object) => Promise<Window> } })
    .documentPictureInPicture;
export const canPopOutWatch = () => isTauri || !!pipApi();

/**
 * Windows 10 streams the sound of the whole PC (it can't leave Linkord out), so the shared video would reach our
 * stream's viewers on top of their own player: it's muted here while we stream that way.
 */
const mutedForStream = () => voiceUi.screen && voiceUi.streamAudio?.mode === 'system';

/** Opens or hides the shared video for us; the server keeps who's watching. */
export function setWatchOpen(channelId: string, on: boolean) {
  setOpened({ ...opened(), [channelId]: on });
  if (!on) {
    setTheater({ ...theater(), [channelId]: false });
    setChatOn({ ...chatOn(), [channelId]: false });
    if (voiceUi.focus === WATCH_KEY) setVoiceUi('focus', null);
  }
  void api('PUT', `/channels/${channelId}/watch/view`, { on }).catch(() => {});
}

function toggleFocus(channelId: string) {
  const on = voiceUi.focus !== WATCH_KEY;
  if (!on) setTheater({ ...theater(), [channelId]: false });
  setVoiceUi('focus', on ? WATCH_KEY : null);
}

function setTheaterMode(channelId: string, on: boolean) {
  setTheater({ ...theater(), [channelId]: on });
  // Theater: the video alone. Leaving it keeps the video large, with the people strip back.
  setVoiceUi({ focus: WATCH_KEY, hideStrip: on });
}

function toggleChat(channelId: string) {
  const chat = chatFor(watches[channelId]);
  if (!chat) return;
  // A browser on the direct address, where Twitch's chat can't be framed and the app has no window to give it.
  if (!chat.framed && !isTauri) return void openExternal(chat.src);
  const on = !chatShown(channelId);
  setChatOn({ ...chatOn(), [channelId]: on });
  if (on && chat.framed) setVoiceUi('focus', WATCH_KEY);
}

let hostEl: HTMLDivElement | undefined;
/** Fullscreen for the shared video (the player itself, whichever place it's in). */
function toggleWatchFullscreen() {
  if (document.fullscreenElement) return void document.exitFullscreen().catch(() => {});
  void hostEl?.requestFullscreen?.().catch(() => toast(t("Couldn't go fullscreen")));
}

/**
 * Moves the player into its own always-on-top window (it reloads there and catches up with the others). The
 * window starts as a blank page: it gets the app's styles and theme so the player and its "ended" screen fit it.
 */
async function popOutWatch() {
  if (isTauri) return popOutNative();
  const pip = pipApi();
  if (!pip || popped()) return;
  try {
    const win = await pip.requestWindow({ width: 640, height: 360 });
    win.document.title = 'Linkord';
    for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) {
      const copy = node.cloneNode(true) as HTMLElement;
      // The pop-out's own address is about:blank: stylesheet links need their full address.
      if (copy instanceof HTMLLinkElement) copy.href = (node as HTMLLinkElement).href;
      win.document.head.append(copy);
    }
    for (const { name, value } of document.documentElement.attributes)
      win.document.documentElement.setAttribute(name, value);
    win.document.body.style.cssText = 'margin:0;background:#000;overflow:hidden;height:100vh';
    win.addEventListener('pagehide', () => setPopped(null), { once: true });
    setPopped(win);
  } catch {
    toast(t("Couldn't open the pop-out window"));
  }
}

function closePopOutWatch() {
  popped()?.close();
  if (nativePopped()) {
    setNativePopped(false);
    void import('@tauri-apps/api/core').then(({ invoke }) => invoke('watch_popout_close')).catch(() => {});
  }
}

/**
 * Desktop: the player moves to a small always-on-top window of its own (WatchPopout.tsx). That window has no
 * server connection: this one sends it the watch as it changes, and does what it asks (play, pause, seek, stop).
 */
async function popOutNative() {
  if (nativePopped()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('watch_popout_open', { title: `${t('Watch together')} · Linkord` });
    setNativePopped(true);
  } catch (e) {
    console.warn('watch pop-out', e);
    toast(t("Couldn't open the pop-out window"));
  }
}

interface PopOutControl {
  channelId: string;
  patch: Parameters<typeof controlWatch>[1];
}

/** Keeps the pop-out window showing this call's watch while it's open, and carries out what it asks. */
function NativePopOutLink(p: { channelId: string }) {
  let emitTo: typeof import('@tauri-apps/api/event').emitTo | undefined;
  const send = () => {
    const w = watches[p.channelId];
    // Read every field here so a change to any of them sends it again.
    const watch = w ? (JSON.parse(JSON.stringify(w)) as Watch) : null;
    const muted = !!mutedForStream();
    void emitTo?.('watch-popout', 'watch-popout-state', {
      channelId: p.channelId,
      watch,
      offset: serverOffset(),
      muted,
    });
  };
  const unlisten: (() => void)[] = [];
  let disposed = false;
  onMount(async () => {
    const ev = await import('@tauri-apps/api/event');
    if (disposed) return;
    emitTo = ev.emitTo;
    const keep = (off: () => void) => (disposed ? off() : unlisten.push(off));
    keep(await ev.listen('watch-popout-ready', send));
    keep(
      await ev.listen<PopOutControl>('watch-popout-control', ({ payload: m }) => {
        if (m.channelId === p.channelId) void controlWatch(m.channelId, m.patch);
      }),
    );
    keep(
      await ev.listen<{ channelId: string }>('watch-popout-stop', ({ payload: m }) => {
        if (m.channelId === p.channelId) void attempt(() => stopWatch(m.channelId));
      }),
    );
    // Hidden from the pop-out: the same as "Hide for me" here (which closes the window too).
    keep(
      await ev.listen<{ channelId: string }>('watch-popout-hide', ({ payload: m }) => {
        if (m.channelId === p.channelId) setWatchOpen(m.channelId, false);
      }),
    );
    send();
  });
  createEffect(send);
  onCleanup(() => {
    disposed = true;
    unlisten.forEach((off) => off());
  });
  return null;
}

/**
 * The main window's side of the desktop pop-out, from WatchHost (never at import: the pop-out window loads this
 * code too, and would close itself). A pop-out left over from before this window reloaded is closed, or it would
 * play next to the player here; when the pop-out closes itself, the player comes back to the app.
 */
let strayChecked = false;
function watchPopOutClosed(): () => void {
  if (!isTauri) return () => {};
  let off: (() => void) | undefined;
  let gone = false;
  if (!strayChecked) {
    strayChecked = true;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => Promise.all([invoke('watch_popout_close'), invoke('watch_chat_close')]))
      .catch(() => {});
  }
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen('watch-popout-closed', () => setNativePopped(false)))
    .then((f) => (gone ? f() : (off = f)));
  return () => {
    gone = true;
    off?.();
  };
}

/**
 * Desktop: Twitch's chat lives in a window of its own (lib.rs watch_chat_open), open while it's on and the video is
 * open, wherever you are in the app. Closing that window turns the chat off.
 */
function nativeChatWindow(src: () => string | null) {
  if (!isTauri) return;
  let open = false;
  let closing = false;
  const invoke = (cmd: string, args?: Record<string, unknown>) =>
    import('@tauri-apps/api/core').then((m) => m.invoke(cmd, args));
  createEffect(() => {
    const url = src();
    if (url) {
      open = true;
      invoke('watch_chat_open', { url, title: `${t('Stream chat')} · Linkord` }).catch((e) => {
        console.warn('watch chat', e);
        toast(t("Couldn't open the pop-out window"));
      });
    } else if (open) {
      open = false;
      closing = true;
      void invoke('watch_chat_close').catch(() => {});
    }
  });
  let off: (() => void) | undefined;
  let gone = false;
  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen('watch-chat-closed', () => {
        if (closing) return void (closing = false);
        open = false;
        const ch = voiceUi.channelId;
        if (ch) setChatOn({ ...chatOn(), [ch]: false });
      }),
    )
    .then((f) => (gone ? f() : (off = f)));
  onCleanup(() => {
    gone = true;
    off?.();
  });
}

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toast(t('Link copied'));
  } catch {
    toast(t("Couldn't copy the link"));
  }
}

/** The player, reloaded when the link changes or when it has to be muted for our stream. */
function PlayerFor(p: { channelId: string; watch: Watch }) {
  return (
    <Show when={`${p.watch.url}|${mutedForStream()}`} keyed>
      {(_key) => <Player channelId={p.channelId} muted={mutedForStream()} />}
    </Show>
  );
}

/**
 * The one player for the call's shared video. It stays mounted wherever you go: laid over its tile in the call
 * view, floating in a corner while you read other channels, or in the pop-out window. Moving between the call
 * view and the corner doesn't reload it.
 */
export function WatchHost() {
  const channel = () => voiceUi.channelId;
  const w = () => (channel() ? watches[channel()!] : undefined);
  const visible = () => !!w() && !!opened()[channel()!];
  const [box, setBox] = createSignal<{ x: number; y: number; w: number; h: number; clip: string } | null>(null);
  // Follows the slot every frame (layout, scrolling and resizing all move it), clipped to the area it scrolls in.
  let raf = 0;
  const follow = () => {
    const el = slot();
    if (el?.isConnected) {
      const r = el.getBoundingClientRect();
      const area = el.closest('.strip, .voice-stage, .focus-stage')?.getBoundingClientRect() ?? r;
      const inset = [
        Math.max(0, area.top - r.top),
        Math.max(0, r.right - area.right),
        Math.max(0, r.bottom - area.bottom),
        Math.max(0, area.left - r.left),
      ];
      const next = {
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        clip: `inset(${inset.map((n) => `${n}px`).join(' ')})`,
      };
      const cur = box();
      if (
        !cur ||
        cur.x !== next.x ||
        cur.y !== next.y ||
        cur.w !== next.w ||
        cur.h !== next.h ||
        cur.clip !== next.clip
      )
        setBox(next);
    } else if (box()) setBox(null);
    raf = requestAnimationFrame(follow);
  };
  onMount(() => (raf = requestAnimationFrame(follow)));
  onCleanup(watchPopOutClosed());
  onCleanup(() => cancelAnimationFrame(raf));
  // Leaving the call or hiding the video closes the pop-out too.
  createEffect(() => !visible() && closePopOutWatch());
  // Its sound reaches the mic: the voice gate takes that into account while it plays.
  createEffect(() => setMediaPlaying(visible() && !!w()?.playing && !w()?.ended && !mutedForStream()));
  onCleanup(() => setMediaPlaying(false));
  nativeChatWindow(
    createMemo(() => {
      const ch = channel();
      const chat = ch && chatShown(ch) ? chatFor(watches[ch]) : null;
      return chat && !chat.framed ? chat.src : null;
    }),
  );
  // After a reload we're still on the server's list of who's watching, without the player open: fix that.
  const corrected = new Set<string>();
  createEffect(() => {
    const ch = channel();
    const me = state.me?.id;
    const watch = ch ? watches[ch] : undefined;
    if (!ch || !me || !watch?.viewers?.includes(me) || opened()[ch] || corrected.has(watch.url)) return;
    corrected.add(watch.url);
    void api('PUT', `/channels/${ch}/watch/view`, { on: false }).catch(() => {});
  });

  return (
    <Show when={visible() && w()} keyed>
      {(watch) => (
        <Show when={!nativePopped()} fallback={<NativePopOutLink channelId={channel()!} />}>
          <Show
            when={!popped()}
            fallback={
              <Portal mount={popped()!.document.body}>
                <div style={{ position: 'fixed', inset: '0' }}>
                  <PlayerFor channelId={channel()!} watch={watch} />
                </div>
              </Portal>
            }
          >
            <div
              ref={hostEl}
              class="watch-host"
              classList={{ floating: !box() }}
              style={
                box()
                  ? {
                      left: `${box()!.x}px`,
                      top: `${box()!.y}px`,
                      width: `${box()!.w}px`,
                      height: `${box()!.h}px`,
                      'clip-path': box()!.clip,
                    }
                  : {}
              }
            >
              <div class="watch-host-video">
                <PlayerFor channelId={channel()!} watch={watch} />
                <Show when={watches[channel()!]?.ended}>
                  <WatchEnded channelId={channel()!} onStop={() => void attempt(() => stopWatch(channel()!))} />
                </Show>
              </div>
              <Show when={!box()}>
                <div
                  class="watch-mini-bar"
                  onContextMenu={(e) => watchMenu(e, channel()!, state.channels[channel()!]?.guild_id)}
                >
                  <span class={`watch-provider ${watch.provider}`}>{PROVIDERS[watch.provider]}</span>
                  <span class="grow" />
                  <button class="vp-btn" data-tip={t('Fullscreen')} onClick={toggleWatchFullscreen}>
                    <I.Fullscreen size={16} />
                  </button>
                  <button class="vp-btn" data-tip={t('Back to the call')} onClick={() => selectChannel(channel()!)}>
                    <I.Maximize size={16} />
                  </button>
                  <Show when={canPopOutWatch()}>
                    <button class="vp-btn" data-tip={t('Pop out')} onClick={() => void popOutWatch()}>
                      <I.PopOut size={16} />
                    </button>
                  </Show>
                  <button
                    class="vp-btn danger"
                    data-tip={t('Hide for me')}
                    onClick={() => setWatchOpen(channel()!, false)}
                  >
                    <I.Close size={16} />
                  </button>
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      )}
    </Show>
  );
}

/** The shared video's menu: right-click on its tile, its bar, or (desktop app) inside the player itself. */
export function watchMenuItems(channelId: string): MenuEntry[] {
  const w = watches[channelId];
  if (!w) return [];
  const inCall = voiceUi.channelId === channelId;
  const open = showing(channelId);
  const items: MenuEntry[] = [];
  if (!open) {
    if (inCall)
      items.push({
        label: t('Watch together'),
        icon: () => <I.Play size={16} />,
        run: () => setWatchOpen(channelId, true),
      });
  } else {
    if (!w.live && !w.ended)
      items.push({
        label: w.playing ? t('Pause for everyone') : t('Play for everyone'),
        icon: () => <I.Play size={16} />,
        run: () => void controlWatch(channelId, { playing: !w.playing, position: expectedPosition(w) }),
      });
    items.push(
      'separator',
      {
        label: watchExpanded(channelId) ? t('Back to grid') : t('Focus'),
        icon: () => <I.Maximize size={16} />,
        run: () => toggleFocus(channelId),
      },
      { label: t('Fullscreen'), icon: () => <I.Fullscreen size={16} />, run: toggleWatchFullscreen },
    );
    if (!isMobile())
      items.push({
        label: t('Theater mode'),
        checked: watchTheater(channelId),
        run: () => setTheaterMode(channelId, !watchTheater(channelId)),
      });
    if (chatFor(w))
      items.push({ label: t('Stream chat'), checked: chatShown(channelId), run: () => toggleChat(channelId) });
    if (canPopOutWatch())
      items.push({
        label: poppedOut() ? t('Bring it back') : t('Pop out'),
        icon: () => <I.PopOut size={16} />,
        run: () => (poppedOut() ? closePopOutWatch() : void popOutWatch()),
      });
  }
  items.push(
    'separator',
    { label: t('Copy Link'), icon: () => <I.Copy size={16} />, run: () => void copyLink(w.url) },
    { label: t('Open in Browser'), icon: () => <I.External size={16} />, run: () => void openExternal(w.url) },
  );
  if (inCall) {
    items.push('separator');
    if (open) items.push({ label: t('Hide for me'), run: () => setWatchOpen(channelId, false) });
    items.push({
      label: t('Stop for everyone'),
      danger: true,
      icon: () => <I.Close size={16} />,
      run: () => void attempt(() => stopWatch(channelId)),
    });
  }
  return items;
}

export function openWatchMenu(x: number, y: number, channelId: string) {
  const items = watchMenuItems(channelId);
  if (items.length) setUi('menu', { x, y, items });
}

function watchMenu(e: MouseEvent, channelId: string, _guildId?: string | null) {
  e.preventDefault();
  e.stopPropagation();
  openWatchMenu(e.clientX, e.clientY, channelId);
}

/** The channel of the call whose player sits under this point (for right-clicks inside the player). */
export function watchAt(x: number, y: number): string | null {
  const ch = voiceUi.channelId;
  if (!ch || !showing(ch)) return null;
  const el = document.elementFromPoint(x, y);
  return el?.closest('.watch-host') ? ch : null;
}

/**
 * The shared video as a tile of the call, next to streams and cameras. Until you open it, it's an invitation;
 * once open, the player is laid over its slot and the bar under it has its controls.
 */
export function WatchTile(p: {
  channelId: string;
  guildId?: string | null;
  large?: boolean;
  small?: boolean;
  tiled?: boolean;
}) {
  const w = () => watches[p.channelId];
  const inCall = () => voiceUi.channelId === p.channelId;
  const open = () => !!opened()[p.channelId] && inCall();
  const viewers = () => (w()?.viewers ?? []).filter((id) => state.voice[id]?.channel_id === p.channelId);
  const chatInPage = () => {
    const chat = chatFor(w());
    return chat?.framed && chatShown(p.channelId) ? chat.src : null;
  };
  return (
    <Show when={w()}>
      {(watch) => (
        <div
          class="video-card watch-party"
          classList={{ open: open(), expanded: !!p.large && open(), large: p.large, small: p.small, tiled: p.tiled }}
          onContextMenu={(e) => watchMenu(e, p.channelId, p.guildId)}
        >
          <Show
            when={open()}
            fallback={
              <div class="watch-invite">
                <span class="watch-tags">
                  <span class={`watch-provider ${watch().provider}`}>{PROVIDERS[watch().provider]}</span>
                  <Show when={watch().live}>
                    <span class="live-badge">{t('LIVE')}</span>
                  </Show>
                </span>
                <Show when={!p.small}>
                  <strong>{t('{name} is sharing a video', { name: nameOf(watch().started_by, p.guildId) })}</strong>
                  <button class="watch-url" title={watch().url} onClick={() => void openExternal(watch().url)}>
                    {watch().url}
                  </button>
                </Show>
                <Show
                  when={inCall()}
                  fallback={<span class="muted small">{t('Join the call to watch together.')}</span>}
                >
                  <button class="btn primary" onClick={() => setWatchOpen(p.channelId, true)}>
                    <I.Play size={16} /> {t('Watch together')}
                  </button>
                </Show>
                <Show when={!p.small}>
                  <Viewers ids={viewers()} guildId={p.guildId} />
                </Show>
              </div>
            }
          >
            <div class="watch-body">
              <div
                class="watch-slot"
                ref={(el) => {
                  setSlot(el);
                  onCleanup(() => slot() === el && setSlot(null));
                }}
              >
                <Show when={poppedOut()}>
                  <div class="popped-out">
                    <I.PopOut size={26} />
                    <span>{t('Playing in the pop-out window')}</span>
                    <button class="btn small-btn" onClick={closePopOutWatch}>
                      {t('Bring it back')}
                    </button>
                  </div>
                </Show>
              </div>
              <Show when={chatInPage()} keyed>
                {(src) => (
                  <iframe
                    class="watch-chat"
                    title={t('Stream chat')}
                    src={src}
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-storage-access-by-user-activation"
                  />
                )}
              </Show>
            </div>
            <Show when={!p.small}>
              <div class="watch-bar">
                <span class={`watch-provider ${watch().provider}`}>{PROVIDERS[watch().provider]}</span>
                <Show when={watch().live}>
                  <span class="live-badge">{t('LIVE')}</span>
                </Show>
                <span class="watch-by">{t('Shared by {name}', { name: nameOf(watch().started_by, p.guildId) })}</span>
                <Viewers ids={viewers()} guildId={p.guildId} />
                <Show when={mutedForStream()}>
                  <span
                    class="watch-muted"
                    data-tip={t("Muted while you stream: Windows 10 would send it to your stream's viewers")}
                  >
                    <I.VolumeMute size={15} />
                  </span>
                </Show>
                <span class="grow" />
                <Show when={chatFor(watch())}>
                  <button
                    class="vp-btn"
                    classList={{ on: chatShown(p.channelId) }}
                    data-tip={chatShown(p.channelId) ? t('Hide stream chat') : t('Show stream chat')}
                    aria-label={chatShown(p.channelId) ? t('Hide stream chat') : t('Show stream chat')}
                    onClick={() => toggleChat(p.channelId)}
                  >
                    <I.StreamChat size={16} />
                  </button>
                </Show>
                <button
                  class="vp-btn"
                  data-tip={t('Copy Link')}
                  aria-label={t('Copy Link')}
                  onClick={() => void copyLink(watch().url)}
                >
                  <I.Copy size={16} />
                </button>
                <button
                  class="vp-btn"
                  classList={{ on: !!p.large }}
                  data-tip={p.large ? t('Back to grid') : t('Focus')}
                  aria-label={p.large ? t('Back to grid') : t('Focus')}
                  onClick={() => toggleFocus(p.channelId)}
                >
                  <I.Maximize size={16} />
                </button>
                <Show when={!isMobile()}>
                  <button
                    class="vp-btn"
                    classList={{ on: watchTheater(p.channelId) }}
                    data-tip={watchTheater(p.channelId) ? t('Exit theater mode') : t('Theater mode')}
                    aria-label={watchTheater(p.channelId) ? t('Exit theater mode') : t('Theater mode')}
                    onClick={() => setTheaterMode(p.channelId, !watchTheater(p.channelId))}
                  >
                    <I.Theater size={16} />
                  </button>
                </Show>
                <button
                  class="vp-btn"
                  data-tip={t('Fullscreen')}
                  aria-label={t('Fullscreen')}
                  onClick={toggleWatchFullscreen}
                >
                  <I.Fullscreen size={16} />
                </button>
                <Show when={canPopOutWatch()}>
                  <button
                    class="vp-btn"
                    data-tip={poppedOut() ? t('Bring it back') : t('Pop out')}
                    aria-label={t('Pop out')}
                    onClick={() => (poppedOut() ? closePopOutWatch() : void popOutWatch())}
                  >
                    <I.PopOut size={16} />
                  </button>
                </Show>
                <button
                  class="vp-btn"
                  data-tip={t('Hide for me')}
                  aria-label={t('Hide for me')}
                  onClick={() => setWatchOpen(p.channelId, false)}
                >
                  <I.EyeOff size={16} />
                </button>
                <button
                  class="vp-btn danger"
                  data-tip={t('Stop for everyone')}
                  aria-label={t('Stop for everyone')}
                  onClick={() => void attempt(() => stopWatch(p.channelId))}
                >
                  <I.Close size={16} />
                </button>
              </div>
            </Show>
          </Show>
        </div>
      )}
    </Show>
  );
}

/** "Watch together" in the call controls: paste a link to share it with the call. */
export function WatchButton(p: { channelId: string }) {
  const [asking, setAsking] = createSignal(false);
  const [url, setUrl] = createSignal('');
  let input!: HTMLInputElement;
  const share = async () => {
    const link = url().trim();
    if (!link) return;
    // Opened before it starts, so the update announcing it never finds us listed but closed.
    const was = !!opened()[p.channelId];
    setOpened({ ...opened(), [p.channelId]: true });
    try {
      await startWatch(p.channelId, link);
      setAsking(false);
      setUrl('');
    } catch (e) {
      setOpened({ ...opened(), [p.channelId]: was });
      toast((e as Error).message);
    }
  };
  return (
    <span class="watch-start">
      <button
        class="round-btn"
        classList={{ on: asking() || !!watches[p.channelId] }}
        data-tip={t('Watch together')}
        aria-label={t('Watch together')}
        onClick={() => {
          setAsking(!asking());
          if (!asking()) return;
          queueMicrotask(() => input?.focus());
        }}
      >
        <I.Tv />
      </button>
      <Show when={asking()}>
        <form
          class="watch-ask"
          onSubmit={(e) => {
            e.preventDefault();
            void share();
          }}
        >
          <strong>{t('Watch together')}</strong>
          <span class="muted small">
            {t('Paste a YouTube video, or a Twitch or Kick channel. Everyone in the call can open it.')}
          </span>
          <div class="watch-ask-row">
            <input
              ref={input}
              placeholder="https://youtube.com/watch?v=…"
              value={url()}
              onInput={(e) => setUrl(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Escape' && setAsking(false)}
            />
            <button class="btn primary small-btn" disabled={!url().trim()}>
              {t('Share')}
            </button>
          </div>
        </form>
      </Show>
    </span>
  );
}
