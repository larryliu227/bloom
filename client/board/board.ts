/**
 * BLOOM — the board. Renderer and input, one canvas, no camera.
 *
 * Hard rules this file exists to enforce:
 *  - the entire 14x22 grid is on screen at all times. No pan, no zoom, no scroll.
 *    A child must never be lost, so there is nothing to get lost in.
 *  - touch is the primary input. pointerdown lights every cell you may legally
 *    poke; you may slide to change your mind; pointerup commits. That loop teaches
 *    the rule by poking instead of by reading.
 *  - connectivity is the single most important thing on screen. Fed tiles are
 *    saturated and pulse outward from home; cut tiles go grey and visibly drain.
 *    When a limb is severed the whole limb greys AT ONCE, with a flash and a
 *    shockwave, because that is the moment the game is about.
 */

import type { Board, MatchState, RoleDef } from '@shared/bloom.js';
import { BOARD_H, BOARD_W, STORE_CAP, TAKEOVER_SIZE } from '@shared/bloom.js';
import { fitCanvas, hash01, roundRect } from '../ui/dom.js';
import { INK, clamp01, darken, drained, ease, lighten, mix, rgba } from './palette.js';
import { getRole, isBeingTaken, legalCells, legalTap, neighbours, repelBonus, repelHits, seatColour, xy } from '@shared/rules.js';
import type { TapKind } from '@shared/rules.js';

/** Which item is waiting for a board target, if any. */
export type ArmedKind = null | 'takeover' | 'build';

export interface BoardCallbacks {
  /** A committed tap. The caller sends it; the server decides what it meant. */
  onTap(cell: number, kind: TapKind): void;
  /** A limb was cut. `mine` is true when it was OUR limb that died. */
  onSever(seat: number, count: number, mine: boolean): void;
  /** Poked something that is not a legal target. */
  onDeny(): void;
  /**
   * A tap while an item is armed. Bypasses legality entirely — HOSTILE TAKEOVER
   * targets a 9x9 block wherever you point, and the centre of an enemy mat is not
   * somewhere SPORE could legally grow, which is exactly where you want to aim it.
   */
  onArmedTap(cell: number): void;
}

/** Per-cell animation state. Purely cosmetic; the server owns the truth. */
interface Anim {
  /** Seconds since this cell lost its path home. Drives the grey-out wave. */
  sever: number;
  /** 0..1 pop when a claim completes. */
  pop: number;
  /** 0..1 fade of a cell that finished withering, so it does not vanish abruptly. */
  ghost: number;
  ghostColour: string;
}

const PULSE_HZ = 0.55;
/** How far the "fed" pulse travels per second, in cells. Life visibly flows. */
const PULSE_CELLS_PER_SEC = 6;
/** Grey-out wave duration, seconds. Long enough to watch, short enough to hurt. */
const SEVER_WAVE = 0.55;
/**
 * How far toward ash a cut-off-but-supplied pocket fades. Deliberately partial: it
 * is not fed, so it must not look fed, but it is not dying either.
 */
const BESIEGED_FADE = 0.5;
/** Slop radius, in cell widths, for snapping a sloppy thumb to a legal target. */
const SNAP_RADIUS = 0.75;
/**
 * What each kind of tap is drawn in. Four verbs, four colours, never mixed: red
 * takes ground off somebody, violet lands a spore, white plants, and cyan is the
 * defence — the only one of the four that destroys rather than claims.
 */
const TAP_TINT: Record<TapKind, string> = {
  grow: '#f6ffe8',
  attack: '#ff5a3c',
  spore: '#c46bff',
  repel: '#5ce1ff',
};

export class BoardView {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;

  private ctx: CanvasRenderingContext2D;
  private cb: BoardCallbacks;

  private state: MatchState | null = null;
  private mySeat = -1;
  private role: RoleDef = getRole('vine');

  // --- layout (CSS px)
  private cell = 24;
  private ox = 0;
  private oy = 0;
  private vw = 1;
  private vh = 1;

  // --- animation
  private anim: Anim[] = [];
  /** Cells from home, per cell, for the outward pulse. -1 = not fed. */
  private dist: Int16Array = new Int16Array(0);
  private time = 0;
  private flash = 0;
  private shake = 0;
  private shockwave: Array<{ cell: number; t: number; colour: string }> = [];

  // --- input
  private legal = new Map<number, TapKind>();
  private pressCell = -1;
  private pressing = false;
  private pointerId = -1;
  /** Optimistic local highlight, corrected by the next snapshot. */
  private optimistic = new Map<number, number>();
  private denyCell = -1;
  private denyT = 0;
  /** An item is waiting for a target: taps go to `onArmedTap`, legality is skipped. */
  private armed: ArmedKind = null;

