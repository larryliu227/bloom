/**
 * VOIDLINE — camera.
 *
 * Smooth exponential follow with aim lookahead, trauma-based shake (squared
 * falloff, smooth multi-frequency noise rather than per-frame randomness), and
 * hard clamping so the view never reveals more than `EDGE_MARGIN` world units
 * outside the arena.
 *
 * All public positions are in WORLD units. `viewW/viewH` are CSS pixels — the
 * renderer handles devicePixelRatio separately, so the camera never needs to
 * know about it.
 */

import type { Vec2 } from '@shared/types.js';
import { ARENA_H, ARENA_W, SCREENSHAKE_DECAY } from '@shared/constants.js';
import { clamp } from '@shared/math.js';

/** How hard the camera chases its target (1/sec, exponential). */
const FOLLOW_STIFFNESS = 9.0;
/** How hard the lookahead offset chases the aim direction. */
const LOOKAHEAD_STIFFNESS = 4.5;
/** Fraction of the player->aim vector the camera leans into. */
const LOOKAHEAD_FACTOR = 0.3;
/** Hard cap on lookahead so a far cursor cannot push you off-screen. */
const LOOKAHEAD_MAX = 190;
const ZOOM_STIFFNESS = 5.5;
/** Peak positional shake in CSS pixels at trauma == 1. */
const MAX_SHAKE_PX = 26;
/** Peak rotational shake in radians at trauma == 1. */
const MAX_SHAKE_ROT = 0.016;
/** How far outside the arena the view may drift. */
const EDGE_MARGIN = 56;

export class Camera {
  /** Smoothed camera centre, world units (shake excluded). */
  x = ARENA_W / 2;
  y = ARENA_H / 2;
  zoom = 1;

  /** Viewport in CSS pixels. */
  viewW = 1280;
  viewH = 720;

  /** 0..1. Squared before it becomes shake amplitude, per Squirrel Eiserloh. */
  trauma = 0;

  /**
   * Follow stiffness (1/sec). The default is tuned for a raw target. When the
   * caller has already smoothed its camera (client/main.ts does), the renderer
   * raises this so the two filters do not stack into visible lag.
   */
  stiffness = FOLLOW_STIFFNESS;

  /** Visible world bounds including shake + a safety margin. Read-only. */
  minX = 0;
  minY = 0;
  maxX = ARENA_W;
  maxY = ARENA_H;

  private zoomTarget = 1;
  private shakeX = 0;
  private shakeY = 0;
  private shakeRot = 0;
  private lookX = 0;
  private lookY = 0;
  private t = 0;

  // Scratch objects so toScreen/toWorld can be called every frame without churn
  // when the caller opts into the *Into variants.
  private readonly scratchA: Vec2 = { x: 0, y: 0 };
  private readonly scratchB: Vec2 = { x: 0, y: 0 };

  constructor(viewW = 1280, viewH = 720) {
    this.setViewport(viewW, viewH);
  }

  setViewport(w: number, h: number): void {
    this.viewW = Math.max(1, w);
    this.viewH = Math.max(1, h);
    this.updateBounds();
  }

  /** Target zoom; reached smoothly unless `instant`. */
  setZoom(z: number, instant = false): void {
    this.zoomTarget = clamp(z, 0.35, 3);
    if (instant) this.zoom = this.zoomTarget;
  }

  /** Teleport (match start, respawn) — kills smoothing and lookahead. */
  snapTo(p: Vec2): void {
    this.x = p.x;
    this.y = p.y;
    this.lookX = 0;
    this.lookY = 0;
    this.clampToArena();
    this.updateBounds();
  }

  /**
   * Advance the camera one frame.
   * @param target the point to keep centred (usually the local player)
   * @param dt     seconds
   * @param aim    optional world-space aim point; the camera leans toward it
   */
  follow(target: Vec2, dt: number, aim?: Vec2): void {
    const step = dt > 0.1 ? 0.1 : dt;
    this.t += step;

    // --- zoom
    this.zoom += (this.zoomTarget - this.zoom) * (1 - Math.exp(-ZOOM_STIFFNESS * step));

    // --- aim lookahead
    let wantLookX = 0;
    let wantLookY = 0;
    if (aim !== undefined) {
      let dx = (aim.x - target.x) * LOOKAHEAD_FACTOR;
      let dy = (aim.y - target.y) * LOOKAHEAD_FACTOR;
      const d = Math.hypot(dx, dy);
      if (d > LOOKAHEAD_MAX) {
        const k = LOOKAHEAD_MAX / d;
        dx *= k;
        dy *= k;
      }
      wantLookX = dx;
      wantLookY = dy;
    }
    const lookK = 1 - Math.exp(-LOOKAHEAD_STIFFNESS * step);
    this.lookX += (wantLookX - this.lookX) * lookK;
    this.lookY += (wantLookY - this.lookY) * lookK;

    // --- position
    const followK = 1 - Math.exp(-this.stiffness * step);
    this.x += (target.x + this.lookX - this.x) * followK;
    this.y += (target.y + this.lookY - this.y) * followK;
    this.clampToArena();

    // --- trauma decay + smooth shake noise
    if (this.trauma > 0) {
      this.trauma *= Math.exp(-SCREENSHAKE_DECAY * step);
      if (this.trauma < 0.0025) this.trauma = 0;
    }
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma;
      const amp = (MAX_SHAKE_PX * s) / this.zoom;
      const t = this.t;
      this.shakeX = amp * (Math.sin(t * 61.7) * 0.62 + Math.sin(t * 29.3 + 1.7) * 0.38);
      this.shakeY = amp * (Math.sin(t * 53.1 + 2.9) * 0.62 + Math.sin(t * 37.7 + 0.4) * 0.38);
      this.shakeRot = MAX_SHAKE_ROT * s * Math.sin(t * 41.3 + 0.9);
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
      this.shakeRot = 0;
    }

