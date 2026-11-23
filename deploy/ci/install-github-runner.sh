#!/usr/bin/env bash
# GitHub's view of the server's runner (.github/workflows/ship.yml): installs a self-hosted GitHub Actions runner in
# ~/.github-runner (pinned, checksum checked, no sudo), registers it for this repository with the label linkord-box,
# and keeps it running from cron (up within a minute, also after a reboot). Run it on the server, as the user that
# owns the checkout, with `gh` logged in as a repository admin:
#   deploy/ci/install-github-runner.sh            install, register, harden and start
#   deploy/ci/install-github-runner.sh --remove   stop it, take it out of the crontab and unregister it
#
# Hardening (a public repository's pull requests must never run code on this machine):
# - deploy/ci/runner-guard.sh is the runner's job-start hook: it fails every job that isn't ship.yml from master,
#   started by a push to master of this repository, before any step runs;
# - the repository's Actions settings: workflow runs from every external contributor wait for approval, the workflow
#   token is read-only and can't approve pull requests, and only actions from this repository are allowed
#   (ship.yml uses none).
set -euo pipefail
version=2.338.2
sha256=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
root="$(cd "$(dirname "$0")/../.." && pwd)"
dir="$HOME/.github-runner"
# owner/name from the checkout's origin (https://github.com/owner/name.git or git@github.com:owner/name.git).
repo=$(git -C "$root" remote get-url origin | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "origin isn't a GitHub repository: $repo"; exit 1; }
# pgrep's pattern is anchored at the binary's path, so it never matches the cron shell that runs it.
line="* * * * * pgrep -f '^$dir/bin/Runner.Listener run' >/dev/null || (cd $dir && exec setsid ./run.sh) </dev/null >>$dir/runner.log 2>&1 &  # linkord-github-runner"
current=$(crontab -l 2>/dev/null | grep -v '# linkord-github-runner$' || true)

if [ "${1:-}" = --remove ]; then
  printf '%s\n' "$current" | sed '/^$/d' | crontab -
  pkill -f "^$dir/bin/Runner.Listener run" || true
  if [ -x "$dir/config.sh" ]; then
    token=$(gh api -X POST "repos/$repo/actions/runners/remove-token" -q .token)
    (cd "$dir" && ./config.sh remove --token "$token")
  fi
  echo "GitHub runner stopped, out of the crontab and unregistered."
  exit 0
fi

mkdir -p "$dir"
# The first install only: the runner keeps itself up to date after that (GitHub stops sending jobs to old ones).
if [ ! -x "$dir/config.sh" ]; then
  tmp=$(mktemp -d)
  file="actions-runner-linux-x64-$version.tar.gz"
  curl -fsSL -o "$tmp/$file" "https://github.com/actions/runner/releases/download/v$version/$file"
  (cd "$tmp" && printf '%s  %s\n' "$sha256" "$file" | sha256sum -c --quiet -)
  tar -xzf "$tmp/$file" -C "$dir"
  rm -rf "$tmp"
fi

if [ ! -f "$dir/.runner" ]; then
  token=$(gh api -X POST "repos/$repo/actions/runners/registration-token" -q .token)
  (cd "$dir" && ./config.sh --unattended --url "https://github.com/$repo" --token "$token" \
    --name "$(hostname)" --labels linkord-box --work _work --replace)
fi

# The guard, and the repository it guards for (the runner reads .env when it starts).
touch "$dir/.env"
sed -i '/^ACTIONS_RUNNER_HOOK_JOB_STARTED=/d; /^LINKORD_RUNNER_REPO=/d' "$dir/.env"
printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s\nLINKORD_RUNNER_REPO=%s\n' "$root/deploy/ci/runner-guard.sh" "$repo" >>"$dir/.env"
chmod 600 "$dir/.env" "$dir/.credentials" "$dir/.credentials_rsaparams" 2>/dev/null || true

# Repository settings.
gh api -X PUT "repos/$repo/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors >/dev/null
gh api -X PUT "repos/$repo/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false >/dev/null
gh api -X PUT "repos/$repo/actions/permissions" -F enabled=true -f allowed_actions=local_only >/dev/null

printf '%s\n%s\n' "$current" "$line" | sed '/^$/d' | crontab -
# A running runner reads .env only when it starts: restart it so the guard is on.
pkill -f "^$dir/bin/Runner.Listener run" || true
# All of the subshell's output goes to the log, so nothing holds this script's (or an ssh session's) output open.
(cd "$dir" && exec setsid nohup ./run.sh) </dev/null >>"$dir/runner.log" 2>&1 &
echo "GitHub runner $version registered for $repo (label linkord-box), guarded and running."
