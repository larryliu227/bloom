/**
 * BLOONS WORLD — the renderer.
 *
 * Everything is drawn procedurally out of rectangles at 1x and then scaled up with
 * smoothing off, which is what actually makes something look like pixel art: there
 * are no assets to load and no half-pixels anywhere. The camera rounds to whole
 * world pixels for the same reason — a fractional camera makes every straight edge
 * shimmer as you walk.
 */

import { BODY_H, BODY_W, TILE, WORLD_H, WORLD_PX_H, WORLD_PX_W, WORLD_W } from '../shared/world.js';
import type { Dir, Player } from '../shared/world.js';

/** How many world pixels tall the viewport is. Everything scales off this. */
const VIEW_H = 176;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Viewport size in WORLD pixels — the canvas backing store is exactly this. */
  private vw = 240;
  private vh = VIEW_H;
  private scale = 3;
  /** The ground, drawn once into an offscreen canvas and then blitted. */
  private ground: HTMLCanvasElement;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'view';
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('canvas 2d unavailable');
    this.ctx = ctx;
    this.ground = buildGround();
    this.resize();
  }

  resize(): void {
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    /*
     * Pick the biggest WHOLE-number scale that fits. A fractional scale is what
     * turns crisp pixel art into mush, so it is better to letterbox a few pixels
     * than to draw at 2.7x.
     */
    this.scale = Math.max(2, Math.floor(cssH / VIEW_H));
    this.vh = VIEW_H;
    this.vw = Math.ceil(cssW / this.scale);
    this.canvas.width = this.vw;
    this.canvas.height = this.vh;
    this.canvas.style.width = `${this.vw * this.scale}px`;
    this.canvas.style.height = `${this.vh * this.scale}px`;
    this.ctx.imageSmoothingEnabled = false;
  }

  draw(players: Player[], meId: string, time: number): void {
    const me = players.find((p) => p.id === meId);
    const ctx = this.ctx;

    // Camera: centred on you, clamped to the world, rounded to whole pixels.
    const camX = Math.round(clamp((me?.x ?? WORLD_PX_W / 2) - this.vw / 2, 0, Math.max(0, WORLD_PX_W - this.vw)));
    const camY = Math.round(clamp((me?.y ?? WORLD_PX_H / 2) - this.vh / 2, 0, Math.max(0, WORLD_PX_H - this.vh)));

    ctx.fillStyle = '#101820';
    ctx.fillRect(0, 0, this.vw, this.vh);
    ctx.drawImage(this.ground, -camX, -camY);

    // Painter's algorithm: whoever is further down the screen is in front.
    for (const p of [...players].sort((a, b) => a.y - b.y)) {
      this.drawPerson(p, p.x - camX, p.y - camY, time, p.id === meId);
    }
  }

  /**
   * One person: a 10x12 body with a two-frame walk. The whole sprite is rectangles,
   * so the "art" is a dozen fillRect calls and there is nothing to load.
   */
  private drawPerson(p: Player, sx: number, sy: number, time: number, isMe: boolean): void {
    const ctx = this.ctx;
    const x = Math.round(sx - BODY_W / 2);
    const y = Math.round(sy - BODY_H);
    if (x < -32 || y < -32 || x > this.vw + 32 || y > this.vh + 32) return;

    const body = `hsl(${p.hue} 62% 56%)`;
    const dark = `hsl(${p.hue} 55% 38%)`;
    const skin = '#f0c9a0';

    // Shadow first, so it sits under everybody.
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(x + 1, y + BODY_H - 1, BODY_W - 2, 2);

    // The walk cycle: legs swap on a 5 Hz square wave while moving, feet together
    // when stopped. Two frames is all a 12-pixel person needs.
    const frame = p.moving ? (Math.floor(time * 5) % 2 === 0 ? 1 : -1) : 0;
    ctx.fillStyle = dark;
    ctx.fillRect(x + 2, y + 9 + (frame > 0 ? 1 : 0), 2, 3);
    ctx.fillRect(x + BODY_W - 4, y + 9 + (frame < 0 ? 1 : 0), 2, 3);

    ctx.fillStyle = body;
    ctx.fillRect(x + 1, y + 4, BODY_W - 2, 6);
    ctx.fillStyle = skin;
    ctx.fillRect(x + 2, y, BODY_W - 4, 5);
    // Hair, so `up` reads as a back of a head rather than a blank face.
    ctx.fillStyle = dark;
    ctx.fillRect(x + 2, y, BODY_W - 4, 2);

    this.drawFace(x, y, p.dir);

    if (isMe) {
      // A ring under your own feet — with everybody the same size and shape, this is
      // the only thing that answers "which one am I" in a crowd.
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 1.5, y + BODY_H - 2.5, BODY_W + 2, 4);
    }

    const label = isMe ? 'you' : p.name;
    ctx.font = '5px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(label, x + BODY_W / 2, y - 2);
    ctx.fillStyle = isMe ? '#ffffff' : 'rgba(226,240,255,0.85)';
    ctx.fillText(label, x + BODY_W / 2, y - 3);
    ctx.textAlign = 'left';
  }

  private drawFace(x: number, y: number, dir: Dir): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#1b2430';
    if (dir === 'up') return; // back of the head — no eyes
    if (dir === 'down') {
      ctx.fillRect(x + 3, y + 3, 1, 1);
      ctx.fillRect(x + BODY_W - 4, y + 3, 1, 1);
      return;
    }
    // Facing sideways: one eye, pushed to the side you are looking.
    ctx.fillRect(dir === 'right' ? x + BODY_W - 4 : x + 3, y + 3, 1, 1);
  }
}

/**
 * The ground, baked once.
 *
 * Redrawing four thousand tiles every frame is pointless when none of them ever
 * change — bake it into an offscreen canvas at world size and blit the visible part.
 */
function buildGround(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = WORLD_PX_W;
  c.height = WORLD_PX_H;
  const g = c.getContext('2d')!;
  for (let ty = 0; ty < WORLD_H; ty++) {
    for (let tx = 0; tx < WORLD_W; tx++) {
      // Cheap deterministic hash so the grass has variety but never flickers.
      const h = ((tx * 73856093) ^ (ty * 19349663)) >>> 0;
      const shade = 26 + (h % 5) * 3;
      g.fillStyle = `hsl(${104 + (h % 7)} 26% ${shade}%)`;
      g.fillRect(tx * TILE, ty * TILE, TILE, TILE);
      // A few blades, so walking across it reads as movement.
      if (h % 11 === 0) {
        g.fillStyle = `hsl(96 30% ${shade + 8}%)`;
        g.fillRect(tx * TILE + (h % 12), ty * TILE + ((h >> 4) % 12), 1, 2);
      }
      if (h % 37 === 0) {
        g.fillStyle = `hsl(30 22% ${shade + 4}%)`;
        g.fillRect(tx * TILE + ((h >> 8) % 10) + 2, ty * TILE + ((h >> 12) % 10) + 2, 2, 2);
      }
    }
  }
  // A border so the edge of the world is visible rather than an invisible wall.
  g.fillStyle = '#243044';
  g.fillRect(0, 0, WORLD_PX_W, 2);
  g.fillRect(0, WORLD_PX_H - 2, WORLD_PX_W, 2);
  g.fillRect(0, 0, 2, WORLD_PX_H);
  g.fillRect(WORLD_PX_W - 2, 0, 2, WORLD_PX_H);
  return c;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
