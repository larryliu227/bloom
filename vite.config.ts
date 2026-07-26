import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@client': fileURLToPath(new URL('./client', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true, // expose on LAN so you can play with people on your network
  },
  build: {
    target: 'es2022',
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});
