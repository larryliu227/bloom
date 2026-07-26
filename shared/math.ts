/**
 * VOIDLINE — pure math helpers.
 *
 * Everything in here is deterministic and allocation-light. No `Math.random()`,
 * no `Date.now()`. Vector ops never mutate their arguments; they return a fresh
 * `Vec2` so simulation state can never be aliased by accident.
 */

import type { Vec2 } from './types.js';

export const TAU = Math.PI * 2;
export const EPSILON = 1e-6;

// ============================================================ rng

/**
 * mulberry32 — small, fast, well-distributed 32-bit PRNG.
 * Same seed always yields the same stream, on every machine and runtime.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform float in [lo, hi). */
export function rngRange(rng: () => number, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

/** Uniform integer in [lo, hi]. */
export function rngInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ============================================================ scalars

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp; returns 0 when the range is degenerate. */
export function invLerp(a: number, b: number, x: number): number {
  const d = b - a;
  return Math.abs(d) < EPSILON ? 0 : (x - a) / d;
}

/** Move `current` toward `target` by at most `maxDelta`. Never overshoots. */
export function approach(current: number, target: number, maxDelta: number): number {
  if (maxDelta <= 0) return current;
  const d = target - current;
  if (d > maxDelta) return current + maxDelta;
  if (d < -maxDelta) return current - maxDelta;
  return target;
}

/** Signed shortest rotation from angle `a` to angle `b`, in (-PI, PI]. */
export function shortestAngle(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Normalize an angle into [-PI, PI). */
export function normalizeAngle(a: number): number {
  let x = (a + Math.PI) % TAU;
  if (x < 0) x += TAU;
  return x - Math.PI;
}

/** Rotate `from` toward `to` by at most `maxDelta` radians, the short way round. */
export function approachAngle(from: number, to: number, maxDelta: number): number {
  const d = shortestAngle(from, to);
  if (Math.abs(d) <= maxDelta) return normalizeAngle(to);
  return normalizeAngle(from + Math.sign(d) * maxDelta);
}

/** Smooth 0..1 ramp. Handy for VFX curves and telegraphs. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential smoothing factor.
 * `lerp(a, b, damp(rate, dt))` converges at the same wall-clock speed for any dt.
 */
export function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

// ============================================================ vectors

export const v = {
  zero(): Vec2 {
    return { x: 0, y: 0 };
  },
  of(x: number, y: number): Vec2 {
    return { x, y };
  },
  clone(a: Vec2): Vec2 {
    return { x: a.x, y: a.y };
  },
  add(a: Vec2, b: Vec2): Vec2 {
    return { x: a.x + b.x, y: a.y + b.y };
  },
  sub(a: Vec2, b: Vec2): Vec2 {
    return { x: a.x - b.x, y: a.y - b.y };
  },
  scale(a: Vec2, s: number): Vec2 {
    return { x: a.x * s, y: a.y * s };
  },
  /** a + b * s — the common "integrate" step, without a temporary. */
  addScaled(a: Vec2, b: Vec2, s: number): Vec2 {
    return { x: a.x + b.x * s, y: a.y + b.y * s };
  },
  neg(a: Vec2): Vec2 {
    return { x: -a.x, y: -a.y };
  },
  len(a: Vec2): number {
    return Math.sqrt(a.x * a.x + a.y * a.y);
  },
  len2(a: Vec2): number {
    return a.x * a.x + a.y * a.y;
  },
  norm(a: Vec2): Vec2 {
    const l = Math.sqrt(a.x * a.x + a.y * a.y);
    return l < EPSILON ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
  },
  /** Clamp magnitude to `max`, keeping direction. */
  clampLen(a: Vec2, max: number): Vec2 {
    const l = Math.sqrt(a.x * a.x + a.y * a.y);
    if (l <= max || l < EPSILON) return { x: a.x, y: a.y };
    const s = max / l;
    return { x: a.x * s, y: a.y * s };
  },
  dist(a: Vec2, b: Vec2): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  },
  dist2(a: Vec2, b: Vec2): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return dx * dx + dy * dy;
  },
  dot(a: Vec2, b: Vec2): number {
    return a.x * b.x + a.y * b.y;
  },
  /** 2D cross product (z of the 3D cross). Sign tells you which side b is on. */
  cross(a: Vec2, b: Vec2): number {
    return a.x * b.y - a.y * b.x;
  },
  lerp(a: Vec2, b: Vec2, t: number): Vec2 {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  },
  /** Rotate counter-clockwise by `rad`. */
  rot(a: Vec2, rad: number): Vec2 {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
  },
  /** Perpendicular (90 degrees CCW). */
  perp(a: Vec2): Vec2 {
    return { x: -a.y, y: a.x };
  },
  angle(a: Vec2): number {
    return Math.atan2(a.y, a.x);
  },
  fromAngle(rad: number, mag = 1): Vec2 {
    return { x: Math.cos(rad) * mag, y: Math.sin(rad) * mag };
  },
  /** Direction from `a` to `b`, unit length (zero vector if coincident). */
  dir(a: Vec2, b: Vec2): Vec2 {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.sqrt(dx * dx + dy * dy);
    return l < EPSILON ? { x: 0, y: 0 } : { x: dx / l, y: dy / l };
  },
  eq(a: Vec2, b: Vec2, tol = EPSILON): boolean {
    return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
  },
};

// ============================================================ collision

/** Circle vs circle overlap test. */
export function circleHit(a: Vec2, ar: number, b: Vec2, br: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const r = ar + br;
  return dx * dx + dy * dy <= r * r;
}

/** Parametric position (0..1) of the closest point on segment p0->p1 to `c`. */
export function closestT(p0: Vec2, p1: Vec2, c: Vec2): number {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < EPSILON) return 0;
  return clamp01(((c.x - p0.x) * dx + (c.y - p0.y) * dy) / l2);
}

/** Closest point on segment p0->p1 to `c`. */
export function closestPointOnSegment(p0: Vec2, p1: Vec2, c: Vec2): Vec2 {
  const t = closestT(p0, p1, c);
  return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
}

/** Shortest distance from point `c` to segment p0->p1. */
export function pointSegmentDist(p0: Vec2, p1: Vec2, c: Vec2): number {
  const q = closestPointOnSegment(p0, p1, c);
  const dx = c.x - q.x;
  const dy = c.y - q.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Segment vs circle overlap — used for beams, dash sweeps and swept projectiles. */
export function segmentCircle(p0: Vec2, p1: Vec2, c: Vec2, r: number): boolean {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const l2 = dx * dx + dy * dy;
  let t = 0;
  if (l2 >= EPSILON) {
    t = ((c.x - p0.x) * dx + (c.y - p0.y) * dy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const qx = p0.x + dx * t - c.x;
  const qy = p0.y + dy * t - c.y;
  return qx * qx + qy * qy <= r * r;
}

/** True if `p` sits inside the axis-aligned rect [0,0]..[w,h] inset by `margin`. */
export function insideRect(p: Vec2, w: number, h: number, margin = 0): boolean {
  return p.x >= margin && p.y >= margin && p.x <= w - margin && p.y <= h - margin;
}

/** Is `target` within `halfAngle` radians of `facing`, as seen from `origin`? */
export function inCone(origin: Vec2, facing: number, halfAngle: number, target: Vec2): boolean {
  const a = Math.atan2(target.y - origin.y, target.x - origin.x);
  return Math.abs(shortestAngle(facing, a)) <= halfAngle;
}
