/**
 * BLOOM — a room. One lobby, then one match, then back to the lobby.
 *
 * The room is the authority. It owns a `Garden` (the shared simulation), feeds it
 * only taps it has verified came from the seat that sent them, and ships the whole
 * resulting state to every client at SNAPSHOT_RATE. A client cannot author an
 * outcome here — the worst a hostile one can do is ask for something illegal and be
 * told no.
 *
 * Three things in here exist purely to keep a real match playable over a real
 * network, and none of them are optional:
 *
 *  - PLANTS ARE DRAFTED, NOT PRE-PICKED. The board is generated first and shown to
 *    everyone, and only then does anyone choose. Maps are deliberately unfair, so
 *    reading your own spawn — walled in, wide open, a sun in reach — is the whole
 *    decision. Two people may draft the same plant; gardens are told apart by seat
 *    colour, not by faction.
 *  - A DROPPED PLAYER KEEPS THEIR SEAT for RECONNECT_GRACE_SEC. Their garden keeps
 *    growing and their tiles keep feeding; phones lose Wi-Fi mid-match and losing
 *    the whole game to a tunnel is not a rule anybody accepts.
 *  - A MATCH WITH NO HUMANS LEFT ENDS. Otherwise an abandoned room ticks a full
 *    simulation forever.
 */

import {
  CHAT_MAX_LEN,
  COUNTDOWN_SEC,
  MATCH_COMPLETE_LINGER_SEC,
  RECONNECT_GRACE_SEC,
} from '@shared/constants.js';
import type { GameMode, MatchPhase, PlayerId, RoleId, RoomId, TechId } from '@shared/bloom.js';
import { TECHS } from '@shared/bloom.js';
import { Garden } from '@shared/garden.js';
import type { GardenSeat } from '@shared/garden.js';
import { ROLE_IDS } from '@shared/rules.js';
import { encode } from '@shared/protocol.js';
import type {
  ClientMsg,
  LobbyPlayer,
  LobbyState,
  MatchEndReason,
  MatchResult,
  ServerMsg,
} from '@shared/protocol.js';

import { sanitizeChat } from './net.js';
import type { Client } from './net.js';

export interface RoomOptions {
  level?: number;
  isPublic?: boolean;
}

/** Hard ceiling: the board is cut with five seedling positions. */
export const MAX_SEATS = 5;

/** Bodies needed to start, and the cap, per mode. */
const MODE_LIMITS: Record<GameMode, { min: number; max: number }> = {
  duel: { min: 2, max: 2 },
  garden: { min: 2, max: MAX_SEATS },
  // No Blight simulation exists yet; `index.ts` refuses to create one of these.
  coop_blight: { min: 1, max: MAX_SEATS },
};

/** Names for AI gardeners, in the order they are seated. */
const BOT_NAMES = ['IVY', 'FERN', 'BURR', 'HUSK'];

/**
 * One participant, human or machine.
 *
 * Deliberately separate from `Client`: a member outlives their socket. That is the
 * whole mechanism behind reconnect — the member (and their seat, and their
 * territory) stays in the room while the socket is gone.
 */
interface Member {
  playerId: PlayerId;
  name: string;
  role: RoleId | null;
  ready: boolean;
  isBot: boolean;
  /** Seat index once the match starts, or -1 while in the lobby. */
  seat: number;
  /** null when the socket is gone but the seat is still being held. */
  client: Client | null;
  /** When the hold expires, as epoch ms. 0 when connected. */
  holdUntil: number;
}

/** Running totals for the result card. Accumulated from simulation events. */
interface Tally {
  peakTiles: number;
  claimed: number;
  captured: number;
  /** Enemy tiles that withered because THIS seat made the cut. The real score. */
  severed: number;
}

export class Room {
  readonly id: RoomId;
  readonly mode: GameMode;
  readonly createdAt = Date.now();

  isPublic: boolean;
  level: number;
  closed = false;
  /** Epoch ms since the last socket left, or 0 while anyone is attached. */
  emptySince = 0;

