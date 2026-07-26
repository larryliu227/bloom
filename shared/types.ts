/**
 * VOIDLINE — core domain types.
 * This file is the single source of truth for game state shape.
 * Server mutates these; client renders them. Do not fork these definitions.
 */

export type PlayerId = string;
export type EntityId = number;
export type RoomId = string;

export interface Vec2 {
  x: number;
  y: number;
}

// ============================================================ roles
export type RoleId = 'breaker' | 'bulwark' | 'conduit' | 'phantom';

export interface RoleDef {
  id: RoleId;
  name: string;
  tagline: string;
  /** Multiplier on BASE_HP. */
  hpMul: number;
  /** Multiplier on MOVE_SPEED. */
  speedMul: number;
  /** Multiplier on damage dealt. */
  damageMul: number;
  /** Weave grid dimension for this role (overrides WEAVE_SIZE). */
  weaveSize: number;
  /** Multiplier on CHARGE_RATE_BASE — how fast connected slots fill. */
  chargeRateMul: number;
  /** Ability ids this role may choose from. Player picks ABILITY_SLOTS of them. */
  abilityPool: AbilityId[];
  /** Free, always-available light attack. Not routed through the Weave. */
  basicAttack: AbilityId;
  /** Accent color, hex. Drives UI + player silhouette tint. */
  color: string;
}

// ============================================================ abilities
export type AbilityId = string;

export type AbilityShape =
  | 'projectile'   // travels, hits first target
  | 'beam'         // instant line, pierces
  | 'aoe'          // circle at cursor / at self
  | 'dash'         // movement + damage along path
  | 'buff'         // self or ally effect, no damage
  | 'summon'       // spawns a persistent entity
  | 'zone';        // lingering ground effect

export interface AbilityDef {
  id: AbilityId;
  name: string;
  role: RoleId | 'any';
  shape: AbilityShape;
  description: string;
  /** Charge required to fire. Higher = must hold the circuit longer. */
  cost: number;
  damage: number;
  /** World units. Meaning depends on shape (travel range, beam length, radius). */
  range: number;
  radius: number;
  /** Projectile/dash travel speed in units/sec. 0 for instant shapes. */
  speed: number;
  /** Seconds the effect persists (zones, buffs, summons). 0 = instant. */
  duration: number;
  /** Status applied on hit, if any. */
  applies?: StatusKind;
  /** Overcharge (charge > cost) scales these by up to MAX_OVERCHARGE. */
  scalesWithOvercharge: boolean;
  /**
   * Extra targets hit before the effect stops.
   * Projectiles: 0 (default) = dies on first hit. Beams: defaults to BEAM_PIERCE_DEFAULT.
   */
  pierce?: number;
  /** True if this ability targets allies rather than enemies. */
  friendly?: boolean;
  /** Icon glyph — a single character rendered in the HUD slot. */
  icon: string;
}

// ============================================================ status effects
export type StatusKind =
  | 'burn'      // damage over time
  | 'chill'     // slow
  | 'stun'      // no input
  | 'shield'    // absorbs damage
  | 'haste'     // move speed up
  | 'overclock' // charge rate up
  | 'root'      // no movement, can still act
  | 'mark';     // takes bonus damage

export interface Status {
  kind: StatusKind;
  /** Seconds remaining. */
  remaining: number;
  /** Effect strength; interpretation depends on kind. */
  magnitude: number;
  /** Who applied it. */
  source: EntityId;
}

// ============================================================ weave puzzle
/**
 * Each tile is a conduit piece. `connections` is a 4-bit mask of open edges
 * in the tile's CURRENT rotation: 1=up, 2=right, 4=down, 8=left.
 * Rotating right (clockwise) maps the mask: up->right, right->down, etc.
 */
export type EdgeMask = number;

export type TileKind =
  | 'empty'    // no conduit, blocks flow
  | 'straight' // two opposite edges
  | 'elbow'    // two adjacent edges
  | 'tee'      // three edges
  | 'cross'    // all four edges
  | 'core'     // power source, always powered, rotation locked
  | 'slot'     // ability output, rotation locked
  | 'blocked'  // permanently dead cell (damage / hazard)
  | 'relay';   // coop: mirrors an ally's tile at the same coordinate

export interface WeaveTile {
  kind: TileKind;
  /** Base edge mask before rotation is applied. */
  base: EdgeMask;
  /** 0..3, number of clockwise quarter-turns applied. */
  rotation: number;
  /** True if the player cannot rotate this tile. */
  locked: boolean;
  /** True if power currently reaches this tile (server-computed). */
  powered: boolean;
  /** For 'slot' tiles: which of the player's 3 ability slots this feeds (0-2). */
  slotIndex?: number;
}

export interface WeaveSlot {
  /** Which loadout ability sits here. */
  ability: AbilityId;
  /** Current accumulated charge. Fires when >= ability.cost. */
  charge: number;
  /** True while the slot's tile is connected to the core. */
  connected: boolean;
}

export interface WeaveBoard {
  size: number;
  /** Row-major, length size*size. */
  tiles: WeaveTile[];
  slots: WeaveSlot[]; // exactly ABILITY_SLOTS entries
  /** Index into `tiles` of the core cell. */
  coreIndex: number;
}

// ============================================================ entities
/**
 * 'a'/'b' are the two PvP sides, 'players' vs 'hostile' is co-op, 'neutral' is inert
 * (props, scenery — hostile to nobody). 'ffa' is the free-for-all team: every 'ffa'
 * entity is hostile to every OTHER 'ffa' entity and allied with none of them, which
 * is what lets an 8-way arena work without needing eight distinct team ids.
 */
