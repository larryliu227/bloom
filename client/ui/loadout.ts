/**
 * VOIDLINE — loadout screen.
 *
 * Role picker (4 cards) + pick-3-of-7 ability grid, with a live preview of the
 * Weave board this configuration produces and the three slot gauges filling at
 * the role's real charge rate.
 */

import { ABILITY_SLOTS, CHARGE_RATE_BASE, MAX_OVERCHARGE } from '@shared/constants.js';
import type { AbilityDef, AbilityId, RoleDef, RoleId, WeaveBoard } from '@shared/types.js';
import { ROLE_LIST, defaultLoadout, getRole } from '@shared/roles.js';
import { abilitiesForRole, getAbility } from '@shared/abilities.js';
import { createBoard } from '@shared/weave.js';
import { add, button, clear, fitCanvas, h, loadLocal, roundRect, rgbTriplet, saveLocal, setText } from './dom.js';
import { drawWeave } from './weave.js';

const ROLE_KEY = 'voidline.role';
const LOADOUT_KEY = (r: RoleId): string => `voidline.loadout.${r}`;

const SHAPE_LABEL: Record<string, string> = {
  projectile: 'PROJECTILE',
  beam: 'BEAM',
  aoe: 'AREA',
  dash: 'DASH',
  buff: 'BUFF',
  summon: 'SUMMON',
  zone: 'ZONE',
};

/**
 * `AbilityDef.damage` is a magnitude field, not literally "damage" — for friendly
 * abilities it carries healing or shield points, and for a pure buff it carries the
 * effect strength as a FRACTION (overclock 0.35 = +35% charge rate).
 *
 * Labelling all of it "DMG" made the support kit unreadable: Ablative Vent read
 * `DMG 28` when it is a 28-point shield, Mend Pulse read `DMG 16` when it heals,
 * and Overclock Link read `DMG 0` because 0.35 rounds to zero. Name the number for
 * what it actually does instead.
 */
function effectLabel(a: AbilityDef): string {
  if (a.applies === 'shield') return 'SHIELD';
  if (a.applies === 'haste') return 'SPEED';
  if (a.applies === 'overclock') return 'CHARGE';
  if (a.friendly) return 'HEAL';
  if (a.shape === 'zone' || (a.shape === 'summon' && a.damage > 0)) return 'DMG/S';
  return 'DMG';
}

function effectValue(a: AbilityDef): string {
  if (a.damage <= 0) return '—';
  // Fractional magnitudes are percentages (haste +45%, overclock +35%).
  if (a.applies === 'haste' || a.applies === 'overclock') {
    return `+${Math.round(a.damage * 100)}%`;
  }
  return String(Math.round(a.damage));
}

export interface LoadoutCallbacks {
  onRole(role: RoleId): void;
  onLoadout(loadout: AbilityId[]): void;
  onConfirm(role: RoleId, loadout: AbilityId[]): void;
  onBack(): void;
}

export class LoadoutScreen {
  readonly root: HTMLElement;

  private cb: LoadoutCallbacks;
  private roleListEl: HTMLElement;
  private abilityGridEl: HTMLElement;
  private slotStrip: HTMLElement;
  private previewCanvas: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;
  private previewMeta: HTMLElement;
  private detailEl: HTMLElement;
  private confirmBtn: HTMLButtonElement;
  private headSub: HTMLElement;

  private roles: RoleDef[] = [];
  private role: RoleDef | null = null;
  private pool: AbilityDef[] = [];
  private picks: Array<AbilityId | null> = new Array(ABILITY_SLOTS).fill(null);
  private armed = 0;
  private board: WeaveBoard | null = null;
  private time = 0;
  private statMax = { hp: 1, speed: 1, damage: 1, charge: 1 };
  private hovered: AbilityDef | null = null;

