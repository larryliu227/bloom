/**
 * VOIDLINE — the deterministic simulation step.
 *
 * Both sides run this file. The server runs `stepWorld` at TICK_RATE and owns
 * the result; the client runs `stepPlayerMovement` for its own player to predict
 * ahead of the network. Anything that influences movement must therefore be a
 * pure function of (entity, input, dt, speedMul) — no RNG, no world lookups.
 *
 * Tick order (fixed — do not reorder casually, prediction and replay depend on it):
 *   0. clear last tick's events
 *   1. statuses (burn/chill/stun/shield/haste/overclock/root/mark)
 *   2. players: input -> movement -> weave charge -> ability casts
 *   3. projectiles (swept collision)
 *   4. zones (accumulator-driven damage pulses)
 *   5. enemies/summons (velocity integration + lifetimes; AI belongs to the server)
 *   6. downs, revives, respawn timers
 *   7. cull the dead
 */

import {
  ARENA_H,
  ARENA_W,
  BASIC_ATTACK_COOLDOWN,
  COOP_BLEEDOUT_RESPAWN,
  DASH_COOLDOWN,
  DASH_DURATION,
  DASH_SPEED,
  MOVE_ACCEL,
  MOVE_FRICTION,
  MOVE_MIN_MUL,
  MOVE_SLOW_FLOOR,
  MOVE_SPEED,
  REVIVE_DECAY_RATE,
  REVIVE_HP_FRACTION,
  REVIVE_RADIUS,
  REVIVE_TIME,
  ZONE_TICK_INTERVAL,
} from './constants.js';
import type {
  AbilityDef,
  EnemyEntity,
  Entity,
  EntityId,
  GameEvent,
  PlayerEntity,
  PlayerId,
  ProjectileEntity,
  Vec2,
  WorldState,
  ZoneEntity,
} from './types.js';
import { ActionBit, type InputFrame } from './protocol.js';
import { approach, approachAngle, circleHit, clamp, segmentCircle, v } from './math.js';
import {
  HOMING_ABILITIES,
  HOMING_TURN_RATE,
  SUMMON_ATTACK_INTERVAL,
  refireInterval,
} from './abilities.js';
import {
  abilityOf,
  applyDamage,
  applyStatus,
  blastRadiusOf,
  fireAbility,
  findEntity,
  getStatus,
  hasStatus,
  isHostile,
  isPlayer,
  isTargetable,
  killEntity,
  makeStatus,
  pulseSummon,
  pulseZone,
  resolveProjectileImpact,
  roleOf,
  syncShield,
  tickStatuses,
} from './combat.js';

// These come from agent A. Imported against the declared contract.
import { canFire, consumeCharge, recomputePower, updateCharge } from './weave.js';

// ============================================================ context

export interface SimContext {
  world: WorldState;
  rng: () => number;
  nextId(): EntityId;
  emit(e: GameEvent): void;
  /** Present on the server only; mode handlers hook damage/death. */
  hooks?: SimHooks;
}

export interface SimHooks {
  onDamage?(ctx: SimContext, target: Entity, amount: number, source: Entity | null): void;
  onDeath?(ctx: SimContext, entity: Entity, killer: Entity | null): void;
}

const FIRE_BITS = [ActionBit.Fire1, ActionBit.Fire2, ActionBit.Fire3] as const;

/** How far a homing projectile will look for something to chase. */
const HOMING_SEEK_RANGE = 520;
/** A walking summon closes to this fraction of its engagement range. */
const SUMMON_STANDOFF = 0.65;

/** Phases in which players may act. Movement is always simulated. */
function combatLive(world: WorldState): boolean {
  return world.phase === 'playing' || world.phase === 'intermission';
}

function neutralInput(p: PlayerEntity): InputFrame {
  return {
    seq: 0,
    move: { x: 0, y: 0 },
    aim: v.addScaled(p.pos, v.fromAngle(p.angle), 100),
    buttons: 0,
    ts: 0,
  };
}

