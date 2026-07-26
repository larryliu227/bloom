/**
 * VOIDLINE — the Weave puzzle engine.  (Owner: Agent A)
 *
 * A Weave board is a square grid of conduit tiles. Power originates at the
 * `core` tile in the middle of the board and flows outward through tiles whose
 * open edges line up. Three `slot` tiles sit on the board's rim; while a slot
 * is connected to the core it charges, and a charged slot can fire an ability.
 *
 * Edge mask bits (`edgeMaskFor` applies the tile's current rotation):
 *
 *            1 (up)
 *      8 (left) + 2 (right)
 *           4 (down)
 *
 * Two adjacent tiles are connected only if BOTH have an open edge facing the
 * other. Rotating clockwise maps up->right->down->left->up.
 *
 * Everything in here is pure and deterministic: no `Math.random()`, no
 * `Date.now()`. Every stochastic entry point takes an explicit `seed`.
 *
 * Dependency note: the seeded RNG (mulberry32) is implemented locally on
 * purpose. This module deliberately does NOT import `./math.js` so that board
 * generation can never be perturbed by unrelated changes in the sim helpers.
 */

import {
  ABILITY_SLOTS,
  CHARGE_DECAY_RATE,
  CHARGE_RATE_BASE,
  MAX_OVERCHARGE,
  WEAVE_SIZE,
} from './constants.js';
import type {
  AbilityDef,
  AbilityId,
  EdgeMask,
  TileKind,
  WeaveBoard,
  WeaveSlot,
  WeaveTile,
} from './types.js';

// ============================================================ edge geometry

export const UP: EdgeMask = 1;
export const RIGHT: EdgeMask = 2;
export const DOWN: EdgeMask = 4;
export const LEFT: EdgeMask = 8;
export const ALL_EDGES: EdgeMask = 15;

/** Direction index 0..3 == clockwise order: up, right, down, left. */
const DIR_BITS: readonly EdgeMask[] = [UP, RIGHT, DOWN, LEFT];
const DIR_DX: readonly number[] = [0, 1, 0, -1];
const DIR_DY: readonly number[] = [-1, 0, 1, 0];

/** Base (rotation-0) edge mask for every tile kind. `slot` is overridden per tile. */
export const TILE_BASE: Record<TileKind, EdgeMask> = {
  empty: 0,
  straight: UP | DOWN, // 5
  elbow: UP | RIGHT, // 3
  tee: UP | RIGHT | DOWN, // 7
  cross: ALL_EDGES, // 15
  core: ALL_EDGES, // 15 — power source, radiates in every direction
  slot: UP, // placeholder; createBoard points it inward
  blocked: 0,
  relay: ALL_EDGES, // 15 — coop mirror node, conducts in every direction
};

/** Every rotation of every rotatable kind, indexed [rotation]. */
const KIND_MASKS: Record<'straight' | 'elbow' | 'tee' | 'cross', readonly EdgeMask[]> = {
  straight: [5, 10, 5, 10],
  elbow: [3, 6, 12, 9],
  tee: [7, 14, 13, 11],
  cross: [15, 15, 15, 15],
};

const FIT_ORDER: readonly ('straight' | 'elbow' | 'tee' | 'cross')[] = [
  'straight',
  'elbow',
  'tee',
  'cross',
];

/** Rotate a 4-bit edge mask `r` quarter-turns clockwise. */
export function rotateMask(mask: EdgeMask, r: number): EdgeMask {
  const k = ((r % 4) + 4) % 4;
  const m = mask & 0xf;
  return ((m << k) | (m >>> (4 - k))) & 0xf;
}

/** Edge mask after applying the tile's rotation. */
export function edgeMaskFor(tile: WeaveTile): EdgeMask {
  if (!tile) return 0;
  return rotateMask(tile.base & 0xf, tile.rotation);
}

const OPPOSITE = [2, 3, 0, 1] as const;

function popcount4(m: number): number {
  return (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
}

// ============================================================ tiny local utils

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** mulberry32 — 32-bit seeded PRNG. Same algorithm C uses in math.ts, kept local. */
function mulberry32(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = a ^ (a >>> 15);
    t = Math.imul(t, 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministically derive a sub-seed so independent streams never correlate. */
function mixSeed(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

function normalizeSize(size: number): number {
  const n = Math.floor(Number.isFinite(size) ? size : WEAVE_SIZE);
  return clamp(n, 3, 12);
}

function normalizeLoadout(loadout: AbilityId[]): AbilityId[] {
  const out: AbilityId[] = [];
  for (let i = 0; i < ABILITY_SLOTS; i++) {
    const id = loadout && loadout[i];
    out.push(typeof id === 'string' ? id : '');
  }
  return out;
}

// ============================================================ tile helpers

/** Construct a tile of the given kind at rotation 0. */
export function makeTile(kind: TileKind, rotation = 0, locked?: boolean): WeaveTile {
  const immovable = kind === 'core' || kind === 'slot' || kind === 'blocked' || kind === 'empty' || kind === 'relay';
  return {
    kind,
    base: TILE_BASE[kind],
    rotation: ((rotation % 4) + 4) % 4,
    locked: locked === undefined ? immovable : locked,
    powered: false,
  };
}

/** The `tiles` index of the tile feeding ability slot `slot`, or -1. */
export function slotTileIndex(board: WeaveBoard, slot: number): number {
  if (!board) return -1;
  for (let i = 0; i < board.tiles.length; i++) {
    const t = board.tiles[i];
    if (t.kind === 'slot' && t.slotIndex === slot) return i;
  }
  return -1;
}

/** True if the two tiles at `a` and `b` (must be adjacent) mutually face each other. */
export function tilesConnected(board: WeaveBoard, a: number, b: number): boolean {
  const n = board.size;
  const total = board.tiles.length;
  if (a < 0 || b < 0 || a >= total || b >= total) return false;
  const ax = a % n;
  const ay = (a / n) | 0;
  const bx = b % n;
  const by = (b / n) | 0;
  let d = -1;
  for (let i = 0; i < 4; i++) {
    if (ax + DIR_DX[i] === bx && ay + DIR_DY[i] === by) {
      d = i;
      break;
    }
  }
  if (d < 0) return false;
  return (
    (edgeMaskFor(board.tiles[a]) & DIR_BITS[d]) !== 0 &&
    (edgeMaskFor(board.tiles[b]) & DIR_BITS[OPPOSITE[d]]) !== 0
  );
}

/** Deep copy — safe to mutate and throw away (used by the solver and by tests). */
export function cloneBoard(board: WeaveBoard): WeaveBoard {
  return {
    size: board.size,
    coreIndex: board.coreIndex,
    tiles: board.tiles.map((t) => ({ ...t })),
    slots: board.slots.map((s) => ({ ...s })),
  };
}

/**
 * Coop helper: turn a cell into a `relay` node (see `linkRelays`).
 * Refuses the core, slot tiles and out-of-range indices. Returns success.
 */
export function placeRelay(board: WeaveBoard, index: number): boolean {
  if (!board || index < 0 || index >= board.tiles.length) return false;
  if (index === board.coreIndex) return false;
  const t = board.tiles[index];
  if (t.kind === 'slot' || t.kind === 'core' || t.kind === 'relay') return false;
  t.kind = 'relay';
  t.base = TILE_BASE.relay;
  t.rotation = 0;
  t.locked = true;
  t.powered = false;
  recomputePower(board);
  return true;
}

// ============================================================ power flood fill

const NO_SEEDS: readonly number[] = [];

/**
 * Pure flood fill. Returns a per-tile powered array without touching the board.
 * `seeds` are extra always-powered origins (used by `linkRelays`).
 */
function computePowered(board: WeaveBoard, seeds: readonly number[]): boolean[] {
  const n = board.size;
  const tiles = board.tiles;
  const total = tiles.length;
  const powered = new Array<boolean>(total).fill(false);
  const queue: number[] = [];

  const seed = (i: number): void => {
    if (i < 0 || i >= total) return;
    if (powered[i]) return;
    if ((tiles[i].base & 0xf) === 0) return; // empty / blocked conduct nothing
    powered[i] = true;
    queue.push(i);
  };

  seed(board.coreIndex);
  for (let s = 0; s < seeds.length; s++) seed(seeds[s]);

  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi];
    const mask = edgeMaskFor(tiles[i]);
    const x = i % n;
    const y = (i / n) | 0;
    for (let d = 0; d < 4; d++) {
      if ((mask & DIR_BITS[d]) === 0) continue;
      const nx = x + DIR_DX[d];
      const ny = y + DIR_DY[d];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (j < 0 || j >= total || powered[j]) continue;
      // Mutual connection: the neighbour must also open toward us.
      if ((edgeMaskFor(tiles[j]) & DIR_BITS[OPPOSITE[d]]) === 0) continue;
      powered[j] = true;
      queue.push(j);
    }
  }
  return powered;
}

/** Write a computed power state onto the board (tiles + slot connectivity). */
function applyPower(board: WeaveBoard, seeds: readonly number[]): void {
  const powered = computePowered(board, seeds);
  for (let i = 0; i < board.slots.length; i++) board.slots[i].connected = false;
  for (let i = 0; i < board.tiles.length; i++) {
    const t = board.tiles[i];
    t.powered = powered[i];
    if (t.kind === 'slot' && t.slotIndex !== undefined) {
      const s = board.slots[t.slotIndex];
      if (s) s.connected = s.connected || powered[i];
    }
  }
}

/** Flood-fill from the core; sets `tile.powered` and `slot.connected`. Call after any mutation. */
export function recomputePower(board: WeaveBoard): void {
  if (!board || !board.tiles) return;
  applyPower(board, NO_SEEDS);
}

/** True if the slot's output tile is currently receiving power from the core. */
export function boardSolvedFor(board: WeaveBoard, slot: number): boolean {
  if (!board) return false;
  const idx = slotTileIndex(board, slot);
  if (idx < 0) return false;
  return computePowered(board, NO_SEEDS)[idx];
}

// ============================================================ player actions

/** Rotate a tile clockwise. Returns false if index invalid or tile locked. */
export function rotateTile(board: WeaveBoard, index: number): boolean {
  if (!board || !Number.isInteger(index)) return false;
  if (index < 0 || index >= board.tiles.length) return false;
  const t = board.tiles[index];
  if (t.locked) return false;
  if (t.kind === 'empty' || t.kind === 'blocked' || t.kind === 'core' || t.kind === 'slot') return false;
  t.rotation = (t.rotation + 1) & 3;
  recomputePower(board);
  return true;
}

/** Randomize rotations of all unlocked tiles (boss mechanic / round reset). */
export function scrambleBoard(board: WeaveBoard, seed: number): void {
  if (!board) return;
  const rng = mulberry32(mixSeed(seed >>> 0, 0x5c4a));
  scrambleTowardUnsolved(board, rng, 12);
}

/**
 * Randomize the rotations of unlocked tiles only — layout, locks, pre-locked
 * head-start tiles and blocked cells all survive untouched. Identical to
 * `scrambleBoard`; exported under this name for PvP death/round resets where
 * the intent is "re-route known terrain", not "new board".
 */
export function scrambleRotations(board: WeaveBoard, seed: number): void {
  scrambleBoard(board, seed);
}

/**
 * Fewest clockwise tile rotations ("clicks") needed to connect `slot` to the
 * core from the board's current state. 0 means it is already live. Returns -1
 * if no rotation of the current layout can connect it (only reachable through
 * external mutation — `createBoard` and `damageBoard` both refuse to produce
 * such a board).
 *
 * Dijkstra over (cell, entry-edge) states with 0..3 weights, via Dial's
 * algorithm — bounded edge weights mean four rotating buckets suffice.
 */
export function routeDistance(board: WeaveBoard, slot: number): number {
  if (!board) return -1;
  const target = slotTileIndex(board, slot);
  if (target < 0) return -1;
  const n = board.size;
  const tiles = board.tiles;
  const total = tiles.length;
  const core = board.coreIndex;
  if (core < 0 || core >= total) return -1;

  const INF = 0x3fffffff;
  const states = total * 4;
  const dist = new Int32Array(states).fill(INF);
  const buckets: number[][] = [[], [], [], []];
  const maxDist = total * 3 + 4;

  const push = (state: number, d: number): void => {
    if (d >= dist[state] || d > maxDist) return;
    dist[state] = d;
    buckets[d & 3].push(state);
  };

  // Leaving the core costs nothing: it is locked wide open.
  const cx = core % n;
  const cy = (core / n) | 0;
  for (let d = 0; d < 4; d++) {
    if ((edgeMaskFor(tiles[core]) & DIR_BITS[d]) === 0) continue;
    const nx = cx + DIR_DX[d];
    const ny = cy + DIR_DY[d];
    if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
    const j = ny * n + nx;
    if (j >= total) continue;
    const inDir = OPPOSITE[d];
    if (turnsToOpen(tiles[j], DIR_BITS[inDir]) >= INF) continue;
    push(j * 4 + inDir, 0);
  }

  let best = INF;
  for (let d = 0; d <= maxDist; d++) {
    const bucket = buckets[d & 3];
    while (bucket.length > 0) {
      const state = bucket.pop() as number;
      if (dist[state] !== d) continue; // superseded
      const cell = state >> 2;
      const inDir = state & 3;
      if (cell === target) {
        if (d < best) best = d;
        return best; // Dijkstra pops in nondecreasing order
      }
      const x = cell % n;
      const y = (cell / n) | 0;
      for (let out = 0; out < 4; out++) {
        if (out === inDir) continue;
        const nx = x + DIR_DX[out];
        const ny = y + DIR_DY[out];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (j >= total) continue;
        const w = turnsToOpen(tiles[cell], DIR_BITS[inDir] | DIR_BITS[out]);
        if (w >= INF) continue;
        const back = OPPOSITE[out];
        if (turnsToOpen(tiles[j], DIR_BITS[back]) >= INF) continue;
        push(j * 4 + back, d + w);
      }
    }
  }
  return best >= INF ? -1 : best;
}

/** Fewest clockwise quarter-turns that make `tile` open every edge in `req`. */
function turnsToOpen(tile: WeaveTile, req: EdgeMask): number {
  const INF = 0x3fffffff;
  if (req === 0) return 0;
  const base = tile.base & 0xf;
  if (base === 0) return INF;
  if (tile.locked) return (edgeMaskFor(tile) & req) === req ? 0 : INF;
  let best = INF;
  const from = ((tile.rotation % 4) + 4) % 4;
  for (let r = 0; r < 4; r++) {
    if ((rotateMask(base, r) & req) !== req) continue;
    const cost = (r - from + 4) & 3;
    if (cost < best) best = cost;
  }
  return best;
}

/**
 * Scramble unlocked rotations, preferring a state where NO slot is connected
 * so the board never starts solved. If a random roll cannot find one, the live
 * circuits are cut deterministically (see `severLiveSlots`). Some degenerate
 * tiny boards (3x3) have slot tiles wired straight into the core and simply
 * cannot be unsolved; those are accepted as-is.
 */
function scrambleTowardUnsolved(board: WeaveBoard, rng: () => number, tries: number): void {
  const tiles = board.tiles;
  let bestRot: number[] | null = null;
  let bestConnected = Infinity;

  for (let attempt = 0; attempt < tries; attempt++) {
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (t.locked) continue;
      t.rotation = Math.floor(rng() * 4) & 3;
    }
    const powered = computePowered(board, NO_SEEDS);
    let connected = 0;
    for (let i = 0; i < tiles.length; i++) if (tiles[i].kind === 'slot' && powered[i]) connected++;
    if (connected < bestConnected) {
      bestConnected = connected;
      bestRot = tiles.map((t) => t.rotation);
    }
    if (connected === 0) break;
  }

  if (bestRot) for (let i = 0; i < tiles.length; i++) tiles[i].rotation = bestRot[i];

  // Random rolls rarely fail on 5x5+, but a cramped 4x4 packed with decoy
  // conduit can be hard to darken by luck. Descend to a dark state instead.
  if (bestConnected > 0) {
    for (let restart = 0; restart < 4; restart++) {
      if (severLiveSlots(board)) break;
      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        if (!t.locked) t.rotation = Math.floor(rng() * 4) & 3;
      }
    }
  }
  applyPower(board, NO_SEEDS);
}

