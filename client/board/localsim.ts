/**
 * BLOOM — local garden.
 *
 * A self-contained runner of the BLOOM rules, used for two things and nothing else:
 *
 *   1. ATTRACT MODE. The menus sit on top of a live board so the game is showing
 *      you what it is before you have pressed anything. Colour and motion teach.
 *   2. PRACTICE. One human against bots with no server, which is also how the
 *      touch loop is verified end to end.
 *
 * It is NOT authority. Online, every snapshot comes from the server and this file
 * is not running. Keeping it here (client-side, disposable) means the client is
 * never a blank screen, and it never gets to disagree with a real match.
 */

import type { Board, Cell, GameMode, MatchState, RoleDef, RoleId, Seat, TechId } from '@shared/bloom.js';
import { BOARD_H, BOARD_W, TECHS, TECH_BARK_TOUGH, TECH_ENZYME_BONUS, TECH_FEED_ENERGY, ENERGY_PER_TILE, HOME_CAPTURE_TIME, BOND_COST, BOND_TIME, CYCLE_SEC, DAY_SUN_BONUS, NIGHT_CREEP_MUL, NIGHT_DIGEST_BONUS, NIGHT_GROW_MUL, isAllied, isDay, INSECT_STEP, INSECT_LIFE, INSECT_COST, INSECT_CAP, TECH_GROW_SPEED, TECH_SOLAR_BONUS, TECH_WITHER_MUL } from '@shared/bloom.js';
import type { BloomEvent } from '@shared/bloom.js';
import { makeRng } from '@shared/math.js';
import { getRole, idx, legalTap, neighbours, xy } from './rules.js';

const ENERGY_PASSIVE = 1 / 3;
const ENERGY_PER_SUN = 1 / 2;
const WITHER_SEC = 2;
const TERRITORY_WIN = 0.6;
const HOLD_WIN_SEC = 15;

export interface LocalOpts {
  mode: GameMode;
  /** Roles by seat. Seat 0 is the human unless `botAll`. */
  roles: RoleId[];
  names: string[];
  seed: number;
  /** Attract mode: nobody is human, every seat is played by the machine. */
  botAll?: boolean;
}

function blank(kind: Cell['kind'] = 'soil'): Cell {
  return { kind, owner: -1, progress: 0, claimant: -1, wither: 0, connected: false, spore: 0 };
}

export class LocalGarden {
  state: MatchState;
  private rng: () => number;
  private botClock: number[] = [];
  private creepClock: number[] = [];
  private nextInsect = 1;
  private opts: LocalOpts;

  constructor(opts: LocalOpts) {
    this.opts = opts;
    this.rng = makeRng(opts.seed);
    this.state = this.build();
  }

