/**
 * VOIDLINE — particle system.
 *
 * Pooled, struct-of-arrays, allocation-free in steady state.
 *
 * - One pre-allocated set of typed arrays (`MAX_PARTICLES` slots). Nothing is
 *   ever `new`ed while the game is running.
 * - Dead particles are removed by swapping the tail into the hole, so the live
 *   range `[0, count)` is always dense and cache friendly. Draw order within a
 *   kind is irrelevant for particles, so this costs nothing visually.
 * - Colours are interned into a small string table, so a particle stores a
 *   single byte instead of a string reference. That also lets us cache one
 *   baked glow sprite per colour.
 * - Drawing is batched by composite mode and then by kind: exactly two
 *   `globalCompositeOperation` writes per frame regardless of particle count.
 *
 * Budget: 1500 slots. The renderer targets ~300 live at 60 fps with 8 players
 * and 40 enemies on screen.
 */

import type { Camera } from './camera.js';
import * as P from './palette.js';
import { glowSprite, haloSprite, puffSprite } from './sprites.js';

const TAU = Math.PI * 2;

export type ParticleKind = 'spark' | 'ember' | 'smoke' | 'shard' | 'ring' | 'beamMote';

const K_SPARK = 0;
const K_EMBER = 1;
const K_SMOKE = 2;
const K_SHARD = 3;
const K_RING = 4;
const K_MOTE = 5;

const KIND_CODE: Record<ParticleKind, number> = {
  spark: K_SPARK,
  ember: K_EMBER,
  smoke: K_SMOKE,
  shard: K_SHARD,
  ring: K_RING,
  beamMote: K_MOTE,
};

export const MAX_PARTICLES = 1500;
const MAX_COLORS = 64;

export interface EmitOptions {
  kind: ParticleKind;
  x: number;
  y: number;
  /** Number of particles to spawn. Default 1. */
  count?: number;
  /** Base emission direction, radians. Default 0. */
  angle?: number;
  /** Half-width of the emission arc, radians. `Math.PI` for a full circle. */
  spread?: number;
  speed?: number;
  speedVar?: number;
  life?: number;
  lifeVar?: number;
  size?: number;
  sizeVar?: number;
  color?: string;
  /** Velocity damping per second, 0..~8. */
  drag?: number;
  /** Constant downward (+y) acceleration in world units/s^2. */
  gravity?: number;
  /** Peak angular velocity for shards, radians/sec. */
  spin?: number;
  /** Alpha curve exponent. 1 = linear, 2 = punchy, 0.5 = lingering. */
  fade?: number;
  /** Inherited velocity added to every particle (e.g. the shooter's velocity). */
  vx?: number;
  vy?: number;
  /** Ring only: radial growth in world units/sec. */
  growth?: number;
  /** Ring only: stroke width in world units. */
  width?: number;
}

export class ParticleSystem {
  private readonly px = new Float32Array(MAX_PARTICLES);
  private readonly py = new Float32Array(MAX_PARTICLES);
  private readonly vx = new Float32Array(MAX_PARTICLES);
  private readonly vy = new Float32Array(MAX_PARTICLES);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly invLife = new Float32Array(MAX_PARTICLES);
  private readonly size = new Float32Array(MAX_PARTICLES);
  private readonly rot = new Float32Array(MAX_PARTICLES);
  private readonly rotVel = new Float32Array(MAX_PARTICLES);
  private readonly drag = new Float32Array(MAX_PARTICLES);
  private readonly grav = new Float32Array(MAX_PARTICLES);
  private readonly fade = new Float32Array(MAX_PARTICLES);
  private readonly aux = new Float32Array(MAX_PARTICLES);
  private readonly kind = new Uint8Array(MAX_PARTICLES);
  private readonly col = new Uint8Array(MAX_PARTICLES);

  private count = 0;
  private dropped = 0;

  private readonly colors: string[] = [];
  private readonly colorIds = new Map<string, number>();

  /** Live particle count. */
  get live(): number {
    return this.count;
  }

  /** Particles rejected because the pool was full since the last reset. */
  get overflow(): number {
    return this.dropped;
  }

  clear(): void {
    this.count = 0;
    this.dropped = 0;
  }

  // ---------------------------------------------------------------- emission

