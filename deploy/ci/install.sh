#!/usr/bin/env bash
# Installs the runner on the box (run it there, as the user that owns the checkout; no sudo):
# a crontab line that ticks every minute, `linkord-ci` on the PATH, and the starting point: everything up to the
# current master counts as already deployed and published, so only later pushes go out.
#   deploy/ci/install.sh            install or update (keeps the runner's state)
#   deploy/ci/install.sh --from SHA start after SHA instead (what came later goes out on the next tick)
#   deploy/ci/install.sh --remove   take the crontab line out
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
state="${XDG_STATE_HOME:-$HOME/.local/state}/linkord-ci"
line="* * * * * $root/deploy/ci/linkord-ci tick >/dev/null 2>&1  # linkord-ci"
current=$(crontab -l 2>/dev/null | grep -v '# linkord-ci$' || true)
if [ "${1:-}" = --remove ]; then
  printf '%s\n' "$current" | sed '/^$/d' | crontab -
  echo "Runner removed from the crontab (state kept in $state)."
  exit 0
fi
mkdir -p "$HOME/.local/bin" "$state/runs"
ln -sfn "$root/deploy/ci/linkord-ci" "$HOME/.local/bin/linkord-ci"
git -C "$root" fetch -q origin master
start=$(git -C "$root" rev-parse "${2:-origin/master}")
for t in server monitor desktop android tick; do
  if [ "${1:-}" = --from ] || [ ! -f "$state/last-$t" ]; then echo "$start" >"$state/last-$t"; fi
done
printf '%s\n%s\n' "$current" "$line" | sed '/^$/d' | crontab -
echo "Runner installed: ticks every minute; pushes after ${start:0:9} go out. Try: linkord-ci status"
