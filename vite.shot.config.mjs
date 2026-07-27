// TEMPORARY: HMR-free dev server for the screenshot loop while several agents edit
// concurrently. Delete when done.
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@render': fileURLToPath(new URL('./src/render', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
      '@state': fileURLToPath(new URL('./src/state', import.meta.url)),
    },
  },
  server: { port: 5199, strictPort: true, hmr: false, watch: null },
});
