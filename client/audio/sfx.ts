/**
 * VOIDLINE — the sound registry.
 *
 * Maps every game moment to a synthesized voice. One class, no state beyond the
 * sustained Weave layers (which are the only nodes here that outlive a single
 * event, because a charging circuit is a *continuous* sound and must be).
 */

import type { AbilityId, AbilityShape, EntityKind, Vec2 } from '@shared/types.js';
import { getAbility } from '@shared/abilities.js';

import type { AudioEngine, PlayOpts, Voice } from './engine.js';
import { clamp, clamp01 } from './engine.js';
import { clang, fmBlip, hashStr, noiseBurst, semi, shimmer, sweep, thump } from './synth.js';

/** Start the same voice later without reserving a second pool slot. */
function off(v: Voice, dt: number): Voice {
  return { ...v, t: v.t + dt };
}

/** Scale a layer's share of the voice's amplitude budget. */
function lvl(v: Voice, k: number): Voice {
  return { ...v, amp: v.amp * k };
}

/** Minor-pentatonic degrees, in semitones. Everything pitched lands on these. */
const PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];

/** Per-shape voice character. Base pitch is refined by the ability id's hash. */
const SHAPE_BASE: Record<AbilityShape, number> = {
  projectile: 330,
  beam: 520,
  aoe: 165,
  dash: 260,
  buff: 440,
  summon: 196,
  zone: 220,
};

export type UiSound = 'hover' | 'click' | 'back' | 'ready' | 'toggle' | 'deny';
export type StingKind = 'start' | 'victory' | 'defeat';

export class Sfx {
  private eng: AudioEngine;

  // --- weave rotation: consecutive clicks walk up a scale so spam sounds musical
  private rotStep = 0;
  private rotAt = 0;
  private rotDir = 1;

  // --- sustained weave layers, built on first use
  private weaveBuilt = false;
  private hums: SustainLayer[] = [];
  private flows: SustainLayer[] = [];
  private humFrac: number[] = [0, 0, 0];
  private humOn: number[] = [0, 0, 0];

  constructor(engine: AudioEngine) {
    this.eng = engine;
  }

  /** Reserve a voice, build it, and close it at its own tail. */
  private one(opts: PlayOpts, build: (v: Voice) => number): void {
    const v = this.eng.play(opts);
    if (!v) return;
    try {
      v.end(build(v));
    } catch (err) {
      console.warn('[audio] voice failed', err);
      try {
        v.end(v.t + 0.4);
      } catch {
        /* nothing left to do */
      }
    }
  }

  /** Deterministic pitch for an ability: a pentatonic degree off its shape's base. */
  private abilityPitch(shape: AbilityShape, id: AbilityId): number {
    const h = hashStr(id || shape);
    const degree = PENTA[Math.floor(h * 6) % PENTA.length];
    return SHAPE_BASE[shape] * semi(degree - 3);
  }

  private shapeOf(id: AbilityId): AbilityShape {
    try {
      const def = getAbility(id);
      if (def?.shape) return def.shape;
    } catch {
      /* content module not loaded — fall through */
    }
    return 'projectile';
  }

  // ================================================================ casting

