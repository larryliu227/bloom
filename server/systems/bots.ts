/**
 * VOIDLINE — AI runners ("bots").
 *
 * A bot is a full roster member: it takes a lobby seat, gets a real
 * `PlayerEntity` with a real Weave board from `Room.buildMatch`, and is driven
 * by synthesized `InputFrame`s through the exact same `stepWorld` path a human
 * uses. It has no socket, no snapshot, and no private channel into the sim —
 * everything it does, a human could do with a mouse.
 *
 * It plays both halves of the game:
 *   - COMBAT  approach / hold standoff / strafe, aim with lead and jitter, pull
 *             the trigger on charged slots, throw the free basic attack, and
 *             dash out of telegraphed hits and incoming projectiles.
 *   - PUZZLE  rotate its own conduit tiles to route power from the core to its
 *             three slots, one click at a time, throttled by the same
 *             `WEAVE_ROTATE_COOLDOWN` a human is forced to respect.
 *
 * Difficulty is mostly ROUTING SPEED. A bot that solves its board instantly is
 * not fun and not beatable on the puzzle axis, which is the game's identity, so
 * `rotationsPerSec` is the primary dial; reaction latency and aim jitter are the
 * secondary ones.
 *
 * Determinism: every random choice comes from `SimContext.rng`. No `Math.random`.
 */

import {
  ARENA_H,
  ARENA_W,
  DASH_COOLDOWN,
  PLAYER_RADIUS,
  REVIVE_RADIUS,
  WEAVE_ROTATE_COOLDOWN,
} from '@shared/constants.js';
import { getAbility } from '@shared/abilities.js';
import { alliesOf, hostilesOf, isHostile } from '@shared/combat.js';
import { v } from '@shared/math.js';
import { ActionBit } from '@shared/protocol.js';
import type { InputFrame } from '@shared/protocol.js';
import { ROLE_LIST } from '@shared/roles.js';
import type { SimContext } from '@shared/sim.js';
import type {
  AbilityDef,
  Entity,
  LobbyPlayer,
  PlayerEntity,
  PlayerId,
  RoleId,
  Vec2,
  WeaveBoard,
} from '@shared/types.js';
import {
  applySolution,
  canFire,
  cloneBoard,
  isSolvable,
  routeDistance,
  slotTileIndex,
} from '@shared/weave.js';

import type { BotTier } from '../lobby.js';
import type { Room } from '../room.js';

// ---------------------------------------------------------------- difficulty

export interface BotProfile {
  tier: BotTier;
  label: string;
  /** ms between re-decisions. Also the bot's aim latency: aim is frozen between. */
  reactionMs: number;
  /** Radians of aim error, scaled down at point blank and up at long range. */
  aimJitter: number;
  /**
   * Tile rotations per second — THE difficulty dial. A human is hard-capped at
   * 1 / WEAVE_ROTATE_COOLDOWN = 12.5/s, so even `ace` routes at about half the
   * mechanical ceiling of a good player.
   */
  rotationsPerSec: number;
  /**
   * Time spent "reading" the board before the first click of a new route — after
   * the match starts and after anything restructures the grid (a sapper burst, a
   * boss scramble). The other half of the routing dial: a recruit is effectively
   * out of the fight for a second and a half after its board is hit.
   */
  planDelayMs: number;
  /** Chance to answer a telegraph / incoming projectile with a dash. */
  dodgeChance: number;
  /** How long a slot sits charged before the trigger gets pulled. */
  triggerDelayMs: number;
  /** Fraction of its best ability's range the bot tries to hold. */
  standoff: number;
  /** 0..1 of the true intercept lead applied when aiming at a moving target. */
  leadFactor: number;
  /** Retreat below this HP fraction instead of trading. */
  kiteBelowHp: number;
}

