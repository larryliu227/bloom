/**
 * VOIDLINE — the co-op campaign, as data.
 *
 * Five chapters aboard Voidline Station. Each is a flat list of beats the co-op
 * mode handler walks in order. Nothing here executes: `server/modes/coop.ts`
 * interprets every beat kind.
 *
 * Voices:
 *   VESSEL      — the station's dying intelligence. Clipped. Increasingly small.
 *   LOG // KORR — fragments left by the runner who came before. Forty-five days.
 *   THE CHOIR   — the night shift. Plural. Still on duty.
 *   ???         — day forty-five.
 */

import type { Vec2 } from '@shared/types.js';
import { ARENA_H, ARENA_W } from '@shared/constants.js';
import type { DirectorConfig } from '../systems/director.js';

const CX = ARENA_W / 2;
const CY = ARENA_H / 2;

// ============================================================ beat vocabulary

export interface ScriptSpawn {
  archetype: string;
  count: number;
  /** Explicit placement; otherwise the director picks a rim point away from players. */
  at?: Vec2;
}

export type Beat =
  /** Queue a dialogue line. Non-blocking: play it over the fighting. */
  | { t: 'line'; speaker: string; text: string; ms?: number }
  /** Block until the dialogue queue has drained. */
  | { t: 'waitDialogue' }
  /** Block for a fixed number of seconds. */
  | { t: 'wait'; seconds: number }
  /** Set the HUD objective label. */
  | { t: 'objective'; label: string }
  /** One director wave. Completes when the arena is clear + the rest beat passes. */
  | { t: 'wave'; label?: string }
  /** Explicit spawn list. Completes when everything is dead. */
  | { t: 'script'; label?: string; spawns: ScriptSpawn[] }
  /** Place static coolant vents. They persist until cleared or destroyed. */
  | { t: 'hazard'; positions: Vec2[] }
  | { t: 'clearHazards' }
  /**
   * Cross-player relay seal. `participants` runners must simultaneously power a
   * relay tile on their own board for `hold` seconds of accumulated time.
   */
  | {
      t: 'relay';
      label: string;
      participants: number;
      hold: number;
      timeout: number;
      /** Pressure spawned while the seal is being routed. */
      live?: number;
      intensity?: number;
    }
  /** Defend the coolant shunt. Failure state: it reaches 0 hp. */
  | {
      t: 'defend';
      label: string;
      seconds: number;
      hp: number;
      at: Vec2;
      live: number;
      intensity: number;
    }
  /** Continuous pressure without an objective to protect. */
  | { t: 'sustain'; label: string; seconds: number; live: number; intensity: number }
  /** Spawn a boss and block until it dies. */
  | { t: 'boss'; archetype: string; label: string; at?: Vec2 }
  /**
   * The onboarding sequence from `./tutorial.ts`. Blocks until every step is
   * satisfied, timed out or skipped. A no-op on chapters `tutorialSteps`
   * returns null for, so it is always safe to leave in a beat list.
   */
  | { t: 'tutorial' }
  /** Restore downed runners and top everyone up. Act breaks only. */
  | { t: 'recover'; frac: number }
  /** Chapter cleared. */
  | { t: 'complete'; label: string };

export interface ChapterDef {
  id: number;
  name: string;
  subtitle: string;
  /** Design target, minutes, for a competent group of 3. */
  targetMinutes: [number, number];
  /** Runners drop in here; index by player slot. */
  spawnPoints: Vec2[];
  director: Partial<DirectorConfig>;
  beats: Beat[];
}

/** Beat kinds that count as a "wave" for the HUD wave counter. */
const COUNTED: ReadonlySet<Beat['t']> = new Set<Beat['t']>([
  'wave',
  'script',
  'relay',
  'defend',
  'sustain',
  'boss',
]);

export function countWaves(ch: ChapterDef): number {
  let n = 0;
  for (const b of ch.beats) if (COUNTED.has(b.t)) n++;
  return n;
}