/**
 * Greedy descent toward "no slot is live". Objective is
 * `liveSlots * 1000 + poweredCells`, so even when no single turn cuts a slot
 * outright the search still shrinks the powered region and eventually does.
 * Returns true if it reached a fully dark board. This is what makes
 * "never starts solved" a hard guarantee rather than a probabilistic one.
 */
function severLiveSlots(board: WeaveBoard): boolean {
  const tiles = board.tiles;
  const movable: number[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    if (!t.locked && (t.base & 0xf) !== 0 && popcount4(t.base) < 4) movable.push(i);
  }

  const score = (): number => {
    const p = computePowered(board, NO_SEEDS);
    let live = 0;
    let on = 0;
    for (let i = 0; i < tiles.length; i++) {
      if (!p[i]) continue;
      on++;
      if (tiles[i].kind === 'slot') live++;
    }
    return live * 1000 + on;
  };

  let cur = score();
  if (cur < 1000) return true;
  if (movable.length === 0) return false;

  for (let step = 0; step < 128; step++) {
    let bestIdx = -1;
    let bestRot = 0;
    let bestScore = cur;
    for (let k = 0; k < movable.length; k++) {
      const t = tiles[movable[k]];
      const orig = t.rotation;
      for (let r = 1; r < 4; r++) {
        t.rotation = (orig + r) & 3;
        const sc = score();
        if (sc < bestScore) {
          bestScore = sc;
          bestIdx = movable[k];
          bestRot = t.rotation;
        }
      }
      t.rotation = orig;
    }
    if (bestIdx < 0) return false; // local minimum
    tiles[bestIdx].rotation = bestRot;
    cur = bestScore;
    if (cur < 1000) return true;
  }
  return cur < 1000;
}

// ============================================================ charge

/**
 * Advance charge/decay. Returns slot indices that became fireable this step.
 * Connected slots gain CHARGE_RATE_BASE * chargeRateMul per second; disconnected
 * slots bleed CHARGE_DECAY_RATE per second. Charge banks up to cost*MAX_OVERCHARGE.
 */
export function updateCharge(
  board: WeaveBoard,
  dt: number,
  chargeRateMul: number,
  costs: number[],
): number[] {
  const fired: number[] = [];
  if (!board || !board.slots || !Number.isFinite(dt) || dt <= 0) return fired;
  const mul = Number.isFinite(chargeRateMul) && chargeRateMul > 0 ? chargeRateMul : 1;

  for (let i = 0; i < board.slots.length; i++) {
    const slot = board.slots[i];
    if (!slot) continue;
    const raw = costs && Number.isFinite(costs[i]) ? costs[i] : 1;
    const cost = raw > 0 ? raw : 1;
    const cap = cost * MAX_OVERCHARGE;

    if (!Number.isFinite(slot.charge)) slot.charge = 0;
    const wasFireable = slot.charge >= cost - CHARGE_EPS;

    if (slot.connected) slot.charge += CHARGE_RATE_BASE * mul * dt;
    else slot.charge -= CHARGE_DECAY_RATE * dt;

    slot.charge = clamp(slot.charge, 0, cap);

    const nowFireable = slot.charge >= cost - CHARGE_EPS;
    if (!wasFireable && nowFireable) fired.push(i);
  }
  return fired;
}

const CHARGE_EPS = 1e-6;

/** True if the slot has enough charge for `ability`. */
export function canFire(board: WeaveBoard, slot: number, ability: AbilityDef): boolean {
  if (!board || !ability) return false;
  const s = board.slots[slot];
  if (!s) return false;
  const cost = Number.isFinite(ability.cost) && ability.cost > 0 ? ability.cost : 0;
  return s.charge >= cost - CHARGE_EPS;
}

/**
 * Spend the charge. Returns the overcharge multiplier (1.0 .. MAX_OVERCHARGE),
 * or 0 if the slot could not fire (nothing is spent in that case).
 */
export function consumeCharge(board: WeaveBoard, slot: number, ability: AbilityDef): number {
  if (!canFire(board, slot, ability)) return 0;
  const s = board.slots[slot];
  const cost = Number.isFinite(ability.cost) && ability.cost > 0 ? ability.cost : 1;
  const over = clamp(s.charge / cost, 1, MAX_OVERCHARGE);
  s.charge = 0;
  return over;
}

