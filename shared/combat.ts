/**
 * VOIDLINE — combat resolution.
 *
 * Everything that turns intent into consequences: firing an ability, dealing
 * damage, applying and ticking statuses. Deterministic; the only randomness
 * available is `ctx.rng` and this module deliberately does not use it, so a
 * client replaying a cast produces the same shapes the server does.
 *
 * Data conventions (AbilityDef is intentionally small, so these are the rules
 * the content in shared/abilities.ts is written against):
 *   - `damage` on a `zone` is damage PER SECOND; sim.ts slices it into pulses.
 *   - `damage` on a `buff` doubles as the status magnitude (shield absorb, etc.).
 *   - `radius` on a `projectile` > PROJECTILE_BODY_RADIUS makes it explosive.
 *   - `radius` on a `beam` is its half-thickness.
 *   - `speed` 0 on a `dash` means blink (instant teleport).
 */

import {
  ARENA_H,
  ARENA_W,
  BEAM_HALF_WIDTH,
  BEAM_PIERCE_DEFAULT,
  BLAST_FALLOFF,
  BLAST_VFX_MIN_RADIUS,
  BURN_TICK_INTERVAL,
  CRIT_HP_FRACTION,
  DASH_DURATION,
  DASH_HIT_RADIUS,
  DASH_IFRAMES,
  DASH_MAX_DURATION,
  DASH_MIN_DURATION,
  DASH_SPEED,
  DOWNED_DURATION,
  MAX_OVERCHARGE,
  PROJECTILE_MAX_LIFE,
  PROJECTILE_RADIUS_DEFAULT,
  PROJECTILE_RADIUS_MAX,
  RESPAWN_DELAY,
  SHAKE_MAX,
  SHAKE_PER_DAMAGE,
  SHIELD_DECAY_RATE,
  SHIELD_MAX,
  STATUS_BURN_DPS_FRACTION,
  STATUS_BURN_MIN_DPS,
  STATUS_CHILL_SLOW,
  STATUS_DURATION_BURN,
  STATUS_DURATION_CHILL,
  STATUS_DURATION_HASTE,
  STATUS_DURATION_MARK,
  STATUS_DURATION_OVERCLOCK,
  STATUS_DURATION_ROOT,
  STATUS_DURATION_SHIELD,
  STATUS_DURATION_STUN,
  STATUS_HASTE_BONUS,
  STATUS_MARK_AMP,
  STATUS_OVERCLOCK_BONUS,
  STATUS_SHIELD_DEFAULT,
  SUMMON_BASE_HP,
  SUMMON_DEFAULT_LIFE,
  SUMMON_HP_PER_DAMAGE,
  SUMMON_RADIUS_DEFAULT,
  ZONE_RADIUS_DEFAULT,
} from './constants.js';
import type {
  AbilityDef,
  AbilityId,
  EnemyEntity,
  Entity,
  EntityId,
  PlayerEntity,
  ProjectileEntity,
  RoleDef,
  RoleId,
  Status,
  StatusKind,
  Vec2,
  ZoneEntity,
} from './types.js';
import { circleHit, clamp, segmentCircle, v } from './math.js';
import type { SimContext } from './sim.js';

// These come from agent B. Imported against the declared contract.
// `statusFor`, `summonHp` and PROJECTILE_BODY_RADIUS are B's resolution helpers:
// content owns the magnitudes, combat.ts only stamps them onto entities.
import {
  PROJECTILE_BODY_RADIUS,
  SUMMON_ATTACK_INTERVAL,
  getAbility,
  isAbilityId,
  statusFor,
  summonHp,
} from './abilities.js';
import { getRole } from './roles.js';

// ============================================================ narrowing helpers

export function isPlayer(e: Entity): e is PlayerEntity {
  return e.kind === 'player';
}
export function isEnemy(e: Entity): e is EnemyEntity {
  return e.kind === 'enemy';
}
export function isProjectile(e: Entity): e is ProjectileEntity {
  return e.kind === 'projectile';
}
export function isZone(e: Entity): e is ZoneEntity {
  return e.kind === 'zone';
}
/** Entities that occupy space and can be hit (as opposed to projectiles/zones). */
export function isActor(e: Entity): e is PlayerEntity | EnemyEntity {
  return e.kind === 'player' || e.kind === 'enemy';
}

/**
 * Content lookups are defensive: a malformed loadout id must never take the
 * server down mid-match. Returns null instead of throwing.
 */
export function abilityOf(id: AbilityId | null | undefined): AbilityDef | null {
  if (!id || !isAbilityId(id)) return null;
  try {
    const def = getAbility(id);
    return def ?? null;
  } catch {
    return null;
  }
}

/**
 * Splash radius of a projectile, 0 for a plain bolt. Per the content contract the
 * body always collides at PROJECTILE_BODY_RADIUS; anything bigger is a blast.
 */
