/**
 * VOIDLINE — audio public API.
 *
 * The whole subsystem behind one object. Nothing here throws, nothing here
 * allocates per frame, and nothing here exists until the player's first click.
 *
 *   audio.unlock()                 // from a real user gesture, once
 *   audio.setListener(self.pos)    // per frame
 *   audio.handleEvents(evts, me)   // per frame, same array the renderer eats
 *   audio.updateWeave(board)       // per frame while in a match
 *   audio.updateMusic({ ... })     // per frame; state changes are deduped
 */

import type { GameEvent, MatchPhase, ObjectiveState, PlayerId, Vec2, WeaveBoard } from '@shared/types.js';
import { getAbility } from '@shared/abilities.js';

import { AudioEngine, clamp01 } from './engine.js';
import type { VolumeSettings } from './engine.js';
import { MusicDirector } from './music.js';
import type { MusicState } from './music.js';
import { Sfx } from './sfx.js';
import type { StingKind, UiSound } from './sfx.js';
import { loadLocal, saveLocal } from '../ui/dom.js';

export type { MusicState } from './music.js';
export type { StingKind, UiSound } from './sfx.js';
export type { VolumeSettings } from './engine.js';

const LS_PREFIX = 'voidline.audio.';

/** Capture + passive: the unlock retry must never shadow or delay game input. */
const RETRY_OPTS: AddEventListenerOptions = { capture: true, passive: true };

export interface MusicContext {
  screen: string;
  phase?: MatchPhase;
  objective?: ObjectiveState;
  /** True while a boss-class enemy is alive. */
  boss?: boolean;
}

interface SlotAudio {
  frac: number;
  connected: boolean;
}

class VoidlineAudio {
  private eng = new AudioEngine();
  private sfx = new Sfx(this.eng);
  private music = new MusicDirector(this.eng);

  /** True only once the context has been observed `running`. Never a guess. */
  private unlocked = false;
  private retryArmed = false;
  private stateCb: ((state: string, ready: boolean) => void) | null = null;
  private screen = 'title';
  /** Sticky across the results screen so a win does not fall back to lobby music. */
  private outcome: MusicState | null = null;
  private lastCountdown = -1;
  /** Reused every frame so the weave update never allocates. */
  private slots: SlotAudio[] = [
    { frac: 0, connected: false },
    { frac: 0, connected: false },
    { frac: 0, connected: false },
  ];

