/**
 * VOIDLINE — competitive PvP mode handlers.
 *
 * Owned by H. Exports `createDuelHandler()` (pvp_duel) and `createArenaHandler()`
 * (pvp_arena), both implementing D's `ModeHandler`.
 *
 * Design principle this file exists to protect: VOIDLINE's PvP skill expression is
 * TWO-DIMENSIONAL — aim/movement *and* puzzle routing speed. Neither may dominate.
 *   - Dying does NOT wipe your board (that would make snowballing unrecoverable). It
 *     calls `scrambleRotations`, which re-rotates unlocked tiles but preserves the layout
 *     and the locks, and taxes banked charge: same terrain, new route. You pay time, not
 *     knowledge. See `penaliseBoardOnDeath`.
 *   - Falling behind grants a capped `chargeRateMul` bonus (scoring.ts) so a losing
 *     player is never locked out of their own board by a snowballing opponent.
 *   - Between duel rounds every board is regenerated *and* scrambled, so nobody starts
 *     a round on a pre-solved circuit, and the intermission is real routing time.
 *
 * Nothing here uses Date.now() or Math.random(): time is an accumulated match clock fed
 * by `dt`, randomness comes from the seeded `ctx.rng`.
 */

import type { ModeHandler } from './index.js';
import type { Room } from '../room.js';
import type { SimContext } from '@shared/sim.js';
import type { MatchResult } from '@shared/protocol.js';
import type {
  Entity,
  GameMode,
  MatchPhase,
  ObjectiveState,
  PlayerEntity,
  PlayerId,
  RoleId,
  Team,
  Vec2,
} from '@shared/types.js';
import { applyStatus } from '@shared/combat.js';
import { getRole } from '@shared/roles.js';
import { createBoard, recomputePower, scrambleBoard, scrambleRotations } from '@shared/weave.js';
import { clamp } from '@shared/math.js';
import { ABILITY_SLOTS, MAX_PLAYERS_PVP, RESPAWN_DELAY, WEAVE_SIZE } from '@shared/constants.js';
import { ScoreKeeper, type KillReport, type ScoreConfig } from '../systems/scoring.js';
import { SpawnDirector, allPlayers, arenaForMode, isLiving } from '../systems/spawns.js';

// ---------------------------------------------------------------- tuning

/** Duel: best of 5 — first to 3 round wins. */
export const DUEL_ROUNDS_TO_WIN = 3;
/** Hard stop so repeated stalemates cannot loop forever. */
export const DUEL_MAX_ROUNDS_PLAYED = 7;
/** A round that reaches this ends on HP percentage. */
export const DUEL_ROUND_TIME = 90;
/** Prep before round 1 — boards are already generated, this is pure routing time. */
export const DUEL_OPENING_PREP = 4.0;
/** Between-round intermission: HP restored, boards regenerated, players at spawn. */
export const DUEL_INTERMISSION = 5.0;
/** Beat between "round over" and the intermission starting, for the announcer. */
export const DUEL_ROUND_END_HOLD = 1.8;
/**
 * Sudden death. From this many seconds into a round the spine bleeds both runners.
 *
 * Why: with B's final role numbers a bulwark mirror is ~10 landed abilities each way
 * (165 HP, 0.80 damage mul, 0.80 charge mul on a 6x6 board), which can outlast a 90 s
 * round and make the HP% tiebreak the *normal* ending rather than the exception. The
 * bleed is a fraction of MAX HP per second, so it is identical in percentage terms for
 * both players: it never distorts the HP% tiebreak, it just guarantees that stalling
 * loses and that somebody actually dies. Breaker/phantom rounds (4 abilities) end long
 * before it ever engages.
 */
export const DUEL_SURGE_AT = 60;
/**
 * Peak bleed at the round timer, as a fraction of maxHp per second. Ramps linearly
 * 0 -> this over the last 30 s, so the integral is 0.5 * 0.06 * 30 = 90% of max HP.
 * Anyone who has taken a single meaningful hit by t=60 bleeds out before the timer;
 * only two players who genuinely refuse to engage both reach 0:00 together.
 */
export const DUEL_SURGE_PEAK_FRAC = 0.06;

/** Arena: first to this many points. */
export const ARENA_SCORE_LIMIT_FFA = 30;
export const ARENA_SCORE_LIMIT_TEAMS = 50;
/** Safety valve: highest score at this point wins. */
export const ARENA_TIME_LIMIT = 600;
export const ARENA_OPENING_PREP = 3.0;
/** Auto-balanced teams need an even count of at least this many players. */
export const ARENA_TEAM_MIN_PLAYERS = 4;
/** Announce MATCH POINT when the leader is within this of the limit. */
export const ARENA_MATCH_POINT_MARGIN = 4;

/** Fraction of banked slot charge kept through a death. The rest is the toll. */
export const DEATH_CHARGE_RETAIN = 0.6;
/** Seconds with fewer than 2 connected players before the match is called. */
export const FORFEIT_GRACE = 10;

/**
 * Relative "how much this role warps a team fight" weight, used only to auto-balance
 * arena teams. Conduit is the highest because an unanswered support is oppressive.
 */
export const ROLE_TEAM_WEIGHT: Record<RoleId, number> = {
  conduit: 1.35,
  bulwark: 1.1,
  phantom: 1.05,
  breaker: 1.0,
};

/**
 * Can the engine express an n-way free-for-all?
 *
 * BLOCKING CONTRACT GAP — read before changing. `shared/combat.ts` gates *every* damage
 * path (projectiles, beams, AoE, zones, `applyDamage`) behind `isHostile(a, b)`, which is:
 *     same team              -> never hostile
 *     HOSTILE_TABLE          -> { players<->hostile, a<->b, neutral: [] }
 * That is exactly two mutually-hostile groups, and 'neutral' is hostile to nobody. So the
 * largest true free-for-all the `Team` union can encode is TWO players. Marking an 8-way
 * FFA lobby 'neutral' would produce a match in which no shot ever lands.
 *
 * RESOLVED (integrator): rather than overload 'neutral' — which must stay genuinely inert
 * for props and scenery — the Team union gained a dedicated 'ffa' member, and combat.ts
 * now reads:
 *     isHostile: if (a.team === 'ffa' && b.team === 'ffa') return true;   // before the
 *                                                                         // same-team gate
 *     isAlly:    ffa combatants are nobody's ally, so a Conduit cannot heal or shield
 *                the players it is fighting.
 * Free-for-all arenas up to MAX_PLAYERS_PVP are therefore fully lethal.
 */
