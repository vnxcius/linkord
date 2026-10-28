#!/usr/bin/env bash
# Builds the server + web client and (re)starts linkord as a systemd user service.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

(cd "$root/app" && bun install --frozen-lockfile && bun run build)
(cd "$root/server" && cargo build --release)

mkdir -p "$HOME/.config/systemd/user"
cp "$root/deploy/linkord.service" "$HOME/.config/systemd/user/linkord.service"
systemctl --user daemon-reload
systemctl --user enable --now linkord.service
systemctl --user restart linkord.service
systemctl --user --no-pager status linkord.service | head -5
