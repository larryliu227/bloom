/**
 * BLOOM — core domain types.
 *
 * Single source of truth for board and match state. Server mutates, client renders.
 * The board is deliberately small: the whole thing ships in every snapshot, which
 * removes an entire class of desync bugs and still compresses to almost nothing.
 */

export type PlayerId = string;
export type RoomId = string;

/** Board archetypes. Defined in `garden.ts`, which owns generation. */
export type MapKind = 'open' | 'walled' | 'warren' | 'pillars';

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
  | 'sun' // energy for the photosynthesisers. LETHAL to fungal and spore.
  | 'wood' // FUNGAL's larder: the only thing that pays it. Braces its holder's defence.
  | 'insect' // SPORE's larder: the only thing that pays it. Rots everyone else's defence.
  | 'acid' // pays ACID, and acid is the only thing that buys tech. Contested by all five.
  | 'home'; // a player's root. Lose the ability to grow from it and you are out.

/** The four tiles that pay something. Everything else is just ground. */
export const RESOURCE_KINDS: readonly CellKind[] = ['sun', 'wood', 'insect', 'acid'];

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
  /**
   * Cell index of each seat's CURRENT primary seedling, indexed by seat; -1 once
   * they hold none and are out.
   *
   * Not the whole story, and deliberately not the source of truth: seedlings change
   * hands, so a seat can hold several. The real answer to "is this a root" is
   * `cell.kind === 'home' && cell.owner === seat`, which is what connectivity and
   * the render pulse both use. This field is a convenience for "where did this seat
   * live", nothing more.
   */
  homes: number[];
  /**
   * Which archetype this board was cut from. Terrain decides which verbs are good
   * here, so the client names it on the plant-choice screen — picking SPORE on a
   * walled map or VINE on an open one is the decision, and it needs the label.
   */
  kind: MapKind;
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
   * Bonds do not apply to this plant, in cost or in time.
   *
   * The bond rule — a tile buried in a mat is expensive and slow, an exposed tip is
   * cheap — is what makes SHAPE matter, and it is aimed at plants that advance by
   * pushing a front forward. Neither of the two that ignore adjacency is doing that:
   * SPORE lands behind you and FUNGAL rots outward from wherever it already is, so
   * charging them for the thickness of a mat they never had to walk through was
   * taxing them for a geometry they do not play in.
   */
  ignoresBonds?: boolean;
  /** Sunlight is lethal to this plant: it can never hold a `sun` cell. */
  sunKills?: boolean;
  /** HOSTILE TAKEOVER does not touch this plant's tiles. FUNGAL and SPORE only. */
  poisonImmune?: boolean;
  /**
   * This plant's tiles brace nothing: attacking one costs no bond surcharge and
   * takes no bond delay, however deep in the mat it sits.
   *
   * The defensive half of the same idea. A mycelium is loose mush with no structure
   * to it — there is nothing for a neighbouring tile to hold on to — so a mat of it
   * is exactly as cheap to chew at the middle as at the edge. It is also the price
   * of the offensive exemption: a plant that pays nobody's bonds should not be
   * collecting everybody else's.
   */
  noBondDefence?: boolean;
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
 * Upgrades — a real tree, not a shopping list.
 *
 * Shared: TWO chains three deep, and you cannot afford both. SURGE leads to the
 * sun (a fast, greedy economy); DEEP ROOT leads to compost and heartwood (a tough,
 * slow one). Picking one is picking how you intend to win.
 *
 * Faction: one opener, then a FORK — two tier-2s off it, each with its own tier-3.
 * So two VINEs can end the match with genuinely different vines, and the shape of
 * the tree tells you that before you commit. `requires` is enforced in the model
 * (see `Garden.buyTech`), never merely hidden in the UI.
 */
export type TechId =
  // shared — two chains, three deep each
  | 'surge'
  | 'solar'
  | 'zenith'
  | 'deeproot'
  | 'compost'
  | 'heartwood'
  // VINE
  | 'whip'
  | 'lash'
  | 'canopy'
  | 'thicket'
  | 'lightning'
  // MOSS
  | 'carpet'
  | 'bark'
  | 'bog'
  | 'rampart'
  | 'peat'
  // SPORE
  | 'drift'
  | 'pod'
  | 'burst'
  | 'gale'
  | 'bloomburst'
  // FUNGAL
  | 'mycelium'
  | 'enzyme'
  | 'bloomcap'
  | 'brood'
  | 'hive'
  | 'rot'
  // THORN
  | 'barbs'
  | 'feed'
  | 'swarm'
  | 'venom'
  | 'bramble';

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
  /**
   * Factions this tech does nothing for, and which therefore never see it.
   *
   * FUNGAL earns only by digesting, so every income upgrade in the shared tree is a
   * dead buy for it. Offering a card that provably cannot help is a trap, not a
   * choice.
   */
  notFor?: RoleId[];
  tier: number;
}

