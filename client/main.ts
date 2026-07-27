/**
 * BLOOM — simple version.
 *
 * Deliberately small: pick a role, play a garden against bots on this device.
 * No server, no lobby, no rooms. The local sim (`board/localsim.ts`) is the
 * authority here; when online play returns it is swapped for server snapshots
 * and nothing else in this file changes, because `BoardView` only ever consumes
 * a `MatchState`.
 */

import type { MatchState, RoleId, TechDef, TechId } from '@shared/bloom.js';
import { INSECT_COST, allyKey, isAllied, isDay, techsFor } from '@shared/bloom.js';
import { BoardView } from './board/board.js';
import { LocalGarden } from './board/localsim.js';
import { ROLE_LIST, getRole } from './board/rules.js';

const FRAME_MS = 1000 / 60;
const ROLE_KEY = 'bloom.role';

class Bloom {
  private view: BoardView;
  private game: LocalGarden | null = null;
  private overlay: HTMLElement;
  private last = 0;
  private raf = 0;

  constructor(overlay: HTMLElement) {
    this.overlay = overlay;
    this.view = new BoardView({
      onTap: (cell) => {
        // Seat 0 is always the human in the simple version.
        if (this.game) this.game.tap(0, cell);
      },
      onSever: () => {},
      onDeny: () => {},
    });
    // BoardView builds its own root but never mounts itself — do it here, behind
    // the overlay, so the menu can sit on top of a live board.
    document.body.insertBefore(this.view.root, overlay);
    this.showMenu();
    window.addEventListener('resize', () => this.view.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.view.resize(), 120));
    this.loop(performance.now());
  }

  // ------------------------------------------------------------------ menu

  private showMenu(): void {
    this.view.hide();
    this.overlay.innerHTML = '';
    const wrap = el('div', 'menu');
    wrap.appendChild(el('h1', 'brand', 'BLOOM'));
    wrap.appendChild(el('p', 'tagline', 'Grow your vine. Cut theirs.'));

    const grid = el('div', 'role-grid');
    for (const r of ROLE_LIST) {
      const card = el('button', 'role-card');
      card.style.setProperty('--role', r.colour);
      card.appendChild(el('span', 'role-name', r.name));
      card.appendChild(el('span', 'role-blurb', r.blurb));
      card.addEventListener('click', () => this.start(r.id));
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
    this.overlay.appendChild(wrap);
  }

  // ------------------------------------------------------------------ play

  private start(role: RoleId): void {
    try {
      localStorage.setItem(ROLE_KEY, role);
    } catch {
      /* private mode — the choice just will not persist */
    }
    // One human plus three machine gardens, each on a different role so the four
    // growth rules are visible in a single match.
    const others = ROLE_LIST.map((r) => r.id).filter((id) => id !== role);
    const roles: RoleId[] = [role, others[0], others[1], others[2]];
    this.game = new LocalGarden({
      mode: 'garden',
      roles,
      names: ['YOU', 'IVY', 'FERN', 'BURR'],
      seed: (Math.random() * 1e9) | 0,
    });
    this.overlay.innerHTML = '';
    this.role = role;
    this.resultShown = false;
    this.allyRows = [];
    this.overlay.appendChild(this.hudBar());
    this.overlay.appendChild(this.techPanel());
    this.overlay.appendChild(this.allyPanelEl());
    this.view.show();
    this.view.resize();
  }

  private hudBar(): HTMLElement {
    const bar = el('div', 'hud');
    const back = el('button', 'hud-back', '←');
    back.addEventListener('click', () => {
      this.game = null;
      this.techBtns = [];
      this.techPanelEl = null;
      this.allyRows = [];
      this.showMenu();
    });
    this.energyEl = el('span', 'hud-energy', '0');
    const tech = el('button', 'hud-tech');
    tech.appendChild(el('span', 'hud-tech-icon', '🌱'));
    tech.appendChild(el('span', 'hud-tech-label', 'TECH'));
    this.techPip = el('span', 'hud-tech-pip', '');
    tech.appendChild(this.techPip);
    tech.addEventListener('click', () => this.toggleTech(true));

    // FUNGAL only: hatch an insect. Hidden entirely for the other plants rather
    // than shown disabled, so nobody wonders what a button they can never press does.
    this.hatchBtn = el('button', 'hud-act') as HTMLButtonElement;
    this.hatchBtn.appendChild(el('span', 'hud-act-icon', '🐛'));
    this.hatchBtn.appendChild(el('span', 'hud-act-cost', String(INSECT_COST)));
    this.hatchBtn.addEventListener('click', () => this.game?.hatchInsect(0));
    if (this.role !== 'fungal') this.hatchBtn.classList.add('hidden');

    const ally = el('button', 'hud-act', '🤝');
    ally.addEventListener('click', () => this.toggleAlly(true));

    bar.appendChild(back);
    bar.appendChild(this.energyEl);
    bar.appendChild(this.hatchBtn);
    bar.appendChild(ally);
    bar.appendChild(tech);
    return bar;
  }

  /**
   * The tech tree, as its own screen behind a button.
   *
   * Shared roots first, then this faction's own branch — laid out by tier so the
   * commitment is visible: a tier-2 card is dimmed until its parent is owned.
   */
  private techPanel(): HTMLElement {
    const panel = el('div', 'techpanel hidden');
    const head = el('div', 'techpanel-head');
    head.appendChild(el('h2', 'techpanel-title', 'TECH'));
    const close = el('button', 'techpanel-close', '✕');
    close.addEventListener('click', () => this.toggleTech(false));
    head.appendChild(close);
    panel.appendChild(head);

    this.techBtns = [];
    const list = techsFor(this.role ?? 'vine');

    /*
     * Polytopia-style: each branch is a ROW that reads left to right, tier by tier,
     * with a connector between a tech and the one it unlocks. The shape of the tree
     * is the explanation — you can see that CANOPY sits behind two other things
     * without reading a word about prerequisites.
     */
    const branches: { label: string; items: TechDef[] }[] = [];
    const shared = list.filter((t) => !t.role);
    // Chain the shared ones by their requires links so they lay out as a line too.
    branches.push({ label: 'ROOTS', items: shared });
    branches.push({
      label: (this.role ?? 'vine').toUpperCase(),
      items: list.filter((t) => t.role).sort((a, b) => a.tier - b.tier),
    });

    for (const br of branches) {
      panel.appendChild(el('div', 'techpanel-group', br.label));
      const row = el('div', 'tech-branch');
      const byTier = new Map<number, TechDef[]>();
      for (const t of br.items) {
        const bucket = byTier.get(t.tier) ?? [];
        bucket.push(t);
        byTier.set(t.tier, bucket);
      }
      const tiers = [...byTier.keys()].sort((a, b) => a - b);
      tiers.forEach((tier, ti) => {
        if (ti > 0) row.appendChild(el('div', 'tech-link', ''));
        const col = el('div', 'tech-tier');
        for (const t of byTier.get(tier) ?? []) col.appendChild(this.techCard(t));
        row.appendChild(col);
      });
      panel.appendChild(row);
    }
    panel.addEventListener('click', (e) => {
      if (e.target === panel) this.toggleTech(false);
    });
    this.techPanelEl = panel;
    return panel;
  }

  private techCard(t: TechDef): HTMLButtonElement {
    const b = el('button', 'tech-node') as HTMLButtonElement;
    b.appendChild(el('span', 'tech-icon', t.icon));
    b.appendChild(el('span', 'tech-name', t.name));
    b.appendChild(el('span', 'tech-blurb', t.blurb));
    const cost = el('span', 'tech-cost', String(t.cost));
    b.appendChild(cost);
    b.appendChild(el('span', 'tech-lock', '🔒'));
    b.addEventListener('click', () => {
      if (this.game?.buyTech(0, t.id)) b.classList.add('owned');
    });
    this.techBtns.push({ def: t, el: b });
    return b;
  }

  private toggleTech(open: boolean): void {
    this.techPanelEl?.classList.toggle('hidden', !open);
  }

  private energyEl: HTMLElement | null = null;
  private techBtns: { def: TechDef; el: HTMLButtonElement }[] = [];
  private techPanelEl: HTMLElement | null = null;
  private techPip: HTMLElement | null = null;
  private allyRows: { seat: number; tag: HTMLElement; row: HTMLElement }[] = [];
  private role: RoleId | null = null;
  private resultShown = false;
  private hatchBtn: HTMLButtonElement | null = null;
  private allyPanel: HTMLElement | null = null;

  /** Offer or break a pact with each other plant. Allies cannot eat each other. */
  private allyPanelEl(): HTMLElement {
    const panel = el('div', 'techpanel hidden');
    const head = el('div', 'techpanel-head');
    head.appendChild(el('h2', 'techpanel-title', 'PACTS'));
    const close = el('button', 'techpanel-close', '✕');
    close.addEventListener('click', () => this.toggleAlly(false));
    head.appendChild(close);
    panel.appendChild(head);
    panel.appendChild(el('div', 'techpanel-group', 'ALLIES CANNOT EAT EACH OTHER'));

    const st = this.game?.state;
    for (const seat of st?.seats ?? []) {
      if (seat.seat === 0) continue;
      const row = el('button', 'ally-row') as HTMLButtonElement;
      const dot = el('span', 'result-dot');
      dot.style.background = seat.colour;
      row.appendChild(dot);
      row.appendChild(el('span', 'result-name', seat.name));
      const tag = el('span', 'ally-tag', '');
      row.appendChild(tag);
      row.addEventListener('click', () => {
        const s = this.game?.state;
        if (!s) return;
        const key = allyKey(0, seat.seat);
        const at = s.allies.indexOf(key);
        if (at >= 0) s.allies.splice(at, 1);
        else s.allies.push(key);
      });
      this.allyRows.push({ seat: seat.seat, tag, row });
      panel.appendChild(row);
    }
    panel.addEventListener('click', (e) => {
      if (e.target === panel) this.toggleAlly(false);
    });
    this.allyPanel = panel;
    return panel;
  }

  private toggleAlly(open: boolean): void {
    this.allyPanel?.classList.toggle('hidden', !open);
  }

  /**
   * End-of-match card. Reads the winner off the final state rather than the win
   * event, so it is correct even if the event was drained before we looked.
   */
  private showResult(): void {
    const st = this.game?.state;
    if (!st) return;
    this.toggleTech(false);

    const alive = st.seats.filter((x) => x.alive);
    const best = [...st.seats].sort((a, b) => b.tiles - a.tiles)[0];
    const winner = alive.length === 1 ? alive[0] : best;
    const iWon = winner?.seat === 0;
    const reason =
      alive.length === 1 ? 'last one growing' : 'took over the garden';

    const card = el('div', 'result');
    const box = el('div', 'result-box');
    box.style.setProperty('--role', winner?.colour ?? '#3ddc6b');
    box.appendChild(el('div', 'result-title', iWon ? 'YOU WIN' : `${winner?.name ?? '???'} WINS`));
    box.appendChild(el('div', 'result-reason', reason));

    const table = el('div', 'result-rows');
    for (const seat of [...st.seats].sort((a, b) => b.tiles - a.tiles)) {
      const row = el('div', 'result-row');
      if (seat.seat === 0) row.classList.add('is-you');
      const dot = el('span', 'result-dot');
      dot.style.background = seat.colour;
      row.appendChild(dot);
      row.appendChild(el('span', 'result-name', seat.name));
      row.appendChild(el('span', 'result-tiles', `${seat.tiles}`));
      if (!seat.alive) row.appendChild(el('span', 'result-out', 'OUT'));
      table.appendChild(row);
    }
    box.appendChild(table);

    const again = el('button', 'result-btn', 'PLAY AGAIN');
    again.addEventListener('click', () => {
      if (this.role) this.start(this.role);
    });
    const menu = el('button', 'result-btn ghost', 'CHANGE PLANT');
    menu.addEventListener('click', () => {
      this.game = null;
      this.techBtns = [];
      this.techPanelEl = null;
      this.allyRows = [];
      this.showMenu();
    });
    box.appendChild(again);
    box.appendChild(menu);
    card.appendChild(box);
    this.overlay.appendChild(card);
  }

  // ------------------------------------------------------------------ loop

  private loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop);
    const dtMs = Math.min(100, now - this.last);
    if (dtMs < FRAME_MS - 1) return;
    this.last = now;

    if (this.game) {
      this.game.step(dtMs / 1000);
      // A finished match used to just freeze with no explanation, which read as
      // "the game stopped on a timer". Announce the result instead.
      if (this.game.state.phase === 'complete' && !this.resultShown) {
        this.resultShown = true;
        this.showResult();
      }
      const state: MatchState = this.game.state;
      this.view.setState(state, 0);
      const me = state.seats[0];
      if (this.energyEl) this.energyEl.textContent = me ? String(Math.floor(me.energy)) : '0';
      // Grey out anything unaffordable so a child can see what is reachable.
      const owned = this.game.techFor(0);
      let affordable = 0;
      for (const t of this.techBtns) {
        const have = owned.has(t.def.id);
        const locked = !!t.def.requires && !owned.has(t.def.requires);
        const canBuy = !have && !locked && !!me && me.energy >= t.def.cost;
        if (canBuy) affordable++;
        t.el.classList.toggle('owned', have);
        t.el.classList.toggle('locked', locked);
        t.el.disabled = have || locked || !canBuy;
      }
      if (this.hatchBtn) this.hatchBtn.disabled = !me || me.energy < INSECT_COST;
      for (const a of this.allyRows) {
        const pact = isAllied(state.allies, 0, a.seat);
        a.tag.textContent = pact ? 'ALLIED' : 'TAP TO ALLY';
        a.row.classList.toggle('is-allied', pact);
      }
      document.body.dataset.sky = isDay(state.clock) ? 'day' : 'night';
      // A quiet count on the button so you know there is something to spend on.
      if (this.techPip) {
        this.techPip.textContent = affordable > 0 ? String(affordable) : '';
        this.techPip.classList.toggle('on', affordable > 0);
      }
    }
    this.view.update(dtMs);
  };
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const overlay = document.getElementById('overlay');
if (!overlay) throw new Error('bloom: missing #overlay');
(window as unknown as Record<string, unknown>).bloom = new Bloom(overlay);
