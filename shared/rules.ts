/**
 * BLOOM — the rules. Geometry, role definitions, and tap legality.
 *
 * SHARED, and that is the whole point: the server imports this to decide what a
 * tap actually did, and the client imports the SAME functions to light up the
 * cells you may legally poke on touch-down. One implementation, so the highlight
 * cannot disagree with the outcome.
 *
 * This used to be a client-side *mirror* of rules the server owned separately.
 * That is a standing invitation to divergence — the highlight says yes, the server
 * says no, and the player learns not to trust the game. Nothing in here touches
 * the DOM or the socket, so both sides can hold it.
 */

import type { Board, Cell, RoleDef, RoleId, Seat } from './bloom.js';
import { BOARD_W, INSECT_DEFENCE, INSECT_FUNGAL_DEFENCE, INSECT_SPORE_DEFENCE, NEIGHBOURS, REPEL_COST, WOOD_DEFENCE, WOOD_THORN_DEFENCE } from './bloom.js';

// ---------------------------------------------------------------- geometry

export function idx(x: number, y: number, w: number = BOARD_W): number {
  return y * w + x;
}

export function xy(i: number, w: number = BOARD_W): { x: number; y: number } {
  return { x: i % w, y: Math.floor(i / w) };
}

export function inBounds(x: number, y: number, board: Board): boolean {
  return x >= 0 && y >= 0 && x < board.w && y < board.h;
}

/** 4-neighbour cell indices of `i`, clipped to the board. */
export function neighbours(board: Board, i: number): number[] {
  const p = xy(i, board.w);
  const out: number[] = [];
  for (const [dx, dy] of NEIGHBOURS) {
    const x = p.x + dx;
    const y = p.y + dy;
    if (inBounds(x, y, board)) out.push(idx(x, y, board.w));
  }
  return out;
}

export function cellAt(board: Board, i: number): Cell | null {
  return i >= 0 && i < board.cells.length ? board.cells[i] : null;
}

// ---------------------------------------------------------------- roles

/**
 * Presentation truth for the four roles. Colours and verbs are the whole UI
 * contract: a child reads the game by colour and by the shape a tap makes.
 */
export const ROLE_LIST: RoleDef[] = [
  {
    id: 'vine',
    name: 'VINE',
    blurb: 'throws long runners',
    colour: '#3ddc6b',
    growTime: 0.7,
    captureTime: 2.2,
    growCost: 1,
    attackCost: 3,
    witherMul: 2,
    toughness: 1,
    reach: 4,
    blockSize: 1,
    remote: false,
    sporeLife: 0,
  },
  {
    id: 'moss',
    name: 'MOSS',
    blurb: 'claims big tough patches',
    colour: '#4da3ff',
    growTime: 1.9,
    captureTime: 2.2,
    growCost: 2,
    attackCost: 3,
    witherMul: 0.6,
    toughness: 2,
    reach: 1,
    blockSize: 2,
    remote: false,
    sporeLife: 0,
  },
  {
    id: 'spore',
    name: 'SPORE',
    blurb: 'hops over walls and rocks',
    colour: '#c46bff',
    growTime: 1.2,
    captureTime: 2.0,
    growCost: 2,
    attackCost: 3,
    witherMul: 1.4,
    toughness: 0.8,
    reach: 1,
    blockSize: 1,
    remote: true,
    sporeLife: 9,
    hop: 5,
    rootsAnywhere: true,
    ignoresBonds: true,
    sunKills: true,
    poisonImmune: true,
  },
  {
    id: 'fungal',
    name: 'FUNGAL',
    blurb: 'eats to live — nothing else feeds it',
    colour: '#e8c15a',
    growTime: 1.4,
    captureTime: 1.4,
    growCost: 2,
    /*
     * Eating is FREE, and it has to be: digestion is the fungus's ONLY income (see
     * `stepEnergy`), so a mycelium that ran dry while priced out of the one action
     * that earns would be dead on the board with no way back.
     */
    attackCost: 0,
    witherMul: 1,
    toughness: 1.2,
    reach: 1,
    blockSize: 1,
    remote: false,
    sporeLife: 0,
    /*
     * A fungus has no trunk to cut. Every mycelium tile is its own root, so the
     * network never has to trace home and losing the seedling does not kill it —
     * the same rule SPORE plays by, for the same reason.
     */
    rootsAnywhere: true,
    /* Pays nobody's bonds, and collects nobody's — a mycelium braces nothing. */
    ignoresBonds: true,
    noBondDefence: true,
    sunKills: true,
    poisonImmune: true,
    creep: 2.6,
    digest: 2,
  },
  {
    id: 'thorn',
    name: 'THORN',
    blurb: 'eating spreads it sideways',
    colour: '#ff5a3c',
    growTime: 1.1,
    captureTime: 0.7,
    growCost: 1,
    attackCost: 1,
    witherMul: 1,
    toughness: 1.5,
    reach: 1,
    blockSize: 1,
    remote: false,
    sporeLife: 0,
    parasite: true,
  },
];

