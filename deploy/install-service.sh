#!/usr/bin/env bash
# Deploys the server + web client without dropping anyone. Builds the image, starts it in the idle slot (a or b of
# docker-compose.yml), which takes over from the running one (server/src/handover.rs: the same listening sockets,
# calls, gateway sessions, watch together and Kass's queue), then stops the old slot. Clients reconnect within a
# fraction of a second and resume; nobody leaves the call.
# If the new slot doesn't take over, the old one keeps serving and the deploy fails.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
compose() { docker compose -f "$root/deploy/docker-compose.yml" --profile server "$@"; }
live_file="$root/server/data/run/live"

running() { [ "$(docker inspect -f '{{.State.Running}}' "linkord-server-$1" 2>/dev/null)" = true ]; }
live_slot() { sed -n 's/.*"slot":"\([ab]\)".*/\1/p' "$live_file" 2>/dev/null || true; }

# Our own builder keeps the cargo caches (deploy/buildkitd.toml); --load hands the image to Docker.
docker buildx build --builder "$("$root/deploy/builder.sh")" --load -f "$root/deploy/server.Dockerfile" -t linkord-server:latest "$root"

old=$(live_slot)
if [ -n "$old" ] && ! running "$old"; then old=""; fi
if [ -z "$old" ]; then
  for s in a b; do if running "$s"; then old=$s; fi; done
fi
new=a
if [ "$old" = a ]; then new=b; fi
# Nothing running: an old marker must not pass for the new slot.
if [ -z "$old" ]; then rm -f "$live_file"; fi

compose up -d --no-deps --force-recreate "server-$new"
echo "Waiting for slot $new to take over${old:+ from slot $old}..."
for _ in $(seq 1 240); do
  if [ "$(live_slot)" = "$new" ]; then break; fi
  sleep 0.5
done
if [ "$(live_slot)" != "$new" ]; then
  echo "Slot $new didn't take over${old:+; slot $old keeps serving}. Its log:"
  docker logs --tail 60 "linkord-server-$new" 2>&1 || true
  compose stop -t 10 "server-$new"
  exit 1
fi
if [ -n "$old" ]; then
  # It finishes the requests it was serving (up to a minute), then exits.
  compose stop -t 75 "server-$old"
fi
docker image prune -f >/dev/null || true
echo "Serving from slot $new: $(cat "$live_file")"
echo "Logs: docker logs -f linkord-server-$new"
