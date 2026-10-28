# Linkord

A self-hosted, Discord-style chat app for a small group of friends: servers, channels, threads, DMs, voice, video
and screen share. Login is Discord OAuth only.

- **Server:** Rust (axum, sqlx) + PostgreSQL. REST API, a websocket gateway, and a voice/video relay, all on one
  HTTPS origin, so voice needs no port forwarding, TURN or media server.
- **Client:** SolidJS + Vite (web), wrapped in a Tauri 2 desktop app (Windows first, Linux packages too) with
  native screen capture, global keybinds, tray and signed auto-updates.

```
server/   Rust backend (src/api REST, gateway.rs, voice.rs, migrations/)
app/      SolidJS client; app/src-tauri = desktop shell
deploy/   Postgres docker-compose, systemd user unit, install script
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
   cd server && cargo test           # server unit tests
   cd app && bun run lint && bun run fmt:check   # oxlint + oxfmt on the client
   cd tests && node --test echo.test.mjs video-links.test.mjs i18n.test.mjs games.test.mjs
   ```
   New UI strings need a pt-BR entry in `app/src/lib/locales/pt-BR.ts` or `i18n.test.mjs` fails.
   GitLab CI (`.gitlab-ci.yml`) runs the same suite on every push and merge request.
6. **Try the desktop app:** `app/build-windows.sh` cross-compiles a Windows installer into `app/out/`.

## Deploy

Production runs as a systemd user service on `127.0.0.1:7700`, published through a Cloudflare tunnel.

1. **Run the full test suite:** `tests/run-local.sh`.
2. **Deploy the server and web client** (builds both, then installs/restarts the `linkord` user service):
   ```bash
   deploy/install-service.sh
   journalctl --user -u linkord -f                 # logs
   ```
   Once per machine: `sudo loginctl enable-linger $USER` so the service survives logout.
3. **Publish the desktop app** (bumps the patch version, signed build, published to the update feed):
   ```bash
   app/publish-windows.sh "What changed"
   app/publish-linux.sh                            # optional: .deb/.rpm for the same version
   ```
   Installed apps update themselves within 30 minutes. Deploy the server first when the client depends on new
   server behaviour, and keep the server compatible with the previous client during that window.
   GitLab CI also builds both installers as job artifacts on `v*` tags (needs a `TAURI_SIGNING_KEY` File variable);
   publishing to the update feed stays local.

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
| `GIPHY_API_KEY` | Optional GIF search |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Optional Spotify connection (redirect `<public_url>/api/connections/spotify/callback`) |
| `LINKORD_DIRECT_BIND` / `LINKORD_DIRECT_HOST` / `CLOUDFLARE_API_TOKEN` | Optional second HTTPS listener that skips Cloudflare (Let's Encrypt via DNS-01) |
