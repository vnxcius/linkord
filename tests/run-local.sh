#!/usr/bin/env bash
# Runs the API and UI test suites against a throwaway server instance (port 7701, database
# linkord_test, dev login on). Production is never touched.
#   tests/run-local.sh              everything (do this before deploying)
#   tests/run-local.sh --api        API tests only (~10 s)
#   tests/run-local.sh --ui [regex] browser steps matching regex (plus setup), stopping at the first
#                                   failure with 5 s waits; screenshots of failures go to $SHOTS if set
#   tests/run-local.sh --monitor    the monitor (monitor/) against the throwaway server; $SHOTS gets its screens
set -euo pipefail
mode=all
only=""
case "${1:-}" in
  --api) mode=api ;;
  --ui) mode=ui; only="${2:-}" ;;
  --monitor) mode=monitor ;;
esac
root="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
pg_pass=$(grep POSTGRES_PASSWORD "$root/deploy/.env" | cut -d= -f2)
command -v ffmpeg >/dev/null || { echo "ffmpeg isn't on the PATH (Windows: winget install Gyan.FFmpeg, then open a new terminal)"; exit 1; }
# Git Bash on Windows: the server and node are native programs, so hand them C:/... paths.
windows=false
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) windows=true ;; esac
native() { if $windows; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }
data=$(native "$(mktemp -d)")
# A copy of the default nameplates, so tests can add files without touching server/nameplates.
cp -r "$root/server/nameplates" "$data/nameplates"

docker exec linkord-postgres-1 createdb -U linkord linkord_test 2>/dev/null || true
[[ $mode == api ]] || (cd "$root/app" && bun run build >/dev/null)
if [[ $mode == all || $mode == monitor ]]; then
  (cd "$root/monitor/web" && bun install --frozen-lockfile >/dev/null && bun run build >/dev/null)
  (cd "$root/monitor" && cargo build -q)
fi
# CARGO_TARGET_DIR elsewhere lets the tests build while a dev server runs from server/target (Windows locks it).
(cd "$root/server" && cargo build -q)
(cd "$root/tests" && [ -d node_modules ] || npm ci --silent)

node "$root/tests/spotify-mock.mjs" 7702 &
spotify_mock=$!
if $windows; then
  # Windows can't run the .sh mock directly; LINKORD_YTDLP_ARGS go before yt-dlp's own arguments.
  ytdlp=$(native "$(command -v bash)") ytdlp_args=$(native "$root/tests/ytdlp-mock.sh")
  chromium=$(ls -d "$(native "$LOCALAPPDATA")"/ms-playwright/chromium-*/chrome-win64/chrome.exe 2>/dev/null | tail -1)
else
  ytdlp="$root/tests/ytdlp-mock.sh" ytdlp_args=
  chromium=$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | tail -1)
fi
cd "$root/server"
SPOTIFY_CLIENT_ID=test-client SPOTIFY_CLIENT_SECRET=test-secret SPOTIFY_POLL_MS=500 \
  SPOTIFY_ACCOUNTS_URL=http://localhost:7702 SPOTIFY_API_URL=http://localhost:7702 LINKORD_DETECTABLE_URL=http://localhost:7702/detectable \
  LINKORD_BIND=127.0.0.1:7701 LINKORD_PUBLIC_URL=http://localhost:7701 LINKORD_INTERNAL_BIND=127.0.0.1:7704 \
  LINKORD_DIRECT_BIND=127.0.0.1:7703 LINKORD_DIRECT_HOST=localhost LINKORD_DIRECT_TLS=off \
  DATABASE_URL="postgres://linkord:$pg_pass@127.0.0.1:5433/linkord_test" \
  LINKORD_YTDLP="$ytdlp" LINKORD_YTDLP_ARGS="$ytdlp_args" LINKORD_NAMEPLATES_DIR="$data/nameplates" LINKORD_DATA_DIR="$data" LINKORD_DEV_LOGIN=true LINKORD_GAME_INFO=off LINKORD_ADMINS=logadmin DISCORD_CLIENT_ID= DISCORD_CLIENT_SECRET= \
  "${CARGO_TARGET_DIR:-target}/debug/linkord-server" >"$data/server.log" 2>&1 &
server=$!
monitor=
trap 'kill $server $spotify_mock $monitor 2>/dev/null; sleep 0.3; rm -rf "$data"' EXIT
for _ in $(seq 1 40); do curl -sf localhost:7701/api/health >/dev/null && break; sleep 0.5; done
if [[ $mode == all || $mode == monitor ]]; then
  # Its own process, data and port. The same variables server/.env gives it in production.
  # No subshell: on Windows killing one would leave the program running, holding its files.
  cd "$root/monitor"
  LINKORD_MONITOR_BIND=127.0.0.1:7705 LINKORD_MONITOR_PASSWORD=monitor-test-password LINKORD_MONITOR_DATA_DIR="$data/monitor" \
    LINKORD_MONITOR_SERVER_DIR="$data/no-server-env" LINKORD_MONITOR_PROBE_INTERNET=off \
    LINKORD_BIND=127.0.0.1:7701 LINKORD_PUBLIC_URL=http://localhost:7701 LINKORD_INTERNAL_BIND=127.0.0.1:7704 \
    DATABASE_URL="postgres://linkord:$pg_pass@127.0.0.1:5433/linkord_test" LINKORD_DATA_DIR="$data" \
    LINKORD_NAMEPLATES_DIR="$data/nameplates" \
    "${CARGO_TARGET_DIR:-target}/debug/linkord-monitor" >"$data/monitor.log" 2>&1 &
  monitor=$!
  for _ in $(seq 1 40); do curl -sf localhost:7705/api/session >/dev/null && break; sleep 0.5; done
fi

cd "$root/tests"
export LINKORD_TEST_URL=http://localhost:7701 LINKORD_TEST_DATA_DIR="$data"
# Chromium for the UI tests: cd tests && npx playwright-core install chromium
export CHROMIUM="${CHROMIUM:-$chromium}"
[[ $mode == ui || $mode == monitor ]] || node --test --test-timeout=20000 api.test.mjs
if [[ $mode == all || $mode == monitor ]]; then
  MONITOR_TEST_URL=http://localhost:7705 LINKORD_INTERNAL_TEST_URL=http://127.0.0.1:7704 SHOTS="${SHOTS:-}" \
    node --test --test-timeout=120000 monitor.test.mjs || { cat "$data/monitor.log"; exit 1; }
fi
if [[ $mode == monitor ]]; then
  :
elif [[ $mode == ui ]]; then
  E2E_ONLY="$only" E2E_FAILFAST=1 E2E_TIMEOUT=5000 node ui.e2e.mjs "${SHOTS:-}"
elif [[ $mode == all ]]; then
  node ui.e2e.mjs "${SHOTS:-}"
fi