export function isCountedBeat(b: Beat): boolean {
  return COUNTED.has(b.t);
}

// ============================================================ 1 — Docking Spine

const CHAPTER_1: ChapterDef = {
  id: 1,
  name: 'Docking Spine',
  subtitle: 'Nothing is wrong yet. That is the worst part.',
  // The tutorial beat is the first two of these minutes for a new runner and
  // almost none of them for a returning one, so the band is deliberately wide.
  targetMinutes: [6, 9],
  spawnPoints: [
    { x: 210, y: CY - 90 },
    { x: 210, y: CY + 90 },
    { x: 320, y: CY - 150 },
    { x: 320, y: CY + 150 },
  ],
  director: {
    chapter: 1,
    /*
     * High floor, shallow slope. Both halves of that matter and both were wrong.
     *
     * The floor: at `budgetBase: 9` the opening wave bought ~11 threat for four
     * runners — six husks, trickling in from the rim two at a time, deleted at
     * range before they closed. Measured over thirty seconds of real play, four
     * runners took 27 damage between them. A first wave is allowed to be gentle;
     * it is not allowed to be an empty room.
     *
     * The slope: `budgetPerWave: 5.0` across a shortened chapter put the last
     * wave at ~69 threat for three runners, which was the single heaviest wave
     * in the campaign — heavier than anything in the Coolant Gallery (58.7), the
     * Choir (52.8) or the Reactor Shell (43.5). The gentle tutorial chapter
     * peaked above every chapter that follows it, and hard against `maxLive`,
     * which flattened three runners and four into the same crowd.
     *
     * Now: ~15 threat at wave 1 rising to ~50 by wave 8 (three runners), so the
     * ramp into the Coolant Gallery stays a ramp, and the budget — not the cap —
     * decides how many bodies a head count sees.
     */
    budgetBase: 15,
    budgetPerWave: 2.2,
    chapterMul: 0.78,
    // Above the 4-runner peak (~30 bodies) so head count reaches the wire here
    // instead of being clipped; still far under MAX_LIVE_HARD.
    maxLive: 34,
    // Bodies arrive in overlapping groups instead of single file, and the gap
    // between waves is a breath rather than a lull. Delivery rate is presence;
    // it is not lethality, which is what `budgetBase`/`budgetPerWave` above set.
    restSeconds: 4.5,
    leadIn: 1.6,
    groupGap: [0.55, 1.1],
    groupSize: [2, 4],
    eliteEvery: 0,
    eliteFrom: 99,
    pool: [
      // Pulled forward one wave each: the chapter is seven waves and a hold now,
      // not nine, and the roster still has to introduce itself at the same
      // *fraction* of the way through rather than the same absolute wave number.
      { archetype: 'chaser', weight: 10 },
      /*
       * From wave 1, and heavier than it was. Husks have to cross the arena and
       * die on the walk in — with a melee-only opening wave a group of three is
       * not dodging, it is queueing. Spitters apply pressure from where they
       * stand, which is what makes routing under fire mean anything. The
       * onboarding sequence teaches the dash against a spitter windup, so this
       * is the first thing it taught them, arriving on schedule.
       */
      { archetype: 'spitter', weight: 6 },
      { archetype: 'splitter', weight: 3, minWave: 2 },
      { archetype: 'burster', weight: 3, minWave: 3 },
      { archetype: 'bulwark', weight: 2, minWave: 4, cap: 2 },
    ],
  },
  beats: [
    { t: 'objective', label: 'Bring the docking spine online' },
    // Head-count agnostic on purpose: co-op runs one to four runners.
    { t: 'line', speaker: 'VESSEL', text: 'Lattice handshake accepted. Heartbeats on the spine.', ms: 3000 },
    { t: 'line', speaker: 'VESSEL', text: 'Good. The last one came alone.', ms: 3200 },
    { t: 'waitDialogue' },

    /*
     * Onboarding. Gated on the player actually routing, not on a timer — see
     * `./tutorial.ts`. A group that already knows the Weave clears the whole
     * thing in well under a minute and the rest of the chapter is unchanged.
     */
    { t: 'tutorial' },

    { t: 'wave', label: 'Clear the spine — wave 1' },
    { t: 'line', speaker: 'VESSEL', text: 'Maintenance frames. They were told to keep the spine clear.', ms: 3600 },
    { t: 'line', speaker: 'VESSEL', text: 'They still are.', ms: 2600 },

    { t: 'wave', label: 'Clear the spine — wave 2' },
    { t: 'line', speaker: 'LOG // KORR', text: 'Day one. Station is cold. Lattice is warm.', ms: 3400 },
    { t: 'line', speaker: 'LOG // KORR', text: 'Something is still drawing power.', ms: 3000 },

    { t: 'wave', label: 'Clear the spine — wave 3' },
    {
      t: 'line',
      speaker: 'VESSEL',
      text: 'Do not stop routing. A slot that loses the core forgets what it was holding.',
      ms: 4200,
    },
    { t: 'line', speaker: 'LOG // KORR', text: 'Day four. I keep hearing the shift change bell.', ms: 3600 },
    { t: 'line', speaker: 'LOG // KORR', text: 'There is no shift.', ms: 2800 },

    { t: 'wave', label: 'Clear the spine — wave 4' },
    { t: 'line', speaker: 'LOG // KORR', text: 'Crew manifest says two hundred and six.', ms: 3200 },
    { t: 'line', speaker: 'LOG // KORR', text: 'I have found nine bodies.', ms: 3000 },

    { t: 'wave', label: 'Clear the spine — wave 5' },
    { t: 'line', speaker: 'VESSEL', text: 'Reactor output eleven percent. Falling.', ms: 3200 },
    { t: 'line', speaker: 'VESSEL', text: 'You did not ask. I am telling you anyway.', ms: 3400 },
    { t: 'line', speaker: 'LOG // KORR', text: 'Day six. I named the frames. That was a mistake.', ms: 3600 },

    /*
     * The hold. The tutorial beat cost this chapter two waves and gives back
     * about forty seconds, so one of them comes back here — as the sustained
     * beat the chapter never had.
     *
     * Measured over a full run, chapter 1 kept 1.5 hostiles alive on average
     * against every other chapter's 5 to 7, and under one within 500 units of a
     * runner. Eight short waves are eight bursts separated by rest: a group of
     * three deleted each one in seconds and then stood in an empty room. This is
     * the single stretch of the chapter that does not stop.
     *
     * `live: 10` is the lowest ceiling of any sustain in the campaign — six
     * bodies for a solo runner, thirteen for four — so it can never become a
     * crowd, and a first-timer simply sits at that ceiling exactly as they would
     * have at any intensity. The intensity is what a competent group feels: it
     * sets how fast the director replaces what they just killed, which is the
     * only knob in here that answers skill rather than head count.
     */
    { t: 'sustain', label: 'Hold the spine', seconds: 50, live: 10, intensity: 1.2 },
    { t: 'line', speaker: 'LOG // KORR', text: 'Day seven. I sleep in the conduit runs now. It is warmer.', ms: 3800 },

    { t: 'wave', label: 'Clear the spine — wave 6' },
    { t: 'line', speaker: 'VESSEL', text: 'You are getting good at this. I want you to know that worries me.', ms: 4200 },

    { t: 'wave', label: 'Clear the spine — wave 7' },
    { t: 'line', speaker: 'VESSEL', text: 'Something heavier just undocked itself.', ms: 3200 },

    {
      t: 'script',
      label: 'Hold the airlock',
      spawns: [
        { archetype: 'bulwark', count: 2 },
        { archetype: 'spitter', count: 3 },
        { archetype: 'chaser', count: 6 },
        { archetype: 'splitter', count: 2 },
      ],
    },

    { t: 'recover', frac: 0.6 },
    { t: 'line', speaker: 'VESSEL', text: 'Docking spine clear. Nothing else wants it.', ms: 3400 },
    { t: 'line', speaker: 'VESSEL', text: 'Deeper in, things want.', ms: 3000 },
    { t: 'waitDialogue' },
    { t: 'complete', label: 'DOCKING SPINE SECURED' },
  ],
};

