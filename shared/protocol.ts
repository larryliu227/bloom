/**
 * BLOOM — wire protocol.
 *
 * Every message over the WebSocket is JSON: { t: <tag>, ... }.
 *
 * Two rules shape this file:
 *
 * 1. The server is authoritative and every client message is an INTENT, never an
 *    outcome. `tap` is the whole of the moment-to-moment game; `buyTech`, `hatch`,
 *    `takeover` and `pact` are the deliberate acts around it. There is no movement, no
 *    aim, no prediction and therefore no reconciliation — the client says what it
 *    wants and the server decides whether it was even legal.
 * 2. The board is small (14x22 cells), so the server ships the WHOLE match
 *    state every tick in `match`. It compresses to almost nothing over
 *    permessage-deflate and it deletes an entire class of desync bugs.
 *
 * The lobby/session half of this protocol is inherited unchanged from the
 * engine: `hello`/`welcome` with the secret reconnect token, room codes, ready
 * up, bots, chat, ping. Do not weaken any of it.
 */

import type { GameMode, MatchState, PlayerId, RoleId, RoomId, TechId } from './bloom.js';

// ============================================================ lobby types

/** Bot difficulty. The dial is how well it spots CUTS, never how fast it taps. */
export type BotTierId = 'sprout' | 'gardener' | 'reaper';

export interface LobbyPlayer {
  playerId: PlayerId;
  name: string;
  /**
   * The plant this seat drafted, or null before they have. Not unique — two people
   * may play the same plant, and gardens are told apart by seat colour.
   */
  role: RoleId | null;
  ready: boolean;
  connected: boolean;
  /**
   * Server-controlled AI gardener. Absent/false for humans. Bots hold a real
   * seat; they are always ready and are never counted as a socket, a host
   * candidate, or a reconnect slot. Behaviour lives in the shared simulation
   * (`shared/garden.ts` — `stepBot`), so a bot plays by exactly the rules you do.
   */
  isBot?: boolean;
  /** Display only — the server owns behaviour. */
  botTier?: BotTierId;
}

export interface LobbyState {
  roomId: RoomId;
  mode: GameMode;
  host: PlayerId;
  players: LobbyPlayer[];
  /** CO-OP only: which Blight level (1..3). Level 1 is the tutorial. */
  level: number;
  maxPlayers: number;
  /** Seconds until the match starts once everyone is ready. */
  countdown: number;
}

// ============================================================ client -> server

export type ClientMsg =
  // handshake
  /**
   * `token` is a SECRET reconnect credential issued in `welcome`. Presenting it
   * reclaims a seat the server is still holding (RECONNECT_GRACE_SEC);
   * otherwise a fresh identity is issued and the field is ignored.
   *
   * It is deliberately NOT the PlayerId. PlayerIds are broadcast to every
   * co-player in every snapshot, so using one as the credential let anyone
   * harvest an id off the wire, wait for that player to drop, and seize their
   * seat. The credential must never appear in any seat, lobby or match state.
   */
  | { t: 'hello'; name: string; version: string; token?: string }
  // lobby
  | { t: 'createRoom'; mode: GameMode; level?: number }
  | { t: 'joinRoom'; roomId: RoomId }
  | { t: 'quickPlay'; mode: GameMode }
  | { t: 'leaveRoom' }
  | { t: 'chooseRole'; role: RoleId }
  | { t: 'setReady'; ready: boolean }
  /** Host only, CO-OP only: pick the Blight level. */
  | { t: 'setLevel'; level: number }
  | { t: 'startMatch' } // host only
  /** Host only: seat an AI gardener so one person can fill a lobby. */
  | { t: 'addBot'; tier?: BotTierId; role?: RoleId }
  /** Host only: free the most recently seated AI gardener. */
  | { t: 'removeBot' }
  // gameplay — this is the entire input surface of the game
  /** Tap one cell. Expansion, attack and puzzle move, all at once. */
  | { t: 'tap'; cell: number }
  /** Buy an upgrade. The server enforces what is buyable, not the UI. */
  | { t: 'buyTech'; tech: TechId }
  /**
   * Build a nutrient store on one of your own tiles. The only construction in the
   * game, and the one thing that decides where your energy physically lives.
   */
  | { t: 'build'; cell: number }
  /** FUNGAL only: spend energy to hatch an insect somewhere on your network. */
  | { t: 'hatch' }
  /**
   * SPORE only: HOSTILE TAKEOVER, centred on `cell`. Ten acid, 9x9, instant.
   * An item rather than a tech — you buy it every time you use it.
   */
  | { t: 'takeover'; cell: number }
  /** TREE only: drop a 4x4 forest centred on `cell`. Once a minute, no cost. */
  | { t: 'grove'; cell: number }
  /**
   * Offer a pact to `seat` — or, if they have already offered, accept it; or, if
   * you are already allied, betray them. One message for all three because from
   * the player's side it is one button, and which of the three it means is a fact
   * about the match state that only the server reliably knows.
   */
  | { t: 'pact'; seat: number }
  | { t: 'chat'; text: string }
  | { t: 'ping'; ts: number };

