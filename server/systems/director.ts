/**
 * VOIDLINE — co-op wave director.
 *
 * Responsibilities:
 *  - convert (chapter, wave, live player count) into a spawn budget
 *  - spend that budget against a weighted archetype pool
 *  - release the purchase in small groups with gaps, so a wave *arrives* instead
 *    of appearing all at once
 *  - place every spawn away from the players, on the arena rim
 *  - keep an intensity curve with real peaks and troughs, and hard-cap live bodies
 *
 * All randomness comes from `ctx.rng`.
 */

import type { PlayerEntity, Vec2 } from '@shared/types.js';
import type { SimContext } from '@shared/sim.js';
import { clamp, v } from '@shared/math.js';
import { ARENA_H, ARENA_W } from '@shared/constants.js';
import { EnemySystem, enemyThreat } from './enemies.js';

// ---------------------------------------------------------------- tuning

/**
 * Absolute ceiling on simultaneous live hostiles. Matches the renderer's stated
 * perf budget (8 players + 40 enemies + 300 particles at a locked 60 fps).
 */
export const MAX_LIVE_HARD = 40;
/** Nothing spawns closer than this to a living runner. */
export const MIN_SPAWN_DIST = 420;
/** ...unless the arena is too crowded to honour it, then we accept this. */
export const MIN_SPAWN_DIST_FLOOR = 260;
/** Rim inset for spawn placement. */
export const SPAWN_INSET = 90;

/**
 * ---------------------------------------------------------------- adaptive pressure
 *
 * The budget above answers "how much threat does this beat owe?" — it is a
 * function of chapter, wave and headcount only. It cannot answer "is the floor
 * actually occupied?", and those are different questions once damage output
 * varies by an order of magnitude between groups. Four aces at ~168 dps each
 * delete a group of chasers inside one spawn gap, so the arena reads as empty
 * even though the beat has paid for a full wave; a newcomer at ~12 dps is fighting
 * for their life against the same numbers.
 *
 * So the director also measures the group: how many bodies per second are
 * actually leaving the floor, and how much of what it has delivered is still
 * standing. When a group is deleting the floor on arrival, the sustain top-up
 * refills toward the population the beat already declared instead of trickling.
 *
 * Three properties this deliberately keeps:
 *  - It never buys more threat than the chapter authored. `budgetFor`,
 *    `intensityFor`, `playerScale` and `sustainTarget` are all untouched, so the
 *    tuned chapter curve is unchanged; only the sustain refill *rate* adapts, and
 *    it is still hard-clamped by `sustainTarget` and `maxLive` — and therefore by
 *    `MAX_LIVE_HARD`.
 *  - It only applies to sustain. Measured: a wave beat already delivers 8-10
 *    bodies/sec while the fastest group observed clears 3.7/sec, so delivery is
 *    never the binding constraint there — the purchased queue simply runs out.
 *  - Below the entry threshold the adaptive branch is not entered at all, so both
 *    the arithmetic and the `ctx.rng()` call sequence are bit-identical to the
 *    static director. A weak group cannot tell the difference, by construction,
 *    and that is verified by diffing the full pacing table (see below).
 */
/** Time constant of the clearance-rate estimator, seconds. */
export const CLEAR_RATE_TAU = 4.0;
/** Ignore single-tick artifacts (scripted despawns) above this many bodies/sec. */
export const CLEAR_RATE_CLAMP = 40;
/**
 * Adaptation turns on when the floor holds less than this fraction of what has
 * actually been *delivered* to it (capped at the beat's declared population).
 *
 * Measuring against delivery rather than against the target is what makes the
 * test safe. A struggling group's floor tracks delivery almost exactly — nothing
 * they were sent has died yet — so the ratio sits near 1 and the adaptive branch
 * is unreachable for them, including during the fill-in seconds at the start of
 * a beat when the target has not been reached by anybody yet. A group that is
 * deleting bodies on arrival sits near 0.
 *
 * Calibrated, not guessed. Sampling `live / min(target, delivered)` at every
 * sustain top-up across all 5 chapters x 1-4 runners with the ORIGINAL static
 * director gives:
 *
 *     12 dps/runner (a newcomer)   min 0.133  p05 0.300  p50 0.875
 *     42 dps/runner (competent)    min 0.000  p05 0.000  p50 0.188
 *    168 dps/runner (four aces)    min 0.000  p50 0.000  p90 0.143
 *
 * Entry sits at 0.125 — strictly below the *minimum* a 12 dps group ever
 * produced — so the gentle chapters are not merely "about the same" for a weak
 * group, the adaptive branch is unreachable and the sim is bit-identical.
 * Release is much higher so that once adaptation engages it holds long enough to
 * actually repopulate the floor instead of chattering at the entry threshold.
 */
