/**
 * VOIDLINE — co-op enemy roster, AI and bosses.
 *
 * Everything here is data-driven: an `EnemyDef` holds the tuning numbers and a
 * pure-ish `update` function that drives one instance for one tick.
 *
 * Rules obeyed:
 *  - never `Math.random()`; all randomness comes from `ctx.rng`.
 *  - every enemy keeps `aiState`, `telegraph` and `telegraphKind` truthful so the
 *    renderer can draw a readable windup.
 *  - damage/status/ability resolution is delegated to `shared/combat.ts`.
 *  - Weave attacks go through `damageBoard` / `scrambleBoard` from `shared/weave.ts`.
 *
 * Per-instance mutable AI memory lives in this system (a `Map` keyed by entity id)
 * rather than on `EnemyEntity`, because `shared/types.ts` is frozen.
 */

import type {
  AbilityDef,
  AbilityId,
  AbilityShape,
  EnemyEntity,
  Entity,
  EntityId,
  PlayerEntity,
  StatusKind,
  Team,
  Vec2,
  WeaveBoard,
} from '@shared/types.js';
import type { SimContext } from '@shared/sim.js';
import {
  applyDamage,
  applyHeal,
  applyStatus,
  fireAbility,
  isAlly,
  isHostile,
  isTargetable,
} from '@shared/combat.js';
import { approachAngle, clamp, segmentCircle, shortestAngle, v } from '@shared/math.js';
import { damageBoard, recomputePower, scrambleBoard } from '@shared/weave.js';
import * as WeaveModule from '@shared/weave.js';
import { SUMMON_ATTACK_INTERVAL } from '@shared/abilities.js';
import { ARENA_H, ARENA_W } from '@shared/constants.js';

// ============================================================ local tuning
// (shared/constants.ts is frozen for this agent, so co-op-only numbers live here)

/** Splitters stop splitting at this depth. depth 0 -> 2 -> 4 = 7 bodies max. */
export const MAX_SPLIT_DEPTH = 2;
/** Fraction of hp/damage a body keeps per split generation. */
export const SPLIT_HP_MUL = 0.44;
export const SPLIT_SCALE_MUL = 0.7;
/**
 * Bulwark frontal shield: half-arc in radians and the fraction of damage it eats.
 *
 * 0.85 is not a taste number — it is the half-angle of the azure plate the
 * renderer strokes on the Ward body (`enemyShape`, case 'bulwark':
 * `arc(0, 0, r * 1.28, -0.85, 0.85)`). The arc used to be 1.25, so the plate you
 * could see was narrower than the plate that actually blocked: a flank at ~1.0
 * rad looked clear and still ate the 86% reduction. The drawn plate is the only
 * tell a player has, so the sim matches the tell rather than the other way round.
 */
export const BULWARK_ARC = 0.85;
export const BULWARK_BLOCK = 0.86;
/** Elite shield phase. */
export const ELITE_SHIELD_AT = 0.55;
export const ELITE_SHIELD_TIME = 3.0;
export const ELITE_SHIELD_BLOCK = 0.9;
/** How long a sapper stays scared after eating a cell. */
export const SAPPER_FLEE_TIME = 4.0;
/** Boss relay-puzzle window (Choirmaster). */
export const CHOIR_RELAY_SECONDS = 22;
/** Choirmaster stagger reward for solving the relay in time. */
export const CHOIR_STAGGER_TIME = 6.0;
export const CHOIR_STAGGER_VULN = 1.4;
/** Fracture phase transition length. */
export const FRACTURE_RIFT_TIME = 3.4;

/**
 * Half-width of the angular SAFE GAP carved out of every boss shockwave.
 *
 * This is the single most important number in the file for readability. The gap
 * is the whole counterplay of a ring attack, and the client cannot invent it:
 * `EnemyMemory` never reaches a snapshot. It travels out on `EnemyEntity.angle`
 * instead (see `EnemySystem.updateRing`) — but `angle` is one number, so it can
 * only carry the CENTRE. The half-width therefore has to be a constant both
 * sides agree on, which is why it no longer varies per boss phase.
 *
 * Difficulty still ramps: later phases push ring speed and ring damage up, so a
 * wider-looking gap is not a softer fight, it is the same fight with a door you
 * can actually see. Renderer contract: while `telegraphKind` is `choir_wail`,
 * `fracture_shock`, `fracture_ring` or `fx_ring`, the damage band is
 * `angle + RING_GAP_HALF .. angle - RING_GAP_HALF` the long way round — i.e.
 * cut the band out between `angle - 0.65` and `angle + 0.65`.
 */
export const RING_GAP_HALF = 0.65;

/** The Fracture's twin sweeping arms (phase 2+): length, half-width, tell period. */
export const FX_ARM_LEN = 640;
export const FX_ARM_WIDTH = 18;
export const FX_ARM_TELE = 0.5;

const TAU = Math.PI * 2;

/**
 * Agent A is adding `scrambleRotations` (re-rolls unlocked rotations, keeps the
 * layout) which is the better between-phases boss mechanic: it forces a full
 * re-route without erasing the player's mental map. Resolved through a namespace
 * import so this file still loads if that export has not landed yet.
 */
type BoardReroll = (board: WeaveBoard, seed: number) => void;
const rerouteBoard: BoardReroll =
  (WeaveModule as unknown as { scrambleRotations?: BoardReroll }).scrambleRotations ?? scrambleBoard;

// ============================================================ small helpers

/** Unit vector for an angle. */
function dir(a: number): Vec2 {
  return v.fromAngle(a);
}

function angleTo(from: Vec2, to: Vec2): number {
  return v.angle(v.sub(to, from));
}

/** Shortest signed difference a-b, wrapped to [-PI, PI]. */
function angDelta(a: number, b: number): number {
  return shortestAngle(b, a);
}

function turnToward(current: number, want: number, maxStep: number): number {
  return approachAngle(current, want, maxStep);
}

function rngInt(ctx: SimContext, n: number): number {
  return Math.floor(ctx.rng() * n) % Math.max(1, n);
}

function rngRange(ctx: SimContext, lo: number, hi: number): number {
  return lo + ctx.rng() * (hi - lo);
}

function seedFrom(ctx: SimContext): number {
  return (Math.floor(ctx.rng() * 0xffffffff) ^ (ctx.world.tick * 2654435761)) >>> 0;
}

function status(kind: StatusKind, remaining: number, magnitude: number, source: EntityId) {
  return { kind, remaining, magnitude, source };
}

