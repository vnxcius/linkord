# syntax=docker/dockerfile:1.7
# Linux packages (.deb for Debian/Ubuntu, .rpm for Fedora). Use ./build-linux.sh rather than calling this directly.
# Native capture and global keybinds are Windows-only; on Linux the app uses the browser fallbacks.
# Base images are pinned by digest (a tag can be moved to other contents): bump tag and digest together, with
# `docker buildx imagetools inspect <image:tag>`.

FROM rust:1-trixie@sha256:1f65e0abcce9b449f9533df5994f2a62391059196c481a09b8e1b522dd6d75af AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev file \
    && rm -rf /var/lib/apt/lists/*
# Node (the Tauri CLI, tsc and vite run on it) and bun from their own pinned images, not a `curl | bash` installer.
COPY --from=node:24-trixie-slim@sha256:4d00acb4bcc42c454c4eb801526f7ad7f772ea3bd4fd168c5cc2e384abcbb9d4 /usr/local/bin/node /usr/local/bin/node
COPY --from=oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 /usr/local/bin/bun /usr/local/bin/bun

FROM base AS build
ARG VITE_DEFAULT_SERVER=""
ENV VITE_DEFAULT_SERVER=${VITE_DEFAULT_SERVER} CI=true
WORKDIR /src
COPY package.json bun.lock ./
RUN --mount=type=cache,id=linkord-bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY . .
RUN --mount=type=secret,id=tauri_key,required=true \
    --mount=type=cache,id=linkord-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=linkord-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=linkord-target-linux,target=/src/src-tauri/target \
    export TAURI_SIGNING_PRIVATE_KEY="$(cat /run/secrets/tauri_key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
    && bun tauri build --bundles deb,rpm $([ -f src-tauri/tauri.local.conf.json ] && echo --config src-tauri/tauri.local.conf.json) \
    && mkdir -p /out && cp src-tauri/target/release/bundle/deb/*.deb src-tauri/target/release/bundle/rpm/*.rpm /out/

FROM scratch
COPY --from=build /out/ /
