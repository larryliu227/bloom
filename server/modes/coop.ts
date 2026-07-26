/**
 * VOIDLINE — co-op story mode handler.
 *
 * Drives one chapter's beat sequence: waves via the director, cross-player relay
 * seals, the defend objective, bosses, the downed/revive flow, and the dialogue
 * queue. Everything the HUD shows comes out of `ObjectiveState`.
 *
 * Implements `ModeHandler` from `server/modes/index.ts` (owner: agent D).
 */

import type { ModeHandler, ModeHandlerExtras } from './index.js';
import type { Room } from '../room.js';
import type { SimContext } from '@shared/sim.js';
import { respawnPlayer } from '@shared/sim.js';
import type { MatchResult } from '@shared/protocol.js';
import type {
  EnemyEntity,
  Entity,
  EntityId,
  GameMode,
  PlayerEntity,
  PlayerId,
  Vec2,
  WeaveBoard,
  WeaveTile,
} from '@shared/types.js';
import { linkRelays, placeRelay, recomputePower } from '@shared/weave.js';
import { clamp, v } from '@shared/math.js';
import { ARENA_H, ARENA_W, MAX_PLAYERS_COOP } from '@shared/constants.js';
import { ENEMIES, EnemySystem } from '../systems/enemies.js';
import { Director } from '../systems/director.js';
import {
  countWaves,
  getChapter,
  isCountedBeat,
  type Beat,
  type ChapterDef,
} from '../content/chapters.js';
import { TutorialRun, tutorialSteps, type TutorialHost } from '../content/tutorial.js';

// ---------------------------------------------------------------- co-op tuning

/** HP fraction a revived runner comes back with. */
export const REVIVE_HP_FRAC = 0.5;
/** Each extra reviver past the first adds this much speed. */
export const REVIVE_ASSIST = 0.6;
/** Reviving stops if the reviver is interrupted; progress bleeds off at this rate. */
export const REVIVE_DECAY = 0.5;
/** Grace period with everyone down before the run is called. */
export const WIPE_GRACE = 1.25;
/** A standalone relay seal burns open after this many failed attempts. */
export const RELAY_MAX_ATTEMPTS = 2;
/** Share of a wave that beelines the defend objective instead of the runners. */
export const DEFEND_PRIORITY_SHARE = 0.3;
/** Standing this close to the coolant shunt counts as defending it. */
export const SHUNT_GUARD_RADIUS = 280;
/** Damage the shunt shrugs off per nearby runner, and the ceiling on that. */
export const SHUNT_GUARD_PER = 0.26;
export const SHUNT_GUARD_MAX = 0.62;
/** Score awards. */
export const SCORE_KILL = 10;
export const SCORE_ELITE = 60;
export const SCORE_BOSS = 400;
export const SCORE_REVIVE = 60;
export const SCORE_WAVE = 35;
export const SCORE_RELAY = 120;
/** Enemy scalars. Body count scales with players; per-body stats scale with chapter. */
export function enemyHpMulFor(chapter: number): number {
  return 1 + 0.05 * (clamp(chapter, 1, 5) - 1);
}
export function enemyDamageMulFor(chapter: number): number {
  return 0.85 + 0.05 * clamp(chapter, 1, 5);
}
/** Bosses are single bodies, so they scale on head count instead. */
export function bossHpMulFor(chapter: number, players: number): number {
  return (0.62 + 0.38 * clamp(players, 1, MAX_PLAYERS_COOP)) * enemyHpMulFor(chapter);
}

// ---------------------------------------------------------------- internals

interface Stat {
  damageDealt: number;
  damageTaken: number;
  slotsCharged: number;
  revives: number;
}

interface DialogueLine {
  speaker: string;
  text: string;
  ms: number;
}

/** Everything `placeRelay` overwrites, so a seal can be undone exactly. */
interface SavedTile {
  board: WeaveBoard;
  index: number;
  kind: WeaveTile['kind'];
  base: number;
  rotation: number;
  locked: boolean;
}

function restoreTile(s: SavedTile): void {
  const t = s.board.tiles[s.index];
  if (!t) return;
  t.kind = s.kind;
  t.base = s.base;
  t.rotation = s.rotation;
  t.locked = s.locked;
}

interface RelayRun {
  label: string;
  required: number;
  hold: number;
  timeout: number;
  elapsed: number;
  charge: number;
  /** Boards taking part, and the tiles we converted into relays. */
  boards: WeaveBoard[];
  saved: SavedTile[];
  indices: number[];
  /** Non-null when the Choirmaster forced this. */
  bossId: EntityId | null;
  announced: boolean;
  /** Failed attempts so far. A standalone seal burns through after RELAY_MAX_ATTEMPTS. */
  attempts: number;
}

type BeatPhase =
  | 'idle'
  | 'wait'
  | 'waitDialogue'
  | 'tutorial'
  | 'wave'
  | 'script'
  | 'sustain'
  | 'defend'
  | 'relay'
  | 'boss'
  | 'done';

class CoopHandler implements ModeHandler, ModeHandlerExtras {
  readonly mode: GameMode = 'coop_story';

  private ch: ChapterDef;
  private enemies = new EnemySystem();
  private director: Director;

