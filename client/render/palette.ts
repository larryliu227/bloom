/**
 * VOIDLINE — palette.
 *
 * Every colour the renderer uses is named here so the whole game reads as one
 * designed system. Nothing else in `client/render/*` may contain a raw hex
 * literal; if you need a new colour, name it in this file.
 *
 * Design language: a fracturing deep-space station seen from directly above.
 * - Surfaces are near-black blues, lit only by what is powered.
 * - Player / friendly energy is CYAN -> VIOLET.
 * - Hostile energy and every telegraph is ORANGE -> RED. If it is warm, it hurts.
 * - Everything that emits light is drawn additively; nothing "emissive" is ever
 *   drawn with a plain fill.
 */

import type { RoleId, Team } from '@shared/types.js';
import { getRole } from '@shared/roles.js';

// ---------------------------------------------------------------- deep space
export const BG_VOID = '#06080f'; // the canvas clear colour — locked
export const BG_ABYSS = '#03050a';
export const STAR_FAR = '#5c6f96';
export const STAR_NEAR = '#cfe4ff';
export const STAR_HOT = '#9fe8ff';
export const STAR_WARM = '#ffd7b0';
export const NEBULA_COOL = '#16307a';
export const NEBULA_VIOLET = '#4a1d78';
export const NEBULA_TEAL = '#0b3f5c';
export const NEBULA_EMBER = '#5c1f2c';

// ---------------------------------------------------------------- station deck
export const PLATE = '#0a0e19';
export const PLATE_DARK = '#05070d';
export const PLATE_LIGHT = '#121b2e';
export const PLATE_SEAM = '#050810';
export const HEX_MESH = '#131f36';
export const CIRCUIT_TRACE = '#16294a';
export const CIRCUIT_PAD = '#1d3a66';
export const GRID_LINE = '#152340';
export const GRID_TRUNK = '#1d3358';
export const STENCIL = '#22385e';
export const WALL_BODY = '#0d1526';
export const WALL_EDGE = '#2d4f86';

// ---------------------------------------------------------------- energy (friendly)
export const ENERGY_CYAN = '#3ff5ff';
export const ENERGY_CYAN_DEEP = '#0f6d86';
export const ENERGY_VIOLET = '#a06bff';
export const ENERGY_VIOLET_DEEP = '#432a7d';
export const ENERGY_MINT = '#3cffa8';
export const ENERGY_AZURE = '#4da3ff';
export const ENERGY_WHITE = '#eafcff';
export const CORE_WHITE = '#ffffff';

// ---------------------------------------------------------------- danger (hostile)
export const DANGER_ORANGE = '#ff8a3c';
export const DANGER_RED = '#ff3c5a';
export const DANGER_DEEP = '#7d1526';
export const DANGER_AMBER = '#ffb14d';
export const WARN_YELLOW = '#ffd166';
export const HAZARD_MAGENTA = '#ff5ad2';

// ---------------------------------------------------------------- roles (fallbacks)
/** Used only if `getRole` cannot answer (unknown id, module not loaded yet). */
export const ROLE_FALLBACK = ENERGY_CYAN;

// ---------------------------------------------------------------- teams
export const TEAM_A = '#3ff5ff';
export const TEAM_B = '#a06bff';
export const TEAM_PLAYERS = '#3ff5ff';
export const TEAM_HOSTILE = '#ff8a3c';
export const TEAM_NEUTRAL = '#9fb0c8';

// ---------------------------------------------------------------- entities
export const SHADOW = '#000000';
export const CHASSIS = '#070b14';
export const CHASSIS_LIGHT = '#101a2c';
export const ENEMY_CHASSIS = '#150a0c';

export const ARCHETYPE_CHASER = '#ff8a3c';
export const ARCHETYPE_SPITTER = '#ff5a3c';
export const ARCHETYPE_BULWARK = '#ffb14d';
export const ARCHETYPE_SPLITTER = '#ff6ea0';
export const ARCHETYPE_SAPPER = '#a06bff';
export const ARCHETYPE_TURRET = '#ff3c5a';
export const ARCHETYPE_ELITE = '#ffd166';
export const ARCHETYPE_BOSS = '#ff2f4d';
export const ARCHETYPE_DEFAULT = '#ff8a3c';

