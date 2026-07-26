/**
 * VOIDLINE — renderer.
 *
 * Canvas2D, no framework. Everything expensive is baked once in `sprites.ts`
 * and blitted; everything that emits light is drawn additively in a layered
 * pass (wide dim -> medium -> tight bright core).
 *
 * Draw order (strict):
 *   1  clear to the void
 *   2  two parallax starfield layers + drifting nebula        [screen space]
 *   3  baked arena deck                                       [world space]
 *   4  conduit energy pulsing inward toward the reactor core
 *   5  arena containment edge
 *   6  zones (ground effects)
 *   7  entity shadows (single batched path)
 *   8  enemy telegraphs (under bodies, so shapes stay readable)
 *   9  motion trails
 *  10  enemies
 *  11  players
 *  12  projectiles
 *  13  shockwaves / beams / dash streaks
 *  14  aim indicator
 *  15  particles (bloom pass, then main additive pass)
 *  16  nameplates + HP bars                                   [screen space]
 *  17  floating damage numbers
 *  18  vignette / scanlines / grain
 *  19  edge pulses + white flash
 *  20  chromatic aberration impulse
 */

import type {
  Entity,
  EntityId,
  EnemyEntity,
  PlayerEntity,
  ProjectileEntity,
  Vec2,
  WorldState,
  ZoneEntity,
} from '@shared/types.js';
import type { RoleId } from '@shared/types.js';
import {
  ARENA_H,
  ARENA_W,
  DASH_DURATION,
  DASH_IFRAMES,
  ENEMY_RADIUS_DEFAULT,
  MOVE_SPEED,
  PLAYER_RADIUS,
} from '@shared/constants.js';
import type { GameEvent } from '@shared/types.js';
import { makeRng } from '@shared/math.js';
import { defaultLoadout } from '@shared/roles.js';
import { createBoard } from '@shared/weave.js';
import { Camera } from './camera.js';
import { Effects, safeAbility } from './effects.js';
import { ParticleSystem } from './particles.js';
import * as P from './palette.js';
import * as S from './sprites.js';

const TAU = Math.PI * 2;

/**
 * Half-width of the safe gap in a boss ring attack, radians.
 *
 * MUST equal `RING_GAP_HALF` in `server/systems/enemies.ts`. The gap centre is
 * published per-ring via the caster's `angle`, but a single number cannot carry
 * the width too, so this is a contract between the two files: if the sim widens
 * the gap and this does not follow, the drawn exit stops matching the safe one
 * and players die in a gap the game showed them.
 */
const RING_GAP_HALF = 0.65;

/**
 * Clamp to 0..1. Canvas throws IndexSizeError on a negative arc radius, and a
 * throw inside a draw pass aborts every pass after it — so any ratio feeding a
 * radius, lineWidth or alpha gets pinned here rather than trusted.
 */
function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
const FONT = '"Eurostile", "Bahnschrift", "DIN Alternate", system-ui, sans-serif';

/** Spacing of the conduit trunk lines, matched to the baked floor. */
const CONDUIT_STEP = 100;
/** Trail ring-buffer depth (frames of history). */
const TRAIL_MAX = 14;

/** What the client shell hands the renderer every frame. */
export interface RenderView {
  /** Already interpolated by Agent F: remote entities lerped, self predicted. */
  world: WorldState;
  selfId: EntityId;
  /** Desired camera focus in world units. */
  camera: { x: number; y: number; zoom: number };
  /** World-space aim point (cursor). */
  aim: Vec2;
}

/** Per-entity visual state the snapshot cannot carry (trails, telegraph memory). */
interface EntityVis {
  id: EntityId;
  stamp: number;
  tx: Float32Array;
  ty: Float32Array;
  tcount: number;
  thead: number;
  speed: number;
  angle: number;
  age: number;
  hpShown: number;
  telePrev: number;
  teleMax: number;
  resolve: number;
  ghost: number;
  seed: number;
}

export class Renderer {
  readonly camera = new Camera();
  readonly particles = new ParticleSystem();
  readonly effects = new Effects(this.particles);

  /**
   * Apply aim lookahead inside the camera. Off by default because
   * `client/main.ts` already leans its camera toward the cursor; the demo
   * harness turns it on.
   */
  lookahead = false;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 1280;
  private height = 720;

  private time = 0;
  private realTime = 0;
  private frame = 0;
  private primed = false;
  private disposed = false;

  /** 1 = everything, 0.5 = no grain/bloom, 0 = no aberration either. */
  private quality = 1;
  /** Draw passes that have already thrown once, so we log each at most once. */
  private readonly failedPasses = new Set<string>();
  private avgFrameMs = 16.7;

  private readonly playersL: PlayerEntity[] = [];
  private readonly enemiesL: EnemyEntity[] = [];
  private readonly projectilesL: ProjectileEntity[] = [];
  private readonly zonesL: ZoneEntity[] = [];
  private readonly byId = new Map<EntityId, Entity>();

  private readonly vis = new Map<EntityId, EntityVis>();
  private readonly visPool: EntityVis[] = [];

  private lastEvents: unknown = null;
  private readonly camTarget: Vec2 = { x: ARENA_W / 2, y: ARENA_H / 2 };

  private fxA: HTMLCanvasElement | null = null;
  private fxB: HTMLCanvasElement | null = null;