  private beatIndex = -1;
  private phase: BeatPhase = 'idle';
  private beatTimer = 0;
  private beatGrace = 0;

  private label = '';
  private progress = -1;
  private waveNumber = 0;
  private totalWaves = 0;

  private dialogueQueue: DialogueLine[] = [];
  private current: DialogueLine | null = null;
  private currentLeft = 0;

  private relay: RelayRun | null = null;
  /** Non-null only while the chapter's `tutorial` beat is open. */
  private tutorial: TutorialRun | null = null;
  private core: EnemyEntity | null = null;
  private coreHp = 0;
  private hazards: EntityId[] = [];

  private bossId: EntityId | null = null;
  private bossDead = false;
  private bossName = '';

  private stats = new Map<PlayerId, Stat>();
  /** Last tick's `respawnTimer` per player, for edge detection on bleed-out. */
  private respawning = new Map<PlayerId, number>();
  /** Players whose board this mode mutated; drained by the room each tick. */
  private boardDirty = new Set<PlayerId>();
  private elapsed = 0;
  private wipeTimer = 0;
  private result: 'none' | 'cleared' | 'wiped' | 'failed' = 'none';
  private taughtBoardDamage = false;

  constructor(chapter: number) {
    this.ch = getChapter(chapter);
    this.totalWaves = countWaves(this.ch);
    this.director = new Director(this.enemies, this.ch.director);
  }

  // ============================================================ lifecycle

  onMatchStart(room: Room, ctx: SimContext): void {
    const players = this.enemies.allPlayers(ctx);
    this.enemies.hpMul = enemyHpMulFor(this.ch.id);
    this.enemies.damageMul = enemyDamageMulFor(this.ch.id);
    this.enemies.hooks = {
      onBoardDamaged: (p) => {
        this.markBoards([p]);
        if (this.taughtBoardDamage) return;
        this.taughtBoardDamage = true;
        // The onboarding sequence's re-route step teaches exactly this, in its
        // own words and on its own clock. Do not narrate over it.
        if (this.tutorial) return;
        this.say('VESSEL', 'That cell is gone. It does not come back. Route around it.', 4000);
      },
      onBoardsScrambled: (players) => {
        this.markBoards(players);
        const lines = [
          'let me help you re-route.',
          'it is easier when there is only one board.',
          'stay. it is warm.',
        ];
        const i = clamp(this.enemies.bosses(ctx).length ? this.currentBossPhase(ctx) - 1 : 0, 0, 2);
        this.say('THE FRACTURE', lines[i], 3600);
      },
      onRelayDemand: (boss, seconds) => {
        this.say('VESSEL', 'It has sealed itself. Two of you, route together. Now.', 4000);
        this.startRelay(ctx, 'RELAY SEAL — break the Choirmaster', 2, 12, seconds, boss.id);
      },
      onBossPhase: (boss, phase) => {
        if (boss.archetype === 'choirmaster') {
          if (phase === 1) this.say('THE CHOIR', 'louder.', 2400);
          if (phase === 2) this.say('THE CHOIR', 'ALL OF US.', 2600);
        }
      },
      onBossDefeated: (boss) => {
        if (this.bossId === boss.id) this.bossDead = true;
      },
      onEnemyLine: (speaker, text, ms) => this.say(speaker, text, ms),
    };

    for (const p of players) {
      this.stats.set(p.playerId, { damageDealt: 0, damageTaken: 0, slotsCharged: 0, revives: 0 });
      p.downed = false;
      p.downedTimer = 0;
      p.reviveProgress = 0;
    }

    this.label = this.ch.name.toUpperCase();
    this.progress = -1;
    this.publish(ctx);
    this.beatIndex = -1;
    this.advance(ctx);
  }

  onTick(room: Room, ctx: SimContext, dt: number): void {
    if (this.result !== 'none') return;
    this.elapsed += dt;

    this.collectEvents(ctx);
    this.updateDowned(room, ctx, dt);
    if (this.result !== 'none') {
      // A group that wiped mid-lesson does not get the closing line.
      if (this.tutorial) {
        this.tutorial.abort(this.tutorialHost(ctx));
        this.tutorial = null;
      }
      return;
    }

    this.updateDialogue(ctx, dt);
    this.updateRelay(ctx, dt);
    this.updateBeat(ctx, dt);
    this.director.update(ctx, dt);
    this.enemies.update(ctx, dt);
    this.publish(ctx);
  }

