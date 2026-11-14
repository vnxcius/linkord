// The public clip page (/clip/<slug>, rendered by server/src/clips.rs) with Pottira's own video player instead of the
// browser's. The server's page already has a plain <video> inside #clip-player, so it plays without this script (link
// previews, JavaScript off, an older build); this swaps it for VideoPlayer once it loads.

import './lib/storage-migrate';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource/instrument-serif/400.css';
import './styles.css';
import './clip-page.css';
import { render, Show } from 'solid-js/web';
import { VideoPlayer } from './components/VideoPlayer';
import { initTooltips } from './lib/tooltip';
import { ui } from './lib/ui';

const slot = document.getElementById('clip-player');
const video = slot?.querySelector('video');
const src = video?.getAttribute('src');
if (slot && src) {
  initTooltips();
  const poster = video!.getAttribute('poster') ?? undefined;
  const filename = slot.dataset.filename || 'clip.mp4';
  slot.replaceChildren();
  render(
    () => (
      <>
        <VideoPlayer src={src} poster={poster} filename={filename} large />
        {/* The player's few messages (a download that failed). */}
        <Show when={ui.toast}>
          <div class="toast">{ui.toast}</div>
        </Show>
      </>
    ),
    slot,
  );
}