  cast(id: AbilityId, pos: Vec2 | null, shapeHint?: AbilityShape): void {
    const shape = shapeHint ?? this.shapeOf(id);
    const f = this.abilityPitch(shape, id);
    const seed = Math.floor(hashStr(id) * 1e6) | 0;
    const base: PlayOpts = { pos, key: `cast:${id}`, minInterval: 0.035, gain: 0.9 };

    switch (shape) {
      // Dry, short, forward. A gun, not a spell.
      case 'projectile':
        this.one({ ...base, reverb: 0.12, delay: 0.04 }, (v) => {
          const a = fmBlip(lvl(v, 1), { freq: f * 2, to: f * 1.1, ratio: 3.2, index: 2.4, dur: 0.13, gain: 0.34 });
          const b = noiseBurst(lvl(v, 0.7), { freq: 2400, to: 760, dur: 0.075, q: 0.9, gain: 0.3 });
          return Math.max(a, b);
        });
        break;

      // A hard ignition, then a bright resonant hold that keeps ringing.
      case 'beam':
        this.one({ ...base, reverb: 0.3, delay: 0.2 }, (v) => {
          const a = sweep(lvl(v, 0.8), { from: f * 0.45, to: f * 2.1, dur: 0.075, type: 'sawtooth', q: 7, gain: 0.26 });
          const b = fmBlip(off(lvl(v, 1), 0.05), { freq: f * 2, ratio: 1.5, index: 0.8, dur: 0.34, gain: 0.3, type: 'triangle' });
          const c = noiseBurst(off(lvl(v, 0.55), 0.04), { type: 'highpass', freq: 1100, dur: 0.3, q: 0.6, gain: 0.22 });
          return Math.max(a, b, c);
        });
        break;

      // Weight first: sub drop, dark noise bloom, a little debris ring.
      case 'aoe':
        this.one({ ...base, reverb: 0.34, delay: 0.1, priority: 1 }, (v) => {
          const a = thump(lvl(v, 1), { freq: f, to: f * 0.28, dur: 0.5, gain: 0.66, click: 0.5 });
          const b = noiseBurst(lvl(v, 0.85), { type: 'lowpass', freq: 1100, to: 180, dur: 0.44, q: 0.5, gain: 0.5 });
          const c = clang(off(lvl(v, 0.4), 0.02), { base: f * 3.2, count: 3, warp: 0.3, dur: 0.3, gain: 0.14, seed });
          return Math.max(a, b, c);
        });
        break;

      // Air moving: up-whoosh into a down-whoosh, with a pitch drop underneath.
      case 'dash':
        this.one({ ...base, reverb: 0.2 }, (v) => {
          const a = noiseBurst(lvl(v, 0.8), { freq: 320, to: 2800, dur: 0.1, q: 1.7, gain: 0.34 });
          const b = noiseBurst(off(lvl(v, 0.7), 0.085), { freq: 2800, to: 300, dur: 0.24, q: 1.4, gain: 0.3 });
          const c = fmBlip(lvl(v, 0.6), { freq: f * 1.6, to: f * 0.6, ratio: 1.4, index: 1.2, dur: 0.18, gain: 0.2 });
          return Math.max(a, b, c);
        });
        break;

      // Consonant and rising — the only shape allowed to sound *nice*.
      case 'buff':
        this.one({ ...base, reverb: 0.36, delay: 0.12 }, (v) => {
          const a = fmBlip(lvl(v, 1), { freq: f, to: f * semi(7), ratio: 1.5, index: 0.6, dur: 0.3, gain: 0.28, type: 'triangle' });
          const b = shimmer(off(lvl(v, 0.9), 0.05), { freq: f * 4, count: 8, dur: 0.55, spread: 9, drift: 7, gain: 0.16, seed });
          return Math.max(a, b);
        });
        break;

      // Something arrives: a low knock and a warped bell falling away.
      case 'summon':
        this.one({ ...base, reverb: 0.42, delay: 0.1, priority: 1 }, (v) => {
          const a = thump(lvl(v, 0.9), { freq: f * 0.6, to: f * 0.22, dur: 0.4, gain: 0.5, click: 0.25 });
          const b = clang(off(lvl(v, 1), 0.03), { base: f * 1.5, count: 6, warp: 0.34, dur: 0.75, gain: 0.22, seed });
          const c = shimmer(off(lvl(v, 0.7), 0.08), { freq: f * 6, count: 7, dur: 0.6, spread: 7, drift: -8, gain: 0.11, seed: seed ^ 99 });
          return Math.max(a, b, c);
        });
        break;

      // Ground opening up: slow, wide, and it hangs around.
      case 'zone':
        this.one({ ...base, reverb: 0.48, delay: 0.24, priority: 1 }, (v) => {
          const a = sweep(lvl(v, 0.9), { from: f * 1.5, to: f * 0.65, dur: 0.55, type: 'sawtooth', q: 4, gain: 0.24, detune: -18 });
          const b = noiseBurst(lvl(v, 0.8), { type: 'lowpass', freq: 620, to: 240, dur: 0.65, q: 0.7, gain: 0.32 });
          const c = thump(lvl(v, 0.6), { freq: f * 0.5, to: f * 0.2, dur: 0.35, gain: 0.4 });
          return Math.max(a, b, c);
        });
        break;
    }
  }

  // ================================================================ impacts

