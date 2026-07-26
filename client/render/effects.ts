/**
 * VOIDLINE — effects.
 *
 * Everything transient that is *not* a particle: shockwave rings, beam/dash
 * streaks, floating damage numbers, per-entity hit flashes, hitstop, screen
 * flash, chromatic-aberration impulse and screen-edge pulses.
 *
 * This module is the single consumer of `world.events` (the `GameEvent` union).
 * Every variant is handled; the switch is exhaustiveness-checked at compile
 * time so a new event kind cannot be silently ignored.
 *
 * All pools are fixed-size and overwritten round-robin — no allocation while
 * the game is running.
 */

import type { AbilityDef, Entity, EntityId, GameEvent, PlayerEntity, PlayerId, Vec2, WorldState } from '@shared/types.js';
import { HITSTOP_MS } from '@shared/constants.js';
import { getAbility } from '@shared/abilities.js';
import type { Camera } from './camera.js';
import { ParticleSystem } from './particles.js';
import * as P from './palette.js';
import { edgeGlow } from './sprites.js';

const TAU = Math.PI * 2;

const MAX_SHOCKS = 64;
const MAX_NUMBERS = 96;
/** World units within which two damage numbers count as landing on the same spot. */
const NUMBER_CROWD_RADIUS = 46;
/** Seconds a number keeps claiming its spawn spot for crowding purposes. */
const NUMBER_CROWD_WINDOW = 0.5;
/** Sideways spacing, world units, between fanned-out numbers. */
const NUMBER_LANE_STEP = 26;
const MAX_STREAKS = 48;
const MAX_EDGE = 6;

interface Shock {
  active: boolean;
  x: number;
  y: number;
  r0: number;
  r1: number;
  life: number;
  maxLife: number;
  width: number;
  color: string;
  /** 0 = ring, 1 = ring + inner flare (big detonations). */
  flare: number;
}

interface FloatNumber {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  text: string;
  size: number;
  color: string;
  crit: boolean;
  /** Seconds before this number starts moving and drawing (temporal stagger). */
  delay: number;
  /** Where it was spawned, so later numbers can fan out around the same hit. */
  ox: number;
  oy: number;
  /** Seconds since spawn — used to age the crowding test. */
  age: number;
}

interface Streak {
  active: boolean;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  life: number;
  maxLife: number;
  width: number;
  color: string;
}

interface EdgePulse {
  active: boolean;
  life: number;
  maxLife: number;
  color: string;
  strength: number;
}

/** Ability shapes we can render a cast flourish for. */
type CastShape = 'projectile' | 'beam' | 'aoe' | 'dash' | 'buff' | 'summon' | 'zone';

export class Effects {
  /** Remaining client-side hitstop in real milliseconds. */
  hitstopMs = 0;
  /** 0..1 chromatic aberration impulse, decays fast. */
  aberration = 0;
  /** 0..1 full-screen additive white flash. */
  flash = 0;

  /** Optional audio bridge. Agent F may wire this to a sound bank. */
  onSfx: ((name: string, pos?: Vec2) => void) | null = null;

  private readonly shocks: Shock[] = [];
  private readonly numbers: FloatNumber[] = [];
  private readonly streaks: Streak[] = [];
  private readonly edges: EdgePulse[] = [];
  private shockCursor = 0;
  private numberCursor = 0;
  private streakCursor = 0;
  private edgeCursor = 0;

  /** entityId -> remaining hit-flash seconds. */
  private readonly flashes = new Map<EntityId, number>();

  constructor(private readonly particles: ParticleSystem) {
    for (let i = 0; i < MAX_SHOCKS; i++) {
      this.shocks.push({ active: false, x: 0, y: 0, r0: 0, r1: 0, life: 0, maxLife: 1, width: 3, color: P.ENERGY_WHITE, flare: 0 });
    }
    for (let i = 0; i < MAX_NUMBERS; i++) {
      this.numbers.push({
        active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, text: '', size: 15,
        color: P.DMG_NORMAL, crit: false, delay: 0, ox: 0, oy: 0, age: 0,
      });
    }
    for (let i = 0; i < MAX_STREAKS; i++) {
      this.streaks.push({ active: false, x0: 0, y0: 0, x1: 0, y1: 0, life: 0, maxLife: 1, width: 4, color: P.ENERGY_CYAN });
    }
    for (let i = 0; i < MAX_EDGE; i++) {
      this.edges.push({ active: false, life: 0, maxLife: 1, color: P.ENERGY_CYAN, strength: 1 });
    }
  }

