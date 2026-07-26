/**
 * VOIDLINE — generative ambient score.
 *
 * There is no loop. Four layers run continuously and a look-ahead scheduler
 * decides, a beat at a time, what happens next:
 *
 *   drone   4 detuned oscillators on a stacked fifth, filter on a random walk
 *   air     looped noise through a wandering bandpass — the station breathing
 *   pulse   a low sub thump on a jittered interval; the game's heartbeat
 *   pad     sparse chords voiced from the current mode, never the same twice
 *   motif   rare high material: bells when calm, warped metal when it is not
 *
 * State drives a `Mood` — tonic, mode, density, brightness, pulse rate — and
 * every continuous parameter glides to the new mood over seconds, so the score
 * tightens as the fight does instead of cutting between tracks.
 */

import type { AudioEngine, Voice } from './engine.js';
import { clamp, clamp01 } from './engine.js';
import { clang, noiseBuffer, noiseBurst, semi, shimmer, thump } from './synth.js';

export type MusicState =
  | 'off'
  | 'menu'
  | 'lobby'
  | 'tension'
  | 'combat'
  | 'boss'
  | 'victory'
  | 'defeat';

interface Mood {
  /** Tonic in Hz. */
  root: number;
  /** Scale degrees in semitones. */
  scale: readonly number[];
  drone: number;
  droneCut: number;
  /** Cents of spread across the drone stack. */
  detune: number;
  air: number;
  pulse: number;
  pulseEvery: number;
  pad: number;
  padEvery: number;
  motif: number;
  motifEvery: number;
  /** Octave bias for pad/motif material. */
  bright: number;
  /** True where the motif layer should sound like struck metal, not bells. */
  harsh: boolean;
}

const AEOLIAN = [0, 2, 3, 5, 7, 8, 10];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const LOCRIAN = [0, 1, 3, 5, 6, 8, 10];
const IONIAN = [0, 2, 4, 5, 7, 9, 11];

const MOODS: Record<Exclude<MusicState, 'off'>, Mood> = {
  // Cold and empty. Almost nothing happens, and that is the point.
  menu: { root: 55.0, scale: AEOLIAN, drone: 0.1, droneCut: 330, detune: 11, air: 0.05, pulse: 0.0, pulseEvery: 7.0, pad: 0.085, padEvery: 9.5, motif: 0.1, motifEvery: 15, bright: 3, harsh: false },
  lobby: { root: 58.27, scale: AEOLIAN, drone: 0.11, droneCut: 430, detune: 14, air: 0.055, pulse: 0.1, pulseEvery: 4.4, pad: 0.09, padEvery: 7.0, motif: 0.1, motifEvery: 11, bright: 3, harsh: false },
  // Something is coming. The pulse arrives and the mode darkens a step.
  tension: { root: 61.74, scale: PHRYGIAN, drone: 0.13, droneCut: 620, detune: 22, air: 0.07, pulse: 0.3, pulseEvery: 2.1, pad: 0.09, padEvery: 5.5, motif: 0.11, motifEvery: 8, bright: 3, harsh: false },
  combat: { root: 65.41, scale: PHRYGIAN, drone: 0.15, droneCut: 900, detune: 30, air: 0.08, pulse: 0.42, pulseEvery: 1.3, pad: 0.085, padEvery: 4.5, motif: 0.11, motifEvery: 6.5, bright: 2, harsh: true },
  // Locrian, fast pulse, metal in the upper register. No comfort anywhere.
  boss: { root: 69.3, scale: LOCRIAN, drone: 0.18, droneCut: 1320, detune: 48, air: 0.1, pulse: 0.55, pulseEvery: 0.74, pad: 0.08, padEvery: 3.2, motif: 0.14, motifEvery: 4.0, bright: 2, harsh: true },
  // The only major mood in the game.
  victory: { root: 65.41, scale: IONIAN, drone: 0.12, droneCut: 1700, detune: 7, air: 0.04, pulse: 0.12, pulseEvery: 3.6, pad: 0.13, padEvery: 3.4, motif: 0.16, motifEvery: 3.6, bright: 3, harsh: false },
  // A tritone below combat, filter shut, pulse dying out.
  defeat: { root: 46.25, scale: LOCRIAN, drone: 0.12, droneCut: 235, detune: 42, air: 0.06, pulse: 0.08, pulseEvery: 5.6, pad: 0.09, padEvery: 8.0, motif: 0.09, motifEvery: 16, bright: 2, harsh: true },
};