export const FFA_HOSTILITY_AVAILABLE = true;

/** Team value for FFA players. Every 'ffa' entity fights every other 'ffa' entity. */
export const FFA_TEAM: Team = 'ffa';

/**
 * Which format an arena of `n` players runs. FFA keeps per-player scoring and the lower
 * score limit; teams get clusters, balancing and the higher limit.
 */
export function arenaFormat(n: number): 'ffa' | 'teams' {
  if (FFA_HOSTILITY_AVAILABLE) {
    // Spec behaviour: auto-balanced teams on an even count of 4+, FFA otherwise.
    return n >= ARENA_TEAM_MIN_PLAYERS && n % 2 === 0 ? 'teams' : 'ffa';
  }
  // Degraded behaviour: only a 2-player arena is a genuine FFA (a vs b is mutually
  // hostile), everything larger runs as teams so that combat actually resolves.
  return n >= 3 ? 'teams' : 'ffa';
}

// ---------------------------------------------------------------- helpers

type Stage = 'prep' | 'live' | 'roundEnd' | 'done';

function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function asPlayer(e: Entity | null): PlayerEntity | null {
  return e && e.kind === 'player' ? e : null;
}

/** Stable ordering so team assignment and spawn anchors are deterministic. */
function byPlayerId(a: PlayerEntity, b: PlayerEntity): number {
  return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
}

// ---------------------------------------------------------------- base

abstract class PvpBase implements ModeHandler {
  abstract readonly mode: GameMode;

  protected ctx: SimContext | null = null;
  protected readonly spawns: SpawnDirector;
  protected scores: ScoreKeeper;

  /** Match clock in seconds. The single source of time for everything in this file. */
  protected clock = 0;
  protected stage: Stage = 'prep';
  protected stageTimer = 0;
  protected worldPhase: MatchPhase = 'countdown';

  protected roster: PlayerEntity[] = [];
  protected teamsEnabled = false;
  protected result: MatchResult | null = null;
  protected forfeitTimer = 0;
  protected spawnCursor = 0;

  private readonly announced = new Set<string>();
  private readonly dirtyBoards = new Set<PlayerId>();
  private readonly known = new Set<PlayerId>();

  constructor(protected readonly arenaId: 'duel_spine' | 'arena_fracture', config: ScoreConfig) {
    this.spawns = new SpawnDirector(arenaForMode(this.arenaId === 'duel_spine' ? 'pvp_duel' : 'pvp_arena'));
    this.scores = new ScoreKeeper(config);
  }

  // -------------------------------------------------------------- ModeHandler

  onMatchStart(room: Room, ctx: SimContext): void {
    this.ctx = ctx;
    this.clock = 0;
    this.result = null;
    this.forfeitTimer = 0;
    this.announced.clear();
    this.dirtyBoards.clear();
    this.known.clear();
    this.spawns.reset();

    this.roster = allPlayers(ctx.world).sort(byPlayerId);
    this.setup(ctx);
    for (const p of this.roster) this.known.add(p.playerId);

    const prep = this.openingPrep();
    for (const p of this.roster) {
      this.regenerateBoard(ctx, p);
      this.placeAtSpawn(ctx, p, this.choosePoint(ctx, p));
      this.rootForPrep(ctx, p, prep);
    }
    this.beginPrep(ctx, prep, this.openingLabel());
    this.writeObjective(ctx);
  }

  onTick(room: Room, ctx: SimContext, dt: number): void {
    this.ctx = ctx;
    if (this.stage === 'done') {
      this.writeObjective(ctx);
      return;
    }

    this.clock += dt;
    this.stageTimer = Math.max(0, this.stageTimer - dt);
    this.syncRoster(ctx);
    this.spawns.prune(this.clock);
    this.scores.consumeEvents(ctx.world);
    this.scores.tick(dt);
    this.trackForfeit(dt);

    this.advance(room, ctx, dt);

    ctx.world.phase = this.worldPhase;
    ctx.world.phaseTimer = this.stageTimer;
    this.writeObjective(ctx);
  }

  onDamage(ctx: SimContext, target: Entity, amount: number, source: Entity | null): void {
    this.ctx = ctx;
    if (!(amount > 0)) return;
    // Damage outside live play (intermission sparring) is not a stat and not an assist.
    if (this.stage !== 'live') return;

    const attacker = asPlayer(source);
    const victim = asPlayer(target);

    if (victim) {
      this.scores.recordDamage(this.clock, victim, amount, attacker ? attacker.playerId : null);
    } else if (attacker) {
      this.scores.recordDamageDealtOnly(attacker.playerId, amount);
    }
  }

  onDeath(room: Room, ctx: SimContext, entity: Entity, killer: Entity | null): void {
    this.ctx = ctx;
    const victim = asPlayer(entity);
    if (!victim) return;
    // Already processed (sim may re-report a corpse) — ignore.
    if (victim.respawnTimer > 0) return;

    const slayerRaw = asPlayer(killer);
    const slayer = slayerRaw && slayerRaw.playerId !== victim.playerId ? slayerRaw : null;

    // A PvP death is "waiting to respawn", not "cull me": the entity owns the Weave board
    // and the connection slot. `respawnTimer > 0` is the authoritative dead flag.
    victim.dead = false;
    victim.hp = 0;
    victim.shield = 0;
    victim.downed = false;
    victim.downedTimer = 0;
    victim.reviveProgress = 0;
    victim.vel.x = 0;
    victim.vel.y = 0;
    victim.statuses.length = 0;

    this.penaliseBoardOnDeath(ctx, victim);
    this.spawns.noteDeath(victim.pos, this.clock);

    const report = this.scores.recordKill(this.clock, victim, slayer);
    this.syncEntityScores();
    for (const line of report.announcements) this.announce(ctx, line, 'pvp_announce');
    ctx.emit({ t: 'shake', magnitude: slayer ? 0.55 : 0.35 });

    this.onPlayerDown(room, ctx, victim, slayer, report);
  }