// ---------------------------------------------------------------- readouts
export const TEXT_BRIGHT = '#eaf4ff';
export const TEXT_PRIMARY = '#c8daf5';
export const TEXT_DIM = '#7f90ad';
export const TEXT_SHADOW = '#01030a';

export const HP_HIGH = '#3cffa8';
export const HP_MID = '#ffd166';
export const HP_LOW = '#ff3c5a';
export const HP_TRACK = '#0b1120';
export const HP_FRAME = '#22334f';
export const SHIELD_BAR = '#7fd4ff';

export const DMG_NORMAL = '#ffd9a0';
export const DMG_CRIT = '#fff6cf';
export const DMG_INCOMING = '#ff6b7f';
export const DMG_HEAL = '#7dffc0';

// ---------------------------------------------------------------- statuses
export const STATUS_BURN = '#ff8a3c';
export const STATUS_CHILL = '#8fdcff';
export const STATUS_STUN = '#ffd166';
export const STATUS_SHIELD = '#7fd4ff';
export const STATUS_HASTE = '#3cffa8';
export const STATUS_OVERCLOCK = '#a06bff';
export const STATUS_ROOT = '#b98a4f';
export const STATUS_MARK = '#ff3c5a';

// ---------------------------------------------------------------- screen dressing
export const VIGNETTE = '#000308';
export const SCANLINE = '#000000';
export const GRAIN = '#8fa6c8';
export const FLASH_WHITE = '#ffffff';
export const ABERRATION_WARM = '#ff2a2a';
export const ABERRATION_COOL = '#28c8ff';

// ================================================================ helpers

const TAU = Math.PI * 2;

const rgbCache = new Map<string, [number, number, number]>();

/**
 * Parse `#rgb` / `#rrggbb` (and, defensively, `rgb(r,g,b)`) into a cached
 * [r,g,b] triple. The `rgb()` branch matters: anything that survives a round
 * trip through a colour helper must still be usable as an input to the next
 * one, and an unparsed string silently degrading to white is invisible in code
 * review and glaring on screen.
 */
export function hexToRgb(hex: string): [number, number, number] {
  let out = rgbCache.get(hex);
  if (out !== undefined) return out;
  let r = 255;
  let g = 255;
  let b = 255;
  if (hex.charCodeAt(0) === 35 /* # */) {
    if (hex.length === 4) {
      r = parseInt(hex[1] + hex[1], 16);
      g = parseInt(hex[2] + hex[2], 16);
      b = parseInt(hex[3] + hex[3], 16);
    } else if (hex.length >= 7) {
      r = parseInt(hex.slice(1, 3), 16);
      g = parseInt(hex.slice(3, 5), 16);
      b = parseInt(hex.slice(5, 7), 16);
    }
  } else if (hex.charCodeAt(0) === 114 /* r */ && hex.startsWith('rgb')) {
    const open = hex.indexOf('(');
    const parts = hex.slice(open + 1, hex.indexOf(')')).split(',');
    if (parts.length >= 3) {
      r = parseInt(parts[0], 10);
      g = parseInt(parts[1], 10);
      b = parseInt(parts[2], 10);
    }
  }
  if (!(r >= 0)) r = 255;
  if (!(g >= 0)) g = 255;
  if (!(b >= 0)) b = 255;
  out = [r | 0, g | 0, b | 0];
  rgbCache.set(hex, out);
  return out;
}

const ALPHA_STEPS = 65; // quantised to 1/64 so the cache stays tiny and hot
const alphaTable = new Map<string, (string | undefined)[]>();

/**
 * `rgba()` string for a palette colour at `alpha`.
 * Allocation-free after warm-up: alpha is quantised to 1/64 and memoised, so
 * this is safe to call inside per-particle draw loops.
 */