export const BOT_PROFILES: Record<BotTier, BotProfile> = {
  recruit: {
    tier: 'recruit',
    label: 'RECRUIT',
    reactionMs: 420,
    aimJitter: 0.17,
    rotationsPerSec: 1.2,
    planDelayMs: 1500,
    dodgeChance: 0.2,
    triggerDelayMs: 340,
    standoff: 0.55,
    leadFactor: 0.25,
    kiteBelowHp: 0.15,
  },
  veteran: {
    tier: 'veteran',
    label: 'VETERAN',
    reactionMs: 230,
    aimJitter: 0.075,
    rotationsPerSec: 3,
    planDelayMs: 600,
    dodgeChance: 0.55,
    triggerDelayMs: 150,
    standoff: 0.72,
    leadFactor: 0.7,
    kiteBelowHp: 0.3,
  },
  ace: {
    tier: 'ace',
    label: 'ACE',
    reactionMs: 110,
    aimJitter: 0.025,
    rotationsPerSec: 6.5,
    planDelayMs: 150,
    dodgeChance: 0.9,
    triggerDelayMs: 40,
    standoff: 0.85,
    leadFactor: 1,
    kiteBelowHp: 0.4,
  },
};

/** Beatable by a competent human, respectable to a good one. */
export const DEFAULT_BOT_TIER: BotTier = 'veteran';

export const BOT_TIERS: BotTier[] = ['recruit', 'veteran', 'ace'];

export function isBotTier(value: unknown): value is BotTier {
  return typeof value === 'string' && (BOT_TIERS as string[]).indexOf(value) >= 0;
}

/** Bot ids deliberately fail `isPlayerId`, so no client can adopt a bot seat. */
const BOT_ID_PREFIX = 'bot_';
const CALLSIGNS = ['ARC', 'VEX', 'ECHO', 'KILN', 'ONYX', 'RUNE', 'ZEPH', 'MIRE'];

export function isBotId(id: PlayerId): boolean {
  return id.startsWith(BOT_ID_PREFIX);
}

// ---------------------------------------------------------------- per-bot state

interface BotState {
  playerId: PlayerId;
  profile: BotProfile;
  seq: number;
  /** Decision outputs, held between reactions. */
  aim: Vec2;
  move: Vec2;
  /** One-shot buttons for the tick the decision was made on. */
  pulse: number;
  pulseTicks: number;
  /** Buttons held every tick until the next decision (revive needs a hold). */
  hold: number;
  thinkAccum: number;
  targetId: number;
  strafeSign: number;
  strafeTimer: number;
  dodgeCooldown: number;
  /** Milliseconds each slot has been continuously fireable, for the trigger delay. */
  hotFor: number[];
  /** Preferred engagement distance, derived from the loadout at match start. */
  range: number;
  // --- puzzle half
  plan: number[] | null;
  planStamp: string;
  /** Seconds left of "reading the board" before the next click is allowed. */
  planDelay: number;
  rotateBudget: number;
  rotateCooldown: number;
  rotations: number;
  wanderTimer: number;
  wander: Vec2;
}

function freshState(playerId: PlayerId, profile: BotProfile): BotState {
  return {
    playerId,
    profile,
    seq: 1,
    aim: { x: ARENA_W / 2, y: ARENA_H / 2 },
    move: { x: 0, y: 0 },
    pulse: 0,
    pulseTicks: 0,
    hold: 0,
    thinkAccum: 0,
    targetId: -1,
    strafeSign: 1,
    strafeTimer: 0,
    dodgeCooldown: 0,
    hotFor: [0, 0, 0],
    range: 260,
    plan: null,
    planStamp: '',
    planDelay: profile.planDelayMs / 1000,
    rotateBudget: 0,
    rotateCooldown: 0,
    rotations: 0,
    wanderTimer: 0,
    wander: { x: ARENA_W / 2, y: ARENA_H / 2 },
  };
}

// ---------------------------------------------------------------- controller

/**
 * One per room. Owns the bot seats and drives them from the room's match tick.
 * Held by `Room`; `Room` calls `onMatchStart` and `think`.
 */
export class BotController {
  private readonly room: Room;
  private readonly states = new Map<PlayerId, BotState>();
  private nextIndex = 0;

  constructor(room: Room) {
    this.room = room;
  }

  get count(): number {
    return this.states.size;
  }

  ids(): PlayerId[] {
    return [...this.states.keys()];
  }

  tierOf(playerId: PlayerId): BotTier | null {
    return this.states.get(playerId)?.profile.tier ?? null;
  }