// ============================================================ derived stats

/**
 * Effective move-speed multiplier for a player: role, then statuses.
 * The client must call this with the same entity state the server has, which is
 * exactly what reconciliation guarantees.
 */
export function playerSpeedMul(p: PlayerEntity): number {
  if (p.downed || p.respawnTimer > 0 || p.hp <= 0) return 0;
  const role = roleOf(p.role);
  return statusSpeedMul(p, role ? role.speedMul : 1);
}

/** Status-only speed scaling, usable for any entity (enemies included). */
export function statusSpeedMul(e: Entity, base: number): number {
  if (hasStatus(e, 'stun') || hasStatus(e, 'root')) return 0;
  let mul = base;
  const chill = getStatus(e, 'chill');
  if (chill) mul *= Math.max(MOVE_SLOW_FLOOR, 1 - chill.magnitude);
  const haste = getStatus(e, 'haste');
  if (haste) mul *= 1 + haste.magnitude;
  return Math.max(0, mul);
}

/** Charge-rate multiplier fed to `updateCharge`: role, then overclock. */
export function chargeRateMul(p: PlayerEntity): number {
  const role = roleOf(p.role);
  let mul = role ? role.chargeRateMul : 1;
  const oc = getStatus(p, 'overclock');
  if (oc) mul *= 1 + oc.magnitude;
  if (p.downed || p.respawnTimer > 0) mul = 0;
  return mul;
}

/** True while the player is barred from acting (not merely from moving). */
export function isActionLocked(p: PlayerEntity): boolean {
  return p.downed || p.respawnTimer > 0 || p.hp <= 0 || hasStatus(p, 'stun');
}

// ============================================================ movement (shared with prediction)

/**
 * Movement-only step used by client-side prediction for the local player.
 * Pure: no RNG, no world access, no content lookups. `speedMul` is the fully
 * resolved multiplier from `playerSpeedMul` — pass the same value on both sides.
 */
export function stepPlayerMovement(
  p: PlayerEntity,
  input: InputFrame,
  dt: number,
  speedMul: number,
): void {
  if (dt <= 0) return;

  if (p.dashCooldown > 0) p.dashCooldown = Math.max(0, p.dashCooldown - dt);

  // Facing always tracks the cursor; it is cosmetic plus the fallback aim vector.
  const ax = input.aim.x - p.pos.x;
  const ay = input.aim.y - p.pos.y;
  if (ax * ax + ay * ay > 1) p.angle = Math.atan2(ay, ax);

  const mobile = speedMul > MOVE_MIN_MUL && !p.downed && p.respawnTimer <= 0;

  // --- move input, magnitude-clamped to 1 (a client cannot ask for more).
  let mx = input.move.x;
  let my = input.move.y;
  const mlen = Math.sqrt(mx * mx + my * my);
  if (mlen > 1) {
    mx /= mlen;
    my /= mlen;
  }
  const hasMove = mlen > 0.001;

  // --- dash start
  if (
    mobile &&
    p.dashing <= 0 &&
    p.dashCooldown <= 0 &&
    (input.buttons & ActionBit.Dash) !== 0
  ) {
    // Dash the way you are moving; if you are standing still, dash where you look.
    let dx = Math.cos(p.angle);
    let dy = Math.sin(p.angle);
    if (hasMove) {
      const l = Math.sqrt(mx * mx + my * my);
      if (l > 0.001) {
        dx = mx / l;
        dy = my / l;
      }
    }
    p.dashing = DASH_DURATION;
    p.dashCooldown = DASH_COOLDOWN;
    p.vel.x = dx * DASH_SPEED;
    p.vel.y = dy * DASH_SPEED;
  }

  if (p.dashing > 0) {
    // Dash holds its velocity for the whole window — committed, readable, dodgy.
    p.dashing = Math.max(0, p.dashing - dt);
  } else {
    const target = MOVE_SPEED * speedMul;
    const desiredX = mobile && hasMove ? mx * target : 0;
    const desiredY = mobile && hasMove ? my * target : 0;
    const rate = (mobile && hasMove ? MOVE_ACCEL : MOVE_FRICTION) * dt;
    p.vel.x = approach(p.vel.x, desiredX, rate);
    p.vel.y = approach(p.vel.y, desiredY, rate);
  }

  p.pos.x += p.vel.x * dt;
  p.pos.y += p.vel.y * dt;

  // --- arena bounds; kill the velocity component that ran into the wall.
  const r = p.radius;
  if (p.pos.x < r) {
    p.pos.x = r;
    if (p.vel.x < 0) p.vel.x = 0;
  } else if (p.pos.x > ARENA_W - r) {
    p.pos.x = ARENA_W - r;
    if (p.vel.x > 0) p.vel.x = 0;
  }
  if (p.pos.y < r) {
    p.pos.y = r;
    if (p.vel.y < 0) p.vel.y = 0;
  } else if (p.pos.y > ARENA_H - r) {
    p.pos.y = ARENA_H - r;
    if (p.vel.y > 0) p.vel.y = 0;
  }
}

