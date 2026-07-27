/**
 * BLOOM — core domain types.
 *
 * Single source of truth for board and match state. Server mutates, client renders.
 * The board is deliberately small: the whole thing ships in every snapshot, which
 * removes an entire class of desync bugs and still compresses to almost nothing.
 */

export type PlayerId = string;
export type RoomId = string;

// ============================================================ board

export const BOARD_W = 12;
export const BOARD_H = 18;
export const CELL_COUNT = BOARD_W * BOARD_H;

/** 4-neighbour offsets. No diagonals — easier to read and to reason about. */
export const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export type CellKind =
  | 'soil' // plain, claimable
  | 'rock' // permanently blocked; makes the chokepoints the whole game turns on
  | 'sun' // resource: owning it speeds your energy
  | 'home'; // a player's root. Lose the ability to grow from it and you are out.

/**
 * One board cell.
 *
 * `owner` is the seat index (0..3) or -1 for unowned. Seat index rather than PlayerId
 * keeps the snapshot tiny and makes colour lookup a straight array index.
 */
export interface Cell {
  kind: CellKind;
  /** Seat index of the owner, or -1. */
  owner: number;
  /**
   * 0..1. Rises while being claimed, and is what the client animates. A cell only
   * changes `owner` when this completes, so a contested cell reads honestly.
   */
  progress: number;
  /** Seat currently claiming this cell, or -1. */
  claimant: number;
  /**
   * Seconds of wither remaining. Set when the cell loses its path home; at 0 the cell
   * reverts to unowned soil. This is the visual payoff of a successful cut.
   */
  wither: number;
  /** True when a path back to the owner's home exists. Server-computed every tick. */
  connected: boolean;
  /** SPORE only: seconds before an unconnected spore dies. 0 when not a spore. */
  spore: number;
}

export interface Board {
  w: number;
  h: number;
  /** Row-major, length w*h. */
  cells: Cell[];
  /** Cell index of each seat's home, indexed by seat. */
  homes: number[];
}

// ============================================================ roles

export type RoleId = 'vine' | 'moss' | 'spore' | 'thorn' | 'fungal';

export interface RoleDef {
  id: RoleId;
  name: string;
  /** One short line. Must be understandable by a child; no numbers. */
  blurb: string;
  colour: string;
  /** Seconds to claim a neutral tile. */
  growTime: number;
  /** Seconds to capture an enemy tile. */
  captureTime: number;
  /** Energy cost to claim neutral / to attack. */
  growCost: number;
  attackCost: number;
  /** Multiplier on how fast this role's tiles wither once cut. */
  witherMul: number;
  /** Multiplier on how long ENEMIES take to capture this role's tiles. */
  toughness: number;
  /** Straight-line run length per tap (VINE = 2, others 1). */
  reach: number;
  /** Claim a square block of this size per tap (MOSS = 2, others 1). */
  blockSize: number;
  /** True if this role ignores adjacency and may tap anywhere (SPORE). */
  remote: boolean;
  /** Seconds an unconnected remote claim survives (SPORE). 0 = n/a. */
  sporeLife: number;
  /**
   * THORN: cannot claim empty soil at all — it only takes tiles off other players.
   * This is a VERB, not a modifier, and it is what stops THORN being a slow VINE.
   */
  parasite?: boolean;
  /**
   * SPORE: a landed spore becomes a second root, so its network no longer has to
   * trace all the way home. Without this SPORE was strictly worse than everyone —
   * it paid the adjacency-free tap with a connection it could almost never keep.
   */
  rootsAnywhere?: boolean;
  /** SPORE: how many cells away from its own network a landing may be. */
  hop?: number;
  /**
   * FUNGAL: seconds between automatic, free spread steps into neighbouring soil.
   * Its verb is that it does not tap to grow AT ALL — the mycelium creeps on its
   * own, and your taps are spent entirely on eating other players.
   */
  creep?: number;
  /** FUNGAL: energy gained per tile eaten. Growth is fed by digestion. */
  digest?: number;
}

// ============================================================ tech

/**
 * Upgrades. Three shared roots everyone can take, plus a three-deep branch unique
 * to each faction — so a VINE's late game does not look like a MOSS's.
 *
 * `requires` makes the branch a real tree rather than a shopping list: you commit
 * to a direction before you can see the payoff at the end of it.
 */
export type TechId =
  | 'surge'
  | 'deeproot'
  | 'solar'
  | 'whip'
  | 'lash'
  | 'canopy'
  | 'carpet'
  | 'bark'
  | 'bog'
  | 'drift'
  | 'pod'
  | 'burst'
  | 'barbs'
  | 'feed'
  | 'swarm'
  | 'mycelium'
  | 'enzyme'
  | 'bloomcap';

export interface TechDef {
  id: TechId;
  name: string;
  /** Child-readable. No numbers. */
  blurb: string;
  cost: number;
  icon: string;
  /** Undefined = available to everyone. Otherwise only this faction may take it. */
  role?: RoleId;
  /** Must be owned first. This is what makes the branch a tree. */
  requires?: TechId;
  tier: number;
}

