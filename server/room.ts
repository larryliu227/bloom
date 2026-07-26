/**
 * VOIDLINE — the room.
 *
 * A room is one lobby that becomes one match. It owns:
 *   - the phase machine  lobby -> loadout -> countdown -> playing -> complete
 *   - the roster, host succession, and 20 s reconnect slots
 *   - input buffering and the per-client `ackSeq`
 *   - the weave: rotation cooldowns, power recomputation, owner-only dispatch
 *   - the snapshot broadcast
 *
 * It does NOT own gameplay. `stepWorld` (agent C) advances the world and a
 * `ModeHandler` (agents G/H) decides what winning means. The room is the wiring
 * between them, and the only thing that ever touches a socket.
 */

import { randomInt } from 'node:crypto';

import { getAbility } from '@shared/abilities.js';
import {
  ABILITY_SLOTS,
  ARENA_H,
  ARENA_W,
  BASE_HP,
  BASIC_ATTACK_COOLDOWN,
  CHAT_MAX_LEN,
  COUNTDOWN_SEC,
  LOADOUT_PHASE_SEC,
  MATCH_COMPLETE_LINGER_SEC,
  PLAYER_RADIUS,
  RECONNECT_GRACE_SEC,
  RESPAWN_DELAY,
  TICK_RATE,
  WEAVE_ROTATE_COOLDOWN,
  WEAVE_SYNC_INTERVAL_TICKS,
} from '@shared/constants.js';
import { fireAbility } from '@shared/combat.js';
import { makeRng } from '@shared/math.js';
import { ActionBit, encode } from '@shared/protocol.js';
import type { ClientMsg, InputFrame, MatchResult, ServerMsg } from '@shared/protocol.js';
import { defaultLoadout, getRole, validateLoadout } from '@shared/roles.js';
import { stepWorld } from '@shared/sim.js';
import type { SimContext, SimHooks } from '@shared/sim.js';
import type {
  AbilityDef,
  AbilityId,
  Entity,
  EntityId,
  GameEvent,
  GameMode,
  LobbyPlayer,
  MatchPhase,
  PlayerEntity,
  PlayerId,
  RoleDef,
  RoleId,
  RoomId,
  StatusKind,
  Vec2,
  WeaveBoard,
  WeaveTile,
  WorldState,
} from '@shared/types.js';
import {
  canFire,
  consumeCharge,
  createBoard,
  damageBoard,
  linkRelays,
  recomputePower,
  rotateTile as rotateWeaveTile,
  scrambleBoard,
  updateCharge,
} from '@shared/weave.js';

import { Lobby, isRoleId, minPlayersFor } from './lobby.js';
import type { BotTier } from './lobby.js';
import { BotController, DEFAULT_BOT_TIER, isBotTier } from './systems/bots.js';
import { NullModeHandler, clampToArena, createModeHandler, drainBoardUpdates } from './modes/index.js';
import type { ModeHandler } from './modes/index.js';
import { Client, sanitizeChat } from './net.js';

/** Shared empty array spliced into snapshots in place of every weave grid. */
const NO_TILES: WeaveTile[] = [];

/** Runaway guard — a broken mode handler must not be able to OOM the process. */
const MAX_ENTITIES = 2000;

/** Per-player state the client never sees and the world does not need. */
interface PlayerRuntime {
  /** Most recent accepted input frame; reused if a packet is late. */
  latest: InputFrame | null;
  /** Highest seq we have accepted — echoed back as `ackSeq`. */
  ackSeq: number;
  /** Buttons from the frame applied last tick, for rising-edge detection. */
  prevButtons: number;
  rotateCooldown: number;
  basicCooldown: number;
  weaveDirty: boolean;
  lastWeaveTick: number;
  lastSentChargeSum: number;
  slotConnected: boolean[];
  /** True while this player was waiting out a respawn timer at the last tick. */
  respawnPending: boolean;
  /** Where they were lying when the timer was still running. */
  respawnPos: Vec2 | null;
  /** ms timestamp of the drop, or 0 while connected. */
  disconnectedAt: number;
  stats: MatchStats;
}

interface MatchStats {
  damageDealt: number;
  damageTaken: number;
  slotsCharged: number;
  revives: number;
}

export interface RoomOptions {
  chapter?: number;
  isPublic?: boolean;
}

export class Room {
  readonly id: RoomId;
  readonly mode: GameMode;
  readonly createdAt = Date.now();
  readonly lobby: Lobby;
  /** Server-controlled AI runners seated in this room. */
  readonly bots: BotController;
  /** Rooms opened by Quick Play are public and can be matched into. */
  isPublic: boolean;

  phase: MatchPhase = 'lobby';
  closed = false;
  /** ms timestamp since the room had zero live sockets, or 0. */
  emptySince = Date.now();

  /** Live sockets, keyed by player id. Excludes players in their grace window. */
  readonly clients = new Map<PlayerId, Client>();
  /** Player entities for the current match, including held disconnects. */
  readonly players = new Map<PlayerId, PlayerEntity>();

  readonly world: WorldState;

  /** Set by matchmaking so it can track reconnect slots without a circular import. */
  onPlayerHeld:
    | ((room: Room, playerId: PlayerId, graceMs: number, token: string) => void)
    | null = null;
  onPlayerReleased: ((room: Room, playerId: PlayerId) => void) | null = null;

  private readonly runtime = new Map<PlayerId, PlayerRuntime>();
  private handler: ModeHandler;
  private readonly ctx: SimContext;
  private readonly hooks: SimHooks;

  private seedValue = 0;
  private rngFn: () => number = makeRngSafe(1);
  private nextEntityId = 1;
  private phaseTimer = 0;
  private matchStartMs = 0;
  private lastCountdownShown = -1;

  /**
   * Who advances weave charge and turns Fire buttons into casts.
   *
   * `stepWorld` may already do it (agent C owns ability resolution), in which
   * case the room must keep its hands off or every cast would fire twice. We
   * watch the first half second of the match: if total charge never moves while
   * a slot is connected and chargeable, the room takes over. Whoever advances
   * charge also fires — the two always travel together.
   */
  private weaveDriver: 'probing' | 'sim' | 'room' = 'probing';
  private probeTicks = 0;