// ============================================================ the step

export function stepWorld(ctx: SimContext, inputs: Map<PlayerId, InputFrame>, dt: number): void {
  const world = ctx.world;

  // 0. Events are exactly one tick's worth.
  world.events.length = 0;
  world.tick += 1;
  if (dt <= 0) return;

  const snapshot = world.entities.slice();

  // 1. Statuses first: burn ticks, durations, shield decay. Movement this tick
  //    then sees the freshly-resolved slow/stun state.
  for (let i = 0; i < snapshot.length; i++) {
    const e = snapshot[i];
    if (!e.dead) tickStatuses(ctx, e, dt);
  }

  // 2..6
  for (let i = 0; i < snapshot.length; i++) {
    const e = snapshot[i];
    if (e.dead) continue;
    if (e.kind === 'player') stepPlayer(ctx, e, inputs.get(e.playerId), dt);
  }
  for (let i = 0; i < snapshot.length; i++) {
    const e = snapshot[i];
    if (e.dead) continue;
    if (e.kind === 'projectile') stepProjectile(ctx, e, dt);
    else if (e.kind === 'zone') stepZone(ctx, e, dt);
    else if (e.kind === 'enemy') stepEnemy(ctx, e, dt);
  }

  stepDownsAndRespawns(ctx, inputs, dt);

  // 7. Cull. Players are never culled — they down or wait out a respawn timer.
  //    Removed in place so anything holding a reference to `world.entities`
  //    (snapshot writers, mode handlers) keeps seeing the same array.
  const list = world.entities;
  let write = 0;
  for (let read = 0; read < list.length; read++) {
    const e = list[read];
    if (e.dead) continue;
    if (write !== read) list[write] = e;
    write++;
  }
  if (write !== list.length) list.length = write;
}

// ------------------------------------------------------------ players

