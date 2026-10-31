#!/usr/bin/env bash
# Runs the API and UI test suites against a throwaway server instance (port 7701, database
# linkord_test, dev login on). Production is never touched.
#   tests/run-local.sh              everything (do this before deploying)
#   tests/run-local.sh --api        API tests only (~10 s)
#   tests/run-local.sh --ui [regex] browser steps matching regex (plus setup), stopping at the first
#                                   failure with 5 s waits; screenshots of failures go to $SHOTS if set
set -euo pipefail
mode=all
only=""
case "${1:-}" in
  --api) mode=api ;;
  --ui) mode=ui; only="${2:-}" ;;
esac
root="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
pg_pass=$(grep POSTGRES_PASSWORD "$root/deploy/.env" | cut -d= -f2)
data=$(mktemp -d)
# A copy of the default nameplates, so tests can add files without touching server/nameplates.
cp -r "$root/server/nameplates" "$data/nameplates"

docker exec linkord-postgres-1 createdb -U linkord linkord_test 2>/dev/null || true
[[ $mode == api ]] || (cd "$root/app" && bun run build >/dev/null)
(cd "$root/server" && cargo build -q)
(cd "$root/tests" && [ -d node_modules ] || npm ci --silent)

node "$root/tests/spotify-mock.mjs" 7702 &
spotify_mock=$!
cd "$root/server"
SPOTIFY_CLIENT_ID=test-client SPOTIFY_CLIENT_SECRET=test-secret SPOTIFY_POLL_MS=500 \
  SPOTIFY_ACCOUNTS_URL=http://localhost:7702 SPOTIFY_API_URL=http://localhost:7702 LINKORD_DETECTABLE_URL=http://localhost:7702/detectable \
  LINKORD_BIND=127.0.0.1:7701 LINKORD_PUBLIC_URL=http://localhost:7701 \
  LINKORD_DIRECT_BIND=127.0.0.1:7703 LINKORD_DIRECT_HOST=localhost LINKORD_DIRECT_TLS=off \
  DATABASE_URL="postgres://linkord:$pg_pass@127.0.0.1:5433/linkord_test" \
  LINKORD_YTDLP="$root/tests/ytdlp-mock.sh" LINKORD_NAMEPLATES_DIR="$data/nameplates" LINKORD_DATA_DIR="$data" LINKORD_DEV_LOGIN=true LINKORD_ADMINS=logadmin DISCORD_CLIENT_ID= DISCORD_CLIENT_SECRET= \
  ./target/debug/linkord-server >"$data/server.log" 2>&1 &
server=$!
trap 'kill $server $spotify_mock 2>/dev/null; rm -rf "$data"' EXIT
for _ in $(seq 1 40); do curl -sf localhost:7701/api/health >/dev/null && break; sleep 0.5; done

cd "$root/tests"
export LINKORD_TEST_URL=http://localhost:7701 LINKORD_TEST_DATA_DIR="$data"
export CHROMIUM="${CHROMIUM:-$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | tail -1)}"
[[ $mode == ui ]] || node --test --test-timeout=20000 api.test.mjs
if [[ $mode == ui ]]; then
  E2E_ONLY="$only" E2E_FAILFAST=1 E2E_TIMEOUT=5000 node ui.e2e.mjs "${SHOTS:-}"
elif [[ $mode == all ]]; then
  node ui.e2e.mjs "${SHOTS:-}"
fi
