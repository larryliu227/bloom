/**
 * VOIDLINE — Chapter 1 onboarding.
 *
 * The Weave is not a cooldown bar and a new runner has no reason to guess that.
 * This module is the staged sequence that teaches it, expressed as data plus a
 * small runner. Every step is gated on the player *doing* the thing — distance
 * travelled, a landed basic, a tile actually turning, `slot.connected` going
 * true, a slot actually firing — never on a timer alone. The timers exist only
 * so nothing can soft-lock: each step has a hard timeout that advances with a
 * gentler line, and a competent group skips the whole sequence by simply being
 * competent (see `TUTORIAL_SKIP_STREAK`).
 *
 * The only voice here is VESSEL, matching `chapters.ts`: clipped, declarative,
 * no exclamation, no encouragement. It is not a tutor. It is a dying station
 * that needs the lattice to work.
 *
 * `server/modes/coop.ts` owns the wiring; this file never touches the world.
 */

import { MAX_OVERCHARGE } from '@shared/constants.js';
import { getAbility } from '@shared/abilities.js';
import { getRole } from '@shared/roles.js';
import { isSolvable, routeDistance, solveBoard } from '@shared/weave.js';
import type { Entity, GameEvent, PlayerEntity, PlayerId, WeaveBoard } from '@shared/types.js';

// ============================================================ tuning

/** Master switch. Off means chapter 1 opens straight into its first wave. */
export const TUTORIAL_ENABLED = true;
/** Only chapter 1 is tutorialised. */
export const TUTORIAL_CHAPTER = 1;
/** World units the `move` step wants before it believes you have hands. */
export const TUTORIAL_MOVE_DISTANCE = 220;
/** Charge ratio that counts as a deliberate overcharge (cap is MAX_OVERCHARGE). */
export const TUTORIAL_OVERCHARGE_MIN = 1.15;
/** A step satisfied inside this window counts as "already knew that". */
export const TUTORIAL_FAST_SECONDS = 3.0;
/** That many fast steps in a row and the rest of the sequence is dropped. */
export const TUTORIAL_SKIP_STREAK = 4;
/** Beat after a step is satisfied, so a 4-stack sees it land before moving on. */
export const TUTORIAL_GRACE = 1.0;
/** Window linking a basic-attack cast to the damage it caused. */
const BASIC_HIT_WINDOW = 0.8;
/** Single-tick charge drop that can only mean `consumeCharge` ran. */
const FIRE_DROP = 0.2;

/** Overcharge ceiling as a percentage, so the dialogue can never drift from it. */
const OVER_PCT = Math.round((MAX_OVERCHARGE - 1) * 100);

// ============================================================ vocabulary

export type TutorialStepId =
  | 'move'
  | 'basic'
  | 'rotate'
  | 'connect'
  | 'fire'
  | 'overcharge'
  | 'dash'
  | 'reroute';

export interface TutorialLine {
  speaker: string;
  text: string;
  ms: number;
}

/**
 * What a step is allowed to know about one runner. Everything is measured from
 * real state each tick and reset when the step opens, so a step can never be
 * satisfied by something the player did two steps ago.
 */
export interface TutorialView {
  playerId: PlayerId;
  /** World units travelled this step. */
  moved: number;
  /** Landed hits attributable to the free basic attack this step. */
  basicHits: number;
  /** Tile rotations observed on this player's board this step. */
  rotations: number;
  /** Any slot connected to the core right now. */
  connected: boolean;
  /** Disconnected -> connected transitions this step. */
  connects: number;
  /** Weave slots that actually fired this step. */
  slotCasts: number;
  /** Best overcharge multiplier spent this step, 1 if nothing fired. */
  bestOvercharge: number;
  /** Movement dashes this step (ability blinks excluded). */
  dashes: number;
  /** Cells this player's board lost this step. */
  cellsLost: number;
  /** Fewest rotations that would light some slot right now; -1 if none can. */
  clicks: number;
  /** False only if the board has stopped being routable at all. */
  routable: boolean;
  /** Hostiles were on the floor this step and are now all dead. */
  floorClear: boolean;
}

