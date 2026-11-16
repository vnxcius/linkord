#!/usr/bin/env bash
# GitLab's view of the box's runner (.gitlab-ci.yml): installs gitlab-runner in ~/.local/bin (pinned, checksum
# checked, no sudo), registers it for this project, and keeps it running from cron (up within a minute, also after a
# reboot). Run it on the box, as the user that owns the checkout:
#   deploy/ci/install-gitlab-runner.sh glrt-XXXX   install, register and start; the token is the one GitLab shows
#                                                   when you create a project runner (Settings -> CI/CD -> Runners ->
#                                                   New project runner, tag "linkord-box")
#   deploy/ci/install-gitlab-runner.sh --remove    stop it and take it out of the crontab (the registration stays)
set -euo pipefail
version=v18.5.0
bin="$HOME/.local/bin/gitlab-runner"
dir="$HOME/.gitlab-runner"
conf="$dir/config.toml"
# pgrep's pattern is anchored at the binary's path, so it never matches the cron shell that runs it.
line="* * * * * pgrep -f '^$bin run' >/dev/null || $bin run --config $conf --working-directory $dir >>$dir/runner.log 2>&1  # linkord-gitlab-runner"
current=$(crontab -l 2>/dev/null | grep -v '# linkord-gitlab-runner$' || true)

if [ "${1:-}" = --remove ]; then
  printf '%s\n' "$current" | sed '/^$/d' | crontab -
  pkill -f "^$bin run" || true
  echo "gitlab-runner stopped and out of the crontab."
  exit 0
fi
token="${1:-}"
[[ "$token" == glrt-* ]] || { echo "Usage: $0 glrt-XXXX (the project runner's token from GitLab)"; exit 1; }

mkdir -p "$HOME/.local/bin" "$dir"
if [ "$("$bin" --version 2>/dev/null | sed -n 's/^Version: *//p')" != "${version#v}" ]; then
  tmp=$(mktemp -d)
  base="https://gitlab-runner-downloads.s3.amazonaws.com/$version"
  curl -fsSL -o "$tmp/gitlab-runner-linux-amd64" "$base/binaries/gitlab-runner-linux-amd64"
  curl -fsSL -o "$tmp/release.sha256" "$base/release.sha256"
  # release.sha256 lines are "<hash><tab>binaries/<file>": checked as "<hash>  <file>" against the download.
  sum=$(awk '$2 == "binaries/gitlab-runner-linux-amd64" { print $1 "  gitlab-runner-linux-amd64" }' "$tmp/release.sha256")
  [ -n "$sum" ] || { echo "No checksum for gitlab-runner-linux-amd64 in $version's release.sha256."; exit 1; }
  (cd "$tmp" && printf '%s\n' "$sum" | sha256sum -c --quiet -)
  install -m 755 "$tmp/gitlab-runner-linux-amd64" "$bin"
  rm -rf "$tmp"
fi
"$bin" register --non-interactive --config "$conf" --url https://gitlab.com --token "$token" \
  --executor shell --name "$(hostname)"
chmod 600 "$conf"
printf '%s\n%s\n' "$current" "$line" | sed '/^$/d' | crontab -
pgrep -f "^$bin run" >/dev/null || nohup "$bin" run --config "$conf" --working-directory "$dir" >>"$dir/runner.log" 2>&1 &
echo "gitlab-runner $version registered and running; GitLab -> Build -> Pipelines shows each push."
