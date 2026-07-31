/**
 * BLOONS WORLD — the socket.
 *
 * Same-origin `/ws`, exactly as BLOOM does it: in production one node process
 * serves the page and the socket, and in development vite proxies `/ws` to it. The
 * client is therefore never told where the server is, which is the difference
 * between "open the link" and "also edit a config".
 */

import { PROTOCOL_VERSION, decode, encode } from '../shared/protocol.js';
import type { ClientMsg, ServerMsg } from '../shared/protocol.js';
import type { Player } from '../shared/world.js';

/** One snapshot, stamped on arrival so remote players can be interpolated. */
export interface Frame {
  at: number;
  players: Player[];
}

export type Status = 'offline' | 'connecting' | 'online';

export class Net {
  id = '';
  status: Status = 'offline';
  /** The last two frames. Two is all interpolation needs. */
  prev: Frame | null = null;
  last: Frame | null = null;
  onStatus: ((s: Status, detail: string) => void) | null = null;

  private ws: WebSocket | null = null;
  private retry = 0;
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.set('connecting', 'finding the world…');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${proto}//${location.host}/ws`);
    } catch {
      this.set('offline', 'could not connect');
      this.scheduleRetry();
      return;
    }
    this.ws = socket;

    socket.onopen = () => socket.send(encode({ t: 'hello', name: this.name, version: PROTOCOL_VERSION }));
    socket.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const msg = decode<ServerMsg>(e.data);
      if (msg) this.receive(msg);
    };
    socket.onclose = (e) => {
      this.ws = null;
      // A version mismatch must not retry: the server told us to reload, and a
      // reconnect loop would just spam the same rejection.
      if (e.code === 1002) return this.set('offline', 'out of date — reload');
      this.set('offline', 'lost the world — retrying');
      this.scheduleRetry();
    };
  }

  private receive(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.id = msg.id;
        this.retry = 0;
        this.set('online', 'connected');
        return;
      case 'state':
        this.prev = this.last;
        this.last = { at: performance.now(), players: msg.players };
        return;
      case 'error':
        this.set('offline', msg.message);
        return;
      default:
        return;
    }
  }

  /** Post the current intent. Dropped rather than queued — a stale input is worse. */
  sendInput(x: number, y: number, jump = false): void {
    this.send({ t: 'input', x, y, jump });
  }

  rename(name: string): void {
    this.name = name;
    this.send({ t: 'rename', name });
  }

  private send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.status === 'online') this.ws.send(encode(msg));
  }

  private scheduleRetry(): void {
    const delay = Math.min(8000, 500 * 2 ** this.retry);
    this.retry += 1;
    window.setTimeout(() => this.connect(), delay);
  }

  private set(s: Status, detail: string): void {
    this.status = s;
    this.onStatus?.(s, detail);
  }
}
