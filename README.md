# Linkord

A self-hosted chat app for a small group of friends: servers, channels, threads, DMs, voice, video and screen share.
Login is Discord OAuth only.

- **Server:** Rust (axum, sqlx) + PostgreSQL. REST API, a websocket gateway, and a voice/video relay, all on one
  HTTPS origin, so voice needs no port forwarding, TURN or media server.
- **Client:** SolidJS + Vite (web), wrapped in a Tauri 2 desktop app (Windows first, Linux packages too) with
  native screen capture, global keybinds, tray and signed auto-updates.
- **Android:** a native Kotlin + Jetpack Compose app (`android/`), sideloaded with its own updater.

```
server/   Rust backend (src/api REST, gateway.rs, voice.rs, migrations/)
app/      SolidJS client; app/src-tauri = desktop shell
android/  Android app (core, designsystem, voice, app modules)
monitor/  The dashboard (health, logs, moderation): a separate service
deploy/   docker-compose (Postgres, server slots a/b, monitor), Dockerfiles, install scripts, ci/ (the runner)
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

## Ship

Production runs in Docker on `127.0.0.1:7700` (deploy/docker-compose.yml), published through a Cloudflare tunnel, on
the home server. **Pushing to `master` is the release:** a runner on that box (`deploy/ci/linkord-ci`, ticked by cron
every minute) fetches master, fast-forwards its checkout and ships what changed since each part last went out:

| Changed | Runner does |
| --- | --- |
| anything but docs | full test suite (failed browser steps run once more, alone; the monitor's tests only when it changed), unit tests, lint, `cargo test`; Android: `core` tests and a release compile the publish reuses |
| `server/`, the web client (`app/` minus the desktop shell), the image's deploy files | `deploy/install-service.sh`: zero-downtime swap between slots a/b |
| `monitor/` | `deploy/install-monitor.sh` |
| `app/` | desktop release: Windows + Linux, signed, on the update feed (apps see it at once) |
| `android/`, `pt-BR.ts` | Android release (signed APK on the update feed) |

Patch notes are written from the commit subjects (`feat`, `fix` and `perf`, without the type and scope; see
`deploy/ci/notes.mjs`), so write subjects people can read. Version bumps come back to master as one
`chore(release): ...` commit: `git pull --rebase` before your next push. Order is CLAUDE.md's: tests, server, clients.

```bash
deploy/ci/ship.sh                                   # git push, then follow the run on the box until it's done
ssh linkord-box '~/.local/bin/linkord-ci status'    # where each part stands, the last runs
ssh linkord-box '~/.local/bin/linkord-ci log -f'    # the current run
ssh linkord-box '~/.local/bin/linkord-ci retry'     # run a failed commit again (failures wait for the next push otherwise)
```

Each push also shows up in GitLab (Build -> Pipelines): `.gitlab-ci.yml` runs one job on the box that wakes the runner
and streams its log there, red when a step failed. The box's gitlab-runner is set up by
`deploy/ci/install-gitlab-runner.sh glrt-...` (a project runner tagged `linkord-box`; no sudo, kept up by cron).

Set up once on the box: `deploy/ci/install.sh` (a crontab line, no sudo; `--remove` takes it out). It needs Docker
(our BuildKit builder), Rust, Bun, Node, a JDK 21 in `/mnt/hdd/linkord/jdk-21`, the Android SDK in `/mnt/hdd/linkord/android-sdk` and the signing keys
in `~/.config/linkord/`. The scripts it runs still work by hand on the box (`deploy/install-service.sh`,
`app/publish-windows.sh "notes"`, `android/publish.sh "notes"`, ...).

The dashboard (`deploy/install-monitor.sh`; the first run creates monitor/.env with a random password) listens on
loopback: `ssh -L 7710:127.0.0.1:7710 <user>@<server>`, then open http://localhost:7710. Availability, performance,
network, storage, database, logs and diagnostics, plus every server, account and uploaded file for moderation. Only
expose it on purpose: it can see everything people upload, direct messages included.

**Signing keys:** `~/.config/linkord/updater.key` (desktop) and `android-release.jks` + `.properties` (Android),
outside the repo. Back them up: without them, installed apps can't verify updates and everyone has to reinstall.

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
