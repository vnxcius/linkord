// Patch notes for a release, from the commit subjects since the last one (Conventional Commits, CLAUDE.md):
// feat / fix / perf commits that touched the app's files, one line each, oldest first, without the type and scope.
//   node deploy/ci/notes.mjs desktop|android <from-sha> <to-sha>
// Commits scoped to another platform are left out (a "fix(android): ..." touching pt-BR.ts isn't a desktop note).
import { execFileSync } from 'node:child_process';

const PATHS = {
  desktop: ['app', ':!app/*.md', ':!app/publish-*.sh'],
  // pt-BR.ts alone triggers an Android release (the strings), but its commits are usually about the other clients.
  android: ['android', ':!android/**/*.md'],
};
const OTHER_SCOPES = {
  desktop: /^(android|monitor|server|ci|deploy)$/,
  android: /^(desktop|windows|linux|web|monitor|server|ci|deploy|rec|overlay)$/,
};

export function notesFrom(subjects, target) {
  const lines = [];
  for (const s of subjects) {
    const m = /^(\w+)(?:\(([^)]*)\))?(!)?: (.+)$/.exec(s.trim());
    if (!m || !['feat', 'fix', 'perf'].includes(m[1])) continue;
    if (m[2] && OTHER_SCOPES[target]?.test(m[2])) continue;
    const text = m[4].replace(/^\w/, (c) => c.toUpperCase());
    if (!lines.includes(text)) lines.push(text);
  }
  return lines.length ? lines.join('\n') : 'Bug fixes and improvements';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [target, from, to] = process.argv.slice(2);
  if (!PATHS[target] || !from || !to) {
    console.error('usage: notes.mjs desktop|android <from> <to>');
    process.exit(2);
  }
  const out = execFileSync(
    'git',
    ['log', '--no-merges', '--reverse', '--format=%s', `${from}..${to}`, '--', ...PATHS[target]],
    { encoding: 'utf8', cwd: new URL('../..', import.meta.url).pathname },
  );
  console.log(notesFrom(out.split('\n').filter(Boolean), target));
}
