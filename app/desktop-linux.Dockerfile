# syntax=docker/dockerfile:1
# Linux packages (.deb for Debian/Ubuntu, .rpm for Fedora). Use ./build-linux.sh rather than calling this directly.
# Native capture and global keybinds are Windows-only; on Linux the app uses the browser fallbacks.

FROM rust:1-trixie AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev file \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g bun@1

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
    && bun tauri build --bundles deb,rpm \
    && mkdir -p /out && cp src-tauri/target/release/bundle/deb/*.deb src-tauri/target/release/bundle/rpm/*.rpm /out/

FROM scratch
COPY --from=build /out/ /
