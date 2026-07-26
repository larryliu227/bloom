/**
 * VOIDLINE — the Weave board.
 *
 * `drawWeave()` is a pure Canvas2D renderer for a `WeaveBoard`; it is used both by
 * the in-match panel (bottom right) and by the loadout screen's live preview.
 *
 * `WeavePanel` wraps it with input: clicking a tile rotates it clockwise, applying
 * an immediate optimistic local rotation (so it feels instant) which the next
 * authoritative `weave` message overwrites.
 */

import { CHARGE_DECAY_RATE, CHARGE_RATE_BASE, MAX_OVERCHARGE, WEAVE_ROTATE_COOLDOWN } from '@shared/constants.js';
import type { WeaveBoard, WeaveTile } from '@shared/types.js';
import { edgeMaskFor, recomputePower, rotateTile } from '@shared/weave.js';
import { fitCanvas, h, hash01, roundRect } from './dom.js';

// ---------------------------------------------------------------- geometry

/** up, right, down, left — matching the EdgeMask bit order in types.ts. */
const DIRS: ReadonlyArray<{ bit: number; dx: number; dy: number }> = [
  { bit: 1, dx: 0, dy: -1 },
  { bit: 2, dx: 1, dy: 0 },
  { bit: 4, dx: 0, dy: 1 },
  { bit: 8, dx: -1, dy: 0 },
];

/** Kept in lockstep with client/render/palette.ts so the UI reads as one product. */
const PALETTE = {
  plate: '#0a0e19',
  plateLit: '#111c2e',
  plateEdge: 'rgba(70,120,160,0.20)',
  /**
   * Unpowered conduit, drawn in two strokes.
   *
   * Reading the topology at a glance *is* the game — you plan a route before
   * you commit a rotation — so a dead conduit has to be legible, not merely
   * present. The old single `#16294a` stroke sat at 1.32:1 against the plate:
   * technically visible, useless for planning.
   *
   * `pipeCasing` is the wide body and `pipeDim` the bright inner line drawn
   * over it. Both are *desaturated steel*, deliberately off the cyan axis:
   * powered conduits stay unmistakable because they are cyan, additively
   * glowing and carrying animated energy, none of which these do. The casing
   * keeps the strokes reading as physical pipe rather than flat paint.
   */
  pipeCasing: '#1d3350',
  pipeDim: '#6d8ba6',
  pipeCore: '#0f6d86',
  energy: '#3ff5ff',
  energyHot: '#eafcff',
  violet: '#a06bff',
  danger: '#ff3c5a',
  muted: 'rgba(120,160,190,0.5)',
};

export interface WeaveDrawOptions {
  /** Seconds, monotonically increasing. Drives every animation. */
  time: number;
  /** Role accent color, hex. */
  accent?: string;
  /** Tile index under the cursor, or -1. */
  hover?: number;
  /** Tile index being pressed, or -1. */
  pressed?: number;
  /** Continuous (fractional, unwrapped) rotation per tile for smooth turning. */
  rotVis?: Float32Array | null;
  /** Charge cost per slot, so the ring can show a real fraction. */
  costs?: number[];
  /** Icon glyph per slot. */
  icons?: string[];
  /** False for static previews: hides charge rings and ready flares. */
  showCharge?: boolean;
  /** Overall glow strength, 0..1. */
  glow?: number;
}

/** Flood fill from the core across open edges. Returns BFS depth, -1 = unpowered. */
export function powerDepth(board: WeaveBoard): Int32Array {
  const size = board.size;
  const n = size * size;
  const depth = new Int32Array(n).fill(-1);
  const masks = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = board.tiles[i];
    if (!t || t.kind === 'empty' || t.kind === 'blocked') continue;
    masks[i] = edgeMaskFor(t) & 15;
  }
  const core = board.coreIndex;
  if (core < 0 || core >= n) return depth;
  depth[core] = 0;
  const queue = [core];
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi];
    const cx = i % size;
    const cy = (i / size) | 0;
    const d = depth[i];
    for (let dir = 0; dir < 4; dir++) {
      const D = DIRS[dir];
      if ((masks[i] & D.bit) === 0) continue;
      const nx = cx + D.dx;
      const ny = cy + D.dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const j = ny * size + nx;
      if (depth[j] !== -1) continue;
      const back = DIRS[(dir + 2) % 4].bit;
      if ((masks[j] & back) === 0) continue;
      depth[j] = d + 1;
      queue.push(j);
    }
  }
  return depth;
}

