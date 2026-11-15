# Linkord

A self-hosted chat app for a small group of friends: servers, channels, threads, DMs, voice, video and screen share.
Login is Discord OAuth only.

It was briefly called Pottira in November 2026 (version 2.0.0) and went back to Linkord right after.

- **Server:** Rust (axum, sqlx) + PostgreSQL. REST API, a websocket gateway, and a voice/video relay, all on one
  HTTPS origin, so voice needs no port forwarding, TURN or media server.
- **Client:** SolidJS + Vite (web), wrapped in a Tauri 2 desktop app (Windows first, Linux packages too) with
  native screen capture, global keybinds, tray and signed auto-updates.

```
server/   Rust backend (src/api REST, gateway.rs, voice.rs, migrations/)
app/      SolidJS client; app/src-tauri = desktop shell
monitor/  The dashboard (health, logs, moderation): a separate service
deploy/   docker-compose (Postgres, server slots a/b, monitor), Dockerfiles, install scripts
tests/    API, browser (Playwright) and unit tests
```

## Prerequisites

Rust (stable), Node 20+, Bun, Docker. Desktop builds also run in Docker, so no Tauri toolchain is needed locally.

## Develop

1. **Start Postgres** (listens on `127.0.0.1:5433`):
   ```bash
   cp deploy/.env.example deploy/.env        # set POSTGRES_PASSWORD
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
   ```
2. **Configure the server:**
   ```bash
   cp server/.env.example server/.env
   ```
   Set `DATABASE_URL` to the password above. For local work set `LINKORD_DEV_LOGIN=true` (passwordless login,
   **never in production**), or fill `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` with redirect URI
   `<LINKORD_PUBLIC_URL>/api/auth/discord/callback`.
3. **Run the server** (migrations run on startup):
   ```bash
   cd server && cargo run
   ```
4. **Run the web client** with hot reload on http://localhost:1420 (proxies `/api` to the server on :7700):
   ```bash
   cd app && bun install && bun run dev
   ```
5. **Test:**
   ```bash
   tests/run-local.sh                # everything, on a throwaway server (:7701, DB linkord_test)
   tests/run-local.sh --api          # API only (~10 s)
   tests/run-local.sh --ui 'regex'   # matching browser steps only
   tests/run-local.sh --monitor      # the dashboard only
   cd server && cargo test           # server unit tests
   cd app && bun run lint && bun run fmt:check   # oxlint + oxfmt on the client
   cd tests && node --test echo.test.mjs video-links.test.mjs i18n.test.mjs games.test.mjs
   ```
   New UI strings need a pt-BR entry in `app/src/lib/locales/pt-BR.ts` or `i18n.test.mjs` fails.
   GitLab CI (`.gitlab-ci.yml`) runs the same suite on every push and merge request.
6. **Try the desktop app:** `app/build-windows.sh` builds a Windows installer into `app/out/` (cross-compiled in
   Docker on Linux, native on Windows; unsigned when the updater key is missing).

### On Windows

Also needs Visual Studio 2022 Build Tools (C++), WebView2, ffmpeg (`winget install Gyan.FFmpeg`) and, for the UI
tests, `cd tests && npx playwright-core install chromium`. Run the `.sh` scripts in Git Bash. Then, with Postgres and
the server running as above:

```powershell
cd app; bun run desktop      # "Linkord Dev": tauri dev against the local server, next to an installed Linkord
$env:VITE_DEFAULT_SERVER='https://linkord.app'; bun run desktop   # the dev build against production
cd app/src-tauri; cargo test # desktop shell unit tests (keybinds, colour conversion)
```

## Deploy

Production runs in Docker on `127.0.0.1:7700` (deploy/docker-compose.yml), published through a Cloudflare tunnel.

1. **Run the full test suite:** `tests/run-local.sh`.
2. **Deploy the server and web client** (builds the image, then swaps slots a/b without dropping anyone):
   ```bash
   deploy/install-service.sh
   docker logs -f linkord-server-<slot>            # logs; server/data/run/live names the slot serving
   ```
3. **Publish the desktop app** (bumps the patch version, signed build, published to the update feed):
   ```bash
   app/publish-windows.sh "What changed"
   app/publish-linux.sh                            # optional: .deb/.rpm for the same version
   ```
   Installed apps show the update within seconds. Deploy the server first when the client depends on new
   server behaviour, and keep the server compatible with the previous client during that window.
   GitLab CI also builds both installers as job artifacts on `v*` tags (needs a `TAURI_SIGNING_KEY` File variable);
   publishing to the update feed stays local.

4. **Deploy the dashboard** (separate service, deploying one never restarts the other):
   ```bash
   deploy/install-monitor.sh                       # the first run creates monitor/.env with a random password
   ssh -L 7710:127.0.0.1:7710 <user>@<server>      # from your PC, then open http://localhost:7710
   ```
   Availability, performance, network, storage, database, logs and diagnostics, plus every server, account and uploaded
   file for moderation. It listens on loopback by default (`LINKORD_MONITOR_BIND`). Only expose it on purpose: it can see
   everything people upload, direct messages included.

**Updater signing key:** `~/.config/linkord/updater.key` (outside the repo). Back it up: without it, installed apps
can't verify updates and everyone has to reinstall.

### Configuration (`server/.env`)

| Variable | Purpose |
| --- | --- |
| `LINKORD_PUBLIC_URL` | Public https URL (OAuth redirects are built from it) |
| `DATABASE_URL` | Postgres connection string |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord OAuth app |
| `LINKORD_DEV_LOGIN` | Passwordless test login. Keep `false` in production |
| `LINKORD_UPLOAD_QUOTA_MB` | Upload space per user (default 2048) |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Optional Spotify connection (redirect `<public_url>/api/connections/spotify/callback`) |
| `LINKORD_DIRECT_BIND` / `LINKORD_DIRECT_HOST` / `CLOUDFLARE_API_TOKEN` | Optional second HTTPS listener that skips Cloudflare (Let's Encrypt via DNS-01) |
| `LINKORD_INTERNAL_BIND` | Loopback address the dashboard reads live numbers from (default `127.0.0.1:7711`, `off` to disable) |
