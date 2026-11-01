import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

const monitor = process.env.MONITOR_URL ?? 'http://127.0.0.1:7710';

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 1430,
    proxy: {
      '/api': { target: monitor, changeOrigin: true },
      '/media': { target: monitor, changeOrigin: true },
    },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 800 },
});
