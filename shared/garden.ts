/**
 * BLOOM — the garden. The rules of the game, running.
 *
 * ONE simulation, used in two places:
 *
 *   1. THE SERVER, as authority. `server/room.ts` owns an instance, feeds it taps
 *      it has verified came from the right seat, and ships the resulting state to
 *      every client at SNAPSHOT_RATE.
 *   2. THE CLIENT, for solo play and for the live board behind the menus. No
 *      socket, no waiting — the same rules, refereed locally.
 *
 * It is deliberately the same file for both. A second implementation of "what does
 * a tap do" is a desync generator: the two drift, and the game starts lying to
 * whichever side is wrong. Nothing here touches the DOM, the socket, or the clock —
 * `step(dt)` is the only way time passes, so the caller owns pacing.
 *
 * Determinism is NOT relied upon. The server ships whole board states rather than
 * inputs, so `rng` divergence between two machines is harmless by construction.
 */

import type { Board, Cell, GameMode, MapKind, MatchState, RoleDef, RoleId, Seat, TechId } from './bloom.js';
import { BOARD_H, BOARD_W, SPORE_DRIFT_PER_SEC, TAKEOVER_COST, TAKEOVER_SIZE, TAKEOVER_SEED_FRACTION, ACID_PER_SEC, WOOD_ENERGY_PER_SEC, INSECT_ENERGY_PER_SEC, DRAFT_SEC, REPEL_COST, REPEL_COOLDOWN, REPEL_KNOCKBACK, REPEL_RADIUS, TECHS, TECH_ZENITH_NIGHT, TECH_COMPOST_TILE, TECH_PEAT_TILE, TECH_HEARTWOOD, TECH_RAMPART_BOND, TECH_HIVE_CAP, TECH_HIVE_DISCOUNT, TECH_BARK_TOUGH, TECH_ENZYME_BONUS, TECH_FEED_ENERGY, ENERGY_PER_TILE, ENERGY_PER_SEC, SUN_ENERGY_PER_SEC, START_ENERGY, WITHER_TIME, TERRITORY_FRACTION, TERRITORY_HOLD_SEC, HOME_CAPTURE_TIME, BOND_COST, BOND_TIME, DAY_SUN_BONUS, NIGHT_CREEP_MUL, NIGHT_DIGEST_BONUS, NIGHT_GROW_MUL, allyKey, isAllied, isDay, INSECT_STEP, INSECT_LIFE, INSECT_COST, INSECT_CAP, TECH_GROW_SPEED, TECH_SOLAR_BONUS, TECH_WITHER_MUL } from './bloom.js';
import type { BloomEvent } from './bloom.js';
import { makeRng } from './math.js';
import { ROLE_IDS, SEAT_COLOURS, getRole, idx, isBeingTaken, legalTap, neighbours, terrainDefence, xy } from './rules.js';

/** One competitor. The server fills these from its lobby; solo play fabricates them. */
export interface GardenSeat {
  playerId: string;
  name: string;
  /** null means "drafts one after seeing the map". */
  role: RoleId | null;
  /** Played by the machine. Bots tap themselves inside `step`. */
  isBot: boolean;
}

export interface GardenOpts {
  mode: GameMode;
  seats: GardenSeat[];
  seed: number;
}

function blank(kind: Cell['kind'] = 'soil'): Cell {
  return { kind, owner: -1, progress: 0, claimant: -1, wither: 0, connected: false, spore: 0 };
}

/**
 * Where each seat's seedling starts.
 *
 * A diamond up to four — bottom, top, left, right — which is the layout every
 * measured number in this game was tuned against, so it is preserved exactly.
 *
 * Five needs its own shape rather than a fifth point bolted onto the diamond: the
 * only places left on a diamond are the corners, and a corner sits ~6 cells from
 * two of the four existing seedlings while the rest are 14 apart. That is not a
 * disadvantage, it is a different game. The five-seat layout is a pentagon instead,
 * left-right mirrored, with a minimum separation of 8 cells and none of the five
 * landing on a sun.
 */
function homeLayout(n: number): number[] {
  const spots: ReadonlyArray<readonly [number, number]> =
    n <= 4
      ? [
          [Math.floor(BOARD_W / 2) - 1, BOARD_H - 2],
          [Math.floor(BOARD_W / 2), 1],
          [1, Math.floor(BOARD_H / 2)],
          [BOARD_W - 2, Math.floor(BOARD_H / 2)],
        ]
      : [
          // Seat 0 keeps the bottom-centre seedling it has in every other layout.
          [Math.floor(BOARD_W / 2) - 1, BOARD_H - 2],
          [1, 2],
          [BOARD_W - 2, 2],
          [1, BOARD_H - 8],
          [BOARD_W - 2, BOARD_H - 8],
        ];
  return spots.slice(0, n).map(([x, y]) => idx(x, y));
}

/**
 * Map archetypes.
 *
 * Maps used to be one recipe — random rock clumps in the middle third — which made
 * every board the same board with the pebbles moved. It also had two measured bugs:
 * rocks could only spawn in columns 1..10 so the outer files were always bare, and
 * suns were placed AFTER rocks with `if (kind !== 'rock')`, so two of the six were
 * routinely eaten and the sun count silently varied from four to six by seed.
 *
 * Now a map has a character, and the character is the point: it decides which verbs
 * are good here, which is what makes looking at the board before you pick a plant a
 * real decision rather than a loading screen.
 */

export const MAP_KINDS: readonly MapKind[] = ['open', 'walled', 'warren', 'pillars'];

export const MAP_NAMES: Record<MapKind, string> = {
  open: 'OPEN FIELD',
  walled: 'WALLED GARDEN',
  warren: 'THE WARREN',
  pillars: 'STONE ROWS',
};

/** One line, child-readable, no numbers. Shown while you are choosing a plant. */
export const MAP_BLURBS: Record<MapKind, string> = {
  open: 'wide open, long runs, nowhere to hide',
  walled: 'a wall across every approach, with one way through',
  warren: 'cramped and tangled, everything touches',
  pillars: 'rows of stone, chokepoints everywhere',
};

/**
 * How much rock each archetype lays down, and in what shape.
 *
 * `walls` are long straight runs with a gap in them; `stubs` are short scattered
 * pieces; `pillars` are lone blocks. Every archetype mixes them differently, and
 * they are placed FREELY across the whole board — not mirrored, not balanced per
 * seat, not equalised.
 *
 * Maps are deliberately unfair. One spawn gets a sun on its doorstep and open
 * ground; another gets boxed in behind a wall with nothing nearby. That asymmetry
 * is the reason you pick your plant AFTER you see the board: a cramped, walled-in
 * corner wants SPORE or THORN, an open flank wants VINE, a sun you can reach wants
 * anything that can hold it. A perfectly fair board would make that choice
 * meaningless — every spot would want the same plant.
 */
interface MapSpec {
  walls: number;
  wallLen: [number, number];
  stubs: number;
  pillars: number;
  /** How many of each paying tile to scatter: sun, wood, insect, acid. */
  suns: [number, number];
  wood: [number, number];
  insect: [number, number];
  acid: [number, number];
}

/**
 * Resource counts per archetype.
 *
 * ACID is the scarcest thing on any board, because it is the only currency the tech
 * tree takes: three or four cells decide who gets to upgrade at all, which is a
 * fight worth having. SUN, WOOD and INSECT are each one faction's larder — a map
 * short on wood is a map where FUNGAL starves, and reading that is exactly what the
 * draft is for.
 */
const MAP_SPECS: Record<MapKind, MapSpec> = {
  open: { walls: 1, wallLen: [4, 7], stubs: 3, pillars: 4, suns: [4, 6], wood: [3, 5], insect: [3, 5], acid: [3, 4] },
  walled: { walls: 5, wallLen: [5, 9], stubs: 2, pillars: 2, suns: [3, 5], wood: [3, 5], insect: [3, 4], acid: [3, 4] },
  warren: { walls: 2, wallLen: [3, 4], stubs: 14, pillars: 6, suns: [4, 7], wood: [4, 6], insect: [5, 7], acid: [3, 5] },
  pillars: { walls: 0, wallLen: [0, 0], stubs: 4, pillars: 18, suns: [4, 6], wood: [3, 4], insect: [4, 5], acid: [3, 4] },
};

function inside(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < BOARD_W && y < BOARD_H;
}