  constructor(id: RoomId, mode: GameMode, opts: RoomOptions = {}) {
    this.id = id;
    this.mode = mode;
    this.isPublic = opts.isPublic ?? false;
    this.lobby = new Lobby(mode, opts.chapter ?? 1);
    this.bots = new BotController(this);
    this.handler = new NullModeHandler(mode);

    this.world = {
      tick: 0,
      mode,
      phase: 'lobby',
      phaseTimer: 0,
      entities: [],
      objective: { label: '', progress: -1 },
      events: [],
    };

    this.hooks = {
      onDamage: (ctx, target, amount, source) => {
        this.recordDamage(target, amount, source);
        this.guard('onDamage', () => this.handler.onDamage(ctx, target, amount, source));
      },
      onDeath: (ctx, entity, killer) => {
        this.guard('onDeath', () => this.handler.onDeath(this, ctx, entity, killer));
        // Safety net: without this a dead player in PvP would never come back
        // if the mode handler forgot to arm the timer.
        if (entity.kind === 'player' && this.mode !== 'coop_story') {
          if (entity.hp <= 0 && entity.respawnTimer <= 0 && !entity.downed) {
            entity.respawnTimer = RESPAWN_DELAY;
          }
        }
      },
    };

    // The world object is never replaced, only reset in place, so this context
    // stays valid for the lifetime of the room.
    this.ctx = {
      world: this.world,
      rng: () => this.rngFn(),
      nextId: () => this.allocId(),
      emit: (e: GameEvent) => this.emit(e),
      hooks: this.hooks,
    };
  }

  // ======================================================================
  // Public surface used by mode handlers (agents G and H)
  // ======================================================================

  get chapter(): number {
    return this.lobby.chapter;
  }

  get seed(): number {
    return this.seedValue;
  }

  get maxPlayers(): number {
    return this.lobby.maxPlayers;
  }

  /** Every player entity in the current match, in join order. */
  playerEntities(): PlayerEntity[] {
    const out: PlayerEntity[] = [];
    for (const lp of this.lobby.list()) {
      const e = this.players.get(lp.playerId);
      if (e) out.push(e);
    }
    return out;
  }

  playerCount(): number {
    return this.players.size;
  }

  /** Stable 0-based index for a player, for deterministic spawn slots. */
  spawnOrderOf(playerId: PlayerId): number {
    const i = this.lobby.orderOf(playerId);
    return i < 0 ? 0 : i;
  }

  /** Allocate an entity id. Same allocator `ctx.nextId()` uses. */
  allocId(): EntityId {
    this.nextEntityId += 1;
    return this.nextEntityId;
  }

  /** Add an entity to the world, respecting the runaway guard. */
  spawnEntity(entity: Entity): boolean {
    if (this.world.entities.length >= MAX_ENTITIES) return false;
    this.world.entities.push(entity);
    return true;
  }

  emit(event: GameEvent): void {
    // Events are consumed by exactly one snapshot and then dropped, so an
    // unbounded queue here would only ever be a leak.
    if (this.world.events.length < 256) this.world.events.push(event);
  }

  /** Force a full weave push to this player on the next tick. */
  markWeaveDirty(playerId: PlayerId): void {
    const rt = this.runtime.get(playerId);
    if (rt) rt.weaveDirty = true;
  }

  /** Enemy "conduit burst": kill a cell on a player's board. */
  damageWeave(player: PlayerEntity, seed?: number): number {
    const index = damageBoard(player.weave, seed ?? this.seedFromRng());
    this.refreshBoards(player);
    return index;
  }

  /** Boss mechanic / round reset: randomize every unlocked tile. */
  scrambleWeave(player: PlayerEntity, seed?: number): void {
    scrambleBoard(player.weave, seed ?? this.seedFromRng());
    this.refreshBoards(player);
  }

  /** Scramble everyone — used by H between duel rounds. */
  scrambleAllWeaves(): void {
    for (const p of this.players.values()) this.scrambleWeave(p);
  }

  stats(playerId: PlayerId): MatchStats {
    return this.statsFor(playerId);
  }

  /** Modes may move between `playing` and `intermission` freely. */
  setPhase(phase: MatchPhase, timer = 0): void {
    this.phase = phase;
    this.phaseTimer = Math.max(0, timer);
    this.world.phase = phase;
    this.world.phaseTimer = this.phaseTimer;
  }

  // ======================================================================
  // Roster
  // ======================================================================

  /**
   * True if the room's PHASE lets a newcomer be seated, ignoring capacity.
   * Split out from `isJoinable` because "full" is fixable by freeing a bot seat
   * and "mid-match" is not.
   */
  private seatingOpen(): boolean {
    if (this.closed) return false;
    return this.phase === 'lobby' || this.phase === 'loadout' || this.phase === 'complete';
  }

  /** True if a newcomer could take a seat right now. */
  isJoinable(): boolean {
    return this.seatingOpen() && this.lobby.size < this.lobby.maxPlayers;
  }

  join(client: Client): boolean {
    if (this.closed) return false;

    // Reconnect: the slot was held open, take it back.
    if (this.lobby.has(client.id)) {
      this.reattach(client);
      return true;
    }

    // A human always outranks a bot: free a seat rather than turn them away.
    // Only while seating is open, though. Mid-match the join is refused whatever
    // we do here, and evicting a bot would rip a live body out of the running
    // world — `releaseBotSeat` deletes the entity — for a join that then fails
    // anyway. That made any stray `joinRoom` at a full, in-progress room silently
    // shrink the match.
    if (this.seatingOpen() && this.lobby.isFull() && this.bots.count > 0) {
      this.bots.remove();
    }
    if (!this.isJoinable()) return false;

    this.lobby.add(client.id, client.name);
    this.runtimeFor(client.id);
    client.roomId = this.id;
    this.clients.set(client.id, client);
    this.emptySince = 0;

    client.send({ t: 'lobby', state: this.lobbyState() });
    this.broadcastLobby();
    return true;
  }

  /**
   * `hold` is true when the socket died mid-match: the entity stays in the
   * world marked `connected: false` for RECONNECT_GRACE_SEC so the player can
   * drop back into the same slot. An explicit `leaveRoom` never holds.
   */
  leave(client: Client, hold = false): void {
    const playerId = client.id;

    // A dead socket's teardown can arrive after the same player has already
    // reconnected on a fresh one. Never let the stale close evict the new seat.
    const seated = this.clients.get(playerId);
    if (seated && seated !== client) {
      if (client.roomId === this.id) client.roomId = null;
      return;
    }

    if (client.roomId === this.id) client.roomId = null;
    this.clients.delete(playerId);

    const inMatch = this.isLive() && this.players.has(playerId);
    if (hold && inMatch) {
      const entity = this.players.get(playerId);
      if (entity) {
        entity.connected = false;
        // Freeze them in place rather than letting a stale frame run them into
        // a wall for the next 20 seconds.
        entity.vel = { x: 0, y: 0 };
      }
      const rt = this.runtimeFor(playerId);
      rt.disconnectedAt = Date.now();
      rt.latest = null;
      rt.prevButtons = 0;
      this.lobby.setConnected(playerId, false);
      // Pass the departing socket's SECRET token, not just the public playerId —
      // reclaiming this slot must require proving you were the one who left.
      this.onPlayerHeld?.(this, playerId, RECONNECT_GRACE_SEC * 1000, client.reconnectToken);
    } else {
      this.releasePlayer(playerId);
    }

    if (this.clients.size === 0 && this.emptySince === 0) this.emptySince = Date.now();

    // Host succession happens inside the lobby; announce the new state.
    this.broadcastLobby();
    this.maybeAbortForEmptyMatch();
  }