  emit(o: EmitOptions): void {
    const n = o.count === undefined ? 1 : o.count | 0;
    if (n <= 0) return;

    const code = KIND_CODE[o.kind];
    const ci = this.internColor(o.color === undefined ? P.ENERGY_WHITE : o.color);
    const baseAngle = o.angle === undefined ? 0 : o.angle;
    const spread = o.spread === undefined ? Math.PI : o.spread;
    const speed = o.speed === undefined ? 90 : o.speed;
    const speedVar = o.speedVar === undefined ? speed * 0.6 : o.speedVar;
    const life = o.life === undefined ? 0.5 : o.life;
    const lifeVar = o.lifeVar === undefined ? life * 0.35 : o.lifeVar;
    const size = o.size === undefined ? 3 : o.size;
    const sizeVar = o.sizeVar === undefined ? size * 0.4 : o.sizeVar;
    const drag = o.drag === undefined ? 2.4 : o.drag;
    const grav = o.gravity === undefined ? 0 : o.gravity;
    const spin = o.spin === undefined ? 0 : o.spin;
    const fade = o.fade === undefined ? 1 : o.fade;
    const ivx = o.vx === undefined ? 0 : o.vx;
    const ivy = o.vy === undefined ? 0 : o.vy;
    const growth = o.growth === undefined ? 220 : o.growth;
    const width = o.width === undefined ? 3 : o.width;

    for (let k = 0; k < n; k++) {
      const i = this.count;
      if (i >= MAX_PARTICLES) {
        this.dropped += n - k;
        return;
      }
      this.count++;

      const a = baseAngle + (Math.random() * 2 - 1) * spread;
      const sp = speed + (Math.random() * 2 - 1) * speedVar;
      const lf = Math.max(0.03, life + (Math.random() * 2 - 1) * lifeVar);

      this.px[i] = o.x;
      this.py[i] = o.y;
      this.kind[i] = code;
      this.col[i] = ci;
      this.life[i] = lf;
      this.invLife[i] = 1 / lf;
      this.size[i] = Math.max(0.4, size + (Math.random() * 2 - 1) * sizeVar);
      this.drag[i] = drag;
      this.grav[i] = grav;
      this.fade[i] = fade;
      this.rot[i] = Math.random() * TAU;
      this.rotVel[i] = spin === 0 ? 0 : (Math.random() * 2 - 1) * spin;

      if (code === K_RING) {
        this.vx[i] = growth;
        this.vy[i] = 0;
        this.aux[i] = width;
        this.size[i] = o.size === undefined ? 4 : o.size; // ring: size == radius
      } else {
        this.vx[i] = Math.cos(a) * sp + ivx;
        this.vy[i] = Math.sin(a) * sp + ivy;
        this.aux[i] = Math.random() * TAU; // flicker phase
      }
    }
  }

  // ---------------------------------------------------------------- recipes
  // Named, tuned emitters so call sites read as intent, not as parameter soup.

  /** Directional spark spray — the bread and butter of every impact. */
  sparks(x: number, y: number, color: string, count: number, angle: number, spread: number, speed: number): void {
    this.emit({
      kind: 'spark',
      x,
      y,
      count,
      color,
      angle,
      spread,
      speed,
      speedVar: speed * 0.55,
      life: 0.26,
      lifeVar: 0.12,
      size: 2.2,
      sizeVar: 1,
      drag: 4.2,
      fade: 1.6,
    });
  }

  /** Full impact package: sparks + embers + a breath of smoke. `power` ~ 0.2..2.5 */
  impact(x: number, y: number, color: string, power: number, angle = 0, spread = Math.PI): void {
    const p = power < 0.15 ? 0.15 : power > 3 ? 3 : power;
    this.sparks(x, y, color, (6 + p * 9) | 0, angle, spread, 150 + p * 130);
    this.emit({
      kind: 'ember',
      x,
      y,
      count: (3 + p * 5) | 0,
      color,
      angle,
      spread,
      speed: 60 + p * 70,
      life: 0.42,
      lifeVar: 0.2,
      size: 4 + p * 3,
      sizeVar: 2,
      drag: 3,
      fade: 1.8,
    });
    if (p > 0.7) {
      this.emit({
        kind: 'smoke',
        x,
        y,
        count: (1 + p) | 0,
        color: P.PLATE_LIGHT,
        spread: Math.PI,
        speed: 22,
        life: 0.9,
        lifeVar: 0.35,
        size: 16 + p * 12,
        sizeVar: 8,
        drag: 1.6,
        fade: 0.7,
      });
    }
  }