/**
 * Cut the terrain.
 *
 * Order is load-bearing: rock, then suns, then seedlings. Later writers win, which
 * is how a sun stops being silently swallowed by a rock — the old generator placed
 * suns with `if (kind !== 'rock')`, so two of its six routinely vanished and the
 * board quietly had a different economy than intended.
 */
function carveMap(homes: number[], kind: MapKind, rng: () => number): Cell[] {
  const cells: Cell[] = [];
  for (let i = 0; i < BOARD_W * BOARD_H; i++) cells.push(blank());
  const spec = MAP_SPECS[kind];
  const pick = (n: number) => Math.floor(rng() * n);
  const set = (x: number, y: number, k: Cell['kind']) => {
    if (inside(x, y)) cells[idx(x, y)].kind = k;
  };

  // Long walls with a gap. The gap is the chokepoint the whole game turns on, so it
  // is always exactly one cell — you can see it, and so can everyone else.
  for (let w = 0; w < spec.walls; w++) {
    const vert = rng() > 0.45;
    const len = spec.wallLen[0] + pick(spec.wallLen[1] - spec.wallLen[0] + 1);
    const x = pick(BOARD_W);
    const y = pick(BOARD_H);
    const gap = 1 + pick(Math.max(1, len - 2));
    for (let d = 0; d < len; d++) {
      if (d === gap) continue;
      set(vert ? x : x + d, vert ? y + d : y, 'rock');
    }
  }
  // Short stubs: cover, corners, and things to grow around.
  for (let k = 0; k < spec.stubs; k++) {
    const vert = rng() > 0.5;
    const len = 2 + pick(2);
    const x = pick(BOARD_W);
    const y = pick(BOARD_H);
    for (let d = 0; d < len; d++) set(vert ? x : x + d, vert ? y + d : y, 'rock');
  }
  for (let k = 0; k < spec.pillars; k++) set(pick(BOARD_W), pick(BOARD_H), 'rock');

  /*
   * The paying tiles, scattered. Some land on somebody's doorstep and some land in
   * no-man's land, and which is which is exactly the thing you are reading when you
   * choose a plant — a sun by your seedling is worthless to FUNGAL and lethal to it,
   * while a wood cell there is its whole game.
   *
   * Spaced apart only enough that they do not stack into one corner, and never on a
   * seedling.
   */
  const placed: Array<{ x: number; y: number }> = [];
  const scatter = (kind: Cell['kind'], range: [number, number]) => {
    const want = range[0] + pick(range[1] - range[0] + 1);
    let done = 0;
    for (let attempt = 0; attempt < want * 40 && done < want; attempt++) {
      const x = pick(BOARD_W);
      const y = pick(BOARD_H);
      if (placed.some((p) => Math.abs(p.x - x) + Math.abs(p.y - y) < 3)) continue;
      if (homes.includes(idx(x, y))) continue;
      placed.push({ x, y });
      set(x, y, kind);
      done++;
    }
  };
  // Acid first: it is the scarcest and the most fought over, so it gets the room.
  scatter('acid', spec.acid);
  scatter('sun', spec.suns);
  scatter('wood', spec.wood);
  scatter('insect', spec.insect);

  for (const h of homes) {
    cells[h].kind = 'home';
    // Nobody starts entombed — an unlucky wall must not bury a seedling outright.
    for (const nb of rawNeighbours(h)) if (cells[nb].kind === 'rock') cells[nb].kind = 'soil';
  }

  connectHomes(cells, homes);
  return cells;
}

/**
 * Guarantee every seedling can reach every other over open ground.
 *
 * The one thing an unfair map may NOT do is seal someone off completely: a seat
 * that cannot reach anybody is not playing, and `stepWin`'s liveness check would
 * eventually eliminate them for terrain they never chose. Hard spots are the point;
 * impossible spots are a bug.
 */
function connectHomes(cells: Cell[], homes: number[]): void {
  for (let guard = 0; guard < 12; guard++) {
    const seen = new Uint8Array(cells.length);
    const queue = [homes[0]];
    seen[homes[0]] = 1;
    for (let head = 0; head < queue.length; head++) {
      for (const n of rawNeighbours(queue[head])) {
        if (seen[n] || cells[n].kind === 'rock') continue;
        seen[n] = 1;
        queue.push(n);
      }
    }
    const stranded = homes.find((h) => !seen[h]);
    if (stranded === undefined) return;
    // Cut an L back to the first seedling. Only rock is removed, so suns and
    // seedlings survive the dig.
    let { x, y } = xy(stranded);
    const t = xy(homes[0]);
    const dig = () => {
      const c = cells[idx(x, y)];
      if (c.kind === 'rock') c.kind = 'soil';
    };
    while (x !== t.x) {
      x += Math.sign(t.x - x);
      dig();
    }
    while (y !== t.y) {
      y += Math.sign(t.y - y);
      dig();
    }
  }
}

export class Garden {
  state: MatchState;
  private rng: () => number;
  private botClock: number[] = [];
  private creepClock: number[] = [];
  private nextInsect = 1;
  private opts: GardenOpts;
  /**
   * Standing pact offers, as `allyKey` values, per seat. A pact needs BOTH sides,
   * which is why offers are tracked separately from `state.allies`.
   */
  private offers: Set<number>[] = [];
  /**
   * Cues raised BETWEEN ticks, waiting for the next one to ship them.
   *
   * `tap`, `repel`, `hostileTakeover` and `hatchInsect` all run from a message
   * handler, not from `step`. `step` clears `state.events` so each snapshot carries
   * exactly one tick of cues — which silently deleted everything a handler had just
   * raised, before any client saw it. Measured: a `takeover` event was gone by the
   * time the next snapshot went out, so the shockwave never fired for anybody.
   */
  private pending: BloomEvent[] = [];
  /** True only while `step` is running. Decides which list `emit` writes to. */
  private inStep = false;

  constructor(opts: GardenOpts) {
    this.opts = opts;
    this.rng = makeRng(opts.seed);
    this.state = this.build();
  }

  /**
   * Raise a cue. Inside a tick it joins this tick's events; outside one it waits in
   * `pending` for the next tick to pick it up. Never push to `state.events` directly.
   */
  private emit(ev: BloomEvent): void {
    if (this.inStep) this.state.events.push(ev);
    else this.pending.push(ev);
  }

  private build(): MatchState {
    const n = this.opts.seats.length;
    const homeSpots = homeLayout(n);
    const kind = MAP_KINDS[Math.floor(this.rng() * MAP_KINDS.length)];
    const cells = carveMap(homeSpots, kind, this.rng);
    const homes: number[] = [];
    const seats: Seat[] = [];
    for (let s = 0; s < n; s++) {
      const home = homeSpots[s];
      homes.push(home);
      const c = cells[home];
      // `carveMap` already stamped the seedling and cleared its breathing ring.
      c.owner = s;
      c.connected = true;
      const spec = this.opts.seats[s];
      const role = spec.role ? getRole(spec.role) : null;
      seats.push({
        seat: s,
        playerId: spec.playerId,
        name: spec.name || `SEAT ${s + 1}`,
        role: role ? role.id : null,
        /*
         * Colour belongs to the SEAT, not the plant.
         *
         * Two players may pick the same plant, so faction colour cannot identify a
         * garden — two VINEs would be two identical greens and the board would stop
         * meaning anything. Seat colour is fixed for the match and never changes,
         * which also means nobody's territory recolours the moment they draft.
         */
        colour: SEAT_COLOURS[s % SEAT_COLOURS.length],
        energy: START_ENERGY,
        tiles: 1,
        alive: true,
        connected: true,
        isBot: spec.isBot,
        techs: [],
        acid: 0,
        repelCooldown: 0,
      });
      this.botClock.push(0.4 + this.rng() * 0.8);
      this.offers.push(new Set());
    }

    const board: Board = { w: BOARD_W, h: BOARD_H, cells, homes, kind };
    /*
     * If anybody arrived without a plant the match opens in `draft`: the board
     * exists, everyone can see it and their own seedling, and nothing is simulated
     * until the plants are in. A fully-specified line-up skips straight to play.
     */
    const drafting = this.opts.seats.some((x) => x.role === null);
    return {
      tick: 0,
      mode: this.opts.mode,
      phase: drafting ? 'draft' : 'playing',
      draftTimer: drafting ? DRAFT_SEC : 0,
      phaseTimer: 0,
      board,
      seats,
      holdTimers: seats.map(() => 0),
      clock: 0,
      allies: [],
      insects: [],
      events: [],
    };
  }

  // ================================================================ input

