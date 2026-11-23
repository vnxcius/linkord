# Linkord brand sources

- `linkord-icon.svg`: the app icon. Two white wings (#efece6) around the gold Triforce (#f6bd2e) on the graphite tile
  (#18181c), corner radius 108/512. The Triforce is always equilateral; its three pieces join with solid bridges
  (the cut-out is the middle triangle about 20% smaller).
- `linkord-icon-light.svg`: the same on a light tile (#f3f0ea) with ink wings (#1d1c20) and a deeper gold (#e0a21b),
  for light backgrounds and print.
- `linkord-mark.svg` / `linkord-mark-ink.svg`: the wings and Triforce alone, on transparent.

The first version was made with an image AI (November 2026); it was traced and redrawn here: each wing is two
feathers merged into one shape with a V notch, the inner ends follow the Triforce's sides. The app's accent is still
Algodão, no hue (cotton on dark, ink on light): the icon's gold stays in the icon.

Everything else is generated:
1. `node design/render.mjs`: assets/icon.png (1024), app/src/assets/emblem.png, the web icons in app/public and the
   monitor's (monitor/web).
2. `node app/src-tauri/icons/tray/generate.mjs`: the tray icons and assets/icon-square.png, then
   `cd app && bun tauri icon ../assets/icon-square.png` (delete the android/ios folders it adds).
3. `node app/src-tauri/icons/christmas/generate.mjs`, then
   `cd app && bun tauri icon ../assets/icon-christmas-square.png -o src-tauri/icons/christmas/tmp` (keep tmp/icon.ico as
   icons/christmas/icon.ico, delete the rest).
