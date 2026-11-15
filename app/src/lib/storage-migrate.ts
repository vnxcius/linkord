// Linkord was briefly called Pottira (2.0.0), and devices that ran it keep their saved data (sign-in, prefs, last
// place, open folders, ...) under `pottira.*` keys. This moves every one of them back to `linkord.*` before anything
// reads storage, so it is the first import of each entry point (index.tsx, clip-page.tsx). A key already saved under
// the current name wins. Apps older than 2.0 never renamed anything, so they need nothing here.
// The old public addresses are gone too: a server saved as one of them becomes the default again.
// Safe to delete once every installed app has started a build with this file at least once.
const OLD = 'pottira.';
const NEW = 'linkord.';
const OLD_ADDRESS = /^https:\/\/(pottira\.com|old\.example\.com)\/?$/;

for (const get of [() => localStorage, () => sessionStorage]) {
  try {
    const store = get();
    for (const key of Object.keys(store)) {
      if (!key.startsWith(OLD)) continue;
      const value = store.getItem(key);
      const renamed = NEW + key.slice(OLD.length);
      if (value !== null && store.getItem(renamed) === null) store.setItem(renamed, value);
      store.removeItem(key);
    }
  } catch {}
}

try {
  const server = localStorage.getItem(`${NEW}server`);
  if (server && OLD_ADDRESS.test(server)) localStorage.removeItem(`${NEW}server`);
} catch {}

export {};