  /** Permanently drop a player: entity, runtime, lobby seat. */
  private releasePlayer(playerId: PlayerId): void {
    const entity = this.players.get(playerId);
    if (entity) {
      entity.connected = false;
      entity.dead = true;
      const i = this.world.entities.indexOf(entity);
      if (i >= 0) this.world.entities.splice(i, 1);
      this.players.delete(playerId);
    }
    this.runtime.delete(playerId);
    this.lobby.remove(playerId);
    this.onPlayerReleased?.(this, playerId);
  }

  private reattach(client: Client): void {
    const rt = this.runtimeFor(client.id);
    rt.disconnectedAt = 0;
    rt.weaveDirty = true;
    rt.prevButtons = 0;
    rt.latest = null;

    client.roomId = this.id;
    this.clients.set(client.id, client);
    this.emptySince = 0;
    this.lobby.add(client.id, client.name);
    this.lobby.setConnected(client.id, true);

    const entity = this.players.get(client.id);
    if (entity) {
      entity.connected = true;
      entity.name = client.name;
      entity.ping = client.ping;
    }

    client.send({ t: 'lobby', state: this.lobbyState() });
    if (this.isLive() && entity) {
      client.send({ t: 'matchStart', mode: this.mode, seed: this.seedValue, you: entity.id });
      client.send({ t: 'weave', board: entity.weave });
    }
    this.broadcastLobby();
  }

  /** If every human vanished mid-match, do not keep simulating an empty world. */
  private maybeAbortForEmptyMatch(): void {
    if (!this.isLive()) return;
    if (this.clients.size > 0) return;
    this.returnToLobby();
  }

  private isLive(): boolean {
    return this.phase === 'playing' || this.phase === 'intermission' || this.phase === 'countdown';
  }

  // ======================================================================
  // Message handling
  // ======================================================================

  handle(client: Client, msg: ClientMsg): void {
    switch (msg.t) {
      case 'leaveRoom':
        this.leave(client, false);
        break;

      // Selection handlers return false both for "nothing changed" and for
      // "refused". Either way the sender is now potentially holding a stale view
      // of its own row, so it gets the authoritative state back even though the
      // rest of the room has nothing new to hear.
      case 'chooseRole':
        if (this.phase !== 'lobby' && this.phase !== 'loadout') return;
        if (this.lobby.chooseRole(client.id, msg.role)) this.broadcastLobby();
        else if (!isRoleId(msg.role)) this.sendLobbyTo(client);
        break;

      case 'chooseLoadout':
        if (this.phase !== 'lobby' && this.phase !== 'loadout') return;
        if (this.lobby.chooseLoadout(client.id, msg.loadout)) this.broadcastLobby();
        else if (!this.lobby.get(client.id)?.role) this.sendLobbyTo(client);
        break;

      case 'setReady':
        if (this.phase !== 'lobby' && this.phase !== 'loadout') return;
        if (this.lobby.setReady(client.id, msg.ready)) this.broadcastLobby();
        else this.sendLobbyTo(client);
        break;

      case 'setChapter':
        if (this.phase !== 'lobby' && this.phase !== 'loadout') return;
        if (!this.lobby.isHost(client.id)) {
          client.error('not_host', 'Only the host can change the chapter.');
          return;
        }
        if (this.lobby.setChapter(msg.chapter)) this.broadcastLobby();
        break;

      case 'startMatch':
        this.onStartMatch(client);
        break;

      case 'addBot': {
        if (this.phase !== 'lobby' && this.phase !== 'loadout') return;
        if (!this.lobby.isHost(client.id)) {
          client.error('not_host', 'Only the host can add AI runners.');
          return;
        }
        const tier = isBotTier(msg.tier) ? msg.tier : DEFAULT_BOT_TIER;
        if (this.bots.add(tier, msg.role)) this.broadcastLobby();
        else client.error('room_full', 'No seats left for another runner.');
        break;
      }

      case 'removeBot':
        if (this.phase !== 'lobby' && this.phase !== 'loadout') return;
        if (!this.lobby.isHost(client.id)) {
          client.error('not_host', 'Only the host can remove AI runners.');
          return;
        }
        if (this.bots.remove()) this.broadcastLobby();
        break;

      case 'input':
        this.onInput(client, msg.frame);
        break;

      case 'rotateTile':
        this.onRotate(client, msg.index);
        break;

      case 'chat':
        this.onChat(client, msg.text);
        break;

      case 'ping':
        client.send({ t: 'pong', ts: msg.ts, serverTime: Date.now() });
        break;

      default:
        // hello / createRoom / joinRoom / quickPlay are handled by the server.
        break;
    }
  }

  private onStartMatch(client: Client): void {
    if (!this.lobby.isHost(client.id)) {
      client.error('not_host', 'Only the host can start the match.');
      return;
    }
    if (this.lobby.connectedCount < minPlayersFor(this.mode)) {
      client.error('not_enough_players', `This mode needs ${minPlayersFor(this.mode)} players.`);
      return;
    }
    // The loadout phase is a grace window for people who have not picked yet.
    // If everyone already has a legal build, skip it and light the fuse.
    if (this.phase === 'lobby') {
      if (this.lobby.everyoneLockedIn()) this.beginCountdown();
      else this.beginLoadout();
    } else if (this.phase === 'loadout') {
      this.beginCountdown();
    } else if (this.phase === 'complete') {
      this.returnToLobby();
      if (this.lobby.everyoneLockedIn()) this.beginCountdown();
      else this.beginLoadout();
    }
  }

  private onInput(client: Client, raw: unknown): void {
    const rt = this.runtime.get(client.id);
    if (!rt) return;
    const frame = sanitizeInput(raw);
    if (!frame) return;
    // Latest-wins, stale-dropped. `ackSeq` is the high-water mark we echo back
    // so the client knows exactly how far to rewind its prediction.
    if (frame.seq <= rt.ackSeq) return;
    rt.ackSeq = frame.seq;
    rt.latest = frame;
  }

  private onRotate(client: Client, index: unknown): void {
    this.rotateTileFor(client.id, index);
  }

  /**
   * The single rotation path. Humans reach it through `rotateTile`, bots through
   * `server/systems/bots.ts` — so the phase gate, the bounds check and the
   * `WEAVE_ROTATE_COOLDOWN` anti-spam are provably identical for both.
   */
  rotateTileFor(playerId: PlayerId, index: unknown): boolean {
    if (this.phase !== 'playing' && this.phase !== 'intermission') return false;
    const player = this.players.get(playerId);
    if (!player || !isPlayerActive(player)) return false;

    const rt = this.runtimeFor(playerId);
    if (rt.rotateCooldown > 0) return false; // server-side anti-spam, silently ignored

    if (typeof index !== 'number' || !Number.isInteger(index)) return false;
    if (index < 0 || index >= player.weave.tiles.length) return false;

    if (!rotateWeaveTile(player.weave, index)) return false; // locked or invalid

    rt.rotateCooldown = WEAVE_ROTATE_COOLDOWN;
    this.refreshBoards(player);
    return true;
  }