// ============================================================ server -> client

export type ServerMsg =
  /**
   * `reconnectToken` is secret and sent only to its owner on this socket. Store
   * it, replay it as `hello.token` to reclaim a held seat, never display it.
   */
  | { t: 'welcome'; playerId: PlayerId; version: string; reconnectToken: string }
  | { t: 'error'; code: string; message: string }
  | { t: 'lobby'; state: LobbyState }
  | { t: 'roomClosed'; reason: string }
  /** Sent once when the match begins — the static facts the client caches. */
  | { t: 'matchStart'; mode: GameMode; seed: number; seat: number; level: number }
  /**
   * The authoritative whole-board state, at SNAPSHOT_RATE. Deliberately not a
   * delta: 308 cells of small integers gzip to a couple of hundred bytes.
   */
  | { t: 'match'; state: MatchState }
  | { t: 'matchEnd'; result: MatchResult }
  /**
   * Pact offers involving THIS client, sent only to them and only when they change.
   *
   * Deliberately not part of `match`: that snapshot goes to everybody, and who has
   * offered whom a pact is exactly the information a four-way game is played with.
   * Broadcasting it would turn diplomacy into a public ledger.
   */
  | { t: 'pacts'; toYou: number[]; fromYou: number[] }
  | { t: 'chat'; from: PlayerId; name: string; text: string }
  | { t: 'pong'; ts: number; serverTime: number };

/** Why the match stopped. `abandoned` means every human walked out. */
export type MatchEndReason = 'home' | 'territory' | 'blight' | 'wiped' | 'abandoned' | 'none';

export interface MatchResult {
  mode: GameMode;
  /**
   * Human-readable winner tag: a seat index as a string for PvP ('0', '1', ...),
   * `players` or `blight` for co-op, `none` if nobody won.
   */
  winner: string;
  /** The winning seat, or -1 for a co-op/no-winner outcome. */
  winnerSeat: number;
  reason: MatchEndReason;
  /** Per-seat end-of-match stats, ordered by tiles held descending. */
  standings: Array<{
    seat: number;
    playerId: PlayerId;
    name: string;
    role: RoleId;
    /** Cells owned at the final tick. */
    tiles: number;
    /** Largest territory held at any point. */
    peakTiles: number;
    /** Neutral cells claimed. */
    claimed: number;
    /** Enemy cells taken. */
    captured: number;
    /** Enemy cells that withered because THIS seat made the cut. The real score. */
    severed: number;
    isBot: boolean;
  }>;
  /** CO-OP: which Blight level was played and whether it was cleared. */
  level?: number;
  levelCleared?: boolean;
  durationSec: number;
}

/** Bumped from VOIDLINE's 1.x — the gameplay half of the protocol is new. */
export const PROTOCOL_VERSION = '2.0.0';

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