/** The handful of things a step may ask the mode handler to do. */
export interface TutorialHost {
  say(speaker: string, text: string, ms: number): void;
  objective(label: string): void;
  /** Queue `count` bodies away from the group. Already scaled by head count. */
  spawn(archetype: string, count: number): void;
  clearFloor(): void;
}

/** Bodies a step puts on the floor as it opens. */
export interface TutorialSpawn {
  archetype: string;
  count: number;
  /**
   * Skip head-count scaling. For the one body a step is actually *about*: four
   * Unravellers chewing four boards teach nothing one does not, and drown it.
   */
  solo?: boolean;
}

/** Teaching-spawn scaling. 1 runner leaves it alone, 4 roughly doubles it. */
export function scaleSpawn(count: number, players: number): number {
  const heads = players < 1 ? 1 : players > 4 ? 4 : players;
  return Math.max(1, Math.round(count * (0.55 + 0.35 * heads)));
}

export interface TutorialStep {
  id: TutorialStepId;
  /** HUD objective banner while this step is open. */
  objective: string;
  /** Queued the moment the step opens. Plays over whatever is happening. */
  intro: TutorialLine[];
  /** Escalation, one at a time, from `hintAfter` then every `hintEvery`. */
  hints: TutorialLine[];
  /** Said when the step is satisfied. Skipped if it was satisfied instantly. */
  cleared?: TutorialLine;
  /** Said instead when the hard timeout advances the step. */
  bail: TutorialLine;
  hintAfter: number;
  hintEvery: number;
  /** Hard ceiling. The step advances no matter what once this elapses. */
  timeout: number;
  /** Wipe the floor as the step opens (used to make the board lesson calm). */
  clearFloor?: boolean;
  spawns?: TutorialSpawn[];
  /**
   * Read the board for the second hint onward and say something specific about
   * how far off the routing is. Never solves it.
   */
  boardHint?: boolean;
  /** Any single runner satisfying this advances the whole group. */
  done(vw: TutorialView): boolean;
}

const V = 'VESSEL';

function line(text: string, ms: number): TutorialLine {
  return { speaker: V, text, ms };
}