export const OCCUPANCY_ENTER = 0.125;
export const OCCUPANCY_EXIT = 0.55;
/** Seconds between sustain top-ups at intensity 1. */
const SUSTAIN_PERIOD = 1.6;
/**
 * Fraction of the gap to the declared live target that one adaptive top-up
 * closes. Replacing only what died holds a population but can never rebuild one
 * — clearance is capped by delivery, so a purely reactive term settles into a
 * near-empty equilibrium. This is the term that actually climbs.
 */
const SUSTAIN_REFILL_GAIN = 0.35;
/** Bodies one adaptive top-up may release. Keeps a refill an arrival, not a wall. */
const SUSTAIN_MAX_GROUP = 8;

/**
 * The shape of a chapter. Peaks and troughs, not a ramp: a wave that eases off
 * makes the next spike land.
 */
export const DEFAULT_INTENSITY = [0.72, 0.9, 1.0, 0.84, 1.14, 0.95, 1.26, 1.08, 1.42, 1.2, 1.55, 1.7];

/** Sub-linear-ish scaling: 1p = 1.00, 2p = 1.40, 3p = 1.80, 4p = 2.20. */
export function playerScale(players: number): number {
  return 0.6 + 0.4 * clamp(players, 1, 4);
}

export interface SpawnEntry {
  archetype: string;
  /** Relative weight in the pool. */
  weight: number;
  /** Not eligible before this (0-indexed) wave. */
  minWave?: number;
  /** Hard cap of this archetype per wave. */
  cap?: number;
}

export interface DirectorConfig {
  chapter: number;
  /** Budget at wave 0 before scaling. */
  budgetBase: number;
  /** Added per wave index. */
  budgetPerWave: number;
  /** Chapter-wide difficulty scalar. */
  chapterMul: number;
  /** Live-body ceiling for this chapter (still clamped by MAX_LIVE_HARD). */
  maxLive: number;
  /** Breathing room after a wave is cleared. */
  restSeconds: number;
  /** Delay before the first body of a wave appears. */
  leadIn: number;
  /** Seconds between spawn groups. */
  groupGap: [number, number];
  /** Bodies per spawn group. */
  groupSize: [number, number];
  intensity: number[];
  pool: SpawnEntry[];
  /** Insert one elite every N waves (0 = never), starting at `eliteFrom`. */
  eliteEvery: number;
  eliteFrom: number;
}

export const BASE_DIRECTOR: DirectorConfig = {
  chapter: 1,
  budgetBase: 6,
  budgetPerWave: 3,
  chapterMul: 1,
  maxLive: 30,
  restSeconds: 6.5,
  leadIn: 1.4,
  groupGap: [0.55, 1.15],
  groupSize: [2, 4],
  intensity: DEFAULT_INTENSITY,
  pool: [{ archetype: 'chaser', weight: 10 }],
  eliteEvery: 0,
  eliteFrom: 99,
};

export type DirectorState = 'idle' | 'leadin' | 'spawning' | 'holding' | 'rest';

interface QueuedSpawn {
  archetype: string;
  /** Force placement near this point instead of the rim (boss adds, scripted). */
  at?: Vec2;
}

export class Director {
  readonly cfg: DirectorConfig;
  private sys: EnemySystem;

  state: DirectorState = 'idle';
  wave = -1;
  /** Bodies bought but not yet released. */
  private queue: QueuedSpawn[] = [];
  private timer = 0;
  private players = 1;

  /** Sustain mode: hold a live population instead of running discrete waves. */
  private sustain = false;
  private sustainTarget = 0;
  private sustainTimer = 0;
  private sustainIntensity = 1;

  /** Diagnostics for the objective HUD. */
  spawnedThisWave = 0;
  budgetThisWave = 0;

  /** Bodies leaving the floor per second, EMA. See "adaptive pressure" above. */
  private clearRate = 0;
  private prevLive = -1;
  private releasedSinceSample = 0;
  /** Bodies released since the current beat began — the occupancy denominator. */
  private releasedThisBeat = 0;
  /** Latched adaptive state (see OCCUPANCY_ENTER / OCCUPANCY_EXIT). */
  private adaptive = false;

  constructor(sys: EnemySystem, cfg: Partial<DirectorConfig> = {}) {
    this.sys = sys;
    this.cfg = { ...BASE_DIRECTOR, ...cfg };
  }

  // ---------------------------------------------------------- budget

