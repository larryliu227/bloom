/**
 * VOIDLINE — client shell.
 *
 * Owns the frame loop, input capture, client-side prediction + reconciliation,
 * remote entity interpolation, and the screen state machine that drives every
 * DOM overlay. The arena itself is drawn by `client/render/renderer.ts` (agent E);
 * this module only hands it a `RenderView`.
 *
 * Timing model
 *   render        60 fps (rAF, frame-limited)
 *   input send    30 Hz  (INPUT_SEND_RATE), decoupled from render
 *   server sim    20 Hz  (TICK_RATE), snapshots at SNAPSHOT_RATE
 *   remote view   serverTime - INTERP_DELAY_MS
 */

import {
  ARENA_H,
  ARENA_W,
  INPUT_SEND_RATE,
  INTERP_DELAY_MS,
} from '@shared/constants.js';
import { ActionBit } from '@shared/protocol.js';
import type { InputFrame, MatchResult } from '@shared/protocol.js';
import type {
  AbilityId,
  Entity,
  EntityId,
  GameEvent,
  GameMode,
  LobbyState,
  PlayerEntity,
  PlayerId,
  RoleId,
  Team,
  Vec2,
  WeaveBoard,
  WorldState,
} from '@shared/types.js';
import { clamp } from '@shared/math.js';
import { stepPlayerMovement } from '@shared/sim.js';
import { getRole } from '@shared/roles.js';
import { getAbility } from '@shared/abilities.js';

import { Renderer, mountDemo } from './render/renderer.js';
import type { RenderView } from './render/renderer.js';

import { Connection, defaultServerUrl } from './net/connection.js';
import type { ConnectionState } from './net/connection.js';
import { Hud } from './ui/hud.js';
import { LobbyScreen } from './ui/lobby.js';
import { LoadoutScreen } from './ui/loadout.js';
import { ResultsScreen } from './ui/results.js';
import { TitleScreen } from './ui/title.js';
import { WeavePanel } from './ui/weave.js';
import { add, button, h, normalizeCode } from './ui/dom.js';
import { audio } from './audio/index.js';

// ---------------------------------------------------------------- tuning

const FRAME_MS = 1000 / 60;
const INPUT_MS = 1000 / INPUT_SEND_RATE;
/** How much snapshot history to keep for interpolation (~1 second). */
const SNAPSHOT_WINDOW_MS = 1100;
/** Below this the prediction error is treated as zero. */
const RECONCILE_EPS = 1.5;
/** Above this we stop blending and snap (teleport, respawn, dash resolution). */
const RECONCILE_SNAP = 260;
/** Exponential blend rate for correcting prediction error, per second. */
const ERROR_BLEND_RATE = 11;
const MAX_STEP_DT = 0.2;

type ScreenName = 'title' | 'lobby' | 'loadout' | 'playing' | 'results';

interface Snap {
  world: WorldState;
  serverTime: number;
  recvAt: number;
  ackSeq: number;
}

interface SentInput {
  frame: InputFrame;
  sentAt: number;
}

// ---------------------------------------------------------------- helpers

function clonePlayer(p: PlayerEntity): PlayerEntity {
  return Object.assign({}, p, {
    pos: { x: p.pos.x, y: p.pos.y },
    vel: { x: p.vel.x, y: p.vel.y },
    statuses: p.statuses ? p.statuses.slice() : [],
  });
}

function cloneEntityLerped<T extends Entity>(a: T, b: T, t: number): T {
  return Object.assign({}, b, {
    pos: { x: a.pos.x + (b.pos.x - a.pos.x) * t, y: a.pos.y + (b.pos.y - a.pos.y) * t },
    vel: { x: b.vel.x, y: b.vel.y },
    angle: lerpAngle(a.angle, b.angle, t),
    hp: a.hp + (b.hp - a.hp) * t,
  });
}

function cloneEntityFlat<T extends Entity>(e: T): T {
  return Object.assign({}, e, { pos: { x: e.pos.x, y: e.pos.y }, vel: { x: e.vel.x, y: e.vel.y } });
}

