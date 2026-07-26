/**
 * VOIDLINE — global tuning constants.
 * Shared verbatim by server (authority) and client (prediction/rendering).
 * Anything that affects simulation MUST live here, never duplicated.
 */

// ---------------------------------------------------------------- networking
export const TICK_RATE = 20; // authoritative sim ticks per second
export const TICK_MS = 1000 / TICK_RATE;
export const DT = 1 / TICK_RATE; // seconds per tick, use this in all sim math
export const INPUT_SEND_RATE = 30; // client -> server input frames per second
export const SNAPSHOT_RATE = 20; // server -> client world snapshots per second
export const INTERP_DELAY_MS = 100; // client renders remote entities this far in the past
export const MAX_PLAYERS_PVP = 8;
export const MAX_PLAYERS_COOP = 4;
export const DEFAULT_PORT = 8080;

// ---------------------------------------------------------------- arena space
// World units. 1 unit == 1 pixel at camera zoom 1.
export const ARENA_W = 1600;
export const ARENA_H = 1200;
export const PLAYER_RADIUS = 16;
export const ENEMY_RADIUS_DEFAULT = 18;

// ---------------------------------------------------------------- movement
export const MOVE_SPEED = 260; // units/sec baseline, scaled by role
export const DASH_SPEED = 900;
export const DASH_DURATION = 0.16; // seconds
export const DASH_COOLDOWN = 1.6;
export const DASH_IFRAMES = 0.14; // invulnerable window during dash

// ---------------------------------------------------------------- health/combat
export const BASE_HP = 100;
export const RESPAWN_DELAY = 3.0; // pvp only
export const DOWNED_DURATION = 12.0; // coop: seconds before bleed-out
export const REVIVE_RADIUS = 60;
export const REVIVE_TIME = 3.0;

// ---------------------------------------------------------------- weave board
/** The Weave is a square grid of conduit tiles the player rotates in real time. */
export const WEAVE_SIZE = 5; // 5x5 default; roles may override (see roles.ts)
export const WEAVE_ROTATE_COOLDOWN = 0.08; // anti-spam, seconds between rotations
/** Power flows from the core outward; a slot charges while it stays connected. */
export const CHARGE_RATE_BASE = 1.0; // charge units/sec while connected
export const CHARGE_DECAY_RATE = 0.35; // charge units/sec lost while disconnected
/** A slot fires when charge >= its ability's cost. */
export const MAX_OVERCHARGE = 1.5; // charge can bank to 150% for empowered casts

// ---------------------------------------------------------------- loadout
export const ABILITY_SLOTS = 3; // exactly matches the 3 output slots on the Weave

// ---------------------------------------------------------------- feel
export const HITSTOP_MS = 60; // freeze frames on solid hit (client-side only)
export const SCREENSHAKE_DECAY = 8.0;

// ================================================================ simulation (owner: C)
// Everything below is consumed by shared/sim.ts + shared/combat.ts and is safe to
// tune. All of it must stay identical on client and server (prediction parity).

// ---------------------------------------------------------------- movement feel
/** Ground acceleration toward the desired velocity, units/sec^2. Snappy, not floaty. */
export const MOVE_ACCEL = 3400;
/** Deceleration when there is no move input (also bleeds off dash momentum). */
export const MOVE_FRICTION = 2600;
/** Below this effective speed multiplier a player counts as immobilised. */
export const MOVE_MIN_MUL = 0.02;
/** Hardest a chill/slow may ever bite. */
export const MOVE_SLOW_FLOOR = 0.2;

// ---------------------------------------------------------------- basic attack
/** Internal rate limit on the free basic attack (it is not routed through the Weave). */
export const BASIC_ATTACK_COOLDOWN = 0.35;

// ---------------------------------------------------------------- projectiles
export const PROJECTILE_RADIUS_DEFAULT = 8;
export const PROJECTILE_RADIUS_MAX = 20;
/** Hard cap on projectile lifetime regardless of range/speed. */
export const PROJECTILE_MAX_LIFE = 4.0;
/** An ability whose radius meets this spawns a blast on projectile impact. */
export const PROJECTILE_BLAST_MIN_RADIUS = 28;
/** Splash damage fraction applied to secondary targets inside a blast. */
export const BLAST_FALLOFF = 0.6;
/**
 * Below this blast radius the detonation still splashes but does not shake the
 * camera — a heavy slug with a 12-unit cleave must not feel like a mortar.
 */
export const BLAST_VFX_MIN_RADIUS = 40;

// ---------------------------------------------------------------- beams
/** Half-thickness of a beam when the ability declares no radius. */
export const BEAM_HALF_WIDTH = 10;
/** Targets a beam passes through when the ability declares no pierce. */
export const BEAM_PIERCE_DEFAULT = 3;

// ---------------------------------------------------------------- dashes
/** Sweep radius of a damaging dash/blink. */
export const DASH_HIT_RADIUS = 24;
export const DASH_MIN_DURATION = 0.06;
export const DASH_MAX_DURATION = 0.6;