  /**
   * Timbre and pitch both track damage: a graze is a bright dry tick, a heavy
   * landing is dark, low and has a body behind it. Crits add ringing metal.
   */
  hit(pos: Vec2 | null, damage: number, crit: boolean): void {
    const d = clamp01(Math.abs(damage) / 45);
    this.one(
      {
        pos,
        key: crit ? 'crit' : 'hit',
        minInterval: crit ? 0.02 : 0.028,
        gain: 0.55 + 0.45 * d,
        reverb: 0.1 + 0.2 * d,
        priority: crit ? 1 : 0,
      },
      (v) => {
        // Noise centre falls as damage rises — that darkening *is* the weight.
        const centre = 3000 - 1800 * d;
        const a = noiseBurst(lvl(v, 1), {
          freq: centre,
          to: centre * 0.3,
          dur: 0.06 + 0.11 * d,
          q: 0.8 + 1.4 * (1 - d),
          gain: 0.3 + 0.26 * d,
        });
        const b = fmBlip(lvl(v, 0.8), {
          freq: 260 * (1 - 0.42 * d),
          to: 150 * (1 - 0.4 * d),
          ratio: 1.8,
          index: 3 + 2 * d,
          dur: 0.055 + 0.09 * d,
          gain: 0.3,
        });
        let end = Math.max(a, b);
        if (d > 0.4) {
          end = Math.max(end, thump(lvl(v, 0.7 * d), { freq: 96, to: 40, dur: 0.16 + 0.16 * d, gain: 0.5 }));
        }
        if (crit) {
          end = Math.max(
            end,
            clang(off(lvl(v, 0.75), 0.006), { base: 940, count: 4, warp: 0.22, dur: 0.38, gain: 0.2, seed: (damage * 977) | 0 }),
            noiseBurst(lvl(v, 0.6), { type: 'highpass', freq: 5200, dur: 0.09, q: 0.7, gain: 0.26 }),
            fmBlip(off(lvl(v, 0.5), 0.02), { freq: 700, to: 1500, ratio: 2.5, index: 1.4, dur: 0.14, gain: 0.18 }),
          );
        }
        return end;
      },
    );
  }

  /** A runner going down is a system failure; an enemy dying is scrap. */
  death(pos: Vec2 | null, kind: EntityKind): void {
    if (kind === 'player') {
      this.one({ pos, gain: 1, reverb: 0.55, delay: 0.2, priority: 2 }, (v) => {
        const a = sweep(lvl(v, 1), { from: 440, to: 62, dur: 1.15, type: 'sawtooth', detune: -26, q: 4, gain: 0.3, attack: 0.01 });
        const b = noiseBurst(lvl(v, 0.85), { type: 'lowpass', freq: 1500, to: 130, dur: 0.95, q: 0.6, gain: 0.36 });
        const c = thump(lvl(v, 0.9), { freq: 130, to: 34, dur: 0.6, gain: 0.6, click: 0.45 });
        const e = clang(off(lvl(v, 0.5), 0.14), { base: 210, count: 5, warp: 0.4, dur: 0.9, gain: 0.16, seed: 4242 });
        return Math.max(a, b, c, e);
      });
      return;
    }
    if (kind === 'enemy' || kind === 'summon') {
      this.one({ pos, gain: 0.9, reverb: 0.26, priority: 1, key: 'death', minInterval: 0.04 }, (v) => {
        const a = noiseBurst(lvl(v, 1), { freq: 1600, to: 210, dur: 0.3, q: 0.55, gain: 0.44 });
        const b = clang(lvl(v, 0.8), { base: 300, count: 5, warp: 0.38, dur: 0.45, gain: 0.22, seed: 1337 });
        const c = thump(lvl(v, 0.7), { freq: 112, to: 42, dur: 0.24, gain: 0.44, click: 0.3 });
        return Math.max(a, b, c);
      });
      return;
    }
    // Projectiles, zones, props expiring: a soft puff, first to be culled.
    this.one({ pos, gain: 0.5, priority: 0, key: 'fizz', minInterval: 0.05 }, (v) =>
      noiseBurst(v, { freq: 1900, to: 620, dur: 0.09, q: 1.4, gain: 0.2 }),
    );
  }

  /** Movement dash — length of the whoosh follows the distance travelled. */
  dash(from: Vec2, to: Vec2): void {
    const dist = clamp(Math.hypot(to.x - from.x, to.y - from.y), 40, 700);
    const k = dist / 700;
    this.one({ pos: from, gain: 0.85, reverb: 0.22, key: 'dash', minInterval: 0.06 }, (v) => {
      const dur = 0.1 + 0.14 * k;
      const a = noiseBurst(lvl(v, 0.9), { freq: 300, to: 2600 + 900 * k, dur, q: 1.8, gain: 0.34 });
      const b = noiseBurst(off(lvl(v, 0.8), dur * 0.85), { freq: 2600, to: 260, dur: 0.2 + 0.16 * k, q: 1.3, gain: 0.3 });
      const c = fmBlip(lvl(v, 0.55), { freq: 420, to: 150, ratio: 1.3, index: 1.4, dur: 0.2, gain: 0.2 });
      return Math.max(a, b, c);
    });
  }

