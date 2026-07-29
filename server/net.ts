/**
 * VOIDLINE — transport layer.
 *
 * A `Client` is one live WebSocket plus everything the game needs to know about
 * the human on the other end: a stable id, a sanitized name, which room they are
 * in, their measured RTT, and the guard rails (message size cap, 120 msg/sec
 * rate limit, heartbeat) that keep a hostile or broken peer from hurting anyone.
 *
 * Nothing in here knows about rooms, the simulation, or the weave. It only
 * turns bytes into `ClientMsg` and `ServerMsg` back into bytes.
 */

import { randomBytes } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';

import {
  CHAT_MIN_INTERVAL_SEC,
  HEARTBEAT_MISS_LIMIT,
  MAX_CLIENT_MSG_BYTES,
  MAX_CLIENT_MSGS_PER_SEC,
  NAME_MAX_LEN,
} from '@shared/constants.js';
import { decode, encode } from '@shared/protocol.js';
import type { ClientMsg, ServerMsg } from '@shared/protocol.js';
import type { PlayerId, RoomId } from '@shared/bloom.js';

/** Why a socket went away — surfaced to the room so it can log sensibly. */
export type ClientCloseReason =
  | 'client'
  | 'rate-limit'
  | 'oversize'
  | 'protocol'
  | 'timeout'
  | 'shutdown'
  | 'error';

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g;
const PLAYER_ID_RE = /^p_[A-Za-z0-9_-]{6,40}$/;

/** Mint a fresh, unguessable player id. Doubles as the reconnect token. */
export function newPlayerId(): PlayerId {
  return `p_${randomBytes(9).toString('base64url')}`;
}

/**
 * A secret reconnect credential, deliberately separate from the PlayerId.
 *
 * PlayerIds are public — they ride in every snapshot to every co-player — so they
 * cannot double as an auth token. This value is sent once, to its owner, in
 * `welcome`, and must never be placed in an entity, lobby roster or snapshot.
 * 24 bytes so it is not guessable within a reconnect grace window.
 */
export function newReconnectToken(): string {
  return randomBytes(24).toString('base64url');
}

/** True if a client-supplied reconnect token is even shaped like one of ours. */
export function isPlayerId(raw: unknown): raw is PlayerId {
  return typeof raw === 'string' && PLAYER_ID_RE.test(raw);
}

/** Collapse whitespace, strip control characters, clamp length, never empty. */
export function sanitizeName(raw: unknown): string {
  const source = typeof raw === 'string' ? raw : '';
  const cleaned = source
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX_LEN);
  if (cleaned.length > 0) return cleaned;
  return `Runner-${randomBytes(2).toString('hex').toUpperCase()}`;
}

