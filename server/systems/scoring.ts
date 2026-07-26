/**
 * VOIDLINE — PvP scoring.
 *
 * Owned by H. Tracks kills, assists (via a per-victim damage ledger), killstreaks,
 * first blood, multi-kills, shutdowns, the full `MatchResult.standings` stat block,
 * and the **comeback mechanic**.
 *
 * Comeback rationale: VOIDLINE's skill expression is two-dimensional — aim/movement AND
 * puzzle routing. A snowballing opponent who keeps blowing up your board effectively
 * locks you out of the second dimension entirely. A losing player therefore gets a modest
 * `chargeRateMul` bonus so they can still *route*. It is deliberately capped low enough
 * that it never wins a fight on its own (see COMEBACK_MAX_BONUS).
 *
 * No wall-clock: every timestamp is the mode handler's match clock in seconds.
 */

import type { EntityId, GameEvent, PlayerEntity, PlayerId, RoleId, Team, WorldState } from '@shared/types.js';
import type { MatchResult } from '@shared/protocol.js';
import { clamp } from '@shared/math.js';

// ---------------------------------------------------------------- score table

/**
 * The whole scoring table in one place.
 *
 *   kill                +2
 *   assist              +1   (top 3 contributors, >=10% of victim maxHp within 8 s)
 *   first blood         +3   (once per match, on top of the kill)
 *   killstreak          +1 per 3-kill tier, max +3   (streak 3-5 => +1, 6-8 => +2, 9+ => +3)
 *   shutdown            +1..+3, matching the bounty the victim had built up
 *   multi-kill          +1 double / +2 triple / +3 quad+ (within a 4 s window)
 *   suicide / world     -1 to the victim (score floored at 0)
 *   round win (duel)    +1
 */
export const SCORE = {
  kill: 2,
  assist: 1,
  firstBlood: 3,
  suicide: -1,
  roundWin: 1,
  /** Bonus per completed streak tier. */
  streakTier: 1,
  maxStreakBonus: 3,
  maxShutdownBonus: 3,
  /** Index = extra kills in the window (0 = single). */
  multiKill: [0, 1, 2, 3] as const,
} as const;

export const ASSIST_WINDOW = 8.0;
/** Fraction of the victim's max HP an attacker must have dealt to earn an assist. */
export const ASSIST_MIN_FRACTION = 0.1;
export const ASSIST_MAX_PER_KILL = 3;
export const MULTIKILL_WINDOW = 4.0;
export const STREAK_TIER_SIZE = 3;

export const STREAK_TITLES: ReadonlyArray<{ at: number; title: string }> = [
  { at: 3, title: 'RUNNING HOT' },
  { at: 5, title: 'OVERCLOCKED' },
  { at: 7, title: 'CONDUIT ASCENDANT' },
  { at: 10, title: 'VOIDLINE' },
];

const MULTIKILL_TITLES = ['', '', 'DOUBLE BREAK', 'TRIPLE BREAK', 'FRACTURE'];

// ---------------------------------------------------------------- comeback tuning

/** Hard ceiling on the comeback charge bonus. +25% — meaningful, never decisive. */
export const COMEBACK_MAX_BONUS = 0.25;
/** Deficit below this fraction of the score limit earns nothing. (30 -> 3 pts, 50 -> 5 pts) */
export const COMEBACK_DEADBAND_FRAC = 0.1;
/** Deficit at/above this fraction of the score limit earns the full bonus. (30 -> 12, 50 -> 20) */
export const COMEBACK_FULL_FRAC = 0.4;
/** The leader must have this fraction of the limit before comeback engages at all. */
export const COMEBACK_MIN_LEADER_FRAC = 0.2;
/** How fast the applied multiplier eases toward its target, per second. */
export const COMEBACK_RAMP = 0.6;
/** Duel: bonus per round of deficit (1 round down = +12.5%, 2 down = +25%). */
export const COMEBACK_PER_ROUND = 0.125;

// ---------------------------------------------------------------- types

export type ScoreKind = 'ffa' | 'teams' | 'rounds';