const BY_ID = new Map<RoleId, RoleDef>(ROLE_LIST.map((r) => [r.id, r]));

export function getRole(id: RoleId): RoleDef {
  return BY_ID.get(id) ?? ROLE_LIST[0];
}

export const ROLE_IDS: RoleId[] = ROLE_LIST.map((r) => r.id);

/** Seat colours when the server has not assigned one yet (lobby previews). */
export const SEAT_COLOURS = ['#3ddc6b', '#4da3ff', '#c46bff', '#ff5a3c', '#e8c15a'];

export function seatColour(seats: Seat[], seat: number): string {
  const s = seats[seat];
  if (s?.colour) return s.colour;
  // Modulo the real length, not `& 3` — that masked seat 4 back onto seat 0's
  // colour, so a five-plant garden had two greens in any lobby preview that fell
  // back to this before the server had assigned seats.
  return SEAT_COLOURS[seat % SEAT_COLOURS.length];
}

// ---------------------------------------------------------------- legality

export type TapKind = 'grow' | 'attack' | 'spore' | 'repel';

/**
 * What would tapping `cell` do? `null` means nothing — the cell must not light up
 * on touch-down and the tap must not be sent.
 */
export function legalTap(
  board: Board,
  seats: Seat[],
  seat: number,
  role: RoleDef,
  cell: number,
): TapKind | null {
  const c = cellAt(board, cell);
  if (!c) return null;
  if (c.kind === 'rock') return null;
  // Sunlight is lethal to the rot-plants; they may not even reach for it.
  if (c.kind === 'sun' && role.sunKills) return null;
  /*
   * An ENEMY seedling is conquerable — just very slow to take. That is what gives an
   * attack a point beyond attrition: crack someone's seedling and they are out.
   *
   * YOUR OWN seedling is the one cell of yours you may tap, and doing so repels
   * whoever is leaning on it — while it is off cooldown. See `REPEL_COST`.
   */
  if (c.kind === 'home' && c.owner === seat) {
    return (seats[seat]?.repelCooldown ?? 0) > 0 ? null : 'repel';
  }
  if (c.owner === seat) return null; // already yours

  let touching = false;
  for (const n of neighbours(board, cell)) {
    if (board.cells[n].owner === seat) {
      touching = true;
      break;
    }
  }

  if (c.owner < 0) {
    /*
     * SPORE jumps, but not to the far side of the world.
     *
     * Landing literally anywhere meant floating tiles with no relationship to your
     * network — which is both confusing to look at and, measured, terrible to play:
     * scattered singles never connect, so they wither. A bounded hop keeps the verb
     * ("I can cross a wall or a rock") while every landing is still about YOUR mat.
     */
    if (role.remote) return withinHop(board, seat, cell, role.hop ?? 4) ? 'spore' : null;
    /*
     * THORN cannot claim empty ground AT ALL. It is a parasite: the only way it
     * grows is by taking someone else's tile. This is the difference between a
     * role and a stat block — without it THORN was just a slower VINE.
     */
    // THORN plants like anyone else; its verb is what happens when it EATS
    // (see localsim: a completed capture infects every neutral cell around it).
    if (role.parasite) return touching ? 'grow' : null;
    /*
     * FUNGAL never hand-plants on soil — the mycelium creeps there on its own.
     * Every tap it spends is an attack, which is what makes it play completely
     * differently from the four that grow by tapping.
     */
    if (role.creep) return null;
    // VINE reaches down a straight line; everyone else needs contact.
    if (role.reach > 1 && !touching) return lineFrom(board, seat, cell, role.reach) ? 'grow' : null;
    return touching ? 'grow' : null;
  }

  // Enemy tile. Everyone, SPORE included, still needs contact to eat.
  const victim = seats[c.owner];
  if (victim && !victim.alive) return touching ? 'grow' : null;
  return touching ? 'attack' : null;
}

