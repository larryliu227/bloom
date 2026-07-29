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
    /*
     * The client always talks to `/ws` on whatever origin it was loaded from. In
     * production one node process serves both, so that is already true; in
     * development this proxy makes it true as well.
     *
     * The alternative — teaching the client the server's host and port — means a
     * different URL in dev, in prod, and on every phone on the LAN, and each one is
     * something that can be wrong. There is nothing to configure this way.
     */
    proxy: {
      '/ws': {
        target: `ws://localhost:${process.env.PORT ?? 8080}`,
        ws: true,
        // A dev server restart should not kill the page with a proxy error.
        rewriteWsOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});
