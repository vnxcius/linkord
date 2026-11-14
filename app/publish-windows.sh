#!/usr/bin/env bash
# Releases a new desktop version: bumps the patch version, builds an optimized signed installer,
# and publishes it to the server's update feed. Running apps pick it up within 30 minutes.
#   ./publish-windows.sh "What changed"   (one change per line; they become the patch notes page's bullets)
#   POTTIRA_VERSION=0.2.0 ./publish-windows.sh "..."   releases that version instead of the next patch
set -euo pipefail
cd "$(dirname "$0")"
notes="${1:-Bug fixes and improvements}"
updates="${POTTIRA_UPDATES_DIR:-../server/data/updates}"
key="${POTTIRA_UPDATER_KEY:-$HOME/.config/pottira/updater.key}"
[[ -f "$key" ]] || { echo "Updater signing key not found at $key: can't publish (installed apps would reject the update)."; exit 1; }
export POTTIRA_REQUIRE_SIGNING=1
# The update feed is the production server's data/updates. On a Windows dev PC ../server/data/updates is only
# the local dev server, so say where the feed is (POTTIRA_UPDATES_DIR) or publish from the server.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    [[ -n "${POTTIRA_UPDATES_DIR:-}" ]] || { echo "On Windows, set POTTIRA_UPDATES_DIR to the production server's data/updates."; exit 1; }
    ;;
esac

current=$(node -p "require('./src-tauri/tauri.conf.json').version")
next=${POTTIRA_VERSION:-$(node -p "const [a,b,c]='$current'.split('.').map(Number); [a,b,c+1].join('.')")}
node -e "
  const fs = require('fs');
  for (const f of ['src-tauri/tauri.conf.json', 'package.json']) {
    const j = JSON.parse(fs.readFileSync(f)); j.version = '$next'; fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  }
  const t = 'src-tauri/Cargo.toml';
  fs.writeFileSync(t, fs.readFileSync(t, 'utf8').replace(/^version = \".*\"/m, 'version = \"$next\"'));
"
echo "Releasing $current -> $next"

./build-windows.sh --release
exe=$(ls out/*_"$next"_x64-setup.exe)
mkdir -p "$updates"
cp "$exe" "$updates/"
node -e "
  const fs = require('fs');
  fs.writeFileSync('$updates/latest.json', JSON.stringify({
    version: '$next',
    notes: process.argv[1],
    pub_date: new Date().toISOString(),
    platforms: { 'windows-x86_64': { signature: fs.readFileSync('$exe.sig', 'utf8'), file: require('path').basename('$exe') } },
  }, null, 2));
" "$notes"
# Patch notes page: newest first, one entry per version.
node -e "
  const fs = require('fs');
  const f = '$updates/changelog.json';
  let list = [];
  try { list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  list = [{ version: '$next', date: new Date().toISOString(), notes: process.argv[1] }, ...list.filter((r) => r.version !== '$next')];
  fs.writeFileSync(f, JSON.stringify(list, null, 2));
" "$notes"
echo "Published $next. Commit the version bump: git commit -am 'Release $next'"
