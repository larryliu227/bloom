/**
 * BLOOM — the app.
 *
 * Two ways to play, one game. Solo runs the shared simulation on this device;
 * online receives it from the server 20 times a second. Everything downstream of
 * `Session` — the board, the HUD, the tech tree, the pact panel, the result card —
 * cannot tell the difference, because both hand it the same `MatchState`.
 *
 * That indirection is the entire reason online play is a small file rather than a
 * second client. `Session` has five verbs (tap, buyTech, hatch, pact, step); solo
 * answers them by calling the simulation, online by putting a message on a socket.
 * Nothing else in here knows which.
 */

import type { Currency, MatchState, RoleId, TechDef, TechId } from '@shared/bloom.js';
import { CURRENCIES, CURRENCY_ICON, INSECT_COST, STORE_COST, TAKEOVER_COST, isAllied, isDay, techsFor } from '@shared/bloom.js';
import { Garden, MAP_BLURBS, MAP_NAMES } from '@shared/garden.js';
import { ROLE_LIST, getRole } from '@shared/rules.js';
import type { LobbyState, MatchResult } from '@shared/protocol.js';
import { BoardView } from './board/board.js';
import { Connection } from './net/connection.js';
import type { ConnStatus } from './net/connection.js';

const FRAME_MS = 1000 / 60;
const ROLE_KEY = 'bloom.role';
const NAME_KEY = 'bloom.name';

/**
 * A match in progress, however it is being refereed.
 *
 * `step` is the only asymmetry left: solo has to advance the simulation itself,
 * online has nothing to do because the next snapshot is already on its way.
 */
interface Session {
  readonly state: MatchState | null;
  readonly mySeat: number;
  readonly online: boolean;
  /** Draft only: claim a plant now that the map is on screen. */
  chooseRole(role: RoleId): void;
  tap(cell: number): void;
  /** SPORE only: HOSTILE TAKEOVER centred on `cell`. */
  takeover(cell: number): void;
  /** Put a nutrient store on one of your own tiles. */
  build(cell: number): void;
  /** TREE only: drop a 4x4 forest centred on `cell`. */
  plantGrove(cell: number): void;
  buyTech(id: TechId): void;
  hatch(): void;
  pact(seat: number): void;
  step(dt: number): void;
  /** Seats that have offered us a pact, and seats we have offered one to. */
  offersToMe(): number[];
  offersFromMe(): number[];
}

class SoloSession implements Session {
  readonly online = false;
  readonly mySeat = 0;
  private garden: Garden;

  constructor() {
    /*
     * You plus one machine garden per remaining plant — every faction on the board,
     * every match.
     *
     * Nobody has a plant yet. The map is cut first and the garden opens in `draft`,
     * because on a deliberately unfair board the interesting decision is which plant
     * suits the corner you were dealt.
     *
     * You pick FIRST, from all five. The bots take what is left when you lock in —
     * seating them up front left exactly one plant on the menu, which is not a
     * choice, it is a formality.
     */
    const names = ['YOU', 'IVY', 'FERN', 'BURR', 'HUSK'];
    this.garden = new Garden({
      mode: 'garden',
      seed: (Math.random() * 1e9) | 0,
      seats: names.map((name, i) => ({
        playerId: `local-${i}`,
        name,
        role: null,
        isBot: i > 0,
      })),
    });
  }

  get state(): MatchState {
    return this.garden.state;
  }
  chooseRole(role: RoleId): void {
    // Solo has nobody to wait for: lock in, let the bots take what is left, and play.
    if (this.garden.setRole(0, role)) this.garden.beginPlay();
  }
  tap(cell: number): void {
    this.garden.tap(0, cell);
  }
  buyTech(id: TechId): void {
    this.garden.buyTech(0, id);
  }
  hatch(): void {
    this.garden.hatchInsect(0);
  }
  takeover(cell: number): void {
    this.garden.hostileTakeover(0, cell);
  }
  build(cell: number): void {
    this.garden.buildStore(0, cell);
  }
  plantGrove(cell: number): void {
    this.garden.plantGrove(0, cell);
  }
  pact(seat: number): void {
    this.garden.setPact(0, seat);
  }
  step(dt: number): void {
    if (this.garden.state.phase === 'draft') this.garden.stepDraft(dt);
    else this.garden.step(dt);
  }
  // Solo can just ask the simulation; online has to be told (see the `pacts` message).
  offersToMe(): number[] {
    return this.garden.state.seats.filter((s) => this.garden.hasOffer(s.seat, 0)).map((s) => s.seat);
  }
  offersFromMe(): number[] {
    return this.garden.state.seats.filter((s) => this.garden.hasOffer(0, s.seat)).map((s) => s.seat);
  }
}

class OnlineSession implements Session {
  readonly online = true;
  mySeat: number;
  /** Last snapshot from the server. The server is the only author of this. */
  snapshot: MatchState | null = null;
  /** Seats who have offered us a pact, and seats we have offered. */
  offersToUs: number[] = [];
  offersFromUs: number[] = [];
  private conn: Connection;

  constructor(conn: Connection, seat: number) {
    this.conn = conn;
    this.mySeat = seat;
  }

  chooseRole(role: RoleId): void {
    this.conn.chooseRole(role);
  }

