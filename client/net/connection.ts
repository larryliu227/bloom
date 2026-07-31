/**
 * BLOOM — the socket.
 *
 * One WebSocket, one callback bag, no state machine beyond what the protocol
 * already implies. Everything the server says arrives here and is handed straight
 * to the app; everything the player does leaves through a named method so no
 * message shape is spelled out twice.
 *
 * Two things are load-bearing:
 *
 *  - SAME-ORIGIN `/ws`. In production the node server serves the client and the
 *    socket off one port; in development vite proxies `/ws` to it. Either way the
 *    client never has to be told where the server is, which is the difference
 *    between "open the link" and "also edit a config".
 *  - THE RECONNECT TOKEN IS PERSISTED. A phone that loses Wi-Fi for ten seconds
 *    reconnects, replays the token, and lands back in its own garden. Without it a
 *    dropped connection means a lost match, which no player accepts.
 */

import type { GameMode, MatchState, RoleId, TechId } from '@shared/bloom.js';
import { PROTOCOL_VERSION, decode, encode } from '@shared/protocol.js';
import type { ClientMsg, LobbyState, MatchResult, ServerMsg } from '@shared/protocol.js';

const TOKEN_KEY = 'bloom.token';
const NAME_KEY = 'bloom.name';

/** How the connection is doing, for the one line of status the player sees. */
export type ConnStatus = 'offline' | 'connecting' | 'online';

export interface ConnectionEvents {
  onStatus(status: ConnStatus, detail: string): void;
  /** Handshake done. `playerId` is how we recognise ourselves in a lobby roster. */
  onWelcome(playerId: string): void;
  onLobby(lobby: LobbyState): void;
  /** The match is live and you are `seat`. */
  onMatchStart(seat: number, mode: GameMode): void;
  onSnapshot(state: MatchState): void;
  onMatchEnd(result: MatchResult): void;
  /** Pact offers involving you: seats who have offered, seats you have offered. */
  onPacts(toYou: number[], fromYou: number[]): void;
  onChat(name: string, text: string): void;
  onError(code: string, message: string): void;
  onRoomClosed(reason: string): void;
}

export class Connection {
  /** Our public id, as the server issued it. Empty until `welcome` lands. */
  playerId = '';

  private ws: WebSocket | null = null;
  private ev: ConnectionEvents;
  private status: ConnStatus = 'offline';
  /** Queued while the socket is still opening; flushed on `hello`. */
  private outbox: string[] = [];
  private helloSent = false;
  /** What to re-do after a reconnect: rejoin the room we were in. */
  private rejoin: (() => void) | null = null;
  private retry = 0;
  private retryTimer = 0;
  private closedByUs = false;
  private name: string;

  constructor(ev: ConnectionEvents) {
    this.ev = ev;
    this.name = load(NAME_KEY) ?? '';
  }

  get isOnline(): boolean {
    return this.status === 'online';
  }

  // ---------------------------------------------------------------- lifecycle

  connect(name?: string): void {
    if (name) {
      this.name = name;
      save(NAME_KEY, name);
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.closedByUs = false;
    this.setStatus('connecting', 'reaching the garden…');

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl());
    } catch {
      this.setStatus('offline', 'could not open a connection');
      this.scheduleRetry();
      return;
    }
    this.ws = socket;
    this.helloSent = false;

    socket.onopen = () => {
      // `hello` must be the first message on the wire; everything else waits.
      const token = load(TOKEN_KEY) ?? undefined;
      socket.send(
        encode({ t: 'hello', name: this.name, version: PROTOCOL_VERSION, ...(token ? { token } : {}) }),
      );
      this.helloSent = true;
    };