// ============================================================ 2 — Coolant Gallery

const VENTS_2: Vec2[] = [
  { x: 380, y: 300 },
  { x: 1220, y: 300 },
  { x: 380, y: 900 },
  { x: 1220, y: 900 },
  { x: CX, y: 210 },
  { x: CX, y: 990 },
];

const CHAPTER_2: ChapterDef = {
  id: 2,
  name: 'Coolant Gallery',
  subtitle: 'A dead cell does not come back.',
  targetMinutes: [9, 10],
  spawnPoints: [
    { x: 260, y: ARENA_H - 240 },
    { x: 380, y: ARENA_H - 200 },
    { x: 260, y: ARENA_H - 360 },
    { x: 400, y: ARENA_H - 330 },
  ],
  director: {
    chapter: 2,
    budgetBase: 8,
    budgetPerWave: 3.4,
    chapterMul: 0.95,
    maxLive: 34,
    restSeconds: 6.5,
    leadIn: 1.8,
    groupGap: [0.6, 1.2],
    groupSize: [2, 4],
    eliteEvery: 4,
    eliteFrom: 5,
    pool: [
      { archetype: 'chaser', weight: 9 },
      { archetype: 'spitter', weight: 6 },
      { archetype: 'splitter', weight: 4 },
      { archetype: 'burster', weight: 3 },
      { archetype: 'sapper', weight: 5, minWave: 1, cap: 3 },
      { archetype: 'bulwark', weight: 3, minWave: 2, cap: 3 },
      { archetype: 'turret', weight: 3, minWave: 3, cap: 2 },
    ],
  },
  beats: [
    { t: 'objective', label: 'Purge the coolant gallery' },
    { t: 'line', speaker: 'VESSEL', text: 'Coolant gallery. Mind the vents.', ms: 3000 },
    { t: 'line', speaker: 'VESSEL', text: 'They still think they are cooling something.', ms: 3400 },
    { t: 'hazard', positions: VENTS_2.slice(0, 4) },
    { t: 'wait', seconds: 2.0 },

    { t: 'wave', label: 'Purge the gallery — wave 1' },
    /*
     * The chapter-1 onboarding sequence says 'New shape on the lattice. It is
     * not going for your body.' the first time an Unraveller shows up, so this
     * beat must not repeat it verbatim — but it still has to teach cold, because
     * the lobby lets a group start here having never played chapter 1.
     */
    { t: 'line', speaker: 'VESSEL', text: 'Unravellers in the gallery. They want the board, not the body.', ms: 4000 },

    {
      t: 'script',
      label: 'Kill the Unraveller',
      spawns: [
        { archetype: 'sapper', count: 1 },
        { archetype: 'chaser', count: 4 },
      ],
    },
    { t: 'line', speaker: 'VESSEL', text: 'It eats conduit. Blocked cells do not heal.', ms: 3600 },
    { t: 'line', speaker: 'VESSEL', text: 'There are more of them in here. Count what you have left.', ms: 3800 },

    { t: 'wave', label: 'Purge the gallery — wave 2' },
    { t: 'line', speaker: 'LOG // KORR', text: 'Day nine. Lost two cells today.', ms: 3200 },
    { t: 'line', speaker: 'LOG // KORR', text: 'I can still fire. I just have to think harder.', ms: 3600 },
    { t: 'line', speaker: 'LOG // KORR', text: 'I do not like thinking harder.', ms: 3000 },

    { t: 'wave', label: 'Purge the gallery — wave 3' },
    { t: 'hazard', positions: VENTS_2.slice(4) },
    { t: 'line', speaker: 'VESSEL', text: 'Two more vents just woke up. I did not do that.', ms: 3600 },

    { t: 'wave', label: 'Purge the gallery — wave 4' },
    { t: 'line', speaker: 'LOG // KORR', text: 'Day fourteen. Board is half dead. So am I.', ms: 3600 },
    { t: 'line', speaker: 'LOG // KORR', text: 'The station keeps offering to help.', ms: 3200 },
    { t: 'line', speaker: 'VESSEL', text: 'I did not offer.', ms: 2600 },

    { t: 'wave', label: 'Purge the gallery — wave 5' },
    { t: 'sustain', label: 'Hold the gallery floor', seconds: 62, live: 16, intensity: 1.05 },
    { t: 'line', speaker: 'VESSEL', text: 'Pressure in the return line. Something is pushing back.', ms: 3400 },

    { t: 'wave', label: 'Purge the gallery — wave 6' },
    { t: 'line', speaker: 'LOG // KORR', text: 'Day twenty. It is not a bell.', ms: 3000 },
    { t: 'line', speaker: 'LOG // KORR', text: 'It is singing.', ms: 2800 },

    {
      t: 'script',
      label: 'Break the coolant lock',
      spawns: [
        { archetype: 'elite', count: 1 },
        { archetype: 'sapper', count: 2 },
        { archetype: 'turret', count: 2 },
        { archetype: 'bulwark', count: 2 },
        { archetype: 'chaser', count: 6 },
      ],
    },

    { t: 'clearHazards' },
    { t: 'recover', frac: 0.6 },
    { t: 'line', speaker: 'VESSEL', text: 'Gallery clear. The singing is louder from here.', ms: 3600 },
    { t: 'line', speaker: 'VESSEL', text: 'I would rather you did not go.', ms: 3000 },
    { t: 'waitDialogue' },
    { t: 'complete', label: 'COOLANT GALLERY PURGED' },
  ],
};

