# Linkord

A self-hosted, Discord-style chat app for you and your friends: servers, text channels, threads, DMs, group DMs, voice, video and screen share. You sign in with your Discord account.

## Stack

| Piece | Tech | Why |
| --- | --- | --- |
| Server | Rust · axum · tokio · sqlx | Single small binary, low memory, handles thousands of websockets |
| Database | PostgreSQL 16 (Docker, port 5433) | Reliable, runs separately from the system Postgres |
| Realtime | WebSocket gateway (`/api/gateway`) with session resume | Server pushes `{s, t, d}` events; reconnects replay only what was missed |
| Voice/video | Opus (WASM) + WebCodecs VP8, relayed by the server over a websocket | Works anywhere the app loads. No ports, TURN or media server to configure |
| Client UI | SolidJS · Vite · TypeScript | Fine-grained reactivity, small bundle |
| Desktop | Tauri 2 | Uses the OS webview instead of bundling Chromium, so RAM use is a fraction of Electron's |

## Features

**Servers and roles**
- Roles and permissions, using Discord's permission model: admin, manage server, channels, roles, emoji, kick, nicknames, messages, threads, mention @everyone, connect, speak.
- Role hierarchy, role colors, and roles shown as separate groups in the member list.
- Invites with expiry, nicknames, custom emoji (static and animated), server icon.

**Chat**
- Markdown, @user, @role and @everyone/@here mentions, replies, edits (↑ edits your last message), reactions with custom emoji, attachments (drag-drop and paste).
- Link previews and GIF/image embeds, threads started from a message, pins.
- Search with `from:`, `has:image`, `has:file` and `has:link` filters; jump to any message and back to the present.
- Typing indicators, unread markers, mention badges, desktop notifications, and per-server or per-channel mutes.

**People**
- Friends: requests by username, plus pending and blocked lists.
- Blocking hides a person's messages and stops their DMs.
- DMs need a shared server or a friendship. Group DMs hold up to 10 friends.
- Profiles show roles, a bio and a banner.

**Voice**
- Join a channel by clicking it. Speaking indicators, mute and deafen, camera and screen share.
- Input and output device selection, and a voice-activity threshold (automatic, or manual with a live meter).
- Noise suppression and echo cancellation, push-to-talk with a release delay, per-user volume (right-click someone), join/leave sounds, and a "you're muted" hint.

**Desktop app (Windows)**
- Tray icon that shows a green ring while you speak and red when muted or deafened.
- Taskbar mention badge, close-to-tray, start with Windows.
- Global push-to-talk that also works in games without swallowing the key.
- Signed auto-updates.

**Server hardening**
- Rate limits on logins, messages, reactions, friend requests and search.
- Per-user upload quota (`LINKORD_UPLOAD_QUOTA_MB`, default 2048). Deleted attachments free their space.
- Link previews never reach private or local addresses.

Usernames follow Discord's rules: 2–32 characters, lowercase `a-z`, `0-9`, `_` and `.`, with no consecutive dots.

## Running it

```bash
# Postgres. Its password lives in deploy/.env (see .env.example)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d

# Build everything and run the server as a systemd user service
deploy/install-service.sh
sudo loginctl enable-linger $USER     # keep it running when you're logged out (once)
```

Re-run `deploy/install-service.sh` after pulling changes. It rebuilds and restarts the server. Logs: `journalctl --user -u linkord -f`.

Configuration lives in `server/.env` (see `server/.env.example`):

| Variable | Purpose |
| --- | --- |
| `LINKORD_PUBLIC_URL` | Public https URL. Discord's redirect is `<this>/api/auth/discord/callback` |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | From discord.com/developers → your app → OAuth2 |
| `LINKORD_DEV_LOGIN` | Passwordless test login. **Keep `false` in production** |
| `LINKORD_UPLOAD_QUOTA_MB` | Upload space per user (default 2048) |
| `GIPHY_API_KEY` | Optional. Enables GIF search; without it the picker shows your favorite GIFs |

The server listens on `127.0.0.1:7700` behind the Cloudflare tunnel. Voice needs nothing extra.

## Desktop releases

```bash
cd app
./build-windows.sh                  # quick test build -> app/out/ (about 20 s after the first build)
./publish-windows.sh "What changed" # bump version, optimized signed build, publish to the update feed
```

- **How updates reach people:** installed apps check `https://old.example.com/api/updates/...` every 30 minutes and show an "Update & restart" banner.
- **Releases:** the feed lives in `server/data/updates/`. Commit the version bump after publishing.
- **Signing key:** updates are signed with `~/.config/linkord/updater.key`, which is created once with `pnpm tauri signer generate`. Back it up. Without it, installed apps can't verify future updates and everyone would need to reinstall.
- **Windows setup:** the installer installs per-user. Windows SmartScreen warns because the build isn't code-signed: click *More info → Run anyway*.
- **CI:** `.github/workflows/desktop.yml` also builds installers on tag push.

## Tests

```bash
tests/run-local.sh   # throwaway server on :7701 with its own database; runs API + browser tests
```

- `tests/api.test.mjs` covers permissions, roles, threads, pins, search, emoji, friends, blocks, group DMs, settings, session resume, rate limits and the update feed.
- `tests/ui.e2e.mjs` drives two browser users through the real UI, including two-way voice.
- `cargo test` in `server/` covers parsing and safety checks.
- CI runs all of it on every push (`.github/workflows/test.yml`).

## Layout

```
server/        Rust backend: src/api/* REST, gateway.rs websocket, voice.rs voice/video relay,
               perms.rs, embeds.rs (link previews), ratelimit.rs
app/           SolidJS client + Tauri shell (app/src-tauri: tray, push-to-talk hook, updater)
deploy/        docker-compose (Postgres), systemd unit, install script
tests/         API and browser test suites
assets/        Original Linkord emblem (SVG)
```

## Later

- "Playing X" status from running games
- Nightly database backups

Branding note: the emblem, tray icons, sounds and theme are original works inspired by classic fantasy-adventure aesthetics. No Nintendo or Discord artwork is used.
