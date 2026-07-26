/**
 * VOIDLINE — the room registry.
 *
 * Owns every live `Room`, the code -> room index, the per-mode index that Quick
 * Play searches, and the short-lived "this player is reconnecting" table that
 * lets a dropped runner land back in the room they fell out of.
 *
 * Room codes are 6 characters from an alphabet with no O/0/I/1, because people
 * read these out loud.
 */

import { randomInt } from 'node:crypto';

import {
  EMPTY_ROOM_TTL_SEC,
  RECONNECT_GRACE_SEC,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from '@shared/constants.js';
import type { GameMode, PlayerId, RoomId } from '@shared/types.js';

import { Room } from './room.js';
import type { RoomOptions } from './room.js';
import type { Client } from './net.js';

const VALID_MODES: readonly GameMode[] = ['pvp_duel', 'pvp_arena', 'coop_story'];

export function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && (VALID_MODES as readonly string[]).includes(value);
}

/** Normalize whatever the player typed into a room code. */
export function normalizeRoomCode(raw: unknown): RoomId | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === ROOM_CODE_LENGTH ? code : null;
}

interface HeldSlot {
  roomId: RoomId;
  expiresAt: number;
  /**
   * The secret credential that may reclaim this slot. Held slots are keyed by the
   * PUBLIC playerId for lookup, but reclaiming requires this — a playerId is
   * broadcast in every snapshot, so possessing one proves nothing.
   */
  token: string;
}

export class Matchmaking {
  private readonly rooms = new Map<RoomId, Room>();
  private readonly byMode = new Map<GameMode, Set<Room>>();
  /** playerId -> the room holding their slot open. */
  private readonly held = new Map<PlayerId, HeldSlot>();

  constructor() {
    for (const mode of VALID_MODES) this.byMode.set(mode, new Set());
  }

  // -------------------------------------------------------------- inventory

  get roomCount(): number {
    return this.rooms.size;
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }

  get(roomId: RoomId | null | undefined): Room | undefined {
    if (!roomId) return undefined;
    return this.rooms.get(roomId);
  }

  forMode(mode: GameMode): Room[] {
    return [...(this.byMode.get(mode) ?? [])];
  }

  /** Live counts for the periodic log line. */
  stats(): { rooms: number; players: number; byMode: Record<GameMode, number>; playing: number } {
    const byMode = { pvp_duel: 0, pvp_arena: 0, coop_story: 0 } as Record<GameMode, number>;
    let players = 0;
    let playing = 0;
    for (const room of this.rooms.values()) {
      byMode[room.mode] += 1;
      players += room.clients.size;
      if (room.phase === 'playing' || room.phase === 'intermission') playing += 1;
    }
    return { rooms: this.rooms.size, players, byMode, playing };
  }

  // ------------------------------------------------------------- lifecycle

  createRoom(mode: GameMode, opts: RoomOptions = {}): Room {
    const room = new Room(this.allocCode(), mode, opts);
    room.onPlayerHeld = (r, playerId, graceMs, token) => {
      this.held.set(playerId, { roomId: r.id, expiresAt: Date.now() + graceMs, token });
    };
    room.onPlayerReleased = (r, playerId) => {
      const slot = this.held.get(playerId);
      if (slot && slot.roomId === r.id) this.held.delete(playerId);
    };

    this.rooms.set(room.id, room);
    this.byMode.get(mode)?.add(room);
    return room;
  }

  destroyRoom(room: Room, reason = 'Room closed.'): void {
    room.close(reason);
    this.rooms.delete(room.id);
    this.byMode.get(room.mode)?.delete(room);
    for (const [playerId, slot] of this.held) {
      if (slot.roomId === room.id) this.held.delete(playerId);
    }
  }

  closeAll(reason: string): void {
    for (const room of [...this.rooms.values()]) this.destroyRoom(room, reason);
  }

  // ----------------------------------------------------------- matchmaking

  /**
   * Drop the client into the best available public room for `mode`, creating
   * one if nothing suitable exists. Prefers the fullest joinable room so games
   * fill up instead of scattering one player across five empty lobbies.
   */
  quickPlay(client: Client, mode: GameMode): Room {
    const candidates = this.forMode(mode)
      .filter((room) => room.isPublic && room.isJoinable() && room.phase === 'lobby')
      .sort((a, b) => b.clients.size - a.clients.size || a.createdAt - b.createdAt);

    for (const room of candidates) {
      if (room.join(client)) return room;
    }

    const room = this.createRoom(mode, { isPublic: true });
    room.join(client);
    return room;
  }

  /** The room holding this player's slot open, if any. */
  heldRoomFor(playerId: PlayerId): Room | null {
    const slot = this.held.get(playerId);
    if (!slot) return null;
    if (slot.expiresAt <= Date.now()) {
      this.held.delete(playerId);
      return null;
    }
    const room = this.rooms.get(slot.roomId);
    if (!room || room.closed) {
      this.held.delete(playerId);
      return null;
    }
    return room;
  }

  forgetHeld(playerId: PlayerId): void {
    this.held.delete(playerId);
  }

  /**
   * Resolve a SECRET reconnect token to the slot it may reclaim.
   *
   * The only way to reclaim a held slot. Deliberately takes the token rather than a
   * playerId: playerIds are public (every snapshot carries them), so an id proves
   * nothing about who you are. Returns null for an unknown, expired, or
   * wrong-room token, which is exactly what an attacker's guess produces.
   */
  claimHeldSlot(token: string): { playerId: PlayerId; room: Room } | null {
    if (typeof token !== 'string' || token.length === 0) return null;
    for (const [playerId, slot] of this.held) {
      if (slot.token !== token) continue;
      const room = this.heldRoomFor(playerId); // re-validates expiry + room liveness
      return room ? { playerId, room } : null;
    }
    return null;
  }

  // ---------------------------------------------------------------- upkeep

  /**
   * Reap rooms nobody has been connected to for a while, and expire stale
   * reconnect slots. Called from the server's slow housekeeping timer.
   */
  sweep(now = Date.now()): number {
    for (const [playerId, slot] of [...this.held]) {
      if (slot.expiresAt <= now - RECONNECT_GRACE_SEC * 1000) this.held.delete(playerId);
    }

    let reaped = 0;
    for (const room of [...this.rooms.values()]) {
      if (room.closed) {
        this.destroyRoom(room);
        reaped += 1;
        continue;
      }
      if (room.clients.size > 0) continue;
      if (room.emptySince === 0) {
        room.emptySince = now;
        continue;
      }
      if (now - room.emptySince >= EMPTY_ROOM_TTL_SEC * 1000) {
        this.destroyRoom(room, 'Room was empty.');
        reaped += 1;
      }
    }
    return reaped;
  }

  // --------------------------------------------------------------- codes

  private allocCode(): RoomId {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const code = randomRoomCode();
      if (!this.rooms.has(code)) return code;
    }
    // Astronomically unlikely; keep going rather than throwing at a player.
    let code = randomRoomCode();
    while (this.rooms.has(code)) code = randomRoomCode();
    return code;
  }
}

function randomRoomCode(): RoomId {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    out += ROOM_CODE_ALPHABET[randomInt(0, ROOM_CODE_ALPHABET.length)];
  }
  return out;
}