  checkComplete(room: Room, ctx: SimContext): MatchResult | null {
    this.ctx = ctx;
    return this.result;
  }

  spawnPoint(room: Room, player: PlayerEntity): Vec2 {
    const ctx = this.ctx;
    if (!ctx) return this.spawns.fallback(this.spawnCursor++);
    return this.choosePoint(ctx, player);
  }

  // -------------------------------------------------------------- integration surface

  /**
   * Player ids whose `weave` board object was REPLACED (not merely mutated) since the
   * last call. D must re-send `{ t: 'weave', board }` to each of them.
   * Draining is intentional — call it once per tick after `onTick`.
   */
  consumeBoardUpdates(): PlayerId[] {
    const out = [...this.dirtyBoards];
    this.dirtyBoards.clear();
    return out;
  }

  /**
   * Charge-rate multiplier for a player's Weave this tick: role multiplier folded with
   * the comeback bonus. D should pass this into `updateCharge(board, dt, mul, costs)`
   * (multiplied by any `overclock` status the player has).
   */
  chargeRateMulFor(player: PlayerEntity): number {
    const role = getRole(player.role);
    const base = role && role.chargeRateMul > 0 ? role.chargeRateMul : 1;
    return base * this.scores.chargeRateMulFor(player.playerId);
  }

  /** Read-only access for debugging / admin endpoints. */
  get scoreboard(): ScoreKeeper {
    return this.scores;
  }

  // -------------------------------------------------------------- subclass hooks

  protected abstract setup(ctx: SimContext): void;
  protected abstract advance(room: Room, ctx: SimContext, dt: number): void;
  protected abstract onPlayerDown(
    room: Room,
    ctx: SimContext,
    victim: PlayerEntity,
    killer: PlayerEntity | null,
    report: KillReport,
  ): void;
  protected abstract writeObjective(ctx: SimContext): void;
  protected abstract openingPrep(): number;
  protected abstract openingLabel(): string;
  protected abstract choosePoint(ctx: SimContext, player: PlayerEntity): Vec2;
  protected abstract isEnemyOf(a: PlayerEntity, b: PlayerEntity): boolean;

  // -------------------------------------------------------------- shared internals

  protected objective(ctx: SimContext): ObjectiveState {
    let obj = ctx.world.objective;
    if (!obj) {
      obj = { label: '', progress: -1 };
      ctx.world.objective = obj;
    }
    return obj;
  }

  protected announce(ctx: SimContext, label: string, sfx?: string): void {
    ctx.emit({ t: 'objective', label });
    if (sfx) ctx.emit({ t: 'sfx', name: sfx });
  }

  protected announceOnce(ctx: SimContext, key: string, label: string, sfx?: string): void {
    if (this.announced.has(key)) return;
    this.announced.add(key);
    this.announce(ctx, label, sfx);
  }

  protected seed(ctx: SimContext): number {
    return (ctx.rng() * 0xffffffff) >>> 0;
  }

  /**
   * Pick up players who joined after `onMatchStart`, and re-bind the roster if D handed a
   * reconnecting player a fresh entity. Roster entries are never dropped mid-match — a
   * disconnected player keeps their standings row and their respawn slot.
   */
  protected syncRoster(ctx: SimContext): void {
    for (const p of allPlayers(ctx.world)) {
      if (this.known.has(p.playerId)) {
        const idx = this.roster.findIndex((r) => r.playerId === p.playerId);
        if (idx >= 0 && this.roster[idx] !== p) this.roster[idx] = p;
        continue;
      }
      this.known.add(p.playerId);
      this.roster.push(p);
      this.admit(ctx, p);
    }
  }

  /** Called for a player that appears mid-match. Subclasses assign a team first. */
  protected admit(ctx: SimContext, p: PlayerEntity): void {
    this.scores.register(p, p.team);
    this.regenerateBoard(ctx, p);
    this.placeAtSpawn(ctx, p, this.choosePoint(ctx, p));
    this.spawns.protect(ctx, p);
  }

  /**
   * Full board reset: a brand new layout, then scrambled so it is never pre-solved, then
   * powered. Used at match start and at every duel round boundary.
   */
  protected regenerateBoard(ctx: SimContext, p: PlayerEntity): void {
    const role = getRole(p.role);
    const size = role && role.weaveSize > 0 ? role.weaveSize : WEAVE_SIZE;
    const loadout = p.loadout.slice(0, ABILITY_SLOTS);
    const board = createBoard(size, loadout, this.seed(ctx));
    scrambleBoard(board, this.seed(ctx));
    recomputePower(board);
    for (const s of board.slots) s.charge = 0;
    p.weave = board;
    this.dirtyBoards.add(p.playerId);
  }

  /**
   * The cost of dying. `scrambleRotations` re-rotates only unlocked tiles, so the layout,
   * the locks and every blocked cell survive — you keep the terrain and everything you
   * learned about it — but the route is gone and most banked charge with it. You must
   * re-solve a puzzle you already understand before you can threaten anyone again.
   * That is a time tax, not a knowledge reset: snowballing stays recoverable.
   */
  protected penaliseBoardOnDeath(ctx: SimContext, p: PlayerEntity): void {
    if (!p.weave) return;
    scrambleRotations(p.weave, this.seed(ctx));
    recomputePower(p.weave);
    for (const s of p.weave.slots) s.charge *= DEATH_CHARGE_RETAIN;
    this.dirtyBoards.add(p.playerId);
  }

  /** Zero every slot's charge without touching rotations — used entering a live round. */
  protected drainCharge(p: PlayerEntity): void {
    if (!p.weave) return;
    for (const s of p.weave.slots) s.charge = 0;
  }

