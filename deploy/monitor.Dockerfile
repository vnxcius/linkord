# syntax=docker/dockerfile:1.7
# The monitor (monitor/): its server and dashboard. Built from the repository root by deploy/install-monitor.sh:
#   docker buildx build --builder "$(deploy/builder.sh)" --load -f deploy/monitor.Dockerfile -t linkord-monitor .
# Its settings and history (monitor/.env, monitor/data) stay on the host; it reads the app's files read-only.

# Base images are pinned by digest (a tag can be moved to other contents): bump tag and digest together, with
# `docker buildx imagetools inspect <image:tag>`.

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS web
WORKDIR /src/monitor/web
COPY monitor/web/package.json monitor/web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY monitor/web/ ./
RUN bun run build

FROM rust:1.99-trixie@sha256:8a4e90c7946b74626488b1446f712c0fe0ed1a596cbd3d871684bc9c5433ae07 AS build
WORKDIR /src/monitor
COPY monitor/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/monitor/target \
    cargo build --release --locked && cp target/release/linkord-monitor /linkord-monitor

FROM debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /linkord-monitor /usr/local/bin/linkord-monitor
COPY --from=web /src/monitor/web/dist /linkord/monitor/web/dist
# Its relative paths (./data, ./web/dist, ../server) work from here, as on the host.
WORKDIR /linkord/monitor
USER 1000:1000
ENV RUST_LOG=linkord_monitor=info HOME=/tmp
ENTRYPOINT ["/usr/local/bin/linkord-monitor"]