// ---------------------------------------------------------------- zones
export const ZONE_TICKS_PER_SEC = 4;
export const ZONE_TICK_INTERVAL = 1 / ZONE_TICKS_PER_SEC;
export const ZONE_RADIUS_DEFAULT = 90;

// ---------------------------------------------------------------- statuses
/** Burn deals damage in discrete ticks so damage numbers stay readable. */
export const BURN_TICK_INTERVAL = 0.5;
/** Burn dps derived from the applying ability's damage. */
export const STATUS_BURN_DPS_FRACTION = 0.3;
export const STATUS_BURN_MIN_DPS = 5;
/** Fractional move-speed reduction from chill. */
export const STATUS_CHILL_SLOW = 0.35;
/** Fractional move-speed bonus from haste. */
export const STATUS_HASTE_BONUS = 0.4;
/** Fractional charge-rate bonus from overclock. */
export const STATUS_OVERCLOCK_BONUS = 0.6;
/** Fractional bonus damage taken while marked. */
export const STATUS_MARK_AMP = 0.25;
/** Absorb granted by a shield ability that declares no damage value. */
export const STATUS_SHIELD_DEFAULT = 25;
/** Shield points bled off per second while active. */
export const SHIELD_DECAY_RATE = 2.0;
export const SHIELD_MAX = 150;

export const STATUS_DURATION_BURN = 3.0;
export const STATUS_DURATION_CHILL = 2.5;
export const STATUS_DURATION_STUN = 0.9;
export const STATUS_DURATION_ROOT = 1.5;
export const STATUS_DURATION_MARK = 4.0;
export const STATUS_DURATION_SHIELD = 6.0;
export const STATUS_DURATION_HASTE = 4.0;
export const STATUS_DURATION_OVERCLOCK = 5.0;

// ---------------------------------------------------------------- down / revive
/** Fraction of max HP a revived player comes back with. */
export const REVIVE_HP_FRACTION = 0.5;
/** Revive progress (0..1) lost per second when nobody is holding Interact. */
export const REVIVE_DECAY_RATE = 0.5;
/** Coop: seconds before a bled-out player may be brought back by the mode handler. */
export const COOP_BLEEDOUT_RESPAWN = 8.0;

// ---------------------------------------------------------------- summons
export const SUMMON_BASE_HP = 45;
export const SUMMON_HP_PER_DAMAGE = 2.5;
export const SUMMON_RADIUS_DEFAULT = 14;
export const SUMMON_DEFAULT_LIFE = 10;

// ---------------------------------------------------------------- juice
/** A hit landing for at least this fraction of max HP reads as a crit. */
export const CRIT_HP_FRACTION = 0.22;
export const SHAKE_PER_DAMAGE = 0.012;
export const SHAKE_MAX = 1.4;

// ---------------------------------------------------------------- session / transport
// (added by agent D — server backbone. All additive.)
/** Max client -> server messages per second before the connection is dropped. */
export const MAX_CLIENT_MSGS_PER_SEC = 120;
/** Hard cap on a single inbound message; larger frames are rejected outright. */
export const MAX_CLIENT_MSG_BYTES = 8192;
/** WebSocket-level heartbeat cadence and how many missed beats kill the socket. */
export const HEARTBEAT_INTERVAL_MS = 15000;
export const HEARTBEAT_MISS_LIMIT = 2;
/** A dropped player's entity is held this long so they can reclaim their slot. */
export const RECONNECT_GRACE_SEC = 20;
/** Longest a room may sit with zero connected clients before it is reaped. */
export const EMPTY_ROOM_TTL_SEC = 60;
/** Name/chat guardrails (server sanitizes; never trust the client). */
export const NAME_MAX_LEN = 18;
export const CHAT_MAX_LEN = 200;
export const CHAT_MIN_INTERVAL_SEC = 0.5;

// ---------------------------------------------------------------- rooms / match pacing
/** Room codes: 6 chars from an unambiguous alphabet (no O/0/I/1). */
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Seconds allowed on the loadout screen before the match starts anyway. */
export const LOADOUT_PHASE_SEC = 45;
/** Seconds of "3..2..1" once everyone is locked in. */
export const COUNTDOWN_SEC = 5;
/** How long the results screen stays up before the room returns to lobby. */
export const MATCH_COMPLETE_LINGER_SEC = 15;
/** Minimum bodies required to start. */
export const MIN_PLAYERS_PVP = 2;
export const MIN_PLAYERS_COOP = 1;
/** Number of chapters in the co-op campaign. */
export const COOP_CHAPTER_COUNT = 5;

// ---------------------------------------------------------------- weave dispatch
/**
 * Full weave boards are pushed to their owner on any structural change, plus a
 * forced resync every N ticks so charge values never drift. Never 20 Hz.
 */
export const WEAVE_SYNC_INTERVAL_TICKS = 5;
/**
 * Cadence of the free basic attack, which is NOT routed through the Weave:
 * see `BASIC_ATTACK_COOLDOWN` in the simulation section above (declared once there
 * because shared/sim.ts owns the basic-attack timer). Do not re-declare it here.
 */
