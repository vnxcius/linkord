# Notices

Linkord's source code is licensed under the GNU General Public License, version 3 only (see [LICENSE](LICENSE)).
The GPL covers the code and the artwork made for the project. It does **not** cover the third-party material listed
below, which keeps its own owners and terms.

Linkord is an independent project. It is not affiliated with, endorsed or sponsored by Discord Inc., Nintendo,
Mojang/Microsoft, Riot Games, Spotify or any other company whose names or services it mentions. Their names and marks
belong to their owners and are used only to describe compatibility.

## Not covered by the GPL

These files are in the repository so the reference instance builds as it runs. They are **not** licensed to you under
the GPL or any other license: if you fork Linkord, replace them with material you have the rights to.

| Files | What they are |
| --- | --- |
| `app/src/assets/sounds/*.wav` (join, leave, mute, message, stream, REC and the other UI sounds) | Edits of sound effects from *The Legend of Zelda: Ocarina of Time*, © Nintendo |
| `app/src/assets/sounds/ring-incoming.mp3`, `ring-outgoing.mp3` | Ringtones based on *The Legend of Zelda* music, © Nintendo |
| `app/src/assets/sounds/camera-on.mp3`, `camera-off.mp3`, `ptt-on.mp3`, `ptt-off.mp3` | Discord's sounds, © Discord Inc. |
| `app/src/assets/sounds/christmas/*` | Discord's Winter sound pack, © Discord Inc. |
| `server/soundboard/*` | Default soundboard clips; their origin hasn't been verified |
| The emblem and app icons (`design/*.svg`, `assets/`, `app/public/icon*`, `app/public/apple-touch-icon.png`, `app/public/badge-96.png`, `app/src/assets/emblem*.png`, `app/src-tauri/icons/`, `android/app/src/main/res/drawable-nodpi/emblem.png`) | The wings are original; the Triforce they surround is a trademark of Nintendo. Use your own icon in a fork |

The Android app copies `app/src/assets/sounds` into its build, so the same applies there.

## Public domain

- `app/music/christmas/*`: recordings by United States Air Force bands, works of the US federal government.

## Third-party components with their own licenses

- **Twemoji** graphics (`app/src/assets/fonts/twemoji.woff2`, `android/designsystem/src/main/res/font/twemoji.ttf`):
  © Twitter, Inc. and other contributors, licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Patched by `app/scripts/patch-twemoji.py`
  (variation selector handling). License text: `app/src/assets/fonts/twemoji-LICENSE.txt`.
- **Geist** and **Geist Mono** (Vercel) and **Instrument Serif** fonts: SIL Open Font License 1.1. License texts in
  `android/designsystem/src/main/assets/licenses/`; the web client uses the `@fontsource` packages.
- **Heroicons** (outline set, used in `app/src/components/Icons.tsx` and the icons generated from it): MIT License,
  Copyright (c) Tailwind Labs, Inc. (text below).
- **Simple Icons** brand shapes (`app/src/lib/brand-icons.ts`): CC0 1.0. The brand names and logos remain trademarks
  of their owners.
- Code dependencies (Rust crates, npm and Gradle packages, libopus, RNNoise) keep their licenses, recorded in their
  own manifests; all are compatible with GPL-3.0.

### Heroicons license

```
MIT License

Copyright (c) Tailwind Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