export type Team = 'a' | 'b' | 'players' | 'hostile' | 'neutral' | 'ffa';

export type EntityKind = 'player' | 'enemy' | 'projectile' | 'zone' | 'summon' | 'prop';

export interface BaseEntity {
  id: EntityId;
  kind: EntityKind;
  pos: Vec2;
  vel: Vec2;
  radius: number;
  team: Team;
  hp: number;
  maxHp: number;
  /** Facing angle in radians. */
  angle: number;
  statuses: Status[];
  /** Set the tick it died; entity is culled after. */
  dead: boolean;
}

export interface PlayerEntity extends BaseEntity {
  kind: 'player';
  playerId: PlayerId;
  name: string;
  role: RoleId;
  loadout: AbilityId[]; // length ABILITY_SLOTS
  weave: WeaveBoard;
  shield: number;
  dashCooldown: number;
  dashing: number; // seconds of dash remaining, 0 = not dashing
  /** Seconds until the free basic attack is available again. Managed by the sim. */
  basicCooldown?: number;
  /** Coop: downed and awaiting revive. */
  downed: boolean;
  downedTimer: number;
  reviveProgress: number;
  /** PvP: seconds until respawn, 0 = alive. */
  respawnTimer: number;
  score: number;
  kills: number;
  deaths: number;
  ping: number;
  connected: boolean;
}

export interface EnemyEntity extends BaseEntity {
  kind: 'enemy';
  archetype: string; // see server/systems/enemies
  /** Current AI behavior node/state name — useful for debugging + client tells. */
  aiState: string;
  /** Windup telegraph: seconds until the attack lands. 0 = not attacking. */
  telegraph: number;
  telegraphKind: string;
  target: EntityId | null;
  /** Optional lifetime in seconds (summons). Undefined = permanent until killed. */
  life?: number;
  /** Damage per attack. Set for summons; enemy AI may use it too. */
  damage?: number;
}

export interface ProjectileEntity extends BaseEntity {
  kind: 'projectile';
  ability: AbilityId;
  owner: EntityId;
  /** Seconds before self-destruct. */
  life: number;
  pierced: EntityId[];
  /** Damage per hit, baked at spawn (includes overcharge). Falls back to the ability's damage. */
  damage?: number;
  /** Remaining extra targets this projectile may pass through. */
  pierce?: number;
}

export interface ZoneEntity extends BaseEntity {
  kind: 'zone';
  ability: AbilityId;
  owner: EntityId;
  life: number;
  tickAccumulator: number;
  /** Damage (or heal, if the ability is friendly) applied per damage tick. Baked at spawn. */
  damage?: number;
}

export type Entity = PlayerEntity | EnemyEntity | ProjectileEntity | ZoneEntity;

// ============================================================ world / modes
export type GameMode = 'pvp_duel' | 'pvp_arena' | 'coop_story';
export type MatchPhase = 'lobby' | 'loadout' | 'countdown' | 'playing' | 'intermission' | 'complete';

export interface WorldState {
  tick: number;
  mode: GameMode;
  phase: MatchPhase;
  /** Seconds remaining in the current phase, if timed. */
  phaseTimer: number;
  entities: Entity[];
  /** Mode-specific scoreboard/objective payload. */
  objective: ObjectiveState;
  /** Transient one-shot events for client VFX/SFX this tick. */
  events: GameEvent[];
}

export interface ObjectiveState {
  /** Human-readable current goal, shown in HUD. */
  label: string;
  /** 0..1 progress bar, or -1 for none. */
  progress: number;
  /** PvP: team scores. Coop: chapter + wave. */
  teamScores?: Record<string, number>;
  chapter?: number;
  wave?: number;
  totalWaves?: number;
  /** Coop story: currently displayed dialogue line, if any. */
  dialogue?: { speaker: string; text: string; portrait?: string };
}

// ============================================================ events (VFX/SFX cues)
export type GameEvent =
  | { t: 'hit'; pos: Vec2; damage: number; crit: boolean; target: EntityId }
  | { t: 'death'; pos: Vec2; entity: EntityId; kind: EntityKind }
  | { t: 'cast'; pos: Vec2; ability: AbilityId; caster: EntityId; angle: number }
  | { t: 'dash'; from: Vec2; to: Vec2; entity: EntityId }
  | { t: 'slotCharged'; player: PlayerId; slot: number }
  | { t: 'weavePower'; player: PlayerId; connected: boolean; slot: number }
  | { t: 'revive'; player: PlayerId; by: PlayerId }
  | { t: 'objective'; label: string }
  | { t: 'dialogue'; speaker: string; text: string; durationMs: number }
  | { t: 'shake'; magnitude: number }
  | { t: 'sfx'; name: string; pos?: Vec2 };

// ============================================================ lobby
export interface LobbyPlayer {
  playerId: PlayerId;
  name: string;
  role: RoleId | null;
  loadout: AbilityId[];
  ready: boolean;
  connected: boolean;
  /**
   * Server-controlled AI player (see `server/systems/bots.ts`). Absent/false for
   * humans. Bots hold a real seat and a real Weave board; they are always ready
   * and are never counted as a socket, a host candidate, or a reconnect slot.
   */
  isBot?: boolean;
  /** Bot difficulty tier, when `isBot`. Display only — the server owns behavior. */
  botTier?: 'recruit' | 'veteran' | 'ace';
}

export interface LobbyState {
  roomId: RoomId;
  mode: GameMode;
  host: PlayerId;
  players: LobbyPlayer[];
  /** Coop only. */
  chapter: number;
  maxPlayers: number;
  /** Seconds until auto-start once everyone is ready. */
  countdown: number;
}