export const TECHS: TechDef[] = [
  // --- shared: the greedy chain
  { id: 'surge', name: 'SURGE', blurb: 'everything grows faster', cost: 8, icon: '⚡', tier: 1 },
  { notFor: ['fungal'], id: 'solar', name: 'SOLAR', blurb: 'sun tiles feed you more', cost: 14, icon: '☀', tier: 2, requires: 'surge' },
  { notFor: ['fungal'], id: 'zenith', name: 'ZENITH', blurb: 'your suns keep feeding after dark', cost: 22, icon: '✷', tier: 3, requires: 'solar' },

  // --- shared: the stubborn chain
  { notFor: ['fungal'], id: 'deeproot', name: 'DEEP ROOT', blurb: 'cut vines hang on longer', cost: 10, icon: '⚓', tier: 1 },
  { notFor: ['fungal'], id: 'compost', name: 'COMPOST', blurb: 'every tile you hold feeds you more', cost: 15, icon: '❂', tier: 2, requires: 'deeproot' },
  { id: 'heartwood', name: 'HEARTWOOD', blurb: 'your seedlings take much longer to lose', cost: 24, icon: '♥', tier: 3, requires: 'compost' },

  // --- VINE: distance, then a fork between tough runners and long ones
  { id: 'whip', name: 'WHIP', blurb: 'runners go further', cost: 9, icon: '➤', role: 'vine', tier: 1 },
  { id: 'lash', name: 'LASH', blurb: 'runners cost less', cost: 16, icon: '⇉', role: 'vine', tier: 2, requires: 'whip' },
  { id: 'canopy', name: 'CANOPY', blurb: 'runners land much faster', cost: 16, icon: '❋', role: 'vine', tier: 2, requires: 'whip' },
  { id: 'thicket', name: 'THICKET', blurb: 'runners are hard to chew through', cost: 24, icon: '፨', role: 'vine', tier: 3, requires: 'lash' },
  { id: 'lightning', name: 'LIGHTNING', blurb: 'runners cross half the garden', cost: 26, icon: '↯', role: 'vine', tier: 3, requires: 'canopy' },

  // --- MOSS: bulk, then a fork between armour and permanence
  { id: 'carpet', name: 'CARPET', blurb: 'claim a bigger patch', cost: 9, icon: '▦', role: 'moss', tier: 1 },
  { id: 'bark', name: 'BARK', blurb: 'much harder to eat', cost: 16, icon: '🛡', role: 'moss', tier: 2, requires: 'carpet' },
  { id: 'bog', name: 'BOG', blurb: 'never withers', cost: 16, icon: '≋', role: 'moss', tier: 2, requires: 'carpet' },
  { id: 'rampart', name: 'RAMPART', blurb: 'they pay dearly for every tile', cost: 24, icon: '⛨', role: 'moss', tier: 3, requires: 'bark' },
  { id: 'peat', name: 'PEAT', blurb: 'your ground feeds you richly', cost: 26, icon: '⬛', role: 'moss', tier: 3, requires: 'bog' },

  // --- SPORE: reach, then a fork between range and spread
  { id: 'drift', name: 'DRIFT', blurb: 'hop further', cost: 9, icon: '❂', role: 'spore', tier: 1 },
  { id: 'pod', name: 'POD', blurb: 'spores cost less', cost: 16, icon: '◍', role: 'spore', tier: 2, requires: 'drift' },
  { id: 'burst', name: 'BURSTPOD', blurb: 'landings spread out', cost: 16, icon: '✺', role: 'spore', tier: 2, requires: 'drift' },
  { id: 'gale', name: 'GALE', blurb: 'hop clean across the garden', cost: 24, icon: '≈', role: 'spore', tier: 3, requires: 'pod' },
  { id: 'bloomburst', name: 'BLOOMBURST', blurb: 'landings spread twice as far', cost: 26, icon: '❊', role: 'spore', tier: 3, requires: 'burst' },

  // --- FUNGAL: creep, then a fork between the swarm and the rot
  { id: 'mycelium', name: 'MYCELIUM', blurb: 'creeps much faster', cost: 9, icon: '🍄', role: 'fungal', tier: 1 },
  { id: 'enzyme', name: 'ENZYME', blurb: 'eating feeds you more', cost: 16, icon: '🧪', role: 'fungal', tier: 2, requires: 'mycelium' },
  { id: 'bloomcap', name: 'BLOOMCAP', blurb: 'eaten tiles creep too', cost: 16, icon: '✿', role: 'fungal', tier: 2, requires: 'mycelium' },
  /*
   * The insects are FUNGAL's endgame, and they are priced like it. Nothing else in
   * the tree costs anything close — this is what a whole match of digesting other
   * people's gardens is FOR, and until you buy it the mycelium has no swarm at all.
   */
  { id: 'brood', name: 'BROOD', blurb: 'the mycelium starts hatching insects', cost: 100, icon: '🐛', role: 'fungal', tier: 3, requires: 'enzyme' },
  { id: 'rot', name: 'ROT', blurb: 'the mycelium never stops', cost: 26, icon: '☣', role: 'fungal', tier: 3, requires: 'bloomcap' },
  { id: 'hive', name: 'HIVE', blurb: 'many more insects, far cheaper', cost: 24, icon: '🐝', role: 'fungal', tier: 4, requires: 'brood' },

  // --- THORN: contact, then a fork between cheap bites and wide ones
  { id: 'barbs', name: 'BARBS', blurb: 'eat much faster', cost: 9, icon: '✖', role: 'thorn', tier: 1 },
  { id: 'feed', name: 'FEED', blurb: 'eating gives energy', cost: 16, icon: '🍖', role: 'thorn', tier: 2, requires: 'barbs' },
  { id: 'swarm', name: 'SWARM', blurb: 'eating spreads twice as far', cost: 16, icon: '⁂', role: 'thorn', tier: 2, requires: 'barbs' },
  { id: 'venom', name: 'VENOM', blurb: 'eating costs almost nothing', cost: 24, icon: '☠', role: 'thorn', tier: 3, requires: 'feed' },
  { id: 'bramble', name: 'BRAMBLE', blurb: 'eating spreads three times as far', cost: 26, icon: '҉', role: 'thorn', tier: 3, requires: 'swarm' },
];

