# Linkord

Self-hosted Discord-style app (servers, channels, threads, DMs, voice, video, screen share, REC game recording) for a
small community. Discord OAuth is the only login. One server process (Rust) serves the API, the websocket gateway, the
voice/video relay and the web client from a single HTTPS origin; clients are a web app, a Windows/Linux desktop app
(Tauri) and a native Android app. Licensed GPL-3.0-only; third-party media is listed in NOTICE.md.

Instance-specific settings (addresses, machines, keys) never go in the repo: `server/.env`, `app/.env.production.local`,
`app/src-tauri/tauri.local.conf.json`, `android/local.properties`, `~/.config/linkord/` (README, "Your own instance").
A maintainer's private notes for agents go in `CLAUDE.local.md` (gitignored).

## Project rules (keep them)
- **Lightweight desktop:** Tauri 2, never Electron. Windows is the priority platform. No ffmpeg bundled in the app.
- **Zero-configuration voice:** no port forwarding, no TURN, no separate media server; everything over the app's HTTPS origin.
- **Games first:** nothing may cost games performance. No injection or hooks into games (anti-cheat), ever.
- **Brand "Margin" look:** neutral Aço grays (steel-tinted graphite), **Algodão** as the only accent (no hue: cotton
  #ece8e1 on dark, ink #22201d on light). No decorative gradients/glows/heavy shadows. Dark first, but light gets its
  own polished values, never inverted dark ones. Exceptions: speaking = green (`--speaking`), status colors only for
  status (always with a glyph and a word), badge metal colors, the Christmas theme.
  Accent tokens: `--brand`, `--brand-hi`, `--brand-rgb`, `--tint`, `--brand-soft`, `--on-brand`.
- **Layout:** three rounded panels on a darker desk; server tiles in a strip above the left panel (at most two rows, the
  rest behind a "+N" tile: Rail.tsx fitTwoRows, keep its constants in step with the CSS); channel list with numbered text
  channels (01, 02…), the chat "page" with a running head (No. 03 · Server) over a serif channel name, and the right
  "margin" (People / Pins / Search). Active tab/item marks are their own bar (3px+, rounded, clear of corners).
- **Type:** Instrument Serif for titles 20px+, Geist for text, Geist Mono for labels/times/counts. Avatars and server
  tiles are rounded squares (30%, `--avatar-radius`), notifications included.
- **Icons:** Heroicons outline via `I.*` in components/Icons.tsx (missing shapes drawn there on the 24px grid, 1.5
  stroke); pins tilted 40°. Emblem = the app icon: white wings around a gold Triforce on a graphite tile (design/,
  `node design/render.mjs`; the Triforce stays equilateral with joined pieces).
- **Sounds and media:** UI sounds, ringtones, Christmas music and soundboard clips are third-party (NOTICE.md), not GPL.
- **Emoji:** Twemoji everywhere, patched by `app/scripts/patch-twemoji.py` (Chromium drops FE0F before ligatures; it
  also writes the Android TTF with FE0F declared). Rerun it when bumping `twemoji-colr-font`.
- **UI stack (web/desktop):** SolidJS (not React). Tailwind v4 (no preflight) with shadcn token names on the CSS
  variables; shadcn-style components in `src/components/ui` (Kobalte + cva + `cn()`), older screens on classic CSS.
- **Every existing feature must survive restyles.**
- **Usernames** follow Discord's rules (2–32 chars, `a-z0-9_.`, no `..`), unique among live accounts; a taken one gets a
  stand-in and must be picked (Username.tsx).

## Conventions
- **Commits:** Conventional Commits, subject line only, lowercase English.
- **Releases = pushing to master** on an instance that runs the runner (deploy/ci, see Commands): it tests, deploys the
  server and publishes the clients that changed, in that order, with patch notes from the commit subjects, so write
  subjects people can read. It commits the version bumps as `chore(release): ...`: pull before pushing again, and never
  bump versions by hand. Keep the server backward compatible with the previous clients.
- **i18n:** UI text is English in code, wrapped in `t()` / `msg()` / `plural()`; every string needs a pt-BR entry in
  `app/src/lib/locales/pt-BR.ts` (`UI`; server errors in `SERVER`), shared by web, desktop and Android.
  `tests/i18n.test.mjs` fails on missing, unused or duplicate keys. Tone: informal "você", Discord-like pt-BR (Cargo,
  Tópico = thread, Assunto = topic). Dates via `dateLocale()`.
- **Logs never hold secrets or message contents:** ids as fields (logs::redact cuts them), never tokens or endpoints.
- **Never** enable `LINKORD_DEV_LOGIN` in production. Tests use their own instance.
- **Never edit an applied migration** (sqlx checksums them byte for byte; the repo is LF everywhere, check line endings
  first if one "was modified").
- Windows-only Rust is compile-checked on Linux but can't run there: say so when reporting.
- Message list (web): render the message objects themselves (wrapping re-renders every message, videos reload); no
  `content-visibility` on messages (breaks scroll-to-bottom). Lazy media in long lists (src only while on screen).
- Tooltips: any `data-tip` uses lib/tooltip.ts; don't add `[data-tip]::after` tooltips.
- Accounts are soft-deleted (`deleted_at`, `discord_id = 'deleted:<id>'`); only the monitor's People → "Delete for good"
  removes one entirely (users::purge through internal.rs: messages, files, 1:1 DMs, clips, owned servers if confirmed).

## Commands
- **Tests:** `tests/run-local.sh` (everything: throwaway server on :7701, DB `linkord_test`, dev login). While
  iterating: `--api`, `--monitor`, `--ui 'regex'` (`SHOTS=dir` saves failure screenshots), `--handover`.
  Unit tests: `cd tests && node --test echo.test.mjs video-links.test.mjs i18n.test.mjs games.test.mjs markdown.test.mjs
  brand-icons.test.mjs capture-match.test.mjs device.test.mjs league-events.test.mjs`; `cd server && cargo test`;
  `cd monitor && cargo test`. Known flaky UI step: "voice messages" (passes on rerun; the runner reruns only failed
  browser steps). `LINKORD_TEST_MONITOR=0` skips the monitor's part of the full suite.
- **Lint/format (app):** `cd app && bun run lint`, `bun run fmt` / `fmt:check` (oxlint/oxfmt).
- **Deploy server + web client:** `deploy/install-service.sh` (Docker image, zero-downtime swap between slots a/b; the
  live slot is in server/data/run/live; logs `docker logs -f linkord-server-<slot>`). Never `docker compose up` the
  server slots by hand. Monitor: `deploy/install-monitor.sh` (independent).
- **Ship:** `deploy/ci/ship.sh` = push master and follow the runner over ssh (`LINKORD_BOX` = the server's ssh host).
  On the server: `linkord-ci status`, `log [-f]`, `follow [sha]`, `retry` (a failed commit waits for the next push),
  `kick`. The runner (deploy/ci/linkord-ci, cron every minute, installed by deploy/ci/install.sh) picks targets by path
  (README "Ship"), refuses to touch a dirty or diverged checkout, and is a dry run anywhere but the host and checkout
  named in `~/.config/linkord/ci.env` (`LINKORD_CI_DRY=1` forces one; never test it with real steps elsewhere). State
  and logs: ~/.local/state/linkord-ci. It calls `app/publish-windows.sh` / `publish-linux.sh` / `android/publish.sh
  "notes"`, which also work by hand. Test installer: `app/build-windows.sh` → app/out (unsigned without the key).
- **Docker builds** go through linkord's own BuildKit builder (`deploy/builder.sh`, deploy/buildkitd.toml; `--recreate`
  applies config changes). Never plain `docker build` (the default builder drops caches → cold 5-minute builds).
- **Local dev:** Postgres via `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d postgres`
  (on 5433), `cd server && cargo run` (server/.env: dev login on), ffmpeg/ffprobe on the PATH. Desktop:
  `cd app && bun run desktop` ("Linkord Dev", com.linkord.app.dev, never auto-updates); run tests with a separate
  CARGO_TARGET_DIR while a dev server holds the exe. Tauri can't build natively without WebKitGTK; Windows builds on
  Linux go through app/desktop.Dockerfile. Seed data through the API with a token from
  `POST /api/auth/dev {"username":"<name>"}` (dev login only).

## Map
```
server/   Rust (axum, sqlx/Postgres). The spec for every client.
  api/*            REST (messages, guilds, roles, channels, invites, users, dms, updates, settings, templates...)
  gateway.rs       websocket events + session resume; in_use = active in the last 5 min (push rule)
  voice.rs         voice + media relay (two sockets per client), DM call ringing, AFK mover, voice seats with grace
  handover.rs      restarts without dropping anyone (see Restarts)
  push.rs, fcm.rs  Web Push + Android FCM (see Push); a quiet FCM "q" message takes a notification down when read elsewhere
  receipts.rs      DM ticks (sent/delivered/read; voice messages read once played; Message info times) and the read-receipts privacy switch (off both ways)
  perms.rs         Discord-style permissions (mirrored by app lib/perms.ts and Android core Store.kt)
  embeds.rs        link previews (SSRF-guarded), video_site in step with lib/video-links.ts
  music.rs         Kass, the music bot (/play YouTube/Spotify via yt-dlp → Opus kind 5)
  steve.rs         Steve, the Minecraft bot (account only; driven by an external panel over the internal listener)
  league.rs        League of Legends presence, widget, lobby invites (BR only, RIOT_API_KEY, art proxied)
  clips.rs         REC clip sharing (resumable uploads, public /clip/<slug> page, views)
  videos.rs        H.264 `playable.mp4` copies of videos WebView2/phones can't decode
  media.rs         every ffmpeg/ffprobe run (queue, limits, explicit -f)
  badges.rs        milestone ladders (mirrored in app lib/badges.ts) and singles
  watch.rs         watch together (YouTube/Twitch/Kick/clips), synced to the server clock
  crypt.rs         encryption at rest (message text, embeds, forwarded copies, notes); see Security rules
  soundboard.rs, snowball.rs, spotify.rs, activities.rs, previews.rs, stats.rs, logs.rs, internal.rs (monitor API),
  direct.rs (second listener with Let's Encrypt via DNS-01), android.rs (assetlinks.json)
app/      SolidJS + Vite web client; app/src-tauri = the Tauri shell
  src/lib/voice*.ts, voice-worklets.ts, echo-canceller.ts   voice/video client
  src/lib/rec*.ts, components/Rec*.tsx, src-tauri/src/rec/   REC
  src-tauri/src/capture/   native Windows capture (Desktop Duplication, Media Foundation H.264, WASAPI loopback)
  src-tauri/src/overlay.rs  in-game voice overlay;  keybinds.rs  global hooks (non-consuming)
monitor/  dashboard on :7710 (own login, own SQLite, read-only Postgres): see Monitor
android/  native Android app (Kotlin + Compose): see Android
deploy/   docker-compose.yml (Postgres, server slots a/b, monitor), Dockerfiles, install scripts, builder.sh, ci/
tests/    api.test.mjs, ui.e2e.mjs (Playwright), monitor.test.mjs, handover.test.mjs, unit tests
design/   the emblem's vectors
```

## How things work (the parts that bite)
**Voice/streaming.** Two websockets per call: `/api/voice/connect` (voice + JSON control) and `/api/voice/media` (video
+ stream audio); the server drops media older than 400 ms. Screen shares only go to viewers who clicked Watch.
v2 clients keep their seat 20 s after a drop and reconnect without tearing down. Windows capture uses DXGI Desktop
Duplication; Graphics Capture only as a fallback (while any WGC session lives, Windows draws the cursor in software
system-wide: lag in games). Stream audio: Windows 11 process loopback; Windows 10 captures the system mix and runs the
EchoCanceller (a faint residual echo remains; known). Mic noise suppression: RNNoise.

**Voice overlay.** Click-through layered window drawn on the CPU only when something changes, up only while a
fullscreen window is in front during a call, excluded from capture. Showing/hiding costs a frame, so never tie its
visibility to who's talking. Borderless windows only (exclusive fullscreen would need injection).

**Restarts.** `install-service.sh` starts the idle slot with LINKORD_TAKEOVER=1; it takes the running one's listening
sockets and in-memory state over data/run/handover.sock, then clients reconnect and resume (close 4100). Snapshot parts
are versioned JSON: new fields need defaults. SIGTERM alone saves data/run/snapshot.json for a start within 2 minutes.

**Push.** Web Push (VAPID key in data/push-vapid.key) and Android FCM share one rule set (push.rs): DMs, mentions,
role/@everyone mentions, replies and "All messages" channels; never for level "none", muted, Do Not Disturb, blocked
authors, or while the person uses Linkord elsewhere (gateway `active`/`away`, 5-minute window). Payloads are encrypted
for the device (RFC 8291), FCM only carries ciphertext in a data message (no collapse key, so every message arrives).
DM calls ring through push too; `call_end` takes the ringing notification down. FCM settings: LINKORD_FCM_CREDENTIALS /
LINKORD_FCM_CLIENT (files from your own Firebase project, never in the repo).

**Video.** WebView2 and phones can't decode HEVC/10-bit/ProRes/MKV, so videos.rs makes `playable.mp4` (players use it,
Download keeps the original; the "only the sound" notice says a copy is coming while `codec` is unset).

