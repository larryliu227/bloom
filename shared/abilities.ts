/**
 * VOIDLINE — ability content. 4 basic attacks + 28 Weave circuits.
 *
 * ============================================================ FIELD SEMANTICS
 * `AbilityDef` is a flat record, so a few fields carry shape-dependent meaning.
 * These readings are the contract between this file and `combat.ts`. Everything
 * below is intentional, not an accident of tuning.
 *
 *   cost      Charge required to fire. Roughly "seconds of held circuit" at
 *             CHARGE_RATE_BASE 1.0. Basic attacks are 0 — they bypass the Weave
 *             entirely and are rate-limited by `refireInterval()` instead.
 *
 *   damage    projectile/beam/aoe/dash : damage per target hit.
 *             zone                     : damage per SECOND to anything inside.
 *             summon                   : damage per attack (see SUMMON_ATTACK_INTERVAL).
 *             buff                     : NOT damage — the magnitude of `applies`
 *                                        (shield points, or a fraction for haste
 *                                        and overclock).
 *             friendly + any of the above : the number is healing, not damage.
 *
 *   range     projectile : max travel distance before it expires.
 *             beam       : line length.
 *             aoe        : max cast distance from the caster. 0 = centred on self.
 *             dash       : distance travelled.
 *             buff       : max distance to the targeted ally. 0 = self only.
 *             summon     : the summon's own engagement range (it spawns on the caster).
 *
 *   radius    projectile : blast radius on impact. The projectile BODY always
 *                          collides at min(radius, PROJECTILE_BODY_RADIUS); if
 *                          `radius` is larger than that it detonates for splash.
 *             beam       : half-width of the line.
 *             aoe / zone : effect radius.
 *             dash       : half-width of the swept lane.
 *             buff       : >0 applies to every ally within this radius of the
 *                          caster; 0 means a single target (see `range`).
 *             summon     : the summon entity's body radius.
 *
 *   speed     Travel speed for projectile/dash. Summon walk speed (0 = immobile
 *             turret). 0 for every instant shape.
 *
 *   duration  How long the ability's EFFECT lasts.
 *             instant shapes (projectile/beam/aoe/dash) : the duration of the
 *                          status in `applies`. 0 when it applies nothing.
 *             zone/summon : entity lifetime. Statuses they apply are re-applied
 *                          each tick with a ZONE_STATUS_REFRESH window.
 *             buff       : buff lifetime.
 *
 *   applies   Status on hit. Magnitude comes from STATUS_MAGNITUDE, EXCEPT for
 *             `buff` shapes where it comes from `damage`. `statusFor()` resolves
 *             this for you — call that rather than reimplementing the rule.
 *
 *   scalesWithOvercharge
 *             Overcharge (up to MAX_OVERCHARGE = 1.5x) multiplies damage/heal/
 *             shield only. Deliberately FALSE on every hard-CC and every charge-
 *             rate buff: a 1.5x stun lock or a 90% overclock is not a fun payoff.
 *
 * ============================================================ BALANCE MODEL
 * A player realistically banks ~1.4-1.8 charge/sec once you account for reroute
 * downtime and how many slots their board can branch to. Damage-per-charge (DPC)
 * is therefore the master dial:
 *
 *   cost 1.0-1.5  chip      DPC ~ 9-11   spammable, no commitment, no status
 *   cost 2.0-2.6  tools     DPC ~ 7-11   the cheap ones buy CC, not damage
 *   cost 3.0-3.8  swings    DPC ~ 9-11   real damage or real area
 *   cost 4.2-4.8  payoffs   DPC ~ 8      fight-deciding by AREA and TELEGRAPH,
 *                                        not by efficiency — a Siege Shell is a
 *                                        statement, not a DPS increase.
 *
 * Those are NOMINAL numbers — what an ability pays if it connects. Measured
 * output per charge in a live duel is far lower for anything you have to aim,
 * so `speed` on a projectile is a balance stat, not flavour: a shell slow enough
 * to walk away from converts at under 1 per charge no matter what `damage` says.
 * Nothing in this file may be priced on nominal DPC alone.
 *
 * Ceiling rule: no single landed ability exceeds ~50% of a 100 HP target after
 * the role's damageMul. That is what keeps the "4-7 landed abilities" window
 * honest while still letting a Breaker delete a Phantom who stood still.
 *
 * SUSTAIN IS NOT PRICED ON THE DPC LINE. The original model put healing and
 * shielding at the same ~10 per charge as damage, on the assumption that both
 * sides land everything. They do not: measured over 2400 `pvp_duel` matches
 * between ace bots, aimed damage converts at roughly 1-5 per charge once misses
 * are counted, while a heal or a shield converts at its full face value because
 * it cannot miss. Sustain priced at parity therefore beat every attacker in the
 * game 100-0. Heals and shields now sit near the LOW end of the measured damage
 * curve instead of the nominal one:
 *
 *   mend_pulse     16 / 2.8 =  5.7 HP per charge
 *   ablative_vent  28 / 2.4 = 11.7 shield per charge
 *   aegis_weave    34 / 2.8 = 12.1 shield per charge
 *   bastion        40 / 3.2 = 12.5 shield per charge   (also hits allies)
 *
 * Keep the three shields on one line; they are the same effect at different
 * reach. Two further rules keep sustain honest, and `combat.ts` must honour both:
 *   1. The role's `damageMul` applies to HOSTILE damage only. Heals, shields
 *      and buff magnitudes are never scaled by it — a Conduit's 0.85 must not
 *      nerf its own Mend Pulse.
 *   2. `shield` REFRESHES, it does not stack. Re-applying replaces the old
 *      absorb pool. Stacking shields makes Aegis Weave uncounterable.
 *
 * Basic attacks want a per-role cadence, not a flat one — a Breaker slug and a
 * Phantom slash are not the same weapon. `sim.ts` should gate them with
 *   p.basicCooldown = refireInterval(basic.id) || BASIC_ATTACK_COOLDOWN;
 * Their damage is nonetheless tuned to stay non-broken at the flat fallback.
 */

