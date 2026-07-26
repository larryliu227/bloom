/**
 * VOIDLINE — PvP arena layouts + spawn selection.
 *
 * Owned by H. Two responsibilities:
 *   1. Static arena layout data (spawn candidates + cover props). Exported so the
 *      renderer can draw the same geometry the server reasons about.
 *   2. `SpawnDirector` — picks the spawn point that maximises distance to the nearest
 *      living enemy while penalising points that were used recently or that people
 *      keep dying on (spawn camping), with a graceful fallback when everything is
 *      contested, plus a short `shield` spawn-protection window.
 *
 * No wall-clock, no Math.random. Time comes in as the caller's match clock; randomness
 * comes in as the seeded sim RNG.
 */

import type { Entity, PlayerEntity, Vec2, WorldState, GameMode } from '@shared/types.js';
import type { SimContext } from '@shared/sim.js';
import { applyStatus } from '@shared/combat.js';
import { clamp, v } from '@shared/math.js';
import { ARENA_H, ARENA_W, PLAYER_RADIUS } from '@shared/constants.js';

// ---------------------------------------------------------------- tuning

/** Seconds of post-spawn invulnerability-ish protection. */
export const SPAWN_PROTECT_TIME = 1.5;
/** Magnitude of the `shield` status granted on spawn. */
export const SPAWN_PROTECT_SHIELD = 45;
/** Distance to the nearest enemy we consider "totally safe" — more is not better. */
export const SPAWN_SAFE_DIST = 360;
/** Below this, a candidate is treated as contested and skipped unless nothing is left. */
export const SPAWN_HARD_MIN_DIST = 190;
/** How long a spawn point stays "hot" after being used. */
export const SPAWN_CAMP_WINDOW = 9.0;
/** Score penalty for a freshly-used spawn point (decays linearly over the window). */
export const SPAWN_CAMP_PENALTY = 430;
/** How long a death location keeps radiating "someone is farming here". */
export const SPAWN_DEATH_WINDOW = 12.0;
export const SPAWN_DEATH_HEAT_RADIUS = 260;
export const SPAWN_DEATH_PENALTY = 300;
/** Team modes: mild pull toward living team-mates. */
export const SPAWN_ALLY_RADIUS = 520;
export const SPAWN_ALLY_BONUS = 95;
/** Random positional scatter so two people spawning together do not stack. */
export const SPAWN_JITTER = 28;
/** Random score noise, breaks ties without overriding real safety differences. */
export const SPAWN_TIEBREAK_JITTER = 26;
/** Death heat entries kept before the oldest are dropped. */
const DEATH_HEAT_MAX = 24;

// ---------------------------------------------------------------- layout data

export type ArenaId = 'duel_spine' | 'arena_fracture';

export type PropKind = 'pillar' | 'slab' | 'conduit';

/**
 * A piece of static arena geometry. Props are *not* entities (the `Entity` union has no
 * prop member) — they are shared layout data the renderer draws and the mode reads.
 * `pillar` uses `radius`; `slab`/`conduit` use `hw`/`hh` half-extents.
 */
export interface CoverProp {
  kind: PropKind;
  pos: Vec2;
  radius: number;
  hw: number;
  hh: number;
  /** True if the prop blocks projectiles/movement, false for pure decoration. */
  solid: boolean;
}

export interface ArenaLayout {
  id: ArenaId;
  name: string;
  width: number;
  height: number;
  center: Vec2;
  /** Every candidate spawn point, used for FFA and as the universal fallback pool. */
  spawns: Vec2[];
  /** Side-clustered spawns for duels and team arena. Mirror images of each other. */
  teamSpawns: Record<'a' | 'b', Vec2[]>;
  props: CoverProp[];
}

/** Point-reflect through the arena centre — guarantees perfectly symmetric layouts. */
function mirror(p: Vec2): Vec2 {
  return { x: ARENA_W - p.x, y: ARENA_H - p.y };
}