/** Same treatment for chat, with a longer budget and no fallback. */
export function sanitizeChat(raw: unknown, maxLen: number): string {
  const source = typeof raw === 'string' ? raw : '';
  return source.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

export class Client {
  name: string;
  roomId: RoomId | null = null;

  /** Measured round trip in ms, from WebSocket-level ping/pong frames. */
  ping = 0;
  /** Set once the `hello` handshake succeeds. Nothing else is accepted before. */
  helloDone = false;
  readonly connectedAt = Date.now();
  readonly remote: string;

  /** Wired by the server; kept as fields so teardown is a single assignment. */
  onMessage: ((client: Client, msg: ClientMsg) => void) | null = null;
  onClose: ((client: Client, reason: ClientCloseReason) => void) | null = null;

  private _id: PlayerId;
  /** Secret reconnect credential. Never leaves this socket except via `welcome`. */
  private _reconnectToken: string = newReconnectToken();
  private readonly socket: WebSocket;
  private closed = false;
  private closeReason: ClientCloseReason = 'client';

  // rate limiting — fixed 1 second window, cheap and good enough
  private windowStart = Date.now();
  private windowCount = 0;

  // heartbeat
  private missedBeats = 0;
  private pingSentAt = 0;

  // chat throttle, separate from the global message budget
  private lastChatAt = 0;

  constructor(socket: WebSocket, id: PlayerId, name: string, remote: string) {
    this.socket = socket;
    this._id = id;
    this.name = name;
    this.remote = remote;

    socket.on('message', (data: RawData, isBinary: boolean) => this.receive(data, isBinary));
    socket.on('pong', () => {
      this.missedBeats = 0;
      if (this.pingSentAt > 0) {
        this.ping = Math.max(0, Math.round(Date.now() - this.pingSentAt));
        this.pingSentAt = 0;
      }
    });
    socket.on('error', () => this.finish('error'));
    socket.on('close', () => this.finish(this.closeReason));
  }

  /** Stable identity for this session. Also the reconnect token. */
  get id(): PlayerId {
    return this._id;
  }

  /**
   * Reclaim a previous session's id during the handshake, so a player who
   * dropped can land back in the slot the room is holding for them. Only legal
   * before `hello` completes — by then nothing has keyed off the id yet.
   */
  adoptIdentity(id: PlayerId): boolean {
    if (this.helloDone || !isPlayerId(id)) return false;
    this._id = id;
    return true;
  }

  /**
   * Adopt a reclaimed session wholesale: its public id AND its secret token, so a
   * client that reconnects twice can keep presenting the same credential.
   */
  adoptSession(id: PlayerId, token: string): boolean {
    if (!this.adoptIdentity(id)) return false;
    this._reconnectToken = token;
    return true;
  }

  get reconnectToken(): string {
    return this._reconnectToken;
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === WebSocket.OPEN;
  }

  // ------------------------------------------------------------------ outbound

  send(msg: ServerMsg): void {
    this.sendRaw(encode(msg));
  }

  /**
   * Send a pre-serialized frame. The tick loop stringifies one snapshot world
   * and splices it into every client's envelope, so this is the hot path.
   */
  sendRaw(json: string): void {
    if (!this.isOpen) return;
    try {
      this.socket.send(json);
    } catch {
      this.close(1011, 'send failed', 'error');
    }
  }

  error(code: string, message: string): void {
    this.send({ t: 'error', code, message });
  }

  // ------------------------------------------------------------------ inbound

  private receive(data: RawData, isBinary: boolean): void {
    if (this.closed) return;

    if (isBinary) {
      this.error('bad_frame', 'Binary frames are not accepted.');
      this.close(1003, 'binary', 'protocol');
      return;
    }

    const now = Date.now();
    if (!this.consumeRateToken(now)) {
      this.error('rate_limit', `Too many messages (limit ${MAX_CLIENT_MSGS_PER_SEC}/s).`);
      this.close(1008, 'rate limit', 'rate-limit');
      return;
    }

    const text = rawToText(data);
    if (text === null) {
      this.close(1009, 'oversize', 'oversize');
      return;
    }

    const msg = decode<ClientMsg>(text);
    if (!msg) {
      // A single malformed frame is not fatal — bots and proxies send noise.
      this.error('bad_json', 'Message was not a tagged JSON object.');
      return;
    }

    try {
      this.onMessage?.(this, msg);
    } catch (err) {
      console.error(`[net] handler threw for ${this.id} (${msg.t}):`, err);
      this.error('server_error', 'The server failed to process that message.');
    }
  }

  private consumeRateToken(now: number): boolean {
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    return this.windowCount <= MAX_CLIENT_MSGS_PER_SEC;
  }

  /** Chat gets its own slow lane so it cannot be used to spam a whole room. */
  canChat(now = Date.now()): boolean {
    if (now - this.lastChatAt < CHAT_MIN_INTERVAL_SEC * 1000) return false;
    this.lastChatAt = now;
    return true;
  }

  // ---------------------------------------------------------------- heartbeat

  /**
   * Called on a fixed interval by the server. Returns false if the peer has
   * gone silent and has been terminated.
   */
  heartbeat(): boolean {
    if (this.closed) return false;
    if (this.missedBeats >= HEARTBEAT_MISS_LIMIT) {
      this.closeReason = 'timeout';
      this.terminate();
      return false;
    }
    this.missedBeats += 1;
    this.pingSentAt = Date.now();
    try {
      this.socket.ping();
    } catch {
      this.terminate();
      return false;
    }
    return true;
  }

  // ----------------------------------------------------------------- teardown

  close(code = 1000, reason = 'bye', why: ClientCloseReason = 'client'): void {
    if (this.closed) return;
    this.closeReason = why;
    try {
      this.socket.close(code, reason);
    } catch {
      this.terminate();
      return;
    }
    // Do not wait forever for a polite close handshake.
    const timer = setTimeout(() => this.terminate(), 2000);
    timer.unref?.();
  }

  terminate(): void {
    try {
      this.socket.terminate();
    } catch {
      /* already gone */
    }
    this.finish(this.closeReason);
  }

  /** Idempotent: fires `onClose` exactly once and drops all references. */
  private finish(reason: ClientCloseReason): void {
    if (this.closed) return;
    this.closed = true;
    const cb = this.onClose;
    this.onMessage = null;
    this.onClose = null;
    try {
      cb?.(this, reason);
    } catch (err) {
      console.error(`[net] close handler threw for ${this.id}:`, err);
    }
    this.socket.removeAllListeners();
  }
}

/** Normalize the three shapes `ws` can hand us. Returns null if oversize. */
function rawToText(data: RawData): string | null {
  if (typeof data === 'string') {
    return Buffer.byteLength(data, 'utf8') > MAX_CLIENT_MSG_BYTES ? null : data;
  }
  if (Buffer.isBuffer(data)) {
    return data.byteLength > MAX_CLIENT_MSG_BYTES ? null : data.toString('utf8');
  }
  if (Array.isArray(data)) {
    const joined = Buffer.concat(data);
    return joined.byteLength > MAX_CLIENT_MSG_BYTES ? null : joined.toString('utf8');
  }
  const view = Buffer.from(data as ArrayBuffer);
  return view.byteLength > MAX_CLIENT_MSG_BYTES ? null : view.toString('utf8');
}
