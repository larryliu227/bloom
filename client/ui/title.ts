/**
 * VOIDLINE — title / play screen.
 * Presents as station software coming up on a cold boot.
 */

import type { GameMode } from '@shared/types.js';
import type { ConnectionState } from '../net/connection.js';
import { add, button, h, loadLocal, normalizeCode, saveLocal, setText } from './dom.js';

const NAME_KEY = 'voidline.name';

const BOOT_LINES: string[] = [
  'VOIDLINE STATION // conduit lattice interface',
  'cold boot .... ok',
  'reactor telemetry .... FRACTURING',
  'lattice integrity .... 41%',
  'runner uplink .... standby',
];

const MODE_CARDS: Array<{ mode: GameMode; key: string; name: string; blurb: string; meta: string }> = [
  {
    mode: 'pvp_duel',
    key: 'DUEL',
    name: 'DUEL',
    blurb: '1v1. Best of five. Boards scramble between rounds.',
    meta: '2 RUNNERS',
  },
  {
    mode: 'pvp_arena',
    key: 'ARENA',
    name: 'ARENA',
    blurb: 'Up to eight runners, free-for-all or auto-balanced teams.',
    meta: '2-8 RUNNERS',
  },
  {
    mode: 'coop_story',
    key: 'STORY',
    name: 'CO-OP STORY',
    blurb: 'Four runners, five chapters, cross-player relay circuits.',
    meta: '1-4 RUNNERS',
  },
];

export interface TitleCallbacks {
  onName(name: string): void;
  onQuickPlay(mode: GameMode): void;
  onCreateRoom(mode: GameMode): void;
  onJoin(code: string): void;
}

export class TitleScreen {
  readonly root: HTMLElement;

  private nameInput: HTMLInputElement;
  private codeInput: HTMLInputElement;
  private statusEl: HTMLElement;
  private errorEl: HTMLElement;
  private bootEl: HTMLElement;
  private cardsEl: HTMLElement;
  private joinBtn: HTMLButtonElement;
  private cb: TitleCallbacks;
  private selected: GameMode = 'pvp_arena';
  private busy = false;
  private bootTimer: number | null = null;