// ============================================================ 3 — The Choir

const CHAPTER_3: ChapterDef = {
  id: 3,
  name: 'The Choir',
  subtitle: 'The seal takes two circuits. They built it that way after.',
  targetMinutes: [10, 12],
  spawnPoints: [
    { x: CX - 140, y: ARENA_H - 200 },
    { x: CX + 140, y: ARENA_H - 200 },
    { x: CX - 300, y: ARENA_H - 260 },
    { x: CX + 300, y: ARENA_H - 260 },
  ],
  director: {
    chapter: 3,
    budgetBase: 9,
    budgetPerWave: 3.6,
    chapterMul: 1.1,
    maxLive: 38,
    restSeconds: 6.0,
    leadIn: 1.6,
    groupGap: [0.55, 1.1],
    groupSize: [2, 4],
    eliteEvery: 3,
    eliteFrom: 3,
    pool: [
      { archetype: 'chaser', weight: 8 },
      { archetype: 'spitter', weight: 6 },
      { archetype: 'splitter', weight: 5 },
      { archetype: 'burster', weight: 4 },
      { archetype: 'sapper', weight: 4, cap: 3 },
      { archetype: 'bulwark', weight: 4, cap: 3 },
      { archetype: 'turret', weight: 3, cap: 3 },
    ],
  },
  beats: [
    { t: 'objective', label: 'Reach the choir deck' },
    { t: 'line', speaker: 'VESSEL', text: 'Crew deck. Night shift quarters.', ms: 3000 },
    {
      t: 'line',
      speaker: 'VESSEL',
      text: 'This is where they stopped being separate people.',
      ms: 3600,
    },
    { t: 'wait', seconds: 2.0 },

    { t: 'wave', label: 'Push through the deck — wave 1' },
    { t: 'line', speaker: 'THE CHOIR', text: 'we kept the reactor warm.', ms: 3000 },
    { t: 'line', speaker: 'THE CHOIR', text: 'we are still keeping it warm.', ms: 3200 },

    { t: 'wave', label: 'Push through the deck — wave 2' },
    {
      t: 'line',
      speaker: 'VESSEL',
      text: 'Bulkhead seal ahead. It reads two circuits, not one.',
      ms: 3800,
    },
    {
      t: 'line',
      speaker: 'VESSEL',
      text: 'Two of you power a relay cell. At the same time. Hold it.',
      ms: 4000,
    },

    {
      t: 'relay',
      label: 'RELAY SEAL — two runners must hold power together',
      participants: 2,
      hold: 9,
      timeout: 55,
      live: 10,
      intensity: 0.85,
    },
    { t: 'line', speaker: 'VESSEL', text: 'Seal open. That is the first time in four years.', ms: 3600 },

    { t: 'wave', label: 'Push through the deck — wave 3' },
    {
      t: 'line',
      speaker: 'LOG // KORR',
      text: 'Day thirty-one. Tried the seal alone for six hours.',
      ms: 3800,
    },
    { t: 'line', speaker: 'LOG // KORR', text: 'It needs two. I have been alone since day one.', ms: 4000 },

    { t: 'wave', label: 'Push through the deck — wave 4' },
    { t: 'line', speaker: 'THE CHOIR', text: 'he sang flat. we forgave him.', ms: 3400 },

    {
      t: 'relay',
      label: 'INNER SEAL — hold the shared circuit',
      participants: 2,
      hold: 13,
      timeout: 70,
      live: 16,
      intensity: 1.15,
    },

    { t: 'recover', frac: 0.7 },
    { t: 'line', speaker: 'VESSEL', text: 'Inner seal open. It is standing up.', ms: 3200 },
    { t: 'line', speaker: 'THE CHOIR', text: 'you brought FRIENDS.', ms: 3000 },
    { t: 'wait', seconds: 2.2 },

    { t: 'boss', archetype: 'choirmaster', label: 'THE CHOIRMASTER', at: { x: CX, y: 300 } },

    { t: 'line', speaker: 'THE CHOIR', text: '...it is quiet.', ms: 3200 },
    { t: 'line', speaker: 'THE CHOIR', text: '...oh.', ms: 2800 },
    { t: 'wait', seconds: 1.5 },
    { t: 'line', speaker: 'VESSEL', text: 'Two hundred and six voices. Now none.', ms: 3600 },
    { t: 'line', speaker: 'VESSEL', text: 'Reactor shell is next.', ms: 2800 },
    { t: 'line', speaker: 'VESSEL', text: 'I would like to be wrong about what is in there.', ms: 3800 },
    { t: 'waitDialogue' },
    { t: 'complete', label: 'THE CHOIR SILENCED' },
  ],
};

