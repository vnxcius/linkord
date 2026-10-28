# syntax=docker/dockerfile:1
# Windows installer, cross-compiled on Linux with cargo-xwin. Use ./build-windows.sh rather than calling this directly.
# Cache mounts keep crates, compiled dependencies, the MSVC SDK and the bun cache between builds.

# trixie: Tauri's installer script needs NSIS >= 3.09 (bookworm ships 3.08)
FROM rust:1-trixie AS base
# libayatana-appindicator: the Tauri CLI checks for it whenever the tray feature is on, even for Windows targets.
RUN apt-get update && apt-get install -y --no-install-recommends nsis lld llvm clang libayatana-appindicator3-dev \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g bun@1
RUN rustup target add x86_64-pc-windows-msvc && cargo install --locked cargo-xwin

FROM base AS build
ARG VITE_DEFAULT_SERVER=""
# fast: no LTO, parallel codegen, incremental, for quick test builds. release: smallest/fastest binary.
ARG PROFILE=fast
ENV VITE_DEFAULT_SERVER=${VITE_DEFAULT_SERVER} CI=true
WORKDIR /src
COPY package.json bun.lock ./
RUN --mount=type=cache,id=linkord-bun,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY . .
# The updater signing key comes in as a build secret so it never lands in an image layer.
RUN --mount=type=secret,id=tauri_key,required=true \
    --mount=type=cache,id=linkord-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=linkord-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=linkord-xwin,target=/root/.cache/cargo-xwin \
    --mount=type=cache,id=linkord-target-win,target=/src/src-tauri/target \
    export TAURI_SIGNING_PRIVATE_KEY="$(cat /run/secrets/tauri_key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
    && if [ "$PROFILE" = fast ]; then \
      export CARGO_PROFILE_RELEASE_LTO=off CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
             CARGO_PROFILE_RELEASE_INCREMENTAL=true CARGO_PROFILE_RELEASE_OPT_LEVEL=1; \
    fi \
    && bun tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis \
    && mkdir -p /out && cp src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe* /out/

FROM scratch
COPY --from=build /out/ /
