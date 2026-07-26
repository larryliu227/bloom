/**
 * VOIDLINE — game mode contract.
 *
 * `ModeHandler` is the seam between the room backbone (agent D) and the actual
 * games: the co-op campaign (agent G, `./coop.ts`) and PvP (agent H, `./pvp.ts`).
 * The room drives the clock, the sockets and the weave; a mode handler decides
 * what the world is *for* — where people spawn, what killing means, when it ends.
 *
 * The mode modules are pulled in with dynamic `import()` behind a try/catch so
 * that a missing or broken mode file degrades to `NullModeHandler` instead of
 * taking the whole server down. Call `loadModeModules()` once at boot;
 * `createModeHandler` stays synchronous, exactly as declared in ARCHITECTURE.md.
 */

import { ARENA_H, ARENA_W, PLAYER_RADIUS, RESPAWN_DELAY } from '@shared/constants.js';
import type { MatchResult } from '@shared/protocol.js';
import type { SimContext } from '@shared/sim.js';
import type { Entity, GameMode, PlayerEntity, PlayerId, Vec2 } from '@shared/types.js';

import type { Room } from '../room.js';

export interface ModeHandler {
  readonly mode: GameMode;
  onMatchStart(room: Room, ctx: SimContext): void;
  onTick(room: Room, ctx: SimContext, dt: number): void;
  onDamage(ctx: SimContext, target: Entity, amount: number, source: Entity | null): void;
  onDeath(room: Room, ctx: SimContext, entity: Entity, killer: Entity | null): void;
  /** Return non-null to end the match. */
  checkComplete(room: Room, ctx: SimContext): MatchResult | null;
  /** Where a joining/respawning player spawns. */
  spawnPoint(room: Room, player: PlayerEntity): Vec2;
}

/**
 * Optional extras a handler may implement. Duck-typed on purpose: the room can
 * take advantage of them without importing `./pvp.js` or `./coop.js` directly,
 * which is what keeps a missing mode module from becoming a boot failure.
 */
export interface ModeHandlerExtras {
  /**
   * Player ids whose `weave` board object was replaced or mutated by the mode
   * (round resets, boss scrambles). Drained by the room once per tick; each id
   * gets a fresh `{ t: 'weave' }` push. Implemented by agent H as
   * `PvpBase.consumeBoardUpdates()`.
   */
  consumeBoardUpdates?(): PlayerId[];
}

/** Drain a handler's pending board pushes. Returns [] if it does not implement it. */
export function drainBoardUpdates(handler: ModeHandler): PlayerId[] {
  const fn = (handler as ModeHandler & ModeHandlerExtras).consumeBoardUpdates;
  if (typeof fn !== 'function') return [];
  try {
    const ids = fn.call(handler);
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

/** What `./coop.ts` (agent G) must export. */
interface CoopModule {
  createCoopHandler(chapter: number): ModeHandler;
}

/** What `./pvp.ts` (agent H) must export. */
interface PvpModule {
  createDuelHandler(): ModeHandler;
  createArenaHandler(): ModeHandler;
}

// ---------------------------------------------------------------------------
// Fallback

/**
 * A mode that does nothing harmful: everyone spawns on a ring around the arena
 * core, deaths recycle on the normal respawn delay, and the match never ends on
 * its own. Used when a mode module is absent or throws on load, so the server
 * still boots and the lobby still works while another agent is mid-write.
 */
export class NullModeHandler implements ModeHandler {
  readonly mode: GameMode;

  constructor(mode: GameMode) {
    this.mode = mode;
  }

  onMatchStart(): void {
    /* nothing to set up */
  }

  onTick(): void {
    /* no waves, no rounds */
  }

  onDamage(): void {
    /* no scoring */
  }

  onDeath(_room: Room, _ctx: SimContext, entity: Entity): void {
    if (entity.kind === 'player' && this.mode !== 'coop_story') {
      entity.respawnTimer = RESPAWN_DELAY;
    }
  }

  checkComplete(): MatchResult | null {
    return null;
  }

  spawnPoint(room: Room, player: PlayerEntity): Vec2 {
    // Deterministic ring placement keyed off the join order, so two players
    // never land on top of each other.
    const order = room.spawnOrderOf(player.playerId);
    const count = Math.max(1, room.playerCount());
    const angle = (order / count) * Math.PI * 2;
    const radius = Math.min(ARENA_W, ARENA_H) * 0.3;
    return {
      x: ARENA_W / 2 + Math.cos(angle) * radius,
      y: ARENA_H / 2 + Math.sin(angle) * radius,
    };
  }
}

/** Clamp any mode-supplied spawn point into the playable area. */
export function clampToArena(p: Vec2): Vec2 {
  const m = PLAYER_RADIUS + 4;
  return {
    x: Math.min(ARENA_W - m, Math.max(m, Number.isFinite(p.x) ? p.x : ARENA_W / 2)),
    y: Math.min(ARENA_H - m, Math.max(m, Number.isFinite(p.y) ? p.y : ARENA_H / 2)),
  };
}

// ---------------------------------------------------------------------------
// Module loading

let coopFactory: ((chapter: number) => ModeHandler) | null = null;
let duelFactory: (() => ModeHandler) | null = null;
let arenaFactory: (() => ModeHandler) | null = null;
let loadPromise: Promise<void> | null = null;

/**
 * The specifiers are held in variables on purpose: it keeps `tsc` from failing
 * the build when a sibling agent has not written their file yet, and it keeps
 * the failure at runtime where the try/catch can absorb it.
 */
const COOP_SPECIFIER = './coop.js';
const PVP_SPECIFIER = './pvp.js';

/** Import the mode modules. Never rejects. Safe to await more than once. */
export function loadModeModules(): Promise<void> {
  if (!loadPromise) loadPromise = doLoad();
  return loadPromise;
}

async function doLoad(): Promise<void> {
  try {
    const mod = (await import(COOP_SPECIFIER)) as Partial<CoopModule>;
    if (typeof mod.createCoopHandler === 'function') {
      coopFactory = mod.createCoopHandler;
    } else {
      console.warn('[modes] ./coop.js loaded but does not export createCoopHandler');
    }
  } catch (err) {
    console.warn(`[modes] co-op unavailable, using NullModeHandler: ${describe(err)}`);
  }

  try {
    const mod = (await import(PVP_SPECIFIER)) as Partial<PvpModule>;
    if (typeof mod.createDuelHandler === 'function') duelFactory = mod.createDuelHandler;
    if (typeof mod.createArenaHandler === 'function') arenaFactory = mod.createArenaHandler;
    if (!duelFactory || !arenaFactory) {
      console.warn('[modes] ./pvp.js loaded but is missing a handler factory');
    }
  } catch (err) {
    console.warn(`[modes] pvp unavailable, using NullModeHandler: ${describe(err)}`);
  }
}

/** Which modes are backed by a real implementation right now. */
export function modeStatus(): Record<GameMode, boolean> {
  return {
    coop_story: coopFactory !== null,
    pvp_duel: duelFactory !== null,
    pvp_arena: arenaFactory !== null,
  };
}

export function createModeHandler(mode: GameMode, chapter: number): ModeHandler {
  try {
    switch (mode) {
      case 'coop_story':
        if (coopFactory) return coopFactory(chapter);
        break;
      case 'pvp_duel':
        if (duelFactory) return duelFactory();
        break;
      case 'pvp_arena':
        if (arenaFactory) return arenaFactory();
        break;
    }
  } catch (err) {
    console.error(`[modes] ${mode} factory threw, falling back to NullModeHandler:`, err);
  }
  return new NullModeHandler(mode);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