  /**
   * A bot's input frame for this tick. Same buffer a socket writes into, so the
   * frame goes through `sanitizeInput`-equivalent constraints (the bot builds
   * legal frames) and through `stepWorld` exactly like a human's.
   */
  setBotInput(playerId: PlayerId, frame: InputFrame): void {
    if (!this.lobby.isBot(playerId)) return;
    const rt = this.runtime.get(playerId);
    if (!rt) return;
    rt.latest = frame;
    rt.ackSeq = frame.seq;
  }

  /** Free a bot's seat: entity, runtime and roster row. */
  releaseBotSeat(playerId: PlayerId): void {
    if (!this.lobby.isBot(playerId)) return;
    this.releasePlayer(playerId);
  }

  /**
   * Host-only lobby control, delivered over the chat channel so no new wire
   * message is needed: `/bot`, `/bot add [recruit|veteran|ace] [role]`,
   * `/bot remove`, `/bot clear`. Returns a line to echo back, or null if the
   * text was ordinary chat.
   */
  private handleBotCommand(client: Client, text: string): string | null {
    const parts = text.trim().toLowerCase().split(/\s+/);
    if (parts[0] !== '/bot' && parts[0] !== '/bots') return null;
    if (this.phase !== 'lobby' && this.phase !== 'loadout' && this.phase !== 'complete') {
      return 'Bots can only be changed between matches.';
    }
    if (!this.lobby.isHost(client.id)) return 'Only the host can change bots.';

    const verb = parts[1] ?? 'add';
    if (verb === 'remove' || verb === 'kick' || verb === '-') {
      const gone = this.bots.remove();
      if (!gone) return 'No bots to remove.';
      this.broadcastLobby();
      return `${gone.name} disconnected.`;
    }
    if (verb === 'clear' || verb === 'none') {
      if (this.bots.count === 0) return 'No bots to remove.';
      this.bots.removeAll();
      this.broadcastLobby();
      return 'All bots removed.';
    }
    if (verb !== 'add' && verb !== '+' && !isBotTier(verb) && !isRoleId(verb)) {
      return 'Usage: /bot add [recruit|veteran|ace] [role] · /bot remove · /bot clear';
    }

    const args = parts.slice(verb === 'add' || verb === '+' ? 2 : 1);
    const tier: BotTier = (args.find((a) => isBotTier(a)) as BotTier | undefined) ?? DEFAULT_BOT_TIER;
    const role = args.find((a) => isRoleId(a));
    const seat = this.bots.add(tier, isRoleId(role) ? role : undefined);
    if (!seat) return 'The lobby is full.';
    this.broadcastLobby();
    return `${seat.name} jacked in — ${String(seat.role).toUpperCase()} / ${tier.toUpperCase()}.`;
  }

  private onChat(client: Client, raw: unknown): void {
    const text = sanitizeChat(raw, CHAT_MAX_LEN);
    if (!text) return;

    // Bot control rides the chat channel: it is a lobby command, not a message,
    // so it bypasses the chat throttle and is never relayed to the room.
    if (text.startsWith('/')) {
      const reply = this.handleBotCommand(client, text);
      if (reply !== null) {
        client.send({ t: 'chat', from: '', name: 'SYSTEM', text: reply });
        return;
      }
    }

    if (!client.canChat()) return;
    this.broadcast({ t: 'chat', from: client.id, name: client.name, text });
  }

  // ======================================================================
  // Phase machine
  // ======================================================================

  tick(dt: number): void {
    if (this.closed) return;
    this.expireHeldPlayers();

    switch (this.phase) {
      case 'lobby':
        this.tickLobby();
        break;
      case 'loadout':
        this.tickLoadout(dt);
        break;
      case 'countdown':
        this.tickCountdown(dt);
        break;
      case 'playing':
      case 'intermission':
        this.tickMatch(dt);
        break;
      case 'complete':
        this.tickComplete(dt);
        break;
    }
  }

  /**
   * Everybody ready is the go signal. It is NOT a reason to route through the
   * loadout phase: `setReady` refuses without a valid build and any build change
   * clears the flag, so `allReady()` already implies every connected player is
   * locked in. There is nothing left for a loadout phase to collect — and going
   * through it anyway wiped the ready flags that had just triggered it, which is
   * exactly why a solo co-op lobby could never start.
   */
  private tickLobby(): void {
    if (this.lobby.allReady()) this.beginCountdown();
  }

  private beginLoadout(): void {
    this.lobby.clearUnbuiltReady();
    this.setPhase('loadout', LOADOUT_PHASE_SEC);
    this.lobby.countdown = 0;
    this.lastCountdownShown = -1;
    this.broadcastLobby();
  }

  private tickLoadout(dt: number): void {
    this.phaseTimer = Math.max(0, this.phaseTimer - dt);
    this.world.phaseTimer = this.phaseTimer;
    if (this.lobby.connectedCount < minPlayersFor(this.mode)) {
      // Someone left and we no longer have a match — fall back rather than
      // stranding the remaining player on a dead screen.
      this.setPhase('lobby', 0);
      this.lobby.resetReady();
      this.broadcastLobby();
      return;
    }
    if (this.lobby.allReady() || this.phaseTimer <= 0) this.beginCountdown();
  }

  private beginCountdown(): void {
    this.lobby.fillMissingBuilds();
    this.setPhase('countdown', COUNTDOWN_SEC);
    this.lobby.countdown = COUNTDOWN_SEC;
    this.lastCountdownShown = -1;
    this.broadcastLobby();
  }

  private tickCountdown(dt: number): void {
    this.phaseTimer = Math.max(0, this.phaseTimer - dt);
    this.world.phaseTimer = this.phaseTimer;
    this.lobby.countdown = this.phaseTimer;

    if (this.lobby.connectedCount < minPlayersFor(this.mode)) {
      this.setPhase('lobby', 0);
      this.lobby.countdown = 0;
      this.lobby.resetReady();
      this.broadcastLobby();
      return;
    }

    const shown = Math.ceil(this.phaseTimer);
    if (shown !== this.lastCountdownShown) {
      this.lastCountdownShown = shown;
      this.broadcastLobby();
    }
    if (this.phaseTimer <= 0) this.beginMatch();
  }

  private tickComplete(dt: number): void {
    this.phaseTimer = Math.max(0, this.phaseTimer - dt);
    this.world.phaseTimer = this.phaseTimer;
    if (this.phaseTimer <= 0) this.returnToLobby();
  }

  // ======================================================================
  // Match lifecycle
  // ======================================================================

