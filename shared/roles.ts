/**
 * VOIDLINE — role definitions.
 *
 * Four runners jack into the Voidline lattice. Each one is a different bet about
 * how much time you can afford to spend looking at your Weave instead of the arena.
 *
 *   breaker  — small board, expensive circuits, obscene payload. One gun at a time.
 *   bulwark  — huge board, slow charge, but 165 HP means you can afford to route.
 *   conduit  — mid board, fastest sustained income, pays out in other people's HP.
 *   phantom  — small board, cheapest circuits, fastest charge. Fires constantly.
 *
 * Balance, MEASURED (2400 ace-vs-ace `pvp_duel` matches, default loadouts, both
 * seat orders pooled — round win rate, +/- ~1.4pp):
 *   breaker 54.2%  ·  bulwark 51.3%  ·  conduit 46.2%  ·  phantom 48.2%
 * Landed abilities to secure a round: breaker 7.3 · phantom 9.0 · conduit 11.0 ·
 * bulwark 11.5 (the original 4/4-5/6/7 estimates were derived on paper and are
 * roughly 2x optimistic; they assumed every ability connects).
 * See the header of `abilities.ts` for the damage-per-charge model behind those numbers.
 *
 * This module owns NO ability data — only which ids each role may pick from.
 * It deliberately does not import `abilities.ts`, which keeps the dependency
 * one-directional (abilities -> roles) and cycle-free.
 */

import { ABILITY_SLOTS } from './constants.js';
import type { AbilityId, RoleDef, RoleId } from './types.js';

// ---------------------------------------------------------------- role table
//
// | role    | HP  | speed | dmg  | board | charge | identity                      |
// |---------|-----|-------|------|-------|--------|-------------------------------|
// | breaker | 85  | 247   | 1.25 | 4x4   | 1.00   | burst, dies to a stiff breeze |
// | bulwark | 165 | 221   | 0.80 | 6x6   | 0.90   | attrition, control, shields   |
// | conduit | 105 | 260   | 0.85 | 5x5   | 1.15   | sustain, marks, denial        |
// | phantom | 76  | 325   | 1.20 | 4x4   | 1.40   | tempo, marks, reposition      |
//
// Board size was INTENDED to be the balance lever: a 4x4 barely branches, a 6x6
// feeds all three slots at once. Measured in `pvp_duel`, it is not one. Sampled
// every live tick across 2400 ace-vs-ace matches, every role holds 3/3 slots
// connected 100% of the time and gets there inside 0.1 s of the round going
// live — because the 4-5 s round prep is free routing time and nothing in PvP
// ever un-solves a board again (`damageBoard` is a co-op sapper mechanic).
// `weaveSize` therefore only bites in co-op and against a human who is still
// learning to route. In a duel the real economy dial is `chargeRateMul` against
// the loadout's total cost, which is what the numbers above are tuned on.

export const ROLES: Record<RoleId, RoleDef> = {
  breaker: {
    id: 'breaker',
    name: 'Breaker',
    tagline: 'Nothing on this station is load-bearing.',
    hpMul: 0.85,
    speedMul: 0.95,
    damageMul: 1.25,
    weaveSize: 4,
    chargeRateMul: 1.0,
    abilityPool: [
      'ord_round',
      'concussion',
      'sunder',
      'rail_lance',
      'thermite',
      'ablative_vent',
      'siege_shell',
    ],
    basicAttack: 'slug_shot',
    color: '#ff5a3c',
  },

  bulwark: {
    id: 'bulwark',
    name: 'Bulwark',
    tagline: 'The lattice holds where you stand.',
    hpMul: 1.65,
    speedMul: 0.85,
    damageMul: 0.8,
    weaveSize: 6,
    chargeRateMul: 0.9,
    abilityPool: [
      'slag_lob',
      'tether_spike',
      'hardpoint_charge',
      'bastion',
      'seismic_slam',
      'gravity_well',
      'ward_pylon',
    ],
    basicAttack: 'scatter_burst',
    color: '#4da3ff',
  },

  conduit: {
    id: 'conduit',
    name: 'Conduit',
    tagline: 'Power is a gift. It can be withdrawn.',
    hpMul: 1.05,
    speedMul: 1.0,
    damageMul: 0.85,
    weaveSize: 5,
    chargeRateMul: 1.15,
    abilityPool: [
      'flux_bolt',
      'mend_pulse',
      'ion_tether',
      'aegis_weave',
      'overclock_link',
      'null_field',
      'sanctum_node',
    ],
    basicAttack: 'sig_mote',
    color: '#3cffa8',
  },

  phantom: {
    id: 'phantom',
    name: 'Phantom',
    tagline: 'In the walls before the alarm finishes.',
    hpMul: 0.76,
    speedMul: 1.25,
    damageMul: 1.2,
    weaveSize: 4,
    chargeRateMul: 1.4,
    abilityPool: [
      'splinter',
      'blink',
      'void_mark',
      'ghostwalk',
      'phase_lance',
      'decoy_echo',
      'collapse',
    ],
    basicAttack: 'rift_slash',
    color: '#c46bff',
  },
};

