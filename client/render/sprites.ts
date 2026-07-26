/**
 * VOIDLINE — sprite & texture bakery.
 *
 * Canvas2D is fast at `drawImage` and slow at everything that allocates
 * (gradients, patterns, per-frame path building). So every repeated visual
 * element in the game is baked ONCE into an offscreen canvas here and then
 * blitted. Nothing in this module runs per frame; everything is memoised.
 *
 * Bakes:
 *  - layered radial glow sprites (the additive workhorse)
 *  - soft smoke puffs
 *  - directional energy streaks (conduit pulses, dashes, beams)
 *  - two parallax starfield tiles
 *  - a drifting nebula sheet
 *  - the entire static arena deck (hex mesh + circuit traces + conduit grid)
 *  - scanline / grain / vignette screen dressing
 */

import { makeRng } from '@shared/math.js';
import * as P from './palette.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------- primitives

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = c.getContext('2d');
  if (g === null) throw new Error('VOIDLINE: unable to acquire a 2D canvas context');
  return g;
}

// ---------------------------------------------------------------- glow sprite

const glowCache = new Map<string, HTMLCanvasElement>();

/**
 * A radial glow: white-hot centre, saturated mid, transparent rim.
 * Blit this additively at several scales to build the layered-glow look.
 * `size` is the sprite's pixel diameter; snapped to a power of two so the
 * cache stays small (callers scale freely at draw time).
 */
export function glowSprite(color: string, size = 64): HTMLCanvasElement {
  const s = size <= 16 ? 16 : size <= 32 ? 32 : size <= 64 ? 64 : 128;
  const key = color + '|' + s;
  const hit = glowCache.get(key);
  if (hit !== undefined) return hit;

  const c = createCanvas(s, s);
  const g = ctx2d(c);
  const r = s / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.0, P.withAlpha(P.CORE_WHITE, 1));
  grad.addColorStop(0.14, P.withAlpha(P.hot(color, 0.55), 0.96));
  grad.addColorStop(0.34, P.withAlpha(color, 0.62));
  grad.addColorStop(0.62, P.withAlpha(color, 0.19));
  grad.addColorStop(1.0, P.withAlpha(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);

  glowCache.set(key, c);
  return c;
}

const haloCache = new Map<string, HTMLCanvasElement>();

/** A wide, coreless halo — the "dim wide pass" of the layered glow technique. */
export function haloSprite(color: string, size = 128): HTMLCanvasElement {
  const s = size <= 64 ? 64 : 128;
  const key = color + '|' + s;
  const hit = haloCache.get(key);
  if (hit !== undefined) return hit;

  const c = createCanvas(s, s);
  const g = ctx2d(c);
  const r = s / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0.0, P.withAlpha(color, 0.5));
  grad.addColorStop(0.3, P.withAlpha(color, 0.26));
  grad.addColorStop(0.68, P.withAlpha(color, 0.07));
  grad.addColorStop(1.0, P.withAlpha(color, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);

  haloCache.set(key, c);
  return c;
}

const puffCache = new Map<string, HTMLCanvasElement>();

/** Soft, low-contrast puff for smoke / dissipation. Drawn non-additively. */
export function puffSprite(color: string, size = 64): HTMLCanvasElement {
  const key = color + '|' + size;
  const hit = puffCache.get(key);
  if (hit !== undefined) return hit;

  const c = createCanvas(size, size);
  const g = ctx2d(c);
  const r = size / 2;
  const grad = g.createRadialGradient(r * 0.85, r * 0.8, r * 0.05, r, r, r);
  grad.addColorStop(0.0, P.withAlpha(color, 0.55));
  grad.addColorStop(0.45, P.withAlpha(color, 0.3));
  grad.addColorStop(1.0, P.withAlpha(color, 0));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(r, r, r, 0, TAU);
  g.fill();

  puffCache.set(key, c);
  return c;
}

// ---------------------------------------------------------------- streaks

const streakCache = new Map<string, HTMLCanvasElement>();

/**
 * A tapered energy streak: bright in the middle, transparent at both ends,
 * with a soft perpendicular falloff. Baked horizontally and vertically so the
 * conduit grid never needs a canvas transform.
 */