  private build(): MatchState {
    const n = this.opts.roles.length;
    const cells: Cell[] = [];
    for (let i = 0; i < BOARD_W * BOARD_H; i++) cells.push(blank());

    // Rocks in mirrored clumps: chokepoints are the entire strategic game, so they
    // must be fair and they must be obvious.
    const rocks = new Set<number>();
    for (let k = 0; k < 16; k++) {
      const x = 1 + Math.floor(this.rng() * (BOARD_W / 2 - 1));
      const y = 2 + Math.floor(this.rng() * (BOARD_H - 4));
      const len = 1 + Math.floor(this.rng() * 3);
      const vert = this.rng() > 0.5;
      for (let s = 0; s < len; s++) {
        const px = vert ? x : x + s;
        const py = vert ? y + s : y;
        if (px >= BOARD_W || py >= BOARD_H) continue;
        rocks.add(idx(px, py));
        rocks.add(idx(BOARD_W - 1 - px, BOARD_H - 1 - py));
      }
    }
    for (const r of rocks) cells[r].kind = 'rock';

    // Suns on the mid band, mirrored, so nobody starts next to all the food.
    const sunSpots = [
      [2, 5],
      [9, 12],
      [5, 8],
      [6, 9],
      [1, 11],
      [10, 6],
    ];
    for (const [x, y] of sunSpots) {
      const i = idx(x, y);
      if (cells[i].kind !== 'rock') cells[i].kind = 'sun';
    }

    const homeSpots = [
      idx(Math.floor(BOARD_W / 2) - 1, BOARD_H - 2),
      idx(Math.floor(BOARD_W / 2), 1),
      idx(1, Math.floor(BOARD_H / 2)),
      idx(BOARD_W - 2, Math.floor(BOARD_H / 2)),
    ];
    const homes: number[] = [];
    const seats: Seat[] = [];
    for (let s = 0; s < n; s++) {
      const home = homeSpots[s];
      homes.push(home);
      const c = cells[home];
      c.kind = 'home';
      c.owner = s;
      c.connected = true;
      // Clear a breathing hole around every home; nobody starts entombed.
      for (const nb of rawNeighbours(home)) if (cells[nb].kind === 'rock') cells[nb].kind = 'soil';
      const role = getRole(this.opts.roles[s]);
      seats.push({
        seat: s,
        playerId: `local-${s}`,
        name: this.opts.names[s] ?? role.name,
        role: role.id,
        colour: role.colour,
        energy: 4,
        tiles: 1,
        alive: true,
        connected: true,
        isBot: !!this.opts.botAll || s > 0,
      });
      this.botClock.push(0.4 + this.rng() * 0.8);
    }

    const board: Board = { w: BOARD_W, h: BOARD_H, cells, homes };
    return {
      tick: 0,
      mode: this.opts.mode,
      phase: 'playing',
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
    const def = TECHS.find((t) => t.id === id);
    if (!def) return false;
    const owned = this.techFor(seat);
    if (owned.has(id)) return false;
    // Enforce the tree in the MODEL, not just the UI. A hidden button is not a
    // rule — bots and any future server path go through here too.
    if (def.requires && !owned.has(def.requires)) return false;
    if (def.role && def.role !== s.seats[seat].role) return false;
    if (s.seats[seat].energy < def.cost) return false;
    s.seats[seat].energy -= def.cost;
    owned.add(id);
    return true;
  }

  techFor(seat: number): Set<TechId> {
    if (!this.tech[seat]) this.tech[seat] = new Set();
    return this.tech[seat];
  }

  /** Role stats after this seat's upgrades. The sim reads this, never the raw role. */
  private effectiveRole(seat: number): RoleDef {
    const base = getRole(this.state.seats[seat].role);
    const owned = this.techFor(seat);
    if (owned.size === 0) return base;
    const r: RoleDef = { ...base };

    // --- shared roots
    if (owned.has('surge')) {
      r.growTime *= TECH_GROW_SPEED;
      r.captureTime *= TECH_GROW_SPEED;
    }
    if (owned.has('deeproot')) r.witherMul *= TECH_WITHER_MUL;

    // --- VINE: distance
    if (owned.has('whip')) r.reach += 2;
    if (owned.has('lash')) r.growCost = Math.max(1, r.growCost - 1);
    if (owned.has('canopy')) r.growTime *= 0.45;

    // --- MOSS: bulk
    if (owned.has('carpet')) r.blockSize += 1;
    if (owned.has('bark')) r.toughness *= TECH_BARK_TOUGH;
    if (owned.has('bog')) r.witherMul = 0.05; // effectively never rots

    // --- SPORE: reach
    if (owned.has('drift')) { r.sporeLife += 6; r.hop = (r.hop ?? 4) + 3; }
    if (owned.has('pod')) r.growCost = Math.max(1, r.growCost - 2);
    // 'burst' is handled at landing time, not as a stat.

    // --- FUNGAL: digestion
    if (owned.has('mycelium') && r.creep) r.creep *= 0.5;
    if (owned.has('enzyme') && r.digest) r.digest += TECH_ENZYME_BONUS;
    // 'bloomcap' is handled at capture time.

    // --- THORN: contact
    if (owned.has('barbs')) r.captureTime *= 0.5;
    // 'feed' and 'swarm' are handled at capture time.

    return r;
  }

  tap(seat: number, cell: number): boolean {
    const s = this.state;
    if (s.phase !== 'playing') return false;
    const role = this.effectiveRole(seat);
    const kind = legalTap(s.board, s.seats, seat, role, cell);
    if (!kind) return false;
    // You cannot eat an ally.
    const target = s.board.cells[cell];
    if (target.owner >= 0 && target.owner !== seat && isAllied(s.allies, seat, target.owner)) {
      s.events.push({ t: 'denied', cell, seat, reason: 'illegal' });
      return false;
    }
    const cost = kind === 'attack' ? this.costOf(seat, cell) : role.growCost;
    if (s.seats[seat].energy < cost) {
      s.events.push({ t: 'denied', cell, seat, reason: 'energy' });
      return false;
    }
    s.seats[seat].energy -= cost;
    for (const target of this.footprint(seat, cell, kind)) {
      const c = s.board.cells[target];
      if (c.claimant === seat && c.progress > 0) continue;
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
    s.events = [];
    if (s.phase !== 'playing') return;
    s.tick++;
    s.clock += dt;

    this.stepEnergy(dt);
    this.stepCreep(dt);
    this.stepInsects(dt);
    this.stepClaims(dt);
    this.connectivity();
    this.stepWither(dt);
    for (let i = 0; i < s.seats.length; i++) if (s.seats[i].isBot) this.stepBot(i, dt);
    this.stepWin(dt);
  }

  private stepEnergy(dt: number): void {
    const s = this.state;
    const suns = s.seats.map(() => 0);
    for (const c of s.board.cells) if (c.kind === 'sun' && c.owner >= 0 && c.connected) suns[c.owner]++;
    for (const seat of s.seats) {
      if (!seat.alive) continue;
      // Sun tiles only photosynthesise in daylight — and pay extra while they do.
      const day = isDay(s.clock);
      const sunRate =
        (day ? (ENERGY_PER_SUN + (this.techFor(seat.seat).has('solar') ? TECH_SOLAR_BONUS : 0)) * DAY_SUN_BONUS : 0);
      // Territory is an economy: every tile you hold funds the next one.
      const fromTiles = ENERGY_PER_TILE * seat.tiles;
      seat.energy = Math.min(20, seat.energy + (ENERGY_PASSIVE + sunRate * suns[seat.seat] + fromTiles) * dt);
    }
  }

  private stepClaims(dt: number): void {
    const s = this.state;
    for (let i = 0; i < s.board.cells.length; i++) {
      const c = s.board.cells[i];
      if (c.claimant < 0 || c.progress <= 0) continue;
      // Upgraded stats, not the raw role — reading `getRole` here was why SURGE
      // (and the defender's toughness techs) did nothing at all.
      const role = this.effectiveRole(c.claimant);
      const contested = c.owner >= 0 && c.owner !== c.claimant;
      const defenderTough = contested ? this.effectiveRole(c.owner).toughness : 1;
      // A seedling is the slowest thing on the board to take, on purpose: it is a
      // decisive, visible commitment rather than a stray tap.
      const night = !isDay(s.clock);
      // Bonds make a tile slow as well as costly, and most plants grow worse at night.
      const bondSlow = contested ? this.bondsOf(i) * BOND_TIME : 0;
      const nightMul = night && !role.creep ? NIGHT_GROW_MUL : 1;
      const dur =
        (c.kind === 'home'
          ? HOME_CAPTURE_TIME * defenderTough
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
          s.events.push({ t: 'captured', cell: i, seat: c.owner, from });
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
            s.seats[c.owner].energy = Math.min(20, s.seats[c.owner].energy + bite);
            if (owned.has('bloomcap')) this.creepFrom(i, c.owner);
          }
          // Taking a seedling knocks its owner out and their whole network dies.
          if (c.kind === 'home' && from >= 0) {
            s.seats[from].alive = false;
            s.board.homes[from] = -1;
            s.events.push({ t: 'eliminated', seat: from });
          }
          if (owned.has('feed')) {
            s.seats[c.owner].energy = Math.min(20, s.seats[c.owner].energy + TECH_FEED_ENERGY);
          }
          if (this.effectiveRole(c.owner).parasite) {
            // SWARM pushes the infection a second ring outward.
            this.infect(i, c.owner, owned.has('swarm') ? 2 : 1);
          }
        } else {
          s.events.push({ t: 'claimed', cell: i, seat: c.owner });
          if (this.techFor(c.owner).has('burst') && this.effectiveRole(c.owner).remote) {
            this.infect(i, c.owner, 1);
          }
        }
      }
    }
  }

