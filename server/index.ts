/**
 * VOIDLINE — server entry point.
 *
 * One HTTP server, one WebSocket server riding its upgrade, one `setInterval`
 * at TICK_RATE that drives every room with a real measured delta. In production
 * the same port also serves the built client out of `dist/client`, so shipping
 * is `npm run build && npm start` and nothing else.
 *
 * Message routing lives here: the handshake, room creation/joining, and then
 * everything else is handed to the room the client is standing in.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import {
  DEFAULT_PORT,
  HEARTBEAT_INTERVAL_MS,
  TICK_MS,
  TICK_RATE,
} from '@shared/constants.js';
import { PROTOCOL_VERSION } from '@shared/protocol.js';
import type { ClientMsg } from '@shared/protocol.js';
import type { PlayerId } from '@shared/types.js';

import { Matchmaking, isGameMode, normalizeRoomCode } from './matchmaking.js';
import { loadModeModules, modeStatus } from './modes.js';
import { Client, isPlayerId, newPlayerId, sanitizeName } from './net.js';

const PORT = readPort();
const PRODUCTION = process.env.NODE_ENV === 'production';
const CLIENT_DIR = resolve(process.cwd(), 'dist', 'client');
const MAX_SOCKETS = 512;
const STATS_INTERVAL_MS = 30_000;
const SWEEP_INTERVAL_MS = 10_000;
/**
 * How long a freshly-accepted socket has to complete the `hello` handshake before
 * it is dropped. Without this, a peer can open a connection, never say `hello`, and
 * sit forever: the heartbeat only detects *dead* sockets, and the `ws` library
 * auto-answers protocol pings, so an idle-but-alive peer never trips it. An attacker
 * could hold the entire MAX_SOCKETS budget open without ever handshaking.
 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

const matchmaking = new Matchmaking();
/** Every live socket, including ones that have not said `hello` yet. */
const sockets = new Set<Client>();
/** Handshaken clients, by player id. */
const byId = new Map<PlayerId, Client>();

// ---------------------------------------------------------------------------
// HTTP

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/health') {
    const stats = matchmaking.stats();
    sendJson(res, 200, {
      ok: true,
      protocol: PROTOCOL_VERSION,
      uptimeSec: Math.round(process.uptime()),
      sockets: sockets.size,
      ...stats,
      modes: modeStatus(),
    });
    return;
  }

  if (!PRODUCTION) {
    sendText(res, 200, `BLOOM server — protocol ${PROTOCOL_VERSION}\nWebSocket endpoint: ws://<host>:${PORT}\nRun the client with: npm run dev:client\n`);
    return;
  }

  serveStatic(url.pathname, req, res).catch((err) => {
    console.error('[http] static failed:', err);
    sendText(res, 500, 'Internal error');
  });
});

/*
 * Snapshots are JSON and highly repetitive, so they compress extremely well:
 * measured 6.6-7.3x on real 8-player and heavy-co-op payloads. Uncompressed this
 * costs ~1.46 Mbps down per client (peaks ~2.5 Mbps) — fine on loopback, needlessly
 * hostile on LTE, and the first wall a single process hits is NIC egress
 * (~800 Mbps at 60 full arenas), not CPU or tick time. Compression trades spare
 * CPU for the resource we actually run out of.
 *
 * Tuned deliberately rather than defaulted:
 *  - level 3: most of the ratio for a fraction of level-9 CPU. These are 3-30 KB
 *    frames sent 20x/sec per client, so per-frame cost matters more than ratio.
 *  - concurrencyLimit caps simultaneous zlib jobs so a burst cannot starve the
 *    tick loop; zlib runs off-thread, the tick loop must not wait on it.
 *  - threshold: tiny control messages (pong, lobby deltas) skip deflate entirely.
 *  - context takeover left ON (the default): consecutive snapshots are nearly
 *    identical, which is exactly what the sliding window exploits.
 * Note this does give up part of the serialize-once/send-many win, since `ws`
 * deflates per socket — see the memLevel cap keeping per-socket state modest.
 */
const wss = new WebSocketServer({
  server: http,
  maxPayload: 64 * 1024,
  perMessageDeflate: {
    zlibDeflateOptions: { level: 3, memLevel: 7 },
    concurrencyLimit: 8,
    threshold: 512,
  },
});

// ---------------------------------------------------------------------------
// Connections

wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
  if (sockets.size >= MAX_SOCKETS) {
    socket.close(1013, 'server full');
    return;
  }

  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const remote = req.socket.remoteAddress ?? 'unknown';

  // A returning player may present their previous id up front, either as a
  // query parameter or on the `hello` message. Either way it is only honoured
  // if nobody is currently using it.
  const requested = query.get('pid');
  const id = isPlayerId(requested) && !byId.has(requested) ? requested : newPlayerId();

  const client = new Client(socket, id, sanitizeName(query.get('name')), remote);
  sockets.add(client);

  // Drop the socket if it never finishes the handshake. Cleared on close so a
  // handshaken (or already-gone) socket is never touched by it.
  const handshakeTimer = setTimeout(() => {
    if (!client.helloDone) client.close(4008, 'handshake timeout', 'timeout');
  }, HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref?.();

  client.onMessage = (c, msg) => route(c, msg);
  client.onClose = (c) => {
    clearTimeout(handshakeTimer);
    teardown(c);
  };
});