  /**
   * Seat a bot. Returns null if there is no room for one — the lobby is full,
   * the match is already live, or the room is closed.
   */
  add(tier: BotTier = DEFAULT_BOT_TIER, role?: RoleId): LobbyPlayer | null {
    const room = this.room;
    if (room.closed) return null;
    if (room.phase !== 'lobby' && room.phase !== 'loadout' && room.phase !== 'complete') return null;
    if (room.lobby.isFull()) return null;

    const profile = BOT_PROFILES[tier] ?? BOT_PROFILES[DEFAULT_BOT_TIER];
    const index = this.nextIndex++;
    const id = `${BOT_ID_PREFIX}${room.id.toLowerCase()}_${index}`;
    const callsign = CALLSIGNS[index % CALLSIGNS.length];
    const name = `BOT ${callsign}-${index + 1}`;
    const chosen = role ?? this.pickRole(index);

    const seat = room.lobby.addBot(id, name, chosen, profile.tier);
    this.states.set(id, freshState(id, profile));
    return seat;
  }

  /** Remove the most recently added bot. Returns the seat that was freed. */
  remove(playerId?: PlayerId): LobbyPlayer | null {
    const bots = this.room.lobby.bots();
    if (bots.length === 0) return null;
    const seat = playerId ? bots.find((b) => b.playerId === playerId) : bots[bots.length - 1];
    if (!seat) return null;
    this.states.delete(seat.playerId);
    this.room.releaseBotSeat(seat.playerId);
    return seat;
  }

  removeAll(): void {
    for (const seat of this.room.lobby.bots()) {
      this.states.delete(seat.playerId);
      this.room.releaseBotSeat(seat.playerId);
    }
    this.states.clear();
  }

  /**
   * Spread roles so a lobby of bots is not four Breakers. Deterministic, and it
   * skips nothing: `ROLE_LIST` order is the content author's order.
   */
  private pickRole(index: number): RoleId {
    let list: RoleId[] = [];
    try {
      list = (ROLE_LIST ?? []).map((r) => r.id);
    } catch {
      list = [];
    }
    if (list.length === 0) return 'breaker';
    return list[index % list.length];
  }

  /** Re-arm every bot for a fresh match: new board, new plan, no stale target. */
  onMatchStart(): void {
    for (const [id, old] of this.states) {
      const next = freshState(id, old.profile);
      const entity = this.room.players.get(id);
      if (entity) next.range = preferredRange(entity, old.profile);
      this.states.set(id, next);
    }
  }

  /** Total tile rotations performed this match, for tests and telemetry. */
  rotationCount(): number {
    let n = 0;
    for (const s of this.states.values()) n += s.rotations;
    return n;
  }

  /**
   * Drive every bot for one tick. Called from `Room.tickMatch` BEFORE inputs are
   * collected, so a decision made now is applied by `stepWorld` on this tick.
   */
  think(ctx: SimContext, dt: number): void {
    if (this.states.size === 0) return;
    for (const state of this.states.values()) {
      const self = this.room.players.get(state.playerId);
      if (!self) continue;

      // The puzzle half runs even while the combat half is idle — a downed bot
      // cannot rotate (the room refuses), but a waiting one keeps routing.
      this.routeWeave(state, self, dt);
      this.tickTriggers(state, self, dt);

      if (self.dead || self.hp <= 0 || self.downed || self.respawnTimer > 0) {
        state.pulse = 0;
        state.hold = 0;
        this.room.setBotInput(state.playerId, this.frame(state, { x: 0, y: 0 }, 0));
        continue;
      }

      state.dodgeCooldown = Math.max(0, state.dodgeCooldown - dt);
      state.strafeTimer -= dt;
      state.thinkAccum += dt * 1000;
      if (state.thinkAccum >= state.profile.reactionMs) {
        state.thinkAccum = 0;
        this.decide(ctx, state, self, dt);
      }

      // Buttons are pulsed, never held: a held fire bit would make the bot
      // discharge every slot the instant it charges, which reads as a machine.
      let buttons = state.hold;
      if (state.pulseTicks > 0) {
        buttons |= state.pulse;
        state.pulseTicks -= 1;
        if (state.pulseTicks <= 0) state.pulse = 0;
      }
      this.room.setBotInput(state.playerId, this.frame(state, state.move, buttons));
    }
  }