export function blastRadiusOf(ability: AbilityDef): number {
  return ability.shape === 'projectile' && ability.radius > PROJECTILE_BODY_RADIUS
    ? ability.radius
    : 0;
}

export function roleOf(id: RoleId | null | undefined): RoleDef | null {
  if (!id) return null;
  try {
    const def = getRole(id);
    return def ?? null;
  } catch {
    return null;
  }
}

// ============================================================ teams

const HOSTILE_TABLE: Record<string, string[]> = {
  players: ['hostile'],
  hostile: ['players'],
  a: ['b'],
  b: ['a'],
  neutral: [],
  // 'ffa' is handled ahead of the table — see isHostile.
  ffa: ['hostile'],
};

/**
 * 'players' fights 'hostile'; 'a' fights 'b'. Same team is normally never hostile and
 * 'neutral' is hostile to nobody (and nobody is hostile to it).
 *
 * 'ffa' is the deliberate exception: everyone on it fights everyone else on it. Without
 * this case the largest true free-for-all the Team union could express would be two
 * players, because same-team entities can never damage each other.
 */
export function isHostile(a: Entity, b: Entity): boolean {
  if (a === b || a.id === b.id) return false;
  if (a.team === 'ffa' && b.team === 'ffa') return true;
  if (a.team === b.team) return false;
  const table = HOSTILE_TABLE[a.team];
  return table !== undefined && table.indexOf(b.team) !== -1;
}

/**
 * Same-team, not self. Used by friendly abilities.
 * Free-for-all combatants share a team id for hostility purposes but are nobody's
 * ally — otherwise a Conduit would heal and shield the people it is trying to kill.
 */
export function isAlly(a: Entity, b: Entity): boolean {
  if (a.id === b.id) return false;
  if (a.team === 'ffa' || b.team === 'ffa') return false;
  return a.team === b.team;
}

// ============================================================ targeting

/** Can this entity currently be hit? Covers death, downs, respawns and i-frames. */
export function isTargetable(e: Entity): boolean {
  if (e.dead || e.hp <= 0) return false;
  if (e.kind === 'projectile' || e.kind === 'zone') return false;
  if (isPlayer(e)) {
    if (e.downed || e.respawnTimer > 0) return false;
    if (hasIFrames(e)) return false;
  }
  return true;
}

/** True during the invulnerable window at the start of a dash. */
export function hasIFrames(p: PlayerEntity): boolean {
  return p.dashing > DASH_DURATION - DASH_IFRAMES;
}

/** Can this entity receive a friendly effect (heal/shield/revive target)? */
export function isSupportable(e: Entity): boolean {
  if (e.dead) return false;
  if (e.kind === 'projectile' || e.kind === 'zone') return false;
  if (isPlayer(e) && e.respawnTimer > 0) return false;
  return true;
}

export function findEntity(ctx: SimContext, id: EntityId | null | undefined): Entity | null {
  if (id === null || id === undefined) return null;
  const list = ctx.world.entities;
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

/** All live hostiles of `from`, unsorted. */
export function hostilesOf(ctx: SimContext, from: Entity): Entity[] {
  const out: Entity[] = [];
  const list = ctx.world.entities;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (isTargetable(e) && isHostile(from, e)) out.push(e);
  }
  return out;
}

/** All live allies of `from` (excluding `from` itself). */
export function alliesOf(ctx: SimContext, from: Entity): Entity[] {
  const out: Entity[] = [];
  const list = ctx.world.entities;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (isSupportable(e) && isAlly(from, e)) out.push(e);
  }
  return out;
}

