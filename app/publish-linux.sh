#!/usr/bin/env bash
# Builds the Linux packages for the current version (run after publish-windows.sh, which bumps it), signs them
# for the updater and publishes them: installed .deb/.rpm apps update from /api/updates/linux/..., and the web
# client's "Download the app" menu offers them.
#   ./publish-linux.sh ["What changed"]   (defaults to the Windows release notes of the same version)
set -euo pipefail
cd "$(dirname "$0")"
updates="${POTTIRA_UPDATES_DIR:-../server/data/updates}"
key="${POTTIRA_UPDATER_KEY:-$HOME/.config/pottira/updater.key}"
version=$(node -p "require('./src-tauri/tauri.conf.json').version")
notes="${1:-$(node -p "try { const l = JSON.parse(require('fs').readFileSync('$updates/latest.json')); l.version === '$version' ? l.notes : '' } catch { '' }")}"

./build-linux.sh
deb=$(ls out/*_"$version"_amd64.deb)
rpm=$(ls out/*-"$version"-1.x86_64.rpm)
for f in "$deb" "$rpm"; do
  node_modules/.bin/tauri signer sign -f "$key" -p "" "$f" >/dev/null
done
mkdir -p "$updates"
cp "$deb" "$rpm" "$updates/"
node -e "
  const fs = require('fs');
  fs.writeFileSync('$updates/linux.json', JSON.stringify({
    version: '$version', notes: process.argv[1], pub_date: new Date().toISOString(),
    deb: '$(basename "$deb")', deb_signature: fs.readFileSync('$deb.sig', 'utf8'),
    rpm: '$(basename "$rpm")', rpm_signature: fs.readFileSync('$rpm.sig', 'utf8'),
  }, null, 2));
" "${notes:-Bug fixes and improvements}"
echo "Published Linux $version"