  protected placeAtSpawn(ctx: SimContext, p: PlayerEntity, pos: Vec2): void {
    p.pos.x = pos.x;
    p.pos.y = pos.y;
    p.vel.x = 0;
    p.vel.y = 0;
    p.hp = p.maxHp;
    p.shield = 0;
    p.dead = false;
    p.downed = false;
    p.downedTimer = 0;
    p.reviveProgress = 0;
    p.respawnTimer = 0;
    p.dashCooldown = 0;
    p.dashing = 0;
    p.statuses.length = 0;
    // The entity may have been culled while dead — make sure it is back in the world.
    if (!ctx.world.entities.includes(p)) ctx.world.entities.push(p);
  }

  /** Freeze players in place for a prep window. They can still rotate tiles. */
  protected rootForPrep(ctx: SimContext, p: PlayerEntity, seconds: number): void {
    applyStatus(ctx, p, { kind: 'root', remaining: seconds, magnitude: 1, source: p.id });
  }

  protected beginPrep(ctx: SimContext, seconds: number, label: string): void {
    this.stage = 'prep';
    this.stageTimer = seconds;
    this.worldPhase = this.clock > 0 ? 'intermission' : 'countdown';
    ctx.world.phase = this.worldPhase;
    ctx.world.phaseTimer = seconds;
    this.announce(ctx, label, 'pvp_round_prep');
  }

  /**
   * Held every prep tick. Players are invulnerable-by-restoration (HP is topped up each
   * tick, so intermission pot-shots are meaningless) and cannot bank charge, but their
   * rotations persist — the intermission is genuine routing time.
   */
  protected holdPrep(ctx: SimContext): void {
    for (const p of this.roster) {
      p.hp = p.maxHp;
      p.dead = false;
      p.respawnTimer = 0;
      this.drainCharge(p);
    }
  }

  protected trackForfeit(dt: number): void {
    const connected = this.roster.filter((p) => p.connected).length;
    if (connected >= 2) this.forfeitTimer = 0;
    else this.forfeitTimer += dt;
  }

  protected shouldForfeit(): boolean {
    return this.forfeitTimer >= FORFEIT_GRACE;
  }

  /** Mirror scoring state onto the entities so the snapshot scoreboard is correct. */
  protected syncEntityScores(): void {
    for (const p of this.roster) {
      const s = this.scores.get(p.playerId);
      if (!s) continue;
      p.score = s.score;
      p.kills = s.kills;
      p.deaths = s.deaths;
    }
  }

  protected finish(ctx: SimContext, winner: string, label: string): MatchResult {
    this.syncEntityScores();
    this.stage = 'done';
    this.stageTimer = 0;
    this.worldPhase = 'complete';
    ctx.world.phase = 'complete';
    ctx.world.phaseTimer = 0;
    this.announce(ctx, label, 'pvp_match_end');
    ctx.emit({ t: 'shake', magnitude: 1.0 });
    this.result = {
      mode: this.mode,
      winner,
      standings: this.scores.standings(),
      durationSec: Math.round(this.clock),
    };
    return this.result;
  }
}

// ---------------------------------------------------------------- duel

/**
 * pvp_duel — strict 1v1, best of 5.
 *
 * Round flow:
 *   prep (routing time, rooted, full HP, charge drained)
 *     -> live (90 s cap; ends on a death or on HP% at time)
 *       -> roundEnd (1.8 s hold for the announcer)
 *         -> prep (boards REGENERATED + scrambled, sides swapped) -> ...
 *   First to 3 round wins takes the match.
 */
class DuelHandler extends PvpBase {
  readonly mode: GameMode = 'pvp_duel';

  private sides: Record<'a' | 'b', PlayerEntity[]> = { a: [], b: [] };
  /** Display round number — a stalemate does not consume one. */
  private roundNumber = 1;
  /** Total rounds actually played, including stalemates. */
  private roundsPlayed = 0;
  private roundClock = 0;
  private roundWinner: 'a' | 'b' | null = null;
  /** damageDealt snapshot at round start, for the HP tiebreak. */
  private roundDamage = new Map<PlayerId, number>();

  constructor() {
    super('duel_spine', { kind: 'rounds', limit: DUEL_ROUNDS_TO_WIN });
  }

  protected setup(ctx: SimContext): void {
    this.scores.setConfig({ kind: 'rounds', limit: DUEL_ROUNDS_TO_WIN });
    this.sides = { a: [], b: [] };
    this.roundNumber = 1;
    this.roundsPlayed = 0;
    this.roundWinner = null;
    // Strict 1v1 in practice (the room caps at 2); alternating keeps 2v2 sane if it ever
    // gets more, rather than throwing.
    this.roster.forEach((p, i) => {
      const team: 'a' | 'b' = i % 2 === 0 ? 'a' : 'b';
      p.team = team;
      this.sides[team].push(p);
      this.scores.register(p, team);
      p.score = 0;
      p.kills = 0;
      p.deaths = 0;
    });
  }

  protected override admit(ctx: SimContext, p: PlayerEntity): void {
    const team: 'a' | 'b' = this.sides.a.length <= this.sides.b.length ? 'a' : 'b';
    p.team = team;
    this.sides[team].push(p);
    super.admit(ctx, p);
    this.scores.register(p, team);
  }

  protected openingPrep(): number {
    return DUEL_OPENING_PREP;
  }

  protected openingLabel(): string {
    return `BEST OF ${DUEL_ROUNDS_TO_WIN * 2 - 1} — ROUND 1`;
  }

  protected isEnemyOf(a: PlayerEntity, b: PlayerEntity): boolean {
    return a.team !== b.team;
  }

  protected choosePoint(ctx: SimContext, player: PlayerEntity): Vec2 {
    const team: 'a' | 'b' = player.team === 'b' ? 'b' : 'a';
    // Sides swap every round so neither player owns the better half of the map, and the
    // anchor pair rotates every two rounds so the opening is not identical each time.
    const swap = this.roundNumber % 2 === 0;
    const cluster: 'a' | 'b' = swap ? (team === 'a' ? 'b' : 'a') : team;
    const pairIndex = Math.floor((this.roundNumber - 1) / 2);
    const base = this.spawns.anchor(cluster, pairIndex);
    // Two players on the same side (degenerate >2 duel) get separated a little.
    const idx = this.sides[team].indexOf(player);
    if (idx > 0) base.y += idx * 70;
    return base;
  }