  get state(): MatchState | null {
    return this.snapshot;
  }
  tap(cell: number): void {
    this.conn.tap(cell);
  }
  buyTech(id: TechId): void {
    this.conn.buyTech(id);
  }
  hatch(): void {
    this.conn.hatch();
  }
  takeover(cell: number): void {
    this.conn.takeover(cell);
  }
  build(cell: number): void {
    this.conn.build(cell);
  }
  plantGrove(cell: number): void {
    this.conn.plantGrove(cell);
  }
  pact(seat: number): void {
    this.conn.pact(seat);
  }
  step(): void {
    /* the server steps the world; we only draw it */
  }
  offersToMe(): number[] {
    return this.offersToUs;
  }
  offersFromMe(): number[] {
    return this.offersFromUs;
  }
}

class Bloom {
  private view: BoardView;
  private overlay: HTMLElement;
  private conn: Connection;
  private session: Session | null = null;
  private last = 0;

  // --- lobby / connection state
  private lobby: LobbyState | null = null;
  private myId = '';
  private status: ConnStatus = 'offline';
  private statusText = '';
  private notice = '';
  /** Which screen is up, so a connection change repaints the right one. */
  private screen: 'title' | 'solo-picker' | 'online' | 'lobby' | 'match' = 'title';

  // --- in-match UI handles
  private energyEl: HTMLElement | null = null;
  private techBtns: { def: TechDef; el: HTMLButtonElement }[] = [];
  private techPanelEl: HTMLElement | null = null;
  private techPip: HTMLElement | null = null;
  private allyRows: { seat: number; tag: HTMLElement; row: HTMLElement }[] = [];
  private allyPanel: HTMLElement | null = null;
  private hatchBtn: HTMLButtonElement | null = null;
  private role: RoleId | null = null;
  private resultShown = false;
  private peaceEl: HTMLElement | null = null;
  private draftEl: HTMLElement | null = null;
  private draftHead: HTMLElement | null = null;
  private draftBlurb: HTMLElement | null = null;
  private draftClock: HTMLElement | null = null;
  private draftChips: { id: RoleId; el: HTMLButtonElement }[] = [];
  private draftYou: HTMLElement | null = null;
  private wasDrafting = false;
  private acidEl: HTMLElement | null = null;
  private sunEl: HTMLElement | null = null;
  private takeoverBtn: HTMLButtonElement | null = null;
  private groveBtn: HTMLButtonElement | null = null;
  private groveCost: HTMLElement | null = null;
  private buildBtn: HTMLButtonElement | null = null;
  /**
   * Which item, if any, is waiting for a target on the board.
   *
   * Two things arm now, and they must be mutually exclusive: firing a 9x9 nuke when
   * you meant to put up a granary is not a mistake anyone should be able to make.
   */
  private arming: null | 'takeover' | 'build' | 'grove' = null;

  constructor(overlay: HTMLElement) {
    this.overlay = overlay;
    this.view = new BoardView({
      onTap: (cell) => this.session?.tap(cell),
      onArmedTap: (cell) => {
        // One shot: fire, then disarm so a stray second tap does not spend again.
        const what = this.arming;
        this.arming = null;
        if (what === 'takeover') this.session?.takeover(cell);
        else if (what === 'build') this.session?.build(cell);
        else if (what === 'grove') this.session?.plantGrove(cell);
        this.refreshArmed();
      },
      onSever: () => {},
      onDeny: () => {},
    });
    // BoardView builds its own root but never mounts itself — do it here, behind
    // the overlay, so the menu can sit on top of a live board.
    document.body.insertBefore(this.view.root, overlay);

    this.conn = new Connection({
      onStatus: (s, detail) => {
        this.status = s;
        this.statusText = detail;
        this.refreshShell();
      },
      onWelcome: (id) => {
        this.myId = id;
      },
      onLobby: (state) => {
        this.lobby = state;
        // A lobby message during an online match means the room has reset after the
        // result card — the match is over, so go back to the room.
        if (this.session?.online) this.session = null;
        this.showLobby();
      },
      onMatchStart: (seat) => this.beginOnlineMatch(seat),
      onSnapshot: (state) => this.applySnapshot(state),
      onMatchEnd: (result) => this.showResult(result),
      onPacts: (toYou, fromYou) => {
        if (this.session instanceof OnlineSession) {
          this.session.offersToUs = toYou;
          this.session.offersFromUs = fromYou;
        }
      },
      onChat: () => {},
      onError: (code, message) => {
        this.notice = message;
        // A rejected join has to put the player back somewhere they can act.
        if (code === 'no_such_room' || code === 'bad_code' || code === 'room_unavailable') {
          this.lobby = null;
          this.showOnlineMenu();
        } else {
          this.refreshShell();
        }
      },
      onRoomClosed: (reason) => {
        this.notice = reason;
        this.lobby = null;
        this.session = null;
        this.showOnlineMenu();
      },
    });

    window.addEventListener('resize', () => this.view.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.view.resize(), 120));