/** Charge fraction of a slot, 0..1 (1 = fireable). Values above 1 are overcharge. */
export function slotFraction(board: WeaveBoard, slot: number, cost: number): number {
  const s = board.slots[slot];
  if (!s || cost <= 0) return 0;
  return s.charge / cost;
}

// ---------------------------------------------------------------- drawing

export function drawWeave(
  ctx: CanvasRenderingContext2D,
  board: WeaveBoard,
  ox: number,
  oy: number,
  cell: number,
  opts: WeaveDrawOptions,
): void {
  const size = board.size;
  const t = opts.time;
  const accent = opts.accent ?? PALETTE.energy;
  const hover = opts.hover ?? -1;
  const pressed = opts.pressed ?? -1;
  const glow = opts.glow ?? 1;
  const showCharge = opts.showCharge !== false;
  const depth = powerDepth(board);
  const boardPx = size * cell;

  const cxOf = (i: number): number => ox + ((i % size) + 0.5) * cell;
  const cyOf = (i: number): number => oy + (((i / size) | 0) + 0.5) * cell;

  ctx.save();

  // ---- backdrop -------------------------------------------------------
  const bg = ctx.createLinearGradient(ox, oy, ox + boardPx, oy + boardPx);
  bg.addColorStop(0, '#070c16');
  bg.addColorStop(1, '#050810');
  roundRect(ctx, ox - 6, oy - 6, boardPx + 12, boardPx + 12, 10);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = 'rgba(60,110,150,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // ---- cell plates ----------------------------------------------------
  for (let i = 0; i < size * size; i++) {
    const tile = board.tiles[i];
    if (!tile) continue;
    const x = ox + (i % size) * cell;
    const y = oy + ((i / size) | 0) * cell;
    const inset = cell * 0.045;
    const w = cell - inset * 2;

    if (tile.kind === 'blocked') {
      roundRect(ctx, x + inset, y + inset, w, w, cell * 0.1);
      ctx.fillStyle = '#150a0c';
      ctx.fill();
      // Held up against the brighter conduits: a dead cell must stay
      // unmistakably dead-and-red, never read as just another dim tile.
      ctx.strokeStyle = 'rgba(255,90,60,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
      drawCracks(ctx, x + cell / 2, y + cell / 2, cell, i);
      continue;
    }
    if (tile.kind === 'empty') {
      roundRect(ctx, x + inset, y + inset, w, w, cell * 0.1);
      ctx.fillStyle = 'rgba(8,12,20,0.75)';
      ctx.fill();
      continue;
    }

    const lit = depth[i] >= 0;
    const isHover = i === hover;
    roundRect(ctx, x + inset, y + inset, w, w, cell * 0.1);
    ctx.fillStyle = isHover ? PALETTE.plateLit : PALETTE.plate;
    ctx.fill();
    ctx.strokeStyle = lit ? 'rgba(90,200,235,0.24)' : PALETTE.plateEdge;
    ctx.lineWidth = 1;
    ctx.stroke();

    if (tile.locked) drawLockMarks(ctx, x, y, cell);
  }

  // ---- conduits (dim base pass) --------------------------------------
  // Two strokes: a dark casing for body, then a bright inner line so the
  // route is readable without power. The powered pass below lands on top of
  // the same geometry, so lit conduits still win outright.
  ctx.lineCap = 'round';
  for (let i = 0; i < size * size; i++) {
    const tile = board.tiles[i];
    if (!tile || !hasPipes(tile)) continue;
    const cx = cxOf(i);
    const cy = cyOf(i);
    const rot = rotOf(opts, i, tile);
    drawTilePipes(ctx, tile, cx, cy, cell, rot, PALETTE.pipeCasing, cell * 0.19, 0);
    drawTilePipes(ctx, tile, cx, cy, cell, rot, PALETTE.pipeDim, cell * 0.085, 0);
  }

  // ---- conduits (powered pass, additive) ------------------------------
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < size * size; i++) {
    const tile = board.tiles[i];
    if (!tile || !hasPipes(tile) || depth[i] < 0) continue;
    const pulse = 0.72 + 0.28 * Math.sin(t * 3.1 - depth[i] * 0.55);
    ctx.globalAlpha = 0.55 * glow * pulse;
    drawTilePipes(ctx, tile, cxOf(i), cyOf(i), cell, rotOf(opts, i, tile), PALETTE.pipeCore, cell * 0.155, 0);
    ctx.globalAlpha = 0.9 * glow;
    drawTilePipes(ctx, tile, cxOf(i), cyOf(i), cell, rotOf(opts, i, tile), PALETTE.energy, cell * 0.055, cell * 0.35 * glow);
  }
  ctx.globalAlpha = 1;

  // ---- energy flowing from the core to the slots ----------------------
  const flowRate = 1.35; // cells per second
  for (let i = 0; i < size * size; i++) {
    if (depth[i] < 0) continue;
    const tile = board.tiles[i];
    if (!tile) continue;
    const mask = edgeMaskFor(tile) & 15;
    const gx = i % size;
    const gy = (i / size) | 0;
    for (let dir = 0; dir < 4; dir++) {
      const D = DIRS[dir];
      if ((mask & D.bit) === 0) continue;
      const nx = gx + D.dx;
      const ny = gy + D.dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const j = ny * size + nx;
      if (depth[j] !== depth[i] + 1) continue; // draw only downstream flow
      const x0 = cxOf(i);
      const y0 = cyOf(i);
      const x1 = cxOf(j);
      const y1 = cyOf(j);
      for (let p = 0; p < 2; p++) {
        const u = fract(t * flowRate - depth[i] - p * 0.5);
        const px = x0 + (x1 - x0) * u;
        const py = y0 + (y1 - y0) * u;
        const fade = Math.sin(Math.PI * Math.min(1, u * 1.02));
        const r = cell * (0.055 + 0.03 * fade);
        const grd = ctx.createRadialGradient(px, py, 0, px, py, r * 3.2);
        grd.addColorStop(0, PALETTE.energyHot);
        grd.addColorStop(0.35, accent);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = 0.85 * fade * glow;
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(px, py, r * 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // ---- special tiles ---------------------------------------------------
  for (let i = 0; i < size * size; i++) {
    const tile = board.tiles[i];
    if (!tile) continue;
    const cx = cxOf(i);
    const cy = cyOf(i);
    if (tile.kind === 'core') drawCore(ctx, cx, cy, cell, t, accent);
    else if (tile.kind === 'relay') drawRelay(ctx, cx, cy, cell, t, depth[i] >= 0);
    else if (tile.kind === 'slot') {
      const idx = tile.slotIndex ?? 0;
      const cost = opts.costs?.[idx] ?? 1;
      const frac = showCharge ? slotFraction(board, idx, cost) : 0;
      drawSlot(ctx, cx, cy, cell, t, idx, frac, depth[i] >= 0, opts.icons?.[idx] ?? '◆', accent, showCharge);
    } else if (hasPipes(tile)) {
      // conduit hub dot
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.075, 0, Math.PI * 2);
      ctx.fillStyle = depth[i] >= 0 ? PALETTE.energy : PALETTE.pipeDim;
      ctx.fill();
    }
  }

  // ---- hover / press affordance ---------------------------------------
  if (hover >= 0) {
    const tile = board.tiles[hover];
    if (tile && !tile.locked && tile.kind !== 'blocked' && tile.kind !== 'empty') {
      const cx = cxOf(hover);
      const cy = cyOf(hover);
      const r = cell * (hover === pressed ? 0.3 : 0.34);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = accent;
      ctx.globalAlpha = hover === pressed ? 0.95 : 0.6;
      ctx.lineWidth = Math.max(1.2, cell * 0.035);
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI * 0.85, Math.PI * 0.35);
      ctx.stroke();
      // arrow head at the arc end, pointing clockwise
      const a = Math.PI * 0.35;
      const hx = cx + Math.cos(a) * r;
      const hy = cy + Math.sin(a) * r;
      const s = cell * 0.09;
      ctx.beginPath();
      ctx.moveTo(hx + Math.cos(a - 0.4) * s, hy + Math.sin(a - 0.4) * s);
      ctx.lineTo(hx + Math.cos(a + 1.9) * s, hy + Math.sin(a + 1.9) * s);
      ctx.lineTo(hx + Math.cos(a + 0.9) * s * 1.6, hy + Math.sin(a + 0.9) * s * 1.6);
      ctx.closePath();
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.restore();
    }
  }

  ctx.restore();
}

function fract(n: number): number {
  return n - Math.floor(n);
}

function hasPipes(tile: WeaveTile): boolean {
  return tile.kind !== 'empty' && tile.kind !== 'blocked';
}

function rotOf(opts: WeaveDrawOptions, i: number, tile: WeaveTile): number {
  const v = opts.rotVis;
  return v && i < v.length ? v[i] : tile.rotation;
}

/** Draw the tile's conduit spokes, rotated by a fractional quarter-turn count. */
function drawTilePipes(
  ctx: CanvasRenderingContext2D,
  tile: WeaveTile,
  cx: number,
  cy: number,
  cell: number,
  rot: number,
  color: string,
  width: number,
  blur: number,
): void {
  const base = tile.kind === 'core' || tile.kind === 'slot' || tile.kind === 'relay'
    ? edgeMaskFor(tile) & 15
    : tile.base & 15;
  if (!base) return;
  const spinnable = !(tile.kind === 'core' || tile.kind === 'slot' || tile.kind === 'relay');
  ctx.save();
  ctx.translate(cx, cy);
  if (spinnable) ctx.rotate(rot * Math.PI * 0.5);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  if (blur > 0) {
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
  }
  const reach = cell * 0.5;
  ctx.beginPath();
  for (let dir = 0; dir < 4; dir++) {
    if ((base & DIRS[dir].bit) === 0) continue;
    ctx.moveTo(0, 0);
    ctx.lineTo(DIRS[dir].dx * reach, DIRS[dir].dy * reach);
  }
  ctx.stroke();
  ctx.restore();
}

function drawCore(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  cell: number,
  t: number,
  accent: string,
): void {
  const r = cell * 0.3;
  const pulse = 0.85 + 0.15 * Math.sin(t * 4.2);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.6 * pulse);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.25, accent);
  g.addColorStop(0.6, 'rgba(90,220,255,0.32)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 2.6 * pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // rotating containment ring
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t * 0.6);
  ctx.strokeStyle = 'rgba(230,250,255,0.85)';
  ctx.lineWidth = Math.max(1, cell * 0.028);
  ctx.beginPath();
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