  constructor(cb: BoardCallbacks) {
    this.cb = cb;
    this.root = document.createElement('div');
    this.root.className = 'board-wrap';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'board-canvas';
    this.root.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('canvas 2d unavailable');
    this.ctx = ctx;
    this.wireInput();
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  /** Arm or disarm targeting mode. While armed the board shows a footprint, not moves. */
  setArmed(what: ArmedKind): void {
    this.armed = what;
    this.root.classList.toggle('arming', what !== null);
    if (what) this.legal.clear();
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.endPress();
  }

  // ================================================================ state

  setState(next: MatchState, mySeat: number): void {
    const prev = this.state;
    this.mySeat = mySeat;
    const seat = next.seats[mySeat];
    // During the draft nobody has a plant yet, so there is no legality to preview.
    if (seat?.role) this.role = getRole(seat.role);

    if (!prev || prev.board.cells.length !== next.board.cells.length) {
      this.anim = next.board.cells.map(() => ({ sever: -1, pop: 0, ghost: 0, ghostColour: INK.ash }));
    } else {
      this.diff(prev, next);
    }
    this.state = next;
    this.recomputeDist(next.board);
    // The snapshot is truth: anything we optimistically lit is now redundant.
    for (const [c, t] of this.optimistic) if (this.time - t > 0.45) this.optimistic.delete(c);
    if (this.pressing) this.recomputeLegal();
  }

  /** Find what changed, and turn the important changes into things you can see. */
  private diff(prev: MatchState, next: MatchState): void {
    const a = prev.board.cells;
    const b = next.board.cells;
    const cut = new Map<number, number[]>();

    for (let i = 0; i < b.length; i++) {
      const p = a[i];
      const c = b[i];
      if (!p) continue;
      // Lost its path home. THE moment. Batch by seat so one cut reads as one event.
      if (c.owner >= 0 && p.owner === c.owner && p.connected && !c.connected) {
        this.anim[i].sever = 0;
        const list = cut.get(c.owner) ?? [];
        list.push(i);
        cut.set(c.owner, list);
      }
      if (c.connected && !p.connected) this.anim[i].sever = -1;
      if (c.owner >= 0 && p.owner !== c.owner) {
        this.anim[i].pop = 1;
        this.anim[i].sever = c.connected ? -1 : 0;
      }
      if (p.owner >= 0 && c.owner < 0) {
        this.anim[i].ghost = 1;
        this.anim[i].ghostColour = seatColour(prev.seats, p.owner);
        this.anim[i].sever = -1;
      }
    }

    // Server-authored cue wins when present; the diff above is the fallback so the
    // payoff never depends on an event array arriving.
    for (const ev of next.events ?? []) {
      if (ev.t === 'severed') {
        this.fireSever(ev.seat, ev.count, ev.cause);
        cut.delete(ev.seat);
      } else if (ev.t === 'repel') {
        // Ground being burned back off you is a moment; give it the same shockwave
        // language as a cut, in the defender's colour.
        this.shockwave.push({ cell: ev.cell, t: 0, colour: seatColour(next.seats, ev.seat) });
        if (this.shockwave.length > 6) this.shockwave.shift();
        this.flash = Math.max(this.flash, ev.seat === this.mySeat ? 0.5 : 0.25);
        this.shake = Math.max(this.shake, 6);
      } else if (ev.t === 'looted' && ev.fuel > 0) {
        /*
         * A granary changing hands with food in it. Loud in proportion to the haul,
         * and loudest of all when it was YOURS — losing a full store is the most
         * expensive thing that can happen to you without losing a seedling, and it
         * must never happen quietly off the side of the screen.
         */
        this.shockwave.push({ cell: ev.cell, t: 0, colour: INK.store });
        if (this.shockwave.length > 6) this.shockwave.shift();
        const mine = ev.from === this.mySeat;
        this.flash = Math.max(this.flash, mine ? 0.8 : 0.3);
        this.shake = Math.max(this.shake, mine ? 10 : 4);
      } else if (ev.t === 'denied' && ev.seat === this.mySeat) {
        // The server refused it — out of energy, or out of reach of a store. Say so
        // on the cell that was tapped, in the same language as an illegal poke.
        this.denyCell = ev.cell;
        this.denyT = 0.4;
      }
    }
    for (const [seat, list] of cut) {
      this.fireSever(seat, list.length, list[0]);
    }
  }

  private fireSever(seat: number, count: number, cause: number): void {
    if (count <= 0) return;
    const mine = seat === this.mySeat;
    const colour = this.state ? seatColour(this.state.seats, seat) : INK.ash;
    this.shockwave.push({ cell: cause, t: 0, colour });
    if (this.shockwave.length > 6) this.shockwave.shift();
    // A big cut shakes the whole screen. A nick does not. Scale teaches weight.
    const mag = clamp01(count / 14);
    this.flash = Math.max(this.flash, 0.35 + mag * 0.65);
    this.shake = Math.max(this.shake, 3 + mag * 14);
    this.cb.onSever(seat, count, mine);
  }

  /**
   * BFS from every seedling over that seat's own tiles. Gives each fed tile its
   * distance from the root, which is what makes the pulse *travel* outward
   * instead of blinking in unison — the board looks like it is being fed.
   *
   * Seeds from every owned `home` cell rather than from `board.homes`, matching
   * the simulation exactly: a conquered seedling is a real root, so the zone around
   * it has to be seen to pulse from itself. Rooted at the old owner's start cell,
   * a captured zone drew as fed while pulsing from nowhere.
   */
  private recomputeDist(board: Board): void {
    if (this.dist.length !== board.cells.length) this.dist = new Int16Array(board.cells.length);
    this.dist.fill(-1);
    const queue: number[] = [];
    for (let i = 0; i < board.cells.length; i++) {
      const c = board.cells[i];
      if (c.kind !== 'home' || c.owner < 0) continue;
      this.dist[i] = 0;
      queue.push(i);
    }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      const owner = board.cells[i].owner;
      for (const n of neighbours(board, i)) {
        const c = board.cells[n];
        if (c.owner !== owner || this.dist[n] >= 0 || !c.connected) continue;
        this.dist[n] = this.dist[i] + 1;
        queue.push(n);
      }
    }
  }