  onDamage(ctx: SimContext, target: Entity, amount: number, source: Entity | null): void {
    /*
     * Standing on the objective is the objective. Without this the defend beat
     * degrades into a pure DPS race that a group can lose while never being
     * anywhere near the thing they are defending. Each nearby runner shrugs off
     * a share of the incoming damage; `applyDamage` calls this hook after it has
     * already subtracted, and before it checks for death, so refunding here is
     * both safe and ordering-independent.
     */
    if (this.core && target === (this.core as Entity) && amount > 0) {
      let guards = 0;
      for (const p of this.enemies.livingPlayers(ctx)) {
        if (v.dist(p.pos, target.pos) <= SHUNT_GUARD_RADIUS) guards++;
      }
      if (guards > 0) {
        const reduction = Math.min(SHUNT_GUARD_MAX, SHUNT_GUARD_PER * guards);
        target.hp = Math.min(target.maxHp, target.hp + amount * reduction);
      }
    }

    // Downed runners never reach here — `isTargetable` filters them upstream.
    if (target.kind === 'player') {
      const s = this.stats.get((target as PlayerEntity).playerId);
      if (s) s.damageTaken += Math.max(0, amount);
    }
    if (source && source.kind === 'player' && target.kind !== 'player') {
      const s = this.stats.get((source as PlayerEntity).playerId);
      if (s) s.damageDealt += Math.max(0, amount);
    }
    // A `hit` event carries no source, so the onboarding sequence's "landed a
    // basic" test has to be told here — this is the only place damage and its
    // author are both in scope.
    if (this.tutorial && amount > 0) this.tutorial.noteDamage(source, target);
    this.enemies.onDamage(ctx, target, amount, source);
  }

  onDeath(room: Room, ctx: SimContext, entity: Entity, killer: Entity | null): void {
    if (entity.kind === 'player') {
      // `killEntity` has already put them into the downed state for co-op.
      // All this mode adds is the flavour and the clock.
      const p = entity as PlayerEntity;
      ctx.emit({ t: 'shake', magnitude: 6 });
      if (this.enemies.livingPlayers(ctx).length === 1) {
        this.say('VESSEL', 'One of you is still standing. Only one.', 3000);
      }
      void p;
      return;
    }
    if (entity.kind !== 'enemy') return;

    const e = entity as EnemyEntity;
    const def = ENEMIES[e.archetype];

    // The shunt falling is a hard chapter failure.
    if (e.archetype === 'shunt') {
      if (this.phase === 'defend') {
        this.say('VESSEL', 'Shunt is gone. The shell is going with it.', 4000);
        this.result = 'failed';
      }
      return;
    }

    const real = this.enemies.onDeath(ctx, e, killer);
    if (!real) return;

    if (killer && killer.kind === 'player') {
      const p = killer as PlayerEntity;
      const award = def?.boss ? SCORE_BOSS : e.archetype === 'elite' ? SCORE_ELITE : SCORE_KILL;
      p.score += award;
      p.kills += 1;
    }
    if (e.archetype === 'vent') {
      this.hazards = this.hazards.filter((id) => id !== e.id);
    }
  }

  checkComplete(room: Room, ctx: SimContext): MatchResult | null {
    if (this.result === 'none') return null;
    const cleared = this.result === 'cleared';
    return {
      mode: this.mode,
      winner: cleared ? 'players' : 'hostile',
      standings: this.standings(ctx),
      chapter: this.ch.id,
      chapterCleared: cleared,
      durationSec: Math.round(this.elapsed),
    };
  }

  spawnPoint(room: Room, player: PlayerEntity): Vec2 {
    const pts = this.ch.spawnPoints;
    const order = room.spawnOrderOf(player.playerId);
    const idx = order >= 0 ? order : 0;
    const base = pts[idx % pts.length];
    // Fan out slightly so four bodies do not stack on one tile.
    const a = (idx / MAX_PLAYERS_COOP) * Math.PI * 2;
    return {
      x: clamp(base.x + Math.cos(a) * 26, 60, ARENA_W - 60),
      y: clamp(base.y + Math.sin(a) * 26, 60, ARENA_H - 60),
    };
  }

  // ============================================================ beats

  private advance(ctx: SimContext): void {
    this.phase = 'idle';
    this.beatIndex++;
    if (this.beatIndex >= this.ch.beats.length) {
      this.result = 'cleared';
      return;
    }
    const b = this.ch.beats[this.beatIndex];
    if (isCountedBeat(b)) this.waveNumber++;
    this.startBeat(ctx, b);
    // Instant beats fall straight through to the next one.
    if (this.phase === 'idle') this.advance(ctx);
  }

