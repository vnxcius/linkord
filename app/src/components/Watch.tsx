// Watch together in a call: share a YouTube, Twitch or Kick link and everyone who opens it watches the same
// moment (YouTube follows play, pause and seeks; streams are live for everyone). Volume stays each person's own.
import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { selectChannel } from '../lib/actions';
import { t } from '../lib/i18n';
import { nameOf } from '../lib/store';
import { attempt, toast } from '../lib/ui';
import { voiceUi } from '../lib/voice';
import { controlWatch, embedSrc, expectedPosition, startWatch, stopWatch, watches, YouTubeSync } from '../lib/watch';
import * as I from './Icons';

const PROVIDERS = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' } as const;

/** Channels whose shared video we opened (per session; closing it only hides it for us). */
const [opened, setOpened] = createSignal<Record<string, boolean>>({});
/** Channels where the video fills the call (people hidden under it). */
const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});
export const watchExpanded = (channelId: string) =>
  !!expanded()[channelId] && !!opened()[channelId] && !!watches[channelId] && voiceUi.channelId === channelId;
/** Where the player sits in the call view, when the call view is on screen. */
const [slot, setSlot] = createSignal<HTMLElement | null>(null);
/** The Document Picture-in-Picture window the player was popped out to. */
const [popped, setPopped] = createSignal<Window | null>(null);
const pipApi = () =>
  (window as unknown as { documentPictureInPicture?: { requestWindow: (o: object) => Promise<Window> } })
    .documentPictureInPicture;
export const canPopOutWatch = () => !!pipApi();

let hostEl: HTMLDivElement | undefined;
/** Fullscreen for the shared video (the player itself, whichever place it's in). */
function toggleWatchFullscreen() {
  if (document.fullscreenElement) return void document.exitFullscreen().catch(() => {});
  void hostEl?.requestFullscreen?.().catch(() => toast(t("Couldn't go fullscreen")));
}

/** Moves the player into its own always-on-top window (it reloads there and catches up with the others). */
async function popOutWatch() {
  const api = pipApi();
  if (!api || popped()) return;
  try {
    const win = await api.requestWindow({ width: 640, height: 360 });
    win.document.title = 'Linkord';
    win.document.body.style.cssText = 'margin:0;background:#000;overflow:hidden';
    win.addEventListener('pagehide', () => setPopped(null), { once: true });
    setPopped(win);
  } catch {
    toast(t("Couldn't open the pop-out window"));
  }
}

const closePopOutWatch = () => popped()?.close();

function Player(p: { channelId: string }) {
  const w = () => watches[p.channelId];
  // The embed loads once at the shared position; the YouTube one is kept in step from then on.
  const src = embedSrc(w()!, expectedPosition(w()!));
  let frame!: HTMLIFrameElement;
  let sync: YouTubeSync | undefined;
  onMount(() => {
    if (w()?.provider === 'youtube') sync = new YouTubeSync(frame, w, p.channelId);
  });
  onCleanup(() => sync?.dispose());
  return (
    <iframe
      ref={frame}
      class="watch-frame"
      src={src}
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowfullscreen
    />
  );
}

/**
 * The one player for the call's shared video. It stays mounted wherever you go: laid over its place in the call
 * view, floating in a corner while you read other channels, or in the pop-out window. Moving between the call
 * view and the corner doesn't reload it.
 */
