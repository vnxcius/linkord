#!/usr/bin/env node
// The Android app's translations come from the web client's dictionary (app/src/lib/locales/pt-BR.ts), keyed by the
// English text like t() there. Writes <out>/i18n/pt-BR.json; the app's build runs this (app/build.gradle.kts
// genStrings), so the dictionary stays one file. Usage: node android/scripts/gen-strings.mjs <out dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = process.argv[2];
if (!out) throw new Error('usage: gen-strings.mjs <out dir>');
const { UI, SERVER } = await import(pathToFileURL(join(root, 'app/src/lib/locales/pt-BR.ts')).href);
mkdirSync(join(out, 'i18n'), { recursive: true });
writeFileSync(join(out, 'i18n', 'pt-BR.json'), JSON.stringify({ ui: UI, server: SERVER }));
console.log(`pt-BR: ${Object.keys(UI).length} UI strings, ${Object.keys(SERVER).length} server messages`);