  private startBeat(ctx: SimContext, b: Beat): void {
    switch (b.t) {
      case 'line':
        this.say(b.speaker, b.text, b.ms ?? 3200);
        return;

      case 'waitDialogue':
        this.phase = 'waitDialogue';
        return;

      case 'wait':
        this.phase = 'wait';
        this.beatTimer = b.seconds;
        return;

      case 'objective':
        this.label = b.label;
        this.progress = -1;
        ctx.emit({ t: 'objective', label: b.label });
        return;

      case 'wave': {
        this.phase = 'wave';
        this.label = b.label ?? `Wave ${this.waveNumber} of ${this.totalWaves}`;
        this.progress = 0;
        this.director.beginWave(ctx, Math.max(0, this.waveNumber - 1), this.livingCount(ctx));
        ctx.emit({ t: 'objective', label: this.label });
        return;
      }

      case 'script': {
        this.phase = 'script';
        this.label = b.label ?? `Wave ${this.waveNumber} of ${this.totalWaves}`;
        this.progress = 0;
        this.director.stop();
        const scale = this.scriptScale(ctx);
        for (const s of b.spawns) {
          const n = Math.max(1, Math.round(s.count * scale));
          this.director.push(s.archetype, n, s.at);
        }
        this.beatGrace = 0;
        ctx.emit({ t: 'objective', label: this.label });
        return;
      }

      case 'hazard': {
        for (const p of b.positions) {
          const e = this.enemies.spawn(ctx, 'vent', p, {});
          this.hazards.push(e.id);
        }
        return;
      }

      case 'clearHazards': {
        for (const en of ctx.world.entities) {
          if (en.kind === 'enemy' && (en as EnemyEntity).archetype === 'vent') {
            en.dead = true;
            en.hp = 0;
          }
        }
        this.hazards = [];
        return;
      }

      case 'relay': {
        this.phase = 'relay';
        this.label = b.label;
        this.progress = 0;
        this.startRelay(ctx, b.label, b.participants, b.hold, b.timeout, null);
        if (b.live && b.live > 0) {
          this.director.beginSustain(ctx, this.livingCount(ctx), b.live, b.intensity ?? 1);
        }
        ctx.emit({ t: 'objective', label: this.label });
        return;
      }

      case 'defend': {
        this.phase = 'defend';
        this.label = b.label;
        this.beatTimer = b.seconds;
        this.progress = 0;
        /*
         * Shunt HP by head count — and deliberately NOT the old
         * `0.7 + 0.3 * n`, which was upside down at the bottom end.
         *
         * Incoming scales with `playerScale`: 1.00 for a solo runner, 2.20 for
         * four. Damage output scales with bodies, so it roughly quadruples. A
         * solo runner therefore eats a little under half the raw pressure of a
         * four-stack while bringing a quarter of the guns — the worst per-capita
         * deal in the game — and this beat is the only hard *fail* in the
         * campaign. Under the old curve their shunt was also the frailest one
         * (x1.0 against a four-stack's x1.9). Measured: a solo runner sustaining
         * basics-only damage (~12 dps, which is what `BASIC_ATTACK_COOLDOWN` and
         * a 4-damage basic actually buy) lost the shunt at 2:27 every time.
         *
         * Three and four runners keep their verified values exactly — x1.8 and
         * x1.9 — and only the under-gunned small groups get the headroom.
         */
        const hp = b.hp * (1.6 + 0.1 * (clamp(this.livingCount(ctx), 1, 4) - 1));
        this.core = this.enemies.spawn(ctx, 'shunt', b.at, { hp, team: 'players' });
        this.coreHp = hp;
        this.enemies.priority = this.core;
        this.enemies.priorityShare = DEFEND_PRIORITY_SHARE;
        this.director.beginSustain(ctx, this.livingCount(ctx), b.live, b.intensity);
        ctx.emit({ t: 'objective', label: this.label });
        ctx.emit({ t: 'shake', magnitude: 5 });
        return;
      }

      case 'sustain': {
        this.phase = 'sustain';
        this.label = b.label;
        this.beatTimer = b.seconds;
        this.progress = 0;
        this.director.beginSustain(ctx, this.livingCount(ctx), b.live, b.intensity);
        ctx.emit({ t: 'objective', label: this.label });
        return;
      }

      case 'boss': {
        this.phase = 'boss';
        this.label = b.label;
        this.progress = 1;
        this.director.stop();
        this.enemies.clearHostiles(ctx);
        const def = ENEMIES[b.archetype];
        const players = this.livingCount(ctx);
        const hp = (def?.hp ?? 2000) * bossHpMulFor(this.ch.id, players);
        const at = b.at ?? { x: ARENA_W / 2, y: 260 };
        const boss = this.enemies.spawn(ctx, b.archetype, at, { hp });
        this.bossId = boss.id;
        this.bossDead = false;
        this.bossName = b.label;
        ctx.emit({ t: 'objective', label: b.label });
        ctx.emit({ t: 'shake', magnitude: 12 });
        ctx.emit({ t: 'sfx', name: 'boss_intro' });
        return;
      }

      case 'tutorial': {
        const steps = tutorialSteps(this.ch.id);
        // Untutorialised chapter: stay 'idle' so `advance` falls straight through.
        if (!steps || steps.length === 0) return;
        this.director.stop();
        this.enemies.clearHostiles(ctx);
        const run = new TutorialRun(steps);
        this.tutorial = run;
        this.phase = 'tutorial';
        run.begin(this.tutorialHost(ctx), this.enemies.allPlayers(ctx));
        this.label = run.objectiveLabel;
        this.progress = run.progress;
        if (run.finished) {
          this.tutorial = null;
          this.phase = 'idle';
        }
        return;
      }

      case 'recover': {
        // Act break: everybody stands up, nobody is fully topped off.
        for (const p of this.enemies.allPlayers(ctx)) {
          if (p.downed || p.respawnTimer > 0 || p.hp <= 0) {
            respawnPlayer(ctx, p, null);
            this.respawning.set(p.playerId, 0);
          }
          p.hp = Math.max(Math.min(p.hp, p.maxHp), p.maxHp * b.frac);
        }
        ctx.emit({ t: 'sfx', name: 'lattice_recover' });
        return;
      }

      case 'complete': {
        this.label = b.label;
        this.progress = 1;
        this.phase = 'done';
        this.beatTimer = 2.5;
        ctx.emit({ t: 'objective', label: b.label });
        return;
      }
    }
  }