/** Techs this faction may ever take, in tree order. */
export function techsFor(role: RoleId): TechDef[] {
  /*
   * Transitive, deliberately: a tech whose prerequisite this faction can never buy
   * is just as unbuyable as one it is barred from outright.
   *
   * FUNGAL is why. Excluding the income upgrades left HEARTWOOD on its list saying
   * "NEEDS COMPOST" — a card it could look at forever and never own. Resolving to a
   * fixed point means barring one tech automatically bars everything downstream of
   * it, so this cannot rot the next time an exclusion is added.
   */
  const offered = TECHS.filter(
    (t) => (t.role === undefined || t.role === role) && !t.notFor?.includes(role),
  );
  const reachable = new Set<TechId>();
  for (let pass = 0; pass < offered.length; pass++) {
    let grew = false;
    for (const t of offered) {
      if (reachable.has(t.id)) continue;
      if (t.requires && !reachable.has(t.requires)) continue;
      reachable.add(t.id);
      grew = true;
    }
    if (!grew) break;
  }
  return TECHS.filter((t) => reachable.has(t.id));
}

// Tuning for the effects above.
export const TECH_GROW_SPEED = 0.65;
/** ZENITH: fraction of full daylight your suns still yield after dark. */
export const TECH_ZENITH_NIGHT = 0.8;
/** COMPOST / PEAT: extra energy per owned tile per second. */
export const TECH_COMPOST_TILE = 0.02;
export const TECH_PEAT_TILE = 0.035;
/** HEARTWOOD: multiplier on how long YOUR seedlings take an enemy to crack. */
export const TECH_HEARTWOOD = 2.2;
/** RAMPART: multiplier on the bond cost an attacker pays against your tiles. */
export const TECH_RAMPART_BOND = 2.2;
/** HIVE: extra insects alive at once, and the discount on hatching one. */
export const TECH_HIVE_CAP = 3;
export const TECH_HIVE_DISCOUNT = 2;
export const TECH_WITHER_MUL = 0.45;
export const TECH_SOLAR_BONUS = 0.5;
export const TECH_BARK_TOUGH = 2;
export const TECH_FEED_ENERGY = 2;
export const TECH_ENZYME_BONUS = 2;

