// Inline video players for links: which URLs get one, and that the desktop CSP lets them load.
// Run: cd tests && node --test video-links.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CHAT_ORIGINS, DESKTOP_CHAT_ORIGINS, PLAYER_ORIGINS, twitchChatFrames, videoPlayer, watchChat } from '../app/src/lib/video-links.ts';

const play = (url) => videoPlayer(url, 'tauri.localhost');

test('YouTube watch, short links, Shorts and start times', () => {
  assert.equal(play('https://www.youtube.com/watch?v=dQw4w9WgXcQ').src, 'https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0');
  assert.equal(play('https://youtu.be/dQw4w9WgXcQ?t=1m30s').src, 'https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&start=90');
  assert.equal(play('https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42').src.endsWith('&start=42'), true);
  const short = play('https://www.youtube.com/shorts/aqz-KE-bpKQ');
  assert.equal(short.vertical, true);
  assert.equal(short.src, 'https://www.youtube.com/embed/aqz-KE-bpKQ?autoplay=1&rel=0');
  assert.equal(play('https://www.youtube.com/@somechannel'), null);
  assert.equal(play('https://www.youtube.com/watch?v=<script>'), null);
});

test('TikTok, Instagram Reels and the rest', () => {
  assert.match(play('https://www.tiktok.com/@scout2015/video/6718335390845095173?lang=en').src, /^https:\/\/www\.tiktok\.com\/player\/v1\/6718335390845095173\?/);
  assert.equal(play('https://www.tiktok.com/@scout2015'), null);
  assert.equal(play('https://vm.tiktok.com/ZMabc123/'), null, 'short link: the server resolves it first');
  assert.equal(play('https://www.instagram.com/reel/C8fLEo2yGmT/?igsh=x').src, 'https://www.instagram.com/reel/C8fLEo2yGmT/embed/');
  assert.equal(play('https://www.instagram.com/reels/C8fLEo2yGmT/').provider, 'Instagram');
  assert.equal(play('https://www.instagram.com/p/C8fLEo2yGmT/'), null, 'posts are usually photos');
  assert.equal(play('https://vimeo.com/76979871').src, 'https://player.vimeo.com/video/76979871?autoplay=1');
  assert.equal(play('https://vimeo.com/about'), null);
  assert.equal(play('https://clips.twitch.tv/FunnyClipSlug').src, 'https://clips.twitch.tv/embed?clip=FunnyClipSlug&parent=tauri.localhost&autoplay=true');
  assert.equal(play('https://www.twitch.tv/somestreamer/clip/FunnyClipSlug').provider, 'Twitch');
  assert.equal(play('https://www.twitch.tv/somestreamer').src, 'https://player.twitch.tv/?channel=somestreamer&parent=tauri.localhost&autoplay=true');
  assert.equal(play('https://streamable.com/abc12').src, 'https://streamable.com/e/abc12?autoplay=1');
  assert.equal(play('https://dai.ly/x8abc').provider, 'Dailymotion');
  assert.equal(play('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(play('not a url'), null);
});

test('every player origin is allowed in the desktop CSP frame-src', () => {
  const conf = JSON.parse(readFileSync(new URL('../app/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const frameSrc = conf.app.security.csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src')).split(/\s+/).slice(1);
  for (const o of PLAYER_ORIGINS) assert.ok(frameSrc.includes(o), `${o} missing from frame-src`);
  for (const url of ['https://youtu.be/x1', 'https://www.tiktok.com/@a/video/1', 'https://www.instagram.com/reel/x/', 'https://vimeo.com/1', 'https://clips.twitch.tv/x', 'https://www.twitch.tv/videos/1', 'https://streamable.com/x', 'https://dai.ly/x']) {
    assert.ok(PLAYER_ORIGINS.includes(new URL(play(url).src).origin), url);
  }
});

test('every player origin is allowed in the web CSP frame-src too', () => {
  const server = readFileSync(new URL('../server/src/security.rs', import.meta.url), 'utf8');
  for (const o of PLAYER_ORIGINS) assert.ok(server.includes(o), `${o} missing from security.rs WEB_CSP`);
  assert.ok(server.includes('https://player.kick.com'));
});

test('watch together chat: only live streams have one, and Twitch is framed only where it allows it', () => {
  const chat = (provider, media, live, frames = true) => watchChat({ provider, media, live }, 'old.example.com', frames, true);
  assert.deepEqual(chat('twitch', 'someone', true), { src: 'https://www.twitch.tv/embed/someone/chat?parent=old.example.com&darkpopout', framed: true });
  assert.deepEqual(chat('twitch', 'someone', true, false), { src: 'https://www.twitch.tv/popout/someone/chat?popout=&darkpopout', framed: false });
  assert.deepEqual(chat('kick', 'someone', true), { src: 'https://kick.com/popout/someone/chat', framed: true });
  assert.deepEqual(chat('youtube', 'aqz-KE-bpKQ', true), { src: 'https://www.youtube.com/live_chat?v=aqz-KE-bpKQ&embed_domain=old.example.com&dark_theme=1', framed: true });
  assert.equal(chat('youtube', 'aqz-KE-bpKQ', false), null);
  assert.equal(chat('twitch', 'v123', false), null);
  const page = (url) => new URL(url);
  assert.equal(twitchChatFrames(page('https://old.example.com/')), true);
  assert.equal(twitchChatFrames(page('https://direct.example.com:8443/')), false);
  assert.equal(twitchChatFrames(page('http://tauri.localhost/')), false);
  assert.equal(twitchChatFrames(page('http://127.0.0.1:7701/')), true);
});

test('every framed chat origin is allowed in both CSPs', () => {
  const conf = JSON.parse(readFileSync(new URL('../app/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const frameSrc = conf.app.security.csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('frame-src')).split(/\s+/).slice(1);
  for (const o of DESKTOP_CHAT_ORIGINS) assert.ok(frameSrc.includes(o), `${o} missing from frame-src`);
  assert.ok(!frameSrc.includes('https://www.twitch.tv'), 'the desktop app never frames www.twitch.tv');
  const server = readFileSync(new URL('../server/src/security.rs', import.meta.url), 'utf8');
  for (const o of CHAT_ORIGINS) assert.ok(server.includes(o), `${o} missing from security.rs WEB_CSP`);
});