function drawRelay(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  cell: number,
  t: number,
  lit: boolean,
): void {
  const r = cell * 0.27;
  ctx.save();
  ctx.strokeStyle = lit ? PALETTE.violet : 'rgba(140,110,190,0.4)';
  ctx.lineWidth = Math.max(1, cell * 0.03);
  ctx.setLineDash([cell * 0.09, cell * 0.07]);
  ctx.lineDashOffset = -t * cell * 0.4;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(cx, cy, cell * 0.09, 0, Math.PI * 2);
  ctx.fillStyle = lit ? '#e6d9ff' : '#3a3050';
  ctx.fill();
  ctx.restore();
}

function drawSlot(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  cell: number,
  t: number,
  index: number,
  frac: number,
  connected: boolean,
  icon: string,
  accent: string,
  showCharge: boolean,
): void {
  const half = cell * 0.31;
  const ready = frac >= 1;

  // housing
  roundRect(ctx, cx - half, cy - half, half * 2, half * 2, cell * 0.08);
  ctx.fillStyle = ready ? 'rgba(20,45,58,0.95)' : 'rgba(8,16,26,0.95)';
  ctx.fill();
  ctx.strokeStyle = ready ? '#eafcff' : connected ? accent : 'rgba(120,160,190,0.45)';
  ctx.lineWidth = Math.max(1, cell * 0.028);
  ctx.stroke();

  // charge ring
  if (showCharge) {
    const r = cell * 0.4;
    ctx.save();
    ctx.lineWidth = Math.max(1.5, cell * 0.05);
    ctx.strokeStyle = 'rgba(70,110,140,0.35)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    if (frac > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = ready ? '#eafcff' : accent;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, frac));
      ctx.stroke();
      if (frac > 1) {
        ctx.strokeStyle = PALETTE.violet;
        ctx.lineWidth = Math.max(1, cell * 0.028);
        ctx.beginPath();
        ctx.arc(
          cx,
          cy,
          r + cell * 0.055,
          -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * Math.min(1, (frac - 1) / (MAX_OVERCHARGE - 1)),
        );
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ready flare
  if (ready && showCharge) {
    const p = 0.5 + 0.5 * Math.sin(t * 7);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.35 + 0.35 * p;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cell * 0.72);
    g.addColorStop(0, 'rgba(220,255,255,0.55)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.72, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // icon
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(cell * 0.33)}px "Apple Color Emoji","Segoe UI Emoji",system-ui,sans-serif`;
  ctx.fillStyle = ready ? '#ffffff' : connected ? '#cfe6f5' : 'rgba(160,190,210,0.65)';
  ctx.fillText(icon, cx, cy + cell * 0.01);
  ctx.restore();

  // slot number
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${Math.round(cell * 0.16)}px ui-monospace,Menlo,Consolas,monospace`;
  ctx.fillStyle = ready ? '#eafcff' : 'rgba(140,180,205,0.8)';
  ctx.fillText(String(index + 1), cx - half + cell * 0.09, cy - half + cell * 0.09);
  ctx.restore();
}

function drawLockMarks(ctx: CanvasRenderingContext2D, x: number, y: number, cell: number): void {
  const m = cell * 0.14;
  const len = cell * 0.11;
  ctx.save();
  // Brighter conduits would otherwise swallow the "you cannot turn this" cue.
  ctx.strokeStyle = 'rgba(178,208,230,0.52)';
  ctx.lineWidth = Math.max(1, cell * 0.022);
  ctx.beginPath();
  // four corner brackets
  ctx.moveTo(x + m, y + m + len);
  ctx.lineTo(x + m, y + m);
  ctx.lineTo(x + m + len, y + m);
  ctx.moveTo(x + cell - m - len, y + m);
  ctx.lineTo(x + cell - m, y + m);
  ctx.lineTo(x + cell - m, y + m + len);
  ctx.moveTo(x + cell - m, y + cell - m - len);
  ctx.lineTo(x + cell - m, y + cell - m);
  ctx.lineTo(x + cell - m - len, y + cell - m);
  ctx.moveTo(x + m + len, y + cell - m);
  ctx.lineTo(x + m, y + cell - m);
  ctx.lineTo(x + m, y + cell - m - len);
  ctx.stroke();
  ctx.restore();
}

function drawCracks(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  cell: number,
  seed: number,
): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,110,80,0.5)';
  ctx.lineWidth = Math.max(1, cell * 0.022);
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    const a0 = hash01(seed * 31 + k) * Math.PI * 2;
    const a1 = a0 + (hash01(seed * 71 + k) - 0.5) * 1.4;
    const r0 = cell * 0.06;
    const r1 = cell * (0.24 + hash01(seed * 17 + k) * 0.14);
    ctx.moveTo(cx + Math.cos(a0) * r0, cy + Math.sin(a0) * r0);
    ctx.lineTo(cx + Math.cos(a1) * r1, cy + Math.sin(a1) * r1);
  }
  ctx.stroke();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = 'rgba(255,90,60,0.8)';
  ctx.lineWidth = Math.max(1, cell * 0.03);
  const d = cell * 0.14;
  ctx.beginPath();
  ctx.moveTo(cx - d, cy - d);
  ctx.lineTo(cx + d, cy + d);
  ctx.moveTo(cx + d, cy - d);
  ctx.lineTo(cx - d, cy + d);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------- panel

