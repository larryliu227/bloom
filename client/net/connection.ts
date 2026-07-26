/**
 * VOIDLINE — client WebSocket transport.
 *
 * Owns: URL derivation (LAN friendly), typed handler registry over `ServerMsg`,
 * exponential-backoff reconnect, an outbound queue for messages sent before the
 * socket is open, and ping/pong RTT + server-clock estimation.
 *
 * The rest of the client never touches a raw WebSocket.
 */

import { DEFAULT_PORT } from '@shared/constants.js';
import { PROTOCOL_VERSION, decode, encode } from '@shared/protocol.js';
import type { ClientMsg, ServerMsg } from '@shared/protocol.js';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ConnectionOptions {
  /** Sent in the `hello` handshake on every (re)connect. */
  name?: string;
  /** ms between ping probes. */
  pingIntervalMs?: number;
  /** Max messages held while the socket is not open. */
  maxQueue?: number;
}

type AnyHandler = (m: ServerMsg) => void;

/**
 * Where to connect. Derived from the page host so that opening the Vite dev
 * server from another machine on the LAN still finds the game server.
 * `?server=` overrides: accepts `host`, `host:port`, or a full ws(s):// URL.
 */
export function defaultServerUrl(): string {
  let override: string | null = null;
  try {
    override = new URLSearchParams(window.location.search).get('server');
  } catch {
    override = null;
  }
  if (override) {
    const trimmed = override.trim();
    if (/^wss?:\/\//i.test(trimmed)) return trimmed;
    if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/^http/i, 'ws');
    return trimmed.includes(':') ? `ws://${trimmed}` : `ws://${trimmed}:${DEFAULT_PORT}`;
  }
  const secure = window.location.protocol === 'https:';
  const host = window.location.hostname || 'localhost';
  const scheme = secure ? 'wss' : 'ws';
  const pagePort = window.location.port;

  /*
   * Two very different deployments:
   *  - dev: Vite serves the client on 5173 while the game server is a separate
   *         process on DEFAULT_PORT, so we must cross over to it.
   *  - prod: `npm start` serves the built client AND accepts the WebSocket upgrade
   *         on one port (possibly 80/443 behind a proxy). Reusing the page's own
   *         origin is the only thing that works there — hardcoding DEFAULT_PORT
   *         would point at a port that isn't open.
   */
  const VITE_DEV_PORTS = new Set(['5173', '4173', '3000']);
  if (pagePort && VITE_DEV_PORTS.has(pagePort)) {
    return `${scheme}://${host}:${DEFAULT_PORT}`;
  }
  // Same-origin: keep the page's port, or none at all for standard 80/443.
  return pagePort ? `${scheme}://${host}:${pagePort}` : `${scheme}://${host}`;
}

const BACKOFF_BASE_MS = 400;
const BACKOFF_MAX_MS = 8000;

/**
 * The server holds a dropped player's entity for RECONNECT_GRACE_SEC so they can
 * reclaim the same slot mid-match. Reclaiming requires replaying the SECRET
 * `reconnectToken` issued in `welcome` — without it every drop mints a new identity
 * and the held slot expires unused. Persisted so a tab reload also lands back in
 * the match.
 *
 * This is a credential, not an identifier: never log it, show it, or put it in a
 * URL. It is deliberately not the playerId, which the server broadcasts to every
 * co-player in every snapshot and therefore cannot authenticate anyone.
 */
const PID_STORAGE_KEY = 'voidline.rtoken';

