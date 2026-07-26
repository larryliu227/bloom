/**
 * VOIDLINE — lobby screen.
 * Room code, roster, chapter select (co-op), ready-up and host start.
 */

import { MAX_PLAYERS_COOP, MAX_PLAYERS_PVP } from '@shared/constants.js';
import type { GameMode, LobbyState, PlayerId, RoleId } from '@shared/types.js';
import { getRole } from '@shared/roles.js';
import { add, button, clear, copyText, h, setText } from './dom.js';

/** Display-only chapter titles (content lives in server/content/chapters.ts). */
export const CHAPTER_NAMES: string[] = [
  'DOCKING SPINE',
  'COOLANT GALLERY',
  'THE CHOIR',
  'REACTOR SHELL',
  'THE FRACTURE',
];

const CHAPTER_BLURBS: string[] = [
  'Board the spine. Learn the lattice under light pressure.',
  'Coolant is venting. The hazard will kill cells on your board.',
  'A sealed choir door. Two runners must route a relay circuit together.',
  'Hold the reactor shell. Waves, no pauses, no cover.',
  'The fracture answers. It will scramble your Weave mid-fight.',
];

/**
 * AI runner tiers. The server owns the behaviour (`server/systems/bots.ts`);
 * these are the labels and the one-line promise each tier makes to the player.
 */
const BOT_TIERS = ['recruit', 'veteran', 'ace'] as const;
type BotTierName = (typeof BOT_TIERS)[number];

const BOT_TIER_BLURBS: Record<BotTierName, string> = {
  recruit: 'Slow to read the Weave, wide aim, rarely dodges. A sparring partner.',
  veteran: 'Routes a circuit in about two seconds, leads its shots, dodges half of what it sees.',
  ace: 'Reads the board almost instantly, dodges telegraphs, punishes a bad route.',
};

const MODE_LABEL: Record<GameMode, string> = {
  pvp_duel: 'DUEL · BEST OF 5',
  pvp_arena: 'ARENA · FREE FOR ALL',
  coop_story: 'CO-OP STORY',
};

export interface LobbyCallbacks {
  onReady(ready: boolean): void;
  onStart(): void;
  onLeave(): void;
  onChapter(chapter: number): void;
  onEditLoadout(): void;
  onChat(text: string): void;
  /** Host only: add an AI runner at the selected tier. */
  onAddBot(tier: BotTierName): void;
  /** Host only: remove the most recently added AI runner. */
  onRemoveBot(): void;
}

export class LobbyScreen {
  readonly root: HTMLElement;

  private cb: LobbyCallbacks;
  private codeEl: HTMLElement;
  private modeEl: HTMLElement;
  private countEl: HTMLElement;
  private rosterEl: HTMLElement;
  private chapterWrap: HTMLElement;
  private chapterGrid: HTMLElement;
  private chapterBlurb: HTMLElement;
  private botsWrap: HTMLElement;
  private botTierGrid: HTMLElement;
  private botBlurb: HTMLElement;
  private botAddBtn: HTMLButtonElement;
  private botRemoveBtn: HTMLButtonElement;
  private botTier: BotTierName = 'veteran';
  private readyBtn: HTMLButtonElement;
  private startBtn: HTMLButtonElement;
  private loadoutBtn: HTMLButtonElement;
  private statusEl: HTMLElement;
  private chatLog: HTMLElement;
  private chatInput: HTMLInputElement;
  private copyNote: HTMLElement;

  private state: LobbyState | null = null;
  private selfId: PlayerId = '';

