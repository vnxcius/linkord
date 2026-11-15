import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';
import { readdirSync, readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import pkg from './package.json' with { type: 'json' };

/**
 * Spellcheck dictionaries at /dictionaries/<lang>.<aff|dic> (lib/spellcheck.ts). Only the web build carries them
 * (~7 MB); the desktop app downloads the language it uses from the server, keeping the installer small.
 */
function dictionaries(): Plugin {
  const file = (lang: string, ext: string) => readFileSync(`node_modules/dictionary-${lang}/index.${ext}`);
  const names = ['en', 'pt', 'es'].flatMap((lang) => ['aff', 'dic'].map((ext) => [lang, ext] as const));
  return {
    name: 'linkord-dictionaries',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/dictionaries\/(en|pt|es)\.(aff|dic)$/);
        if (!m) return next();
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(file(m[1], m[2]));
      });
    },
    generateBundle() {
      if (process.env.TAURI_ENV_PLATFORM) return;
      for (const [lang, ext] of names)
        this.emitFile({ type: 'asset', fileName: `dictionaries/${lang}.${ext}`, source: file(lang, ext) });
    },
  };
}

/**
 * The Christmas theme's background music at /christmas-music/<track>.mp3 (lib/christmas-music.ts). Like the dictionaries,
 * only the web build carries it (~18 MB); the desktop app streams it from the server.
 */
function christmasMusic(): Plugin {
  const tracks = () => readdirSync('music/christmas').filter((f) => f.endsWith('.mp3'));
  return {
    name: 'linkord-christmas-music',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/christmas-music\/([a-z-]+\.mp3)$/);
        if (!m || !tracks().includes(m[1])) return next();
        res.setHeader('content-type', 'audio/mpeg');
        res.end(readFileSync(`music/christmas/${m[1]}`));
      });
    },
    generateBundle() {
      if (process.env.TAURI_ENV_PLATFORM) return;
      for (const f of tracks())
        this.emitFile({
          type: 'asset',
          fileName: `christmas-music/${f}`,
          source: readFileSync(`music/christmas/${f}`),
        });
    },
  };
}

/**
 * hunspell-asm's ESM build (and its emscripten-wasm-loader) import CommonJS functions as namespaces and then call
 * them (`import * as nanoid from 'nanoid'; nanoid()`, the same with the Emscripten runtime), which only works with
 * CommonJS interop. Default imports instead. It runs in the spellcheck worker, so workers get this plugin too.
 */
function fixHunspellAsm(): Plugin {
  const namespaces = /import \* as (nanoid|runtime) from ('[^']+')/g;
  return {
    name: 'linkord-hunspell-asm',
    transform(code, id) {
      if (!/hunspell-asm|emscripten-wasm-loader/.test(id) || !namespaces.test(code)) return;
      namespaces.lastIndex = 0;
      return code.replace(namespaces, 'import $1 from $2');
    },
  };
}

export default defineConfig({
  plugins: [solid(), tailwindcss(), dictionaries(), christmasMusic(), fixHunspellAsm()],
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: 1420,
    strictPort: true,
    // In dev, the web client talks to the local server through the vite proxy.
    proxy: {
      '/api': { target: 'http://127.0.0.1:7700', ws: true },
      '/uploads': 'http://127.0.0.1:7700',
    },
  },
  // Voice runs in a module worker (Opus/WASM) plus audio worklets.
  worker: { format: 'es', plugins: () => [fixHunspellAsm()] },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 600,
    // clip.html: the custom player of the public clip page (src/clip-page.tsx; the server reads its tags).
    rollupOptions: { input: { main: 'index.html', clip: 'clip.html' } },
  },
});