// ============================================================ board damage

/**
 * Convert a permanently-blocked cell somewhere on the board (enemy "conduit
 * burst" attack). Prefers a cell that is currently carrying power so the hit
 * actually forces a re-route. Never produces an unsolvable board: candidates
 * that would orphan a slot are skipped. Returns the blocked index, or -1.
 */
export function damageBoard(board: WeaveBoard, seed: number): number {
  if (!board || !board.tiles.length) return -1;
  const rng = mulberry32(mixSeed(seed >>> 0, 0x0d33));

  const poweredNow: number[] = [];
  const cold: number[] = [];
  for (let i = 0; i < board.tiles.length; i++) {
    if (i === board.coreIndex) continue;
    const t = board.tiles[i];
    if (t.locked) continue; // core / slot / relay / empty / blocked are all locked
    if (t.kind === 'core' || t.kind === 'slot' || t.kind === 'blocked' || t.kind === 'empty') continue;
    (t.powered ? poweredNow : cold).push(i);
  }
  if (poweredNow.length === 0 && cold.length === 0) return -1;

  const order = shuffle(poweredNow, rng).concat(shuffle(cold, rng));
  const limit = Math.min(order.length, DAMAGE_MAX_CANDIDATES);
  const budget: SolveBudget = { left: DAMAGE_TOTAL_BUDGET };

  for (let k = 0; k < limit && budget.left > 0; k++) {
    const i = order[k];
    const t = board.tiles[i];
    const saved: WeaveTile = { ...t };

    t.kind = 'blocked';
    t.base = 0;
    t.rotation = 0;
    t.locked = true;
    t.powered = false;
    delete t.slotIndex;

    // Cheap screen first, then the real proof against the shared budget.
    const ok = slotsRelaxedReachable(board) && solveInternal(board, budget) !== null;
    if (ok) {
      recomputePower(board);
      return i;
    }

    // Would have killed a slot for good — put it back and try another cell.
    t.kind = saved.kind;
    t.base = saved.base;
    t.rotation = saved.rotation;
    t.locked = saved.locked;
    t.powered = saved.powered;
    if (saved.slotIndex !== undefined) t.slotIndex = saved.slotIndex;
  }
  return -1;
}

// ============================================================ coop relays

/**
 * Coop: link boards so `relay` tiles at the same index share power — if any
 * linked board powers its relay, every board's relay at that index lights up.
 * Iterates to a fixed point (power only ever spreads, so this converges fast).
 */
export function linkRelays(boards: WeaveBoard[]): void {
  if (!boards || boards.length === 0) return;
  if (boards.length === 1) {
    recomputePower(boards[0]);
    return;
  }

  const relayIdx: Set<number>[] = boards.map((b) => {
    const s = new Set<number>();
    for (let i = 0; i < b.tiles.length; i++) if (b.tiles[i].kind === 'relay') s.add(i);
    return s;
  });

  let anyRelay = false;
  for (const s of relayIdx) if (s.size > 0) anyRelay = true;
  if (!anyRelay) {
    for (const b of boards) recomputePower(b);
    return;
  }

  let shared = new Set<number>();
  for (let iter = 0; iter < 8; iter++) {
    const next = new Set<number>();
    for (let bi = 0; bi < boards.length; bi++) {
      const b = boards[bi];
      const seeds: number[] = [];
      for (const idx of shared) if (relayIdx[bi].has(idx)) seeds.push(idx);
      applyPower(b, seeds);
      for (const idx of relayIdx[bi]) if (b.tiles[idx].powered) next.add(idx);
    }
    let same = next.size === shared.size;
    if (same) for (const idx of next) if (!shared.has(idx)) { same = false; break; }
    shared = next;
    if (same) break;
  }

  // Final consistent pass with the converged relay set.
  for (let bi = 0; bi < boards.length; bi++) {
    const seeds: number[] = [];
    for (const idx of shared) if (relayIdx[bi].has(idx)) seeds.push(idx);
    applyPower(boards[bi], seeds);
  }
}

// ============================================================ solver

/**
 * Can this tile be rotated so that all of `req`'s edges are open?
 * Locked tiles are pinned to their current rotation.
 */
function canRealize(tile: WeaveTile, req: EdgeMask): boolean {
  if (req === 0) return true;
  const base = tile.base & 0xf;
  if (base === 0) return false;
  if (tile.locked) return (edgeMaskFor(tile) & req) === req;
  for (let r = 0; r < 4; r++) if ((rotateMask(base, r) & req) === req) return true;
  return false;
}

/** Search-node allowance. Shared and mutable so a caller can bound a whole batch. */
interface SolveBudget {
  left: number;
}

const SOLVE_BUDGET = 400000;
/**
 * damageBoard runs on the server tick. Its candidate probes share ONE budget,
 * so the common case (a candidate that is obviously still solvable, proved in a
 * few hundred nodes) costs almost nothing and many candidates can be tried,
 * while the total worst case stays a fraction of a tick.
 */
const DAMAGE_TOTAL_BUDGET = 60000;
const DAMAGE_MAX_CANDIDATES = 24;

/**
 * Necessary (not sufficient) condition for solvability, in O(cells): in the
 * *relaxed* graph — where each tile is judged in isolation, ignoring what its
 * other edges are committed to — every slot must still be reachable from the
 * core. Blocking a cell that orphans a slot is rejected here instead of by
 * exhausting the solver's search budget.
 */
function slotsRelaxedReachable(board: WeaveBoard): boolean {
  const n = board.size;
  const tiles = board.tiles;
  const total = tiles.length;
  const core = board.coreIndex;
  if (core < 0 || core >= total) return false;

  const seen = new Uint8Array(total);
  const q: number[] = [core];
  seen[core] = 1;
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    const x = i % n;
    const y = (i / n) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIR_DX[d];
      const ny = y + DIR_DY[d];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (j >= total || seen[j]) continue;
      if (!canRealize(tiles[i], DIR_BITS[d])) continue;
      if (!canRealize(tiles[j], DIR_BITS[OPPOSITE[d]])) continue;
      seen[j] = 1;
      q.push(j);
    }
  }
  for (let i = 0; i < total; i++) if (tiles[i].kind === 'slot' && !seen[i]) return false;
  return true;
}

/**
 * Search for a rotation assignment that connects the core to every slot.
 *
 * Strategy: treat it as a Steiner-tree problem. For each slot in turn we
 * enumerate simple core->slot routes (DFS, nearest-first heuristic) while
 * accumulating a per-cell "required open edges" mask. A route may only pass
 * through a cell if that cell can still be rotated to satisfy every edge
 * required of it so far, which is what makes shared trunks legal (a junction
 * simply needs to be a tee or a cross). Full backtracking across the three
 * slots, bounded by a node budget.
 */
function solveInternal(board: WeaveBoard, budgetIn: SolveBudget): number[] | null {
  const n = board.size;
  const tiles = board.tiles;
  const total = tiles.length;
  if (total === 0) return null;
  const core = board.coreIndex;
  if (core < 0 || core >= total) return null;

  const targets: number[] = [];
  for (let i = 0; i < total; i++) if (tiles[i].kind === 'slot') targets.push(i);
  if (targets.length === 0) return [];

  // Most-constrained (farthest) first: establishes the trunk early.
  const dist = (i: number): number =>
    Math.abs((i % n) - (core % n)) + Math.abs(((i / n) | 0) - ((core / n) | 0));
  targets.sort((a, b) => dist(b) - dist(a));

  // Cheap necessary condition first (see `slotsRelaxedReachable`).
  if (!slotsRelaxedReachable(board)) return null;

  const req = new Int32Array(total);
  let maxDepth = total;

  // Everything the search touches is preallocated: `searchSlot` is re-entered
  // once per candidate route of the previous slot, so per-call typed arrays
  // would dominate the runtime.
  const levels = targets.length;
  const visitedAll = new Uint8Array(levels * total);
  const dirScratch = new Int8Array(levels * (total + 1) * 4);

  function searchSlot(k: number): boolean {
    if (k >= levels) return true;
    const target = targets[k];
    const tx = target % n;
    const ty = (target / n) | 0;
    const vBase = k * total;
    const sBase = k * (total + 1) * 4;
    visitedAll.fill(0, vBase, vBase + total);

    function dfs(cur: number, depth: number): boolean {
      if (budgetIn.left-- <= 0) return false;
      if (cur === target) return searchSlot(k + 1);
      if (depth >= maxDepth) return false;

      const x = cur % n;
      const y = (cur / n) | 0;
      const slot = sBase + depth * 4;

      // Nearest-to-target first keeps the common case at a handful of nodes.
      let count = 0;
      for (let d = 0; d < 4; d++) {
        const nx = x + DIR_DX[d];
        const ny = y + DIR_DY[d];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (j >= total || visitedAll[vBase + j]) continue;
        if ((tiles[j].base & 0xf) === 0) continue;
        // insertion sort by |distance to target|; at most 4 entries
        const dd = Math.abs(nx - tx) + Math.abs(ny - ty);
        let a = count - 1;
        while (a >= 0) {
          const od = dirScratch[slot + a];
          const oDist = Math.abs(x + DIR_DX[od] - tx) + Math.abs(y + DIR_DY[od] - ty);
          if (oDist <= dd) break;
          dirScratch[slot + a + 1] = od;
          a--;
        }
        dirScratch[slot + a + 1] = d;
        count++;
      }

      for (let ci = 0; ci < count; ci++) {
        const d = dirScratch[slot + ci];
        const j = (y + DIR_DY[d]) * n + (x + DIR_DX[d]);
        const bitOut = DIR_BITS[d];
        const bitIn = DIR_BITS[OPPOSITE[d]];
        const oldCur = req[cur];
        const oldNext = req[j];
        if (!canRealize(tiles[cur], oldCur | bitOut)) continue;
        if (!canRealize(tiles[j], oldNext | bitIn)) continue;

        req[cur] = oldCur | bitOut;
        req[j] = oldNext | bitIn;
        visitedAll[vBase + j] = 1;
        if (dfs(j, depth + 1)) return true;
        visitedAll[vBase + j] = 0;
        req[cur] = oldCur;
        req[j] = oldNext;
      }
      return false;
    }

    visitedAll[vBase + core] = 1;
    return dfs(core, 0);
  }

  // Iterative deepening: nearly every board is solved by a short route set, and
  // capping depth keeps the DFS from wandering into the long tail before it
  // notices the easy answer. The final pass is uncapped, so nothing is lost.
  const caps: readonly number[] = [Math.max(4, n + 2), n * 3, total];
  const shares: readonly number[] = [0.12, 0.3, 1];
  const startBudget = budgetIn.left;
  let found = false;
  for (let ci = 0; ci < caps.length && !found; ci++) {
    if (ci > 0 && caps[ci] <= caps[ci - 1]) continue;
    if (budgetIn.left <= 0) break;
    req.fill(0);
    maxDepth = caps[ci];
    // Each pass is capped, but unspent nodes stay in the shared pool.
    const allowance = Math.min(budgetIn.left, Math.max(1024, Math.floor(startBudget * shares[ci])));
    const reserve = budgetIn.left - allowance;
    budgetIn.left = allowance;
    found = searchSlot(0);
    budgetIn.left += reserve;
  }
  if (!found) return null;

  // Materialize: every constrained, unlocked cell takes a rotation satisfying it.
  const rotations = new Array<number>(total);
  for (let i = 0; i < total; i++) {
    const t = tiles[i];
    rotations[i] = t.rotation;
    if (t.locked || req[i] === 0) continue;
    const base = t.base & 0xf;
    for (let r = 0; r < 4; r++) {
      if ((rotateMask(base, r) & req[i]) === req[i]) {
        rotations[i] = r;
        break;
      }
    }
  }

  // Independent confirmation on a throwaway copy.
  const probe = cloneBoard(board);
  for (let i = 0; i < total; i++) probe.tiles[i].rotation = rotations[i];
  const powered = computePowered(probe, NO_SEEDS);
  for (let i = 0; i < targets.length; i++) if (!powered[targets[i]]) return null;
  return rotations;
}