  // ================================================================ input

  private wireInput(): void {
    const c = this.canvas;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', () => this.endPress());
    c.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.pressing) this.pressCell = -1;
    });
    // Belt and braces against iOS double-tap zoom on a fast tapper.
    c.addEventListener('dblclick', (e) => e.preventDefault());
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private cellFromEvent(e: PointerEvent): number {
    const state = this.state;
    if (!state) return -1;
    const r = this.canvas.getBoundingClientRect();
    const px = e.clientX - r.left - this.ox;
    const py = e.clientY - r.top - this.oy;
    const gx = Math.floor(px / this.cell);
    const gy = Math.floor(py / this.cell);
    const b = state.board;
    if (gx < 0 || gy < 0 || gx >= b.w || gy >= b.h) return -1;
    const exact = gy * b.w + gx;
    if (this.armed) return exact;
    if (this.legal.has(exact)) return exact;
    return this.snap(px, py, exact);
  }

  /**
   * A 12-wide board on a 393 px phone gives 32 px cells — below the 44 px target
   * and not negotiable, because the whole board must stay on screen. So the
   * *effective* target is widened instead: a thumb that lands on nothing snaps to
   * the nearest legal cell within SNAP_RADIUS, and you can slide before lifting.
   */
  private snap(px: number, py: number, fallback: number): number {
    const b = this.state?.board;
    if (!b || !this.legal.size) return fallback;
    let best = fallback;
    let bestD = (SNAP_RADIUS * this.cell) ** 2;
    for (const cell of this.legal.keys()) {
      const p = xy(cell, b.w);
      const cx = (p.x + 0.5) * this.cell;
      const cy = (p.y + 0.5) * this.cell;
      const d = (cx - px) ** 2 + (cy - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = cell;
      }
    }
    return best;
  }

  private recomputeLegal(): void {
    const s = this.state;
    if (!s || this.mySeat < 0 || s.phase !== 'playing') {
      this.legal.clear();
      return;
    }
    // Allies matter here: a defence never touches a friend's ground, so a tile whose
    // only neighbours are an ally's must not light up as one.
    this.legal = legalCells(s.board, s.seats, this.mySeat, this.role, s.allies);
  }

  private onDown(e: PointerEvent): void {
    if (this.pressing) return;
    e.preventDefault();
    this.pressing = true;
    this.pointerId = e.pointerId;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* not fatal */
    }
    if (!this.armed) this.recomputeLegal();
    this.pressCell = this.cellFromEvent(e);
  }

  private onMove(e: PointerEvent): void {
    if (!this.pressing) {
      if (e.pointerType === 'mouse') this.pressCell = -1;
      return;
    }
    if (e.pointerId !== this.pointerId) return;
    this.pressCell = this.cellFromEvent(e);
  }

  private onUp(e: PointerEvent): void {
    if (!this.pressing || e.pointerId !== this.pointerId) return;
    e.preventDefault();
    const cell = this.cellFromEvent(e);
    const s = this.state;
    if (this.armed) {
      if (cell >= 0) this.cb.onArmedTap(cell);
      this.endPress();
      return;
    }
    const kind =
      s && this.mySeat >= 0 && cell >= 0
        ? legalTap(s.board, s.seats, this.mySeat, this.role, cell)
        : null;
    /*
     * A cell that is already filling in swallows the tap silently — no send, and no
     * deny flash either. Tapping again at a bar you can watch moving is the most
     * natural thing on a touchscreen, so it must not read as an error, and it must
     * certainly not cost anything (it used to cost a full attack, server-side).
     *
     * A repel is exempt: your seedling being claimed is the whole reason to tap it.
     */
    if (cell >= 0 && s && kind !== 'repel' && isBeingTaken(s.board, cell)) {
      this.endPress();
      return;
    }
    /*
     * A defence with nothing in range is refused by the simulation and costs nothing,
     * so say so here rather than sending a tap that will silently evaporate. Every
     * tile you own is a legal defence, which makes "there was nothing to push" by far
     * the most common way to miss with one.
     */
    if (cell >= 0 && s && kind === 'repel') {
      const hits = repelHits(s.board, s.allies, this.mySeat, cell, repelBonus(s.seats[this.mySeat]));
      if (hits.length === 0) {
        this.denyCell = cell;
        this.denyT = 0.4;
        this.cb.onDeny();
        this.endPress();
        return;
      }
    }
    if (cell >= 0 && kind) {
      // A defence claims nothing, so it gets no optimistic claim-fill on the tile.
      if (kind !== 'repel') this.optimistic.set(cell, this.time);
      this.cb.onTap(cell, kind);
    } else if (cell >= 0) {
      this.denyCell = cell;
      this.denyT = 0.4;
      this.cb.onDeny();
    }
    this.endPress();
  }

  private endPress(): void {
    if (this.pressing) {
      try {
        this.canvas.releasePointerCapture(this.pointerId);
      } catch {
        /* already gone */
      }
    }
    this.pressing = false;
    this.pointerId = -1;
    this.pressCell = -1;
    this.legal.clear();
  }

  // ================================================================ frame

  resize(): void {
    /*
     * Measure the CONTENT box, not the border box.
     *
     * `.board-wrap` is padded to keep the board clear of the HUD and the tech bar,
     * and `getBoundingClientRect()` includes that padding — so sizing from it
     * produced a canvas larger than the space available, CSS `max-width` then
     * clamped it back down, and `cellFromEvent` (which reads the clamped rect)
     * ended up in a different coordinate space than the renderer. That mismatch is
     * exactly the "hitbox is off" bug: taps landed on the wrong cell, and by more
     * the further you got from the centre.
     */
    const cs = getComputedStyle(this.root);
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const w = Math.max(1, this.root.clientWidth - padX);
    const h = Math.max(1, this.root.clientHeight - padY);
    const fit = fitCanvas(this.canvas, w, h);
    this.vw = fit.w;
    this.vh = fit.h;
    const b = this.state?.board;
    const cols = b?.w ?? BOARD_W;
    const rows = b?.h ?? BOARD_H;
    this.cell = Math.max(6, Math.floor(Math.min(fit.w / cols, fit.h / rows)));
    this.ox = Math.round((fit.w - this.cell * cols) / 2);
    this.oy = Math.round((fit.h - this.cell * rows) / 2);
  }

  /** Cell size in CSS px — reported so the touch-target budget stays honest. */
  get cellSize(): number {
    return this.cell;
  }

  update(dtMs: number): void {
    const dt = Math.min(0.05, dtMs / 1000);
    this.time += dt;
    this.flash = Math.max(0, this.flash - dt * 2.2);
    this.shake = Math.max(0, this.shake - dt * 34);
    this.denyT = Math.max(0, this.denyT - dt);
    for (const s of this.shockwave) s.t += dt;
    this.shockwave = this.shockwave.filter((s) => s.t < 1);
    for (const a of this.anim) {
      if (a.sever >= 0) a.sever += dt;
      a.pop = Math.max(0, a.pop - dt * 2.6);
      a.ghost = Math.max(0, a.ghost - dt * 1.6);
    }
    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx;
    const dpr = this.canvas.width / Math.max(1, this.vw);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = INK.bg;
    ctx.fillRect(0, 0, this.vw, this.vh);

    const s = this.state;
    if (!s) return;
    if (this.cell < 8 || Math.abs(this.cell * s.board.w - (this.vw - this.ox * 2)) > this.cell) {
      this.resize();
      ctx.setTransform(this.canvas.width / Math.max(1, this.vw), 0, 0, this.canvas.height / Math.max(1, this.vh), 0, 0);
    }

    // Screen shake is applied to the board, never the HUD, so numbers stay readable.
    let sx = 0;
    let sy = 0;
    if (this.shake > 0.2) {
      sx = Math.sin(this.time * 61) * this.shake;
      sy = Math.cos(this.time * 47) * this.shake;
    }
    ctx.save();
    ctx.translate(this.ox + sx, this.oy + sy);

    this.drawSoil(s.board);
    this.drawVeins(s);
    this.drawCells(s);
    this.drawClaims(s);
    this.drawShockwaves(s.board);
    this.drawInsects(s);
    this.drawTouch(s.board);

    ctx.restore();

    if (this.flash > 0.01) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.16})`;
      ctx.fillRect(0, 0, this.vw, this.vh);
    }
  }

  // ---------------------------------------------------------------- layers

  private drawSoil(board: Board): void {
    const ctx = this.ctx;
    const c = this.cell;
    for (let i = 0; i < board.cells.length; i++) {
      const cell = board.cells[i];
      const p = xy(i, board.w);
      const x = p.x * c;
      const y = p.y * c;
      if (cell.kind === 'rock') {
        // Rock is a chunky bevelled block: the only shape with a hard edge, so
        // "you cannot go there" reads without a single word.
        ctx.fillStyle = INK.rock;
        roundRect(ctx, x + 1, y + 1, c - 2, c - 2, c * 0.16);
        ctx.fill();
        ctx.fillStyle = INK.rockTop;
        roundRect(ctx, x + 1 + c * 0.1, y + 1 + c * 0.08, c * 0.5, c * 0.24, c * 0.08);
        ctx.fill();
        continue;
      }
      ctx.fillStyle = INK.soil;
      roundRect(ctx, x + 1, y + 1, c - 2, c - 2, c * 0.22);
      ctx.fill();
      // A faint speckle keeps 216 identical squares from reading as graph paper.
      const hsh = hash01(i);
      if (hsh > 0.55) {
        ctx.fillStyle = INK.soilEdge;
        const r = c * 0.06;
        ctx.beginPath();
        ctx.arc(x + c * (0.25 + hsh * 0.5), y + c * (0.3 + hash01(i + 99) * 0.4), r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * Thick links between adjacent same-owner cells. This is what makes a limb read
   * as ONE organism rather than a pile of squares — so when it greys, one thing
   * dies, and you feel it.
   */
  private drawVeins(s: MatchState): void {
    const ctx = this.ctx;
    const board = s.board;
    const c = this.cell;
    ctx.lineCap = 'round';
    for (let i = 0; i < board.cells.length; i++) {
      const a = board.cells[i];
      if (a.owner < 0) continue;
      const pa = xy(i, board.w);
      for (const n of [i + 1, i + board.w]) {
        if (n >= board.cells.length) continue;
        if (n === i + 1 && pa.x === board.w - 1) continue;
        const b = board.cells[n];
        if (b.owner !== a.owner) continue;
        const live = a.connected && b.connected;
        const colour = seatColour(s.seats, a.owner);
        const t = live ? 0 : clamp01(Math.max(this.anim[i].sever, this.anim[n].sever) / SEVER_WAVE);
        ctx.strokeStyle = live ? rgba(lighten(colour, 0.15), 0.9) : rgba(drained(colour, t), 0.5);
        ctx.lineWidth = c * (live ? 0.3 : 0.2);
        const pb = xy(n, board.w);
        ctx.beginPath();
        ctx.moveTo((pa.x + 0.5) * c, (pa.y + 0.5) * c);
        ctx.lineTo((pb.x + 0.5) * c, (pb.y + 0.5) * c);
        ctx.stroke();
      }
    }
  }

  /** Fungal insects: a small dark body with legs, sitting on top of the tile. */
  private drawInsects(s: MatchState): void {
    if (!s.insects || s.insects.length === 0) return;
    const ctx = this.ctx;
    const cell = this.cell;
    for (const bug of s.insects) {
      const x = (bug.cell % s.board.w) * cell + cell / 2;
      const y = Math.floor(bug.cell / s.board.w) * cell + cell / 2;
      const r = cell * 0.2;
      // Fades out over its last two seconds so its death is not a surprise.
      ctx.globalAlpha = Math.min(1, bug.life / 2);
      ctx.fillStyle = '#1b1206';
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.15, r, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#e8c15a';
      ctx.lineWidth = Math.max(1, cell * 0.045);
      for (const sx2 of [-1, 1]) {
        for (const oy of [-0.5, 0.15, 0.8]) {
          ctx.beginPath();
          ctx.moveTo(x + sx2 * r * 0.7, y + r * oy * 0.6);
          ctx.lineTo(x + sx2 * r * 1.6, y + r * oy);
          ctx.stroke();
        }
      }
      ctx.fillStyle = '#e8c15a';
      ctx.beginPath();
      ctx.arc(x, y - r * 0.15, r * 0.34, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  private drawCells(s: MatchState): void {
    const ctx = this.ctx;
    const board = s.board;
    const c = this.cell;
    for (let i = 0; i < board.cells.length; i++) {
      const cell = board.cells[i];
      const p = xy(i, board.w);
      const x = p.x * c;
      const y = p.y * c;
      const a = this.anim[i];

      if (a.ghost > 0 && cell.owner < 0) {
        ctx.fillStyle = rgba(drained(a.ghostColour, 1), a.ghost * 0.35);
        roundRect(ctx, x + 2, y + 2, c - 4, c - 4, c * 0.22);
        ctx.fill();
      }

      if (cell.owner >= 0) {
        const base = seatColour(s.seats, cell.owner);
        const fed = cell.connected;
        /*
         * A pocket that is cut off but has a granary in it is NOT dying, and must not
         * be drawn as if it were. It goes half-grey and stops there: visibly severed,
         * visibly still standing. The full ash wave is reserved for ground that is
         * actually about to evaporate.
         */
        const besieged = !fed && (s.board.nets[cell.net]?.stores ?? 0) > 0;
        // The grey-out wave. It runs to full ash in SEVER_WAVE seconds, and every
        // cell of the limb starts it on the same tick, so the whole shape dies at once.
        const deadT = fed
          ? 0
          : besieged
            ? BESIEGED_FADE
            : a.sever >= 0
              ? clamp01(a.sever / SEVER_WAVE)
              : 1;
        let colour = drained(base, deadT);
        if (fed) {
          // Fed tiles breathe, and the breath travels outward from home.
          const d = this.dist[i];
          const phase = this.time * PULSE_HZ * Math.PI * 2 - (d >= 0 ? d / PULSE_CELLS_PER_SEC : 0) * Math.PI * 2;
          const lift = 0.06 + 0.1 * (0.5 + 0.5 * Math.sin(phase));
          colour = lighten(base, lift);
        }
        const pop = ease(a.pop);
        const inset = 2 - pop * 1.6;
        ctx.fillStyle = colour;
        roundRect(ctx, x + inset, y + inset, c - inset * 2, c - inset * 2, c * 0.24);
        ctx.fill();

        if (besieged) {
          // Dug in: a hard bright edge, which is the opposite read to the crack a
          // dying tile gets. This ground is holding out, and it can still hit back.
          ctx.strokeStyle = rgba(INK.store, 0.5);
          ctx.lineWidth = Math.max(1, c * 0.06);
          roundRect(ctx, x + 3, y + 3, c - 6, c - 6, c * 0.2);
          ctx.stroke();
        } else if (!fed) {
          // Draining: an inner square shrinks toward nothing while the wither runs.
          const life = cell.wither > 0 ? clamp01(cell.wither / 2) : 1 - deadT;
          ctx.fillStyle = rgba(INK.ashDark, 0.55);
          const k = (1 - life) * 0.5;
          roundRect(ctx, x + 2 + (c - 4) * k * 0.5, y + 2, (c - 4) * (1 - k * 0.5), (c - 4) * (1 - life) , c * 0.1);
          ctx.fill();
          this.drawCrack(x, y, i);
        } else {
          ctx.strokeStyle = rgba(lighten(base, 0.45), 0.5);
          ctx.lineWidth = Math.max(1, c * 0.05);
          roundRect(ctx, x + 3, y + 3, c - 6, c - 6, c * 0.2);
          ctx.stroke();
        }

        if (cell.spore > 0) this.drawSporeTimer(x, y, cell.spore, base);
      }

      if (cell.kind === 'sun') this.drawSun(x, y, cell.owner >= 0);
      else if (cell.kind === 'wood') this.drawWood(x, y, cell.owner >= 0);
      else if (cell.kind === 'acid') this.drawAcid(x, y, cell.owner >= 0);
      else if (cell.kind === 'insect') this.drawBugs(x, y, cell.owner >= 0);
      if (cell.kind === 'home') this.drawHome(x, y, s, cell.owner);
      if (cell.store > 0) this.drawStore(x, y, cell.fuel);
    }
  }

  /**
   * A nutrient store: a squat tank with the energy visibly inside it.
   *
   * Drawn last, over everything including the seedling ring, because it is the
   * single most important thing on a tile — it is where the energy physically is, it
   * is what a raider is coming for, and its fill level is the answer to "why has my
   * income stopped".
   */
  private drawStore(x: number, y: number, fuel: number): void {
    const ctx = this.ctx;
    const c = this.cell;
    const w = c * 0.42;
    const h = c * 0.34;
    const bx = x + (c - w) / 2;
    const by = y + c - h - c * 0.12;
    const full = clamp01(fuel / STORE_CAP);
    ctx.fillStyle = rgba(INK.bg, 0.8);
    roundRect(ctx, bx, by, w, h, c * 0.06);
    ctx.fill();
    if (full > 0) {
      ctx.fillStyle = rgba(INK.store, 0.95);
      roundRect(ctx, bx + 1, by + 1 + (h - 2) * (1 - full), w - 2, (h - 2) * full, c * 0.05);
      ctx.fill();
    }
    ctx.strokeStyle = rgba(INK.store, full >= 0.999 ? 0.4 + 0.6 * Math.abs(Math.sin(this.time * 4)) : 0.85);
    ctx.lineWidth = Math.max(1, c * 0.05);
    roundRect(ctx, bx, by, w, h, c * 0.06);
    ctx.stroke();
  }

  private drawCrack(x: number, y: number, i: number): void {
    const ctx = this.ctx;
    const c = this.cell;
    ctx.strokeStyle = rgba(INK.bg, 0.75);
    ctx.lineWidth = Math.max(1, c * 0.045);
    ctx.beginPath();
    const h = hash01(i);
    ctx.moveTo(x + c * (0.2 + h * 0.2), y + c * 0.15);
    ctx.lineTo(x + c * 0.5, y + c * (0.45 + h * 0.1));
    ctx.lineTo(x + c * (0.7 - h * 0.2), y + c * 0.85);
    ctx.stroke();
  }

  /** Sun: the only star on the board. Owning one feeds you faster. */
  /**
   * WOOD — stacked timber. Squared-off and static, so it reads as structure next to
   * the sun's spin; it is the tile that BRACES whoever holds it.
   */
  private drawWood(x: number, y: number, owned: boolean): void {
    const ctx = this.ctx;
    const c = this.cell;
    ctx.fillStyle = owned ? INK.woodGlow : INK.wood;
    const w = c * 0.52;
    const h = c * 0.17;
    for (let k = 0; k < 3; k++) {
      const off = (k % 2) * (c * 0.07);
      roundRect(ctx, x + (c - w) / 2 + off - c * 0.03, y + c * 0.26 + k * (h + c * 0.04), w, h, 1);
      ctx.fill();
    }
  }

  /**
   * ACID — a bubbling pit. The scarcest thing on the board and the only currency the
   * tech tree takes, so it gets motion: it should catch your eye from across the map.
   */
  private drawAcid(x: number, y: number, owned: boolean): void {
    const ctx = this.ctx;
    const c = this.cell;
    const cx = x + c / 2;
    const cy = y + c / 2;
    ctx.fillStyle = owned ? INK.acidGlow : INK.acid;
    roundRect(ctx, cx - c * 0.28, cy - c * 0.16, c * 0.56, c * 0.32, 2);
    ctx.fill();
    // Bubbles, on a per-cell phase so a field of acid does not pulse in unison.
    const seed = hash01(x * 31 + y * 17);
    for (let k = 0; k < 3; k++) {
      const t = (this.time * 0.9 + seed + k * 0.33) % 1;
      const r = c * 0.05 * (1 - t * 0.5);
      ctx.globalAlpha = 1 - t;
      ctx.beginPath();
      ctx.arc(cx + (k - 1) * c * 0.16, cy + c * 0.1 - t * c * 0.28, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * INSECT beds — a scatter of grubs. Deliberately restless and slightly unpleasant:
   * this ground ROTS the defence of everyone standing on it except SPORE.
   */
  private drawBugs(x: number, y: number, owned: boolean): void {
    const ctx = this.ctx;
    const c = this.cell;
    ctx.fillStyle = owned ? INK.bugGlow : INK.bug;
    for (let k = 0; k < 4; k++) {
      const seed = hash01(x * 13 + y * 7 + k * 101);
      const wob = Math.sin(this.time * 2.2 + seed * 6.28) * c * 0.04;
      const px = x + c * (0.24 + 0.5 * seed);
      const py = y + c * (0.26 + 0.48 * ((seed * 7) % 1)) + wob;
      roundRect(ctx, px - c * 0.07, py - c * 0.04, c * 0.14, c * 0.08, 2);
      ctx.fill();
    }
  }

  private drawSun(x: number, y: number, owned: boolean): void {
    const ctx = this.ctx;
    const c = this.cell;
    const cx = x + c / 2;
    const cy = y + c / 2;
    const r = c * (owned ? 0.2 : 0.26);
    const spin = this.time * 0.5;
    ctx.fillStyle = owned ? INK.sunGlow : INK.sun;
    ctx.beginPath();
    for (let k = 0; k < 16; k++) {
      const ang = spin + (k / 16) * Math.PI * 2;
      const rr = k % 2 === 0 ? r : r * 0.52;
      const px = cx + Math.cos(ang) * rr;
      const py = cy + Math.sin(ang) * rr;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    if (!owned) {
      ctx.strokeStyle = rgba(INK.sun, 0.25 + 0.15 * Math.sin(this.time * 3));
      ctx.lineWidth = Math.max(1, c * 0.05);
      ctx.beginPath();
      ctx.arc(cx, cy, c * 0.4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** Home: a fat ring. Indestructible, and unmistakably the thing to protect. */
  private drawHome(x: number, y: number, s: MatchState, owner: number): void {
    const ctx = this.ctx;
    const c = this.cell;
    const cx = x + c / 2;
    const cy = y + c / 2;
    const colour = owner >= 0 ? seatColour(s.seats, owner) : INK.ash;
    const beat = 0.5 + 0.5 * Math.sin(this.time * 2.2);
    ctx.strokeStyle = lighten(colour, 0.35 * beat);
    ctx.lineWidth = Math.max(2, c * 0.16);
    ctx.beginPath();
    ctx.arc(cx, cy, c * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = darken(colour, 0.35);
    ctx.beginPath();
    ctx.arc(cx, cy, c * 0.14, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawSporeTimer(x: number, y: number, life: number, colour: string): void {
    const ctx = this.ctx;
    const c = this.cell;
    const frac = clamp01(life / 8);
    ctx.strokeStyle = rgba(lighten(colour, 0.5), 0.95);
    ctx.lineWidth = Math.max(1.5, c * 0.09);
    ctx.beginPath();
    ctx.arc(x + c / 2, y + c / 2, c * 0.33, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.stroke();
  }

  /**
   * In-flight claims. The fill rises from the bottom in the CLAIMANT's colour, so
   * you can watch a claim land on you and go contest it before it completes.
   */
  private drawClaims(s: MatchState): void {
    const ctx = this.ctx;
    const board = s.board;
    const c = this.cell;
    for (let i = 0; i < board.cells.length; i++) {
      const cell = board.cells[i];
      let progress = cell.progress;
      let claimant = cell.claimant;
      if (claimant < 0 || progress <= 0) {
        const t = this.optimistic.get(i);
        if (t === undefined) continue;
        // Optimistic: show intent immediately, let the snapshot overwrite it.
        claimant = this.mySeat;
        progress = Math.min(0.35, (this.time - t) * 0.9);
      }
      const p = xy(i, board.w);
      const x = p.x * c;
      const y = p.y * c;
      const colour = seatColour(s.seats, claimant);
      const k = ease(clamp01(progress));
      ctx.save();
      ctx.beginPath();
      roundRect(ctx, x + 2, y + 2, c - 4, c - 4, c * 0.24);
      ctx.clip();
      ctx.fillStyle = rgba(colour, 0.85);
      ctx.fillRect(x + 2, y + 2 + (c - 4) * (1 - k), c - 4, (c - 4) * k);
      ctx.restore();
      ctx.strokeStyle = rgba(lighten(colour, 0.5), 0.55 + 0.45 * Math.sin(this.time * 9));
      ctx.lineWidth = Math.max(1.5, c * 0.07);
      roundRect(ctx, x + 2, y + 2, c - 4, c - 4, c * 0.24);
      ctx.stroke();
    }
  }

  private drawShockwaves(board: Board): void {
    const ctx = this.ctx;
    const c = this.cell;
    for (const w of this.shockwave) {
      const p = xy(w.cell, board.w);
      const k = ease(w.t);
      ctx.strokeStyle = rgba(INK.white, (1 - k) * 0.55);
      ctx.lineWidth = Math.max(2, c * 0.3 * (1 - k));
      ctx.beginPath();
      ctx.arc((p.x + 0.5) * c, (p.y + 0.5) * c, c * (0.5 + k * 7), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** Touch-down affordance: every legal cell lights up, the one under the thumb most. */
  private drawTouch(board: Board): void {
    const ctx = this.ctx;
    const c = this.cell;
    if (this.pressing) {
      for (const [cellIdx, kind] of this.legal) {
        const p = xy(cellIdx, board.w);
        const x = p.x * c;
        const y = p.y * c;
        const tint = TAP_TINT[kind];
        ctx.strokeStyle = rgba(tint, 0.55);
        ctx.lineWidth = Math.max(1.5, c * 0.08);
        roundRect(ctx, x + 2.5, y + 2.5, c - 5, c - 5, c * 0.22);
        ctx.stroke();
        ctx.fillStyle = rgba(tint, 0.12);
        ctx.fill();
      }
      if (this.armed === 'build' && this.pressCell >= 0 && this.state) {
        /*
         * Building. Show the tile you would put a granary on, and refuse to promise
         * one anywhere it cannot go — a store only stands on ground you already hold
         * and that has not got one.
         */
        const c = this.state.board.cells[this.pressCell];
        const ok = c && c.owner === this.mySeat && c.store <= 0;
        const p = xy(this.pressCell, board.w);
        ctx.fillStyle = rgba(ok ? INK.store : '#ff4d4d', 0.22);
        roundRect(ctx, p.x * this.cell + 2, p.y * this.cell + 2, this.cell - 4, this.cell - 4, this.cell * 0.22);
        ctx.fill();
        ctx.strokeStyle = rgba(ok ? INK.store : '#ff4d4d', 0.95);
        ctx.lineWidth = Math.max(2, this.cell * 0.1);
        roundRect(ctx, p.x * this.cell + 2, p.y * this.cell + 2, this.cell - 4, this.cell - 4, this.cell * 0.22);
        ctx.stroke();
      }
      if (this.armed === 'takeover' && this.pressCell >= 0) {
        // The block HOSTILE TAKEOVER would clear, clamped to the board exactly as
        // the simulation clamps it. You must be able to see a 9x9 before you spend.
        const half = Math.floor(TAKEOVER_SIZE / 2);
        const p = xy(this.pressCell, board.w);
        const x0 = Math.max(0, p.x - half);
        const y0 = Math.max(0, p.y - half);
        const x1 = Math.min(board.w - 1, p.x + half);
        const y1 = Math.min(board.h - 1, p.y + half);
        ctx.fillStyle = rgba(INK.acid, 0.16);
        ctx.fillRect(
          this.ox + x0 * this.cell,
          this.oy + y0 * this.cell,
          (x1 - x0 + 1) * this.cell,
          (y1 - y0 + 1) * this.cell,
        );
        ctx.strokeStyle = rgba(INK.acid, 0.9);
        ctx.lineWidth = Math.max(2, this.cell * 0.1);
        ctx.strokeRect(
          this.ox + x0 * this.cell + 1,
          this.oy + y0 * this.cell + 1,
          (x1 - x0 + 1) * this.cell - 2,
          (y1 - y0 + 1) * this.cell - 2,
        );
      }
      if (!this.armed && this.pressCell >= 0) {
        const p = xy(this.pressCell, board.w);
        const kind = this.legal.get(this.pressCell);
        /*
         * A defence is the one tap whose effect is not on the tile you are touching,
         * so the tile under the thumb is not enough: ring every ASSAULT it would push
         * back. Only claims in progress — a defence does not touch anybody's tiles,
         * and marking their ground would promise something it does not do.
         */
        if (kind === 'repel' && this.state) {
          const s = this.state;
          const hits = repelHits(s.board, s.allies, this.mySeat, this.pressCell, repelBonus(s.seats[this.mySeat]));
          for (const i of hits) {
            const q = xy(i, board.w);
            ctx.strokeStyle = rgba(TAP_TINT.repel, 0.9);
            ctx.lineWidth = Math.max(1.5, c * 0.09);
            ctx.beginPath();
            ctx.arc((q.x + 0.5) * c, (q.y + 0.5) * c, c * 0.36, 0, Math.PI * 2);
            ctx.stroke();
            // A short arrow shoved away from the tile doing the defending: this claim
            // is being pushed BACK, not deleted.
            const from = xy(this.pressCell, board.w);
            const dx = Math.sign(q.x - from.x);
            const dy = Math.sign(q.y - from.y);
            if (dx || dy) {
              ctx.beginPath();
              ctx.moveTo((q.x + 0.5) * c, (q.y + 0.5) * c);
              ctx.lineTo((q.x + 0.5 + dx * 0.34) * c, (q.y + 0.5 + dy * 0.34) * c);
              ctx.stroke();
            }
          }
        }
        const tint = kind ? TAP_TINT[kind] : '#ffffff';
        ctx.strokeStyle = tint;
        ctx.lineWidth = Math.max(2.5, c * 0.13);
        const grow = 1 + 0.06 * Math.sin(this.time * 12);
        const w = (c - 2) * grow;
        roundRect(ctx, p.x * c + (c - w) / 2, p.y * c + (c - w) / 2, w, w, c * 0.26);
        ctx.stroke();
      }
    }
    if (this.denyT > 0 && this.denyCell >= 0) {
      const p = xy(this.denyCell, board.w);
      const k = this.denyT / 0.4;
      ctx.strokeStyle = rgba('#ff4d4d', k);
      ctx.lineWidth = Math.max(2, c * 0.12);
      const j = Math.sin(this.time * 40) * c * 0.08 * k;
      roundRect(ctx, p.x * c + 2 + j, p.y * c + 2, c - 4, c - 4, c * 0.24);
      ctx.stroke();
    }
  }
}

export { mix };