function teardown(client: Client): void {
  sockets.delete(client);
  if (byId.get(client.id) === client) byId.delete(client.id);
  const room = matchmaking.get(client.roomId);
  // `hold: true` — if the match is live the room keeps their slot warm.
  room?.leave(client, true);
}

// ---------------------------------------------------------------------------
// Routing

function route(client: Client, msg: ClientMsg): void {
  if (!client.helloDone) {
    if (msg.t !== 'hello') {
      client.error('handshake_required', 'Send `hello` before anything else.');
      return;
    }
    handleHello(client, msg);
    return;
  }

  switch (msg.t) {
    case 'hello':
      client.error('already_connected', 'Handshake already completed.');
      return;

    case 'createRoom': {
      if (!isGameMode(msg.mode)) {
        client.error('bad_mode', 'Unknown game mode.');
        return;
      }
      partFromCurrentRoom(client);
      const room = matchmaking.createRoom(msg.mode, {
        level: typeof msg.level === 'number' ? msg.level : 1,
        isPublic: false,
      });
      if (!room.join(client)) {
        matchmaking.destroyRoom(room);
        client.error('join_failed', 'Could not create the room.');
      }
      return;
    }

    case 'joinRoom': {
      const code = normalizeRoomCode(msg.roomId);
      if (!code) {
        client.error('bad_code', 'Room codes are 6 characters.');
        return;
      }
      const room = matchmaking.get(code);
      if (!room || room.closed) {
        client.error('no_such_room', `No room with code ${code}.`);
        return;
      }
      if (room.clients.has(client.id)) return;
      partFromCurrentRoom(client);
      if (!room.join(client)) {
        client.error('room_unavailable', 'That room is full or already in progress.');
      }
      return;
    }

    case 'quickPlay': {
      if (!isGameMode(msg.mode)) {
        client.error('bad_mode', 'Unknown game mode.');
        return;
      }
      partFromCurrentRoom(client);
      matchmaking.quickPlay(client, msg.mode);
      return;
    }

    case 'leaveRoom': {
      partFromCurrentRoom(client);
      return;
    }

    case 'ping': {
      const room = matchmaking.get(client.roomId);
      if (room) room.handle(client, msg);
      else client.send({ t: 'pong', ts: msg.ts, serverTime: Date.now() });
      return;
    }

    default: {
      const room = matchmaking.get(client.roomId);
      if (!room) {
        // Taps arriving after a room closed are normal; do not spam the client.
        if (msg.t !== 'tap') {
          client.error('not_in_room', 'You are not in a room.');
        }
        return;
      }
      room.handle(client, msg);
    }
  }
}

function handleHello(client: Client, msg: Extract<ClientMsg, { t: 'hello' }>): void {
  const version = typeof msg.version === 'string' ? msg.version : '';
  if (version !== PROTOCOL_VERSION) {
    client.send({
      t: 'error',
      code: 'version_mismatch',
      message: `Server protocol is ${PROTOCOL_VERSION}; you sent "${version || 'nothing'}". Reload the page.`,
    });
    client.close(1002, 'version mismatch', 'protocol');
    return;
  }

  /*
   * Optional reconnect credential.
   *
   * This MUST be the secret `reconnectToken` from `welcome`, never a PlayerId.
   * PlayerIds ride in every snapshot to every co-player, so keying adoption on one
   * allowed an attacker to harvest a victim's id off the wire, wait for them to
   * drop, and seize both their live entity and their private Weave board.
   * `claimHeldSlot` resolves a slot only on an exact token match.
   */
  const offered = (msg as { token?: unknown }).token;
  if (typeof offered === 'string' && offered.length > 0) {
    const claim = matchmaking.claimHeldSlot(offered);
    if (claim && claim.playerId !== client.id && !byId.has(claim.playerId)) {
      client.adoptSession(claim.playerId, offered);
    }
  }

  // An old socket for the same identity is stale by definition — evict it.
  const previous = byId.get(client.id);
  if (previous && previous !== client) {
    previous.close(4000, 'replaced by a newer session', 'protocol');
  }

  client.name = sanitizeName(msg.name);
  client.helloDone = true;
  byId.set(client.id, client);
  client.send({
    t: 'welcome',
    playerId: client.id,
    version: PROTOCOL_VERSION,
    reconnectToken: client.reconnectToken,
  });

  const held = matchmaking.heldRoomFor(client.id);
  if (held && held.join(client)) {
    console.log(`[server] ${client.name} (${client.id}) reconnected into room ${held.id}`);
  }
}