/** Find a rotation assignment that connects all three slots, or null. */
export function solveBoard(board: WeaveBoard): number[] | null {
  if (!board) return null;
  return solveInternal(board, { left: SOLVE_BUDGET });
}

/** True if some rotation assignment connects the core to every slot. */
export function isSolvable(board: WeaveBoard): boolean {
  return solveBoard(board) !== null;
}

/** Solve and apply in place (tutorial hint / "show me" button). Returns success. */
export function applySolution(board: WeaveBoard): boolean {
  const rot = solveBoard(board);
  if (!rot) return false;
  for (let i = 0; i < board.tiles.length; i++) board.tiles[i].rotation = rot[i];
  recomputePower(board);
  return true;
}

// ============================================================ generation

interface SlotPlan {
  /** Index of the rim cell that holds the slot tile. */
  cell: number;
  /** Index of the cell just inside it — where the route has to arrive. */
  entry: number;
  /** Edge id 0=top 1=right 2=bottom 3=left. */
  edge: number;
  /** The slot tile's single open edge (pointing inward, at `entry`). */
  inward: EdgeMask;
}

/** Optional per-role / per-chapter shaping for `createBoard`. */
export interface BoardOptions {
  /**
   * Fraction (0..1) of tiles on the guaranteed solution path to pre-lock in
   * their CORRECT rotation — a head start, never a solved board. Bulwark uses
   * ~0.25. Capped so at least `PRELOCK_MIN_FREE_PER_ROUTE` unlocked tiles
   * always remain on every slot's route, and pre-locked tiles are also immune
   * to `damageBoard`.
   */
  prelockFraction?: number;
  /**
   * Extra decoy conduit density, 0..1, on top of the size-derived default.
   * 0 leaves it unchanged; 1 saturates the board with noise to route around.
   */
  decoyDensity?: number;
  /**
   * Number of cells to pre-set to 'blocked' (hazardous chapters / handicaps).
   * Best-effort: a cell is only blocked if the board stays routable to all
   * three slots afterwards, so a cramped or heavily pre-locked board can end
   * up with fewer. Read the real count off the board if you need it.
   */
  blockedCells?: number;
}

/** A pre-locked route may never leave a slot with fewer free tiles than this. */
const PRELOCK_MIN_FREE_PER_ROUTE = 2;

interface ResolvedOptions {
  prelockFraction: number;
  decoyDensity: number;
  blockedCells: number;
}