    // A shared link is the whole point of room codes: land straight in the room.
    const invite = new URLSearchParams(location.search).get('r');
    if (invite) {
      this.showOnlineMenu();
      this.conn.connect(this.myName());
      this.pendingJoin = invite.trim().toUpperCase();
    } else {
      this.showTitle();
    }
    this.loop(performance.now());
  }

  /** A code from a share link, joined as soon as the socket is up. */
  private pendingJoin: string | null = null;

  private myName(): string {
    return load(NAME_KEY) || '';
  }

  // ================================================================== screens

  private showTitle(): void {
    this.screen = 'title';
    this.view.hide();
    this.session = null;
    this.overlay.innerHTML = '';
    const wrap = el('div', 'menu');
    wrap.appendChild(el('h1', 'brand', 'BLOOM'));
    wrap.appendChild(el('p', 'tagline', 'Grow your vine. Cut theirs.'));

    const stack = el('div', 'menu-stack');
    const online = el('button', 'big-btn', 'PLAY ONLINE') as HTMLButtonElement;
    online.appendChild(el('span', 'big-btn-sub', 'with other people'));
    online.addEventListener('click', () => {
      this.showOnlineMenu();
      this.conn.connect(this.myName());
    });
    const solo = el('button', 'big-btn ghost', 'PLAY SOLO') as HTMLButtonElement;
    solo.appendChild(el('span', 'big-btn-sub', 'against the machine'));
    solo.addEventListener('click', () => this.startSolo());
    stack.appendChild(online);
    stack.appendChild(solo);
    wrap.appendChild(stack);
    this.overlay.appendChild(wrap);
  }

  /**
   * The online front door. Three ways in, in the order they are most often wanted:
   * join whatever is going, start a room to share, or type a code somebody read out.
   */
  private showOnlineMenu(): void {
    this.screen = 'online';
    this.view.hide();
    this.session = null;
    this.overlay.innerHTML = '';
    const wrap = el('div', 'menu');
    wrap.appendChild(el('h1', 'brand', 'BLOOM'));
    wrap.appendChild(this.statusLine());

    const stack = el('div', 'menu-stack');

    const quick = el('button', 'big-btn', 'QUICK MATCH') as HTMLButtonElement;
    quick.appendChild(el('span', 'big-btn-sub', 'join any open garden'));
    quick.addEventListener('click', () => this.conn.quickPlay('garden'));

    const host = el('button', 'big-btn ghost', 'START A GARDEN') as HTMLButtonElement;
    host.appendChild(el('span', 'big-btn-sub', 'get a code to share'));
    host.addEventListener('click', () => this.conn.createRoom('garden'));

    stack.appendChild(quick);
    stack.appendChild(host);

    // Join by code. `inputmode` + `maxlength` so a phone shows the right keyboard.
    const joinRow = el('div', 'join-row');
    const input = document.createElement('input');
    input.className = 'code-input';
    input.placeholder = 'CODE';
    input.maxLength = 6;
    input.autocapitalize = 'characters';
    input.spellcheck = false;
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    const go = el('button', 'result-btn', 'JOIN') as HTMLButtonElement;
    const submit = () => {
      if (input.value.length === 6) this.conn.joinRoom(input.value);
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    joinRow.appendChild(input);
    joinRow.appendChild(go);
    stack.appendChild(joinRow);

    wrap.appendChild(stack);
    if (this.notice) wrap.appendChild(el('p', 'notice', this.notice));
    wrap.appendChild(
      this.backButton(() => {
        this.conn.disconnect();
        this.notice = '';
        this.showTitle();
      }),
    );
    this.overlay.appendChild(wrap);
  }

  /**
   * The room. Code at the top because reading it out loud is how people actually
   * get into a game together, and a copyable link under it because that is how
   * they do it when they are not in the same room.
   */
  private showLobby(): void {
    const lobby = this.lobby;
    if (!lobby) return;
    this.screen = 'lobby';
    this.view.hide();
    this.overlay.innerHTML = '';
    const me = lobby.players.find((p) => p.playerId === this.myId);
    const isHost = lobby.host === this.myId;

    const wrap = el('div', 'menu');
    const head = el('div', 'lobby-head');
    head.appendChild(el('div', 'lobby-label', 'ROOM CODE'));
    head.appendChild(el('div', 'lobby-code', lobby.roomId));
    const share = el('button', 'result-btn ghost', 'COPY LINK') as HTMLButtonElement;
    share.addEventListener('click', () => {
      const url = `${location.origin}${location.pathname}?r=${lobby.roomId}`;
      navigator.clipboard?.writeText(url).then(
        () => {
          share.textContent = 'COPIED';
          setTimeout(() => (share.textContent = 'COPY LINK'), 1400);
        },
        () => {
          // Clipboard denied (or no permission): show the link so it can be copied
          // by hand rather than failing silently.
          share.textContent = url;
        },
      );
    });
    head.appendChild(share);
    wrap.appendChild(head);

    // Who is here.
    const rows = el('div', 'result-rows');
    for (const p of lobby.players) {
      const row = el('div', 'result-row');
      if (p.playerId === this.myId) row.classList.add('is-you');
      const dot = el('span', 'result-dot');
      dot.style.background = p.role ? getRole(p.role).colour : '#7f9c8a';
      row.appendChild(dot);
      row.appendChild(el('span', 'result-name', p.name));
      if (p.playerId === lobby.host) row.appendChild(el('span', 'lobby-tag', 'HOST'));
      if (p.isBot) row.appendChild(el('span', 'lobby-tag', 'BOT'));
      if (!p.connected) row.appendChild(el('span', 'result-out', 'GONE'));
      else row.appendChild(el('span', p.ready ? 'lobby-ready on' : 'lobby-ready', p.ready ? 'READY' : 'WAIT'));
      rows.appendChild(row);
    }
    wrap.appendChild(rows);

    wrap.appendChild(
      el('div', 'techpanel-group', 'PLANTS ARE CHOSEN ONCE THE GARDEN IS DEALT'),
    );

    const controls = el('div', 'menu-stack');
    if (lobby.countdown > 0) {
      controls.appendChild(el('div', 'countdown', `STARTING IN ${lobby.countdown}`));
    } else {
      const ready = el('button', 'big-btn', me?.ready ? 'NOT READY' : 'READY') as HTMLButtonElement;
      ready.addEventListener('click', () => this.conn.setReady(!me?.ready));
      controls.appendChild(ready);
    }

    if (isHost) {
      const hostRow = el('div', 'join-row');
      const addBot = el('button', 'result-btn ghost', '+ BOT') as HTMLButtonElement;
      addBot.disabled = lobby.players.length >= lobby.maxPlayers;
      addBot.addEventListener('click', () => this.conn.addBot());
      const dropBot = el('button', 'result-btn ghost', '− BOT') as HTMLButtonElement;
      dropBot.disabled = !lobby.players.some((p) => p.isBot);
      dropBot.addEventListener('click', () => this.conn.removeBot());
      const start = el('button', 'result-btn', 'START NOW') as HTMLButtonElement;
      start.disabled = lobby.players.length < 2;
      start.addEventListener('click', () => this.conn.startMatch());
      hostRow.appendChild(addBot);
      hostRow.appendChild(dropBot);
      hostRow.appendChild(start);
      controls.appendChild(hostRow);
    } else {
      controls.appendChild(el('p', 'tagline', 'Waiting for the host to start.'));
    }
    wrap.appendChild(controls);
    if (this.notice) wrap.appendChild(el('p', 'notice', this.notice));
    wrap.appendChild(
      this.backButton(() => {
        this.conn.leaveRoom();
        this.lobby = null;
        this.showOnlineMenu();
      }),
    );
    this.overlay.appendChild(wrap);
  }

  private statusLine(): HTMLElement {
    const p = el('p', 'tagline', this.statusText || 'not connected');
    p.dataset.status = this.status;
    return p;
  }

  private backButton(onClick: () => void): HTMLElement {
    const b = el('button', 'result-btn ghost', '← BACK');
    b.addEventListener('click', onClick);
    return b;
  }

  /** Repaint whichever menu screen is up, so a status change is visible. */
  private refreshShell(): void {
    if (this.screen === 'match') return;
    // An invite code from a share link can only be redeemed once we are connected.
    if (this.pendingJoin && this.status === 'online') {
      const code = this.pendingJoin;
      this.pendingJoin = null;
      this.conn.joinRoom(code);
      return;
    }
    if (this.screen === 'lobby' && this.lobby) this.showLobby();
    else if (this.screen === 'online') this.showOnlineMenu();
  }

  // ================================================================== playing

  private startSolo(): void {
    this.session = new SoloSession();
    this.role = null;
    this.enterMatch();
  }

  /**
   * The server has seated us. Deliberately does NOT build the match chrome yet:
   * the tech tree is built for one specific plant, and the authoritative answer to
   * "which plant am I" is in the snapshot that follows this message immediately.
   * Building here and again on the first snapshot flickered the whole HUD.
   */
  private beginOnlineMatch(seat: number): void {
    this.session = new OnlineSession(this.conn, seat);
    this.role = this.lobby?.players[seat]?.role ?? this.role ?? 'vine';
    this.lobby = null;
  }

  /** Build the in-match chrome. Identical for solo and online, by construction. */
  private enterMatch(): void {
    this.screen = 'match';
    this.overlay.innerHTML = '';
    this.resultShown = false;
    this.allyRows = [];
    this.notice = '';
    // Never carry a live target cursor into a new match — the buttons it belonged to
    // have just been thrown away and rebuilt.
    this.arming = null;
    this.view.setArmed(null);
    this.overlay.appendChild(this.hudBar());
    this.overlay.appendChild(this.techPanel());
    this.overlay.appendChild(this.allyPanelEl());
    this.overlay.appendChild(this.draftSheet());
    this.peaceEl = el('div', 'peace hidden');
    this.overlay.appendChild(this.peaceEl);
    this.view.show();
    this.view.resize();
  }

  private applySnapshot(state: MatchState): void {
    if (!(this.session instanceof OnlineSession)) return;
    const first = this.session.snapshot === null;
    this.session.snapshot = state;
    if (first) {
      // Now we know the plant for certain, so the tech tree can be the right one.
      this.role = state.seats[this.session.mySeat]?.role ?? this.role;
      this.enterMatch();
    }
    this.view.setState(state, this.session.mySeat);
  }

  private leaveMatch(): void {
    const wasOnline = this.session?.online === true;
    this.session = null;
    this.techBtns = [];
    this.techPanelEl = null;
    this.allyRows = [];
    if (wasOnline) {
      this.conn.leaveRoom();
      this.showOnlineMenu();
    } else {
      this.showTitle();
    }
  }

  private hudBar(): HTMLElement {
    const bar = el('div', 'hud');
    const back = el('button', 'hud-back', '←');
    back.addEventListener('click', () => this.leaveMatch());
    /*
     * Energy, then the three tech purses, in one compact group.
     *
     * All four are on screen at once and never hidden, because "can I afford that
     * card" is a question you ask while looking at the BOARD — the whole point of
     * three purses is that you can see which ground you need to go and take.
     */
    this.energyEl = el('span', 'hud-energy', '0');
    this.acidEl = el('span', 'hud-acid', '0');
    this.sunEl = el('span', 'hud-sun', '0');
    const purse = el('div', 'hud-purse');
    purse.appendChild(this.energyEl);
    purse.appendChild(this.acidEl);
    purse.appendChild(this.sunEl);
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
    this.hatchBtn.addEventListener('click', () => this.session?.hatch());
    // Shown by `refreshHud` once BROOD is owned; hidden for everyone else forever.
    this.hatchBtn.classList.add('hidden');

    const ally = el('button', 'hud-act', '🤝');
    ally.addEventListener('click', () => this.toggleAlly(true));

    /*
     * HOSTILE TAKEOVER. Arms rather than fires: it needs a target, and a 9x9 that
     * went off wherever you happened to be pressing would be unusable. Tap it, then
     * tap the board; tap it again to think better of it.
     */
    this.takeoverBtn = el('button', 'hud-act hidden') as HTMLButtonElement;
    this.takeoverBtn.appendChild(el('span', 'hud-act-icon', '☠'));
    this.takeoverBtn.appendChild(el('span', 'hud-act-cost', String(TAKEOVER_COST)));
    this.takeoverBtn.addEventListener('click', () => {
      this.arming = this.arming === 'takeover' ? null : 'takeover';
      this.refreshArmed();
    });

    /*
     * BUILD A STORE. Arms exactly like the nuke does, because it is the same shape of
     * decision: the button says "I want one", the board says WHERE, and where is the
     * entire content of the choice — a granary at the front is a supply line, the
     * same granary at home is a bank vault nobody can reach.
     */
    this.buildBtn = el('button', 'hud-act') as HTMLButtonElement;
    this.buildBtn.appendChild(el('span', 'hud-act-icon', '🛢'));
    this.buildBtn.appendChild(el('span', 'hud-act-cost', String(STORE_COST)));
    this.buildBtn.addEventListener('click', () => {
      this.arming = this.arming === 'build' ? null : 'build';
      this.refreshArmed();
    });

    /*
     * PLANT A FOREST. TREE's only input, once a minute — so the button is also its
     * only clock, and it reads the cooldown rather than a price.
     */
    this.groveBtn = el('button', 'hud-act hidden') as HTMLButtonElement;
    this.groveBtn.appendChild(el('span', 'hud-act-icon', '🌲'));
    this.groveCost = el('span', 'hud-act-cost', '');
    this.groveBtn.appendChild(this.groveCost);
    this.groveBtn.addEventListener('click', () => {
      this.arming = this.arming === 'grove' ? null : 'grove';
      this.refreshArmed();
    });

    bar.appendChild(back);
    bar.appendChild(purse);
    bar.appendChild(this.buildBtn);
    bar.appendChild(this.groveBtn);
    bar.appendChild(this.hatchBtn);
    bar.appendChild(this.takeoverBtn);
    bar.appendChild(ally);
    bar.appendChild(tech);
    return bar;
  }

  /**
   * The tech tree, as its own screen behind a button.
   *
   * A shop floor, not a ladder. There are no prerequisites, so there is nothing to
   * draw connectors between and no card that has to explain what it NEEDS first —
   * every card is either affordable or it is not, and the only thing standing
   * between you and a tier-4 card is the ground you are holding.
   *
   * So the layout is a plain wrapping grid, cheapest band first, grouped into the
   * shared cards and this faction's own. That fits a phone without sideways
   * scrolling, which the old tier-column row did not once the tree got this big.
   */
  private techPanel(): HTMLElement {
    const panel = el('div', 'techpanel hidden');
    const head = el('div', 'techpanel-head');
    head.appendChild(el('h2', 'techpanel-title', 'TECH'));
    const close = el('button', 'techpanel-close', '✕');
    close.addEventListener('click', () => this.toggleTech(false));
    head.appendChild(close);
    panel.appendChild(head);
    panel.appendChild(
      el('div', 'techpanel-group', 'BUY ANYTHING, IN ANY ORDER — IF YOU CAN PAY FOR IT'),
    );
    // What the three prices on the cards actually mean, in one line.
    const purses = el('div', 'tech-purses');
    for (const cur of CURRENCIES) purses.appendChild(el('span', `tech-purse cur-${cur}`, PURSE_LABEL[cur]));
    panel.appendChild(purses);

    this.techBtns = [];
    const list = techsFor(this.role ?? 'vine');
    const byCost = (a: TechDef, b: TechDef) => a.tier - b.tier || a.cost - b.cost;

    const branches: { label: string; items: TechDef[] }[] = [
      { label: 'ROOTS — EVERY PLANT', items: list.filter((t) => !t.role).sort(byCost) },
      { label: (this.role ?? 'vine').toUpperCase(), items: list.filter((t) => t.role).sort(byCost) },
    ];

    for (const br of branches) {
      if (br.items.length === 0) continue;
      panel.appendChild(el('div', 'techpanel-group', br.label));
      const grid = el('div', 'tech-branch');
      for (const t of br.items) grid.appendChild(this.techCard(t));
      panel.appendChild(grid);
    }
    panel.addEventListener('click', (e) => {
      if (e.target === panel) this.toggleTech(false);
    });
    this.techPanelEl = panel;
    return panel;
  }

  private techCard(t: TechDef): HTMLButtonElement {
    const b = el('button', `tech-node cur-${t.currency}`) as HTMLButtonElement;
    b.appendChild(el('span', 'tech-icon', t.icon));
    b.appendChild(el('span', 'tech-name', t.name));
    b.appendChild(el('span', 'tech-blurb', t.blurb));
    /*
     * Price AND purse, on every card. With three currencies in play a bare number is
     * ambiguous — 14 acid and 14 sun are wildly different asks depending on what you
     * are standing on — so the glyph is part of the price, never a separate legend.
     */
    b.appendChild(el('span', 'tech-cost', `${t.cost}${CURRENCY_ICON[t.currency]}`));
    // No optimistic `owned` class: the seat's tech list arrives in the next
    // snapshot, and online the purchase might legitimately have been refused.
    b.addEventListener('click', () => this.session?.buyTech(t.id));
    this.techBtns.push({ def: t, el: b });
    return b;
  }

  /** Swap in the tech tree and hatch button for the plant we ended up with. */
  private rebuildForRole(): void {
    this.techPanelEl?.remove();
    this.techBtns = [];
    this.overlay.appendChild(this.techPanel());
  }

  /** Reflect the armed item on the buttons and the board. */
  private refreshArmed(): void {
    this.takeoverBtn?.classList.toggle('armed', this.arming === 'takeover');
    this.buildBtn?.classList.toggle('armed', this.arming === 'build');
    this.groveBtn?.classList.toggle('armed', this.arming === 'grove');
    this.view.setArmed(this.arming);
  }

  private toggleTech(open: boolean): void {
    this.techPanelEl?.classList.toggle('hidden', !open);
  }

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

    const st = this.session?.state;
    const mine = this.session?.mySeat ?? 0;
    for (const seat of st?.seats ?? []) {
      if (seat.seat === mine) continue;
      const row = el('button', 'ally-row') as HTMLButtonElement;
      const dot = el('span', 'result-dot');
      dot.style.background = seat.colour;
      row.appendChild(dot);
      row.appendChild(el('span', 'result-name', seat.name));
      const tag = el('span', 'ally-tag', '');
      row.appendChild(tag);
      row.addEventListener('click', () => this.session?.pact(seat.seat));
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
    // Built lazily the first time it is opened: online, the seat list does not
    // exist until the first snapshot lands, so building it at match start gave an
    // empty panel for the rest of the game.
    if (open && this.allyRows.length === 0 && this.session?.state) {
      this.allyPanel?.remove();
      this.overlay.appendChild(this.allyPanelEl());
    }
    this.allyPanel?.classList.toggle('hidden', !open);
  }

  /**
   * The draft: the map is already on screen behind this, with your seedling on it.
   *
   * A bottom sheet rather than a full screen, deliberately — the board is the thing
   * you are supposed to be reading, and covering it to ask "which plant?" would put
   * the question and the evidence on different screens. Maps are unfair on purpose,
   * so the answer is different every time: boxed in behind a wall wants SPORE, a
   * wide flank wants VINE, a neighbour on your doorstep wants THORN.
   *
   * Nothing is greyed out. Plants are not reserved, so five gardens may all pick
   * VINE if they all fancy it — the swatch by the map name is your seat's colour,
   * which is what actually tells the gardens apart.
   */
  private draftSheet(): HTMLElement {
    const sheet = el('div', 'draft hidden');
    this.draftYou = el('span', 'draft-you', '');
    this.draftHead = el('div', 'draft-map', '');
    this.draftBlurb = el('div', 'draft-blurb', '');
    this.draftClock = el('div', 'draft-clock', '');
    const head = el('div', 'draft-head');
    head.appendChild(this.draftYou);
    head.appendChild(this.draftHead);
    head.appendChild(this.draftClock);
    sheet.appendChild(head);
    sheet.appendChild(this.draftBlurb);

    const chips = el('div', 'draft-chips');
    this.draftChips = [];
    for (const r of ROLE_LIST) {
      const chip = el('button', 'draft-chip') as HTMLButtonElement;
      chip.style.setProperty('--role', r.colour);
      chip.appendChild(el('span', 'draft-chip-name', r.name));
      chip.appendChild(el('span', 'draft-chip-blurb', r.blurb));
      chip.addEventListener('click', () => this.session?.chooseRole(r.id));
      this.draftChips.push({ id: r.id, el: chip });
      chips.appendChild(chip);
    }
    sheet.appendChild(chips);
    this.draftEl = sheet;
    return sheet;
  }

  /** Keep the sheet in step with the state, and take it away when play begins. */
  private refreshDraft(state: MatchState): void {
    const drafting = state.phase === 'draft';
    this.draftEl?.classList.toggle('hidden', !drafting);
    /*
     * Shrink the board out from under the sheet while it is up. Without this the
     * sheet covers the bottom of the grid — which on the default layout is exactly
     * where seat 0's seedling sits, so the one thing you are meant to be looking at
     * is the one thing hidden.
     */
    if (drafting !== this.wasDrafting) {
      this.wasDrafting = drafting;
      this.view.root.classList.toggle('drafting', drafting);
      this.view.resize();
    }
    if (!drafting) return;
    const mine = this.session?.mySeat ?? 0;
    if (this.draftHead) this.draftHead.textContent = MAP_NAMES[state.board.kind];
    if (this.draftBlurb) this.draftBlurb.textContent = MAP_BLURBS[state.board.kind];
    if (this.draftClock) this.draftClock.textContent = `${Math.ceil(state.draftTimer)}s`;
    // Your garden's colour, so you can find yourself on the board behind the sheet.
    if (this.draftYou) this.draftYou.style.background = state.seats[mine]?.colour ?? '#3ddc6b';
    const picked = state.seats[mine]?.role ?? null;
    // Nothing is reserved: another garden playing VINE does not stop you playing it.
    for (const c of this.draftChips) c.el.classList.toggle('on', picked === c.id);
  }

  /**
   * End-of-match card.
   *
   * Online the server sends a `MatchResult` with the numbers that matter (peak
   * territory, and how much of other people's gardens you killed by cutting).
   * Solo derives what it can from the final state.
   */
  private showResult(result?: MatchResult): void {
    if (this.resultShown) return;
    const st = this.session?.state;
    if (!st) return;
    this.resultShown = true;
    this.toggleTech(false);
    this.toggleAlly(false);

    const mine = this.session?.mySeat ?? 0;
    const alive = st.seats.filter((x) => x.alive);
    const best = [...st.seats].sort((a, b) => b.tiles - a.tiles)[0];
    const winnerSeat = result ? result.winnerSeat : alive.length === 1 ? alive[0].seat : best?.seat;
    const winner = st.seats.find((s) => s.seat === winnerSeat);
    const iWon = winnerSeat === mine;
    const reason = result ? REASONS[result.reason] : alive.length === 1 ? 'last one growing' : 'took over the garden';

    const card = el('div', 'result');
    const box = el('div', 'result-box');
    box.style.setProperty('--role', winner?.colour ?? '#3ddc6b');
    box.appendChild(
      el('div', 'result-title', iWon ? 'YOU WIN' : winner ? `${winner.name} WINS` : 'NOBODY WINS'),
    );
    box.appendChild(el('div', 'result-reason', reason));

    const table = el('div', 'result-rows');
    const order = result
      ? result.standings.map((s) => st.seats.find((x) => x.seat === s.seat)).filter(isSeat)
      : [...st.seats].sort((a, b) => b.tiles - a.tiles);
    for (const seat of order) {
      const row = el('div', 'result-row');
      if (seat.seat === mine) row.classList.add('is-you');
      const dot = el('span', 'result-dot');
      dot.style.background = seat.colour;
      row.appendChild(dot);
      row.appendChild(el('span', 'result-name', seat.name));
      const cut = result?.standings.find((s) => s.seat === seat.seat)?.severed;
      if (cut !== undefined) row.appendChild(el('span', 'result-cut', `✂ ${cut}`));
      row.appendChild(el('span', 'result-tiles', `${seat.tiles}`));
      if (!seat.alive) row.appendChild(el('span', 'result-out', 'OUT'));
      table.appendChild(row);
    }
    box.appendChild(table);

    if (this.session?.online) {
      box.appendChild(el('div', 'result-reason', 'Back to the lobby in a moment…'));
      const leave = el('button', 'result-btn ghost', 'LEAVE ROOM');
      leave.addEventListener('click', () => {
        card.remove();
        this.leaveMatch();
      });
      box.appendChild(leave);
    } else {
      const again = el('button', 'result-btn', 'NEW GARDEN');
      again.addEventListener('click', () => {
        this.techBtns = [];
        this.techPanelEl = null;
        this.allyRows = [];
        this.startSolo();
      });
      const menu = el('button', 'result-btn ghost', 'MENU');
      menu.addEventListener('click', () => {
        this.session = null;
        this.techBtns = [];
        this.techPanelEl = null;
        this.allyRows = [];
        this.showTitle();
      });
      box.appendChild(again);
      box.appendChild(menu);
    }
    card.appendChild(box);
    this.overlay.appendChild(card);
  }

  // ===================================================================== loop

  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    const dtMs = Math.min(100, now - this.last);
    if (dtMs < FRAME_MS - 1) return;
    this.last = now;

    const session = this.session;
    const state = session?.state ?? null;
    if (session && state) {
      session.step(dtMs / 1000);
      // Solo has to push the state in; online already did on the snapshot.
      if (!session.online) this.view.setState(state, session.mySeat);
      // A finished match used to just freeze with no explanation, which read as
      // "the game stopped on a timer". Announce the result instead. Online the
      // server's `matchEnd` does this with better numbers; this is the fallback.
      if (state.phase === 'complete' && !this.resultShown) this.showResult();
      this.refreshDraft(state);
      /*
       * The tech tree is built for one specific plant, and during the draft there is
       * no plant. Build it the moment the seat has one — which is also how a solo
       * rematch on a different plant gets the right tree.
       */
      const mine = state.seats[session.mySeat]?.role ?? null;
      if (mine && mine !== this.role) {
        this.role = mine;
        this.rebuildForRole();
      }
      this.refreshHud(state, session);
    }
    this.view.update(dtMs);
  };

  private refreshHud(state: MatchState, session: Session): void {
    const me = state.seats[session.mySeat];
    // Energy reads as stored/capacity: when those two meet, income has STOPPED and
    // the only cure is another granary. That has to be visible without opening
    // anything, because it is the moment the game asks you to spend or build.
    if (this.energyEl) {
      this.energyEl.textContent = me ? `${Math.floor(me.energy)}/${Math.floor(me.cap)}` : '0';
      this.energyEl.classList.toggle('full', !!me && me.cap > 0 && me.energy >= me.cap - 0.5);
    }
    if (this.acidEl) this.acidEl.textContent = me ? String(Math.floor(me.acid)) : '0';
    if (this.sunEl) this.sunEl.textContent = me ? String(Math.floor(me.sun)) : '0';
    if (this.takeoverBtn) {
      // SPORE's item, and only SPORE's.
      const canCast = me?.role === 'spore';
      this.takeoverBtn.classList.toggle('hidden', !canCast);
      this.takeoverBtn.disabled = !canCast || !me || me.acid < TAKEOVER_COST;
      if (this.arming === 'takeover' && this.takeoverBtn.disabled) {
        this.arming = null;
        this.refreshArmed();
      }
    }
    if (this.groveBtn) {
      // TREE only. The label counts the forest down, and reads READY when it is.
      const isTree = me?.role === 'tree';
      this.groveBtn.classList.toggle('hidden', !isTree);
      const left = me?.plantCooldown ?? 0;
      this.groveBtn.disabled = !isTree || left > 0;
      if (this.groveCost) this.groveCost.textContent = left > 0 ? `${Math.ceil(left)}s` : 'NOW';
      if (this.arming === 'grove' && this.groveBtn.disabled) {
        this.arming = null;
        this.refreshArmed();
      }
    }
    if (this.buildBtn) {
      /*
       * Affordability here is the SEAT total, which is a deliberate half-truth: the
       * real answer is per network and the player is about to point at one. Showing
       * the button as live whenever any of your networks could pay is the honest
       * version of "you can build somewhere" — the server refuses the ones that
       * cannot, and the board draws which tiles are legal while you aim.
       */
      this.buildBtn.disabled = !me || me.energy < STORE_COST;
      if (this.arming === 'build' && this.buildBtn.disabled) {
        this.arming = null;
        this.refreshArmed();
      }
    }

    /*
     * Grey out anything unaffordable so a child can see what is reachable.
     *
     * Unaffordable is now the ONLY reason a card is out of reach — nothing is locked
     * behind anything else — so a dim card means exactly one thing: go and take the
     * ground that fills that purse. The owned set and the purses both come off the
     * seat, which means online they are the server's answer, not a guess.
     */
    const owned = new Set(me?.techs ?? []);
    const purse: Record<Currency, number> = {
      acid: me?.acid ?? 0,
      sun: me?.sun ?? 0,
    };
    let affordable = 0;
    for (const t of this.techBtns) {
      const have = owned.has(t.def.id);
      const canBuy = !have && purse[t.def.currency] >= t.def.cost;
      if (canBuy) affordable++;
      t.el.classList.toggle('owned', have);
      t.el.disabled = have || !canBuy;
    }
    /*
     * The hatch button exists only once BROOD is bought — insects are locked behind
     * it entirely, so a button that could never work has no business on the HUD. The
     * tech tree is where you find out it is coming.
     */
    if (this.hatchBtn) {
      // Insects are part of FUNGAL again, not something bought — BROOD is gone.
      const canHatch = me?.role === 'fungal';
      this.hatchBtn.classList.toggle('hidden', !canHatch);
      this.hatchBtn.disabled = !canHatch || !me || me.energy < INSECT_COST;
    }

    const offersToUs = session.offersToMe();
    const offersFromUs = session.offersFromMe();
    for (const a of this.allyRows) {
      const pact = isAllied(state.allies, session.mySeat, a.seat);
      a.tag.textContent = pact
        ? 'ALLIED — TAP TO BETRAY'
        : offersToUs.includes(a.seat)
          ? 'WANTS A PACT'
          : offersFromUs.includes(a.seat)
            ? 'OFFERED'
            : 'TAP TO OFFER';
      a.row.classList.toggle('is-allied', pact);
      a.row.classList.toggle('is-offered', !pact && offersToUs.includes(a.seat));
    }

    /*
     * The truce banner. Counting it down in the open matters — a player who taps an
     * enemy tile and gets nothing needs to know it is a rule and when it lifts, not
     * wonder whether the game is broken.
     */
    if (this.peaceEl) {
      const left = state.peaceTimer;
      this.peaceEl.classList.toggle('hidden', left <= 0);
      if (left > 0) {
        this.peaceEl.textContent = `TRUCE · ${Math.ceil(left)}s · grow, nobody can be attacked`;
      }
    }

    document.body.dataset.sky = isDay(state.clock) ? 'day' : 'night';
    if (this.techPip) {
      this.techPip.textContent = affordable > 0 ? String(affordable) : '';
      this.techPip.classList.toggle('on', affordable > 0);
    }
  }
}

/** What each purse is, in three words. Shown once at the top of the tech screen. */
const PURSE_LABEL: Record<Currency, string> = {
  acid: '🜁 ACID POOLS',
  sun: '☀ SUN, IN DAYLIGHT',
};

const REASONS: Record<string, string> = {
  home: 'took the last seedling',
  territory: 'held the garden',
  blight: 'the blight won',
  wiped: 'everything died',
  abandoned: 'everyone left',
  none: 'no winner',
};

function isSeat<T>(v: T | undefined): v is T {
  return v !== undefined;
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function load(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — the choice just will not persist */
  }
}

const overlay = document.getElementById('overlay');
if (!overlay) throw new Error('bloom: missing #overlay');
(window as unknown as Record<string, unknown>).bloom = new Bloom(overlay);