/** Scheduler cadence and how far ahead it commits events. */
const TICK_MS = 240;
const LOOKAHEAD = 1.3;

export class MusicDirector {
  private eng: AudioEngine;
  private state: MusicState = 'off';
  private mood: Mood = MOODS.menu;
  private intensity = 0;

  private started = false;
  private timer = 0;

  private droneOsc: OscillatorNode[] = [];
  private droneFilt: BiquadFilterNode | null = null;
  private droneGain: GainNode | null = null;
  private airSrc: AudioBufferSourceNode | null = null;
  private airFilt: BiquadFilterNode | null = null;
  private airGain: GainNode | null = null;

  private nextPulse = 0;
  private nextPad = 0;
  private nextMotif = 0;
  private nextWalk = 0;
  private padIndex = 2;
  private pulseCount = 0;
  private seed = 0x1f2e3d4c;

  constructor(engine: AudioEngine) {
    this.eng = engine;
  }

  private rnd(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Build the continuous layers and start the scheduler. Idempotent. */
  start(): void {
    if (this.started) return;
    const ctx = this.eng.context;
    const bus = this.eng.bus('music');
    if (!ctx || !bus) return;
    try {
      this.buildDrone(ctx, bus);
      this.buildAir(ctx, bus);
    } catch (err) {
      console.warn('[audio] music layers failed', err);
      return;
    }
    this.started = true;
    const now = ctx.currentTime;
    this.nextPulse = now + 0.5;
    this.nextPad = now + 1.4;
    this.nextMotif = now + 4;
    this.nextWalk = now + 1;
    this.applyMood(6);
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
    this.setState('off');
  }

  get current(): MusicState {
    return this.state;
  }

  private buildDrone(ctx: AudioContext, bus: GainNode): void {
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 300;
    filt.Q.value = 1.6;
    filt.connect(gain);
    gain.connect(bus);
    const verb = this.eng.fx('reverb');
    if (verb) {
      const send = ctx.createGain();
      send.gain.value = 0.5;
      gain.connect(send);
      send.connect(verb);
    }
    // Tonic, fifth, octave, and a slightly sour octave+fifth on top.
    const ratios = [1, 1.5, 2, 2.997];
    const types: OscillatorType[] = ['sawtooth', 'triangle', 'sawtooth', 'triangle'];
    for (let i = 0; i < ratios.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = types[i];
      osc.frequency.value = this.mood.root * ratios[i];
      osc.detune.value = (i - 1.5) * 8;
      const g = ctx.createGain();
      g.gain.value = 1 / (1 + i * 0.9);
      osc.connect(g);
      g.connect(filt);
      osc.start();
      this.droneOsc.push(osc);
    }
    this.droneFilt = filt;
    this.droneGain = gain;
  }

  private buildAir(ctx: AudioContext, bus: GainNode): void {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 620;
    filt.Q.value = 0.9;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    src.connect(filt);
    filt.connect(gain);
    gain.connect(bus);
    const verb = this.eng.fx('reverb');
    if (verb) {
      const send = ctx.createGain();
      send.gain.value = 0.35;
      gain.connect(send);
      send.connect(verb);
    }
    src.start();
    this.airSrc = src;
    this.airFilt = filt;
    this.airGain = gain;
  }

  // ---------------------------------------------------------------- state

  /** Escalation rank — decides whether a transition rises or falls. */
  private static rank(s: MusicState): number {
    switch (s) {
      case 'boss':
        return 3;
      case 'combat':
        return 2;
      case 'tension':
      case 'victory':
        return 1;
      case 'off':
        return -1;
      default:
        return 0;
    }
  }

  setState(next: MusicState, intensity?: number): void {
    if (typeof intensity === 'number') this.intensity = clamp01(intensity);
    if (next === this.state) {
      if (typeof intensity === 'number') this.applyMood(3);
      return;
    }
    const prev = this.state;
    this.state = next;
    if (next === 'off') {
      this.applyMood(0.9);
      return;
    }
    this.mood = MOODS[next];
    if (!this.started) {
      this.start();
      return;
    }
    const up = MusicDirector.rank(next) > MusicDirector.rank(prev);
    // Escalations bite quickly; releases take their time.
    this.applyMood(up ? 1.6 : 3.4);
    const now = this.eng.now();
    this.nextPulse = Math.min(this.nextPulse, now + 0.35);
    this.nextPad = Math.min(this.nextPad, now + 0.7);
    this.nextMotif = Math.min(this.nextMotif, now + 1.1);
    if (prev !== 'off') this.riser(up);
  }

  /** Continuous 0..1 within the current state (wave progress, boss HP, …). */
  setIntensity(x: number): void {
    const v = clamp01(x);
    if (Math.abs(v - this.intensity) < 0.06) return;
    this.intensity = v;
    this.applyMood(2.4);
  }

  private applyMood(tc: number): void {
    const ctx = this.eng.context;
    if (!ctx) return;
    const m = this.mood;
    const on = this.state !== 'off';
    const i = this.intensity;
    const t = ctx.currentTime;
    const set = (p: AudioParam | undefined, value: number): void => {
      if (!p) return;
      try {
        p.setTargetAtTime(value, t, Math.max(0.02, tc));
      } catch {
        /* ignore */
      }
    };
    set(this.droneGain?.gain, on ? Math.max(0.0001, m.drone * (0.85 + 0.3 * i)) : 0.0001);
    set(this.droneFilt?.frequency, clamp(m.droneCut * (0.82 + 0.45 * i), 80, 9000));
    set(this.airGain?.gain, on ? Math.max(0.0001, m.air) : 0.0001);
    const ratios = [1, 1.5, 2, 2.997];
    const n = this.droneOsc.length;
    for (let k = 0; k < n; k++) {
      set(this.droneOsc[k].frequency, clamp(m.root * ratios[k % ratios.length], 16, 8000));
      set(this.droneOsc[k].detune, (k / Math.max(1, n - 1) - 0.5) * 2 * m.detune);
    }
  }

  // ---------------------------------------------------------------- scheduler

  private tick(): void {
    if (!this.started || this.state === 'off') return;
    const ctx = this.eng.context;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const until = now + LOOKAHEAD;
    const m = this.mood;

    // A backgrounded tab freezes currentTime advancement relative to our clocks;
    // never try to catch up on minutes of missed events.
    if (this.nextPulse < now - 2) this.nextPulse = now + 0.2;
    if (this.nextPad < now - 4) this.nextPad = now + 0.6;
    if (this.nextMotif < now - 6) this.nextMotif = now + 1.5;

    // Slow random walk: the drone must never sit on one colour.
    if (now >= this.nextWalk) {
      this.nextWalk = now + 2.2 + this.rnd() * 3.4;
      const cut = m.droneCut * (0.7 + this.rnd() * 0.85) * (0.82 + 0.45 * this.intensity);
      try {
        this.droneFilt?.frequency.setTargetAtTime(clamp(cut, 80, 9000), now, 2.6);
        this.airFilt?.frequency.setTargetAtTime(280 + this.rnd() * 1600, now, 3.4);
      } catch {
        /* ignore */
      }
    }

    let guard = 0;
    while (this.nextPulse < until && guard++ < 24) {
      if (m.pulse > 0.02) this.pulse(this.nextPulse);
      this.nextPulse += m.pulseEvery * (0.9 + this.rnd() * 0.22);
    }
    guard = 0;
    while (this.nextPad < until && guard++ < 8) {
      this.padChord(this.nextPad);
      this.nextPad += m.padEvery * (0.62 + this.rnd() * 0.85);
    }
    guard = 0;
    while (this.nextMotif < until && guard++ < 8) {
      this.motif(this.nextMotif);
      this.nextMotif += m.motifEvery * (0.6 + this.rnd() * 0.95);
    }
  }

  /**
   * A music voice. Deliberately bypasses the SFX voice pool: the scheduler
   * already bounds how many can exist, and the score must never be culled by
   * a busy fight.
   */
  private voice(gain: number, reverb: number, at: number): Voice | null {
    const ctx = this.eng.context;
    const bus = this.eng.bus('music');
    if (!ctx || !bus) return null;
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(bus);
    let tap: GainNode | null = null;
    const verb = this.eng.fx('reverb');
    if (verb && reverb > 0.01) {
      tap = ctx.createGain();
      tap.gain.value = clamp01(reverb);
      out.connect(tap);
      tap.connect(verb);
    }
    return {
      ctx,
      out,
      t: at,
      amp: clamp01(gain),
      end: (endAt: number): void => {
        const wait = Math.max(0, (endAt - ctx.currentTime + 0.3) * 1000);
        window.setTimeout(() => {
          try {
            out.disconnect();
            tap?.disconnect();
          } catch {
            /* already gone */
          }
        }, Math.min(wait, 60000));
      },
    };
  }

  // ---------------------------------------------------------------- layers

  /** The heartbeat. Every eighth beat lands a minor third up, which is the tell. */
  private pulse(at: number): void {
    const m = this.mood;
    const v = this.voice(m.pulse, 0.3, at);
    if (!v) return;
    const accent = this.pulseCount % 8 === 4;
    const f = m.root * 2 * (accent ? semi(3) : 1);
    v.end(thump(v, { freq: f, to: f * 0.34, dur: 0.5 + this.rnd() * 0.3, gain: 0.85, click: accent ? 0.1 : 0.04 }));
    this.pulseCount++;
  }

  /** Sparse detuned pad: a random walk over the mode, voiced in stacked thirds. */
  private padChord(at: number): void {
    const ctx = this.eng.context;
    const m = this.mood;
    if (!ctx) return;
    const v = this.voice(m.pad, 0.6, at);
    if (!v) return;
    const len = m.scale.length;
    this.padIndex = (this.padIndex + Math.floor(this.rnd() * 5) - 2 + len * 2) % len;
    const oct = Math.pow(2, m.bright + (this.rnd() < 0.26 ? 1 : 0));
    const dur = 3.4 + this.rnd() * 3.6;
    const notes = [0, 2, 4].map((k, idx) => m.scale[(this.padIndex + k) % len] + (idx === 2 && this.rnd() < 0.4 ? 12 : 0));

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 700 + this.rnd() * 1900;
    filt.Q.value = 0.8;
    filt.connect(v.out);

    const attack = 0.9 + this.rnd() * 1.6;
    const peak = v.amp / notes.length;
    for (const n of notes) {
      const f = m.root * oct * semi(n);
      for (let d = 0; d < 2; d++) {
        const osc = ctx.createOscillator();
        osc.type = d === 0 ? 'sawtooth' : 'triangle';
        osc.frequency.value = clamp(f, 20, 9000);
        osc.detune.value = (d === 0 ? -1 : 1) * (4 + this.rnd() * m.detune * 0.6);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0002, at);
        g.gain.linearRampToValueAtTime(Math.max(0.0003, peak * (d === 0 ? 0.7 : 1)), at + attack);
        g.gain.exponentialRampToValueAtTime(0.0002, at + dur);
        osc.connect(g);
        g.connect(filt);
        osc.start(at);
        osc.stop(at + dur + 0.05);
      }
    }
    v.end(at + dur);
  }