export const TECHS: TechDef[] = [
  // --- shared roots
  { id: 'surge', name: 'SURGE', blurb: 'everything grows faster', cost: 8, icon: '⚡', tier: 1 },
  { id: 'deeproot', name: 'DEEP ROOT', blurb: 'cut vines hang on longer', cost: 10, icon: '⚓', tier: 1 },
  { id: 'solar', name: 'SOLAR', blurb: 'sun tiles feed you more', cost: 14, icon: '☀', tier: 2, requires: 'surge' },

  // --- VINE: distance
  { id: 'whip', name: 'WHIP', blurb: 'runners go further', cost: 9, icon: '➤', role: 'vine', tier: 1 },
  { id: 'lash', name: 'LASH', blurb: 'runners cost less', cost: 16, icon: '⇉', role: 'vine', tier: 2, requires: 'whip' },
  { id: 'canopy', name: 'CANOPY', blurb: 'runners land much faster', cost: 24, icon: '❋', role: 'vine', tier: 3, requires: 'lash' },

  // --- MOSS: bulk
  { id: 'carpet', name: 'CARPET', blurb: 'claim a bigger patch', cost: 9, icon: '▦', role: 'moss', tier: 1 },
  { id: 'bark', name: 'BARK', blurb: 'much harder to eat', cost: 16, icon: '🛡', role: 'moss', tier: 2, requires: 'carpet' },
  { id: 'bog', name: 'BOG', blurb: 'never withers', cost: 24, icon: '≋', role: 'moss', tier: 3, requires: 'bark' },

  // --- SPORE: reach
  { id: 'drift', name: 'DRIFT', blurb: 'hop further', cost: 9, icon: '❂', role: 'spore', tier: 1 },
  { id: 'pod', name: 'POD', blurb: 'spores cost less', cost: 16, icon: '◍', role: 'spore', tier: 2, requires: 'drift' },
  { id: 'burst', name: 'BURSTPOD', blurb: 'landings spread out', cost: 24, icon: '✺', role: 'spore', tier: 3, requires: 'pod' },

  // --- FUNGAL: digestion
  { id: 'mycelium', name: 'MYCELIUM', blurb: 'creeps much faster', cost: 9, icon: '🍄', role: 'fungal', tier: 1 },
  { id: 'enzyme', name: 'ENZYME', blurb: 'eating feeds you more', cost: 16, icon: '🧪', role: 'fungal', tier: 2, requires: 'mycelium' },
  { id: 'bloomcap', name: 'BLOOMCAP', blurb: 'eaten tiles creep too', cost: 24, icon: '✿', role: 'fungal', tier: 3, requires: 'enzyme' },

  // --- THORN: contact
  { id: 'barbs', name: 'BARBS', blurb: 'eat much faster', cost: 9, icon: '✖', role: 'thorn', tier: 1 },
  { id: 'feed', name: 'FEED', blurb: 'eating gives energy', cost: 16, icon: '🍖', role: 'thorn', tier: 2, requires: 'barbs' },
  { id: 'swarm', name: 'SWARM', blurb: 'eating spreads twice as far', cost: 24, icon: '⁂', role: 'thorn', tier: 3, requires: 'feed' },
];

/** Techs this faction may ever take, in tree order. */
export function techsFor(role: RoleId): TechDef[] {
  return TECHS.filter((t) => t.role === undefined || t.role === role);
}

// Tuning for the effects above.
export const TECH_GROW_SPEED = 0.65;
export const TECH_WITHER_MUL = 0.45;
export const TECH_SOLAR_BONUS = 0.5;
export const TECH_BARK_TOUGH = 2;
export const TECH_FEED_ENERGY = 2;
export const TECH_ENZYME_BONUS = 2;

// ============================================================ match

export type GameMode = 'duel' | 'garden' | 'coop_blight';
export type MatchPhase = 'lobby' | 'countdown' | 'playing' | 'complete';

export interface Seat {
  seat: number;
  playerId: PlayerId;
  name: string;
  role: RoleId;
  colour: string;
  energy: number;
  /** Live count of owned cells — drives the win check and the HUD bar. */
  tiles: number;
  alive: boolean;
  connected: boolean;
  isBot: boolean;
}

/**
 * A fungal insect. Spawned by the mycelium, walks the board on its own, and eats
 * whatever enemy tile it stands next to — so FUNGAL projects force without taps.
 */
export interface Insect {
  id: number;
  seat: number;
  /** Cell it currently occupies. */
  cell: number;
  /** Seconds until its next move or bite. */
  clock: number;
  /** Seconds left to live. Insects are temporary; the swarm must be renewed. */
  life: number;
}

/** Seconds between insect actions. Night makes them quicker. */
export const INSECT_STEP = 1.1;
export const INSECT_LIFE = 26;
/** Energy the mycelium pays to hatch one. */
export const INSECT_COST = 5;
/** How many an owner may have alive at once. */
export const INSECT_CAP = 4;