/** Wrap to [0, TAU). Keeps a facing that carries data comparable and log-friendly. */
function wrapTau(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

// ============================================================ ring safe gap
//
// Boss shockwaves are the only attacks in the game whose counterplay is a piece
// of hidden server state. `armRingGap` decides the gap up front — at the moment
// the wind-up starts, not when the wall launches — and `faceRingGap` publishes
// it on the one field the client already receives.

/**
 * Roll the safe gap for the shockwave this boss is about to charge. Call once,
 * at the start of the wind-up, so the whole telegraph points at the way out.
 */
function armRingGap(ctx: SimContext, e: EnemyEntity, m: EnemyMemory): void {
  m.ringGapCenter = wrapTau(ctx.rng() * TAU);
  m.ringGapHalf = RING_GAP_HALF;
  faceRingGap(e, m);
}

/** Publish the armed gap centre on `angle` — the client's only channel for it. */
function faceRingGap(e: EnemyEntity, m: EnemyMemory): void {
  e.angle = m.ringGapCenter;
}

/**
 * The Fracture's twin sweeping arms (phase 2+): advance them, deal their damage,
 * and — in the same call — publish exactly where they are.
 *
 * They used to run unconditionally at the top of the boss update, which made
 * them literally undrawable: `angle` and `telegraphKind` are one channel each,
 * and whatever the boss was winding up always owned both. Two 640-unit beams
 * nobody can see is not a mechanic, it is a random damage tax.
 *
 * Now they only sweep while the boss is not committed to another move, and they
 * own the tell whenever they do. Damage and drawing are the same statement, so
 * there is no tick where an arm can hit you off-screen. The spin freezes rather
 * than jumping while the boss is busy, so the arms never teleport either.
 */
function fractureArms(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number): void {
  if (m.phase < 2) return;
  m.spin += dt * (m.phase === 3 ? 1.25 : 0.9);
  for (let i = 0; i < 2; i++) {
    sys.beamStrike(ctx, e, m, m.spin + i * Math.PI, FX_ARM_LEN, 13, FX_ARM_WIDTH, undefined, 'fracture_arm', 0.7);
  }
  // Renderer contract: `fx_arms` is an `arm` telegraph with arms = 2, so it
  // draws lanes at `angle` and `angle + PI` — the two beams above, exactly.
  e.angle = wrapTau(m.spin);
  e.telegraph = FX_ARM_TELE;
  e.telegraphKind = 'fx_arms';
}

// ============================================================ enemy abilities
// Enemy shots go through `fireAbility`, so they travel and collide exactly like
// player projectiles. `castProjectile`/`castZone` bake `damage` onto the entity,
// so these defs work without being in the player ability registry.
// NOTE: `AbilityDef.applies` is resolved by id at impact time, so it would be
// dropped for unregistered ids — enemy statuses are therefore applied directly
// by the AI (see `EnemySystem.radialStrike` / `meleeStrike`) rather than here.
// Exported so the client/renderer can resolve enemy projectile names and icons.

function mkAbility(
  id: AbilityId,
  name: string,
  shape: AbilityShape,
  o: Partial<AbilityDef>,
): AbilityDef {
  return {
    id,
    name,
    role: 'any',
    shape,
    description: 'Voidline Station defense routine.',
    cost: 0,
    damage: 0,
    range: 0,
    radius: 0,
    speed: 0,
    duration: 0,
    scalesWithOvercharge: false,
    icon: '·',
    ...o,
  };
}

export const ENEMY_ABILITIES: Record<AbilityId, AbilityDef> = {
  enemy_spit: mkAbility('enemy_spit', 'Coolant Spit', 'projectile', {
    damage: 11, range: 480, radius: 9, speed: 330, icon: '●',
  }),
  enemy_shard: mkAbility('enemy_shard', 'Casing Shard', 'projectile', {
    damage: 7, range: 250, radius: 7, speed: 300, icon: '◆',
  }),
  enemy_volley: mkAbility('enemy_volley', 'Warden Volley', 'projectile', {
    damage: 10, range: 440, radius: 8, speed: 410, icon: '▲',
  }),
  enemy_note: mkAbility('enemy_note', 'Held Note', 'projectile', {
    damage: 12, range: 1100, radius: 12, speed: 205, icon: '♪',
  }),
  enemy_orb: mkAbility('enemy_orb', 'Fracture Mote', 'projectile', {
    damage: 14, range: 1500, radius: 15, speed: 170, icon: '○',
  }),
  enemy_lance: mkAbility('enemy_lance', 'Rift Lance', 'projectile', {
    damage: 20, range: 950, radius: 10, speed: 545, icon: '→',
  }),
  enemy_ember: mkAbility('enemy_ember', 'Ember Pool', 'zone', {
    damage: 9, range: 0, radius: 76, duration: 6, icon: '░',
  }),
};

function ea(id: AbilityId): AbilityDef {
  return ENEMY_ABILITIES[id];
}

// ============================================================ memory

export interface EnemyMemory {
  archetype: string;
  def: EnemyDef;
  /** Generic sub-state timer. */
  stateTimer: number;
  /** Seconds until this enemy may start another attack. */
  attackTimer: number;
  /** Locked-in aim point captured when the telegraph started. */
  windupAim: Vec2 | null;
  windupId: EntityId | null;
  /** Splitter generation. */
  depth: number;
  scale: number;
  /** Boss phase index and one-shot gate bitmask. */
  phase: number;
  gates: number;
  cycle: number;
  /** Damage refunded after the fact (bulwark arc, shield phases, invulnerability). */
  blocked: number;
  blockFrac: number;
  /** Extra damage taken (staggered boss). */
  vuln: number;
  home: Vec2;
  strafe: number;
  /** Motion bookkeeping for the integration probe. */
  lastPos: Vec2;
  lastVel: Vec2;
  lastDt: number;
  teleported: boolean;
  /** Defend objectives: this body commits to the objective instead of players. */
  priorityLock: boolean;
  /** Per-target re-hit cooldowns for sweeping beams / rings. */
  hitCd: Map<EntityId, number>;
  /** Sweeping beam. */
  sweepAngle: number;
  sweepDir: number;
  sweepLeft: number;
  /** Expanding shockwave ring. */
  ringR: number;
  ringSpeed: number;
  ringMax: number;
  ringDamage: number;
  ringGapCenter: number;
  ringGapHalf: number;
  ringHit: Set<EntityId>;
  /** Boss bookkeeping. */
  relayPending: boolean;
  relayResult: 'none' | 'won' | 'lost';
  summonCount: number;
  hazardTimer: number;
  spin: number;
}

export interface EnemyHooks {
  /** A sapper (or worse) chewed a hole in a player's board. */
  onBoardDamaged?(player: PlayerEntity, cellIndex: number, source: EnemyEntity): void;
  /** The Fracture re-rolled everybody's routing. */
  onBoardsScrambled?(players: PlayerEntity[], source: EnemyEntity): void;
  /** The Choirmaster demands a cross-player relay circuit. Resolve with `resolveRelay`. */
  onRelayDemand?(source: EnemyEntity, seconds: number): void;
  /** A boss changed phase (0-indexed). */
  onBossPhase?(source: EnemyEntity, phase: number): void;
  /** A boss died. */
  onBossDefeated?(source: EnemyEntity): void;
  /** Flavour line requested by an enemy script. */
  onEnemyLine?(speaker: string, text: string, durationMs: number): void;
}

export interface SpawnOpts {
  hpMul?: number;
  scaleMul?: number;
  damageMul?: number;
  depth?: number;
  team?: Team;
  priorityLock?: boolean;
  /** Overrides the archetype's base hp entirely (used for the defend objective). */
  hp?: number;
  angle?: number;
}

// ============================================================ definitions

export type EnemyUpdate = (
  sys: EnemySystem,
  ctx: SimContext,
  e: EnemyEntity,
  m: EnemyMemory,
  dt: number,
) => void;

export interface EnemyDef {
  archetype: string;
  name: string;
  /** One-line renderer/AI hint. */
  blurb: string;
  hp: number;
  radius: number;
  speed: number;
  damage: number;
  /** Distance at which the archetype commits to its attack. */
  attackRange: number;
  /** Windup duration in seconds. */
  telegraph: number;
  telegraphKind: string;
  /** Seconds of vulnerable recovery after an attack lands. */
  recovery: number;
  /** Director spend cost. */
  threat: number;
  boss: boolean;
  /** Base team; overridable per spawn. */
  team: Team;
  update: EnemyUpdate;
}

// ---------------------------------------------------------------- chaser

function updateChaser(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  const t = sys.pickTarget(ctx, e, m);
  if (!t) return sys.idle(ctx, e, m, dt);
  const d = v.dist(e.pos, t.pos);
  e.target = t.id;

  if (e.aiState === 'windup') {
    e.angle = turnToward(e.angle, angleTo(e.pos, m.windupAim ?? t.pos), 2.6 * dt);
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    if (e.telegraph <= 0) {
      // Lunge: a short committed dash along the locked-in angle.
      e.aiState = 'strike';
      m.stateTimer = 0.26;
      sys.setVel(e, m, v.scale(dir(e.angle), 720));
      ctx.emit({ t: 'sfx', name: 'husk_lunge', pos: { ...e.pos } });
    }
    return;
  }
  if (e.aiState === 'strike') {
    m.stateTimer -= dt;
    sys.move(ctx, e, m, v.scale(dir(e.angle), 720), dt, true);
    sys.meleeStrike(ctx, e, m, m.def.damage, e.radius + 30, 1.1, undefined, 'chaser_hit');
    if (m.stateTimer <= 0) {
      e.aiState = 'recover';
      m.stateTimer = m.def.recovery;
    }
    return;
  }
  if (e.aiState === 'recover') {
    m.stateTimer -= dt;
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    if (m.stateTimer <= 0) e.aiState = 'pursue';
    return;
  }

  e.aiState = 'pursue';
  e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 7 * dt);
  const want = v.scale(v.norm(v.sub(t.pos, e.pos)), m.def.speed);
  sys.move(ctx, e, m, sys.avoid(ctx, e, want), dt);
  m.attackTimer -= dt;
  if (d < m.def.attackRange + t.radius + 26 && m.attackTimer <= 0) {
    sys.beginWindup(e, m, m.def.telegraph, m.def.telegraphKind, t);
  }
}

// ---------------------------------------------------------------- burster

function updateBurster(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  const t = sys.pickTarget(ctx, e, m);
  if (!t) return sys.idle(ctx, e, m, dt);
  e.target = t.id;

  if (e.aiState === 'windup') {
    sys.move(ctx, e, m, v.scale(v.norm(v.sub(t.pos, e.pos)), m.def.speed * 0.35), dt);
    if (e.telegraph <= 0) {
      sys.radialStrike(ctx, e, m, m.def.damage, m.def.attackRange, undefined);
      ctx.emit({ t: 'shake', magnitude: 4 });
      ctx.emit({ t: 'sfx', name: 'burster_pop', pos: { ...e.pos } });
      e.hp = 0;
      e.dead = true;
      e.aiState = 'spent';
    }
    return;
  }
  e.aiState = 'pursue';
  e.angle = angleTo(e.pos, t.pos);
  sys.move(ctx, e, m, v.scale(v.norm(v.sub(t.pos, e.pos)), m.def.speed), dt);
  if (v.dist(e.pos, t.pos) < m.def.attackRange * 0.55 + t.radius) {
    sys.beginWindup(e, m, m.def.telegraph, m.def.telegraphKind, t);
  }
}

// ---------------------------------------------------------------- spitter

function updateSpitter(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  const t = sys.pickTarget(ctx, e, m);
  if (!t) return sys.idle(ctx, e, m, dt);
  const d = v.dist(e.pos, t.pos);
  e.target = t.id;
  const preferred = 300;

  if (e.aiState === 'windup') {
    e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 3.4 * dt);
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    if (e.telegraph <= 0) {
      // Lead the shot a little so kiting matters but the arc stays dodgeable.
      const shot = ea('enemy_spit');
      const lead = clamp(d / shot.speed, 0, 0.55);
      const aim = { x: t.pos.x + t.vel.x * lead, y: t.pos.y + t.vel.y * lead };
      e.angle = angleTo(e.pos, aim);
      fireAbility(ctx, e, sys.scaled(shot, m), aim, 1);
      ctx.emit({ t: 'cast', pos: { ...e.pos }, ability: shot.id, caster: e.id, angle: e.angle });
      e.aiState = 'recover';
      m.stateTimer = m.def.recovery;
      m.attackTimer = m.def.recovery;
    }
    return;
  }
  if (e.aiState === 'recover') {
    m.stateTimer -= dt;
    if (m.stateTimer <= 0) e.aiState = 'kite';
  }

  e.aiState = e.aiState === 'recover' ? 'recover' : 'kite';
  e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 4 * dt);
  const away = v.norm(v.sub(e.pos, t.pos));
  const perp = { x: -away.y, y: away.x };
  let want: Vec2;
  if (d < preferred - 60) want = v.scale(away, m.def.speed);
  else if (d > preferred + 90) want = v.scale(away, -m.def.speed);
  else want = v.scale(perp, m.def.speed * 0.75 * m.strafe);
  sys.move(ctx, e, m, sys.avoid(ctx, e, want), dt);

  m.attackTimer -= dt;
  if (m.attackTimer <= 0 && d < m.def.attackRange && e.aiState === 'kite') {
    sys.beginWindup(e, m, m.def.telegraph, m.def.telegraphKind, t);
  }
}

// ---------------------------------------------------------------- bulwark

function updateBulwark(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  const t = sys.pickTarget(ctx, e, m);
  if (!t) return sys.idle(ctx, e, m, dt);
  e.target = t.id;
  const d = v.dist(e.pos, t.pos);

  if (e.aiState === 'windup') {
    // Committed: the shield stops tracking, which is the flanking window.
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    if (e.telegraph <= 0) {
      sys.meleeStrike(ctx, e, m, m.def.damage, e.radius + 58, 1.0, 'stun', 'bulwark_slam');
      ctx.emit({ t: 'shake', magnitude: 5 });
      e.aiState = 'recover';
      m.stateTimer = m.def.recovery;
    }
    return;
  }
  if (e.aiState === 'recover') {
    m.stateTimer -= dt;
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    if (m.stateTimer <= 0) {
      e.aiState = 'advance';
      m.attackTimer = 0.5;
    }
    return;
  }

  e.aiState = 'advance';
  // Slow turn is the whole point: you are meant to get behind it.
  e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 1.35 * dt);
  const want = v.scale(v.norm(v.sub(t.pos, e.pos)), m.def.speed);
  sys.move(ctx, e, m, sys.avoid(ctx, e, want), dt);
  m.attackTimer -= dt;
  if (d < m.def.attackRange + t.radius + 20 && m.attackTimer <= 0) {
    sys.beginWindup(e, m, m.def.telegraph, m.def.telegraphKind, t);
  }
}

// ---------------------------------------------------------------- splitter