import type { AbilityDef, AbilityId, RoleId, Status, StatusKind } from './types.js';
import { ROLES } from './roles.js';

// ---------------------------------------------------------------- resolution constants
// Tuning that belongs to ability CONTENT rather than to the global sim, so it
// lives here beside the numbers it governs. `combat.ts` should import these.

/** Zones apply their per-second `damage` in slices this large. */
export const ZONE_TICK_INTERVAL = 0.5;
/** Status window a zone/summon stamps on anything inside; refreshed every tick. */
export const ZONE_STATUS_REFRESH = 0.6;
/** Summons attack this often; their `damage` is per attack. */
export const SUMMON_ATTACK_INTERVAL = 1.0;
/** Summon maxHp = round(cost * this). Expensive summons are tougher summons. */
export const SUMMON_HP_PER_COST = 22;
/** Projectile bodies collide at this radius; a larger `radius` means splash. */
export const PROJECTILE_BODY_RADIUS = 10;
/** Fallback status window when an instant ability declares `applies` but no duration. */
export const DEFAULT_STATUS_DURATION = 2.0;
/** Steering rate, rad/sec, for the ids in HOMING_ABILITIES. */
export const HOMING_TURN_RATE = 3.2;

/**
 * Projectiles that steer toward the nearest valid target. Currently just the
 * Conduit's basic — it is slow and weak precisely because it never misses.
 */
export const HOMING_ABILITIES: ReadonlySet<AbilityId> = new Set<AbilityId>(['sig_mote']);

/**
 * Default magnitude per status kind. Used for every shape except `buff`, where
 * the ability's `damage` field carries the magnitude instead.
 *
 *   burn      damage per second
 *   chill     fraction of move speed removed (0.4 = -40%)
 *   stun      unused (binary)
 *   shield    absorb points
 *   haste     fraction of move speed added
 *   overclock fraction added to Weave charge rate
 *   root      unused (binary)
 *   mark      fraction of extra damage taken from all sources
 */
export const STATUS_MAGNITUDE: Record<StatusKind, number> = {
  burn: 5,
  chill: 0.4,
  stun: 1,
  shield: 25,
  haste: 0.3,
  overclock: 0.4,
  root: 1,
  mark: 0.18,
};

/**
 * Refire interval for the free basic attacks, seconds. Keyed by ability id.
 *
 * Damage on the four basics is tuned so they stay sane even if the caller
 * ignores this and uses the flat BASIC_ATTACK_COOLDOWN — a free attack should
 * never out-earn the Weave, which is the whole game. With these intervals the
 * basics sit at roughly 40-50% of a role's Weave DPS, which is where they belong.
 */
