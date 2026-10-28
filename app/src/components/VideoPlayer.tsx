// Video player for attachments and video links: custom controls, keyboard shortcuts (YouTube-style),
// playback speed, picture-in-picture and download.
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { downloadFile } from '../lib/download';
import { msg, t } from '../lib/i18n';
import { prefs, setPrefs } from '../lib/prefs';
import { toast } from '../lib/ui';
import * as I from './Icons';
import { VolumeControl } from './VolumeControl';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const FRAME = 1 / 30;

const SHORTCUTS: [string, string][] = [
  ['Space / K', msg('Play / pause')],
  ['← / →', msg('Back / forward 5 seconds')],
  ['J / L', msg('Back / forward 10 seconds')],
  ['↑ / ↓', msg('Volume up / down')],
  ['M', msg('Mute')],
  ['F', msg('Fullscreen')],
  ['P', msg('Picture-in-picture')],
  ['< / >', msg('Slower / faster')],
  [', / .', msg('Previous / next frame')],
  ['0 – 9', msg('Jump to 0 – 90%')],
  [msg('Home / End'), msg('Start / end')],
];

const canPip = typeof document !== 'undefined' && !!document.pictureInPictureEnabled;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function formatDuration(s: number) {
  if (!Number.isFinite(s)) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Only one chat video plays at a time. */
let active: HTMLVideoElement | null = null;
export const pauseChatVideo = () => active?.pause();

export function VideoPlayer(p: { src: string; filename: string }) {
  let root!: HTMLDivElement;
  let v!: HTMLVideoElement;
  let seekBar!: HTMLDivElement;

  const [paused, setPaused] = createSignal(true);
  const [started, setStarted] = createSignal(false);
  const [time, setTime] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [buffered, setBuffered] = createSignal(0);
  const [volume, setVolume] = createSignal(prefs.mediaVolume);
  const [muted, setMuted] = createSignal(false);
  const [rate, setRate] = createSignal(1);
  const [waiting, setWaiting] = createSignal(false);
  const [idle, setIdle] = createSignal(false);
  const [menu, setMenu] = createSignal<'speed' | 'keys' | null>(null);
  const [fullscreen, setFullscreen] = createSignal(false);
  const [hover, setHover] = createSignal<number | null>(null);
  const [osd, setOsd] = createSignal<{ text: string; n: number } | null>(null);
  const [saving, setSaving] = createSignal<number | null>(null);
  const [failed, setFailed] = createSignal(false);
  /** The browser plays the sound but can't decode the picture (e.g. HEVC on Linux Chromium): a black frame. */
  const [noVideo, setNoVideo] = createSignal(false);
  const [aspect, setAspect] = createSignal(16 / 9);

  // ---------- feedback ----------
  let osdTimer: number | undefined;
  let osdCount = 0;
  const flash = (text: string) => {
    setOsd({ text, n: ++osdCount });
    clearTimeout(osdTimer);
    osdTimer = window.setTimeout(() => setOsd(null), 700);
  };
  let idleTimer: number | undefined;
  const wake = () => {
    setIdle(false);
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => !v.paused && !menu() && setIdle(true), 2500);
  };

  // ---------- actions ----------
  const play = () => v.play().catch(() => {});
  const toggle = () => (v.paused || v.ended ? void play() : v.pause());
  const seekTo = (t: number) => {
    if (!duration()) return;
    v.currentTime = clamp(t, 0, duration());
    setTime(v.currentTime);
  };
  const seekBy = (s: number) => {
    seekTo(v.currentTime + s);
    flash(`${s > 0 ? '+' : '−'}${Math.abs(s)}s`);
  };
  const setVol = (x: number, announce = false) => {
    x = clamp(Math.round(x * 100) / 100, 0, 1);
    v.volume = x;
    v.muted = x === 0;
    if (x > 0) setPrefs({ mediaVolume: x });
    if (announce) flash(t('Volume {n}%', { n: Math.round(x * 100) }));
  };
  const toggleMute = () => {
    if (v.muted || v.volume === 0) setVol(v.volume || prefs.mediaVolume || 0.5);
    else v.muted = true;
    flash(v.muted ? t('Muted') : t('Volume {n}%', { n: Math.round(v.volume * 100) }));
  };
  const setSpeed = (r: number) => {
    v.playbackRate = r;
    flash(`${r}×`);
  };
  const stepSpeed = (dir: 1 | -1) => {
    const i = SPEEDS.findIndex((s) => s >= v.playbackRate);
    setSpeed(SPEEDS[clamp((i < 0 ? SPEEDS.length - 1 : i) + dir, 0, SPEEDS.length - 1)]);
  };
  const stepFrame = (dir: 1 | -1) => {
    v.pause();
    seekTo(v.currentTime + dir * FRAME);
  };
  const toggleFullscreen = () => (document.fullscreenElement ? void document.exitFullscreen() : void root.requestFullscreen?.());
  const togglePip = () =>
    void (document.pictureInPictureElement === v ? document.exitPictureInPicture() : v.requestPictureInPicture()).catch(() =>
      toast(t("Picture-in-picture isn't available here")),
    );
  const save = async () => {
    if (saving() !== null) return;
    setSaving(0);
    try {
      await downloadFile(p.src, p.filename, (x) => setSaving(x));
    } catch (e) {
      toast(t('Download failed: {error}', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSaving(null);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (k) {
      case ' ':
      case 'k':
        toggle();
        break;
      case 'ArrowLeft':
        seekBy(-5);
        break;
      case 'ArrowRight':
        seekBy(5);
        break;
      case 'j':
        seekBy(-10);
        break;
      case 'l':
        seekBy(10);
        break;
      case 'ArrowUp':
        setVol(v.volume + 0.05, true);
        break;
      case 'ArrowDown':
        setVol(v.volume - 0.05, true);
        break;
      case 'm':
        toggleMute();
        break;
      case 'f':
        toggleFullscreen();
        break;
      case 'p':
        if (canPip) togglePip();
        break;
      case '<':
        stepSpeed(-1);
        break;
      case '>':
        stepSpeed(1);
        break;
      case ',':
        stepFrame(-1);
        break;
      case '.':
        stepFrame(1);
        break;
      case 'Home':
        seekTo(0);
        break;
      case 'End':
        seekTo(duration());
        break;
      case '?':
        setMenu(menu() === 'keys' ? null : 'keys');
        break;
      case 'Escape':
        if (!menu()) return;
        setMenu(null);
        break;
      default:
        if (!/^[0-9]$/.test(k)) return;
        seekTo((+k / 10) * duration());
    }
    e.preventDefault();
    e.stopPropagation();
    wake();
  };

  // ---------- scrubbing ----------
  const fraction = (el: HTMLElement, e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1);
  };
  let scrubbing = false;
  let resumeAfterScrub = false;
  const seekDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    seekBar.setPointerCapture(e.pointerId);
    scrubbing = true;
    resumeAfterScrub = !v.paused;
    v.pause();
    seekTo(fraction(seekBar, e) * duration());
  };
  const seekMove = (e: PointerEvent) => {
    setHover(fraction(seekBar, e));
    if (scrubbing) seekTo(fraction(seekBar, e) * duration());
  };
  const seekUp = () => {
    if (!scrubbing) return;
    scrubbing = false;
    if (resumeAfterScrub) void play();
  };
  // Smooth progress bar while playing (timeupdate only fires ~4 times a second).
  let raf = 0;
  const tick = () => {
    setTime(v.currentTime);
    raf = requestAnimationFrame(tick);
  };

  const onFs = () => setFullscreen(document.fullscreenElement === root);
  onMount(() => {
    v.volume = prefs.mediaVolume;
    document.addEventListener('fullscreenchange', onFs);
  });
  onCleanup(() => {
    document.removeEventListener('fullscreenchange', onFs);
    cancelAnimationFrame(raf);
    clearTimeout(idleTimer);
    clearTimeout(osdTimer);
    if (active === v) active = null;
  });

  return (
    <div
      class="vp"
      classList={{ playing: !paused(), idle: idle() && !paused(), fullscreen: fullscreen(), started: started() }}
      ref={root}
      tabindex="0"
      // Sized to the video so portrait clips don't sit in a wide black box (max height 380px).
      style={fullscreen() ? undefined : { width: `${clamp(Math.round(380 * aspect()), 320, 560)}px` }}
      onKeyDown={onKey}
      onPointerMove={wake}
      onPointerLeave={() => !paused() && setIdle(true)}
    >
      <video
        ref={v}
        src={p.src}
        preload="metadata"
        playsinline
        onClick={() => (menu() ? setMenu(null) : toggle())}
        onDblClick={toggleFullscreen}
        onPlay={() => {
          if (active && active !== v) active.pause();
          active = v;
          setPaused(false);
          setStarted(true);
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(tick);
          wake();
        }}
        onPause={() => {
          setPaused(true);
          setIdle(false);
          cancelAnimationFrame(raf);
          setTime(v.currentTime);
        }}
        onTimeUpdate={() => {
          setTime(v.currentTime);
          if (v.currentTime > 1 && !noVideo() && v.getVideoPlaybackQuality?.().totalVideoFrames === 0) setNoVideo(true);
        }}
        onLoadedMetadata={() => (v.videoWidth ? setAspect(v.videoWidth / v.videoHeight) : setNoVideo(true))}
        onDurationChange={() => setDuration(Number.isFinite(v.duration) ? v.duration : 0)}
        onProgress={() => setBuffered(v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0)}
        onVolumeChange={() => {
          setVolume(v.volume);
          setMuted(v.muted);
        }}
        onRateChange={() => setRate(v.playbackRate)}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onError={() => setFailed(true)}
      />

      <Show when={failed()}>
        <div class="vp-center vp-error">{t("This video can't be played here.")}</div>
      </Show>
      <Show when={noVideo() && !failed()}>
        <div class="vp-novideo">
          <I.Warning size={16} />
          <span>{t("This browser can't show this video's picture (its format isn't supported here), only the sound. Download it to watch.")}</span>
        </div>
      </Show>
      <Show when={!failed() && !started()}>
        <button
          class="vp-big-play"
          aria-label={t('Play')}
          onClick={() => {
            // This button disappears once playing; keep focus on the player for the shortcuts.
            root.focus({ preventScroll: true });
            void play();
          }}
        >
          <I.Play size={30} />
        </button>
      </Show>
      <Show when={waiting() && !paused()}>
        <div class="vp-center">
          <div class="spinner" />
        </div>
      </Show>
      <Show when={osd()} keyed>
        {(o) => <div class="vp-osd">{o.text}</div>}
      </Show>

      <Show when={menu() === 'keys'}>
        <div class="vp-keys" onClick={() => setMenu(null)}>
          <div class="vp-keys-card" onClick={(e) => e.stopPropagation()}>
            <strong>{t('Keyboard shortcuts')}</strong>
            <For each={SHORTCUTS}>
              {([key, what]) => (
                <div class="vp-key-row">
                  <kbd>{t(key)}</kbd>
                  <span>{t(what)}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <div
        class="vp-controls"
        // Keep keyboard focus on the player itself so shortcuts keep working after a click.
        onMouseDown={(e) => {
          e.preventDefault();
          root.focus({ preventScroll: true });
        }}
      >
        <div class="vp-seek" ref={seekBar} onPointerDown={seekDown} onPointerMove={seekMove} onPointerUp={seekUp} onPointerCancel={seekUp} onPointerLeave={() => setHover(null)}>
          <div class="vp-track">
            <div class="vp-buffered" style={{ width: `${duration() ? (buffered() / duration()) * 100 : 0}%` }} />
            <Show when={hover() !== null}>
              <div class="vp-hover" style={{ width: `${hover()! * 100}%` }} />
            </Show>
            <div class="vp-progress" style={{ width: `${duration() ? (time() / duration()) * 100 : 0}%` }} />
          </div>
          <div class="vp-thumb" style={{ left: `${duration() ? (time() / duration()) * 100 : 0}%` }} />
          <Show when={hover() !== null && duration()}>
            <div class="vp-tip" style={{ left: `clamp(22px, ${hover()! * 100}%, calc(100% - 22px))` }}>
              {formatDuration(hover()! * duration())}
            </div>
          </Show>
        </div>

        <div class="vp-bar">
          <button class="vp-btn" data-tip={paused() ? t('Play (k)') : t('Pause (k)')} onClick={toggle}>
            {paused() ? <I.Play size={18} /> : <I.Pause size={18} />}
          </button>
          <VolumeControl value={volume()} muted={muted()} tip={t('Mute (m)')} onChange={(x) => setVol(x)} onToggleMute={toggleMute} />
          <span class="vp-time">
            {formatDuration(time())} / {formatDuration(duration())}
          </span>
          <span class="grow" />
          <div class="vp-speed">
            <button class="vp-btn vp-rate" classList={{ changed: rate() !== 1 }} data-tip={t('Playback speed')} onClick={() => setMenu(menu() === 'speed' ? null : 'speed')}>
              <Show when={rate() !== 1} fallback={<I.Speed size={18} />}>
                {rate()}×
              </Show>
            </button>
            <Show when={menu() === 'speed'}>
              <div class="vp-menu">
                <div class="vp-menu-title">{t('Playback speed')}</div>
                <div class="vp-speeds">
                  <For each={SPEEDS}>
                    {(s) => (
                      <button
                        classList={{ on: rate() === s }}
                        onClick={() => {
                          setSpeed(s);
                          setMenu(null);
                        }}
                      >
                        {s === 1 ? '1×' : `${s}×`}
                      </button>
                    )}
                  </For>
                </div>
                <div class="vp-menu-sep" />
                <button class="vp-menu-link" onClick={() => setMenu('keys')}>
                  {t('Keyboard shortcuts')} <kbd>?</kbd>
                </button>
              </div>
            </Show>
          </div>
          <button class="vp-btn" data-tip={saving() !== null ? t('Downloading…') : t('Download')} onClick={() => void save()}>
            <Show when={saving() !== null} fallback={<I.Download size={18} />}>
              <span class="vp-saving">{Number.isNaN(saving()!) ? '…' : `${Math.round(saving()! * 100)}%`}</span>
            </Show>
          </button>
          <Show when={canPip}>
            <button class="vp-btn" data-tip={t('Picture-in-picture (p)')} onClick={togglePip}>
              <I.PopOut size={18} />
            </button>
          </Show>
          <button class="vp-btn" data-tip={fullscreen() ? t('Exit fullscreen (f)') : t('Fullscreen (f)')} onClick={toggleFullscreen}>
            {fullscreen() ? <I.ExitFullscreen size={18} /> : <I.EnterFullscreen size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
}