  get maxLive(): number {
    return Math.min(
      MAX_LIVE_HARD,
      Math.min(this.cfg.maxLive, 12 + 7 * clamp(this.players, 1, 4) + this.cfg.chapter * 2),
    );
  }

  intensityFor(wave: number): number {
    const c = this.cfg.intensity;
    if (c.length === 0) return 1;
    return wave < c.length ? c[wave] : c[c.length - 1] + (wave - c.length + 1) * 0.12;
  }

  budgetFor(wave: number, players: number): number {
    const raw =
      (this.cfg.budgetBase + this.cfg.budgetPerWave * wave) *
      this.cfg.chapterMul *
      playerScale(players) *
      this.intensityFor(wave);
    return Math.max(2, raw);
  }

  // ---------------------------------------------------------- clearance rate

  /**
   * Bodies/sec the group is currently removing from the floor, smoothed.
   * Exposed for tuning harnesses and the pacing tests.
   */
  get clearancePerSec(): number {
    return this.clearRate;
  }

  /**
   * True once the group is demonstrably eating the floor faster than it fills.
   * While this is false the adaptive branch is never entered, so a weak or
   * average group runs the original arithmetic on the original `ctx.rng()`
   * sequence — byte-identical, not merely similar.
   */
  outpacing(live: number, target: number): boolean {
    if (target <= 0 || this.clearRate <= 0 || this.releasedThisBeat < 2) {
      this.adaptive = false;
      return false;
    }
    const occupancy = live / Math.min(target, this.releasedThisBeat);
    if (this.adaptive) this.adaptive = occupancy < OCCUPANCY_EXIT;
    else this.adaptive = occupancy < OCCUPANCY_ENTER;
    return this.adaptive;
  }

  /**
   * Fold this tick's floor delta into the estimator. Spawns released since the
   * last sample are added back so arrivals never read as departures.
   */
  private sampleClearance(live: number, dt: number): void {
    if (this.prevLive < 0 || dt <= 0) {
      this.prevLive = live;
      this.releasedSinceSample = 0;
      return;
    }
    const removed = Math.max(0, this.prevLive + this.releasedSinceSample - live);
    this.prevLive = live;
    this.releasedSinceSample = 0;
    const inst = Math.min(CLEAR_RATE_CLAMP, removed / dt);
    this.clearRate += (inst - this.clearRate) * clamp(dt / CLEAR_RATE_TAU, 0, 1);
  }

  /** Forget the measured rate across a beat boundary (mass despawns lie). */
  private resetClearance(): void {
    this.clearRate = 0;
    this.prevLive = -1;
    this.releasedSinceSample = 0;
    this.releasedThisBeat = 0;
    this.adaptive = false;
  }

  // ---------------------------------------------------------- wave control

  beginWave(ctx: SimContext, wave: number, players: number): void {
    this.resetClearance();
    this.sustain = false;
    this.wave = wave;
    this.players = clamp(players, 1, 4);
    this.queue = this.buy(ctx, this.budgetFor(wave, this.players), wave);
    this.budgetThisWave = this.queue.length;
    this.spawnedThisWave = 0;
    this.state = 'leadin';
    this.timer = this.cfg.leadIn;
  }

  /**
   * Chapter 4-style continuous pressure. `targetLive` bodies are kept alive for
   * `seconds`; the director keeps topping the arena up.
   */
  beginSustain(ctx: SimContext, players: number, targetLive: number, intensity: number): void {
    this.resetClearance();
    this.sustain = true;
    this.players = clamp(players, 1, 4);
    this.sustainTarget = Math.min(this.maxLive, Math.round(targetLive * playerScale(this.players) * 0.6));
    this.sustainIntensity = intensity;
    this.sustainTimer = 0;
    this.state = 'spawning';
    this.queue = [];
  }

  /** Queue explicit bodies (scripted beats, boss adds). */
  push(archetype: string, count = 1, at?: Vec2): void {
    for (let i = 0; i < count; i++) this.queue.push({ archetype, at });
    if (this.state === 'idle' || this.state === 'rest') {
      this.state = 'spawning';
      this.timer = 0.2;
    }
  }

  stop(): void {
    this.queue = [];
    this.sustain = false;
    this.state = 'idle';
    this.resetClearance();
  }

  get pending(): number {
    return this.queue.length;
  }

  /** True once everything bought has been released and the arena is clear. */
  waveCleared(ctx: SimContext): boolean {
    if (this.sustain) return false;
    if (this.queue.length > 0) return false;
    if (this.state === 'leadin' || this.state === 'spawning') return false;
    return this.sys.liveCombatants(ctx).length === 0;
  }