export function streakSprite(color: string, len: number, thick: number, vertical: boolean): HTMLCanvasElement {
  const key = color + '|' + len + '|' + thick + '|' + (vertical ? 'v' : 'h');
  const hit = streakCache.get(key);
  if (hit !== undefined) return hit;

  const w = vertical ? thick : len;
  const h = vertical ? len : thick;
  const c = createCanvas(w, h);
  const g = ctx2d(c);

  // Along-axis energy ramp.
  const along = vertical ? g.createLinearGradient(0, 0, 0, h) : g.createLinearGradient(0, 0, w, 0);
  along.addColorStop(0.0, P.withAlpha(color, 0));
  along.addColorStop(0.42, P.withAlpha(color, 0.3));
  along.addColorStop(0.72, P.withAlpha(P.hot(color, 0.5), 0.85));
  along.addColorStop(0.86, P.withAlpha(P.CORE_WHITE, 1));
  along.addColorStop(0.95, P.withAlpha(P.hot(color, 0.4), 0.5));
  along.addColorStop(1.0, P.withAlpha(color, 0));
  g.fillStyle = along;
  g.fillRect(0, 0, w, h);

  // Cross-axis falloff, applied as a mask.
  g.globalCompositeOperation = 'destination-in';
  const across = vertical ? g.createLinearGradient(0, 0, w, 0) : g.createLinearGradient(0, 0, 0, h);
  across.addColorStop(0.0, P.withAlpha(P.CORE_WHITE, 0));
  across.addColorStop(0.5, P.withAlpha(P.CORE_WHITE, 1));
  across.addColorStop(1.0, P.withAlpha(P.CORE_WHITE, 0));
  g.fillStyle = across;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = 'source-over';

  streakCache.set(key, c);
  return c;
}

// ---------------------------------------------------------------- starfield

const starCache = new Map<string, HTMLCanvasElement>();
const patternCache = new WeakMap<HTMLCanvasElement, CanvasPattern>();

/**
 * A seamless starfield tile. Stars near an edge are drawn again wrapped so the
 * tiling never shows a seam.
 */
export function starLayer(seed: number, size: number, count: number, maxRadius: number, brightness: number): HTMLCanvasElement {
  const key = seed + '|' + size + '|' + count + '|' + maxRadius + '|' + brightness;
  const hit = starCache.get(key);
  if (hit !== undefined) return hit;

  const c = createCanvas(size, size);
  const g = ctx2d(c);
  const rng = makeRng(seed);
  const tints = [P.STAR_FAR, P.STAR_NEAR, P.STAR_HOT, P.STAR_WARM, P.STAR_NEAR];

  for (let i = 0; i < count; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const t = rng();
    const r = 0.35 + t * t * maxRadius;
    const tint = tints[(rng() * tints.length) | 0];
    const a = (0.18 + rng() * 0.82) * brightness;

    // Draw at up to four wrapped positions so the tile is seamless.
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const px = x + ox * size;
        const py = y + oy * size;
        if (px < -r * 4 || py < -r * 4 || px > size + r * 4 || py > size + r * 4) continue;
        if (r > 1.1) {
          const sprite = glowSprite(tint, 32);
          g.globalAlpha = a * 0.85;
          g.drawImage(sprite, px - r * 4, py - r * 4, r * 8, r * 8);
          g.globalAlpha = 1;
        }
        g.fillStyle = P.withAlpha(tint, a);
        g.beginPath();
        g.arc(px, py, r, 0, TAU);
        g.fill();
      }
    }
  }

  // A few distant "dust" smudges for depth.
  for (let i = 0; i < 6; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = size * (0.06 + rng() * 0.12);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, P.withAlpha(P.STAR_FAR, 0.05 * brightness));
    grad.addColorStop(1, P.withAlpha(P.STAR_FAR, 0));
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  starCache.set(key, c);
  return c;
}

/** Cached repeating pattern for a baked tile. */
export function tilePattern(ctx: CanvasRenderingContext2D, tile: HTMLCanvasElement): CanvasPattern {
  const hit = patternCache.get(tile);
  if (hit !== undefined) return hit;
  const pat = ctx.createPattern(tile, 'repeat');
  if (pat === null) throw new Error('VOIDLINE: unable to create canvas pattern');
  patternCache.set(tile, pat);
  return pat;
}

// ---------------------------------------------------------------- nebula

let nebulaCanvas: HTMLCanvasElement | null = null;