function updateSplitter(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  const t = sys.pickTarget(ctx, e, m);
  if (!t) return sys.idle(ctx, e, m, dt);
  e.target = t.id;

  if (e.aiState === 'windup') {
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    if (e.telegraph <= 0) {
      sys.radialStrike(ctx, e, m, m.def.damage, e.radius + 62, undefined);
      const shard = sys.scaled(ea('enemy_shard'), m);
      const n = 5;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + ctx.rng() * 0.4;
        fireAbility(ctx, e, shard, v.add(e.pos, v.scale(dir(a), 200)), 1);
      }
      ctx.emit({ t: 'sfx', name: 'splitter_burst', pos: { ...e.pos } });
      e.aiState = 'recover';
      m.stateTimer = m.def.recovery;
    }
    return;
  }
  if (e.aiState === 'recover') {
    m.stateTimer -= dt;
    if (m.stateTimer <= 0) e.aiState = 'pursue';
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    return;
  }

  e.aiState = 'pursue';
  e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 4 * dt);
  sys.move(ctx, e, m, sys.avoid(ctx, e, v.scale(v.norm(v.sub(t.pos, e.pos)), m.def.speed)), dt);
  m.attackTimer -= dt;
  if (v.dist(e.pos, t.pos) < m.def.attackRange + t.radius + 24 && m.attackTimer <= 0) {
    sys.beginWindup(e, m, m.def.telegraph, m.def.telegraphKind, t);
  }
}

/** Called from EnemySystem.onDeath. */
function splitterOnDeath(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory) {
  if (m.depth >= MAX_SPLIT_DEPTH) return;
  const childScale = m.scale * SPLIT_SCALE_MUL;
  for (let i = 0; i < 2; i++) {
    const a = ctx.rng() * TAU;
    const pos = v.add(e.pos, v.scale(dir(a), e.radius * 0.9));
    sys.spawn(ctx, 'splitter', pos, {
      depth: m.depth + 1,
      hpMul: sys.hpMul * Math.pow(SPLIT_HP_MUL, m.depth + 1),
      scaleMul: childScale,
      damageMul: 0.75,
      priorityLock: m.priorityLock,
    });
  }
  ctx.emit({ t: 'sfx', name: 'splitter_divide', pos: { ...e.pos } });
}

// ---------------------------------------------------------------- sapper

function updateSapper(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  // The sapper ignores the defend objective — it only wants boards.
  const t = sys.nearestPlayer(ctx, e.pos);
  if (!t) return sys.idle(ctx, e, m, dt);
  e.target = t.id;

  if (e.aiState === 'flee') {
    m.stateTimer -= dt;
    const away = v.norm(v.sub(e.pos, t.pos));
    sys.move(ctx, e, m, v.scale(away, m.def.speed * 1.15), dt);
    e.angle = angleTo(e.pos, t.pos);
    if (m.stateTimer <= 0) {
      e.aiState = 'stalk';
      m.attackTimer = 1.2;
    }
    return;
  }

  if (e.aiState === 'windup') {
    // Rooted while it opens the tap: this is the kill window.
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    const lock = sys.entityById(ctx, m.windupId);
    if (lock) {
      // The renderer draws `sap` as a tether to `e.target`. `e.target` is
      // refreshed to the NEAREST player every tick, but the cell actually gets
      // burned out of the player locked in at wind-up — so the tether used to
      // point at whoever happened to be closest while a different runner's board
      // was the one on fire. Republish the locked victim: this is the only
      // warning that player gets to break line before the tap opens.
      e.target = lock.id;
      e.angle = turnToward(e.angle, angleTo(e.pos, lock.pos), 2.2 * dt);
    }
    if (e.telegraph <= 0) {
      const victim = lock && lock.kind === 'player' ? (lock as PlayerEntity) : sys.nearestPlayer(ctx, e.pos);
      const reach = m.def.attackRange + 40;
      if (victim && !victim.downed && v.dist(e.pos, victim.pos) <= reach + victim.radius) {
        const idx = damageBoard(victim.weave, seedFrom(ctx));
        recomputePower(victim.weave);
        ctx.emit({ t: 'sfx', name: 'weave_burn', pos: { ...victim.pos } });
        ctx.emit({ t: 'shake', magnitude: 6 });
        ctx.emit({ t: 'weavePower', player: victim.playerId, connected: false, slot: -1 });
        sys.hooks?.onBoardDamaged?.(victim, typeof idx === 'number' ? idx : -1, e);
      } else {
        ctx.emit({ t: 'sfx', name: 'weave_burn_miss', pos: { ...e.pos } });
      }
      e.aiState = 'flee';
      m.stateTimer = SAPPER_FLEE_TIME;
      m.attackTimer = m.def.recovery;
    }
    return;
  }

  e.aiState = 'stalk';
  e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 5 * dt);
  const d = v.dist(e.pos, t.pos);
  // Circles just outside reach, then darts in.
  const toward = v.norm(v.sub(t.pos, e.pos));
  const perp = { x: -toward.y, y: toward.x };
  const want =
    d > m.def.attackRange + 30
      ? v.add(v.scale(toward, m.def.speed), v.scale(perp, m.def.speed * 0.4 * m.strafe))
      : v.scale(perp, m.def.speed * 0.9 * m.strafe);
  sys.move(ctx, e, m, sys.avoid(ctx, e, want), dt);

  m.attackTimer -= dt;
  if (m.attackTimer <= 0 && d < m.def.attackRange + t.radius) {
    sys.beginWindup(e, m, m.def.telegraph, m.def.telegraphKind, t);
    ctx.emit({ t: 'sfx', name: 'sapper_open', pos: { ...e.pos } });
  }
}

// ---------------------------------------------------------------- turret

function updateTurret(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  sys.setVel(e, m, { x: 0, y: 0 });
  const t = sys.pickTarget(ctx, e, m);
  if (!t) {
    e.aiState = 'dormant';
    e.telegraph = 0;
    e.telegraphKind = '';
    return;
  }
  e.target = t.id;
  const d = v.dist(e.pos, t.pos);

  if (e.aiState === 'windup') {
    // Keeps tracking slowly during the sight-line so you must break the angle.
    e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 0.85 * dt);
    if (e.telegraph <= 0) {
      sys.beamStrike(ctx, e, m, e.angle, m.def.attackRange, m.def.damage, 16, undefined, 'turret_beam');
      ctx.emit({ t: 'shake', magnitude: 3.5 });
      e.aiState = 'recover';
      m.stateTimer = m.def.recovery;
      m.attackTimer = m.def.recovery;
    }
    return;
  }
  if (e.aiState === 'recover') {
    m.stateTimer -= dt;
    e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 1.6 * dt);
    if (m.stateTimer <= 0) e.aiState = 'track';
    return;
  }

  e.aiState = 'track';
  e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 1.7 * dt);
  m.attackTimer -= dt;
  const aligned = Math.abs(angDelta(angleTo(e.pos, t.pos), e.angle)) < 0.25;
  if (m.attackTimer <= 0 && d < m.def.attackRange && aligned) {
    sys.beginWindup(e, m, m.def.telegraph, m.def.telegraphKind, t);
    ctx.emit({ t: 'sfx', name: 'turret_charge', pos: { ...e.pos } });
  }
}

// ---------------------------------------------------------------- elite

function updateElite(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  const t = sys.pickTarget(ctx, e, m);
  if (!t) return sys.idle(ctx, e, m, dt);
  e.target = t.id;
  const d = v.dist(e.pos, t.pos);

  // One-shot shield phase, halfway down.
  if (!(m.gates & 1) && e.hp <= e.maxHp * ELITE_SHIELD_AT) {
    m.gates |= 1;
    e.aiState = 'shield';
    m.stateTimer = ELITE_SHIELD_TIME;
    m.blockFrac = ELITE_SHIELD_BLOCK;
    e.telegraph = ELITE_SHIELD_TIME;
    e.telegraphKind = 'elite_shield';
    applyStatus(ctx, e, status('shield', ELITE_SHIELD_TIME, 60, e.id));
    for (let i = 0; i < 2; i++) {
      const a = ctx.rng() * TAU;
      sys.spawn(ctx, 'chaser', v.add(e.pos, v.scale(dir(a), 70)), { hpMul: sys.hpMul });
    }
    ctx.emit({ t: 'sfx', name: 'elite_shield', pos: { ...e.pos } });
  }

  if (e.aiState === 'shield') {
    m.stateTimer -= dt;
    e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 1.2 * dt);
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    if (m.stateTimer <= 0) {
      m.blockFrac = 0;
      e.aiState = 'hunt';
      m.attackTimer = 0.4;
    }
    return;
  }

  if (e.aiState === 'windup') {
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 2.0 * dt);
    if (e.telegraph <= 0) {
      if (e.telegraphKind === 'elite_cleave') {
        sys.meleeStrike(ctx, e, m, m.def.damage * 1.25, e.radius + 72, 1.35, 'burn', 'elite_cleave');
        ctx.emit({ t: 'shake', magnitude: 4.5 });
      } else {
        const shot = sys.scaled(ea('enemy_volley'), m);
        for (let i = -1; i <= 1; i++) {
          const a = e.angle + i * 0.16;
          fireAbility(ctx, e, shot, v.add(e.pos, v.scale(dir(a), 400)), 1);
        }
        // Frost wash under the volley: the chill the projectiles cannot carry.
        for (const p of sys.hostileTargets(ctx, e)) {
          if (Math.abs(angDelta(angleTo(e.pos, p.pos), e.angle)) > 0.5) continue;
          if (v.dist(e.pos, p.pos) > 260) continue;
          applyStatus(ctx, p, status('chill', 2.2, 0.3, e.id));
        }
        ctx.emit({ t: 'cast', pos: { ...e.pos }, ability: shot.id, caster: e.id, angle: e.angle });
      }
      e.aiState = 'recover';
      m.stateTimer = m.def.recovery;
      m.attackTimer = m.def.recovery + 0.5;
    }
    return;
  }
  if (e.aiState === 'recover') {
    m.stateTimer -= dt;
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    if (m.stateTimer <= 0) e.aiState = 'hunt';
    return;
  }

  e.aiState = 'hunt';
  e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 4 * dt);
  const toward = v.norm(v.sub(t.pos, e.pos));
  const perp = { x: -toward.y, y: toward.x };
  const want =
    d > 240
      ? v.scale(toward, m.def.speed)
      : v.add(v.scale(toward, m.def.speed * 0.35), v.scale(perp, m.def.speed * 0.8 * m.strafe));
  sys.move(ctx, e, m, sys.avoid(ctx, e, want), dt);

  m.attackTimer -= dt;
  if (m.attackTimer <= 0) {
    const close = d < 130;
    sys.beginWindup(e, m, close ? 0.55 : m.def.telegraph, close ? 'elite_cleave' : 'elite_volley', t);
  }
}

// ---------------------------------------------------------------- vent hazard

function updateVent(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  sys.setVel(e, m, { x: 0, y: 0 });
  if (e.aiState === 'erupt') {
    m.stateTimer -= dt;
    if (m.stateTimer <= 0) {
      e.aiState = 'charging';
      e.telegraph = m.def.telegraph;
      e.telegraphKind = m.def.telegraphKind;
    }
    return;
  }
  e.aiState = 'charging';
  if (e.telegraph <= 0) {
    sys.radialStrike(ctx, e, m, m.def.damage, m.def.attackRange, 'burn');
    ctx.emit({ t: 'sfx', name: 'vent_erupt', pos: { ...e.pos } });
    ctx.emit({ t: 'shake', magnitude: 3 });
    e.aiState = 'erupt';
    m.stateTimer = m.def.recovery;
    e.telegraph = 0;
    e.telegraphKind = 'vent_open';
  }
}

