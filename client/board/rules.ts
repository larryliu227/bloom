/**
 * BLOOM — client-side rule mirror.
 *
 * The server is authoritative for every outcome. This module exists so the client
 * can answer two *presentation* questions instantly, with no round trip:
 *
 *   1. "which cells may I legally poke right now?"  (the touch-down highlight,
 *      which is how a child learns the rule — by poking, not by reading)
 *   2. "what colour / shape / verb belongs to this role?"
 *
 * It is deliberately a mirror rather than a hard dependency on `@shared/board.ts`
 * and `@shared/roles.ts`: a wrong highlight is corrected by the next `match`
 * snapshot within one tick, so a divergence is cosmetic and self-healing, while a
 * missing module would take the whole client offline. When those shared modules
 * land, the three functions below become one-line re-exports.
 */

import type { Board, Cell, RoleDef, RoleId, Seat } from '@shared/bloom.js';
import { BOARD_W, NEIGHBOURS } from '@shared/bloom.js';

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
  },
  {
    id: 'fungal',
    name: 'FUNGAL',
    blurb: 'creeps by itself, eats to feed',
    colour: '#e8c15a',
    growTime: 1.4,
    captureTime: 1.4,
    growCost: 2,
    attackCost: 1,
    witherMul: 1,
    toughness: 1.2,
    reach: 1,
    blockSize: 1,
    remote: false,
    sporeLife: 0,
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
  return SEAT_COLOURS[seat & 3];
}

// ---------------------------------------------------------------- legality

export type TapKind = 'grow' | 'attack' | 'spore';

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
  /*
   * The seedling (home) IS conquerable now — it is just very slow to take. This is
   * what gives an attack a point beyond attrition: crack someone's seedling and they
   * are out, and every tile they own dies with them.
   */
  if (c.kind === 'home' && c.owner === seat) return null; // never your own
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

/** Energy a tap of this kind costs, for the client-side "can't afford" shake. */
export function tapCost(role: RoleDef, kind: TapKind): number {
  return kind === 'attack' ? role.attackCost : role.growCost;
}

/** Every cell the local player could legally poke. Recomputed on touch-down. */
export function legalCells(
  board: Board,
  seats: Seat[],
  seat: number,
  role: RoleDef,
): Map<number, TapKind> {
  const out = new Map<number, TapKind>();
  for (let i = 0; i < board.cells.length; i++) {
    const k = legalTap(board, seats, seat, role, i);
    if (k) out.set(i, k);
  }
  return out;
}