// ============================================================ the sequence

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'move',
    objective: 'Move — let the lattice find you',
    intro: [line('You are jacked in. Walk. I need the lattice to register a body.', 4200)],
    hints: [
      line('Any direction. The spine does not care which.', 3200),
      line('If you cannot move I will have to log you as cargo.', 3800),
    ],
    bail: line('Logged as present. We will call that walking.', 3200),
    hintAfter: 4.5,
    hintEvery: 4.5,
    timeout: 15,
    clearFloor: true,
    done: (vw) => vw.moved >= TUTORIAL_MOVE_DISTANCE,
  },
  {
    id: 'basic',
    objective: 'Break the frame — the light attack is free',
    intro: [
      line('One maintenance frame on the deck. Hit it with your light attack.', 4000),
      line('That one is free. It is not routed. It never runs dry.', 4000),
    ],
    hints: [
      line('The light attack does not touch your board. Use it constantly.', 3800),
      line('It is the only thing on you that never needs power.', 3600),
    ],
    bail: line('Leaving it standing. It will find you later.', 3200),
    hintAfter: 6,
    hintEvery: 5.5,
    timeout: 20,
    // `solo` so the line stays true at four heads: one frame, not two.
    spawns: [{ archetype: 'chaser', count: 1, solo: true }],
    done: (vw) => vw.basicHits >= 1,
  },
  {
    id: 'rotate',
    objective: 'Turn a conduit tile',
    intro: [
      line('Now the board. Your three abilities are three sockets on its rim.', 4400),
      line('Nothing on it has a cooldown. It has geometry. Turn a tile.', 4400),
    ],
    hints: [
      line('Take any conduit. It turns a quarter. That is all it does.', 3800),
      line('Turn the wrong one. Nothing on that board can break.', 3800),
      // Not by name. The name arrives with the first LOG // KORR fragment.
      line('The last one spent nine minutes on his first board. You have the time.', 4000),
    ],
    cleared: line('Good. Every tile does that. All of them, always.', 3800),
    bail: line('The board is yours whether you touch it or not.', 3400),
    hintAfter: 6,
    hintEvery: 5.5,
    timeout: 24,
    clearFloor: true,
    /*
     * `connected` counts as proof, and it is not a shortcut: `createBoard`
     * never hands out a board with a live slot — weave.ts asserts that in its
     * own self-test, and 1600 fresh boards across all four roles confirm it —
     * so a runner whose slot is lit can only have got there by turning tiles.
     *
     * Without this, a runner who already routed during an earlier step has
     * nothing left to turn: the step wants a *change* it will never see, so it
     * burns its full 24 seconds on a deliberately cleared floor. That is the
     * longest empty room in the game, and it lands on exactly the people who
     * least need the lesson.
     */
    done: (vw) => vw.rotations >= 1 || vw.connected,
  },
  {
    id: 'connect',
    objective: 'Route the core to a slot',
    intro: [
      line('The lit cell at the centre is your core. It is always burning.', 4200),
      line('Power crosses two tiles only where both are open to each other.', 4400),
      line('Build that line out to a slot. A connected slot charges itself.', 4400),
    ],
    hints: [
      line('Trace it by eye. Core, tile, tile, slot. No gaps.', 4000),
      line('There is always a line. This lattice does not build dead ends.', 4000),
      line('Take it one tile at a time, outward. Do not plan the whole thing.', 4200),
    ],
    cleared: line('Connected. That slot is drinking now. Do not let it go.', 4000),
    bail: line('Leave it dark for the moment. It will matter shortly.', 3600),
    hintAfter: 8,
    hintEvery: 6,
    timeout: 30,
    boardHint: true,
    done: (vw) => vw.connected || vw.connects >= 1 || !vw.routable,
  },
  {
    id: 'fire',
    objective: 'Fire the charged slot',
    intro: [
      line('It filled. Fire it.', 2600),
      line('Firing empties the slot. The circuit survives. It refills.', 4200),
    ],
    hints: [
      line('The gauge on that slot is full. That means it will go.', 3800),
      line('Hold the circuit and it comes back. Break it and it bleeds off.', 4200),
    ],
    bail: line('Keep it banked then. Charge does not spoil.', 3200),
    hintAfter: 7,
    hintEvery: 5.5,
    timeout: 24,
    boardHint: true,
    spawns: [{ archetype: 'chaser', count: 2 }],
    done: (vw) => vw.slotCasts >= 1,
  },
  {
    id: 'overcharge',
    objective: 'Hold a live circuit past full',
    intro: [
      line('A full slot keeps drinking. Half again, and then it stops.', 4000),
      line(`Hold the circuit past full and the shot lands ${OVER_PCT} percent harder.`, 4400),
      line('Greed costs you seconds. Decide which you have more of.', 4000),
    ],
    hints: [
      line('Do not fire the instant it fills. Wait. Watch it swell.', 4200),
      line('Keep the line intact. It banks until it cannot.', 3800),
    ],
    cleared: line('That one landed harder. You will want that at the core.', 4000),
    bail: line('Another time. It will matter at the core.', 3200),
    hintAfter: 7,
    hintEvery: 6,
    timeout: 22,
    spawns: [{ archetype: 'chaser', count: 1 }],
    done: (vw) => vw.bestOvercharge >= TUTORIAL_OVERCHARGE_MIN,
  },
  {
    id: 'dash',
    objective: 'Dash the telegraph',
    intro: [
      line('Something is winding up on you. Read the ring.', 3600),
      line('Dash. For a fraction of a second you are not there. It is enough.', 4400),
    ],
    hints: [
      line('Dash through it, not away from it.', 3400),
      line('The frames commit before they swing. That gap is the whole fight.', 4200),
    ],
    bail: line('Take the hit then. You have the health for one.', 3200),
    hintAfter: 6,
    hintEvery: 5,
    timeout: 18,
    // One windup, arriving on an empty floor. Leftovers from the firing steps
    // would bury the ring this step is asking them to read.
    clearFloor: true,
    spawns: [
      { archetype: 'spitter', count: 1 },
      { archetype: 'chaser', count: 1 },
    ],
    done: (vw) => vw.dashes >= 1,
  },
  {
    id: 'reroute',
    objective: 'Unraveller inbound — kill it or route around it',
    intro: [
      line('New shape on the lattice. It is not going for your body.', 3800),
      line('It bites a cell out of your board. That cell does not come back.', 4400),
      line('Kill it while it roots, or route around the hole. Both are answers.', 4400),
    ],
    hints: [
      line('It has to stop moving to open the tap. That is your window.', 4200),
      line('If it took a cell, build a new line. The old one is gone.', 4200),
    ],
    cleared: line('Your board is terrain now. It can be taken from you.', 4200),
    bail: line('It is still on you. Work around it.', 3200),
    hintAfter: 8,
    hintEvery: 6,
    // The longest window in the sequence on purpose: an Unraveller stalks before
    // it commits, and both of the answers offered above take real time.
    timeout: 30,
    boardHint: true,
    // The lesson is one Unraveller and the hole it leaves. Anything still
    // standing from the dash step just hides it.
    clearFloor: true,
    spawns: [
      { archetype: 'sapper', count: 1, solo: true },
      { archetype: 'chaser', count: 2 },
    ],
    done: (vw) => (vw.cellsLost > 0 ? vw.connected : false) || vw.floorClear,
  },
];