  protected advance(room: Room, ctx: SimContext, dt: number): void {
    if (this.result) return;

    if (this.roster.filter((p) => p.connected).length < 2 && this.shouldForfeit()) {
      const survivor = this.roster.find((p) => p.connected);
      const winner = survivor ? (survivor.team === 'b' ? 'b' : 'a') : 'a';
      this.finish(ctx, winner, survivor ? `${survivor.name} WINS — OPPONENT DISCONNECTED` : 'MATCH ABANDONED');
      return;
    }

    switch (this.stage) {
      case 'prep':
        this.holdPrep(ctx);
        if (this.stageTimer <= 0) this.startRound(ctx);
        break;

      case 'live':
        this.roundClock += dt;
        this.applySurge(room, ctx, dt);
        if (this.stage === 'live') this.tickLive(ctx);
        break;

      case 'roundEnd':
        if (this.stageTimer <= 0) this.afterRound(ctx);
        break;

      default:
        break;
    }
  }

  private startRound(ctx: SimContext): void {
    this.stage = 'live';
    this.roundClock = 0;
    this.stageTimer = DUEL_ROUND_TIME;
    this.worldPhase = 'playing';
    this.roundWinner = null;
    this.roundDamage.clear();

    for (const p of this.roster) {
      this.placeAtSpawn(ctx, p, this.choosePoint(ctx, p));
      this.drainCharge(p); // rotations kept, banked charge is not
      if (p.weave) recomputePower(p.weave);
      const s = this.scores.get(p.playerId);
      this.roundDamage.set(p.playerId, s ? s.damageDealt : 0);
    }
    this.scores.resetRound();

    const a = this.scores.objectiveScores().a ?? 0;
    const b = this.scores.objectiveScores().b ?? 0;
    this.announce(ctx, `ROUND ${this.roundNumber} — ENGAGE  ${a}–${b}`, 'pvp_round_start');
  }

  /** How hard the spine is bleeding right now, as a fraction of maxHp per second. */
  private surgeRate(): number {
    const elapsed = DUEL_ROUND_TIME - this.stageTimer;
    if (elapsed <= DUEL_SURGE_AT) return 0;
    const span = Math.max(1e-3, DUEL_ROUND_TIME - DUEL_SURGE_AT);
    return DUEL_SURGE_PEAK_FRAC * clamp((elapsed - DUEL_SURGE_AT) / span, 0, 1);
  }

  /**
   * Sudden death. Percentage-of-maxHp bleed applied equally to both runners, so the
   * HP% tiebreak is untouched but a passive round resolves itself. A bleed-out is a
   * killer-less death: it costs the victim the round, and nobody is credited.
   */
  private applySurge(room: Room, ctx: SimContext, dt: number): void {
    const rate = this.surgeRate();
    if (rate <= 0) return;
    this.announceOnce(
      ctx,
      `surge:${this.roundsPlayed}`,
      'REACTOR SURGE — THE SPINE IS BLEEDING',
      'pvp_surge',
    );
    for (const p of this.roster) {
      if (!isLiving(p)) continue;
      p.hp -= p.maxHp * rate * dt;
      if (p.hp > 0) continue;
      p.hp = 0;
      // The sim did not author this death, so emit the cue ourselves before booking it.
      ctx.emit({ t: 'death', pos: { x: p.pos.x, y: p.pos.y }, entity: p.id, kind: 'player' });
      this.onDeath(room, ctx, p, null);
    }
  }

  private tickLive(ctx: SimContext): void {
    const aliveA = this.sides.a.filter(isLiving).length;
    const aliveB = this.sides.b.filter(isLiving).length;

    if (aliveA === 0 && aliveB === 0) {
      this.endRound(ctx, null, 'DOUBLE KILL — STALEMATE');
      return;
    }
    if (aliveB === 0) {
      this.endRound(ctx, 'a', null);
      return;
    }
    if (aliveA === 0) {
      this.endRound(ctx, 'b', null);
      return;
    }

    if (this.stageTimer <= 0) {
      const hpA = this.sideHp(this.sides.a);
      const hpB = this.sideHp(this.sides.b);
      if (Math.abs(hpA - hpB) > 1e-4) {
        const w: 'a' | 'b' = hpA > hpB ? 'a' : 'b';
        const pct = Math.round(Math.max(hpA, hpB) * 100);
        this.endRound(ctx, w, `TIME — ${this.sideName(w)} SURVIVES ON ${pct}%`);
        return;
      }
      // Perfect HP tie: fall through to damage dealt this round.
      const dmgA = this.sideRoundDamage(this.sides.a);
      const dmgB = this.sideRoundDamage(this.sides.b);
      if (Math.abs(dmgA - dmgB) > 1e-4) {
        const w: 'a' | 'b' = dmgA > dmgB ? 'a' : 'b';
        this.endRound(ctx, w, `TIME — ${this.sideName(w)} ON DAMAGE`);
        return;
      }
      this.endRound(ctx, null, 'TIME — STALEMATE');
    }
  }

  /** Average remaining HP fraction for a side. */
  private sideHp(side: PlayerEntity[]): number {
    if (side.length === 0) return 0;
    let sum = 0;
    for (const p of side) sum += p.maxHp > 0 ? clamp(p.hp / p.maxHp, 0, 1) : 0;
    return sum / side.length;
  }

  private sideRoundDamage(side: PlayerEntity[]): number {
    let sum = 0;
    for (const p of side) {
      const s = this.scores.get(p.playerId);
      if (!s) continue;
      sum += s.damageDealt - (this.roundDamage.get(p.playerId) ?? 0);
    }
    return sum;
  }

  private sideName(team: 'a' | 'b'): string {
    const p = this.sides[team][0];
    return p ? p.name : team.toUpperCase();
  }

