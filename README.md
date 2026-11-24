# Linkord

A self-hosted chat app in the spirit of Discord, made for a small community: servers, channels, threads, DMs, voice,
video, screen share and game recording, all from one server you run yourself. Login is Discord OAuth only.

- **Server:** Rust (axum, sqlx) + PostgreSQL. REST API, a websocket gateway, and a voice/video relay, all on one
  HTTPS origin, so voice needs no port forwarding, TURN or media server.
- **Client:** SolidJS + Vite (web), wrapped in a Tauri 2 desktop app (Windows first, Linux packages too) with
  native screen capture, an in-game voice overlay, REC game recording, global keybinds, tray and signed auto-updates.
- **Android:** a native Kotlin + Jetpack Compose app (`android/`), sideloaded with its own updater.
- **Monitor:** a separate dashboard for health, logs and moderation (`monitor/`).

It was built for one group of friends and runs at [linkord.app](https://linkord.app). It's shared as is: expect
choices made for that instance (pt-BR as the second language, League of Legends integration for Brazil, a Minecraft
bot hook) and rough edges for other setups.

```
server/   Rust backend (src/api REST, gateway.rs, voice.rs, migrations/)
app/      SolidJS client; app/src-tauri = desktop shell
android/  Android app (core, designsystem, voice, app modules)
monitor/  The dashboard (health, logs, moderation): a separate service
deploy/   docker-compose (Postgres, server slots a/b, monitor), Dockerfiles, install scripts, ci/ (the runner)
tests/    API, browser (Playwright) and unit tests
design/   the emblem's vectors
```

`CLAUDE.md` describes the architecture, conventions and the parts that bite in more depth.

## Prerequisites

Rust (stable), Node 20+, Bun, Docker. Desktop builds also run in Docker, so no Tauri toolchain is needed locally.
ffmpeg/ffprobe on the PATH (the server uses them for uploads). Android: a JDK 21 and the Android SDK.

## Develop

1. **Start Postgres** (listens on `127.0.0.1:5433`):
   ```bash
   cp deploy/.env.example deploy/.env        # set POSTGRES_PASSWORD
   docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d postgres
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
   cd android && ./gradlew :core:test :app:testDebugUnitTest
   ```
   New UI strings need a pt-BR entry in `app/src/lib/locales/pt-BR.ts` or `i18n.test.mjs` fails.
6. **Try the desktop app:** `cd app && bun run desktop` runs "Linkord Dev" against the local server, next to an
   installed Linkord. `app/build-windows.sh` builds a Windows installer into `app/out/` (cross-compiled in Docker on
   Linux, native on Windows; unsigned when the updater key is missing).
7. **Try the Android app** on a phone over USB: `adb reverse tcp:7700 tcp:7700`, then
   `cd android && ./gradlew :app:installDebug -Plinkord.devServer=http://127.0.0.1:7700`.

### On Windows

Also needs Visual Studio 2022 Build Tools (C++), WebView2, ffmpeg (`winget install Gyan.FFmpeg`) and, for the UI
tests, `cd tests && npx playwright-core install chromium`. Run the `.sh` scripts in Git Bash. Then, with Postgres and
the server running as above:

```powershell
cd app; bun run desktop      # "Linkord Dev": tauri dev against the local server, next to an installed Linkord
$env:VITE_DEFAULT_SERVER='https://your.instance'; bun run desktop   # the dev build against a real instance
cd app/src-tauri; cargo test # desktop shell unit tests (keybinds, colour conversion)
```

## Your own instance

The repo builds clients for linkord.app. To run your own, keep your settings out of the repo:

| Where | What |
| --- | --- |
| `server/.env` (from `server/.env.example`) | Everything the server needs: public URL, database, Discord/Spotify apps, admins, direct access, FCM |
| `deploy/.env` | The Postgres password for docker-compose |
| `app/.env.production.local` | `VITE_DIRECT_SERVER`, `VITE_FORMER_SERVERS` (see `app/.env.production`) |
| `app/src-tauri/tauri.local.conf.json` | Merged over `tauri.conf.json` by the desktop builds, e.g. your `plugins.updater.endpoints` |
| `android/local.properties` | `linkord.directServer`, `linkord.formerServers` |
| `~/.config/linkord/` | Signing keys (`updater.key`, `android-release.jks` + `.properties`) and the runner's `ci.env` |

`*.local*` files are gitignored. A fork should also change what identifies the reference instance: the default
server (`LINKORD_SERVER_URL` for the desktop build scripts, `DEFAULT_SERVER` in `android/app/build.gradle.kts`), the
updater public key and endpoints in `app/src-tauri/tauri.conf.json` (`bun tauri signer generate`), the app
identifiers (`com.linkord.app`), its own Firebase project for Android push, and the media listed in
[NOTICE.md](NOTICE.md), which isn't licensed for reuse.

### Production

The server runs in Docker on `127.0.0.1:7700` (`deploy/docker-compose.yml`); put it behind a TLS-terminating proxy or
tunnel (Caddy, a Cloudflare tunnel...). `deploy/install-service.sh` builds the image and swaps between two slots
(a/b) with no downtime: the new process takes over the old one's sockets and in-memory state, and clients reconnect
and resume. Docker builds go through `deploy/builder.sh` (a BuildKit builder that keeps its caches).

The dashboard (`deploy/install-monitor.sh`; the first run creates monitor/.env with a random password) listens on
loopback: `ssh -L 7710:127.0.0.1:7710 <user>@<server>`, then open http://localhost:7710. Availability, performance,
network, storage, database, logs and diagnostics, plus every server, account and uploaded file for moderation. Only
expose it on purpose: it can see everything people upload, direct messages included.

**Keys to back up off the machine:** `server/data/message.key` (messages are encrypted at rest with it; without it
they're unreadable), `~/.config/linkord/updater.key` (desktop) and `android-release.jks` + `.properties` (Android).
Without the signing keys, installed apps can't verify updates and everyone has to reinstall.

### Ship

Optionally, pushing to `master` can be the release: a runner on the server machine (`deploy/ci/linkord-ci`, ticked by
cron every minute) fetches master, fast-forwards its checkout and ships what changed since each part last went out:

| Changed | Runner does |
| --- | --- |
| anything but docs | full test suite (failed browser steps run once more, alone; the monitor's tests only when it changed), unit tests, lint, `cargo test`; Android: `core` tests and a release compile the publish reuses |
| `server/`, the web client (`app/` minus the desktop shell), the image's deploy files | `deploy/install-service.sh` |
| `monitor/` | `deploy/install-monitor.sh` |
| `app/` | desktop release: Windows + Linux, signed, on the update feed (apps see it at once) |
| `android/`, `pt-BR.ts` | Android release (signed APK on the update feed) |

Patch notes are written from the commit subjects (`feat`, `fix` and `perf`, without the type and scope; see
`deploy/ci/notes.mjs`). Version bumps come back to master as one `chore(release): ...` commit.

Set it up once on the server: `deploy/ci/install.sh` (a crontab line, no sudo; `--remove` takes it out), then
`~/.config/linkord/ci.env` with `LINKORD_CI_HOST=<the machine's hostname>` (and `ANDROID_HOME` / `JAVA_HOME` if
they're not the defaults). Without it every step is a dry run. It needs Docker, Rust, Bun, Node, a JDK 21, the
Android SDK and the signing keys. From a dev machine:

```bash
LINKORD_BOX=<ssh host> deploy/ci/ship.sh          # git push, then follow the run until it's done
ssh <ssh host> '~/.local/bin/linkord-ci status'   # where each part stands, the last runs (also: log -f, retry)
```

Each push also shows up on GitHub (Actions -> ship): `.github/workflows/ship.yml` runs one job on a self-hosted
runner on the server that wakes linkord-ci and streams its log there, red when a step failed. Set it up with
`deploy/ci/install-github-runner.sh` (no sudo, kept up by cron, `gh` logged in as a repository admin). Since the
repository is public, the runner is locked down: its job-start hook (`deploy/ci/runner-guard.sh`) fails every job that
isn't `ship.yml` from a push to master, so pull requests never run on the server, and the installer makes workflow
runs from external contributors wait for approval. If you fork Linkord, point your runner at your own repository.

The scripts it runs also work by hand (`deploy/install-service.sh`, `app/publish-windows.sh "notes"`,
`android/publish.sh "notes"`, ...).

### Configuration (`server/.env`)

The main settings; `server/.env.example` documents all of them.

| Variable | Purpose |
| --- | --- |
| `LINKORD_PUBLIC_URL` | Public https URL (OAuth redirects are built from it) |
| `DATABASE_URL` | Postgres connection string |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | Discord OAuth app |
| `LINKORD_DEV_LOGIN` | Passwordless test login. Keep `false` in production |
| `LINKORD_SIGNUP` | `closed` stops new accounts (existing ones still sign in) |
| `LINKORD_ADMINS` | Linkord user ids (comma-separated) that can change the bots' pictures; names are ignored |
| `LINKORD_UPLOAD_QUOTA_MB` | Upload space per user (default 2048) |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Optional Spotify connection (redirect `<public_url>/api/connections/spotify/callback`) |
| `LINKORD_DIRECT_BIND` / `LINKORD_DIRECT_HOST` / `CLOUDFLARE_API_TOKEN` | Optional second HTTPS listener that skips Cloudflare (Let's Encrypt via DNS-01) |
| `LINKORD_INTERNAL_BIND` | Loopback address the dashboard reads live numbers from (default `127.0.0.1:7711`, `off` to disable) |
| `LINKORD_FCM_CREDENTIALS` / `LINKORD_FCM_CLIENT` | Optional Android push through your Firebase project |

## Contributing

Issues and pull requests are welcome. Conventional Commit subjects (`feat:`, `fix:`, ...), one line, in English:
they become the patch notes. Every UI string goes through `t()` and needs a pt-BR translation. Run the tests above
before sending a change. Security problems: see [SECURITY.md](SECURITY.md).

## License

Linkord is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License,
version 3, as published by the Free Software Foundation. See [LICENSE](LICENSE).

Some media in this repository (UI sounds, ringtones, soundboard clips, the Triforce in the emblem) belongs to third
parties and is **not** covered by the GPL; [NOTICE.md](NOTICE.md) lists it along with the attributions for Twemoji,
the fonts and the icon sets.