  /** Somebody is back on their feet. Deliberately warm and resolving. */
  revive(pos: Vec2 | null): void {
    this.one({ pos, gain: 1, reverb: 0.45, delay: 0.14, priority: 2 }, (v) => {
      const a = sweep(lvl(v, 0.7), { from: 170, to: 700, dur: 0.72, type: 'triangle', q: 5, gain: 0.22 });
      let end = a;
      const root = 392;
      [0, 4, 7, 12].forEach((s, i) => {
        end = Math.max(
          end,
          fmBlip(off(lvl(v, 0.7), 0.16 + i * 0.09), { freq: root * semi(s), ratio: 2, index: 0.7, dur: 0.42, gain: 0.2, type: 'triangle' }),
        );
      });
      return Math.max(end, shimmer(off(lvl(v, 0.9), 0.3), { freq: root * 4, count: 10, dur: 0.7, spread: 10, drift: 6, gain: 0.14, seed: 7 }));
    });
  }

  /** Objective banner: two low stabs, wide reverb. The station noticing you. */
  objective(): void {
    this.one({ bus: 'ui', gain: 1, reverb: 0.6, delay: 0.18, priority: 2, key: 'obj', minInterval: 0.6 }, (v) => {
      const a = fmBlip(lvl(v, 1), { freq: 110, ratio: 2.02, index: 2.2, dur: 0.6, gain: 0.34, type: 'triangle' });
      const b = fmBlip(off(lvl(v, 0.8), 0.19), { freq: 164.8, ratio: 2.02, index: 1.8, dur: 0.8, gain: 0.3, type: 'triangle' });
      const c = clang(off(lvl(v, 0.4), 0.02), { base: 880, count: 3, warp: 0.1, dur: 0.7, gain: 0.1, seed: 5 });
      return Math.max(a, b, c);
    });
  }

  /**
   * Dialogue voice-blip: not speech, a transmission artefact. The speaker's name
   * hashes into pitch, timbre and syllable count, so each character is
   * recognisable without a single recorded sample.
   */
  dialogue(speaker: string): void {
    const h = hashStr(speaker || 'STATION');
    const base = 220 + h * 460;
    const ratio = 1.3 + ((h * 7) % 1) * 1.9;
    const count = 3 + Math.floor(((h * 13) % 1) * 3);
    this.one({ bus: 'ui', gain: 0.7, reverb: 0.3, priority: 1, key: 'dlg', minInterval: 0.12 }, (v) => {
      let end = v.t;
      let step = 0;
      for (let i = 0; i < count; i++) {
        // A small deterministic random walk over the pentatonic — reads as prosody.
        step += Math.floor(((h * (i + 3) * 17) % 1) * 5) - 2;
        const f = base * semi(PENTA[Math.abs(step) % 5]);
        end = Math.max(
          end,
          fmBlip(off(lvl(v, 0.9), i * 0.062), { freq: f, ratio, index: 1.1, dur: 0.05, gain: 0.22, type: 'square' }),
        );
      }
      return Math.max(end, noiseBurst(lvl(v, 0.3), { type: 'highpass', freq: 3400, dur: count * 0.062, q: 0.5, gain: 0.05 }));
    });
  }

  /** Screenshake gets a matching sub-bass shove so the hit lands in the chest. */
  shake(magnitude: number): void {
    const m = clamp01(magnitude / 1.4);
    if (m < 0.04) return;
    this.one({ gain: 0.35 + 0.65 * m, reverb: 0.2, key: 'shake', minInterval: 0.09, priority: 1 }, (v) =>
      thump(v, { freq: 58 + 46 * m, to: 26, dur: 0.24 + 0.4 * m, gain: 0.75, click: 0.12 + 0.2 * m }),
    );
  }

  // ================================================================ the weave
  //
  // The board is the game. It gets four sounds, and they have to interlock:
  //   rotate   a mechanical click that walks up a scale when you spam it
  //   charge   a hum that rises in pitch and opens up as the slot fills
  //   charged  an unmistakable chime the instant the slot is fireable
  //   power    a flow tone that engages and disengages with the circuit

