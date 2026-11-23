#!/usr/bin/env bash
# Pushes master and follows the box's runner until the push is tested, deployed and published.
#   deploy/ci/ship.sh            git push, then stream the run (exit 1 if it failed)
#   deploy/ci/ship.sh --no-wait  git push and kick the runner, without waiting
# LINKORD_BOX = the box's ssh host (default linkord-box, see ~/.ssh/config).
set -euo pipefail
box="${LINKORD_BOX:-linkord-box}"
# By its path: a plain `ssh box command` gets a PATH without ~/.local/bin.
ci="~/.local/bin/linkord-ci"
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = master ] || { echo "On $branch: the runner only ships master."; exit 1; }
git push origin master
sha=$(git rev-parse HEAD)
ssh "$box" "$ci kick"
[ "${1:-}" = --no-wait ] && { echo "Kicked the runner for ${sha:0:9}. Watch it on GitHub (Actions -> ship) or: ssh $box $ci follow $sha"; exit 0; }
ssh -t "$box" "$ci follow $sha"