  phase: MatchPhase = 'lobby';

  /** Live sockets by player id. `matchmaking` reads `.size` and `.has()`. */
  readonly clients = new Map<PlayerId, Client>();

  /** Wired by `Matchmaking` so a dropped player can be found again. */
  onPlayerHeld: ((room: Room, playerId: PlayerId, graceMs: number, token: string) => void) | null =
    null;
  onPlayerReleased: ((room: Room, playerId: PlayerId) => void) | null = null;

  private members: Member[] = [];
  private host: PlayerId | null = null;
  private garden: Garden | null = null;
  private seed = 0;
  private countdown = 0;
  private linger = 0;
  private elapsed = 0;
  private tally: Tally[] = [];
  private nextBot = 0;
  /** Set once per match so a result is never announced twice. */
  private ended = false;

  constructor(id: RoomId, mode: GameMode, opts: RoomOptions = {}) {
    this.id = id;
    this.mode = mode;
    this.isPublic = opts.isPublic ?? false;
    this.level = opts.level ?? 1;
  }

  // ================================================================ inventory

  private get limits(): { min: number; max: number } {
    return MODE_LIMITS[this.mode];
  }

  /** Members holding a seat, bots included. */
  private get seated(): Member[] {
    return this.members;
  }

  private get humans(): Member[] {
    return this.members.filter((m) => !m.isBot);
  }

  /** Humans with a live socket right now. */
  private get present(): Member[] {
    return this.members.filter((m) => !m.isBot && m.client);
  }

  isJoinable(): boolean {
    if (this.closed) return false;
    if (this.members.length >= this.limits.max) return false;
    // A match in progress is joinable only by someone reclaiming a held seat.
    return this.phase === 'lobby';
  }

  private find(playerId: PlayerId): Member | undefined {
    return this.members.find((m) => m.playerId === playerId);
  }

  // ================================================================ join / leave

  /**
   * Attach a client. Handles three different arrivals through one door:
   * a new player, a reconnecting player reclaiming a held seat, and a duplicate
   * socket for a member who is already here.
   */
  join(client: Client): boolean {
    if (this.closed) return false;

    const existing = this.find(client.id);
    if (existing) {
      // Reclaiming a held seat, or just a second socket for the same identity.
      existing.client = client;
      existing.holdUntil = 0;
      existing.name = client.name;
      this.attach(client);
      this.onPlayerReleased?.(this, existing.playerId);
      if (this.phase === 'playing' || this.phase === 'countdown' || this.phase === 'draft') this.sendMatchStart(existing);
      else this.broadcastLobby();
      return true;
    }

    if (!this.isJoinable()) return false;

    const member: Member = {
      playerId: client.id,
      name: client.name,
      // Chosen in the draft, once there is a map to choose against.
      role: null,
      ready: false,
      isBot: false,
      seat: -1,
      client,
      holdUntil: 0,
    };
    this.members.push(member);
    this.attach(client);
    if (!this.host) this.host = member.playerId;
    this.broadcastLobby();
    return true;
  }

  private attach(client: Client): void {
    client.roomId = this.id;
    this.clients.set(client.id, client);
    this.emptySince = 0;
  }

  /**
   * Detach a client. `hold` keeps their seat warm for the reconnect grace window;
   * an explicit departure never holds.
   */
  leave(client: Client, hold: boolean): void {
    const member = this.find(client.id);
    if (this.clients.get(client.id) === client) this.clients.delete(client.id);
    if (client.roomId === this.id) client.roomId = null;
    if (!member) return;

    const mid_match = this.phase === 'playing' || this.phase === 'countdown' || this.phase === 'draft';
    if (hold && mid_match) {
      member.client = null;
      member.holdUntil = Date.now() + RECONNECT_GRACE_SEC * 1000;
      // The garden keeps growing without them — mark the seat so the HUD can say so.
      const seat = this.garden?.state.seats[member.seat];
      if (seat) seat.connected = false;
      this.onPlayerHeld?.(this, member.playerId, RECONNECT_GRACE_SEC * 1000, client.reconnectToken);
    } else {
      this.remove(member);
    }

    if (this.clients.size === 0) this.emptySince = Date.now();
    if (!mid_match) this.broadcastLobby();
  }