function normalizeOptions(opts?: BoardOptions): ResolvedOptions {
  const num = (v: number | undefined, dflt: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return {
    prelockFraction: clamp(num(opts?.prelockFraction, 0), 0, 1),
    decoyDensity: clamp(num(opts?.decoyDensity, 0), 0, 1),
    blockedCells: Math.max(0, Math.floor(num(opts?.blockedCells, 0))),
  };
}

/**
 * Decoy conduit density, split by whether the cell touches the real route.
 * Scales with board size: a cramped 4x4 packed with junk is unreadable (and
 * hard to keep unsolved at spawn), while a roomy 7x7 needs the noise or the
 * correct route is visually obvious. `extra` pushes both values toward
 * saturation without ever filling the board completely.
 */
function decoyDensity(n: number, extra: number): { near: number; far: number } {
  let near: number;
  let far: number;
  if (n <= 4) { near = 0.46; far = 0.24; }
  else if (n === 5) { near = 0.62; far = 0.36; }
  else if (n === 6) { near = 0.70; far = 0.44; }
  else { near = 0.76; far = 0.50; }
  if (extra > 0) {
    near = Math.min(0.92, near + (1 - near) * extra);
    far = Math.min(0.88, far + (1 - far) * extra);
  }
  return { near, far };
}

/**
 * Lock a share of the solution-path tiles at their (currently correct)
 * rotation. Returns the set of cells it locked. Never locks a route down to
 * fewer than `PRELOCK_MIN_FREE_PER_ROUTE` free tiles, so no slot can start
 * effectively free.
 */
function prelockSolutionTiles(
  board: WeaveBoard,
  routes: number[][],
  fraction: number,
  rng: () => number,
): Set<number> {
  const tiles = board.tiles;
  const locked = new Set<number>();
  if (fraction <= 0) return locked;

  const routesOf = new Map<number, number[]>();
  const freeOnRoute: number[] = routes.map(() => 0);
  for (let k = 0; k < routes.length; k++) {
    for (const c of routes[k]) {
      if (c < 0 || c >= tiles.length || tiles[c].locked) continue;
      let owners = routesOf.get(c);
      if (!owners) {
        owners = [];
        routesOf.set(c, owners);
      }
      if (owners.indexOf(k) < 0) {
        owners.push(k);
        freeOnRoute[k]++;
      }
    }
  }

  const candidates = shuffle(Array.from(routesOf.keys()), rng);
  let want = Math.round(fraction * candidates.length);
  for (const c of candidates) {
    if (want <= 0) break;
    const owners = routesOf.get(c) as number[];
    let ok = true;
    for (const k of owners) {
      if (freeOnRoute[k] - 1 < PRELOCK_MIN_FREE_PER_ROUTE) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    tiles[c].locked = true; // already sitting at its solution rotation
    for (const k of owners) freeOnRoute[k]--;
    locked.add(c);
    want--;
  }
  return locked;
}

function makeSlotPlan(n: number, edge: number, offset: number): SlotPlan {
  switch (edge) {
    case 0: // top row
      return { cell: offset, entry: n + offset, edge, inward: DOWN };
    case 1: // right column
      return { cell: offset * n + (n - 1), entry: offset * n + (n - 2), edge, inward: LEFT };
    case 2: // bottom row
      return { cell: (n - 1) * n + offset, entry: (n - 2) * n + offset, edge, inward: UP };
    default: // left column
      return { cell: offset * n, entry: offset * n + 1, edge, inward: RIGHT };
  }
}

/**
 * Three slots on three distinct rim edges, never on a corner, scored to
 * maximize the minimum pairwise distance (so they sit well apart) and the
 * distance to the core (so no slot is wired straight into it, which would make
 * that slot permanently solved). Enumerates every offset triple when the board
 * is small enough, otherwise samples.
 */
function planSlots(n: number, coreIndex: number, rng: () => number): SlotPlan[] | null {
  const lo = 1;
  const hi = n - 2;
  if (hi < lo) return null;
  const edges = shuffle([0, 1, 2, 3], rng).slice(0, 3);
  const range = hi - lo + 1;
  const combos = range * range * range;
  const exhaustive = combos <= 729;
  const iterations = exhaustive ? combos : 128;
  const cx = coreIndex % n;
  const cy = (coreIndex / n) | 0;

  let best: SlotPlan[] | null = null;
  let bestScore = -Infinity;

  for (let it = 0; it < iterations; it++) {
    const offs: number[] = exhaustive
      ? [lo + (it % range), lo + (((it / range) | 0) % range), lo + (((it / (range * range)) | 0) % range)]
      : [
          lo + Math.floor(rng() * range),
          lo + Math.floor(rng() * range),
          lo + Math.floor(rng() * range),
        ];
    const cand = [
      makeSlotPlan(n, edges[0], offs[0]),
      makeSlotPlan(n, edges[1], offs[1]),
      makeSlotPlan(n, edges[2], offs[2]),
    ];

    let penalty = 0;
    const cells = new Set<number>();
    for (const p of cand) {
      cells.add(p.cell);
      // An entry ON the core means the slot is hard-wired live and can never be
      // unsolved. Unavoidable on a 3x3; forbidden everywhere else.
      if (n >= 4 && p.entry === coreIndex) penalty += 1e6;
      if (p.cell === coreIndex) penalty += 1e6;
    }
    if (cells.size !== 3) penalty += 1e6;

    let minPair = Infinity;
    let minCore = Infinity;
    for (let i = 0; i < cand.length; i++) {
      const a = cand[i].cell;
      const ax = a % n;
      const ay = (a / n) | 0;
      minCore = Math.min(minCore, Math.abs(ax - cx) + Math.abs(ay - cy));
      for (let j = i + 1; j < cand.length; j++) {
        const b = cand[j].cell;
        const d = Math.abs(ax - (b % n)) + Math.abs(ay - ((b / n) | 0));
        if (d < minPair) minPair = d;
      }
    }

    const score = minPair * 100 + minCore * 10 + rng() * 6 - penalty;
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best;
}

function neighborsOf(n: number, i: number, out: number[]): number[] {
  out.length = 0;
  const x = i % n;
  const y = (i / n) | 0;
  for (let d = 0; d < 4; d++) {
    const nx = x + DIR_DX[d];
    const ny = y + DIR_DY[d];
    if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
    out.push(ny * n + nx);
  }
  return out;
}

function bfsPath(n: number, start: number, target: number, forbidden: Set<number>): number[] | null {
  const total = n * n;
  const prev = new Int32Array(total).fill(-1);
  const seen = new Uint8Array(total);
  const q: number[] = [start];
  seen[start] = 1;
  const buf: number[] = [];
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    if (cur === target) break;
    neighborsOf(n, cur, buf);
    for (let k = 0; k < buf.length; k++) {
      const j = buf[k];
      if (seen[j] || forbidden.has(j)) continue;
      seen[j] = 1;
      prev[j] = cur;
      q.push(j);
    }
  }
  if (!seen[target]) return null;
  const path: number[] = [];
  for (let c = target; c !== -1; c = prev[c]) {
    path.push(c);
    if (c === start) break;
  }
  path.reverse();
  return path[0] === start ? path : null;
}

/**
 * Randomized depth-first route. `bias` is the chance of preferring a step that
 * closes on the target; low bias produces long, winding routes — which is
 * exactly where the difficulty is supposed to come from.
 */
function dfsPath(
  n: number,
  start: number,
  target: number,
  forbidden: Set<number>,
  rng: () => number,
  bias: number,
): number[] | null {
  const total = n * n;
  const visited = new Uint8Array(total);
  const tx = target % n;
  const ty = (target / n) | 0;
  const buf: number[] = [];

  const order = (i: number): number[] => {
    neighborsOf(n, i, buf);
    const list: number[] = [];
    for (let k = 0; k < buf.length; k++) {
      const j = buf[k];
      if (visited[j] || forbidden.has(j)) continue;
      list.push(j);
    }
    shuffle(list, rng);
    if (list.length > 1 && rng() < bias) {
      // Move the best distance-reducing neighbour to the end (popped first).
      let bestK = 0;
      let bestD = Infinity;
      for (let k = 0; k < list.length; k++) {
        const j = list[k];
        const d = Math.abs((j % n) - tx) + Math.abs(((j / n) | 0) - ty);
        if (d < bestD) {
          bestD = d;
          bestK = k;
        }
      }
      const t = list[bestK];
      list[bestK] = list[list.length - 1];
      list[list.length - 1] = t;
    }
    return list;
  };

  const stack: number[] = [start];
  const frontier: number[][] = [order(start)];
  visited[start] = 1;
  let guard = total * 64;

  while (stack.length > 0 && guard-- > 0) {
    const cur = stack[stack.length - 1];
    if (cur === target) return stack.slice();
    const opts = frontier[frontier.length - 1];
    let next = -1;
    while (opts.length > 0) {
      const c = opts.pop() as number;
      if (!visited[c]) {
        next = c;
        break;
      }
    }
    if (next < 0) {
      stack.pop();
      frontier.pop();
      continue;
    }
    visited[next] = 1;
    stack.push(next);
    frontier.push(order(next));
  }
  return null;
}

const CARVE_BIASES: readonly number[] = [1.0, 0.9, 0.75, 0.6, 0.45, 0.3, 0.15, 0.0];

/** Pick the route whose length lands closest to a randomized target length. */
function carveRoute(
  n: number,
  start: number,
  target: number,
  forbidden: Set<number>,
  rng: () => number,
): number[] | null {
  if (start === target) return [start];
  const shortest = bfsPath(n, start, target, forbidden);
  if (!shortest) return null;

  const cap = Math.max(shortest.length, Math.floor(n * n * 0.55));
  const desired = Math.min(shortest.length + 1 + Math.floor(rng() * (n + 2)), cap);

  let best = shortest;
  let bestErr = Math.abs(shortest.length - desired);
  for (let b = 0; b < CARVE_BIASES.length; b++) {
    const p = dfsPath(n, start, target, forbidden, rng, CARVE_BIASES[b]);
    if (!p) continue;
    const err = Math.abs(p.length - desired);
    if (err < bestErr) {
      best = p;
      bestErr = err;
    }
  }
  return best;
}

function dirBetween(n: number, from: number, to: number): number {
  const dx = (to % n) - (from % n);
  const dy = ((to / n) | 0) - ((from / n) | 0);
  for (let d = 0; d < 4; d++) if (DIR_DX[d] === dx && DIR_DY[d] === dy) return d;
  return -1;
}

function linkReq(req: Int32Array, n: number, a: number, b: number): void {
  const d = dirBetween(n, a, b);
  if (d < 0) return;
  req[a] |= DIR_BITS[d];
  req[b] |= DIR_BITS[OPPOSITE[d]];
}

/** Smallest tile kind + rotation whose open edges cover `mask` (exact where possible). */
function fitTile(mask: EdgeMask): { kind: TileKind; base: EdgeMask; rotation: number } {
  const m = mask & 0xf;
  if (m === 0) return { kind: 'empty', base: 0, rotation: 0 };
  for (let pass = 0; pass < 2; pass++) {
    for (let ki = 0; ki < FIT_ORDER.length; ki++) {
      const kind = FIT_ORDER[ki];
      const masks = KIND_MASKS[kind];
      for (let r = 0; r < 4; r++) {
        const hit = pass === 0 ? masks[r] === m : (masks[r] & m) === m;
        if (hit) return { kind, base: TILE_BASE[kind], rotation: r };
      }
    }
  }
  return { kind: 'cross', base: ALL_EDGES, rotation: 0 };
}

function randomConduit(rng: () => number, allowCross: boolean): { kind: TileKind; base: EdgeMask } {
  const r = rng();
  if (r < 0.42) return { kind: 'elbow', base: TILE_BASE.elbow };
  if (r < 0.72) return { kind: 'straight', base: TILE_BASE.straight };
  if (r < 0.92 || !allowCross) return { kind: 'tee', base: TILE_BASE.tee };
  return { kind: 'cross', base: TILE_BASE.cross };
}

/**
 * True if this tile presents an open edge toward `d` in EVERY rotation the
 * player could put it in. Only crosses (and locked tiles) are like this — and a
 * chain of them from the core to a slot would make that slot permanently live,
 * which would mean the board starts solved and can never be un-solved.
 */
function alwaysOpen(tile: WeaveTile, d: number): boolean {
  const base = tile.base & 0xf;
  if (base === 0) return false;
  if (tile.locked) return (edgeMaskFor(tile) & DIR_BITS[d]) !== 0;
  for (let r = 0; r < 4; r++) if ((rotateMask(base, r) & DIR_BITS[d]) === 0) return false;
  return true;
}

/** Cells reachable from the core through connections no rotation can break. */
function unbreakableFromCore(board: WeaveBoard): boolean[] {
  const n = board.size;
  const tiles = board.tiles;
  const total = tiles.length;
  const hit = new Array<boolean>(total).fill(false);
  const q: number[] = [];
  if (board.coreIndex >= 0 && board.coreIndex < total) {
    hit[board.coreIndex] = true;
    q.push(board.coreIndex);
  }
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    const x = i % n;
    const y = (i / n) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DIR_DX[d];
      const ny = y + DIR_DY[d];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (j >= total || hit[j]) continue;
      if (!alwaysOpen(tiles[i], d)) continue;
      if (!alwaysOpen(tiles[j], OPPOSITE[d])) continue;
      hit[j] = true;
      q.push(j);
    }
  }
  return hit;
}

function makeSlots(abilities: AbilityId[]): WeaveSlot[] {
  const slots: WeaveSlot[] = [];
  for (let i = 0; i < ABILITY_SLOTS; i++) {
    slots.push({ ability: abilities[i] ?? '', charge: 0, connected: false });
  }
  return slots;
}

/**
 * One generation attempt. Returns null if anything about the layout failed to
 * verify, in which case `createBoard` retries with a derived seed.
 */
