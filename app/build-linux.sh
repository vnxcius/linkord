#!/usr/bin/env bash
# Builds the Linux packages (.deb and .rpm) into app/out/.
set -euo pipefail
cd "$(dirname "$0")"
server="${LINKORD_SERVER_URL:-https://old.example.com}"
key="${LINKORD_UPDATER_KEY:-$HOME/.config/linkord/updater.key}"
[[ -f "$key" ]] || { echo "Updater signing key not found at $key"; exit 1; }
rm -f out/*.deb out/*.rpm

start=$SECONDS
DOCKER_BUILDKIT=1 docker build -f desktop-linux.Dockerfile \
  --build-arg VITE_DEFAULT_SERVER="$server" \
  --secret id=tauri_key,src="$key" \
  --output out .
echo "Built in $((SECONDS - start))s:"
ls -lh out/*.deb out/*.rpm