function stepPlayer(ctx: SimContext, p: PlayerEntity, frame: InputFrame | undefined, dt: number): void {
  const input = frame ?? neutralInput(p);

  if (p.basicCooldown !== undefined && p.basicCooldown > 0) {
    p.basicCooldown = Math.max(0, p.basicCooldown - dt);
  }

  const wasDashing = p.dashing;
  const from = v.clone(p.pos);
  stepPlayerMovement(p, input, dt, playerSpeedMul(p));
  if (wasDashing <= 0 && p.dashing > 0) {
    ctx.emit({ t: 'dash', from, to: v.addScaled(p.pos, p.vel, DASH_DURATION), entity: p.id });
    ctx.emit({ t: 'sfx', name: 'dash', pos: from });
  }

  stepWeave(ctx, p, dt);

  if (!combatLive(ctx.world) || isActionLocked(p)) return;

  // --- weave slots
  const board = p.weave;
  if (board && board.slots) {
    for (let slot = 0; slot < board.slots.length && slot < FIRE_BITS.length; slot++) {
      if ((input.buttons & FIRE_BITS[slot]) === 0) continue;
      const ability = abilityOf(board.slots[slot].ability);
      if (!ability) continue;
      if (!canFire(board, slot, ability)) continue;
      const overcharge = consumeCharge(board, slot, ability);
      fireAbility(ctx, p, ability, input.aim, overcharge);
    }
  }

  // --- free basic attack, rate limited internally (never routed through the Weave)
  if ((input.buttons & ActionBit.Basic) !== 0 && (p.basicCooldown ?? 0) <= 0) {
    const role = roleOf(p.role);
    const basic = role ? abilityOf(role.basicAttack) : null;
    if (basic) {
      // Content sets the per-weapon cadence; the global constant is the fallback.
      const interval = refireInterval(basic.id);
      p.basicCooldown = interval > 0 ? interval : BASIC_ATTACK_COOLDOWN;
      fireAbility(ctx, p, basic, input.aim, 1);
    }
  }
}

/** Recompute power (relays mean an ally's rotation can change your board), then charge. */
function stepWeave(ctx: SimContext, p: PlayerEntity, dt: number): void {
  const board = p.weave;
  if (!board || !board.slots || board.slots.length === 0) return;

  const wasConnected: boolean[] = [];
  for (let i = 0; i < board.slots.length; i++) wasConnected.push(board.slots[i].connected);

  recomputePower(board);

  for (let i = 0; i < board.slots.length; i++) {
    if (board.slots[i].connected !== wasConnected[i]) {
      ctx.emit({
        t: 'weavePower',
        player: p.playerId,
        connected: board.slots[i].connected,
        slot: i,
      });
    }
  }

  if (p.downed || p.respawnTimer > 0) return;

  const costs: number[] = [];
  for (let i = 0; i < board.slots.length; i++) {
    const def = abilityOf(board.slots[i].ability);
    costs.push(def ? def.cost : 1);
  }

  const charged = updateCharge(board, dt, chargeRateMul(p), costs);
  if (charged && charged.length > 0) {
    for (let i = 0; i < charged.length; i++) {
      ctx.emit({ t: 'slotCharged', player: p.playerId, slot: charged[i] });
      ctx.emit({ t: 'sfx', name: 'slotCharged', pos: v.clone(p.pos) });
    }
  }
}

// ------------------------------------------------------------ projectiles