// ---------------------------------------------------------------- shunt (defend objective)

function updateShunt(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  sys.setVel(e, m, { x: 0, y: 0 });
  e.aiState = e.hp < e.maxHp * 0.35 ? 'critical' : 'holding';
  e.telegraph = 0;
  e.telegraphKind = '';
  e.angle += dt * 0.6;
  if (e.angle > TAU) e.angle -= TAU;
}

// ---------------------------------------------------------------- player summons
//
// `castSummon` in shared/combat.ts spawns these as `summon:<abilityId>` and
// `stepEnemy` drives them itself. These defs cover the *bare* archetype ids, so
// anything that spawns a `ward_pylon` / `sanctum_node` / `decoy_echo` directly
// still gets driven — and never double-driven, because the prefixed form is not
// registered here. They live on the caster's team, so `isHostile` keeps them off
// their owner's allies automatically.

/** Immobile emplacement: pulses everything hostile inside range. */
function updatePylon(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  sys.setVel(e, m, { x: 0, y: 0 });
  const targets = sys.hostileTargets(ctx, e).filter((t) => v.dist(e.pos, t.pos) <= m.def.attackRange + t.radius);
  if (targets.length > 0) {
    e.aiState = 'engage';
    e.angle = turnToward(e.angle, angleTo(e.pos, targets[0].pos), 3.2 * dt);
  } else {
    e.aiState = 'hold';
    e.angle += dt * 0.9;
  }
  e.telegraphKind = 'summonAttack';
  if (e.telegraph > 0) return;
  e.telegraph = SUMMON_ATTACK_INTERVAL;
  if (targets.length === 0) return;
  const dmg = typeof e.damage === 'number' ? e.damage : m.def.damage;
  for (const t of targets) applyDamage(ctx, t, dmg, e);
  ctx.emit({ t: 'sfx', name: 'pylon_pulse', pos: { ...e.pos } });
}

/** Immobile support node: heals allies inside range, hurts nobody. */
function updateNode(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  sys.setVel(e, m, { x: 0, y: 0 });
  e.aiState = 'hold';
  e.angle += dt * 0.7;
  e.telegraphKind = 'summonPulse';
  if (e.telegraph > 0) return;
  e.telegraph = SUMMON_ATTACK_INTERVAL;
  const amount = typeof e.damage === 'number' ? e.damage : m.def.damage;
  let healed = false;
  for (const other of ctx.world.entities) {
    if (other.kind === 'projectile' || other.kind === 'zone') continue;
    if (!isAlly(e, other) || other.dead) continue;
    if (v.dist(e.pos, other.pos) > m.def.attackRange + other.radius) continue;
    applyHeal(ctx, other, amount, e);
    healed = true;
  }
  if (healed) ctx.emit({ t: 'sfx', name: 'node_pulse', pos: { ...e.pos } });
}

/** Mobile echo: seeks the nearest hostile, shoots it, soaks a burst. */
function updateEcho(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  let target: Entity | null = null;
  let bd = Infinity;
  for (const t of sys.hostileTargets(ctx, e)) {
    const d = v.dist(e.pos, t.pos);
    if (d < bd) {
      bd = d;
      target = t;
    }
  }
  if (!target) {
    e.aiState = 'idle';
    e.target = null;
    sys.setVel(e, m, { x: 0, y: 0 });
    return;
  }
  e.target = target.id;
  const standoff = m.def.attackRange * 0.65;
  e.angle = turnToward(e.angle, angleTo(e.pos, target.pos), 6 * dt);
  if (bd > standoff) {
    e.aiState = 'seek';
    sys.move(ctx, e, m, v.scale(v.dir(e.pos, target.pos), m.def.speed), dt);
  } else {
    e.aiState = 'engage';
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
  }
  e.telegraphKind = 'summonAttack';
  if (e.telegraph > 0) return;
  e.telegraph = SUMMON_ATTACK_INTERVAL;
  if (bd > m.def.attackRange + target.radius) return;
  const dmg = typeof e.damage === 'number' ? e.damage : m.def.damage;
  applyDamage(ctx, target, dmg, e);
  ctx.emit({ t: 'sfx', name: 'echo_shot', pos: { ...e.pos } });
}

// ---------------------------------------------------------------- BOSS: The Choirmaster

const CHOIR_RELAY_GATES = [0.75, 0.4];

function updateChoirmaster(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  const t = sys.nearestPlayer(ctx, e.pos);
  const frac = e.hp / e.maxHp;

  // Phase bookkeeping (cosmetic + cadence).
  const wantPhase = frac > 0.66 ? 0 : frac > 0.33 ? 1 : 2;
  if (wantPhase !== m.phase) {
    m.phase = wantPhase;
    sys.hooks?.onBossPhase?.(e, m.phase);
    ctx.emit({ t: 'shake', magnitude: 6 });
  }

  // ---- relay seal gates
  for (let i = 0; i < CHOIR_RELAY_GATES.length; i++) {
    const bit = 1 << (i + 1);
    if (!(m.gates & bit) && frac <= CHOIR_RELAY_GATES[i]) {
      m.gates |= bit;
      e.aiState = 'seal';
      e.telegraph = CHOIR_RELAY_SECONDS;
      e.telegraphKind = 'choir_seal';
      m.blockFrac = 1;
      m.relayPending = true;
      m.relayResult = 'none';
      m.stateTimer = CHOIR_RELAY_SECONDS;
      sys.hooks?.onRelayDemand?.(e, CHOIR_RELAY_SECONDS);
      ctx.emit({ t: 'sfx', name: 'choir_seal', pos: { ...e.pos } });
      break;
    }
  }

  if (e.aiState === 'seal') {
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    m.stateTimer -= dt;
    e.telegraph = Math.max(0, m.stateTimer);
    if (t) e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 0.7 * dt);
    // Pressure while the group is busy routing.
    m.hazardTimer -= dt;
    if (m.hazardTimer <= 0) {
      m.hazardTimer = 3.2;
      const note = sys.scaled(ea('enemy_note'), m);
      const n = 8;
      const off = ctx.rng() * TAU;
      for (let i = 0; i < n; i++) {
        const a = off + (i / n) * TAU;
        fireAbility(ctx, e, note, v.add(e.pos, v.scale(dir(a), 500)), 1);
      }
    }
    if (m.relayResult === 'won') {
      m.relayPending = false;
      m.blockFrac = 0;
      m.vuln = CHOIR_STAGGER_VULN;
      e.aiState = 'stagger';
      m.stateTimer = CHOIR_STAGGER_TIME;
      e.telegraph = CHOIR_STAGGER_TIME;
      e.telegraphKind = 'choir_stagger';
      ctx.emit({ t: 'sfx', name: 'choir_break', pos: { ...e.pos } });
      ctx.emit({ t: 'shake', magnitude: 9 });
      sys.hooks?.onEnemyLine?.('THE CHOIR', 'it hurts to be heard.', 2600);
    } else if (m.relayResult === 'lost' || m.stateTimer <= 0) {
      m.relayPending = false;
      m.relayResult = 'none';
      m.blockFrac = 0;
      // Failure discharge: everyone eats a heavy, unavoidable chord.
      for (const p of sys.livingPlayers(ctx)) {
        applyDamage(ctx, p, 34 * sys.damageMul, e);
        applyStatus(ctx, p, status('chill', 3, 0.35, e.id));
      }
      ctx.emit({ t: 'shake', magnitude: 12 });
      ctx.emit({ t: 'sfx', name: 'choir_discharge', pos: { ...e.pos } });
      sys.hooks?.onEnemyLine?.('THE CHOIR', 'you sang it WRONG.', 2600);
      e.aiState = 'idle';
      m.attackTimer = 1.6;
      e.telegraph = 0;
      e.telegraphKind = '';
    }
    return;
  }

  if (e.aiState === 'stagger') {
    m.stateTimer -= dt;
    e.telegraph = Math.max(0, m.stateTimer);
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    if (m.stateTimer <= 0) {
      m.vuln = 1;
      e.aiState = 'idle';
      m.attackTimer = 1.0;
      e.telegraph = 0;
      e.telegraphKind = '';
    }
    return;
  }

  if (!t) return sys.idle(ctx, e, m, dt);
  e.target = t.id;

  // ---- active attacks
  if (e.aiState === 'windup') {
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    // A wail wind-up spends its facing on the safe gap instead of on the target:
    // nothing in `choirRelease` reads `e.angle` for a wail, and the gap is the
    // only thing worth telling anyone during those 1.35 s. Every other move
    // keeps a truthful facing — `choir_sweep` in particular opens its beam at
    // `e.angle - 1.5`, so corrupting it there would aim the sweep at nothing.
    if (e.telegraphKind === 'choir_wail') faceRingGap(e, m);
    else if (t) e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 1.4 * dt);
    if (e.telegraph <= 0) choirRelease(sys, ctx, e, m);
    return;
  }
  if (e.aiState === 'sweep') {
    choirSweep(sys, ctx, e, m, dt);
    return;
  }
  if (e.aiState === 'wail') {
    sys.updateRing(ctx, e, m, dt, 'choir_wail');
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    if (!m.ringHit || m.ringR >= m.ringMax) {
      e.aiState = 'recover';
      m.stateTimer = 0.9;
    }
    return;
  }
  if (e.aiState === 'recover') {
    m.stateTimer -= dt;
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    if (m.stateTimer <= 0) e.aiState = 'idle';
    return;
  }

  // ---- reposition + choose the next move
  e.aiState = 'idle';
  e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 1.6 * dt);
  const d = v.dist(e.pos, t.pos);
  const toward = v.norm(v.sub(t.pos, e.pos));
  const perp = { x: -toward.y, y: toward.x };
  const want =
    d > 330
      ? v.scale(toward, m.def.speed)
      : v.scale(perp, m.def.speed * 0.7 * m.strafe);
  sys.move(ctx, e, m, want, dt);

  m.attackTimer -= dt;
  if (m.attackTimer > 0) return;

  const cadence = [1.9, 1.55, 1.2][m.phase];
  const patterns: string[][] = [
    ['choir_hymn', 'choir_summon', 'choir_sweep'],
    ['choir_hymn', 'choir_sweep', 'choir_summon', 'choir_wail'],
    ['choir_hymn', 'choir_wail', 'choir_sweep', 'choir_summon', 'choir_hymn'],
  ];
  const pattern: string[] = patterns[m.phase] ?? patterns[0];
  const kind = pattern[m.cycle % pattern.length];
  m.cycle++;
  const windups: Record<string, number> = {
    choir_hymn: 0.9,
    choir_summon: 1.15,
    choir_sweep: 1.0,
    choir_wail: 1.35,
  };
  sys.beginWindup(e, m, windups[kind] * (m.phase === 2 ? 0.85 : 1), kind, t);
  // Decide the wail's safe gap now, so the wind-up already points at it.
  if (kind === 'choir_wail') armRingGap(ctx, e, m);
  m.attackTimer = cadence + windups[kind];
}

