// A fake Spotify (accounts + Web API) for the test server: consent auto-approves, tokens are fake,
// and tests set what's "playing" with POST /mock/playing { track: {...} | null }. Also serves a small Discord
// detectable-games list at /detectable.
//   node spotify-mock.mjs [port]
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 7702);
let playing = null;
// A small album cover (gradient square) so screenshots look like the real thing.
const COVER = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#3a7bd5"/><stop offset="1" stop-color="#d4a72c"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><circle cx="32" cy="32" r="12" fill="#0e1412" opacity=".6"/></svg>')}`;
let codes = 0;

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const body = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => resolve(data));
});

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  // Discord's detectable applications list (game detection), a few real-shaped entries.
  if (url.pathname === '/detectable') {
    return json(res, 200, [
      { id: '1158877933042143272', name: 'Counter-Strike 2', icon_hash: '558f5a26ecb3b17c3dea3d15c1df537a', executables: [{ os: 'win32', name: 'win64/cs2.exe', is_launcher: false }] },
      { id: '700136079562375258', name: 'VALORANT', icon_hash: '11f81959f4fdd76ca6c39c59eac256c1', executables: [{ os: 'win32', name: 'win64/valorant-win64-shipping.exe', is_launcher: false }] },
      { id: '42', name: 'Launcher Only', icon_hash: null, executables: [{ os: 'win32', name: 'launcher.exe', is_launcher: true }] },
    ]);
  }
  if (url.pathname === '/authorize') {
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', `code${++codes}`);
    back.searchParams.set('state', url.searchParams.get('state'));
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (url.pathname === '/api/token' && req.method === 'POST') {
    const form = new URLSearchParams(await body(req));
    if (req.headers.authorization !== `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`) return json(res, 401, { error: 'invalid_client' });
    if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'revoked') return json(res, 400, { error: 'invalid_grant' });
    return json(res, 200, { access_token: `at-${Date.now()}`, refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' });
  }
  if (!req.headers.authorization?.startsWith('Bearer at-') && url.pathname.startsWith('/v1/')) return json(res, 401, { error: { status: 401 } });
  if (url.pathname === '/v1/me') return json(res, 200, { id: 'mock-listener', display_name: 'Mock Listener' });
  if (url.pathname === '/v1/me/player/currently-playing') {
    if (!playing) {
      res.writeHead(204);
      return res.end();
    }
    const t = playing;
    return json(res, 200, {
      is_playing: t.is_playing ?? true,
      currently_playing_type: 'track',
      progress_ms: t.progress_ms ?? 30000 + (Date.now() - t.since),
      item: {
        id: t.id,
        name: t.name,
        duration_ms: t.duration_ms ?? 180000,
        external_urls: { spotify: `https://open.spotify.com/track/${t.id}` },
        artists: (t.artists ?? ['Mock Artist']).map((name, i) => ({ name, external_urls: { spotify: `https://open.spotify.com/artist/a${i}` } })),
        album: { name: t.album ?? 'Mock Album', external_urls: { spotify: 'https://open.spotify.com/album/x' }, images: [{ url: COVER, width: 300, height: 300 }] },
      },
    });
  }
  if (url.pathname === '/mock/playing' && req.method === 'POST') {
    const { track } = JSON.parse((await body(req)) || '{}');
    playing = track ? { ...track, since: Date.now() } : null;
    return json(res, 200, {});
  }
  json(res, 404, {});
}).listen(port, '127.0.0.1');
