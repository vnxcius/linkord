#!/usr/bin/env bash
# Stands in for yt-dlp in tests (LINKORD_YTDLP): `-j ... -- <url|ytsearch1:query>` prints a video's info,
# `-o - ... -- <url>` streams 8 s of a 440 Hz tone, `-U` does nothing. "nothing" finds nothing; a URL with
# "broken" in it fails to download.
target="${*: -1}"
case " $* " in
  *" -U "*) echo "yt-dlp is up to date (mock)" ;;
  *" -j "*)
    [[ $target == *nothing* ]] && { echo "ERROR: no results" >&2; exit 1; }
    if [[ $target == ytsearch1:* ]]; then id=search; else id="${target##*v=}"; fi
    printf '{"id":"%s","title":"Mock Song %s","webpage_url":"https://www.youtube.com/watch?v=%s","duration":8,"uploader":"Mock Channel","thumbnail":null}\n' "$id" "$id" "$id"
    ;;
  *" -o "*)
    [[ $target == *broken* ]] && { echo "ERROR: Sign in to confirm you're not a bot" >&2; exit 1; }
    exec ffmpeg -loglevel error -f lavfi -i sine=frequency=440:duration=8 -f wav pipe:1
    ;;
  *) echo "mock yt-dlp: unexpected arguments: $*" >&2; exit 2 ;;
esac
