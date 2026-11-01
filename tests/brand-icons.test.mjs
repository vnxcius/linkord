// Profile link icons: which site a link goes to (app/src/lib/brand-icons.ts).
//   node --test brand-icons.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRANDS, brandOf } from '../app/src/lib/brand-icons.ts';

const id = (url) => brandOf(url)?.id ?? null;

test('known sites by host, with or without https://, www, m. or other subdomains', () => {
  assert.equal(id('https://www.instagram.com/someone/'), 'instagram');
  assert.equal(id('instagram.com/someone'), 'instagram');
  assert.equal(id('https://m.youtube.com/@channel'), 'youtube');
  assert.equal(id('youtu.be/abc'), 'youtube');
  assert.equal(id('https://steamcommunity.com/id/someone'), 'steam');
  assert.equal(id('https://store.steampowered.com/app/730'), 'steam');
  assert.equal(id('https://www.twitch.tv/someone'), 'twitch');
  assert.equal(id('https://someone.bandcamp.com'), 'bandcamp');
  assert.equal(id('https://music.apple.com/br/playlist/x'), 'applemusic');
  assert.equal(id('https://bsky.app/profile/someone.bsky.social'), 'bluesky');
  assert.equal(id('HTTPS://GITHUB.COM/Someone'), 'github');
});

test('X links get the Twitter bird', () => {
  assert.equal(id('https://x.com/someone'), 'twitter');
  assert.equal(id('https://twitter.com/someone'), 'twitter');
  assert.equal(brandOf('x.com/someone').name, 'Twitter');
});

test('lookalikes and unknown sites get no brand', () => {
  assert.equal(id('https://notinstagram.com/x'), null);
  assert.equal(id('https://instagram.com.evil.example/x'), null);
  assert.equal(id('https://apple.com'), null, 'only Apple Music');
  assert.equal(id('https://example.org'), null);
  assert.equal(id(''), null);
  assert.equal(id('not a link at all'), null);
});

test('every brand has a name, hosts and a path', () => {
  const ids = new Set();
  for (const b of BRANDS) {
    assert.ok(b.name && b.hosts.length && /^[Mm]/.test(b.path), b.id);
    assert.ok(!ids.has(b.id), `duplicate ${b.id}`);
    ids.add(b.id);
  }
});