  /** Rare high material. Bells when the station is calm, warped metal when not. */
  private motif(at: number): void {
    const m = this.mood;
    const v = this.voice(m.motif, 0.72, at);
    if (!v) return;
    const len = m.scale.length;
    const n = m.scale[Math.floor(this.rnd() * len)] + (this.rnd() < 0.4 ? 12 : 0);
    const f = clamp(m.root * Math.pow(2, m.bright + 2) * semi(n), 60, 9000);
    const end = m.harsh
      ? clang(v, { base: f, count: 5, warp: 0.32 + this.rnd() * 0.34, dur: 1.4 + this.rnd() * 1.1, gain: 1.2, seed: this.seed })
      : shimmer(v, { freq: f, count: 9, dur: 1.5 + this.rnd() * 1.3, spread: 12, drift: this.rnd() * 10 - 5, gain: 1.7, seed: this.seed });
    v.end(end);
  }

  /** Transition swell, direction set by whether the game just got worse. */
  private riser(up: boolean): void {
    const v = this.voice(0.26, 0.55, this.eng.now() + 0.02);
    if (!v) return;
    v.end(
      up
        ? noiseBurst(v, { freq: 320, to: 4400, dur: 1.7, q: 0.8, gain: 0.6, attack: 1.35 })
        : noiseBurst(v, { freq: 3000, to: 170, dur: 2.1, q: 0.7, gain: 0.45, attack: 0.18 }),
    );
  }
}