/** Shortest-arc angle interpolation. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function isPlayer(e: Entity): e is PlayerEntity {
  return e.kind === 'player';
}

// ---------------------------------------------------------------- client

class VoidlineClient {
  private canvas: HTMLCanvasElement;
  private overlay: HTMLElement;
  private renderer: Renderer;
  private conn: Connection;

  private title: TitleScreen;
  private lobby: LobbyScreen;
  private loadout: LoadoutScreen;
  private results: ResultsScreen;
  private hud: Hud;
  private weave: WeavePanel;
  private pause: HTMLElement;

  // --- audio settings overlay (owned here; see client/audio/*)
  private audioPanel: HTMLElement;
  private mutedBadge: HTMLElement;
  private volInputs: Partial<Record<VolumeKind, HTMLInputElement>> = {};
  private volLabels: Partial<Record<VolumeKind, HTMLElement>> = {};
  private muteLabel: HTMLElement | null = null;
  private hovered: Element | null = null;

  private screen: ScreenName = 'title';
  private playerId: PlayerId = '';
  private selfEntityId: EntityId = -1;
  private lobbyState: LobbyState | null = null;
  private roomId: string | null = null;
  private mode: GameMode = 'pvp_arena';
  private role: RoleId | null = null;
  private loadoutIds: AbilityId[] = [];
  private board: WeaveBoard | null = null;
  private matchResult: MatchResult | null = null;
  private paused = false;
  private loadoutSeen = false;
  /** Attract-mode renderer teardown, active whenever we are not in a match. */
  private demoStop: (() => void) | null = null;

  // --- net timing
  private snapshots: Snap[] = [];
  private clockOffset: number | null = null;
  private drainedUntil = 0;

  // --- prediction
  private sent: SentInput[] = [];
  private seq = 1;
  private predicted: PlayerEntity | null = null;
  private predError: Vec2 = { x: 0, y: 0 };

  // --- input
  private held = new Set<string>();
  private pressedMask = 0;
  private mouseDown = false;
  private mouseScreen: Vec2 = { x: 0, y: 0 };
  private aimWorld: Vec2 = { x: ARENA_W / 2, y: ARENA_H / 2 };
  private camera = { x: ARENA_W / 2, y: ARENA_H / 2, zoom: 1 };

  /**
   * Screen-space margins, in CSS px, that the camera must keep free of gameplay.
   * Measured from the live HUD every `HUD_INSET_INTERVAL` (see
   * `measureHudInsets`) and glided toward, never hardcoded: every occluder is
   * sized in vw/clamp() units (`--weave-size` is `clamp(228px, 21vw, 312px)`),
   * so a 1600x900 constant would be wrong on every other viewport.
   */
  private readonly hudInset = { l: 0, t: 0, r: 0, b: 0 };
  private readonly hudInsetTarget = { l: 0, t: 0, r: 0, b: 0 };
  private hudInsetClock = 0;

  // --- loop
  private lastFrame = 0;
  private lastRender = 0;
  private inputAccum = 0;
  private fps = 60;

  constructor(canvas: HTMLCanvasElement, overlay: HTMLElement) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.renderer = new Renderer(canvas);

    // ---- screens ------------------------------------------------------
    this.hud = new Hud();
    this.weave = new WeavePanel({
      onRotate: (index) => {
        // Only fires on a rotation the panel actually accepted, so the click
        // never lies about whether the tile moved.
        audio.weaveRotate();
        this.conn.send({ t: 'rotateTile', index });
      },
    });
    this.title = new TitleScreen({
      // TitleScreen seeds its name field from localStorage and commits it from its
      // own constructor, which runs before `this.conn` exists further down. That
      // first commit is redundant — the Connection is built with `title.name`
      // below — so guard it rather than reordering construction.
      onName: (name) => this.conn?.setName(name),
      onQuickPlay: (mode) => {
        this.mode = mode;
        this.conn.send({ t: 'quickPlay', mode });
      },
      onCreateRoom: (mode) => {
        this.mode = mode;
        this.conn.send({ t: 'createRoom', mode, chapter: mode === 'coop_story' ? 1 : undefined });
      },
      onJoin: (code) => this.conn.send({ t: 'joinRoom', roomId: code }),
    });
    this.lobby = new LobbyScreen({
      onReady: (ready) => {
        if (ready) audio.ui('ready');
        this.conn.send({ t: 'setReady', ready });
      },
      onStart: () => this.conn.send({ t: 'startMatch' }),
      onAddBot: (tier) => {
        audio.ui('click');
        this.conn.send({ t: 'addBot', tier });
      },
      onRemoveBot: () => {
        audio.ui('back');
        this.conn.send({ t: 'removeBot' });
      },
      onLeave: () => this.leaveRoom(),
      onChapter: (chapter) => this.conn.send({ t: 'setChapter', chapter }),
      onEditLoadout: () => this.setScreen('loadout'),
      onChat: (text) => this.conn.send({ t: 'chat', text }),
    });
    this.loadout = new LoadoutScreen({
      onRole: (role) => {
        this.role = role;
        this.conn.send({ t: 'chooseRole', role });
        this.applyRoleAccent(role);
      },
      onLoadout: (l) => {
        this.loadoutIds = l;
        this.conn.send({ t: 'chooseLoadout', loadout: l });
      },
      onConfirm: (role, l) => {
        this.role = role;
        this.loadoutIds = l;
        this.conn.send({ t: 'chooseRole', role });
        this.conn.send({ t: 'chooseLoadout', loadout: l });
        this.setScreen(this.screen === 'loadout' && this.matchLive() ? 'playing' : 'lobby');
      },
      onBack: () => this.setScreen(this.matchLive() ? 'playing' : 'lobby'),
    });
    this.results = new ResultsScreen({
      onContinue: () => {
        this.matchResult = null;
        this.setScreen(this.lobbyState ? 'lobby' : 'title');
      },
      onLeave: () => this.leaveRoom(),
    });
    this.pause = this.buildPauseMenu();
    this.audioPanel = this.buildAudioPanel();
    this.mutedBadge = this.buildMutedBadge();

    add(
      this.overlay,
      this.hud.root,
      this.weave.root,
      this.title.root,
      this.lobby.root,
      this.loadout.root,
      this.results.root,
      this.pause,
      this.audioPanel,
      this.mutedBadge,
    );

    // ---- connection ---------------------------------------------------
    this.conn = new Connection(defaultServerUrl(), { name: this.title.name });
    this.wireNet();
    this.conn.onStatus((state, detail) => this.onConnStatus(state, detail));
    this.conn.connect();

    // ---- input --------------------------------------------------------
    this.wireInput();
    this.wireAudio();

    const hash = normalizeCode(window.location.hash.replace('#', ''));
    if (hash.length === 6) this.title.setCode(hash);

    this.setScreen('title');
    this.resize();
    window.addEventListener('resize', () => this.resize());
    requestAnimationFrame(this.frame);
  }

  // ================================================================ net

  private wireNet(): void {
    this.conn.on('welcome', (m) => {
      this.playerId = m.playerId;
      this.title.setBusy(false);
      // Reconnected mid-session: try to slide back into the room we were in.
      if (this.roomId) this.conn.send({ t: 'joinRoom', roomId: this.roomId });
    });

    this.conn.on('error', (m) => {
      const text = `${m.code}: ${m.message}`;
      this.title.setError(text);
      this.title.setBusy(false);
      if (this.screen === 'playing') this.hud.pushFeed('SYSTEM', m.message.toUpperCase(), false);
      console.warn('[server]', text);
    });

    this.conn.on('lobby', (m) => {
      this.lobbyState = m.state;
      this.roomId = m.state.roomId;
      this.mode = m.state.mode;
      const me = m.state.players.find((p) => p.playerId === this.playerId);
      if (me?.role) {
        this.role = me.role;
        this.applyRoleAccent(me.role);
      }
      if (me && me.loadout?.length) this.loadoutIds = me.loadout;
      this.loadout.setSelection(me?.role ?? null, me?.loadout ?? []);
      this.lobby.setState(m.state, this.playerId);
      this.title.setBusy(false);
      this.title.setError('');
      // Lobby auto-start countdown: one tick per whole second remaining.
      if (m.state.countdown > 0) audio.countdown(m.state.countdown);
      else audio.resetCountdown();

      if (this.screen === 'title' || this.screen === 'results') {
        // First time into a room: go straight to the loadout, it is the game's
        // handshake with the player. Afterwards, land in the lobby.
        this.setScreen(this.loadoutSeen && me?.role ? 'lobby' : 'loadout');
        this.loadoutSeen = true;
      }
    });

    this.conn.on('roomClosed', (m) => {
      this.roomId = null;
      this.lobbyState = null;
      this.endMatchState();
      this.setScreen('title');
      this.title.setError(`room closed — ${m.reason}`);
    });

    this.conn.on('matchStart', (m) => {
      this.mode = m.mode;
      this.selfEntityId = m.you;
      this.snapshots = [];
      this.sent = [];
      this.predicted = null;
      this.predError = { x: 0, y: 0 };
      this.clockOffset = null;
      this.drainedUntil = 0;
      this.matchResult = null;
      this.seq = 1;
      this.setScreen('playing');
      audio.matchStart();
    });

    this.conn.on('snapshot', (m) => this.onSnapshot(m.world, m.ackSeq, m.serverTime));

    this.conn.on('weave', (m) => {
      this.board = m.board;
      this.weave.setBoard(m.board);
      this.refreshSlotMeta();
    });

    this.conn.on('matchEnd', (m) => {
      this.matchResult = m.result;
      // Read the outcome before setScreen, which is what drives the music state.
      audio.matchEnd(this.matchWon(m.result));
      this.setScreen('results');
    });

    this.conn.on('chat', (m) => {
      this.lobby.pushChat(m.name, m.text);
      // In-match chat gets its own log. It used to be forced through `pushFeed`,
      // which UPPERCASED it into the kill feed — so a teammate saying "left seal"
      // rendered like a death notification.
      if (this.screen === 'playing') {
        this.hud.pushChat(m.name, m.text, m.from === this.playerId);
      }
    });
  }

  private onConnStatus(state: ConnectionState, detail: string): void {
    this.title.setConnection(state, detail);
    document.body.dataset.link = state;
  }

  private onSnapshot(world: WorldState, ackSeq: number, serverTime: number): void {
    const now = performance.now();
    const snap: Snap = { world, serverTime, recvAt: now, ackSeq };

    // Insert in serverTime order (UDP-like reordering can't happen on TCP, but
    // a paused tab can deliver a burst; keep the buffer monotonic regardless).
    const last = this.snapshots[this.snapshots.length - 1];
    if (last && serverTime < last.serverTime) return;
    this.snapshots.push(snap);
    const cutoff = serverTime - SNAPSHOT_WINDOW_MS;
    while (this.snapshots.length > 2 && this.snapshots[0].serverTime < cutoff) this.snapshots.shift();

    // Server clock estimate, biased to the best (lowest latency) sample.
    const sample = serverTime + this.conn.ping / 2 - Date.now();
    if (this.clockOffset === null) this.clockOffset = sample;
    else this.clockOffset = sample > this.clockOffset ? sample : this.clockOffset * 0.995 + sample * 0.005;

    if (this.screen !== 'playing' && this.screen !== 'results' && world.phase === 'playing') {
      this.setScreen('playing');
    }
    this.reconcile(snap);
  }

  // ================================================================ prediction

  /**
   * Take the authoritative local player from the snapshot, replay every input
   * the server has not acknowledged, and land on "the present". Any residual
   * difference from what we were already showing becomes a decaying offset so
   * corrections read as a slide, never a teleport.
   */
  private reconcile(snap: Snap): void {
    const auth = snap.world.entities.find(
      (e): e is PlayerEntity => isPlayer(e) && e.id === this.selfEntityId,
    );
    if (!auth) return;

    while (this.sent.length && this.sent[0].frame.seq <= snap.ackSeq) this.sent.shift();

    const prev = this.predicted;
    const visualX = prev ? prev.pos.x + this.predError.x : auth.pos.x;
    const visualY = prev ? prev.pos.y + this.predError.y : auth.pos.y;

    const p = clonePlayer(auth);
    if (this.board) p.weave = this.board;
    const speedMul = this.speedMul(p);
    const now = performance.now();
    for (let i = 0; i < this.sent.length; i++) {
      const cur = this.sent[i];
      const next = this.sent[i + 1];
      const dt = clamp(((next ? next.sentAt : now) - cur.sentAt) / 1000, 0, MAX_STEP_DT);
      if (dt > 0) stepPlayerMovement(p, cur.frame, dt, speedMul);
    }
    this.predicted = p;

    const dx = visualX - p.pos.x;
    const dy = visualY - p.pos.y;
    const dist = Math.hypot(dx, dy);
    if (!prev || dist > RECONCILE_SNAP || dist < RECONCILE_EPS) {
      this.predError.x = 0;
      this.predError.y = 0;
    } else {
      this.predError.x = dx;
      this.predError.y = dy;
    }
  }

  /** Advance the predicted local player with live input between snapshots. */
  private predictFrame(dt: number): void {
    const p = this.predicted;
    if (!p) return;
    if (!p.dead && !p.downed && p.respawnTimer <= 0) {
      p.angle = Math.atan2(this.aimWorld.y - p.pos.y, this.aimWorld.x - p.pos.x);
      stepPlayerMovement(p, this.liveFrame(), dt, this.speedMul(p));
    }
    const k = Math.exp(-ERROR_BLEND_RATE * dt);
    this.predError.x *= k;
    this.predError.y *= k;
    if (Math.abs(this.predError.x) < 0.02) this.predError.x = 0;
    if (Math.abs(this.predError.y) < 0.02) this.predError.y = 0;
  }

  /**
   * Client-side estimate of the movement multiplier the server will use.
   * Role scaling is exact; status scaling is a best guess — any mismatch is
   * absorbed by the reconciliation blend rather than snapping the player.
   */
  private speedMul(p: PlayerEntity): number {
    let mul = 1;
    try {
      mul = getRole(p.role)?.speedMul ?? 1;
    } catch {
      mul = 1;
    }
    for (const s of p.statuses ?? []) {
      if (s.kind === 'stun' || s.kind === 'root') return 0;
      if (s.kind === 'chill') mul *= 1 - clamp(s.magnitude, 0, 0.9);
      else if (s.kind === 'haste') mul *= 1 + Math.max(0, s.magnitude);
    }
    return mul;
  }

  // ================================================================ interpolation

  /** Server-time we are rendering remote entities at. */
  private renderTime(): number {
    const snaps = this.snapshots;
    if (!snaps.length) return 0;
    const newest = snaps[snaps.length - 1].serverTime;
    const oldest = snaps[0].serverTime;
    if (this.clockOffset === null) return newest;
    const t = Date.now() + this.clockOffset - INTERP_DELAY_MS;
    return clamp(t, oldest, newest);
  }

  private interpolate(renderTime: number): WorldState | null {
    const snaps = this.snapshots;
    if (!snaps.length) return null;

    let i = snaps.length - 1;
    while (i > 0 && snaps[i].serverTime > renderTime) i--;
    const a = snaps[i];
    const b = snaps[Math.min(i + 1, snaps.length - 1)];
    const span = b.serverTime - a.serverTime;
    const t = span > 0 ? clamp((renderTime - a.serverTime) / span, 0, 1) : 1;

    const prevById = new Map<EntityId, Entity>();
    for (const e of a.world.entities) prevById.set(e.id, e);

    const entities: Entity[] = [];
    for (const e of b.world.entities) {
      if (e.id === this.selfEntityId && isPlayer(e)) {
        entities.push(this.renderSelf(e));
        continue;
      }
      const prev = prevById.get(e.id);
      entities.push(
        prev && prev.kind === e.kind ? cloneEntityLerped(prev as typeof e, e, t) : cloneEntityFlat(e),
      );
    }

    return {
      tick: b.world.tick,
      mode: b.world.mode,
      phase: b.world.phase,
      phaseTimer: b.world.phaseTimer,
      entities,
      objective: b.world.objective,
      events: this.drainEvents(renderTime),
    };
  }

  /** Events become visible when the interpolation clock reaches their snapshot. */
  private drainEvents(renderTime: number): GameEvent[] {
    const out: GameEvent[] = [];
    for (const s of this.snapshots) {
      if (s.serverTime <= this.drainedUntil) continue;
      if (s.serverTime > renderTime) break;
      if (s.world.events?.length) out.push(...s.world.events);
      this.drainedUntil = s.serverTime;
    }
    return out;
  }

  /** The local player as it should be drawn: predicted position + blended error. */
  private renderSelf(fallback: PlayerEntity): PlayerEntity {
    const p = this.predicted;
    if (!p) return cloneEntityFlat(fallback);
    const out = clonePlayer(p);
    out.pos.x += this.predError.x;
    out.pos.y += this.predError.y;
    if (this.board) out.weave = this.board;
    return out;
  }

  // ================================================================ input

  private wireInput(): void {
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => {
      this.held.clear();
      this.mouseDown = false;
    });

    window.addEventListener('mousemove', (e) => {
      this.mouseScreen.x = e.clientX;
      this.mouseScreen.y = e.clientY;
    });
    window.addEventListener(
      'mousedown',
      (e) => {
        if (this.screen !== 'playing' || this.paused) return;
        if (e.button !== 0) return;
        // The Weave panel owns its own clicks — never also swing at the world.
        if (this.weave.containsPoint(e.clientX, e.clientY)) return;
        if (e.target !== this.canvas && e.target !== this.overlay && e.target !== this.hud.root) return;
        this.mouseDown = true;
        this.pressedMask |= ActionBit.Basic;
      },
      true,
    );
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
      if (e.code === 'Escape') target.blur();
      return;
    }

    // Enter opens in-match chat. Once the input takes focus the guard above sends
    // every subsequent keystroke to the text field, so WASD types instead of moving.
    if ((e.code === 'Enter' || e.code === 'NumpadEnter') && this.screen === 'playing' && !this.paused) {
      e.preventDefault();
      // Composing while keys are physically held would leave them stuck down.
      this.held.clear();
      this.pressedMask = 0;
      this.hud.openChat((text) => this.conn.send({ t: 'chat', text }));
      return;
    }

    if (e.code === 'Escape') {
      e.preventDefault();
      // Audio settings sit on top of everything, so they close first.
      if (!this.audioPanel.classList.contains('hidden')) {
        this.setAudioPanel(false);
        return;
      }
      if (this.screen === 'playing') this.togglePause();
      else if (this.screen === 'loadout') this.setScreen(this.matchLive() ? 'playing' : 'lobby');
      return;
    }
    if (e.code === 'Tab') {
      e.preventDefault();
      if (this.screen === 'playing') this.hud.setScoreboard(true);
      return;
    }
    if (e.repeat) return;

    // M and O are free in the action map (see `actionBitFor`) and work on every
    // screen, so audio is always one key away.
    if (e.code === 'KeyM') {
      e.preventDefault();
      audio.toggleMute();
      this.syncAudioUi();
      return;
    }
    if (e.code === 'KeyO') {
      e.preventDefault();
      this.setAudioPanel(this.audioPanel.classList.contains('hidden'));
      return;
    }

    this.held.add(e.code);
    if (this.screen !== 'playing' || this.paused) return;
    if (MOVE_CODES.has(e.code) || e.code === 'Space') e.preventDefault();
    this.pressedMask |= actionBitFor(e.code);
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.held.delete(e.code);
    if (e.code === 'Tab') this.hud.setScoreboard(false);
  }

  private heldMask(): number {
    let m = 0;
    if (this.mouseDown) m |= ActionBit.Basic;
    for (const code of this.held) m |= actionBitFor(code);
    return m;
  }

  private moveVector(): Vec2 {
    let x = 0;
    let y = 0;
    if (this.held.has('KeyW') || this.held.has('ArrowUp')) y -= 1;
    if (this.held.has('KeyS') || this.held.has('ArrowDown')) y += 1;
    if (this.held.has('KeyA') || this.held.has('ArrowLeft')) x -= 1;
    if (this.held.has('KeyD') || this.held.has('ArrowRight')) x += 1;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    return { x, y };
  }

  /** The input frame as of *right now* — used for prediction between sends. */
  private liveFrame(): InputFrame {
    return {
      seq: this.seq,
      move: this.paused ? { x: 0, y: 0 } : this.moveVector(),
      aim: { x: this.aimWorld.x, y: this.aimWorld.y },
      buttons: this.paused ? 0 : this.heldMask() | this.pressedMask,
      ts: Date.now(),
    };
  }

  private sendInput(): void {
    if (this.screen !== 'playing' || this.selfEntityId < 0) return;
    const frame = this.liveFrame();
    this.seq++;
    this.pressedMask = 0;
    this.sent.push({ frame, sentAt: performance.now() });
    while (this.sent.length > 120) this.sent.shift();
    this.conn.send({ t: 'input', frame });
  }

  // ================================================================ screens

  private setScreen(next: ScreenName): void {
    if (next === this.screen && next !== 'playing') return;
    this.screen = next;
    document.body.dataset.screen = next;

    this.title.hide();
    this.lobby.hide();
    this.loadout.hide();
    this.results.hide();
    this.setPaused(false);

    // Out of a match the canvas belongs to the renderer's attract demo, which
    // also means the client shows something real with no server running.
    this.setDemo(next !== 'playing');

    const inMatch = next === 'playing';
    if (inMatch) {
      this.hud.show();
      this.weave.show();
    } else {
      this.hud.hide();
      this.hud.setScoreboard(false);
      if (next !== 'loadout') this.weave.hide();
    }

    switch (next) {
      case 'title':
        this.title.show();
        this.weave.hide();
        break;
      case 'lobby':
        this.lobby.show();
        if (this.lobbyState) this.lobby.setState(this.lobbyState, this.playerId);
        break;
      case 'loadout':
        this.loadout.show();
        this.weave.hide();
        break;
      case 'results':
        if (this.matchResult) this.results.show(this.matchResult, this.playerId, this.selfTeam());
        this.weave.hide();
        break;
      default:
        break;
    }

    // The score follows the screen; the per-frame sync below refines it with
    // phase/objective once snapshots start arriving.
    this.setAudioPanel(false);
    if (!inMatch) audio.weaveSilence();
    audio.updateMusic({ screen: next });
  }

  /** Did the local player's side win? Drives the results sting and music. */
  private matchWon(r: MatchResult): boolean {
    if (r.mode === 'coop_story') return r.winner === 'players' || !!r.chapterCleared;
    const team = this.selfTeam();
    if (team && r.winner === team) return true;
    return r.winner === this.playerId;
  }

  /**
   * Dev/attract fallback: `mountDemo` drives the arena canvas by itself, so the
   * game looks alive on the menus and is verifiable without a running server.
   */
  private setDemo(on: boolean): void {
    if (on === !!this.demoStop) return;
    if (on) {
      try {
        this.demoStop = mountDemo(this.canvas);
      } catch (err) {
        console.warn('[render] demo unavailable', err);
        this.demoStop = null;
      }
    } else {
      try {
        this.demoStop?.();
      } catch (err) {
        console.warn('[render] demo teardown failed', err);
      }
      this.demoStop = null;
    }
  }

  private selfTeam(): Team | null {
    const world = this.snapshots[this.snapshots.length - 1]?.world;
    const me = world?.entities.find((e) => e.id === this.selfEntityId);
    return me?.team ?? null;
  }

  private matchLive(): boolean {
    const world = this.snapshots[this.snapshots.length - 1]?.world;
    return !!world && world.phase !== 'complete' && world.phase !== 'lobby' && this.selfEntityId >= 0;
  }

  private endMatchState(): void {
    this.snapshots = [];
    this.sent = [];
    this.predicted = null;
    this.board = null;
    this.weave.clearBoard();
    this.selfEntityId = -1;
  }

  private leaveRoom(): void {
    this.conn.send({ t: 'leaveRoom' });
    this.roomId = null;
    this.lobbyState = null;
    this.matchResult = null;
    this.endMatchState();
    this.setScreen('title');
  }

  private buildPauseMenu(): HTMLElement {
    const root = h('div', 'screen screen-pause hidden');
    const panel = h('div', 'pause-panel');
    add(
      panel,
      h('div', 'pause-title', 'SYSTEM MENU'),
      button('RESUME', 'primary', () => this.setPaused(false)),
      button('RECONFIGURE LOADOUT', 'ghost', () => {
        this.setPaused(false);
        this.setScreen('loadout');
      }),
      button('AUDIO', 'ghost', () => this.setAudioPanel(true)),
      button('LEAVE MATCH', 'danger', () => this.leaveRoom()),
      h('div', 'pause-keys mono', KEYBIND_HELP),
    );
    root.appendChild(panel);
    return root;
  }

  // ================================================================ audio

  /**
   * Audio comes online on the first real gesture and not a moment earlier —
   * every browser refuses to start an AudioContext otherwise. Two delegated
   * listeners then cover UI feedback for every button any screen will ever
   * build, so no screen module needs to know audio exists.
   */
  private wireAudio(): void {
    const unlock = (): void => {
      if (!audio.unlock()) return;
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      audio.updateMusic({ screen: this.screen });
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);

    this.overlay.addEventListener('pointerover', (e) => {
      const hit = interactiveAt(e.target);
      if (hit === this.hovered) return;
      this.hovered = hit;
      if (hit && !(hit as HTMLButtonElement).disabled) audio.ui('hover');
    });
    this.overlay.addEventListener(
      'click',
      (e) => {
        const hit = interactiveAt(e.target);
        if (!hit) return;
        if ((hit as HTMLButtonElement).disabled) {
          audio.ui('deny');
          return;
        }
        audio.ui(BACK_LABEL.test(hit.textContent ?? '') ? 'back' : 'click');
      },
      true,
    );

    this.syncAudioUi();
  }

  private buildAudioPanel(): HTMLElement {
    const root = h('div', 'screen screen-pause hidden');
    const panel = h('div', 'pause-panel');
    panel.style.minWidth = '360px';

    const rows = h('div');
    rows.style.display = 'grid';
    rows.style.gap = '15px';
    rows.style.margin = '2px 0 16px';
    for (const kind of VOLUME_KINDS) rows.appendChild(this.buildVolumeRow(kind));

    const mute = button('MUTE  ·  M', 'ghost', () => {
      audio.toggleMute();
      this.syncAudioUi();
    });
    this.muteLabel = mute.querySelector('.btn-label');

    add(
      panel,
      h('div', 'pause-title', 'AUDIO'),
      rows,
      mute,
      button('CLOSE', 'primary', () => this.setAudioPanel(false)),
      h('div', 'pause-keys mono', 'M  mute · O  this panel\nall sound is synthesized live — no audio files'),
    );
    root.appendChild(panel);
    return root;
  }

  private buildVolumeRow(kind: VolumeKind): HTMLElement {
    const row = h('div');
    const head = h('div');
    head.style.display = 'flex';
    head.style.justifyContent = 'space-between';
    head.style.alignItems = 'baseline';
    const value = h('span', 'stat-value mono', '');
    add(head, h('span', 'field-label', VOLUME_LABEL[kind]), value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.value = String(Math.round(audio.volumes[kind] * 100));
    input.style.width = '100%';
    input.style.marginTop = '7px';
    input.style.accentColor = 'var(--cyan)';
    input.style.cursor = 'pointer';
    input.addEventListener('input', () => {
      audio.setVolume(kind, Number(input.value) / 100);
      value.textContent = `${input.value}%`;
    });
    // One confirmation blip per drag, on release — not per pixel.
    input.addEventListener('change', () => audio.ui('toggle'));

    this.volInputs[kind] = input;
    this.volLabels[kind] = value;
    value.textContent = `${input.value}%`;
    return add(row, head, input);
  }

  private buildMutedBadge(): HTMLElement {
    const el = h('div', 'mono hidden', 'AUDIO MUTED  ·  M');
    const s = el.style;
    s.position = 'fixed';
    s.top = '10px';
    s.left = '50%';
    s.transform = 'translateX(-50%)';
    s.padding = '4px 13px';
    s.border = '1px solid var(--line-2)';
    s.borderRadius = 'var(--r-sm)';
    s.background = 'var(--panel)';
    s.color = 'var(--muted)';
    s.fontSize = '10px';
    s.letterSpacing = '0.24em';
    s.zIndex = '60';
    s.pointerEvents = 'none';
    return el;
  }

  private setAudioPanel(on: boolean): void {
    const wasOpen = !this.audioPanel.classList.contains('hidden');
    if (on === wasOpen) return;
    this.audioPanel.classList.toggle('hidden', !on);
    if (on) {
      this.syncAudioUi();
      this.held.clear();
      this.mouseDown = false;
    }
  }

  /** Push the engine's live volume state back into the sliders and the badge. */
  private syncAudioUi(): void {
    const v = audio.volumes;
    for (const kind of VOLUME_KINDS) {
      const pct = Math.round(v[kind] * 100);
      const input = this.volInputs[kind];
      if (input && document.activeElement !== input) input.value = String(pct);
      const label = this.volLabels[kind];
      if (label) label.textContent = `${pct}%`;
    }
    if (this.muteLabel) this.muteLabel.textContent = v.muted ? 'UNMUTE  ·  M' : 'MUTE  ·  M';
    this.mutedBadge.classList.toggle('hidden', !v.muted);
  }

  private togglePause(): void {
    this.setPaused(!this.paused);
  }

  private setPaused(on: boolean): void {
    this.paused = on && this.screen === 'playing';
    this.pause.classList.toggle('hidden', !this.paused);
    if (this.paused) {
      this.held.clear();
      this.mouseDown = false;
      this.hud.setScoreboard(false);
    }
  }

  private applyRoleAccent(role: RoleId): void {
    try {
      const def = getRole(role);
      if (def) {
        document.body.style.setProperty('--accent-role', def.color);
        this.weave.accent = def.color;
        this.weave.chargeRateMul = def.chargeRateMul;
        this.weave.setTitle(`WEAVE · ${def.name.toUpperCase()}`);
      }
    } catch {
      /* content module not loaded */
    }
  }

  private refreshSlotMeta(): void {
    const board = this.board;
    if (!board) return;
    const costs: number[] = [];
    const icons: string[] = [];
    for (const slot of board.slots) {
      let cost = 1;
      let icon = '◆';
      try {
        const def = getAbility(slot.ability);
        if (def) {
          cost = Math.max(0.0001, def.cost);
          icon = def.icon || '◆';
        }
      } catch {
        /* ignore */
      }
      costs.push(cost);
      icons.push(icon);
    }
    this.weave.costs = costs;
    this.weave.icons = icons;
  }

  // ================================================================ frame

  private resize(): void {
    this.renderer.resize();
  }

  private frame = (nowMs: number): void => {
    requestAnimationFrame(this.frame);
    if (!this.lastFrame) this.lastFrame = nowMs;
    const rawDt = nowMs - this.lastFrame;
    this.lastFrame = nowMs;

    // --- 30 Hz input, independent of the render cadence -----------------
    this.inputAccum += rawDt;
    if (this.inputAccum > 250) this.inputAccum = INPUT_MS;
    while (this.inputAccum >= INPUT_MS) {
      this.inputAccum -= INPUT_MS;
      this.sendInput();
    }

    // --- 60 fps render gate ---------------------------------------------
    const sinceRender = nowMs - this.lastRender;
    if (sinceRender < FRAME_MS - 1.2) return;
    this.lastRender = nowMs;
    const dtMs = Math.min(100, sinceRender);
    const dt = dtMs / 1000;
    this.fps = this.fps * 0.9 + (1000 / Math.max(1, dtMs)) * 0.1;

    if (this.screen === 'loadout') this.loadout.update(dtMs);

    if (this.screen === 'playing' || this.screen === 'results') {
      this.updateAim();
      if (this.screen === 'playing') this.predictFrame(dt);
      const world = this.interpolate(this.renderTime());
      if (world) {
        this.updateCamera(dt);

        // --- audio: same drained event array the renderer consumes ---------
        audio.setListener(this.predicted?.pos ?? this.camera);
        audio.handleEvents(world.events, this.playerId);
        audio.updateMusic({
          screen: this.screen,
          phase: world.phase,
          objective: world.objective,
          boss: hasBoss(world),
        });
        if (world.phase === 'countdown') audio.countdown(world.phaseTimer);

        const view: RenderView = {
          world,
          selfId: this.selfEntityId,
          camera: this.camera,
          aim: this.aimWorld,
        };
        this.renderer.render(view, dtMs);
        if (this.screen === 'playing') {
          this.weave.advanceCharge(dt);
          this.weave.update(dtMs);
          // Charge hums track the same extrapolated board the panel draws.
          audio.updateWeave(this.board);
          this.hud.update(
            {
              world,
              self: this.predicted ?? world.entities.find((e): e is PlayerEntity => isPlayer(e) && e.id === this.selfEntityId) ?? null,
              selfId: this.selfEntityId,
              board: this.board,
              events: world.events,
              ping: this.conn.ping,
              fps: this.fps,
              linkDown: this.conn.state !== 'open',
            },
            dtMs,
          );
        }
      }
    }
  };

  private updateAim(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const hgt = this.canvas.clientHeight || window.innerHeight;
    const z = this.camera.zoom || 1;
    this.aimWorld.x = this.camera.x + (this.mouseScreen.x - w / 2) / z;
    this.aimWorld.y = this.camera.y + (this.mouseScreen.y - hgt / 2) / z;
  }

  /**
   * Re-measure how far each HUD block intrudes on the canvas.
   *
   * Each occluder is cleared from whichever *single* edge is cheapest: the Weave
   * panel costs 330 px of width or 351 px of height at 1600x900, so it becomes a
   * right inset and the bottom stays free for the slot gauges' 63 px. That keeps
   * the safe rect as large as possible while still fully clearing every element,
   * and it adapts automatically when the layout reflows.
   */
  private measureHudInsets(): void {
    const view = this.canvas.getBoundingClientRect();
    if (view.width < 1 || view.height < 1) return;
    let l = 0;
    let t = 0;
    let r = 0;
    let b = 0;
    for (const sel of HUD_OCCLUDERS) {
      const el = document.querySelector(sel);
      if (el === null) continue;
      const q = el.getBoundingClientRect();
      // A hidden panel (display:none) measures 0x0 and costs the camera nothing.
      if (q.width < 1 || q.height < 1) continue;
      const x0 = Math.max(q.left, view.left);
      const x1 = Math.min(q.right, view.right);
      const y0 = Math.max(q.top, view.top);
      const y1 = Math.min(q.bottom, view.bottom);
      if (x1 <= x0 || y1 <= y0) continue; // scrolled off the canvas entirely
      const fromL = x1 - view.left;
      const fromT = y1 - view.top;
      const fromR = view.right - x0;
      const fromB = view.bottom - y0;
      const best = Math.min(fromL, fromT, fromR, fromB);
      if (best === fromL) l = Math.max(l, fromL);
      else if (best === fromT) t = Math.max(t, fromT);
      else if (best === fromR) r = Math.max(r, fromR);
      else b = Math.max(b, fromB);
    }
    // Hard ceiling: a pathological layout must never strand the camera in a
    // sliver of screen. Beyond this the HUD, not the camera, is the bug.
    const capX = view.width * HUD_INSET_MAX_FRAC;
    const capY = view.height * HUD_INSET_MAX_FRAC;
    this.hudInsetTarget.l = Math.min(l, capX);
    this.hudInsetTarget.r = Math.min(r, capX);
    this.hudInsetTarget.t = Math.min(t, capY);
    this.hudInsetTarget.b = Math.min(b, capY);
  }

  private updateCamera(dt: number): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const hgt = this.canvas.clientHeight || window.innerHeight;
    this.camera.zoom = clamp(Math.max(w / 1400, hgt / 900), 0.75, 1.9);

    // Measuring forces a layout flush, so do it on a slow clock and glide toward
    // the result — a banner fading in must never snap the view.
    this.hudInsetClock -= dt;
    if (this.hudInsetClock <= 0) {
      this.hudInsetClock = HUD_INSET_INTERVAL;
      this.measureHudInsets();
    }
    const ins = this.hudInset;
    const ik = 1 - Math.exp(-6 * dt);
    ins.l += (this.hudInsetTarget.l - ins.l) * ik;
    ins.t += (this.hudInsetTarget.t - ins.t) * ik;
    ins.r += (this.hudInsetTarget.r - ins.r) * ik;
    ins.b += (this.hudInsetTarget.b - ins.b) * ik;

    const self = this.predicted;
    if (!self) return;
    const z = this.camera.zoom;
    const lookX = clamp(this.aimWorld.x - self.pos.x, -420, 420) * 0.14;
    const lookY = clamp(this.aimWorld.y - self.pos.y, -420, 420) * 0.14;

    // Frame the player at the centre of the space you can actually see, not the
    // centre of the canvas. With a 330 px panel on the right that is 144 world
    // units of offset, and it is the difference between "centred" and "shoved
    // under the Weave board".
    const offX = (ins.l - ins.r) / 2 / z;
    const offY = (ins.t - ins.b) / 2 / z;
    let tx = self.pos.x + this.predError.x + lookX - offX;
    let ty = self.pos.y + this.predError.y + lookY - offY;

    // Clamp against the safe rect rather than the canvas. Letting the camera
    // overscroll by exactly the inset lands the arena's edge where the HUD
    // begins, so no playable ground is ever parked behind furniture — and the
    // player's own glyph keeps CAMERA_EDGE_PAD px of daylight from it.
    const halfW = w / 2 / z;
    const halfH = hgt / 2 / z;
    const padL = (ins.l + CAMERA_EDGE_PAD) / z;
    const padR = (ins.r + CAMERA_EDGE_PAD) / z;
    const padT = (ins.t + CAMERA_EDGE_PAD) / z;
    const padB = (ins.b + CAMERA_EDGE_PAD) / z;
    const minX = halfW - padL;
    const maxX = ARENA_W - halfW + padR;
    const minY = halfH - padT;
    const maxY = ARENA_H - halfH + padB;
    // Arena narrower than the safe rect: centre it inside the safe rect instead.
    tx = minX <= maxX ? clamp(tx, minX, maxX) : ARENA_W / 2 - offX;
    ty = minY <= maxY ? clamp(ty, minY, maxY) : ARENA_H / 2 - offY;

    const k = 1 - Math.exp(-10 * dt);
    this.camera.x += (tx - this.camera.x) * k;
    this.camera.y += (ty - this.camera.y) * k;
  }
}

