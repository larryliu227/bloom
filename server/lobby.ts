/**
 * VOIDLINE — pre-match state.
 *
 * The lobby is the room's roster: who is here, what they picked, who is ready,
 * who is host. It is deliberately dumb about the simulation — the `Room` owns
 * the phase machine and simply asks the lobby questions ("is everyone ready?")
 * and tells it things ("this player dropped").
 *
 * Every selection the client sends is laundered through `validateLoadout` /
 * the role table before it is stored. The lobby never trusts a `ClientMsg`.
 */

import {
  ABILITY_SLOTS,
  COOP_CHAPTER_COUNT,
  MAX_PLAYERS_COOP,
  MAX_PLAYERS_PVP,
  MIN_PLAYERS_COOP,
  MIN_PLAYERS_PVP,
} from '@shared/constants.js';
import { ROLES, defaultLoadout, validateLoadout } from '@shared/roles.js';
import type { GameMode, LobbyPlayer, LobbyState, PlayerId, RoleId } from '@shared/types.js';

/** Bot difficulty tiers. Behaviour lives in `server/systems/bots.ts`. */
export type BotTier = NonNullable<LobbyPlayer['botTier']>;

/** Seats available for a mode. Duel is strictly two. */
export function maxPlayersFor(mode: GameMode): number {
  if (mode === 'coop_story') return MAX_PLAYERS_COOP;
  if (mode === 'pvp_duel') return 2;
  return MAX_PLAYERS_PVP;
}

/** Bodies required before a match may start. */
export function minPlayersFor(mode: GameMode): number {
  return mode === 'coop_story' ? MIN_PLAYERS_COOP : MIN_PLAYERS_PVP;
}

export function isRoleId(value: unknown): value is RoleId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROLES, value);
}

export class Lobby {
  readonly mode: GameMode;
  readonly maxPlayers: number;
  host: PlayerId | null = null;
  chapter = 1;
  /** Mirrors the room's countdown so the client can render it from LobbyState. */
  countdown = 0;

  /** Join order is significant: it drives host succession and spawn ordering. */
  private readonly order: PlayerId[] = [];
  private readonly byId = new Map<PlayerId, LobbyPlayer>();

  constructor(mode: GameMode, chapter = 1) {
    this.mode = mode;
    this.maxPlayers = maxPlayersFor(mode);
    this.chapter = clampChapter(chapter);
  }

  // ------------------------------------------------------------------ roster

  get size(): number {
    return this.order.length;
  }

  get connectedCount(): number {
    let n = 0;
    for (const p of this.byId.values()) if (p.connected) n += 1;
    return n;
  }

  has(playerId: PlayerId): boolean {
    return this.byId.has(playerId);
  }

  get(playerId: PlayerId): LobbyPlayer | undefined {
    return this.byId.get(playerId);
  }

  /** Ordered roster, oldest member first. */
  list(): LobbyPlayer[] {
    const out: LobbyPlayer[] = [];
    for (const id of this.order) {
      const p = this.byId.get(id);
      if (p) out.push(p);
    }
    return out;
  }

  /** Position in the join order, or -1. Used for deterministic spawn slots. */
  orderOf(playerId: PlayerId): number {
    return this.order.indexOf(playerId);
  }

  isFull(): boolean {
    return this.order.length >= this.maxPlayers;
  }

  add(playerId: PlayerId, name: string): LobbyPlayer {
    const existing = this.byId.get(playerId);
    if (existing) {
      existing.name = name;
      existing.connected = true;
      if (!this.host) this.host = playerId;
      return existing;
    }

    const player: LobbyPlayer = {
      playerId,
      name,
      role: null,
      loadout: [],
      ready: false,
      connected: true,
    };
    this.byId.set(playerId, player);
    this.order.push(playerId);
    if (!this.host) this.host = playerId;
    return player;
  }

  /**
   * Seat a server-controlled AI player. Bots are ordinary roster members — they
   * get a `PlayerEntity` and a Weave board from `Room.buildMatch` like anybody
   * else — with three differences: they are always ready, they never hold a
   * socket, and they can never inherit the host crown.
   */
  addBot(playerId: PlayerId, name: string, role: RoleId, tier: BotTier): LobbyPlayer {
    const bot: LobbyPlayer = {
      playerId,
      name,
      role,
      loadout: validateLoadout(role, defaultLoadout(role)),
      ready: true,
      connected: true,
      isBot: true,
      botTier: tier,
    };
    this.byId.set(playerId, bot);
    this.order.push(playerId);
    return bot;
  }

  /** Roster members that are bots, oldest first. */
  bots(): LobbyPlayer[] {
    return this.list().filter((p) => p.isBot === true);
  }

  isBot(playerId: PlayerId): boolean {
    return this.byId.get(playerId)?.isBot === true;
  }

  /** Humans holding a seat, connected or inside their reconnect grace window. */
  humanCount(): number {
    let n = 0;
    for (const p of this.byId.values()) if (!p.isBot) n += 1;
    return n;
  }

  /** Humans holding a live socket right now. Bots never count. */
  connectedHumanCount(): number {
    let n = 0;
    for (const p of this.byId.values()) if (!p.isBot && p.connected) n += 1;
    return n;
  }

  remove(playerId: PlayerId): void {
    this.byId.delete(playerId);
    const i = this.order.indexOf(playerId);
    if (i >= 0) this.order.splice(i, 1);
    if (this.host === playerId) this.migrateHost();
  }

  setConnected(playerId: PlayerId, connected: boolean): void {
    const p = this.byId.get(playerId);
    if (!p || p.isBot) return;
    p.connected = connected;
    if (!connected) p.ready = false;
    if (!connected && this.host === playerId) this.migrateHost();
  }