  protected onPlayerDown(
    room: Room,
    ctx: SimContext,
    victim: PlayerEntity,
    killer: PlayerEntity | null,
    report: KillReport,
  ): void {
    // No respawns inside a duel round — the round itself is the respawn.
    victim.respawnTimer = DUEL_ROUND_END_HOLD + DUEL_INTERMISSION + 1;
  }

  private endRound(ctx: SimContext, winner: 'a' | 'b' | null, label: string | null): void {
    this.stage = 'roundEnd';
    this.stageTimer = DUEL_ROUND_END_HOLD;
    this.worldPhase = 'intermission';
    this.roundWinner = winner;
    this.roundsPlayed += 1;

    if (winner) {
      const champ = this.sides[winner][0];
      if (champ) this.scores.addRoundWin(champ.playerId);
      this.syncEntityScores();
      this.announce(ctx, label ?? `ROUND ${this.roundNumber} — ${this.sideName(winner)}`, 'pvp_round_win');
    } else {
      this.announce(ctx, label ?? 'STALEMATE', 'pvp_round_draw');
    }
    ctx.emit({ t: 'shake', magnitude: 0.8 });
  }

  private afterRound(ctx: SimContext): void {
    const scores = this.scores.objectiveScores();
    const a = scores.a ?? 0;
    const b = scores.b ?? 0;

    if (a >= DUEL_ROUNDS_TO_WIN || b >= DUEL_ROUNDS_TO_WIN) {
      const w: 'a' | 'b' = a >= DUEL_ROUNDS_TO_WIN ? 'a' : 'b';
      this.finish(ctx, w, `${this.sideName(w)} TAKES THE MATCH  ${Math.max(a, b)}–${Math.min(a, b)}`);
      return;
    }
    if (this.roundsPlayed >= DUEL_MAX_ROUNDS_PLAYED) {
      const w: 'a' | 'b' = a === b ? (this.sideRoundDamage(this.sides.a) >= this.sideRoundDamage(this.sides.b) ? 'a' : 'b') : a > b ? 'a' : 'b';
      this.finish(ctx, w, `${this.sideName(w)} TAKES THE MATCH  ${Math.max(a, b)}–${Math.min(a, b)}`);
      return;
    }

    if (this.roundWinner) this.roundNumber += 1;

    // Fresh boards for everyone: new layout, scrambled. Nobody opens a round on a
    // pre-solved circuit, and the comeback player gets the same clean slate.
    for (const p of this.roster) {
      this.regenerateBoard(ctx, p);
      this.placeAtSpawn(ctx, p, this.choosePoint(ctx, p));
      this.rootForPrep(ctx, p, DUEL_INTERMISSION);
    }

    const matchPoint = a === DUEL_ROUNDS_TO_WIN - 1 || b === DUEL_ROUNDS_TO_WIN - 1;
    const header = matchPoint ? 'MATCH POINT' : `ROUND ${this.roundNumber}`;
    this.beginPrep(ctx, DUEL_INTERMISSION, `${header}  ${a}–${b} — RE-ROUTE`);
    if (matchPoint) this.announceOnce(ctx, `mp:${a}:${b}`, 'MATCH POINT', 'pvp_match_point');
  }

  protected writeObjective(ctx: SimContext): void {
    const obj = this.objective(ctx);
    const scores = this.scores.objectiveScores();
    const a = scores.a ?? 0;
    const b = scores.b ?? 0;
    obj.teamScores = { a, b };
    obj.progress = clamp(Math.max(a, b) / DUEL_ROUNDS_TO_WIN, 0, 1);

    switch (this.stage) {
      case 'prep':
        obj.label = `ROUND ${this.roundNumber}  ${a}–${b} · RE-ROUTE ${Math.ceil(this.stageTimer)}`;
        break;
      case 'live':
        obj.label =
          `ROUND ${this.roundNumber}  ${a}–${b} · ${fmtClock(this.stageTimer)}` +
          (this.surgeRate() > 0 ? ' · SURGE' : '');
        break;
      case 'roundEnd':
        obj.label = this.roundWinner
          ? `${this.sideName(this.roundWinner)} TAKES ROUND ${this.roundNumber}  ${a}–${b}`
          : `STALEMATE  ${a}–${b}`;
        break;
      default:
        obj.label = this.result ? `MATCH OVER  ${a}–${b}` : `DUEL  ${a}–${b}`;
        break;
    }
  }
}

// ---------------------------------------------------------------- arena

/**
 * pvp_arena — up to MAX_PLAYERS_PVP.
 *   - Even player count >= 4  -> auto-balanced teams 'a'/'b', first to 50.
 *   - Otherwise               -> FFA, first to 30.
 * Continuous respawn on RESPAWN_DELAY with spawn protection and camp-aware spawn choice.
 */
class ArenaHandler extends PvpBase {
  readonly mode: GameMode = 'pvp_arena';

  private respawning = new Map<PlayerId, number>();
  private scoreLimit = ARENA_SCORE_LIMIT_FFA;
  private teamWipeTimer = 0;

  constructor() {
    super('arena_fracture', { kind: 'ffa', limit: ARENA_SCORE_LIMIT_FFA });
  }

  private connectedPerTeam(): Record<'a' | 'b', number> {
    const out: Record<'a' | 'b', number> = { a: 0, b: 0 };
    for (const p of this.roster) {
      if (!p.connected) continue;
      if (p.team === 'a') out.a += 1;
      else if (p.team === 'b') out.b += 1;
    }
    return out;
  }

  protected setup(ctx: SimContext): void {
    this.respawning.clear();
    this.teamWipeTimer = 0;
    const active = this.roster.slice(0, MAX_PLAYERS_PVP);
    this.teamsEnabled = arenaFormat(active.length) === 'teams';
    this.scoreLimit = this.teamsEnabled ? ARENA_SCORE_LIMIT_TEAMS : ARENA_SCORE_LIMIT_FFA;
    this.scores.setConfig({ kind: this.teamsEnabled ? 'teams' : 'ffa', limit: this.scoreLimit });

    if (this.teamsEnabled) this.balanceTeams(active);
    else this.assignFfaTeams(active);

    for (const p of active) {
      this.scores.register(p, p.team);
      p.score = 0;
      p.kills = 0;
      p.deaths = 0;
    }
  }