/**
 * HUD blocks the camera must not park gameplay under. Order is irrelevant —
 * each is cleared from its own cheapest edge. Transient chatter (kill feed,
 * dialogue, toasts) is deliberately absent: it comes and goes constantly and
 * budgeting for it would keep the camera permanently squeezed.
 */
const HUD_OCCLUDERS = ['.hud-vitals', '.hud-objective', '.hud-slots', '.weave-panel'] as const;
/** Seconds between HUD measurements. Each one costs a layout flush. */
const HUD_INSET_INTERVAL = 0.2;
/** No single axis may lose more than this fraction of the viewport to the HUD. */
const HUD_INSET_MAX_FRAC = 0.34;
/**
 * Extra screen-px of daylight kept between the arena edge and the HUD, so the
 * player's glyph, glow and nameplate clear the furniture rather than touching it.
 */
const CAMERA_EDGE_PAD = 26;

// ---------------------------------------------------------------- keybinds

type VolumeKind = 'master' | 'music' | 'sfx';
const VOLUME_KINDS: readonly VolumeKind[] = ['master', 'music', 'sfx'];
const VOLUME_LABEL: Record<VolumeKind, string> = {
  master: 'MASTER',
  music: 'MUSIC',
  sfx: 'EFFECTS',
};

/** Labels that should get the descending "back" blip rather than the click. */
const BACK_LABEL = /\b(BACK|LEAVE|CANCEL|CLOSE|EXIT)\b/i;