    this.updateBounds();
  }

  /** Add trauma. Magnitudes are additive and clamped to 1. */
  shake(mag: number): void {
    if (!(mag > 0)) return;
    const next = this.trauma + mag;
    this.trauma = next > 1 ? 1 : next;
  }

  /** Camera centre actually used for rendering (includes shake). */
  get renderX(): number {
    return this.x + this.shakeX;
  }

  get renderY(): number {
    return this.y + this.shakeY;
  }

  get rotation(): number {
    return this.shakeRot;
  }

  /** Push world-space transform onto `ctx`. Caller is responsible for save/restore. */
  apply(ctx: CanvasRenderingContext2D): void {
    ctx.translate(this.viewW * 0.5, this.viewH * 0.5);
    if (this.shakeRot !== 0) ctx.rotate(this.shakeRot);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.renderX, -this.renderY);
  }

  // ---------------------------------------------------------------- transforms

  toScreen(p: Vec2): Vec2 {
    const out = this.scratchA;
    out.x = this.toScreenX(p.x, p.y);
    out.y = this.toScreenY(p.x, p.y);
    return out;
  }

  toWorld(p: Vec2): Vec2 {
    const out = this.scratchB;
    const c = Math.cos(-this.shakeRot);
    const s = Math.sin(-this.shakeRot);
    const dx = p.x - this.viewW * 0.5;
    const dy = p.y - this.viewH * 0.5;
    const rx = dx * c - dy * s;
    const ry = dx * s + dy * c;
    out.x = rx / this.zoom + this.renderX;
    out.y = ry / this.zoom + this.renderY;
    return out;
  }

  /** Allocation-free component transforms for hot loops. */
  toScreenX(wx: number, wy: number): number {
    const dx = (wx - this.renderX) * this.zoom;
    const dy = (wy - this.renderY) * this.zoom;
    if (this.shakeRot === 0) return dx + this.viewW * 0.5;
    return dx * Math.cos(this.shakeRot) - dy * Math.sin(this.shakeRot) + this.viewW * 0.5;
  }

  toScreenY(wx: number, wy: number): number {
    const dx = (wx - this.renderX) * this.zoom;
    const dy = (wy - this.renderY) * this.zoom;
    if (this.shakeRot === 0) return dy + this.viewH * 0.5;
    return dx * Math.sin(this.shakeRot) + dy * Math.cos(this.shakeRot) + this.viewH * 0.5;
  }

  /** World-space radius that a screen-space pixel radius corresponds to. */
  pixelsToWorld(px: number): number {
    return px / this.zoom;
  }

  /** Cheap AABB visibility test used to cull every draw call. */
  isVisible(x: number, y: number, radius: number): boolean {
    return x + radius >= this.minX && x - radius <= this.maxX && y + radius >= this.minY && y - radius <= this.maxY;
  }

  // ---------------------------------------------------------------- internals

  private clampToArena(): void {
    const halfW = this.viewW / (2 * this.zoom);
    const halfH = this.viewH / (2 * this.zoom);
    if (halfW * 2 >= ARENA_W + EDGE_MARGIN * 2) {
      this.x = ARENA_W / 2;
    } else {
      this.x = clamp(this.x, halfW - EDGE_MARGIN, ARENA_W - halfW + EDGE_MARGIN);
    }
    if (halfH * 2 >= ARENA_H + EDGE_MARGIN * 2) {
      this.y = ARENA_H / 2;
    } else {
      this.y = clamp(this.y, halfH - EDGE_MARGIN, ARENA_H - halfH + EDGE_MARGIN);
    }
  }

  private updateBounds(): void {
    // Rotation is tiny; expand by 6% plus a fixed pad instead of transforming corners.
    const halfW = (this.viewW / (2 * this.zoom)) * 1.06 + 48;
    const halfH = (this.viewH / (2 * this.zoom)) * 1.06 + 48;
    const cx = this.renderX;
    const cy = this.renderY;
    this.minX = cx - halfW;
    this.maxX = cx + halfW;
    this.minY = cy - halfH;
    this.maxY = cy + halfH;
  }
}