  /**
   * Tile rotation. Rapid rotations climb a pentatonic run and reverse at the top,
   * so re-routing under pressure turns into a phrase instead of a rattle.
   */
  weaveRotate(): void {
    const now = this.eng.now();
    if (now - this.rotAt > 0.42) {
      this.rotStep = 0;
      this.rotDir = 1;
    } else {
      this.rotStep += this.rotDir;
      if (this.rotStep >= 7) this.rotDir = -1;
      else if (this.rotStep <= 0) this.rotDir = 1;
    }
    this.rotAt = now;
    const f = 620 * semi(PENTA[this.rotStep % PENTA.length]);
    this.one({ bus: 'ui', gain: 0.9, reverb: 0.1, key: 'rot', minInterval: 0.024 }, (v) => {
      // Two hard transients (the mechanism) plus a tuned tail (the conduit).
      const a = noiseBurst(lvl(v, 0.9), { freq: 3400, to: 1500, dur: 0.032, q: 3, gain: 0.3 });
      const b = fmBlip(lvl(v, 1), { freq: f, ratio: 3.5, index: 1.1, dur: 0.085, gain: 0.24 });
      const c = clang(off(lvl(v, 0.45), 0.004), { base: f * 2, count: 2, warp: 0.06, dur: 0.13, gain: 0.1, seed: this.rotStep * 31 + 7 });
      return Math.max(a, b, c);
    });
  }

  /** A slot just became fireable. Bright, consonant, and impossible to miss. */
  weaveCharged(slot: number): void {
    const root = 523.25 * semi(PENTA[(slot % 3) * 2]);
    this.one({ bus: 'ui', gain: 1, reverb: 0.4, delay: 0.16, priority: 2, key: `chg${slot}`, minInterval: 0.1 }, (v) => {
      const a = fmBlip(lvl(v, 1), { freq: root, ratio: 2, index: 1.1, dur: 0.46, gain: 0.3, type: 'triangle' });
      const b = fmBlip(off(lvl(v, 0.8), 0.046), { freq: root * semi(7), ratio: 2, index: 0.8, dur: 0.5, gain: 0.24, type: 'triangle' });
      const c = noiseBurst(lvl(v, 0.5), { type: 'highpass', freq: 5600, dur: 0.05, q: 0.8, gain: 0.16 });
      const d = shimmer(off(lvl(v, 0.8), 0.03), { freq: root * 3, count: 8, dur: 0.42, spread: 7, drift: 5, gain: 0.13, seed: slot * 977 + 3 });
      return Math.max(a, b, c, d);
    });
  }

  /** Power reached (or left) a slot. Engages/disengages that slot's flow tone. */
  weavePower(slot: number, connected: boolean): void {
    this.ensureWeave();
    const l = this.flows[slot % 3];
    if (l) {
      this.steer(l, {
        level: connected ? 0.05 : 0,
        freq: l.freq,
        cutoff: connected ? 900 : 260,
        tc: connected ? 0.08 : 0.22,
      });
    }
    const f = 174.6 * semi(PENTA[(slot % 3) * 2]);
    this.one({ bus: 'ui', gain: 0.85, reverb: 0.28, key: `pwr${slot}`, minInterval: 0.05 }, (v) => {
      if (connected) {
        // Contact made: a switch closing, then the line energising upward.
        const a = noiseBurst(lvl(v, 0.7), { freq: 2200, to: 5200, dur: 0.05, q: 2.2, gain: 0.22 });
        const b = fmBlip(lvl(v, 1), { freq: f, to: f * semi(5), ratio: 1.5, index: 1.6, dur: 0.24, gain: 0.26, type: 'sawtooth' });
        return Math.max(a, b);
      }
      // Contact lost: the line sags and a dull relay drops out.
      const a = fmBlip(lvl(v, 1), { freq: f * semi(5), to: f * 0.62, ratio: 1.5, index: 2.2, dur: 0.28, gain: 0.24, type: 'sawtooth' });
      const b = noiseBurst(lvl(v, 0.6), { type: 'lowpass', freq: 900, to: 200, dur: 0.16, q: 0.8, gain: 0.24 });
      return Math.max(a, b);
    });
  }

  /**
   * Per-frame charge state. `frac` is charge/cost, 0..1+. Called from the render
   * loop; every write is threshold-gated so this is a handful of float compares
   * on a normal frame and zero AudioParam churn.
   */
  updateWeave(slots: ReadonlyArray<{ frac: number; connected: boolean }>): void {
    if (!this.eng.ready) return;
    this.ensureWeave();
    for (let i = 0; i < this.hums.length; i++) {
      const l = this.hums[i];
      const s = slots[i];
      const frac = s ? clamp01(s.frac) : 0;
      const on = s?.connected ? 1 : 0;
      if (Math.abs(frac - this.humFrac[i]) < 0.02 && on === this.humOn[i]) continue;
      this.humFrac[i] = frac;
      this.humOn[i] = on;
      this.steer(l, {
        level: on ? 0.03 + 0.055 * frac : 0,
        freq: l.freq * semi(frac * 7),
        cutoff: 340 + 2800 * frac,
        tc: on ? 0.07 : 0.18,
      });
    }
  }