/** The opening line of the whole sequence, and the line that ends it. */
// "Lattice is warm" belongs to KORR's day-one log; VESSEL does not borrow it.
export const TUTORIAL_OPEN = line('The spine is quiet. Before you go deeper I want to watch you work.', 4400);
export const TUTORIAL_CLOSE = line('That is everything the station can teach you. The rest is the station.', 4600);
/** Said instead of the remaining steps when a runner clearly already knows. */
export const TUTORIAL_SKIP = line('You have done this before. I will stop narrating.', 3600);

/** Steps for a chapter, or null if that chapter is not tutorialised. */
export function tutorialSteps(chapter: number): TutorialStep[] | null {
  if (!TUTORIAL_ENABLED) return null;
  return chapter === TUTORIAL_CHAPTER ? TUTORIAL_STEPS : null;
}

// ============================================================ board hints

const COUNT_WORDS = ['zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
const MAG_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

function words(n: number, table: string[]): string {
  return n >= 0 && n < table.length ? table[n] : String(n);
}

/** Fewest rotations that would light any slot on this board. -1 if none can. */
export function bestRouteDistance(board: WeaveBoard): number {
  let best = -1;
  for (let i = 0; i < board.slots.length; i++) {
    const d = routeDistance(board, i);
    if (d < 0) continue;
    if (best < 0 || d < best) best = d;
  }
  return best;
}

/**
 * The unlocked cell nearest the core whose rotation has to change for the
 * board's own solution to hold. Deliberately only ONE cell, and deliberately
 * described rather than turned: escalate the hint, never solve the puzzle.
 */
function firstWrongCell(board: WeaveBoard): number {
  const want = solveBoard(board);
  if (!want) return -1;
  const n = board.size;
  const cx = board.coreIndex % n;
  const cy = (board.coreIndex / n) | 0;
  let pick = -1;
  let pickD = Infinity;
  for (let i = 0; i < board.tiles.length; i++) {
    const t = board.tiles[i];
    if (t.locked || want[i] === t.rotation) continue;
    const d = Math.abs((i % n) - cx) + Math.abs(((i / n) | 0) - cy);
    if (d < pickD) {
      pickD = d;
      pick = i;
    }
  }
  return pick;
}

function describeCell(board: WeaveBoard, index: number): string | null {
  const n = board.size;
  const dx = (index % n) - (board.coreIndex % n);
  const dy = ((index / n) | 0) - ((board.coreIndex / n) | 0);
  const parts: string[] = [];
  if (dy < 0) parts.push(`${words(-dy, MAG_WORDS)} up`);
  else if (dy > 0) parts.push(`${words(dy, MAG_WORDS)} down`);
  if (dx < 0) parts.push(`${words(-dx, MAG_WORDS)} left`);
  else if (dx > 0) parts.push(`${words(dx, MAG_WORDS)} right`);
  return parts.length === 0 ? null : parts.join(' and ');
}

/**
 * An escalated hint read off the real board. Says how far off the routing is
 * and points at one cell. Never applies a solution — `applySolution` exists in
 * `shared/weave.ts` and is deliberately not called from here.
 */
export function routeHint(board: WeaveBoard): string | null {
  if (!board || !board.tiles || !board.slots) return null;
  const best = bestRouteDistance(board);
  if (best === 0) return 'A slot is already live. Hold it there.';
  if (best < 0) {
    return isSolvable(board)
      ? null
      : 'That board has lost too much. Work with what is still lit.';
  }
  const turns = `${words(best, COUNT_WORDS)} ${best === 1 ? 'turn' : 'turns'} from live.`;
  const cell = firstWrongCell(board);
  const where = cell >= 0 ? describeCell(board, cell) : null;
  return where ? `${turns} Start ${where} from the core.` : `${turns} Keep turning.`;
}

// ============================================================ per-player probe

/**
 * Everything a step's `done` predicate needs, derived by diffing real state
 * against last tick. Nothing here is reported by the client, so none of it can
 * be spoofed, and nothing here mutates the world.
 */
class Tracker {
  moved = 0;
  basicHits = 0;
  rotations = 0;
  connects = 0;
  slotCasts = 0;
  bestOvercharge = 1;
  dashes = 0;
  cellsLost = 0;

  private basicAge = Infinity;
  private slotAge = Infinity;
  private hitAge = Infinity;

  private px = 0;
  private py = 0;
  private rot: number[] = [];
  private kind: string[] = [];
  private charge: number[] = [];
  private blocked = 0;
  private wasDashing = 0;
  private wasConnected = false;

  constructor(p: PlayerEntity) {
    this.reset(p);
  }

  /** Zero the accumulators and re-baseline. Called as every step opens. */
  reset(p: PlayerEntity): void {
    this.moved = 0;
    this.basicHits = 0;
    this.rotations = 0;
    this.connects = 0;
    this.slotCasts = 0;
    this.bestOvercharge = 1;
    this.dashes = 0;
    this.cellsLost = 0;
    this.basicAge = Infinity;
    this.slotAge = Infinity;
    this.hitAge = Infinity;
    this.px = p.pos.x;
    this.py = p.pos.y;
    this.wasDashing = p.dashing;
    const b = p.weave;
    this.rot = b && b.tiles ? b.tiles.map((t) => t.rotation) : [];
    this.kind = b && b.tiles ? b.tiles.map((t) => t.kind as string) : [];
    this.charge = b && b.slots ? b.slots.map((s) => s.charge) : [];
    this.blocked = countBlocked(b);
    this.wasConnected = anyConnected(b);
  }

  /** A hostile took damage from this runner. Fed by the mode handler's onDamage. */
  noteHit(): void {
    this.hitAge = 0;
  }

  step(p: PlayerEntity, events: readonly GameEvent[], dt: number): void {
    this.basicAge += dt;
    this.slotAge += dt;
    this.hitAge += dt;

    const basicId = getRole(p.role).basicAttack;
    let slotCastThisTick = false;
    for (const ev of events) {
      if (ev.t !== 'cast' || ev.caster !== p.id) continue;
      if (ev.ability === basicId) this.basicAge = 0;
      else {
        this.slotAge = 0;
        slotCastThisTick = true;
      }
    }

    const dx = p.pos.x - this.px;
    const dy = p.pos.y - this.py;
    this.moved += Math.sqrt(dx * dx + dy * dy);
    this.px = p.pos.x;
    this.py = p.pos.y;

    // Movement dash only: an ability blink emits the same event in the same tick
    // as its `cast`, so a slot cast this tick disqualifies the transition.
    if (this.wasDashing <= 0 && p.dashing > 0 && !slotCastThisTick) this.dashes += 1;
    this.wasDashing = p.dashing;

    const b = p.weave;
    if (b && b.tiles) {
      for (let i = 0; i < b.tiles.length && i < this.rot.length; i++) {
        const t = b.tiles[i];
        const sameCell = (t.kind as string) === this.kind[i];
        if (sameCell && !t.locked && t.rotation !== this.rot[i]) this.rotations += 1;
        this.rot[i] = t.rotation;
        this.kind[i] = t.kind as string;
      }
      const nowBlocked = countBlocked(b);
      if (nowBlocked > this.blocked) this.cellsLost += nowBlocked - this.blocked;
      this.blocked = nowBlocked;

      const live = anyConnected(b);
      if (live && !this.wasConnected) this.connects += 1;
      this.wasConnected = live;

      if (b.slots) {
        for (let i = 0; i < b.slots.length; i++) {
          const cost = getAbility(b.slots[i].ability).cost;
          const prev = this.charge.length > i ? this.charge[i] : 0;
          const now = b.slots[i].charge;
          // Charge only ever falls this fast when `consumeCharge` zeroed it;
          // decay is CHARGE_DECAY_RATE per second, far under FIRE_DROP a tick.
          if (cost > 0 && prev - now >= FIRE_DROP && prev >= cost * 0.98) {
            this.slotCasts += 1;
            const over = prev / cost;
            if (over > this.bestOvercharge) this.bestOvercharge = Math.min(over, MAX_OVERCHARGE);
          }
          this.charge[i] = now;
        }
      }
    }

    /*
     * A `hit` event carries no author, so a landed basic has to be inferred:
     * this runner swung, something of theirs connected, and the swing is the
     * most recent thing they fired.
     *
     * That last clause used to be "and they have not fired a slot at all
     * recently", which quietly broke for anyone holding the light attack down
     * while their circuits also went off — a returning runner with a live board
     * does exactly that, so the step could never be satisfied and burned its
     * whole twenty seconds. Comparing the two ages instead still refuses to
     * credit ability damage as a basic (slot fired, basic did not), while a
     * runner doing both in the same breath gets the credit they earned.
     */
    if (
      this.basicAge <= BASIC_HIT_WINDOW &&
      this.hitAge <= BASIC_HIT_WINDOW &&
      this.basicAge <= this.slotAge
    ) {
      this.basicHits += 1;
      this.hitAge = Infinity; // one credit per landed swing
    }
  }

  view(p: PlayerEntity, floorClear: boolean, wantBoard: boolean): TutorialView {
    const b = p.weave;
    const clicks = wantBoard && b && b.tiles ? bestRouteDistance(b) : -1;
    return {
      playerId: p.playerId,
      moved: this.moved,
      basicHits: this.basicHits,
      rotations: this.rotations,
      connected: anyConnected(b),
      connects: this.connects,
      slotCasts: this.slotCasts,
      bestOvercharge: this.bestOvercharge,
      dashes: this.dashes,
      cellsLost: this.cellsLost,
      clicks,
      routable: wantBoard ? clicks >= 0 : true,
      floorClear,
    };
  }
}

function countBlocked(b: WeaveBoard | undefined): number {
  if (!b || !b.tiles) return 0;
  let n = 0;
  for (const t of b.tiles) if (t.kind === 'blocked') n += 1;
  return n;
}

function anyConnected(b: WeaveBoard | undefined): boolean {
  if (!b || !b.slots) return false;
  for (const s of b.slots) if (s.connected) return true;
  return false;
}

// ============================================================ the runner

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Walks `TUTORIAL_STEPS`. One instance per match, driven from the co-op mode
 * handler's `tutorial` beat.
 *
 * Guarantees:
 *  - **idempotent** — `begin` is a no-op once the run has started or ended, and
 *    `update` returns `true` forever afterwards without touching anything.
 *  - **never soft-locks** — every step advances on its `timeout` regardless of
 *    player state, and a step whose board became unroutable completes at once.
 *  - **skippable** — a step already satisfied when it opens completes on the
 *    first tick, and once *every* runner has cleared `TUTORIAL_SKIP_STREAK`
 *    steps in a row instantly, the rest of the sequence is dropped.
 *  - **head-count blind** — any one runner satisfying a step advances everybody,
 *    so three people are never stuck watching a fourth.
 */
export class TutorialRun {
  private readonly steps: TutorialStep[];
  private idx = -1;
  private t = 0;
  private hintsSaid = 0;
  private nextHint = Infinity;
  private grace = -1;
  /** Consecutive steps each runner has personally cleared inside FAST_SECONDS. */
  private fast = new Map<PlayerId, number>();
  private sawHostiles = false;
  private cleared = 0;
  private ended = false;
  private label = '';
  private trackers = new Map<PlayerId, Tracker>();

  constructor(steps: TutorialStep[]) {
    this.steps = steps;
  }

  get finished(): boolean {
    return this.ended;
  }

  get stepId(): TutorialStepId | null {
    const s = this.steps[this.idx];
    return s ? s.id : null;
  }

  get stepIndex(): number {
    return this.idx;
  }

  /** HUD banner. Empty once the sequence is over. */
  get objectiveLabel(): string {
    return this.label;
  }

  /** 0..1 across the whole sequence, for the objective progress bar. */
  get progress(): number {
    if (this.steps.length === 0) return 1;
    return clamp01(this.cleared / this.steps.length);
  }

  begin(host: TutorialHost, players: PlayerEntity[]): void {
    if (this.idx >= 0 || this.ended) return;
    if (this.steps.length === 0) {
      this.ended = true;
      return;
    }
    for (const p of players) this.trackers.set(p.playerId, new Tracker(p));
    host.say(TUTORIAL_OPEN.speaker, TUTORIAL_OPEN.text, TUTORIAL_OPEN.ms);
    this.open(host, 0, players);
  }

  /** Returns true once the whole sequence is over. Safe to keep calling. */
  update(
    host: TutorialHost,
    players: PlayerEntity[],
    events: readonly GameEvent[],
    hostiles: number,
    dt: number,
  ): boolean {
    if (this.ended) return true;
    if (this.idx < 0) {
      this.begin(host, players);
      if (this.ended) return true;
    }

    for (const p of players) {
      let tr = this.trackers.get(p.playerId);
      if (!tr) {
        tr = new Tracker(p); // late joiner: baselined here, so no free credit
        this.trackers.set(p.playerId, tr);
      }
      tr.step(p, events, dt);
    }
    if (hostiles > 0) this.sawHostiles = true;

    if (this.grace >= 0) {
      this.grace -= dt;
      if (this.grace <= 0) this.open(host, this.idx + 1, players);
      return this.ended;
    }

    const step = this.steps[this.idx];
    if (!step) {
      this.finish(host, true);
      return true;
    }
    this.t += dt;

    const floorClear = this.sawHostiles && hostiles === 0;
    const wantBoard = step.boardHint === true;
    // Every runner is polled, not just the first one who counts — the group
    // advances on any of them, but who did it decides whether the rest of the
    // sequence can be dropped.
    const who = new Set<PlayerId>();
    for (const p of players) {
      const tr = this.trackers.get(p.playerId);
      if (!tr) continue;
      if (step.done(tr.view(p, floorClear, wantBoard))) who.add(p.playerId);
    }
    if (who.size > 0) {
      this.satisfy(host, step, players, who);
      return this.ended;
    }

    if (this.t >= this.nextHint && this.hintsSaid < step.hints.length) {
      this.sayHint(host, step, players);
    }
    if (this.t >= step.timeout) {
      host.say(step.bail.speaker, step.bail.text, step.bail.ms);
      this.fast.clear();
      this.cleared += 1;
      this.grace = TUTORIAL_GRACE;
    }
    return this.ended;
  }

  /** Fed from the mode handler's `onDamage` so basic hits can be attributed. */
  noteDamage(source: Entity | null, target: Entity): void {
    if (this.ended || !source) return;
    if (source.kind !== 'player' || target.kind === 'player') return;
    const tr = this.trackers.get((source as PlayerEntity).playerId);
    if (tr) tr.noteHit();
  }

  /** Drop the rest of the sequence (host bail-out, e.g. a wipe mid-tutorial). */
  abort(host: TutorialHost): void {
    if (this.ended) return;
    this.finish(host, false);
  }

  // ---------------------------------------------------------- internals

  private satisfy(
    host: TutorialHost,
    step: TutorialStep,
    players: PlayerEntity[],
    who: Set<PlayerId>,
  ): void {
    const instant = this.t <= TUTORIAL_FAST_SECONDS;
    if (step.cleared && !instant) {
      host.say(step.cleared.speaker, step.cleared.text, step.cleared.ms);
    }
    /*
     * Dropping the rest of the sequence is a per-runner verdict, never a group
     * one. Three veterans — or three AI runners, which are always instant —
     * clearing a step on its first tick must not cancel the fourth runner's
     * first lesson. So each runner carries their own streak, only for steps they
     * personally satisfied, and the sequence is only dropped when nobody in the
     * room still needs it.
     */
    for (const p of players) {
      const n = this.fast.get(p.playerId) ?? 0;
      this.fast.set(p.playerId, instant && who.has(p.playerId) ? n + 1 : 0);
    }
    this.cleared += 1;
    const everyoneKnows =
      players.length > 0 &&
      players.every((p) => (this.fast.get(p.playerId) ?? 0) >= TUTORIAL_SKIP_STREAK);
    if (everyoneKnows && this.idx < this.steps.length - 1) {
      host.say(TUTORIAL_SKIP.speaker, TUTORIAL_SKIP.text, TUTORIAL_SKIP.ms);
      this.finish(host, false);
      return;
    }
    this.grace = TUTORIAL_GRACE;
  }

  private open(host: TutorialHost, i: number, players: PlayerEntity[]): void {
    this.grace = -1;
    if (i >= this.steps.length) {
      this.finish(host, true);
      return;
    }
    const step = this.steps[i];
    this.idx = i;
    this.t = 0;
    this.hintsSaid = 0;
    this.nextHint = step.hintAfter;
    this.sawHostiles = false;
    for (const p of players) this.trackers.get(p.playerId)?.reset(p);
    if (step.clearFloor) host.clearFloor();
    this.label = step.objective;
    host.objective(step.objective);
    for (const l of step.intro) host.say(l.speaker, l.text, l.ms);
    if (step.spawns) {
      for (const s of step.spawns) {
        host.spawn(s.archetype, s.solo ? s.count : scaleSpawn(s.count, players.length));
      }
    }
  }

  private finish(host: TutorialHost, closing: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.cleared = this.steps.length;
    this.label = '';
    if (closing) host.say(TUTORIAL_CLOSE.speaker, TUTORIAL_CLOSE.text, TUTORIAL_CLOSE.ms);
  }

  /** Hint against whichever board is furthest from live — the runner who needs it. */
  private stuckBoard(players: PlayerEntity[]): WeaveBoard | null {
    let pick: WeaveBoard | null = null;
    let worst = -Infinity;
    for (const p of players) {
      const b = p.weave;
      if (!b || !b.tiles) continue;
      const d = bestRouteDistance(b);
      const score = d < 0 ? Infinity : d;
      if (score > worst) {
        worst = score;
        pick = b;
      }
    }
    return pick;
  }

  private sayHint(host: TutorialHost, step: TutorialStep, players: PlayerEntity[]): void {
    const scripted = step.hints[this.hintsSaid];
    let text = scripted.text;
    if (step.boardHint && this.hintsSaid >= 1) {
      const board = this.stuckBoard(players);
      const dynamic = board ? routeHint(board) : null;
      if (dynamic) text = dynamic;
    }
    host.say(scripted.speaker, text, scripted.ms);
    this.hintsSaid += 1;
    this.nextHint = this.t + step.hintEvery;
  }
}
