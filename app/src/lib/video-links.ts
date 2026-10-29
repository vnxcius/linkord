// Inline players for video sites (YouTube, TikTok, Instagram Reels...), like Discord's embeds.
// Keep the recognised URL shapes in sync with `video_site` in server/src/embeds.rs, which makes sure
// these links get an embed even when the page itself offers no preview metadata.

export interface VideoPlayer {
  provider: string;
  /** iframe URL that starts playing on load. */
  src: string;
  /** Portrait (Shorts, TikTok, Reels). */
  vertical: boolean;
  /** Brand colour for the embed's edge. */
  color: string;
}

/** "1m30s", "90", "90s" -> seconds. */
function parseStart(t: string | null): number {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return +t;
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? +(m[1] ?? 0) * 3600 + +(m[2] ?? 0) * 60 + +(m[3] ?? 0) : 0;
}

const ID = /^[\w-]+$/;

export function videoPlayer(raw: string, hostname = location.hostname): VideoPlayer | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^(www|m)\./, '');
  const seg = u.pathname.split('/').filter(Boolean);
  const valid = (id: string | null | undefined): id is string => !!id && ID.test(id);

  if (
    host === 'youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtu.be' ||
    host === 'youtube-nocookie.com'
  ) {
    let id: string | null | undefined;
    let vertical = false;
    if (host === 'youtu.be') id = seg[0];
    else if (seg[0] === 'watch') id = u.searchParams.get('v');
    else if (['shorts', 'live', 'embed'].includes(seg[0])) {
      id = seg[1];
      vertical = seg[0] === 'shorts';
    }
    if (!valid(id)) return null;
    const start = parseStart(u.searchParams.get('t') ?? u.searchParams.get('start'));
    return {
      provider: 'YouTube',
      src: `https://www.youtube.com/embed/${id}?autoplay=1&rel=0${start ? `&start=${start}` : ''}`,
      vertical,
      color: '#ff0033',
    };
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    const i = seg.indexOf('video');
    const id = i >= 0 ? seg[i + 1] : seg[0] === 'embed' ? seg.at(-1) : undefined;
    if (!valid(id) || !/^\d+$/.test(id)) return null;
    return {
      provider: 'TikTok',
      src: `https://www.tiktok.com/player/v1/${id}?autoplay=1&rel=0&description=1&music_info=1`,
      vertical: true,
      color: '#25f4ee',
    };
  }
  if (host === 'instagram.com') {
    // Only reels: a /p/ post is usually a photo, and a play button on it would be a lie.
    const i = seg.findIndex((s) => s === 'reel' || s === 'reels' || s === 'tv');
    const id = i >= 0 ? seg[i + 1] : undefined;
    if (!valid(id)) return null;
    return {
      provider: 'Instagram',
      src: `https://www.instagram.com/reel/${id}/embed/`,
      vertical: true,
      color: '#e1306c',
    };
  }
  if (host === 'vimeo.com' && /^\d+$/.test(seg[0] ?? '')) {
    return {
      provider: 'Vimeo',
      src: `https://player.vimeo.com/video/${seg[0]}?autoplay=1`,
      vertical: false,
      color: '#1ab7ea',
    };
  }
  if (host === 'twitch.tv' || host === 'clips.twitch.tv') {
    // Twitch refuses to play unless told which site embeds it.
    const parent = `parent=${encodeURIComponent(hostname)}`;
    const clip = host === 'clips.twitch.tv' ? seg[0] : seg[1] === 'clip' ? seg[2] : undefined;
    let src: string | undefined;
    if (valid(clip)) src = `https://clips.twitch.tv/embed?clip=${clip}&${parent}&autoplay=true`;
    else if (seg[0] === 'videos' && /^\d+$/.test(seg[1] ?? ''))
      src = `https://player.twitch.tv/?video=${seg[1]}&${parent}&autoplay=true`;
    else if (seg.length === 1 && /^\w{3,25}$/.test(seg[0]))
      src = `https://player.twitch.tv/?channel=${seg[0]}&${parent}&autoplay=true`;
    return src ? { provider: 'Twitch', src, vertical: false, color: '#9146ff' } : null;
  }
  if (host === 'streamable.com' && seg.length === 1 && valid(seg[0])) {
    return {
      provider: 'Streamable',
      src: `https://streamable.com/e/${seg[0]}?autoplay=1`,
      vertical: false,
      color: '#0f90fa',
    };
  }
  if (host === 'dailymotion.com' || host === 'dai.ly') {
    const id = host === 'dai.ly' ? seg[0] : seg[0] === 'video' ? seg[1] : undefined;
    if (!valid(id)) return null;
    return {
      provider: 'Dailymotion',
      src: `https://www.dailymotion.com/embed/video/${id}?autoplay=1`,
      vertical: false,
      color: '#0a0aff',
    };
  }
  return null;
}

/** Hosts the desktop app's CSP must allow in frame-src (see app/src-tauri/tauri.conf.json). */
export const PLAYER_ORIGINS = [
  'https://www.youtube.com',
  'https://www.tiktok.com',
  'https://www.instagram.com',
  'https://player.vimeo.com',
  'https://clips.twitch.tv',
  'https://player.twitch.tv',
  'https://streamable.com',
  'https://www.dailymotion.com',
];
