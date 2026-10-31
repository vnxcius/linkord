// The shared video's player and its "Video ended" screen. Kept apart from Watch.tsx so the desktop pop-out window
// (WatchPopout.tsx) can show them without loading the rest of the app (voice, store, gateway).
import { onCleanup, onMount } from 'solid-js';
import { t } from '../lib/i18n';
import { controlWatch, embedSrc, expectedPosition, watches, YouTubeSync } from '../lib/watch';
import * as I from './Icons';

export function Player(p: { channelId: string; muted: boolean }) {
  const w = () => watches[p.channelId];
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
