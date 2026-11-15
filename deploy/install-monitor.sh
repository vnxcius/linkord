#!/usr/bin/env bash
# Builds the monitor + its dashboard into an image and (re)starts its container (docker-compose.yml `monitor`),
# separate from the app's. The first run creates monitor/.env with a random password.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$root/monitor/.env" ]; then
  password=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
  sed "s|^LINKORD_MONITOR_PASSWORD=.*|LINKORD_MONITOR_PASSWORD=$password|" "$root/monitor/.env.example" >"$root/monitor/.env"
  chmod 600 "$root/monitor/.env"
  echo "Created monitor/.env with a random password: see LINKORD_MONITOR_PASSWORD in there."
fi
mkdir -p "$root/monitor/data"

docker buildx build --builder "$("$root/deploy/builder.sh")" --load -f "$root/deploy/monitor.Dockerfile" -t linkord-monitor:latest "$root"

docker compose -f "$root/deploy/docker-compose.yml" --profile monitor up -d --no-deps --force-recreate monitor
docker image prune -f >/dev/null || true
bind=$(grep -E '^LINKORD_MONITOR_BIND=' "$root/monitor/.env" | cut -d= -f2 || true)
echo "Monitor on http://${bind:-127.0.0.1:7710} (logs: docker logs -f linkord-monitor)"
echo "From another machine: ssh -L 7710:127.0.0.1:7710 $USER@$(hostname -I 2>/dev/null | cut -d' ' -f1), then open http://localhost:7710"
