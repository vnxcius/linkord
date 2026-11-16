#!/usr/bin/env bash
# Makes the Android release signing key, once: ~/.config/linkord/android-release.jks plus the properties file the
# build reads. Android only installs an update signed with the same key, so LOSING IT MEANS EVERY FRIEND REINSTALLS:
# back up the .jks and the passwords somewhere safe (owner). Prints the SHA-256 fingerprint for the server's
# LINKORD_ANDROID_CERTS (App Links, server/src/android.rs).
set -euo pipefail
dir="$HOME/.config/linkord"
jks="$dir/android-release.jks"
props="$dir/android-release.properties"
[ -e "$jks" ] && { echo "$jks already exists; not touching it."; exit 1; }
mkdir -p "$dir" && chmod 700 "$dir"
keytool="${JAVA_HOME:-/usr/local/android-studio/jbr}/bin/keytool"
pass=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
"$keytool" -genkeypair -keystore "$jks" -storetype PKCS12 -alias linkord -keyalg RSA -keysize 4096 -validity 36500 \
  -storepass "$pass" -keypass "$pass" -dname "CN=Linkord"
printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=linkord\nkeyPassword=%s\n' "$jks" "$pass" "$pass" > "$props"
chmod 600 "$jks" "$props"
echo "Key: $jks (password in $props). BACK BOTH UP."
"$keytool" -list -v -keystore "$jks" -storepass "$pass" | grep -E 'SHA256:' | sed 's/.*SHA256: /LINKORD_ANDROID_CERTS=/'