  constructor(cb: LoadoutCallbacks) {
    this.cb = cb;
    this.root = h('div', 'screen screen-loadout hidden');
    const shell = h('div', 'loadout-shell');

    // ---- header -------------------------------------------------------
    const head = h('div', 'loadout-head');
    const titles = h('div', 'loadout-titles');
    add(titles, h('h2', 'loadout-title', 'CONFIGURE RUNNER'));
    this.headSub = h('div', 'loadout-sub mono', 'SELECT ROLE · ROUTE THREE ABILITIES');
    titles.appendChild(this.headSub);
    const headActions = h('div', 'loadout-head-actions');
    this.confirmBtn = button('CONFIRM', 'primary', () => this.confirm());
    add(headActions, button('BACK', 'ghost', () => this.cb.onBack()), this.confirmBtn);
    add(head, titles, headActions);
    shell.appendChild(head);

    // ---- body: roles | abilities | preview ----------------------------
    const body = h('div', 'loadout-body');

    const rolesCol = h('div', 'loadout-col loadout-roles');
    rolesCol.appendChild(h('div', 'col-title', 'ROLE'));
    this.roleListEl = h('div', 'role-list');
    rolesCol.appendChild(this.roleListEl);
    body.appendChild(rolesCol);

    const abilityCol = h('div', 'loadout-col loadout-abilities');
    const abHead = h('div', 'col-title-row');
    add(abHead, h('div', 'col-title', 'ABILITIES'), h('div', 'col-hint mono', `CHOOSE ${ABILITY_SLOTS}`));
    abilityCol.appendChild(abHead);
    this.abilityGridEl = h('div', 'ability-grid');
    abilityCol.appendChild(this.abilityGridEl);
    this.detailEl = h('div', 'ability-detail');
    abilityCol.appendChild(this.detailEl);
    body.appendChild(abilityCol);

    const previewCol = h('div', 'loadout-col loadout-preview');
    previewCol.appendChild(h('div', 'col-title', 'WEAVE PREVIEW'));
    const canvasWrap = h('div', 'preview-canvas-wrap');
    this.previewCanvas = h('canvas', 'preview-canvas');
    canvasWrap.appendChild(this.previewCanvas);
    const ctx = this.previewCanvas.getContext('2d');
    if (!ctx) throw new Error('loadout: 2d context unavailable');
    this.previewCtx = ctx;
    previewCol.appendChild(canvasWrap);
    this.previewMeta = h('div', 'preview-meta mono');
    previewCol.appendChild(this.previewMeta);
    previewCol.appendChild(h('div', 'col-title', 'OUTPUT SLOTS'));
    this.slotStrip = h('div', 'slot-strip');
    previewCol.appendChild(this.slotStrip);
    body.appendChild(previewCol);

    shell.appendChild(body);
    this.root.appendChild(shell);

    this.buildRoles();
  }

  // ------------------------------------------------------------------ lifecycle