/** A slow-drifting gas sheet. Drawn additively at low alpha behind the arena. */
export function nebulaSheet(): HTMLCanvasElement {
  if (nebulaCanvas !== null) return nebulaCanvas;
  const size = 1024;
  const c = createCanvas(size, size);
  const g = ctx2d(c);
  const rng = makeRng(0x4e17b0);
  const tints = [P.NEBULA_COOL, P.NEBULA_VIOLET, P.NEBULA_TEAL, P.NEBULA_EMBER];

  for (let i = 0; i < 22; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = size * (0.1 + rng() * 0.34);
    const tint = tints[(rng() * tints.length) | 0];
    const a = 0.05 + rng() * 0.11;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0.0, P.withAlpha(tint, a));
    grad.addColorStop(0.45, P.withAlpha(tint, a * 0.45));
    grad.addColorStop(1.0, P.withAlpha(tint, 0));
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Carve voids so it does not read as a flat wash.
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 14; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = size * (0.05 + rng() * 0.2);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, P.withAlpha(P.CORE_WHITE, 0.55 + rng() * 0.4));
    grad.addColorStop(1, P.withAlpha(P.CORE_WHITE, 0));
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.globalCompositeOperation = 'source-over';

  nebulaCanvas = c;
  return c;
}

// ---------------------------------------------------------------- arena deck

const floorCache = new Map<string, HTMLCanvasElement>();

/**
 * The entire static arena deck, baked once at 1:1 world scale.
 * Per frame the renderer blits only the visible sub-rectangle, then adds the
 * animated conduit energy on top additively. This is the single biggest reason
 * the floor can be this detailed and still hit 60 fps.
 */
