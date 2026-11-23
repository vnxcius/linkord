# syntax=docker/dockerfile:1.7
# The linkord server image: the server, the web client it serves, and what it runs (ffmpeg; Python and Node for
# yt-dlp). Built from the repository root by deploy/install-service.sh:
#   docker buildx build --builder "$(deploy/builder.sh)" --load -f deploy/server.Dockerfile -t linkord-server .
# Settings, data, the soundboard and nameplates stay on the host (bind mounts in docker-compose.yml).
# Build caches (cargo registry and target, bun) live in BuildKit cache mounts, so a deploy only rebuilds what changed.

FROM oven/bun:1.4.2 AS web
WORKDIR /src/app
COPY app/package.json app/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY app/ ./
RUN bun run build

FROM rust:1.99-trixie AS server
WORKDIR /src/server
COPY server/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/server/target \
    cargo build --release --locked && cp target/release/linkord-server /linkord-server

# Only its binary: yt-dlp solves YouTube's JavaScript with it (LINKORD_YTDLP_ARGS="--js-runtimes node").
FROM node:24-trixie-slim AS node

FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=server /linkord-server /usr/local/bin/linkord-server
COPY --from=web /src/app/dist /linkord/app/dist
# The server's relative paths (./data, ../app/dist, ./soundboard, ./nameplates, .env) work from here, as on the host.
WORKDIR /linkord/server
# The host user (uid 1000): files in the bind-mounted data folder keep their owner.
USER 1000:1000
ENV RUST_LOG=linkord_server=info HOME=/tmp
ENTRYPOINT ["/usr/local/bin/linkord-server"]
