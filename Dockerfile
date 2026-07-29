# syntax=docker/dockerfile:1
#
# VOIDLINE — production image.
#
# One process, one port. The server serves the built client out of `dist/client`
# over HTTP *and* accepts the WebSocket upgrade on the same socket, so there is
# nothing to reverse-proxy and no second container to run.
#
# ---------------------------------------------------------------------------
# Why `tsx` at runtime instead of compiling the server
# ---------------------------------------------------------------------------
# `server/modes/index.ts` loads the game modes through a *runtime* specifier:
#
#     const COOP_SPECIFIER = './coop.js';
#     await import(COOP_SPECIFIER)            // deliberately opaque to bundlers
#
# That indirection is intentional (a broken mode module must degrade to
# NullModeHandler instead of killing the server), but it means a bundler cannot
# see the dependency. Pre-bundling with esbuild produces a binary that boots
# fine, passes /health, and then *silently* serves the null mode: no enemies, no
# scoring, matches that never end. Verified: the emitted bundle keeps a bare
# `await import(COOP_SPECIFIER)` that resolves next to the bundle and misses.
#
# Compiling with `tsc` is no better: the project is `noEmit` and the server
# imports through the `@shared/*` path alias, which `tsc` does not rewrite.
#
# So the runtime image runs the exact same source that `npm start` runs locally,
# under `tsx`. The price is ~11 MB (tsx + its esbuild binary) on top of the Node
# base; the payoff is zero dev/prod divergence. Everything else that `npm ci`
# pulls in (typescript, vite, rollup, concurrently) stays in the build stage.
#
# Final image: ~175 MB uncompressed / ~70 MB pulled — node:24-alpine (~160 MB)
# plus ~12 MB of tini + node_modules + sources + dist/client. Measure with
# `docker images voidline:latest` after the first build.
#
#   docker build -t voidline .
#   docker run --rm -p 8080:8080 voidline     # then open http://localhost:8080

ARG NODE_VERSION=24-alpine

# ---------------------------------------------------------------------------
# Stage 1 — build the client (and warm the full dependency tree)
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS build

WORKDIR /app
ENV CI=true

# Deps first so the layer caches until the lockfile actually changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Everything Vite needs to produce dist/client.
COPY tsconfig.json vite.config.ts index.html ./
# `public/` is empty, and git does not track empty directories — so this COPY was
# fine locally and failed on every clean checkout with "/public: not found". It is
# kept alive by `public/.gitkeep`; delete that only if you also delete this line and
# `publicDir` in vite.config.ts.
COPY public ./public
COPY shared ./shared
COPY client ./client
COPY server ./server

RUN npx vite build && test -f dist/client/index.html

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime

# tini is PID 1: it forwards SIGTERM/SIGINT to node (so the server's graceful
# shutdown actually runs) and reaps zombies. Without it PID 1 is node, which
# does get our handlers, but any future wrapper script would swallow signals.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app

# Runtime deps only: `ws` is the single production dependency.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# tsx + its esbuild binary, lifted from the build stage rather than installed,
# so the lockfile-pinned versions are used and no dev tree is unpacked here.
# tsx@4 depends on esbuild only; if that ever changes this COPY fails loudly at
# build time rather than at boot.
COPY --from=build /app/node_modules/tsx ./node_modules/tsx
COPY --from=build /app/node_modules/esbuild ./node_modules/esbuild
COPY --from=build /app/node_modules/@esbuild ./node_modules/@esbuild

# Server source + the tsconfig that defines the @shared/* alias tsx resolves.
COPY tsconfig.json ./
COPY shared ./shared
COPY server ./server

# The built client, served by the same process on the same port.
COPY --from=build /app/dist/client ./dist/client

# `node` (uid 1000) ships with the base image. Nothing here needs to be writable.
RUN chown -R node:node /app
USER node

EXPOSE 8080

# The server answers /health with JSON as soon as it is listening. Node is
# already in the image, so no curl/wget dependency.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# `node --import tsx` keeps node as the direct child of tini — one process, and
# SIGTERM lands on the handler in server/index.ts.
CMD ["node", "--import", "tsx", "server/index.ts"]