// ============================================================ match

export type GameMode = 'duel' | 'garden' | 'coop_blight';
/**
 * `draft` is the window between the board existing and the match starting: the map
 * is generated and everyone can see it and their own seedling, but nothing is
 * simulated yet because nobody has a plant.
 */
export type MatchPhase = 'lobby' | 'countdown' | 'draft' | 'playing' | 'complete';

export interface Seat {
  seat: number;
  playerId: PlayerId;
  name: string;
  /** null until this seat has drafted a plant. See `MatchPhase.draft`. */
  role: RoleId | null;
  /**
   * Banked acid. The ONLY currency the tech tree accepts, for every faction.
   *
   * Deliberately separate from energy: energy is the moment-to-moment budget for
   * taps, and tech used to compete with it directly, so every upgrade was paid for
   * by not playing for a while. Acid comes only from `acid` tiles, which means the
   * tech tree is gated behind map control rather than behind patience.
   */
  acid: number;
  /** Seconds until this seat may repel again. 0 when ready. */
  repelCooldown: number;
  /**
   * This garden's colour on the board, fixed for the match.
   *
   * Belongs to the SEAT, not the plant: two players may draft the same plant, so
   * faction colour cannot tell two gardens apart.
   */
  colour: string;
  energy: number;
  /** Live count of owned cells — drives the win check and the HUD bar. */
  tiles: number;
  alive: boolean;
  connected: boolean;
  isBot: boolean;
  /**
   * Upgrades bought, in purchase order.
   *
   * Lives on the seat — and therefore in every snapshot — because the tech panel
   * has to grey out what you already own, and online that answer is the server's
   * to give. When this was private to the simulation the client had no way to know
   * it without running its own copy of the rules.
   */
  techs: TechId[];
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
/**
 * Energy the mycelium pays to hatch one — AFTER the BROOD tech has been bought.
 * Insects are locked entirely until then; see `TECHS`.
 */
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
  /** Seconds left to choose a plant. Only meaningful while `phase` is `draft`. */
  draftTimer: number;
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
  /**
   * The payoff cue: `count` cells were severed from `seat` by a capture at cell
   * `cause`, made by seat `by`. Both are -1 when nothing this tick explains the
   * cut (a tile withering can orphan the tiles behind it with nobody to credit).
   *
   * `by` exists because it is the score that matters: how much of someone else's
   * garden you killed without ever touching it.
   */
  | { t: 'severed'; seat: number; count: number; cause: number; by: number }
  | { t: 'withered'; cell: number; seat: number }
  | { t: 'spore'; cell: number; seat: number }
  | { t: 'denied'; cell: number; seat: number; reason: 'energy' | 'illegal' }
  | { t: 'hatch'; cell: number; seat: number }
  /** An insect ate a tile: `seat` took `cell` off `from`. */
  | { t: 'bite'; cell: number; seat: number; from: number }
  /** A seedling shrugged off an assault: `count` hostile claims/tiles pushed back. */
  | { t: 'repel'; cell: number; seat: number; count: number }
  /** HOSTILE TAKEOVER landed: `cell` is the centre, `cleared` tiles evaporated. */
  | { t: 'takeover'; cell: number; seat: number; cleared: number; seeded: number }
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

export type TapKind = 'grow' | 'attack' | 'spore' | 'repel';

// ============================================================ tuning

/** Passive income, energy per second. */
export const ENERGY_PER_SEC = 1 / 3;
/** Extra income per owned `sun` tile, energy per second. */
export const SUN_ENERGY_PER_SEC = 1 / 2;
/** Energy per owned `wood` tile per second. FUNGAL's only wage. */
export const WOOD_ENERGY_PER_SEC = 0.55;
/** Energy per owned `insect` tile per second. SPORE's only wage. */
export const INSECT_ENERGY_PER_SEC = 0.55;
/**
 * What a SPORE earns while it holds NO insect bed at all.
 *
 * A starvation valve, not an income. FUNGAL cannot lock up because its bite is free
 * and its creep is free, so it always has an action and always eventually reaches
 * something to eat. SPORE pays 2 for every landing and has no free move, so a spore
 * that never reaches a grub bed is broke forever — measured at 1 match in 40, which
 * is rare and still a player who cannot play. A drifting spore stays barely alive;
 * the trickle stops the moment it holds a bed of its own.
 */
export const SPORE_DRIFT_PER_SEC = 0.17;
/** Acid per owned `acid` tile per second. The whole tech economy runs on this. */
export const ACID_PER_SEC = 0.42;

/**
 * Terrain multipliers on how long an attacker needs to take a tile.
 *
 * WOOD braces whoever stands on it — except THORN, which is a parasite with no use
 * for timber and is left weaker there than on bare soil. INSECT ground is crawling
 * and rotten: it makes its holder fragile, unless that holder is SPORE (whose larder
 * it is) and to a lesser degree FUNGAL, which is at home in anything decomposing.
 */
export const WOOD_DEFENCE = 2;
export const WOOD_THORN_DEFENCE = 0.5;
export const INSECT_DEFENCE = 0.4;
export const INSECT_FUNGAL_DEFENCE = 0.75;
/**
 * SPORE on a grub bed is a fortress. Not braced — immovable.
 *
 * The beds are SPORE's entire income, there are only three or four on a board, and
 * SPORE is otherwise the flimsiest defender in the game. At neutral (1.0) it would
 * take a bed, lose it, drop to the drift trickle and freeze: 2.3 average tiles and
 * not one win in 200 matches. So the one ground it cares about is ground almost
 * nobody can shift it off. Prising a bed out of a SPORE is a project, and that is
 * the whole shape of the faction — it owns four squares on the map and it owns them
 * completely.
 */
export const INSECT_SPORE_DEFENCE = 8;

/**
 * HOSTILE TAKEOVER — SPORE's item, and the only one in the game.
 *
 * One acid to instantly evaporate every tile in a 9x9 block and sprinkle the ruins
 * with landings. FUNGAL and SPORE tiles are immune, so it clears the photosynthesisers
 * out of a third of the board and leaves the two rot-plants standing in it.
 *
 * Priced at ONE deliberately. At ten it was a thing you saved up for and fired twice
 * a match, which is not what SPORE needed — its problem was never a lack of one big
 * moment, it was an economy that could not compound (measured: it never held more
 * than a single grub bed, and finished matches on two or three tiles). At one acid the
 * missile IS the faction: hold a puddle of acid and you are firing constantly, and the
 * board belongs to whoever can live in the rubble. Which, by design, is only SPORE and
 * FUNGAL.
 */
export const TAKEOVER_COST = 1;
export const TAKEOVER_SIZE = 9;
/** Fraction of the cleared cells that come up as SPORE landings. */
export const TAKEOVER_SEED_FRACTION = 0.34;
export const START_ENERGY = 4;
/*
 * There is no energy cap. Banking is a legitimate strategy: sit on your income and
 * spend it all at once on a push, a seedling, or the top of a tech branch.
 */
/**
 * Energy per owned tile per second. Territory is now an economy, not just a score:
 * a bigger network funds a faster one, so taking ground compounds.
 */
export const ENERGY_PER_TILE = 0.022;
/** Seconds to take an enemy seedling (home). Deliberately slow and very visible. */
export const HOME_CAPTURE_TIME = 6;

/**
 * Tap your OWN seedling to repel: it costs this much and shoves the enemy back.
 *
 * The counter-play to a seedling assault — but deliberately a DELAYING one, not an
 * answer. The attacker holds the advantage here on purpose: they chose the moment,
 * they are looking at the fight, and nothing warns the defender that their heart is
 * being eaten. A repel that simply erased an assault would mean a base could never
 * fall to anyone whose opponent happened to be paying attention, which turns the
 * most decisive play in the game into a test of who was looking at their phone.
 *
 * So a repel BUYS TIME. It knocks the assault back part way and then goes on
 * cooldown, and sustained pressure gets through: against a defender repelling on
 * every cooldown, a seedling still falls in roughly twenty seconds instead of six.
 *
 * A repel that finds nothing to push costs nothing, so mashing it is not a trap.
 */
export const REPEL_COST = 2;
/** Manhattan radius around the seedling in which hostile claims are knocked back. */
export const REPEL_RADIUS = 2;
/**
 * Fraction of an assault's progress a repel removes. Deliberately less than the
 * attacker regains before the cooldown is up — see the note above.
 */
export const REPEL_KNOCKBACK = 0.35;
/** Seconds before that seat may repel again. */
export const REPEL_COOLDOWN = 3;

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

/**
 * Seconds to look at the map and choose a plant.
 *
 * Long enough to actually read the board — where your seedling is, what is walled
 * off, which suns you can reach — and short enough that nobody is held hostage by
 * someone else deliberating. Anyone who runs out gets a free plant assigned.
 */
export const DRAFT_SEC = 20;

