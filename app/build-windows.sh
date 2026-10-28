#!/usr/bin/env bash
# Builds the Windows installer into app/out/.
#   ./build-windows.sh            quick test build (cached, incremental)
#   ./build-windows.sh --release  fully optimized build for sharing
set -euo pipefail
cd "$(dirname "$0")"
profile=fast
[[ "${1:-}" == "--release" ]] && profile=release
server="${LINKORD_SERVER_URL:-https://old.example.com}"
key="${LINKORD_UPDATER_KEY:-$HOME/.config/linkord/updater.key}"
[[ -f "$key" ]] || { echo "Updater signing key not found at $key (generate with: bun tauri signer generate --ci -w $key)"; exit 1; }
rm -f out/*-setup.exe out/*-setup.exe.sig

start=$SECONDS
DOCKER_BUILDKIT=1 docker build -f desktop.Dockerfile \
  --build-arg PROFILE="$profile" \
  --build-arg VITE_DEFAULT_SERVER="$server" \
  --secret id=tauri_key,src="$key" \
  --output out .
echo "Built in $((SECONDS - start))s ($profile):"
ls -lh out/*-setup.exe*
