# syntax=docker/dockerfile:1.7
# The linkord server image: the server, the web client it serves, and what it runs (ffmpeg; Python and Node for
# yt-dlp). Built from the repository root by deploy/install-service.sh:
#   docker buildx build --builder "$(deploy/builder.sh)" --load -f deploy/server.Dockerfile -t linkord-server .
# Settings, data, the soundboard and nameplates stay on the host (bind mounts in docker-compose.yml).
# Build caches (cargo registry and target, bun) live in BuildKit cache mounts, so a deploy only rebuilds what changed.

# Base images are pinned by digest (a tag can be moved to other contents): bump tag and digest together, with
# `docker buildx imagetools inspect <image:tag>`.

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS web
WORKDIR /src/app
COPY app/package.json app/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY app/ ./
RUN bun run build

FROM rust:1.99-trixie@sha256:8a4e90c7946b74626488b1446f712c0fe0ed1a596cbd3d871684bc9c5433ae07 AS server
WORKDIR /src/server
COPY server/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/server/target \
    cargo build --release --locked && cp target/release/linkord-server /linkord-server

# Only its binary: yt-dlp solves YouTube's JavaScript with it (LINKORD_YTDLP_ARGS="--js-runtimes node").
FROM node:24-trixie-slim@sha256:4d00acb4bcc42c454c4eb801526f7ad7f772ea3bd4fd168c5cc2e384abcbb9d4 AS node

FROM debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# yt-dlp at a checked version (its official SHA2-256SUMS), not one that updates itself: bump the version in the URL and
# the checksum together. LINKORD_YTDLP makes the server use this one even if data/bin/yt-dlp exists.
ADD --chmod=755 --checksum=sha256:e8665ed64d6b9172773e812f891fb707a0cb1ee8d9ef4fc1acb00cabee4c5256 \
    https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.23/yt-dlp /usr/local/bin/yt-dlp
COPY --from=server /linkord-server /usr/local/bin/linkord-server
COPY --from=web /src/app/dist /linkord/app/dist
# The server's relative paths (./data, ../app/dist, ./soundboard, ./nameplates, .env) work from here, as on the host.
WORKDIR /linkord/server
# The host user (uid 1000): files in the bind-mounted data folder keep their owner.
USER 1000:1000
ENV RUST_LOG=linkord_server=info HOME=/tmp LINKORD_YTDLP=/usr/local/bin/yt-dlp
ENTRYPOINT ["/usr/local/bin/linkord-server"]