const REFIRE: Record<string, number> = {
  slug_shot: 0.55,
  scatter_burst: 0.55,
  sig_mote: 0.45,
  rift_slash: 0.42,
};

// ============================================================ BREAKER
// 85 HP, 1.25x damage, 4x4 board. Every circuit is expensive relative to what
// the board can sustain, so a Breaker is choosing which single gun is loaded.
// The whole kit is priced assuming roughly half of it misses — which is why the
// projectile speeds matter as much as the damage numbers do.

const BREAKER: AbilityDef[] = [
  {
    id: 'slug_shot',
    name: 'Slug',
    role: 'breaker',
    shape: 'projectile',
    description: 'Free heavy slug — 4 damage at 540 u/s. Slow enough that you have to lead it.',
    cost: 0,
    damage: 4,
    range: 520,
    radius: 12,
    speed: 540,
    duration: 0,
    scalesWithOvercharge: false,
    icon: '●',
  },
  {
    id: 'ord_round',
    name: 'Ordnance Round',
    role: 'breaker',
    shape: 'projectile',
    description: 'Cheap shell, 12 damage at 1050 u/s. The circuit refills before the casing lands.',
    cost: 1.2,
    damage: 12,
    range: 700,
    radius: 11,
    speed: 1050,
    duration: 0,
    scalesWithOvercharge: true,
    icon: '◆',
  },
  {
    id: 'concussion',
    name: 'Concussion Wave',
    role: 'breaker',
    shape: 'aoe',
    description: 'Point-blank pressure wave: 16 damage and a 0.5 s stun to everything inside 170.',
    cost: 2.2,
    damage: 16,
    range: 0,
    radius: 170,
    speed: 0,
    duration: 0.5,
    applies: 'stun',
    scalesWithOvercharge: false,
    icon: '◉',
  },
  {
    id: 'sunder',
    name: 'Sunder',
    role: 'breaker',
    shape: 'dash',
    description: 'Ram 380 units forward — 24 damage and a 1.2 s chill to everything you plough through.',
    cost: 2.4,
    damage: 24,
    range: 380,
    radius: 34,
    speed: 1250,
    duration: 1.2,
    applies: 'chill',
    scalesWithOvercharge: true,
    icon: '▲',
  },
  {
    id: 'rail_lance',
    name: 'Rail Lance',
    role: 'breaker',
    shape: 'beam',
    description: 'Instant piercing lance: 28 damage down an 820-unit line, and it does not stop at the first body.',
    cost: 3.2,
    damage: 28,
    range: 820,
    radius: 12,
    speed: 0,
    duration: 0,
    pierce: 4,
    scalesWithOvercharge: true,
    icon: '⌁',
  },
  {
    id: 'thermite',
    name: 'Thermite Spread',
    role: 'breaker',
    shape: 'zone',
    description: 'Burning slag, 115 radius for 5 s: 11 damage/s plus burn to anything that stays in it.',
    cost: 2.8,
    damage: 11,
    range: 560,
    radius: 115,
    speed: 0,
    duration: 5,
    applies: 'burn',
    scalesWithOvercharge: true,
    icon: '❋',
  },
  {
    id: 'ablative_vent',
    name: 'Ablative Vent',
    role: 'breaker',
    shape: 'buff',
    description: 'Blow your plating into a 28-point shield for 6 s. The only reason a Breaker wins a trade.',
    cost: 2.4,
    damage: 28,
    range: 0,
    radius: 0,
    speed: 0,
    duration: 6,
    applies: 'shield',
    scalesWithOvercharge: true,
    friendly: true,
    icon: '⬡',
  },
  {
    id: 'siege_shell',
    name: 'Siege Shell',
    role: 'breaker',
    shape: 'projectile',
    description: 'A 680 u/s shell that detonates for 38 damage inside 90 units. Fully telegraphed, and worth it.',
    cost: 4.8,
    damage: 38,
    range: 820,
    radius: 90,
    speed: 680,
    duration: 0,
    scalesWithOvercharge: true,
    icon: '⬢',
  },
];

