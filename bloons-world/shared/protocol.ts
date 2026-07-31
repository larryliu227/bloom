/**
 * BLOONS WORLD — wire protocol.
 *
 * JSON over one WebSocket. Two rules, both borrowed from BLOOM because they earned
 * it there:
 *
 * 1. The client sends INTENT, never position. It says "I am pushing north-east";
 *    the server decides where that puts you. A client that could post its own
 *    coordinates could stand anywhere it liked.
 * 2. The server ships the whole player list every tick. There are tens of players,
 *    not thousands, so a delta protocol would be optimising the wrong thing and
 *    buying desync bugs with the savings.
 */

import type { Player } from './world.js';

export type ClientMsg =
  /** First message on the socket. Nothing else is accepted before it. */
  | { t: 'hello'; name: string; version: string }
  /**
   * The input vector, roughly INPUT_RATE times a second. Components are clamped to
   * [-1, 1] server-side; a hostile client cannot walk faster by sending 9.
   */
  | { t: 'input'; x: number; y: number; jump?: boolean }
  /** Change your name mid-session. The tag over your head updates for everyone. */
  | { t: 'rename'; name: string }
  | { t: 'ping'; ts: number };

export type ServerMsg =
  | { t: 'welcome'; id: string; version: string }
  | { t: 'error'; code: string; message: string }
  /** The whole world, every tick. */
  | { t: 'state'; tick: number; players: Player[] }
  | { t: 'pong'; ts: number };

export const PROTOCOL_VERSION = 'world-1.0.0';

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

export function decode<T extends ClientMsg | ServerMsg>(raw: string): T | null {
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null && typeof v.t === 'string' ? (v as T) : null;
  } catch {
    return null;
  }
}