function nearestAlly(ctx: SimContext, from: Entity, maxDist: number, aim: Vec2): Entity | null {
  let best: Entity | null = null;
  let bestScore = Infinity;
  const max2 = maxDist * maxDist;
  for (const e of alliesOf(ctx, from)) {
    if (v.dist2(from.pos, e.pos) > max2) continue;
    // Prefer whoever the caster is pointing at, then whoever is hurt most.
    const toAim = v.dist2(aim, e.pos);
    const hurt = 1 - clamp(e.hp / Math.max(1, e.maxHp), 0, 1);
    const score = toAim - hurt * 40000;
    if (score < bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

// ============================================================ statuses

export function getStatus(e: Entity, kind: StatusKind): Status | null {
  for (let i = 0; i < e.statuses.length; i++) {
    if (e.statuses[i].kind === kind) return e.statuses[i];
  }
  return null;
}

export function hasStatus(e: Entity, kind: StatusKind): boolean {
  return getStatus(e, kind) !== null;
}

/** Default duration for a status kind when the ability declares none. */
export function defaultStatusDuration(kind: StatusKind): number {
  switch (kind) {
    case 'burn':
      return STATUS_DURATION_BURN;
    case 'chill':
      return STATUS_DURATION_CHILL;
    case 'stun':
      return STATUS_DURATION_STUN;
    case 'root':
      return STATUS_DURATION_ROOT;
    case 'mark':
      return STATUS_DURATION_MARK;
    case 'shield':
      return STATUS_DURATION_SHIELD;
    case 'haste':
      return STATUS_DURATION_HASTE;
    case 'overclock':
      return STATUS_DURATION_OVERCLOCK;
    default:
      return 2;
  }
}

/**
 * Fallback magnitude for a status with no owning ability (enemy AI, hazards).
 * Ability-driven magnitudes come from B's `statusFor` instead — content owns them.
 *   burn      -> damage per second        shield    -> absorb points
 *   chill     -> fractional slow          haste     -> fractional speed bonus
 *   overclock -> fractional charge bonus  mark      -> fractional bonus damage
 *   stun/root -> unused (presence is the effect)
 */
export function statusMagnitude(kind: StatusKind, ability: AbilityDef | null, oc: number): number {
  const dmg = ability ? ability.damage : 0;
  switch (kind) {
    case 'burn':
      return Math.max(STATUS_BURN_MIN_DPS, dmg * STATUS_BURN_DPS_FRACTION) * oc;
    case 'shield':
      return (dmg > 0 ? dmg : STATUS_SHIELD_DEFAULT) * oc;
    case 'chill':
      return STATUS_CHILL_SLOW;
    case 'haste':
      return STATUS_HASTE_BONUS;
    case 'overclock':
      return STATUS_OVERCLOCK_BONUS;
    case 'mark':
      return STATUS_MARK_AMP;
    default:
      return 1;
  }
}

/**
 * Build the status an ability applies. Delegates to the content module's
 * `statusFor` (which knows that `buff` shapes carry their magnitude in `damage`
 * and that zones re-stamp a short refresh window) and only falls back to the
 * table above when the caller asks for a kind the ability does not declare.
 */
export function makeStatus(
  kind: StatusKind,
  ability: AbilityDef | null,
  oc: number,
  source: EntityId,
): Status {
  if (ability && ability.applies === kind) {
    const resolved = statusFor(ability, oc);
    if (resolved) return { ...resolved, source };
  }
  const declared = ability && ability.duration > 0 ? ability.duration : 0;
  return {
    kind,
    remaining: declared > 0 ? declared : defaultStatusDuration(kind),
    magnitude: statusMagnitude(kind, ability, oc),
    source,
  };
}

export function applyStatus(ctx: SimContext, target: Entity, status: Status): void {
  if (target.dead || status.remaining <= 0) return;
  if (isPlayer(target) && target.respawnTimer > 0) return;

  const existing = getStatus(target, status.kind);
  if (existing) {
    if (status.kind === 'shield') {
      // Shields REFRESH, they do not stack — re-applying replaces the absorb pool.
      existing.magnitude = Math.min(SHIELD_MAX, status.magnitude);
      existing.remaining = status.remaining;
    } else {
      existing.magnitude = Math.max(existing.magnitude, status.magnitude);
      existing.remaining = Math.max(existing.remaining, status.remaining);
    }
    existing.source = status.source;
  } else {
    target.statuses.push({
      kind: status.kind,
      remaining: status.remaining,
      magnitude: status.kind === 'shield' ? Math.min(SHIELD_MAX, status.magnitude) : status.magnitude,
      source: status.source,
    });
  }

  if (status.kind === 'shield') syncShield(target);
  ctx.emit({ t: 'sfx', name: `status:${status.kind}`, pos: v.clone(target.pos) });
}

/** Mirror the shield statuses onto PlayerEntity.shield so the HUD has one number. */
export function syncShield(e: Entity): void {
  if (!isPlayer(e)) return;
  let total = 0;
  for (let i = 0; i < e.statuses.length; i++) {
    if (e.statuses[i].kind === 'shield') total += e.statuses[i].magnitude;
  }
  e.shield = Math.round(total * 10) / 10;
}

/**
 * Advance every status on `e` by dt. Burn deals damage in discrete ticks derived
 * from `remaining`, which keeps it stateless and identical on any tick rate.
 */
export function tickStatuses(ctx: SimContext, e: Entity, dt: number): void {
  if (e.statuses.length === 0) return;

  let burnDamage = 0;
  let burnSource: EntityId | null = null;
  let shieldChanged = false;

  for (let i = e.statuses.length - 1; i >= 0; i--) {
    const s = e.statuses[i];

    if (s.kind === 'burn') {
      const before = Math.ceil(Math.max(0, s.remaining) / BURN_TICK_INTERVAL);
      s.remaining -= dt;
      const after = Math.ceil(Math.max(0, s.remaining) / BURN_TICK_INTERVAL);
      const ticks = before - after;
      if (ticks > 0) {
        burnDamage += s.magnitude * BURN_TICK_INTERVAL * ticks;
        burnSource = s.source;
      }
    } else if (s.kind === 'shield') {
      s.remaining -= dt;
      s.magnitude -= SHIELD_DECAY_RATE * dt;
      shieldChanged = true;
      if (s.magnitude <= 0.05) s.remaining = 0;
    } else {
      s.remaining -= dt;
    }

    if (s.remaining <= 0) {
      if (s.kind === 'shield') shieldChanged = true;
      e.statuses.splice(i, 1);
      ctx.emit({ t: 'sfx', name: `statusEnd:${s.kind}`, pos: v.clone(e.pos) });
    }
  }

  if (shieldChanged) syncShield(e);

  // Applied after the loop so a lethal burn cannot invalidate the iteration.
  if (burnDamage > 0) {
    applyDamage(ctx, e, burnDamage, findEntity(ctx, burnSource));
  }
}

// ============================================================ damage / healing

/**
 * The single funnel for all damage. Respects i-frames, mark amplification, the
 * source's role damage multiplier and shield absorption, then routes through the
 * mode handler hooks.
 */
export function applyDamage(
  ctx: SimContext,
  target: Entity,
  amount: number,
  source: Entity | null,
): void {
  if (amount <= 0) return;
  if (!isTargetable(target)) return;

  let dmg = amount;

  if (source && isPlayer(source)) {
    const role = roleOf(source.role);
    if (role) dmg *= role.damageMul;
  }

  const mark = getStatus(target, 'mark');
  if (mark) dmg *= 1 + mark.magnitude;

  dmg = Math.round(dmg * 10) / 10;
  if (dmg <= 0) return;

  // Shields absorb first, oldest layer first.
  let remaining = dmg;
  if (target.statuses.length > 0) {
    for (let i = 0; i < target.statuses.length && remaining > 0; i++) {
      const s = target.statuses[i];
      if (s.kind !== 'shield') continue;
      const absorbed = Math.min(s.magnitude, remaining);
      s.magnitude -= absorbed;
      remaining -= absorbed;
      if (s.magnitude <= 0.05) s.remaining = 0;
    }
    syncShield(target);
  }

  if (remaining > 0) {
    target.hp = Math.round((target.hp - remaining) * 10) / 10;
  }

  const crit = mark !== null || dmg >= target.maxHp * CRIT_HP_FRACTION;
  ctx.emit({ t: 'hit', pos: v.clone(target.pos), damage: dmg, crit, target: target.id });
  ctx.emit({
    t: 'shake',
    magnitude: Math.min(SHAKE_MAX, dmg * SHAKE_PER_DAMAGE * (crit ? 1.8 : 1)),
  });

  if (ctx.hooks && ctx.hooks.onDamage) ctx.hooks.onDamage(ctx, target, dmg, source);

  if (target.hp <= 0) killEntity(ctx, target, source);
}

/** Restore HP (never past max). Emits a negative-damage hit so the HUD can float it. */
export function applyHeal(ctx: SimContext, target: Entity, amount: number, source: Entity | null): void {
  if (amount <= 0) return;
  if (!isSupportable(target)) return;
  if (isPlayer(target) && target.downed) return;
  const before = target.hp;
  target.hp = Math.round(Math.min(target.maxHp, target.hp + amount) * 10) / 10;
  const healed = Math.round((target.hp - before) * 10) / 10;
  if (healed <= 0) return;
  ctx.emit({ t: 'hit', pos: v.clone(target.pos), damage: -healed, crit: false, target: target.id });
  ctx.emit({ t: 'sfx', name: 'heal', pos: v.clone(target.pos) });
  void source;
}

/**
 * Take an entity out of the fight.
 * Players are never culled: in co-op they go `downed`, in pvp they take a
 * respawn timer. The mode handler decides what any of it means for the match.
 */
export function killEntity(ctx: SimContext, e: Entity, killer: Entity | null): void {
  if (e.dead) return;
  // Already out of the fight — do not re-kill, re-count or re-notify.
  if (isPlayer(e) && (e.downed || e.respawnTimer > 0)) return;

  e.hp = 0;
  e.statuses.length = 0;

  if (isPlayer(e)) {
    e.shield = 0;
    e.vel = { x: 0, y: 0 };
    e.dashing = 0;
    e.deaths += 1;
    if (killer && isPlayer(killer) && isHostile(killer, e)) killer.kills += 1;

    if (ctx.world.mode === 'coop_story') {
      e.downed = true;
      e.downedTimer = DOWNED_DURATION;
      e.reviveProgress = 0;
    } else {
      e.respawnTimer = RESPAWN_DELAY;
    }
  } else {
    e.dead = true;
  }

  ctx.emit({ t: 'death', pos: v.clone(e.pos), entity: e.id, kind: e.kind });
  ctx.emit({ t: 'shake', magnitude: isPlayer(e) ? 0.9 : 0.35 });
  ctx.emit({ t: 'sfx', name: isPlayer(e) ? 'playerDown' : 'kill', pos: v.clone(e.pos) });

  if (ctx.hooks && ctx.hooks.onDeath) ctx.hooks.onDeath(ctx, e, killer);
}

// ============================================================ ability firing

function aimDirection(caster: Entity, aim: Vec2): Vec2 {
  const d = v.sub(aim, caster.pos);
  if (v.len2(d) < 1) return v.fromAngle(caster.angle);
  return v.norm(d);
}

/** Point at `aim`, pulled back to at most `range` from the caster, kept in-arena. */
function clampToRange(caster: Entity, aim: Vec2, range: number): Vec2 {
  const d = v.sub(aim, caster.pos);
  const l = v.len(d);
  const p =
    l <= range || l < 1 ? v.clone(aim) : v.addScaled(caster.pos, { x: d.x / l, y: d.y / l }, range);
  return { x: clamp(p.x, 0, ARENA_W), y: clamp(p.y, 0, ARENA_H) };
}

function pierceBudget(ability: AbilityDef): number {
  if (typeof ability.pierce === 'number') return Math.max(0, Math.floor(ability.pierce));
  return ability.shape === 'beam' ? BEAM_PIERCE_DEFAULT : 0;
}

/**
 * Resolve one cast. `overcharge` comes from `consumeCharge` (1.0 .. MAX_OVERCHARGE)
 * and scales damage/magnitude only when the ability opts in.
 */
export function fireAbility(
  ctx: SimContext,
  caster: Entity,
  ability: AbilityDef,
  aim: Vec2,
  overcharge: number,
): void {
  if (caster.dead) return;
  if (isPlayer(caster) && (caster.downed || caster.respawnTimer > 0)) return;

  const oc = ability.scalesWithOvercharge ? clamp(overcharge, 1, MAX_OVERCHARGE) : 1;
  const dir = aimDirection(caster, aim);
  const angle = v.angle(dir);
  const damage = ability.damage * oc;

  switch (ability.shape) {
    case 'projectile':
      castProjectile(ctx, caster, ability, dir, angle, damage, oc);
      break;
    case 'beam':
      castBeam(ctx, caster, ability, dir, angle, damage, oc);
      break;
    case 'aoe':
      castAoe(ctx, caster, ability, aim, angle, damage, oc);
      break;
    case 'dash':
      castDash(ctx, caster, ability, dir, angle, damage, oc);
      break;
    case 'buff':
      castBuff(ctx, caster, ability, aim, angle, oc);
      break;
    case 'summon':
      castSummon(ctx, caster, ability, dir, angle, oc);
      break;
    case 'zone':
      castZone(ctx, caster, ability, aim, angle, damage, oc);
      break;
    default:
      ctx.emit({ t: 'cast', pos: v.clone(caster.pos), ability: ability.id, caster: caster.id, angle });
      break;
  }
}

// ------------------------------------------------------------ projectile

function castProjectile(
  ctx: SimContext,
  caster: Entity,
  ability: AbilityDef,
  dir: Vec2,
  angle: number,
  damage: number,
  oc: number,
): void {
  const speed = ability.speed > 0 ? ability.speed : 700;
  const range = ability.range > 0 ? ability.range : 500;
  // Body always collides small; a bigger declared radius is the blast, not the bolt.
  const bodyRadius = clamp(
    Math.min(ability.radius > 0 ? ability.radius : PROJECTILE_RADIUS_DEFAULT, PROJECTILE_BODY_RADIUS),
    4,
    PROJECTILE_RADIUS_MAX,
  );

  const spawn = v.addScaled(caster.pos, dir, caster.radius + bodyRadius + 2);
  const proj: ProjectileEntity = {
    id: ctx.nextId(),
    kind: 'projectile',
    pos: { x: clamp(spawn.x, 0, ARENA_W), y: clamp(spawn.y, 0, ARENA_H) },
    vel: v.scale(dir, speed),
    radius: bodyRadius,
    team: caster.team,
    hp: 1,
    maxHp: 1,
    angle,
    statuses: [],
    dead: false,
    ability: ability.id,
    owner: caster.id,
    life: clamp(range / speed, 0.05, PROJECTILE_MAX_LIFE),
    pierced: [],
    damage,
    pierce: pierceBudget(ability),
  };
  ctx.world.entities.push(proj);

  ctx.emit({ t: 'cast', pos: v.clone(caster.pos), ability: ability.id, caster: caster.id, angle });
  ctx.emit({ t: 'sfx', name: `fire:${ability.id}`, pos: v.clone(caster.pos) });
  void oc;
}

/**
 * Impact resolution for a projectile, shared by sim.ts. Handles the blast
 * variant (splash to everything else inside `radius`).
 */
export function resolveProjectileImpact(
  ctx: SimContext,
  proj: ProjectileEntity,
  primary: Entity | null,
  owner: Entity | null,
): void {
  const ability = abilityOf(proj.ability);
  const damage = typeof proj.damage === 'number' ? proj.damage : ability ? ability.damage : 0;
  const friendly = ability ? ability.friendly === true : false;

  if (primary) {
    if (friendly) {
      applyHeal(ctx, primary, damage, owner);
    } else {
      applyDamage(ctx, primary, damage, owner ?? proj);
    }
    if (ability && ability.applies) {
      applyStatus(ctx, primary, makeStatus(ability.applies, ability, 1, proj.owner));
    }
  }

  const blastRadius = ability ? blastRadiusOf(ability) : 0;
  if (ability && blastRadius > 0) {
    const center = v.clone(proj.pos);
    ctx.emit({ t: 'sfx', name: `blast:${ability.id}`, pos: center });
    if (blastRadius >= BLAST_VFX_MIN_RADIUS) {
      ctx.emit({ t: 'shake', magnitude: clamp(blastRadius / 160, 0.2, SHAKE_MAX) });
    }
    const splash = damage * BLAST_FALLOFF;
    const list = ctx.world.entities.slice();
    for (const e of list) {
      if (primary && e.id === primary.id) continue;
      if (!circleHit(center, blastRadius, e.pos, e.radius)) continue;
      if (friendly) {
        if (isAlly(proj, e) && isSupportable(e)) applyHeal(ctx, e, splash, owner);
      } else if (isHostile(proj, e) && isTargetable(e)) {
        applyDamage(ctx, e, splash, owner ?? proj);
        if (ability.applies) applyStatus(ctx, e, makeStatus(ability.applies, ability, 1, proj.owner));
      }
    }
  }
}

// ------------------------------------------------------------ beam

function castBeam(
  ctx: SimContext,
  caster: Entity,
  ability: AbilityDef,
  dir: Vec2,
  angle: number,
  damage: number,
  oc: number,
): void {
  const range = ability.range > 0 ? ability.range : 520;
  const halfWidth = ability.radius > 0 ? ability.radius : BEAM_HALF_WIDTH;
  const p0 = v.addScaled(caster.pos, dir, caster.radius * 0.5);
  const p1 = v.addScaled(caster.pos, dir, range);

  ctx.emit({ t: 'cast', pos: v.clone(caster.pos), ability: ability.id, caster: caster.id, angle });
  ctx.emit({ t: 'sfx', name: `beam:${ability.id}`, pos: v.clone(caster.pos) });
  ctx.emit({ t: 'shake', magnitude: clamp(damage * SHAKE_PER_DAMAGE, 0.15, SHAKE_MAX) });

  const friendly = ability.friendly === true;
  const candidates = friendly ? alliesOf(ctx, caster) : hostilesOf(ctx, caster);
  const hits = candidates
    .filter((e) => segmentCircle(p0, p1, e.pos, e.radius + halfWidth))
    .sort((a, b) => v.dist2(caster.pos, a.pos) - v.dist2(caster.pos, b.pos));

  const budget = pierceBudget(ability) + 1;
  for (let i = 0; i < hits.length && i < budget; i++) {
    const target = hits[i];
    if (friendly) {
      applyHeal(ctx, target, damage, caster);
    } else {
      applyDamage(ctx, target, damage, caster);
    }
    if (ability.applies) {
      applyStatus(ctx, target, makeStatus(ability.applies, ability, oc, caster.id));
    }
  }
}

// ------------------------------------------------------------ aoe

function castAoe(
  ctx: SimContext,
  caster: Entity,
  ability: AbilityDef,
  aim: Vec2,
  angle: number,
  damage: number,
  oc: number,
): void {
  const center = ability.range > 0 ? clampToRange(caster, aim, ability.range) : v.clone(caster.pos);
  const radius = ability.radius > 0 ? ability.radius : 80;

  ctx.emit({ t: 'cast', pos: center, ability: ability.id, caster: caster.id, angle });
  ctx.emit({ t: 'sfx', name: `aoe:${ability.id}`, pos: center });
  ctx.emit({ t: 'shake', magnitude: clamp(radius / 140 + damage * SHAKE_PER_DAMAGE, 0.2, SHAKE_MAX) });

  const friendly = ability.friendly === true;
  const list = ctx.world.entities.slice();
  for (const e of list) {
    if (!circleHit(center, radius, e.pos, e.radius)) continue;
    if (friendly) {
      if (e.id !== caster.id && !isAlly(caster, e)) continue;
      if (!isSupportable(e)) continue;
      if (damage > 0) applyHeal(ctx, e, damage, caster);
    } else {
      if (!isHostile(caster, e) || !isTargetable(e)) continue;
      applyDamage(ctx, e, damage, caster);
    }
    if (ability.applies) {
      applyStatus(ctx, e, makeStatus(ability.applies, ability, oc, caster.id));
    }
  }
}

// ------------------------------------------------------------ dash / blink

function castDash(
  ctx: SimContext,
  caster: Entity,
  ability: AbilityDef,
  dir: Vec2,
  angle: number,
  damage: number,
  oc: number,
): void {
  const speed = ability.speed > 0 ? ability.speed : DASH_SPEED;
  const dist = ability.range > 0 ? ability.range : speed * DASH_DURATION;
  const from = v.clone(caster.pos);
  const rawTo = v.addScaled(from, dir, dist);
  const to = {
    x: clamp(rawTo.x, caster.radius, ARENA_W - caster.radius),
    y: clamp(rawTo.y, caster.radius, ARENA_H - caster.radius),
  };

  ctx.emit({ t: 'cast', pos: from, ability: ability.id, caster: caster.id, angle });

  if (ability.speed <= 0) {
    // Blink: instantaneous reposition.
    caster.pos = to;
    caster.vel = { x: 0, y: 0 };
    if (isPlayer(caster)) caster.dashing = Math.max(caster.dashing, DASH_IFRAMES);
    ctx.emit({ t: 'sfx', name: `blink:${ability.id}`, pos: to });
  } else {
    const duration = clamp(dist / speed, DASH_MIN_DURATION, DASH_MAX_DURATION);
    caster.vel = v.scale(dir, speed);
    if (isPlayer(caster)) caster.dashing = Math.max(caster.dashing, duration);
    ctx.emit({ t: 'sfx', name: `dash:${ability.id}`, pos: from });
  }

  ctx.emit({ t: 'dash', from, to, entity: caster.id });
  caster.angle = angle;

  if (damage > 0) {
    const sweep = ability.radius > 0 ? ability.radius : DASH_HIT_RADIUS;
    for (const e of hostilesOf(ctx, caster)) {
      if (!segmentCircle(from, to, e.pos, e.radius + sweep)) continue;
      applyDamage(ctx, e, damage, caster);
      if (ability.applies) applyStatus(ctx, e, makeStatus(ability.applies, ability, oc, caster.id));
    }
  } else if (ability.applies) {
    // A pure mobility ability with a rider (e.g. haste on blink) buffs the caster.
    applyStatus(ctx, caster, makeStatus(ability.applies, ability, oc, caster.id));
  }
}

// ------------------------------------------------------------ buff

function castBuff(
  ctx: SimContext,
  caster: Entity,
  ability: AbilityDef,
  aim: Vec2,
  angle: number,
  oc: number,
): void {
  // Content contract: radius > 0 buffs everyone nearby, radius 0 + range > 0 buffs
  // one targeted ally, range 0 is self only. `damage` is the magnitude, never a heal.
  const targets: Entity[] = [];

  if (ability.radius > 0) {
    targets.push(caster);
    if (ability.friendly) {
      for (const ally of alliesOf(ctx, caster)) {
        if (circleHit(caster.pos, ability.radius, ally.pos, ally.radius)) targets.push(ally);
      }
    }
  } else if (ability.friendly && ability.range > 0) {
    const ally = nearestAlly(ctx, caster, ability.range, aim);
    targets.push(ally ?? caster);
  } else {
    targets.push(caster);
  }

  ctx.emit({ t: 'cast', pos: v.clone(caster.pos), ability: ability.id, caster: caster.id, angle });
  ctx.emit({ t: 'sfx', name: `buff:${ability.id}`, pos: v.clone(targets[0].pos) });

  if (!ability.applies) return;
  for (const target of targets) {
    if (!isSupportable(target)) continue;
    applyStatus(ctx, target, makeStatus(ability.applies, ability, oc, caster.id));
  }
}

// ------------------------------------------------------------ summon

function castSummon(
  ctx: SimContext,
  caster: Entity,
  ability: AbilityDef,
  dir: Vec2,
  angle: number,
  oc: number,
): void {
  const radius = ability.radius > 0 ? Math.min(ability.radius, 28) : SUMMON_RADIUS_DEFAULT;
  // Summons deploy on the caster, nudged forward just enough not to overlap them.
  const spawn = v.addScaled(caster.pos, dir, caster.radius + radius + 2);
  const contentHp = summonHp(ability);
  const hp = contentHp > 0 ? contentHp : Math.round(SUMMON_BASE_HP + ability.damage * SUMMON_HP_PER_DAMAGE);

  const summon: EnemyEntity = {
    id: ctx.nextId(),
    kind: 'enemy',
    pos: { x: clamp(spawn.x, radius, ARENA_W - radius), y: clamp(spawn.y, radius, ARENA_H - radius) },
    vel: { x: 0, y: 0 },
    radius,
    team: caster.team,
    hp,
    maxHp: hp,
    angle,
    statuses: [],
    dead: false,
    archetype: `summon:${ability.id}`,
    aiState: 'seek',
    // `telegraph` doubles as the countdown to this summon's next pulse.
    telegraph: SUMMON_ATTACK_INTERVAL * 0.5,
    telegraphKind: ability.friendly ? 'summonPulse' : 'summonAttack',
    target: null,
    life: ability.duration > 0 ? ability.duration : SUMMON_DEFAULT_LIFE,
    damage: ability.damage * oc,
  };
  ctx.world.entities.push(summon);

  ctx.emit({ t: 'cast', pos: v.clone(summon.pos), ability: ability.id, caster: caster.id, angle });
  ctx.emit({ t: 'sfx', name: `summon:${ability.id}`, pos: v.clone(summon.pos) });
}

// ------------------------------------------------------------ zone

function castZone(
  ctx: SimContext,
  caster: Entity,
  ability: AbilityDef,
  aim: Vec2,
  angle: number,
  damage: number,
  oc: number,
): void {
  const center = ability.range > 0 ? clampToRange(caster, aim, ability.range) : v.clone(caster.pos);
  const radius = ability.radius > 0 ? ability.radius : ZONE_RADIUS_DEFAULT;

  const zone: ZoneEntity = {
    id: ctx.nextId(),
    kind: 'zone',
    pos: center,
    vel: { x: 0, y: 0 },
    radius,
    team: caster.team,
    hp: 1,
    maxHp: 1,
    angle,
    statuses: [],
    dead: false,
    ability: ability.id,
    owner: caster.id,
    life: ability.duration > 0 ? ability.duration : 4,
    tickAccumulator: 0,
    // `damage` on a zone is per SECOND (content contract); pulses slice it up.
    damage,
  };
  ctx.world.entities.push(zone);

  ctx.emit({ t: 'cast', pos: v.clone(center), ability: ability.id, caster: caster.id, angle });
  ctx.emit({ t: 'sfx', name: `zone:${ability.id}`, pos: v.clone(center) });
  void oc;
}

// ------------------------------------------------------------ zone ticking

/**
 * One damage/heal pulse of a zone. Called by sim.ts on the zone's accumulator.
 * `zone.damage` is per second; `interval` is how much of a second this pulse covers.
 */
export function pulseZone(
  ctx: SimContext,
  zone: ZoneEntity,
  owner: Entity | null,
  interval: number,
): void {
  const ability = abilityOf(zone.ability);
  const perSecond =
    typeof zone.damage === 'number' ? zone.damage : ability ? ability.damage : 0;
  const perTick = perSecond * interval;
  const friendly = ability ? ability.friendly === true : false;

  const list = ctx.world.entities.slice();
  for (const e of list) {
    if (e.kind === 'projectile' || e.kind === 'zone') continue;
    if (!circleHit(zone.pos, zone.radius, e.pos, e.radius)) continue;

    if (friendly) {
      if (!(e.team === zone.team) || !isSupportable(e)) continue;
      if (perTick > 0) applyHeal(ctx, e, perTick, owner);
    } else {
      if (!isHostile(zone, e) || !isTargetable(e)) continue;
      if (perTick > 0) applyDamage(ctx, e, perTick, owner ?? zone);
    }
    if (ability && ability.applies) {
      applyStatus(ctx, e, makeStatus(ability.applies, ability, 1, zone.owner));
    }
  }
}

// ------------------------------------------------------------ summon pulses

/**
 * One attack pulse from a summoned entity, fired by sim.ts on
 * SUMMON_ATTACK_INTERVAL. Immobile emplacements (speed 0) pulse everything
 * inside `range`; walkers engage their single nearest target.
 */
export function pulseSummon(ctx: SimContext, summon: EnemyEntity, ability: AbilityDef): boolean {
  const range = ability.range > 0 ? ability.range : 220;
  const amount = typeof summon.damage === 'number' ? summon.damage : ability.damage;
  const friendly = ability.friendly === true;

  const pool = friendly ? alliesOf(ctx, summon) : hostilesOf(ctx, summon);
  const inRange = pool.filter((e) => circleHit(summon.pos, range, e.pos, e.radius));
  if (inRange.length === 0) return false;

  if (friendly) {
    // Triage: top up whoever is worst off first.
    inRange.sort((a, b) => a.hp / Math.max(1, a.maxHp) - b.hp / Math.max(1, b.maxHp));
  } else {
    inRange.sort((a, b) => v.dist2(summon.pos, a.pos) - v.dist2(summon.pos, b.pos));
  }

  const targets = ability.speed <= 0 ? inRange : inRange.slice(0, 1);
  if (targets.length === 0) return false;

  summon.angle = v.angle(v.sub(targets[0].pos, summon.pos));
  ctx.emit({
    t: 'cast',
    pos: v.clone(summon.pos),
    ability: ability.id,
    caster: summon.id,
    angle: summon.angle,
  });

  for (const target of targets) {
    if (friendly) {
      if (target.hp < target.maxHp) applyHeal(ctx, target, amount, summon);
    } else {
      applyDamage(ctx, target, amount, summon);
    }
    if (ability.applies) {
      applyStatus(ctx, target, makeStatus(ability.applies, ability, 1, summon.id));
    }
  }
  return true;
}