  constructor(cb: LobbyCallbacks) {
    this.cb = cb;
    this.root = h('div', 'screen screen-lobby hidden');
    const shell = h('div', 'lobby-shell');

    // ---- header: room code -------------------------------------------
    const head = h('div', 'lobby-head');
    const codeBlock = h('button', 'code-block');
    codeBlock.type = 'button';
    codeBlock.title = 'Copy room code';
    this.codeEl = h('span', 'code-value mono', '------');
    this.copyNote = h('span', 'code-note', 'CLICK TO COPY');
    add(codeBlock, h('span', 'code-label', 'ROOM CODE'), this.codeEl, this.copyNote);
    codeBlock.addEventListener('click', () => this.copyCode());

    const headMeta = h('div', 'lobby-head-meta');
    this.modeEl = h('div', 'lobby-mode', '—');
    this.countEl = h('div', 'lobby-count mono', '0/0 RUNNERS');
    add(headMeta, this.modeEl, this.countEl);

    add(head, codeBlock, headMeta, button('LEAVE', 'danger', () => this.cb.onLeave()));
    shell.appendChild(head);

    // ---- body ---------------------------------------------------------
    const body = h('div', 'lobby-body');

    const rosterPanel = h('div', 'panel lobby-roster');
    rosterPanel.appendChild(h('div', 'panel-title', 'ROSTER'));
    this.rosterEl = h('div', 'roster-list');
    rosterPanel.appendChild(this.rosterEl);
    body.appendChild(rosterPanel);

    const side = h('div', 'lobby-side');

    this.chapterWrap = h('div', 'panel lobby-chapters hidden');
    this.chapterWrap.appendChild(h('div', 'panel-title', 'CHAPTER'));
    this.chapterGrid = h('div', 'chapter-grid');
    for (let i = 0; i < CHAPTER_NAMES.length; i++) {
      const b = h('button', 'chapter-btn');
      b.type = 'button';
      b.dataset.chapter = String(i + 1);
      add(b, h('span', 'chapter-num mono', String(i + 1).padStart(2, '0')), h('span', 'chapter-name', CHAPTER_NAMES[i]));
      b.addEventListener('click', () => this.cb.onChapter(i + 1));
      this.chapterGrid.appendChild(b);
    }
    this.chapterBlurb = h('div', 'chapter-blurb', CHAPTER_BLURBS[0]);
    add(this.chapterWrap, this.chapterGrid, this.chapterBlurb);
    side.appendChild(this.chapterWrap);

    // ---- AI runners (host only) ---------------------------------------
    // Lets one person fill a lobby: the server owns the behaviour, this only
    // picks a tier and asks for a body.
    this.botsWrap = h('div', 'panel lobby-bots hidden');
    this.botsWrap.appendChild(h('div', 'panel-title', 'AI RUNNERS'));
    this.botTierGrid = h('div', 'bot-tier-grid');
    for (const tier of BOT_TIERS) {
      const b = h('button', 'bot-tier-btn');
      b.type = 'button';
      b.dataset.tier = tier;
      b.appendChild(h('span', 'bot-tier-name', tier.toUpperCase()));
      b.addEventListener('click', () => this.selectBotTier(tier));
      this.botTierGrid.appendChild(b);
    }
    this.botBlurb = h('div', 'bot-blurb', BOT_TIER_BLURBS[this.botTier]);
    const botBtns = h('div', 'bot-actions');
    this.botAddBtn = button('ADD RUNNER', 'ghost', () => this.cb.onAddBot(this.botTier));
    this.botRemoveBtn = button('REMOVE', 'ghost', () => this.cb.onRemoveBot());
    add(botBtns, this.botAddBtn, this.botRemoveBtn);
    add(this.botsWrap, this.botTierGrid, this.botBlurb, botBtns);
    side.appendChild(this.botsWrap);

    const chatPanel = h('div', 'panel lobby-chat');
    chatPanel.appendChild(h('div', 'panel-title', 'COMMS'));
    this.chatLog = h('div', 'chat-log');
    this.chatInput = h('input', 'field chat-input');
    this.chatInput.type = 'text';
    this.chatInput.maxLength = 120;
    this.chatInput.placeholder = 'transmit…';
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.chatInput.value.trim();
        this.chatInput.value = '';
        if (text) this.cb.onChat(text);
      }
    });
    add(chatPanel, this.chatLog, this.chatInput);
    side.appendChild(chatPanel);

    body.appendChild(side);
    shell.appendChild(body);

    // ---- footer -------------------------------------------------------
    const foot = h('div', 'lobby-foot');
    this.loadoutBtn = button('LOADOUT', 'ghost', () => this.cb.onEditLoadout());
    this.readyBtn = button('READY UP', 'primary', () => {
      const me = this.me();
      this.cb.onReady(!(me?.ready ?? false));
    });
    this.startBtn = button('START MATCH', 'primary', () => this.cb.onStart());
    this.startBtn.classList.add('hidden');
    this.statusEl = h('div', 'lobby-status mono', 'waiting for runners');
    add(foot, this.loadoutBtn, this.readyBtn, this.startBtn, this.statusEl);
    shell.appendChild(foot);

    this.root.appendChild(shell);
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  pushChat(name: string, text: string): void {
    const line = h('div', 'chat-line');
    add(line, h('span', 'chat-name', name), h('span', 'chat-text', text));
    this.chatLog.appendChild(line);
    while (this.chatLog.childElementCount > 40) this.chatLog.removeChild(this.chatLog.firstChild!);
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  setState(state: LobbyState, selfId: PlayerId): void {
    this.state = state;
    this.selfId = selfId;

    setText(this.codeEl, state.roomId);
    setText(this.modeEl, MODE_LABEL[state.mode] ?? state.mode);
    const cap = state.maxPlayers || (state.mode === 'coop_story' ? MAX_PLAYERS_COOP : MAX_PLAYERS_PVP);
    setText(this.countEl, `${state.players.length}/${cap} RUNNERS`);

    // roster
    clear(this.rosterEl);
    for (const p of state.players) {
      const row = h('div', 'roster-row');
      row.classList.toggle('is-self', p.playerId === selfId);
      row.classList.toggle('is-ready', p.ready);
      row.classList.toggle('is-gone', !p.connected);

      const dot = h('span', 'roster-dot');
      const role = p.role ? safeRole(p.role) : null;
      if (role) dot.style.background = role.color;
      const nameEl = h('span', 'roster-name', p.name);
      const roleEl = h('span', 'roster-role mono', role ? role.name.toUpperCase() : 'SELECTING…');
      if (role) roleEl.style.color = role.color;
      const tags = h('span', 'roster-tags');
      if (p.playerId === state.host) tags.appendChild(h('span', 'tag tag-host', 'HOST'));
      if (!p.connected) tags.appendChild(h('span', 'tag tag-gone', 'LINK LOST'));
      const ready = h('span', 'roster-ready mono', p.ready ? 'READY' : 'STANDBY');

      add(row, dot, nameEl, roleEl, tags, ready);
      this.rosterEl.appendChild(row);
    }
    for (let i = state.players.length; i < cap; i++) {
      const row = h('div', 'roster-row roster-empty');
      add(row, h('span', 'roster-dot'), h('span', 'roster-name', 'OPEN SLOT'));
      this.rosterEl.appendChild(row);
    }

    // chapters
    const coop = state.mode === 'coop_story';
    this.chapterWrap.classList.toggle('hidden', !coop);
    if (coop) {
      const isHost = state.host === selfId;
      for (const el of Array.from(this.chapterGrid.children)) {
        const b = el as HTMLButtonElement;
        const n = Number(b.dataset.chapter);
        b.classList.toggle('selected', n === state.chapter);
        b.disabled = !isHost;
      }
      const idx = Math.max(0, Math.min(CHAPTER_BLURBS.length - 1, state.chapter - 1));
      setText(this.chapterBlurb, CHAPTER_BLURBS[idx]);
    }

    // footer controls
    const me = this.me();
    const hasRole = !!me?.role;
    this.readyBtn.classList.toggle('is-on', !!me?.ready);
    const label = this.readyBtn.querySelector('.btn-label');
    if (label) label.textContent = me?.ready ? 'STAND DOWN' : 'READY UP';
    this.readyBtn.disabled = !hasRole;
    this.loadoutBtn.classList.toggle('attention', !hasRole);

    const isHost = state.host === selfId;
    const everyoneReady = state.players.length > 0 && state.players.every((p) => p.ready || !p.connected);
    this.startBtn.classList.toggle('hidden', !isHost);
    this.startBtn.disabled = !everyoneReady;

    // AI runners: only the host fills seats, and only while seats remain.
    const botCount = state.players.filter((p) => p.isBot).length;
    const seatsLeft = state.players.length < state.maxPlayers;
    this.botsWrap.classList.toggle('hidden', !isHost);
    this.botAddBtn.disabled = !seatsLeft;
    this.botRemoveBtn.disabled = botCount === 0;
    this.syncBotTierButtons();

    if (!hasRole) setText(this.statusEl, 'select a role and loadout to ready up');
    else if (state.countdown > 0) setText(this.statusEl, `launching in ${Math.ceil(state.countdown)}…`);
    else if (everyoneReady) setText(this.statusEl, isHost ? 'all runners ready — start when you are' : 'all runners ready — waiting on host');
    else setText(this.statusEl, `waiting on ${state.players.filter((p) => !p.ready).length} runner(s)`);
  }

  private me(): LobbyState['players'][number] | undefined {
    return this.state?.players.find((p) => p.playerId === this.selfId);
  }

  private selectBotTier(tier: BotTierName): void {
    this.botTier = tier;
    setText(this.botBlurb, BOT_TIER_BLURBS[tier]);
    this.syncBotTierButtons();
  }

  private syncBotTierButtons(): void {
    for (const el of Array.from(this.botTierGrid.children)) {
      el.classList.toggle('selected', (el as HTMLElement).dataset.tier === this.botTier);
    }
  }

  private copyCode(): void {
    const code = this.state?.roomId;
    if (!code) return;
    void copyText(code).then((ok) => {
      setText(this.copyNote, ok ? 'COPIED' : 'COPY FAILED');
      this.copyNote.classList.add('flash');
      window.setTimeout(() => {
        setText(this.copyNote, 'CLICK TO COPY');
        this.copyNote.classList.remove('flash');
      }, 1400);
    });
  }
}

/** getRole() throws on unknown ids in some builds — never let the lobby die for it. */
function safeRole(id: RoleId): { name: string; color: string } | null {
  try {
    const r = getRole(id);
    return r ? { name: r.name, color: r.color } : null;
  } catch {
    return null;
  }
}