  /** Fade every sustained weave layer out — leaving a match, or muting. */
  weaveSilence(): void {
    for (const l of [...this.hums, ...this.flows]) this.steer(l, { level: 0, freq: l.freq, cutoff: 300, tc: 0.15 });
    this.humFrac = [0, 0, 0];
    this.humOn = [0, 0, 0];
  }

  private ensureWeave(): void {
    if (this.weaveBuilt || !this.eng.context) return;
    this.weaveBuilt = true;
    // Charge hums sit on a minor triad; flow tones an octave below, saw-buzzy.
    const humRoots = [130.81, 155.56, 196.0];
    const flowRoots = [65.41, 77.78, 98.0];
    for (const f of humRoots) {
      const l = this.layer(f, 400, 'triangle', 2);
      if (l) this.hums.push(l);
    }
    for (const f of flowRoots) {
      const l = this.layer(f, 300, 'sawtooth', 1.5);
      if (l) this.flows.push(l);
    }
  }

  private layer(freq: number, cutoff: number, type: OscillatorType, harm: number): SustainLayer | null {
    const ctx = this.eng.context;
    const bus = this.eng.bus('sfx');
    if (!ctx || !bus) return null;
    try {
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = cutoff;
      filt.Q.value = 3.2;
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = freq * harm;
      sub.detune.value = 9;
      osc.connect(filt);
      sub.connect(filt);
      filt.connect(gain);
      gain.connect(bus);
      osc.start();
      sub.start();
      return { osc, sub, filt, gain, freq, level: 0, cutoff };
    } catch (err) {
      console.warn('[audio] sustain layer failed', err);
      return null;
    }
  }

  private steer(
    l: SustainLayer,
    to: { level: number; freq: number; cutoff: number; tc: number },
  ): void {
    const ctx = this.eng.context;
    if (!ctx) return;
    const t = ctx.currentTime;
    try {
      l.gain.gain.setTargetAtTime(Math.max(0.0001, to.level), t, to.tc);
      l.osc.frequency.setTargetAtTime(to.freq, t, to.tc);
      l.sub.frequency.setTargetAtTime(to.freq * 1.5, t, to.tc);
      l.filt.frequency.setTargetAtTime(clamp(to.cutoff, 60, 12000), t, to.tc);
      l.level = to.level;
      l.cutoff = to.cutoff;
    } catch {
      /* param scheduling raced a context teardown */
    }
  }

  // ================================================================ interface

  ui(kind: UiSound): void {
    switch (kind) {
      case 'hover':
        this.one({ bus: 'ui', gain: 0.4, priority: 0, key: 'hov', minInterval: 0.045 }, (v) => {
          const a = noiseBurst(lvl(v, 1), { freq: 5400, dur: 0.028, q: 4, gain: 0.24 });
          const b = fmBlip(lvl(v, 0.7), { freq: 1980, ratio: 4, index: 0.4, dur: 0.04, gain: 0.14 });
          return Math.max(a, b);
        });
        break;
      case 'click':
        this.one({ bus: 'ui', gain: 0.8, reverb: 0.12, key: 'clk', minInterval: 0.04 }, (v) => {
          const a = fmBlip(lvl(v, 1), { freq: 784, to: 700, ratio: 2.5, index: 1.6, dur: 0.1, gain: 0.28 });
          const b = noiseBurst(lvl(v, 0.7), { freq: 3200, to: 900, dur: 0.05, q: 1.2, gain: 0.2 });
          return Math.max(a, b);
        });
        break;
      case 'back':
        this.one({ bus: 'ui', gain: 0.75, reverb: 0.14, key: 'bck', minInterval: 0.05 }, (v) => {
          const a = fmBlip(lvl(v, 1), { freq: 523, to: 294, ratio: 2, index: 1.4, dur: 0.15, gain: 0.26 });
          const b = noiseBurst(lvl(v, 0.5), { type: 'lowpass', freq: 1400, to: 400, dur: 0.09, q: 0.8, gain: 0.18 });
          return Math.max(a, b);
        });
        break;
      case 'ready':
        this.one({ bus: 'ui', gain: 0.9, reverb: 0.3, delay: 0.1, priority: 1 }, (v) => {
          const a = fmBlip(lvl(v, 1), { freq: 622, ratio: 2, index: 0.9, dur: 0.2, gain: 0.26, type: 'triangle' });
          const b = fmBlip(off(lvl(v, 1), 0.085), { freq: 932, ratio: 2, index: 0.7, dur: 0.34, gain: 0.24, type: 'triangle' });
          const c = shimmer(off(lvl(v, 0.6), 0.09), { freq: 1864, count: 6, dur: 0.34, spread: 6, drift: 4, gain: 0.1, seed: 21 });
          return Math.max(a, b, c);
        });
        break;
      case 'toggle':
        this.one({ bus: 'ui', gain: 0.7, key: 'tgl', minInterval: 0.04 }, (v) => {
          const a = fmBlip(lvl(v, 1), { freq: 660, to: 880, ratio: 3, index: 0.8, dur: 0.08, gain: 0.22 });
          const b = noiseBurst(lvl(v, 0.6), { freq: 4200, dur: 0.03, q: 3, gain: 0.18 });
          return Math.max(a, b);
        });
        break;
      case 'deny':
        this.one({ bus: 'ui', gain: 0.8, key: 'dny', minInterval: 0.08 }, (v) => {
          const a = fmBlip(lvl(v, 1), { freq: 180, ratio: 1.41, index: 4, dur: 0.16, gain: 0.28, type: 'square' });
          const b = noiseBurst(lvl(v, 0.5), { type: 'lowpass', freq: 700, dur: 0.1, q: 0.6, gain: 0.2 });
          return Math.max(a, b);
        });
        break;
    }
  }