// ============================================================ BULWARK
// 165 HP, 0.8x damage, 6x6 board at 0.9 charge. The only role whose board can
// realistically branch to all three slots at once, which is the point: a Bulwark
// wins by never being out of options, not by out-damaging anyone.

const BULWARK: AbilityDef[] = [
  {
    id: 'scatter_burst',
    name: 'Scatter',
    role: 'bulwark',
    shape: 'beam',
    description: 'Free point-blank scatter: 6 damage to everything in a 210-unit wedge. Useless at range, brutal in a doorway.',
    cost: 0,
    damage: 6,
    range: 210,
    radius: 44,
    speed: 0,
    duration: 0,
    pierce: 5,
    scalesWithOvercharge: false,
    icon: '▣',
  },
  {
    id: 'slag_lob',
    name: 'Slag Lob',
    role: 'bulwark',
    shape: 'projectile',
    description: 'Arcing wad of reactor slag: 13 damage in a 20-unit splash, then burn for 3 s.',
    cost: 1.4,
    damage: 13,
    range: 540,
    radius: 20,
    speed: 760,
    duration: 3,
    applies: 'burn',
    scalesWithOvercharge: true,
    icon: '▼',
  },
  {
    id: 'tether_spike',
    name: 'Tether Spike',
    role: 'bulwark',
    shape: 'projectile',
    description: 'Harpoon that pins: 15 damage and a 1.1 s root. They can still shoot — they just cannot leave.',
    cost: 2.0,
    damage: 15,
    range: 620,
    radius: 14,
    speed: 1150,
    duration: 1.1,
    applies: 'root',
    scalesWithOvercharge: false,
    icon: '⋔',
  },
  {
    id: 'hardpoint_charge',
    name: 'Hardpoint Charge',
    role: 'bulwark',
    shape: 'dash',
    description: 'Armoured charge 300 units: 26 damage and a 1.2 s chill to everything in the lane.',
    cost: 2.4,
    damage: 26,
    range: 300,
    radius: 36,
    speed: 980,
    duration: 1.2,
    applies: 'chill',
    scalesWithOvercharge: true,
    icon: '■',
  },
  {
    id: 'bastion',
    name: 'Bastion Field',
    role: 'bulwark',
    shape: 'buff',
    description: 'A 40-point shield on you and every ally within 200, for 8 s. This is why squads survive Chapter 4.',
    cost: 3.2,
    damage: 40,
    range: 0,
    radius: 200,
    speed: 0,
    duration: 8,
    applies: 'shield',
    scalesWithOvercharge: true,
    friendly: true,
    icon: '⊕',
  },
  {
    id: 'seismic_slam',
    name: 'Seismic Slam',
    role: 'bulwark',
    shape: 'aoe',
    description: 'Drive the deck plate down: 34 damage and a 0.45 s stun in a 195-unit ring.',
    cost: 3.4,
    damage: 34,
    range: 0,
    radius: 195,
    speed: 0,
    duration: 0.45,
    applies: 'stun',
    scalesWithOvercharge: false,
    icon: '⊙',
  },
  {
    id: 'gravity_well',
    name: 'Gravity Well',
    role: 'bulwark',
    shape: 'zone',
    description: 'Collapsed graviton knot: 12 damage/s and a 40% chill inside 155 units, for 7 s.',
    cost: 3.8,
    damage: 12,
    range: 520,
    radius: 155,
    speed: 0,
    duration: 7,
    applies: 'chill',
    scalesWithOvercharge: true,
    icon: '⌖',
  },
  {
    id: 'ward_pylon',
    name: 'Ward Pylon',
    role: 'bulwark',
    shape: 'summon',
    description: 'Bolt down a 92 HP pylon for 12 s. Pulses 11 damage every second at anything inside 220. It can be shot down.',
    cost: 4.2,
    damage: 11,
    range: 220,
    radius: 18,
    speed: 0,
    duration: 12,
    scalesWithOvercharge: true,
    icon: '⌂',
  },
];

// ============================================================ CONDUIT
// 105 HP, 0.85x damage, 5x5 board at the best sustained charge rate in the game.
// The slowest killer in the game — ~11 landed abilities — but the only role that
// can hand its charge to somebody else. Its sustain is deliberately priced BELOW
// the nominal damage-per-charge line (see the header): unmissable output that
// matched aimed output made the Conduit unkillable 1v1.