function choirRelease(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory) {
  const kind = e.telegraphKind;
  if (kind === 'choir_hymn') {
    const note = sys.scaled(ea('enemy_note'), m);
    const n = [10, 14, 18][m.phase];
    const off = ctx.rng() * TAU;
    for (let i = 0; i < n; i++) {
      const a = off + (i / n) * TAU;
      fireAbility(ctx, e, note, v.add(e.pos, v.scale(dir(a), 600)), 1);
    }
    ctx.emit({ t: 'cast', pos: { ...e.pos }, ability: note.id, caster: e.id, angle: off });
    ctx.emit({ t: 'sfx', name: 'choir_hymn', pos: { ...e.pos } });
    e.aiState = 'recover';
    m.stateTimer = 0.6;
    return;
  }
  if (kind === 'choir_summon') {
    const sets: string[][] = [
      ['chaser', 'chaser', 'chaser'],
      ['chaser', 'chaser', 'spitter'],
      ['spitter', 'spitter', 'sapper'],
    ];
    const set = sets[m.phase];
    for (let i = 0; i < set.length; i++) {
      const a = (i / set.length) * TAU + ctx.rng();
      sys.spawn(ctx, set[i], v.add(e.pos, v.scale(dir(a), 130)), { hpMul: sys.hpMul });
    }
    m.summonCount += set.length;
    ctx.emit({ t: 'sfx', name: 'choir_summon', pos: { ...e.pos } });
    e.aiState = 'recover';
    m.stateTimer = 0.7;
    return;
  }
  if (kind === 'choir_sweep') {
    m.sweepAngle = e.angle - 1.5;
    // Publish where the arm actually IS on the very first frame of the sweep.
    // `choir_sweep` (charging) is drawn at `angle - 1.5` and `choir_sweep_live`
    // at `angle`; without this the kind flips a tick before the facing catches
    // up and the arm visibly jumps 1.5 rad as it goes live.
    e.angle = m.sweepAngle;
    m.sweepDir = 1;
    m.sweepLeft = [1.7, 1.45, 1.2][m.phase];
    m.hitCd.clear();
    e.aiState = 'sweep';
    e.telegraph = m.sweepLeft;
    e.telegraphKind = 'choir_sweep_live';
    ctx.emit({ t: 'sfx', name: 'choir_sweep', pos: { ...e.pos } });
    return;
  }
  // choir_wail — the gap was armed when the wind-up began.
  sys.startRing(ctx, e, m, 30, 460, 560);
  e.aiState = 'wail';
  e.telegraph = 1.2;
  e.telegraphKind = 'choir_wail';
  ctx.emit({ t: 'shake', magnitude: 8 });
  ctx.emit({ t: 'sfx', name: 'choir_wail', pos: { ...e.pos } });
}

function choirSweep(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
  const total = [1.7, 1.45, 1.2][m.phase];
  const rate = 3.0 / total;
  m.sweepAngle += rate * dt * m.sweepDir;
  m.sweepLeft -= dt;
  e.angle = m.sweepAngle;
  e.telegraph = Math.max(0, m.sweepLeft);
  // Width 16, not 20: the renderer draws this lane at halfWidth 16
  // (`TELEGRAPHS.choir_sweep_live`). A 20-unit pad meant the beam clipped people
  // standing four units outside the line they were shown.
  sys.beamStrike(ctx, e, m, m.sweepAngle, 720, 16, 16, undefined, 'choir_sweep_hit', 0.5);
  if (m.sweepLeft <= 0) {
    e.aiState = 'recover';
    m.stateTimer = 0.8;
    e.telegraph = 0;
    e.telegraphKind = '';
  }
}

// ---------------------------------------------------------------- BOSS: The Fracture

const FRACTURE_GATES = [0.75, 0.5, 0.25];

function updateFracture(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number) {
  const frac = e.hp / e.maxHp;
  const t = sys.nearestPlayer(ctx, e.pos);

  // ---- phase transitions: the board-scramble moment
  for (let i = 0; i < FRACTURE_GATES.length; i++) {
    const bit = 1 << (i + 4);
    if (!(m.gates & bit) && frac <= FRACTURE_GATES[i]) {
      m.gates |= bit;
      m.phase = i + 1;
      e.aiState = 'rift';
      m.stateTimer = FRACTURE_RIFT_TIME;
      e.telegraph = FRACTURE_RIFT_TIME;
      e.telegraphKind = 'fracture_rift';
      m.blockFrac = 1;
      m.relayPending = false;
      m.hazardTimer = 1.5; // scramble fires partway through the rift
      m.ringHit = new Set();
      // The rift ends in a shockwave. Arm its gap now: the boss then spends the
      // whole 3.4 s transition pointing at the tile you have to be standing on
      // when it lands, which is the only warning the punish ring ever gets.
      armRingGap(ctx, e, m);
      sys.hooks?.onBossPhase?.(e, m.phase);
      ctx.emit({ t: 'shake', magnitude: 14 });
      ctx.emit({ t: 'sfx', name: 'fracture_rift', pos: { ...e.pos } });
      break;
    }
  }

  if (e.aiState === 'rift') {
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    m.stateTimer -= dt;
    e.telegraph = Math.max(0, m.stateTimer);
    faceRingGap(e, m); // hold the tell for the shockwave the rift ends with

    m.hazardTimer -= dt;
    if (m.hazardTimer <= 0 && m.hazardTimer > -900) {
      m.hazardTimer = -1000; // one-shot
      const players = sys.allPlayers(ctx);
      for (const p of players) {
        if (!p.weave) continue;
        rerouteBoard(p.weave, seedFrom(ctx));
        recomputePower(p.weave);
      }
      ctx.emit({ t: 'shake', magnitude: 10 });
      ctx.emit({ t: 'sfx', name: 'weave_scramble' });
      sys.hooks?.onBoardsScrambled?.(players, e);
    }
    if (m.stateTimer <= 0) {
      m.blockFrac = 0;
      // Punish anyone who stood still through the rift. Gap armed at rift start.
      sys.startRing(ctx, e, m, 24, 700, 900);
      e.aiState = 'shock';
      e.telegraph = 1.3;
      e.telegraphKind = 'fracture_shock';
      const adds: string[][] = [
        [],
        ['chaser', 'chaser', 'spitter'],
        ['bulwark', 'spitter', 'spitter'],
        ['sapper', 'elite'],
      ];
      for (const a of adds[m.phase] ?? []) {
        const ang = ctx.rng() * TAU;
        sys.spawn(ctx, a, v.add(e.pos, v.scale(dir(ang), 210)), { hpMul: sys.hpMul });
      }
    }
    return;
  }

  if (e.aiState === 'shock') {
    sys.updateRing(ctx, e, m, dt, 'fracture_shock');
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    if (m.ringR >= m.ringMax) {
      e.aiState = 'idle';
      m.attackTimer = 0.8;
      e.telegraph = 0;
      e.telegraphKind = '';
    }
    return;
  }

  if (!t) return sys.idle(ctx, e, m, dt);
  e.target = t.id;

  // ---- persistent phase behaviour
  // The twin arms live in `fractureArms`, driven only from the uncommitted
  // states below so that their damage and their telegraph are never out of sync.
  if (m.phase >= 3) {
    m.hazardTimer -= dt;
    if (m.hazardTimer <= 0) {
      m.hazardTimer = 4.5;
      const ember = sys.scaled(ea('enemy_ember'), m);
      const p = sys.livingPlayers(ctx);
      const pick = p.length ? p[rngInt(ctx, p.length)] : null;
      const at = pick ? { ...pick.pos } : { x: ARENA_W / 2, y: ARENA_H / 2 };
      fireAbility(ctx, e, ember, at, 1);
      ctx.emit({ t: 'cast', pos: at, ability: ember.id, caster: e.id, angle: 0 });
    }
  }

  if (e.aiState === 'windup') {
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    // Same deal as the Choirmaster's wail: `fractureRelease` never reads
    // `e.angle` (orbs use their own offset, lances re-aim per player, the blink
    // rolls its own vector, sentries use fixed anchors), so the ring wind-up
    // spends the facing on the gap. Every other wind-up keeps a real facing.
    if (e.telegraphKind === 'fx_ring') faceRingGap(e, m);
    else e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 1.6 * dt);
    if (e.telegraph <= 0) fractureRelease(sys, ctx, e, m);
    return;
  }
  if (e.aiState === 'ring') {
    sys.updateRing(ctx, e, m, dt, 'fracture_ring');
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    if (m.ringR >= m.ringMax) {
      e.aiState = 'recover';
      m.stateTimer = 0.6;
      e.telegraph = 0;
      e.telegraphKind = '';
    }
    return;
  }
  if (e.aiState === 'recover') {
    m.stateTimer -= dt;
    sys.move(ctx, e, m, { x: 0, y: 0 }, dt);
    fractureArms(sys, ctx, e, m, dt);
    if (m.stateTimer <= 0) e.aiState = 'idle';
    return;
  }

  e.aiState = 'idle';
  e.angle = turnToward(e.angle, angleTo(e.pos, t.pos), 1.8 * dt);
  const d = v.dist(e.pos, t.pos);
  const toward = v.norm(v.sub(t.pos, e.pos));
  const perp = { x: -toward.y, y: toward.x };
  sys.move(
    ctx,
    e,
    m,
    d > 300 ? v.scale(toward, m.def.speed) : v.scale(perp, m.def.speed * 0.8 * m.strafe),
    dt,
  );
  sys.meleeStrike(ctx, e, m, 16, e.radius + 26, Math.PI, undefined, 'fracture_body', 0.9);

  m.attackTimer -= dt;
  if (m.attackTimer > 0) {
    // Still loitering: the arms are the only live hazard, so they own the tell.
    fractureArms(sys, ctx, e, m, dt);
    return;
  }

  const patterns: string[][] = [
    ['fx_orbs', 'fx_lance', 'fx_orbs', 'fx_ring'],
    ['fx_blink', 'fx_ring', 'fx_orbs', 'fx_lance'],
    ['fx_orbs', 'fx_blink', 'fx_ring', 'fx_lance', 'fx_sentries'],
    ['fx_blink', 'fx_orbs', 'fx_ring', 'fx_blink', 'fx_lance', 'fx_orbs'],
  ];
  const pat = patterns[m.phase];
  const kind = pat[m.cycle % pat.length];
  m.cycle++;
  const windups: Record<string, number> = {
    fx_orbs: 0.8,
    fx_lance: 0.55,
    fx_ring: 1.1,
    fx_blink: 0.85,
    fx_sentries: 1.2,
  };
  const w = windups[kind] * (m.phase >= 3 ? 0.8 : 1);
  sys.beginWindup(e, m, w, kind, t);
  // Decide the shockwave's safe gap now, so the charge already points at it.
  if (kind === 'fx_ring') armRingGap(ctx, e, m);
  m.attackTimer = [2.0, 1.7, 1.45, 1.15][m.phase] + w;
}