/**
 * For VINE: is `cell` on a straight orthogonal run of at most `reach` empty cells
 * starting from one of `seat`'s tiles? Returns the run, nearest cell first.
 *
 * This is what makes VINE a different game rather than a faster one — it throws a
 * whole runner across open ground in one tap, so it plays for distance and cut-off
 * lines, while MOSS plays for area and THORN plays for contact.
 */
/** Is `cell` within `hop` cells (manhattan) of any tile this seat owns? */
function withinHop(board: Board, seat: number, cell: number, hop: number): boolean {
  const a = xy(cell, board.w);
  for (let i = 0; i < board.cells.length; i++) {
    if (board.cells[i].owner !== seat) continue;
    const b = xy(i, board.w);
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) <= hop) return true;
  }
  return false;
}

export function lineFrom(board: Board, seat: number, cell: number, reach: number): number[] | null {
  const { x, y } = xy(cell, board.w);
  for (const [dx, dy] of [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ] as const) {
    const run: number[] = [];
    // Walk backwards from the target toward the player's territory.
    for (let step = 1; step <= reach; step++) {
      const px = x + dx * step;
      const py = y + dy * step;
      if (!inBounds(px, py, board)) break;
      const p = board.cells[idx(px, py, board.w)];
      if (p.owner === seat) {
        // Found the root: everything between is the run.
        run.reverse();
        return [cell, ...run];
      }
      if (p.kind === 'rock' || p.owner >= 0) break; // blocked; try another direction
      run.push(idx(px, py, board.w));
    }
  }
  return null;
}

/**
 * How much longer a tile takes to capture because of the ground it sits on.
 *
 * WOOD braces its holder, INSECT ground rots them, and both have an exception:
 * THORN gets nothing from timber, and SPORE (whose larder the insect beds are) is
 * untroubled by them, with FUNGAL only mildly bothered.
 */
export function terrainDefence(kind: Cell['kind'], owner: RoleDef | null): number {
  if (kind === 'wood') return owner?.parasite ? WOOD_THORN_DEFENCE : WOOD_DEFENCE;
  if (kind === 'insect') {
    if (owner?.remote) return INSECT_SPORE_DEFENCE;
    return owner?.digest ? INSECT_FUNGAL_DEFENCE : INSECT_DEFENCE;
  }
  return 1;
}

/** Energy a tap of this kind costs, for the client-side "can't afford" shake. */
export function tapCost(role: RoleDef, kind: TapKind): number {
  if (kind === 'repel') return REPEL_COST;
  return kind === 'attack' ? role.attackCost : role.growCost;
}

/**
 * Every cell the local player could legally poke. Recomputed on touch-down.
 *
 * Presentation only, which is why the "already being taken" filter lives here and
 * NOT in `legalTap`: the simulation's liveness check asks `legalTap` whether a seat
 * has any move left, and a seat whose only targets happen to be mid-claim — its own
 * claims included — would be judged entombed and eliminated mid-tap.
 *
 * Lighting up a cell that is already filling in is a lie either way: the tap will be
 * refused, and before that refusal existed it silently cost a full attack.
 */
export function legalCells(
  board: Board,
  seats: Seat[],
  seat: number,
  role: RoleDef,
): Map<number, TapKind> {
  const out = new Map<number, TapKind>();
  for (let i = 0; i < board.cells.length; i++) {
    const k = legalTap(board, seats, seat, role, i);
    if (!k) continue;
    /*
     * A cell already filling in is not tappable — EXCEPT your own seedling, where a
     * claim in progress is precisely the reason to tap it. Hiding it then would take
     * the repel away at the only moment it matters.
     */
    if (k !== 'repel' && isBeingTaken(board, i)) continue;
    out.set(i, k);
  }
  return out;
}

/** Is a claim already filling this cell? Such a tap does nothing, for anyone. */
export function isBeingTaken(board: Board, cell: number): boolean {
  const c = cellAt(board, cell);
  return !!c && c.claimant >= 0 && c.progress > 0;
}
