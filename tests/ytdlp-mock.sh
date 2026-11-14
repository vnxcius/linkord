#!/usr/bin/env bash
# Stands in for yt-dlp in tests (POTTIRA_YTDLP): `-j ... -- <url|ytsearch1:query>` prints a video's info,
# `-o - ... -- <url>` streams 8 s of a 440 Hz tone, `-U` does nothing. "nothing" finds nothing; a URL with
# "broken" in it fails to download. `-j` with ytsearch10: lists results, one of them live and one too long.
target="${*: -1}"
case " $* " in
  *" -U "*) echo "yt-dlp is up to date (mock)" ;;
  *" -j "*)
    [[ $target == *nothing* ]] && { echo "ERROR: no results" >&2; exit 1; }
    if [[ $target == ytsearch10:* ]]; then
      printf '{"id":"mockSong001","title":"Mock One","channel":"Mock Channel","duration":8}\n'
      printf '{"id":"mockLive001","title":"Mock Live","channel":"Mock Channel","duration":null}\n'
      printf '{"id":"mockLong001","title":"Mock Long","channel":"Mock Channel","duration":7200}\n'
      printf '{"id":"brokenbroke","title":"Mock Broken","channel":"Mock Channel","duration":8}\n'
      exit 0
    fi
    if [[ $target == ytsearch1:* ]]; then id=search; else id="${target##*v=}"; fi
    printf '{"id":"%s","title":"Mock Song %s","webpage_url":"https://www.youtube.com/watch?v=%s","duration":8,"uploader":"Mock Channel","thumbnail":null}\n' "$id" "$id" "$id"
    ;;
  *" -o "*)
    [[ $target == *broken* ]] && { echo "ERROR: Sign in to confirm you're not a bot" >&2; exit 1; }
    # A time limit: on Windows an ffmpeg left behind when the server stops stays blocked on its pipe forever and keeps
    # the server's port (it inherited the socket), so the next test run can't start.
    exec timeout 30 ffmpeg -loglevel error -f lavfi -i sine=frequency=440:duration=8 -f wav pipe:1
    ;;
  *) echo "mock yt-dlp: unexpected arguments: $*" >&2; exit 2 ;;
esac