export function withAlpha(hex: string, alpha: number): string {
  const a = alpha <= 0 ? 0 : alpha >= 1 ? 1 : alpha;
  const q = (a * 64 + 0.5) | 0;
  let row = alphaTable.get(hex);
  if (row === undefined) {
    row = new Array<string | undefined>(ALPHA_STEPS);
    alphaTable.set(hex, row);
  }
  const cached = row[q];
  if (cached !== undefined) return cached;
  const rgb = hexToRgb(hex);
  const built = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(q / 64).toFixed(4)})`;
  row[q] = built;
  return built;
}

const mixTable = new Map<string, (string | undefined)[]>();

/** Linear blend of two palette colours. Memoised at 1/32 resolution. */
export function mix(a: string, b: string, t: number): string {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const q = (k * 32 + 0.5) | 0;
  const key = a + '|' + b;
  let row = mixTable.get(key);
  if (row === undefined) {
    row = new Array<string | undefined>(33);
    mixTable.set(key, row);
  }
  const cached = row[q];
  if (cached !== undefined) return cached;
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const f = q / 32;
  const r = (ca[0] + (cb[0] - ca[0]) * f) | 0;
  const g = (ca[1] + (cb[1] - ca[1]) * f) | 0;
  const bl = (ca[2] + (cb[2] - ca[2]) * f) | 0;
  const built = `rgb(${r},${g},${bl})`;
  row[q] = built;
  return built;
}

/** Push a colour toward white — used for "hot core" passes. */
export function hot(hex: string, amount = 0.5): string {
  return mix(hex, CORE_WHITE, amount);
}

/** Push a colour toward the void — used for chassis fills derived from a tint. */
export function cool(hex: string, amount = 0.5): string {
  return mix(hex, PLATE_DARK, amount);
}

const roleColorCache = new Map<string, string>();

/**
 * Accent colour for a role. Delegates to `shared/roles.ts` (single source of
 * truth) and memoises, falling back to cyan if the id is unknown.
 */
export function roleColor(role: RoleId | null | undefined): string {
  if (!role) return ROLE_FALLBACK;
  const hit = roleColorCache.get(role);
  if (hit !== undefined) return hit;
  let c = ROLE_FALLBACK;
  try {
    const def = getRole(role);
    if (def && typeof def.color === 'string' && def.color.length > 0) c = def.color;
  } catch {
    c = ROLE_FALLBACK;
  }
  roleColorCache.set(role, c);
  return c;
}

/** Colour for anything owned by a team: projectiles, zones, trails. */
export function teamColor(team: Team): string {
  switch (team) {
    case 'a':
      return TEAM_A;
    case 'b':
      return TEAM_B;
    case 'players':
      return TEAM_PLAYERS;
    case 'hostile':
      return TEAM_HOSTILE;
    default:
      return TEAM_NEUTRAL;
  }
}

/** True if this team should be rendered with the danger ramp. */
export function isHostileTeam(team: Team): boolean {
  return team === 'hostile';
}

const archetypeColors: Record<string, string> = {
  chaser: ARCHETYPE_CHASER,
  spitter: ARCHETYPE_SPITTER,
  bulwark: ARCHETYPE_BULWARK,
  splitter: ARCHETYPE_SPLITTER,
  sapper: ARCHETYPE_SAPPER,
  turret: ARCHETYPE_TURRET,
  elite: ARCHETYPE_ELITE,
  boss: ARCHETYPE_BOSS,
};

/** Readable tint per enemy archetype. Unknown archetypes get the danger default. */
export function archetypeColor(archetype: string): string {
  const c = archetypeColors[archetype];
  return c !== undefined ? c : ARCHETYPE_DEFAULT;
}

/** Health bar colour ramp: mint -> amber -> red. */
export function hpColor(frac: number): string {
  const f = frac <= 0 ? 0 : frac >= 1 ? 1 : frac;
  if (f > 0.55) return mix(HP_MID, HP_HIGH, (f - 0.55) / 0.45);
  return mix(HP_LOW, HP_MID, f / 0.55);
}

const statusColors: Record<string, string> = {
  burn: STATUS_BURN,
  chill: STATUS_CHILL,
  stun: STATUS_STUN,
  shield: STATUS_SHIELD,
  haste: STATUS_HASTE,
  overclock: STATUS_OVERCLOCK,
  root: STATUS_ROOT,
  mark: STATUS_MARK,
};

export function statusColor(kind: string): string {
  const c = statusColors[kind];
  return c !== undefined ? c : ENERGY_WHITE;
}

export { TAU };