  constructor(cb: TitleCallbacks) {
    this.cb = cb;
    this.root = h('div', 'screen screen-title');

    const shell = h('div', 'title-shell');

    // ---- boot log -----------------------------------------------------
    this.bootEl = h('pre', 'boot-log mono');
    shell.appendChild(this.bootEl);

    // ---- wordmark -----------------------------------------------------
    const brand = h('div', 'brand');
    const mark = h('h1', 'brand-mark');
    for (const ch of 'VOIDLINE') mark.appendChild(h('span', 'brand-ch', ch));
    add(
      brand,
      mark,
      h('div', 'brand-sub', 'ROUTE POWER · CHARGE THE CIRCUIT · DO NOT STOP MOVING'),
    );
    shell.appendChild(brand);

    // ---- identity -----------------------------------------------------
    const idRow = h('div', 'panel panel-id');
    const label = h('label', 'field-label', 'RUNNER ID');
    label.setAttribute('for', 'name-input');
    this.nameInput = h('input', 'field mono');
    this.nameInput.id = 'name-input';
    this.nameInput.type = 'text';
    this.nameInput.maxLength = 14;
    this.nameInput.spellcheck = false;
    this.nameInput.autocomplete = 'off';
    this.nameInput.placeholder = 'callsign';
    this.nameInput.value = loadLocal(NAME_KEY, randomName());
    this.nameInput.addEventListener('input', () => this.commitName());
    this.nameInput.addEventListener('change', () => this.commitName());
    add(idRow, label, this.nameInput);
    shell.appendChild(idRow);

    // ---- mode cards ---------------------------------------------------
    this.cardsEl = h('div', 'mode-grid');
    for (const m of MODE_CARDS) {
      const card = h('button', 'mode-card');
      card.type = 'button';
      card.dataset.mode = m.mode;
      add(
        card,
        h('span', 'mode-key mono', m.key),
        h('span', 'mode-name', m.name),
        h('span', 'mode-blurb', m.blurb),
        h('span', 'mode-meta mono', m.meta),
      );
      card.addEventListener('click', () => this.select(m.mode));
      card.addEventListener('dblclick', () => this.quickPlay());
      this.cardsEl.appendChild(card);
    }
    shell.appendChild(this.cardsEl);

    // ---- actions ------------------------------------------------------
    const actions = h('div', 'title-actions');
    const quick = button('QUICK PLAY', 'primary', () => this.quickPlay());
    const create = button('CREATE ROOM', 'ghost', () => {
      if (this.busy) return;
      this.commitName();
      this.cb.onCreateRoom(this.selected);
    });
    add(actions, quick, create);
    shell.appendChild(actions);

    // ---- join by code -------------------------------------------------
    const joinRow = h('div', 'panel panel-join');
    const joinLabel = h('label', 'field-label', 'JOIN BY CODE');
    joinLabel.setAttribute('for', 'code-input');
    this.codeInput = h('input', 'field field-code mono');
    this.codeInput.id = 'code-input';
    this.codeInput.type = 'text';
    this.codeInput.maxLength = 6;
    this.codeInput.spellcheck = false;
    this.codeInput.autocomplete = 'off';
    this.codeInput.placeholder = '------';
    this.codeInput.addEventListener('input', () => {
      const c = normalizeCode(this.codeInput.value);
      if (this.codeInput.value !== c) this.codeInput.value = c;
      this.joinBtn.disabled = c.length !== 6;
    });
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.join();
    });
    this.joinBtn = button('LINK', 'ghost', () => this.join());
    this.joinBtn.disabled = true;
    add(joinRow, joinLabel, this.codeInput, this.joinBtn);
    shell.appendChild(joinRow);

    // ---- status -------------------------------------------------------
    this.errorEl = h('div', 'title-error');
    this.statusEl = h('div', 'title-status mono', 'uplink offline');
    add(shell, this.errorEl, this.statusEl);

    const foot = h('div', 'title-foot mono');
    add(
      foot,
      h('span', '', 'WASD MOVE'),
      h('span', '', 'MOUSE AIM'),
      h('span', '', 'LMB ATTACK'),
      h('span', '', '1·2·3 WEAVE SLOTS'),
      h('span', '', 'SPACE DASH'),
      h('span', '', 'F INTERACT'),
      h('span', '', 'TAB SCORES'),
    );
    shell.appendChild(foot);

    this.root.appendChild(shell);
    this.select(this.selected);
    this.commitName();
  }

  get name(): string {
    return this.nameInput.value.trim() || 'runner';
  }

  show(): void {
    this.root.classList.remove('hidden');
    this.setBusy(false);
    this.runBoot();
  }

  hide(): void {
    this.root.classList.add('hidden');
    if (this.bootTimer !== null) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
  }

  /** Pre-fill the join field, e.g. from a `#CODE` deep link. */
  setCode(code: string): void {
    const c = normalizeCode(code);
    this.codeInput.value = c;
    this.joinBtn.disabled = c.length !== 6;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.root.classList.toggle('busy', busy);
  }

  setError(message: string): void {
    setText(this.errorEl, message);
    this.errorEl.classList.toggle('visible', message.length > 0);
    if (message) this.setBusy(false);
  }

  setConnection(state: ConnectionState, detail: string): void {
    const text =
      state === 'open'
        ? `uplink established · ${detail}`
        : state === 'connecting'
          ? `handshaking · ${detail}`
          : state === 'reconnecting'
            ? `link lost · retrying · ${detail}`
            : 'uplink offline';
    setText(this.statusEl, text);
    this.statusEl.dataset.state = state;
  }

  // ------------------------------------------------------------------ internals

  private commitName(): void {
    const n = this.name;
    saveLocal(NAME_KEY, n);
    this.cb.onName(n);
  }

  private select(mode: GameMode): void {
    this.selected = mode;
    for (const el of Array.from(this.cardsEl.children)) {
      (el as HTMLElement).classList.toggle('selected', (el as HTMLElement).dataset.mode === mode);
    }
  }

  private quickPlay(): void {
    if (this.busy) return;
    this.commitName();
    this.setError('');
    this.setBusy(true);
    this.cb.onQuickPlay(this.selected);
  }

  private join(): void {
    if (this.busy) return;
    const code = normalizeCode(this.codeInput.value);
    if (code.length !== 6) return;
    this.commitName();
    this.setError('');
    this.setBusy(true);
    this.cb.onJoin(code);
  }

  private runBoot(): void {
    if (this.bootTimer !== null) return;
    if (this.bootEl.dataset.done === '1') return;
    let line = 0;
    let col = 0;
    this.bootEl.textContent = '';
    const step = (): void => {
      if (line >= BOOT_LINES.length) {
        this.bootEl.dataset.done = '1';
        this.bootTimer = null;
        this.root.classList.add('booted');
        return;
      }
      const src = BOOT_LINES[line];
      col += 3;
      const shown = BOOT_LINES.slice(0, line).join('\n');
      this.bootEl.textContent = (line ? shown + '\n' : '') + src.slice(0, col);
      if (col >= src.length) {
        line++;
        col = 0;
        this.bootTimer = window.setTimeout(step, 90);
      } else {
        this.bootTimer = window.setTimeout(step, 12);
      }
    };
    step();
  }
}

const NAME_PARTS_A = ['NULL', 'ARC', 'VOID', 'HEX', 'ION', 'RUST', 'ECHO', 'FLUX'];
const NAME_PARTS_B = ['WIRE', 'DRIFT', 'SPUR', 'LINE', 'FALL', 'CORE', 'HOLD'];

function randomName(): string {
  const a = NAME_PARTS_A[Math.floor(Math.random() * NAME_PARTS_A.length)];
  const b = NAME_PARTS_B[Math.floor(Math.random() * NAME_PARTS_B.length)];
  return `${a}${b}`;
}