const CONDUIT: AbilityDef[] = [
  {
    id: 'sig_mote',
    name: 'Signal Mote',
    role: 'conduit',
    shape: 'projectile',
    description: 'Free homing mote, 4 damage. It drifts at 360 u/s and steers — it always arrives eventually.',
    cost: 0,
    damage: 4,
    range: 640,
    radius: 9,
    speed: 360,
    duration: 0,
    scalesWithOvercharge: false,
    icon: '○',
  },
  {
    id: 'flux_bolt',
    name: 'Flux Bolt',
    role: 'conduit',
    shape: 'projectile',
    description: 'Compressed lattice charge, 14 damage at 780 u/s. Cheap enough to hold a corridor alone.',
    cost: 1.3,
    damage: 14,
    range: 660,
    radius: 11,
    speed: 780,
    duration: 0,
    scalesWithOvercharge: true,
    icon: '✦',
  },
  {
    id: 'mend_pulse',
    name: 'Mend Pulse',
    role: 'conduit',
    shape: 'aoe',
    description: 'Restores 16 HP to you and every ally within 185. No cast time — just the circuit.',
    cost: 2.8,
    damage: 16,
    range: 0,
    radius: 185,
    speed: 0,
    duration: 0,
    scalesWithOvercharge: true,
    friendly: true,
    icon: '✧',
  },
  {
    id: 'ion_tether',
    name: 'Ion Tether',
    role: 'conduit',
    shape: 'beam',
    description: 'Piercing tether: 24 damage and a 4 s mark. Marked targets take 18% more from every source.',
    cost: 2.4,
    damage: 24,
    range: 640,
    radius: 10,
    speed: 0,
    duration: 4,
    applies: 'mark',
    pierce: 2,
    scalesWithOvercharge: true,
    icon: '⇋',
  },
  {
    id: 'aegis_weave',
    name: 'Aegis Weave',
    role: 'conduit',
    shape: 'buff',
    description: 'Wrap one ally within 440 in a 34-point shield for 7 s. It does not stack — pick the right ally, and the right second.',
    cost: 2.8,
    damage: 34,
    range: 440,
    radius: 0,
    speed: 0,
    duration: 7,
    applies: 'shield',
    scalesWithOvercharge: true,
    friendly: true,
    icon: '❖',
  },
  {
    id: 'overclock_link',
    name: 'Overclock Link',
    role: 'conduit',
    shape: 'buff',
    description: 'Shunt your circuit into an ally within 440: +35% Weave charge rate for 6 s. Worth a slot when you hand it away; barely worth one when you keep it.',
    cost: 3.2,
    damage: 0.35,
    range: 440,
    radius: 0,
    speed: 0,
    duration: 6,
    applies: 'overclock',
    scalesWithOvercharge: false,
    friendly: true,
    icon: '↺',
  },
  {
    id: 'null_field',
    name: 'Null Field',
    role: 'conduit',
    shape: 'zone',
    description: 'Depolarised air, 160 radius for 6 s: 10 damage/s and a 40% chill on anything hostile inside.',
    cost: 3.6,
    damage: 10,
    range: 560,
    radius: 160,
    speed: 0,
    duration: 6,
    applies: 'chill',
    scalesWithOvercharge: true,
    icon: '≋',
  },
  {
    id: 'sanctum_node',
    name: 'Sanctum Node',
    role: 'conduit',
    shape: 'summon',
    description: 'Plant a 97 HP node for 12 s. Pulses 5 HP a second to allies within 230. Fight around it, not away from it.',
    cost: 4.4,
    damage: 5,
    range: 230,
    radius: 16,
    speed: 0,
    duration: 12,
    scalesWithOvercharge: true,
    friendly: true,
    icon: '◎',
  },
];

// ============================================================ PHANTOM
// 76 HP, 1.2x damage, 4x4 board at 1.4x charge. The cheapest kit in the game:
// a Phantom fires roughly twice as often as a Breaker for two thirds the payload.
// Voidmark -> Phase Lance -> Collapse is the intended kill; measured it takes
// about nine landed circuits, and the Phantom is still the fastest closer at a
// ~23 s round.