/** Canonical display order for the role picker. */
export const ROLE_LIST: RoleDef[] = [
  ROLES.breaker,
  ROLES.bulwark,
  ROLES.conduit,
  ROLES.phantom,
];

/**
 * Starter loadouts. Each is a working cost ladder — one cheap circuit you can
 * keep re-firing, one mid-cost tool, one payoff — so a first-time player is
 * never stuck staring at a board that takes six seconds to do anything.
 */
const DEFAULT_LOADOUTS: Record<RoleId, AbilityId[]> = {
  //          1.2 chip        2.8 zone       4.8 payoff
  breaker: ['ord_round', 'thermite', 'siege_shell'],
  //          1.4 chip        3.2 shield     3.8 zone
  bulwark: ['slag_lob', 'bastion', 'gravity_well'],
  //          1.3 chip        2.8 heal       2.4 mark
  conduit: ['flux_bolt', 'mend_pulse', 'ion_tether'],
  //          1.0 chip        1.8 mark       3.8 payoff
  phantom: ['splinter', 'void_mark', 'collapse'],
};

/** How many entries of an untrusted loadout array we are willing to even look at. */
const MAX_SCANNED_ENTRIES = 64;

/** Runtime type guard for the protocol boundary — client `chooseRole` is untrusted. */
export function isRoleId(x: unknown): x is RoleId {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(ROLES, x);
}

/**
 * Look up a role. Falls back to `breaker` rather than throwing so a malformed
 * client message can never take down a room's tick loop. Validate with
 * `isRoleId` at the protocol boundary if you want to reject instead.
 */
export function getRole(id: RoleId): RoleDef {
  return isRoleId(id) ? ROLES[id] : ROLES.breaker;
}

/** A fresh copy of the role's starter loadout, always exactly ABILITY_SLOTS long. */
export function defaultLoadout(id: RoleId): AbilityId[] {
  const role = getRole(id);
  const base = DEFAULT_LOADOUTS[role.id];
  const out = base.slice(0, ABILITY_SLOTS);
  for (const abilityId of role.abilityPool) {
    if (out.length >= ABILITY_SLOTS) break;
    if (!out.includes(abilityId)) out.push(abilityId);
  }
  return out;
}

/**
 * Sanitize client input.
 *
 * Guarantees, for any input whatsoever (null, wrong type, junk strings, 10k
 * entries, duplicates, another role's abilities):
 *   - every returned id is legal for `role`
 *   - no duplicates
 *   - exactly ABILITY_SLOTS entries, padded from the default loadout then the pool
 *   - a brand new array; the caller can mutate it freely
 */
export function validateLoadout(role: RoleId, loadout: AbilityId[]): AbilityId[] {
  const roleDef = getRole(role);
  const legal = new Set<AbilityId>(roleDef.abilityPool);
  const out: AbilityId[] = [];
  const seen = new Set<AbilityId>();

  const push = (id: AbilityId): void => {
    if (out.length >= ABILITY_SLOTS || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  if (Array.isArray(loadout)) {
    const limit = Math.min(loadout.length, MAX_SCANNED_ENTRIES);
    for (let i = 0; i < limit && out.length < ABILITY_SLOTS; i++) {
      const raw: unknown = loadout[i];
      if (typeof raw !== 'string') continue;
      if (!legal.has(raw)) continue;
      push(raw);
    }
  }

  // Pad: preferred starter picks first, then anything else the role can run.
  for (const id of DEFAULT_LOADOUTS[roleDef.id]) push(id);
  for (const id of roleDef.abilityPool) push(id);

  return out;
}