/** Nearest thing under the pointer that behaves like a control. */
function interactiveAt(target: EventTarget | null): HTMLElement | null {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return null;
  return el.closest('button, .btn, [class*="card"], .field, [role="button"]');
}

/** Any boss-class enemy alive? Escalates the score to its hardest state. */
function hasBoss(world: WorldState): boolean {
  for (const e of world.entities) {
    if (e.kind === 'enemy' && typeof e.archetype === 'string' && e.archetype.includes('boss')) return true;
  }
  return false;
}

const MOVE_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/** Physical-key -> action bit. Layout independent (uses KeyboardEvent.code). */
function actionBitFor(code: string): number {
  switch (code) {
    case 'Digit1':
    case 'Numpad1':
    case 'KeyQ':
      return ActionBit.Fire1;
    case 'Digit2':
    case 'Numpad2':
    case 'KeyE':
      return ActionBit.Fire2;
    case 'Digit3':
    case 'Numpad3':
    case 'KeyR':
      return ActionBit.Fire3;
    case 'Space':
    case 'ShiftLeft':
    case 'ShiftRight':
      return ActionBit.Dash;
    case 'KeyF':
      return ActionBit.Interact;
    default:
      return 0;
  }
}

const KEYBIND_HELP = [
  'WASD  move',
  'MOUSE  aim',
  'LMB  basic attack',
  '1 2 3  fire weave slots  (Q E R)',
  'SPACE / SHIFT  dash',
  'F  interact · revive',
  'TAB  scoreboard',
  'ESC  menu',
  'M  mute · O  audio settings',
  'CLICK A TILE  rotate the weave',
].join('\n');

// ---------------------------------------------------------------- bootstrap

function boot(): void {
  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  const overlay = document.getElementById('overlay');
  if (!canvas || !overlay) throw new Error('voidline: missing #game or #overlay');
  const client = new VoidlineClient(canvas, overlay);
  (window as unknown as Record<string, unknown>).voidline = client;
  // Exposed for the headless audio smoke test (and for tweaking the mix live).
  (window as unknown as Record<string, unknown>).voidlineAudio = audio;
  document.getElementById('boot')?.remove();
  document.body.classList.add('ready');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