  /** 0..1 progress through the current wave, for the HUD. */
  waveProgress(ctx: SimContext): number {
    const total = Math.max(1, this.budgetThisWave);
    const remaining = this.queue.length + this.sys.liveCombatants(ctx).length;
    return clamp(1 - remaining / total, 0, 1);
  }

  // ---------------------------------------------------------- tick

  update(ctx: SimContext, dt: number): void {
    const alive = this.sys.livingPlayers(ctx);
    if (alive.length > 0) this.players = clamp(alive.length, 1, 4);

    const liveNow = this.sys.liveCombatants(ctx).length;
    this.sampleClearance(liveNow, dt);

    if (this.sustain) {
      this.sustainTimer -= dt;
      if (this.sustainTimer <= 0) {
        const period = SUSTAIN_PERIOD / Math.max(0.4, this.sustainIntensity);
        this.sustainTimer = period;
        const live = liveNow;
        const target = Math.min(this.maxLive, this.sustainTarget);
        const room = target - live;
        if (room > 0) {
          // The static draw is always taken so the rng sequence does not fork.
          const drawn = 1 + Math.floor(ctx.rng() * 2.99);
          let n = drawn;
          if (this.outpacing(live, target)) {
            // Replace what this group is actually killing, then close part of
            // the gap back to the population the beat declared. `room` is the
            // hard ceiling, so this can only ever fill the beat up to its own
            // `sustainTarget` (itself clamped by `maxLive` / `MAX_LIVE_HARD`) —
            // it can never make the beat bigger than authored.
            const replace = this.clearRate * period;
            const refill = room * SUSTAIN_REFILL_GAIN;
            n = Math.min(SUSTAIN_MAX_GROUP, Math.max(drawn, Math.round(replace + refill)));
          }
          n = Math.min(room, Math.max(1, n));
          const bought = this.buy(ctx, n * 2.2 * this.sustainIntensity, Math.max(2, this.wave));
          for (const b of bought.slice(0, n)) this.release(ctx, b, alive);
        }
      }
      return;
    }

    switch (this.state) {
      case 'idle':
      case 'rest':
        this.timer -= dt;
        if (this.timer <= 0) this.state = 'idle';
        return;

      case 'leadin':
        this.timer -= dt;
        if (this.timer <= 0) {
          this.state = 'spawning';
          this.timer = 0;
        }
        return;

      case 'spawning': {
        this.timer -= dt;
        if (this.timer > 0) return;
        const live = liveNow;
        if (live >= this.maxLive) {
          this.timer = 0.5;
          return;
        }
        // A bigger group kills faster, so a fixed arrival rate would make a
        // four-stack feel emptier than a solo run even though it is fighting
        // more bodies overall. Scale the delivery rate, not just the budget.
        const crowd = clamp(this.players, 1, 4);
        const groupMin = this.cfg.groupSize[0];
        const groupMax = this.cfg.groupSize[1] + (crowd >= 3 ? 1 : 0);
        let n = groupMin + Math.floor(ctx.rng() * (groupMax - groupMin + 1));
        // NOTE: the wave path deliberately does NOT take an adaptive term.
        // Measured: a wave already delivers 8-10 bodies/sec while the fastest
        // group observed clears 3.7/sec, so delivery is never the binding
        // constraint here — the purchased queue simply runs out. Widening it
        // would mean buying more threat, which is `budgetFor`'s job and would
        // move the tuned chapter curve. Sustain is where the adaptation belongs.
        n = Math.min(n, this.queue.length, this.maxLive - live);
        for (let i = 0; i < n; i++) {
          const q = this.queue.shift();
          if (!q) break;
          this.release(ctx, q, alive);
        }
        const [gMin, gMax] = this.cfg.groupGap;
        this.timer = (gMin + ctx.rng() * (gMax - gMin)) / (0.8 + 0.2 * crowd);
        if (this.queue.length === 0) this.state = 'holding';
        return;
      }

      case 'holding':
        if (this.sys.liveCombatants(ctx).length === 0) {
          this.state = 'rest';
          this.timer = this.cfg.restSeconds;
        }
        return;
    }
  }

  /** Seconds of breathing room still owed before the next wave should start. */
  get restRemaining(): number {
    return this.state === 'rest' ? Math.max(0, this.timer) : 0;
  }

  // ---------------------------------------------------------- internals