  /**
   * Per-slot "how long has this been fireable" clock, in ms of real elapsed
   * time, advanced every tick.
   *
   * It used to be bumped by `reactionMs` once per *decision*, which quietly made
   * `triggerDelayMs` unreachable for all three tiers — every tier's trigger delay
   * is shorter than its own reaction time, so the first decision after a slot lit
   * up always cleared it and the hesitation dial did nothing. Sampling real time
   * every tick makes the dial independent of `reactionMs`, which is what lets a
   * recruit read as hesitant rather than merely slow to look up.
   */
  private tickTriggers(state: BotState, self: PlayerEntity, dt: number): void {
    const board = self.weave;
    const idle = self.dead || self.hp <= 0 || self.downed || self.respawnTimer > 0;
    for (let slot = 0; slot < state.hotFor.length; slot += 1) {
      const ability = abilityOf(self.loadout[slot] ?? board?.slots?.[slot]?.ability);
      if (idle || !board || !ability || !canFire(board, slot, ability)) {
        state.hotFor[slot] = 0;
        continue;
      }
      state.hotFor[slot] += dt * 1000;
    }
  }

  private frame(state: BotState, move: Vec2, buttons: number): InputFrame {
    return {
      seq: state.seq++,
      move: { x: move.x, y: move.y },
      aim: { x: state.aim.x, y: state.aim.y },
      buttons,
      ts: 0,
    };
  }

  // -------------------------------------------------------------- combat half

  /** One decision, taken every `reactionMs`. Everything below is its output. */
  private decide(ctx: SimContext, state: BotState, self: PlayerEntity, dt: number): void {
    const prof = state.profile;
    const step = prof.reactionMs / 1000;
    let pulse = 0;
    state.hold = 0;

    // Co-op triage outranks everything: a downed ally on the floor is worth more
    // than any damage this bot could be doing instead.
    const rescue = this.pickRescue(ctx, self);
    if (rescue) {
      state.targetId = -1;
      state.aim = { x: rescue.pos.x, y: rescue.pos.y };
      if (v.dist(self.pos, rescue.pos) > REVIVE_RADIUS * 0.55) {
        state.move = v.dir(self.pos, rescue.pos);
      } else {
        state.move = { x: 0, y: 0 };
        state.hold = ActionBit.Interact; // held, not pulsed: revive needs contact
      }
      state.pulse = 0;
      state.pulseTicks = 0;
      return;
    }

    const target = this.pickTarget(ctx, state, self);
    if (!target) {
      state.targetId = -1;
      state.wanderTimer -= step;
      if (state.wanderTimer <= 0 || v.dist(self.pos, state.wander) < 90) {
        state.wanderTimer = 3 + ctx.rng() * 3;
        const margin = PLAYER_RADIUS * 5;
        state.wander = {
          x: margin + ctx.rng() * (ARENA_W - margin * 2),
          y: margin + ctx.rng() * (ARENA_H - margin * 2),
        };
      }
      state.move = v.dir(self.pos, state.wander);
      state.aim = v.addScaled(self.pos, state.move, 180);
      // Support roles keep the team topped up between fights.
      const idle = this.pickSupport(ctx, state, self);
      if (idle) {
        state.aim = idle.aim;
        pulse |= idle.button;
      }
      state.pulse = pulse;
      state.pulseTicks = pulse ? 2 : 0;
      return;
    }

    state.targetId = target.id;
    const dist = Math.max(1, v.dist(self.pos, target.pos));
    const dir = v.dir(self.pos, target.pos);
    const perp = v.perp(dir);

    // --- aim: lead the target, then miss it by the tier's jitter -----------
    const shot = this.pickShot(state, self, dist);
    /*
     * Only lead a shot that actually takes time to arrive.
     *
     * `speed: 0` means INSTANT (beams are hitscan, aoe lands at the cursor), not
     * "unknown speed" — the old `speed > 0 ? speed : 900` fallback treated a beam
     * as a slow projectile and aimed up to 0.6 s of target motion ahead of a shot
     * that arrives immediately. Measured effect: `rail_lance` landed 8% of casts.
     * With lead suppressed for instant shapes it lands ~65%, which puts all three
     * beams exactly on their designed damage-per-charge. Never reintroduce a
     * non-zero default here.
     */
    const instant = shot !== null && (shot.ability.shape === 'beam' || shot.ability.shape === 'aoe');
    const speed = shot && shot.ability.speed > 0 ? shot.ability.speed : 900;
    const lead = instant ? 0 : Math.min(0.6, (dist / Math.max(140, speed)) * prof.leadFactor);
    const predicted = v.addScaled(target.pos, target.vel, lead);
    const spread = (ctx.rng() * 2 - 1) * prof.aimJitter * (0.45 + Math.min(1, dist / 420));
    state.aim = v.add(self.pos, v.rot(v.sub(predicted, self.pos), spread));

    // --- footwork: close, kite, or orbit ----------------------------------
    if (state.strafeTimer <= 0) {
      state.strafeSign = ctx.rng() < 0.5 ? -1 : 1;
      state.strafeTimer = 0.7 + ctx.rng() * 1.1;
    }
    const hurt = self.hp / Math.max(1, self.maxHp) < prof.kiteBelowHp;
    const want = state.range * (hurt ? 1.5 : 1);
    const sign = state.strafeSign;
    let move: Vec2;
    if (dist > want * 1.15) {
      move = { x: dir.x + perp.x * 0.35 * sign, y: dir.y + perp.y * 0.35 * sign };
    } else if (dist < want * 0.7) {
      move = { x: -dir.x + perp.x * 0.5 * sign, y: -dir.y + perp.y * 0.5 * sign };
    } else {
      move = { x: perp.x * sign, y: perp.y * sign };
    }
    state.move = v.norm(move);

    // --- dash: dodge what is about to land, or close a dead gap ------------
    const threat = this.threatDir(ctx, self);
    if (threat && state.dodgeCooldown <= 0 && self.dashCooldown <= 0 && ctx.rng() < prof.dodgeChance) {
      state.move = threat;
      pulse |= ActionBit.Dash;
      state.dodgeCooldown = DASH_COOLDOWN * 0.25;
    } else if (!threat && dist > want * 2.2 && self.dashCooldown <= 0 && ctx.rng() < 0.3) {
      pulse |= ActionBit.Dash;
    }

    // --- trigger. One slot per decision, so the aim always matches the shot.
    const support = this.pickSupport(ctx, state, self);
    if (support && (!shot || support.urgent)) {
      state.aim = support.aim;
      pulse |= support.button;
    } else if (shot) {
      pulse |= ActionBit.Fire1 << shot.slot;
    } else if (dist <= 430) {
      pulse |= ActionBit.Basic; // free attack, rate limited by the sim
    }

    state.pulse = pulse;
    state.pulseTicks = pulse === 0 ? 0 : 2;
    void dt;
  }

