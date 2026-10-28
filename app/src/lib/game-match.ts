// Matches running executables against Discord's detectable-games list, the way Discord does: an entry like
// "win64/cs2.exe" matches any path ending in that (case-insensitive, either slash); ">javaw.exe" matches the
// file name exactly. Kept free of imports so it can be unit-tested in Node (tests/games.test.mjs).

/** As served by /api/activities/detectable: [application id, name, icon hash, executables]. */
export type DetectableGame = [id: string, name: string, icon: string, exes: string[]];

export interface GameIndex {
  /** Executable file name -> games with an entry ending in it. */
  byFile: Map<string, { game: DetectableGame; pattern: string; exact: boolean }[]>;
}

export const normalizePath = (path: string) => path.toLowerCase().replace(/\\/g, '/');
const fileOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export function buildIndex(list: DetectableGame[]): GameIndex {
  const byFile: GameIndex['byFile'] = new Map();
  for (const game of list) {
    for (const raw of game[3]) {
      const exact = raw.startsWith('>');
      const pattern = normalizePath(exact ? raw.slice(1) : raw);
      const file = fileOf(pattern);
      if (!file) continue;
      let entries = byFile.get(file);
      if (!entries) byFile.set(file, (entries = []));
      entries.push({ game, pattern, exact });
    }
  }
  return { byFile };
}

/** The detectable game a process path belongs to, if any. */
export function matchPath(index: GameIndex, path: string): DetectableGame | undefined {
  const p = normalizePath(path);
  const file = fileOf(p);
  for (const e of index.byFile.get(file) ?? []) {
    if (e.exact ? file === e.pattern : p === e.pattern || p.endsWith(`/${e.pattern}`)) return e.game;
  }
  return undefined;
}

/** Discord's CDN icon for a detectable game (same URL the server puts in the activity). */
export const gameIconUrl = (game: DetectableGame, size = 128) => (game[2] ? `https://cdn.discordapp.com/app-icons/${game[0]}/${game[2]}.png?size=${size}` : undefined);
