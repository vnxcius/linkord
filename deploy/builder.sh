#!/usr/bin/env bash
# Prints the name of pottira's own BuildKit builder ("pottira"), creating it first if it doesn't exist. Every Docker
# build of the project goes through it (app/build-windows.sh, app/build-linux.sh, deploy/install-*.sh), so the build
# caches follow deploy/buildkitd.toml instead of the default builder's 48 h / 2.83 GiB limit for cache mounts.
#   deploy/builder.sh              ensure it exists, print its name
#   deploy/builder.sh --recreate   apply a changed buildkitd.toml (keeps the caches)
# The builder is a container (buildx_buildkit_pottira0) with its caches in a Docker volume; buildx starts it when a
# build needs it.
set -euo pipefail
name=pottira
dir="$(cd "$(dirname "$0")" && pwd)"
config="$dir/buildkitd.toml"
# Git Bash on Windows: docker is a native program.
case "$(uname -s)" in MINGW* | MSYS* | CYGWIN*) config=$(cygpath -m "$config") ;; esac

if [[ "${1:-}" == "--recreate" ]]; then
  docker buildx rm --keep-state "$name" >&2 2>/dev/null || true
fi
if ! docker buildx inspect "$name" >/dev/null 2>&1; then
  docker buildx create --name "$name" --driver docker-container --driver-opt image=moby/buildkit:v0.34.2 \
    --buildkitd-config "$config" --bootstrap >&2
fi
echo "$name"
