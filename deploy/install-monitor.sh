#!/usr/bin/env bash
# Builds the monitor + its dashboard and (re)starts it as a systemd user service, separate from the app's.
# The first run creates monitor/.env with a random password.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

if [ ! -f "$root/monitor/.env" ]; then
  password=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
  sed "s|^LINKORD_MONITOR_PASSWORD=.*|LINKORD_MONITOR_PASSWORD=$password|" "$root/monitor/.env.example" >"$root/monitor/.env"
  chmod 600 "$root/monitor/.env"
  echo "Created monitor/.env with a random password: see LINKORD_MONITOR_PASSWORD in there."
fi

(cd "$root/monitor/web" && bun install --frozen-lockfile && bun run build)
(cd "$root/monitor" && cargo build --release)

mkdir -p "$HOME/.config/systemd/user"
cp "$root/deploy/linkord-monitor.service" "$HOME/.config/systemd/user/linkord-monitor.service"
systemctl --user daemon-reload
systemctl --user enable --now linkord-monitor.service
systemctl --user restart linkord-monitor.service
systemctl --user --no-pager status linkord-monitor.service | head -5
bind=$(grep -E '^LINKORD_MONITOR_BIND=' "$root/monitor/.env" | cut -d= -f2)
echo "Monitor on http://${bind:-127.0.0.1:7710}"
echo "From another machine: ssh -L 7710:127.0.0.1:7710 $USER@$(hostname -I 2>/dev/null | cut -d' ' -f1), then open http://localhost:7710"