  /** Techs owned, per seat. Bought once each, permanent for the match. */
  readonly tech: Set<TechId>[] = [];

  /** Buy an upgrade. Returns false if already owned or too poor. */
  buyTech(seat: number, id: TechId): boolean {
    const s = this.state;
    const me = s.seats[seat];
    if (!me || !me.alive) return false;
    const def = TECHS.find((t) => t.id === id);
    if (!def) return false;
    const owned = this.techFor(seat);
    if (owned.has(id)) return false;
    // Enforce the tree in the MODEL, not just the UI. A hidden button is not a
    // rule — bots and remote clients both come through here.
    if (def.requires && !owned.has(def.requires)) return false;
    if (def.role && def.role !== me.role) return false;
    // Tech is bought with ACID and nothing else — see `Seat.acid`.
    if (me.acid < def.cost) return false;
    me.acid -= def.cost;
    owned.add(id);
    // Mirror onto the seat so it rides the snapshot to every client.
    me.techs = [...owned];
    return true;
  }

  /**
   * Offer, or accept, a pact with another seat. Returns true if the offer landed.
   *
   * Mutual by construction: your offer stands until theirs arrives, and the pact
   * forms the moment both exist. Either side calling this again while allied breaks
   * it, which is the betrayal the whole feature is for. (Solo play used to toggle
   * `state.allies` directly and unilaterally — a pact nobody had to agree to.)
   */
  setPact(from: number, to: number): boolean {
    const s = this.state;
    if (from === to) return false;
    if (!s.seats[from]?.alive || !s.seats[to]?.alive) return false;
    const key = allyKey(from, to);
    const at = s.allies.indexOf(key);
    if (at >= 0) {
      // Allied already — this is a betrayal. Drop the pact and both offers.
      s.allies.splice(at, 1);
      this.offersFor(from).delete(key);
      this.offersFor(to).delete(key);
      return true;
    }
    if (this.offersFor(to).has(key)) {
      // They already offered. Sealed.
      this.offersFor(from).delete(key);
      this.offersFor(to).delete(key);
      s.allies.push(key);
      return true;
    }
    this.offersFor(from).add(key);
    return true;
  }

  /** Has `from` offered `to` a pact that is still standing? */
  hasOffer(from: number, to: number): boolean {
    return this.offersFor(from).has(allyKey(from, to));
  }

  private offersFor(seat: number): Set<number> {
    if (!this.offers[seat]) this.offers[seat] = new Set();
    return this.offers[seat];
  }

  techFor(seat: number): Set<TechId> {
    if (!this.tech[seat]) this.tech[seat] = new Set();
    return this.tech[seat];
  }

  /**
   * The plant in this seat. Falls back to VINE only for a seat that has not drafted,
   * which cannot happen while the simulation is running — `step` refuses to advance
   * outside `playing`, and `beginPlay` fills every empty seat before it gets there.
   */
  private roleOf(seat: number): RoleDef {
    return getRole(this.state.seats[seat]?.role ?? 'vine');
  }

  // ---------------------------------------------------------------- the draft

  /**
   * Claim a plant during the draft.
   *
   * Duplicates are allowed: five VINEs is a legal, and quite interesting, garden.
   * Nothing about the board depends on plants being unique because colour is a
   * property of the seat, so the only thing a shared pick costs you is surprise.
   */
  setRole(seat: number, role: RoleId): boolean {
    const s = this.state;
    if (s.phase !== 'draft') return false;
    const me = s.seats[seat];
    if (!me) return false;
    me.role = role;
    return true;
  }

  /** True once every seat has a plant and the draft could end early. */
  get draftComplete(): boolean {
    return this.state.seats.every((x) => x.role !== null);
  }

  /**
   * End the draft and start the match. Anyone who never chose is handed a free
   * plant — running out of time costs you the choice, not the game.
   */
  beginPlay(): void {
    const s = this.state;
    if (s.phase !== 'draft') return;
    for (const seat of s.seats) {
      if (seat.role) continue;
      seat.role = ROLE_IDS[Math.floor(this.rng() * ROLE_IDS.length)] ?? ROLE_IDS[0];
    }
    s.draftTimer = 0;
    s.phase = 'playing';
  }

  /**
   * Advance the draft clock. Separate from `step` because `step` deliberately
   * refuses to run the world outside `playing`, and the draft still needs time to
   * pass — the caller (a room, or solo play) drives this instead.
   */
  stepDraft(dt: number): void {
    const s = this.state;
    if (s.phase !== 'draft') return;
    s.draftTimer = Math.max(0, s.draftTimer - dt);
    if (s.draftTimer <= 0) this.beginPlay();
  }

  /** Role stats after this seat's upgrades. The sim reads this, never the raw role. */
  private effectiveRole(seat: number): RoleDef {
    const base = this.roleOf(seat);
    const owned = this.techFor(seat);
    if (owned.size === 0) return base;
    const r: RoleDef = { ...base };

    // --- shared roots
    if (owned.has('surge')) {
      r.growTime *= TECH_GROW_SPEED;
      r.captureTime *= TECH_GROW_SPEED;
    }
    if (owned.has('deeproot')) r.witherMul *= TECH_WITHER_MUL;

    // --- VINE: distance, forking into tough runners or very long ones
    if (owned.has('whip')) r.reach += 2;
    if (owned.has('lash')) r.growCost = Math.max(1, r.growCost - 1);
    if (owned.has('canopy')) r.growTime *= 0.45;
    if (owned.has('thicket')) r.toughness *= 2;
    if (owned.has('lightning')) r.reach += 3;

    // --- MOSS: bulk, forking into armour or permanence
    if (owned.has('carpet')) r.blockSize += 1;
    if (owned.has('bark')) r.toughness *= TECH_BARK_TOUGH;
    if (owned.has('bog')) r.witherMul = 0.05; // effectively never rots
    // 'rampart' is paid by the ATTACKER — see `costOf` and the bond slow in stepClaims.
    // 'peat' is income — see `stepEnergy`.

    // --- SPORE: reach, forking into range or spread
    if (owned.has('drift')) { r.sporeLife += 6; r.hop = (r.hop ?? 4) + 3; }
    if (owned.has('pod')) r.growCost = Math.max(1, r.growCost - 2);
    if (owned.has('gale')) r.hop = (r.hop ?? 4) + 4;
    // 'burst' and 'bloomburst' are handled at landing time, not as stats.

    // --- FUNGAL: digestion, forking into the swarm or the rot
    if (owned.has('mycelium') && r.creep) r.creep *= 0.5;
    if (owned.has('enzyme') && r.digest) r.digest += TECH_ENZYME_BONUS;
    if (owned.has('rot') && r.creep) r.creep *= 0.5;
    // 'bloomcap' is handled at capture time; 'hive' in `hatchInsect`.

    // --- THORN: contact, forking into cheap bites or wide ones
    if (owned.has('barbs')) r.captureTime *= 0.5;
    if (owned.has('venom')) r.attackCost = Math.max(0, r.attackCost - 1);
    // 'feed', 'swarm' and 'bramble' are handled at capture time.

    return r;
  }

  /** How far a completed capture by this seat infects the neutral ring around it. */
  private infectDepth(seat: number): number {
    const owned = this.techFor(seat);
    if (owned.has('bramble')) return 3;
    if (owned.has('swarm')) return 2;
    return 1;
  }