    socket.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const msg = decode<ServerMsg>(e.data);
      if (msg) this.receive(msg);
    };

    socket.onerror = () => {
      // `onclose` always follows; let it do the work so retries happen once.
    };

    socket.onclose = (e) => {
      this.ws = null;
      this.helloSent = false;
      if (this.closedByUs) {
        this.setStatus('offline', 'left');
        return;
      }
      /*
       * A version mismatch is the one close we must not retry: the server told us
       * to reload, and reconnecting in a loop would just spam the same rejection.
       */
      if (e.code === 1002) {
        this.setStatus('offline', 'this page is out of date — reload');
        return;
      }
      this.setStatus('offline', 'connection lost — retrying');
      this.scheduleRetry();
    };
  }

  /** Deliberate disconnect. Cancels retries and forgets the pending rejoin. */
  disconnect(): void {
    this.closedByUs = true;
    this.rejoin = null;
    window.clearTimeout(this.retryTimer);
    this.outbox = [];
    try {
      this.ws?.close(1000, 'bye');
    } catch {
      /* already gone */
    }
    this.ws = null;
    this.setStatus('offline', 'left');
  }

  private scheduleRetry(): void {
    window.clearTimeout(this.retryTimer);
    // Back off, but never so far that a player is left staring at a dead screen.
    const delay = Math.min(8000, 500 * 2 ** this.retry);
    this.retry += 1;
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private setStatus(status: ConnStatus, detail: string): void {
    this.status = status;
    this.ev.onStatus(status, detail);
  }

  // ---------------------------------------------------------------- inbound

  private receive(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome': {
        // Secret — persisted so a reload or a dropped socket can reclaim the seat.
        save(TOKEN_KEY, msg.reconnectToken);
        this.playerId = msg.playerId;
        this.retry = 0;
        this.status = 'online';
        this.ev.onWelcome(msg.playerId);
        this.setStatus('online', 'connected');
        for (const queued of this.outbox) this.ws?.send(queued);
        this.outbox = [];
        // If we were in a room before the drop, get back into it.
        this.rejoin?.();
        return;
      }
      case 'lobby':
        this.ev.onLobby(msg.state);
        return;
      case 'matchStart':
        this.ev.onMatchStart(msg.seat, msg.mode);
        return;
      case 'match':
        this.ev.onSnapshot(msg.state);
        return;
      case 'matchEnd':
        this.ev.onMatchEnd(msg.result);
        return;
      case 'pacts':
        this.ev.onPacts(msg.toYou, msg.fromYou);
        return;
      case 'chat':
        this.ev.onChat(msg.name, msg.text);
        return;
      case 'roomClosed':
        this.rejoin = null;
        this.ev.onRoomClosed(msg.reason);
        return;
      case 'error':
        this.ev.onError(msg.code, msg.message);
        return;
      case 'pong':
        return;
    }
  }

  // ---------------------------------------------------------------- outbound

  private send(msg: ClientMsg): void {
    const json = encode(msg);
    if (this.ws?.readyState === WebSocket.OPEN && this.helloSent && this.status === 'online') {
      this.ws.send(json);
      return;
    }
    /*
     * Not ready yet. Queue it rather than dropping it — but only lobby-shaped
     * intent, never gameplay: a tap that arrives four seconds late would be played
     * against a board that has moved on, which is worse than the tap being lost.
     */
    if (
      msg.t === 'tap' ||
      msg.t === 'buyTech' ||
      msg.t === 'hatch' ||
      msg.t === 'takeover' ||
      msg.t === 'grove' ||
      msg.t === 'build' ||
      msg.t === 'pact'
    ) {
      return;
    }
    if (this.outbox.length < 16) this.outbox.push(json);
  }

  createRoom(mode: GameMode): void {
    this.rejoin = null;
    this.send({ t: 'createRoom', mode });
  }

  joinRoom(code: string): void {
    const room = code.trim().toUpperCase();
    // Remember it: a reconnect has to walk back through the same door.
    this.rejoin = () => this.send({ t: 'joinRoom', roomId: room });
    this.send({ t: 'joinRoom', roomId: room });
  }

  quickPlay(mode: GameMode): void {
    this.rejoin = null;
    this.send({ t: 'quickPlay', mode });
  }

  leaveRoom(): void {
    this.rejoin = null;
    this.send({ t: 'leaveRoom' });
  }

  chooseRole(role: RoleId): void {
    this.send({ t: 'chooseRole', role });
  }

  setReady(ready: boolean): void {
    this.send({ t: 'setReady', ready });
  }

  startMatch(): void {
    this.send({ t: 'startMatch' });
  }

  addBot(): void {
    this.send({ t: 'addBot' });
  }

  removeBot(): void {
    this.send({ t: 'removeBot' });
  }

  tap(cell: number): void {
    this.send({ t: 'tap', cell });
  }

  buyTech(tech: TechId): void {
    this.send({ t: 'buyTech', tech });
  }

  hatch(): void {
    this.send({ t: 'hatch' });
  }

  takeover(cell: number): void {
    this.send({ t: 'takeover', cell });
  }

  plantGrove(cell: number): void {
    this.send({ t: 'grove', cell });
  }

  build(cell: number): void {
    this.send({ t: 'build', cell });
  }

  pact(seat: number): void {
    this.send({ t: 'pact', seat });
  }

  chat(text: string): void {
    this.send({ t: 'chat', text });
  }
}

/**
 * Same origin, `/ws`. Never hardcode a host: the whole point is that whatever URL
 * the player opened is also the URL the game talks to, on a phone on the LAN or a
 * box on the internet, with no configuration anywhere.
 */
function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — reconnect just will not survive a reload */
  }
}