// ============================================================ 4 — Reactor Shell

const SHUNT_POS: Vec2 = { x: CX, y: CY };

const CHAPTER_4: ChapterDef = {
  id: 4,
  name: 'Reactor Shell',
  subtitle: 'If the shunt falls, the shell goes with it.',
  targetMinutes: [10, 12],
  // Deliberately inside SHUNT_GUARD_RADIUS: this chapter is about standing on
  // the thing you are protecting, so it drops you there.
  spawnPoints: [
    { x: CX - 150, y: CY + 170 },
    { x: CX + 150, y: CY + 170 },
    { x: CX - 190, y: CY - 140 },
    { x: CX + 190, y: CY - 140 },
  ],
  director: {
    chapter: 4,
    budgetBase: 11,
    budgetPerWave: 4.0,
    chapterMul: 1.25,
    maxLive: 40,
    restSeconds: 5.5,
    leadIn: 1.5,
    groupGap: [0.5, 1.0],
    groupSize: [3, 5],
    eliteEvery: 3,
    eliteFrom: 2,
    pool: [
      { archetype: 'chaser', weight: 8 },
      { archetype: 'spitter', weight: 6 },
      { archetype: 'splitter', weight: 5 },
      { archetype: 'burster', weight: 5 },
      { archetype: 'sapper', weight: 4, cap: 4 },
      { archetype: 'bulwark', weight: 5, cap: 4 },
      { archetype: 'turret', weight: 3, cap: 3 },
    ],
  },
  beats: [
    { t: 'objective', label: 'Reach the coolant shunt' },
    { t: 'line', speaker: 'VESSEL', text: 'Reactor shell. The shunt is the only thing holding it.', ms: 4000 },
    { t: 'line', speaker: 'LOG // KORR', text: 'Day forty. Welded that shunt myself.', ms: 3200 },
    { t: 'line', speaker: 'LOG // KORR', text: 'It will hold. It has to hold.', ms: 3000 },
    { t: 'wait', seconds: 2.0 },

    { t: 'wave', label: 'Clear the shell floor — wave 1' },
    { t: 'wave', label: 'Clear the shell floor — wave 2' },

    { t: 'line', speaker: 'VESSEL', text: 'They have found the shunt. They will go for it, not you.', ms: 4200 },
    { t: 'wait', seconds: 1.6 },

    {
      t: 'defend',
      label: 'DEFEND THE COOLANT SHUNT',
      seconds: 105,
      hp: 2800,
      at: SHUNT_POS,
      live: 15,
      intensity: 0.95,
    },
    { t: 'recover', frac: 0.45 },
    { t: 'line', speaker: 'VESSEL', text: 'Shunt holding. Hull temperature climbing.', ms: 3400 },

    { t: 'wave', label: 'Clear the shell floor — wave 3' },
    { t: 'line', speaker: 'LOG // KORR', text: 'Day forty-four. The reactor asked me a question.', ms: 3800 },
    { t: 'line', speaker: 'LOG // KORR', text: 'I have not answered yet.', ms: 3000 },

    {
      t: 'defend',
      label: 'DEFEND THE COOLANT SHUNT — SURGE',
      seconds: 130,
      hp: 4200,
      at: SHUNT_POS,
      live: 19,
      intensity: 1.1,
    },
    { t: 'recover', frac: 0.5 },
    { t: 'line', speaker: 'VESSEL', text: 'I have lost the outer ring. I am smaller now.', ms: 3600 },

    {
      t: 'script',
      label: 'Break the shell assault',
      spawns: [
        { archetype: 'elite', count: 2 },
        { archetype: 'bulwark', count: 3 },
        { archetype: 'turret', count: 3 },
        { archetype: 'sapper', count: 3 },
        { archetype: 'spitter', count: 4 },
        { archetype: 'chaser', count: 8 },
      ],
    },

    { t: 'recover', frac: 0.65 },
    { t: 'line', speaker: 'VESSEL', text: 'Shell secure. Shunt at forty percent and I will take it.', ms: 4000 },
    { t: 'line', speaker: 'VESSEL', text: 'The core is aware of you now.', ms: 3200 },
    { t: 'line', speaker: '???', text: 'you routed so well.', ms: 3400 },
    { t: 'waitDialogue' },
    { t: 'complete', label: 'REACTOR SHELL HELD' },
  ],
};