  /** Countdown tick. `n` counts down to 1; the pitch climbs as it goes. */
  countdown(n: number): void {
    const step = clamp(5 - n, 0, 6);
    this.one({ bus: 'ui', gain: 0.9, reverb: 0.22, priority: 2, key: 'cd', minInterval: 0.25 }, (v) => {
      const f = 392 * semi(step * 2);
      const a = fmBlip(lvl(v, 1), { freq: f, ratio: 2, index: 1.3, dur: 0.13, gain: 0.3, type: 'triangle' });
      const b = noiseBurst(lvl(v, 0.7), { freq: 3000, to: 1400, dur: 0.035, q: 2.4, gain: 0.24 });
      return Math.max(a, b);
    });
  }

  sting(kind: StingKind): void {
    if (kind === 'start') {
      // A riser that lands on an impact — the drop *is* the match starting.
      this.one({ bus: 'ui', gain: 1, reverb: 0.5, delay: 0.12, priority: 2 }, (v) => {
        const a = sweep(lvl(v, 0.85), { from: 74, to: 880, dur: 1.0, type: 'sawtooth', detune: 16, q: 3.5, gain: 0.28, attack: 0.4 });
        const b = noiseBurst(lvl(v, 0.5), { type: 'highpass', freq: 400, to: 6000, dur: 0.98, q: 0.5, gain: 0.16, attack: 0.7 });
        return Math.max(a, b);
      });
      this.one({ bus: 'ui', gain: 1, reverb: 0.55, delay: 0.2, priority: 2, at: 0.98 }, (v) => {
        const a = thump(lvl(v, 1), { freq: 150, to: 36, dur: 0.85, gain: 0.8, click: 0.6 });
        const b = clang(lvl(v, 0.7), { base: 220, count: 6, warp: 0.16, dur: 1.3, gain: 0.24, seed: 909 });
        const c = noiseBurst(lvl(v, 0.7), { type: 'lowpass', freq: 2600, to: 200, dur: 0.7, q: 0.5, gain: 0.3 });
        return Math.max(a, b, c);
      });
      return;
    }
    if (kind === 'victory') {
      this.one({ bus: 'ui', gain: 1, reverb: 0.6, delay: 0.22, priority: 2 }, (v) => {
        let end = v.t;
        [0, 7, 12, 16, 19].forEach((s, i) => {
          end = Math.max(
            end,
            fmBlip(off(lvl(v, 0.9), i * 0.14), { freq: 261.6 * semi(s), ratio: 2, index: 0.8, dur: 1.1 - i * 0.08, gain: 0.24, type: 'triangle' }),
          );
        });
        const sw = sweep(off(lvl(v, 0.5), 0.05), { from: 130, to: 523, dur: 0.9, type: 'triangle', q: 4, gain: 0.18, attack: 0.5 });
        const sh = shimmer(off(lvl(v, 1), 0.5), { freq: 1046, count: 16, dur: 1.6, spread: 14, drift: 9, gain: 0.16, seed: 31 });
        return Math.max(end, sw, sh);
      });
      return;
    }
    // Defeat: the same material, dragged down a tritone and left unresolved.
    this.one({ bus: 'ui', gain: 1, reverb: 0.65, delay: 0.25, priority: 2 }, (v) => {
      let end = v.t;
      [0, -3, -7, -14].forEach((s, i) => {
        end = Math.max(
          end,
          fmBlip(off(lvl(v, 0.9), i * 0.2), { freq: 220 * semi(s), ratio: 1.98, index: 1.6, dur: 1.5 - i * 0.1, gain: 0.24, type: 'triangle' }),
        );
      });
      const sw = sweep(lvl(v, 0.7), { from: 220, to: 48, dur: 2.2, type: 'sawtooth', detune: -30, q: 3, gain: 0.22, attack: 0.2 });
      const cl = clang(off(lvl(v, 0.5), 0.4), { base: 155, count: 6, warp: 0.5, dur: 1.6, gain: 0.16, seed: 66 });
      return Math.max(end, sw, cl);
    });
  }