  /**
   * Shake an assault off your seedling.
   *
   * Two things happen, both hostile-only (an ally leaning on your base is not
   * leaning on it):
   *
   *  1. Every enemy claim in progress within REPEL_RADIUS is knocked BACK by
   *     REPEL_KNOCKBACK — not cancelled. The attacker keeps the cell if any progress
   *     survives, and simply carries on; they do not even have to tap again. See
   *     REPEL_COST for why the attacker is meant to win this exchange on time.
   *  2. Enemy tiles standing directly on the seedling are shoved back to bare soil.
   *     Bare, not yours — a repel is a shove, not a free harvest.
   *
   * Then the seat goes on cooldown, which is the real limit: energy is uncapped, so
   * without one a rich defender could repel on every tick and be invulnerable.
   *
   * Returns false when there was nothing to push, and the caller then charges
   * nothing. Mashing your own base is pointless rather than ruinous.
   */
  private repel(seat: number, cell: number): boolean {
    const s = this.state;
    const p = xy(cell);
    let pushed = 0;

    for (let i = 0; i < s.board.cells.length; i++) {
      const c = s.board.cells[i];
      if (c.claimant < 0 || c.progress <= 0) continue;
      if (c.claimant === seat || isAllied(s.allies, seat, c.claimant)) continue;
      const q = xy(i);
      if (Math.abs(q.x - p.x) + Math.abs(q.y - p.y) > REPEL_RADIUS) continue;
      c.progress -= REPEL_KNOCKBACK;
      // Only a claim knocked all the way to nothing actually breaks off.
      if (c.progress <= 0) {
        c.progress = 0;
        c.claimant = -1;
      }
      pushed++;
    }

    for (const n of neighbours(s.board, cell)) {
      const c = s.board.cells[n];
      if (c.owner < 0 || c.owner === seat) continue;
      if (isAllied(s.allies, seat, c.owner)) continue;
      // Never dissolve a seedling — a conquered heart next door is taken, not shoved.
      if (c.kind === 'home') continue;
      const from = c.owner;
      c.owner = -1;
      c.claimant = -1;
      c.progress = 0;
      c.wither = 0;
      c.spore = 0;
      this.emit({ t: 'withered', cell: n, seat: from });
      pushed++;
    }

    if (pushed === 0) return false;
    const me = s.seats[seat];
    if (me) me.repelCooldown = REPEL_COOLDOWN;
    this.emit({ t: 'repel', cell, seat, count: pushed });
    return true;
  }

  tap(seat: number, cell: number): boolean {
    const s = this.state;
    if (s.phase !== 'playing') return false;
    const role = this.effectiveRole(seat);
    const kind = legalTap(s.board, s.seats, seat, role, cell);
    if (!kind) return false;

    /*
     * Repel is handled first, ahead of every guard below, and that ordering is the
     * whole feature: the guard that refuses a cell somebody else is mid-claim on
     * would otherwise block a repel in exactly the situation it exists for — your
     * seedling with an enemy six seconds into taking it.
     */
    if (kind === 'repel') {
      if (s.seats[seat].energy < REPEL_COST) {
        this.emit({ t: 'denied', cell, seat, reason: 'energy' });
        return false;
      }
      if (!this.repel(seat, cell)) return false; // nothing to push — costs nothing
      s.seats[seat].energy -= REPEL_COST;
      return true;
    }

    // You cannot eat an ally.
    const target = s.board.cells[cell];
    if (target.owner >= 0 && target.owner !== seat && isAllied(s.allies, seat, target.owner)) {
      this.emit({ t: 'denied', cell, seat, reason: 'illegal' });
      return false;
    }
    /*
     * Somebody else is already taking this cell. Refuse rather than seize it.
     *
     * A rival tap used to overwrite `claimant` and reset `progress` to nothing, so
     * two players reaching for the same tile just wiped each other: the bar never
     * filled, neither of them got it, and BOTH paid full price on every tap. With
     * four bots on the board that is a constant, invisible drain. First tap wins the
     * race now; you have to cut them off or wait, and either way you keep your energy.
     */
    if (target.claimant >= 0 && target.claimant !== seat && target.progress > 0) {
      this.emit({ t: 'denied', cell, seat, reason: 'illegal' });
      return false;
    }

    /*
     * Work out what this tap would ACTUALLY change before charging for it.
     *
     * The cost used to come out of your energy first, and only then did the loop
     * below discover every cell was already under way and skip them all — so tapping
     * a tile you are in the middle of taking (the most natural thing in the world on
     * a touchscreen; the bar is moving, so you tap it again) silently cost you a full
     * attack and bought nothing. Measured: 51 taps to take one tile, 19 energy spent
     * on a 3-energy capture. You then could not afford the next move, which reads as
     * "my attacks stop working".
     */
    const targets = this.footprint(seat, cell, kind).filter((i) => {
      const c = s.board.cells[i];
      return !(c.claimant >= 0 && c.progress > 0);
    });
    if (targets.length === 0) return false; // already under way — costs nothing

    const cost = kind === 'attack' ? this.costOf(seat, cell) : role.growCost;
    if (s.seats[seat].energy < cost) {
      this.emit({ t: 'denied', cell, seat, reason: 'energy' });
      return false;
    }
    s.seats[seat].energy -= cost;
    for (const i of targets) {
      const c = s.board.cells[i];
      c.claimant = seat;
      c.progress = 0.001;
    }
    return true;
  }