export interface ScoreConfig {
  kind: ScoreKind;
  /** Points to win (ffa/teams) or round wins to win (rounds). */
  limit: number;
}

export interface PlayerStats {
  playerId: PlayerId;
  entityId: EntityId;
  name: string;
  role: RoleId;
  team: Team;
  score: number;
  kills: number;
  deaths: number;
  assists: number;
  damageDealt: number;
  damageTaken: number;
  slotsCharged: number;
  revives: number;
  /** Current unbroken kill streak. */
  streak: number;
  bestStreak: number;
  /** Streaks of >=3 that this player ended. */
  shutdowns: number;
  /** Largest multi-kill (2 = double, ...). */
  bestMultiKill: number;
  roundWins: number;
  /** Applied comeback multiplier, 1.0 .. 1 + COMEBACK_MAX_BONUS. Eased, not stepped. */
  comeback: number;
  lastKillAt: number;
  killsInWindow: number;
}

export interface KillReport {
  killerId: PlayerId | null;
  victimId: PlayerId;
  assistIds: PlayerId[];
  /** Points awarded to the killer for this kill (0 in duel/rounds scoring). */
  points: number;
  firstBlood: boolean;
  /** The killer's streak after this kill. */
  streak: number;
  streakTitle: string | null;
  /** The victim's streak that was broken (0 if they were not on one). */
  shutdownOf: number;
  /** 2 = double kill, 3 = triple, ... 0 if not a multi. */
  multiKill: number;
  /** Announcer lines, most important first. Already fully formatted. */
  announcements: string[];
}

interface DamageEntry {
  by: PlayerId;
  amount: number;
  at: number;
}

// ---------------------------------------------------------------- keeper

export class ScoreKeeper {
  private config: ScoreConfig;
  private readonly stats = new Map<PlayerId, PlayerStats>();
  /** victim entity id -> recent damage contributions. */
  private readonly ledger = new Map<EntityId, DamageEntry[]>();
  private firstBloodTaken = false;
  /** Event-scan bookkeeping so `slotsCharged`/`revives` are counted exactly once. */
  private lastEventTick = -1;
  private eventCursor = 0;

  constructor(config: ScoreConfig) {
    this.config = config;
  }

  setConfig(config: ScoreConfig): void {
    this.config = config;
  }

  get kind(): ScoreKind {
    return this.config.kind;
  }

  get limit(): number {
    return this.config.limit;
  }

  // -------------------------------------------------------------- roster

  register(p: PlayerEntity, team: Team): PlayerStats {
    const existing = this.stats.get(p.playerId);
    if (existing) {
      existing.entityId = p.id;
      existing.name = p.name;
      existing.role = p.role;
      existing.team = team;
      return existing;
    }
    const s: PlayerStats = {
      playerId: p.playerId,
      entityId: p.id,
      name: p.name,
      role: p.role,
      team,
      score: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
      damageDealt: 0,
      damageTaken: 0,
      slotsCharged: 0,
      revives: 0,
      streak: 0,
      bestStreak: 0,
      shutdowns: 0,
      bestMultiKill: 0,
      roundWins: 0,
      comeback: 1,
      lastKillAt: -Infinity,
      killsInWindow: 0,
    };
    this.stats.set(p.playerId, s);
    return s;
  }

  get(id: PlayerId): PlayerStats | undefined {
    return this.stats.get(id);
  }

  all(): PlayerStats[] {
    return [...this.stats.values()];
  }

  // -------------------------------------------------------------- damage ledger