function fractureRelease(sys: EnemySystem, ctx: SimContext, e: EnemyEntity, m: EnemyMemory) {
  const kind = e.telegraphKind;
  const t = sys.nearestPlayer(ctx, e.pos);

  if (kind === 'fx_orbs') {
    const orb = sys.scaled(ea('enemy_orb'), m);
    const arms = 3 + m.phase;
    const per = 4;
    const off = ctx.rng() * TAU;
    for (let a = 0; a < arms; a++) {
      for (let i = 0; i < per; i++) {
        const ang = off + (a / arms) * TAU + i * 0.16;
        fireAbility(ctx, e, orb, v.add(e.pos, v.scale(dir(ang), 700)), 1);
      }
    }
    ctx.emit({ t: 'cast', pos: { ...e.pos }, ability: orb.id, caster: e.id, angle: off });
    e.aiState = 'recover';
    m.stateTimer = 0.5;
    return;
  }
  if (kind === 'fx_lance') {
    const lance = sys.scaled(ea('enemy_lance'), m);
    const targets = sys.livingPlayers(ctx);
    for (const p of targets.slice(0, 4)) {
      const a = angleTo(e.pos, p.pos);
      fireAbility(ctx, e, lance, v.add(e.pos, v.scale(dir(a), 800)), 1);
    }
    ctx.emit({ t: 'sfx', name: 'fracture_lance', pos: { ...e.pos } });
    e.aiState = 'recover';
    m.stateTimer = 0.45;
    return;
  }
  if (kind === 'fx_ring') {
    // Gap armed at wind-up start; phase scales speed and damage, not the door.
    sys.startRing(ctx, e, m, 22 + m.phase * 3, 420 + m.phase * 55, 980);
    e.aiState = 'ring';
    e.telegraph = 1.6;
    e.telegraphKind = 'fracture_ring';
    ctx.emit({ t: 'sfx', name: 'fracture_ring', pos: { ...e.pos } });
    return;
  }
  if (kind === 'fx_blink') {
    if (t) {
      const a = ctx.rng() * TAU;
      const to = {
        x: clamp(t.pos.x + Math.cos(a) * 120, e.radius, ARENA_W - e.radius),
        y: clamp(t.pos.y + Math.sin(a) * 120, e.radius, ARENA_H - e.radius),
      };
      ctx.emit({ t: 'dash', from: { ...e.pos }, to: { ...to }, entity: e.id });
      e.pos.x = to.x;
      e.pos.y = to.y;
      m.teleported = true;
    }
    sys.radialStrike(ctx, e, m, 30, 185, 'chill');
    ctx.emit({ t: 'shake', magnitude: 7 });
    ctx.emit({ t: 'sfx', name: 'fracture_slam', pos: { ...e.pos } });
    e.aiState = 'recover';
    m.stateTimer = 0.7;
    return;
  }
  // fx_sentries
  const anchors: Vec2[] = [
    { x: 240, y: 240 },
    { x: ARENA_W - 240, y: 240 },
    { x: 240, y: ARENA_H - 240 },
    { x: ARENA_W - 240, y: ARENA_H - 240 },
  ];
  const a0 = rngInt(ctx, anchors.length);
  sys.spawn(ctx, 'turret', anchors[a0], { hpMul: sys.hpMul * 0.8 });
  sys.spawn(ctx, 'turret', anchors[(a0 + 2) % anchors.length], { hpMul: sys.hpMul * 0.8 });
  ctx.emit({ t: 'sfx', name: 'fracture_sentries', pos: { ...e.pos } });
  e.aiState = 'recover';
  m.stateTimer = 0.6;
}

// ============================================================ the roster

export const ENEMIES: Record<string, EnemyDef> = {
  chaser: {
    archetype: 'chaser',
    name: 'Husk',
    blurb: 'Maintenance frame running a corrupted approach routine. Lunges.',
    hp: 34, radius: 15, speed: 195, damage: 13,
    attackRange: 40, telegraph: 0.45, telegraphKind: 'lunge',
    recovery: 0.75, threat: 1, boss: false, team: 'hostile',
    update: updateChaser,
  },
  burster: {
    archetype: 'burster',
    name: 'Wisp',
    blurb: 'Overpressured coolant bladder. Sprints in and detonates.',
    hp: 20, radius: 13, speed: 268, damage: 24,
    attackRange: 96, telegraph: 0.55, telegraphKind: 'detonate',
    recovery: 0, threat: 1.5, boss: false, team: 'hostile',
    update: updateBurster,
  },
  spitter: {
    archetype: 'spitter',
    name: 'Cinder Spitter',
    blurb: 'Lobbed coolant slug. Kites to its preferred band.',
    hp: 30, radius: 15, speed: 135, damage: 11,
    attackRange: 460, telegraph: 0.7, telegraphKind: 'aim',
    recovery: 1.15, threat: 2, boss: false, team: 'hostile',
    update: updateSpitter,
  },
  splitter: {
    archetype: 'splitter',
    name: 'Cyst',
    blurb: 'Divides on death. Twice. Then stops.',
    hp: 62, radius: 22, speed: 120, damage: 15,
    attackRange: 46, telegraph: 0.55, telegraphKind: 'burst',
    recovery: 0.9, threat: 3, boss: false, team: 'hostile',
    update: updateSplitter,
  },
  turret: {
    archetype: 'turret',
    name: 'Sentry Node',
    blurb: 'Bolted down. Long sight-line, long charge, piercing beam.',
    hp: 95, radius: 20, speed: 0, damage: 27,
    attackRange: 620, telegraph: 1.3, telegraphKind: 'beam',
    recovery: 1.7, threat: 3, boss: false, team: 'hostile',
    update: updateTurret,
  },
  sapper: {
    archetype: 'sapper',
    name: 'Unraveller',
    blurb: 'Ignores your body. Eats a cell out of your Weave and runs.',
    hp: 48, radius: 17, speed: 172, damage: 0,
    attackRange: 78, telegraph: 1.6, telegraphKind: 'sap',
    recovery: 3.0, threat: 3.5, boss: false, team: 'hostile',
    update: updateSapper,
  },
  bulwark: {
    archetype: 'bulwark',
    name: 'Ward',
    blurb: 'Frontal plate eats damage inside its facing arc. Flank it.',
    hp: 130, radius: 24, speed: 92, damage: 21,
    attackRange: 52, telegraph: 0.85, telegraphKind: 'slam',
    recovery: 1.0, threat: 4.5, boss: false, team: 'hostile',
    update: updateBulwark,
  },
  elite: {
    archetype: 'elite',
    name: 'Warden',
    blurb: 'Chilling volleys, burning cleave, one hard shield phase at 55%.',
    hp: 210, radius: 22, speed: 152, damage: 22,
    attackRange: 320, telegraph: 0.65, telegraphKind: 'elite_volley',
    recovery: 1.0, threat: 9, boss: false, team: 'hostile',
    update: updateElite,
  },
  vent: {
    archetype: 'vent',
    name: 'Coolant Vent',
    blurb: 'Static hazard. Erupts on a slow cycle. Destructible.',
    hp: 220, radius: 30, speed: 0, damage: 18,
    attackRange: 155, telegraph: 3.0, telegraphKind: 'vent',
    recovery: 2.2, threat: 0, boss: false, team: 'hostile',
    update: updateVent,
  },
  shunt: {
    archetype: 'shunt',
    name: 'Coolant Shunt',
    blurb: 'The thing you are defending. Friendly. Do not let it fall.',
    hp: 1000, radius: 40, speed: 0, damage: 0,
    attackRange: 0, telegraph: 0, telegraphKind: '',
    recovery: 0, threat: 0, boss: false, team: 'players',
    update: updateShunt,
  },
  ward_pylon: {
    archetype: 'ward_pylon',
    name: 'Ward Pylon',
    blurb: 'Player summon. Bolted down, pulses everything hostile inside 220.',
    hp: 92, radius: 18, speed: 0, damage: 11,
    attackRange: 220, telegraph: SUMMON_ATTACK_INTERVAL * 0.5, telegraphKind: 'summonAttack',
    recovery: 0, threat: 0, boss: false, team: 'players',
    update: updatePylon,
  },
  sanctum_node: {
    archetype: 'sanctum_node',
    name: 'Sanctum Node',
    blurb: 'Player summon. Heals allies inside 230. Deals no damage.',
    hp: 97, radius: 16, speed: 0, damage: 7,
    attackRange: 230, telegraph: SUMMON_ATTACK_INTERVAL * 0.5, telegraphKind: 'summonPulse',
    recovery: 0, threat: 0, boss: false, team: 'players',
    update: updateNode,
  },
  decoy_echo: {
    archetype: 'decoy_echo',
    name: 'Fracture Echo',
    blurb: 'Player summon. Walks, shoots, and pulls aggro off its owner.',
    hp: 70, radius: 16, speed: 300, damage: 8,
    attackRange: 260, telegraph: SUMMON_ATTACK_INTERVAL * 0.5, telegraphKind: 'summonAttack',
    recovery: 0, threat: 0, boss: false, team: 'players',
    update: updateEcho,
  },
  choirmaster: {
    archetype: 'choirmaster',
    name: 'The Choirmaster',
    blurb: 'Night shift, fused. Summons, sweeps, and seals itself behind a relay circuit.',
    hp: 2050, radius: 44, speed: 82, damage: 26,
    attackRange: 600, telegraph: 1.0, telegraphKind: 'choir_hymn',
    recovery: 0.8, threat: 40, boss: true, team: 'hostile',
    update: updateChoirmaster,
  },
  fracture: {
    archetype: 'fracture',
    name: 'The Fracture',
    blurb: 'Four phases. Scrambles every Weave between them.',
    hp: 2950, radius: 52, speed: 74, damage: 30,
    attackRange: 900, telegraph: 1.0, telegraphKind: 'fracture_rift',
    recovery: 0.8, threat: 60, boss: true, team: 'hostile',
    update: updateFracture,
  },
};

export const ENEMY_LIST: EnemyDef[] = Object.values(ENEMIES);

export function getEnemyDef(archetype: string): EnemyDef {
  const d = ENEMIES[archetype];
  if (!d) throw new Error(`unknown enemy archetype: ${archetype}`);
  return d;
}

export function enemyThreat(archetype: string): number {
  return ENEMIES[archetype]?.threat ?? 1;
}

// ============================================================ the system

/**
 * Owns every live enemy's AI memory for one match. Created by the co-op mode
 * handler; never a module-level singleton (rooms must not share state).
 */
export class EnemySystem {
  readonly mem = new Map<EntityId, EnemyMemory>();
  hooks: EnemyHooks | null = null;