  /**
   * How many friendly neighbours the tile's OWNER has around it. A deeply bonded
   * tile is expensive and slow to take; an exposed tip is cheap.
   */
  bondsOf(cell: number): number {
    const s = this.state;
    const c = s.board.cells[cell];
    if (!c || c.owner < 0) return 0;
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
    return Math.round(role.attackCost + this.bondsOf(cell) * BOND_COST);
  }

  /** Hatch an insect on one of this seat's tiles. Returns false if it cannot. */
  hatchInsect(seat: number): boolean {
    const s = this.state;
    const role = this.effectiveRole(seat);
    if (!role.creep) return false; // fungal only
    if (s.seats[seat].energy < INSECT_COST) return false;
    if (s.insects.filter((b) => b.seat === seat).length >= INSECT_CAP) return false;
    const mine: number[] = [];
    for (let i = 0; i < s.board.cells.length; i++) {
      if (s.board.cells[i].owner === seat && s.board.cells[i].connected) mine.push(i);
    }
    if (mine.length === 0) return false;
    const cell = mine[Math.floor(this.rng() * mine.length)];
    s.seats[seat].energy -= INSECT_COST;
    s.insects.push({ id: this.nextInsect++, seat, cell, clock: INSECT_STEP, life: INSECT_LIFE });
    s.events.push({ t: 'hatch', cell, seat });
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
        s.board.cells[target].owner = bug.seat;
        s.board.cells[target].claimant = -1;
        s.board.cells[target].progress = 0;
        s.events.push({ t: 'bite', cell: target, seat: bug.seat });
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
          edge.push(n);
        }
      }
      if (edge.length === 0) continue;
      const pick = edge[Math.floor(this.rng() * edge.length)];
      s.board.cells[pick].owner = seat.seat;
      s.events.push({ t: 'claimed', cell: pick, seat: seat.seat });
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
          nb.owner = seat;
          s.events.push({ t: 'claimed', cell: n, seat });
          next.push(n);
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
  }

  /** Flood from every home over that seat's tiles. Everything else is cut. */
  private connectivity(): void {
    const s = this.state;
    const seen = new Uint8Array(s.board.cells.length);
    const queue: number[] = [];
    for (let seat = 0; seat < s.seats.length; seat++) {
      const home = s.board.homes[seat];
      // An eliminated seat's home is set to -1; guard before indexing.
      if (home === undefined || home < 0 || home >= s.board.cells.length) continue;
      const hc = s.board.cells[home];
      if (!hc || hc.owner !== seat) continue;
      seen[home] = 1;
      queue.push(home);
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
      if (!getRole(s.seats[c.owner].role).rootsAnywhere) continue;
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
      else if (c.wither <= 0) c.wither = WITHER_SEC / this.effectiveRole(c.owner).witherMul;
    }
    for (const [seat, count] of severed) {
      s.events.push({ t: 'severed', seat, count, cause: -1 });
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
        s.events.push({ t: 'withered', cell: i, seat });
      }
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
    const role = getRole(s.seats[seat].role);
    this.botClock[seat] = 0.35 + this.rng() * 0.7;

    const options: Array<{ cell: number; score: number }> = [];
    for (let i = 0; i < s.board.cells.length; i++) {
      const kind = legalTap(s.board, s.seats, seat, role, i);
      if (!kind) continue;
      const cost = kind === 'attack' ? this.costOf(seat, i) : role.growCost;
      if (s.seats[seat].energy < cost) continue;
      let score = this.rng() * 0.6;
      const c = s.board.cells[i];
      if (c.kind === 'sun') score += 2.4;
      if (kind === 'attack') score += 1.4 + (role.id === 'thorn' ? 1.6 : 0);
      // Prefer taps that thin an enemy's neck — the cut is the point of the game.
      if (kind === 'attack') {
        let enemyNb = 0;
        for (const n of neighbours(s.board, i)) if (s.board.cells[n].owner === c.owner) enemyNb++;
        if (enemyNb <= 2) score += 2.2;
      }
      const p = xy(i);
      const hp = xy(s.board.homes[seat] ?? 0);
      score += 1.2 - Math.min(1, (Math.abs(p.x - hp.x) + Math.abs(p.y - hp.y)) / 24);
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
       * Entombed: no way to gain ground anywhere means the garden is over for you.
       *
       * This must consider PASSIVE growth, not just taps. FUNGAL deliberately has no
       * legal tap on empty soil — the mycelium creeps on its own — so a tap-only
       * liveness check eliminated it on the first tick of every match.
       */
      const role = this.effectiveRole(seat.seat);
      let canAct = false;
      for (let i = 0; i < s.board.cells.length && !canAct; i++) {
        if (legalTap(s.board, s.seats, seat.seat, role, i)) canAct = true;
      }
      if (!canAct && role.creep) canAct = this.hasCreepRoom(seat.seat);
      if (!canAct && seat.tiles > 0) {
        seat.alive = false;
        s.events.push({ t: 'eliminated', seat: seat.seat });
      }
      const frac = seat.tiles / Math.max(1, claimable);
      s.holdTimers[seat.seat] = frac >= TERRITORY_WIN ? s.holdTimers[seat.seat] + dt : 0;
      if (s.holdTimers[seat.seat] >= HOLD_WIN_SEC) {
        s.phase = 'complete';
        s.events.push({ t: 'win', seat: seat.seat, reason: 'territory' });
      }
    }
    const alive = s.seats.filter((x) => x.alive);
    if (alive.length === 1 && s.seats.length > 1 && s.phase === 'playing') {
      s.phase = 'complete';
      s.events.push({ t: 'win', seat: alive[0].seat, reason: 'home' });
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
