import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: 5174, // BLOOM sits on 5173; both can run at once
    host: true, // expose on the LAN so a phone can join
    /*
     * The client always talks to `/ws` on whatever origin served it. In production
     * one node process does both, so that is already true; in development this
     * proxy makes it true as well, and there is nothing to configure anywhere.
     */
    proxy: {
      '/ws': { target: `ws://localhost:${process.env.PORT ?? 8081}`, ws: true, rewriteWsOrigin: true },
    },
  },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});