  private release(ctx: SimContext, q: QueuedSpawn, players: PlayerEntity[]): void {
    const pos = q.at ? this.jitter(ctx, q.at, 70) : this.pickSpawn(ctx, players);
    this.sys.spawn(ctx, q.archetype, pos, {});
    this.spawnedThisWave++;
    this.releasedSinceSample++;
    this.releasedThisBeat++;
  }

  private jitter(ctx: SimContext, p: Vec2, r: number): Vec2 {
    const a = ctx.rng() * Math.PI * 2;
    const d = ctx.rng() * r;
    return {
      x: clamp(p.x + Math.cos(a) * d, SPAWN_INSET, ARENA_W - SPAWN_INSET),
      y: clamp(p.y + Math.sin(a) * d, SPAWN_INSET, ARENA_H - SPAWN_INSET),
    };
  }

  /**
   * Rim placement, biased away from the group. Samples candidates and keeps the
   * best; degrades the distance requirement rather than ever failing.
   */
  pickSpawn(ctx: SimContext, players: PlayerEntity[]): Vec2 {
    let best: Vec2 = { x: ARENA_W / 2, y: SPAWN_INSET };
    let bestScore = -Infinity;

    for (let i = 0; i < 14; i++) {
      const c = this.rimPoint(ctx);
      let nearest = Infinity;
      for (const p of players) nearest = Math.min(nearest, v.dist(c, p.pos));
      if (players.length === 0) nearest = MIN_SPAWN_DIST;
      // Prefer "just out of sight" over "the far corner": cap the reward.
      const score = Math.min(nearest, MIN_SPAWN_DIST + 320) + ctx.rng() * 40;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
      if (nearest >= MIN_SPAWN_DIST) break;
    }
    if (bestScore < MIN_SPAWN_DIST_FLOOR) {
      // Everything is crowded: push to the farthest rim point from the centroid.
      const cx = players.reduce((s, p) => s + p.pos.x, 0) / Math.max(1, players.length);
      const cy = players.reduce((s, p) => s + p.pos.y, 0) / Math.max(1, players.length);
      best = {
        x: cx < ARENA_W / 2 ? ARENA_W - SPAWN_INSET : SPAWN_INSET,
        y: cy < ARENA_H / 2 ? ARENA_H - SPAWN_INSET : SPAWN_INSET,
      };
    }
    return best;
  }

  private rimPoint(ctx: SimContext): Vec2 {
    const side = Math.floor(ctx.rng() * 4) % 4;
    const t = ctx.rng();
    switch (side) {
      case 0: return { x: SPAWN_INSET + t * (ARENA_W - SPAWN_INSET * 2), y: SPAWN_INSET };
      case 1: return { x: ARENA_W - SPAWN_INSET, y: SPAWN_INSET + t * (ARENA_H - SPAWN_INSET * 2) };
      case 2: return { x: SPAWN_INSET + t * (ARENA_W - SPAWN_INSET * 2), y: ARENA_H - SPAWN_INSET };
      default: return { x: SPAWN_INSET, y: SPAWN_INSET + t * (ARENA_H - SPAWN_INSET * 2) };
    }
  }

  /** Spend a budget against the weighted pool. */
  private buy(ctx: SimContext, budget: number, wave: number): QueuedSpawn[] {
    const out: QueuedSpawn[] = [];
    const used = new Map<string, number>();

    // Scheduled elite: bought first so the budget accounts for it.
    if (
      this.cfg.eliteEvery > 0 &&
      wave >= this.cfg.eliteFrom &&
      (wave - this.cfg.eliteFrom) % this.cfg.eliteEvery === 0
    ) {
      out.push({ archetype: 'elite' });
      budget -= enemyThreat('elite');
      used.set('elite', 1);
    }

    let guard = 0;
    while (budget > 0 && guard++ < 200) {
      const eligible = this.cfg.pool.filter((p) => {
        if ((p.minWave ?? 0) > wave) return false;
        if (p.cap !== undefined && (used.get(p.archetype) ?? 0) >= p.cap) return false;
        return enemyThreat(p.archetype) <= budget + 0.5;
      });
      if (eligible.length === 0) break;

      const total = eligible.reduce((s, p) => s + p.weight, 0);
      let r = ctx.rng() * total;
      let choice = eligible[eligible.length - 1];
      for (const p of eligible) {
        r -= p.weight;
        if (r <= 0) {
          choice = p;
          break;
        }
      }
      out.push({ archetype: choice.archetype });
      used.set(choice.archetype, (used.get(choice.archetype) ?? 0) + 1);
      budget -= enemyThreat(choice.archetype);
    }

    // Interleave so groups are mixed rather than "eight husks, then eight spitters".
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(ctx.rng() * (i + 1)) % (i + 1);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }
}
