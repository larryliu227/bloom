/**
 * BLOONS WORLD — the shared rules of the place.
 *
 * Everything in here is imported by BOTH the server and the client, because the
 * client predicts its own movement locally and the server integrates the same
 * numbers authoritatively. If the two ever disagree about how fast a person walks,
 * every player rubber-bands. One file, one answer.
 */

/** Pixels per world tile. The art is drawn at this scale and never smoothed. */
export const TILE = 16;

/** World size in tiles. Small enough to run into each other, big enough to wander. */
export const WORLD_W = 64;
export const WORLD_H = 64;

export const WORLD_PX_W = WORLD_W * TILE;
export const WORLD_PX_H = WORLD_H * TILE;

/** Walking speed, pixels per second. */
export const WALK_SPEED = 78;

/**
 * Jumping. Up at JUMP_SPEED, pulled back down at GRAVITY.
 *
 * Tuned together rather than separately: peak height is v^2/2g and airtime is 2v/g,
 * so these two numbers mean "about 23 pixels up, in about six-tenths of a second" —
 * roughly twice a person's own height, and slow enough to see at the top.
 *
 * You keep full control of your feet in the air. A jump you cannot steer reads as a
 * stumble rather than a hop.
 */
export const JUMP_SPEED = 150;
export const GRAVITY = 480;

/** How wide a person is, for keeping them inside the world. */
export const BODY_W = 10;
export const BODY_H = 12;

/** Authoritative ticks per second, and how often the client posts its input. */
export const TICK_RATE = 20;
export const TICK_MS = 1000 / TICK_RATE;
export const INPUT_RATE = 20;

/**
 * How far behind the newest snapshot remote players are drawn.
 *
 * Rendering other people at the very latest position means stuttering every time a
 * packet is late. Holding them one tick in the past means there is always a pair of
 * snapshots to interpolate between, and the cost is 50ms of lag on somebody else's
 * position — which nobody can perceive and everybody prefers to jitter.
 */
export const INTERP_DELAY_MS = 100;

export type Dir = 'down' | 'up' | 'left' | 'right';

export interface Player {
  id: string;
  name: string;
  /** Pixel position of the player's feet, in world space. */
  x: number;
  y: number;
  dir: Dir;
  /** True while they are actually moving, which is what drives the walk cycle. */
  moving: boolean;
  /**
   * Height above the ground in pixels. The FEET stay at (x, y) whatever this is —
   * a jump lifts the drawing, not the position, so the shadow and everyone's sense
   * of where you are standing stay honest.
   */
  z: number;
  /** Vertical speed, pixels per second. Positive is upward. */
  vz: number;
  /** Chosen at join and never changed, so everyone renders you the same colour. */
  hue: number;
}

/** Clamp a position to the walkable world. */
export function clampToWorld(x: number, y: number): { x: number; y: number } {
  const halfW = BODY_W / 2;
  return {
    x: Math.min(WORLD_PX_W - halfW, Math.max(halfW, x)),
    y: Math.min(WORLD_PX_H - 1, Math.max(BODY_H, y)),
  };
}

/**
 * Move one step. The ONE place walking is defined, called by the server to advance
 * the world and by the client to predict its own next position.
 *
 * Diagonals are normalised — without it, holding two keys is 1.41x faster than one,
 * which players find immediately and then never walk in a straight line again.
 */
export function step(
  p: { x: number; y: number; dir: Dir; moving: boolean; z: number; vz: number },
  inx: number,
  iny: number,
  dt: number,
  jump = false,
): void {
  /*
   * Jump first, and only from the ground — holding the key must not let you climb.
   * `z <= 0` is the whole grounded test; there is nothing to stand on but the floor.
   */
  if (jump && p.z <= 0) p.vz = JUMP_SPEED;
  if (p.z > 0 || p.vz !== 0) {
    p.vz -= GRAVITY * dt;
    p.z += p.vz * dt;
    if (p.z <= 0) {
      p.z = 0;
      p.vz = 0;
    }
  }

  const len = Math.hypot(inx, iny);
  if (len < 0.01) {
    p.moving = false;
    return;
  }
  const nx = inx / len;
  const ny = iny / len;
  const next = clampToWorld(p.x + nx * WALK_SPEED * dt, p.y + ny * WALK_SPEED * dt);
  p.x = next.x;
  p.y = next.y;
  p.moving = true;
  // Face whichever axis you are pushing hardest, so a diagonal still has one face.
  if (Math.abs(nx) > Math.abs(ny)) p.dir = nx > 0 ? 'right' : 'left';
  else p.dir = ny > 0 ? 'down' : 'up';
}
