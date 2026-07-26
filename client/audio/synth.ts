/**
 * VOIDLINE — synthesis primitives.
 *
 * Six building blocks that every sound in the game is assembled from. Each takes
 * a `Voice` reserved from the engine, schedules its whole graph up front, and
 * closes the voice at the moment its tail goes silent. Nothing here loops or
 * polls; once scheduled a sound needs no further CPU from us.
 */

import type { Voice } from './engine.js';
import { clamp } from './engine.js';

/** Per-context white noise, 2 s, shared by every noise voice ever played. */
const NOISE = new WeakMap<AudioContext, AudioBuffer>();

export function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const cached = NOISE.get(ctx);
  if (cached) return cached;
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let seed = 0x2545f491;
  for (let i = 0; i < len; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    d[i] = seed / 0x7fffffff - 1;
  }
  NOISE.set(ctx, buf);
  return buf;
}

/** Percussive amplitude envelope. Returns the absolute end time. */
function perc(g: GainNode, t: number, peak: number, attack: number, dur: number): number {
  const p = Math.max(0.0002, peak);
  const a = Math.max(0.0005, attack);
  g.gain.setValueAtTime(0.0002, t);
  g.gain.linearRampToValueAtTime(p, t + a);
  g.gain.exponentialRampToValueAtTime(0.0002, t + Math.max(dur, a + 0.01));
  return t + Math.max(dur, a + 0.01);
}

function safeFreq(n: number): number {
  return clamp(Number.isFinite(n) ? n : 440, 8, 19000);
}

// ---------------------------------------------------------------- 1. noise burst

export interface NoiseBurstOpts {
  dur?: number;
  /** Filter centre at the start. */
  freq?: number;
  /** Filter centre at the end — set for a whoosh or a downward crunch. */
  to?: number;
  q?: number;
  type?: BiquadFilterType;
  attack?: number;
  gain?: number;
}

/** Filtered noise. The workhorse: impacts, whooshes, air, ticks. */
export function noiseBurst(v: Voice, o: NoiseBurstOpts = {}): number {
  const { ctx, out, t } = v;
  const dur = o.dur ?? 0.14;
  const src = ctx.createBufferSource();
  const buf = noiseBuffer(ctx);
  src.buffer = buf;
  src.loop = true;
  const filt = ctx.createBiquadFilter();
  filt.type = o.type ?? 'bandpass';
  const f0 = safeFreq(o.freq ?? 1400);
  filt.frequency.setValueAtTime(f0, t);
  if (o.to !== undefined) filt.frequency.exponentialRampToValueAtTime(safeFreq(o.to), t + dur);
  filt.Q.value = o.q ?? 1.2;
  const g = ctx.createGain();
  const end = perc(g, t, v.amp * (o.gain ?? 0.5), o.attack ?? 0.004, dur);
  src.connect(filt);
  filt.connect(g);
  g.connect(out);
  src.start(t, (t * 7.31) % (buf.duration - dur - 0.05 > 0 ? buf.duration - dur - 0.05 : 0.1));
  src.stop(end + 0.02);
  return end;
}

// ---------------------------------------------------------------- 2. FM blip

export interface FmBlipOpts {
  freq?: number;
  /** Modulator:carrier frequency ratio. Non-integers go metallic. */
  ratio?: number;
  /** Modulation index — how much timbre. */
  index?: number;
  dur?: number;
  /** Carrier pitch target; set for a glide. */
  to?: number;
  type?: OscillatorType;
  attack?: number;
  gain?: number;
}

/** Two-operator FM. Bells, chimes, casts, UI clicks — anything with a pitch. */
export function fmBlip(v: Voice, o: FmBlipOpts = {}): number {
  const { ctx, out, t } = v;
  const dur = o.dur ?? 0.18;
  const f = safeFreq(o.freq ?? 440);
  const car = ctx.createOscillator();
  car.type = o.type ?? 'sine';
  car.frequency.setValueAtTime(f, t);
  if (o.to !== undefined) car.frequency.exponentialRampToValueAtTime(safeFreq(o.to), t + dur);
  const mod = ctx.createOscillator();
  mod.type = 'sine';
  mod.frequency.value = safeFreq(f * (o.ratio ?? 2));
  const modGain = ctx.createGain();
  const depth = f * (o.index ?? 1.4);
  modGain.gain.setValueAtTime(depth, t);
  modGain.gain.exponentialRampToValueAtTime(Math.max(1, depth * 0.04), t + dur * 0.8);
  const g = ctx.createGain();
  const end = perc(g, t, v.amp * (o.gain ?? 0.34), o.attack ?? 0.003, dur);
  mod.connect(modGain);
  modGain.connect(car.frequency);
  car.connect(g);
  g.connect(out);
  mod.start(t);
  car.start(t);
  mod.stop(end + 0.02);
  car.stop(end + 0.02);
  return end;
}

// ---------------------------------------------------------------- 3. sweep

export interface SweepOpts {
  from?: number;
  to?: number;
  dur?: number;
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  /** Resonant lowpass that tracks the sweep, for a vocal-ish riser. */
  q?: number;
  /** Cents of detune on a doubled oscillator; 0 disables the double. */
  detune?: number;
}

