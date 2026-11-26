// The shared video's player and its "Video ended" screen. Kept apart from Watch.tsx so the desktop pop-out window
// (WatchPopout.tsx) can show them without loading the rest of the app (voice, store, gateway).
import { createEffect, onCleanup, onMount, Show } from 'solid-js';
import { media } from '../lib/api';
import { t } from '../lib/i18n';
import { PLAYER_SANDBOX } from '../lib/video-links';
import { controlWatch, embedSrc, expectedPosition, watches, YouTubeSync } from '../lib/watch';
import * as I from './Icons';

/** How far a REC clip may drift from the shared position before it's moved back. */
const CLIP_DRIFT = 0.75;

/**
 * A REC clip watched together: our own <video> of the file on this server, kept on the shared position. What the viewer
 * does (play, pause, seek, the end) is sent to everyone; what we do to follow the others isn't.
 */
function ClipPlayer(p: { channelId: string; muted: boolean }) {
  const w = () => watches[p.channelId];
  let video!: HTMLVideoElement;
  /** Changes we're making ourselves, so their events aren't sent back. */
  let following = 0;
  const follow = (fn: () => void) => {
    following++;
    fn();
    setTimeout(() => following--, 300);
  };
  createEffect(() => {
    const x = w();
    if (!x || !video) return;
    const at = expectedPosition(x);
    if (Math.abs(video.currentTime - at) > CLIP_DRIFT) follow(() => (video.currentTime = at));
    if (x.playing && video.paused && !x.ended) follow(() => void video.play().catch(() => {}));
    if (!x.playing && !video.paused) follow(() => video.pause());
  });
  const send = (patch: Parameters<typeof controlWatch>[1]) => {
    if (!following) void controlWatch(p.channelId, patch).catch(() => {});
  };
  return (
    <Show when={w()}>
      {(x) => (
        <video
          ref={video}
          class="watch-frame"
          style={{ display: 'block', width: '100%', height: '100%', background: '#000' }}
          src={media(`/uploads/clips/${x().media}.mp4`)}
          muted={p.muted}
          controls
          playsinline
          onLoadedMetadata={() => follow(() => (video.currentTime = expectedPosition(x())))}
          onPlay={() => send({ playing: true, position: video.currentTime })}
          onPause={() => !video.ended && send({ playing: false, position: video.currentTime })}
          onSeeked={() => send({ position: video.currentTime })}
          onEnded={() => send({ ended: true })}
        />
      )}
    </Show>
  );
}

export function Player(p: { channelId: string; muted: boolean }) {
  const w = () => watches[p.channelId];
  if (w()?.provider === 'clip') return <ClipPlayer channelId={p.channelId} muted={p.muted} />;
  // The embed loads once at the shared position; the YouTube one is kept in step from then on.
  const src = embedSrc(w()!, expectedPosition(w()!), location.hostname, p.muted);
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
      // Inline too: the pop-out window may not have the stylesheet yet when the player moves there.
      style={{ display: 'block', width: '100%', height: '100%', border: '0', background: '#000' }}
      src={src}
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
      allowfullscreen
      sandbox={PLAYER_SANDBOX}
    />
  );
}

/** Over the player once the video played to the end, for everyone. */
export function WatchEnded(p: { channelId: string; onStop: () => void }) {
  return (
    <div class="watch-ended">
      <strong>{t('Video ended')}</strong>
      <div class="watch-ended-actions">
        <button
          class="btn primary small-btn"
          onClick={() => void controlWatch(p.channelId, { position: 0, playing: true })}
        >
          <I.Rejoin size={15} /> {t('Watch again')}
        </button>
        <button class="btn small-btn" onClick={p.onStop}>
          {t('Stop for everyone')}
        </button>
      </div>
    </div>
  );
}
