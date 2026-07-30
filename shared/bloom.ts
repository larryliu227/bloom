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

/**
 * Board size.
 *
 * 14x22 = 308 cells. Bigger than the original 12x18 on purpose: more room for a
 * runner to matter, more resource tiles to fight over, and enough distance between
 * seedlings that an early rush is a decision rather than the only opening.
 *
 * The ceiling is the phone, not the simulation: the WHOLE board is on screen at all
 * times with no pan and no zoom, so every extra column costs every player cell size.
 * At 14 wide a 393 px phone gives 28 px cells, which the snap radius in the renderer
 * still covers comfortably. Going wider than this starts costing taps.
 */
export const BOARD_W = 14;
export const BOARD_H = 22;
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
   * Which of its owner's separate NETWORKS this cell belongs to — an index into
   * `Board.nets`, or -1 when unowned. Server-computed every tick.
   *
   * A garden that gets cut in half is not one garden with a problem, it is two
   * gardens. Each half earns its own income into its own stores and spends only what
   * it has, which is why a cut hurts even when nothing withers: the half without
   * your granary is suddenly broke.
   */
  net: number;
  /**
   * 1 when a NUTRIENT STORE stands here. Every seedling has one from the start;
   * everything else has to be built (see `STORE_COST`).
   */
  store: number;
  /** Energy held in this store, 0..STORE_CAP. Always 0 where there is no store. */
  fuel: number;
  /**
   * Cells from the nearest store in this same network, or -1 when the network holds
   * none. This is the supply line: a tap costs more the further it is from a store,
   * so the way to push a front forward is to build a granary behind it.
   */
  dist: number;
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

/**
 * One connected network of one seat's tiles — the unit the economy actually runs on.
 *
 * Split a garden and you get two of these, with two separate purses. That is the
 * whole point: cutting somebody used to be a slow death sentence for the far side
 * (it withered), which meant a cut either killed everything behind it or, if they
 * had a store, nothing at all. Now a cut SPLITS THE ECONOMY, immediately, and the
 * far half lives or dies on what it can pay for out of its own granaries.
 */
export interface Net {
  owner: number;
  /**
   * Contains a root — a seedling, or any tile at all for the plants that root
   * anywhere. A network that is NOT live cannot grow and cannot attack: it is a
   * besieged pocket that may only defend itself (see `stepWither` for what happens
   * to a pocket with no store to live off).
   */
  live: boolean;
  tiles: number;
  /** How many granaries stand in it. Zero means a cut of it is a death sentence. */
  stores: number;
  /**
   * Energy banked here, and what this network can hold — its granaries plus the sap
   * in its own tissue (see `SAP_PER_TILE`).
   */
  fuel: number;
  cap: number;
}

