#!/usr/bin/env bash
# Builds the Windows installer into app/out/. On Windows (Git Bash) it builds natively; on Linux it
# cross-compiles in Docker (desktop.Dockerfile).
#   ./build-windows.sh            quick test build (cached, incremental)
#   ./build-windows.sh --release  fully optimized build for sharing
# Without the updater signing key the installer is built unsigned: fine to install and test, not to publish.
set -euo pipefail
cd "$(dirname "$0")"
profile=fast
[[ "${1:-}" == "--release" ]] && profile=release
server="${LINKORD_SERVER_URL:-https://old.example.com}"
key="${LINKORD_UPDATER_KEY:-$HOME/.config/linkord/updater.key}"
signed=true
if [[ ! -f "$key" ]]; then
  [[ -n "${LINKORD_REQUIRE_SIGNING:-}" ]] && { echo "Updater signing key not found at $key"; exit 1; }
  echo "Updater signing key not found at $key: building an unsigned test installer (not publishable)."
  signed=false
fi
mkdir -p out
rm -f out/*-setup.exe out/*-setup.exe.sig

start=$SECONDS
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    [[ -d node_modules ]] || bun install --frozen-lockfile
    rm -rf src-tauri/target/release/bundle/nsis
    args=(--bundles nsis)
    if $signed; then
      export TAURI_SIGNING_PRIVATE_KEY="$(cat "$key")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
    else
      args+=(--config '{"bundle":{"createUpdaterArtifacts":false}}')
    fi
    if [[ $profile == fast ]]; then
      export CARGO_PROFILE_RELEASE_LTO=off CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
        CARGO_PROFILE_RELEASE_INCREMENTAL=true CARGO_PROFILE_RELEASE_OPT_LEVEL=1
    fi
    VITE_DEFAULT_SERVER="$server" bun tauri build "${args[@]}"
    cp src-tauri/target/release/bundle/nsis/*-setup.exe* out/
    ;;
  *)
    $signed || { echo "The Docker build needs the signing key (bun tauri signer generate --ci -w $key)"; exit 1; }
    # Our own builder: the default one throws the caches away after 48 h (deploy/buildkitd.toml).
    docker buildx build --builder "$(../deploy/builder.sh)" -f desktop.Dockerfile \
      --build-arg PROFILE="$profile" \
      --build-arg VITE_DEFAULT_SERVER="$server" \
      --secret id=tauri_key,src="$key" \
      --output out .
    ;;
esac
echo "Built in $((SECONDS - start))s ($profile):"
ls -lh out/*-setup.exe*
