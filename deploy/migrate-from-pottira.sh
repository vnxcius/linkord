#!/usr/bin/env bash
# One time, on each machine that runs the Pottira names (the production box; the Windows dev PC never moved to them,
# so it needs nothing): moves Docker, Postgres, the .env files and the updater key from Pottira back to Linkord.
# Delete this script once the box has run it.
#
#   - backs up every database (pg_dumpall) into server/data/backups/
#   - renames the role pottira -> linkord and the databases pottira* -> linkord* (the password stays)
#   - copies the Postgres volume into the linkord project's. The stale linkord_pgdata left by the move to Pottira
#     (a copy from before 2.0) is kept as linkord_pgdata_before_pottira first, then overwritten
#   - renames POTTIRA_* -> LINKORD_* in server/.env, monitor/.env and deploy/.env, and points the public URL at
#     https://linkord.app
#   - moves ~/.config/pottira/updater.key to ~/.config/linkord/updater.key
#   - production only: builds the new images first, then stops the old containers (the server saves its calls and
#     sessions, see handover.rs), and starts linkord-server-a and linkord-monitor. Downtime: about a minute.
#     Clients reconnect by themselves. The old containers are removed; their images and the old volume are kept.
#
# Safe to run again: whatever is already done is skipped.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
compose() { docker compose -f "$root/deploy/docker-compose.yml" "$@"; }
exists() { docker inspect "$1" >/dev/null 2>&1; }
volume() { docker volume inspect "$1" >/dev/null 2>&1; }
old_pg=pottira-postgres-1

prod=false
for c in pottira-server-a pottira-server-b pottira-monitor; do exists "$c" && prod=true; done

if ! exists "$old_pg"; then
  echo "No $old_pg container: the database was already moved."
else
  if $prod; then
    # Images first, while the old server still serves: the slow part happens before any downtime.
    builder=$("$root/deploy/builder.sh")
    docker buildx build --builder "$builder" --load -f "$root/deploy/server.Dockerfile" -t linkord-server:latest "$root"
    docker buildx build --builder "$builder" --load -f "$root/deploy/monitor.Dockerfile" -t linkord-monitor:latest "$root"
  fi
  docker start "$old_pg" >/dev/null
  until docker exec "$old_pg" pg_isready -q; do sleep 0.5; done

  mkdir -p "$root/server/data/backups"
  backup="$root/server/data/backups/before-linkord-$(date +%Y%m%d-%H%M%S).sql"
  (umask 077 && docker exec "$old_pg" pg_dumpall -U pottira >"$backup")
  echo "Backup: $backup ($(du -h "$backup" | cut -f1))"

  # Checked before anything stops: a database already called linkord* in this cluster would be overwritten below.
  taken=$(docker exec "$old_pg" psql -tA -U pottira -d postgres -c "SELECT string_agg(datname, ' ') FROM pg_database WHERE datname LIKE 'linkord%'")
  if [ -n "$taken" ]; then
    echo "Stopping: this cluster already has databases named $taken. Nothing was changed; look at them first."
    exit 1
  fi

  if $prod; then
    echo "Stopping the old server and monitor (the server saves its calls and sessions)..."
    for c in pottira-server-a pottira-server-b pottira-monitor; do
      if [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ]; then docker stop -t 75 "$c" >/dev/null; fi
    done
  fi

  # A role can't rename itself, so a temporary superuser does it (local connections in the container need no password).
  pg_pass=$(grep '^POSTGRES_PASSWORD=' "$root/deploy/.env" | cut -d= -f2-)
  docker exec "$old_pg" psql -q -v ON_ERROR_STOP=1 -U pottira -d postgres -c 'CREATE ROLE rename_helper SUPERUSER LOGIN'
  sql() { docker exec -i "$old_pg" psql -q -v ON_ERROR_STOP=1 -U rename_helper -d postgres "$@"; }
  sql <<'SQL'
SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname LIKE 'pottira%' AND pid <> pg_backend_pid();
SQL
  for db in $(sql -tA -c "SELECT datname FROM pg_database WHERE datname LIKE 'pottira%'"); do
    new="linkord${db#pottira}"
    echo "Renaming database $db -> $new"
    sql -c "ALTER DATABASE \"$db\" RENAME TO \"$new\""
  done
  # Renaming a role clears an MD5 password, so it is set again (fed through stdin, never on a command line).
  printf "ALTER ROLE pottira RENAME TO linkord;\nALTER ROLE linkord PASSWORD '%s';\n" "${pg_pass//\'/\'\'}" | sql
  docker exec "$old_pg" psql -q -v ON_ERROR_STOP=1 -U linkord -d postgres -c 'DROP ROLE rename_helper'
  docker stop "$old_pg" >/dev/null

  # linkord_pgdata still holds the database as it was before the move to Pottira (the last script kept it as a
  # backup). Keep that copy under another name before the live data goes in.
  if volume linkord_pgdata && ! volume linkord_pgdata_before_pottira; then
    echo "Keeping the pre-2.0 linkord_pgdata as linkord_pgdata_before_pottira..."
    docker volume create linkord_pgdata_before_pottira >/dev/null
    docker run --rm -v linkord_pgdata:/from:ro -v linkord_pgdata_before_pottira:/to postgres:16-alpine sh -c 'cp -a /from/. /to/'
  fi

  # The linkord project's Postgres, with a copy of the Pottira volume's files.
  compose up --no-start postgres
  docker run --rm -v pottira_pgdata:/from:ro -v linkord_pgdata:/to postgres:16-alpine \
    sh -c 'rm -rf /to/* && cp -a /from/. /to/'
  docker rm "$old_pg" >/dev/null
  compose up -d --wait postgres
  echo "Postgres: linkord-postgres-1 on the linkord_pgdata volume (pottira_pgdata kept)."
fi

# Settings files: the old variable names, the old public address, the database URL's role and name.
for f in "$root/server/.env" "$root/monitor/.env" "$root/deploy/.env"; do
  [ -f "$f" ] || continue
  if grep -qi 'pottira' "$f"; then
    sed -i -E \
      -e 's#https://pottira\.com#https://linkord.app#g' \
      -e 's#^(DATABASE_URL=postgres(ql)?://)pottira:#\1linkord:#' \
      -e 's#^(DATABASE_URL=.*)/pottira(_[a-z]+)?$#\1/linkord\2#' \
      -e 's#POTTIRA_#LINKORD_#g' -e 's#Pottira#Linkord#g' -e 's#pottira#linkord#g' "$f"
    echo "Updated $(basename "$(dirname "$f")")/.env"
  fi
done

# The updater signing key (app/publish-*.sh read ~/.config/linkord/updater.key). Moved, never overwritten.
old_key="$HOME/.config/pottira/updater.key"
new_key="$HOME/.config/linkord/updater.key"
if [ -f "$old_key" ]; then
  if [ ! -f "$new_key" ]; then
    mkdir -p "$(dirname "$new_key")" && chmod 700 "$(dirname "$new_key")"
    mv "$old_key" "$new_key" && rmdir "$(dirname "$old_key")" 2>/dev/null || true
    echo "Updater key: $new_key"
  elif cmp -s "$old_key" "$new_key"; then
    rm "$old_key" && rmdir "$(dirname "$old_key")" 2>/dev/null || true
  else
    echo "WARNING: $old_key and $new_key differ. The released apps trust the key in tauri.conf.json's pubkey;"
    echo "         keep the one that matches it at $new_key and delete the other by hand."
  fi
fi

if $prod; then
  rm -f "$root/server/data/run/live"
  compose --profile server up -d --no-deps server-a
  echo "Waiting for linkord-server-a..."
  for _ in $(seq 1 120); do
    grep -q '"slot":"a"' "$root/server/data/run/live" 2>/dev/null && break
    sleep 0.5
  done
  grep -q '"slot":"a"' "$root/server/data/run/live" 2>/dev/null || { docker logs --tail 60 linkord-server-a; exit 1; }
  compose --profile monitor up -d --no-deps monitor
  for c in pottira-server-a pottira-server-b pottira-monitor; do exists "$c" && docker rm "$c" >/dev/null; done
  echo "Serving from linkord-server-a: $(cat "$root/server/data/run/live")"
fi

echo
echo "Done. Kept as backups until you're happy: the volumes pottira_pgdata and linkord_pgdata_before_pottira, the"
echo "images pottira-server / pottira-monitor and the BuildKit builder 'pottira' (its caches). Remove them with:"
echo "  docker volume rm pottira_pgdata linkord_pgdata_before_pottira; docker image rm pottira-server pottira-monitor"
echo "  docker buildx rm pottira"
