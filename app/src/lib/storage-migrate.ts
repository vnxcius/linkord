// 1.x apps saved the server as old.example.com, an address that's gone: a server saved as it becomes the default
// again. Runs before anything reads storage, so it is the first import of each entry point (index.tsx, clip-page.tsx).
// Safe to delete once every installed app has started a build with this file at least once.
const OLD_ADDRESS = /^https:\/\/old\.example\.com\/?$/;

try {
  const server = localStorage.getItem('linkord.server');
  if (server && OLD_ADDRESS.test(server)) localStorage.removeItem('linkord.server');
} catch {}

export {};