export function arenaFloor(w: number, h: number): HTMLCanvasElement {
  const key = w + 'x' + h;
  const hit = floorCache.get(key);
  if (hit !== undefined) return hit;

  const c = createCanvas(w, h);
  const g = ctx2d(c);
  const rng = makeRng(0x5eed17);
  const cx = w / 2;
  const cy = h / 2;

  // --- base plate, lit from the reactor core outward
  g.fillStyle = P.PLATE;
  g.fillRect(0, 0, w, h);
  const base = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.66);
  base.addColorStop(0.0, P.withAlpha(P.PLATE_LIGHT, 0.95));
  base.addColorStop(0.4, P.withAlpha(P.PLATE_LIGHT, 0.4));
  base.addColorStop(1.0, P.withAlpha(P.PLATE_DARK, 0.7));
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);

  // --- hex mesh (flat-top), one path, one stroke
  const R = 26;
  const stepX = R * 1.5;
  const stepY = Math.sqrt(3) * R;
  g.beginPath();
  for (let col = 0; col * stepX < w + R * 2; col++) {
    const x = col * stepX;
    const yOff = col % 2 === 0 ? 0 : stepY / 2;
    for (let row = -1; row * stepY + yOff < h + stepY; row++) {
      const y = row * stepY + yOff;
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * TAU;
        const px = x + Math.cos(a) * R;
        const py = y + Math.sin(a) * R;
        if (k === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.closePath();
    }
  }
  g.strokeStyle = P.withAlpha(P.HEX_MESH, 0.55);
  g.lineWidth = 1;
  g.stroke();

  // --- deck panel seams (big plates)
  const panel = 200;
  g.strokeStyle = P.withAlpha(P.PLATE_SEAM, 0.85);
  g.lineWidth = 3;
  g.beginPath();
  for (let x = panel; x < w; x += panel) {
    g.moveTo(x, 0);
    g.lineTo(x, h);
  }
  for (let y = panel; y < h; y += panel) {
    g.moveTo(0, y);
    g.lineTo(w, y);
  }
  g.stroke();

  // A handful of panels lifted slightly, so the deck is not uniform.
  g.fillStyle = P.withAlpha(P.PLATE_LIGHT, 0.25);
  for (let i = 0; i < 26; i++) {
    const px = Math.floor(rng() * (w / panel)) * panel;
    const py = Math.floor(rng() * (h / panel)) * panel;
    g.fillRect(px + 3, py + 3, panel - 6, panel - 6);
  }

  // --- circuit traces: snapped, right-angled runs with solder pads
  const gridSnap = 20;
  g.lineCap = 'square';
  for (let i = 0; i < 220; i++) {
    let x = Math.round((rng() * w) / gridSnap) * gridSnap;
    let y = Math.round((rng() * h) / gridSnap) * gridSnap;
    const segs = 2 + ((rng() * 4) | 0);
    g.beginPath();
    g.moveTo(x, y);
    let horizontal = rng() < 0.5;
    for (let s = 0; s < segs; s++) {
      const runLen = (1 + ((rng() * 5) | 0)) * gridSnap * (rng() < 0.5 ? -1 : 1);
      if (horizontal) x += runLen;
      else y += runLen;
      g.lineTo(x, y);
      horizontal = !horizontal;
    }
    g.strokeStyle = P.withAlpha(P.CIRCUIT_TRACE, 0.35 + rng() * 0.4);
    g.lineWidth = rng() < 0.25 ? 3 : 1.5;
    g.stroke();
    // pad at the terminus
    g.fillStyle = P.withAlpha(P.CIRCUIT_PAD, 0.45);
    g.fillRect(x - 3, y - 3, 6, 6);
  }
  g.lineCap = 'butt';

  // --- conduit trunk grid: this is what the energy pulses will run along
  const conduit = 100;
  g.beginPath();
  for (let x = conduit; x < w; x += conduit) {
    g.moveTo(x, 0);
    g.lineTo(x, h);
  }
  for (let y = conduit; y < h; y += conduit) {
    g.moveTo(0, y);
    g.lineTo(w, y);
  }
  g.strokeStyle = P.withAlpha(P.GRID_LINE, 0.8);
  g.lineWidth = 1.5;
  g.stroke();

  g.beginPath();
  for (let x = conduit * 4; x < w; x += conduit * 4) {
    g.moveTo(x, 0);
    g.lineTo(x, h);
  }
  for (let y = conduit * 4; y < h; y += conduit * 4) {
    g.moveTo(0, y);
    g.lineTo(w, y);
  }
  g.strokeStyle = P.withAlpha(P.GRID_TRUNK, 0.9);
  g.lineWidth = 3;
  g.stroke();

  // --- machine rings around the reactor core
  for (let i = 0; i < 6; i++) {
    const r = 90 + i * 105;
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.strokeStyle = P.withAlpha(P.GRID_TRUNK, 0.5 - i * 0.05);
    g.lineWidth = i % 2 === 0 ? 2.5 : 1;
    g.stroke();

    // radial tick marks
    const ticks = 24 + i * 8;
    g.beginPath();
    for (let t = 0; t < ticks; t++) {
      const a = (t / ticks) * TAU;
      const c0 = Math.cos(a);
      const s0 = Math.sin(a);
      g.moveTo(cx + c0 * (r - 6), cy + s0 * (r - 6));
      g.lineTo(cx + c0 * (r + 6), cy + s0 * (r + 6));
    }
    g.strokeStyle = P.withAlpha(P.GRID_LINE, 0.5);
    g.lineWidth = 1;
    g.stroke();
  }

  // --- core plate
  const corePlate = g.createRadialGradient(cx, cy, 0, cx, cy, 90);
  corePlate.addColorStop(0.0, P.withAlpha(P.CIRCUIT_PAD, 0.5));
  corePlate.addColorStop(0.7, P.withAlpha(P.PLATE_LIGHT, 0.4));
  corePlate.addColorStop(1.0, P.withAlpha(P.PLATE_LIGHT, 0));
  g.fillStyle = corePlate;
  g.beginPath();
  g.arc(cx, cy, 90, 0, TAU);
  g.fill();

  // --- floor stencils
  g.save();
  g.font = '900 84px "Eurostile", "Bahnschrift", "DIN Alternate", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = P.withAlpha(P.STENCIL, 0.1);
  g.fillText('VOIDLINE', cx, cy - h * 0.3);
  g.font = '700 34px "Eurostile", "Bahnschrift", "DIN Alternate", system-ui, sans-serif';
  g.fillStyle = P.withAlpha(P.STENCIL, 0.12);
  g.fillText('REACTOR DECK  ///  SECTOR 07', cx, cy + h * 0.31);
  g.fillText('CAUTION — CONDUIT LATTICE LIVE', cx, cy + h * 0.36);
  g.restore();

  // --- hazard chevrons in the corners
  g.save();
  g.globalAlpha = 0.16;
  const chev = 26;
  for (const [ox, oy, sx, sy] of [
    [0, 0, 1, 1],
    [w, 0, -1, 1],
    [0, h, 1, -1],
    [w, h, -1, -1],
  ] as const) {
    for (let i = 0; i < 7; i++) {
      g.fillStyle = i % 2 === 0 ? P.DANGER_AMBER : P.PLATE_DARK;
      g.beginPath();
      g.moveTo(ox + sx * (i * chev), oy);
      g.lineTo(ox + sx * ((i + 1) * chev), oy);
      g.lineTo(ox, oy + sy * ((i + 1) * chev));
      g.lineTo(ox, oy + sy * (i * chev));
      g.closePath();
      g.fill();
    }
  }
  g.restore();

  // --- containment wall inset
  g.strokeStyle = P.withAlpha(P.WALL_EDGE, 0.5);
  g.lineWidth = 4;
  g.strokeRect(2, 2, w - 4, h - 4);
  g.strokeStyle = P.withAlpha(P.WALL_BODY, 0.9);
  g.lineWidth = 14;
  g.strokeRect(11, 11, w - 22, h - 22);

  floorCache.set(key, c);
  return c;
}

