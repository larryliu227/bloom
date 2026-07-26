# Deploying VOIDLINE

VOIDLINE is **one Node process on one port**. In `NODE_ENV=production` the server
serves the built client out of `dist/client` over HTTP *and* accepts the WebSocket
upgrade on that same port. There is no separate API host, no second container, no
build-time server URL to configure — the client derives its socket URL from the
page origin (`https://` page → `wss://` socket, automatically).

That means every platform below is a one-liner, and "does it work over the
internet" reduces to "is the port reachable".

**Read [Scaling: one instance only](#scaling-one-instance-only) before you touch a
replica count.** Room state is in-process.

---

## Quick reference

| Goal | Command |
|---|---|
| Play with people on your LAN | `npm run dev`, share `http://<your-ip>:5173` |
| Run the real production build locally | `npm run build && npm start` |
| Build the container | `npm run docker:build` |
| Run the container | `npm run docker:run` → http://localhost:8080 |
| Prove a build boots and serves | `npm run build && npm run smoke` |
| Deploy to Fly.io | `fly launch --copy-config --no-deploy && fly deploy` |
| Deploy to Render | push to GitHub → New → Blueprint → Apply |
| Deploy to Railway | `railway init && railway up` |
| Is it alive? | `curl https://<host>/health` |

---

## 1. LAN play (fastest way to get friends in)

Two dev servers: `tsx watch` on `:8080` for the game, Vite on `:5173` for the
client. Vite is already bound to `0.0.0.0` (`server.host: true` in
`vite.config.ts`), so anyone on your network can load it.

```bash
npm install
npm run dev
```

Find the address to hand out:

```bash
# macOS (Wi-Fi; try en1 if en0 is empty)
ipconfig getifaddr en0

# Linux
hostname -I | awk '{print $1}'

# Windows (PowerShell)
(Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'Wi-Fi').IPAddress
```

Teammates open **`http://<that-ip>:5173`**. Vite proxies nothing — the client
opens its own WebSocket to `<same-host>:8080`, which is why this works without
any config.

If nobody can connect:

- Your firewall is blocking inbound 5173/8080. macOS: System Settings → Network →
  Firewall → Options → allow `node`. Windows: allow Node.js on private networks.
- You are on a "guest"/isolated Wi-Fi network that blocks client-to-client
  traffic. Nothing you can fix in code — use one of the hosted options below.
- Only for people **outside** your network: don't port-forward, just deploy. Fly's
  free tier takes about three minutes.

## 2. Production build, locally

This is exactly what the container and every PaaS run:

```bash
npm run build          # tsc --noEmit && vite build  ->  dist/client
npm start              # NODE_ENV=production tsx server/index.ts  ->  :8080
```

Open <http://localhost:8080>. One port serves the page, the assets and the
WebSocket. Verify all three:

```bash
curl -s localhost:8080/health          # {"ok":true,...}
curl -sI localhost:8080/               # 200, text/html
curl -sI localhost:8080/assets/        # (see the hashed names in dist/client/assets)
```

Or let the smoke script do it, on a port that won't collide:

```bash
npm run build && npm run smoke         # boots on :8290, checks /health and /, exits non-zero on failure
PORT=9000 npm run smoke                # pick your own port
```

## 3. Docker

```bash
npm run docker:build                   # docker build -t voidline:latest .
npm run docker:run                     # -p 8080:8080, then open http://localhost:8080
```

Or by hand, with a different host port:

```bash
docker build -t voidline .
docker run --rm -p 3000:8080 -e NODE_ENV=production voidline
docker logs -f <container>             # tick rate, mode status, room stats every 30s
docker inspect --format '{{.State.Health.Status}}' <container>   # healthy
```

Notes on the image:

- Multi-stage: stage 1 installs everything and runs `vite build`; stage 2 carries
  Node 24 (Alpine), `tini`, `ws`, `tsx` + its esbuild binary, the server/shared
  sources, `tsconfig.json` and `dist/client`. About **175 MB** uncompressed
  (~160 MB of that is `node:24-alpine` itself); check with `docker images voidline`.
- Runs as the unprivileged `node` user (uid 1000).
- `tini` is PID 1, so `docker stop` delivers SIGTERM to Node and the server's
  graceful shutdown runs (rooms closed, sockets sent 1001, clean exit).
- `HEALTHCHECK` polls `/health` every 30 s using Node's built-in `fetch` — no
  `curl` in the image.
- The server is run with `node --import tsx server/index.ts` rather than a
  precompiled bundle. The reason is in a comment at the top of the `Dockerfile`:
  `server/modes/index.ts` imports the game modes through a runtime specifier that
  bundlers cannot follow, so a bundled server boots green and then silently
  serves the no-op mode handler. Running the same source as `npm start` costs
  ~11 MB and removes that class of bug entirely.

## 4. Fly.io

Best fit of the three: WebSockets are first-class, the proxy never idle-closes
them, and you control whether the machine is allowed to stop. `fly.toml` is
committed and already correct.

```bash
brew install flyctl                       # or: curl -L https://fly.io/install.sh | sh
fly auth signup                           # or: fly auth login

# First time. --copy-config keeps the committed fly.toml; --no-deploy so you can
# pick a region before anything builds.
fly launch --copy-config --no-deploy --name voidline

fly deploy
fly open                                  # https://voidline.fly.dev
```

Day-to-day:

```bash
fly logs                                  # live server log
fly status                                # machine state, health check
fly ssh console                           # poke around inside
curl https://voidline.fly.dev/health
fly deploy                                # ship an update (brief downtime, see below)
```

Choose a region near your players — latency is the whole game:

```bash
fly platform regions                      # list
fly regions set lhr                       # or edit primary_region in fly.toml
```

What the committed config does and why:

- `internal_port = 8080` matches the Dockerfile's `EXPOSE`/`PORT`.
- `auto_stop_machines = "off"` + `min_machines_running = 1`. Fly's default
  scale-to-zero would suspend the machine on idle, which **drops every open
  WebSocket and destroys every room in memory**, mid-match. Left on, a
  `shared-cpu-1x/512mb` machine is cheap.
- `[[http_service.checks]]` on `/health` with a 15 s grace period.
- Connection soft/hard limits of 400/480 sit under the server's own
  `MAX_SOCKETS = 512`, so Fly stops sending traffic before the server starts
  refusing sockets with close code 1013.
- `strategy = "rolling"` on a single machine means stop → replace → start: a few
  seconds of downtime per deploy, but never two instances alive at once. Deploy
  between matches; players in a live match get disconnected and reconnect into a
  server that no longer has their room.

## 5. Render

```bash
git push                                  # repo must be on GitHub/GitLab
```

Then: Render dashboard → **New** → **Blueprint** → pick the repo → **Apply**.
Render reads `render.yaml`, builds the `Dockerfile`, and gives you
`https://voidline.onrender.com`. Health checks hit `/health`; `autoDeploy` ships
every push to the default branch.

- Edit `region:` in `render.yaml` (`oregon`, `ohio`, `virginia`, `frankfurt`,
  `singapore`) before applying.
- WebSockets work on every Render plan, including free.
- **Free plans spin down after ~15 minutes of inactivity** and cold-start in
  30–60 s. All rooms are lost on spin-down, and the first player to arrive waits
  out the cold start. `plan: starter` avoids it.
- Render injects `PORT`; the server already reads `process.env.PORT`. The value in
  `render.yaml` just keeps everything in agreement.

## 6. Railway

```bash
npm i -g @railway/cli
railway login
railway init                              # create/select a project
railway up                                # builds the Dockerfile, deploys
railway domain                            # mint a public https:// URL
railway logs
```

`railway.json` pins the Dockerfile builder, `numReplicas: 1`, the `/health` check,
`sleepApplication: false` (do not idle-sleep a game server), `overlapSeconds: 0`
so a redeploy never runs two instances at once, and `drainingSeconds: 15` to give
the graceful shutdown room to finish.

Railway injects `PORT` at runtime; `NODE_ENV=production` comes from the image's
`ENV`, so there are no dashboard variables to set. Railway's config file does not
carry env vars — if you need extras, add them in the service's **Variables** tab.

## TLS and `wss://`

You never configure this. Fly, Render and Railway all terminate TLS at their edge
and forward plain HTTP to `$PORT` inside the container. The browser therefore
loads the page over `https://`, and the client picks its scheme from the page:

- `https://` page → `wss://<same host>` — encrypted, works everywhere.
- `http://` page → `ws://<same host>` — fine on LAN and localhost.

Consequences worth knowing:

- A page served over `https://` **cannot** open a plain `ws://` socket; browsers
  block mixed content. Since both come from the same origin, this can only bite
  you if you put a custom proxy in front — make sure it upgrades WebSockets and
  passes `Connection: upgrade` / `Upgrade: websocket` through.
- Rolling your own nginx/Caddy in front? The server pings every 15 s
  (`HEARTBEAT_INTERVAL_MS`), which keeps a default 60 s `proxy_read_timeout`
  happy — but nginx also needs the explicit upgrade headers
  (`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";
  proxy_http_version 1.1;`) or the handshake 400s. Caddy's `reverse_proxy`
  handles upgrades correctly with no extra config.
- Escape hatch: the client accepts `?server=` to point at a different game server
  (`?server=example.com:8080`, or a full `wss://…` URL). Handy for testing a
  staging server from a production page — and, on an `https://` page, remember
  the override must be `wss://`.
- Custom domains: `fly certs add play.example.com`, or the Custom Domain panel on
  Render/Railway. Certificates are issued for you.

## Environment variables

Only two matter.

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` (`DEFAULT_PORT`) | The one port: HTTP + WebSocket. Every PaaS sets this for you; an invalid value falls back to 8080. |
| `NODE_ENV` | unset | **Must be `production`** for the server to serve `dist/client`. Unset/`development` makes `/` return a plain-text banner instead of the game, which looks exactly like a broken deploy. Set in the `Dockerfile`, `fly.toml` and `render.yaml`. |

There are no secrets, no database URL and no API keys. Nothing to leak.

## Checking a deployment

```bash
curl -s https://voidline.fly.dev/health | python3 -m json.tool
```

```json
{
  "ok": true,
  "protocol": "1.0.0",
  "uptimeSec": 412,
  "sockets": 3,
  "rooms": 1,
  "players": 2,
  "byMode": { "pvp_duel": 1, "pvp_arena": 0, "coop_story": 0 },
  "playing": 1,
  "modes": { "coop_story": true, "pvp_duel": true, "pvp_arena": true }
}
```

Read it like this:

- `protocol` must match what the client was built with. A mismatch makes the
  server reject `hello` with `version_mismatch` — you deployed a client and a
  server from different commits, or a player has a stale tab. Tell them to reload.
- `modes` — any `false` means that mode module failed to load and is running the
  no-op fallback: the lobby works, the match does nothing. Check `fly logs` for
  `[modes]`.
- `uptimeSec` resetting on its own means the platform is restarting or
  idle-stopping your instance. On Fly, check `auto_stop_machines`. On Render free,
  that is the spin-down.
- `sockets` counts every live connection including ones that never handshook;
  `players` counts people actually in rooms.

Then do the thing the health check can't: open the URL in two browsers, create a
room in one, join by code in the other, and play a round.

## Scaling: one instance only

**All game state is in this process's memory.** `Matchmaking` owns the rooms, each
`Room` owns its players, their weave boards and the simulated world. Nothing is
persisted; there is no Redis, no shared store, no cross-instance messaging.

So: **do not run more than one instance without sticky routing.** With two
instances behind a normal round-robin load balancer, a room created on instance A
does not exist on instance B, and "join by code" fails for roughly half of your
players, at random, with no useful error. Quick Play silently splits your
population into two pools.

The committed configs all pin a single instance (`min_machines_running = 1` +
`auto_stop_machines = "off"`, `numInstances: 1`, `numReplicas: 1`). Leave them.

To actually grow:

1. **Scale up, not out.** One machine handles a lot: the sim is 20 Hz, the state
   is small, and `MAX_SOCKETS` is 512. Give it more CPU/RAM
   (`fly scale vm shared-cpu-2x --memory 1024`) long before adding instances.
2. **Multiple independent regions.** Run separate apps per region
   (`voidline-lhr`, `voidline-syd`) and let players pick. Each is its own island
   of rooms, which for a session-based arena game is a perfectly good answer.
3. **Real horizontal scale** would need room ownership moved out of process: a
   room→instance directory in Redis and either socket routing to the owning
   instance or a stateless front door. That is a design change, not a config flag.

## Honest limitations

- **Restart = everyone drops.** No state survives a deploy or a crash. A dropped
  player's slot is held for ~20 s for reconnects, but that only helps if the
  server is still alive. Deploy between matches.
- **No persistence.** No accounts, no stats, no match history, no leaderboard.
  Room codes are ephemeral.
- **No auth or rate limiting on room creation.** Anyone with the URL can spam
  rooms up to the socket cap. Fine among friends, not hardened for a public link
  posted somewhere large. The socket cap (512) and idle-room sweeper are the only
  brakes.
- **Names are the only identity.** `sanitizeName` cleans them up; nothing stops
  two people using the same one.
- **Latency is not hidden.** The client predicts local movement and interpolates
  remote entities 100 ms in the past, which is solid on a nearby region and
  visibly rubbery from another continent. Region choice matters more than
  anything else in this document.
- **Single point of failure by design.** One process, one machine. If it dies,
  the game is down until the platform restarts it (seconds, automatically).
