# Pottira brand sources

- `pottira-icon.svg`: the app icon. Cotton swirl (#ece8e1) on the graphite tile (#1b1c20), corner radius 172/1024.
- `pottira-icon-light.svg`: the same on a white tile with the ink swirl (#22201d), for light backgrounds and print.
- `pottira-mark.svg` / `pottira-mark-ink.svg`: the swirl alone, cotton or ink, on transparent.

The swirl was drawn with an image AI from the brand brief and traced into 23 cubic curves (98% pixel match with the
original). Wordmark: "Pottira" set in Instrument Serif. Accent: Algodão, no hue (cotton on dark, ink on light).

Everything else is generated from `assets/icon.png` (a 1024 px render of `pottira-icon.svg`):
`node app/src-tauri/icons/tray/generate.mjs`, then `cd app && bun tauri icon ../assets/icon-square.png` (delete the
android/ios folders it adds), and `node app/src-tauri/icons/christmas/generate.mjs` for the Christmas set.