function tryGenerate(
  n: number,
  abilities: AbilityId[],
  seed: number,
  options: ResolvedOptions,
): WeaveBoard | null {
  const rng = mulberry32(seed);
  const total = n * n;
  const cx = n >> 1;
  const cy = n >> 1;
  const coreIndex = cy * n + cx;

  const plan = planSlots(n, coreIndex, rng);
  if (!plan || plan.length !== ABILITY_SLOTS) return null;
  for (const p of plan) if (n >= 4 && (p.entry === coreIndex || p.cell === coreIndex)) return null;

  const slotCells = new Set<number>(plan.map((p) => p.cell));
  if (slotCells.has(coreIndex)) return null;
  if (slotCells.size !== ABILITY_SLOTS) return null;

  // --- carve one route per slot; routes may merge into shared trunks -------
  // Each route must leave the core in its own direction: three routes stacked
  // on one core-adjacent cell would turn it into a cross, and a cross next to
  // the core is a connection the player can never break.
  const req = new Int32Array(total);
  const routes: number[][] = [];
  const blockedForRoutes = new Set<number>(slotCells);
  for (let k = 0; k < plan.length; k++) {
    const p = plan[k];
    if (slotCells.has(p.entry)) return null;
    // This slot's own entry must stay reachable even if an earlier route
    // claimed it as its first step.
    const reserved = blockedForRoutes.delete(p.entry);
    const route = carveRoute(n, coreIndex, p.entry, blockedForRoutes, rng);
    if (reserved) blockedForRoutes.add(p.entry);
    if (!route) return null;
    for (let i = 0; i + 1 < route.length; i++) linkReq(req, n, route[i], route[i + 1]);
    linkReq(req, n, p.entry, p.cell);
    routes.push(route.concat([p.cell]));
    if (route.length > 1) blockedForRoutes.add(route[1]);
  }

  // --- realize tiles ------------------------------------------------------
  const tiles: WeaveTile[] = new Array(total);
  const slotOf = new Map<number, number>();
  for (let k = 0; k < plan.length; k++) slotOf.set(plan[k].cell, k);

  for (let i = 0; i < total; i++) {
    if (i === coreIndex) {
      tiles[i] = { kind: 'core', base: TILE_BASE.core, rotation: 0, locked: true, powered: false };
      continue;
    }
    const sk = slotOf.get(i);
    if (sk !== undefined) {
      const inward = req[i] !== 0 ? (req[i] & 0xf) : plan[sk].inward;
      tiles[i] = {
        kind: 'slot',
        base: inward,
        rotation: 0,
        locked: true,
        powered: false,
        slotIndex: sk,
      };
      continue;
    }
    if (req[i] !== 0) {
      const fit = fitTile(req[i]);
      tiles[i] = { kind: fit.kind, base: fit.base, rotation: fit.rotation, locked: false, powered: false };
      continue;
    }
    tiles[i] = { kind: 'empty', base: 0, rotation: 0, locked: true, powered: false };
  }

  // --- decoy fill: dense next to the real route so the eye can't trace it --
  const nbuf: number[] = [];
  const density = decoyDensity(n, options.decoyDensity);
  for (let i = 0; i < total; i++) {
    if (i === coreIndex || slotOf.has(i) || req[i] !== 0) continue;
    neighborsOf(n, i, nbuf);
    let nearPath = false;
    let touchesFixed = false;
    for (let k = 0; k < nbuf.length; k++) {
      const j = nbuf[k];
      if (req[j] !== 0) nearPath = true;
      if (j === coreIndex || slotOf.has(j)) touchesFixed = true;
    }
    const chance = nearPath ? density.near : density.far;
    if (rng() >= chance) continue; // stays 'empty'
    // A decoy cross touching the core or a slot is an unbreakable connector.
    const c = randomConduit(rng, !touchesFixed);
    tiles[i] = {
      kind: c.kind,
      base: c.base,
      rotation: Math.floor(rng() * 4) & 3,
      locked: false,
      powered: false,
    };
  }

  const board: WeaveBoard = { size: n, tiles, slots: makeSlots(abilities), coreIndex };

  // --- verify by construction: the solution rotations must light every slot -
  const solved = computePowered(board, NO_SEEDS);
  for (let k = 0; k < plan.length; k++) if (!solved[plan[k].cell]) return null;

  // --- no slot may be wired to the core by connections rotation can't break -
  // Decoy crosses on such a chain are not load-bearing, so demote them to
  // tees; if a route cross is the culprit, abandon this layout and reseed.
  for (let pass = 0; pass < 4; pass++) {
    const stuck = unbreakableFromCore(board);
    let bad = -1;
    for (let k = 0; k < plan.length; k++) if (stuck[plan[k].cell]) { bad = plan[k].cell; break; }
    if (bad < 0) break;
    let demoted = false;
    for (let i = 0; i < total; i++) {
      if (!stuck[i] || req[i] !== 0 || tiles[i].kind !== 'cross') continue;
      tiles[i] = {
        kind: 'tee',
        base: TILE_BASE.tee,
        rotation: Math.floor(rng() * 4) & 3,
        locked: false,
        powered: false,
      };
      demoted = true;
      break;
    }
    if (!demoted) return null;
  }
  {
    const stuck = unbreakableFromCore(board);
    for (let k = 0; k < plan.length; k++) if (stuck[plan[k].cell]) return null;
  }
  // Demotions can only remove edges, so re-verify the solution still lights up.
  const reSolved = computePowered(board, NO_SEEDS);
  for (let k = 0; k < plan.length; k++) if (!reSolved[plan[k].cell]) return null;

  // --- optional head start: lock some solution tiles where they already are -
  const prelocked = prelockSolutionTiles(board, routes, options.prelockFraction, rng);
  // A pre-locked tile is permanently open toward its route neighbours, so it
  // can forge an unbreakable core->slot chain. Free tiles until it cannot.
  for (let guard = 0; guard <= prelocked.size; guard++) {
    const stuck = unbreakableFromCore(board);
    let bad = false;
    for (let k = 0; k < plan.length; k++) if (stuck[plan[k].cell]) { bad = true; break; }
    if (!bad) break;
    let freed = false;
    for (const c of prelocked) {
      if (!stuck[c]) continue;
      tiles[c].locked = false;
      prelocked.delete(c);
      freed = true;
      break;
    }
    if (!freed) return null;
  }

  // --- scramble so it does not start solved -------------------------------
  scrambleTowardUnsolved(board, rng, 32);

  // Hard post-condition: a fresh board hands the player nothing for free.
  // Pre-locking shrinks the set of tiles the scramble can turn, so on rare
  // layouts no dark state is reachable — reject and let createBoard reseed.
  // (A 3x3 is too small to satisfy this and is exempt.)
  if (n >= 4) {
    const finalPower = computePowered(board, NO_SEEDS);
    for (let k = 0; k < plan.length; k++) if (finalPower[plan[k].cell]) return null;
  }
  return board;
}

/**
 * Last-resort layout: three straight spokes from the core to three rim slots,
 * everything else empty. Trivially solvable, used only if `tryGenerate` somehow
 * fails every attempt. Guarantees `createBoard` never returns a dead board.
 */
function fallbackBoard(n: number, abilities: AbilityId[], seed: number): WeaveBoard {
  const total = n * n;
  const c = n >> 1;
  const coreIndex = c * n + c;
  const req = new Int32Array(total);

  const spokes: SlotPlan[] = [makeSlotPlan(n, 0, c), makeSlotPlan(n, 1, c), makeSlotPlan(n, 2, c)];
  for (const p of spokes) {
    const route = bfsPath(n, coreIndex, p.entry, new Set(spokes.map((s) => s.cell)));
    if (route) for (let i = 0; i + 1 < route.length; i++) linkReq(req, n, route[i], route[i + 1]);
    linkReq(req, n, p.entry, p.cell);
  }

  const slotOf = new Map<number, number>();
  spokes.forEach((p, k) => slotOf.set(p.cell, k));

  const tiles: WeaveTile[] = new Array(total);
  for (let i = 0; i < total; i++) {
    if (i === coreIndex) {
      tiles[i] = { kind: 'core', base: TILE_BASE.core, rotation: 0, locked: true, powered: false };
    } else if (slotOf.has(i)) {
      tiles[i] = {
        kind: 'slot',
        base: (req[i] & 0xf) || spokes[slotOf.get(i) as number].inward,
        rotation: 0,
        locked: true,
        powered: false,
        slotIndex: slotOf.get(i) as number,
      };
    } else if (req[i] !== 0) {
      const fit = fitTile(req[i]);
      tiles[i] = { kind: fit.kind, base: fit.base, rotation: fit.rotation, locked: false, powered: false };
    } else {
      tiles[i] = { kind: 'empty', base: 0, rotation: 0, locked: true, powered: false };
    }
  }

  const board: WeaveBoard = { size: n, tiles, slots: makeSlots(abilities), coreIndex };
  scrambleTowardUnsolved(board, mulberry32(mixSeed(seed, 0x7a11)), 16);
  return board;
}

/**
 * Build a fresh board. Deterministic given `seed`. Guarantees a solvable layout
 * that does not start solved.
 *
 * Algorithm:
 *  1. Core at the board centre.
 *  2. Three slot tiles on three distinct rim edges, never on a corner, placed
 *     to maximize the minimum pairwise distance between them.
 *  3. For each slot, carve a route from the core to the cell just inside it
 *     using a randomized DFS walk; several walks at different target-bias
 *     values are generated and the one whose length is closest to a randomized
 *     target length is kept. Routes may merge, forming shared trunks.
 *  4. Every routed cell gets the tile kind whose edge count matches its
 *     required connections (straight / elbow / tee / cross) at the rotation
 *     that solves it.
 *  5. Remaining cells get decoy conduit (denser adjacent to the real route) or
 *     stay empty.
 *  6. The solution rotations are verified with a flood fill; only then are all
 *     unlocked rotations scrambled, preferring a roll where no slot is live.
 *
 * `opts` is optional shaping (pre-locked head-start tiles, extra decoy noise,
 * pre-blocked cells) — see `BoardOptions`. Omitting it reproduces the plain
 * three-argument behaviour exactly.
 */
export function createBoard(
  size: number,
  loadout: AbilityId[],
  seed: number,
  opts?: BoardOptions,
): WeaveBoard {
  const n = normalizeSize(size);
  const abilities = normalizeLoadout(loadout);
  const baseSeed = (Number.isFinite(seed) ? seed : 0) >>> 0;
  const options = normalizeOptions(opts);

  let board: WeaveBoard | null = null;
  for (let attempt = 0; attempt < 24 && !board; attempt++) {
    board = tryGenerate(n, abilities, mixSeed(baseSeed, 0x51ed0000 + attempt * 0x9e3779b1), options);
  }
  if (!board) board = fallbackBoard(n, abilities, baseSeed);

  // Pre-blocked cells go through the same safety net as combat damage, so a
  // handicapped board is still guaranteed routable to all three slots.
  for (let k = 0; k < options.blockedCells; k++) {
    if (damageBoard(board, mixSeed(baseSeed, 0x0b10c000 + k * 0x9e3779b1)) < 0) break;
  }
  return board;
}

// ============================================================ debug rendering

const GLYPH_COLD: readonly string[] = [
  '·', '╵', '╶', '└', '╷', '│', '┌', '├', '╴', '┘', '─', '┴', '┐', '┤', '┬', '┼',
];
const GLYPH_LIVE: readonly string[] = [
  '·', '╹', '╺', '╚', '╻', '║', '╔', '╠', '╸', '╝', '═', '╩', '╗', '╣', '╦', '╬',
];
const SLOT_COLD: readonly string[] = ['①', '②', '③'];
const SLOT_LIVE: readonly string[] = ['❶', '❷', '❸'];

function glyphFor(tile: WeaveTile): string {
  const mask = edgeMaskFor(tile);
  switch (tile.kind) {
    case 'core':
      return tile.powered ? '◉' : '○';
    case 'blocked':
      return '▩';
    case 'empty':
      return '·';
    case 'relay':
      return tile.powered ? '◈' : '◇';
    case 'slot': {
      const s = tile.slotIndex ?? 0;
      return tile.powered ? SLOT_LIVE[s] ?? '★' : SLOT_COLD[s] ?? '☆';
    }
    default:
      return (tile.powered ? GLYPH_LIVE : GLYPH_COLD)[mask] ?? '?';
  }
}