function loadStoredPid(): string | null {
  try {
    return window.sessionStorage.getItem(PID_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storePid(pid: string | null): void {
  try {
    if (pid) window.sessionStorage.setItem(PID_STORAGE_KEY, pid);
    else window.sessionStorage.removeItem(PID_STORAGE_KEY);
  } catch {
    /* private browsing — reconnect simply degrades to a fresh identity */
  }
}

export class Connection {
  readonly url: string;

  state: ConnectionState = 'closed';
  /** Incremented every time a fresh socket successfully opens. */
  generation = 0;

  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<AnyHandler>>();
  private statusCbs = new Set<(state: ConnectionState, detail: string) => void>();
  private queue: ClientMsg[] = [];
  private attempts = 0;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  private closedByUs = false;

  private _ping = 0;
  private _clockOffset = 0;
  private _clockInit = false;

  private name: string;
  private readonly pingIntervalMs: number;
  private readonly maxQueue: number;
  /** Our public, server-assigned id. Safe to display; useless as a credential. */
  private playerId: string | null = null;
  /** Secret credential replayed on reconnect to reclaim a held slot. */
  private reconnectToken: string | null = loadStoredPid();

  constructor(url: string = defaultServerUrl(), opts: ConnectionOptions = {}) {
    this.url = url;
    this.name = opts.name ?? 'runner';
    this.pingIntervalMs = opts.pingIntervalMs ?? 1000;
    this.maxQueue = opts.maxQueue ?? 64;

    // Internal bookkeeping handlers. Registered first so app handlers still run.
    this.on('pong', (m) => {
      const rtt = Math.max(0, Date.now() - m.ts);
      this._ping = this._ping === 0 ? rtt : this._ping * 0.7 + rtt * 0.3;
      this.noteServerTime(m.serverTime, rtt / 2);
    });
    this.on('snapshot', (m) => this.noteServerTime(m.serverTime, this._ping / 2));
    this.on('welcome', (m) => {
      this.playerId = m.playerId;
      this.reconnectToken = m.reconnectToken;
      storePid(m.reconnectToken);
    });
  }

  /** Forget our session so the next connect starts fresh. */
  clearIdentity(): void {
    this.playerId = null;
    this.reconnectToken = null;
    storePid(null);
  }

  // ------------------------------------------------------------------ status

  /** Smoothed round-trip time in milliseconds. */
  get ping(): number {
    return Math.round(this._ping);
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Best estimate of the server's clock, in the server's own ms timebase. */
  serverNow(): number {
    return Date.now() + this._clockOffset;
  }

  onStatus(fn: (state: ConnectionState, detail: string) => void): () => void {
    this.statusCbs.add(fn);
    fn(this.state, '');
    return () => this.statusCbs.delete(fn);
  }

  private setState(state: ConnectionState, detail = ''): void {
    this.state = state;
    for (const cb of this.statusCbs) cb(state, detail);
  }

  private noteServerTime(serverTime: number, oneWayMs: number): void {
    // offset = serverTime - localTime, biased toward the *smallest* observed
    // latency (largest offset sample) so jitter never drags the clock backwards.
    const sample = serverTime + oneWayMs - Date.now();
    if (!this._clockInit) {
      this._clockOffset = sample;
      this._clockInit = true;
    } else {
      this._clockOffset =
        sample > this._clockOffset ? sample : this._clockOffset * 0.995 + sample * 0.005;
    }
  }

  // ---------------------------------------------------------------- handlers

  /** Subscribe to one server message tag. Returns an unsubscribe function. */
  on<T extends ServerMsg['t']>(t: T, fn: (m: Extract<ServerMsg, { t: T }>) => void): () => void {
    let set = this.handlers.get(t);
    if (!set) {
      set = new Set();
      this.handlers.set(t, set);
    }
    const h = fn as unknown as AnyHandler;
    set.add(h);
    return () => {
      set!.delete(h);
    };
  }

  private dispatch(msg: ServerMsg): void {
    const set = this.handlers.get(msg.t);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(msg);
      } catch (err) {
        console.error(`[net] handler for "${msg.t}" threw`, err);
      }
    }
  }

  // ------------------------------------------------------------------ socket

  connect(): void {
    this.closedByUs = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.clearTimer();
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting', this.url);

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.scheduleReconnect(String(err));
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.generation++;
      this.setState('open', this.url);
      // `token` is optional on the wire; the server honours it only while it is
      // still holding a slot for it, otherwise it issues a fresh identity.
      this.rawSend({
        t: 'hello',
        name: this.name,
        version: PROTOCOL_VERSION,
        ...(this.reconnectToken ? { token: this.reconnectToken } : {}),
      });
      this.flush();
      this.startPings();
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      if (typeof ev.data !== 'string') return;
      const msg = decode<ServerMsg>(ev.data);
      if (msg) this.dispatch(msg);
    };

    ws.onerror = () => {
      /* onclose always follows; reported there. */
    };

    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPings();
      if (this.closedByUs) {
        this.setState('closed', 'disconnected');
        return;
      }
      this.scheduleReconnect(ev.reason || `socket closed (${ev.code})`);
    };
  }

  /** Change the handshake name; takes effect on the next connect. */
  setName(name: string): void {
    this.name = name;
  }

  close(): void {
    this.closedByUs = true;
    this.clearTimer();
    this.stopPings();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.setState('closed', 'disconnected');
  }

  private scheduleReconnect(detail: string): void {
    const delay =
      Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, this.attempts)) *
      (0.8 + Math.random() * 0.4);
    this.attempts++;
    this.setState('reconnecting', detail);
    this.clearTimer();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startPings(): void {
    this.stopPings();
    this.pingTimer = window.setInterval(() => {
      if (this.isOpen) this.rawSend({ t: 'ping', ts: Date.now() });
    }, this.pingIntervalMs);
  }

  private stopPings(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ------------------------------------------------------------------ output

  /** Queue-aware send. Safe to call before the socket opens. */
  send(msg: ClientMsg): void {
    if (this.isOpen) {
      this.rawSend(msg);
      return;
    }
    // Stale input frames are worthless once we reconnect — drop them first.
    if (this.queue.length >= this.maxQueue) {
      const i = this.queue.findIndex((m) => m.t === 'input');
      this.queue.splice(i >= 0 ? i : 0, 1);
    }
    this.queue.push(msg);
  }

  private rawSend(msg: ClientMsg): void {
    try {
      this.ws?.send(encode(msg));
    } catch (err) {
      console.warn('[net] send failed', err);
    }
  }

  private flush(): void {
    if (!this.queue.length) return;
    const pending = this.queue;
    this.queue = [];
    for (const m of pending) {
      if (m.t === 'input') continue; // never replay stale intent
      this.rawSend(m);
    }
  }
}