  /** Global scalars set by the mode handler from player count + chapter. */
  hpMul = 1;
  damageMul = 1;

  /** Defend objective; a share of spawns commit to it instead of players. */
  priority: Entity | null = null;
  priorityShare = 0;

  // ---------------------------------------------------------- spawning

  spawn(ctx: SimContext, archetype: string, pos: Vec2, opts: SpawnOpts = {}): EnemyEntity {
    const def = getEnemyDef(archetype);
    const scale = opts.scaleMul ?? 1;
    const hp = opts.hp ?? def.hp * (opts.hpMul ?? this.hpMul);
    const e: EnemyEntity = {
      id: ctx.nextId(),
      kind: 'enemy',
      pos: {
        x: clamp(pos.x, def.radius * scale + 4, ARENA_W - def.radius * scale - 4),
        y: clamp(pos.y, def.radius * scale + 4, ARENA_H - def.radius * scale - 4),
      },
      vel: { x: 0, y: 0 },
      radius: Math.max(8, def.radius * scale),
      team: opts.team ?? def.team,
      hp,
      maxHp: hp,
      angle: opts.angle ?? ctx.rng() * TAU,
      statuses: [],
      dead: false,
      archetype,
      aiState: 'spawn',
      telegraph: 0,
      telegraphKind: '',
      target: null,
    };
    const m: EnemyMemory = {
      archetype,
      def: { ...def, speed: def.speed * (scale < 1 ? 1.28 : 1), damage: def.damage * (opts.damageMul ?? 1) },
      stateTimer: 0,
      attackTimer: rngRange(ctx, 0.25, 0.9),
      windupAim: null,
      windupId: null,
      depth: opts.depth ?? 0,
      scale,
      phase: 0,
      gates: 0,
      cycle: 0,
      blocked: 0,
      blockFrac: 0,
      vuln: 1,
      home: { ...pos },
      strafe: ctx.rng() < 0.5 ? -1 : 1,
      lastPos: { ...pos },
      lastVel: { x: 0, y: 0 },
      lastDt: 0,
      teleported: true,
      priorityLock: opts.priorityLock ?? (this.priority !== null && ctx.rng() < this.priorityShare),
      hitCd: new Map(),
      sweepAngle: 0,
      sweepDir: 1,
      sweepLeft: 0,
      ringR: 0,
      ringSpeed: 0,
      ringMax: 0,
      ringDamage: 0,
      ringGapCenter: 0,
      ringGapHalf: 0,
      ringHit: new Set(),
      relayPending: false,
      relayResult: 'none',
      summonCount: 0,
      hazardTimer: 0,
      spin: ctx.rng() * TAU,
    };
    this.mem.set(e.id, m);
    ctx.world.entities.push(e);
    ctx.emit({ t: 'sfx', name: def.boss ? 'boss_spawn' : 'enemy_spawn', pos: { ...e.pos } });
    return e;
  }

  memoryOf(e: EnemyEntity): EnemyMemory | null {
    return this.mem.get(e.id) ?? null;
  }

  /** Every live hostile body (excludes friendly props like the shunt). */
  liveEnemies(ctx: SimContext): EnemyEntity[] {
    const out: EnemyEntity[] = [];
    for (const en of ctx.world.entities) {
      if (en.kind !== 'enemy' || en.dead) continue;
      const e = en as EnemyEntity;
      if (e.team !== 'hostile') continue;
      out.push(e);
    }
    return out;
  }

  /** Live hostiles that count against a wave (hazards and the shunt do not). */
  liveCombatants(ctx: SimContext): EnemyEntity[] {
    return this.liveEnemies(ctx).filter((e) => e.archetype !== 'vent');
  }

  bosses(ctx: SimContext): EnemyEntity[] {
    return this.liveEnemies(ctx).filter((e) => ENEMIES[e.archetype]?.boss);
  }

  /** Remove everything hostile (chapter transitions / boss intros). */
  clearHostiles(ctx: SimContext, keepBosses = false): void {
    for (const e of this.liveEnemies(ctx)) {
      if (keepBosses && ENEMIES[e.archetype]?.boss) continue;
      e.dead = true;
      e.hp = 0;
      this.mem.delete(e.id);
    }
  }

  // ---------------------------------------------------------- targeting

  allPlayers(ctx: SimContext): PlayerEntity[] {
    const out: PlayerEntity[] = [];
    for (const en of ctx.world.entities) if (en.kind === 'player') out.push(en as PlayerEntity);
    return out;
  }

  livingPlayers(ctx: SimContext): PlayerEntity[] {
    return this.allPlayers(ctx).filter((p) => !p.dead && !p.downed && p.connected !== false);
  }