  private beginMatch(): void {
    try {
      this.buildMatch();
    } catch (err) {
      console.error(`[room ${this.id}] failed to start match:`, err);
      this.broadcast({
        t: 'error',
        code: 'match_start_failed',
        message: 'The match could not be started. Returning to the lobby.',
      });
      this.returnToLobby();
    }
  }

  private buildMatch(): void {
    this.seedValue = randomInt(1, 0x7fffffff);
    this.rngFn = makeRngSafe(this.seedValue);
    this.nextEntityId = 1;
    this.weaveDriver = 'probing';
    this.probeTicks = 0;

    this.lobby.fillMissingBuilds();

    // Reset the world in place — `ctx.world` holds this exact reference.
    this.world.tick = 0;
    this.world.mode = this.mode;
    this.world.phaseTimer = 0;
    this.world.entities.length = 0;
    this.world.events.length = 0;
    this.world.objective = { label: '', progress: -1 };

    this.players.clear();

    const roster = this.lobby.list().filter((p) => p.connected);
    const boards: WeaveBoard[] = [];
    roster.forEach((lp, index) => {
      const entity = this.createPlayerEntity(lp, index);
      this.players.set(lp.playerId, entity);
      this.world.entities.push(entity);
      boards.push(entity.weave);

      const rt = this.runtimeFor(lp.playerId);
      rt.latest = null;
      rt.ackSeq = 0;
      rt.prevButtons = 0;
      rt.rotateCooldown = 0;
      rt.basicCooldown = 0;
      rt.weaveDirty = true;
      rt.lastWeaveTick = -WEAVE_SYNC_INTERVAL_TICKS;
      rt.lastSentChargeSum = -1;
      rt.disconnectedAt = 0;
      rt.respawnPending = false;
      rt.respawnPos = null;
      rt.slotConnected = entity.weave.slots.map((s) => s.connected);
      rt.stats = { damageDealt: 0, damageTaken: 0, slotsCharged: 0, revives: 0 };
    });

    // Co-op relay tiles mirror power between boards at matching coordinates.
    if (this.mode === 'coop_story' && boards.length > 1) {
      this.guard('linkRelays', () => linkRelays(boards));
    }

    this.handler = createModeHandler(this.mode, this.lobby.chapter);
    // Bots re-arm after the boards exist and before the first tick.
    this.guard('bots.onMatchStart', () => this.bots.onMatchStart());
    this.setPhase('playing', 0);
    this.matchStartMs = Date.now();

    this.guard('onMatchStart', () => this.handler.onMatchStart(this, this.ctx));

    // Spawn points are asked for after onMatchStart so the mode has had a
    // chance to lay out its arena / assign teams first.
    for (const entity of this.players.values()) {
      const spawn = this.safeSpawnPoint(entity);
      entity.pos = { x: spawn.x, y: spawn.y };
      entity.vel = { x: 0, y: 0 };
      recomputePower(entity.weave);
    }

    for (const [playerId, client] of this.clients) {
      const entity = this.players.get(playerId);
      if (!entity) continue;
      client.send({ t: 'matchStart', mode: this.mode, seed: this.seedValue, you: entity.id });
      client.send({ t: 'weave', board: entity.weave });
    }

    console.log(
      `[room ${this.id}] match start — ${this.mode}` +
        (this.mode === 'coop_story' ? ` ch.${this.lobby.chapter}` : '') +
        ` with ${roster.length} player(s), seed ${this.seedValue}`,
    );
  }

  private createPlayerEntity(lp: LobbyPlayer, index: number): PlayerEntity {
    const roleId: RoleId = lp.role ?? 'breaker';
    const role = this.safeRole(roleId);
    const requested = lp.loadout.length > 0 ? lp.loadout : safeDefaultLoadout(roleId);
    const loadout = safeValidateLoadout(roleId, requested);
    const maxHp = Math.max(1, Math.round(BASE_HP * (role.hpMul || 1)));

    const board = createBoard(role.weaveSize, loadout, this.boardSeed(lp.playerId));
    recomputePower(board);

    return {
      id: this.allocId(),
      kind: 'player',
      pos: { x: ARENA_W / 2, y: ARENA_H / 2 },
      vel: { x: 0, y: 0 },
      radius: PLAYER_RADIUS,
      team: this.mode === 'coop_story' ? 'players' : index % 2 === 0 ? 'a' : 'b',
      hp: maxHp,
      maxHp,
      angle: 0,
      statuses: [],
      dead: false,
      playerId: lp.playerId,
      name: lp.name,
      role: roleId,
      loadout,
      weave: board,
      shield: 0,
      dashCooldown: 0,
      dashing: 0,
      downed: false,
      downedTimer: 0,
      reviveProgress: 0,
      respawnTimer: 0,
      score: 0,
      kills: 0,
      deaths: 0,
      ping: this.clients.get(lp.playerId)?.ping ?? 0,
      connected: true,
    };
  }

  private endMatch(raw: MatchResult): void {
    const measured = Math.round(((Date.now() - this.matchStartMs) / 1000) * 10) / 10;
    const standings =
      Array.isArray(raw.standings) && raw.standings.length > 0 ? raw.standings : this.buildStandings();

    const result: MatchResult = {
      mode: this.mode,
      winner: typeof raw.winner === 'string' && raw.winner ? raw.winner : 'none',
      standings,
      chapter: raw.chapter ?? (this.mode === 'coop_story' ? this.lobby.chapter : undefined),
      chapterCleared: raw.chapterCleared,
      durationSec: raw.durationSec && raw.durationSec > 0 ? raw.durationSec : measured,
    };

    this.setPhase('complete', MATCH_COMPLETE_LINGER_SEC);
    this.broadcast({ t: 'matchEnd', result });
    this.broadcastLobby();
    console.log(`[room ${this.id}] match end — winner=${result.winner} in ${result.durationSec}s`);
  }