**Direct access.** server/src/direct.rs: LINKORD_DIRECT_BIND/HOST, Let's Encrypt via Cloudflare DNS-01,
PublicBase = the origin a request came in on (OAuth callbacks with the direct port must be registered). Clients fall
back to it when the main address is unreachable; its address is build config (VITE_DIRECT_SERVER,
`linkord.directServer`, the updater endpoints in tauri.local.conf.json).

**Security rules.** Desktop/Android sign-in = PKCE code exchange through a loopback/custom-scheme callback (never hand a
session to an id chosen in a link). Logout closes that session's sockets live. Markdown never expands inside an
attribute, then DOMPurify. Uploads served with nosniff + sandbox CSP; image names from the bytes. ffmpeg only through
media.rs. A route that takes files must be listed in security body_limit. Keep WEB_CSP frame-src in step with
PLAYER_ORIGINS. What people type is sealed at rest (crypt.rs, AES-256-GCM, key server/data/message.key, keep a backup
off the machine; the server refuses to start with a missing/wrong one): write it through `crypt::seal`/`seal_json`/
`Forwarded::sealed`, read it through `Sealed`/`SealedJson`, never match it in SQL (search filters text in Rust). Names
stay plain. Report vulnerabilities as SECURITY.md says, not in public issues.

**REC (desktop, Windows).** Opt-in (nothing records until turned on). One Desktop Duplication per monitor feeds both
streams and REC; REC stays on the GPU (video processor → hardware H.264), variable frame rate, 2 s GOP, fragmented-MP4
segments (rec/mp4.rs, our own muxer), clips remuxed without re-encoding (edit lists). Voice chat comes from the app's
own recording mix (so opted-out voices can be left out: users.rec_opt_out), never a loopback. Folder
%USERPROFILE%\Videos\Linkord (dev app: "Linkord Dev"). Caps: VODs 50 GB, clips 20 GB, stop below 5 GB free; server:
5 GB of shared clips per user, 1 GB per file. Overlay = a separate transparent WebView window, excluded from capture.