function pillar(x: number, y: number, radius: number): CoverProp {
  return { kind: 'pillar', pos: { x, y }, radius, hw: radius, hh: radius, solid: true };
}

function slab(x: number, y: number, hw: number, hh: number): CoverProp {
  return { kind: 'slab', pos: { x, y }, radius: Math.max(hw, hh), hw, hh, solid: true };
}

function conduit(x: number, y: number, hw: number, hh: number): CoverProp {
  return { kind: 'conduit', pos: { x, y }, radius: Math.max(hw, hh), hw, hh, solid: false };
}

/** Push a prop and its mirror image. */
function sym(out: CoverProp[], p: CoverProp): void {
  out.push(p);
  const m = mirror(p.pos);
  if (Math.abs(m.x - p.pos.x) < 1 && Math.abs(m.y - p.pos.y) < 1) return; // dead centre
  out.push({ ...p, pos: m });
}

function buildDuelSpine(): ArenaLayout {
  const props: CoverProp[] = [];
  sym(props, pillar(800, 600, 58)); // the spine core
  sym(props, pillar(560, 380, 42));
  sym(props, pillar(560, 820, 42));
  sym(props, slab(800, 250, 132, 26));
  sym(props, slab(430, 600, 24, 96));
  sym(props, conduit(800, 600, 300, 4));

  const aSpawns: Vec2[] = [
    { x: 200, y: 600 },
    { x: 300, y: 265 },
  ];
  const bSpawns = aSpawns.map(mirror);

  return {
    id: 'duel_spine',
    name: 'Docking Spine',
    width: ARENA_W,
    height: ARENA_H,
    center: { x: ARENA_W / 2, y: ARENA_H / 2 },
    spawns: [...aSpawns, ...bSpawns],
    teamSpawns: { a: aSpawns, b: bSpawns },
    props,
  };
}

function buildArenaFracture(): ArenaLayout {
  const props: CoverProp[] = [];
  sym(props, pillar(800, 600, 72)); // the fracture itself
  sym(props, pillar(520, 600, 46));
  sym(props, pillar(800, 360, 46));
  sym(props, pillar(400, 320, 36));
  sym(props, pillar(1200, 320, 36));
  sym(props, slab(250, 600, 24, 124));
  sym(props, slab(800, 130, 164, 24));
  sym(props, conduit(800, 600, 6, 420));
  sym(props, conduit(800, 600, 420, 6));

  const aSpawns: Vec2[] = [
    { x: 170, y: 600 },
    { x: 210, y: 230 },
    { x: 210, y: 970 },
    { x: 520, y: 300 },
  ];
  const bSpawns = aSpawns.map(mirror);
  const extra: Vec2[] = [
    { x: 800, y: 175 },
    { x: 800, y: 1025 },
  ];

  return {
    id: 'arena_fracture',
    name: 'The Fracture',
    width: ARENA_W,
    height: ARENA_H,
    center: { x: ARENA_W / 2, y: ARENA_H / 2 },
    spawns: [...aSpawns, ...bSpawns, ...extra],
    teamSpawns: { a: aSpawns, b: bSpawns },
    props,
  };
}

export const ARENA_LAYOUTS: Record<ArenaId, ArenaLayout> = {
  duel_spine: buildDuelSpine(),
  arena_fracture: buildArenaFracture(),
};

export function getArena(id: ArenaId): ArenaLayout {
  return ARENA_LAYOUTS[id];
}

/** Which arena a PvP mode plays on. Co-op supplies its own geometry. */
export function arenaForMode(mode: GameMode): ArenaLayout {
  return mode === 'pvp_duel' ? ARENA_LAYOUTS.duel_spine : ARENA_LAYOUTS.arena_fracture;
}

// ---------------------------------------------------------------- world helpers