  private updateBeat(ctx: SimContext, dt: number): void {
    switch (this.phase) {
      case 'idle':
        return;

      case 'wait':
        this.beatTimer -= dt;
        if (this.beatTimer <= 0) this.advance(ctx);
        return;

      case 'waitDialogue':
        if (!this.current && this.dialogueQueue.length === 0) this.advance(ctx);
        return;

      case 'tutorial': {
        const run = this.tutorial;
        if (!run) {
          this.advance(ctx);
          return;
        }
        const over = run.update(
          this.tutorialHost(ctx),
          this.enemies.allPlayers(ctx),
          ctx.world.events,
          this.enemies.liveCombatants(ctx).length,
          dt,
        );
        if (run.objectiveLabel) this.label = run.objectiveLabel;
        this.progress = run.progress;
        if (over) {
          this.tutorial = null;
          this.director.stop();
          this.advance(ctx);
        }
        return;
      }

      case 'wave':
        this.progress = this.director.waveProgress(ctx);
        if (this.director.waveCleared(ctx) && this.director.restRemaining <= 0) {
          this.awardWave(ctx);
          this.advance(ctx);
        }
        return;

      case 'script':
        this.progress = this.director.waveProgress(ctx);
        if (this.director.pending === 0 && this.enemies.liveCombatants(ctx).length === 0) {
          this.beatGrace += dt;
          if (this.beatGrace > 3.5) {
            this.awardWave(ctx);
            this.advance(ctx);
          }
        } else {
          this.beatGrace = 0;
        }
        return;

      case 'sustain': {
        this.beatTimer -= dt;
        const b = this.ch.beats[this.beatIndex];
        const total = b && b.t === 'sustain' ? b.seconds : 1;
        this.progress = clamp(1 - this.beatTimer / total, 0, 1);
        if (this.beatTimer <= 0) {
          this.director.stop();
          this.awardWave(ctx);
          this.advance(ctx);
        }
        return;
      }

      case 'defend': {
        this.beatTimer -= dt;
        const b = this.ch.beats[this.beatIndex];
        const total = b && b.t === 'defend' ? b.seconds : 1;
        this.progress = clamp(1 - this.beatTimer / total, 0, 1);
        const core = this.core;
        if (core && (core.dead || core.hp <= 0)) {
          this.say('VESSEL', 'Shunt is gone. The shell is going with it.', 4000);
          this.result = 'failed';
          return;
        }
        if (core && core.hp < core.maxHp * 0.25 && ctx.world.tick % 100 === 0) {
          this.say('VESSEL', 'Shunt is failing. Pull them off it.', 2600);
        }
        if (this.beatTimer <= 0) {
          this.director.stop();
          this.enemies.priority = null;
          this.enemies.priorityShare = 0;
          if (core) {
            core.dead = true;
            core.hp = 0;
          }
          this.core = null;
          this.awardWave(ctx);
          this.advance(ctx);
        }
        return;
      }

      case 'relay':
        if (!this.relay) {
          this.director.stop();
          this.advance(ctx);
        } else {
          this.progress = clamp(this.relay.charge / this.relay.hold, 0, 1);
        }
        return;

      case 'boss': {
        const boss = this.bossEntity(ctx);
        if (boss) {
          this.progress = clamp(boss.hp / Math.max(1, boss.maxHp), 0, 1);
          this.label = this.relay ? this.relay.label : this.bossName;
        }
        if (this.bossDead || (!boss && this.bossId !== null)) {
          this.finishRelay(ctx, false);
          this.director.stop();
          this.enemies.clearHostiles(ctx);
          this.bossId = null;
          for (const p of this.enemies.allPlayers(ctx)) p.score += SCORE_BOSS / 2;
          this.advance(ctx);
        }
        return;
      }

      case 'done':
        this.beatTimer -= dt;
        if (this.beatTimer <= 0) this.result = 'cleared';
        return;
    }
  }

  /**
   * The four verbs the onboarding sequence is allowed.
   *
   * Teaching spawns borrow the director's rim placement — bodies still arrive
   * away from the group — but are placed directly rather than queued. The
   * director's queue only drains from `idle`/`rest`/`spawning`, so a step that
   * pushed while a previous step's bodies were still alive (state `holding`)
   * left its lesson sitting in the queue until `beginWave` threw it away: the
   * Unraveller the re-route step is *about* never actually arrived. Head-count
   * scaling already happened in `tutorial.ts`, which is where the content
   * decides what should scale.
   */
  private tutorialHost(ctx: SimContext): TutorialHost {
    return {
      say: (speaker, text, ms) => this.say(speaker, text, ms),
      objective: (label) => {
        this.label = label;
        ctx.emit({ t: 'objective', label });
      },
      spawn: (archetype, count) => {
        const players = this.enemies.livingPlayers(ctx);
        const n = Math.max(1, count);
        for (let i = 0; i < n; i++) {
          this.enemies.spawn(ctx, archetype, this.director.pickSpawn(ctx, players), {});
        }
      },
      clearFloor: () => {
        this.director.stop();
        this.enemies.clearHostiles(ctx);
      },
    };
  }

  private awardWave(ctx: SimContext): void {
    for (const p of this.enemies.allPlayers(ctx)) p.score += SCORE_WAVE;
  }