const PHANTOM: AbilityDef[] = [
  {
    id: 'rift_slash',
    name: 'Rift Slash',
    role: 'phantom',
    shape: 'beam',
    description: 'Free 145-unit slash for 5 damage, twice a second. You have to be close enough to regret it.',
    cost: 0,
    damage: 5,
    range: 145,
    radius: 30,
    speed: 0,
    duration: 0,
    pierce: 2,
    scalesWithOvercharge: false,
    icon: '⟁',
  },
  {
    id: 'splinter',
    name: 'Splinter Dart',
    role: 'phantom',
    shape: 'projectile',
    description: 'An 1150 u/s dart for 12 damage. Cheapest circuit in the lattice — never stop firing it.',
    cost: 1.0,
    damage: 12,
    range: 640,
    radius: 8,
    speed: 1150,
    duration: 0,
    scalesWithOvercharge: true,
    icon: '◈',
  },
  {
    id: 'blink',
    name: 'Blink',
    role: 'phantom',
    shape: 'dash',
    description: 'Fold 400 units along your aim — instant, i-frames on arrival, 14 damage to anything caught in the seam.',
    cost: 1.6,
    damage: 14,
    range: 400,
    radius: 26,
    speed: 0,
    duration: 0,
    scalesWithOvercharge: false,
    icon: '⇲',
  },
  {
    id: 'void_mark',
    name: 'Voidmark',
    role: 'phantom',
    shape: 'projectile',
    description: '13 damage and a 5 s mark — the target takes 18% more from everything. Open with this.',
    cost: 1.8,
    damage: 13,
    range: 720,
    radius: 9,
    speed: 980,
    duration: 5,
    applies: 'mark',
    scalesWithOvercharge: false,
    icon: '☍',
  },
  {
    id: 'ghostwalk',
    name: 'Ghostwalk',
    role: 'phantom',
    shape: 'buff',
    description: 'Dampen your lattice signature for 3.5 s: +45% move speed and a silhouette nobody can hold a lead on.',
    cost: 2.0,
    damage: 0.45,
    range: 0,
    radius: 0,
    speed: 0,
    duration: 3.5,
    applies: 'haste',
    scalesWithOvercharge: false,
    friendly: true,
    icon: '⧗',
  },
  {
    id: 'phase_lance',
    name: 'Phase Lance',
    role: 'phantom',
    shape: 'beam',
    description: 'Instant piercing lance, 27 damage over 600 units. The Phantom’s only honest ranged answer.',
    cost: 2.6,
    damage: 27,
    range: 600,
    radius: 9,
    speed: 0,
    duration: 0,
    pierce: 2,
    scalesWithOvercharge: true,
    icon: '↯',
  },
  {
    id: 'decoy_echo',
    name: 'Fracture Echo',
    role: 'phantom',
    shape: 'summon',
    description: 'Split off a 70 HP echo of yourself for 8 s. It walks, it shoots for 8, and it eats the first burst.',
    cost: 3.2,
    damage: 8,
    range: 260,
    radius: 16,
    speed: 300,
    duration: 8,
    scalesWithOvercharge: false,
    icon: '✸',
  },
  {
    id: 'collapse',
    name: 'Collapse',
    role: 'phantom',
    shape: 'aoe',
    description: 'Implode a 125-unit sphere anywhere within 440 for 30 damage. The closing half of a Phantom’s kill.',
    cost: 3.8,
    damage: 30,
    range: 440,
    radius: 125,
    speed: 0,
    duration: 0,
    scalesWithOvercharge: true,
    icon: '✺',
  },
];

// ============================================================ registry

/**
 * Every ability in the game, basic attacks included, in role display order.
 * Basic attacks are present here so `getAbility(role.basicAttack)` resolves, but
 * they are NOT in any `abilityPool` — the loadout picker must use
 * `abilitiesForRole()`, which returns exactly the 7 selectable circuits.
 */
export const ABILITY_LIST: AbilityDef[] = [...BREAKER, ...BULWARK, ...CONDUIT, ...PHANTOM];

export const ABILITIES: Record<AbilityId, AbilityDef> = Object.fromEntries(
  ABILITY_LIST.map((a) => [a.id, a]),
);