  private readonly onWindowResize = (): void => this.resize();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx === null) throw new Error('VOIDLINE: unable to acquire a 2D canvas context');
    this.ctx = ctx;
    this.camera.stiffness = 22; // main.ts pre-smooths; do not stack two filters
    this.resize();
    // Warm the expensive bakes so the first frame is not a hitch.
    S.arenaFloor(ARENA_W, ARENA_H);
    S.nebulaSheet();
    if (typeof window !== 'undefined') window.addEventListener('resize', this.onWindowResize);
  }

  /** Detach listeners. Only the demo harness needs this. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof window !== 'undefined') window.removeEventListener('resize', this.onWindowResize);
  }

  // ================================================================ sizing

  /** devicePixelRatio-correct backing store sizing. Idempotent. */
  /**
   * Run one draw pass in isolation. Canvas is unforgiving — a single bad radius
   * throws — and passes are sequential, so without this an error in an early pass
   * silently erases the HUD, nameplates, particles and damage numbers for that
   * frame. Log each distinct failure once (never per-frame spam), then carry on.
   */
  private pass(name: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (!this.failedPasses.has(name)) {
        this.failedPasses.add(name);
        console.error(`[render] pass "${name}" threw — later passes preserved`, err);
      }
    }
  }

  resize(): void {
    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    let cssW = this.canvas.clientWidth;
    let cssH = this.canvas.clientHeight;
    if (cssW < 1 || cssH < 1) {
      const rect = this.canvas.getBoundingClientRect();
      cssW = rect.width;
      cssH = rect.height;
    }
    if (cssW < 1 || cssH < 1) {
      cssW = typeof window !== 'undefined' ? window.innerWidth : 1280;
      cssH = typeof window !== 'undefined' ? window.innerHeight : 720;
    }

    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;

    this.dpr = dpr;
    this.width = cssW;
    this.height = cssH;
    this.camera.setViewport(cssW, cssH);

    // Half-resolution scratch buffers for the chromatic aberration impulse.
    const fw = Math.max(1, Math.floor(bw / 2));
    const fh = Math.max(1, Math.floor(bh / 2));
    if (this.fxA === null || this.fxA.width !== fw || this.fxA.height !== fh) {
      this.fxA = S.createCanvas(fw, fh);
      this.fxB = S.createCanvas(fw, fh);
    }
    this.ctx.imageSmoothingEnabled = true;
  }

  private syncSize(): void {
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    if (cssW >= 1 && cssH >= 1 && (Math.abs(cssW - this.width) > 0.5 || Math.abs(cssH - this.height) > 0.5)) {
      this.resize();
    }
  }

  // ================================================================ frame

  render(view: RenderView, dtMs: number): void {
    if (this.canvas.width < 1 || this.canvas.height < 1) return;
    this.syncSize();

    const realDtMs = dtMs > 0 ? (dtMs > 100 ? 100 : dtMs) : 16.7;
    this.avgFrameMs = this.avgFrameMs * 0.94 + realDtMs * 0.06;
    this.quality = this.avgFrameMs > 30 ? 0 : this.avgFrameMs > 21 ? 0.5 : 1;

    // Client-side hitstop: freeze the world, keep the clock honest.
    const dt = (realDtMs / 1000) * (this.effects.hitstopMs > 0 ? 0.08 : 1);
    this.time += dt;
    this.realTime += realDtMs / 1000;
    this.frame++;

    this.partition(view.world);
    this.consumeEvents(view.world, view.selfId);

    this.camTarget.x = view.camera.x;
    this.camTarget.y = view.camera.y;
    if (!this.primed) {
      this.primed = true;
      this.camera.setZoom(view.camera.zoom, true);
      this.camera.snapTo(this.camTarget);
    }
    this.camera.setZoom(view.camera.zoom);
    this.camera.follow(this.camTarget, dt, this.lookahead ? view.aim : undefined);

    this.updateVis(dt);
    this.particles.update(dt);
    this.effects.update(dt, realDtMs);

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = P.BG_VOID;
    ctx.fillRect(0, 0, this.width, this.height);

    this.pass('starfield', () => this.drawStarfield());
    this.pass('nebula', () => this.drawNebula());

    // try/finally: a pass that throws must still restore the transform, or every
    // later pass — and the next frame — draws in camera space.
    ctx.save();
    try {
      this.camera.apply(ctx);
      this.pass('floor', () => this.drawFloor());
      this.pass('conduitPulses', () => this.drawConduitPulses());
      this.pass('reactorCore', () => this.drawReactorCore());
      this.pass('arenaEdge', () => this.drawArenaEdge());
      this.pass('zones', () => this.drawZones());
      this.pass('shadows', () => this.drawShadows());
      this.pass('telegraphs', () => this.drawTelegraphs(view.selfId));
      this.pass('trails', () => this.drawTrails());
      this.pass('enemies', () => this.drawEnemies());
      this.pass('players', () => this.drawPlayers(view.selfId));
      this.pass('projectiles', () => this.drawProjectiles());
      this.pass('effectsWorld', () => this.effects.drawWorld(ctx, this.camera));
      this.pass('aim', () => this.drawAim(view));
      if (this.quality >= 1) this.pass('bloom', () => this.particles.drawBloom(ctx, this.camera));
      this.pass('particles', () => this.particles.draw(ctx, this.camera));
    } finally {
      ctx.restore();
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    this.pass('nameplates', () => this.drawNameplates(view.selfId));
    this.pass('numbers', () => this.effects.drawNumbers(ctx, this.camera));
    this.pass('overlay', () => this.drawOverlay(view.selfId));
    this.pass('effectsScreen', () => this.effects.drawScreen(ctx, this.width, this.height));
    this.pass('aberration', () => this.drawAberration());
  }

  // ================================================================ world prep

  private partition(world: WorldState): void {
    this.playersL.length = 0;
    this.enemiesL.length = 0;
    this.projectilesL.length = 0;
    this.zonesL.length = 0;
    this.byId.clear();

    const list = world.entities;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      this.byId.set(e.id, e);
      switch (e.kind) {
        case 'player':
          this.playersL.push(e);
          break;
        case 'enemy':
          this.enemiesL.push(e);
          break;
        case 'projectile':
          this.projectilesL.push(e);
          break;
        case 'zone':
          this.zonesL.push(e);
          break;
        default:
          break;
      }
    }
  }

  // ================================================================ background

  private drawStarfield(): void {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const cam = this.camera;

    this.drawStarLayer(S.starLayer(0x51a12, 512, 190, 1.0, 0.5), 0.045, cam, w, h, 0.85);
    this.drawStarLayer(S.starLayer(0xb0d135, 512, 80, 2.0, 1.0), 0.13, cam, w, h, 1);
    void ctx;
  }

  private drawStarLayer(
    tile: HTMLCanvasElement,
    parallax: number,
    cam: Camera,
    w: number,
    h: number,
    alpha: number,
  ): void {
    const ctx = this.ctx;
    const size = tile.width;
    let ox = (-cam.renderX * parallax) % size;
    let oy = (-cam.renderY * parallax) % size;
    if (ox > 0) ox -= size;
    if (oy > 0) oy -= size;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(ox, oy);
    ctx.fillStyle = S.tilePattern(ctx, tile);
    ctx.fillRect(-ox, -oy, w, h);
    ctx.restore();
  }

  private drawNebula(): void {
    const ctx = this.ctx;
    const sheet = S.nebulaSheet();
    const cam = this.camera;
    const cover = Math.max(this.width, this.height) * 1.9;
    ctx.globalCompositeOperation = 'lighter';

    const dx1 = (-cam.renderX * 0.02 + Math.sin(this.realTime * 0.013) * 40) % cover;
    const dy1 = (-cam.renderY * 0.02 + Math.cos(this.realTime * 0.011) * 40) % cover;
    ctx.globalAlpha = 0.17;
    ctx.drawImage(sheet, this.width / 2 - cover / 2 + dx1, this.height / 2 - cover / 2 + dy1, cover, cover);

    const cover2 = cover * 0.62;
    const dx2 = (-cam.renderX * 0.05 - Math.sin(this.realTime * 0.009) * 60) % cover2;
    const dy2 = (-cam.renderY * 0.05 + Math.cos(this.realTime * 0.007) * 60) % cover2;
    ctx.globalAlpha = 0.11;
    ctx.drawImage(sheet, this.width / 2 - cover2 / 2 + dx2, this.height / 2 - cover2 / 2 + dy2, cover2, cover2);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ================================================================ arena deck

  private drawFloor(): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const floor = S.arenaFloor(ARENA_W, ARENA_H);
    const sx = Math.max(0, Math.floor(cam.minX));
    const sy = Math.max(0, Math.floor(cam.minY));
    const ex = Math.min(ARENA_W, Math.ceil(cam.maxX));
    const ey = Math.min(ARENA_H, Math.ceil(cam.maxY));
    if (ex <= sx || ey <= sy) return;
    // Slightly translucent: the starfield and nebula bleed through the deck,
    // which is what makes the arena read as a platform floating in the void.
    ctx.globalAlpha = 0.93;
    ctx.drawImage(floor, sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy);
    ctx.globalAlpha = 1;
  }

  /**
   * Energy running along the conduit trunk lines, always travelling INWARD
   * toward the reactor core, brightening as it converges. Baked streak sprites
   * mean this is pure `drawImage` — no gradients, no transforms.
   */
  private drawConduitPulses(): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const cx = ARENA_W / 2;
    const cy = ARENA_H / 2;
    const t = this.time;

    const LEN = 170;
    const THICK = 13;
    const vert = S.streakSprite(P.ENERGY_CYAN, LEN, THICK, true);
    const horiz = S.streakSprite(P.ENERGY_CYAN, LEN, THICK, false);

    ctx.globalCompositeOperation = 'lighter';

    for (let x = CONDUIT_STEP; x < ARENA_W; x += CONDUIT_STEP) {
      if (x < cam.minX - THICK || x > cam.maxX + THICK) continue;
      const ph = (t * 0.26 + x * 0.0007) % 1;
      const a = 0.07 + 0.28 * ph * ph;
      ctx.globalAlpha = a;
      // upper half travels down toward the core, lower half travels up
      ctx.drawImage(vert, x - THICK / 2, ph * cy - LEN * 0.78, THICK, LEN);
      ctx.drawImage(vert, x - THICK / 2, ARENA_H - ph * cy - LEN * 0.22, THICK, LEN);
    }

    for (let y = CONDUIT_STEP; y < ARENA_H; y += CONDUIT_STEP) {
      if (y < cam.minY - THICK || y > cam.maxY + THICK) continue;
      const ph = (t * 0.22 + y * 0.0009 + 0.37) % 1;
      const a = 0.07 + 0.28 * ph * ph;
      ctx.globalAlpha = a;
      ctx.drawImage(horiz, ph * cx - LEN * 0.78, y - THICK / 2, LEN, THICK);
      ctx.drawImage(horiz, ARENA_W - ph * cx - LEN * 0.22, y - THICK / 2, LEN, THICK);
    }
    ctx.globalAlpha = 1;

    // Concentric intake rings contracting toward the core.
    for (let i = 0; i < 3; i++) {
      const ph = (t * 0.17 + i / 3) % 1;
      const r = 760 * (1 - ph);
      if (r < 40) continue;
      const a = (1 - ph) * ph * 1.9;
      ctx.strokeStyle = P.withAlpha(P.ENERGY_CYAN, a * 0.07);
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = P.withAlpha(P.ENERGY_CYAN, a * 0.2);
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  /** The reactor at the arena centre: the machine everything else plugs into. */
  private drawReactorCore(): void {
    const cx = ARENA_W / 2;
    const cy = ARENA_H / 2;
    if (!this.camera.isVisible(cx, cy, 200)) return;

    const ctx = this.ctx;
    const t = this.time;
    const breathe = 0.72 + 0.28 * Math.sin(t * 1.7);

    ctx.globalCompositeOperation = 'lighter';

    // wide dim pass
    ctx.globalAlpha = 0.17 * breathe;
    ctx.drawImage(S.haloSprite(P.ENERGY_CYAN, 128), cx - 190, cy - 190, 380, 380);
    // medium
    ctx.globalAlpha = 0.24 * breathe;
    ctx.drawImage(S.glowSprite(P.ENERGY_CYAN, 128), cx - 72, cy - 72, 144, 144);
    // tight bright core
    ctx.globalAlpha = 0.95;
    ctx.drawImage(S.glowSprite(P.ENERGY_WHITE, 64), cx - 20 * breathe, cy - 20 * breathe, 40 * breathe, 40 * breathe);
    ctx.globalAlpha = 1;

    // counter-rotating gapped rings
    for (let i = 0; i < 3; i++) {
      const r = 46 + i * 26;
      const dir = i % 2 === 0 ? 1 : -1;
      const rot = t * (0.4 + i * 0.22) * dir;
      const arcs = 3 + i;
      ctx.strokeStyle = P.withAlpha(i === 1 ? P.ENERGY_VIOLET : P.ENERGY_CYAN, 0.55 + 0.25 * breathe);
      ctx.lineWidth = 3 - i * 0.6;
      ctx.beginPath();
      for (let k = 0; k < arcs; k++) {
        const a0 = rot + (k / arcs) * TAU;
        ctx.arc(cx, cy, r, a0, a0 + TAU / arcs - 0.42);
        ctx.moveTo(cx + Math.cos(a0 + TAU / arcs) * r, cy + Math.sin(a0 + TAU / arcs) * r);
      }
      ctx.stroke();
    }

    // hexagonal containment frame
    const hexR = 108;
    const hexRot = -t * 0.14;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = hexRot + (k / 6) * TAU;
      const px = cx + Math.cos(a) * hexR;
      const py = cy + Math.sin(a) * hexR;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.strokeStyle = P.withAlpha(P.ENERGY_CYAN, 0.28);
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.globalCompositeOperation = 'source-over';
  }

  /** Containment field along the arena boundary. */
  private drawArenaEdge(): void {
    const ctx = this.ctx;
    const t = this.time;
    const pulse = 0.5 + 0.5 * Math.sin(t * 1.1);

    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = P.withAlpha(P.ENERGY_CYAN, 0.05 + 0.05 * pulse);
    ctx.lineWidth = 26;
    ctx.strokeRect(0, 0, ARENA_W, ARENA_H);
    ctx.strokeStyle = P.withAlpha(P.ENERGY_CYAN, 0.2 + 0.12 * pulse);
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, ARENA_W, ARENA_H);

    ctx.setLineDash([26, 22]);
    ctx.lineDashOffset = -t * 34;
    ctx.strokeStyle = P.withAlpha(P.ENERGY_WHITE, 0.22);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0, 0, ARENA_W, ARENA_H);
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // corner brackets
    const b = 64;
    ctx.strokeStyle = P.withAlpha(P.ENERGY_VIOLET, 0.42);
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (const [x, y, sx, sy] of [
      [0, 0, 1, 1],
      [ARENA_W, 0, -1, 1],
      [0, ARENA_H, 1, -1],
      [ARENA_W, ARENA_H, -1, -1],
    ] as const) {
      ctx.moveTo(x + sx * b, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + sy * b);
    }
    ctx.stroke();

    ctx.globalCompositeOperation = 'source-over';
  }

  // ================================================================ zones

  private drawZones(): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const t = this.time;

    for (let i = 0; i < this.zonesL.length; i++) {
      const z = this.zonesL[i];
      const r = z.radius;
      if (!cam.isVisible(z.pos.x, z.pos.y, r + 12)) continue;

      const color = zoneColor(z);
      const x = z.pos.x;
      const y = z.pos.y;
      // fade out over the last second of life
      const fade = z.life > 0 && z.life < 1 ? z.life : 1;
      const pulse = 0.72 + 0.28 * Math.sin(t * 3.4 + z.id * 0.7);
      const rr = r * (0.97 + 0.03 * pulse);

      ctx.globalCompositeOperation = 'lighter';

      // soft volumetric fill
      ctx.globalAlpha = 0.13 * fade * pulse;
      ctx.drawImage(S.haloSprite(color, 128), x - rr, y - rr, rr * 2, rr * 2);
      ctx.globalAlpha = 1;

      // scanline interior, clipped to the disc
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, TAU);
      ctx.clip();
      ctx.strokeStyle = P.withAlpha(color, 0.16 * fade);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const off = (t * 26) % 10;
      for (let sy = y - rr + off; sy < y + rr; sy += 10) {
        ctx.moveTo(x - rr, sy);
        ctx.lineTo(x + rr, sy);
      }
      ctx.stroke();
      // radial spokes for a "field" read
      ctx.strokeStyle = P.withAlpha(color, 0.1 * fade);
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = t * 0.5 + (k / 8) * TAU;
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      ctx.stroke();
      ctx.restore();

      // animated boundary: layered glow + rotating dashes
      ctx.strokeStyle = P.withAlpha(color, 0.14 * fade);
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = P.withAlpha(color, 0.5 * fade);
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.setLineDash([12, 9]);
      ctx.lineDashOffset = -t * 40;
      ctx.strokeStyle = P.withAlpha(P.hot(color, 0.6), 0.75 * fade);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, rr * 0.93, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;

      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // ================================================================ shadows

  /** Every shadow in one path, one fill — 1 draw call for the whole cast. */
  private drawShadows(): void {
    const ctx = this.ctx;
    const cam = this.camera;
    ctx.beginPath();
    let any = false;

    for (let i = 0; i < this.enemiesL.length; i++) {
      const e = this.enemiesL[i];
      if (!cam.isVisible(e.pos.x, e.pos.y, e.radius * 2)) continue;
      ctx.moveTo(e.pos.x + e.radius * 1.05, e.pos.y + e.radius * 0.34);
      ctx.ellipse(e.pos.x, e.pos.y + e.radius * 0.34, e.radius * 1.05, e.radius * 0.6, 0, 0, TAU);
      any = true;
    }
    for (let i = 0; i < this.playersL.length; i++) {
      const p = this.playersL[i];
      if (p.respawnTimer > 0) continue;
      if (!cam.isVisible(p.pos.x, p.pos.y, p.radius * 2)) continue;
      ctx.moveTo(p.pos.x + p.radius * 1.05, p.pos.y + p.radius * 0.34);
      ctx.ellipse(p.pos.x, p.pos.y + p.radius * 0.34, p.radius * 1.05, p.radius * 0.6, 0, 0, TAU);
      any = true;
    }

    if (!any) return;
    ctx.fillStyle = P.withAlpha(P.SHADOW, 0.42);
    ctx.fill();
  }

  // ================================================================ per-entity state

  private visFor(e: Entity): EntityVis {
    let v = this.vis.get(e.id);
    if (v !== undefined) return v;
    const pooled = this.visPool.pop();
    if (pooled !== undefined) {
      v = pooled;
      v.tcount = 0;
      v.thead = 0;
    } else {
      v = {
        id: e.id,
        stamp: 0,
        tx: new Float32Array(TRAIL_MAX),
        ty: new Float32Array(TRAIL_MAX),
        tcount: 0,
        thead: 0,
        speed: 0,
        angle: 0,
        age: 0,
        hpShown: 0,
        telePrev: 0,
        teleMax: 0,
        resolve: 0,
        ghost: 0,
        seed: 0,
      };
    }
    v.id = e.id;
    v.speed = 0;
    v.angle = e.angle;
    v.age = 0;
    v.hpShown = e.hp;
    v.telePrev = 0;
    v.teleMax = 0;
    v.resolve = 0;
    v.ghost = 0;
    v.seed = (e.id * 2654435761) % 1000 / 1000;
    this.vis.set(e.id, v);
    return v;
  }

  /**
   * Advance trails, smoothed facing, telegraph memory and status emitters for
   * every live entity, then retire visuals for entities that vanished.
   */
  private updateVis(dt: number): void {
    const stamp = this.frame;

    for (const [, v] of this.vis) v.stamp = -1;

    this.stepVisList(this.playersL, dt, stamp);
    this.stepVisList(this.enemiesL, dt, stamp);
    this.stepVisList(this.projectilesL, dt, stamp);

    for (const [id, v] of this.vis) {
      if (v.stamp === stamp) continue;
      this.vis.delete(id);
      if (this.visPool.length < 96) this.visPool.push(v);
    }
  }

  private stepVisList(list: readonly Entity[], dt: number, stamp: number): void {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const v = this.visFor(e);
      v.stamp = stamp;
      v.age += dt;
      if (v.ghost > 0) v.ghost -= dt;

      // trail ring buffer
      v.thead = (v.thead + 1) % TRAIL_MAX;
      v.tx[v.thead] = e.pos.x;
      v.ty[v.thead] = e.pos.y;
      if (v.tcount < TRAIL_MAX) v.tcount++;

      // smoothed speed + facing
      const sp = Math.hypot(e.vel.x, e.vel.y);
      v.speed += (sp - v.speed) * (1 - Math.exp(-9 * dt));
      let d = e.angle - v.angle;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      v.angle += d * (1 - Math.exp(-18 * dt));

      v.hpShown += (e.hp - v.hpShown) * (1 - Math.exp(-7 * dt));

      if (v.resolve > 0) v.resolve -= dt;

      if (e.kind === 'enemy') this.stepTelegraph(e, v, dt);
      if (e.kind !== 'projectile') this.stepStatusEmitters(e, dt);
    }
  }

  /** Remember how long a windup was so we can draw a fill ratio, and flash on resolve. */
  private stepTelegraph(e: EnemyEntity, v: EntityVis, dt: number): void {
    const tg = e.telegraph;
    if (tg > v.telePrev + 1e-4 || (tg > 0 && v.teleMax <= 0)) v.teleMax = tg;
    if (tg > v.teleMax) v.teleMax = tg;

    if (v.telePrev > 0.001 && tg <= 0.001) {
      // the attack just landed — punch a resolve flash and some danger sparks
      v.resolve = 0.24;
      const color = P.archetypeColor(e.archetype);
      this.particles.ring(e.pos.x, e.pos.y, P.DANGER_RED, e.radius, 520, 0.28, 3);
      this.particles.sparks(e.pos.x, e.pos.y, color, 10, e.angle, 0.9, 240);
      v.teleMax = 0;
    }
    v.telePrev = tg;
    void dt;
  }

  /** Statuses that should shed particles rather than just draw a ring. */
  private stepStatusEmitters(e: Entity, dt: number): void {
    const list = e.statuses;
    if (list === undefined || list.length === 0) return;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.kind === 'burn') {
        if (Math.random() < dt * 26) {
          this.particles.emit({
            kind: 'ember',
            x: e.pos.x + (Math.random() * 2 - 1) * e.radius,
            y: e.pos.y + (Math.random() * 2 - 1) * e.radius,
            count: 1,
            color: P.STATUS_BURN,
            angle: -Math.PI / 2,
            spread: 0.7,
            speed: 46,
            life: 0.42,
            size: 3.4,
            drag: 1.4,
            gravity: -40,
            fade: 1.6,
          });
        }
      } else if (s.kind === 'overclock') {
        if (Math.random() < dt * 14) {
          this.particles.beam(
            e.pos.x - e.radius,
            e.pos.y - e.radius,
            e.pos.x + e.radius,
            e.pos.y + e.radius,
            P.STATUS_OVERCLOCK,
            1,
          );
        }
      } else if (s.kind === 'chill') {
        if (Math.random() < dt * 8) {
          this.particles.trailMote(
            e.pos.x + (Math.random() * 2 - 1) * e.radius,
            e.pos.y + (Math.random() * 2 - 1) * e.radius,
            P.STATUS_CHILL,
            2.4,
            0.6,
          );
        }
      }
    }
  }

  // ================================================================ trails

  /** Motion trails: length and brightness scale with speed. */
  private drawTrails(): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    for (let i = 0; i < this.enemiesL.length; i++) {
      const e = this.enemiesL[i];
      this.drawTrail(e, P.archetypeColor(e.archetype), 0.55);
    }
    for (let i = 0; i < this.projectilesL.length; i++) {
      const p = this.projectilesL[i];
      this.drawTrail(p, P.teamColor(p.team), 1.15);
    }
    for (let i = 0; i < this.playersL.length; i++) {
      const p = this.playersL[i];
      if (p.respawnTimer > 0) continue;
      this.drawTrail(p, P.roleColor(p.role), p.dashing > 0 ? 1.6 : 1);
    }

    ctx.lineCap = 'butt';
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawTrail(e: Entity, color: string, weight: number): void {
    const v = this.vis.get(e.id);
    if (v === undefined || v.tcount < 3) return;
    // 0 at rest, 1 at dash speed — the trail literally lengthens with speed
    const intensity = Math.min(1, v.speed / 620) * weight;
    if (intensity < 0.05) return;

    const ctx = this.ctx;
    const used = Math.max(3, Math.min(v.tcount, Math.round(4 + intensity * (TRAIL_MAX - 4))));
    const baseW = e.radius * 0.85 * Math.min(1.2, weight);
    ctx.strokeStyle = color;

    for (let k = 0; k < used - 1; k++) {
      const i0 = (v.thead - k + TRAIL_MAX * 2) % TRAIL_MAX;
      const i1 = (v.thead - k - 1 + TRAIL_MAX * 2) % TRAIL_MAX;
      const f = 1 - k / used; // 1 at the head, 0 at the tail
      ctx.globalAlpha = f * f * 0.5 * intensity;
      ctx.lineWidth = baseW * f;
      ctx.beginPath();
      ctx.moveTo(v.tx[i0], v.ty[i0]);
      ctx.lineTo(v.tx[i1], v.ty[i1]);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ================================================================ telegraphs

  /**
   * Enemy windups. Non-negotiable readability rules:
   *  - the shape shows exactly WHERE the attack lands, driven by the enemy's
   *    facing and target — see `TELEGRAPHS` for the kind -> geometry table
   *  - warm (orange -> red) means incoming damage and nothing else; defensive
   *    windows are azure, support pulses mint, vulnerability windows yellow
   *  - the fill AND the collar gauge show exactly WHEN: both complete at 0
   *  - every shape lays down a dark cut-out before its additive pass, so a thin
   *    warm stroke never has to win against a bright cyan floor arc
   *  - a hard white snap frame fires as it resolves
   * Drawn under bodies so silhouettes stay legible.
   */
  private drawTelegraphs(selfId: EntityId): void {
    const ctx = this.ctx;
    const cam = this.camera;
    const self = this.byId.get(selfId);
    const selfTeam = self !== undefined ? self.team : 'players';

    for (let i = 0; i < this.enemiesL.length; i++) {
      const e = this.enemiesL[i];
      const v = this.vis.get(e.id);
      if (v === undefined) continue;
      const active = e.telegraph > 0.001 && v.teleMax > 0.001;
      if (!active && v.resolve <= 0) continue;

      const spec = telegraphSpec(e.telegraphKind);
      if (spec.shape === 'none') continue;
      // Allegiance decides the default read: a summon on your own team pulsing
      // its aura is information, not a threat, and must never be painted warm.
      const tone: TeleTone = spec.tone ?? (e.team === selfTeam ? 'support' : 'danger');
      const reach = telegraphReach(e, spec);
      if (!cam.isVisible(e.pos.x, e.pos.y, reach + 60)) continue;

      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (active) {
        this.drawTelegraphShape(e, spec, tone, reach, clamp01(1 - e.telegraph / v.teleMax), false);
      }
      if (v.resolve > 0) {
        this.drawTelegraphShape(e, spec, tone, reach, clamp01(v.resolve / 0.24), true);
      }
      ctx.restore();
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Dark cut-out pass. Call with the path you are about to light up: it stamps a
   * near-black ground first (source-over) and leaves the context in `lighter`
   * for the bright pass that follows.
   */
  private teleShade(path: Path2D, width: number, fillA: number): void {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    if (fillA > 0) {
      ctx.fillStyle = P.withAlpha(TELE_SHADE, fillA);
      ctx.fill(path);
    }
    if (width > 0) {
      ctx.strokeStyle = P.withAlpha(TELE_SHADE, 0.92);
      ctx.lineWidth = width;
      ctx.stroke(path);
    }
    ctx.globalCompositeOperation = 'lighter';
  }

  /**
   * The wind-up clock: a collar around the body that closes as the attack
   * commits. Shape-independent, so timing reads the same on a cone, a lane and
   * an arena-wide boss mechanic.
   */
  private teleCollar(x: number, y: number, r: number, p: number, edge: string, a: number): void {
    const ctx = this.ctx;
    const track = new Path2D();
    track.arc(x, y, r, 0, TAU);
    this.teleShade(track, 9, 0);
    ctx.strokeStyle = P.withAlpha(edge, 0.16);
    ctx.lineWidth = 5;
    ctx.stroke(track);

    const filled = new Path2D();
    filled.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + TAU * Math.max(0.004, p));
    ctx.strokeStyle = P.withAlpha(edge, 0.35 + 0.65 * a);
    ctx.lineWidth = 5.5;
    ctx.stroke(filled);
  }

  /** A capsule of half-width `hw` running `len` units from (x,y) along `ang`. */
  private static teleLane(x: number, y: number, ang: number, len: number, hw: number): Path2D {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const nx = -s * hw;
    const ny = c * hw;
    const path = new Path2D();
    path.moveTo(x + nx, y + ny);
    path.lineTo(x + nx + c * len, y + ny + s * len);
    path.lineTo(x - nx + c * len, y - ny + s * len);
    path.lineTo(x - nx, y - ny);
    path.closePath();
    return path;
  }

  /** Annulus between `r0` and `r1`, fillable with the even-odd rule. */
  private static teleBand(x: number, y: number, r0: number, r1: number): Path2D {
    const path = new Path2D();
    path.arc(x, y, Math.max(0.5, r1), 0, TAU);
    path.moveTo(x + Math.max(0.5, r0), y);
    path.arc(x, y, Math.max(0.5, r0), 0, TAU);
    return path;
  }

  /**
   * An annular band with a wedge cut out of it, swept from `a0` to `a1`.
   *
   * Unlike `teleBand` this is a SINGLE closed loop (outer arc forward, inner arc
   * back, closed), so it fills correctly with the default nonzero rule — do not
   * pass 'evenodd', which would punch the sector back out again.
   */
  private static teleSector(
    x: number,
    y: number,
    r0: number,
    r1: number,
    a0: number,
    a1: number,
  ): Path2D {
    const path = new Path2D();
    path.arc(x, y, Math.max(0.5, r1), a0, a1);
    path.arc(x, y, Math.max(0.5, r0), a1, a0, true);
    path.closePath();
    return path;
  }

  private drawTelegraphShape(
    e: EnemyEntity,
    spec: TeleSpec,
    tone: TeleTone,
    reach: number,
    p: number,
    resolving: boolean,
  ): void {
    const ctx = this.ctx;
    const x = e.pos.x;
    const y = e.pos.y;
    const vis = this.vis.get(e.id);
    const ang = vis !== undefined ? vis.angle : e.angle;

    const pal = spec.shape === 'unknown' ? TELE_UNKNOWN_PAL : TELE_TONES[tone];
    // Colour ramps toward the hot end as the attack commits; the resolve frame
    // is white-hot and decays quadratically so it punches without lingering.
    const edge = resolving ? P.mix(pal.hot, P.CORE_WHITE, p) : P.mix(pal.edge, pal.hot, p);
    const body = resolving ? pal.hot : pal.fill;
    // Alpha floor is deliberately high: a windup at 5% must already be obvious.
    const a = resolving ? p * p * 0.9 : 0.44 + 0.56 * p;
    const snap = !resolving && p > 0.86 ? (p - 0.86) / 0.14 : 0;
    // Geometry is at full extent while resolving — the hit covered the whole area.
    const g = resolving ? 1 : p;
    const fillA = resolving ? 0 : a;
    // Stroke weights: heavy enough to read at a glance over a busy floor.
    const W = 3.6 + 4.5 * snap;
    const WF = 6 + 7 * snap;
    // Only tight shapes get a solid dark ground; blacking out a 900-unit boss
    // radius would erase the arena.
    const heavy = reach <= 300;
    const rim = Math.max(9, e.radius);

    switch (spec.shape) {
      case 'cone': {
        const half = spec.halfArc ?? 0.62;
        const outline = new Path2D();
        outline.moveTo(x, y);
        outline.arc(x, y, reach, ang - half, ang + half);
        outline.closePath();
        this.teleShade(outline, W + 5, heavy ? 0.5 * fillA + 0.18 : 0);

        const grown = new Path2D();
        grown.moveTo(x, y);
        grown.arc(x, y, Math.max(0.5, reach * g), ang - half, ang + half);
        grown.closePath();
        ctx.fillStyle = P.withAlpha(body, 0.12 * fillA);
        ctx.fill(outline);
        ctx.fillStyle = P.withAlpha(body, 0.26 * fillA);
        ctx.fill(grown);

        ctx.strokeStyle = P.withAlpha(edge, 0.55 + 0.45 * a);
        ctx.lineWidth = W;
        ctx.stroke(outline);

        const front = new Path2D();
        front.arc(x, y, Math.max(0.5, reach * g), ang - half, ang + half);
        ctx.strokeStyle = P.withAlpha(edge, a);
        ctx.lineWidth = WF;
        ctx.stroke(front);
        if (snap > 0) {
          ctx.strokeStyle = P.withAlpha(P.CORE_WHITE, snap);
          ctx.lineWidth = 3 + 7 * snap;
          ctx.stroke(outline);
        }
        break;
      }

      case 'lane':
      case 'aimed': {
        const hw = spec.halfWidth ?? Math.max(9, e.radius);
        // `multi` kinds fire one lane per living player (the Fracture's lance
        // volley), so drawing only the caster's current target would tell three
        // of the four people in the room that nothing is coming for them.
        const lanes: { ang: number; len: number; mark: Vec2 | null }[] = [];
        if (spec.shape === 'aimed') {
          const victims: Entity[] = [];
          if (spec.multi === true) {
            for (let k = 0; k < this.playersL.length; k++) {
              const pl = this.playersL[k];
              if (pl.team !== e.team && !pl.dead) victims.push(pl);
            }
          }
          if (victims.length === 0 && e.target !== null) {
            const t = this.byId.get(e.target);
            if (t !== undefined) victims.push(t);
          }
          for (const t of victims) {
            const dx = t.pos.x - x;
            const dy = t.pos.y - y;
            lanes.push({
              ang: Math.atan2(dy, dx),
              len: Math.min(reach, Math.hypot(dx, dy) + t.radius + 26),
              mark: t.pos,
            });
          }
        }
        if (lanes.length === 0) lanes.push({ ang, len: reach, mark: null });

        for (const ln of lanes) {
          const outline = Renderer.teleLane(x, y, ln.ang, ln.len, hw);
          this.teleShade(outline, W + 5, 0.5 * fillA + 0.2);

          ctx.fillStyle = P.withAlpha(body, 0.14 * fillA);
          ctx.fill(outline);
          // The core thickens and brightens rather than growing in length: a
          // beam or a committed dash covers the whole strip at once.
          const core = Renderer.teleLane(x, y, ln.ang, ln.len, Math.max(1, hw * (0.16 + 0.84 * g * g)));
          ctx.fillStyle = P.withAlpha(edge, 0.5 * a);
          ctx.fill(core);
          ctx.strokeStyle = P.withAlpha(edge, 0.5 + 0.5 * a);
          ctx.lineWidth = W;
          ctx.stroke(outline);

          // Far cap: the line has an end, and you can stand past it.
          const c = Math.cos(ln.ang);
          const s = Math.sin(ln.ang);
          const cap = new Path2D();
          cap.moveTo(x + c * ln.len - s * hw, y + s * ln.len + c * hw);
          cap.lineTo(x + c * ln.len + s * hw, y + s * ln.len - c * hw);
          ctx.strokeStyle = P.withAlpha(edge, a);
          ctx.lineWidth = WF * 0.7;
          ctx.stroke(cap);

          if (ln.mark !== null) {
            // Reticle on the victim: "this one is for you".
            const ring = new Path2D();
            ring.arc(ln.mark.x, ln.mark.y, 20 + 10 * (1 - g), 0, TAU);
            this.teleShade(ring, 7, 0);
            ctx.strokeStyle = P.withAlpha(edge, 0.4 + 0.6 * a);
            ctx.lineWidth = 3.5;
            ctx.stroke(ring);
          }
          if (snap > 0) {
            ctx.fillStyle = P.withAlpha(P.CORE_WHITE, snap * 0.85);
            ctx.fill(outline);
          }
        }
        break;
      }

      case 'ring': {
        const band = spec.band ?? 58;
        /*
         * Boss rings carry an angular SAFE GAP, and that gap is the entire
         * counterplay — without it the attack is unavoidable damage.
         *
         * The gap centre rides in on `e.angle`. While a ring is armed the caster
         * does not use its facing for anything, so the sim repurposes that field
         * as data (server/systems/enemies.ts `armRingGap`/`faceRingGap`). Two
         * consequences:
         *   - read the RAW `e.angle`, never the interpolated `vis.angle` — shortest
         *     arc smoothing would drag the gap across the wall between snapshots.
         *   - RING_GAP_HALF must match the server's constant exactly. One number
         *     can only carry the centre, so both sides agree the half-width.
         */
        const gapC = e.angle;
        const a0 = gapC + RING_GAP_HALF;
        const a1 = gapC - RING_GAP_HALF + TAU;

        if (spec.charging === true) {
          // Not launched yet. Show where the wall will stop, and the wall itself
          // gathering on the caster — already cut, because the gap is rolled at
          // wind-up so you can pick your exit before it moves.
          const extent = new Path2D();
          extent.arc(x, y, reach, a0, a1);
          ctx.setLineDash([26, 20]);
          ctx.lineDashOffset = -this.time * 40;
          this.teleShade(extent, 6, 0);
          ctx.strokeStyle = P.withAlpha(body, 0.22 + 0.3 * a);
          ctx.lineWidth = 3;
          ctx.stroke(extent);
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;

          const r = e.radius + 34 + 30 * g;
          const half = band * (0.22 + 0.5 * g);
          const gathering = Renderer.teleSector(x, y, r - half, r + half, a0, a1);
          this.teleShade(gathering, 5, 0.34);
          ctx.fillStyle = P.withAlpha(body, 0.4 * fillA);
          ctx.fill(gathering);
          ctx.strokeStyle = P.withAlpha(edge, 0.5 + 0.5 * a);
          ctx.lineWidth = W;
          ctx.stroke(gathering);
          break;
        }
        // Live shockwave. `telegraph` is (ringMax - ringR) / ringSpeed, so `g` is
        // the true expansion fraction and this band sits on the real hitbox.
        const r = Math.max(2, reach * g);
        const wave = Renderer.teleSector(x, y, Math.max(1, r - band), r + band, a0, a1);
        this.teleShade(wave, 6, 0.3);
        ctx.fillStyle = P.withAlpha(body, 0.3 * fillA);
        ctx.fill(wave);
        ctx.strokeStyle = P.withAlpha(edge, 0.45 + 0.55 * a);
        ctx.lineWidth = W;
        ctx.stroke(wave);

        const front = new Path2D();
        front.arc(x, y, r, a0, a1);
        ctx.strokeStyle = P.withAlpha(edge, a);
        ctx.lineWidth = WF;
        ctx.stroke(front);
        break;
      }

      case 'tether': {
        const t = e.target !== null ? this.byId.get(e.target) : undefined;
        const tx = t !== undefined ? t.pos.x : x + Math.cos(ang) * reach;
        const ty = t !== undefined ? t.pos.y : y + Math.sin(ang) * reach;
        const link = new Path2D();
        link.moveTo(x, y);
        link.lineTo(tx, ty);
        ctx.setLineDash([12, 9]);
        ctx.lineDashOffset = -this.time * 110;
        this.teleShade(link, 10, 0);
        ctx.strokeStyle = P.withAlpha(edge, 0.5 + 0.5 * a);
        ctx.lineWidth = 3 + 5 * g;
        ctx.stroke(link);
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;

        // Socket closing on the victim's board.
        const socket = new Path2D();
        const sr = 30 - 16 * g;
        for (let k = 0; k < 6; k++) {
          const aa = ang + (k / 6) * TAU;
          const px = tx + Math.cos(aa) * sr;
          const py = ty + Math.sin(aa) * sr;
          if (k === 0) socket.moveTo(px, py);
          else socket.lineTo(px, py);
        }
        socket.closePath();
        this.teleShade(socket, 7, 0.3);
        ctx.strokeStyle = P.withAlpha(edge, 0.4 + 0.6 * a);
        ctx.lineWidth = W;
        ctx.stroke(socket);
        break;
      }

      case 'radial': {
        const n = spec.arms ?? 14;
        const spin = this.time * 0.35;
        const inner = e.radius + 8;
        const outer = inner + (reach - inner) * (0.18 + 0.82 * g);
        const spokes = new Path2D();
        for (let k = 0; k < n; k++) {
          const aa = spin + (k / n) * TAU;
          const c = Math.cos(aa);
          const s = Math.sin(aa);
          spokes.moveTo(x + c * inner, y + s * inner);
          spokes.lineTo(x + c * outer, y + s * outer);
        }
        this.teleShade(spokes, 9, 0);
        ctx.strokeStyle = P.withAlpha(edge, 0.35 + 0.65 * a);
        ctx.lineWidth = 3.5 + 3 * snap;
        ctx.stroke(spokes);

        const hub = Renderer.teleBand(x, y, inner, inner + 12 + 10 * g);
        this.teleShade(hub, 5, 0.35);
        ctx.fillStyle = P.withAlpha(body, 0.5 * fillA);
        ctx.fill(hub, 'evenodd');
        ctx.strokeStyle = P.withAlpha(edge, a);
        ctx.lineWidth = W;
        ctx.stroke(hub);
        break;
      }

      case 'arm': {
        const n = spec.arms ?? 1;
        const hw = spec.halfWidth ?? 16;
        // The choir sweep opens 1.5 rad behind its facing and rotates positive.
        const start = spec.charging === true ? ang - 1.5 : ang;
        for (let k = 0; k < n; k++) {
          const aa = start + (k / n) * TAU;
          const lane = Renderer.teleLane(x, y, aa, reach, hw);
          this.teleShade(lane, W + 4, 0.26);
          ctx.fillStyle = P.withAlpha(body, 0.22 * fillA);
          ctx.fill(lane);
          ctx.strokeStyle = P.withAlpha(edge, 0.5 + 0.5 * a);
          ctx.lineWidth = W;
          ctx.stroke(lane);
          // Where it is going next.
          const swept = new Path2D();
          swept.arc(x, y, reach * 0.72, aa, aa + 0.85);
          ctx.setLineDash([18, 14]);
          ctx.lineDashOffset = -this.time * 70;
          ctx.strokeStyle = P.withAlpha(edge, 0.3 + 0.4 * a);
          ctx.lineWidth = 4;
          ctx.stroke(swept);
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;
        }
        break;
      }

      case 'arena': {
        // Arena-scale mechanic: no dodge exists, so the drawing says "do the
        // mechanic" rather than "move". Two counter-rotating dashed rings plus a
        // hard collar on the boss.
        for (let k = 0; k < 2; k++) {
          const rr = reach * (k === 0 ? 1 : 0.62) * (1 - 0.12 * g);
          const ring = new Path2D();
          ring.arc(x, y, Math.max(2, rr), 0, TAU);
          ctx.setLineDash([34, 26]);
          ctx.lineDashOffset = (k === 0 ? -1 : 1) * this.time * 90;
          this.teleShade(ring, 7, 0);
          ctx.strokeStyle = P.withAlpha(edge, 0.3 + 0.5 * a);
          ctx.lineWidth = 4.5;
          ctx.stroke(ring);
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;
        }
        const halo = Renderer.teleBand(x, y, e.radius + 10, e.radius + 26 + 14 * g);
        this.teleShade(halo, 5, 0.4);
        ctx.fillStyle = P.withAlpha(body, 0.45 * fillA);
        ctx.fill(halo, 'evenodd');
        break;
      }

      case 'guard': {
        // Defensive or vulnerability window: a plated collar, never a blast.
        const dome = new Path2D();
        dome.arc(x, y, reach, 0, TAU);
        this.teleShade(dome, W + 4, 0.16);
        ctx.strokeStyle = P.withAlpha(edge, 0.45 + 0.45 * a);
        ctx.lineWidth = W;
        ctx.stroke(dome);

        const plates = new Path2D();
        const seg = tone === 'weak' ? 0.24 : 0.42; // 'weak' reads as a broken shell
        for (let k = 0; k < 8; k++) {
          const a0 = this.time * (tone === 'weak' ? -0.5 : 0.35) + (k / 8) * TAU;
          plates.moveTo(x + Math.cos(a0) * (reach - 7), y + Math.sin(a0) * (reach - 7));
          plates.arc(x, y, reach - 7, a0, a0 + seg);
        }
        this.teleShade(plates, 8, 0);
        ctx.strokeStyle = P.withAlpha(edge, 0.35 + 0.5 * a);
        ctx.lineWidth = 5;
        ctx.stroke(plates);
        break;
      }

      case 'spawn': {
        const ring = new Path2D();
        ring.arc(x, y, Math.max(2, reach * (0.55 + 0.45 * g)), 0, TAU);
        ctx.setLineDash([16, 13]);
        ctx.lineDashOffset = -this.time * 60;
        this.teleShade(ring, 7, 0);
        ctx.strokeStyle = P.withAlpha(edge, 0.4 + 0.5 * a);
        ctx.lineWidth = 4;
        ctx.stroke(ring);
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;

        const marks = new Path2D();
        const rr = reach * (0.55 + 0.45 * g);
        for (let k = 0; k < 3; k++) {
          const aa = this.time * 0.6 + (k / 3) * TAU;
          const mx = x + Math.cos(aa) * rr;
          const my = y + Math.sin(aa) * rr;
          const s = 9 + 6 * g;
          marks.moveTo(mx - s, my - s);
          marks.lineTo(mx + s, my + s);
          marks.moveTo(mx + s, my - s);
          marks.lineTo(mx - s, my + s);
        }
        this.teleShade(marks, 8, 0);
        ctx.strokeStyle = P.withAlpha(edge, 0.4 + 0.6 * a);
        ctx.lineWidth = 4;
        ctx.stroke(marks);
        break;
      }

      case 'pulse': {
        // A metronome, not a warning. Deliberately quiet: it must never compete
        // with a real windup for attention.
        const q = 0.35 * a;
        const wave = new Path2D();
        wave.arc(x, y, Math.max(2, reach * g), 0, TAU);
        ctx.strokeStyle = P.withAlpha(edge, q * (1 - g * 0.7));
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineWidth = 3;
        ctx.stroke(wave);
        const bound = new Path2D();
        bound.arc(x, y, reach, 0, TAU);
        ctx.setLineDash([8, 14]);
        ctx.strokeStyle = P.withAlpha(edge, 0.16);
        ctx.lineWidth = 2;
        ctx.stroke(bound);
        ctx.setLineDash([]);
        break;
      }

      case 'unknown': {
        // Loud on purpose: an unmapped kind must look like a bug, not a circle.
        const ring = new Path2D();
        ring.arc(x, y, reach, 0, TAU);
        ctx.setLineDash([18, 12]);
        ctx.lineDashOffset = -this.time * 140;
        this.teleShade(ring, 9, 0.28);
        ctx.strokeStyle = P.withAlpha(edge, 0.6 + 0.4 * a);
        ctx.lineWidth = 5;
        ctx.stroke(ring);
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
        const cross = new Path2D();
        const s = reach * 0.5;
        cross.moveTo(x - s, y - s);
        cross.lineTo(x + s, y + s);
        cross.moveTo(x + s, y - s);
        cross.lineTo(x - s, y + s);
        this.teleShade(cross, 9, 0);
        ctx.strokeStyle = P.withAlpha(edge, 0.5 + 0.5 * a);
        ctx.lineWidth = 4;
        ctx.stroke(cross);
        break;
      }

      default: {
        // 'blast' — self-centred detonation. Everything inside the boundary dies.
        const outline = new Path2D();
        outline.arc(x, y, reach, 0, TAU);
        this.teleShade(outline, W + 5, heavy ? 0.5 * fillA + 0.2 : 0.2);

        const grown = new Path2D();
        grown.arc(x, y, Math.max(0.5, reach * g), 0, TAU);
        ctx.fillStyle = P.withAlpha(body, 0.3 * fillA);
        ctx.fill(grown);

        ctx.strokeStyle = P.withAlpha(edge, 0.55 + 0.45 * a);
        ctx.lineWidth = W;
        ctx.stroke(outline);

        ctx.strokeStyle = P.withAlpha(edge, a);
        ctx.lineWidth = WF;
        ctx.stroke(grown);

        if (snap > 0) {
          ctx.strokeStyle = P.withAlpha(P.CORE_WHITE, snap);
          ctx.lineWidth = 3 + 8 * snap;
          ctx.stroke(outline);
        }
        break;
      }
    }

    // Shape-independent wind-up clock. Support pulses are excluded: they repeat
    // forever and a spinning gauge on every friendly summon is pure noise.
    if (!resolving && spec.shape !== 'pulse' && spec.shape !== 'none') {
      this.teleCollar(x, y, rim + 13, p, edge, a);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ================================================================ enemies

  private drawEnemies(): void {
    const ctx = this.ctx;
    const cam = this.camera;
    for (let i = 0; i < this.enemiesL.length; i++) {
      const e = this.enemiesL[i];
      if (!cam.isVisible(e.pos.x, e.pos.y, e.radius * 3)) continue;
      const v = this.vis.get(e.id);
      const color = P.archetypeColor(e.archetype);
      const flash = this.effects.flashOf(e.id);
      const wind = e.telegraph > 0 ? 1 : 0;
      const r = e.radius;

      // Windup swell: the body itself tenses before it strikes.
      const swell = wind === 1 && v !== undefined && v.teleMax > 0 ? 1 + 0.12 * (1 - e.telegraph / v.teleMax) : 1;

      ctx.save();
      ctx.translate(e.pos.x, e.pos.y);
      ctx.rotate(v !== undefined ? v.angle : e.angle);
      ctx.scale(swell, swell);
      this.enemyShape(ctx, e, r, color, flash);
      ctx.restore();

      // additive core, drawn unrotated so the glow stays circular
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.24 + 0.14 * Math.sin(this.time * 4 + e.id);
      ctx.drawImage(S.glowSprite(color, 32), e.pos.x - r * 0.9, e.pos.y - r * 0.9, r * 1.8, r * 1.8);
      if (flash > 0) {
        ctx.globalAlpha = flash * 0.34;
        ctx.drawImage(S.glowSprite(P.CORE_WHITE, 64), e.pos.x - r * 2.2, e.pos.y - r * 2.2, r * 4.4, r * 4.4);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      this.drawStatusRing(e, color);
    }
  }

  /** Distinct, readable silhouette per archetype. Local space: +x is forward. */
  private enemyShape(ctx: CanvasRenderingContext2D, e: EnemyEntity, r: number, color: string, flash: number): void {
    const t = this.time;
    switch (e.archetype) {
      case 'chaser': {
        // aggressive forward dart
        ctx.beginPath();
        ctx.moveTo(r * 1.55, 0);
        ctx.lineTo(-r * 0.45, r * 0.95);
        ctx.lineTo(-r * 0.1, 0);
        ctx.lineTo(-r * 0.45, -r * 0.95);
        ctx.closePath();
        paintBody(ctx, color, flash, 2.2);
        break;
      }
      case 'spitter': {
        // hexagon with an open, glowing maw
        polygon(ctx, 0, 0, r, 6, 0);
        paintBody(ctx, color, flash, 2);
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = P.withAlpha(P.hot(color, 0.5), 0.6 + 0.3 * Math.sin(t * 7));
        ctx.beginPath();
        ctx.moveTo(r * 0.95, 0);
        ctx.lineTo(r * 0.25, r * 0.45);
        ctx.lineTo(r * 0.25, -r * 0.45);
        ctx.closePath();
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        break;
      }
      case 'bulwark': {
        // heavy octagon behind a directional shield plate
        polygon(ctx, 0, 0, r, 8, Math.PI / 8);
        paintBody(ctx, color, flash, 2.6);
        ctx.strokeStyle = P.withAlpha(P.ENERGY_AZURE, 0.85);
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.28, -0.85, 0.85);
        ctx.stroke();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = P.withAlpha(P.ENERGY_AZURE, 0.3);
        ctx.lineWidth = 12;
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
        break;
      }
      case 'splitter': {
        // a body visibly straining to come apart
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, TAU);
        paintBody(ctx, color, flash, 2);
        const sep = 0.24 + 0.1 * Math.sin(t * 3.1 + e.id);
        ctx.strokeStyle = P.withAlpha(P.hot(color, 0.4), 0.75);
        ctx.lineWidth = 1.8;
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * TAU + t * 0.6;
          ctx.beginPath();
          ctx.arc(Math.cos(a) * r * sep, Math.sin(a) * r * sep, r * 0.42, 0, TAU);
          ctx.stroke();
        }
        break;
      }
      case 'sapper': {
        // spiky star — it eats your board, so it reads violet
        ctx.beginPath();
        for (let k = 0; k < 10; k++) {
          const a = (k / 10) * TAU + t * 0.9;
          const rad = k % 2 === 0 ? r * 1.35 : r * 0.55;
          const px = Math.cos(a) * rad;
          const py = Math.sin(a) * rad;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        paintBody(ctx, color, flash, 2);
        break;
      }
      case 'turret': {
        // static base, tracking barrel
        polygon(ctx, 0, 0, r, 8, Math.PI / 8);
        paintBody(ctx, color, flash, 2.4);
        ctx.fillStyle = P.withAlpha(P.CHASSIS, 0.95);
        ctx.strokeStyle = P.withAlpha(color, 0.95);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.rect(r * 0.3, -r * 0.3, r * 1.5, r * 0.6);
        ctx.fill();
        ctx.stroke();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = P.withAlpha(P.DANGER_RED, 0.6 + 0.4 * Math.sin(t * 9));
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.3, 0, TAU);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        break;
      }
      case 'elite':
      case 'boss': {
        const big = e.archetype === 'boss' ? 1.15 : 1;
        polygon(ctx, 0, 0, r * big, 6, t * 0.25);
        paintBody(ctx, color, flash, 3);
        ctx.globalCompositeOperation = 'lighter';
        for (let k = 0; k < 2; k++) {
          const dir = k === 0 ? 1 : -1;
          const rr = r * big * (1.35 + k * 0.3);
          ctx.strokeStyle = P.withAlpha(k === 0 ? color : P.CORE_WHITE, 0.5);
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          for (let s = 0; s < 4; s++) {
            const a0 = t * (0.8 + k * 0.5) * dir + (s / 4) * TAU;
            ctx.arc(0, 0, rr, a0, a0 + 0.9);
            ctx.moveTo(Math.cos(a0 + 1.5) * rr, Math.sin(a0 + 1.5) * rr);
          }
          ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';
        break;
      }
      default: {
        polygon(ctx, 0, 0, r, 5, -Math.PI / 2);
        paintBody(ctx, color, flash, 2);
        break;
      }
    }
  }

  /** Small arc segments around an entity, one per active status. */
  private drawStatusRing(e: Entity, fallback: string): void {
    const list = e.statuses;
    if (list === undefined || list.length === 0) return;
    const ctx = this.ctx;
    const r = e.radius + 7;
    const seg = TAU / list.length;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 2.5;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const a0 = i * seg + this.time * 0.8;
      const pulse = s.remaining < 1 ? 0.4 + 0.6 * Math.abs(Math.sin(this.time * 9)) : 1;
      ctx.strokeStyle = P.withAlpha(P.statusColor(s.kind), 0.85 * pulse);
      ctx.beginPath();
      ctx.arc(e.pos.x, e.pos.y, r, a0, a0 + seg * 0.66);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    void fallback;
  }

  // ================================================================ players

  private drawPlayers(selfId: EntityId): void {
    const ctx = this.ctx;
    const cam = this.camera;
    for (let i = 0; i < this.playersL.length; i++) {
      const p = this.playersL[i];
      if (!cam.isVisible(p.pos.x, p.pos.y, p.radius * 4)) continue;
      const v = this.vis.get(p.id);
      const color = P.roleColor(p.role);
      const r = p.radius;
      const isSelf = p.id === selfId;

      // --- respawning: only a spawn beacon
      if (p.respawnTimer > 0) {
        ctx.globalCompositeOperation = 'lighter';
        const k = 0.4 + 0.6 * Math.abs(Math.sin(this.time * 3));
        ctx.strokeStyle = P.withAlpha(color, 0.35 * k);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.pos.x, p.pos.y, r * (1.6 + 0.5 * k), 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 0.18 * k;
        ctx.drawImage(S.glowSprite(color, 64), p.pos.x - r * 2, p.pos.y - r * 2, r * 4, r * 4);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        continue;
      }

      const flash = this.effects.flashOf(p.id);
      const ghost = v !== undefined && v.ghost > 0 ? 1 : 0;
      const alpha = p.downed ? 0.6 : ghost === 1 ? 0.38 + 0.12 * Math.sin(this.time * 6) : 1;

      // --- dash ring + i-frame shimmer
      if (p.dashing > 0) {
        /*
         * `dashing` is NOT bounded by DASH_DURATION. A dash *ability* sets it to
         * clamp(dist/speed, DASH_MIN_DURATION, DASH_MAX_DURATION) — up to 0.6 s,
         * nearly 4x the plain-dash constant. Left unclamped this ratio exceeds 1,
         * dt01 goes negative, and the arc radius below turns negative: canvas
         * throws IndexSizeError, which escapes render() and silently kills every
         * later pass (projectile heads, particles, nameplates, damage numbers).
         * Clamp so a long ability-dash simply holds the ring at full size until
         * it enters its final DASH_DURATION window.
         */
        const dt01 = clamp01(1 - p.dashing / DASH_DURATION);
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = P.withAlpha(P.hot(color, 0.5), (1 - dt01) * 0.9);
        ctx.lineWidth = 4 * (1 - dt01) + 1;
        ctx.beginPath();
        ctx.arc(p.pos.x, p.pos.y, r * (1 + dt01 * 1.8), 0, TAU);
        ctx.stroke();
        // invulnerable window: a shimmering broken ring you can actually read
        if (p.dashing > DASH_DURATION - DASH_IFRAMES) {
          ctx.strokeStyle = P.withAlpha(P.ENERGY_WHITE, 0.55 + 0.45 * Math.sin(this.time * 60));
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let k = 0; k < 5; k++) {
            const a0 = this.time * 14 + (k / 5) * TAU;
            ctx.arc(p.pos.x, p.pos.y, r * 1.35, a0, a0 + 0.5);
            ctx.moveTo(p.pos.x + Math.cos(a0 + 0.9) * r * 1.35, p.pos.y + Math.sin(a0 + 0.9) * r * 1.35);
          }
          ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';
      }

      ctx.globalAlpha = alpha;

      // --- chassis
      ctx.save();
      ctx.translate(p.pos.x, p.pos.y);
      ctx.rotate(v !== undefined ? v.angle : p.angle);
      ctx.beginPath();
      ctx.moveTo(r * 1.4, 0);
      ctx.lineTo(r * 0.3, r * 0.88);
      ctx.lineTo(-r * 0.85, r * 0.72);
      ctx.lineTo(-r * 0.55, 0);
      ctx.lineTo(-r * 0.85, -r * 0.72);
      ctx.lineTo(r * 0.3, -r * 0.88);
      ctx.closePath();
      paintBody(ctx, p.downed ? P.DANGER_RED : color, flash, 2.4);

      // inner power core
      ctx.globalCompositeOperation = 'lighter';
      const beat = 0.6 + 0.4 * Math.sin(this.time * 3.4 + p.id);
      ctx.fillStyle = P.withAlpha(P.hot(color, 0.7), 0.85 * beat);
      ctx.beginPath();
      ctx.moveTo(r * 0.42, 0);
      ctx.lineTo(0, r * 0.34);
      ctx.lineTo(-r * 0.34, 0);
      ctx.lineTo(0, -r * 0.34);
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();

      // --- rim glow
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * 0.2;
      ctx.drawImage(S.glowSprite(color, 64), p.pos.x - r * 1.7, p.pos.y - r * 1.7, r * 3.4, r * 3.4);
      if (flash > 0.004) {
        ctx.globalAlpha = flash * 0.34;
        ctx.drawImage(S.glowSprite(P.CORE_WHITE, 64), p.pos.x - r * 2.4, p.pos.y - r * 2.4, r * 4.8, r * 4.8);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';

      // --- shield bubble
      if (p.shield > 0) {
        ctx.globalCompositeOperation = 'lighter';
        const sr = r * 1.5;
        ctx.strokeStyle = P.withAlpha(P.STATUS_SHIELD, 0.5 + 0.2 * Math.sin(this.time * 4));
        ctx.lineWidth = 2;
        polygon(ctx, p.pos.x, p.pos.y, sr, 6, this.time * 0.5);
        ctx.stroke();
        ctx.strokeStyle = P.withAlpha(P.STATUS_SHIELD, 0.14);
        ctx.lineWidth = 8;
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      }

      // --- downed: bleed-out ring + revive progress
      if (p.downed) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = P.withAlpha(P.DANGER_RED, 0.45 + 0.45 * Math.abs(Math.sin(this.time * 4)));
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(p.pos.x, p.pos.y, r * 1.9, 0, TAU);
        ctx.stroke();
        if (p.reviveProgress > 0) {
          ctx.strokeStyle = P.withAlpha(P.ENERGY_MINT, 0.95);
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.arc(p.pos.x, p.pos.y, r * 1.9, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, p.reviveProgress));
          ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';
      }

      this.drawStatusRing(p, color);
      ctx.globalAlpha = 1;
      void isSelf;
    }
  }

  // ================================================================ projectiles

  private drawProjectiles(): void {
    const ctx = this.ctx;
    const cam = this.camera;
    ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < this.projectilesL.length; i++) {
      const q = this.projectilesL[i];
      const r = Math.max(4, q.radius);
      if (!cam.isVisible(q.pos.x, q.pos.y, r * 6)) continue;

      const style = projectileStyle(q.ability);
      const color = q.team === 'hostile' ? P.DANGER_ORANGE : P.teamColor(q.team);
      const v = this.vis.get(q.id);
      const ang = v !== undefined ? v.angle : q.angle;
      const len = r * style.len;

      // wide dim halo
      ctx.globalAlpha = 0.32;
      ctx.drawImage(S.haloSprite(color, 64), q.pos.x - r * 3.2, q.pos.y - r * 3.2, r * 6.4, r * 6.4);

      // tapered body along the direction of travel
      ctx.globalAlpha = 1;
      ctx.save();
      ctx.translate(q.pos.x, q.pos.y);
      ctx.rotate(ang);
      const w = r * style.width;
      ctx.fillStyle = P.withAlpha(color, 0.55);
      ctx.beginPath();
      ctx.moveTo(len, 0);
      ctx.lineTo(-len * 0.35, w);
      ctx.lineTo(-len * 0.9, 0);
      ctx.lineTo(-len * 0.35, -w);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = P.withAlpha(P.hot(color, 0.8), 0.95);
      ctx.beginPath();
      ctx.moveTo(len * 0.8, 0);
      ctx.lineTo(-len * 0.2, w * 0.42);
      ctx.lineTo(-len * 0.55, 0);
      ctx.lineTo(-len * 0.2, -w * 0.42);
      ctx.closePath();
      ctx.fill();

      if (style.spin) {
        ctx.strokeStyle = P.withAlpha(P.hot(color, 0.4), 0.7);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.9, this.time * 9, this.time * 9 + 2.2);
        ctx.stroke();
      }
      ctx.restore();

      // tight bright core
      ctx.globalAlpha = 1;
      ctx.drawImage(S.glowSprite(P.hot(color, 0.6), 32), q.pos.x - r * 0.9, q.pos.y - r * 0.9, r * 1.8, r * 1.8);

      if (style.embers && Math.random() < 0.5) {
        this.particles.trailMote(q.pos.x, q.pos.y, color, r * 0.7, 0.3);
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ================================================================ aim

  private drawAim(view: RenderView): void {
    const self = this.byId.get(view.selfId);
    if (self === undefined || self.kind !== 'player' || self.respawnTimer > 0) return;
    const ctx = this.ctx;
    const aim = view.aim;
    const dx = aim.x - self.pos.x;
    const dy = aim.y - self.pos.y;
    const d = Math.hypot(dx, dy);
    if (d < 1) return;
    const nx = dx / d;
    const ny = dy / d;
    const color = P.roleColor(self.role);

    ctx.globalCompositeOperation = 'lighter';

    // dotted lead line starting just outside the chassis
    ctx.setLineDash([7, 11]);
    ctx.lineDashOffset = -this.time * 60;
    ctx.strokeStyle = P.withAlpha(color, 0.4);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(self.pos.x + nx * (self.radius + 8), self.pos.y + ny * (self.radius + 8));
    ctx.lineTo(aim.x - nx * 16, aim.y - ny * 16);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // facing chevron hugging the hull
    ctx.strokeStyle = P.withAlpha(P.hot(color, 0.6), 0.9);
    ctx.lineWidth = 3;
    const cr = self.radius + 12;
    const ca = Math.atan2(ny, nx);
    ctx.beginPath();
    ctx.arc(self.pos.x, self.pos.y, cr, ca - 0.36, ca + 0.36);
    ctx.stroke();

    // reticle
    const spin = this.time * 1.6;
    ctx.strokeStyle = P.withAlpha(color, 0.85);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const a0 = spin + (k / 4) * TAU;
      ctx.arc(aim.x, aim.y, 13, a0, a0 + 0.6);
      ctx.moveTo(aim.x + Math.cos(a0 + 1.2) * 13, aim.y + Math.sin(a0 + 1.2) * 13);
    }
    ctx.stroke();
    ctx.fillStyle = P.withAlpha(P.CORE_WHITE, 0.9);
    ctx.beginPath();
    ctx.arc(aim.x, aim.y, 1.8, 0, TAU);
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
  }

  // ================================================================ nameplates

  /** Names and HP, drawn in SCREEN space so text stays pixel-crisp at any zoom. */
  private drawNameplates(selfId: EntityId): void {
    const ctx = this.ctx;
    const cam = this.camera;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < this.playersL.length; i++) {
      const p = this.playersL[i];
      if (p.respawnTimer > 0) continue;
      const sx = cam.toScreenX(p.pos.x, p.pos.y);
      const sy = cam.toScreenY(p.pos.x, p.pos.y) - (p.radius + 20) * cam.zoom;
      if (sx < -90 || sx > this.width + 90 || sy < -40 || sy > this.height + 40) continue;

      const v = this.vis.get(p.id);
      const hp = v !== undefined ? v.hpShown : p.hp;
      const frac = p.maxHp > 0 ? Math.max(0, Math.min(1, hp / p.maxHp)) : 0;
      const w = 52;
      const h = 5;
      const isSelf = p.id === selfId;

      // name
      ctx.font = `600 ${isSelf ? 12.5 : 11.5}px ${FONT}`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = P.withAlpha(P.TEXT_SHADOW, 0.9);
      ctx.strokeText(p.name, sx, sy - 9);
      ctx.fillStyle = isSelf ? P.TEXT_BRIGHT : P.TEXT_PRIMARY;
      ctx.fillText(p.name, sx, sy - 9);

      // hp track
      ctx.fillStyle = P.withAlpha(P.HP_TRACK, 0.85);
      ctx.fillRect(sx - w / 2, sy, w, h);
      ctx.fillStyle = P.hpColor(frac);
      ctx.fillRect(sx - w / 2, sy, w * frac, h);
      // shield overlaid on top of the same track
      if (p.shield > 0 && p.maxHp > 0) {
        const sf = Math.max(0, Math.min(1, p.shield / p.maxHp));
        ctx.fillStyle = P.withAlpha(P.SHIELD_BAR, 0.85);
        ctx.fillRect(sx - w / 2, sy - 2, w * sf, 2);
      }
      ctx.strokeStyle = P.withAlpha(P.HP_FRAME, 0.9);
      ctx.lineWidth = 1;
      ctx.strokeRect(sx - w / 2 - 0.5, sy - 0.5, w + 1, h + 1);

      // role pip
      ctx.fillStyle = P.roleColor(p.role);
      ctx.fillRect(sx - w / 2 - 6, sy, 3, h);
    }

    // damaged enemies get a slim bar, no name
    for (let i = 0; i < this.enemiesL.length; i++) {
      const e = this.enemiesL[i];
      if (e.hp >= e.maxHp || e.maxHp <= 0) continue;
      const sx = cam.toScreenX(e.pos.x, e.pos.y);
      const sy = cam.toScreenY(e.pos.x, e.pos.y) - (e.radius + 12) * cam.zoom;
      if (sx < -60 || sx > this.width + 60 || sy < -20 || sy > this.height + 20) continue;
      const v = this.vis.get(e.id);
      const hp = v !== undefined ? v.hpShown : e.hp;
      const frac = Math.max(0, Math.min(1, hp / e.maxHp));
      const w = Math.max(20, Math.min(60, e.radius * 2.2 * cam.zoom));
      ctx.fillStyle = P.withAlpha(P.HP_TRACK, 0.8);
      ctx.fillRect(sx - w / 2, sy, w, 3);
      ctx.fillStyle = P.archetypeColor(e.archetype);
      ctx.fillRect(sx - w / 2, sy, w * frac, 3);
    }
  }

  // ================================================================ screen dressing

  private drawOverlay(selfId: EntityId): void {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;

    // vignette
    ctx.fillStyle = S.vignette(ctx, w, h);
    ctx.fillRect(0, 0, w, h);

    // scanlines
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = S.tilePattern(ctx, S.scanlines());
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;

    // sensor grain — cheap, and it glues the whole image together
    if (this.quality >= 1) {
      const g = S.grain();
      const ox = -(Math.random() * g.width) | 0;
      const oy = -(Math.random() * g.height) | 0;
      ctx.save();
      ctx.globalAlpha = 0.05;
      ctx.translate(ox, oy);
      ctx.fillStyle = S.tilePattern(ctx, g);
      ctx.fillRect(-ox, -oy, w, h);
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    // low-health warning: the whole jack-in starts bleeding red
    const self = this.byId.get(selfId);
    if (self !== undefined && self.kind === 'player' && !self.downed && self.respawnTimer <= 0 && self.maxHp > 0) {
      const frac = self.hp / self.maxHp;
      if (frac < 0.35) {
        const k = (1 - frac / 0.35) * (0.45 + 0.55 * Math.abs(Math.sin(this.realTime * 3.4)));
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = k * 0.85;
        ctx.fillStyle = S.edgeGlow(ctx, w, h, P.DANGER_RED);
        ctx.fillRect(0, 0, w, h);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  /**
   * Chromatic aberration impulse. Only runs on impact frames, and at half
   * resolution, so the steady-state cost is zero.
   */
  private drawAberration(): void {
    const amt = this.effects.aberration;
    if (amt <= 0.03 || this.quality <= 0 || this.fxA === null || this.fxB === null) return;
    const ctx = this.ctx;
    const bw = this.canvas.width;
    const bh = this.canvas.height;
    const fa = this.fxA.getContext('2d');
    const fb = this.fxB.getContext('2d');
    if (fa === null || fb === null) return;
    const fw = this.fxA.width;
    const fh = this.fxA.height;

    fa.globalCompositeOperation = 'source-over';
    fa.clearRect(0, 0, fw, fh);
    fa.drawImage(this.canvas, 0, 0, fw, fh);
    fb.globalCompositeOperation = 'source-over';
    fb.clearRect(0, 0, fw, fh);
    fb.drawImage(this.fxA, 0, 0);

    fa.globalCompositeOperation = 'multiply';
    fa.fillStyle = P.ABERRATION_WARM;
    fa.fillRect(0, 0, fw, fh);
    fa.globalCompositeOperation = 'source-over';

    fb.globalCompositeOperation = 'multiply';
    fb.fillStyle = P.ABERRATION_COOL;
    fb.fillRect(0, 0, fw, fh);
    fb.globalCompositeOperation = 'source-over';

    const off = amt * 7 * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = amt * 0.3;
    ctx.drawImage(this.fxA, -off, 0, bw, bh);
    ctx.drawImage(this.fxB, off, 0, bw, bh);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // ================================================================ events

  /**
   * Drain `world.events` into the VFX layer.
   *
   * `client/main.ts` already emits each event exactly once (it tracks
   * `drainedUntil`), so this consumes unconditionally. The identity guard below
   * only protects a caller that hands us the *same array instance* twice in a
   * row, which would otherwise double-fire every impact.
   *
   * Every `GameEvent` variant is handled — `Effects.ingest` switches
   * exhaustively over the union.
   */
  private consumeEvents(world: WorldState, selfId: EntityId): void {
    const events = world.events;
    if (events === undefined || events.length === 0) {
      this.lastEvents = events;
      return;
    }
    if (events === this.lastEvents) return;
    this.lastEvents = events;

    // Ability-specific entity state the snapshot cannot express: Ghostwalk
    // fades the Phantom's silhouette for the ability's real duration.
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.t !== 'cast' || e.ability !== 'ghostwalk') continue;
      const caster = this.byId.get(e.caster);
      if (caster === undefined) continue;
      const v = this.vis.get(caster.id);
      const def = safeAbility('ghostwalk');
      if (v !== undefined) v.ghost = def !== null && def.duration > 0 ? def.duration : 3.5;
    }

    this.effects.ingest(events, world, selfId, this.camera);
  }
}

// ================================================================ shape helpers

/** Build a regular polygon path (does not fill or stroke). */
function polygon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, sides: number, rot: number): void {
  ctx.beginPath();
  for (let k = 0; k < sides; k++) {
    const a = rot + (k / sides) * TAU;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (k === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * Paint the current path as a chassis: dark solid body, tinted outline, a wide
 * additive rim (the layered-glow trick applied to a silhouette), and a white
 * hit-flash overlay. Leaves the path intact.
 */
function paintBody(ctx: CanvasRenderingContext2D, color: string, flash: number, lineWidth: number): void {
  ctx.fillStyle = P.withAlpha(P.CHASSIS, 0.93);
  ctx.fill();

  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = P.withAlpha(color, 0.16);
  ctx.lineWidth = lineWidth * 4;
  ctx.stroke();
  ctx.strokeStyle = P.withAlpha(color, 0.4);
  ctx.lineWidth = lineWidth * 2;
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';

  ctx.strokeStyle = P.withAlpha(P.hot(color, 0.25), 0.95);
  ctx.lineWidth = lineWidth;
  ctx.stroke();

  if (flash > 0.004) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = P.withAlpha(P.CORE_WHITE, flash * 0.85);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
}

interface ProjectileStyle {
  /** Body length as a multiple of the projectile radius. */
  len: number;
  /** Body half-width as a multiple of the projectile radius. */
  width: number;
  /** Draw an orbiting arc (homing / unstable rounds). */
  spin: boolean;
  /** Shed ember motes as it travels. */
  embers: boolean;
}

const PROJECTILE_STYLES: Record<string, ProjectileStyle> = {
  // Breaker — heavy ordnance reads slow and fat
  ord_round: { len: 2.2, width: 1.0, spin: false, embers: true },
  siege_shell: { len: 2.4, width: 1.15, spin: false, embers: true },
  rail_lance: { len: 6.5, width: 0.4, spin: false, embers: false },
  thermite: { len: 2.0, width: 0.95, spin: false, embers: true },
  slug_shot: { len: 2.8, width: 0.6, spin: false, embers: false },
  sunder: { len: 3.0, width: 0.8, spin: false, embers: false },
  // Bulwark
  scatter_burst: { len: 2.0, width: 0.7, spin: false, embers: false },
  slag_lob: { len: 1.9, width: 1.05, spin: true, embers: true },
  tether_spike: { len: 4.2, width: 0.5, spin: false, embers: false },
  // Conduit — support ordnance is light and precise
  sig_mote: { len: 1.6, width: 1.0, spin: true, embers: false },
  flux_bolt: { len: 3.2, width: 0.6, spin: false, embers: false },
  ion_tether: { len: 4.0, width: 0.45, spin: true, embers: false },
  // Phantom — thin, fast, mean
  rift_slash: { len: 4.5, width: 0.45, spin: false, embers: false },
  splinter: { len: 3.6, width: 0.4, spin: false, embers: false },
  phase_lance: { len: 7.0, width: 0.38, spin: false, embers: false },
  void_mark: { len: 2.2, width: 0.8, spin: true, embers: false },
};

const DEFAULT_PROJECTILE_STYLE: ProjectileStyle = { len: 2.6, width: 0.7, spin: false, embers: false };

function projectileStyle(ability: string): ProjectileStyle {
  const s = PROJECTILE_STYLES[ability];
  return s !== undefined ? s : DEFAULT_PROJECTILE_STYLE;
}

// ================================================================ telegraph table

/**
 * The primitive a windup is drawn as. Each one answers a different question,
 * and the answer must match what the server actually does to you:
 *
 *   blast   self-centred circle        "everything inside this dies"
 *   cone    wedge along facing         "get out of the arc — sideways works"
 *   lane    capsule along facing       "get off the line"
 *   aimed   capsule locked on a victim "this one is for you, break the angle"
 *   ring    expanding band             "the wall is moving, cross it or outrun it"
 *   tether  dashed link to a victim    "it is eating your board, not your HP"
 *   radial  360-degree spoke burst     "no safe angle, only safe distance"
 *   arm     rotating beam arm          "it is sweeping — move with the rotation"
 *   arena   arena-scale boss event     "positioning will not save you; do the mechanic"
 *   guard   defensive / invuln window  "not incoming damage — stop feeding it"
 *   spawn   reinforcements landing     "bodies arrive here"
 *   pulse   repeating summon pulse     "friendly metronome, or a hostile emplacement"
 */
type TeleShape =
  | 'none'
  | 'blast'
  | 'cone'
  | 'lane'
  | 'aimed'
  | 'ring'
  | 'tether'
  | 'radial'
  | 'arm'
  | 'arena'
  | 'guard'
  | 'spawn'
  | 'pulse'
  | 'unknown';

/** How a telegraph reads. Only `danger` means "this is about to hurt you". */
type TeleTone = 'danger' | 'guard' | 'support' | 'weak';

interface TeleSpec {
  shape: TeleShape;
  /** reach = base + perRadius * entity.radius, world units. Mirrors the sim. */
  base: number;
  perRadius?: number;
  /** Wedge half-angle in radians (`cone`). */
  halfArc?: number;
  /** Half-thickness of a lane/arm in world units. Defaults to the body radius. */
  halfWidth?: number;
  /** Shockwave band half-thickness. `EnemySystem.updateRing` uses 58. */
  band?: number;
  /** Spoke count (`radial`) or arm count (`arm`). */
  arms?: number;
  /** A shockwave that has not left the caster yet (windup, not expansion). */
  charging?: boolean;
  /** `aimed` only: the move fires once per living enemy player, not once total. */
  multi?: boolean;
  /** Overrides the allegiance-derived tone. */
  tone?: TeleTone;
}

/**
 * EXHAUSTIVE map of every `telegraphKind` the server emits onto a shape that
 * matches its real hit geometry. Keys are grouped by the enemy that emits them;
 * each comment cites the sim code the numbers come from
 * (`server/systems/enemies.ts` — read it before changing a number here).
 *
 * Anything not in this table renders as `unknown` — loud magenta, dashed, with a
 * one-time console warning naming the kind. A new enemy move is therefore
 * impossible to miss instead of silently degrading to a circle.
 */
const TELEGRAPHS: Record<string, TeleSpec> = {
  // no windup at all (idle, shunt, spent vent)
  '': { shape: 'none', base: 0 },

  // ---- trash roster -------------------------------------------------------
  /** spitter: leads a slug at you; attackRange 460. Directional, dodge sideways. */
  aim: { shape: 'aimed', base: 460, halfWidth: 14 },
  /** chaser: commits a 0.26 s dash at 720 u/s, then meleeStrike(r + 30, arc 1.1). */
  lunge: { shape: 'lane', base: 217, perRadius: 1, halfWidth: 30 },
  /** burster: radialStrike(96) centred on itself. */
  detonate: { shape: 'blast', base: 96 },
  /** splitter: radialStrike(r + 62). */
  burst: { shape: 'blast', base: 62, perRadius: 1 },
  /** turret: beamStrike(angle, 620, width 16) — a hard line you must leave. */
  beam: { shape: 'lane', base: 620, halfWidth: 16 },
  /** sapper: reaches 78 and burns a cell out of your Weave. Not HP damage. */
  sap: { shape: 'tether', base: 78, tone: 'weak' },
  /** bulwark: meleeStrike(r + 58, halfArc 1.0). */
  slam: { shape: 'cone', base: 58, perRadius: 1, halfArc: 1.0 },
  /** elite: 3 shots at +/-0.16 rad plus a chill wash over halfArc 0.5 out to 260. */
  elite_volley: { shape: 'cone', base: 320, halfArc: 0.5 },
  /** elite: meleeStrike(r + 72, halfArc 1.35) with burn. */
  elite_cleave: { shape: 'cone', base: 72, perRadius: 1, halfArc: 1.35 },
  /** elite: one-shot shield phase at 55% hp. Nothing is incoming — stop shooting. */
  elite_shield: { shape: 'guard', base: 22, perRadius: 1.7, tone: 'guard' },
  /** vent: radialStrike(155) on a slow cycle. */
  vent: { shape: 'blast', base: 155 },
  /** vent: spent and cooling. Carries telegraph 0, so this only shows on resolve. */
  vent_open: { shape: 'guard', base: 30, perRadius: 1, tone: 'weak' },

  // ---- summons (either side; allegiance picks the tone) --------------------
  /** ward_pylon / decoy_echo / hostile summon: pulses hostiles inside ~230. */
  summonAttack: { shape: 'pulse', base: 230 },
  /** sanctum_node / friendly summon: heals allies inside ~230. Never a threat. */
  summonPulse: { shape: 'pulse', base: 230, tone: 'support' },

  // ---- BOSS: the Choirmaster ----------------------------------------------
  /** 10-18 notes fired across the full circle: no safe angle, only safe distance. */
  choir_hymn: { shape: 'radial', base: 600, arms: 14 },
  /** drops 3 adds in a 130-unit ring around itself. */
  choir_summon: { shape: 'spawn', base: 130, tone: 'weak' },
  /** winding up the sweep: the arm starts 1.5 rad behind its facing. */
  choir_sweep: { shape: 'arm', base: 720, halfWidth: 16, arms: 1, charging: true },
  /** live sweep: beamStrike(sweepAngle, 720, width 16) rotating ~3 rad. */
  choir_sweep_live: { shape: 'arm', base: 720, halfWidth: 16, arms: 1 },
  /** startRing(dmg 30, speed 460, max 560) with an angular safe gap. */
  choir_wail: { shape: 'ring', base: 560, band: 58 },
  /** relay-seal gate: invulnerable, and the fight is now a routing puzzle. */
  choir_seal: { shape: 'arena', base: 560, tone: 'guard' },
  /** relay solved: vulnerability window. Dump everything. */
  choir_stagger: { shape: 'guard', base: 26, perRadius: 1.9, tone: 'weak' },

  // ---- BOSS: the Fracture -------------------------------------------------
  /** phase gate: invulnerable, scrambles every board, then throws a shockwave. */
  fracture_rift: { shape: 'arena', base: 900, tone: 'guard' },
  /** post-rift punish ring: startRing(24, speed 700, max 900). */
  fracture_shock: { shape: 'ring', base: 900, band: 58 },
  /** startRing(22+, speed 420+, max 980) with a safe gap. */
  fracture_ring: { shape: 'ring', base: 980, band: 58 },
  /** 3-6 arms x 4 orbs across the full circle. */
  fx_orbs: { shape: 'radial', base: 700, arms: 16 },
  /** one lance per living player — the one aimed at you is the one that matters. */
  fx_lance: { shape: 'aimed', base: 800, halfWidth: 18, multi: true },
  /** charging the gapped shockwave; it has not left the boss yet. */
  fx_ring: { shape: 'ring', base: 980, band: 58, charging: true },
  /**
   * The Fracture, phase 2+: twin beams sweeping out of the body at `angle` and
   * `angle + PI`, 640 long, 13 dmg on a 0.7 s re-hit. Live damage rather than a
   * wind-up — the sim pins `telegraph` at 0.5 s while they turn, so `p` stays
   * near 0 and the lane reads as permanently armed, which it is.
   */
  fx_arms: { shape: 'arm', base: 640, halfWidth: 18, arms: 2 },
  /** blinks next to a player, then radialStrike(185). */
  fx_blink: { shape: 'blast', base: 185 },
  /** plants 3 turrets on the arena anchors. */
  fx_sentries: { shape: 'spawn', base: 260, tone: 'weak' },
};

const TELEGRAPH_TABLE = new Map<string, TeleSpec>(Object.entries(TELEGRAPHS));

/** Deliberately loud: an unmapped kind must look wrong, not merely generic. */
const UNKNOWN_TELEGRAPH: TeleSpec = { shape: 'unknown', base: 110 };

const telegraphWarned = new Set<string>();

/** Resolve a `telegraphKind` to its spec. Unmapped kinds warn once, then shout. */
function telegraphSpec(kind: string): TeleSpec {
  const hit = TELEGRAPH_TABLE.get(kind);
  if (hit !== undefined) return hit;
  if (!telegraphWarned.has(kind)) {
    telegraphWarned.add(kind);
    console.warn(
      `[render] telegraphKind "${kind}" is not in TELEGRAPHS (client/render/renderer.ts) — ` +
        'drawing the UNKNOWN placeholder. Add it with the shape that matches its hit geometry.',
    );
  }
  return UNKNOWN_TELEGRAPH;
}

/** How far the windup reaches, in world units. */
function telegraphReach(e: EnemyEntity, spec: TeleSpec): number {
  return spec.base + (spec.perRadius ?? 0) * e.radius;
}

/** Palette per tone. Only `danger` uses the warm "this will hurt" ramp. */
const TELE_TONES: Record<TeleTone, { edge: string; hot: string; fill: string }> = {
  danger: { edge: P.DANGER_ORANGE, hot: P.DANGER_RED, fill: P.DANGER_ORANGE },
  guard: { edge: P.ENERGY_AZURE, hot: P.ENERGY_WHITE, fill: P.ENERGY_AZURE },
  support: { edge: P.ENERGY_MINT, hot: P.ENERGY_WHITE, fill: P.ENERGY_MINT },
  weak: { edge: P.WARN_YELLOW, hot: P.CORE_WHITE, fill: P.WARN_YELLOW },
};

/**
 * The cut-out colour. Telegraphs are drawn additively over a floor full of
 * decorative cyan arcs; without a dark ground underneath, a thin warm stroke
 * over a bright conduit is invisible. Every telegraph lays this down first.
 */
const TELE_SHADE = '#02040a';

/** The unmapped-kind placeholder never borrows a real tone. */
const TELE_UNKNOWN_PAL = { edge: P.HAZARD_MAGENTA, hot: P.CORE_WHITE, fill: P.HAZARD_MAGENTA };

/** Zones inherit their owner's read: mint for support, warm for hazards. */
// ================================================================ demo harness

const DEMO_ROLES: RoleId[] = ['breaker', 'bulwark', 'conduit', 'phantom'];
const DEMO_NAMES = ['NOX', 'HALCYON', 'VIREO', 'SABLE', 'KESTREL', 'ORRERY', 'TALLOW', 'MIRE'];
const DEMO_ARCHETYPES = ['chaser', 'spitter', 'bulwark', 'splitter', 'sapper', 'turret', 'elite'];
/** Real `telegraphKind` values, index-matched to DEMO_ARCHETYPES. */
const DEMO_TELEGRAPHS = ['lunge', 'aim', 'slam', 'burst', 'sap', 'beam', 'elite_cleave'];
const DEMO_PROJECTILES = ['slug_shot', 'rail_lance', 'ord_round', 'sig_mote', 'splinter', 'flux_bolt', 'phase_lance'];

interface DemoEnemyBrain {
  windup: number;
  cooldown: number;
  timer: number;
  orbit: number;
}

interface DemoState {
  world: WorldState;
  players: PlayerEntity[];
  enemies: EnemyEntity[];
  brains: DemoEnemyBrain[];
  projectiles: ProjectileEntity[];
  zones: ZoneEntity[];
  rng: () => number;
  t: number;
  tickAcc: number;
  boomAcc: number;
  nextId: number;
}

function demoPlayer(id: number, rng: () => number): PlayerEntity {
  const role = DEMO_ROLES[id % DEMO_ROLES.length];
  const loadout = defaultLoadout(role);
  return {
    id,
    kind: 'player',
    pos: { x: 300 + rng() * (ARENA_W - 600), y: 260 + rng() * (ARENA_H - 520) },
    vel: { x: 0, y: 0 },
    radius: PLAYER_RADIUS,
    team: id % 2 === 0 ? 'a' : 'b',
    hp: 60 + rng() * 40,
    maxHp: 100,
    angle: rng() * TAU,
    statuses: [],
    dead: false,
    playerId: 'demo-' + id,
    name: DEMO_NAMES[id % DEMO_NAMES.length],
    role,
    loadout,
    weave: createBoard(5, loadout, 1000 + id),
    shield: id % 3 === 0 ? 24 : 0,
    dashCooldown: 0,
    dashing: 0,
    downed: false,
    downedTimer: 0,
    reviveProgress: 0,
    respawnTimer: 0,
    score: 0,
    kills: 0,
    deaths: 0,
    ping: 40,
    connected: true,
  };
}

function demoEnemy(id: number, index: number, rng: () => number): EnemyEntity {
  const archetype = DEMO_ARCHETYPES[index % DEMO_ARCHETYPES.length];
  const big = archetype === 'elite' || archetype === 'bulwark';
  return {
    id,
    kind: 'enemy',
    pos: { x: 160 + rng() * (ARENA_W - 320), y: 160 + rng() * (ARENA_H - 320) },
    vel: { x: 0, y: 0 },
    radius: big ? ENEMY_RADIUS_DEFAULT * 1.6 : ENEMY_RADIUS_DEFAULT,
    team: 'hostile',
    hp: 40 + rng() * 60,
    maxHp: 100,
    angle: rng() * TAU,
    statuses: [],
    dead: false,
    archetype,
    aiState: 'hunt',
    telegraph: 0,
    telegraphKind: DEMO_TELEGRAPHS[index % DEMO_TELEGRAPHS.length],
    target: null,
  };
}

function demoProjectile(id: number, index: number, rng: () => number): ProjectileEntity {
  const a = rng() * TAU;
  const speed = 280 + rng() * 340;
  return {
    id,
    kind: 'projectile',
    pos: { x: 200 + rng() * (ARENA_W - 400), y: 200 + rng() * (ARENA_H - 400) },
    vel: { x: Math.cos(a) * speed, y: Math.sin(a) * speed },
    radius: 7,
    team: index % 3 === 0 ? 'hostile' : index % 2 === 0 ? 'a' : 'b',
    hp: 1,
    maxHp: 1,
    angle: a,
    statuses: [],
    dead: false,
    ability: DEMO_PROJECTILES[index % DEMO_PROJECTILES.length],
    owner: 1,
    life: 99,
    pierced: [],
  };
}

function demoZone(id: number, index: number, ability: string, rng: () => number): ZoneEntity {
  return {
    id,
    kind: 'zone',
    pos: { x: 300 + rng() * (ARENA_W - 600), y: 300 + rng() * (ARENA_H - 600) },
    vel: { x: 0, y: 0 },
    radius: 90 + rng() * 70,
    team: index % 2 === 0 ? 'a' : 'hostile',
    hp: 1,
    maxHp: 1,
    angle: 0,
    statuses: [],
    dead: false,
    ability,
    owner: 1,
    life: 999,
    tickAccumulator: 0,
  };
}

/** Advance the fake world. Wall-clock only — this never touches the real sim. */
function stepDemo(d: DemoState, dt: number): void {
  d.t += dt;
  const rng = d.rng;

  // ---- players: lissajous patrol, occasional dash
  for (let i = 0; i < d.players.length; i++) {
    const p = d.players[i];
    const ph = d.t * (0.18 + i * 0.035) + i * 1.7;
    const tx = ARENA_W / 2 + Math.cos(ph) * (300 + i * 55);
    const ty = ARENA_H / 2 + Math.sin(ph * 1.37 + i) * (200 + i * 32);
    const dx = tx - p.pos.x;
    const dy = ty - p.pos.y;
    const dist = Math.hypot(dx, dy) || 1;
    const speed = p.dashing > 0 ? 900 : MOVE_SPEED * (0.7 + 0.3 * Math.sin(d.t + i));
    p.vel.x = (dx / dist) * speed;
    p.vel.y = (dy / dist) * speed;
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    p.angle = Math.atan2(dy, dx);
    if (p.dashing > 0) p.dashing = Math.max(0, p.dashing - dt);
    p.hp = 20 + 80 * (0.5 + 0.5 * Math.sin(d.t * 0.4 + i * 2));
  }

  // ---- enemies: converge on the nearest player, cycle a telegraph
  for (let i = 0; i < d.enemies.length; i++) {
    const e = d.enemies[i];
    const b = d.brains[i];
    let best: PlayerEntity | null = null;
    let bestD = Infinity;
    for (let k = 0; k < d.players.length; k++) {
      const dd = (d.players[k].pos.x - e.pos.x) ** 2 + (d.players[k].pos.y - e.pos.y) ** 2;
      if (dd < bestD) {
        bestD = dd;
        best = d.players[k];
      }
    }
    if (best !== null) {
      e.target = best.id;
      const dx = best.pos.x - e.pos.x;
      const dy = best.pos.y - e.pos.y;
      const dist = Math.hypot(dx, dy) || 1;
      const stand = e.archetype === 'turret' ? 1 : 0;
      const orbit = b.orbit;
      const desired = 150 + orbit * 90;
      const push = dist > desired ? 1 : -0.35;
      const sp = stand === 1 ? 0 : (70 + orbit * 40) * push;
      e.vel.x = (dx / dist) * sp - (dy / dist) * 40 * orbit;
      e.vel.y = (dy / dist) * sp + (dx / dist) * 40 * orbit;
      e.pos.x += e.vel.x * dt;
      e.pos.y += e.vel.y * dt;
      e.angle = Math.atan2(dy, dx);
    }
    e.pos.x = Math.max(40, Math.min(ARENA_W - 40, e.pos.x));
    e.pos.y = Math.max(40, Math.min(ARENA_H - 40, e.pos.y));

    b.timer -= dt;
    if (e.telegraph > 0) {
      e.telegraph = Math.max(0, e.telegraph - dt);
      if (e.telegraph === 0) {
        e.aiState = 'recover';
        b.timer = b.cooldown;
      }
    } else if (b.timer <= 0) {
      e.telegraph = b.windup;
      e.aiState = 'windup';
    }
    e.hp = 15 + 85 * (0.5 + 0.5 * Math.sin(d.t * 0.6 + i));
  }

  // ---- projectiles bounce inside the arena
  for (let i = 0; i < d.projectiles.length; i++) {
    const q = d.projectiles[i];
    q.pos.x += q.vel.x * dt;
    q.pos.y += q.vel.y * dt;
    if (q.pos.x < 20 || q.pos.x > ARENA_W - 20) {
      q.vel.x *= -1;
      q.pos.x = Math.max(20, Math.min(ARENA_W - 20, q.pos.x));
    }
    if (q.pos.y < 20 || q.pos.y > ARENA_H - 20) {
      q.vel.y *= -1;
      q.pos.y = Math.max(20, Math.min(ARENA_H - 20, q.pos.y));
    }
    q.angle = Math.atan2(q.vel.y, q.vel.x);
  }

  // ---- emit a fresh event batch at the real 20 Hz tick rate
  d.tickAcc += dt;
  if (d.tickAcc < 0.05) return;
  d.tickAcc -= 0.05;
  d.world.tick++;

  const events: GameEvent[] = [];

  // steady stream of hits
  if (rng() < 0.3) {
    const q = d.projectiles[(rng() * d.projectiles.length) | 0];
    const victim = rng() < 0.5 ? d.enemies[(rng() * d.enemies.length) | 0] : d.players[(rng() * d.players.length) | 0];
    const crit = rng() < 0.16;
    events.push({
      t: 'hit',
      pos: { x: victim.pos.x + (rng() * 2 - 1) * victim.radius, y: victim.pos.y + (rng() * 2 - 1) * victim.radius },
      damage: crit ? 26 + rng() * 22 : 5 + rng() * 16,
      crit,
      target: victim.id,
    });
    void q;
  }

  // casts, cycling through every ability shape
  if (rng() < 0.24) {
    const caster = d.players[(rng() * d.players.length) | 0];
    const ability = caster.loadout[(rng() * caster.loadout.length) | 0] ?? 'slug_shot';
    events.push({ t: 'cast', pos: { x: caster.pos.x, y: caster.pos.y }, ability, caster: caster.id, angle: caster.angle });
    events.push({ t: 'sfx', name: 'cast_' + ability, pos: { x: caster.pos.x, y: caster.pos.y } });
  }

  // dashes
  if (rng() < 0.12) {
    const p = d.players[(rng() * d.players.length) | 0];
    const a = rng() * TAU;
    const to = { x: p.pos.x + Math.cos(a) * 150, y: p.pos.y + Math.sin(a) * 150 };
    events.push({ t: 'dash', from: { x: p.pos.x, y: p.pos.y }, to, entity: p.id });
    p.dashing = DASH_DURATION;
  }

  // weave chatter
  if (rng() < 0.18) {
    const p = d.players[(rng() * d.players.length) | 0];
    events.push({ t: 'weavePower', player: p.playerId, connected: rng() < 0.6, slot: (rng() * 3) | 0 });
  }
  if (rng() < 0.14) {
    const p = d.players[(rng() * d.players.length) | 0];
    events.push({ t: 'slotCharged', player: p.playerId, slot: (rng() * 3) | 0 });
  }
  if (rng() < 0.03) {
    const p = d.players[(rng() * d.players.length) | 0];
    events.push({ t: 'revive', player: p.playerId, by: d.players[0].playerId });
  }

  // periodic detonations: an enemy dies, respawns elsewhere
  d.boomAcc += 0.05;
  if (d.boomAcc > 2.4) {
    d.boomAcc = 0;
    const victim = d.enemies[(rng() * d.enemies.length) | 0];
    events.push({ t: 'death', pos: { x: victim.pos.x, y: victim.pos.y }, entity: victim.id, kind: 'enemy' });
    events.push({ t: 'shake', magnitude: 0.35 });
    events.push({ t: 'sfx', name: 'enemy_death', pos: { x: victim.pos.x, y: victim.pos.y } });
    victim.pos.x = 120 + rng() * (ARENA_W - 240);
    victim.pos.y = 120 + rng() * (ARENA_H - 240);
    if (rng() < 0.25) {
      const p = d.players[(rng() * d.players.length) | 0];
      events.push({ t: 'death', pos: { x: p.pos.x, y: p.pos.y }, entity: p.id, kind: 'player' });
      events.push({ t: 'objective', label: 'RUNNER DOWN' });
    }
  }

  if (rng() < 0.02) {
    events.push({ t: 'dialogue', speaker: 'STATION', text: 'Conduit lattice destabilising.', durationMs: 3000 });
  }

  d.world.events = events;
}

function zoneColor(z: ZoneEntity): string {
  const id = z.ability.toLowerCase();
  if (id.includes('mend') || id.includes('sanctum') || id.includes('aegis') || id.includes('ward')) return P.ENERGY_MINT;
  if (id.includes('thermite') || id.includes('slag') || id.includes('burn')) return P.DANGER_ORANGE;
  if (id.includes('gravity') || id.includes('collapse') || id.includes('void') || id.includes('null')) return P.ENERGY_VIOLET;
  if (z.team === 'hostile') return P.DANGER_ORANGE;
  return P.teamColor(z.team);
}

/**
 * Standalone visual harness — no server, no client shell.
 *
 * Fabricates a live `WorldState` (8 runners on patrol, 22 enemies cycling every
 * telegraph archetype, 20 projectiles, 4 ground zones, periodic detonations)
 * and animates it at 60 fps. Agent F wires this as the no-connection fallback;
 * it is also how the renderer is verified before the server exists.
 *
 * @returns a cleanup function that stops the loop and detaches all listeners.
 */
export function mountDemo(canvas: HTMLCanvasElement): () => void {
  const renderer = new Renderer(canvas);
  renderer.lookahead = true;
  renderer.camera.stiffness = 9; // raw target here, so use the natural follow

  const rng = makeRng(0x501d17);
  let nextId = 1;

  const players: PlayerEntity[] = [];
  for (let i = 0; i < 8; i++) players.push(demoPlayer(nextId++, rng));

  const enemies: EnemyEntity[] = [];
  const brains: DemoEnemyBrain[] = [];
  for (let i = 0; i < 22; i++) {
    enemies.push(demoEnemy(nextId++, i, rng));
    brains.push({
      windup: 0.8 + rng() * 1.2,
      cooldown: 2.4 + rng() * 3.4,
      timer: rng() * 4.5,
      orbit: rng() < 0.5 ? -1 : 1,
    });
  }

  const projectiles: ProjectileEntity[] = [];
  for (let i = 0; i < 20; i++) projectiles.push(demoProjectile(nextId++, i, rng));

  const zoneAbilities = ['gravity_well', 'thermite', 'sanctum_node', 'null_field'];
  const zones: ZoneEntity[] = [];
  for (let i = 0; i < 4; i++) zones.push(demoZone(nextId++, i, zoneAbilities[i], rng));

  const world: WorldState = {
    tick: 0,
    mode: 'coop_story',
    phase: 'playing',
    phaseTimer: 0,
    entities: [...players, ...enemies, ...projectiles, ...zones],
    objective: { label: 'RENDER HARNESS', progress: 0.5, chapter: 1, wave: 3, totalWaves: 6 },
    events: [],
  };

  const demo: DemoState = {
    world,
    players,
    enemies,
    brains,
    projectiles,
    zones,
    rng,
    t: 0,
    tickAcc: 0,
    boomAcc: 0,
    nextId,
  };

  const self = players[0];
  const view: RenderView = {
    world,
    selfId: self.id,
    camera: { x: self.pos.x, y: self.pos.y, zoom: 1 },
    aim: { x: self.pos.x + 200, y: self.pos.y },
  };

  // Mouse aim when available, otherwise a slow orbit so the harness is alive
  // even if nothing is touching it.
  let mouseX = -1;
  let mouseY = -1;
  const onMove = (ev: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    mouseX = ev.clientX - rect.left;
    mouseY = ev.clientY - rect.top;
  };
  canvas.addEventListener('mousemove', onMove);

  let raf = 0;
  let last = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let running = true;

  const frame = (now: number): void => {
    if (!running) return;
    const dtMs = Math.min(50, Math.max(1, now - last));
    last = now;

    stepDemo(demo, dtMs / 1000);

    view.camera.x = self.pos.x;
    view.camera.y = self.pos.y;
    if (mouseX >= 0) {
      const w = renderer.camera.toWorld({ x: mouseX, y: mouseY });
      view.aim.x = w.x;
      view.aim.y = w.y;
    } else {
      const a = demo.t * 0.7;
      view.aim.x = self.pos.x + Math.cos(a) * 260;
      view.aim.y = self.pos.y + Math.sin(a) * 260;
    }

    renderer.render(view, dtMs);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return (): void => {
    running = false;
    if (raf !== 0) cancelAnimationFrame(raf);
    canvas.removeEventListener('mousemove', onMove);
    renderer.dispose();
  };
}