/**
 * ASCII/box-drawing dump of the board. Powered conduit is drawn with double
 * lines (║ ═ ╬), unpowered with single lines (│ ─ ┼). Slots are ①②③ when cold
 * and ❶❷❸ when live; the core is ○/◉; blocked cells are ▩.
 */
export function debugRender(board: WeaveBoard): string {
  if (!board || !board.tiles) return '<no board>';
  const n = board.size;
  const lines: string[] = [];

  lines.push(`weave ${n}x${n}  core=${board.coreIndex}  tiles=${board.tiles.length}`);

  let header = '   ';
  for (let x = 0; x < n; x++) header += x.toString(36);
  lines.push(header);
  lines.push('  ┌' + '─'.repeat(n) + '┐');

  for (let y = 0; y < n; y++) {
    let row = ' ' + y.toString(36) + '│';
    for (let x = 0; x < n; x++) {
      const t = board.tiles[y * n + x];
      row += t ? glyphFor(t) : '?';
    }
    lines.push(row + '│');
  }
  lines.push('  └' + '─'.repeat(n) + '┘');

  for (let s = 0; s < board.slots.length; s++) {
    const slot = board.slots[s];
    const idx = slotTileIndex(board, s);
    const mark = SLOT_COLD[s] ?? String(s);
    lines.push(
      `  ${mark} slot${s} ${slot.connected ? 'LIVE' : 'dark'}` +
        `  charge ${slot.charge.toFixed(2)}` +
        `  ability ${slot.ability || '-'}` +
        `  cell ${idx}`,
    );
  }
  lines.push('  legend: ║═╬ powered · │─┼ unpowered · ▩ blocked · ◉ core · ◈ relay');
  return lines.join('\n');
}

// ============================================================ self-test
// Guarded so the module stays safe to import in the browser bundle, where
// `process` does not exist.  Run:  WEAVE_SELFTEST=1 npx tsx shared/weave.ts