export interface Board {
  w: number;
  h: number;
  /** Row-major, length w*h. */
  cells: Cell[];
  /** Every live network on the board, indexed by `Cell.net`. Rebuilt every tick. */
  nets: Net[];
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
 * Upgrades — a shop floor, not a tech LADDER.
 *
 * There are exactly two requirements to buy anything: **be alive, and be able to
 * pay for it.** No prerequisites, no chains, no card that sits there telling you it
 * NEEDS something else first. Every upgrade on your list is one you could buy this
 * second if you held the ground that pays for it.
 *
 * That moves the whole gate onto the MAP. What you can afford is decided by which
 * tiles you are holding right now, in three separate purses:
 *
 *   🜁 ACID  — everyone earns it, and it is the scarcest ground on the board.
 *   ☀ SUN   — daylight only, and LETHAL to FUNGAL and SPORE, who therefore never
 *              see a sun-priced card at all (see `techsFor`).
 *   ▤ WOOD  — anyone can hold timber, so this is the purse you can always open if
 *              you are willing to fight for a stand of it.
 *
 * A purse you cannot fill is a branch of the tree you cannot climb, which is the
 * same pressure the old `requires` chain applied — except you can see it on the
 * board instead of reading it off a card.
 */
export type TechId =
  // shared — anyone may take these
  | 'surge'
  | 'sprig'
  | 'sap'
  | 'deeproot'
  | 'compost'
  | 'heartwood'
  | 'husk'
  | 'solar'
  | 'zenith'
  | 'dew'
  | 'rain'
  | 'veins'
  | 'bulwark'
  | 'reflex'
  // VINE
  | 'whip'
  | 'lash'
  | 'canopy'
  | 'thicket'
  | 'lightning'
  | 'trellis'
  | 'rend'
  // MOSS
  | 'carpet'
  | 'bark'
  | 'bog'
  | 'rampart'
  | 'peat'
  | 'cushion'
  | 'stonemoss'
  // SPORE
  | 'drift'
  | 'pod'
  | 'burst'
  | 'gale'
  | 'bloomburst'
  | 'windborne'
  | 'blight'
  // FUNGAL
  | 'mycelium'
  | 'enzyme'
  | 'bloomcap'
  | 'brood'
  | 'hive'
  | 'rot'
  | 'putrefy'
  | 'spawnsac'
  // THORN
  | 'barbs'
  | 'feed'
  | 'swarm'
  | 'venom'
  | 'bramble'
  | 'spike'
  | 'gorge';

/** Which purse a card is priced in. See the note on `TechId`. */
export type Currency = 'acid' | 'sun' | 'wood';

export const CURRENCIES: readonly Currency[] = ['acid', 'sun', 'wood'];

/** The glyph each purse is drawn with, on the HUD and on every card. */
export const CURRENCY_ICON: Record<Currency, string> = { acid: '🜁', sun: '☀', wood: '▤' };

/**
 * Plants that sunlight kills, and which therefore can never bank a single point of
 * sun. Declared here rather than read off `RoleDef.sunKills` because `rules.ts`
 * (where the roles live) imports this file, not the other way round.
 */
export const SUN_BLIND_ROLES: readonly RoleId[] = ['fungal', 'spore'];

export interface TechDef {
  id: TechId;
  name: string;
  /** Child-readable. No numbers. */
  blurb: string;
  cost: number;
  /** Which purse pays for it. See `Currency`. */
  currency: Currency;
  icon: string;
  /** Undefined = available to everyone. Otherwise only this faction may take it. */
  role?: RoleId;
  /**
   * Factions this tech does nothing for, and which therefore never see it.
   *
   * FUNGAL earns only by digesting, so every per-tile income upgrade is a dead buy
   * for it. Offering a card that provably cannot help is a trap, not a choice.
   */
  notFor?: RoleId[];
  /**
   * Power band, 1..4. Purely how the panel groups the cards — it is NOT a
   * prerequisite depth, because there are no prerequisites. A tier-4 card is simply
   * an expensive one you may buy first if you can somehow pay for it.
   */
  tier: number;
}

export const TECHS: TechDef[] = [
  // ---------------------------------------------------------------- shared
  { id: 'surge', name: 'SURGE', blurb: 'everything grows faster', cost: 8, currency: 'acid', icon: '⚡', tier: 1 },
  { id: 'sprig', name: 'SPRIG', blurb: 'planting costs less', cost: 12, currency: 'acid', icon: '🌱', tier: 2 },
  // FUNGAL eats for free already, so a discount on eating is nothing to it.
  { notFor: ['fungal'], id: 'sap', name: 'SAP', blurb: 'eating costs less', cost: 12, currency: 'wood', icon: '💧', tier: 2 },
  // Neither rot-plant can be cut (both root anywhere), so wither techs are dead buys.
  { notFor: ['fungal', 'spore'], id: 'deeproot', name: 'DEEP ROOT', blurb: 'cut vines hang on longer', cost: 10, currency: 'acid', icon: '⚓', tier: 1 },
  { notFor: ['fungal', 'spore'], id: 'compost', name: 'COMPOST', blurb: 'every tile you hold feeds you more', cost: 12, currency: 'wood', icon: '❂', tier: 2 },
  { id: 'heartwood', name: 'HEARTWOOD', blurb: 'your seedlings take much longer to lose', cost: 20, currency: 'wood', icon: '♥', tier: 3 },
  { id: 'husk', name: 'HUSK', blurb: 'all your ground is tougher to eat', cost: 16, currency: 'wood', icon: '🥥', tier: 3 },
  { id: 'solar', name: 'SOLAR', blurb: 'sun tiles feed you more', cost: 8, currency: 'sun', icon: '☀', tier: 1 },
  { id: 'zenith', name: 'ZENITH', blurb: 'your suns keep feeding after dark', cost: 18, currency: 'sun', icon: '✷', tier: 3 },
  { id: 'dew', name: 'DEW', blurb: 'a steadier trickle of energy', cost: 10, currency: 'sun', icon: '💦', tier: 2 },
  { id: 'rain', name: 'RAIN', blurb: 'the night no longer slows you', cost: 14, currency: 'sun', icon: '🌧', tier: 2 },
  { id: 'veins', name: 'ACID VEINS', blurb: 'acid pools pay you far more', cost: 14, currency: 'acid', icon: '⚗', tier: 2 },
  { id: 'bulwark', name: 'BULWARK', blurb: 'your defence clears a wider ring', cost: 16, currency: 'acid', icon: '⛨', tier: 3 },
  { id: 'reflex', name: 'REFLEX', blurb: 'defend twice as often', cost: 12, currency: 'acid', icon: '⟳', tier: 2 },

  // ---------------------------------------------------------------- VINE
  { id: 'whip', name: 'WHIP', blurb: 'runners go further', cost: 9, currency: 'acid', icon: '➤', role: 'vine', tier: 1 },
  { id: 'lash', name: 'LASH', blurb: 'runners cost less', cost: 14, currency: 'acid', icon: '⇉', role: 'vine', tier: 2 },
  { id: 'canopy', name: 'CANOPY', blurb: 'runners land much faster', cost: 14, currency: 'wood', icon: '❋', role: 'vine', tier: 2 },
  { id: 'trellis', name: 'TRELLIS', blurb: 'cut runners barely rot', cost: 16, currency: 'wood', icon: '⌗', role: 'vine', tier: 2 },
  { id: 'thicket', name: 'THICKET', blurb: 'runners are hard to chew through', cost: 22, currency: 'wood', icon: '፨', role: 'vine', tier: 3 },
  { id: 'lightning', name: 'LIGHTNING', blurb: 'runners cross half the garden', cost: 24, currency: 'acid', icon: '↯', role: 'vine', tier: 3 },
  { id: 'rend', name: 'REND', blurb: 'runners tear straight through enemy ground', cost: 26, currency: 'acid', icon: '⚔', role: 'vine', tier: 4 },

  // ---------------------------------------------------------------- MOSS
  { id: 'carpet', name: 'CARPET', blurb: 'claim a bigger patch', cost: 9, currency: 'acid', icon: '▦', role: 'moss', tier: 1 },
  { id: 'cushion', name: 'CUSHION', blurb: 'patches cost less to lay', cost: 12, currency: 'sun', icon: '☁', role: 'moss', tier: 2 },
  { id: 'bark', name: 'BARK', blurb: 'much harder to eat', cost: 14, currency: 'wood', icon: '🛡', role: 'moss', tier: 2 },
  { id: 'bog', name: 'BOG', blurb: 'never withers', cost: 16, currency: 'acid', icon: '≋', role: 'moss', tier: 2 },
  { id: 'rampart', name: 'RAMPART', blurb: 'they pay dearly for every tile', cost: 22, currency: 'wood', icon: '⛫', role: 'moss', tier: 3 },
  { id: 'peat', name: 'PEAT', blurb: 'your ground feeds you richly', cost: 24, currency: 'wood', icon: '⬛', role: 'moss', tier: 3 },
  { id: 'stonemoss', name: 'STONEMOSS', blurb: 'poison cannot touch your ground', cost: 26, currency: 'acid', icon: '🗿', role: 'moss', tier: 4 },

  // ---------------------------------------------------------------- SPORE
  { id: 'drift', name: 'DRIFT', blurb: 'hop further', cost: 9, currency: 'acid', icon: '❂', role: 'spore', tier: 1 },
  { id: 'pod', name: 'POD', blurb: 'spores cost less', cost: 14, currency: 'acid', icon: '◍', role: 'spore', tier: 2 },
  { id: 'burst', name: 'BURSTPOD', blurb: 'landings spread out', cost: 14, currency: 'wood', icon: '✺', role: 'spore', tier: 2 },
  { id: 'windborne', name: 'WINDBORNE', blurb: 'landings are much tougher', cost: 16, currency: 'wood', icon: '🌀', role: 'spore', tier: 2 },
  { id: 'gale', name: 'GALE', blurb: 'hop clean across the garden', cost: 22, currency: 'acid', icon: '≈', role: 'spore', tier: 3 },
  { id: 'bloomburst', name: 'BLOOMBURST', blurb: 'landings spread twice as far', cost: 24, currency: 'wood', icon: '❊', role: 'spore', tier: 3 },
  { id: 'blight', name: 'BLIGHT', blurb: 'your poison swallows a wider block', cost: 26, currency: 'acid', icon: '☢', role: 'spore', tier: 4 },

  // ---------------------------------------------------------------- FUNGAL
  { id: 'mycelium', name: 'MYCELIUM', blurb: 'creeps much faster', cost: 9, currency: 'acid', icon: '🍄', role: 'fungal', tier: 1 },
  { id: 'enzyme', name: 'ENZYME', blurb: 'eating feeds you more', cost: 14, currency: 'wood', icon: '🧪', role: 'fungal', tier: 2 },
  { id: 'bloomcap', name: 'BLOOMCAP', blurb: 'eaten tiles creep too', cost: 14, currency: 'acid', icon: '✿', role: 'fungal', tier: 2 },
  { id: 'putrefy', name: 'PUTREFY', blurb: 'chews through tiles far faster', cost: 16, currency: 'wood', icon: '⚱', role: 'fungal', tier: 2 },
  { id: 'rot', name: 'ROT', blurb: 'the mycelium never stops', cost: 24, currency: 'wood', icon: '☣', role: 'fungal', tier: 3 },
  { id: 'spawnsac', name: 'SPAWNSAC', blurb: 'insects live far longer', cost: 20, currency: 'wood', icon: '🥚', role: 'fungal', tier: 3 },
  /*
   * The insects are FUNGAL's endgame, and they are priced like it. Nothing else in
   * the game costs anything close — this is what a whole match of digesting other
   * people's gardens is FOR, and until you buy it the mycelium has no swarm at all.
   */
  { id: 'brood', name: 'BROOD', blurb: 'the mycelium starts hatching insects', cost: 100, currency: 'acid', icon: '🐛', role: 'fungal', tier: 4 },
  // Says BROOD out loud: with no prerequisites to lock it, the blurb is the only
  // thing standing between a player and a card that does nothing on its own.
  { id: 'hive', name: 'HIVE', blurb: 'once BROOD hatches them: many more insects, far cheaper', cost: 24, currency: 'acid', icon: '🐝', role: 'fungal', tier: 4 },

  // ---------------------------------------------------------------- THORN
  { id: 'barbs', name: 'BARBS', blurb: 'eat much faster', cost: 9, currency: 'acid', icon: '✖', role: 'thorn', tier: 1 },
  { id: 'spike', name: 'SPIKE', blurb: 'your thorns are much tougher', cost: 12, currency: 'sun', icon: '✧', role: 'thorn', tier: 2 },
  { id: 'feed', name: 'FEED', blurb: 'eating gives energy', cost: 14, currency: 'wood', icon: '🍖', role: 'thorn', tier: 2 },
  { id: 'swarm', name: 'SWARM', blurb: 'eating spreads twice as far', cost: 14, currency: 'acid', icon: '⁂', role: 'thorn', tier: 2 },
  { id: 'gorge', name: 'GORGE', blurb: 'every bite is a meal', cost: 20, currency: 'sun', icon: '🍯', role: 'thorn', tier: 3 },
  { id: 'venom', name: 'VENOM', blurb: 'eating costs almost nothing', cost: 22, currency: 'acid', icon: '☠', role: 'thorn', tier: 3 },
  { id: 'bramble', name: 'BRAMBLE', blurb: 'eating spreads three times as far', cost: 24, currency: 'wood', icon: '҉', role: 'thorn', tier: 3 },
];

/**
 * Techs this faction may ever take.
 *
 * Three filters, and none of them is a prerequisite:
 *  - it belongs to another faction;
 *  - it provably does nothing for this one (`notFor`);
 *  - it is priced in a purse this plant can never fill. FUNGAL and SPORE die on
 *    sunlight, so a sun-priced card is not a hard buy for them, it is an impossible
 *    one — and a card you can look at forever and never own is a trap, not a choice.
 */
export function techsFor(role: RoleId): TechDef[] {
  const sunBlind = SUN_BLIND_ROLES.includes(role);
  return TECHS.filter(
    (t) =>
      (t.role === undefined || t.role === role) &&
      !t.notFor?.includes(role) &&
      !(sunBlind && t.currency === 'sun'),
  );
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
/** HUSK / SPIKE / WINDBORNE: flat multipliers on how long YOUR tiles take to eat. */
export const TECH_HUSK_TOUGH = 1.5;
export const TECH_SPIKE_TOUGH = 1.7;
export const TECH_WINDBORNE_TOUGH = 1.8;
/** TRELLIS: a cut runner rots at a quarter speed. */
export const TECH_TRELLIS_WITHER = 0.25;
/** PUTREFY: multiplier on FUNGAL's capture time. */
export const TECH_PUTREFY_CAPTURE = 0.55;
/** ACID VEINS: multiplier on everything your acid pools pay. */
export const TECH_VEINS_MUL = 1.7;
/** DEW: extra flat energy per second, on top of the baseline trickle. */
export const TECH_DEW_ENERGY = 0.4;
/** GORGE: energy per tile eaten, on top of FEED. */
export const TECH_GORGE_ENERGY = 4;
/** SPAWNSAC: multiplier on how long a hatched insect lives. */
export const TECH_SPAWNSAC_LIFE = 2;
/**
 * BLIGHT: extra width and height on HOSTILE TAKEOVER's block.
 *
 * Two, not four. A 9x9 covers 26% of a 308-cell board where it covered 37% of the
 * old 216-cell one, so +2 (11x11, 39%) restores the proportion the nuke was tuned
 * at; +4 would put 55% of the garden under one repeatable 1-acid tap.
 */
export const TECH_BLIGHT_SIZE = 2;
/** BULWARK: extra rings of enemy ground a defence clears. */
export const TECH_BULWARK_RADIUS = 1;
/** REFLEX: multiplier on the shared defence cooldown. */
export const TECH_REFLEX_COOLDOWN = 0.5;

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
   * The three purses the tech tree accepts. See the note on `TechId`.
   *
   * Deliberately separate from energy: energy is the moment-to-moment budget for
   * taps, and tech used to compete with it directly, so every upgrade was paid for
   * by not playing for a while. These are paid ONLY by the ground you are holding,
   * which puts the whole tree behind map control rather than behind patience — and
   * three purses rather than one means WHICH ground you hold decides which half of
   * your list you can actually reach.
   */
  acid: number;
  /** Banked sunlight. Daylight only, and FUNGAL/SPORE can never earn a point of it. */
  sun: number;
  /** Banked timber. Anyone may hold a stand of wood, so this purse is never closed. */
  wood: number;
  /** Seconds until this seat may repel again. 0 when ready. */
  repelCooldown: number;
  /**
   * This garden's colour on the board, fixed for the match.
   *
   * Belongs to the SEAT, not the plant: two players may draft the same plant, so
   * faction colour cannot tell two gardens apart.
   */
  colour: string;
  /**
   * Total energy across ALL this seat's stores, and what they could hold.
   *
   * A convenience total for the HUD and the win check — it is NOT a purse. Energy is
   * spent out of one network's stores (see `Net`), so holding 40 across two cut-off
   * halves does not buy you a 40-energy push anywhere.
   */
  energy: number;
  cap: number;
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
  /** A nutrient store went up. */
  | { t: 'built'; cell: number; seat: number }
  /** A store changed hands with `fuel` energy in it. `from` lost the lot. */
  | { t: 'looted'; cell: number; seat: number; from: number; fuel: number }
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
/** Acid per owned `acid` tile per second. The scarcest purse, and the most fought over. */
export const ACID_PER_SEC = 0.42;
/**
 * Sun banked per owned `sun` tile per second, IN DAYLIGHT ONLY (ZENITH keeps it
 * running after dark, exactly as it does for sun energy). Slower than acid per tile
 * because there are more suns on a board than there are acid pools.
 */
export const SUN_BANK_PER_SEC = 0.3;
/** Timber banked per owned `wood` tile per second. Paid to everyone who holds one. */
export const WOOD_BANK_PER_SEC = 0.3;

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

// ---------------------------------------------------------------- nutrient stores

/**
 * Energy is not a number in the sky. It is a physical thing, held in granaries that
 * stand on the board, and everything follows from that:
 *
 *  - **It is capped.** One store holds STORE_CAP. When your network's stores are
 *    full, income stops — you are not banking any more until you BUILD somewhere to
 *    put it. Idling therefore costs you, and expanding is how you keep earning.
 *  - **It is local.** A store belongs to the network it stands in, so a cut garden
 *    is two economies. See `Net`.
 *  - **It is stealable.** Take a store and you take everything in it (`STEAL_CAP`),
 *    which makes a granary the most valuable square on the board after a seedling
 *    and makes a raid behind the lines a real play instead of a nuisance.
 *  - **It is a supply line.** A tap costs more the further it is from a store, so
 *    the way to attack something far away is to build a granary near it first.
 *
 * Every seedling comes with one already built, holding START_ENERGY.
 */
export const STORE_CAP = 25;
/** Energy to build another. Paid out of the network that will own it. */
export const STORE_COST = 8;
/**
 * Energy every ordinary tile can hold in its own tissue, granary or no granary.
 *
 * Small, and load-bearing. Without it a network with no store had a capacity of
 * zero, which meant it earned nothing, which meant it could never afford the store
 * that would let it earn — every spore landing, every infected clump and every
 * re-grown limb was born permanently inert. Measured: it took SPORE from a third of
 * the board to five percent and no wins in forty matches.
 *
 * So a clump of plants holds sap between them. Two per tile is the smallest number
 * that works: it is exactly one spore landing, so a single-tile beachhead can act
 * once and is therefore not stillborn, and a dozen-tile clump can save up a granary
 * — which is the bootstrap. It is nowhere near enough to run a war on, which is why
 * you still build, and it caps out long before a real army does.
 */
export const SAP_PER_TILE = 2;
/**
 * Extra cost per cell of distance from the nearest store, as a fraction of the base
 * price. Applies to growing, attacking AND defending — everything is harder to do
 * at the end of a long supply line.
 */
export const DIST_COST_PER_CELL = 0.12;
/** ...and the ceiling on that, so the far corner of the map is expensive, not impossible. */
export const DIST_COST_MAX = 2.5;
/**
 * Fraction of a captured store's contents the raider keeps. All of it — a granary
 * that survived being taken would not be worth taking.
 */
export const STEAL_CAP = 1;
/**
 * Energy per owned tile per second. Territory is now an economy, not just a score:
 * a bigger network funds a faster one, so taking ground compounds.
 */
export const ENERGY_PER_TILE = 0.022;
/** Seconds to take an enemy seedling (home). Deliberately slow and very visible. */
export const HOME_CAPTURE_TIME = 6;

/**
 * DEFENCE — tap ANY tile you own to shove the enemy off the ground around it.
 *
 * Two separate things happen, and they are tuned against each other:
 *
 *  1. Enemy TILES inside the kill ring are destroyed outright — burned back to bare
 *     soil, not captured. This is the part with teeth: a defence deletes a lodgement
 *     rather than politely asking it to leave, and because the ground comes up
 *     NEUTRAL it is a denial, not a free harvest. Whoever taps first gets the empty
 *     ground next.
 *  2. Enemy CLAIMS in progress inside the (wider) knockback ring are pushed back a
 *     fraction, exactly as they always were.
 *
 * Splitting it that way is deliberate. A defence that also erased an assault in
 * progress would mean a seedling could never fall to anyone whose opponent happened
 * to be paying attention, which turns the most decisive play in the game into a test
 * of who was looking at their phone. So the numbers on a seedling siege are
 * unchanged: the attacker still wins that exchange on time.
 *
 * Every tile defends, not just the seedling — a garden is a thing that fights back
 * everywhere — but a seedling defends a ring wider than an ordinary tile does.
 *
 * A defence that finds nothing to push costs nothing and starts no cooldown, so
 * mashing it is pointless rather than ruinous.
 */
export const REPEL_COST = 2;
/**
 * ...plus this much per tile destroyed. Burning twelve tiles off your doorstep is a
 * real play and it costs real energy; if you cannot pay for all of them you clear
 * the nearest ones you CAN afford rather than being refused outright.
 */
export const REPEL_KILL_COST = 1;
/** Manhattan radius in which hostile claims in progress are knocked back. */
export const REPEL_RADIUS = 2;
/** Manhattan radius in which enemy TILES are destroyed, from an ordinary tile... */
export const REPEL_KILL_RADIUS = 1;
/** ...and from a seedling, which defends itself far more fiercely. */
export const REPEL_HOME_KILL_RADIUS = 2;
/**
 * Fraction of an assault's progress a repel removes. Deliberately less than the
 * attacker regains before the cooldown is up — see the note above.
 */
export const REPEL_KNOCKBACK = 0.35;
/** Seconds before that seat may defend again, from anywhere. One shared cooldown. */
export const REPEL_COOLDOWN = 4;

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