/** Returned by `getAbility` for an unknown id. Inert: costs nothing, does nothing. */
const UNKNOWN_ABILITY: AbilityDef = {
  id: '__unknown',
  name: 'Dead Circuit',
  role: 'any',
  shape: 'projectile',
  description: 'This circuit is not connected to anything.',
  cost: 0,
  damage: 0,
  range: 0,
  radius: 0,
  speed: 0,
  duration: 0,
  scalesWithOvercharge: false,
  icon: '·',
};

/** Runtime type guard for the protocol boundary — client loadouts are untrusted. */
export function isAbilityId(x: unknown): x is AbilityId {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(ABILITIES, x);
}

/**
 * Look up an ability. Never throws: an unknown id yields an inert definition so
 * a corrupt loadout can degrade a slot instead of killing the room's tick loop.
 */
export function getAbility(id: AbilityId): AbilityDef {
  return isAbilityId(id) ? ABILITIES[id] : UNKNOWN_ABILITY;
}

/** The 7 selectable circuits for a role, in picker order. Excludes the basic attack. */
export function abilitiesForRole(role: RoleId): AbilityDef[] {
  const def = ROLES[role];
  if (!def) return [];
  return def.abilityPool.map(getAbility);
}

/** True if the ability targets allies (heals, shields, links) rather than enemies. */
export function isFriendlyAbility(id: AbilityId): boolean {
  return getAbility(id).friendly === true;
}

/** Seconds between shots for a free basic attack. 0 for Weave-routed abilities. */
export function refireInterval(id: AbilityId): number {
  return REFIRE[id] ?? 0;
}

/**
 * Resolve the status an ability applies, with magnitudes already sorted out.
 * `combat.ts` only has to stamp on the `source` entity id.
 *
 *   const s = statusFor(def, overcharge);
 *   if (s) applyStatus(ctx, target, { ...s, source: caster.id });
 */
export function statusFor(def: AbilityDef, overcharge = 1): Omit<Status, 'source'> | null {
  const kind = def.applies;
  if (!kind) return null;

  // Buff shapes carry their magnitude in `damage`; everything else uses the table.
  const base = def.shape === 'buff' ? def.damage : STATUS_MAGNITUDE[kind];

  // Only absorb/heal-style magnitudes scale. CC and charge-rate buffs never do.
  const scales = def.scalesWithOvercharge && (kind === 'shield' || kind === 'burn');
  const magnitude = scales ? base * overcharge : base;

  // Persistent sources re-stamp a short window every tick; instant shapes use
  // `duration` directly, falling back if content forgot to set one.
  const persistent = def.shape === 'zone' || def.shape === 'summon';
  const remaining = persistent
    ? ZONE_STATUS_REFRESH
    : def.duration > 0
      ? def.duration
      : DEFAULT_STATUS_DURATION;

  return { kind, remaining, magnitude };
}

/** Max HP for a summon spawned by this ability. */
export function summonHp(def: AbilityDef): number {
  return Math.round(def.cost * SUMMON_HP_PER_COST);
}

// ---------------------------------------------------------------- content integrity
// Static invariants. These are either always true or always false, so failing at
// import time is exactly what we want — it surfaces the instant anyone adds a
// role or a circuit that does not line up.
{
  const problems: string[] = [];
  const seen = new Set<AbilityId>();
  for (const a of ABILITY_LIST) {
    if (seen.has(a.id)) problems.push(`duplicate ability id: ${a.id}`);
    seen.add(a.id);
    if (a.icon.length === 0) problems.push(`${a.id}: empty icon`);
  }
  for (const role of Object.values(ROLES)) {
    if (role.abilityPool.length !== 7) {
      problems.push(`${role.id}: pool has ${role.abilityPool.length} abilities, expected 7`);
    }
    for (const id of [...role.abilityPool, role.basicAttack]) {
      const def = ABILITIES[id];
      if (!def) problems.push(`${role.id}: unknown ability id "${id}"`);
      else if (def.role !== role.id) problems.push(`${id}: role "${def.role}" != "${role.id}"`);
    }
    if (ABILITIES[role.basicAttack]?.cost !== 0) {
      problems.push(`${role.id}: basic attack "${role.basicAttack}" must cost 0`);
    }
    if (role.abilityPool.includes(role.basicAttack)) {
      problems.push(`${role.id}: basic attack must not be selectable`);
    }
  }
  if (problems.length) throw new Error(`VOIDLINE content error:\n  ${problems.join('\n  ')}`);
}
