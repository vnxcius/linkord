#!/usr/bin/env bash
# Publishes an Android release: bumps the version, builds the signed release APK, checks its signature and writes it
# plus android.json into the update feed (server api/updates.rs), where installed apps find it within seconds.
#   android/publish.sh "notes, one change per line"          bumps the patch version (0.1.0 -> 0.1.1)
#   android/publish.sh "notes" 0.2.0                          sets that version
# Needs the release key (scripts/new-release-key.sh) and Node. LINKORD_UPDATES_DIR = the production server's
# data/updates (default ../server/data/updates). The box's runner (deploy/ci) calls this and commits the bump.
set -euo pipefail
cd "$(dirname "$0")"
notes="${1:?usage: publish.sh \"notes\" [version]}"
props="${LINKORD_ANDROID_SIGNING:-$HOME/.config/linkord/android-release.properties}"
[ -f "$props" ] || { echo "No release key ($props). Make one with android/scripts/new-release-key.sh first."; exit 1; }
export JAVA_HOME="${JAVA_HOME:-/usr/local/android-studio/jbr}"

gradle=app/build.gradle.kts
code=$(grep -oE 'versionCode = [0-9]+' "$gradle" | grep -oE '[0-9]+')
name=$(grep -oE 'versionName = "[^"]+"' "$gradle" | cut -d'"' -f2)
new_code=$((code + 1))
if [ -n "${2:-}" ]; then new_name="$2"; else IFS=. read -r a b c <<<"$name"; new_name="$a.$b.$((c + 1))"; fi
sed -i -E "s/versionCode = [0-9]+/versionCode = $new_code/; s/versionName = \"[^\"]+\"/versionName = \"$new_name\"/" "$gradle"
echo "Linkord for Android $name ($code) -> $new_name ($new_code)"

./gradlew --console=plain :app:assembleRelease
apk=app/build/outputs/apk/release/app-release.apk
[ -f "$apk" ] || { echo "No signed APK was built (is the key in $props right?)"; exit 1; }
apksigner=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/*/apksigner | sort -V | tail -1)
"$apksigner" verify "$apk"

updates="${LINKORD_UPDATES_DIR:-../server/data/updates}"
mkdir -p "$updates"
file="Linkord-$new_name.apk"
cp "$apk" "$updates/$file"
sha=$(sha256sum "$apk" | cut -d' ' -f1)
# Written to a temporary name and renamed, so the server never reads half a feed.
node -e '
const [file, version, code, sha, notes, out] = process.argv.slice(1);
require("fs").writeFileSync(out + ".tmp", JSON.stringify({ version, version_code: Number(code), notes, pub_date: new Date().toISOString(), file, sha256: sha }, null, 2));
require("fs").renameSync(out + ".tmp", out);
' "$file" "$new_name" "$new_code" "$sha" "$notes" "$updates/android.json"
# Older APKs: only the one before stays (an app mid-download keeps working).
ls -1t "$updates"/Linkord-*.apk 2>/dev/null | tail -n +3 | xargs -r rm --
echo "Published $file ($(du -h "$apk" | cut -f1), sha256 $sha) to $updates"