  private buildStandings(): MatchResult['standings'] {
    const rows = this.playerEntities().map((p) => {
      const st = this.statsFor(p.playerId);
      return {
        playerId: p.playerId,
        name: p.name,
        role: p.role,
        score: p.score,
        kills: p.kills,
        deaths: p.deaths,
        damageDealt: Math.round(st.damageDealt),
        damageTaken: Math.round(st.damageTaken),
        slotsCharged: st.slotsCharged,
        revives: st.revives,
      };
    });
    rows.sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);
    return rows;
  }

  private returnToLobby(): void {
    this.setPhase('lobby', 0);
    this.world.tick = 0;
    this.world.entities.length = 0;
    this.world.events.length = 0;
    this.world.objective = { label: '', progress: -1 };
    this.players.clear();
    this.handler = new NullModeHandler(this.mode);
    this.lobby.resetReady();
    this.lobby.countdown = 0;
    this.lastCountdownShown = -1;

    // Anyone still inside their reconnect window has nothing to reconnect to.
    for (const [playerId, rt] of [...this.runtime]) {
      if (rt.disconnectedAt > 0) this.releasePlayer(playerId);
      else {
        rt.latest = null;
        rt.ackSeq = 0;
        rt.prevButtons = 0;
        rt.weaveDirty = false;
      }
    }

    this.broadcastLobby();
  }

  /** Kick everyone and mark the room dead. Called on shutdown or reaping. */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.broadcast({ t: 'roomClosed', reason });
    for (const client of this.clients.values()) {
      if (client.roomId === this.id) client.roomId = null;
    }
    this.clients.clear();
    this.players.clear();
    this.runtime.clear();
    this.world.entities.length = 0;
    this.world.events.length = 0;
  }

  // ======================================================================
  // The match tick
  // ======================================================================

  private tickMatch(dt: number): void {
    const world = this.world;
    world.phase = this.phase;

    if (this.phaseTimer > 0) {
      this.phaseTimer = Math.max(0, this.phaseTimer - dt);
    }
    world.phaseTimer = this.phaseTimer;

    this.tickPlayerTimers(dt);
    this.notePendingRespawns();

    // Bots decide before inputs are gathered, so a decision lands this tick.
    this.guard('bots.think', () => this.bots.think(this.ctx, dt));

    const inputs = this.collectInputs();
    const chargeBefore = this.weaveDriver === 'probing' ? this.totalCharge() : 0;
    const tickBefore = world.tick;

    // `stepWorld` owns the tick counter and clears `world.events` on entry, so
    // nothing may be emitted before this line and expect to survive.
    this.guard('stepWorld', () => stepWorld(this.ctx, inputs, dt));
    if (world.tick === tickBefore) world.tick = tickBefore + 1;

    if (this.weaveDriver === 'probing') this.probeWeaveDriver(chargeBefore);
    if (this.weaveDriver === 'room') {
      this.advanceCharge(dt);
      this.resolveFireInputs();
    }

    this.guard('onTick', () => this.handler.onTick(this, this.ctx, dt));

    this.reclaimLostPlayers();
    this.placeRespawns();
    this.syncWeaveConnectivity();
    for (const playerId of drainBoardUpdates(this.handler)) this.markWeaveDirty(playerId);
    this.cullEntities();

    let result: MatchResult | null = null;
    this.guard('checkComplete', () => {
      result = this.handler.checkComplete(this, this.ctx);
    });

    this.broadcastSnapshot();
    this.flushWeaves();

    // Events live for exactly one snapshot. Anything not sent above is gone.
    world.events.length = 0;

    for (const rt of this.runtime.values()) {
      rt.prevButtons = rt.latest ? rt.latest.buttons : 0;
    }

    if (result) this.endMatch(result);
  }

  /**
   * `stepWorld` rebuilds `world.entities` when it culls. Player entities are
   * never supposed to be dropped — if one ever is, put it back rather than let
   * a live player silently vanish from every snapshot.
   */
  private reclaimLostPlayers(): void {
    if (this.players.size === 0) return;
    const entities = this.world.entities;
    for (const entity of this.players.values()) {
      if (entity.dead) continue;
      if (entities.indexOf(entity) < 0) entities.push(entity);
    }
  }

  private tickPlayerTimers(dt: number): void {
    for (const [playerId, entity] of this.players) {
      const rt = this.runtimeFor(playerId);
      if (rt.rotateCooldown > 0) rt.rotateCooldown = Math.max(0, rt.rotateCooldown - dt);
      if (rt.basicCooldown > 0) rt.basicCooldown = Math.max(0, rt.basicCooldown - dt);
      const client = this.clients.get(playerId);
      if (client) entity.ping = client.ping;
    }
  }

  private collectInputs(): Map<PlayerId, InputFrame> {
    const inputs = new Map<PlayerId, InputFrame>();
    for (const [playerId, rt] of this.runtime) {
      const entity = this.players.get(playerId);
      if (!entity || !entity.connected) continue;
      if (rt.latest) inputs.set(playerId, rt.latest);
    }
    return inputs;
  }

  // ---------------------------------------------------------------- weave

  private totalCharge(): number {
    let sum = 0;
    for (const p of this.players.values()) {
      for (const slot of p.weave.slots) sum += slot.charge;
    }
    return sum;
  }

  private probeWeaveDriver(before: number): void {
    if (Math.abs(this.totalCharge() - before) > 1e-6) {
      this.weaveDriver = 'sim';
      return;
    }
    if (!this.anySlotChargeable()) return;
    this.probeTicks += 1;
    if (this.probeTicks >= Math.ceil(TICK_RATE / 2)) {
      this.weaveDriver = 'room';
      console.log(
        `[room ${this.id}] stepWorld is not advancing weave charge — room is driving charge and slot firing`,
      );
    }
  }

  private anySlotChargeable(): boolean {
    for (const p of this.players.values()) {
      if (!isPlayerActive(p)) continue;
      for (let i = 0; i < p.weave.slots.length; i += 1) {
        const slot = p.weave.slots[i];
        if (!slot.connected) continue;
        const ability = abilityOf(p.loadout[i]);
        const cap = ability ? ability.cost * 2 : 2;
        if (slot.charge < cap) return true;
      }
    }
    return false;
  }

  private advanceCharge(dt: number): void {
    for (const [playerId, entity] of this.players) {
      if (!isPlayerActive(entity)) continue;
      const rt = this.runtimeFor(playerId);
      const role = this.safeRole(entity.role);
      const costs = entity.loadout.map((id) => abilityOf(id)?.cost ?? 1);
      const mul = (role.chargeRateMul || 1) * overclockMul(entity);

      let charged: number[] = [];
      this.guard('updateCharge', () => {
        charged = updateCharge(entity.weave, dt, mul, costs) ?? [];
      });

      for (const slot of charged) {
        this.emit({ t: 'slotCharged', player: playerId, slot });
        rt.stats.slotsCharged += 1;
        rt.weaveDirty = true;
      }
    }
  }

  private resolveFireInputs(): void {
    for (const [playerId, entity] of this.players) {
      if (!isPlayerActive(entity)) continue;
      const rt = this.runtimeFor(playerId);
      const input = rt.latest;
      if (!input) continue;
      if (hasStatus(entity, 'stun')) continue;

      const pressed = input.buttons & ~rt.prevButtons;

      for (let slot = 0; slot < ABILITY_SLOTS; slot += 1) {
        if ((pressed & (ActionBit.Fire1 << slot)) === 0) continue;
        const ability = abilityOf(entity.loadout[slot]);
        if (!ability) continue;
        if (!canFire(entity.weave, slot, ability)) continue;
        const overcharge = consumeCharge(entity.weave, slot, ability);
        this.guard('fireAbility', () => {
          fireAbility(this.ctx, entity, ability, input.aim, overcharge || 1);
        });
        rt.weaveDirty = true;
      }

      if ((input.buttons & ActionBit.Basic) !== 0 && rt.basicCooldown <= 0) {
        const role = this.safeRole(entity.role);
        const basic = abilityOf(role.basicAttack);
        if (basic) {
          this.guard('fireAbility(basic)', () => {
            fireAbility(this.ctx, entity, basic, input.aim, 1);
          });
          rt.basicCooldown = BASIC_ATTACK_COOLDOWN;
        }
      }
    }
  }

  /** Emit `weavePower` when a slot connects or drops, and dirty the board. */
  private syncWeaveConnectivity(): void {
    for (const [playerId, entity] of this.players) {
      const rt = this.runtimeFor(playerId);
      const slots = entity.weave.slots;
      if (rt.slotConnected.length !== slots.length) {
        rt.slotConnected = slots.map((s) => s.connected);
        rt.weaveDirty = true;
        continue;
      }
      for (let i = 0; i < slots.length; i += 1) {
        if (slots[i].connected === rt.slotConnected[i]) continue;
        rt.slotConnected[i] = slots[i].connected;
        rt.weaveDirty = true;
        this.emit({ t: 'weavePower', player: playerId, connected: slots[i].connected, slot: i });
      }
    }
  }

  /**
   * Recompute power after a board mutation. In co-op every board is recomputed
   * because `relay` tiles share power across players, so one rotation can light
   * up somebody else's circuit.
   */
  private refreshBoards(changed: PlayerEntity): void {
    if (this.mode === 'coop_story' && this.players.size > 1) {
      for (const [playerId, entity] of this.players) {
        recomputePower(entity.weave);
        this.runtimeFor(playerId).weaveDirty = true;
      }
      return;
    }
    recomputePower(changed.weave);
    this.runtimeFor(changed.playerId).weaveDirty = true;
  }

  /**
   * Push full boards to their owners. A board goes out when it structurally
   * changed, and otherwise at most every WEAVE_SYNC_INTERVAL_TICKS and only if
   * some charge actually moved — never 20 boards a second.
   */
  private flushWeaves(): void {
    const tick = this.world.tick;
    for (const [playerId, rt] of this.runtime) {
      const entity = this.players.get(playerId);
      if (!entity) continue;
      const client = this.clients.get(playerId);
      if (!client) continue;

      let chargeSum = 0;
      for (const slot of entity.weave.slots) chargeSum += slot.charge;
      const chargeMoved = Math.abs(chargeSum - rt.lastSentChargeSum) > 1e-4;
      const dueForResync = tick - rt.lastWeaveTick >= WEAVE_SYNC_INTERVAL_TICKS;

      if (!rt.weaveDirty && !(dueForResync && chargeMoved)) continue;

      client.send({ t: 'weave', board: entity.weave });
      rt.weaveDirty = false;
      rt.lastWeaveTick = tick;
      rt.lastSentChargeSum = chargeSum;
    }
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Remember who is mid-respawn before the sim runs. `shared/sim.ts` owns the
   * respawn timer and stands the player back up where they fell; the room's job
   * is to then move them to the mode's chosen spawn point.
   */
  private notePendingRespawns(): void {
    for (const [playerId, entity] of this.players) {
      const rt = this.runtimeFor(playerId);
      if (entity.respawnTimer > 0) {
        rt.respawnPending = true;
        rt.respawnPos = { x: entity.pos.x, y: entity.pos.y };
      } else if (!rt.respawnPending) {
        rt.respawnPos = null;
      }
    }
  }

  /** Relocate anyone the sim just revived, unless the mode already moved them. */
  private placeRespawns(): void {
    for (const [playerId, entity] of this.players) {
      const rt = this.runtimeFor(playerId);
      if (!rt.respawnPending) continue;
      if (entity.respawnTimer > 0 || entity.downed || entity.hp <= 0) continue;

      rt.respawnPending = false;
      const fell = rt.respawnPos;
      rt.respawnPos = null;

      const unmoved =
        !fell || (Math.abs(fell.x - entity.pos.x) < 0.01 && Math.abs(fell.y - entity.pos.y) < 0.01);
      if (unmoved) {
        const spawn = this.safeSpawnPoint(entity);
        entity.pos = { x: spawn.x, y: spawn.y };
        entity.vel = { x: 0, y: 0 };
      }

      recomputePower(entity.weave);
      this.markWeaveDirty(playerId);
    }
  }

  private safeSpawnPoint(entity: PlayerEntity): Vec2 {
    let point: Vec2 = { x: ARENA_W / 2, y: ARENA_H / 2 };
    this.guard('spawnPoint', () => {
      const p = this.handler.spawnPoint(this, entity);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) point = p;
    });
    return clampToArena(point);
  }

  /** Drop dead non-player entities. Player entities always persist. */
  private cullEntities(): void {
    const entities = this.world.entities;
    let write = 0;
    for (let read = 0; read < entities.length; read += 1) {
      const e = entities[read];
      if (e.kind !== 'player' && e.dead) continue;
      entities[write] = e;
      write += 1;
    }
    entities.length = write;

    if (entities.length > MAX_ENTITIES) {
      console.warn(`[room ${this.id}] entity cap hit (${entities.length}); trimming`);
      const keep = entities.filter((e) => e.kind === 'player');
      const rest = entities.filter((e) => e.kind !== 'player').slice(-(MAX_ENTITIES - keep.length));
      entities.length = 0;
      entities.push(...keep, ...rest);
    }
  }

  private expireHeldPlayers(): void {
    if (this.runtime.size === 0) return;
    const cutoff = Date.now() - RECONNECT_GRACE_SEC * 1000;
    let changed = false;
    for (const [playerId, rt] of [...this.runtime]) {
      if (rt.disconnectedAt === 0 || rt.disconnectedAt > cutoff) continue;
      this.releasePlayer(playerId);
      changed = true;
    }
    if (changed) {
      this.broadcastLobby();
      this.maybeAbortForEmptyMatch();
    }
  }

  // ======================================================================
  // Broadcast
  // ======================================================================

  broadcast(msg: ServerMsg): void {
    const json = encode(msg);
    for (const client of this.clients.values()) client.sendRaw(json);
  }

  broadcastLobby(): void {
    this.broadcast({ t: 'lobby', state: this.lobbyState() });
  }

  /** Authoritative state to one socket. Used to answer a refused/no-op change. */
  private sendLobbyTo(client: Client): void {
    client.send({ t: 'lobby', state: this.lobbyState() });
  }

  lobbyState() {
    this.lobby.countdown = this.phase === 'countdown' ? this.phaseTimer : 0;
    return this.lobby.state(this.id);
  }

  /**
   * One snapshot object, serialized once, spliced into a per-client envelope so
   * every player gets their own `ackSeq` without re-stringifying the world.
   * Weave grids are stripped: boards are private and are the single largest
   * thing in the payload. Slot charge stays so the HUD gauges track at 20 Hz.
   */
  private broadcastSnapshot(): void {
    const world = this.world;
    const entities = new Array<Entity>(world.entities.length);
    for (let i = 0; i < world.entities.length; i += 1) {
      const e = world.entities[i];
      entities[i] = e.kind === 'player' ? stripBoard(e) : e;
    }

    const payload: WorldState = {
      tick: world.tick,
      mode: world.mode,
      phase: world.phase,
      phaseTimer: Math.round(world.phaseTimer * 100) / 100,
      entities,
      objective: world.objective,
      events: world.events,
    };

    const worldJson = JSON.stringify(payload);
    const serverTime = Date.now();
    for (const [playerId, client] of this.clients) {
      const ackSeq = this.runtime.get(playerId)?.ackSeq ?? 0;
      client.sendRaw(
        `{"t":"snapshot","world":${worldJson},"ackSeq":${ackSeq},"serverTime":${serverTime}}`,
      );
    }
  }

  // ======================================================================
  // Internals
  // ======================================================================

  private runtimeFor(playerId: PlayerId): PlayerRuntime {
    let rt = this.runtime.get(playerId);
    if (!rt) {
      rt = {
        latest: null,
        ackSeq: 0,
        prevButtons: 0,
        rotateCooldown: 0,
        basicCooldown: 0,
        weaveDirty: false,
        lastWeaveTick: -WEAVE_SYNC_INTERVAL_TICKS,
        lastSentChargeSum: -1,
        slotConnected: [],
        respawnPending: false,
        respawnPos: null,
        disconnectedAt: 0,
        stats: { damageDealt: 0, damageTaken: 0, slotsCharged: 0, revives: 0 },
      };
      this.runtime.set(playerId, rt);
    }
    return rt;
  }

  private statsFor(playerId: PlayerId): MatchStats {
    return this.runtimeFor(playerId).stats;
  }

  private recordDamage(target: Entity, amount: number, source: Entity | null): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    if (target.kind === 'player') this.statsFor(target.playerId).damageTaken += amount;
    const attacker = this.resolvePlayerSource(source);
    if (attacker && attacker !== target) this.statsFor(attacker.playerId).damageDealt += amount;
  }

  /** Follow a projectile/zone back to the player who launched it. */
  private resolvePlayerSource(source: Entity | null): PlayerEntity | null {
    if (!source) return null;
    if (source.kind === 'player') return source;
    if (source.kind === 'projectile' || source.kind === 'zone') {
      for (const p of this.players.values()) if (p.id === source.owner) return p;
    }
    return null;
  }

  private safeRole(id: RoleId): RoleDef {
    try {
      const role = getRole(id);
      if (role) return role;
    } catch {
      /* fall through */
    }
    return FALLBACK_ROLE;
  }

  private boardSeed(playerId: PlayerId): number {
    return (this.seedValue ^ hashString(playerId)) >>> 0 || 1;
  }

  private seedFromRng(): number {
    return (Math.floor(this.rngFn() * 0xffffffff) >>> 0) || 1;
  }

  /** Run mode/sim code without letting a throw take down the tick loop. */
  private guard(label: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error(`[room ${this.id}] ${label} threw:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// helpers

/**
 * Snapshot view of a player: same object, minus the weave grid. Slots are kept
 * by reference (three tiny objects) so the client can drive charge gauges.
 */
function stripBoard(player: PlayerEntity): PlayerEntity {
  return {
    ...player,
    weave: {
      size: player.weave.size,
      tiles: NO_TILES,
      slots: player.weave.slots,
      coreIndex: player.weave.coreIndex,
    },
  };
}

function abilityOf(id: AbilityId | undefined): AbilityDef | null {
  if (!id) return null;
  try {
    return getAbility(id) ?? null;
  } catch {
    return null;
  }
}

function safeDefaultLoadout(role: RoleId): AbilityId[] {
  try {
    return defaultLoadout(role) ?? [];
  } catch {
    return [];
  }
}

function safeValidateLoadout(role: RoleId, loadout: AbilityId[]): AbilityId[] {
  try {
    const clean = validateLoadout(role, loadout);
    if (Array.isArray(clean)) return clean;
  } catch {
    /* fall through */
  }
  return loadout.slice(0, ABILITY_SLOTS);
}

/**
 * A player is "active" when they can act on their board and their abilities.
 * Note `dead` is never set on players by `shared/combat.ts` — being out of the
 * fight shows up as hp<=0 plus a respawn timer, or as `downed` in co-op.
 */
function isPlayerActive(p: PlayerEntity): boolean {
  return p.connected && !p.dead && !p.downed && p.hp > 0 && p.respawnTimer <= 0;
}

function hasStatus(entity: Entity, kind: StatusKind): boolean {
  for (const s of entity.statuses) if (s.kind === kind && s.remaining > 0) return true;
  return false;
}

/** Overclock stacks multiplicatively on top of the role's charge rate. */
function overclockMul(entity: Entity): number {
  let best = 0;
  for (const s of entity.statuses) {
    if (s.kind === 'overclock' && s.remaining > 0 && s.magnitude > best) best = s.magnitude;
  }
  return 1 + Math.max(0, best);
}

function makeRngSafe(seed: number): () => number {
  try {
    const rng = makeRng(seed);
    if (typeof rng === 'function') return rng;
  } catch {
    /* fall through */
  }
  // mulberry32, identical to math.ts — only reached if math.ts is missing.
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Only used if roles.ts is unavailable, so the server can still hold a lobby. */
const FALLBACK_ROLE: RoleDef = {
  id: 'breaker',
  name: 'Breaker',
  tagline: 'Heavy ordnance.',
  hpMul: 1,
  speedMul: 1,
  damageMul: 1,
  weaveSize: 5,
  chargeRateMul: 1,
  abilityPool: [],
  basicAttack: 'basic_breaker',
  color: '#ff5a3c',
};

/**
 * Never trust an `InputFrame`. Clamp the move vector to the unit disc, keep the
 * aim point inside a sane envelope, mask the buttons to the six real actions.
 */
function sanitizeInput(raw: unknown): InputFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Partial<InputFrame>;

  const seq = Math.floor(numberOr(f.seq, -1));
  if (!Number.isFinite(seq) || seq < 0) return null;

  const move = { x: numberOr(f.move?.x, 0), y: numberOr(f.move?.y, 0) };
  const mag = Math.hypot(move.x, move.y);
  if (mag > 1) {
    move.x /= mag;
    move.y /= mag;
  }

  const aim = {
    x: clampNumber(numberOr(f.aim?.x, 0), -ARENA_W, ARENA_W * 2),
    y: clampNumber(numberOr(f.aim?.y, 0), -ARENA_H, ARENA_H * 2),
  };

  return {
    seq,
    move,
    aim,
    buttons: Math.trunc(numberOr(f.buttons, 0)) & 0x3f,
    ts: numberOr(f.ts, 0),
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampNumber(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
