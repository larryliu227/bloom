/**
 * VOIDLINE — audio engine.
 *
 * Everything the game hears is synthesized at runtime: no samples, no libraries.
 * This module owns the graph that all of it flows through.
 *
 *   voice.out -> panner -> bus(sfx|music|ui) -> master -> limiter -> destination
 *                      \-> reverb send -> convolver (procedural IR) -> master
 *                      \-> delay send  -> conduit delay (fb + lowpass) -> master
 *
 * Rules it enforces so audio can never hurt the game:
 *   - the AudioContext is built on the first user gesture and never before;
 *   - nothing here throws — every entry point degrades to a no-op;
 *   - concurrent voices are capped and distance-culled, so a 40-enemy wipe
 *     cannot spawn 400 oscillators.
 */

import type { Vec2 } from '@shared/types.js';

export type BusName = 'sfx' | 'music' | 'ui';

export interface VolumeSettings {
  master: number;
  music: number;
  sfx: number;
  muted: boolean;
}

export interface PlayOpts {
  bus?: BusName;
  /** World position. Omitted/null = non-diegetic: centred, no attenuation. */
  pos?: Vec2 | null;
  /** Amplitude budget, 0..1. */
  gain?: number;
  /** 0 = cullable filler, 1 = normal, 2 = never culled (stings, deaths). */
  priority?: number;
  /** 0..1 send into the station reverb. */
  reverb?: number;
  /** 0..1 send into the conduit delay. */
  delay?: number;
  /** Rate-limit key: a repeat inside `minInterval` seconds is dropped. */
  key?: string;
  minInterval?: number;
  /** Seconds to postpone the start relative to now. */
  at?: number;
}

/** A reserved slot in the voice pool with a pre-wired output chain. */
export interface Voice {
  ctx: AudioContext;
  /** Connect the tail of your source graph here. */
  out: GainNode;
  /** Absolute context time this voice starts at. */
  t: number;
  /** Distance-attenuated amplitude budget (0..1). Scale your envelopes by it. */
  amp: number;
  /** Report the absolute time the tail falls silent; frees the pool slot. */
  end(at: number): void;
}

// ---------------------------------------------------------------- tuning

/** Hard ceiling on simultaneously sounding voices. */
const MAX_VOICES = 26;
/** Extra slots reserved for priority-2 sounds so a death sting is never eaten. */
const PRIORITY_HEADROOM = 8;
/** Inside this radius a sound plays at full volume. */
const NEAR = 300;
/** Beyond this radius a sound is inaudible and gets culled outright. */
const FAR = 1500;
/** Half-width of the stereo field in world units. */
const PAN_WIDTH = 560;
/** Panning never hard-sides; keeps the mix from feeling like headphones-only. */
const PAN_MAX = 0.85;
/** Seconds of slack added before a finished voice is torn down. */
const TEARDOWN_PAD = 0.09;
/** Furthest a rate-limited sound may be nudged later before it is dropped. */
const MAX_DEFER = 0.1;