  /** Death: the entity's silhouette blows apart into tumbling fragments. */
  shatter(x: number, y: number, color: string, radius: number, count: number): void {
    this.emit({
      kind: 'shard',
      x,
      y,
      count,
      color,
      spread: Math.PI,
      speed: 110 + radius * 5,
      speedVar: 80,
      life: 0.85,
      lifeVar: 0.4,
      size: radius * 0.42,
      sizeVar: radius * 0.22,
      drag: 1.5,
      spin: 9,
      fade: 1.2,
    });
    this.emit({
      kind: 'ember',
      x,
      y,
      count: (count * 0.8) | 0,
      color: P.hot(color, 0.4),
      spread: Math.PI,
      speed: 180,
      speedVar: 120,
      life: 0.5,
      lifeVar: 0.25,
      size: radius * 0.4,
      sizeVar: radius * 0.2,
      drag: 3.4,
      fade: 2,
    });
    this.emit({
      kind: 'smoke',
      x,
      y,
      count: 4,
      color: P.PLATE_LIGHT,
      spread: Math.PI,
      speed: 40,
      life: 1.2,
      lifeVar: 0.4,
      size: radius * 2.1,
      sizeVar: radius * 0.8,
      drag: 1.4,
      fade: 0.65,
    });
  }

  /** Expanding shockwave ring. */
  ring(x: number, y: number, color: string, radius: number, growth: number, life: number, width: number): void {
    this.emit({ kind: 'ring', x, y, color, count: 1, size: radius, growth, life, lifeVar: 0, width, fade: 1.5 });
  }

