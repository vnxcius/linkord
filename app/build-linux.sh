#!/usr/bin/env bash
# Builds the Linux packages (.deb and .rpm) into app/out/.
set -euo pipefail
cd "$(dirname "$0")"
server="${POTTIRA_SERVER_URL:-https://pottira.com}"
key="${POTTIRA_UPDATER_KEY:-$HOME/.config/pottira/updater.key}"
[[ -f "$key" ]] || { echo "Updater signing key not found at $key"; exit 1; }
rm -f out/*.deb out/*.rpm

start=$SECONDS
# Our own builder: the default one throws the caches away after 48 h (deploy/buildkitd.toml).
docker buildx build --builder "$(../deploy/builder.sh)" -f desktop-linux.Dockerfile \
  --build-arg VITE_DEFAULT_SERVER="$server" \
  --secret id=tauri_key,src="$key" \
  --output out .
echo "Built in $((SECONDS - start))s:"
ls -lh out/*.deb out/*.rpm
