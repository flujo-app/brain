import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Base is set for GitHub Pages project sites (flujo-app.github.io/brain/).
// Override with BRAIN_BASE=/ for local root hosting.
export default defineConfig({
  base: process.env.BRAIN_BASE ?? './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        lobby: resolve(__dirname, 'lobby.html'),
      },
    },
  },
  server: {
    proxy: {
      // Same-origin path to FLUJO, mirroring the brain-manager proxy in the
      // Docker bundle. Needed because FLUJO's /v1 conversation + SSE
      // endpoints send no CORS headers, so the execution watcher can't call
      // them cross-origin.
      '/flujo': {
        target: process.env.FLUJO_URL ?? 'http://localhost:4200',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/flujo/, ''),
      },
      // brain-manager (lobby API, per-brain proxies, brain-stem MCP).
      '/api': { target: process.env.MANAGER_URL ?? 'http://localhost:8090', changeOrigin: true },
      '/brains': { target: process.env.MANAGER_URL ?? 'http://localhost:8090', changeOrigin: true },
    },
  },
});