function stepProjectile(ctx: SimContext, proj: ProjectileEntity, dt: number): void {
  proj.life -= dt;
  if (proj.life <= 0) {
    expireProjectile(ctx, proj, false);
    return;
  }

  const ability = abilityOf(proj.ability);
  const friendly = ability ? ability.friendly === true : false;
  const owner = findEntity(ctx, proj.owner);

  // Homing bolts steer before they integrate — slow, weak, and they never miss.
  if (HOMING_ABILITIES.has(proj.ability)) {
    const speed = v.len(proj.vel);
    if (speed > 1) {
      const target = nearestHostile(ctx, proj, HOMING_SEEK_RANGE);
      if (target) {
        const desired = Math.atan2(target.pos.y - proj.pos.y, target.pos.x - proj.pos.x);
        const steered = approachAngle(Math.atan2(proj.vel.y, proj.vel.x), desired, HOMING_TURN_RATE * dt);
        proj.vel = v.fromAngle(steered, speed);
      }
    }
  }

  const from = v.clone(proj.pos);
  proj.pos.x += proj.vel.x * dt;
  proj.pos.y += proj.vel.y * dt;
  if (proj.vel.x !== 0 || proj.vel.y !== 0) proj.angle = Math.atan2(proj.vel.y, proj.vel.x);

  // Swept collision: fast bolts must not tunnel through a 16px player.
  const candidates = ctx.world.entities.slice();
  let closest: Entity | null = null;
  let closestD2 = Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const e = candidates[i];
    if (e.kind === 'projectile' || e.kind === 'zone') continue;
    if (e.id === proj.owner) continue;
    if (proj.pierced.indexOf(e.id) !== -1) continue;
    if (friendly) {
      if (e.team !== proj.team || e.dead || e.hp <= 0) continue;
      if (e.hp >= e.maxHp) continue; // do not waste a heal bolt on a full-HP ally
    } else {
      if (!isHostile(proj, e) || !isTargetable(e)) continue;
    }
    if (!segmentCircle(from, proj.pos, e.pos, e.radius + proj.radius)) continue;
    const d2 = v.dist2(from, e.pos);
    if (d2 < closestD2) {
      closestD2 = d2;
      closest = e;
    }
  }

  if (closest) {
    proj.pierced.push(closest.id);
    const blast = ability !== null && blastRadiusOf(ability) > 0;
    const spent = proj.pierced.length - 1;
    const survives = !blast && spent < (proj.pierce ?? 0);
    // Snap a terminal impact onto the target so the blast/VFX line up with the hit.
    if (!survives) proj.pos = v.clone(closest.pos);
    resolveProjectileImpact(ctx, proj, closest, owner);
    if (!survives) {
      proj.dead = true;
      ctx.emit({ t: 'death', pos: v.clone(proj.pos), entity: proj.id, kind: 'projectile' });
      return;
    }
  }

  // Arena exit.
  if (
    proj.pos.x < -proj.radius ||
    proj.pos.y < -proj.radius ||
    proj.pos.x > ARENA_W + proj.radius ||
    proj.pos.y > ARENA_H + proj.radius
  ) {
    proj.pos.x = clamp(proj.pos.x, 0, ARENA_W);
    proj.pos.y = clamp(proj.pos.y, 0, ARENA_H);
    expireProjectile(ctx, proj, true);
  }
}

function expireProjectile(ctx: SimContext, proj: ProjectileEntity, hitWall: boolean): void {
  if (proj.dead) return;
  proj.dead = true;
  const ability = abilityOf(proj.ability);
  // Explosive ordnance still detonates when it times out or hits a wall.
  if (ability && blastRadiusOf(ability) > 0) {
    resolveProjectileImpact(ctx, proj, null, findEntity(ctx, proj.owner));
  }
  ctx.emit({ t: 'death', pos: v.clone(proj.pos), entity: proj.id, kind: 'projectile' });
  if (hitWall) ctx.emit({ t: 'sfx', name: 'impactWall', pos: v.clone(proj.pos) });
}

// ------------------------------------------------------------ zones

function stepZone(ctx: SimContext, zone: ZoneEntity, dt: number): void {
  zone.life -= dt;

  if (zone.vel.x !== 0 || zone.vel.y !== 0) {
    zone.pos.x = clamp(zone.pos.x + zone.vel.x * dt, 0, ARENA_W);
    zone.pos.y = clamp(zone.pos.y + zone.vel.y * dt, 0, ARENA_H);
  }

  zone.tickAccumulator += dt;
  let guard = 0;
  while (zone.tickAccumulator >= ZONE_TICK_INTERVAL && guard < 8) {
    zone.tickAccumulator -= ZONE_TICK_INTERVAL;
    guard++;
    pulseZone(ctx, zone, findEntity(ctx, zone.owner), ZONE_TICK_INTERVAL);
  }

  if (zone.life <= 0) {
    zone.dead = true;
    ctx.emit({ t: 'death', pos: v.clone(zone.pos), entity: zone.id, kind: 'zone' });
  }
}

// ------------------------------------------------------------ enemies & summons

/**
 * The sim integrates enemy velocity and lifetimes; steering, telegraphs and
 * attacks are the server enemy system's job (it writes `vel` and casts through
 * `fireAbility`). Statuses apply here so a chilled chaser is slow for everyone.
 */