/** Leave the current room for good (an explicit departure never holds a slot). */
function partFromCurrentRoom(client: Client): void {
  const room = matchmaking.get(client.roomId);
  matchmaking.forgetHeld(client.id);
  if (room) room.leave(client, false);
  client.roomId = null;
  // A room that just lost its last live socket is only kept alive so a dropped
  // player can reconnect — but this was an explicit departure (forgetHeld above),
  // so nobody is coming back to it. Reap it now instead of leaving an empty husk
  // for the 60s sweep TTL. Without this, one socket spamming `createRoom` (each
  // call abandons the prior room) could pile up thousands of empty rooms inside
  // the reaper's window — a cheap memory-exhaustion vector.
  if (room && !room.closed && room.clients.size === 0) matchmaking.destroyRoom(room);
}

// ---------------------------------------------------------------------------
// The tick loop — one timer for the whole process

let lastTickAt = performance.now();

const tickTimer = setInterval(() => {
  const now = performance.now();
  // Real measured delta, clamped so a GC pause or a laptop lid cannot teleport
  // the world a whole second forward.
  const dt = Math.min(0.25, Math.max(0, (now - lastTickAt) / 1000));
  lastTickAt = now;

  for (const room of matchmaking.all()) {
    try {
      room.tick(dt);
    } catch (err) {
      console.error(`[server] room ${room.id} tick failed:`, err);
    }
  }
}, TICK_MS);

const heartbeatTimer = setInterval(() => {
  for (const client of [...sockets]) {
    if (!client.heartbeat()) sockets.delete(client);
  }
}, HEARTBEAT_INTERVAL_MS);

const sweepTimer = setInterval(() => {
  const reaped = matchmaking.sweep();
  if (reaped > 0) console.log(`[server] reaped ${reaped} idle room(s)`);
}, SWEEP_INTERVAL_MS);

const statsTimer = setInterval(() => {
  const s = matchmaking.stats();
  if (s.rooms === 0 && sockets.size === 0) return;
  console.log(
    `[server] ${s.rooms} room(s) (${s.playing} in match) · ${s.players} in rooms · ` +
      `${sockets.size} socket(s) · duel ${s.byMode.duel} garden ${s.byMode.garden} coop ${s.byMode.coop_blight}`,
  );
}, STATS_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Static client (production only)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

async function serveStatic(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed');
    return;
  }

  const decoded = safeDecode(pathname);
  if (decoded === null) {
    sendText(res, 400, 'Bad request');
    return;
  }

  // Strip the leading slash before normalizing, so `relative` really is a
  // relative path and the /assets/ prefix test below actually matches.
  const relative = normalize(decoded.replace(/^\/+/, '')).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(CLIENT_DIR, relative);

  // Never escape the client directory, whatever the URL claims.
  if (filePath !== CLIENT_DIR && !filePath.startsWith(CLIENT_DIR + sep)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  let info = await statOrNull(filePath);
  if (info?.isDirectory()) {
    filePath = join(filePath, 'index.html');
    info = await statOrNull(filePath);
  }

  // SPA fallback: an extensionless path that does not exist is a client route.
  if (!info && extname(filePath) === '') {
    filePath = join(CLIENT_DIR, 'index.html');
    info = await statOrNull(filePath);
  }

  if (!info) {
    sendText(res, 404, 'Not found');
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const isHtml = ext === '.html';
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': info.size,
    // Vite fingerprints everything under /assets, so it is safe to pin.
    'Cache-Control': isHtml
      ? 'no-cache'
      : relative.startsWith('assets')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function statOrNull(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

function safeDecode(p: string): string | null {
  try {
    const decoded = decodeURIComponent(p);
    return decoded.includes('\0') ? null : decoded;
  } catch {
    return null;
  }
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

// ---------------------------------------------------------------------------
// Boot / shutdown

function readPort(): number {
  const raw = process.env.PORT;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} — shutting down`);

  clearInterval(tickTimer);
  clearInterval(heartbeatTimer);
  clearInterval(sweepTimer);
  clearInterval(statsTimer);

  matchmaking.closeAll('The server is shutting down.');
  for (const client of [...sockets]) {
    client.close(1001, 'server shutting down', 'shutdown');
  }

  wss.close(() => {
    http.close(() => {
      console.log('[server] closed cleanly');
      process.exit(0);
    });
  });

  // Do not hang forever on a peer that will not let go.
  const bail = setTimeout(() => {
    for (const client of sockets) client.terminate();
    process.exit(0);
  }, 3000);
  bail.unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection:', err);
});

async function main(): Promise<void> {
  // Never fatal: a missing or broken mode module degrades to NullModeHandler.
  await loadModeModules();
  const modes = modeStatus();

  http.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] BLOOM listening on 0.0.0.0:${PORT} (protocol ${PROTOCOL_VERSION})`);
    console.log(`[server] tick ${TICK_RATE} Hz · modes: ${describeModes(modes)}`);
    if (PRODUCTION) console.log(`[server] serving client from ${CLIENT_DIR}`);
  });
}

function describeModes(modes: Record<string, boolean>): string {
  return Object.entries(modes)
    .map(([name, ok]) => `${name}${ok ? '' : ' (stub)'}`)
    .join(', ');
}

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