  nearestPlayer(ctx: SimContext, from: Vec2): PlayerEntity | null {
    let best: PlayerEntity | null = null;
    let bd = Infinity;
    for (const p of this.livingPlayers(ctx)) {
      const d = v.dist(from, p.pos);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  entityById(ctx: SimContext, id: EntityId | null): Entity | null {
    if (id === null || id === undefined) return null;
    for (const en of ctx.world.entities) if (en.id === id && !en.dead) return en;
    return null;
  }

  /**
   * Who this body walks at. Priority order:
   *  1. the defend objective, for the share of bodies committed to it
   *  2. a Phantom decoy, if one is closer than the nearest runner (that is the
   *     whole point of a decoy)
   *  3. the nearest runner
   */
  pickTarget(ctx: SimContext, e: EnemyEntity, m: EnemyMemory): Entity | null {
    if (m.priorityLock && this.priority && !this.priority.dead && this.priority.hp > 0) {
      return this.priority;
    }
    const p = this.nearestPlayer(ctx, e.pos);
    const decoy = this.nearestDecoy(ctx, e);
    if (decoy && (!p || v.dist(e.pos, decoy.pos) < v.dist(e.pos, p.pos))) return decoy;
    if (p) return p;
    if (this.priority && !this.priority.dead && this.priority.hp > 0) return this.priority;
    return null;
  }

  /** Hostile summons (Phantom echoes, Bulwark pylons) pull aggro like bodies do. */
  private nearestDecoy(ctx: SimContext, e: EnemyEntity): Entity | null {
    let best: Entity | null = null;
    let bd = Infinity;
    for (const en of ctx.world.entities) {
      if (en.kind !== 'enemy') continue;
      const other = en as EnemyEntity;
      if (!other.archetype.includes('decoy_echo')) continue;
      if (!isHostile(e, other) || !isTargetable(other)) continue;
      const d = v.dist(e.pos, other.pos);
      if (d < bd) {
        bd = d;
        best = other;
      }
    }
    return best;
  }

  /**
   * All bodies this enemy is allowed to hurt. Delegates the rules to
   * `isHostile` + `isTargetable`, so downs, i-frames, the friendly-team coolant
   * shunt and player summons are all handled consistently.
   */
  hostileTargets(ctx: SimContext, e: EnemyEntity): Entity[] {
    const out: Entity[] = [];
    for (const en of ctx.world.entities) {
      if (en.kind === 'projectile' || en.kind === 'zone') continue;
      if (!isHostile(e, en) || !isTargetable(en)) continue;
      out.push(en);
    }
    return out;
  }

  // ---------------------------------------------------------- motion

  setVel(e: EnemyEntity, m: EnemyMemory, want: Vec2): void {
    e.vel.x = want.x;
    e.vel.y = want.y;
  }

  /**
   * Sets desired velocity. `stepEnemy` in shared/sim.ts integrates it (applying
   * chill/stun via `statusSpeedMul`) and clamps to the arena, so this must not
   * integrate or slow anything itself. `force` is kept for readability at
   * committed-dash call sites.
   */
  move(ctx: SimContext, e: EnemyEntity, m: EnemyMemory, want: Vec2, dt: number, force = false): void {
    e.vel.x = want.x;
    e.vel.y = want.y;
    e.pos.x = clamp(e.pos.x, e.radius, ARENA_W - e.radius);
    e.pos.y = clamp(e.pos.y, e.radius, ARENA_H - e.radius);
    m.lastPos.x = e.pos.x;
    m.lastPos.y = e.pos.y;
    m.lastVel.x = want.x;
    m.lastVel.y = want.y;
    m.lastDt = dt;
    m.teleported = false;
    void force;
  }

  /** Cheap separation so packs do not stack into one pixel. */
  avoid(ctx: SimContext, e: EnemyEntity, want: Vec2): Vec2 {
    let px = 0;
    let py = 0;
    let n = 0;
    for (const other of ctx.world.entities) {
      if (other === e || other.kind !== 'enemy' || other.dead) continue;
      const dx = e.pos.x - other.pos.x;
      const dy = e.pos.y - other.pos.y;
      const want2 = (e.radius + other.radius) * 1.05;
      const d2 = dx * dx + dy * dy;
      if (d2 > want2 * want2 || d2 < 0.0001) continue;
      const d = Math.sqrt(d2);
      px += (dx / d) * (want2 - d);
      py += (dy / d) * (want2 - d);
      n++;
      if (n > 6) break;
    }
    if (n === 0) return want;
    return { x: want.x + px * 9, y: want.y + py * 9 };
  }

  idle(ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number): void {
    e.aiState = 'idle';
    e.telegraph = 0;
    e.telegraphKind = '';
    e.target = null;
    const center = { x: ARENA_W / 2, y: ARENA_H / 2 };
    const d = v.dist(e.pos, center);
    const want = d > 200 ? v.scale(v.norm(v.sub(center, e.pos)), m.def.speed * 0.35) : { x: 0, y: 0 };
    this.move(ctx, e, m, want, dt);
  }

  // ---------------------------------------------------------- attack helpers

  beginWindup(e: EnemyEntity, m: EnemyMemory, seconds: number, kind: string, target: Entity | null): void {
    e.aiState = 'windup';
    e.telegraph = seconds;
    e.telegraphKind = kind;
    m.windupAim = target ? { ...target.pos } : null;
    m.windupId = target ? target.id : null;
    if (target) e.angle = angleTo(e.pos, target.pos);
  }

  /** Scales an enemy ability def by the system damage multiplier. */
  scaled(def: AbilityDef, m: EnemyMemory): AbilityDef {
    if (this.damageMul === 1) return def;
    return { ...def, damage: def.damage * this.damageMul };
  }

  meleeStrike(
    ctx: SimContext,
    e: EnemyEntity,
    m: EnemyMemory,
    damage: number,
    range: number,
    halfArc: number,
    applies?: StatusKind,
    sfx?: string,
    reHitCd = 0,
  ): void {
    let hit = false;
    for (const t of this.hostileTargets(ctx, e)) {
      if (reHitCd > 0) {
        const cd = m.hitCd.get(t.id) ?? 0;
        if (cd > 0) continue;
      }
      if (v.dist(e.pos, t.pos) > range + t.radius) continue;
      if (halfArc < Math.PI && Math.abs(angDelta(angleTo(e.pos, t.pos), e.angle)) > halfArc) continue;
      applyDamage(ctx, t, damage * this.damageMul, e);
      if (applies) applyStatus(ctx, t, status(applies, applies === 'stun' ? 0.55 : 3, applies === 'burn' ? 6 : 0.35, e.id));
      if (reHitCd > 0) m.hitCd.set(t.id, reHitCd);
      hit = true;
    }
    if (hit && sfx) ctx.emit({ t: 'sfx', name: sfx, pos: { ...e.pos } });
  }

  radialStrike(ctx: SimContext, e: EnemyEntity, m: EnemyMemory, damage: number, radius: number, applies?: StatusKind): void {
    for (const t of this.hostileTargets(ctx, e)) {
      const d = v.dist(e.pos, t.pos);
      if (d > radius + t.radius) continue;
      // Slight falloff so the rim is survivable.
      const falloff = clamp(1 - (d / (radius + t.radius)) * 0.35, 0.6, 1);
      applyDamage(ctx, t, damage * falloff * this.damageMul, e);
      if (applies) applyStatus(ctx, t, status(applies, 3, applies === 'burn' ? 6 : 0.35, e.id));
    }
  }

  beamStrike(
    ctx: SimContext,
    e: EnemyEntity,
    m: EnemyMemory,
    angle: number,
    length: number,
    damage: number,
    width: number,
    applies?: StatusKind,
    sfx?: string,
    reHitCd = 0,
  ): void {
    const p1 = v.add(e.pos, v.scale(dir(angle), length));
    let hit = false;
    for (const t of this.hostileTargets(ctx, e)) {
      if (reHitCd > 0 && (m.hitCd.get(t.id) ?? 0) > 0) continue;
      if (!segmentCircle(e.pos, p1, t.pos, t.radius + width)) continue;
      applyDamage(ctx, t, damage * this.damageMul, e);
      if (applies) applyStatus(ctx, t, status(applies, 3, applies === 'burn' ? 6 : 0.35, e.id));
      if (reHitCd > 0) m.hitCd.set(t.id, reHitCd);
      hit = true;
    }
    if (hit && sfx) ctx.emit({ t: 'sfx', name: sfx, pos: { ...p1 } });
  }

  /**
   * Expanding shockwave band with an angular safe gap.
   *
   * The gap centre is expected to already be armed by `armRingGap` at the START
   * of the wind-up, not rolled here: the player needs the whole telegraph to
   * walk into the gap, not the instant the wall leaves the boss.
   */
  startRing(ctx: SimContext, e: EnemyEntity, m: EnemyMemory, damage: number, speed: number, max: number): void {
    void ctx;
    m.ringR = 0;
    m.ringSpeed = speed;
    m.ringMax = max;
    m.ringDamage = damage;
    m.ringGapHalf = RING_GAP_HALF;
    m.ringHit = new Set();
    faceRingGap(e, m);
  }

  updateRing(ctx: SimContext, e: EnemyEntity, m: EnemyMemory, dt: number, kind: string): void {
    if (m.ringR >= m.ringMax) return;
    m.ringR += m.ringSpeed * dt;
    e.telegraphKind = kind;
    e.telegraph = Math.max(0, (m.ringMax - m.ringR) / Math.max(1, m.ringSpeed));
    // Route the safe gap to the client. `EnemyMemory` is server-only and
    // `shared/types.ts` is frozen, but `angle` is in every snapshot and a ring
    // caster provably does not use its facing while the wave is in flight
    // (no beam, melee arc or aimed shot reads `e.angle` in the `wail` / `ring` /
    // `shock` states), so the facing carries the gap centre instead.
    faceRingGap(e, m);
    const band = 58;
    for (const t of this.hostileTargets(ctx, e)) {
      if (m.ringHit.has(t.id)) continue;
      const d = v.dist(e.pos, t.pos);
      if (Math.abs(d - m.ringR) > band + t.radius) continue;
      if (m.ringGapHalf > 0) {
        const a = angleTo(e.pos, t.pos);
        if (Math.abs(angDelta(a, m.ringGapCenter)) < m.ringGapHalf) {
          m.ringHit.add(t.id); // stood in the gap: safe for this ring
          continue;
        }
      }
      applyDamage(ctx, t, m.ringDamage * this.damageMul, e);
      m.ringHit.add(t.id);
    }
  }

  // ---------------------------------------------------------- damage hooks

  /**
   * Called from the mode handler's `onDamage`. Records damage that should not
   * have landed (bulwark arc / shield phases / boss invulnerability) so it can be
   * refunded regardless of whether the sim calls us before or after applying it.
   */
  onDamage(ctx: SimContext, target: Entity, amount: number, source: Entity | null): void {
    if (target.kind !== 'enemy') return;
    const e = target as EnemyEntity;
    const m = this.mem.get(e.id);
    if (!m) return;

    let block = m.blockFrac;
    if (e.archetype === 'bulwark' && source) {
      const a = angleTo(e.pos, source.pos);
      if (Math.abs(angDelta(a, e.angle)) <= BULWARK_ARC) {
        block = Math.max(block, BULWARK_BLOCK);
        ctx.emit({ t: 'sfx', name: 'bulwark_block', pos: { ...e.pos } });
      }
    }
    if (block > 0) m.blocked += amount * block;
    // Staggered bosses take extra: refund is negative.
    if (m.vuln > 1) m.blocked -= amount * (m.vuln - 1);
  }

  /** Re-applies blocked/bonus damage. Safe to call in any order. */
  private settle(ctx: SimContext, e: EnemyEntity, m: EnemyMemory): void {
    if (m.blocked === 0) return;
    e.hp = Math.min(e.maxHp, e.hp + m.blocked);
    m.blocked = 0;
    if (e.hp > 0 && e.dead) {
      e.dead = false;
      if (!ctx.world.entities.includes(e)) ctx.world.entities.push(e);
    }
    if (e.hp <= 0 && !e.dead) {
      e.hp = 0;
      e.dead = true;
    }
  }

  /**
   * Called from the mode handler's `onDeath`.
   * Returns false if the body survived after blocked damage was refunded.
   */
  onDeath(ctx: SimContext, entity: Entity, killer: Entity | null): boolean {
    if (entity.kind !== 'enemy') return true;
    const e = entity as EnemyEntity;
    const m = this.mem.get(e.id);
    if (!m) return true;
    this.settle(ctx, e, m);
    if (e.hp > 0 && !e.dead) return false;

    if (m.archetype === 'splitter') splitterOnDeath(this, ctx, e, m);
    if (m.archetype === 'burster' && e.aiState !== 'spent') {
      this.radialStrike(ctx, e, m, m.def.damage * 0.55, m.def.attackRange * 0.7, undefined);
    }
    if (ENEMIES[m.archetype]?.boss) {
      ctx.emit({ t: 'shake', magnitude: 18 });
      ctx.emit({ t: 'sfx', name: 'boss_death', pos: { ...e.pos } });
      this.hooks?.onBossDefeated?.(e);
    }
    this.mem.delete(e.id);
    return true;
  }

  /** Choirmaster relay puzzle resolution, called by the co-op handler. */
  resolveRelay(bossId: EntityId, success: boolean): void {
    const m = this.mem.get(bossId);
    if (!m || !m.relayPending) return;
    m.relayResult = success ? 'won' : 'lost';
  }

  relayPendingFor(e: EnemyEntity): boolean {
    return this.mem.get(e.id)?.relayPending ?? false;
  }

  bossPhase(e: EnemyEntity): number {
    return this.mem.get(e.id)?.phase ?? 0;
  }

  // ---------------------------------------------------------- tick

  /**
   * Give AI memory to a body this system did not spawn — player summons dropped
   * in by `castSummon`, or anything else that pushes a known archetype straight
   * into the world. Bodies whose archetype is prefixed `summon:` are skipped:
   * `stepEnemy` in shared/sim.ts already drives those, and driving them twice
   * would double their fire rate.
   *
   * `EnemyEntity.life` is *not* ticked here for the same reason — `stepEnemy`
   * decrements it and kills at zero for every enemy in the world.
   */
  private adopt(ctx: SimContext, e: EnemyEntity): EnemyMemory | null {
    if (e.archetype.startsWith('summon:')) return null;
    const def = ENEMIES[e.archetype];
    if (!def) return null;
    const m: EnemyMemory = {
      archetype: e.archetype,
      def,
      stateTimer: 0,
      attackTimer: 0,
      windupAim: null,
      windupId: null,
      depth: 0,
      scale: 1,
      phase: 0,
      gates: 0,
      cycle: 0,
      blocked: 0,
      blockFrac: 0,
      vuln: 1,
      home: { ...e.pos },
      strafe: ctx.rng() < 0.5 ? -1 : 1,
      lastPos: { ...e.pos },
      lastVel: { x: 0, y: 0 },
      lastDt: 0,
      teleported: true,
      priorityLock: false,
      hitCd: new Map(),
      sweepAngle: 0,
      sweepDir: 1,
      sweepLeft: 0,
      ringR: 0,
      ringSpeed: 0,
      ringMax: 0,
      ringDamage: 0,
      ringGapCenter: 0,
      ringGapHalf: 0,
      ringHit: new Set(),
      relayPending: false,
      relayResult: 'none',
      summonCount: 0,
      hazardTimer: 0,
      spin: ctx.rng() * TAU,
    };
    this.mem.set(e.id, m);
    return m;
  }

  update(ctx: SimContext, dt: number): void {
    for (const en of ctx.world.entities) {
      if (en.kind !== 'enemy') continue;
      const e = en as EnemyEntity;
      const m = this.mem.get(e.id) ?? this.adopt(ctx, e);
      if (!m) continue;

      this.settle(ctx, e, m);
      if (e.dead || e.hp <= 0) continue;

      // Re-hit cooldowns.
      if (m.hitCd.size) {
        for (const [id, cd] of m.hitCd) {
          const n = cd - dt;
          if (n <= 0) m.hitCd.delete(id);
          else m.hitCd.set(id, n);
        }
      }

      // Telegraph always ticks down; AI reads it hitting zero as "release".
      if (e.telegraph > 0) {
        e.telegraph = Math.max(0, e.telegraph - dt);
      }

      // Hard CC gates behaviour but never the telegraph readout.
      const stunned = e.statuses.some((s) => s.kind === 'stun');
      if (stunned) {
        this.setVel(e, m, { x: 0, y: 0 });
        m.lastVel.x = 0;
        m.lastVel.y = 0;
        m.lastDt = dt;
        m.lastPos.x = e.pos.x;
        m.lastPos.y = e.pos.y;
        continue;
      }

      m.def.update(this, ctx, e, m, dt);
    }

    // Reap memory for bodies the sim culled.
    if (this.mem.size > 0 && ctx.world.tick % 20 === 0) {
      const live = new Set<EntityId>();
      for (const en of ctx.world.entities) if (!en.dead) live.add(en.id);
      for (const id of this.mem.keys()) if (!live.has(id)) this.mem.delete(id);
    }
  }
}
