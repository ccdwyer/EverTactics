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
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
});
