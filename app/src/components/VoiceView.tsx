import { createSignal, For, onCleanup, Show } from 'solid-js';
import { msg, t } from '../lib/i18n';
import { prefs } from '../lib/prefs';
import { nameOf, state, voiceMembers } from '../lib/store';
import type { Channel } from '../lib/types';
import { openMenu, setUi } from '../lib/ui';
import {
  canSendVideo,
  joinVoice,
  leaveVoice,
  registerCanvas,
  setStreamVolume,
  stopScreenShare,
  streamVolume,
  toggleStreamMute,
  toggleCamera,
  toggleDeafen,
  toggleMute,
  videoTiles,
  voiceUi,
  watchStream,
  setVoiceUi,
} from '../lib/voice';
import { Avatar } from './Avatar';
import * as I from './Icons';
import { openSwitchSource, volumeMenu } from './Sidebar';
import { VolumeControl } from './VolumeControl';

export const canShareScreen = canSendVideo && !!navigator.mediaDevices?.getDisplayMedia;

/** A stream or camera that can be shown large. Keys look like `<userId>-screen` / `<userId>-camera`. */
interface VideoItem {
  key: string;
  userId: string;
  source: 'screen' | 'camera';
}

export function VoiceView(p: { channel: Channel }) {
  const connected = () => voiceUi.channelId === p.channel.id && !voiceUi.connecting;
  // People streaming come first, like the channel list.
  const members = () => liveFirst(voiceMembers(p.channel.id));
  const me = () => state.me!.id;
  const gid = () => p.channel.guild_id;

  const videos = (): VideoItem[] => {
    const out: VideoItem[] = [];
    for (const v of members()) {
      const isMe = v.user_id === me();
      if (isMe ? voiceUi.screen : v.self_stream) out.push({ key: `${v.user_id}-screen`, userId: v.user_id, source: 'screen' });
      const hasCam = isMe ? voiceUi.camera : videoTiles().some((t) => t.key === `${v.user_id}-camera`);
      if (hasCam) out.push({ key: `${v.user_id}-camera`, userId: v.user_id, source: 'camera' });
    }
    return out;
  };
  // Keyed on the plain key string so the view tears down cleanly when the stream ends.
  const focusKey = () => (connected() ? videos().find((v) => v.key === voiceUi.focus)?.key : undefined);
  const parseKey = (key: string): VideoItem => {
    const i = key.lastIndexOf('-');
    return { key, userId: key.slice(0, i), source: key.slice(i + 1) as VideoItem['source'] };
  };

  const ParticipantTile = (v: { user_id: string; self_mute: boolean; self_deaf: boolean; self_stream?: boolean }) => {
    const speaking = () => !!voiceUi.speaking[v.user_id] && !v.self_mute;
    return (
      <div
        class="voice-tile"
        classList={{ speaking: speaking(), quiet: prefs.userVolumes[v.user_id] === 0 }}
        onContextMenu={(e) => v.user_id !== me() && openMenu(e, volumeMenu(v.user_id))}
      >
        <Avatar user={state.users[v.user_id]} size={64} />
        <span class="voice-tile-name">
          <span class="name">{nameOf(v.user_id, gid())}</span>
          <Show when={v.self_stream}>
            <span class="live-badge">{t('LIVE')}</span>
          </Show>
          <Show when={v.self_deaf} fallback={<Show when={v.self_mute}><I.MicOff size={14} /></Show>}>
            <I.HeadphonesOff size={14} />
          </Show>
        </span>
      </div>
    );
  };

  return (
    <section class="voice-view" classList={{ focused: !!focusKey() }}>
      <Show
        when={focusKey()}
        keyed
        fallback={
          <div class="voice-stage">
            <Show when={videos().length}>
              <div class="grid-show seg" role="tablist">
                <For each={GRID_SHOW}>
                  {([id, label]) => (
                    <button classList={{ active: voiceUi.gridShow === id }} onClick={() => setVoiceUi('gridShow', id)}>
                      {t(label)}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show
              when={voiceUi.gridShow === 'video' && videos().length}
              fallback={
                <div class="voice-grid">
                  <Show when={voiceUi.gridShow !== 'people'}>
                    <For each={videos()}>{(item) => <VideoCard item={item} guildId={gid()} />}</For>
                  </Show>
                  <Show when={voiceUi.gridShow !== 'video'}>
                    <For each={members()} fallback={<p class="muted">{t('No one is here yet.')}</p>}>
                      {(v) => ParticipantTile(v)}
                    </For>
                  </Show>
                </div>
              }
            >
              {/* Only streams and cameras, sized to fill the stage so several can be watched at once. */}
              <div class="stream-grid" style={gridSize(videos().length)}>
                <For each={videos()}>{(item) => <VideoCard item={item} guildId={gid()} tiled />}</For>
              </div>
            </Show>
          </div>
        }
      >
        {(key) => (
          <>
            <div class="focus-stage">
              <VideoCard item={parseKey(key)} guildId={gid()} large />
            </div>
            <div class="strip-wrap" classList={{ hidden: voiceUi.hideStrip }}>
              <button class="strip-toggle" onClick={() => setVoiceUi('hideStrip', !voiceUi.hideStrip)} aria-label={voiceUi.hideStrip ? t('Show members') : t('Hide members')}>
                <I.Chevron size={16} class={voiceUi.hideStrip ? 'flip' : ''} />
                {voiceUi.hideStrip ? t('Show members') : t('Hide members')}
              </button>
              <Show when={!voiceUi.hideStrip}>
                <div class="strip">
                  <For each={videos().filter((v) => v.key !== key)}>{(v) => <VideoCard item={v} guildId={gid()} small />}</For>
                  <For each={members()}>{(v) => ParticipantTile(v)}</For>
                </div>
              </Show>
            </div>
          </>
        )}
      </Show>
      <div class="voice-controls">
        <Show
          when={voiceUi.channelId === p.channel.id}
          fallback={
            <button class="btn primary" onClick={() => void joinVoice(p.channel.id)}>
              {t('Join voice')}
            </button>
          }
        >
          <button class="round-btn" classList={{ off: voiceUi.muted }} data-tip={voiceUi.muted ? t('Unmute') : t('Mute')} onClick={() => void toggleMute()}>
            <Show when={voiceUi.muted} fallback={<I.Mic />}>
              <I.MicOff />
            </Show>
          </button>
          <button class="round-btn" classList={{ off: voiceUi.deafened }} data-tip={voiceUi.deafened ? t('Undeafen') : t('Deafen')} onClick={() => void toggleDeafen()}>
            <Show when={voiceUi.deafened} fallback={<I.Headphones />}>
              <I.HeadphonesOff />
            </Show>
          </button>
          <Show when={canSendVideo}>
            <button class="round-btn" classList={{ on: voiceUi.camera }} data-tip={t('Camera')} disabled={!connected()} onClick={() => void toggleCamera()}>
              <I.Camera />
            </button>
          </Show>
          <Show when={canShareScreen}>
            <Show
              when={voiceUi.screen}
              fallback={
                <button class="round-btn" data-tip={t('Share your screen')} disabled={!connected()} onClick={() => setUi('modal', { type: 'go-live' })}>
                  <I.Screen />
                </button>
              }
            >
              <button class="round-btn" data-tip={t('Switch what you share')} onClick={openSwitchSource}>
                <I.Switch />
              </button>
              <button class="round-btn" data-tip={t('Stream quality')} onClick={() => setUi('modal', { type: 'go-live', update: true })}>
                <I.Gear />
              </button>
              <button class="pill-btn danger" onClick={stopScreenShare}>
                <I.Screen size={18} /> {t('Stop streaming')}
              </button>
            </Show>
          </Show>
          <button class="round-btn hangup" data-tip={t('Disconnect')} onClick={() => void leaveVoice()}>
            <I.Hangup />
          </button>
        </Show>
      </div>
    </section>
  );
}

const GRID_SHOW = [
  ['all', msg('Everyone')],
  ['video', msg('Streams')],
  ['people', msg('People')],
] as const;

/** Columns and rows for `n` equal 16:9 tiles. */
function gridSize(n: number) {
  const cols = Math.ceil(Math.sqrt(n));
  return { '--cols': cols, '--rows': Math.ceil(n / cols) };
}

/** Voice members with people who are live first (stable otherwise). */
export function liveFirst<T extends { self_stream?: boolean }>(list: T[]): T[] {
  return [...list].sort((a, b) => Number(!!b.self_stream) - Number(!!a.self_stream));
}

/** People watching a user's screen share. */
export function viewersOf(userId: string): string[] {
  return Object.values(state.voice)
    .filter((v) => v.watching?.includes(userId))
    .map((v) => v.user_id);
}

/** Floats a stream over other apps (OS picture-in-picture), where the webview supports it. */
export const canPopOut = typeof document !== 'undefined' && !!document.pictureInPictureEnabled && 'captureStream' in HTMLCanvasElement.prototype;

export async function popOut(canvas: HTMLCanvasElement | undefined) {
  if (!canvas) return;
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = canvas.captureStream(60);
  await video.play();
  await video.requestPictureInPicture().catch(() => {});
  video.addEventListener('leavepictureinpicture', () => (video.srcObject = null), { once: true });
}

export function Viewers(p: { userId: string; guildId?: string | null }) {
  const ids = () => viewersOf(p.userId);
  return (
    <Show when={ids().length}>
      <span class="viewers" title={t('Watching: {names}', { names: ids().map((id) => nameOf(id, p.guildId)).join(', ') })}>
        <I.Eye size={14} />
        {ids().length}
        <span class="viewer-avatars">
          <For each={ids().slice(0, 4)}>{(id) => <Avatar user={state.users[id]} size={18} />}</For>
        </span>
      </span>
    </Show>
  );
}

function formatStats(key: string): string {
  const s = voiceUi.stats[key];
  if (!s || !s.height) return '';
  const mbps = s.kbps >= 1000 ? `${(s.kbps / 1000).toFixed(1)} Mbps` : `${s.kbps} kbps`;
  const codec = s.codec.startsWith('avc1') ? 'H.264' : s.codec.startsWith('vp09') ? 'VP9' : 'VP8';
  return `${s.height}p ${s.fps}fps · ${mbps} · ${codec}`;
}

/** Our own stream's audio readout (Windows 10 echo diagnostics): one entry per line. */
function audioDiagLines(): string[] {
  const d = voiceUi.streamAudio;
  if (!d) return [];
  const modes = {
    app: t('only the shared app'),
    all_but_linkord: t('everything except Linkord'),
    system: t('whole PC, voice chat removed by the echo canceller'),
    browser: t('browser capture, no echo canceller'),
    none: t('none'),
  };
  const lines = [t('Stream audio: {mode}', { mode: modes[d.mode] })];
  if (d.fallback) lines.push(t('Native capture failed: {error}', { error: d.fallback }));
  const s = d.stats;
  if (!s) return lines;
  const c = s.canceller;
  if (c?.locked) {
    lines.push(t('Canceller locked · delay {delay} ms · confidence {confidence} · realigned {realigns}× · ignored {rejects} weaker matches', { delay: c.delayMs, confidence: c.confidence, realigns: c.realigns, rejects: c.rejects }));
  } else if (c) {
    lines.push(t('Canceller searching · {misses} of {tries} tries without a match', { misses: c.misses, tries: c.tries }));
  }
  lines.push(
    s.suppressionDb === null
      ? t('Captured {in} dB · sent {out} dB · voice chat silent', { in: s.inDb, out: s.outDb })
      : t('Captured {in} dB · sent {out} dB · voice chat {ref} dB · {suppression} dB removed', { in: s.inDb, out: s.outDb, ref: s.refDb, suppression: s.suppressionDb }),
  );
  const rates = [t('capture {rate} Hz', { rate: s.rate })];
  if (c) rates.push(t('voice reference {rate} Hz', { rate: s.refRate }));
  if (d.device?.mix_rate) rates.push(t('device {rate} Hz, {channels} ch', { rate: d.device.mix_rate, channels: d.device.mix_channels }));
  if (d.device) rates.push(t('{count} gaps', { count: d.device.discontinuities }));
  lines.push(rates.join(' · '));
  if (d.mode === 'system' && !d.defaultOutput) lines.push(t('Voice plays on a device other than the Windows default'));
  return lines;
}

/** Our native stream's per-stage timings: average / peak ms for reading frames back, converting and encoding. */
function captureTimingLines(): string[] {
  const c = voiceUi.captureTimings;
  if (!c) return [];
  const ms = (avg: number, max: number) => `${avg.toFixed(1)} / ${max.toFixed(1)} ms`;
  return [
    t('Readback {readback} · convert {convert} ({threads} threads) · encode {encode}', {
      readback: ms(c.readback_ms, c.readback_max_ms),
      convert: ms(c.convert_ms, c.convert_max_ms),
      threads: c.threads,
      encode: ms(c.encode_ms, c.encode_max_ms),
    }),
    t('{frames} frames/s captured · {encoded} encoded · {skipped} skipped (encoder busy)', { frames: c.frames, encoded: c.encoded, skipped: c.busy_skips }),
  ];
}

function VideoCard(p: { item: VideoItem; guildId?: string | null; large?: boolean; small?: boolean; tiled?: boolean }) {
  let wrap!: HTMLDivElement;
  const me = () => state.me!.id;
  const own = () => p.item.userId === me();
  const isScreen = () => p.item.source === 'screen';
  const watching = () => own() || !isScreen() || !!voiceUi.watching[p.item.userId];
  const localStream = () => videoTiles().find((t) => t.key === `me-${p.item.source}`)?.stream;
  const [idle, setIdle] = createSignal(false);
  const [fullscreen, setFullscreen] = createSignal(false);
  let idleTimer: number | undefined;
  const poke = () => {
    setIdle(false);
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => setIdle(true), 2500);
  };
  const onFs = () => setFullscreen(document.fullscreenElement === wrap);
  document.addEventListener('fullscreenchange', onFs);
  let canvas: HTMLCanvasElement | undefined;
  onCleanup(() => {
    document.removeEventListener('fullscreenchange', onFs);
    clearTimeout(idleTimer);
  });
  const toggleFullscreen = () => (document.fullscreenElement ? void document.exitFullscreen() : void wrap.requestFullscreen?.());
  const focus = () => setVoiceUi('focus', voiceUi.focus === p.item.key ? null : p.item.key);
  // A click focuses a tile, or takes a focused one back to the grid. Wait a moment so a double click
  // (fullscreen) doesn't also count as a click.
  let clickTimer: number | undefined;
  const onClick = () => {
    if (!watching()) return;
    clearTimeout(clickTimer);
    clickTimer = window.setTimeout(focus, 220);
  };
  const onDblClick = () => {
    clearTimeout(clickTimer);
    toggleFullscreen();
  };
  onCleanup(() => clearTimeout(clickTimer));

  return (
    <div
      ref={wrap}
      class="video-card"
      classList={{ large: p.large, small: p.small, tiled: p.tiled, idle: idle() && (p.large || fullscreen()), screen: isScreen(), fullscreen: fullscreen() }}
      onMouseMove={poke}
      onDblClick={onDblClick}
      onClick={onClick}
    >
      <Show
        when={watching()}
        fallback={
          <div class="watch-card">
            <Avatar user={state.users[p.item.userId]} size={p.small ? 40 : 72} />
            <strong>
              {nameOf(p.item.userId, p.guildId)} <span class="live-badge">{t('LIVE')}</span>
            </strong>
            <button class="btn primary" onClick={(e) => (e.stopPropagation(), watchStream(p.item.userId, true, !p.tiled))}>
              {t('Watch Stream')}
            </button>
          </div>
        }
      >
        <Show
          when={own() && localStream()}
          fallback={
            <Show when={!voiceUi.unsupported[p.item.key]} fallback={<p class="video-msg">{t("This device can't play this stream ({codec}).", { codec: voiceUi.unsupported[p.item.key] })}</p>}>
              <canvas
                ref={(c) => {
                  canvas = c;
                  registerCanvas(p.item.key, c, true);
                  onCleanup(() => registerCanvas(p.item.key, c, false));
                }}
              />
              <Show when={!voiceUi.stats[p.item.key]?.fps}>
                <div class="video-msg">
                  <div class="spinner" />
                </div>
              </Show>
            </Show>
          }
        >
          <video ref={(v) => (v.srcObject = localStream() ?? null)} autoplay playsinline muted />
        </Show>
      </Show>

      <Show when={own() && isScreen() && !p.small && (voiceUi.streamAudio || voiceUi.captureTimings)}>
        <div class="audio-diag">
          <For each={[...audioDiagLines(), ...captureTimingLines()]}>{(line) => <div>{line}</div>}</For>
        </div>
      </Show>

      <div class="video-overlay" onClick={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
        <span class="video-label">
          <span class="name">{nameOf(p.item.userId, p.guildId)}</span>
          <Show when={isScreen()}>
            <span class="live-badge">{t('LIVE')}</span>
          </Show>
          <Show when={watching() && !p.small && formatStats(p.item.key)}>
            <span class="video-stats">{formatStats(p.item.key)}</span>
          </Show>
          <Show when={isScreen() && !p.small}>
            <Viewers userId={p.item.userId} guildId={p.guildId} />
          </Show>
        </span>
        <Show when={watching() && !p.small}>
          <div class="video-actions">
            <Show when={isScreen() && !own()}>
              <VolumeControl
                value={streamVolume(p.item.userId)}
                max={2}
                tip={t('Stream volume')}
                onChange={(v) => setStreamVolume(p.item.userId, v)}
                onToggleMute={() => toggleStreamMute(p.item.userId)}
              />
            </Show>
            <button class="vp-btn" data-tip={p.large ? t('Back to grid') : t('Focus')} onClick={focus}>
              <I.Maximize size={16} />
            </button>
            <Show when={canPopOut && canvas}>
              <button class="vp-btn" data-tip={t('Pop out')} onClick={() => void popOut(canvas)}>
                <I.PopOut size={18} />
              </button>
            </Show>
            <button class="vp-btn" data-tip={fullscreen() ? t('Exit fullscreen') : t('Fullscreen')} onClick={toggleFullscreen}>
              <I.Fullscreen size={18} />
            </button>
            <Show when={isScreen() && own()}>
              <button class="vp-btn" data-tip={t('Switch what you share')} onClick={openSwitchSource}>
                <I.Switch size={18} />
              </button>
            </Show>
            <Show when={isScreen()}>
              <button class="vp-btn danger" data-tip={own() ? t('Stop streaming') : t('Stop watching')} onClick={() => (own() ? stopScreenShare() : watchStream(p.item.userId, false))}>
                <I.Close size={18} />
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