export interface MatchState {
  tick: number;
  mode: GameMode;
  phase: MatchPhase;
  phaseTimer: number;
  board: Board;
  seats: Seat[];
  /** Seconds each seat has held the territory threshold, indexed by seat. */
  holdTimers: number[];
  /** Seconds since the match began — drives the day/night cycle. */
  clock: number;
  /** Alliance pairs, as `min*8+max` seat keys. Allies cannot attack each other. */
  allies: number[];
  /** Live fungal insects. */
  insects: Insect[];
  /** Transient cues for the renderer/audio this tick. */
  events: BloomEvent[];
}

/** Are these two seats allied? */
export function isAllied(allies: number[], a: number, b: number): boolean {
  if (a === b) return true;
  const key = a < b ? a * 8 + b : b * 8 + a;
  return allies.includes(key);
}
export function allyKey(a: number, b: number): number {
  return a < b ? a * 8 + b : b * 8 + a;
}

export type BloomEvent =
  | { t: 'claimed'; cell: number; seat: number }
  | { t: 'captured'; cell: number; seat: number; from: number }
  /** The payoff cue: `count` cells were severed from `seat` by a capture at `cause`. */
  | { t: 'severed'; seat: number; count: number; cause: number }
  | { t: 'withered'; cell: number; seat: number }
  | { t: 'spore'; cell: number; seat: number }
  | { t: 'denied'; cell: number; seat: number; reason: 'energy' | 'illegal' }
  | { t: 'hatch'; cell: number; seat: number }
  | { t: 'bite'; cell: number; seat: number }
  | { t: 'eliminated'; seat: number }
  | { t: 'win'; seat: number; reason: 'home' | 'territory' | 'blight' };

// ============================================================ protocol

/** The ONLY gameplay input. One tap. Everything else is derived server-side. */
export interface TapMsg {
  t: 'tap';
  cell: number;
}

/** A tap once the server has resolved which seat sent it. */
export interface SeatTap {
  seat: number;
  cell: number;
}

export type TapKind = 'grow' | 'attack' | 'spore';

// ============================================================ tuning

/** Passive income, energy per second. */
export const ENERGY_PER_SEC = 1 / 3;
/** Extra income per owned `sun` tile, energy per second. */
export const SUN_ENERGY_PER_SEC = 1 / 2;
export const START_ENERGY = 4;
/** Cap, so banking energy is never a strategy. */
export const MAX_ENERGY = 20;
/**
 * Energy per owned tile per second. Territory is now an economy, not just a score:
 * a bigger network funds a faster one, so taking ground compounds.
 */
export const ENERGY_PER_TILE = 0.022;
/** Seconds to take an enemy seedling (home). Deliberately slow and very visible. */
export const HOME_CAPTURE_TIME = 6;

/**
 * Extra energy per friendly neighbour the DEFENDER has around the tile you are
 * taking. A tile deep inside someone's mat is bonded on all four sides and costs
 * a fortune; a lone runner tip costs almost nothing.
 *
 * This is the rule that makes shape matter: thin greedy sprawl is cheap to punish,
 * a solid block is expensive to crack, and cutting a neck is still the bargain
 * because the neck itself has few bonds.
 */
export const BOND_COST = 1.4;
/** Extra seconds per bond, so a bonded tile is slow as well as expensive. */
export const BOND_TIME = 0.35;

// ---------------------------------------------------------------- day / night

/** Seconds for a full day + night. */
export const CYCLE_SEC = 60;
/** Fraction of the cycle that is daytime. */
export const DAY_FRACTION = 0.55;
/** Sun tiles only feed you in daylight, and feed you extra. */
export const DAY_SUN_BONUS = 1.6;
/** FUNGAL creeps this much faster after dark — night is its hour. */
export const NIGHT_CREEP_MUL = 0.5;
/** ...and digests more from every tile it eats. */
export const NIGHT_DIGEST_BONUS = 2;
/** Everything else grows a little slower at night. */
export const NIGHT_GROW_MUL = 1.25;

/** True when `clock` (seconds into the cycle) is daytime. */
export function isDay(clock: number): boolean {
  return clock % CYCLE_SEC < CYCLE_SEC * DAY_FRACTION;
}
/** 0..1 through the current phase — drives the sky tint. */
export function phaseProgress(clock: number): number {
  const t = clock % CYCLE_SEC;
  const dayLen = CYCLE_SEC * DAY_FRACTION;
  return t < dayLen ? t / dayLen : (t - dayLen) / (CYCLE_SEC - dayLen);
}
/** Baseline seconds a severed tile survives, before the owner's `witherMul`. */
export const WITHER_TIME = 2;
export const TERRITORY_FRACTION = 0.6;
export const TERRITORY_HOLD_SEC = 15;
export const MAX_STEP_DT = 0.25;