  /**
   * `{ t: 'sfx', name }` passthrough. Known names get bespoke sounds; a
   * `cast_<abilityId>` name routes to the cast synth; anything else still makes
   * a plausible noise derived from its own name, so no cue is ever silent.
   */
  named(name: string, pos: Vec2 | null): void {
    switch (name) {
      case 'enemy_death':
        this.death(pos, 'enemy');
        return;
      case 'player_death':
        this.death(pos, 'player');
        return;
      case 'shield_break':
        this.one({ pos, gain: 0.9, reverb: 0.3, priority: 1 }, (v) => {
          const a = clang(lvl(v, 1), { base: 1180, count: 6, warp: 0.45, dur: 0.6, gain: 0.24, seed: 12 });
          const b = noiseBurst(lvl(v, 0.8), { type: 'highpass', freq: 2400, to: 700, dur: 0.28, q: 0.6, gain: 0.3 });
          return Math.max(a, b);
        });
        return;
      case 'board_damage':
        this.one({ gain: 1, bus: 'ui', reverb: 0.35, priority: 2 }, (v) => {
          const a = noiseBurst(lvl(v, 1), { type: 'lowpass', freq: 1800, to: 140, dur: 0.5, q: 0.7, gain: 0.4 });
          const b = clang(lvl(v, 0.8), { base: 96, count: 5, warp: 0.6, dur: 0.7, gain: 0.24, seed: 77 });
          const c = thump(lvl(v, 0.8), { freq: 84, to: 30, dur: 0.4, gain: 0.55, click: 0.4 });
          return Math.max(a, b, c);
        });
        return;
      case 'wave_start':
      case 'boss_spawn':
        this.one({ bus: 'ui', gain: 1, reverb: 0.6, delay: 0.2, priority: 2 }, (v) => {
          const low = name === 'boss_spawn' ? 55 : 82.4;
          const a = sweep(lvl(v, 0.9), { from: low * 4, to: low, dur: 1.4, type: 'sawtooth', detune: -24, q: 3, gain: 0.26, attack: 0.25 });
          const b = thump(lvl(v, 0.9), { freq: low * 1.6, to: low * 0.5, dur: 0.7, gain: 0.6, click: 0.35 });
          const c = clang(off(lvl(v, 0.6), 0.06), { base: low * 3, count: 6, warp: 0.4, dur: 1.5, gain: 0.18, seed: 404 });
          return Math.max(a, b, c);
        });
        return;
      case 'seal_open':
      case 'relay_link':
        this.revive(pos);
        return;
      default:
        break;
    }
    if (name.startsWith('cast_')) {
      this.cast(name.slice(5), pos);
      return;
    }
    // Unknown cue: hash the name into a small pitched tick so it still registers.
    const h = hashStr(name);
    this.one({ pos, gain: 0.55, priority: 0, reverb: 0.18, key: `nm:${name}`, minInterval: 0.05 }, (v) => {
      const f = 240 + h * 900;
      const a = fmBlip(lvl(v, 1), { freq: f, ratio: 2 + h * 2, index: 1.2, dur: 0.12, gain: 0.22 });
      const b = noiseBurst(lvl(v, 0.6), { freq: 1800 + h * 2600, to: 600, dur: 0.06, q: 1.4, gain: 0.18 });
      return Math.max(a, b);
    });
  }
}

// ---------------------------------------------------------------- sustained layers

/**
 * A permanently-running two-oscillator drone whose pitch, brightness and level
 * are steered continuously. Used for the Weave's charge hum and power flow —
 * both are states, not events, so they cannot be one-shot voices.
 */
interface SustainLayer {
  osc: OscillatorNode;
  sub: OscillatorNode;
  filt: BiquadFilterNode;
  gain: GainNode;
  freq: number;
  level: number;
  cutoff: number;
}