function runSelfTest(): void {
  const SIZES = [4, 5, 6, 7];
  const BOARDS = 200;
  let failures = 0;
  const fail = (msg: string): void => {
    failures++;
    console.error('  FAIL: ' + msg);
  };

  let totalConduit = 0;
  let totalCells = 0;
  let totalEmpty = 0;
  let totalBlockedAtStart = 0;
  let startConnectedSlots = 0;
  let boardsStartingSolved = 0;
  let minRouteCells = Infinity;
  let maxRouteCells = 0;
  let routeCellSum = 0;
  const t0 = process.hrtime.bigint();

  const sample: WeaveBoard[] = [];

  for (let s = 1; s <= BOARDS; s++) {
    const n = SIZES[s % SIZES.length];
    const board = createBoard(n, ['alpha', 'beta', 'gamma'], s * 7919 + 13);

    if (board.size !== n) fail(`seed ${s}: size ${board.size} != ${n}`);
    if (board.tiles.length !== n * n) fail(`seed ${s}: ${board.tiles.length} tiles for ${n}x${n}`);
    if (board.slots.length !== ABILITY_SLOTS) fail(`seed ${s}: ${board.slots.length} slots`);
    if (board.tiles[board.coreIndex].kind !== 'core') fail(`seed ${s}: coreIndex is not a core`);

    const slotTiles = board.tiles.filter((t) => t.kind === 'slot');
    if (slotTiles.length !== 3) fail(`seed ${s}: ${slotTiles.length} slot tiles`);
    const seen = new Set<number>();
    for (const t of slotTiles) {
      if (t.slotIndex === undefined) fail(`seed ${s}: slot tile with no slotIndex`);
      else seen.add(t.slotIndex);
      if (popcount4(t.base) !== 1) fail(`seed ${s}: slot base ${t.base} is not a single edge`);
      if (!t.locked) fail(`seed ${s}: slot tile not locked`);
    }
    if (seen.size !== 3) fail(`seed ${s}: slot indices ${[...seen].join(',')}`);

    // determinism
    const twin = createBoard(n, ['alpha', 'beta', 'gamma'], s * 7919 + 13);
    if (JSON.stringify(twin) !== JSON.stringify(board)) fail(`seed ${s}: not deterministic`);

    // must not start solved
    let live = 0;
    for (let k = 0; k < 3; k++) if (boardSolvedFor(board, k)) live++;
    startConnectedSlots += live;
    if (live > 0) {
      boardsStartingSolved++;
      fail(`seed ${s} (${n}x${n}): ${live} slot(s) already live at spawn\n${debugRender(board)}`);
    }

    // THE assertion: solvable to all three slots
    const rot = solveBoard(board);
    if (!rot) {
      fail(`seed ${s} (${n}x${n}): UNSOLVABLE\n${debugRender(board)}`);
      continue;
    }
    const solvedBoard = cloneBoard(board);
    for (let i = 0; i < rot.length; i++) solvedBoard.tiles[i].rotation = rot[i];
    recomputePower(solvedBoard);
    for (let k = 0; k < 3; k++) {
      if (!boardSolvedFor(solvedBoard, k)) fail(`seed ${s}: slot ${k} still dark after solving`);
      if (!solvedBoard.slots[k].connected) fail(`seed ${s}: slot ${k} connected flag not set`);
    }

    // stats
    let routeCells = 0;
    for (const t of solvedBoard.tiles) {
      totalCells++;
      if (t.kind === 'empty') totalEmpty++;
      else if (t.kind === 'blocked') totalBlockedAtStart++;
      else if (t.kind !== 'core' && t.kind !== 'slot') totalConduit++;
      if (t.powered && t.kind !== 'core' && t.kind !== 'slot') routeCells++;
    }
    routeCellSum += routeCells;
    if (routeCells < minRouteCells) minRouteCells = routeCells;
    if (routeCells > maxRouteCells) maxRouteCells = routeCells;

    if (sample.length < 1 && n === 5) sample.push(board);
  }

  const genMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // ---- rotation + connectivity mechanics
  {
    const b = createBoard(5, ['a', 'b', 'c'], 424242);
    const idx = b.tiles.findIndex((t) => !t.locked && t.kind === 'elbow');
    if (idx >= 0) {
      const before = b.tiles[idx].rotation;
      if (!rotateTile(b, idx)) fail('rotateTile refused an unlocked elbow');
      if (b.tiles[idx].rotation !== (before + 1) % 4) fail('rotateTile did not advance rotation');
      rotateTile(b, idx);
      rotateTile(b, idx);
      rotateTile(b, idx);
      if (b.tiles[idx].rotation !== before) fail('4 rotations did not return to start');
    }
    if (rotateTile(b, b.coreIndex)) fail('rotateTile accepted the core');
    if (rotateTile(b, -1)) fail('rotateTile accepted index -1');
    if (rotateTile(b, 9999)) fail('rotateTile accepted an out-of-range index');
    if (!b.tiles[b.coreIndex].powered) fail('core is not powered');

    const elbow = makeTile('elbow');
    if (edgeMaskFor(elbow) !== 3) fail('elbow r0 mask');
    elbow.rotation = 1;
    if (edgeMaskFor(elbow) !== 6) fail('elbow r1 mask');
    elbow.rotation = 3;
    if (edgeMaskFor(elbow) !== 9) fail('elbow r3 mask');
    const straight = makeTile('straight', 1);
    if (edgeMaskFor(straight) !== 10) fail('straight r1 mask');
  }

  // ---- charge accumulation / decay / overcharge
  {
    const b = createBoard(5, ['a', 'b', 'c'], 99);
    applySolution(b);
    const costs = [1.2, 2.0, 3.0];
    let crossed: number[] = [];
    for (let i = 0; i < 200; i++) {
      const f = updateCharge(b, 1 / 20, 1, costs);
      crossed = crossed.concat(f);
    }
    if (crossed.length !== 3) fail(`expected 3 charge crossings, got ${crossed.length}`);
    for (let k = 0; k < 3; k++) {
      const cap = costs[k] * MAX_OVERCHARGE;
      if (Math.abs(b.slots[k].charge - cap) > 1e-6) {
        fail(`slot ${k} charge ${b.slots[k].charge} != cap ${cap}`);
      }
    }
    const ability: AbilityDef = {
      id: 'a', name: 'A', role: 'any', shape: 'projectile', description: '',
      cost: 1.2, damage: 10, range: 100, radius: 0, speed: 500, duration: 0,
      scalesWithOvercharge: true, icon: '*',
    };
    if (!canFire(b, 0, ability)) fail('canFire false at full charge');
    const over = consumeCharge(b, 0, ability);
    if (Math.abs(over - MAX_OVERCHARGE) > 1e-6) fail(`overcharge ${over} != ${MAX_OVERCHARGE}`);
    if (b.slots[0].charge !== 0) fail('consumeCharge did not spend');
    if (canFire(b, 0, ability)) fail('canFire true right after spending');
    if (consumeCharge(b, 0, ability) !== 0) fail('consumeCharge paid out while empty');

    // decay when disconnected
    b.slots[1].connected = false;
    const startCharge = b.slots[1].charge;
    for (let i = 0; i < 20; i++) updateCharge(b, 1 / 20, 1, costs);
    const expected = Math.max(0, startCharge - CHARGE_DECAY_RATE * 1.0);
    if (Math.abs(b.slots[1].charge - expected) > 1e-6) {
      fail(`decay: ${b.slots[1].charge} != ${expected}`);
    }
    for (let i = 0; i < 400; i++) updateCharge(b, 1 / 20, 1, costs);
    if (b.slots[1].charge !== 0) fail('charge went below zero');
  }

  // ---- damageBoard never orphans a slot
  {
    let blocked = 0;
    for (let s = 0; s < 40; s++) {
      const b = createBoard(6, ['a', 'b', 'c'], 5000 + s);
      for (let hit = 0; hit < 10; hit++) {
        const i = damageBoard(b, s * 31 + hit);
        if (i < 0) break;
        blocked++;
        if (b.tiles[i].kind !== 'blocked') fail('damageBoard did not mark the cell blocked');
        if (!b.tiles[i].locked) fail('blocked cell is not locked');
        if (b.tiles[i].base !== 0) fail('blocked cell still has open edges');
        if (!isSolvable(b)) fail(`damageBoard made seed ${s} unsolvable after ${hit + 1} hits`);
      }
    }
    if (blocked === 0) fail('damageBoard never blocked anything');
    console.log(`  damageBoard: ${blocked} cells blocked across 40 boards, all stayed solvable`);
  }

  // ---- BoardOptions: prelock / decoy / blockedCells
  {
    let prelockedTotal = 0;
    for (let s = 1; s <= BOARDS; s++) {
      const n = SIZES[s % SIZES.length];
      const b = createBoard(n, ['a', 'b', 'c'], s * 104729 + 5, {
        prelockFraction: 0.25,
        decoyDensity: 0.2,
      });
      const rot = solveBoard(b);
      if (!rot) {
        fail(`prelock seed ${s} (${n}x${n}): UNSOLVABLE\n${debugRender(b)}`);
        continue;
      }
      // The pre-locked tiles must be part of a real solution — the solver is
      // not allowed to move them, so a bad pre-lock shows up as unsolvable.
      for (let i = 0; i < rot.length; i++) {
        if (b.tiles[i].locked && rot[i] !== b.tiles[i].rotation) {
          fail(`prelock seed ${s}: solver rotated a locked tile`);
        }
      }
      let live = 0;
      for (let k = 0; k < 3; k++) if (boardSolvedFor(b, k)) live++;
      if (live > 0) fail(`prelock seed ${s} (${n}x${n}): ${live} slot(s) live at spawn`);
      for (const t of b.tiles) {
        if (t.locked && t.kind !== 'core' && t.kind !== 'slot' && t.kind !== 'empty' &&
            t.kind !== 'blocked' && t.kind !== 'relay') prelockedTotal++;
      }
      // every slot must still need real work
      for (let k = 0; k < 3; k++) {
        const d = routeDistance(b, k);
        if (d < 1) fail(`prelock seed ${s}: slot ${k} routeDistance ${d} (starts free)`);
      }
    }
    console.log(`  prelockFraction 0.25: ${prelockedTotal} head-start tiles across ${BOARDS} boards, all still solvable`);

    const plain = createBoard(6, ['a', 'b', 'c'], 6161);
    const noisy = createBoard(6, ['a', 'b', 'c'], 6161, { decoyDensity: 1 });
    const count = (b: WeaveBoard): number => b.tiles.filter((t) => t.kind === 'empty').length;
    if (count(noisy) >= count(plain)) fail('decoyDensity 1 did not add conduit');
    if (!isSolvable(noisy)) fail('decoyDensity 1 produced an unsolvable board');

    // blockedCells is best-effort: never MORE than asked, and a normal-size
    // board should almost always deliver the full count.
    for (const want of [1, 3, 6]) {
      let exact = 0;
      const trials = 60;
      for (let s = 0; s < trials; s++) {
        const b = createBoard(6, ['a', 'b', 'c'], 4321 + s * 97, { blockedCells: want });
        const got = b.tiles.filter((t) => t.kind === 'blocked').length;
        if (got > want) fail(`blockedCells ${want} produced ${got}`);
        if (got === want) exact++;
        for (const t of b.tiles) {
          if (t.kind !== 'blocked') continue;
          if (!t.locked || t.base !== 0) fail('pre-blocked cell is not a sealed, locked cell');
        }
        if (!isSolvable(b)) fail(`blockedCells ${want} produced an unsolvable board`);
        for (let k = 0; k < 3; k++) {
          if (boardSolvedFor(b, k)) fail(`blockedCells ${want}: slot ${k} live at spawn`);
        }
      }
      const pct = (exact / trials) * 100;
      if (pct < 90) fail(`blockedCells ${want} only reached the full count ${pct.toFixed(0)}% of the time`);
      console.log(`  blockedCells ${want}: exact on ${pct.toFixed(0)}% of 6x6 boards, all solvable + dark`);
    }
    // 3-arg call sites are untouched by the new parameter
    const a3 = createBoard(5, ['a', 'b', 'c'], 8080);
    const a4 = createBoard(5, ['a', 'b', 'c'], 8080, {});
    if (JSON.stringify(a3) !== JSON.stringify(a4)) fail('opts:{} changed the 3-arg result');
  }

  // ---- routeDistance
  {
    const b = createBoard(6, ['a', 'b', 'c'], 20250726);
    for (let k = 0; k < 3; k++) {
      const d = routeDistance(b, k);
      if (d < 1) fail(`routeDistance slot ${k} = ${d} on a fresh (dark) board`);
      // walking the reported number of clicks must be enough: solve, then the
      // distance has to be 0.
    }
    const solved = cloneBoard(b);
    applySolution(solved);
    for (let k = 0; k < 3; k++) {
      if (!solved.slots[k].connected) fail(`routeDistance: slot ${k} not connected after solve`);
      if (routeDistance(solved, k) !== 0) fail(`routeDistance != 0 for a connected slot ${k}`);
    }
    // A slot walled off from the core reports -1.
    const dead = cloneBoard(b);
    const si = slotTileIndex(dead, 0);
    const n = dead.size;
    for (let d = 0; d < 4; d++) {
      const nx = (si % n) + DIR_DX[d];
      const ny = ((si / n) | 0) + DIR_DY[d];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      dead.tiles[j] = { kind: 'blocked', base: 0, rotation: 0, locked: true, powered: false };
    }
    recomputePower(dead);
    if (routeDistance(dead, 0) !== -1) fail('routeDistance on a walled-off slot != -1');
    if (isSolvable(dead)) fail('a walled-off slot still reports solvable');
    // scrambleRotations is the alias
    const x = createBoard(6, ['a', 'b', 'c'], 55);
    const y = createBoard(6, ['a', 'b', 'c'], 55);
    scrambleBoard(x, 9);
    scrambleRotations(y, 9);
    if (JSON.stringify(x) !== JSON.stringify(y)) fail('scrambleRotations != scrambleBoard');
    const locksBefore = y.tiles.map((t) => t.locked).join(',');
    scrambleRotations(y, 10);
    if (y.tiles.map((t) => t.locked).join(',') !== locksBefore) fail('scrambleRotations changed locks');
  }

  // ---- scrambleBoard keeps solvability, changes rotations
  {
    const b = createBoard(6, ['a', 'b', 'c'], 777);
    applySolution(b);
    const before = b.tiles.map((t) => t.rotation).join(',');
    scrambleBoard(b, 1234);
    if (!isSolvable(b)) fail('scrambleBoard produced an unsolvable board');
    if (b.tiles.map((t) => t.rotation).join(',') === before) fail('scrambleBoard changed nothing');
    const c = createBoard(6, ['a', 'b', 'c'], 777);
    scrambleBoard(c, 1234);
    const d = createBoard(6, ['a', 'b', 'c'], 777);
    scrambleBoard(d, 1234);
    if (JSON.stringify(c) !== JSON.stringify(d)) fail('scrambleBoard is not deterministic');
  }

  // ---- relay linking across boards
  {
    const a = createBoard(5, ['a', 'b', 'c'], 31337);
    const b = createBoard(5, ['a', 'b', 'c'], 31338);
    // Find a cell that A can power and that both boards can host a relay on.
    applySolution(a);
    let relayAt = -1;
    for (let i = 0; i < a.tiles.length; i++) {
      const ta = a.tiles[i];
      const tb = b.tiles[i];
      if (i === a.coreIndex || i === b.coreIndex) continue;
      if (ta.kind === 'slot' || tb.kind === 'slot') continue;
      if (!ta.powered) continue;
      relayAt = i;
      break;
    }
    if (relayAt < 0) fail('no candidate relay cell found');
    else {
      // Force A's relay live by wiring it in, keep B's relay isolated.
      placeRelay(a, relayAt);
      placeRelay(b, relayAt);
      for (const t of b.tiles) if (!t.locked) t.rotation = 0;
      recomputePower(a);
      recomputePower(b);
      const aLive = a.tiles[relayAt].powered;
      linkRelays([a, b]);
      if (aLive && !b.tiles[relayAt].powered) {
        fail('linkRelays did not share power into board B');
      }
      if (!a.tiles[relayAt].powered && b.tiles[relayAt].powered) {
        fail('linkRelays did not share power back into board A');
      }
      // idempotent
      const snapA = JSON.stringify(a);
      const snapB = JSON.stringify(b);
      linkRelays([a, b]);
      if (JSON.stringify(a) !== snapA || JSON.stringify(b) !== snapB) {
        fail('linkRelays is not idempotent');
      }
      console.log(`  linkRelays: relay at cell ${relayAt}, A=${a.tiles[relayAt].powered} B=${b.tiles[relayAt].powered}`);
    }
  }

  // ---- report
  console.log('');
  console.log(`  boards generated : ${BOARDS} (sizes ${SIZES.join('/')}) in ${genMs.toFixed(0)} ms`);
  console.log(`  slots live at spawn: ${startConnectedSlots} / ${BOARDS * 3}   fully-solved boards: ${boardsStartingSolved}`);
  console.log(`  solution route cells: min ${minRouteCells}  avg ${(routeCellSum / BOARDS).toFixed(1)}  max ${maxRouteCells}`);
  console.log(
    `  cell mix: ${((totalConduit / totalCells) * 100).toFixed(0)}% conduit, ` +
      `${((totalEmpty / totalCells) * 100).toFixed(0)}% empty, ` +
      `${totalBlockedAtStart} blocked at spawn`,
  );
  console.log('');

  if (sample.length > 0) {
    const b = sample[0];
    console.log('  --- sample board, as generated (scrambled) ---');
    console.log(debugRender(b));
    const solved = cloneBoard(b);
    applySolution(solved);
    for (let i = 0; i < solved.slots.length; i++) solved.slots[i].charge = 1.25;
    console.log('');
    console.log('  --- same board, solved ---');
    console.log(debugRender(solved));
  }

  console.log('');
  if (failures === 0) console.log(`WEAVE SELFTEST: PASS (${BOARDS} boards, 0 failures)`);
  else console.error(`WEAVE SELFTEST: ${failures} FAILURE(S)`);

  if (failures > 0 && typeof process.exit === 'function') process.exit(1);
}

if (typeof process !== 'undefined' && process.env && process.env.WEAVE_SELFTEST) {
  runSelfTest();
}