**League.** The desktop app reads the League client's local API (lockfile, LCU, Live Client Data) and reports
`league` with its playing activity; lobby invites go through Linkord (type-8 chat invite, auto-accept). Riot API: BR
only, personal key limits respected in league.rs slot(); art from Data Dragon first, CommunityDragon fallback, proxied
via /api/league/art.

**Admins** (LINKORD_ADMINS in server/.env: Discord usernames/ids, never Linkord usernames) can change Kass's picture.

**Christmas** (Nov 1–Jan 6): theme (evergreen layers, decorations allowed), snow, hats, Santa, countdown + fireworks,
music (desktop streams it from the server), festive app icon swap, greeting once per season. Decoration clicks are
silent on purpose.

## Monitor (monitor/)
Separate service and container at low priority, so it works when the app is down and never gets in its way. Own
password login (monitor/.env), own SQLite history, at most 3 read-only Postgres connections, reads only the shared
settings from server/.env (never the app's secrets), reads logs/uploads straight off disk; anything that changes app data
goes through the server's internal.rs. Moderation never shows message text. Charts: one y axis, table view, status colors
with glyph + word. Reach it by SSH tunnel/LAN; never publish it.

## Android (android/)
Native Kotlin + Jetpack Compose (no WebView for the app; only site players and watch together use one). Sideloaded APK
with its own updater; no Play Store. Modules: `core` (models, REST, gateway, store, markdown, i18n, permissions, video
links), `designsystem` (tokens, fonts, generated icons, motion, Twemoji), `voice` (libopus via NDK, voice/media sockets,
MediaCodec video), `app` (screens, services, notifications, updater).
- **Build:** a full JDK 21 in JAVA_HOME, `cd android && ./gradlew ...`. On a phone over adb:
  `adb reverse tcp:7700 tcp:7700` and `./gradlew :app:installDebug -Plinkord.devServer=http://127.0.0.1:7700` (the
  address is baked in; Android 17's local network protection blocks LAN addresses). Dev app = com.linkord.app.dev,
  release = com.linkord.app. An instance's direct/former addresses come from android/local.properties.
- **Tests:** `./gradlew :core:test :app:testDebugUnitTest` (Robolectric screens render to app/build/screens). Logic with
  tests lives in `core` (plain JVM): the runner only runs `:core:test` plus a release compile; screenshots stay local.
  Generators: `node android/scripts/gen-icons.mjs` after changing Icons.tsx or brand-icons.ts; strings, badges, sounds and
  the emoji list (app/src/lib/emoji-list.json) come from the web client at build time.
- **Background rules (Android 17):** a cached app's network is blocked within seconds, and a force-stopped app gets no
  FCM. So: notifications come from FCM (the woken process has ~10 s of network), the gateway resumes on return
  (Gateway.wake, quietly), and nothing should rely on sockets staying open in the background.
- **Notifications:** one per conversation (MessagingStyle, last 8, sender pictures in the avatar shape), Reply and
  Mark as read work from a closed app (NotificationActions); DM calls use CallStyle with Answer/Decline and a full-screen
  intent; the app rings itself only while in front.
- **Chat parity:** everything the web chat draws, the phone draws too (inline video/audio/text files, video-site
  players, invite cards, clip cards, lobby invites, bot cards). Site players load from the server's HTTPS origin
  (YouTube refuses http pages). Only one player at a time.
- **Release key:** a keystore outside the repo (`~/.config/linkord/android-release.jks` + `.properties`); losing it
  means everyone reinstalls. Its SHA-256 goes in LINKORD_ANDROID_CERTS (assetlinks.json, App Links).