  clear(): void {
    for (const s of this.shocks) s.active = false;
    for (const n of this.numbers) n.active = false;
    for (const s of this.streaks) s.active = false;
    for (const e of this.edges) e.active = false;
    this.flashes.clear();
    this.hitstopMs = 0;
    this.aberration = 0;
    this.flash = 0;
  }

  /** 0..1 white-out amount for an entity that was just struck. */
  flashOf(id: EntityId): number {
    const t = this.flashes.get(id);
    if (t === undefined) return 0;
    return t / HIT_FLASH_TIME;
  }

  // ================================================================ events

  /**
   * Consume one tick's worth of `world.events`. Safe to call with an empty
   * array. The renderer guarantees each snapshot's events are ingested once.
   */
  ingest(events: readonly GameEvent[], world: WorldState, selfId: EntityId, camera: Camera): void {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.t) {
        case 'hit':
          this.onHit(e.pos, e.damage, e.crit, e.target, selfId, world, camera);
          break;
        case 'death':
          this.onDeath(e.pos, e.entity, e.kind, world, camera);
          break;
        case 'cast':
          this.onCast(e.pos, e.ability, e.caster, e.angle, world, camera);
          break;
        case 'dash':
          this.onDash(e.from, e.to, e.entity, world, camera);
          break;
        case 'slotCharged':
          this.onSlotCharged(e.player, e.slot, world, selfId);
          break;
        case 'weavePower':
          this.onWeavePower(e.player, e.connected, world, selfId);
          break;
        case 'revive':
          this.onRevive(e.player, world);
          break;
        case 'objective':
          this.flash = Math.max(this.flash, 0.1);
          this.pulseEdge(P.ENERGY_MINT, 0.7, 0.32);
          break;
        case 'dialogue':
          // Rendered by the HUD (Agent F). No world-space VFX by design — a
          // dialogue line must never obscure a fight.
          break;
        case 'shake':
          camera.shake(e.magnitude);
          this.aberration = Math.min(1, this.aberration + e.magnitude * 0.35);
          break;
        case 'sfx':
          if (this.onSfx !== null) this.onSfx(e.name, e.pos);
          break;
        default: {
          // Exhaustiveness guard: adding a GameEvent variant breaks the build here.
          const never: never = e;
          void never;
          break;
        }
      }
    }
  }

  private onHit(pos: Vec2, damage: number, crit: boolean, target: EntityId, selfId: EntityId, world: WorldState, camera: Camera): void {
    const isSelf = target === selfId;
    const victim = findEntity(world, target);
    const power = clamp01to(damage / 22, 0.18, 2.4);

    let color = P.ENERGY_WHITE;
    if (crit) color = P.WARN_YELLOW;
    else if (isSelf) color = P.DANGER_RED;
    else if (victim !== null && victim.team === 'hostile') color = P.DANGER_ORANGE;

    // Sparks fly outward from the contact point; if we know the victim, bias
    // the spray away from its centre so the hit reads directionally.
    let angle = Math.random() * TAU;
    let spread = Math.PI;
    if (victim !== null) {
      const dx = pos.x - victim.pos.x;
      const dy = pos.y - victim.pos.y;
      if (dx * dx + dy * dy > 1) {
        angle = Math.atan2(dy, dx);
        spread = 1.15;
      }
    }

    this.particles.impact(pos.x, pos.y, color, power, angle, spread);
    this.shock(pos.x, pos.y, 5, 24 + 46 * power, 0.28, 2.5 + power, color, 0);
    this.damageNumber(pos.x, pos.y, damage, crit, isSelf);
    this.flashes.set(target, HIT_FLASH_TIME);

    camera.shake(0.045 + 0.14 * power + (crit ? 0.11 : 0) + (isSelf ? 0.05 : 0));
    this.aberration = Math.min(1, this.aberration + (crit ? 0.55 : 0.16 * power));

    // Hitstop only on solid hits, so chip damage does not feel mushy.
    if (crit || damage >= 12) {
      const ms = HITSTOP_MS * (crit ? 1.5 : 1) * Math.min(1.25, 0.55 + power * 0.4);
      if (ms > this.hitstopMs) this.hitstopMs = ms;
    }
  }

  private onDeath(pos: Vec2, id: EntityId, kind: string, world: WorldState, camera: Camera): void {
    const ent = findEntity(world, id);
    const radius = ent !== null ? ent.radius : 16;

    let color = P.DANGER_ORANGE;
    if (ent !== null) {
      if (ent.kind === 'player') color = P.roleColor((ent as PlayerEntity).role);
      else if (ent.kind === 'enemy') color = P.archetypeColor((ent as { archetype: string }).archetype);
      else color = P.teamColor(ent.team);
    }

    this.flashes.delete(id);

    switch (kind) {
      case 'projectile': {
        this.particles.impact(pos.x, pos.y, color, 0.5);
        this.shock(pos.x, pos.y, 3, 26, 0.2, 2, color, 0);
        camera.shake(0.03);
        break;
      }
      case 'zone': {
        this.particles.emit({
          kind: 'smoke',
          x: pos.x,
          y: pos.y,
          count: 6,
          color: P.PLATE_LIGHT,
          spread: Math.PI,
          speed: 60,
          life: 1.1,
          size: radius * 0.9,
          drag: 1.4,
          fade: 0.7,
        });
        this.shock(pos.x, pos.y, radius, radius * 0.2, 0.45, 3, color, 0);
        break;
      }
      case 'player': {
        this.particles.shatter(pos.x, pos.y, color, radius * 1.15, 18);
        this.particles.ring(pos.x, pos.y, P.ENERGY_WHITE, radius * 0.6, 260, 0.38, 4);
        this.shock(pos.x, pos.y, radius, radius * 6, 0.6, 6, color, 1);
        camera.shake(0.62);
        this.flash = Math.max(this.flash, 0.22);
        this.aberration = Math.min(1, this.aberration + 0.8);
        if (this.hitstopMs < HITSTOP_MS * 1.6) this.hitstopMs = HITSTOP_MS * 1.6;
        break;
      }
      default: {
        // enemy / summon / prop
        this.particles.shatter(pos.x, pos.y, color, radius, 12);
        this.shock(pos.x, pos.y, radius * 0.6, radius * 5.5, 0.42, 5, color, 1);
        camera.shake(0.16 + Math.min(0.3, radius / 120));
        this.aberration = Math.min(1, this.aberration + 0.25);
        if (this.hitstopMs < HITSTOP_MS * 0.8) this.hitstopMs = HITSTOP_MS * 0.8;
        break;
      }
    }
  }

  private onCast(pos: Vec2, abilityId: string, caster: EntityId, angle: number, world: WorldState, camera: Camera): void {
    const ability = safeAbility(abilityId);
    const ent = findEntity(world, caster);
    let color = P.ENERGY_CYAN;
    if (ent !== null) {
      color = ent.kind === 'player' ? P.roleColor((ent as PlayerEntity).role) : P.teamColor(ent.team);
    }
    if (ability !== null && ability.friendly === true) color = P.ENERGY_MINT;

    const shape: CastShape = ability !== null ? (ability.shape as CastShape) : 'projectile';
    const radius = ability !== null && ability.radius > 0 ? ability.radius : 56;
    const range = ability !== null && ability.range > 0 ? ability.range : 320;
    const cost = ability !== null ? ability.cost : 1;
    const punch = Math.min(1.6, 0.5 + cost * 0.35);

    const nx = Math.cos(angle);
    const ny = Math.sin(angle);

    switch (shape) {
      case 'projectile': {
        // muzzle flash: tight forward cone + a snap ring
        this.particles.sparks(pos.x + nx * 12, pos.y + ny * 12, P.hot(color, 0.5), 10, angle, 0.35, 300);
        this.particles.ring(pos.x + nx * 14, pos.y + ny * 14, color, 6, 260, 0.18, 3);
        this.streak(pos.x, pos.y, pos.x + nx * 52, pos.y + ny * 52, color, 6, 0.12);
        camera.shake(0.05 * punch);
        break;
      }
      case 'beam': {
        const ex = pos.x + nx * range;
        const ey = pos.y + ny * range;
        this.streak(pos.x, pos.y, ex, ey, P.hot(color, 0.4), 6.5 * punch, 0.2);
        this.particles.beam(pos.x, pos.y, ex, ey, color, 26);
        this.particles.ring(pos.x, pos.y, color, 10, 420, 0.24, 4);
        camera.shake(0.16 * punch);
        this.aberration = Math.min(1, this.aberration + 0.2);
        break;
      }
      case 'aoe': {
        this.shock(pos.x, pos.y, radius * 0.15, radius * 1.25, 0.4, 6 * punch, color, 1);
        this.particles.impact(pos.x, pos.y, color, punch * 1.4);
        this.particles.motes(pos.x, pos.y, radius * 0.8, color, 14);
        camera.shake(0.22 * punch);
        break;
      }
      case 'dash': {
        this.particles.sparks(pos.x, pos.y, color, 14, angle + Math.PI, 0.8, 220);
        this.particles.ring(pos.x, pos.y, color, 14, 300, 0.26, 3);
        camera.shake(0.08);
        break;
      }
      case 'buff': {
        this.particles.motes(pos.x, pos.y, radius > 0 ? radius : 40, color, 22);
        this.particles.ring(pos.x, pos.y, color, 8, 190, 0.55, 3);
        this.particles.ring(pos.x, pos.y, P.hot(color, 0.5), 4, 120, 0.75, 2);
        break;
      }
      case 'summon': {
        this.particles.implode(pos.x, pos.y, radius > 0 ? radius : 70, color, 26);
        this.shock(pos.x, pos.y, radius * 1.1, 6, 0.45, 4, color, 0);
        break;
      }
      case 'zone': {
        this.particles.ring(pos.x, pos.y, color, radius * 0.2, radius * 2.4, 0.5, 4);
        this.particles.motes(pos.x, pos.y, radius, color, 18);
        camera.shake(0.09 * punch);
        break;
      }
      default: {
        this.particles.impact(pos.x, pos.y, color, punch);
        break;
      }
    }
  }

  private onDash(from: Vec2, to: Vec2, entity: EntityId, world: WorldState, camera: Camera): void {
    const ent = findEntity(world, entity);
    const color = ent !== null && ent.kind === 'player' ? P.roleColor((ent as PlayerEntity).role) : P.ENERGY_CYAN;
    this.streak(from.x, from.y, to.x, to.y, color, 9, 0.26);
    this.particles.beam(from.x, from.y, to.x, to.y, color, 18);
    this.particles.ring(from.x, from.y, color, 10, 340, 0.3, 3);
    this.particles.ring(to.x, to.y, P.hot(color, 0.5), 4, 260, 0.24, 2.5);
    camera.shake(0.07);
  }

  private onSlotCharged(player: PlayerId, slot: number, world: WorldState, selfId: EntityId): void {
    const p = findPlayer(world, player);
    const color = slot === 0 ? P.ENERGY_CYAN : slot === 1 ? P.ENERGY_VIOLET : P.ENERGY_MINT;
    if (p !== null) {
      this.particles.ring(p.pos.x, p.pos.y, color, p.radius * 1.1, 190, 0.5, 3);
      this.particles.motes(p.pos.x, p.pos.y, p.radius * 1.8, color, 10);
    }
    if (p !== null && p.id === selfId) this.pulseEdge(color, 0.45, 0.36);
  }

  private onWeavePower(player: PlayerId, connected: boolean, world: WorldState, selfId: EntityId): void {
    const p = findPlayer(world, player);
    const color = connected ? P.ENERGY_CYAN : P.DANGER_ORANGE;
    if (p !== null) {
      if (connected) this.particles.implode(p.pos.x, p.pos.y, p.radius * 2.6, color, 10);
      else this.particles.sparks(p.pos.x, p.pos.y, color, 8, 0, Math.PI, 130);
    }
    if (p !== null && p.id === selfId) this.pulseEdge(color, connected ? 0.3 : 0.5, connected ? 0.2 : 0.42);
  }

  private onRevive(player: PlayerId, world: WorldState): void {
    const p = findPlayer(world, player);
    if (p === null) return;
    this.particles.motes(p.pos.x, p.pos.y, p.radius * 2.4, P.ENERGY_MINT, 26);
    this.particles.ring(p.pos.x, p.pos.y, P.ENERGY_MINT, p.radius, 240, 0.7, 4);
    this.shock(p.pos.x, p.pos.y, p.radius, p.radius * 4, 0.5, 4, P.ENERGY_MINT, 0);
  }

  // ================================================================ spawners

  /** Expanding shockwave ring in world space. */
  shock(x: number, y: number, r0: number, r1: number, life: number, width: number, color: string, flare: number): void {
    const s = this.shocks[this.shockCursor];
    this.shockCursor = (this.shockCursor + 1) % MAX_SHOCKS;
    s.active = true;
    s.x = x;
    s.y = y;
    s.r0 = r0;
    s.r1 = r1;
    s.life = life;
    s.maxLife = life;
    s.width = width;
    s.color = color;
    s.flare = flare;
  }

  /** Fading tapered line — beams, dashes, muzzle stabs. */
  streak(x0: number, y0: number, x1: number, y1: number, color: string, width: number, life: number): void {
    const s = this.streaks[this.streakCursor];
    this.streakCursor = (this.streakCursor + 1) % MAX_STREAKS;
    s.active = true;
    s.x0 = x0;
    s.y0 = y0;
    s.x1 = x1;
    s.y1 = y1;
    s.color = color;
    s.width = width;
    s.life = life;
    s.maxLife = life;
  }

  /**
   * How many numbers already claimed roughly this spot in the last
   * `NUMBER_CROWD_WINDOW` seconds. Drives both the sideways fan and the pop
   * delay, so a burst of hits on one target reads as a legible column instead of
   * a pile of overlapping glyphs.
   */
  private crowdAt(x: number, y: number): number {
    let n = 0;
    for (let i = 0; i < MAX_NUMBERS; i++) {
      const f = this.numbers[i];
      if (!f.active || f.age > NUMBER_CROWD_WINDOW) continue;
      const dx = f.ox - x;
      const dy = f.oy - y;
      if (dx * dx + dy * dy <= NUMBER_CROWD_RADIUS * NUMBER_CROWD_RADIUS) n++;
    }
    return n;
  }

  damageNumber(x: number, y: number, damage: number, crit: boolean, incoming: boolean): void {
    const n = this.numbers[this.numberCursor];
    this.numberCursor = (this.numberCursor + 1) % MAX_NUMBERS;
    const value = Math.max(1, Math.round(damage));
    // Deterministic fan: 0, +1, -1, +2, -2 ... columns out from the hit. Random
    // jitter was not enough — two rolls land on top of each other often enough
    // that a burst reads as a smear.
    const stack = this.crowdAt(x, y);
    const rank = (stack + 1) >> 1;
    const side = (stack & 1) === 0 ? 1 : -1;
    const lane = stack === 0 ? 0 : side * rank * NUMBER_LANE_STEP;

    n.active = true;
    n.ox = x;
    n.oy = y;
    n.age = 0;
    n.x = x + lane + (Math.random() * 2 - 1) * 3;
    // Each successive number also starts higher, so even a dead-centre stack
    // separates vertically before anything has had time to drift.
    n.y = y - 6 - stack * 11;
    n.vx = lane * 0.5 + (Math.random() * 2 - 1) * 12;
    n.vy = -104 - stack * 9;
    // ...and pops a beat later, so the eye can follow the order they landed in.
    n.delay = Math.min(stack * 0.05, 0.3);
    n.life = crit ? 1.25 : 1.0;
    n.maxLife = n.life;
    n.text = crit ? value + '!' : String(value);
    n.size = crit ? 29 : incoming ? 23 : 20;
    n.color = crit ? P.DMG_CRIT : incoming ? P.DMG_INCOMING : P.DMG_NORMAL;
    n.crit = crit;
  }

  /** Green healing number. Exposed for Agent F if it wants to surface heals. */
  healNumber(x: number, y: number, amount: number): void {
    const n = this.numbers[this.numberCursor];
    this.numberCursor = (this.numberCursor + 1) % MAX_NUMBERS;
    n.active = true;
    n.x = x;
    n.y = y - 10;
    n.vx = (Math.random() * 2 - 1) * 18;
    n.vy = -86;
    n.life = 0.95;
    n.maxLife = n.life;
    n.text = '+' + Math.max(1, Math.round(amount));
    n.size = 19;
    n.color = P.DMG_HEAL;
    n.crit = false;
    n.delay = 0;
    n.ox = x;
    n.oy = y;
    n.age = 0;
  }

  /** Coloured flash around the screen border. */
  pulseEdge(color: string, life: number, strength: number): void {
    const e = this.edges[this.edgeCursor];
    this.edgeCursor = (this.edgeCursor + 1) % MAX_EDGE;
    e.active = true;
    e.color = color;
    e.life = life;
    e.maxLife = life;
    e.strength = strength;
  }

  /** Manually mark an entity as struck (used by the renderer for telegraph resolves). */
  markFlash(id: EntityId, amount = 1): void {
    this.flashes.set(id, HIT_FLASH_TIME * amount);
  }

  // ================================================================ update

  /**
   * @param dt        scaled seconds (slowed during hitstop) — drives visuals
   * @param realDtMs  unscaled milliseconds — drives the hitstop countdown
   */
  update(dt: number, realDtMs: number): void {
    if (this.hitstopMs > 0) {
      this.hitstopMs -= realDtMs;
      if (this.hitstopMs < 0) this.hitstopMs = 0;
    }
    const realDt = realDtMs / 1000;
    this.aberration = decay(this.aberration, 4.5 * realDt);
    this.flash = decay(this.flash, 4.2 * realDt);

    for (let i = 0; i < MAX_SHOCKS; i++) {
      const s = this.shocks[i];
      if (!s.active) continue;
      s.life -= dt;
      if (s.life <= 0) s.active = false;
    }
    for (let i = 0; i < MAX_STREAKS; i++) {
      const s = this.streaks[i];
      if (!s.active) continue;
      s.life -= dt;
      if (s.life <= 0) s.active = false;
    }
    for (let i = 0; i < MAX_NUMBERS; i++) {
      const n = this.numbers[i];
      if (!n.active) continue;
      n.age += dt;
      if (n.delay > 0) {
        // Still queued behind an earlier number on the same spot: hold position
        // and hold the clock, so the stagger costs no readable lifetime.
        n.delay -= dt;
        continue;
      }
      n.life -= dt;
      if (n.life <= 0) {
        n.active = false;
        continue;
      }
      n.x += n.vx * dt;
      n.y += n.vy * dt;
      n.vy += 210 * dt; // arc up, then fall back
      n.vx *= 1 - 1.8 * dt;
    }
    for (let i = 0; i < MAX_EDGE; i++) {
      const e = this.edges[i];
      if (!e.active) continue;
      e.life -= realDt;
      if (e.life <= 0) e.active = false;
    }

    if (this.flashes.size > 0) {
      for (const [id, t] of this.flashes) {
        const next = t - dt;
        if (next <= 0) this.flashes.delete(id);
        else this.flashes.set(id, next);
      }
    }
  }

  // ================================================================ drawing

  /** World-space pass. `ctx` must already carry the camera transform. */
  drawWorld(ctx: CanvasRenderingContext2D, cam: Camera): void {
    ctx.globalCompositeOperation = 'lighter';

    // --- shockwaves
    for (let i = 0; i < MAX_SHOCKS; i++) {
      const s = this.shocks[i];
      if (!s.active) continue;
      const t = 1 - s.life / s.maxLife; // 0 -> 1
      const r = s.r0 + (s.r1 - s.r0) * easeOutCubic(t);
      if (r <= 0.5 || !cam.isVisible(s.x, s.y, r + s.width * 3)) continue;
      const a = (1 - t) * (1 - t);
      const w = s.width * (1 - t * 0.55);

      ctx.strokeStyle = P.withAlpha(s.color, a * 0.17);
      ctx.lineWidth = w * 3.4;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, TAU);
      ctx.stroke();

      ctx.strokeStyle = P.withAlpha(s.color, a * 0.46);
      ctx.lineWidth = w * 1.5;
      ctx.stroke();

      ctx.strokeStyle = P.withAlpha(P.hot(s.color, 0.75), a * 0.85);
      ctx.lineWidth = Math.max(0.6, w * 0.42);
      ctx.stroke();

      if (s.flare > 0 && t < 0.35) {
        const fa = (1 - t / 0.35) * 0.5;
        ctx.fillStyle = P.withAlpha(s.color, fa * 0.18);
        ctx.beginPath();
        ctx.arc(s.x, s.y, r * 0.82, 0, TAU);
        ctx.fill();
      }
    }

    // --- streaks (beams, dashes, muzzle stabs)
    ctx.lineCap = 'round';
    for (let i = 0; i < MAX_STREAKS; i++) {
      const s = this.streaks[i];
      if (!s.active) continue;
      const a = s.life / s.maxLife;
      const w = s.width * (0.25 + 0.75 * a);
      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0);
      ctx.lineTo(s.x1, s.y1);
      ctx.strokeStyle = P.withAlpha(s.color, a * 0.13);
      ctx.lineWidth = w * 2.1;
      ctx.stroke();
      ctx.strokeStyle = P.withAlpha(s.color, a * 0.44);
      ctx.lineWidth = w * 1.15;
      ctx.stroke();
      ctx.strokeStyle = P.withAlpha(P.hot(s.color, 0.8), a);
      ctx.lineWidth = Math.max(0.8, w * 0.4);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';

    ctx.globalCompositeOperation = 'source-over';
  }

  /** Screen-space pass: floating numbers. Call after the world, before dressing. */
  drawNumbers(ctx: CanvasRenderingContext2D, cam: Camera): void {
    let any = false;
    for (let i = 0; i < MAX_NUMBERS; i++) {
      if (this.numbers[i].active) {
        any = true;
        break;
      }
    }
    if (!any) return;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < MAX_NUMBERS; i++) {
      const n = this.numbers[i];
      if (!n.active || n.delay > 0) continue;
      const t = n.life / n.maxLife;
      // Hold full opacity for most of the life and fade late. The old 0.65
      // threshold meant a number spent two thirds of its time washing out, which
      // is what made a busy fight read as grey mush.
      const a = t > 0.3 ? 1 : t / 0.3;
      const pop = t > 0.82 ? 1 + (t - 0.82) * 2.6 : 1;
      const sx = cam.toScreenX(n.x, n.y);
      const sy = cam.toScreenY(n.x, n.y);
      const size = n.size * pop * (0.75 + 0.25 * cam.zoom);

      ctx.font = `900 ${size.toFixed(1)}px "Eurostile", "Bahnschrift", "DIN Alternate", system-ui, sans-serif`;
      // Two-step outline: a wide near-opaque halo carves the glyph out of
      // whatever is behind it, then a tight dark rim keeps the edges crisp.
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = Math.max(5, size * 0.34);
      ctx.strokeStyle = P.withAlpha(P.BG_ABYSS, a * 0.88);
      ctx.strokeText(n.text, sx, sy);
      ctx.lineWidth = Math.max(2, size * 0.15);
      ctx.strokeStyle = P.withAlpha(P.TEXT_SHADOW, a * 0.95);
      ctx.strokeText(n.text, sx, sy);
      ctx.fillStyle = P.withAlpha(n.color, a);
      ctx.fillText(n.text, sx, sy);

      // Every number gets a light core, not just crits: on this background a
      // flat fill still reads dull against the additive VFX around it.
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = P.withAlpha(n.crit ? P.CORE_WHITE : n.color, a * (n.crit ? 0.4 : 0.22));
      ctx.fillText(n.text, sx, sy);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.lineJoin = 'miter';
  }

  /** Screen-space pass: edge pulses + white flash. Draw last. */
  drawScreen(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    for (let i = 0; i < MAX_EDGE; i++) {
      const e = this.edges[i];
      if (!e.active) continue;
      const t = e.life / e.maxLife;
      const a = t * t * e.strength;
      if (a <= 0.004) continue;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a;
      ctx.fillStyle = edgeGlow(ctx, w, h, e.color);
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    if (this.flash > 0.004) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = P.withAlpha(P.FLASH_WHITE, this.flash * 0.5);
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}

// ================================================================ helpers

const HIT_FLASH_TIME = 0.15;

function decay(v: number, amount: number): number {
  const n = v - amount;
  return n > 0 ? n : 0;
}

function clamp01to(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

function findEntity(world: WorldState, id: EntityId): Entity | null {
  const list = world.entities;
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

function findPlayer(world: WorldState, playerId: PlayerId): PlayerEntity | null {
  const list = world.entities;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.kind === 'player' && e.playerId === playerId) return e;
  }
  return null;
}

const abilityCache = new Map<string, AbilityDef | null>();

/**
 * `getAbility` throws on unknown ids (and the module may legitimately not know
 * about a server-side id yet). The renderer must never crash on content, so we
 * memoise a null and fall back to a generic flourish.
 */
export function safeAbility(id: string): AbilityDef | null {
  const hit = abilityCache.get(id);
  if (hit !== undefined) return hit;
  let def: AbilityDef | null = null;
  try {
    def = getAbility(id) ?? null;
  } catch {
    def = null;
  }
  abilityCache.set(id, def);
  return def;
}