  private remove(member: Member): void {
    this.members = this.members.filter((m) => m !== member);
    this.onPlayerReleased?.(this, member.playerId);
    /*
     * A seat that leaves mid-match is not deleted from the simulation — the seat
     * indices are woven through the board (every cell stores an owner index), so
     * removing one would silently re-colour somebody else's territory.
     *
     * Instead the machine takes the chair over. Left alone, an abandoned garden is
     * a statue: it never grows, never attacks, and never dies, so a duel where one
     * person quits leaves the other grinding down scenery until the territory clock
     * runs out. Handing the seat to the bot driver keeps it a game that can be won.
     */
    const seat = this.garden?.state.seats[member.seat];
    if (seat) {
      seat.connected = false;
      seat.isBot = true;
    }
    if (this.host === member.playerId) {
      this.host = this.humans.find((m) => m.client)?.playerId ?? null;
    }
  }

  // ================================================================ lobby

  private lobbyState(): LobbyState {
    const players: LobbyPlayer[] = this.members.map((m) => ({
      playerId: m.playerId,
      name: m.name,
      role: m.role,
      ready: m.isBot ? true : m.ready,
      connected: m.isBot ? true : !!m.client,
      ...(m.isBot ? { isBot: true } : {}),
    }));
    return {
      roomId: this.id,
      mode: this.mode,
      host: this.host ?? '',
      players,
      level: this.level,
      maxPlayers: this.limits.max,
      countdown: Math.max(0, Math.ceil(this.countdown)),
    };
  }

  private broadcastLobby(): void {
    if (this.closed) return;
    this.broadcast({ t: 'lobby', state: this.lobbyState() });
  }

  private addBot(): boolean {
    if (this.members.length >= this.limits.max) return false;
    this.members.push({
      playerId: `bot_${this.id}_${this.nextBot}`,
      name: BOT_NAMES[this.nextBot % BOT_NAMES.length],
      // Bots draft too — they are handed a free plant the moment the draft opens.
      role: null,
      ready: true,
      isBot: true,
      seat: -1,
      client: null,
      holdUntil: 0,
    });
    this.nextBot += 1;
    return true;
  }