  /**
   * Which cells one tap touches. This is where the four roles stop being numbers
   * and become four different games: VINE runs a line, MOSS takes a block, the
   * others take the one cell they poked.
   */
  private footprint(seat: number, cell: number, kind: string): number[] {
    const s = this.state;
    const role = this.effectiveRole(seat);
    const out = [cell];
    if (role.reach > 1 && kind === 'grow') {
      // Continue in the direction the growth came from — a vine RUNS.
      const from = this.supportDir(seat, cell);
      let cur = cell;
      for (let k = 1; k < role.reach; k++) {
        const p = xy(cur);
        const nx = p.x + from.x;
        const ny = p.y + from.y;
        if (nx < 0 || ny < 0 || nx >= BOARD_W || ny >= BOARD_H) break;
        const ni = idx(nx, ny);
        const c = s.board.cells[ni];
        if (c.kind === 'rock' || c.kind === 'home' || c.owner === seat) break;
        out.push(ni);
        cur = ni;
      }
    }
    if (role.blockSize > 1) {
      const p = xy(cell);
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const nx = p.x + dx;
        const ny = p.y + dy;
        if (nx >= BOARD_W || ny >= BOARD_H) continue;
        const ni = idx(nx, ny);
        const c = s.board.cells[ni];
        if (c.kind === 'rock' || c.kind === 'home' || c.owner === seat) continue;
        out.push(ni);
      }
    }
    return out;
  }

  /** Unit direction pointing away from the supporting tile. */
  private supportDir(seat: number, cell: number): { x: number; y: number } {
    const s = this.state;
    const p = xy(cell);
    for (const n of neighbours(s.board, cell)) {
      if (s.board.cells[n].owner !== seat) continue;
      const q = xy(n);
      return { x: p.x - q.x, y: p.y - q.y };
    }
    return { x: 0, y: -1 };
  }

  // ================================================================ tick

  step(dt: number): void {
    const s = this.state;
    // Carry over anything raised since the last tick, then let this tick append.
    s.events = this.pending;
    this.pending = [];
    if (s.phase !== 'playing') return;
    this.inStep = true;
    s.tick++;
    s.clock += dt;

    this.stepBlight();
    this.stepEnergy(dt);
    for (const seat of s.seats) {
      if (seat.repelCooldown > 0) seat.repelCooldown = Math.max(0, seat.repelCooldown - dt);
    }
    this.stepCreep(dt);
    this.stepInsects(dt);
    this.stepClaims(dt);
    this.connectivity();
    this.stepWither(dt);
    for (let i = 0; i < s.seats.length; i++) if (s.seats[i].isBot) this.stepBot(i, dt);
    this.stepWin(dt);
    this.inStep = false;
  }

  /**
   * Income. Every wage in the game is paid by a tile somebody is holding.
   *
   *  - SUN pays the photosynthesisers, in daylight only. It is LETHAL to FUNGAL and
   *    SPORE, which cannot hold one at all (see `stepBlight`).
   *  - WOOD pays FUNGAL and nothing else pays it. Its only other income is what it
   *    digests, which is also its starvation guard.
   *  - INSECT pays SPORE and nothing else pays it.
   *  - ACID pays acid to whoever holds it, for every faction, and acid is the only
   *    currency the tech tree takes.
   *
   * FUNGAL and SPORE get no flat trickle, no rent on plain ground and no sunlight.
   * They are scavengers: they eat, or they hold their larder, or they earn nothing.
   */
  private stepEnergy(dt: number): void {
    const s = this.state;
    const held: Array<Record<string, number>> = s.seats.map(() => ({ sun: 0, wood: 0, insect: 0, acid: 0 }));
    for (const c of s.board.cells) {
      if (c.owner < 0 || !c.connected) continue;
      const bucket = held[c.owner];
      if (bucket && c.kind in bucket) bucket[c.kind] += 1;
    }

    const day = isDay(s.clock);
    for (const seat of s.seats) {
      if (!seat.alive) continue;
      const owned = this.techFor(seat.seat);
      const mine = held[seat.seat] ?? { sun: 0, wood: 0, insect: 0, acid: 0 };

      // Acid is universal, and it is the whole tech economy.
      seat.acid += ACID_PER_SEC * mine.acid * dt;

      const role = this.effectiveRole(seat.seat);
      if (role.digest) {
        // FUNGAL: timber and what it eats. Nothing else.
        seat.energy += WOOD_ENERGY_PER_SEC * mine.wood * dt;
        continue;
      }
      if (role.remote) {
        // SPORE: the insect beds and nothing else — plus a bare drift while it holds
        // none at all, so being broke is never permanent. See SPORE_DRIFT_PER_SEC.
        seat.energy +=
          (mine.insect > 0 ? INSECT_ENERGY_PER_SEC * mine.insect : SPORE_DRIFT_PER_SEC) * dt;
        continue;
      }

      const sunYield = SUN_ENERGY_PER_SEC + (owned.has('solar') ? TECH_SOLAR_BONUS : 0);
      // ZENITH keeps the panels running after dark.
      const sunRate = day
        ? sunYield * DAY_SUN_BONUS
        : owned.has('zenith')
          ? sunYield * TECH_ZENITH_NIGHT
          : 0;
      // Territory is an economy: every tile you hold funds the next one.
      const perTile =
        ENERGY_PER_TILE +
        (owned.has('compost') ? TECH_COMPOST_TILE : 0) +
        (owned.has('peat') ? TECH_PEAT_TILE : 0);
      seat.energy +=
        (ENERGY_PER_SEC + sunRate * mine.sun + perTile * seat.tiles) * dt;
    }
  }

  /**
   * Sunlight kills the rot-plants.
   *
   * FUNGAL and SPORE cannot hold a `sun` cell. They are stopped from claiming one in
   * `legalTap`, but they have three ways to end up on one without ever tapping it —
   * FUNGAL's creep, THORN-style infection spread, and an insect bite — so the state
   * is also swept here. Belt and braces, because a fungus sitting happily on a sun
   * tile would quietly undo the rule.
   */
  private stepBlight(): void {
    const s = this.state;
    for (let i = 0; i < s.board.cells.length; i++) {
      const c = s.board.cells[i];
      if (c.kind !== 'sun') continue;
      if (c.owner >= 0 && this.roleOf(c.owner).sunKills) {
        this.emit({ t: 'withered', cell: i, seat: c.owner });
        c.owner = -1;
        c.wither = 0;
        c.spore = 0;
      }
      if (c.claimant >= 0 && this.roleOf(c.claimant).sunKills) {
        c.claimant = -1;
        c.progress = 0;
      }
    }
  }

  private stepClaims(dt: number): void {
    const s = this.state;
    for (let i = 0; i < s.board.cells.length; i++) {
      const c = s.board.cells[i];
      if (c.claimant < 0 || c.progress <= 0) continue;
      /*
       * Drop a claim whose owner is out of the match. It would otherwise finish and
       * hand a tile to a dead player — and now that an in-progress claim blocks
       * everyone else from the cell, a corpse's claim would lock it permanently.
       */
      if (!s.seats[c.claimant]?.alive) {
        c.claimant = -1;
        c.progress = 0;
        continue;
      }
      // Upgraded stats, not the raw role — reading `getRole` here was why SURGE
      // (and the defender's toughness techs) did nothing at all.
      const role = this.effectiveRole(c.claimant);
      const contested = c.owner >= 0 && c.owner !== c.claimant;
      const defenderTough = contested
        ? this.effectiveRole(c.owner).toughness * terrainDefence(c.kind, this.roleOf(c.owner))
        : 1;
      // A seedling is the slowest thing on the board to take, on purpose: it is a
      // decisive, visible commitment rather than a stray tap.
      const night = !isDay(s.clock);
      // Bonds make a tile slow as well as costly, and most plants grow worse at night.
      const defTech = contested ? this.techFor(c.owner) : null;
      // ...and not slowed by them either. Bonds are a rule about pushing a front
      // forward; neither of these two advances that way.
      const bondSlow =
        contested && !role.ignoresBonds
          ? this.bondsOf(i) * BOND_TIME * (defTech?.has('rampart') ? TECH_RAMPART_BOND : 1)
          : 0;
      const nightMul = night && !role.creep ? NIGHT_GROW_MUL : 1;
      const dur =
        (c.kind === 'home'
          ? HOME_CAPTURE_TIME *
            defenderTough *
            (c.owner >= 0 && this.techFor(c.owner).has('heartwood') ? TECH_HEARTWOOD : 1)
          : contested
            ? role.captureTime * defenderTough + bondSlow
            : role.growTime) * nightMul;
      c.progress += dt / Math.max(0.1, dur);
      if (c.progress >= 1) {
        const from = c.owner;
        c.owner = c.claimant;
        c.claimant = -1;
        c.progress = 0;
        c.wither = 0;
        c.spore = 0;
        if (from >= 0) {
          this.emit({ t: 'captured', cell: i, seat: c.owner, from });
          /*
           * THORN's verb: eating spreads it sideways. A completed capture infects
           * every neutral cell around it, for free.
           *
           * This is what makes THORN a different game rather than a differently-
           * tuned one — it is weak in open ground and explodes on contact, so it
           * plays for fronts. Earlier drafts made it literally unable to plant,
           * which measured as a softlock: with no enemy adjacent at match start it
           * had zero legal moves and never played at all.
           */
          const owned = this.techFor(c.owner);
          const eater = this.effectiveRole(c.owner);
          // FUNGAL digests what it eats — that is how it pays for anything.
          if (eater.digest) {
            const bite = eater.digest + (isDay(s.clock) ? 0 : NIGHT_DIGEST_BONUS);
            s.seats[c.owner].energy += bite;
            if (owned.has('bloomcap')) this.creepFrom(i, c.owner);
          }
          /*
           * Taking a seedling. The cell stays a `home` and is now yours, so the
           * conqueror gains a root (see `connectivity`) and the victim loses one.
           *
           * The victim is only knocked out once they hold NO seedling anywhere —
           * not merely because the one they started on changed hands. Otherwise a
           * player who had conquered someone else's heart would still die the
           * instant their original fell, while visibly still owning a heart.
           */
          if (c.kind === 'home' && from >= 0) {
            const left = this.seedlingsOf(from);
            s.board.homes[from] = left[0] ?? -1;
            if (left.length === 0 && !this.stillStanding(from)) {
              s.seats[from].alive = false;
              this.emit({ t: 'eliminated', seat: from });
            }
          }
          if (owned.has('feed')) {
            s.seats[c.owner].energy += TECH_FEED_ENERGY;
          }
          if (this.effectiveRole(c.owner).parasite) {
            // SWARM pushes the infection a ring further; BRAMBLE another one again.
            this.infect(i, c.owner, this.infectDepth(c.owner));
          }
        } else {
          this.emit({ t: 'claimed', cell: i, seat: c.owner });
          if (this.effectiveRole(c.owner).remote) {
            const spread = this.techFor(c.owner).has('bloomburst')
              ? 2
              : this.techFor(c.owner).has('burst')
                ? 1
                : 0;
            if (spread > 0) this.infect(i, c.owner, spread);
          }
        }
      }
    }
  }

  /**
   * Every seedling cell this seat currently owns.
   *
   * The source of truth for "do I still have a heart" — `board.homes` only records
   * where each seat STARTED, which stops being the whole answer the moment hearts
   * can change hands.
   */
  seedlingsOf(seat: number): number[] {
    const out: number[] = [];
    const cells = this.state.board.cells;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].kind === 'home' && cells[i].owner === seat) out.push(i);
    }
    return out;
  }

  /** Cells this seat owns, seedlings included. Counted live, not off `seat.tiles`. */
  tileCount(seat: number): number {
    let n = 0;
    for (const c of this.state.board.cells) if (c.owner === seat) n++;
    return n;
  }

  /**
   * Is this seat still in the match with no seedling left?
   *
   * Only SPORE. Every other plant traces its network back to a seedling, so losing
   * the last one means the whole mat is cut and dead anyway — killing them is just
   * saying so early. SPORE's rule is that a landing IS a root (`rootsAnywhere`), so
   * its tiles feed themselves and there is nothing to cut. Killing it for losing a
   * seedling contradicted the one thing that makes the faction what it is.
   *
   * So a spore is immortal for exactly as long as it holds ground: take the last
   * tile and it dies, and not before.
   */
  private stillStanding(seat: number): boolean {
    const me = this.state.seats[seat];
    if (!me || !this.roleOf(seat).rootsAnywhere) return false;
    return this.tileCount(seat) > 0;
  }

  /**
   * How many bonds actually apply when taking this tile.
   *
   * Normally the count of friendly neighbours its OWNER has around it: a tile buried
   * in a mat is expensive and slow, an exposed tip is cheap. A plant flagged
   * `noBondDefence` braces nothing and always reports zero, so its mat is as cheap
   * at the middle as at the edge.
   */
  bondsOf(cell: number): number {
    const s = this.state;
    const c = s.board.cells[cell];
    if (!c || c.owner < 0) return 0;
    if (this.roleOf(c.owner).noBondDefence) return 0;
    let n = 0;
    for (const nb of neighbours(s.board, cell)) {
      if (s.board.cells[nb].owner === c.owner) n++;
    }
    return n;
  }

  /** Energy a tap on `cell` would cost this seat, bonds included. */
  costOf(seat: number, cell: number): number {
    const role = this.effectiveRole(seat);
    const c = this.state.board.cells[cell];
    if (!c) return 0;
    const contested = c.owner >= 0 && c.owner !== seat;
    if (!contested) return role.growCost;
    /*
     * SPORE and FUNGAL are not charged for bonds at all — see `ignoresBonds`.
     *
     * For FUNGAL this is also a starvation guard: digestion is its only income, so
     * any energy price on eating can strand a mycelium at zero, ringed by tiles too
     * well-bonded to afford, unable to act again or ever earn another point.
     * Measured — it happened on the first test board.
     */
    if (role.ignoresBonds) return role.attackCost;
    // RAMPART is the defender's tech: it is the attacker who feels it.
    const bond = BOND_COST * (this.techFor(c.owner).has('rampart') ? TECH_RAMPART_BOND : 1);
    return Math.round(role.attackCost + this.bondsOf(cell) * bond);
  }

  /**
   * HOSTILE TAKEOVER — SPORE's item, and the only one in the game.
   *
   * One acid to instantly evaporate everything in a 9x9 block centred where you tap,
   * then sprinkle the ruins with landings. FUNGAL and SPORE are immune, so what it
   * really does is delete the photosynthesisers out of a third of the board and leave
   * the rot standing in it.
   *
   * Instant, not a creeping poison: the whole point is that a third of the map simply
   * stops being anybody's, in one tap, and the ground is yours before they can react.
   * Seedlings and rock survive — a nuke that could take a heart from nine cells away
   * would make the six-second seedling rule meaningless.
   */
  hostileTakeover(seat: number, cell: number): boolean {
    const s = this.state;
    if (s.phase !== 'playing') return false;
    const me = s.seats[seat];
    if (!me?.alive) return false;
    if (!this.roleOf(seat).remote) return false; // SPORE only
    if (me.acid < TAKEOVER_COST) return false;
    const target = s.board.cells[cell];
    if (!target) return false;

    const half = Math.floor(TAKEOVER_SIZE / 2);
    const c0 = xy(cell);
    const cleared: number[] = [];
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const x = c0.x + dx;
        const y = c0.y + dy;
        if (!inside(x, y)) continue;
        const i = idx(x, y);
        const c = s.board.cells[i];
        if (c.kind === 'rock' || c.kind === 'home') continue;
        // A claim in progress by anyone vulnerable is broken off too.
        if (c.claimant >= 0 && !this.roleOf(c.claimant).poisonImmune) {
          c.claimant = -1;
          c.progress = 0;
        }
        if (c.owner < 0) continue;
        if (this.roleOf(c.owner).poisonImmune) continue;
        this.emit({ t: 'withered', cell: i, seat: c.owner });
        c.owner = -1;
        c.wither = 0;
        c.spore = 0;
        cleared.push(i);
      }
    }
    if (cleared.length === 0) return false; // nothing to poison — costs nothing

    me.acid -= TAKEOVER_COST;
    // Sprinkle the ruins. Not all of it: this takes ground off them, it does not
    // simply hand the same ground to you.
    let seeded = 0;
    for (const i of cleared) {
      if (this.rng() > TAKEOVER_SEED_FRACTION) continue;
      const c = s.board.cells[i];
      if (c.kind === 'sun') continue; // sunlight would kill the landing anyway
      c.owner = seat;
      seeded++;
      this.emit({ t: 'spore', cell: i, seat });
    }
    this.emit({ t: 'takeover', cell, seat, cleared: cleared.length, seeded });
    return true;
  }

  /**
   * Where would HOSTILE TAKEOVER hurt most? Scores every centre by how many
   * vulnerable enemy tiles the block would evaporate.
   */
  private bestTakeover(seat: number): { cell: number; gain: number } {
    const s = this.state;
    const half = Math.floor(TAKEOVER_SIZE / 2);
    let bestCell = -1;
    let bestGain = 0;
    for (let i = 0; i < s.board.cells.length; i++) {
      const p = xy(i);
      let gain = 0;
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const x = p.x + dx;
          const y = p.y + dy;
          if (!inside(x, y)) continue;
          const c = s.board.cells[idx(x, y)];
          if (c.kind === 'rock' || c.kind === 'home') continue;
          if (c.owner < 0 || c.owner === seat) continue;
          if (isAllied(s.allies, seat, c.owner)) continue;
          if (this.roleOf(c.owner).poisonImmune) continue;
          gain++;
        }
      }
      if (gain > bestGain) {
        bestGain = gain;
        bestCell = i;
      }
    }
    return { cell: bestCell, gain: bestGain };
  }

  /** Hatch an insect on one of this seat's tiles. Returns false if it cannot. */
  hatchInsect(seat: number): boolean {
    const s = this.state;
    const role = this.effectiveRole(seat);
    if (!role.creep) return false; // fungal only
    // No swarm until the mycelium has learned to hatch. BROOD is the gate.
    if (!this.techFor(seat).has('brood')) return false;
    const hive = this.techFor(seat).has('hive');
    const cost = Math.max(1, INSECT_COST - (hive ? TECH_HIVE_DISCOUNT : 0));
    const cap = INSECT_CAP + (hive ? TECH_HIVE_CAP : 0);
    if (s.seats[seat].energy < cost) return false;
    if (s.insects.filter((b) => b.seat === seat).length >= cap) return false;
    const mine: number[] = [];
    for (let i = 0; i < s.board.cells.length; i++) {
      if (s.board.cells[i].owner === seat && s.board.cells[i].connected) mine.push(i);
    }
    if (mine.length === 0) return false;
    const cell = mine[Math.floor(this.rng() * mine.length)];
    s.seats[seat].energy -= cost;
    s.insects.push({ id: this.nextInsect++, seat, cell, clock: INSECT_STEP, life: INSECT_LIFE });
    this.emit({ t: 'hatch', cell, seat });
    return true;
  }

  /**
   * Insects walk and bite on their own.
   *
   * Each step: if an enemy tile is adjacent, eat it (that is the point of them);
   * otherwise wander toward the nearest enemy. They are the reason FUNGAL can
   * threaten someone without spending a tap, and they expire, so the swarm has to
   * be renewed out of what the mycelium digests.
   */
  private stepInsects(dt: number): void {
    const s = this.state;
    if (s.insects.length === 0) return;
    const night = !isDay(s.clock);
    for (const bug of s.insects) {
      bug.life -= dt;
      bug.clock -= dt * (night ? 1.6 : 1);
      if (bug.clock > 0) continue;
      bug.clock = INSECT_STEP;

      const adj = neighbours(s.board, bug.cell);
      // Bite an adjacent enemy tile.
      const prey = adj.filter((n) => {
        const c = s.board.cells[n];
        return (
          c.owner >= 0 && c.owner !== bug.seat && !isAllied(s.allies, bug.seat, c.owner) && c.kind !== 'home'
        );
      });
      if (prey.length > 0) {
        const target = prey[Math.floor(this.rng() * prey.length)];
        const from = s.board.cells[target].owner;
        s.board.cells[target].owner = bug.seat;
        s.board.cells[target].claimant = -1;
        s.board.cells[target].progress = 0;
        this.emit({ t: 'bite', cell: target, seat: bug.seat, from });
        bug.cell = target;
        continue;
      }
      // Otherwise crawl toward the nearest enemy tile.
      const step = adj.filter((n) => s.board.cells[n].kind !== 'rock');
      if (step.length === 0) continue;
      const here = xy(bug.cell, s.board.w);
      let bestN = step[Math.floor(this.rng() * step.length)];
      let bestD = Infinity;
      for (let i = 0; i < s.board.cells.length; i++) {
        const c = s.board.cells[i];
        if (c.owner < 0 || c.owner === bug.seat || isAllied(s.allies, bug.seat, c.owner)) continue;
        const p = xy(i, s.board.w);
        const d = Math.abs(p.x - here.x) + Math.abs(p.y - here.y);
        if (d >= bestD) continue;
        bestD = d;
        for (const n of step) {
          const q = xy(n, s.board.w);
          if (Math.abs(p.x - q.x) + Math.abs(p.y - q.y) < d) { bestN = n; break; }
        }
      }
      bug.cell = bestN;
    }
    s.insects = s.insects.filter((b) => b.life > 0);
  }

  /** Is there anywhere for this seat's mycelium to spread? */
  private hasCreepRoom(seat: number): boolean {
    const s = this.state;
    for (let i = 0; i < s.board.cells.length; i++) {
      const c = s.board.cells[i];
      if (c.owner !== seat) continue;
      for (const n of neighbours(s.board, i)) {
        const nb = s.board.cells[n];
        if (nb.owner < 0 && nb.claimant < 0 && nb.kind !== 'rock' && nb.kind !== 'home') return true;
      }
    }
    return false;
  }

  /** One free spread step out of a single tile. */
  private creepFrom(origin: number, seat: number): void {
    this.infect(origin, seat, 1);
  }

  /**
   * FUNGAL's verb: the mycelium spreads on its own, for free, without a tap.
   *
   * Run on a per-seat clock rather than per-tile so a large fungus does not
   * explode exponentially — it advances one cell somewhere along its edge each
   * interval, which is slow, relentless, and very readable on screen.
   */
  private stepCreep(dt: number): void {
    const s = this.state;
    for (const seat of s.seats) {
      if (!seat.alive) continue;
      const role = this.effectiveRole(seat.seat);
      if (!role.creep) continue;
      // Night is the fungus's hour: the mycelium runs at double speed after dark.
      const creepEvery = isDay(s.clock) ? role.creep : role.creep * NIGHT_CREEP_MUL;
      this.creepClock[seat.seat] = (this.creepClock[seat.seat] ?? creepEvery) - dt;
      if (this.creepClock[seat.seat] > 0) continue;
      this.creepClock[seat.seat] = creepEvery;

      // Every empty cell touching this seat's live territory is a candidate.
      const edge: number[] = [];
      for (let i = 0; i < s.board.cells.length; i++) {
        const c = s.board.cells[i];
        if (c.owner !== seat.seat || !c.connected) continue;
        for (const n of neighbours(s.board, i)) {
          const nb = s.board.cells[n];
          if (nb.owner >= 0 || nb.claimant >= 0) continue;
          if (nb.kind === 'rock' || nb.kind === 'home') continue;
          if (nb.kind === 'sun' && role.sunKills) continue; // sunlight kills it
          edge.push(n);
        }
      }
      if (edge.length === 0) continue;
      const pick = edge[Math.floor(this.rng() * edge.length)];
      s.board.cells[pick].owner = seat.seat;
      this.emit({ t: 'claimed', cell: pick, seat: seat.seat });
    }
  }

  /**
   * Claim the neutral ring(s) around `origin` for `seat`. Used by THORN's capture
   * spread and by SPORE's BURSTPOD landing — both are "this tile pulls its
   * neighbours in", just triggered by different events.
   */
  private infect(origin: number, seat: number, depth: number): void {
    const s = this.state;
    let frontier = [origin];
    for (let d = 0; d < depth; d++) {
      const next: number[] = [];
      for (const cur of frontier) {
        for (const n of neighbours(s.board, cur)) {
          const nb = s.board.cells[n];
          if (nb.owner >= 0 || nb.kind === 'rock' || nb.kind === 'home') continue;
          if (nb.claimant >= 0) continue;
          if (nb.kind === 'sun' && this.roleOf(seat).sunKills) continue;
          nb.owner = seat;
          this.emit({ t: 'claimed', cell: n, seat });
          next.push(n);
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
  }

  /** Flood from every seedling over that seat's tiles. Everything else is cut. */
  private connectivity(): void {
    const s = this.state;
    const seen = new Uint8Array(s.board.cells.length);
    const queue: number[] = [];
    /*
     * EVERY seedling you own is a root, not just the one you started on.
     *
     * Conquering someone's seedling leaves that cell on the board as a `home` in
     * your colour, so it already looked like a second heart. Seeding the flood only
     * from `board.homes[seat]` meant it was not one: it rooted nothing, fed nothing,
     * and (because homes never wither) sat there as an immortal decoration in the
     * middle of the territory you had just taken.
     *
     * Now taking a heart really does give you a heart. It is the payoff that makes
     * pushing for a seedling worth the six seconds it costs, and it is what lets a
     * conquered zone stay alive on its own once you cut it free of your main mat.
     */
    for (let i = 0; i < s.board.cells.length; i++) {
      const c = s.board.cells[i];
      if (c.kind !== 'home' || c.owner < 0) continue;
      seen[i] = 1;
      queue.push(i);
    }
    /*
     * SPORE roots anywhere: any spore that survived its countdown becomes a second
     * home and seeds the flood itself.
     *
     * Without this SPORE was strictly the worst role — it paid for adjacency-free
     * placement with a connection it could essentially never keep, so every landing
     * withered and the role did nothing. Rooting anywhere is what turns "jumps" from
     * a drawback into a strategy: you plant a beachhead and grow outward from it.
     */
    for (let i = 0; i < s.board.cells.length; i++) {
      const c = s.board.cells[i];
      if (c.owner < 0 || seen[i]) continue;
      if (!this.roleOf(c.owner).rootsAnywhere) continue;
      if (c.spore > 0) continue; // still a fragile, unrooted landing
      seen[i] = 1;
      queue.push(i);
    }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      const owner = s.board.cells[i].owner;
      for (const n of neighbours(s.board, i)) {
        if (seen[n]) continue;
        if (s.board.cells[n].owner !== owner) continue;
        seen[n] = 1;
        queue.push(n);
      }
    }
    /*
     * Who cut whom.
     *
     * A sever is detected here, one step after the thing that caused it, so the
     * cause has to be recovered from this tick's events: the capture (or insect
     * bite) that took a tile off the victim IS the cut. Without this the payoff
     * event named a victim and no culprit, so "tiles you killed by cutting" — the
     * number the whole game is played for — was unattributable.
     */
    const cutBy = new Map<number, { cell: number; by: number }>();
    for (const ev of s.events) {
      if ((ev.t === 'captured' || ev.t === 'bite') && ev.from >= 0) {
        cutBy.set(ev.from, { cell: ev.cell, by: ev.seat });
      }
    }
    const severed = new Map<number, number>();
    for (let i = 0; i < s.board.cells.length; i++) {
      const c = s.board.cells[i];
      if (c.owner < 0) {
        c.connected = false;
        continue;
      }
      const fed = seen[i] === 1;
      if (c.connected && !fed) severed.set(c.owner, (severed.get(c.owner) ?? 0) + 1);
      c.connected = fed;
      if (fed) c.wither = 0;
      else if (c.wither <= 0) c.wither = WITHER_TIME / this.effectiveRole(c.owner).witherMul;
    }
    for (const [seat, count] of severed) {
      const cut = cutBy.get(seat);
      this.emit({ t: 'severed', seat, count, cause: cut?.cell ?? -1, by: cut?.by ?? -1 });
    }
    for (const seat of s.seats) {
      seat.tiles = 0;
    }
    for (const c of s.board.cells) if (c.owner >= 0) s.seats[c.owner].tiles++;
  }

  private stepWither(dt: number): void {
    const s = this.state;
    for (let i = 0; i < s.board.cells.length; i++) {
      const c = s.board.cells[i];
      if (c.owner < 0 || c.connected) continue;
      if (c.kind === 'home') continue; // homes never rot
      c.wither -= dt;
      if (c.spore > 0) c.spore = Math.max(0, c.spore - dt);
      if (c.wither <= 0) {
        const seat = c.owner;
        c.owner = -1;
        c.wither = 0;
        c.spore = 0;
        c.claimant = -1;
        c.progress = 0;
        this.emit({ t: 'withered', cell: i, seat });
      }
    }
  }

  /**
   * Bots answer pact offers, and eventually turn on you.
   *
   * Without this, offering a bot a pact did nothing forever: `setPact` needs both
   * sides and a bot never spoke, so the whole diplomacy feature was dead in any
   * match against the machine. The rule is deliberately legible rather than clever,
   * because a player has to be able to predict it:
   *
   *  - accept a pact from anyone who is not currently the biggest garden. Allying
   *    with the leader is how you lose, and a bot that took any deal on offer would
   *    make the leader unbeatable.
   *  - betray an ally who has run away with the match. This is what stops a pact
   *    from being a permanent free flank, and it is the moment the feature exists
   *    for — you should have to watch your friend.
   */
  private stepBotDiplomacy(seat: number): void {
    const s = this.state;
    const me = s.seats[seat];
    const leader = s.seats.reduce((a, b) => (b.tiles > a.tiles ? b : a), s.seats[0]);
    for (const other of s.seats) {
      if (other.seat === seat || !other.alive) continue;
      if (isAllied(s.allies, seat, other.seat)) {
        // Runaway ally: cut them loose. Rare per tick so it reads as a decision.
        const runaway = other.tiles > me.tiles * 1.6 && other.tiles > 12;
        if (runaway && this.rng() < 0.06) this.setPact(seat, other.seat);
        continue;
      }
      if (!this.hasOffer(other.seat, seat)) continue;
      if (other.seat === leader.seat && leader.tiles > me.tiles) continue; // not the leader
      if (this.rng() < 0.35) this.setPact(seat, other.seat);
    }
  }

  /**
   * Bots that play the actual game rather than a script: expand toward the largest
   * neighbour opportunity, and take a cut when one is on offer.
   */
  private stepBot(seat: number, dt: number): void {
    const s = this.state;
    if (!s.seats[seat].alive) return;
    this.botClock[seat] -= dt;
    if (this.botClock[seat] > 0) return;
    const role = this.roleOf(seat);
    this.botClock[seat] = 0.35 + this.rng() * 0.7;

    this.stepBotDiplomacy(seat);

    /*
     * SPORE fires HOSTILE TAKEOVER. Without this the bot never once used the ability
     * the whole faction is built around, which made every balance number measured
     * against it meaningless — and made a solo match against SPORE a match against
     * something playing with its main weapon switched off.
     */
    if (role.remote && s.seats[seat].acid >= TAKEOVER_COST) {
      const shot = this.bestTakeover(seat);
      // Do not waste the shot on a handful of tiles, even at one acid.
      if (shot.cell >= 0 && shot.gain >= 6 && this.hostileTakeover(seat, shot.cell)) return;
    }

    /*
     * Defend the heart first. A bot that let its seedling be eaten while it tapped
     * away at open soil would make the repel look like a mechanic only humans get,
     * and `isBeingTaken` below deliberately skips cells under claim — including its
     * own base, which is the one it must not skip.
     */
    for (const root of this.seedlingsOf(seat)) {
      const c = s.board.cells[root];
      if (c.claimant >= 0 && c.claimant !== seat && c.progress > 0) {
        if (this.tap(seat, root)) return;
      }
    }

    // Distance is measured to the NEAREST seedling this seat holds, not to the one
    // it started on — a bot that has conquered a heart should grow around that one
    // too, instead of treating its new zone as the far side of the map.
    const roots = this.seedlingsOf(seat).map((r) => xy(r));

    const options: Array<{ cell: number; score: number }> = [];
    for (let i = 0; i < s.board.cells.length; i++) {
      // Somebody is already taking this one, including possibly us. Tapping it is
      // refused, so spending the bot's turn on it just means it does nothing.
      if (isBeingTaken(s.board, i)) continue;
      const kind = legalTap(s.board, s.seats, seat, role, i);
      if (!kind) continue;
      const cost = kind === 'attack' ? this.costOf(seat, i) : role.growCost;
      if (s.seats[seat].energy < cost) continue;
      let score = this.rng() * 0.6;
      const c = s.board.cells[i];
      /*
       * Resource tiles ARE the economy now, so a bot that only knew about sunlight
       * was playing a different game to the one being simulated. Measured with the
       * old scoring: SPORE averaged 0.1 tiles — it never went for the insect beds
       * that are its only wage, so it simply never got to move.
       *
       * Each plant values the tile that pays IT. Acid pays everybody, because acid
       * is the only thing the tech tree takes.
       */
      if (c.kind === 'acid') score += 3;
      else if (c.kind === 'wood') score += role.digest ? 3.6 : 1;
      else if (c.kind === 'insect') score += role.remote ? 3.6 : 0.1;
      else if (c.kind === 'sun') score += role.sunKills ? 0 : 2.4;
      if (kind === 'attack') score += 1.4 + (role.id === 'thorn' ? 1.6 : 0);
      // Prefer taps that thin an enemy's neck — the cut is the point of the game.
      if (kind === 'attack') {
        let enemyNb = 0;
        for (const n of neighbours(s.board, i)) if (s.board.cells[n].owner === c.owner) enemyNb++;
        if (enemyNb <= 2) score += 2.2;
      }
      // Taking an enemy seedling is the biggest prize on the board: it eliminates
      // them if it is their last, and it hands you a root either way.
      if (kind === 'attack' && c.kind === 'home') score += 3.2;
      const p = xy(i);
      let near = Infinity;
      for (const q of roots) near = Math.min(near, Math.abs(p.x - q.x) + Math.abs(p.y - q.y));
      if (near < Infinity) score += 1.2 - Math.min(1, near / 24);
      options.push({ cell: i, score });
    }
    if (!options.length) return;
    options.sort((a, b) => b.score - a.score);
    const pick = options[Math.floor(this.rng() * Math.min(3, options.length))];
    this.tap(seat, pick.cell);
  }

  private stepWin(dt: number): void {
    const s = this.state;
    let claimable = 0;
    for (const c of s.board.cells) if (c.kind !== 'rock') claimable++;
    for (const seat of s.seats) {
      if (!seat.alive) continue;
      /*
       * Swept off the board: no seedling and no tiles. However it happened — the mat
       * withered, it was eaten a cell at a time, or a rootless spore was finally run
       * down — there is nothing left to play with.
       *
       * Needed once SPORE stopped dying with its seedling: without it, a spore whose
       * last tile was eaten stayed "alive" holding nothing, so `alive.length` never
       * fell to one and the match could not end.
       */
      if (seat.tiles === 0 && this.seedlingsOf(seat.seat).length === 0) {
        seat.alive = false;
        this.emit({ t: 'eliminated', seat: seat.seat });
        continue;
      }
      /*
       * Entombed: no way to gain ground anywhere means the garden is over for you.
       *
       * This must consider PASSIVE growth, not just taps. FUNGAL deliberately has no
       * legal tap on empty soil — the mycelium creeps on its own — so a tap-only
       * liveness check eliminated it on the first tick of every match.
       */
      const role = this.effectiveRole(seat.seat);
      let canAct = false;
      for (let i = 0; i < s.board.cells.length && !canAct; i++) {
        const kind = legalTap(s.board, s.seats, seat.seat, role, i);
        // A repel is not a way to gain ground, so it is not evidence of life. Your
        // own seedling is ALWAYS a legal repel target, so counting it here would
        // mean nobody could ever be entombed again.
        if (kind && kind !== 'repel') canAct = true;
      }
      if (!canAct && role.creep) canAct = this.hasCreepRoom(seat.seat);
      if (!canAct && seat.tiles > 0) {
        seat.alive = false;
        this.emit({ t: 'eliminated', seat: seat.seat });
      }
      const frac = seat.tiles / Math.max(1, claimable);
      s.holdTimers[seat.seat] = frac >= TERRITORY_FRACTION ? s.holdTimers[seat.seat] + dt : 0;
      if (s.holdTimers[seat.seat] >= TERRITORY_HOLD_SEC) {
        s.phase = 'complete';
        this.emit({ t: 'win', seat: seat.seat, reason: 'territory' });
      }
    }
    const alive = s.seats.filter((x) => x.alive);
    if (alive.length === 1 && s.seats.length > 1 && s.phase === 'playing') {
      s.phase = 'complete';
      this.emit({ t: 'win', seat: alive[0].seat, reason: 'home' });
    }
  }

  get events(): BloomEvent[] {
    return this.state.events;
  }
}

function rawNeighbours(i: number): number[] {
  const x = i % BOARD_W;
  const y = Math.floor(i / BOARD_W);
  const out: number[] = [];
  if (y > 0) out.push(i - BOARD_W);
  if (x < BOARD_W - 1) out.push(i + 1);
  if (y < BOARD_H - 1) out.push(i + BOARD_W);
  if (x > 0) out.push(i - 1);
  return out;
}