  show(): void {
    this.root.classList.remove('hidden');
    this.renderPreview(true);
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  get selectedRole(): RoleId | null {
    return this.role?.id ?? null;
  }

  get loadout(): AbilityId[] {
    return this.picks.filter((p): p is AbilityId => !!p);
  }

  /** Adopt server-side truth (e.g. after reconnect or a validated loadout). */
  setSelection(role: RoleId | null, loadout: AbilityId[]): void {
    if (role && role !== this.role?.id) this.selectRole(role, false);
    if (loadout.length) {
      const next: Array<AbilityId | null> = new Array(ABILITY_SLOTS).fill(null);
      for (let i = 0; i < Math.min(ABILITY_SLOTS, loadout.length); i++) next[i] = loadout[i];
      this.picks = next;
      this.armed = this.firstEmpty();
      this.refreshPicks();
    }
  }

  update(dtMs: number): void {
    if (!this.visible) return;
    this.time += dtMs / 1000;
    this.renderPreview(false);
    this.tickGauges();
  }

  // ------------------------------------------------------------------ roles

  private buildRoles(): void {
    let list: RoleDef[] = [];
    try {
      list = ROLE_LIST ?? [];
    } catch {
      list = [];
    }
    this.roles = list;
    this.statMax = {
      hp: Math.max(1, ...list.map((r) => r.hpMul)),
      speed: Math.max(1, ...list.map((r) => r.speedMul)),
      damage: Math.max(1, ...list.map((r) => r.damageMul)),
      charge: Math.max(1, ...list.map((r) => r.chargeRateMul)),
    };

    clear(this.roleListEl);
    for (const r of list) {
      const card = h('button', 'role-card');
      card.type = 'button';
      card.dataset.role = r.id;
      card.style.setProperty('--role', r.color);
      card.style.setProperty('--role-rgb', rgbTriplet(r.color));

      const top = h('div', 'role-card-top');
      add(top, h('span', 'role-name', r.name.toUpperCase()), h('span', 'role-size mono', `${r.weaveSize}×${r.weaveSize}`));
      const tagline = h('div', 'role-tagline', r.tagline);
      const stats = h('div', 'role-stats');
      add(
        stats,
        statBar('PWR', r.damageMul / this.statMax.damage, r.color),
        statBar('VIT', r.hpMul / this.statMax.hp, r.color),
        statBar('SPD', r.speedMul / this.statMax.speed, r.color),
        statBar('FLX', r.chargeRateMul / this.statMax.charge, r.color),
      );
      add(card, top, tagline, stats);
      card.addEventListener('click', () => this.selectRole(r.id, true));
      this.roleListEl.appendChild(card);
    }

    const saved = loadLocal(ROLE_KEY) as RoleId;
    const initial = list.find((r) => r.id === saved)?.id ?? list[0]?.id ?? null;
    if (initial) this.selectRole(initial, false);
  }

  private selectRole(id: RoleId, notify: boolean): void {
    let def: RoleDef | null = null;
    try {
      def = getRole(id) ?? null;
    } catch {
      def = this.roles.find((r) => r.id === id) ?? null;
    }
    if (!def) return;
    this.role = def;
    saveLocal(ROLE_KEY, id);

    for (const el of Array.from(this.roleListEl.children)) {
      (el as HTMLElement).classList.toggle('selected', (el as HTMLElement).dataset.role === id);
    }
    this.root.style.setProperty('--accent-role', def.color);
    this.root.style.setProperty('--accent-role-rgb', rgbTriplet(def.color));

    // Ability pool: `abilitiesForRole` returns exactly the role's 7 selectable
    // circuits, in picker order, already excluding the free basic attack.
    let pool: AbilityDef[] = [];
    try {
      pool = abilitiesForRole(id) ?? [];
    } catch {
      pool = [];
    }
    if (!pool.length) {
      pool = (def.abilityPool ?? [])
        .map((aid) => {
          try {
            return getAbility(aid);
          } catch {
            return null;
          }
        })
        .filter((a): a is AbilityDef => !!a);
    }
    this.pool = pool;

    // restore a stored loadout for this role, else the designer default
    const stored = loadLocal(LOADOUT_KEY(id));
    let chosen: AbilityId[] = stored ? stored.split(',').filter(Boolean) : [];
    chosen = chosen.filter((a) => pool.some((p) => p.id === a));
    if (chosen.length < ABILITY_SLOTS) {
      let fallback: AbilityId[] = [];
      try {
        fallback = defaultLoadout(id) ?? [];
      } catch {
        fallback = [];
      }
      if (!fallback.length) fallback = pool.slice(0, ABILITY_SLOTS).map((a) => a.id);
      for (const a of fallback) {
        if (chosen.length >= ABILITY_SLOTS) break;
        if (!chosen.includes(a)) chosen.push(a);
      }
    }
    this.picks = new Array(ABILITY_SLOTS).fill(null);
    for (let i = 0; i < Math.min(ABILITY_SLOTS, chosen.length); i++) this.picks[i] = chosen[i];
    this.armed = this.firstEmpty();

    this.buildAbilityGrid();
    this.refreshPicks();
    setText(
      this.headSub,
      `${def.name.toUpperCase()} · ${def.weaveSize}×${def.weaveSize} LATTICE · CHOOSE ${ABILITY_SLOTS} OF ${pool.length}`,
    );
    if (notify) {
      this.cb.onRole(id);
      this.emitLoadout();
    }
  }

  // ------------------------------------------------------------------ abilities

  private buildAbilityGrid(): void {
    clear(this.abilityGridEl);
    for (const a of this.pool) {
      const card = h('button', 'ability-card');
      card.type = 'button';
      card.dataset.ability = a.id;

      const icon = h('span', 'ability-icon', a.icon || '◆');
      const badge = h('span', 'ability-badge mono', '');
      const nameRow = h('div', 'ability-name-row');
      add(nameRow, h('span', 'ability-name', a.name), h('span', 'ability-shape mono', SHAPE_LABEL[a.shape] ?? a.shape.toUpperCase()));
      const numbers = h('div', 'ability-numbers mono');
      add(
        numbers,
        numChip('COST', a.cost.toFixed(1)),
        numChip(effectLabel(a), effectValue(a)),
        numChip('RNG', a.range > 0 ? String(Math.round(a.range)) : '—'),
      );
      const desc = h('div', 'ability-desc', a.description);
      add(card, icon, badge, nameRow, numbers, desc);

      card.addEventListener('click', () => this.toggleAbility(a.id));
      card.addEventListener('mouseenter', () => {
        this.hovered = a;
        this.renderDetail();
      });
      card.addEventListener('mouseleave', () => {
        if (this.hovered === a) {
          this.hovered = null;
          this.renderDetail();
        }
      });
      this.abilityGridEl.appendChild(card);
    }
    this.renderDetail();
  }

  private toggleAbility(id: AbilityId): void {
    const existing = this.picks.indexOf(id);
    if (existing >= 0) {
      this.picks[existing] = null;
      this.armed = existing;
    } else {
      const target = this.picks[this.armed] === null ? this.armed : this.firstEmpty(this.armed);
      this.picks[target] = id;
      this.armed = this.firstEmpty(target + 1);
      this.pulse(id);
    }
    this.refreshPicks();
    this.emitLoadout();
  }

  private firstEmpty(from = 0): number {
    for (let k = 0; k < ABILITY_SLOTS; k++) {
      const i = (from + k) % ABILITY_SLOTS;
      if (this.picks[i] === null) return i;
    }
    return from % ABILITY_SLOTS;
  }

  private pulse(id: AbilityId): void {
    const el = this.abilityGridEl.querySelector<HTMLElement>(`[data-ability="${cssEscape(id)}"]`);
    if (!el) return;
    el.classList.remove('pick-pulse');
    // force reflow so the animation restarts on every pick
    void el.offsetWidth;
    el.classList.add('pick-pulse');
  }

  private refreshPicks(): void {
    for (const el of Array.from(this.abilityGridEl.children)) {
      const card = el as HTMLElement;
      const idx = this.picks.indexOf(card.dataset.ability ?? '');
      card.classList.toggle('selected', idx >= 0);
      const badge = card.querySelector('.ability-badge');
      if (badge) badge.textContent = idx >= 0 ? String(idx + 1) : '';
    }
    this.buildSlotStrip();
    this.rebuildBoard();
    const complete = this.loadout.length === ABILITY_SLOTS;
    this.confirmBtn.disabled = !complete || !this.role;
    this.confirmBtn.classList.toggle('attention', complete);
  }

  private buildSlotStrip(): void {
    clear(this.slotStrip);
    const role = this.role;
    const rate = CHARGE_RATE_BASE * (role?.chargeRateMul ?? 1);
    for (let i = 0; i < ABILITY_SLOTS; i++) {
      const id = this.picks[i];
      const def = id ? tryAbility(id) : null;
      const row = h('div', 'slot-row');
      row.dataset.slot = String(i);
      row.classList.toggle('armed', i === this.armed);
      row.classList.toggle('empty', !def);

      const key = h('span', 'slot-key mono', String(i + 1));
      const icon = h('span', 'slot-icon', def?.icon ?? '·');
      const info = h('div', 'slot-info');
      add(
        info,
        h('span', 'slot-name', def ? def.name : 'EMPTY SLOT'),
        h(
          'span',
          'slot-sub mono',
          def ? `${def.cost.toFixed(1)} CHARGE · ${(def.cost / Math.max(0.0001, rate)).toFixed(1)}s` : 'SELECT AN ABILITY',
        ),
      );
      const gauge = h('div', 'slot-gauge');
      const fill = h('div', 'slot-gauge-fill');
      gauge.appendChild(fill);

      add(row, key, icon, info, gauge);
      row.addEventListener('click', () => {
        this.armed = i;
        if (this.picks[i]) {
          this.picks[i] = null;
          this.emitLoadout();
        }
        this.refreshPicks();
      });
      this.slotStrip.appendChild(row);
    }
  }

  private tickGauges(): void {
    const role = this.role;
    const rate = CHARGE_RATE_BASE * (role?.chargeRateMul ?? 1);
    for (const el of Array.from(this.slotStrip.children)) {
      const row = el as HTMLElement;
      const i = Number(row.dataset.slot);
      const id = this.picks[i];
      const def = id ? tryAbility(id) : null;
      const fill = row.querySelector<HTMLElement>('.slot-gauge-fill');
      if (!fill) continue;
      if (!def) {
        fill.style.width = '0%';
        continue;
      }
      // loop the fill at the true charge rate so cheap vs expensive reads instantly
      const period = def.cost / Math.max(0.0001, rate) + 0.6;
      const t = ((this.time + i * 0.35) % period) / period;
      const frac = Math.min(1, (t * period * rate) / def.cost);
      fill.style.width = `${Math.round(frac * 100)}%`;
      row.classList.toggle('ready', frac >= 1);
    }
  }

  private renderDetail(): void {
    clear(this.detailEl);
    const a = this.hovered ?? (this.picks[this.armed] ? tryAbility(this.picks[this.armed]!) : null) ?? null;
    if (!a) {
      this.detailEl.appendChild(h('div', 'detail-empty mono', 'HOVER AN ABILITY FOR TELEMETRY'));
      return;
    }
    const head = h('div', 'detail-head');
    add(head, h('span', 'detail-icon', a.icon || '◆'), h('span', 'detail-name', a.name), h('span', 'detail-shape mono', SHAPE_LABEL[a.shape] ?? a.shape));
    const grid = h('div', 'detail-grid mono');
    add(
      grid,
      numChip('COST', a.cost.toFixed(1)),
      numChip(effectLabel(a) === 'DMG' ? 'DAMAGE' : effectLabel(a), effectValue(a)),
      numChip('RANGE', a.range > 0 ? String(Math.round(a.range)) : '—'),
      numChip('RADIUS', a.radius > 0 ? String(Math.round(a.radius)) : '—'),
      numChip('SPEED', a.speed > 0 ? String(Math.round(a.speed)) : '—'),
      numChip('DURATION', a.duration > 0 ? `${a.duration.toFixed(1)}s` : '—'),
    );
    const tags = h('div', 'detail-tags');
    if (a.applies) tags.appendChild(h('span', 'tag', a.applies.toUpperCase()));
    if (a.friendly) tags.appendChild(h('span', 'tag tag-friendly', 'ALLY TARGET'));
    if (a.scalesWithOvercharge) tags.appendChild(h('span', 'tag tag-over', `OVERCHARGE ×${MAX_OVERCHARGE}`));
    add(this.detailEl, head, h('div', 'detail-desc', a.description), grid, tags);
  }

  // ------------------------------------------------------------------ preview

  private rebuildBoard(): void {
    const role = this.role;
    if (!role) {
      this.board = null;
      return;
    }
    const loadout = this.loadout;
    const seed = hashSeed(role.id + '|' + loadout.join(','));
    let board: WeaveBoard | null = null;
    try {
      board = createBoard(role.weaveSize, loadout.length ? loadout : role.abilityPool.slice(0, ABILITY_SLOTS), seed);
    } catch {
      board = null;
    }
    this.board = board ?? fallbackBoard(role.weaveSize, loadout);
    setText(
      this.previewMeta,
      `${role.weaveSize}×${role.weaveSize} LATTICE · ${role.weaveSize * role.weaveSize} CELLS · CHARGE ×${role.chargeRateMul.toFixed(2)}`,
    );
  }

  private renderPreview(force: boolean): void {
    const wrap = this.previewCanvas.parentElement;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;
    const side = Math.floor(Math.min(rect.width, rect.height));
    const { w, h: hh } = fitCanvas(this.previewCanvas, side, side);
    const dpr = this.previewCanvas.width / Math.max(1, w);
    const ctx = this.previewCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);

    const board = this.board;
    if (!board) {
      ctx.save();
      ctx.strokeStyle = 'rgba(120,160,190,0.25)';
      roundRect(ctx, 8, 8, w - 16, hh - 16, 10);
      ctx.stroke();
      ctx.restore();
      return;
    }
    const pad = 14;
    const cell = Math.floor((Math.min(w, hh) - pad * 2) / board.size);
    const boardPx = cell * board.size;
    drawWeave(ctx, board, Math.round((w - boardPx) / 2), Math.round((hh - boardPx) / 2), cell, {
      time: this.time,
      accent: this.role?.color ?? '#5ef0ff',
      hover: -1,
      costs: this.picks.map((p) => (p ? (tryAbility(p)?.cost ?? 1) : 1)),
      icons: this.picks.map((p) => (p ? (tryAbility(p)?.icon ?? '◆') : '·')),
      showCharge: false,
      glow: force ? 1 : 1,
    });
  }

