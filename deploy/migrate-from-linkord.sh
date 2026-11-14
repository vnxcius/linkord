#!/usr/bin/env bash
# One time, on each machine that still runs the old names (the production box, the Windows dev PC): moves Docker,
# Postgres and the .env files from Linkord to Pottira. Delete this script once both have run it.
#
#   - backs up every database (pg_dumpall) into server/data/backups/
#   - renames the role linkord -> pottira and the databases linkord* -> pottira* (the password stays)
#   - copies the Postgres volume into the new project's (linkord_pgdata is kept, as a second backup)
#   - renames LINKORD_* -> POTTIRA_* in server/.env and monitor/.env, and points the public URL at pottira.com
#   - production only: builds the new images first, then stops the old containers (the server saves its calls and
#     sessions, see handover.rs), and starts pottira-server-a and pottira-monitor. Downtime: about a minute.
#     Clients reconnect by themselves. The old containers are removed, their images and the old volume are kept.
#
# Safe to run again: whatever is already done is skipped.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
compose() { docker compose -f "$root/deploy/docker-compose.yml" "$@"; }
exists() { docker inspect "$1" >/dev/null 2>&1; }
old_pg=linkord-postgres-1

prod=false
for c in linkord-server-a linkord-server-b linkord-monitor; do exists "$c" && prod=true; done

if ! exists "$old_pg"; then
  echo "No $old_pg container: the database was already moved."
else
  if $prod; then
    # Images first, while the old server still serves: the slow part happens before any downtime.
    builder=$("$root/deploy/builder.sh")
    docker buildx build --builder "$builder" --load -f "$root/deploy/server.Dockerfile" -t pottira-server:latest "$root"
    docker buildx build --builder "$builder" --load -f "$root/deploy/monitor.Dockerfile" -t pottira-monitor:latest "$root"
  fi
  docker start "$old_pg" >/dev/null
  until docker exec "$old_pg" pg_isready -q; do sleep 0.5; done

  mkdir -p "$root/server/data/backups"
  backup="$root/server/data/backups/before-pottira-$(date +%Y%m%d-%H%M%S).sql"
  (umask 077 && docker exec "$old_pg" pg_dumpall -U linkord >"$backup")
  echo "Backup: $backup ($(du -h "$backup" | cut -f1))"

  if $prod; then
    echo "Stopping the old server and monitor (the server saves its calls and sessions)..."
    for c in linkord-server-a linkord-server-b linkord-monitor; do
      if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ]; then docker stop -t 75 "$c" >/dev/null; fi
    done
  fi

  # A role can't rename itself, so a temporary superuser does it (local connections in the container need no password).
  pg_pass=$(grep '^POSTGRES_PASSWORD=' "$root/deploy/.env" | cut -d= -f2-)
  docker exec "$old_pg" psql -q -v ON_ERROR_STOP=1 -U linkord -d postgres -c 'CREATE ROLE rename_helper SUPERUSER LOGIN'
  sql() { docker exec -i "$old_pg" psql -q -v ON_ERROR_STOP=1 -U rename_helper -d postgres "$@"; }
  sql <<'SQL'
SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname LIKE 'linkord%' AND pid <> pg_backend_pid();
SQL
  for db in $(sql -tA -c "SELECT datname FROM pg_database WHERE datname LIKE 'linkord%'"); do
    new="pottira${db#linkord}"
    if [ -n "$(sql -tA -c "SELECT 1 FROM pg_database WHERE datname = '$new'")" ]; then
      # The test suite already made its database under the new name; the old one is only a leftover.
      echo "Dropping $db ($new exists)"
      sql -c "DROP DATABASE \"$db\""
    else
      echo "Renaming database $db -> $new"
      sql -c "ALTER DATABASE \"$db\" RENAME TO \"$new\""
    fi
  done
  # Renaming a role clears an MD5 password, so it is set again (fed through stdin, never on a command line).
  printf "ALTER ROLE linkord RENAME TO pottira;\nALTER ROLE pottira PASSWORD '%s';\n" "${pg_pass//\'/\'\'}" | sql
  docker exec "$old_pg" psql -q -v ON_ERROR_STOP=1 -U pottira -d postgres -c 'DROP ROLE rename_helper'
  docker stop "$old_pg" >/dev/null

  # The new project's Postgres, with a copy of the old volume's files.
  compose up --no-start postgres
  docker run --rm -v linkord_pgdata:/from:ro -v pottira_pgdata:/to postgres:16-alpine \
    sh -c 'rm -rf /to/* && cp -a /from/. /to/'
  docker rm "$old_pg" >/dev/null
  compose up -d --wait postgres
  echo "Postgres: pottira-postgres-1 on the pottira_pgdata volume (linkord_pgdata kept)."
fi

# Settings files: new variable names, the old public address replaced, the database URL's role and name.
for f in "$root/server/.env" "$root/monitor/.env"; do
  [ -f "$f" ] || continue
  if grep -qi 'linkord' "$f"; then
    sed -i -E \
      -e 's#https://old\.example\.com#https://pottira.com#g' \
      -e 's#^(DATABASE_URL=postgres(ql)?://)linkord:#\1pottira:#' \
      -e 's#^(DATABASE_URL=.*)/linkord(_[a-z]+)?$#\1/pottira\2#' \
      -e 's#LINKORD_#POTTIRA_#g' -e 's#Linkord#Pottira#g' -e 's#linkord#pottira#g' "$f"
    echo "Updated $(basename "$(dirname "$f")")/.env"
  fi
done

if $prod; then
  rm -f "$root/server/data/run/live"
  compose --profile server up -d --no-deps server-a
  echo "Waiting for pottira-server-a..."
  for _ in $(seq 1 120); do
    grep -q '"slot":"a"' "$root/server/data/run/live" 2>/dev/null && break
    sleep 0.5
  done
  grep -q '"slot":"a"' "$root/server/data/run/live" 2>/dev/null || { docker logs --tail 60 pottira-server-a; exit 1; }
  compose --profile monitor up -d --no-deps monitor
  for c in linkord-server-a linkord-server-b linkord-monitor; do exists "$c" && docker rm "$c" >/dev/null; done
  echo "Serving from pottira-server-a: $(cat "$root/server/data/run/live")"
fi

echo
echo "Done. Kept as backups until you're happy: the volume linkord_pgdata, the images linkord-server / linkord-monitor"
echo "and the old BuildKit builder 'linkord' (its caches). Remove them with:"
echo "  docker volume rm linkord_pgdata; docker image rm linkord-server linkord-monitor; docker buildx rm linkord"