  private removeBot(): boolean {
    for (let i = this.members.length - 1; i >= 0; i -= 1) {
      if (this.members[i].isBot) {
        this.members.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  // ================================================================ match

  private canStart(): boolean {
    return this.members.length >= this.limits.min && this.present.length >= 1;
  }

  private startCountdown(): void {
    if (this.phase !== 'lobby' || !this.canStart()) return;
    this.phase = 'countdown';
    this.countdown = COUNTDOWN_SEC;
    this.broadcastLobby();
  }

  /**
   * Cut the map and open the draft.
   *
   * The board has to exist before anybody picks — that is the entire point. Humans
   * get DRAFT_SEC to look at where they landed and choose; the bots take whatever is
   * left over when the draft closes, so a human is never down to one option.
   */
  private beginMatch(): void {
    // Seat everyone in join order; the seat index is fixed for the whole match.
    const specs: GardenSeat[] = [];
    this.members.forEach((m, i) => {
      m.seat = i;
      specs.push({ playerId: m.playerId, name: m.name, role: null, isBot: m.isBot });
    });

    this.seed = (Math.random() * 1e9) | 0;
    const garden = new Garden({ mode: this.mode, seats: specs, seed: this.seed });
    this.garden = garden;
    this.tally = specs.map(() => ({ peakTiles: 1, claimed: 0, captured: 0, severed: 0 }));
    this.phase = 'draft';
    this.elapsed = 0;
    this.ended = false;

    for (const m of this.members) if (m.client) this.sendMatchStart(m);
  }

  private sendMatchStart(member: Member): void {
    member.client?.send({
      t: 'matchStart',
      mode: this.mode,
      seed: this.seed,
      seat: member.seat,
      level: this.level,
    });
    // Follow it immediately with the current board so a reconnecting player is not
    // looking at nothing until the next snapshot lands.
    const state = this.garden?.state;
    if (state) member.client?.send({ t: 'match', state });
  }

  // ================================================================ tick

  tick(dt: number): void {
    if (this.closed) return;

    // Expire held seats whose owner never came back.
    const now = Date.now();
    for (const m of [...this.members]) {
      if (m.isBot || m.client || m.holdUntil === 0) continue;
      if (now >= m.holdUntil) this.remove(m);
    }

    switch (this.phase) {
      case 'lobby': {
        // Auto-start the moment the room is full-enough and everyone has readied.
        const all = this.members.length > 0 && this.members.every((m) => m.isBot || m.ready);
        if (all && this.canStart()) this.startCountdown();
        return;
      }

      case 'countdown': {
        if (!this.canStart()) {
          // Somebody left during the "3.. 2.. 1"; fall back rather than start a
          // match that cannot legally exist.
          this.phase = 'lobby';
          this.countdown = 0;
          this.broadcastLobby();
          return;
        }
        const before = Math.ceil(this.countdown);
        this.countdown -= dt;
        if (this.countdown <= 0) {
          this.beginMatch();
          return;
        }
        if (Math.ceil(this.countdown) !== before) this.broadcastLobby();
        return;
      }

      case 'draft': {
        const garden = this.garden;
        if (!garden) {
          this.phase = 'lobby';
          return;
        }
        garden.stepDraft(dt);
        // Nobody left to choose? Do not sit on a countdown for an empty room.
        if (this.present.length === 0) {
          this.finish('abandoned');
          return;
        }
        // Every human has picked — no reason to make the room wait out the clock.
        if (this.members.every((m) => m.isBot || m.role)) garden.beginPlay();
        this.broadcast({ t: 'match', state: garden.state });
        if (garden.state.phase === 'playing') {
          this.phase = 'playing';
          // `beginPlay` deals the leftovers to the bots; mirror that onto the roster.
          for (const m of this.members) m.role = garden.state.seats[m.seat]?.role ?? null;
          this.broadcastPacts();
        }
        return;
      }

      case 'playing': {
        const garden = this.garden;
        if (!garden) {
          this.phase = 'lobby';
          return;
        }
        this.elapsed += dt;
        garden.step(dt);
        this.recordEvents(garden);

        // Every human walked out. Do not tick a simulation nobody is watching.
        if (this.present.length === 0 && this.humans.every((m) => !m.client)) {
          this.finish('abandoned');
          return;
        }

        this.broadcast({ t: 'match', state: garden.state });

        if (garden.state.phase === 'complete') {
          const win = garden.state.events.find((e) => e.t === 'win');
          this.finish(win && win.t === 'win' ? win.reason : 'none');
        }
        return;
      }

      case 'complete': {
        this.linger -= dt;
        if (this.linger <= 0) this.resetToLobby();
        return;
      }
    }
  }

  /**
   * Fold this tick's simulation events into the per-seat tallies.
   *
   * `severed` is credited to the seat that MADE the cut, which is why the event
   * carries `by`: the number that matters in BLOOM is how much of someone else's
   * garden you killed without ever touching it.
   */
  private recordEvents(garden: Garden): void {
    for (const ev of garden.state.events) {
      switch (ev.t) {
        case 'claimed':
          if (this.tally[ev.seat]) this.tally[ev.seat].claimed += 1;
          break;
        case 'captured':
          if (this.tally[ev.seat]) this.tally[ev.seat].captured += 1;
          break;
        case 'bite':
          if (this.tally[ev.seat]) this.tally[ev.seat].captured += 1;
          break;
        case 'severed':
          if (ev.by >= 0 && this.tally[ev.by]) this.tally[ev.by].severed += ev.count;
          break;
        default:
          break;
      }
    }
    for (const seat of garden.state.seats) {
      const t = this.tally[seat.seat];
      if (t && seat.tiles > t.peakTiles) t.peakTiles = seat.tiles;
    }
  }

  private finish(reason: MatchEndReason): void {
    if (this.ended) return;
    this.ended = true;
    const garden = this.garden;
    this.phase = 'complete';
    this.linger = MATCH_COMPLETE_LINGER_SEC;
    if (!garden) return;

    garden.state.phase = 'complete';
    const seats = [...garden.state.seats].sort((a, b) => b.tiles - a.tiles);
    const alive = garden.state.seats.filter((s) => s.alive);
    const winnerSeat =
      reason === 'abandoned' || reason === 'none'
        ? -1
        : alive.length === 1
          ? alive[0].seat
          : (seats[0]?.seat ?? -1);

    const result: MatchResult = {
      mode: this.mode,
      winner: winnerSeat >= 0 ? String(winnerSeat) : 'none',
      winnerSeat,
      reason,
      standings: seats.map((s) => ({
        seat: s.seat,
        playerId: s.playerId,
        name: s.name,
        role: s.role ?? 'vine',
        tiles: s.tiles,
        peakTiles: this.tally[s.seat]?.peakTiles ?? s.tiles,
        claimed: this.tally[s.seat]?.claimed ?? 0,
        captured: this.tally[s.seat]?.captured ?? 0,
        severed: this.tally[s.seat]?.severed ?? 0,
        isBot: s.isBot,
      })),
      durationSec: Math.round(this.elapsed),
    };
    this.broadcast({ t: 'matchEnd', result });
  }

  /** Back to the lobby, ready to play again with the same people. */
  private resetToLobby(): void {
    this.phase = 'lobby';
    this.garden = null;
    this.countdown = 0;
    this.ended = false;
    for (const m of this.members) {
      m.seat = -1;
      m.ready = false;
    }
    // Anyone still merely "held" at this point is not coming back.
    for (const m of [...this.members]) if (!m.isBot && !m.client) this.remove(m);
    this.broadcastLobby();
  }

  // ================================================================ messages

  handle(client: Client, msg: ClientMsg): void {
    const member = this.find(client.id);
    if (!member) return;

    switch (msg.t) {
      case 'ping':
        client.send({ t: 'pong', ts: msg.ts, serverTime: Date.now() });
        return;

      case 'chooseRole': {
        // Plants are drafted after the map is revealed, never before it exists.
        if (this.phase !== 'draft' || !this.garden) {
          client.error('not_drafting', 'You choose your plant once the garden is dealt.');
          return;
        }
        if (!isRoleId(msg.role)) {
          client.error('bad_role', 'Unknown plant.');
          return;
        }
        if (member.seat < 0) return;
        // Duplicates are fine — nothing is reserved, so this only fails out of phase.
        if (!this.garden.setRole(member.seat, msg.role)) return;
        member.role = msg.role;
        this.broadcast({ t: 'match', state: this.garden.state });
        return;
      }

      case 'setReady': {
        if (this.phase !== 'lobby') return;
        member.ready = msg.ready === true;
        this.broadcastLobby();
        return;
      }

      case 'setLevel': {
        if (member.playerId !== this.host) return;
        if (this.phase !== 'lobby') return;
        const lvl = Number(msg.level);
        if (!Number.isInteger(lvl) || lvl < 1 || lvl > 3) return;
        this.level = lvl;
        this.broadcastLobby();
        return;
      }

      case 'startMatch': {
        if (member.playerId !== this.host) {
          client.error('not_host', 'Only the host can start.');
          return;
        }
        if (this.phase !== 'lobby') return;
        if (!this.canStart()) {
          client.error('not_enough_players', `You need ${this.limits.min} gardens to start.`);
          return;
        }
        this.startCountdown();
        return;
      }

      case 'addBot': {
        if (member.playerId !== this.host) return;
        if (this.phase !== 'lobby') return;
        if (!this.addBot()) {
          client.error('room_full', 'No room for another garden.');
          return;
        }
        this.broadcastLobby();
        return;
      }

      case 'removeBot': {
        if (member.playerId !== this.host) return;
        if (this.phase !== 'lobby') return;
        if (this.removeBot()) this.broadcastLobby();
        return;
      }

      case 'tap': {
        const garden = this.playable(member);
        if (!garden) return;
        const cell = msg.cell;
        if (!Number.isInteger(cell) || cell < 0 || cell >= garden.state.board.cells.length) return;
        garden.tap(member.seat, cell);
        return;
      }

      case 'buyTech': {
        const garden = this.playable(member);
        if (!garden) return;
        if (!isTechId(msg.tech)) return;
        garden.buyTech(member.seat, msg.tech);
        return;
      }

      case 'build': {
        const garden = this.playable(member);
        if (!garden) return;
        const cell = msg.cell;
        if (!Number.isInteger(cell) || cell < 0 || cell >= garden.state.board.cells.length) return;
        garden.buildStore(member.seat, cell);
        return;
      }

      case 'hatch': {
        const garden = this.playable(member);
        if (!garden) return;
        garden.hatchInsect(member.seat);
        return;
      }

      case 'takeover': {
        const garden = this.playable(member);
        if (!garden) return;
        const cell = msg.cell;
        if (!Number.isInteger(cell) || cell < 0 || cell >= garden.state.board.cells.length) return;
        garden.hostileTakeover(member.seat, cell);
        return;
      }

      case 'pact': {
        const garden = this.playable(member);
        if (!garden) return;
        const other = msg.seat;
        if (!Number.isInteger(other) || other < 0 || other >= garden.state.seats.length) return;
        if (other === member.seat) return;
        if (garden.setPact(member.seat, other)) this.broadcastPacts();
        return;
      }

      case 'chat': {
        const text = sanitizeChat(msg.text, CHAT_MAX_LEN);
        if (!text || !client.canChat()) return;
        this.broadcast({ t: 'chat', from: member.playerId, name: member.name, text });
        return;
      }

      default:
        return;
    }
  }

  /** The garden, if this member may act in it right now. */
  private playable(member: Member): Garden | null {
    if (this.phase !== 'playing') return null;
    const garden = this.garden;
    if (!garden) return null;
    if (member.seat < 0) return null;
    if (!garden.state.seats[member.seat]?.alive) return null;
    return garden;
  }

  /**
   * Tell each client which pacts involve them — and only them. See the `pacts`
   * message in the protocol for why this is not part of the broadcast snapshot.
   */
  private broadcastPacts(): void {
    const garden = this.garden;
    if (!garden) return;
    for (const m of this.members) {
      if (!m.client || m.seat < 0) continue;
      const fromYou: number[] = [];
      const toYou: number[] = [];
      for (const other of garden.state.seats) {
        if (other.seat === m.seat) continue;
        if (garden.hasOffer(m.seat, other.seat)) fromYou.push(other.seat);
        if (garden.hasOffer(other.seat, m.seat)) toYou.push(other.seat);
      }
      m.client.send({ t: 'pacts', toYou, fromYou });
    }
  }

  // ================================================================ teardown

  /**
   * Serialize once, send to many. The snapshot is the hot path — 20 a second to
   * every client — and it is byte-identical for all of them.
   */
  private broadcast(msg: ServerMsg): void {
    const json = encode(msg);
    for (const client of this.clients.values()) client.sendRaw(json);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const client of this.clients.values()) {
      client.send({ t: 'roomClosed', reason });
      if (client.roomId === this.id) client.roomId = null;
    }
    this.clients.clear();
    this.members = [];
    this.garden = null;
  }
}

function isRoleId(value: unknown): value is RoleId {
  return typeof value === 'string' && (ROLE_IDS as readonly string[]).includes(value);
}

function isTechId(value: unknown): value is TechId {
  return typeof value === 'string' && TECHS.some((t) => t.id === value);
}