  /**
   * Nearest downed ally worth picking up, or null. A bot that is itself nearly
   * dead, or standing in somebody's line of fire, finishes the fight first.
   */
  private pickRescue(ctx: SimContext, self: PlayerEntity): PlayerEntity | null {
    if (self.hp / Math.max(1, self.maxHp) < 0.35) return null;
    let best: PlayerEntity | null = null;
    let bestDist = 900;
    for (const ally of alliesOf(ctx, self)) {
      if (ally.kind !== 'player' || !ally.downed) continue;
      const d = v.dist(self.pos, ally.pos);
      if (d < bestDist) {
        bestDist = d;
        best = ally;
      }
    }
    return best;
  }

  /**
   * Nearest live hostile, with hysteresis so the bot does not oscillate between
   * two equidistant enemies, and a bonus for something nearly dead.
   */
  private pickTarget(ctx: SimContext, state: BotState, self: PlayerEntity): Entity | null {
    let best: Entity | null = null;
    let bestScore = Infinity;
    for (const e of hostilesOf(ctx, self)) {
      let score = v.dist(self.pos, e.pos);
      if (e.id === state.targetId) score -= 90; // stickiness
      if (e.hp <= e.maxHp * 0.3) score -= 120; // finish the wounded
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  /**
   * How far away a bot may stand and still usefully cast `ability`.
   *
   * `AbilityDef.range` does NOT mean "cast range" for every shape, and reading it
   * as one made three whole shapes uncastable by any bot:
   *   - self-centred novas (`concussion`, `seismic_slam`) declare `range: 0` and do
   *     their work in `radius` around the caster — the old `max(80, range)` floor of
   *     80 was below `preferredRange`'s 110 minimum, so the gate never opened.
   *   - `summon` uses `range` for the SUMMON's own engagement radius, not how far
   *     the caster may be from a target; measured, a raised gate took `ward_pylon`
   *     from 1.0 to 11 casts/min.
   * So: novas reach by radius, summons are placement (drop them whenever a target
   * is anywhere near), everything else uses range as written.
   */
  static castReach(ability: AbilityDef): number {
    if (ability.shape === 'summon') return Math.max(320, ability.range);
    if (ability.range <= 0) return Math.max(80, ability.radius);
    return Math.max(80, ability.range);
  }

  /**
   * Best charged offensive slot that can actually reach. `hotFor` implements the
   * reaction gap between "the slot lit up" and "the bot pulled the trigger".
   */
  private pickShot(
    state: BotState,
    self: PlayerEntity,
    dist: number,
  ): { slot: number; ability: AbilityDef } | null {
    const board = self.weave;
    if (!board || !board.slots) return null;
    let best: { slot: number; ability: AbilityDef } | null = null;
    let bestScore = -1;

    for (let slot = 0; slot < board.slots.length && slot < 3; slot += 1) {
      const ability = abilityOf(self.loadout[slot] ?? board.slots[slot].ability);
      if (!ability || ability.friendly) continue;
      if (!canFire(board, slot, ability)) continue;
      // `hotFor` is advanced by `tickTriggers`; this is a pure read.
      if (state.hotFor[slot] < state.profile.triggerDelayMs) continue;
      if (dist > BotController.castReach(ability) * 1.05) continue;

      const score =
        ability.damage * (ability.radius >= 40 ? 1.25 : 1) + (ability.applies ? 12 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { slot, ability };
      }
    }
    return best;
  }

  /** Charged friendly slot plus who needs it most (self included). */
  private pickSupport(
    ctx: SimContext,
    state: BotState,
    self: PlayerEntity,
  ): { aim: Vec2; button: number; urgent: boolean } | null {
    const board = self.weave;
    if (!board || !board.slots) return null;

    for (let slot = 0; slot < board.slots.length && slot < 3; slot += 1) {
      const ability = abilityOf(self.loadout[slot] ?? board.slots[slot].ability);
      if (!ability || !ability.friendly) continue;
      if (!canFire(board, slot, ability)) continue;
      if (state.hotFor[slot] < state.profile.triggerDelayMs) continue;

      const reach = Math.max(90, ability.range);
      let who: Entity = self;
      let worst = self.hp / Math.max(1, self.maxHp);
      for (const ally of alliesOf(ctx, self)) {
        if (v.dist(self.pos, ally.pos) > reach) continue;
        const frac = ally.hp / Math.max(1, ally.maxHp);
        if (frac < worst) {
          worst = frac;
          who = ally;
        }
      }
      // A heal on a full-health target is wasted charge; buffs never are.
      const isHeal = ability.shape !== 'buff' && ability.damage > 0;
      if (isHeal && worst > 0.85) continue;
      return {
        aim: { x: who.pos.x, y: who.pos.y },
        button: ActionBit.Fire1 << slot,
        urgent: worst < 0.5,
      };
    }
    return null;
  }

  /**
   * Direction to dash to survive the next half second, or null if nothing is
   * about to land. Answers two threats: a projectile whose closest approach
   * clips us, and an enemy mid-telegraph nearby.
   */
  private threatDir(ctx: SimContext, self: PlayerEntity): Vec2 | null {
    let best: Vec2 | null = null;
    let soonest = Infinity;

    for (const e of ctx.world.entities) {
      if (e.dead || e.id === self.id) continue;

      if (e.kind === 'projectile') {
        if (!isHostile(self, e)) continue;
        const d0 = v.sub(e.pos, self.pos);
        const rv = v.sub(e.vel, self.vel);
        const speed2 = v.len2(rv);
        if (speed2 < 400) continue;
        const t = -v.dot(d0, rv) / speed2;
        if (t <= 0 || t > 0.5 || t >= soonest) continue;
        const at = v.addScaled(d0, rv, t);
        if (v.len(at) > self.radius + e.radius + 18) continue;
        soonest = t;
        const away = v.norm(v.scale(at, -1));
        best = v.len2(away) > 0.01 ? away : v.norm(v.perp(rv));
        continue;
      }

      if (e.kind === 'enemy' && e.telegraph > 0 && e.telegraph < 0.7) {
        const dist = v.dist(self.pos, e.pos);
        if (dist > 280 || e.telegraph >= soonest) continue;
        soonest = e.telegraph;
        const away = v.dir(e.pos, self.pos);
        const side = v.perp(away);
        best = v.norm({ x: away.x * 0.6 + side.x * 0.85, y: away.y * 0.6 + side.y * 0.85 });
      }
    }
    return best;
  }

  // -------------------------------------------------------------- puzzle half

  /**
   * Route power. The bot spends a budget of `rotationsPerSec` clicks and is then
   * throttled by `WEAVE_ROTATE_COOLDOWN` on top — the room enforces that cooldown
   * itself, exactly as it does for a mouse click, so a bot can never out-click
   * the human ceiling of 12.5 rotations/sec.
   */
  private routeWeave(state: BotState, self: PlayerEntity, dt: number): void {
    const board = self.weave;
    if (!board || !board.tiles || board.tiles.length === 0) return;

    // Re-plan only when the board's STRUCTURE moves (a sapper burst, a boss
    // scramble locking cells). Rotations alone never invalidate the plan.
    const stamp = boardStamp(board);
    if (stamp !== state.planStamp) {
      const first = state.planStamp === '';
      state.plan = computePlan(board);
      state.planStamp = stamp;
      // Reading a board takes time. On a mid-fight restructure it takes the full
      // plan delay again — this is what makes a low tier punishable by a sapper.
      state.planDelay = Math.max(state.planDelay, (state.profile.planDelayMs / 1000) * (first ? 1 : 1.25));
      state.rotateBudget = 0;
    }

    state.rotateCooldown = Math.max(0, state.rotateCooldown - dt);
    if (state.planDelay > 0) {
      state.planDelay = Math.max(0, state.planDelay - dt);
      return;
    }
    state.rotateBudget = Math.min(2, state.rotateBudget + state.profile.rotationsPerSec * dt);
    if (state.rotateBudget < 1 || state.rotateCooldown > 0) return;

    const index = this.pickRotation(board, state);
    if (index < 0 || !this.room.rotateTileFor(state.playerId, index)) {
      // Nothing worth doing: hold the budget at one click so the bot reacts
      // immediately when the board changes, instead of banking a burst.
      state.rotateBudget = Math.min(state.rotateBudget, 1);
      return;
    }
    state.rotateBudget -= 1;
    state.rotateCooldown = WEAVE_ROTATE_COOLDOWN;
    state.rotations += 1;
  }

  /**
   * Which tile to click. Greedy on `routeDistance` (the immediate win), with
   * `solveBoard`/`applySolution`'s global plan as the tie-break so the bot cannot
   * stall in a local minimum. It never applies the solution to its live board.
   */
  private pickRotation(board: WeaveBoard, state: BotState): number {
    const primary = primarySlot(board);
    if (primary < 0) return -1; // every slot is already live

    // The plan prunes the search; it is never obeyed. If pruning leaves nothing
    // while a slot is still dark, the plan disagrees with the live board — a
    // co-op relay board the throwaway clone cannot model, or a solve that fell
    // outside the budget. Retry unpruned rather than freeze this bot's routing
    // for the rest of the match, which is what an empty candidate list did.
    let candidates = candidateTiles(board, state.plan, primary);
    if (candidates.length === 0 && state.plan) {
      state.plan = null;
      candidates = candidateTiles(board, null, primary);
    }
    if (candidates.length === 0) return -1;

    let bestIndex = -1;
    let bestScore = boardScore(board, primary);
    for (const index of candidates) {
      const tile = board.tiles[index];
      const before = tile.rotation;
      tile.rotation = (before + 1) & 3;
      const score = boardScore(board, primary);
      tile.rotation = before;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    // No single click pays off yet — take the next step of the global plan.
    return bestIndex >= 0 ? bestIndex : candidates[0];
  }
}

// ---------------------------------------------------------------- free functions

/** Seat a bot in `room`. Declared in ARCHITECTURE.md's shape. */
export function addBot(
  room: Room,
  role?: RoleId,
  tier: BotTier = DEFAULT_BOT_TIER,
): LobbyPlayer | null {
  return room.bots.add(tier, role);
}

/** Free the most recently added bot seat. */
export function removeBot(room: Room): LobbyPlayer | null {
  return room.bots.remove();
}

// ---------------------------------------------------------------- weave helpers

/** The slot most worth working on: unpowered, and cheapest to reach. */
function primarySlot(board: WeaveBoard): number {
  let best = -1;
  let bestDist = Infinity;
  for (let slot = 0; slot < board.slots.length; slot += 1) {
    const d = routeDistance(board, slot);
    if (d <= 0) continue; // 0 = already live, -1 = unroutable
    if (d < bestDist) {
      bestDist = d;
      best = slot;
    }
  }
  return best;
}

/**
 * Weighted total routing distance. The slot being worked on counts triple, so
 * the bot commits to finishing a circuit instead of nudging all three forever —
 * but the other two still count, which is what stops it from tearing down a live
 * slot to save one click on another.
 */
function boardScore(board: WeaveBoard, primary: number): number {
  let sum = 0;
  for (let slot = 0; slot < board.slots.length; slot += 1) {
    const d = routeDistance(board, slot);
    sum += (d < 0 ? 14 : d) * (slot === primary ? 3 : 1);
  }
  return sum;
}

/** Rotatable, plan-mismatched tiles, nearest the target slot first. */
function candidateTiles(board: WeaveBoard, plan: number[] | null, primary: number): number[] {
  const target = primary >= 0 ? slotTileIndex(board, primary) : board.coreIndex;
  const n = Math.max(1, board.size);
  const tx = target % n;
  const ty = (target / n) | 0;
  const scored: Array<{ index: number; d: number }> = [];

  for (let i = 0; i < board.tiles.length; i += 1) {
    const t = board.tiles[i];
    if (t.locked) continue;
    if (t.kind === 'empty' || t.kind === 'blocked' || t.kind === 'core' || t.kind === 'slot') continue;
    if (plan && plan.length === board.tiles.length && t.rotation === plan[i]) continue;
    scored.push({ index: i, d: Math.abs((i % n) - tx) + Math.abs(((i / n) | 0) - ty) });
  }
  scored.sort((a, b) => a.d - b.d || a.index - b.index);
  return scored.slice(0, plan ? 8 : 10).map((c) => c.index);
}

/**
 * Target rotations for a fully routed board, computed on a throwaway clone.
 * `applySolution` would hand the live board a finished puzzle for free, which is
 * precisely the thing that must never happen — so it only ever runs on the copy.
 */
function computePlan(board: WeaveBoard): number[] | null {
  try {
    if (!isSolvable(board)) return null; // dead cells took the last route out
    const probe = cloneBoard(board);
    if (!applySolution(probe)) return null;
    return probe.tiles.map((t) => t.rotation);
  } catch {
    return null;
  }
}

/** Changes only when the board's structure does — not when a tile turns. */
function boardStamp(board: WeaveBoard): string {
  let s = `${board.size}|`;
  for (const t of board.tiles) s += t.locked ? t.kind.charAt(0).toUpperCase() : t.kind.charAt(0);
  return s;
}

// ---------------------------------------------------------------- misc helpers

function abilityOf(id: string | undefined): AbilityDef | null {
  if (!id) return null;
  try {
    return getAbility(id) ?? null;
  } catch {
    return null;
  }
}

/** Standoff distance from the loadout's longest offensive reach. */
function preferredRange(p: PlayerEntity, prof: BotProfile): number {
  let longest = 0;
  for (const id of p.loadout) {
    const a = abilityOf(id);
    if (!a || a.friendly) continue;
    // Use effective cast reach, not raw `range`. A self-centred nova declares
    // `range: 0`, so reading `range` here let an all-nova loadout compute the 320
    // fallback and hold a standoff it could never attack from — the bot would
    // circle at 320 units holding a charged 170-radius blast forever.
    const reach = BotController.castReach(a);
    if (reach > longest) longest = reach;
  }
  if (longest <= 0) longest = 320;
  return Math.max(110, Math.min(560, longest * prof.standoff));
}