  /**
   * FFA team field. Scoring, spawns and the HUD all stay per-player regardless — this
   * only decides who `isHostile` lets you shoot. With FFA_HOSTILITY_AVAILABLE off this
   * is only ever reached with <= 2 players, where a/b is a correct mutual hostility.
   */
  private assignFfaTeams(players: PlayerEntity[]): void {
    if (FFA_HOSTILITY_AVAILABLE) {
      for (const p of players) p.team = FFA_TEAM;
      return;
    }
    players.forEach((p, i) => {
      p.team = i % 2 === 0 ? 'a' : 'b';
    });
  }

  /**
   * Auto-balance by role. Greedy: heaviest roles placed first, each going to the side
   * with the lower total weight (ties broken by how many of that exact role it already
   * has, so conduits/bulwarks split instead of stacking). Side sizes are hard-capped at
   * half the roster, so the result is always even.
   */
  private balanceTeams(players: PlayerEntity[]): void {
    const cap = players.length / 2;
    const weight: Record<'a' | 'b', number> = { a: 0, b: 0 };
    const count: Record<'a' | 'b', number> = { a: 0, b: 0 };
    const roleCount: Record<'a' | 'b', Partial<Record<RoleId, number>>> = { a: {}, b: {} };

    const ordered = players
      .slice()
      .sort((x, y) => (ROLE_TEAM_WEIGHT[y.role] ?? 1) - (ROLE_TEAM_WEIGHT[x.role] ?? 1) || byPlayerId(x, y));

    for (const p of ordered) {
      const w = ROLE_TEAM_WEIGHT[p.role] ?? 1;
      const options: Array<'a' | 'b'> = (['a', 'b'] as const).filter((t) => count[t] < cap);
      const pick =
        options.length === 0
          ? count.a <= count.b
            ? 'a'
            : 'b'
          : options.reduce((best, t) => {
              const costT = weight[t] + 0.5 * (roleCount[t][p.role] ?? 0);
              const costB = weight[best] + 0.5 * (roleCount[best][p.role] ?? 0);
              return costT < costB ? t : best;
            }, options[0]);

      p.team = pick;
      weight[pick] += w;
      count[pick] += 1;
      roleCount[pick][p.role] = (roleCount[pick][p.role] ?? 0) + 1;
    }
  }

  protected override admit(ctx: SimContext, p: PlayerEntity): void {
    if (this.teamsEnabled) {
      const counts = { a: 0, b: 0 };
      for (const o of this.roster) {
        if (o === p) continue;
        if (o.team === 'a') counts.a += 1;
        else if (o.team === 'b') counts.b += 1;
      }
      p.team = counts.a <= counts.b ? 'a' : 'b';
    } else if (FFA_HOSTILITY_AVAILABLE) {
      p.team = FFA_TEAM;
    } else {
      // A joiner that pushes an FFA past 2 makes it un-expressible; slot them opposite
      // the smaller side so they can at least fight someone.
      const counts = { a: 0, b: 0 };
      for (const o of this.roster) {
        if (o === p) continue;
        if (o.team === 'a') counts.a += 1;
        else if (o.team === 'b') counts.b += 1;
      }
      p.team = counts.a <= counts.b ? 'a' : 'b';
    }
    super.admit(ctx, p);
  }

  protected openingPrep(): number {
    return ARENA_OPENING_PREP;
  }

  protected openingLabel(): string {
    return this.teamsEnabled
      ? `TEAM CONTROL — FIRST TO ${this.scoreLimit}`
      : `FREE FOR ALL — FIRST TO ${this.scoreLimit}`;
  }

  protected isEnemyOf(a: PlayerEntity, b: PlayerEntity): boolean {
    if (!this.teamsEnabled) return a.playerId !== b.playerId;
    return a.team !== b.team;
  }

  protected choosePoint(ctx: SimContext, player: PlayerEntity): Vec2 {
    return this.spawns.choose({
      world: ctx.world,
      player,
      isEnemy: (o) => this.isEnemyOf(player, o),
      cluster: this.teamsEnabled ? (player.team === 'b' ? 'b' : 'a') : null,
      now: this.clock,
      rng: ctx.rng,
    });
  }

  protected advance(room: Room, ctx: SimContext, dt: number): void {
    if (this.result) return;

    if (this.shouldForfeit()) {
      const survivor = this.roster.find((p) => p.connected);
      const winner = survivor ? (this.teamsEnabled ? String(survivor.team) : survivor.playerId) : 'a';
      this.finish(ctx, winner, survivor ? `${survivor.name} WINS — LAST RUNNER STANDING` : 'MATCH ABANDONED');
      return;
    }

    // A team emptying out (everyone disconnected) is a forfeit even when the other side
    // still has plenty of players, which the global <2-connected check would never catch.
    if (this.teamsEnabled) {
      const live = this.connectedPerTeam();
      if (live.a === 0 || live.b === 0) this.teamWipeTimer += dt;
      else this.teamWipeTimer = 0;
      if (this.teamWipeTimer >= FORFEIT_GRACE) {
        const w: 'a' | 'b' = live.a > 0 ? 'a' : 'b';
        this.finish(ctx, w, `TEAM ${w.toUpperCase()} WINS — OPPONENTS DISCONNECTED`);
        return;
      }
    }

    if (this.stage === 'prep') {
      this.holdPrep(ctx);
      if (this.stageTimer <= 0) {
        this.stage = 'live';
        this.worldPhase = 'playing';
        this.stageTimer = ARENA_TIME_LIMIT;
        for (const p of this.roster) {
          this.placeAtSpawn(ctx, p, this.choosePoint(ctx, p));
          this.drainCharge(p);
          if (p.weave) recomputePower(p.weave);
        }
        // `beginPrep` already announced the format — this is the go signal.
        this.announce(ctx, 'ENGAGE', 'pvp_round_start');
      }
      return;
    }

    if (this.stage !== 'live') return;

    this.tickRespawns(ctx, dt);
    this.checkMatchPoint(ctx);

    // ---- win conditions
    const top = this.scores.topProgress();
    if (top >= this.scoreLimit) {
      if (this.teamsEnabled) {
        const t = this.scores.teamTotals();
        const w = t.a >= t.b ? 'a' : 'b';
        this.finish(ctx, w, `TEAM ${w.toUpperCase()} WINS  ${Math.max(t.a, t.b)}–${Math.min(t.a, t.b)}`);
      } else {
        const l = this.scores.leader();
        this.finish(ctx, l ? l.playerId : 'a', l ? `${l.name} WINS  ${l.score}` : 'MATCH COMPLETE');
      }
      return;
    }

    if (this.stageTimer <= 0) {
      if (this.teamsEnabled) {
        const t = this.scores.teamTotals();
        const w = t.a >= t.b ? 'a' : 'b';
        this.finish(ctx, w, `TIME — TEAM ${w.toUpperCase()} WINS  ${Math.max(t.a, t.b)}–${Math.min(t.a, t.b)}`);
      } else {
        const l = this.scores.leader();
        this.finish(ctx, l ? l.playerId : 'a', l ? `TIME — ${l.name} WINS  ${l.score}` : 'TIME');
      }
    }
  }