const DEFAULT_VOLUMES: VolumeSettings = { master: 0.75, music: 0.6, sfx: 0.9, muted: false };

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private busses: Record<BusName, GainNode> | null = null;
  private verbIn: GainNode | null = null;
  private delayIn: GainNode | null = null;
  private listener: Vec2 = { x: 0, y: 0 };
  private active = 0;
  private created = 0;
  private dropped = 0;
  private lastAt = new Map<string, number>();
  private vol: VolumeSettings = { ...DEFAULT_VOLUMES };
  private broken = false;
  /** Start attempts, so a stuck unlock is visible rather than silent. */
  private attempts_ = 0;
  private lastError = '';
  /** Last state we notified on, so `statechange` fires the callback once. */
  private seenState = 'idle';
  private stateCb: ((state: string) => void) | null = null;

  // ---------------------------------------------------------------- lifecycle

  /**
   * Build (or resume) the context. MUST be called from inside a user-gesture
   * handler the first time — browsers refuse otherwise. Safe to call often.
   *
   * Returns whether the context is **verifiably running right now**, not
   * whether we asked politely: `resume()` is async, so a first call inside a
   * gesture usually still reads 'suspended' here and returns false. Callers
   * that need the settled answer await `resume()`; callers that just want the
   * truth for a retry loop can trust this. Never reports success for a
   * suspended context — that is what made blocked autoplay look like working
   * audio.
   */
  init(): boolean {
    if (this.broken) return false;
    if (!this.ctx) {
      try {
        const Ctor: typeof AudioContext | undefined =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) {
          this.broken = true;
          this.lastError = 'no AudioContext constructor';
          return false;
        }
        const ctx = new Ctor({ latencyHint: 'interactive' });
        this.buildGraph(ctx);
        this.ctx = ctx;
        // The context is the authority on its own state; mirror every change.
        ctx.addEventListener('statechange', () => this.onCtxState());
      } catch (err) {
        console.warn('[audio] unavailable', err);
        this.broken = true;
        this.lastError = err instanceof Error ? err.message : String(err);
        return false;
      }
    }
    this.attempts_ += 1;
    const ctx = this.ctx;
    if (ctx.state === 'closed') {
      this.lastError = 'context closed';
      return false;
    }
    if (ctx.state === 'suspended') {
      // Fire and forget here; `resume()` is the awaitable form.
      void ctx.resume().then(
        () => this.onCtxState(),
        (err: unknown) => {
          this.lastError = err instanceof Error ? err.message : String(err);
        },
      );
    }
    this.onCtxState();
    return ctx.state === 'running';
  }

  /**
   * The awaitable form of `init()`. Resolves to the *verified* running state
   * once the browser has actually settled the resume, so a caller can tell
   * "audio is on" from "the browser refused".
   */
  async resume(): Promise<boolean> {
    if (this.broken) return false;
    this.init();
    const ctx = this.ctx;
    if (!ctx) return false;
    if (ctx.state === 'running') return true;
    if (ctx.state === 'closed') return false;
    try {
      await ctx.resume();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    this.onCtxState();
    // Re-read through the getter: `await` may have changed the state, which
    // the narrowing above cannot know.
    return this.ready;
  }

  /** Mirror the context's own state and notify once on each transition. */
  private onCtxState(): void {
    const now = this.state;
    if (now === this.seenState) return;
    this.seenState = now;
    if (now === 'running') this.lastError = '';
    const cb = this.stateCb;
    if (cb) {
      try {
        cb(now);
      } catch {
        /* a listener must never break audio */
      }
    }
  }

  /** Notified on every real AudioContext state transition. One listener. */
  onStateChange(cb: ((state: string) => void) | null): void {
    this.stateCb = cb;
  }

  /** How many times we have asked the browser to start audio. */
  get attempts(): number {
    return this.attempts_;
  }

  /** Last failure reason, '' once running. */
  get error(): string {
    return this.lastError;
  }

  private buildGraph(ctx: AudioContext): void {
    // Master -> limiter -> out. The compressor is doing brickwall duty: a wave
    // of simultaneous impacts should duck, never clip.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -9;
    limiter.knee.value = 5;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.19;
    limiter.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = this.vol.muted ? 0 : this.vol.master;
    master.connect(limiter);

    const mk = (g: number): GainNode => {
      const n = ctx.createGain();
      n.gain.value = g;
      n.connect(master);
      return n;
    };
    const busses: Record<BusName, GainNode> = {
      sfx: mk(this.vol.sfx),
      music: mk(this.vol.music),
      ui: mk(this.vol.sfx * 0.9),
    };

    // Station reverb — a cold, long, slightly metallic space.
    const verb = ctx.createConvolver();
    verb.normalize = true;
    verb.buffer = this.makeImpulse(ctx, 2.4, 3.1);
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.85;
    const verbIn = ctx.createGain();
    verbIn.gain.value = 1;
    verbIn.connect(verb);
    verb.connect(verbOut);
    verbOut.connect(master);

    // Conduit delay — pitched-down repeats give the arena its scale.
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.27;
    const fb = ctx.createGain();
    fb.gain.value = 0.33;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2100;
    const delayIn = ctx.createGain();
    delayIn.gain.value = 1;
    delayIn.connect(delay);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    damp.connect(master);

    this.master = master;
    this.busses = busses;
    this.verbIn = verbIn;
    this.delayIn = delayIn;
  }

  /**
   * Procedural impulse response: exponentially decaying noise with a handful of
   * early reflections and a one-pole tilt so the tail darkens as it fades.
   */
  private makeImpulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * seconds));
    const buf = ctx.createBuffer(2, len, sr);
    const reflections = [0.011, 0.019, 0.031, 0.047, 0.071, 0.103];
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      let seed = ch === 0 ? 0x9e3779b9 : 0x85ebca6b;
      for (let i = 0; i < len; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const white = (seed / 0x7fffffff - 1) * 0.5;
        const t = i / len;
        lp += (white - lp) * (0.42 - 0.3 * t);
        d[i] = lp * Math.pow(1 - t, decay);
      }
      for (const r of reflections) {
        const i = Math.floor(r * sr) + (ch === 0 ? 0 : 37);
        if (i < len) d[i] += 0.4 * Math.pow(1 - i / len, decay * 0.6);
      }
    }
    return buf;
  }

  // ---------------------------------------------------------------- state

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** 'unavailable' | 'suspended' | 'running' | 'closed' */
  get state(): string {
    if (this.broken) return 'unavailable';
    return this.ctx ? this.ctx.state : 'idle';
  }

  /** Total voices ever allocated. Used by the headless smoke test. */
  get voicesCreated(): number {
    return this.created;
  }

  get voicesActive(): number {
    return this.active;
  }

  /** Voices refused by the cap / distance cull. Diagnostic only. */
  get voicesDropped(): number {
    return this.dropped;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  bus(name: BusName): GainNode | null {
    return this.busses ? this.busses[name] : null;
  }

  /**
   * Input of a shared send effect. Exposed so the music director can place its
   * own long-lived layers in the same space as the sound effects instead of
   * building a second reverb.
   */
  fx(name: 'reverb' | 'delay'): GainNode | null {
    return name === 'reverb' ? this.verbIn : this.delayIn;
  }

  get volumes(): VolumeSettings {
    return { ...this.vol };
  }

  // ---------------------------------------------------------------- mixer

  setVolumes(next: Partial<VolumeSettings>): void {
    if (typeof next.master === 'number') this.vol.master = clamp01(next.master);
    if (typeof next.music === 'number') this.vol.music = clamp01(next.music);
    if (typeof next.sfx === 'number') this.vol.sfx = clamp01(next.sfx);
    if (typeof next.muted === 'boolean') this.vol.muted = next.muted;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.busses) return;
    const t = ctx.currentTime;
    const ramp = (p: AudioParam, v: number): void => {
      try {
        p.cancelScheduledValues(t);
        p.setTargetAtTime(v, t, 0.02);
      } catch {
        p.value = v;
      }
    };
    ramp(this.master.gain, this.vol.muted ? 0 : this.vol.master);
    ramp(this.busses.music.gain, this.vol.music);
    ramp(this.busses.sfx.gain, this.vol.sfx);
    ramp(this.busses.ui.gain, this.vol.sfx * 0.9);
  }

  // ---------------------------------------------------------------- space

  setListener(pos: Vec2 | null | undefined): void {
    if (!pos) return;
    this.listener.x = pos.x;
    this.listener.y = pos.y;
  }

  /** Stereo pan + volume falloff for a world position, relative to the listener. */
  spatial(pos: Vec2 | null | undefined): { pan: number; att: number; dist: number } {
    if (!pos) return { pan: 0, att: 1, dist: 0 };
    const dx = pos.x - this.listener.x;
    const dy = pos.y - this.listener.y;
    const dist = Math.hypot(dx, dy);
    const pan = clamp(dx / PAN_WIDTH, -1, 1) * PAN_MAX;
    if (dist <= NEAR) return { pan, att: 1, dist };
    const k = clamp01(1 - (dist - NEAR) / (FAR - NEAR));
    return { pan, att: k * k, dist };
  }

  // ---------------------------------------------------------------- voices

  /**
   * Reserve a voice. Returns null when audio is off, muted, rate-limited,
   * out of earshot, or the pool is full — callers must tolerate null.
   */
  play(opts: PlayOpts = {}): Voice | null {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed' || this.vol.muted) return null;

    const prio = opts.priority ?? 1;
    const now = ctx.currentTime;
    let start = now + Math.max(0, opts.at ?? 0);

    // Rate limiting *staggers* rather than mutes: a whole tick's worth of hits
    // arrives with one identical timestamp, and three enemies eating the same
    // shotgun should read as a flam, not as a single hit. Only once the stagger
    // would push a sound audibly late do we give up on it.
    if (opts.key) {
      const min = opts.minInterval ?? 0.03;
      const prev = this.lastAt.get(opts.key);
      if (prev !== undefined && start - prev < min) {
        const shifted = prev + min;
        if (shifted - now > MAX_DEFER) {
          this.dropped++;
          return null;
        }
        start = shifted;
      }
      this.lastAt.set(opts.key, start);
      if (this.lastAt.size > 96) this.lastAt.clear();
    }

    const cap = prio >= 2 ? MAX_VOICES + PRIORITY_HEADROOM : MAX_VOICES;
    if (this.active >= cap) {
      this.dropped++;
      return null;
    }

    const { pan, att } = this.spatial(opts.pos);
    const amp = clamp01(opts.gain ?? 1) * att;
    if (amp < 0.004 && prio < 2) {
      this.dropped++;
      return null;
    }

    const busName: BusName = opts.bus ?? 'sfx';
    const bus = this.busses ? this.busses[busName] : null;
    if (!bus) return null;

    const out = ctx.createGain();
    out.gain.value = 1;
    let tail: AudioNode = out;
    if (pan !== 0) {
      try {
        const panner = ctx.createStereoPanner();
        panner.pan.value = pan;
        out.connect(panner);
        tail = panner;
      } catch {
        tail = out;
      }
    }
    tail.connect(bus);

    const send = (target: GainNode | null, level: number | undefined): GainNode | null => {
      if (!target || !level || level <= 0.001) return null;
      const g = ctx.createGain();
      g.gain.value = clamp01(level);
      tail.connect(g);
      g.connect(target);
      return g;
    };
    const verbTap = send(this.verbIn, opts.reverb);
    const delayTap = send(this.delayIn, opts.delay);

    this.active++;
    this.created++;
    let closed = false;

    return {
      ctx,
      out,
      t: start,
      amp,
      end: (at: number): void => {
        if (closed) return;
        closed = true;
        const wait = Math.max(0, (at - ctx.currentTime + TEARDOWN_PAD) * 1000);
        window.setTimeout(() => {
          this.active = Math.max(0, this.active - 1);
          try {
            out.disconnect();
            if (tail !== out) tail.disconnect();
            verbTap?.disconnect();
            delayTap?.disconnect();
          } catch {
            /* already gone */
          }
        }, Math.min(wait, 30000));
      },
    };
  }
}

// ---------------------------------------------------------------- helpers

export function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

export function clamp01(n: number): number {
  return Number.isFinite(n) ? (n < 0 ? 0 : n > 1 ? 1 : n) : 0;
}