export interface WeavePanelOptions {
  /** Called when the player rotates a tile (after the optimistic local turn). */
  onRotate: (index: number) => void;
}

export class WeavePanel {
  readonly root: HTMLElement;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private titleEl: HTMLElement;
  private board: WeaveBoard | null = null;
  private rotVis = new Float32Array(0);
  private rotTarget = new Float32Array(0);
  private hover = -1;
  private pressed = -1;
  private time = 0;
  private rotateLock = 0;
  /** Cached CSS-intended canvas side, and the panel width it was measured at. */
  private cachedSide = 0;
  private lastPanelW = -1;
  private cell = 40;
  private originX = 0;
  private originY = 0;
  private opts: WeavePanelOptions;

  accent = '#3ff5ff';
  costs: number[] = [1, 1, 1];
  icons: string[] = ['◆', '◆', '◆'];
  chargeRateMul = 1;

  constructor(opts: WeavePanelOptions) {
    this.opts = opts;
    this.root = h('div', 'weave-panel hidden');
    const head = h('div', 'weave-head');
    this.titleEl = h('span', 'weave-title', 'WEAVE');
    head.appendChild(this.titleEl);
    head.appendChild(h('span', 'weave-hint', 'CLICK TO ROTATE'));
    this.root.appendChild(head);

    this.canvas = h('canvas', 'weave-canvas');
    this.root.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('weave: 2d context unavailable');
    this.ctx = ctx;

    this.canvas.addEventListener('mousemove', (e) => {
      this.hover = this.hitTest(e.clientX, e.clientY);
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hover = -1;
      this.pressed = -1;
    });
    this.canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = this.hitTest(e.clientX, e.clientY);
      this.pressed = idx;
      if (idx >= 0) this.rotate(idx);
    });
    this.canvas.addEventListener('mouseup', () => {
      this.pressed = -1;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  setTitle(text: string): void {
    this.titleEl.textContent = text;
  }

  get currentBoard(): WeaveBoard | null {
    return this.board;
  }

  /** Adopt an authoritative board, preserving in-flight rotation animation. */
  setBoard(board: WeaveBoard): void {
    const n = board.size * board.size;
    if (this.rotVis.length !== n) {
      this.rotVis = new Float32Array(n);
      this.rotTarget = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        this.rotVis[i] = board.tiles[i]?.rotation ?? 0;
        this.rotTarget[i] = this.rotVis[i];
      }
    } else {
      for (let i = 0; i < n; i++) {
        const rot = board.tiles[i]?.rotation ?? 0;
        this.rotTarget[i] = alignRotation(this.rotVis[i], rot);
      }
    }
    this.board = board;
  }

  clearBoard(): void {
    this.board = null;
  }

  /** True if the given viewport point lands on the panel (input hit-test). */
  containsPoint(clientX: number, clientY: number): boolean {
    if (this.root.classList.contains('hidden')) return false;
    const r = this.root.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  /** Tile index under a viewport point, or -1. */
  hitTest(clientX: number, clientY: number): number {
    const board = this.board;
    if (!board) return -1;
    const r = this.canvas.getBoundingClientRect();
    const x = clientX - r.left - this.originX;
    const y = clientY - r.top - this.originY;
    if (x < 0 || y < 0) return -1;
    const col = Math.floor(x / this.cell);
    const row = Math.floor(y / this.cell);
    if (col < 0 || row < 0 || col >= board.size || row >= board.size) return -1;
    return row * board.size + col;
  }

  /** Optimistic clockwise rotation + server request. */
  rotate(index: number): void {
    const board = this.board;
    if (!board) return;
    if (this.rotateLock > 0) return;
    const tile = board.tiles[index];
    if (!tile || tile.locked || tile.kind === 'blocked' || tile.kind === 'empty') return;

    const before = tile.rotation;
    if (!rotateTile(board, index)) return;
    recomputePower(board);
    this.rotTarget[index] = alignRotation(this.rotVis[index], before) + 1;
    this.rotateLock = WEAVE_ROTATE_COOLDOWN;
    this.opts.onRotate(index);
  }

  /** Smoothly extrapolate slot charge between authoritative `weave` messages. */
  advanceCharge(dt: number): void {
    const board = this.board;
    if (!board) return;
    for (let i = 0; i < board.slots.length; i++) {
      const s = board.slots[i];
      if (!s) continue;
      const cap = (this.costs[i] ?? 1) * MAX_OVERCHARGE;
      if (s.connected) s.charge = Math.min(cap, s.charge + CHARGE_RATE_BASE * this.chargeRateMul * dt);
      else s.charge = Math.max(0, s.charge - CHARGE_DECAY_RATE * dt);
    }
  }

  /**
   * The CSS-intended square size for the board canvas, in CSS pixels.
   *
   * `fitCanvas` pins an inline width/height on the canvas, so measuring the canvas
   * directly reads back a value we just wrote — a self-reinforcing latch that beats
   * `.weave-canvas { width: 100% }` and freezes the board at whatever size it first
   * saw. On any window downsize the board then overflowed its panel and slid partly
   * off-screen, taking the game's core mechanic with it.
   *
   * So: clear the inline size, let CSS lay it out, and measure that. Clearing forces
   * a reflow, which is why the result is cached and only recomputed when the panel's
   * own width actually changes (`--weave-size` tracks the viewport) — not every frame.
   */
  private measureSide(): number {
    const panelW = this.root.clientWidth;
    if (panelW === this.lastPanelW && this.cachedSide > 0) return this.cachedSide;

    this.canvas.style.width = '';
    this.canvas.style.height = '';
    const rect = this.canvas.getBoundingClientRect();
    // While the panel is hidden every measurement is 0; keep any previous value
    // rather than latching to 1px, and retry once it is visible.
    const side = Math.floor(Math.min(rect.width, rect.height));
    if (side <= 0) return this.cachedSide > 0 ? this.cachedSide : 1;

    this.lastPanelW = panelW;
    this.cachedSide = side;
    return side;
  }

  update(dtMs: number): void {
    const dt = dtMs / 1000;
    this.time += dt;
    this.rotateLock = Math.max(0, this.rotateLock - dt);

    const board = this.board;
    const side = this.measureSide();
    const { w, h: hh } = fitCanvas(this.canvas, side, side);
    const dpr = this.canvas.width / Math.max(1, w);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    if (!board) return;

    // rotation easing
    const k = 1 - Math.exp(-18 * dt);
    for (let i = 0; i < this.rotVis.length; i++) {
      const d = this.rotTarget[i] - this.rotVis[i];
      this.rotVis[i] += Math.abs(d) < 0.001 ? d : d * k;
    }

    const pad = 10;
    this.cell = Math.floor(Math.min(w - pad * 2, hh - pad * 2) / board.size);
    const boardPx = this.cell * board.size;
    this.originX = Math.round((w - boardPx) / 2);
    this.originY = Math.round((hh - boardPx) / 2);

    drawWeave(ctx, board, this.originX, this.originY, this.cell, {
      time: this.time,
      accent: this.accent,
      hover: this.hover,
      pressed: this.pressed,
      rotVis: this.rotVis,
      costs: this.costs,
      icons: this.icons,
      showCharge: true,
      glow: 1,
    });
  }
}

/** Pick the representative of `rot` (mod 4) nearest to the current visual angle. */
function alignRotation(vis: number, rot: number): number {
  return rot + 4 * Math.round((vis - rot) / 4);
}