  private tickRespawns(ctx: SimContext, dt: number): void {
    if (this.respawning.size === 0) return;
    for (const [id, remaining] of [...this.respawning]) {
      const p = this.roster.find((x) => x.playerId === id);
      if (!p) {
        this.respawning.delete(id);
        continue;
      }
      const left = remaining - dt;
      if (left > 0) {
        this.respawning.set(id, left);
        p.respawnTimer = left; // authoritative "you are dead" readout for the HUD
        continue;
      }
      this.respawning.delete(id);
      if (!p.connected) {
        p.respawnTimer = 0.1; // stay down until they come back
        continue;
      }
      this.placeAtSpawn(ctx, p, this.choosePoint(ctx, p));
      this.spawns.protect(ctx, p);
      if (p.weave) recomputePower(p.weave);
    }
  }

  private checkMatchPoint(ctx: SimContext): void {
    const top = this.scores.topProgress();
    if (top < this.scoreLimit - ARENA_MATCH_POINT_MARGIN) return;
    if (this.teamsEnabled) {
      const t = this.scores.teamTotals();
      const w = t.a >= t.b ? 'A' : 'B';
      this.announceOnce(ctx, 'matchpoint', `MATCH POINT — TEAM ${w}`, 'pvp_match_point');
    } else {
      const l = this.scores.leader();
      this.announceOnce(ctx, 'matchpoint', `MATCH POINT — ${l ? l.name : 'LEADER'}`, 'pvp_match_point');
    }
  }

  protected onPlayerDown(
    room: Room,
    ctx: SimContext,
    victim: PlayerEntity,
    killer: PlayerEntity | null,
    report: KillReport,
  ): void {
    victim.respawnTimer = RESPAWN_DELAY;
    this.respawning.set(victim.playerId, RESPAWN_DELAY);
  }

  protected writeObjective(ctx: SimContext): void {
    const obj = this.objective(ctx);
    obj.teamScores = this.scores.objectiveScores();
    const top = this.scores.topProgress();
    obj.progress = clamp(top / this.scoreLimit, 0, 1);

    if (this.stage === 'prep') {
      obj.label = `${this.openingLabel()} · ${Math.ceil(this.stageTimer)}`;
      return;
    }
    if (this.stage === 'done') {
      obj.label = this.result ? 'MATCH OVER' : 'ARENA';
      return;
    }
    if (this.teamsEnabled) {
      const t = this.scores.teamTotals();
      obj.label = `A ${t.a} — ${t.b} B · TO ${this.scoreLimit} · ${fmtClock(this.stageTimer)}`;
    } else {
      const l = this.scores.leader();
      obj.label = l
        ? `${l.name} ${l.score}/${this.scoreLimit} · ${fmtClock(this.stageTimer)}`
        : `FIRST TO ${this.scoreLimit} · ${fmtClock(this.stageTimer)}`;
    }
  }
}

// ---------------------------------------------------------------- factories

export function createDuelHandler(): ModeHandler {
  return new DuelHandler();
}

export function createArenaHandler(): ModeHandler {
  return new ArenaHandler();
}

/** Convenience for D's `createModeHandler` switch. */
export function createPvpHandler(mode: GameMode): ModeHandler {
  return mode === 'pvp_duel' ? createDuelHandler() : createArenaHandler();
}

/** True for handlers produced by this module. */
export function isPvpHandler(h: ModeHandler): h is PvpBase {
  return h instanceof PvpBase;
}

/**
 * INTEGRATION — call this where you charge a player's Weave:
 *   const mul = pvpChargeRateMul(handler, player) * overclockMul;
 *   updateCharge(player.weave, dt, mul, costs);
 * It folds the role's own `chargeRateMul` together with the comeback bonus (1.00..1.25).
 * Returns the plain role multiplier for non-PvP handlers, so it is always safe to call.
 */
export function pvpChargeRateMul(h: ModeHandler, player: PlayerEntity): number {
  if (isPvpHandler(h)) return h.chargeRateMulFor(player);
  const role = getRole(player.role);
  return role && role.chargeRateMul > 0 ? role.chargeRateMul : 1;
}

/**
 * INTEGRATION — drain once per tick after `onTick`. Any player id returned had their
 * `weave` board object REPLACED (round reset / match start); D must push a fresh
 * `{ t: 'weave', board }` to that player. Board *mutations* (death scrambles) also flag
 * here, so this is the single "re-send the board" signal.
 */
export function pvpBoardUpdates(h: ModeHandler): PlayerId[] {
  return isPvpHandler(h) ? h.consumeBoardUpdates() : [];
}

export { PvpBase, DuelHandler, ArenaHandler };