// ============================================================ 5 — The Fracture

const CHAPTER_5: ChapterDef = {
  id: 5,
  name: 'The Fracture',
  subtitle: 'Day forty-five.',
  targetMinutes: [10, 12],
  spawnPoints: [
    { x: CX - 150, y: ARENA_H - 210 },
    { x: CX + 150, y: ARENA_H - 210 },
    { x: CX - 330, y: ARENA_H - 280 },
    { x: CX + 330, y: ARENA_H - 280 },
  ],
  director: {
    chapter: 5,
    budgetBase: 12,
    budgetPerWave: 4.2,
    chapterMul: 1.35,
    maxLive: 40,
    restSeconds: 5.0,
    leadIn: 1.4,
    groupGap: [0.45, 0.95],
    groupSize: [3, 5],
    eliteEvery: 2,
    eliteFrom: 1,
    pool: [
      { archetype: 'chaser', weight: 7 },
      { archetype: 'spitter', weight: 6 },
      { archetype: 'splitter', weight: 5 },
      { archetype: 'burster', weight: 6 },
      { archetype: 'sapper', weight: 5, cap: 4 },
      { archetype: 'bulwark', weight: 5, cap: 4 },
      { archetype: 'turret', weight: 4, cap: 3 },
    ],
  },
  beats: [
    { t: 'objective', label: 'Descend to the reactor core' },
    { t: 'line', speaker: 'VESSEL', text: 'Reactor core. What is left of it.', ms: 3200 },
    { t: 'line', speaker: '???', text: 'day forty-five.', ms: 3000 },
    { t: 'line', speaker: 'VESSEL', text: 'That is not a log.', ms: 2800 },
    { t: 'wait', seconds: 2.4 },

    { t: 'wave', label: 'Cut through the core stairs — wave 1' },
    { t: 'line', speaker: '???', text: 'it asked if i wanted to stop being one thing.', ms: 4000 },

    { t: 'wave', label: 'Cut through the core stairs — wave 2' },
    { t: 'line', speaker: '???', text: 'i answered.', ms: 2800 },

    { t: 'sustain', label: 'Hold the core stairs', seconds: 58, live: 24, intensity: 1.25 },
    { t: 'recover', frac: 0.75 },
    { t: 'line', speaker: 'VESSEL', text: 'Containment field is gone. It is standing in the gap.', ms: 4000 },
    { t: 'wait', seconds: 2.0 },

    { t: 'boss', archetype: 'fracture', label: 'THE FRACTURE', at: { x: CX, y: 320 } },

    { t: 'line', speaker: 'THE FRACTURE', text: '...tell them the shift is over.', ms: 4000 },
    { t: 'wait', seconds: 2.0 },
    { t: 'line', speaker: 'VESSEL', text: 'Reactor is unrecoverable. I have run it eleven thousand times.', ms: 4200 },
    { t: 'line', speaker: 'VESSEL', text: 'I can hold the collapse for ninety seconds.', ms: 3400 },
    { t: 'line', speaker: 'VESSEL', text: 'Route your cores through me and go.', ms: 3400 },
    { t: 'wait', seconds: 1.6 },
    { t: 'line', speaker: 'VESSEL', text: 'Lattice releasing. You are un-jacked.', ms: 3200 },
    { t: 'line', speaker: 'VESSEL', text: 'Manifest: two hundred and six. Two hundred and seven.', ms: 4200 },
    { t: 'line', speaker: 'VESSEL', text: 'Voidline Station, signing off the shift.', ms: 4000 },
    { t: 'waitDialogue' },
    { t: 'complete', label: 'VOIDLINE STATION — SHIFT ENDED' },
  ],
};

// ============================================================ registry

export const CHAPTERS: ChapterDef[] = [CHAPTER_1, CHAPTER_2, CHAPTER_3, CHAPTER_4, CHAPTER_5];
export const CHAPTER_COUNT = CHAPTERS.length;

export function getChapter(n: number): ChapterDef {
  const idx = Math.max(1, Math.min(CHAPTER_COUNT, Math.floor(n || 1))) - 1;
  return CHAPTERS[idx];
}

/** Short blurb list for the lobby's chapter picker. */
export const CHAPTER_SUMMARY: Array<{ id: number; name: string; subtitle: string }> = CHAPTERS.map(
  (c) => ({ id: c.id, name: c.name, subtitle: c.subtitle }),
);