  /** Motes streaming along a line — dashes, beams, tethers. */
  beam(x0: number, y0: number, x1: number, y1: number, color: string, count: number): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return;
    const nx = dx / len;
    const ny = dy / len;
    for (let i = 0; i < count; i++) {
      const t = Math.random();
      const off = (Math.random() * 2 - 1) * 7;
      this.emit({
        kind: 'beamMote',
        x: x0 + dx * t - ny * off,
        y: y0 + dy * t + nx * off,
        count: 1,
        color,
        angle: Math.atan2(ny, nx) + (Math.random() * 2 - 1) * 0.5,
        spread: 0,
        speed: 40 + Math.random() * 120,
        speedVar: 0,
        life: 0.34,
        lifeVar: 0.16,
        size: 3.2,
        sizeVar: 1.4,
        drag: 3.5,
        fade: 1.7,
      });
    }
  }

  /** Slow rising motes — buffs, charge-ups, revives. */
  motes(x: number, y: number, radius: number, color: string, count: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const r = radius * (0.55 + Math.random() * 0.45);
      this.emit({
        kind: 'beamMote',
        x: x + Math.cos(a) * r,
        y: y + Math.sin(a) * r,
        count: 1,
        color,
        angle: -Math.PI / 2 + (Math.random() * 2 - 1) * 0.5,
        spread: 0,
        speed: 30 + Math.random() * 45,
        speedVar: 0,
        life: 0.75,
        lifeVar: 0.3,
        size: 3,
        sizeVar: 1.2,
        drag: 0.8,
        gravity: -18,
        fade: 1.3,
      });
    }
  }

  /** Motes collapsing inward — summons, channel windups. */
  implode(x: number, y: number, radius: number, color: string, count: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const r = radius * (0.8 + Math.random() * 0.6);
      const sp = r / 0.42;
      this.emit({
        kind: 'beamMote',
        x: x + Math.cos(a) * r,
        y: y + Math.sin(a) * r,
        count: 1,
        color,
        angle: a + Math.PI,
        spread: 0.05,
        speed: sp,
        speedVar: 0,
        life: 0.42,
        lifeVar: 0.06,
        size: 3.4,
        sizeVar: 1,
        drag: 0,
        fade: 0.8,
      });
    }
  }

  /** One trailing mote — cheap enough to call per entity per frame. */
  trailMote(x: number, y: number, color: string, size: number, life: number): void {
    this.emit({
      kind: 'ember',
      x,
      y,
      count: 1,
      color,
      spread: Math.PI,
      speed: 12,
      speedVar: 10,
      life,
      lifeVar: life * 0.3,
      size,
      sizeVar: size * 0.3,
      drag: 3,
      fade: 1.8,
    });
  }

  // ---------------------------------------------------------------- simulation

  update(dt: number): void {
    if (dt <= 0) return;
    const step = dt > 0.1 ? 0.1 : dt;
    let i = 0;
    let n = this.count;
    while (i < n) {
      const l = this.life[i] - step;
      if (l <= 0) {
        n--;
        this.swap(i, n);
        continue;
      }
      this.life[i] = l;

      const k = this.kind[i];
      if (k === K_RING) {
        this.size[i] += this.vx[i] * step;
        const ringDrag = 1 - 1.6 * step;
        this.vx[i] *= ringDrag > 0 ? ringDrag : 0;
      } else {
        let d = 1 - this.drag[i] * step;
        if (d < 0) d = 0;
        const vx = this.vx[i] * d;
        const vy = this.vy[i] * d + this.grav[i] * step;
        this.vx[i] = vx;
        this.vy[i] = vy;
        this.px[i] += vx * step;
        this.py[i] += vy * step;
        if (this.rotVel[i] !== 0) this.rot[i] += this.rotVel[i] * step;
        if (k === K_SMOKE) this.size[i] += 26 * step;
      }
      i++;
    }
    this.count = n;
  }

  private swap(dst: number, src: number): void {
    if (dst === src) return;
    this.px[dst] = this.px[src];
    this.py[dst] = this.py[src];
    this.vx[dst] = this.vx[src];
    this.vy[dst] = this.vy[src];
    this.life[dst] = this.life[src];
    this.invLife[dst] = this.invLife[src];
    this.size[dst] = this.size[src];
    this.rot[dst] = this.rot[src];
    this.rotVel[dst] = this.rotVel[src];
    this.drag[dst] = this.drag[src];
    this.grav[dst] = this.grav[src];
    this.fade[dst] = this.fade[src];
    this.aux[dst] = this.aux[src];
    this.kind[dst] = this.kind[src];
    this.col[dst] = this.col[src];
  }

  // ---------------------------------------------------------------- drawing

  /**
   * Draw every live particle.
   * `ctx` MUST already be in world space (the renderer applies the camera
   * transform before calling); `cam` is used only for frustum culling.
   */
  draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
    const n = this.count;
    if (n === 0) return;

    const minX = cam.minX;
    const maxX = cam.maxX;
    const minY = cam.minY;
    const maxY = cam.maxY;
    const cols = this.colors;

    // ---- pass 1: smoke, normal blend, behind everything additive
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < n; i++) {
      if (this.kind[i] !== K_SMOKE) continue;
      const x = this.px[i];
      const y = this.py[i];
      const s = this.size[i];
      if (x + s < minX || x - s > maxX || y + s < minY || y - s > maxY) continue;
      const a = this.alphaOf(i) * 0.34;
      if (a <= 0.004) continue;
      ctx.globalAlpha = a;
      ctx.drawImage(puffSprite(cols[this.col[i]], 64), x - s, y - s, s * 2, s * 2);
    }

    // ---- pass 2: everything that emits light
    ctx.globalCompositeOperation = 'lighter';

    // 2a. embers + motes — baked glow blits
    for (let i = 0; i < n; i++) {
      const k = this.kind[i];
      if (k !== K_EMBER && k !== K_MOTE) continue;
      const x = this.px[i];
      const y = this.py[i];
      const s = this.size[i];
      if (x + s * 2 < minX || x - s * 2 > maxX || y + s * 2 < minY || y - s * 2 > maxY) continue;
      let a = this.alphaOf(i);
      if (k === K_EMBER) a *= 0.72 + 0.28 * Math.sin(this.aux[i] + this.life[i] * 34);
      if (a <= 0.004) continue;
      const color = cols[this.col[i]];
      const sprite = glowSprite(color, 32);
      // wide dim pass
      ctx.globalAlpha = a * 0.3;
      ctx.drawImage(sprite, x - s * 2.1, y - s * 2.1, s * 4.2, s * 4.2);
      // tight bright core
      ctx.globalAlpha = a;
      ctx.drawImage(sprite, x - s * 0.85, y - s * 0.85, s * 1.7, s * 1.7);
    }

    // 2b. sparks — tapered streaks along their own velocity
    ctx.lineCap = 'round';
    for (let i = 0; i < n; i++) {
      if (this.kind[i] !== K_SPARK) continue;
      const x = this.px[i];
      const y = this.py[i];
      if (x < minX - 40 || x > maxX + 40 || y < minY - 40 || y > maxY + 40) continue;
      const a = this.alphaOf(i);
      if (a <= 0.004) continue;
      const s = this.size[i];
      const tail = 0.028;
      ctx.strokeStyle = P.withAlpha(cols[this.col[i]], a);
      ctx.lineWidth = s * (0.35 + 0.65 * a);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - this.vx[i] * tail, y - this.vy[i] * tail);
      ctx.stroke();
    }

    // 2c. shards — tumbling triangular fragments with a hot rim
    for (let i = 0; i < n; i++) {
      if (this.kind[i] !== K_SHARD) continue;
      const x = this.px[i];
      const y = this.py[i];
      const s = this.size[i];
      if (x + s < minX || x - s > maxX || y + s < minY || y - s > maxY) continue;
      const a = this.alphaOf(i);
      if (a <= 0.004) continue;
      const r = this.rot[i];
      const c0 = Math.cos(r);
      const s0 = Math.sin(r);
      const c1 = Math.cos(r + 2.2);
      const s1 = Math.sin(r + 2.2);
      const c2 = Math.cos(r + 4.1);
      const s2 = Math.sin(r + 4.1);
      const color = cols[this.col[i]];
      ctx.beginPath();
      ctx.moveTo(x + c0 * s, y + s0 * s);
      ctx.lineTo(x + c1 * s * 0.68, y + s1 * s * 0.68);
      ctx.lineTo(x + c2 * s * 0.85, y + s2 * s * 0.85);
      ctx.closePath();
      ctx.fillStyle = P.withAlpha(color, a * 0.55);
      ctx.fill();
      ctx.strokeStyle = P.withAlpha(P.hot(color, 0.55), a);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // 2d. rings — layered shockwave strokes
    for (let i = 0; i < n; i++) {
      if (this.kind[i] !== K_RING) continue;
      const x = this.px[i];
      const y = this.py[i];
      const r = this.size[i];
      if (x + r < minX || x - r > maxX || y + r < minY || y - r > maxY) continue;
      const a = this.alphaOf(i);
      if (a <= 0.004 || r <= 0.5) continue;
      const color = cols[this.col[i]];
      const w = this.aux[i];
      ctx.globalAlpha = 1;
      // wide dim pass
      ctx.strokeStyle = P.withAlpha(color, a * 0.13);
      ctx.lineWidth = w * 3.2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.stroke();
      // medium
      ctx.strokeStyle = P.withAlpha(color, a * 0.34);
      ctx.lineWidth = w * 1.5;
      ctx.stroke();
      // tight bright core
      ctx.strokeStyle = P.withAlpha(P.hot(color, 0.7), a * 0.85);
      ctx.lineWidth = w * 0.5;
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Optional wide bloom pass for the biggest particles. Cheap, and it is what
   * sells "energy" over "confetti". Call immediately before `draw`.
   */
  drawBloom(ctx: CanvasRenderingContext2D, cam: Camera): void {
    const n = this.count;
    if (n === 0) return;
    const cols = this.colors;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < n; i++) {
      const k = this.kind[i];
      if (k !== K_EMBER && k !== K_SHARD) continue;
      const s = this.size[i];
      if (s < 5) continue;
      const x = this.px[i];
      const y = this.py[i];
      if (!cam.isVisible(x, y, s * 4)) continue;
      const a = this.alphaOf(i) * 0.085;
      if (a <= 0.004) continue;
      ctx.globalAlpha = a;
      ctx.drawImage(haloSprite(cols[this.col[i]], 64), x - s * 4, y - s * 4, s * 8, s * 8);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- internals

  private alphaOf(i: number): number {
    const t = this.life[i] * this.invLife[i];
    const f = this.fade[i];
    if (f === 1) return t;
    if (f === 2) return t * t;
    return Math.pow(t, f);
  }

  private internColor(c: string): number {
    const hit = this.colorIds.get(c);
    if (hit !== undefined) return hit;
    if (this.colors.length >= MAX_COLORS) return 0;
    const id = this.colors.length;
    this.colors.push(c);
    this.colorIds.set(c, id);
    return id;
  }
}