  /** Scripted set-pieces still need to respect head count. */
  private scriptScale(ctx: SimContext): number {
    const n = this.livingCount(ctx);
    return 0.55 + 0.15 * clamp(n, 1, 4);
  }

  private livingCount(ctx: SimContext): number {
    const live = this.enemies.livingPlayers(ctx).length;
    if (live > 0) return clamp(live, 1, MAX_PLAYERS_COOP);
    const any = this.enemies.allPlayers(ctx).filter((p) => p.connected !== false).length;
    return clamp(any || 1, 1, MAX_PLAYERS_COOP);
  }

  private bossEntity(ctx: SimContext): EnemyEntity | null {
    if (this.bossId === null) return null;
    for (const en of ctx.world.entities) {
      if (en.id === this.bossId && en.kind === 'enemy' && !en.dead) return en as EnemyEntity;
    }
    return null;
  }

  private currentBossPhase(ctx: SimContext): number {
    const b = this.bossEntity(ctx);
    return b ? this.enemies.bossPhase(b) : 0;
  }

  // ============================================================ relay seals

  /**
   * Converts one tile on each participant's board into a `relay`, links the
   * boards, and waits for everyone to hold power through it simultaneously.
   */
  private startRelay(
    ctx: SimContext,
    label: string,
    participants: number,
    hold: number,
    timeout: number,
    bossId: EntityId | null,
  ): void {
    this.finishRelay(ctx, false);

    const players = this.enemies.livingPlayers(ctx);
    const pool = players.length > 0 ? players : this.enemies.allPlayers(ctx);
    const required = clamp(Math.min(participants, pool.length), 1, MAX_PLAYERS_COOP);
    const boards = pool.map((p) => p.weave).filter((b): b is WeaveBoard => !!b && !!b.tiles);
    if (boards.length === 0) return;

    const saved: RelayRun['saved'] = [];
    const indices: number[] = [];
    for (const idx of this.pickRelayIndices(boards)) {
      // Snapshot before `placeRelay` rewrites kind/base/rotation/locked.
      const undo: RelayRun['saved'] = [];
      let ok = true;
      for (const board of boards) {
        const tile = board.tiles[idx];
        if (!tile) {
          ok = false;
          break;
        }
        undo.push({
          board,
          index: idx,
          kind: tile.kind,
          base: tile.base,
          rotation: tile.rotation,
          locked: tile.locked,
        });
        if (!placeRelay(board, idx)) ok = false;
      }
      if (!ok) {
        for (const s of undo) restoreTile(s);
        continue;
      }
      saved.push(...undo);
      indices.push(idx);
    }
    if (indices.length === 0) {
      this.say('VESSEL', 'No spare conduit for a seal. Improvising. Hold the floor.', 3600);
    }
    linkRelays(boards);
    this.markBoards(pool);

    this.relay = {
      label,
      required,
      hold,
      timeout,
      elapsed: 0,
      charge: 0,
      boards,
      saved,
      indices,
      bossId,
      announced: false,
      attempts: 0,
    };
    ctx.emit({ t: 'sfx', name: 'relay_open' });
    for (const p of pool) ctx.emit({ t: 'weavePower', player: p.playerId, connected: false, slot: -1 });
  }

  /**
   * Choose cell indices that are legal to convert on *every* participating board.
   * Boards differ in size per role, so we only consider indices inside the
   * smallest one and skip cores, slots, locked and already-dead cells.
   */
  private pickRelayIndices(boards: WeaveBoard[]): number[] {
    let minLen = Infinity;
    for (const b of boards) minLen = Math.min(minLen, b.tiles.length);
    if (!isFinite(minLen)) return [];

    const ok: number[] = [];
    for (let i = 0; i < minLen; i++) {
      let usable = true;
      for (const b of boards) {
        const t = b.tiles[i];
        if (!t || t.locked || i === b.coreIndex) {
          usable = false;
          break;
        }
        if (t.kind !== 'straight' && t.kind !== 'elbow' && t.kind !== 'tee' && t.kind !== 'cross') {
          usable = false;
          break;
        }
      }
      if (usable) ok.push(i);
    }
    if (ok.length === 0) return [];
    // Prefer cells nearer the middle of the smallest board: reachable, but a real route.
    const size = Math.round(Math.sqrt(minLen));
    const c = (size - 1) / 2;
    ok.sort((a, b) => {
      const da = Math.abs((a % size) - c) + Math.abs(Math.floor(a / size) - c);
      const db = Math.abs((b % size) - c) + Math.abs(Math.floor(b / size) - c);
      return Math.abs(da - 2) - Math.abs(db - 2);
    });
    return ok.slice(0, Math.min(2, ok.length));
  }