  /**
   * Book a damage instance. `victim` is required for the assist ledger; `attackerId` is
   * null for world/DoT damage with no player behind it.
   */
  recordDamage(now: number, victim: PlayerEntity, amount: number, attackerId: PlayerId | null): void {
    if (!(amount > 0)) return;
    const vs = this.stats.get(victim.playerId);
    if (vs) vs.damageTaken += amount;

    if (!attackerId || attackerId === victim.playerId) return;
    const as = this.stats.get(attackerId);
    if (as) as.damageDealt += amount;

    let list = this.ledger.get(victim.id);
    if (!list) {
      list = [];
      this.ledger.set(victim.id, list);
    }
    // Prune anything outside the assist window, then merge into the attacker's entry.
    const cutoff = now - ASSIST_WINDOW;
    let write = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.at >= cutoff) list[write++] = e;
    }
    list.length = write;

    const hit = list.find((e) => e.by === attackerId);
    if (hit) {
      hit.amount += amount;
      hit.at = now;
    } else {
      list.push({ by: attackerId, amount, at: now });
    }
  }

  /** Damage dealt to a non-player target (summons etc.) still counts toward damageDealt. */
  recordDamageDealtOnly(attackerId: PlayerId, amount: number): void {
    if (!(amount > 0)) return;
    const as = this.stats.get(attackerId);
    if (as) as.damageDealt += amount;
  }

  clearLedger(victimEntityId: EntityId): void {
    this.ledger.delete(victimEntityId);
  }

  resetLedgers(): void {
    this.ledger.clear();
  }

  // -------------------------------------------------------------- kills

  /**
   * Apply a kill. Returns everything the mode needs for announcements.
   * In `rounds` (duel) scoring, kills award no points — round wins do.
   */
  recordKill(now: number, victim: PlayerEntity, killer: PlayerEntity | null): KillReport {
    const vs = this.stats.get(victim.playerId);
    const ks = killer ? this.stats.get(killer.playerId) ?? null : null;
    const scoring = this.config.kind !== 'rounds';
    const announcements: string[] = [];

    const victimStreak = vs ? vs.streak : 0;
    if (vs) {
      vs.deaths += 1;
      vs.streak = 0;
      vs.killsInWindow = 0;
    }

    // ---- assists: top contributors inside the window, excluding the killer
    const assistIds: PlayerId[] = [];
    const entries = this.ledger.get(victim.id) ?? [];
    const minDamage = Math.max(1, victim.maxHp * ASSIST_MIN_FRACTION);
    const eligible = entries
      .filter(
        (e) =>
          now - e.at <= ASSIST_WINDOW &&
          e.amount >= minDamage &&
          e.by !== victim.playerId &&
          (!ks || e.by !== ks.playerId),
      )
      .sort((a, b) => b.amount - a.amount)
      .slice(0, ASSIST_MAX_PER_KILL);
    for (const e of eligible) {
      const as = this.stats.get(e.by);
      if (!as) continue;
      as.assists += 1;
      if (scoring) as.score += SCORE.assist;
      assistIds.push(e.by);
    }
    this.ledger.delete(victim.id);

    if (!ks) {
      // Suicide / world kill. Small self-penalty so it is never a free reposition.
      if (vs && scoring) vs.score = Math.max(0, vs.score + SCORE.suicide);
      announcements.push(`${victim.name} FLATLINED`);
      return {
        killerId: null,
        victimId: victim.playerId,
        assistIds,
        points: 0,
        firstBlood: false,
        streak: 0,
        streakTitle: null,
        shutdownOf: 0,
        multiKill: 0,
        announcements,
      };
    }

    // ---- the kill itself
    ks.kills += 1;
    ks.streak += 1;
    if (ks.streak > ks.bestStreak) ks.bestStreak = ks.streak;

    let points: number = SCORE.kill;

    const firstBlood = !this.firstBloodTaken;
    if (firstBlood) {
      this.firstBloodTaken = true;
      points += SCORE.firstBlood;
      announcements.push(`FIRST BLOOD — ${ks.name}`);
    }

    // ---- escalating killstreak value
    const streakBonus = clamp(Math.floor(ks.streak / STREAK_TIER_SIZE) * SCORE.streakTier, 0, SCORE.maxStreakBonus);
    points += streakBonus;
    let streakTitle: string | null = null;
    for (const t of STREAK_TITLES) {
      if (ks.streak === t.at) streakTitle = t.title;
    }
    if (streakTitle) announcements.push(`${ks.name} — ${streakTitle} (${ks.streak})`);

    // ---- shutdown: cashing in someone else's bounty
    let shutdownOf = 0;
    if (victimStreak >= STREAK_TIER_SIZE) {
      shutdownOf = victimStreak;
      const bonus = clamp(Math.floor(victimStreak / STREAK_TIER_SIZE), 1, SCORE.maxShutdownBonus);
      points += bonus;
      ks.shutdowns += 1;
      announcements.push(`SHUTDOWN — ${ks.name} ended ${victim.name} (${victimStreak})`);
    }

    // ---- multi-kill
    let multiKill = 0;
    if (now - ks.lastKillAt <= MULTIKILL_WINDOW) ks.killsInWindow += 1;
    else ks.killsInWindow = 1;
    ks.lastKillAt = now;
    if (ks.killsInWindow >= 2) {
      multiKill = ks.killsInWindow;
      if (multiKill > ks.bestMultiKill) ks.bestMultiKill = multiKill;
      const idx = Math.min(ks.killsInWindow - 1, SCORE.multiKill.length - 1);
      points += SCORE.multiKill[idx];
      const title = MULTIKILL_TITLES[Math.min(multiKill, MULTIKILL_TITLES.length - 1)];
      announcements.push(`${ks.name} — ${title}`);
    }

    if (scoring) ks.score += points;
    else points = 0;

    return {
      killerId: ks.playerId,
      victimId: victim.playerId,
      assistIds,
      points,
      firstBlood,
      streak: ks.streak,
      streakTitle,
      shutdownOf,
      multiKill,
      announcements,
    };
  }

  /** Duel: award a round. Round wins are the score in `rounds` mode. */
  addRoundWin(id: PlayerId): number {
    const s = this.stats.get(id);
    if (!s) return 0;
    s.roundWins += 1;
    s.score += SCORE.roundWin;
    return s.roundWins;
  }

  /** Duel: streaks and ledgers do not carry across a round boundary. */
  resetRound(): void {
    this.ledger.clear();
    for (const s of this.stats.values()) {
      s.streak = 0;
      s.killsInWindow = 0;
      s.lastKillAt = -Infinity;
    }
  }

  // -------------------------------------------------------------- flex stats

  /**
   * Scan this tick's `GameEvent`s for `slotCharged` / `revive` so the flex stats in
   * `MatchResult.standings` get filled without needing extra sim hooks. Safe to call
   * every tick; each event is counted once.
   */
  consumeEvents(world: WorldState): void {
    if (world.tick !== this.lastEventTick) {
      this.lastEventTick = world.tick;
      this.eventCursor = 0;
    }
    const events: GameEvent[] = world.events;
    if (this.eventCursor > events.length) this.eventCursor = 0;
    for (let i = this.eventCursor; i < events.length; i++) {
      const e = events[i];
      if (e.t === 'slotCharged') {
        const s = this.stats.get(e.player);
        if (s) s.slotsCharged += 1;
      } else if (e.t === 'revive') {
        const s = this.stats.get(e.by);
        if (s) s.revives += 1;
      }
    }
    this.eventCursor = events.length;
  }

  // -------------------------------------------------------------- comeback

  /**
   * Ease every player's comeback multiplier toward its target. Call once per tick.
   * Easing (rather than snapping) keeps the Weave from visibly stuttering the moment
   * someone scores.
   */
  tick(dt: number): void {
    for (const s of this.stats.values()) {
      const target = 1 + this.comebackBonus(s);
      const step = COMEBACK_RAMP * dt;
      if (Math.abs(target - s.comeback) <= step) s.comeback = target;
      else s.comeback += Math.sign(target - s.comeback) * step;
    }
  }

  /**
   * The multiplier to fold into `updateCharge(board, dt, chargeRateMul, costs)`.
   * Range 1.00 .. 1.25. Multiply it with the role's own `chargeRateMul`.
   */
  chargeRateMulFor(id: PlayerId): number {
    return this.stats.get(id)?.comeback ?? 1;
  }

  /** Raw (un-eased) bonus in 0 .. COMEBACK_MAX_BONUS. Exposed for tests/telemetry. */
  comebackBonus(s: PlayerStats): number {
    if (this.config.kind === 'rounds') {
      let leadRounds = 0;
      for (const o of this.stats.values()) {
        if (o.playerId === s.playerId) continue;
        if (o.roundWins > leadRounds) leadRounds = o.roundWins;
      }
      const deficit = leadRounds - s.roundWins;
      if (deficit <= 0) return 0;
      return Math.min(COMEBACK_MAX_BONUS, deficit * COMEBACK_PER_ROUND);
    }

    const limit = Math.max(1, this.config.limit);
    let mine: number;
    let leader: number;
    if (this.config.kind === 'teams') {
      const ts = this.teamTotals();
      mine = ts[s.team === 'b' ? 'b' : 'a'] ?? 0;
      leader = Math.max(ts.a ?? 0, ts.b ?? 0);
    } else {
      mine = s.score;
      leader = 0;
      for (const o of this.stats.values()) if (o.score > leader) leader = o.score;
    }

    if (leader < limit * COMEBACK_MIN_LEADER_FRAC) return 0;
    const deficit = leader - mine;
    const dead = limit * COMEBACK_DEADBAND_FRAC;
    const full = limit * COMEBACK_FULL_FRAC;
    if (deficit <= dead || full <= dead) return 0;
    return COMEBACK_MAX_BONUS * clamp((deficit - dead) / (full - dead), 0, 1);
  }

  // -------------------------------------------------------------- readouts

  teamTotals(): Record<'a' | 'b', number> {
    const out: Record<'a' | 'b', number> = { a: 0, b: 0 };
    for (const s of this.stats.values()) {
      if (s.team === 'a') out.a += s.score;
      else if (s.team === 'b') out.b += s.score;
    }
    return out;
  }

  /**
   * What goes into `ObjectiveState.teamScores`.
   * - teams  -> { a, b }
   * - rounds -> { a, b } round wins
   * - ffa    -> { [playerId]: score }  (client resolves ids to names via the entity list)
   */
  objectiveScores(): Record<string, number> {
    if (this.config.kind === 'teams') return this.teamTotals();
    if (this.config.kind === 'rounds') {
      const out: Record<string, number> = { a: 0, b: 0 };
      for (const s of this.stats.values()) {
        if (s.team === 'a') out.a = s.roundWins;
        else if (s.team === 'b') out.b = s.roundWins;
      }
      return out;
    }
    const out: Record<string, number> = {};
    for (const s of this.stats.values()) out[s.playerId] = s.score;
    return out;
  }

  /** Highest individual score (or round wins in duel). */
  leader(): PlayerStats | null {
    let best: PlayerStats | null = null;
    for (const s of this.stats.values()) {
      if (!best || this.rank(s) > this.rank(best)) best = s;
    }
    return best;
  }

  /** Best score currently on the board, in the unit that wins the match. */
  topProgress(): number {
    if (this.config.kind === 'teams') {
      const t = this.teamTotals();
      return Math.max(t.a, t.b);
    }
    const l = this.leader();
    if (!l) return 0;
    return this.config.kind === 'rounds' ? l.roundWins : l.score;
  }

  private rank(s: PlayerStats): number {
    const primary = this.config.kind === 'rounds' ? s.roundWins : s.score;
    return primary * 1e6 + s.kills * 1e3 - s.deaths;
  }

  /** Fully populated `MatchResult.standings`, ordered by score desc. */
  standings(): MatchResult['standings'] {
    return this.all()
      .slice()
      .sort((a, b) => this.rank(b) - this.rank(a))
      .map((s) => ({
        playerId: s.playerId,
        name: s.name,
        role: s.role,
        score: s.score,
        kills: s.kills,
        deaths: s.deaths,
        damageDealt: Math.round(s.damageDealt),
        damageTaken: Math.round(s.damageTaken),
        slotsCharged: s.slotsCharged,
        revives: s.revives,
      }));
  }
}