/** Every player entity in the world, dead or alive, connected or not. */
export function allPlayers(world: WorldState): PlayerEntity[] {
  const out: PlayerEntity[] = [];
  for (const e of world.entities) if (e.kind === 'player') out.push(e);
  return out;
}

/** Players that are on the field right now (not dead, not waiting to respawn). */
export function livingPlayers(world: WorldState): PlayerEntity[] {
  return allPlayers(world).filter(isLiving);
}

export function isLiving(p: PlayerEntity): boolean {
  return !p.dead && p.hp > 0 && p.respawnTimer <= 0 && !p.downed;
}

function nearestDist(point: Vec2, others: readonly Entity[]): number {
  let best = Infinity;
  for (const o of others) {
    const d = v.dist(point, o.pos);
    if (d < best) best = d;
  }
  return best;
}

function keyOf(p: Vec2): string {
  return `${Math.round(p.x)}:${Math.round(p.y)}`;
}

/** Keep a point inside the playable area. */
export function clampToArena(p: Vec2, layout: ArenaLayout, radius = PLAYER_RADIUS): Vec2 {
  return {
    x: clamp(p.x, radius + 4, layout.width - radius - 4),
    y: clamp(p.y, radius + 4, layout.height - radius - 4),
  };
}

// ---------------------------------------------------------------- director

export interface SpawnQuery {
  world: WorldState;
  /** The player being (re)spawned. Excluded from all proximity maths. */
  player: PlayerEntity;
  /** Should `other` be treated as an enemy of the spawning player? */
  isEnemy(other: PlayerEntity): boolean;
  /** Restrict to one side's cluster (duel / team arena). `null` = whole arena (FFA). */
  cluster: 'a' | 'b' | null;
  /** Match clock in seconds. Monotonic, supplied by the mode handler. */
  now: number;
  /** Seeded RNG (use `ctx.rng`). */
  rng: () => number;
}

interface DeathHeat {
  pos: Vec2;
  at: number;
}

/**
 * Stateful spawn picker. One per match. Remembers which points were used recently and
 * where people have been dying, so a snowballing player cannot camp an exit.
 */
export class SpawnDirector {
  readonly layout: ArenaLayout;
  /** spawn-point key -> match clock it was last used at. */
  private readonly used = new Map<string, number>();
  private deaths: DeathHeat[] = [];

  constructor(layout: ArenaLayout) {
    this.layout = layout;
  }

  reset(): void {
    this.used.clear();
    this.deaths = [];
  }

  /** Record a death location so nearby spawns go cold for a while. */
  noteDeath(pos: Vec2, now: number): void {
    this.deaths.push({ pos: { x: pos.x, y: pos.y }, at: now });
    if (this.deaths.length > DEATH_HEAT_MAX) this.deaths.shift();
  }

  /** Drop stale heat. Cheap; safe to call every tick. */
  prune(now: number): void {
    if (this.deaths.length === 0) return;
    this.deaths = this.deaths.filter((d) => now - d.at < SPAWN_DEATH_WINDOW);
  }

  markUsed(point: Vec2, now: number): void {
    this.used.set(keyOf(point), now);
  }

