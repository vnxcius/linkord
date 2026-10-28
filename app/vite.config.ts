import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  plugins: [solid(), tailwindcss()],
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