  constructor() {
    const num = (key: string, dflt: number): number => {
      const raw = loadLocal(LS_PREFIX + key, '');
      const v = raw === '' ? NaN : Number(raw);
      return Number.isFinite(v) ? clamp01(v) : dflt;
    };
    this.eng.setVolumes({
      master: num('master', 0.75),
      music: num('music', 0.55),
      sfx: num('sfx', 0.9),
      muted: loadLocal(LS_PREFIX + 'muted', '0') === '1',
    });
    // Always watch the context itself. If the browser resumes us late (or the
    // OS suspends us mid-match) we find out from the context, not from a guess.
    this.eng.onStateChange((s) => this.emitState(s));
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Bring audio online. Must be called synchronously from a user-gesture
   * handler (pointerdown/keydown) — the browser will not let us start sound
   * any other way. Cheap and idempotent after the first success.
   *
   * Returns **only** whether the AudioContext is verifiably `running` at this
   * moment. `resume()` is asynchronous, so the very first call inside a
   * gesture normally returns false and the *next* gesture returns true; a
   * caller looping on the return value therefore retries instead of latching
   * a lie. We also arm our own gesture retry so audio recovers even if the
   * caller stops asking, and `confirmUnlock()` is the awaitable form.
   */
  unlock(): boolean {
    const running = this.eng.init();
    if (running) {
      this.goLive();
      return true;
    }
    // Not (yet) running: settle the resume in the background and make sure
    // some later gesture tries again.
    void this.eng.resume().then((ok) => {
      if (ok) this.goLive();
      else this.armGestureRetry();
    });
    this.armGestureRetry();
    return false;
  }

  /** Awaitable unlock: resolves to the verified running state. */
  async confirmUnlock(): Promise<boolean> {
    const ok = await this.eng.resume();
    if (ok) this.goLive();
    else this.armGestureRetry();
    return ok;
  }

  /** True only when the context really is running. */
  get ready(): boolean {
    return this.eng.ready;
  }

  /**
   * True when we have asked the browser to start audio and it still has not
   * started. This is the flag a screen should watch to tell the player that
   * sound is off, instead of the game pretending it is on.
   */
  get blocked(): boolean {
    return this.eng.attempts > 0 && !this.eng.ready;
  }

  /** Why audio is not running: '' when fine, otherwise something showable. */
  get blockedReason(): string {
    if (this.eng.ready) return '';
    if (this.eng.state === 'unavailable') return 'AUDIO UNAVAILABLE IN THIS BROWSER';
    if (this.eng.attempts === 0) return '';
    return 'AUDIO BLOCKED — CLICK TO ENABLE';
  }

  /**
   * Observe real transitions of the audio context ('suspended' -> 'running'
   * and back). One listener; the UI owns the rendering.
   */
  onStateChange(cb: ((state: string, ready: boolean) => void) | null): void {
    this.stateCb = cb;
    if (cb) cb(this.eng.state, this.eng.ready);
  }

  private emitState(s: string): void {
    if (s === 'running') {
      this.goLive();
      return; // goLive already notified
    }
    // Dropped back out of 'running' (tab backgrounded, OS took the device).
    // Stop claiming we are up, and arm a retry so the next gesture recovers.
    this.unlocked = false;
    this.armGestureRetry();
    const cb = this.stateCb;
    if (cb) cb(s, this.eng.ready);
  }

  /** Everything that must happen exactly once, when audio truly comes up. */
  private goLive(): void {
    this.disarmGestureRetry();
    if (this.unlocked || !this.eng.ready) return;
    this.unlocked = true;
    this.music.start();
    this.music.setState(this.musicFor({ screen: this.screen }));
    const cb = this.stateCb;
    if (cb) cb('running', true);
  }

  /**
   * Autoplay was refused. Listen for the next real gesture and try again —
   * capture-phase and passive so this can never interfere with gameplay input.
   */
  private armGestureRetry(): void {
    if (this.retryArmed || this.eng.ready || this.eng.state === 'unavailable') return;
    this.retryArmed = true;
    window.addEventListener('pointerdown', this.retry, RETRY_OPTS);
    window.addEventListener('keydown', this.retry, RETRY_OPTS);
    window.addEventListener('touchend', this.retry, RETRY_OPTS);
  }

  private disarmGestureRetry(): void {
    if (!this.retryArmed) return;
    this.retryArmed = false;
    window.removeEventListener('pointerdown', this.retry, RETRY_OPTS);
    window.removeEventListener('keydown', this.retry, RETRY_OPTS);
    window.removeEventListener('touchend', this.retry, RETRY_OPTS);
  }

  /** Bound once so add/removeEventListener always see the same reference. */
  private retry = (): void => {
    this.disarmGestureRetry();
    if (this.eng.init()) this.goLive();
    else void this.eng.resume().then((ok) => (ok ? this.goLive() : this.armGestureRetry()));
  };

  /**
   * Diagnostics — also what the headless smoke test asserts against.
   * `unlocked` is derived from the context, so it can never disagree with
   * `state` / `ready` the way it used to.
   */
  get diagnostics(): {
    state: string;
    unlocked: boolean;
    ready: boolean;
    blocked: boolean;
    attempts: number;
    error: string;
    voicesCreated: number;
    voicesActive: number;
    voicesDropped: number;
    music: MusicState;
    volumes: VolumeSettings;
  } {
    const ready = this.eng.ready;
    return {
      state: this.eng.state,
      unlocked: this.unlocked && ready,
      ready,
      blocked: this.blocked,
      attempts: this.eng.attempts,
      error: this.eng.error,
      voicesCreated: this.eng.voicesCreated,
      voicesActive: this.eng.voicesActive,
      voicesDropped: this.eng.voicesDropped,
      music: this.music.current,
      volumes: this.eng.volumes,
    };
  }

  // ---------------------------------------------------------------- mixer

  get volumes(): VolumeSettings {
    return this.eng.volumes;
  }

  setVolume(kind: 'master' | 'music' | 'sfx', value: number): void {
    const v = clamp01(value);
    this.eng.setVolumes({ [kind]: v });
    saveLocal(LS_PREFIX + kind, v.toFixed(3));
  }

  setMuted(muted: boolean): void {
    this.eng.setVolumes({ muted });
    saveLocal(LS_PREFIX + 'muted', muted ? '1' : '0');
    if (muted) this.sfx.weaveSilence();
  }

  /** Returns the new muted state. */
  toggleMute(): boolean {
    const next = !this.eng.volumes.muted;
    this.setMuted(next);
    if (!next) this.sfx.ui('toggle');
    return next;
  }

  // ---------------------------------------------------------------- space

  setListener(pos: Vec2 | null | undefined): void {
    this.eng.setListener(pos);
  }

  // ---------------------------------------------------------------- events

  /**
   * Drain a frame's worth of `GameEvent`s. Same array the renderer consumes —
   * read-only here. `self` scopes the private Weave cues to the local player.
   */
  handleEvents(events: readonly GameEvent[] | undefined, self?: PlayerId): void {
    if (!events || events.length === 0 || !this.eng.ready) return;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.t) {
        case 'hit':
          this.sfx.hit(e.pos, e.damage, e.crit);
          break;
        case 'death':
          this.sfx.death(e.pos, e.kind);
          break;
        case 'cast':
          this.sfx.cast(e.ability, e.pos);
          break;
        case 'dash':
          this.sfx.dash(e.from, e.to);
          break;
        case 'slotCharged':
          if (!self || e.player === self) this.sfx.weaveCharged(e.slot);
          break;
        case 'weavePower':
          if (!self || e.player === self) this.sfx.weavePower(e.slot, e.connected);
          break;
        case 'revive':
          this.sfx.revive(null);
          break;
        case 'objective':
          this.sfx.objective();
          break;
        case 'dialogue':
          this.sfx.dialogue(e.speaker);
          break;
        case 'shake':
          this.sfx.shake(e.magnitude);
          break;
        case 'sfx':
          this.sfx.named(e.name, e.pos ?? null);
          break;
      }
    }
  }

  // ---------------------------------------------------------------- weave

  /** Per-frame charge/connection state for the local board. Null = silence it. */
  updateWeave(board: WeaveBoard | null | undefined): void {
    if (!this.eng.ready) return;
    if (!board || !board.slots) {
      this.sfx.weaveSilence();
      return;
    }
    for (let i = 0; i < this.slots.length; i++) {
      const s = board.slots[i];
      const out = this.slots[i];
      if (!s) {
        out.frac = 0;
        out.connected = false;
        continue;
      }
      let cost = 1;
      try {
        cost = Math.max(0.0001, getAbility(s.ability)?.cost ?? 1);
      } catch {
        cost = 1;
      }
      out.frac = clamp01(s.charge / cost);
      out.connected = !!s.connected;
    }
    this.sfx.updateWeave(this.slots);
  }

  /** A tile was rotated (local, optimistic — fires on click, not on the ack). */
  weaveRotate(): void {
    this.sfx.weaveRotate();
  }

  weaveSilence(): void {
    this.sfx.weaveSilence();
  }

  // ---------------------------------------------------------------- ui

  ui(kind: UiSound): void {
    this.sfx.ui(kind);
  }

  /**
   * Countdown seconds remaining. Ticks once per integer second and fires the
   * match-start sting when it hits zero.
   */
  countdown(secondsRemaining: number): void {
    if (!this.eng.ready) return;
    const n = Math.ceil(secondsRemaining);
    if (n === this.lastCountdown) return;
    this.lastCountdown = n;
    if (n > 0 && n <= 5) this.sfx.countdown(n);
  }

  resetCountdown(): void {
    this.lastCountdown = -1;
  }

  sting(kind: StingKind): void {
    this.sfx.sting(kind);
    if (kind === 'victory') this.setMusic('victory');
    else if (kind === 'defeat') this.setMusic('defeat');
  }

  /** Match started: sting plus the outcome state cleared for the next result. */
  matchStart(): void {
    this.outcome = null;
    this.resetCountdown();
    this.sfx.sting('start');
  }

  /** Match ended. `won` picks the sting and the resolving music state. */
  matchEnd(won: boolean): void {
    this.outcome = won ? 'victory' : 'defeat';
    this.sfx.weaveSilence();
    this.sting(won ? 'victory' : 'defeat');
  }

  // ---------------------------------------------------------------- music

  setMusic(state: MusicState, intensity?: number): void {
    this.music.setState(state, intensity);
  }

  /**
   * Per-frame music sync. Derives the score state from where the player is and
   * what the world is doing; both `setState` and `setIntensity` are deduped so
   * calling this every frame costs a couple of comparisons.
   */
  updateMusic(c: MusicContext): void {
    this.screen = c.screen;
    if (!this.unlocked) return;
    this.music.setState(this.musicFor(c));
    this.music.setIntensity(this.intensityFor(c));
  }

  private musicFor(c: MusicContext): MusicState {
    switch (c.screen) {
      case 'title':
        return 'menu';
      case 'lobby':
      case 'loadout':
        return this.outcome ?? 'lobby';
      case 'results':
        return this.outcome ?? 'lobby';
      case 'playing':
        if (c.phase === 'countdown' || c.phase === 'intermission') return 'tension';
        if (c.phase === 'complete') return this.outcome ?? 'lobby';
        if (c.boss) return 'boss';
        return 'combat';
      default:
        return 'menu';
    }
  }

  private intensityFor(c: MusicContext): number {
    const o = c.objective;
    if (!o) return 0.3;
    // Co-op: how deep into the chapter we are. PvP: objective progress.
    if (typeof o.wave === 'number' && typeof o.totalWaves === 'number' && o.totalWaves > 0) {
      return clamp01((o.wave - 1) / o.totalWaves);
    }
    if (typeof o.progress === 'number' && o.progress >= 0) return clamp01(o.progress);
    return 0.4;
  }
}

/** The one instance. Import this, not the classes. */
export const audio = new VoidlineAudio();
export type { VoidlineAudio };