  /**
   * The core selection. Returns a fresh Vec2 (never a reference into layout data).
   *
   * score = min(distToNearestEnemy, 2*SAFE)   — farther from enemies is better, capped
   *       + allyBonus                          — team modes only, mild
   *       - campPenalty                        — recent use + recent nearby deaths
   *       + tiny rng                           — tie-break
   *
   * Candidates closer than SPAWN_HARD_MIN_DIST to an enemy are skipped entirely; if
   * *every* candidate is contested we fall back to the whole-arena point that is simply
   * farthest from the nearest enemy.
   */
  choose(q: SpawnQuery): Vec2 {
    this.prune(q.now);
    const layout = this.layout;
    const clustered = q.cluster ? layout.teamSpawns[q.cluster] : null;
    const pool = clustered && clustered.length > 0 ? clustered : layout.spawns;

    const living = livingPlayers(q.world).filter((o) => o !== q.player && o.playerId !== q.player.playerId);
    const enemies = living.filter((o) => q.isEnemy(o));
    const allies = living.filter((o) => !q.isEnemy(o));

    let best: Vec2 | null = null;
    let bestScore = -Infinity;
    let safest: Vec2 | null = null;
    let safestDist = -Infinity;

    for (const c of pool) {
      const ed = nearestDist(c, enemies);
      if (ed > safestDist) {
        safestDist = ed;
        safest = c;
      }
      if (ed < SPAWN_HARD_MIN_DIST) continue; // contested
      let s = Math.min(ed, SPAWN_SAFE_DIST * 2);
      if (q.cluster && allies.length > 0) {
        const ad = nearestDist(c, allies);
        if (ad < SPAWN_ALLY_RADIUS) s += SPAWN_ALLY_BONUS * (1 - ad / SPAWN_ALLY_RADIUS);
      }
      s -= this.campPenalty(c, q.now);
      s += q.rng() * SPAWN_TIEBREAK_JITTER;
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }

    let point = best;
    if (!point) {
      // Everything in the cluster is contested — widen the search to the entire arena
      // and take the single farthest point from the nearest enemy, camping be damned.
      for (const c of layout.spawns) {
        const ed = nearestDist(c, enemies);
        if (ed > safestDist) {
          safestDist = ed;
          safest = c;
        }
      }
      point = safest ?? layout.spawns[0] ?? layout.center;
    }

    this.markUsed(point, q.now);
    return this.scatter(point, q.rng);
  }

  /** Deterministic anchor lookup — duels want a fixed, fair side spawn, not a scored one. */
  anchor(cluster: 'a' | 'b', index: number): Vec2 {
    const list = this.layout.teamSpawns[cluster];
    const p = list[((index % list.length) + list.length) % list.length] ?? this.layout.center;
    return { x: p.x, y: p.y };
  }

  /** Fallback used before the match context exists (e.g. a late joiner during loadout). */
  fallback(index: number): Vec2 {
    const list = this.layout.spawns;
    const p = list[((index % list.length) + list.length) % list.length] ?? this.layout.center;
    return { x: p.x, y: p.y };
  }

  /** Brief post-spawn `shield` so you cannot be deleted the instant you materialise. */
  protect(ctx: SimContext, player: PlayerEntity, seconds = SPAWN_PROTECT_TIME): void {
    applyStatus(ctx, player, {
      kind: 'shield',
      remaining: seconds,
      magnitude: SPAWN_PROTECT_SHIELD,
      source: player.id,
    });
    ctx.emit({ t: 'sfx', name: 'pvp_spawn', pos: { x: player.pos.x, y: player.pos.y } });
  }

  private campPenalty(c: Vec2, now: number): number {
    let pen = 0;
    const last = this.used.get(keyOf(c));
    if (last !== undefined) {
      const age = now - last;
      if (age < SPAWN_CAMP_WINDOW) pen += SPAWN_CAMP_PENALTY * (1 - age / SPAWN_CAMP_WINDOW);
    }
    for (const d of this.deaths) {
      const age = now - d.at;
      if (age >= SPAWN_DEATH_WINDOW) continue;
      const dist = v.dist(c, d.pos);
      if (dist >= SPAWN_DEATH_HEAT_RADIUS) continue;
      pen += SPAWN_DEATH_PENALTY * (1 - dist / SPAWN_DEATH_HEAT_RADIUS) * (1 - age / SPAWN_DEATH_WINDOW);
    }
    return pen;
  }

  private scatter(point: Vec2, rng: () => number): Vec2 {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * SPAWN_JITTER;
    return clampToArena({ x: point.x + Math.cos(a) * r, y: point.y + Math.sin(a) * r }, this.layout);
  }
}
