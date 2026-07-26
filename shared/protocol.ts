/**
 * VOIDLINE — wire protocol.
 * Every message over the WebSocket is JSON: { t: <tag>, ... }.
 * Server is authoritative. The client may PREDICT movement but never
 * authors damage, charge, or kills.
 */

import type {
  AbilityId,
  EntityId,
  GameMode,
  LobbyState,
  PlayerId,
  RoleId,
  RoomId,
  WorldState,
  WeaveBoard,
  Vec2,
} from './types.js';

// ============================================================ client -> server

/** One frame of player intent. Sent at INPUT_SEND_RATE. */
export interface InputFrame {
  /** Monotonic per-client counter, used for reconciliation. */
  seq: number;
  /** Normalized move direction, magnitude 0..1. */
  move: Vec2;
  /** World-space aim point. */
  aim: Vec2;
  /** Bitmask of held actions — see ActionBit. */
  buttons: number;
  /** Client timestamp (ms) for RTT measurement. */
  ts: number;
}

export const ActionBit = {
  Fire1: 1 << 0, // fire weave slot 0
  Fire2: 1 << 1, // fire weave slot 1
  Fire3: 1 << 2, // fire weave slot 2
  Basic: 1 << 3, // free basic attack
  Dash: 1 << 4,
  Interact: 1 << 5, // revive / use terminal
} as const;

export type ClientMsg =
  // handshake
  /**
   * `token` is a SECRET reconnect credential issued in `welcome`. Presenting it
   * reclaims a slot the server is still holding (RECONNECT_GRACE_SEC); otherwise a
   * fresh identity is issued and the field is ignored.
   *
   * It is deliberately NOT the PlayerId. PlayerIds are broadcast to every co-player
   * in every snapshot, so using one as the credential let anyone harvest an id off
   * the wire, wait for that player to drop, and seize their entity and private Weave
   * board. The credential must never appear in any entity, lobby or snapshot.
   */
  | { t: 'hello'; name: string; version: string; token?: string }
  // lobby
  | { t: 'createRoom'; mode: GameMode; chapter?: number }
  | { t: 'joinRoom'; roomId: RoomId }
  | { t: 'quickPlay'; mode: GameMode }
  | { t: 'leaveRoom' }
  | { t: 'chooseRole'; role: RoleId }
  | { t: 'chooseLoadout'; loadout: AbilityId[] }
  | { t: 'setReady'; ready: boolean }
  | { t: 'setChapter'; chapter: number }
  | { t: 'startMatch' } // host only
  /** Host only: seat an AI runner so one person can fill a lobby. */
  | { t: 'addBot'; tier?: 'recruit' | 'veteran' | 'ace'; role?: RoleId }
  /** Host only: free the most recently seated AI runner. */
  | { t: 'removeBot' }
  // gameplay
  | { t: 'input'; frame: InputFrame }
  | { t: 'rotateTile'; index: number } // rotate a weave tile clockwise
  | { t: 'chat'; text: string }
  | { t: 'ping'; ts: number };

// ============================================================ server -> client

export type ServerMsg =
  /**
   * `reconnectToken` is secret and sent only to its owner on this socket. Store it,
   * replay it as `hello.token` to reclaim a held slot, and never display or share it.
   */
  | { t: 'welcome'; playerId: PlayerId; version: string; reconnectToken: string }
  | { t: 'error'; code: string; message: string }
  | { t: 'lobby'; state: LobbyState }
  | { t: 'roomClosed'; reason: string }
  /** Sent once when the match begins — static data the client caches. */
  | { t: 'matchStart'; mode: GameMode; seed: number; you: EntityId }
  /** Authoritative world snapshot at SNAPSHOT_RATE. */
  | { t: 'snapshot'; world: WorldState; ackSeq: number; serverTime: number }
  /** Your own weave board — sent only to its owner, on every change. */
  | { t: 'weave'; board: WeaveBoard }
  | { t: 'matchEnd'; result: MatchResult }
  | { t: 'chat'; from: PlayerId; name: string; text: string }
  | { t: 'pong'; ts: number; serverTime: number };

export interface MatchResult {
  mode: GameMode;
  /** 'a' | 'b' for pvp teams, 'players' or 'hostile' for coop win/loss. */
  winner: string;
  /** Per-player end-of-match stats, ordered by score desc. */
  standings: Array<{
    playerId: PlayerId;
    name: string;
    role: RoleId;
    score: number;
    kills: number;
    deaths: number;
    damageDealt: number;
    damageTaken: number;
    /** Weave-specific flex stat: total slots charged this match. */
    slotsCharged: number;
    revives: number;
  }>;
  /** Coop: which chapter was played and whether it unlocked the next. */
  chapter?: number;
  chapterCleared?: boolean;
  durationSec: number;
}

export const PROTOCOL_VERSION = '1.0.0';

// ============================================================ helpers

export function encode(msg: ServerMsg | ClientMsg): string {
  return JSON.stringify(msg);
}

export function decode<T extends ServerMsg | ClientMsg>(raw: string): T | null {
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null && typeof v.t === 'string' ? (v as T) : null;
  } catch {
    return null;
  }
}