  // ------------------------------------------------------------------ output

  private emitLoadout(): void {
    const role = this.role;
    if (!role) return;
    const l = this.loadout;
    saveLocal(LOADOUT_KEY(role.id), l.join(','));
    this.cb.onLoadout(l);
  }

  private confirm(): void {
    const role = this.role;
    const l = this.loadout;
    if (!role || l.length !== ABILITY_SLOTS) return;
    saveLocal(LOADOUT_KEY(role.id), l.join(','));
    this.cb.onConfirm(role.id, l);
  }
}

// ---------------------------------------------------------------- helpers

function statBar(label: string, value: number, color: string): HTMLElement {
  const row = h('div', 'stat-bar');
  row.appendChild(h('span', 'stat-bar-label mono', label));
  const track = h('div', 'stat-bar-track');
  const fill = h('div', 'stat-bar-fill');
  fill.style.width = `${Math.round(Math.max(0.06, Math.min(1, value)) * 100)}%`;
  fill.style.background = color;
  track.appendChild(fill);
  row.appendChild(track);
  return row;
}

function numChip(label: string, value: string): HTMLElement {
  const chip = h('span', 'num-chip');
  add(chip, h('span', 'num-chip-label', label), h('span', 'num-chip-value', value));
  return chip;
}

function tryAbility(id: AbilityId): AbilityDef | null {
  try {
    return getAbility(id) ?? null;
  } catch {
    return null;
  }
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

function hashSeed(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

/**
 * Display-only stand-in used if the board generator is unavailable — shows the
 * grid dimensions and where the core and the three output slots sit.
 */
function fallbackBoard(size: number, loadout: AbilityId[]): WeaveBoard {
  const tiles = [];
  const n = size * size;
  for (let i = 0; i < n; i++) {
    tiles.push({ kind: 'empty' as const, base: 0, rotation: 0, locked: true, powered: false });
  }
  const core = (((size / 2) | 0) * size) + ((size / 2) | 0);
  tiles[core] = { kind: 'core' as const, base: 15, rotation: 0, locked: true, powered: true };
  const edges = [(size >> 1), n - 1 - (size >> 1), (size >> 1) * size];
  for (let s = 0; s < ABILITY_SLOTS; s++) {
    const idx = Math.min(n - 1, Math.max(0, edges[s] ?? s));
    tiles[idx] = { kind: 'slot' as const, base: 15, rotation: 0, locked: true, powered: false, slotIndex: s };
  }
  return {
    size,
    tiles,
    coreIndex: core,
    slots: new Array(ABILITY_SLOTS).fill(null).map((_, i) => ({
      ability: loadout[i] ?? '',
      charge: 0,
      connected: false,
    })),
  };
}