function stepEnemy(ctx: SimContext, e: EnemyEntity, dt: number): void {
  if (e.life !== undefined) {
    e.life -= dt;
    if (e.life <= 0) {
      killEntity(ctx, e, null);
      return;
    }
  }

  if (e.archetype.startsWith('summon:')) stepSummon(ctx, e, dt);

  const mul = statusSpeedMul(e, 1);
  if (mul > 0 && (e.vel.x !== 0 || e.vel.y !== 0)) {
    e.pos.x += e.vel.x * mul * dt;
    e.pos.y += e.vel.y * mul * dt;
    const r = e.radius;
    e.pos.x = clamp(e.pos.x, r, ARENA_W - r);
    e.pos.y = clamp(e.pos.y, r, ARENA_H - r);
  }
}

/**
 * Behaviour for entities spawned by a `summon` ability. Deliberately minimal —
 * walk to a standoff distance, pulse on SUMMON_ATTACK_INTERVAL — so the server's
 * enemy AI never has to know about player summons. `telegraph` is the pulse timer.
 */
function stepSummon(ctx: SimContext, e: EnemyEntity, dt: number): void {
  const ability = abilityOf(e.archetype.slice('summon:'.length));
  if (!ability) return;

  const friendly = ability.friendly === true;
  const range = ability.range > 0 ? ability.range : 220;

  // --- steering (immobile emplacements have speed 0 and simply hold position)
  if (ability.speed > 0) {
    const target = friendly ? null : nearestHostile(ctx, e, range * 3);
    if (target) {
      e.target = target.id;
      const d = v.dist(e.pos, target.pos);
      const standoff = range * SUMMON_STANDOFF;
      const dir = v.dir(e.pos, target.pos);
      e.angle = v.angle(dir);
      e.vel = d > standoff ? v.scale(dir, ability.speed) : { x: 0, y: 0 };
      e.aiState = d > standoff ? 'seek' : 'engage';
    } else {
      e.target = null;
      e.vel = { x: 0, y: 0 };
      e.aiState = 'idle';
    }
  } else {
    e.vel = { x: 0, y: 0 };
    e.aiState = 'hold';
  }

  // --- pulse timer
  e.telegraph = Math.max(0, e.telegraph - dt);
  if (e.telegraph <= 0) {
    const fired = pulseSummon(ctx, e, ability);
    // Retry sooner when there was nothing to shoot, so it feels responsive.
    e.telegraph = fired ? SUMMON_ATTACK_INTERVAL : Math.min(0.2, SUMMON_ATTACK_INTERVAL);
  }
}

// ------------------------------------------------------------ downs / revives / respawns

