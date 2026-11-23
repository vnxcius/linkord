// Apps saved the server's address, and an address the server no longer has (VITE_FORMER_SERVERS) would leave them
// stranded: a server saved as one becomes the default again. Runs before anything reads storage, so it is the first
// import of each entry point (index.tsx, clip-page.tsx).
const former = (import.meta.env.VITE_FORMER_SERVERS || '')
  .split(',')
  .map((s: string) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

try {
  const server = localStorage.getItem('linkord.server')?.replace(/\/+$/, '');
  if (server && former.includes(server)) localStorage.removeItem('linkord.server');
} catch {}

export {};
