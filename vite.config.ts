import { defineConfig } from 'vite';

// Base is set for GitHub Pages project sites (flujo-app.github.io/brain/).
// Override with BRAIN_BASE=/ for local root hosting.
export default defineConfig({
  base: process.env.BRAIN_BASE ?? './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
});
