# syntax=docker/dockerfile:1.7
# The monitor (monitor/): its server and dashboard. Built from the repository root by deploy/install-monitor.sh:
#   docker buildx build --builder "$(deploy/builder.sh)" --load -f deploy/monitor.Dockerfile -t pottira-monitor .
# Its settings and history (monitor/.env, monitor/data) stay on the host; it reads the app's files read-only.

FROM oven/bun:1.4.2 AS web
WORKDIR /src/monitor/web
COPY monitor/web/package.json monitor/web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY monitor/web/ ./
RUN bun run build

FROM rust:1.99-trixie AS build
WORKDIR /src/monitor
COPY monitor/ ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/src/monitor/target \
    cargo build --release --locked && cp target/release/pottira-monitor /pottira-monitor

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /pottira-monitor /usr/local/bin/pottira-monitor
COPY --from=web /src/monitor/web/dist /pottira/monitor/web/dist
# Its relative paths (./data, ./web/dist, ../server) work from here, as on the host.
WORKDIR /pottira/monitor
USER 1000:1000
ENV RUST_LOG=pottira_monitor=info HOME=/tmp
ENTRYPOINT ["/usr/local/bin/pottira-monitor"]
