/**
 * BLOOM — the visual language, as data.
 *
 * The whole game is taught by two axes and nothing else:
 *
 *   SHAPE  tells you what a cell IS      (soil square, rock chunk, sun star, home ring)
 *   COLOUR tells you whose it is and whether it is ALIVE
 *
 * "Alive" is saturated and lit. "Cut" is grey and draining. There is no third
 * state and no legend, because a child will not read one.
 */

export const INK = {
  /** Deep loam behind everything. */
  bg: '#0d1310',
  soil: '#1e2a22',
  soilEdge: '#28362c',
  rock: '#5a5f62',
  rockTop: '#868d91',
  sun: '#ffd23d',
  sunGlow: '#ffe98a',
  /* The three larders. Each one is one faction's whole economy, so they have to be
     told apart at a glance on a phone: warm timber, sickly green acid, pale grubs. */
  wood: '#b5793a',
  woodGlow: '#e0a367',
  acid: '#9ee83d',
  acidGlow: '#caff8a',
  bug: '#d8d2b0',
  bugGlow: '#f2eccc',
  /**
   * Nutrient stores. Deliberately the same amber as the energy readout on the HUD,
   * because they are the same substance: what the number counts is what the tanks
   * hold, and a player has to make that connection without being told.
   */
  store: '#ffc23d',
  /** The colour of death. Everything severed converges here. */
  ash: '#6d6f6d',
  ashDark: '#3a3d3b',
  white: '#ffffff',
};

/** Parse "#rrggbb" to [r,g,b]. */
export function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Linear blend between two hex colours. `t` 0 = a, 1 = b. */
export function mix(a: string, b: string, t: number): string {
  const A = rgb(a);
  const B = rgb(b);
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(A[0] + (B[0] - A[0]) * k)},${Math.round(
    A[1] + (B[1] - A[1]) * k,
  )},${Math.round(A[2] + (B[2] - A[2]) * k)})`;
}

/** Blend toward ash. `t` 1 = fully dead grey. Used for every severed cell. */
export function drained(hex: string, t: number): string {
  return mix(hex, INK.ash, t);
}

export function lighten(hex: string, t: number): string {
  return mix(hex, INK.white, t);
}

export function darken(hex: string, t: number): string {
  return mix(hex, '#000000', t);
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Smooth 0..1 ease used for every fill and every pulse. */
export function ease(t: number): number {
  const k = clamp01(t);
  return k * k * (3 - 2 * k);
}