export function WatchHost() {
  const channel = () => voiceUi.channelId;
  const w = () => (channel() ? watches[channel()!] : undefined);
  const visible = () => !!w() && !!opened()[channel()!];
  const [box, setBox] = createSignal<{ x: number; y: number; w: number; h: number; clip: string } | null>(null);
  // Follows the slot every frame (layout, scrolling and resizing all move it).
  let raf = 0;
  const follow = () => {
    const el = slot();
    if (el?.isConnected) {
      const r = el.getBoundingClientRect();
      const stage = el.closest('.voice-stage')?.getBoundingClientRect() ?? r;
      const top = Math.max(0, stage.top - r.top);
      const bottom = Math.max(0, r.bottom - stage.bottom);
      const next = { x: r.left, y: r.top, w: r.width, h: r.height, clip: `inset(${top}px 0 ${bottom}px 0)` };
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
  onCleanup(() => cancelAnimationFrame(raf));
  // Leaving the call or hiding the video closes the pop-out too.
  createEffect(() => !visible() && closePopOutWatch());

  return (
    <Show when={visible() && w()} keyed>
      {(watch) => (
        <Show
          when={!popped()}
          fallback={
            <Portal mount={popped()!.document.body}>
              <div style={{ position: 'fixed', inset: '0' }}>
                <Player channelId={channel()!} />
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
              {/* A new link reloads the player. */}
              <Show when={watch.url} keyed>
                {(_url) => <Player channelId={channel()!} />}
              </Show>
              <Show when={watches[channel()!]?.ended}>
                <div class="watch-ended">
                  <strong>{t('Video ended')}</strong>
                  <div class="watch-ended-actions">
                    <button
                      class="btn primary small-btn"
                      onClick={() => void controlWatch(channel()!, { position: 0, playing: true })}
                    >
                      <I.Rejoin size={15} /> {t('Watch again')}
                    </button>
                    <button class="btn small-btn" onClick={() => void attempt(() => stopWatch(channel()!))}>
                      {t('Stop for everyone')}
                    </button>
                  </div>
                </div>
              </Show>
            </div>
            <Show when={!box()}>
              <div class="watch-mini-bar">
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
                  onClick={() => setOpened({ ...opened(), [channel()!]: false })}
                >
                  <I.Close size={16} />
                </button>
              </div>
            </Show>
          </div>
        </Show>
      )}
    </Show>
  );
}

/** The shared video at the top of a call: its place (the player is laid over it) and its controls. */
export function WatchCard(p: { channelId: string; guildId?: string | null }) {
  const w = () => watches[p.channelId];
  const inCall = () => voiceUi.channelId === p.channelId;
  const open = () => !!opened()[p.channelId];
  const big = () => !!expanded()[p.channelId];
  return (
    <Show when={w()}>
      {(watch) => (
        <div class="watch-party" classList={{ open: open() && inCall(), expanded: big() && open() && inCall() }}>
          <Show
            when={open() && inCall()}
            fallback={
              <div class="watch-invite">
                <span class={`watch-provider ${watch().provider}`}>{PROVIDERS[watch().provider]}</span>
                <strong>{t('{name} is sharing a video', { name: nameOf(watch().started_by, p.guildId) })}</strong>
                <a class="watch-url" href={watch().url} target="_blank" rel="noreferrer">
                  {watch().url}
                </a>
                <Show
                  when={inCall()}
                  fallback={<span class="muted small">{t('Join the call to watch together.')}</span>}
                >
                  <button class="btn primary" onClick={() => setOpened({ ...opened(), [p.channelId]: true })}>
                    <I.Play size={16} /> {t('Watch together')}
                  </button>
                </Show>
              </div>
            }
          >
            <div
              class="watch-slot"
              ref={(el) => {
                setSlot(el);
                onCleanup(() => slot() === el && setSlot(null));
              }}
            >
              <Show when={popped()}>
                <div class="popped-out">
                  <I.PopOut size={26} />
                  <span>{t('Playing in the pop-out window')}</span>
                  <button class="btn small-btn" onClick={closePopOutWatch}>
                    {t('Bring it back')}
                  </button>
                </div>
              </Show>
            </div>
          </Show>
          <Show when={inCall()}>
            <div class="watch-bar">
              <span class={`watch-provider ${watch().provider}`}>{PROVIDERS[watch().provider]}</span>
              <Show when={watch().live}>
                <span class="live-badge">{t('LIVE')}</span>
              </Show>
              <span class="watch-by">{t('Shared by {name}', { name: nameOf(watch().started_by, p.guildId) })}</span>
              <span class="grow" />
              <Show when={open()}>
                <button
                  class="vp-btn"
                  classList={{ on: big() }}
                  data-tip={big() ? t('Show people') : t('Hide people')}
                  aria-label={big() ? t('Show people') : t('Hide people')}
                  onClick={() => setExpanded({ ...expanded(), [p.channelId]: !big() })}
                >
                  <I.Users size={16} />
                </button>
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
                    data-tip={popped() ? t('Bring it back') : t('Pop out')}
                    aria-label={t('Pop out')}
                    onClick={() => (popped() ? closePopOutWatch() : void popOutWatch())}
                  >
                    <I.PopOut size={16} />
                  </button>
                </Show>
                <button class="link-btn" onClick={() => setOpened({ ...opened(), [p.channelId]: false })}>
                  {t('Hide for me')}
                </button>
              </Show>
              <button class="link-btn danger" onClick={() => void attempt(() => stopWatch(p.channelId))}>
                {t('Stop for everyone')}
              </button>
            </div>
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
    try {
      await startWatch(p.channelId, link);
      setOpened({ ...opened(), [p.channelId]: true });
      setAsking(false);
      setUrl('');
    } catch (e) {
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