function stepDownsAndRespawns(ctx: SimContext, inputs: Map<PlayerId, InputFrame>, dt: number): void {
  const players: PlayerEntity[] = [];
  for (const e of ctx.world.entities) if (isPlayer(e) && !e.dead) players.push(e);
  if (players.length === 0) return;

  for (const p of players) {
    // --- pvp (and bled-out coop) respawn countdown
    if (p.respawnTimer > 0) {
      p.respawnTimer = Math.max(0, p.respawnTimer - dt);
      if (p.respawnTimer <= 0) {
        // The mode handler owns placement; it may call respawnPlayer() itself with
        // a spawn point. If it does not, the player simply gets back up here.
        respawnPlayer(ctx, p, null);
      }
      continue;
    }

    if (!p.downed) continue;

    // --- co-op: bleed-out
    p.downedTimer = Math.max(0, p.downedTimer - dt);

    let reviver: PlayerEntity | null = null;
    let bestD2 = Infinity;
    for (const other of players) {
      if (other.id === p.id || other.downed || other.hp <= 0 || other.respawnTimer > 0) continue;
      if (!other.connected) continue;
      if (other.team !== p.team) continue;
      const frame = inputs.get(other.playerId);
      if (!frame || (frame.buttons & ActionBit.Interact) === 0) continue;
      if (!circleHit(p.pos, REVIVE_RADIUS, other.pos, other.radius)) continue;
      const d2 = v.dist2(p.pos, other.pos);
      if (d2 < bestD2) {
        bestD2 = d2;
        reviver = other;
      }
    }

    if (reviver) {
      p.reviveProgress = clamp(p.reviveProgress + dt / REVIVE_TIME, 0, 1);
      if (p.reviveProgress >= 1) {
        p.downed = false;
        p.downedTimer = 0;
        p.reviveProgress = 0;
        p.hp = Math.max(1, Math.round(p.maxHp * REVIVE_HP_FRACTION));
        p.vel = { x: 0, y: 0 };
        ctx.emit({ t: 'revive', player: p.playerId, by: reviver.playerId });
        ctx.emit({ t: 'sfx', name: 'revive', pos: v.clone(p.pos) });
        ctx.emit({ t: 'shake', magnitude: 0.4 });
      }
    } else if (p.reviveProgress > 0) {
      p.reviveProgress = Math.max(0, p.reviveProgress - REVIVE_DECAY_RATE * dt);
    }

    // Note the re-check of `downed`: a revive this same tick must not bleed out.
    if (p.downed && p.downedTimer <= 0) {
      // Bled out. onDeath already fired when they went down; the mode handler
      // decides whether this is a wipe.
      p.downed = false;
      p.reviveProgress = 0;
      p.hp = 0;
      p.respawnTimer = COOP_BLEEDOUT_RESPAWN;
      ctx.emit({ t: 'death', pos: v.clone(p.pos), entity: p.id, kind: 'player' });
      ctx.emit({ t: 'sfx', name: 'bleedOut', pos: v.clone(p.pos) });
    }
  }
}

/**
 * Put a player back in the fight. Mode handlers should call this with a spawn
 * point from `ModeHandler.spawnPoint`; the sim calls it with `null` when a
 * respawn timer runs out on its own so nobody is ever stuck dead.
 */
export function respawnPlayer(ctx: SimContext, p: PlayerEntity, at: Vec2 | null): void {
  p.hp = p.maxHp;
  p.shield = 0;
  p.statuses.length = 0;
  p.downed = false;
  p.downedTimer = 0;
  p.reviveProgress = 0;
  p.respawnTimer = 0;
  p.dashing = 0;
  p.dashCooldown = 0;
  p.basicCooldown = 0;
  p.vel = { x: 0, y: 0 };
  if (at) {
    p.pos = {
      x: clamp(at.x, p.radius, ARENA_W - p.radius),
      y: clamp(at.y, p.radius, ARENA_H - p.radius),
    };
  }
  syncShield(p);
  ctx.emit({ t: 'sfx', name: 'respawn', pos: v.clone(p.pos) });
}

// ============================================================ small helpers for other systems

/** Damage helper for melee/contact attacks (enemy AI, props). */
export function applyContactDamage(
  ctx: SimContext,
  source: Entity,
  target: Entity,
  amount: number,
  ability: AbilityDef | null,
): void {
  if (!isTargetable(target) || !isHostile(source, target)) return;
  applyDamage(ctx, target, amount, source);
  if (ability && ability.applies) {
    applyStatus(ctx, target, makeStatus(ability.applies, ability, 1, source.id));
  }
}

/** Every live player, in entity order. */
export function playersOf(world: WorldState): PlayerEntity[] {
  const out: PlayerEntity[] = [];
  for (const e of world.entities) if (e.kind === 'player' && !e.dead) out.push(e);
  return out;
}

/** Nearest hostile actor to `from`, or null. */
export function nearestHostile(ctx: SimContext, from: Entity, maxDist: number): Entity | null {
  let best: Entity | null = null;
  let bestD2 = maxDist * maxDist;
  for (const e of ctx.world.entities) {
    if (e.kind === 'projectile' || e.kind === 'zone') continue;
    if (!isTargetable(e) || !isHostile(from, e)) continue;
    const d2 = v.dist2(from.pos, e.pos);
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = e;
    }
  }
  return best;
}