  /** Hand the crown to the longest-tenured connected human. Never a bot. */
  migrateHost(): PlayerId | null {
    for (const id of this.order) {
      const p = this.byId.get(id);
      if (p && p.connected && !p.isBot) {
        this.host = id;
        return id;
      }
    }
    this.host = null;
    return null;
  }

  isHost(playerId: PlayerId): boolean {
    return this.host === playerId;
  }

  // ---------------------------------------------------------------- selection

  /**
   * Pick a role. Selecting a role always resets the loadout to that role's
   * default, so the player is never left holding abilities they cannot use.
   * Returns false if the role id was bogus.
   */
  chooseRole(playerId: PlayerId, role: unknown): boolean {
    const p = this.byId.get(playerId);
    if (!p || !isRoleId(role)) return false;
    if (p.role === role) return false;
    p.role = role;
    p.loadout = validateLoadout(role, defaultLoadout(role));
    // Changing your build un-readies you: nobody locks in by accident.
    p.ready = false;
    return true;
  }

  /**
   * Sanitize and store a loadout. Anything illegal for the role is dropped and
   * back-filled by `validateLoadout`, so the stored value is always playable.
   */
  chooseLoadout(playerId: PlayerId, loadout: unknown): boolean {
    const p = this.byId.get(playerId);
    if (!p) return false;
    const requested = Array.isArray(loadout)
      ? loadout.filter((id): id is string => typeof id === 'string').slice(0, ABILITY_SLOTS * 2)
      : [];
    const role = p.role;
    if (!role) return false;
    const clean = validateLoadout(role, requested);
    if (sameLoadout(p.loadout, clean)) return false;
    p.loadout = clean;
    p.ready = false;
    return true;
  }

  setReady(playerId: PlayerId, ready: boolean): boolean {
    const p = this.byId.get(playerId);
    if (!p || !p.connected) return false;
    const want = ready === true;
    // You cannot ready up without a build; the client should prevent this, but
    // the client is not trusted.
    if (want && !this.hasValidBuild(p)) return false;
    if (p.ready === want) return false;
    p.ready = want;
    return true;
  }

  setChapter(chapter: unknown): boolean {
    if (this.mode !== 'coop_story') return false;
    const next = clampChapter(chapter);
    if (next === this.chapter) return false;
    this.chapter = next;
    return true;
  }

  /** Full reset — used when a match ends and the room returns to the lobby. */
  resetReady(): void {
    for (const p of this.byId.values()) p.ready = !!p.isBot;
  }

  /**
   * Un-ready only the people the loadout phase actually exists for: anyone
   * without a legal build. A player who is already locked in keeps their flag.
   *
   * This is load-bearing. `setReady` refuses without a valid build and every
   * build change clears the flag, so "ready" already implies "locked in".
   * Wiping those flags on the lobby -> loadout transition used to erase the very
   * ready that triggered it, which is what made solo co-op unstartable: the
   * client has no way to see the `loadout` phase (LobbyState carries no phase),
   * so it just watched its own READY silently revert to STANDBY forever.
   */
  clearUnbuiltReady(): void {
    for (const p of this.byId.values()) {
      if (p.isBot) {
        p.ready = true;
        continue;
      }
      if (!this.hasValidBuild(p)) p.ready = false;
    }
  }

  /** Give anyone who skipped the loadout screen a working default build. */
  fillMissingBuilds(): void {
    for (const p of this.byId.values()) {
      if (!p.role) p.role = 'breaker';
      if (!this.hasValidBuild(p)) {
        p.loadout = validateLoadout(p.role, defaultLoadout(p.role));
      }
    }
  }

  /** True when every connected member could start a match right now. */
  everyoneLockedIn(): boolean {
    for (const p of this.byId.values()) {
      if (!p.connected) continue;
      if (!this.hasValidBuild(p)) return false;
    }
    return true;
  }

  /** A build the server is willing to put into a match. Never weakened. */
  hasValidBuild(p: LobbyPlayer): boolean {
    return p.role !== null && Array.isArray(p.loadout) && p.loadout.length === ABILITY_SLOTS;
  }

  // -------------------------------------------------------------------- state

  /**
   * True when every connected member is ready and there are enough of them.
   * This is the room's auto-start go signal, so it also has to answer "is there
   * anybody here to play it?".
   *
   * Bots are permanently ready and permanently "connected" — they hold a seat
   * without holding a socket. Without the human check a room whose last player
   * walked out would keep satisfying "everyone ready" and relaunch match after
   * match into an empty socket list until the empty-room reaper got to it.
   * `MIN_PLAYERS_PVP` still gates PvP; a bot is a legal second body, just never
   * the only one.
   */
  allReady(): boolean {
    const connected = this.list().filter((p) => p.connected);
    if (connected.length < minPlayersFor(this.mode)) return false;
    if (this.connectedHumanCount() === 0) return false;
    return connected.every((p) => p.ready);
  }

  state(roomId: string): LobbyState {
    return {
      roomId,
      mode: this.mode,
      host: this.host ?? '',
      players: this.list().map((p) => ({
        playerId: p.playerId,
        name: p.name,
        role: p.role,
        loadout: p.loadout.slice(),
        ready: p.ready,
        connected: p.connected,
        ...(p.isBot ? { isBot: true as const, botTier: p.botTier } : {}),
      })),
      chapter: this.chapter,
      maxPlayers: this.maxPlayers,
      countdown: Math.max(0, Math.ceil(this.countdown)),
    };
  }
}

function clampChapter(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 1;
  return Math.min(COOP_CHAPTER_COUNT, Math.max(1, n));
}

function sameLoadout(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