// ---------------------------------------------------------------- screen dressing

let scanlineTile: HTMLCanvasElement | null = null;

/** 1x4 scanline tile — one fillRect per frame covers the whole screen. */
export function scanlines(): HTMLCanvasElement {
  if (scanlineTile !== null) return scanlineTile;
  const c = createCanvas(4, 4);
  const g = ctx2d(c);
  g.fillStyle = P.withAlpha(P.SCANLINE, 0.55);
  g.fillRect(0, 0, 4, 1);
  g.fillStyle = P.withAlpha(P.SCANLINE, 0.22);
  g.fillRect(0, 1, 4, 1);
  scanlineTile = c;
  return c;
}

let grainTile: HTMLCanvasElement | null = null;

/** Static grain tile, offset randomly each frame to read as sensor noise. */
export function grain(): HTMLCanvasElement {
  if (grainTile !== null) return grainTile;
  const size = 128;
  const c = createCanvas(size, size);
  const g = ctx2d(c);
  const img = g.createImageData(size, size);
  const rng = makeRng(0x9e3779b9);
  const tint = P.hexToRgb(P.GRAIN);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = rng();
    data[i] = tint[0];
    data[i + 1] = tint[1];
    data[i + 2] = tint[2];
    data[i + 3] = (n * n * 90) | 0;
  }
  g.putImageData(img, 0, 0);
  grainTile = c;
  return c;
}

const vignetteCache = new Map<string, CanvasGradient>();

/** Screen vignette gradient, cached per viewport size. */
export function vignette(ctx: CanvasRenderingContext2D, w: number, h: number): CanvasGradient {
  const key = w + 'x' + h;
  const hit = vignetteCache.get(key);
  if (hit !== undefined) return hit;
  const cx = w / 2;
  const cy = h / 2;
  const inner = Math.min(w, h) * 0.34;
  const outer = Math.hypot(w, h) * 0.62;
  const grad = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
  grad.addColorStop(0.0, P.withAlpha(P.VIGNETTE, 0));
  grad.addColorStop(0.55, P.withAlpha(P.VIGNETTE, 0.34));
  grad.addColorStop(1.0, P.withAlpha(P.VIGNETTE, 0.88));
  vignetteCache.set(key, grad);
  return grad;
}

const edgeCache = new Map<string, CanvasGradient>();

/** Coloured screen-edge pulse (weave connect / disconnect / slot charged). */
export function edgeGlow(ctx: CanvasRenderingContext2D, w: number, h: number, color: string): CanvasGradient {
  const key = w + 'x' + h + '|' + color;
  const hit = edgeCache.get(key);
  if (hit !== undefined) return hit;
  const cx = w / 2;
  const cy = h / 2;
  const grad = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.42, cx, cy, Math.hypot(w, h) * 0.54);
  grad.addColorStop(0.0, P.withAlpha(color, 0));
  grad.addColorStop(0.62, P.withAlpha(color, 0.02));
  grad.addColorStop(0.86, P.withAlpha(color, 0.16));
  grad.addColorStop(1.0, P.withAlpha(color, 0.55));
  edgeCache.set(key, grad);
  return grad;
}

/** Drop every baked texture. Only used when tearing down the demo harness. */
export function clearBakedTextures(): void {
  glowCache.clear();
  haloCache.clear();
  puffCache.clear();
  streakCache.clear();
  starCache.clear();
  floorCache.clear();
  vignetteCache.clear();
  edgeCache.clear();
  nebulaCanvas = null;
  scanlineTile = null;
  grainTile = null;
}
