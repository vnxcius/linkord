// Pottira used to be called Linkord, and this device's saved data (sign-in, prefs, last place, open folders, ...)
// is still under the old name's keys. This moves every one of them to `pottira.*` before anything reads storage,
// so it is the first import of each entry point (index.tsx, clip-page.tsx). A key already saved under the new name
// wins. The old public address is gone too: a server saved as that address becomes the default again.
// Safe to delete once every installed app has started a 2.0 build at least once.
const OLD = 'linkord.';
const NEW = 'pottira.';
const OLD_ADDRESS = /^https:\/\/old\.example\.com\/?$/;

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