  private updateRelay(ctx: SimContext, dt: number): void {
    const r = this.relay;
    if (!r) return;
    r.elapsed += dt;

    /*
     * Credit must be individual. `linkRelays` deliberately MIRRORS power: once
     * any runner lights a relay index, that index is seeded as powered on every
     * linked board, so reading `tile.powered` after a link would score one
     * person's route as everybody's.
     *
     * So: flood each board from its own core only (`recomputePower`, no seeds)
     * and snapshot who genuinely reached the relay. Only then re-link, which
     * restores the shared state the clients get to see and which is what makes
     * the seal feel like one circuit spanning two people.
     */
    let ready = 0;
    for (const board of r.boards) {
      recomputePower(board);
      let live = false;
      for (const idx of r.indices) {
        const t = board.tiles[idx];
        if (t && t.kind === 'relay' && t.powered) {
          live = true;
          break;
        }
      }
      if (live) ready++;
    }
    linkRelays(r.boards);

    if (ready >= r.required) {
      r.charge = Math.min(r.hold, r.charge + dt);
      if (!r.announced && r.charge > 0.4) {
        r.announced = true;
        ctx.emit({ t: 'sfx', name: 'relay_lock' });
      }
    } else {
      r.charge = Math.max(0, r.charge - dt * 0.45);
      r.announced = false;
    }

    if (r.charge >= r.hold) {
      this.onRelaySolved(ctx, r);
      return;
    }
    if (r.elapsed >= r.timeout) {
      this.onRelayFailed(ctx, r);
    }
  }

  private onRelaySolved(ctx: SimContext, r: RelayRun): void {
    ctx.emit({ t: 'sfx', name: 'relay_solved' });
    ctx.emit({ t: 'shake', magnitude: 7 });
    for (const p of this.enemies.allPlayers(ctx)) p.score += SCORE_RELAY;
    if (r.bossId !== null) this.enemies.resolveRelay(r.bossId, true);
    this.finishRelay(ctx, true);
    if (this.phase === 'relay') {
      this.director.stop();
      this.advance(ctx);
    }
  }

  private onRelayFailed(ctx: SimContext, r: RelayRun): void {
    ctx.emit({ t: 'sfx', name: 'relay_failed' });
    if (r.bossId !== null) {
      this.enemies.resolveRelay(r.bossId, false);
      this.finishRelay(ctx, true);
      return;
    }
    // Standalone seals never end the run — they punish and re-arm. But they must
    // not be able to stall a campaign forever either, so after a few honest
    // attempts VESSEL forces the door and charges the group for it.
    r.attempts += 1;
    for (const p of this.enemies.livingPlayers(ctx)) {
      p.hp = Math.max(1, p.hp - p.maxHp * 0.2);
    }
    if (r.attempts >= RELAY_MAX_ATTEMPTS) {
      this.say('VESSEL', 'Enough. I will burn the seal myself. It will cost me.', 4200);
      ctx.emit({ t: 'shake', magnitude: 9 });
      this.finishRelay(ctx, true);
      if (this.phase === 'relay') {
        this.director.stop();
        this.advance(ctx);
      }
      return;
    }
    this.say('VESSEL', 'Circuit collapsed. Again. Together this time.', 3400);
    r.elapsed = 0;
    r.charge = 0;
  }

  /** Restores converted tiles. `unlink` re-runs linkRelays so boards stop sharing. */
  private finishRelay(ctx: SimContext, unlink: boolean): void {
    const r = this.relay;
    if (!r) return;
    for (const s of r.saved) restoreTile(s);
    // No relay tiles left, so linkRelays degrades to a plain per-board recompute.
    for (const board of r.boards) recomputePower(board);
    if (unlink) linkRelays(r.boards);
    for (const p of this.enemies.allPlayers(ctx)) {
      if (p.weave && r.boards.includes(p.weave)) this.boardDirty.add(p.playerId);
    }
    this.relay = null;
  }

  // ============================================================ downed / revive

  /**
   * The down / revive / bleed-out machinery lives in `shared/sim.ts`
   * (`killEntity` downs a co-op player, `stepDownsAndRespawns` runs the Interact
   * revive and the bleed-out timer). This mode only layers the campaign meaning
   * on top: credit the reviver, place bled-out runners somewhere survivable, and
   * decide when a full team down is the end of the run.
   */
  private updateDowned(room: Room, ctx: SimContext, dt: number): void {
    const all = this.enemies.allPlayers(ctx);
    const connected = all.filter((p) => p.connected !== false);
    if (connected.length === 0) {
      this.wipeTimer = 0;
      return;
    }

    for (const p of all) {
      const prev = this.respawning.get(p.playerId) ?? 0;
      // Bled out this tick: the sim has just started their respawn countdown.
      if (prev <= 0 && p.respawnTimer > 0) {
        this.say('VESSEL', `${p.name} is off the lattice. I am pulling them back.`, 3200);
      }
      // Countdown just finished: the sim revived them in place, which may be
      // inside whatever killed them. Put them somewhere they can stand up.
      if (prev > 0 && p.respawnTimer <= 0 && !p.downed) {
        respawnPlayer(ctx, p, this.safeSpawn(room, ctx, p));
      }
      this.respawning.set(p.playerId, p.respawnTimer);
    }

    // Wipe: every connected runner simultaneously down or waiting to come back.
    const anyUp = connected.some((p) => !p.downed && p.respawnTimer <= 0 && p.hp > 0);
    if (!anyUp) {
      this.wipeTimer += dt;
      if (this.wipeTimer >= WIPE_GRACE) {
        this.say('VESSEL', 'The lattice has lost all of you. I am sorry.', 4000);
        this.result = 'wiped';
      }
    } else {
      this.wipeTimer = 0;
    }
  }

