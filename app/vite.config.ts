import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
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

export default defineConfig({
  plugins: [solid(), tailwindcss(), dictionaries()],
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
  worker: { format: 'es' },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 600,
  },
});