/** A pitched glide. Risers, sirens, beams, deaths. */
export function sweep(v: Voice, o: SweepOpts = {}): number {
  const { ctx, out, t } = v;
  const dur = o.dur ?? 0.5;
  const from = safeFreq(o.from ?? 200);
  const to = safeFreq(o.to ?? 1200);
  const g = ctx.createGain();
  const end = perc(g, t, v.amp * (o.gain ?? 0.3), o.attack ?? Math.min(0.06, dur * 0.25), dur);
  let node: AudioNode = g;
  if (o.q) {
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.Q.value = o.q;
    filt.frequency.setValueAtTime(from * 2.2, t);
    filt.frequency.exponentialRampToValueAtTime(safeFreq(to * 2.2), t + dur);
    g.connect(filt);
    filt.connect(out);
    node = filt;
  } else {
    g.connect(out);
  }
  void node;
  const voices = o.detune ? 2 : 1;
  for (let i = 0; i < voices; i++) {
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sawtooth';
    osc.detune.value = i === 0 ? 0 : (o.detune ?? 0);
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    osc.connect(g);
    osc.start(t);
    osc.stop(end + 0.02);
  }
  return end;
}

// ---------------------------------------------------------------- 4. thump

export interface ThumpOpts {
  freq?: number;
  /** Pitch floor the drop lands on. */
  to?: number;
  dur?: number;
  gain?: number;
  /** Amount of noise transient stacked on the front, 0..1. */
  click?: number;
}

/** Sub-bass impact with a pitch drop. Explosions, shake, the music pulse. */
export function thump(v: Voice, o: ThumpOpts = {}): number {
  const { ctx, out, t } = v;
  const dur = o.dur ?? 0.34;
  const f = safeFreq(o.freq ?? 120);
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(f, t);
  osc.frequency.exponentialRampToValueAtTime(safeFreq(o.to ?? f * 0.32), t + dur * 0.85);
  const g = ctx.createGain();
  const end = perc(g, t, v.amp * (o.gain ?? 0.7), 0.006, dur);
  osc.connect(g);
  g.connect(out);
  osc.start(t);
  osc.stop(end + 0.02);
  if (o.click && o.click > 0.01) {
    noiseBurst({ ...v, amp: v.amp * o.click }, {
      dur: Math.min(0.09, dur * 0.4),
      freq: 2600,
      to: 400,
      q: 0.7,
      gain: 0.5,
    });
  }
  return end;
}

// ---------------------------------------------------------------- 5. metallic clang

/** Inharmonic partial set — deliberately not a harmonic series, so it rings metal. */
const PARTIALS = [1, 1.732, 2.411, 3.187, 4.043, 5.271, 6.618];

export interface ClangOpts {
  base?: number;
  dur?: number;
  gain?: number;
  /** How many partials to voice (2..7). Fewer = tuned bell, more = scrap metal. */
  count?: number;
  /** Detunes the partial set; 0 = pure, 1 = badly warped. */
  warp?: number;
  /** Deterministic variation seed. */
  seed?: number;
}

/** Struck metal. Conduit hits, enemy deaths, the weave's mechanical body. */
export function clang(v: Voice, o: ClangOpts = {}): number {
  const { ctx, out, t } = v;
  const base = safeFreq(o.base ?? 520);
  const dur = o.dur ?? 0.5;
  const count = Math.max(2, Math.min(PARTIALS.length, Math.round(o.count ?? 5)));
  const warp = o.warp ?? 0.12;
  let seed = (o.seed ?? 1) | 0;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let end = t;
  for (let i = 0; i < count; i++) {
    const ratio = PARTIALS[i] * (1 + (rnd() - 0.5) * warp);
    const osc = ctx.createOscillator();
    osc.type = i === 0 ? 'triangle' : 'sine';
    osc.frequency.value = safeFreq(base * ratio);
    const g = ctx.createGain();
    // Upper partials die first — that decay gradient is what reads as "metal".
    const life = dur * (1 - i / (count + 1.4)) * (0.75 + rnd() * 0.4);
    const amp = (v.amp * (o.gain ?? 0.3)) / (1 + i * 1.15);
    const stop = perc(g, t, amp, 0.002 + i * 0.001, Math.max(0.04, life));
    if (stop > end) end = stop;
    osc.connect(g);
    g.connect(out);
    osc.start(t);
    osc.stop(stop + 0.02);
  }
  return end;
}

// ---------------------------------------------------------------- 6. granular shimmer

export interface ShimmerOpts {
  freq?: number;
  count?: number;
  dur?: number;
  gain?: number;
  /** Pitch spread in semitones the grains scatter across. */
  spread?: number;
  /** Overall pitch drift across the cloud, in semitones. */
  drift?: number;
  seed?: number;
}

/** A cloud of tiny windowed sine grains. Magic, buffs, victory, void-space. */
export function shimmer(v: Voice, o: ShimmerOpts = {}): number {
  const { ctx, out, t } = v;
  const base = safeFreq(o.freq ?? 1400);
  const total = o.dur ?? 0.7;
  const count = Math.max(2, Math.min(18, Math.round(o.count ?? 9)));
  const spread = o.spread ?? 12;
  const drift = o.drift ?? 5;
  let seed = (o.seed ?? 7) | 0;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let end = t;
  for (let i = 0; i < count; i++) {
    const at = t + (i / count) * total * 0.8 + rnd() * total * 0.12;
    const semis = (rnd() - 0.5) * spread + (i / count) * drift;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = safeFreq(base * Math.pow(2, semis / 12));
    const g = ctx.createGain();
    const grain = 0.06 + rnd() * 0.14;
    const stop = perc(g, at, (v.amp * (o.gain ?? 0.16)) / Math.sqrt(count), grain * 0.4, grain);
    if (stop > end) end = stop;
    osc.connect(g);
    g.connect(out);
    osc.start(at);
    osc.stop(stop + 0.02);
  }
  return end;
}

// ---------------------------------------------------------------- utilities

/** Stable 0..1 hash of a string — per-ability and per-speaker sound variation. */
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

/** Semitones -> frequency ratio. */
export function semi(n: number): number {
  return Math.pow(2, n / 12);
}