  /** Behind a living ally if there is one, otherwise the chapter's drop point. */
  private safeSpawn(room: Room, ctx: SimContext, p: PlayerEntity): Vec2 {
    const allies = this.enemies.livingPlayers(ctx).filter((q) => q.playerId !== p.playerId);
    if (allies.length === 0) return this.spawnPoint(room, p);

    let best = allies[0];
    let bestD = -Infinity;
    for (const a of allies) {
      let nearest = Infinity;
      for (const e of this.enemies.liveCombatants(ctx)) {
        nearest = Math.min(nearest, v.dist(a.pos, e.pos));
      }
      if (nearest > bestD) {
        bestD = nearest;
        best = a;
      }
    }
    // Step out on the far side of that ally from the closest threat.
    let threat: Vec2 | null = null;
    let td = Infinity;
    for (const e of this.enemies.liveCombatants(ctx)) {
      const d = v.dist(best.pos, e.pos);
      if (d < td) {
        td = d;
        threat = e.pos;
      }
    }
    const away = threat ? v.dir(threat, best.pos) : { x: 0, y: 1 };
    return {
      x: clamp(best.pos.x + away.x * 52, 60, ARENA_W - 60),
      y: clamp(best.pos.y + away.y * 52, 60, ARENA_H - 60),
    };
  }

  // ============================================================ dialogue + HUD

  private say(speaker: string, text: string, ms = 3200): void {
    this.dialogueQueue.push({ speaker, text, ms });
  }

  private updateDialogue(ctx: SimContext, dt: number): void {
    if (this.current) {
      this.currentLeft -= dt * 1000;
      if (this.currentLeft > 0) return;
      this.current = null;
    }
    const next = this.dialogueQueue.shift();
    if (!next) return;
    this.current = next;
    this.currentLeft = next.ms;
    ctx.emit({ t: 'dialogue', speaker: next.speaker, text: next.text, durationMs: next.ms });
  }

  private collectEvents(ctx: SimContext): void {
    for (const ev of ctx.world.events) {
      if (ev.t === 'slotCharged') {
        const s = this.stats.get(ev.player);
        if (s) s.slotsCharged += 1;
      } else if (ev.t === 'revive' && ev.by !== ev.player) {
        // The sim runs the revive; the campaign pays for it.
        const s = this.stats.get(ev.by);
        if (s) s.revives += 1;
        for (const p of this.enemies.allPlayers(ctx)) {
          if (p.playerId === ev.by) p.score += SCORE_REVIVE;
        }
      }
    }
  }

  /**
   * `ModeHandlerExtras`. The room drains this after `onTick` and pushes a fresh
   * `weave` message to each listed owner. Everything that mutates a board from
   * outside `stepWorld` — sapper bites, the Fracture's re-route, relay seals —
   * registers here, otherwise the client would keep rendering a stale board.
   */
  consumeBoardUpdates(): PlayerId[] {
    if (this.boardDirty.size === 0) return [];
    const out = Array.from(this.boardDirty);
    this.boardDirty.clear();
    return out;
  }

  private markBoards(players: Array<PlayerEntity | undefined>): void {
    for (const p of players) if (p) this.boardDirty.add(p.playerId);
  }

  private publish(ctx: SimContext): void {
    const o = ctx.world.objective;
    o.label = this.relay ? this.relay.label : this.label;
    o.progress = this.relay ? clamp(this.relay.charge / this.relay.hold, 0, 1) : this.progress;
    o.chapter = this.ch.id;
    o.wave = this.waveNumber;
    o.totalWaves = this.totalWaves;
    o.dialogue = this.current
      ? { speaker: this.current.speaker, text: this.current.text }
      : undefined;

    const scores: Record<string, number> = {
      alive: this.enemies.livingPlayers(ctx).length,
      enemies: this.enemies.liveCombatants(ctx).length,
    };
    if (this.core && !this.core.dead) {
      scores.shunt = Math.max(0, Math.round((this.core.hp / Math.max(1, this.core.maxHp)) * 100));
    }
    if (this.relay) {
      scores.relay = Math.round((this.relay.charge / this.relay.hold) * 100);
      scores.relayNeeded = this.relay.required;
    }
    o.teamScores = scores;
  }

  private standings(ctx: SimContext): MatchResult['standings'] {
    const rows = this.enemies.allPlayers(ctx).map((p) => {
      const s = this.stats.get(p.playerId) ?? {
        damageDealt: 0,
        damageTaken: 0,
        slotsCharged: 0,
        revives: 0,
      };
      return {
        playerId: p.playerId,
        name: p.name,
        role: p.role,
        score: Math.round(p.score),
        kills: p.kills,
        deaths: p.deaths,
        damageDealt: Math.round(s.damageDealt),
        damageTaken: Math.round(s.damageTaken),
        slotsCharged: s.slotsCharged,
        revives: s.revives,
      };
    });
    rows.sort((a, b) => b.score - a.score);
    return rows;
  }
}

/** Factory used by `createModeHandler('coop_story', chapter)`. */
export function createCoopHandler(chapter: number): ModeHandler {
  return new CoopHandler(chapter);
}
