/**
 * VOIDLINE — in-match HUD overlay.
 *
 * Vitals, dash charge, the three Weave slot gauges, objective banner, co-op
 * dialogue (typewriter), damage vignette, kill feed, Tab scoreboard and a
 * ping/fps readout. Everything is DOM; the arena underneath is canvas.
 */

import {
  ABILITY_SLOTS,
  CHAT_MAX_LEN,
  DASH_COOLDOWN,
  DOWNED_DURATION,
  MAX_OVERCHARGE,
  REVIVE_TIME,
} from '@shared/constants.js';
import type {
  Entity,
  EntityId,
  EntityKind,
  GameEvent,
  ObjectiveState,
  PlayerEntity,
  WeaveBoard,
  WorldState,
} from '@shared/types.js';
import { getAbility } from '@shared/abilities.js';
import { getRole } from '@shared/roles.js';
import { add, clear, h, setText } from './dom.js';

const SLOT_KEYS = ['1', '2', '3'];

export interface HudView {
  world: WorldState | null;
  /** Predicted local player — preferred over the snapshot copy. */
  self: PlayerEntity | null;
  selfId: EntityId;
  board: WeaveBoard | null;
  /** Events that crossed the interpolation clock this frame. */
  events: GameEvent[];
  ping: number;
  fps: number;
  /** True while the socket is down, so the HUD can warn. */
  linkDown: boolean;
}

interface FeedEntry {
  el: HTMLElement;
  ttl: number;
}

/**
 * A kill credit observed on the entity list. `death` GameEvents carry only the
 * victim, so the killer has to come from somewhere else — see `trackCredits`.
 */
interface KillCredit {
  killer: EntityId;
  at: number;
}

/**
 * How long a kill credit stays claimable, in seconds. The server increments
 * `killer.kills` in the same tick it emits the `death` event, but the client
 * reads entity state from the *newer* of the two snapshots it is interpolating
 * while events only surface once the interpolation clock reaches them — so a
 * credit lands up to one snapshot interval (50 ms) plus jitter ahead of the
 * death it belongs to, never behind it. 0.5 s is generous cover for that skew
 * while staying short enough that two unrelated kills rarely overlap.
 */
const CREDIT_WINDOW = 0.5;

/** Suppress a repeat of the same toast text inside this many seconds. */
const TOAST_REPEAT_LOCK = 6;

/** Display name for a feed line. Players keep their name, enemies read as their archetype. */
function nameOf(e: Entity | null, fallback: string): string {
  if (!e) return fallback;
  if (e.kind === 'player') return e.name;
  if (e.kind === 'enemy') return e.archetype.toUpperCase();
  return e.kind.toUpperCase();
}

/**
 * Mirrors `isHostile` in shared/combat.ts closely enough to sanity-check a kill
 * credit: 'ffa' entities are hostile to every other 'ffa' entity, otherwise
 * hostility is simply "different team".
 */
function hostile(a: Entity, b: Entity): boolean {
  if (a.team === 'neutral' || b.team === 'neutral') return false;
  if (a.team === 'ffa' && b.team === 'ffa') return a.id !== b.id;
  return a.team !== b.team;
}

interface Gauge {
  root: HTMLElement;
  icon: HTMLElement;
  name: HTMLElement;
  fill: HTMLElement;
  pct: HTMLElement;
  over: HTMLElement;
}

export class Hud {
  readonly root: HTMLElement;

  private hpFill: HTMLElement;
  private shieldFill: HTMLElement;
  private hpText: HTMLElement;
  private nameText: HTMLElement;
  private roleText: HTMLElement;
  private dashPip: HTMLElement;
  private dashFill: HTMLElement;
  private gauges: Gauge[] = [];
  private objBanner: HTMLElement;
  private objLabel: HTMLElement;
  private objProgress: HTMLElement;
  private objMeta: HTMLElement;
  private dialogueBox: HTMLElement;
  private dialogueSpeaker: HTMLElement;
  private dialogueText: HTMLElement;
  private vignette: HTMLElement;
  private feed: HTMLElement;
  private chatWrap!: HTMLElement;
  private chatLog!: HTMLElement;
  private chatInput!: HTMLInputElement;
  /** True while the chat input has focus — gameplay keys must be suppressed. */
  private chatOpen = false;
  private netEl: HTMLElement;
  private scoreboard: HTMLElement;
  private scoreBody: HTMLElement;
  private toast: HTMLElement;
  private stateBanner: HTMLElement;

  private feedEntries: FeedEntry[] = [];
  private vignetteAmount = 0;
  private toastTtl = 0;
  /** Seconds since the HUD was shown; timestamps kill credits and toasts. */
  private clock = 0;
  private lastToastText = '';
  private lastToastAt = -999;
  /** Structural objective transitions worth announcing (wave/chapter/phase). */
  private lastWave = -1;
  private lastChapter = -1;
  /** Last seen `kills` per player entity, and the unclaimed credits it produced. */
  private killTally = new Map<EntityId, number>();
  private credits: KillCredit[] = [];
  private dialogue: { speaker: string; text: string; shown: number; ttl: number } | null = null;
  private scoreboardOpen = false;
  private netAccum = 0;

  constructor() {
    this.root = h('div', 'hud hidden');

    // ---- vignette ------------------------------------------------------
    this.vignette = h('div', 'hud-vignette');
    this.root.appendChild(this.vignette);

    // ---- vitals (top left) ---------------------------------------------
    const vitals = h('div', 'hud-vitals');
    const idRow = h('div', 'vitals-id');
    this.nameText = h('span', 'vitals-name', '');
    this.roleText = h('span', 'vitals-role mono', '');
    add(idRow, this.nameText, this.roleText);

    const bar = h('div', 'hp-bar');
    this.hpFill = h('div', 'hp-fill');
    this.shieldFill = h('div', 'shield-fill');
    this.hpText = h('span', 'hp-text mono', '0');
    add(bar, this.hpFill, this.shieldFill, this.hpText);

    const dashRow = h('div', 'dash-row');
    this.dashPip = h('div', 'dash-pip');
    this.dashFill = h('div', 'dash-pip-fill');
    this.dashPip.appendChild(this.dashFill);
    add(dashRow, this.dashPip, h('span', 'dash-label mono', 'DASH · SPACE'));

    add(vitals, idRow, bar, dashRow);
    this.root.appendChild(vitals);

    // ---- objective (top center) ----------------------------------------
    this.objBanner = h('div', 'hud-objective');
    this.objLabel = h('div', 'obj-label', '');
    const objTrack = h('div', 'obj-track');
    this.objProgress = h('div', 'obj-progress');
    objTrack.appendChild(this.objProgress);
    this.objMeta = h('div', 'obj-meta mono', '');
    add(this.objBanner, this.objLabel, objTrack, this.objMeta);
    this.root.appendChild(this.objBanner);

    // ---- toast ----------------------------------------------------------
    this.toast = h('div', 'hud-toast');
    this.root.appendChild(this.toast);

    // ---- net + kill feed (top right) ------------------------------------
    const right = h('div', 'hud-right');
    this.netEl = h('div', 'hud-net mono', '--ms · --fps');
    this.feed = h('div', 'hud-feed');
    add(right, this.netEl, this.feed);
    this.root.appendChild(right);

    // ---- in-match chat -------------------------------------------------
    // The lobby has COMMS, but once a match starts there was no way to talk —
    // which is rough for a co-op game built around coordinating relay circuits.
    // The log is always visible; the input only exists while composing, so it
    // never eats a movement key.
    this.chatWrap = h('div', 'hud-chat');
    this.chatLog = h('div', 'hud-chat-log');
    this.chatInput = h('input', 'hud-chat-input mono');
    this.chatInput.type = 'text';
    this.chatInput.maxLength = CHAT_MAX_LEN;
    this.chatInput.placeholder = 'transmit…';
    this.chatInput.classList.add('hidden');
    add(this.chatWrap, this.chatLog, this.chatInput);
    this.root.appendChild(this.chatWrap);

    // ---- state banner (downed / respawn / link) -------------------------
    this.stateBanner = h('div', 'hud-state');
    this.root.appendChild(this.stateBanner);

    // ---- dialogue --------------------------------------------------------
    this.dialogueBox = h('div', 'hud-dialogue');
    this.dialogueSpeaker = h('div', 'dlg-speaker mono', '');
    this.dialogueText = h('div', 'dlg-text', '');
    add(this.dialogueBox, this.dialogueSpeaker, this.dialogueText);
    this.root.appendChild(this.dialogueBox);

    // ---- slot gauges (bottom center) ------------------------------------
    const slots = h('div', 'hud-slots');
    for (let i = 0; i < ABILITY_SLOTS; i++) {
      const g = h('div', 'gauge');
      const key = h('span', 'gauge-key mono', SLOT_KEYS[i] ?? String(i + 1));
      const icon = h('span', 'gauge-icon', '·');
      const body = h('div', 'gauge-body');
      const name = h('span', 'gauge-name', '—');
      const track = h('div', 'gauge-track');
      const fill = h('div', 'gauge-fill');
      const over = h('div', 'gauge-over');
      add(track, fill, over);
      const pct = h('span', 'gauge-pct mono', '0%');
      add(body, name, track);
      add(g, key, icon, body, pct);
      const flare = h('span', 'gauge-ready mono', 'READY');
      g.appendChild(flare);
      slots.appendChild(g);
      this.gauges.push({ root: g, icon, name, fill, pct, over });
    }
    this.root.appendChild(slots);

    // ---- scoreboard ------------------------------------------------------
    this.scoreboard = h('div', 'hud-scoreboard');
    const sbHead = h('div', 'sb-head');
    add(sbHead, h('span', 'sb-title', 'RUNNERS'), h('span', 'sb-hint mono', 'HOLD TAB'));
    const table = h('div', 'sb-table');
    const hdr = h('div', 'sb-row sb-header mono');
    add(
      hdr,
      h('span', 'sb-c sb-name', 'RUNNER'),
      h('span', 'sb-c', 'ROLE'),
      h('span', 'sb-c sb-num', 'K'),
      h('span', 'sb-c sb-num', 'D'),
      h('span', 'sb-c sb-num', 'SCORE'),
      h('span', 'sb-c sb-num', 'PING'),
    );
    this.scoreBody = h('div', 'sb-body');
    add(table, hdr, this.scoreBody);
    add(this.scoreboard, sbHead, table);
    this.root.appendChild(this.scoreboard);
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.dialogue = null;
    this.dialogueBox.classList.remove('visible');
    clear(this.feed);
    this.feedEntries = [];
    this.vignetteAmount = 0;
    // Nothing here survives a match: stale credits would mis-attribute the
    // first kill of the next one, and stale toast/objective keys would
    // swallow its opening announcement.
    this.killTally.clear();
    this.credits.length = 0;
    this.lastToastText = '';
    this.lastToastAt = -999;
    this.lastWave = -1;
    this.lastChapter = -1;
    this.toastTtl = 0;
    this.toast.classList.remove('visible');
  }

  setScoreboard(open: boolean): void {
    this.scoreboardOpen = open;
    this.scoreboard.classList.toggle('open', open);
  }

  get scoreboardVisible(): boolean {
    return this.scoreboardOpen;
  }

  // ------------------------------------------------------------------ frame

  update(view: HudView, dtMs: number): void {
    const dt = dtMs / 1000;
    this.clock += dt;
    this.trackCredits(view);
    this.consumeEvents(view);
    this.updateVitals(view);
    this.updateSlots(view);
    this.updateObjective(view.world?.objective ?? null, view.world ?? null);
    this.updateDialogue(dt);
    this.updateFeed(dt);
    this.updateVignette(dt);
    this.updateState(view);

    if (this.toastTtl > 0) {
      this.toastTtl -= dt;
      if (this.toastTtl <= 0) this.toast.classList.remove('visible');
    }

    this.netAccum += dtMs;
    if (this.netAccum > 250) {
      this.netAccum = 0;
      setText(this.netEl, `${view.ping}ms · ${Math.round(view.fps)}fps`);
      this.netEl.classList.toggle('bad', view.ping > 140 || view.fps < 45);
    }

    if (this.scoreboardOpen) this.updateScoreboard(view);
  }

  // ------------------------------------------------------------------ pieces

  private updateVitals(view: HudView): void {
    const self = view.self;
    if (!self) return;
    setText(this.nameText, self.name);
    let color = '#5ef0ff';
    try {
      const role = getRole(self.role);
      if (role) {
        color = role.color;
        setText(this.roleText, role.name.toUpperCase());
      }
    } catch {
      setText(this.roleText, String(self.role).toUpperCase());
    }
    this.root.style.setProperty('--accent-role', color);

    const maxHp = Math.max(1, self.maxHp);
    const hpFrac = Math.max(0, Math.min(1, self.hp / maxHp));
    this.hpFill.style.width = `${hpFrac * 100}%`;
    this.hpFill.classList.toggle('critical', hpFrac < 0.3);
    const shieldFrac = Math.max(0, Math.min(1, (self.shield ?? 0) / maxHp));
    this.shieldFill.style.width = `${shieldFrac * 100}%`;
    setText(
      this.hpText,
      self.shield > 0 ? `${Math.ceil(self.hp)} +${Math.ceil(self.shield)}` : `${Math.ceil(self.hp)}`,
    );

    const cd = Math.max(0, self.dashCooldown ?? 0);
    const ready = cd <= 0.001;
    this.dashFill.style.width = `${(1 - Math.min(1, cd / DASH_COOLDOWN)) * 100}%`;
    this.dashPip.classList.toggle('ready', ready);
  }

  private updateSlots(view: HudView): void {
    const board = view.board;
    for (let i = 0; i < this.gauges.length; i++) {
      const g = this.gauges[i];
      const slot = board?.slots?.[i];
      if (!slot) {
        g.root.classList.remove('ready', 'linked');
        g.root.classList.add('void');
        setText(g.name, '—');
        setText(g.icon, '·');
        setText(g.pct, '');
        g.fill.style.width = '0%';
        g.over.style.width = '0%';
        continue;
      }
      g.root.classList.remove('void');
      let cost = 1;
      let icon = '◆';
      let name = slot.ability;
      try {
        const def = getAbility(slot.ability);
        if (def) {
          cost = Math.max(0.0001, def.cost);
          icon = def.icon || '◆';
          name = def.name;
        }
      } catch {
        /* content not loaded yet */
      }
      const frac = slot.charge / cost;
      const ready = frac >= 1;
      setText(g.icon, icon);
      setText(g.name, name);
      setText(g.pct, ready ? 'READY' : `${Math.floor(Math.min(1, frac) * 100)}%`);
      g.fill.style.width = `${Math.min(1, frac) * 100}%`;
      g.over.style.width = `${Math.max(0, Math.min(1, (frac - 1) / (MAX_OVERCHARGE - 1))) * 100}%`;
      g.root.classList.toggle('ready', ready);
      g.root.classList.toggle('linked', slot.connected);
    }
  }

  private updateObjective(obj: ObjectiveState | null, world: WorldState | null): void {
    if (!obj) {
      this.objBanner.classList.remove('visible');
      return;
    }
    this.objBanner.classList.add('visible');
    setText(this.objLabel, obj.label || '');
    const p = obj.progress;
    const show = typeof p === 'number' && p >= 0;
    this.objProgress.parentElement?.classList.toggle('hidden', !show);
    if (show) this.objProgress.style.width = `${Math.max(0, Math.min(1, p)) * 100}%`;

    const bits: string[] = [];
    if (obj.chapter) bits.push(`CH ${String(obj.chapter).padStart(2, '0')}`);
    if (obj.wave) bits.push(`WAVE ${obj.wave}${obj.totalWaves ? `/${obj.totalWaves}` : ''}`);
    if (obj.teamScores) {
      /*
       * `teamScores` is keyed by SIDE in duel/team arena ('a', 'b') but by PLAYER ID
       * in FFA — so printing the raw key gave a banner reading
       * "BOT_Z9HBWQ_0 0 · BOT_Z9HBWQ_1 0 · …". Resolve ids to runner names when we
       * can; anything that isn't a live player id (i.e. 'a'/'b') falls through to the
       * old uppercase rendering, so duel still reads "A 3 · B 1".
       */
      const nameOf = new Map<string, string>();
      for (const e of world?.entities ?? []) {
        if (e.kind === 'player') nameOf.set(e.playerId, e.name);
      }
      const scores = Object.entries(obj.teamScores);
      // FFA can seat 8 — sort by score so the banner shows who is actually winning.
      if (scores.length > 2) scores.sort((a, b) => b[1] - a[1]);
      for (const [k, v] of scores) bits.push(`${(nameOf.get(k) ?? k).toUpperCase()} ${v}`);
    }
    setText(this.objMeta, bits.join('  ·  '));

    // The banner owns persistent state and nothing else re-broadcasts it.
    // `obj.label` carries a live clock ("ROUND 1 0-0 · 1:21"), so toasting on
    // every label change re-fired the toast once a second and pinned a copy of
    // the banner over the arena. Transitions arrive as `objective` GameEvents
    // (round start/end, boss phase, chapter beats); the only ones not on that
    // wire are the structural wave/chapter steps, which we raise here.
    if (typeof obj.wave === 'number' && obj.wave > 0 && obj.wave !== this.lastWave) {
      const first = this.lastWave < 0;
      this.lastWave = obj.wave;
      if (!first) this.showToast(`WAVE ${obj.wave}${obj.totalWaves ? ` / ${obj.totalWaves}` : ''}`);
    }
    if (typeof obj.chapter === 'number' && obj.chapter > 0 && obj.chapter !== this.lastChapter) {
      const first = this.lastChapter < 0;
      this.lastChapter = obj.chapter;
      if (!first) this.showToast(`CHAPTER ${obj.chapter}`);
    }

    if (obj.dialogue && (!this.dialogue || this.dialogue.text !== obj.dialogue.text)) {
      this.pushDialogue(obj.dialogue.speaker, obj.dialogue.text, 6000);
    }
  }

  private updateDialogue(dt: number): void {
    const d = this.dialogue;
    if (!d) return;
    if (d.shown < d.text.length) {
      d.shown = Math.min(d.text.length, d.shown + dt * 52);
      setText(this.dialogueText, d.text.slice(0, Math.floor(d.shown)));
    }
    d.ttl -= dt;
    if (d.ttl <= 0) {
      this.dialogue = null;
      this.dialogueBox.classList.remove('visible');
    }
  }

  private updateFeed(dt: number): void {
    for (let i = this.feedEntries.length - 1; i >= 0; i--) {
      const e = this.feedEntries[i];
      e.ttl -= dt;
      if (e.ttl < 0.6) e.el.classList.add('fading');
      if (e.ttl <= 0) {
        e.el.remove();
        this.feedEntries.splice(i, 1);
      }
    }
  }

  private updateVignette(dt: number): void {
    if (this.vignetteAmount <= 0) return;
    this.vignetteAmount = Math.max(0, this.vignetteAmount - dt * 1.8);
    this.vignette.style.opacity = String(Math.min(1, this.vignetteAmount));
  }

  private updateState(view: HudView): void {
    const self = view.self;
    let text = '';
    let cls = '';
    if (view.linkDown) {
      text = 'LINK LOST — REESTABLISHING UPLINK';
      cls = 'danger';
    } else if (self?.downed) {
      const pct = Math.round(Math.max(0, Math.min(1, (self.reviveProgress ?? 0) / REVIVE_TIME)) * 100);
      text = `DOWNED — ${Math.ceil(Math.max(0, self.downedTimer ?? DOWNED_DURATION))}s  ${pct > 0 ? `· REVIVE ${pct}%` : '· HOLD ON'}`;
      cls = 'danger';
    } else if (self && self.respawnTimer > 0) {
      text = `RESPAWNING IN ${self.respawnTimer.toFixed(1)}s`;
      cls = 'warn';
    } else if (view.world?.phase === 'countdown') {
      text = `ENGAGE IN ${Math.ceil(view.world.phaseTimer)}`;
      cls = 'warn';
    } else if (view.world?.phase === 'intermission') {
      text = 'INTERMISSION';
      cls = 'warn';
    }
    this.stateBanner.className = `hud-state${text ? ' visible ' + cls : ''}`;
    setText(this.stateBanner, text);
  }

  private updateScoreboard(view: HudView): void {
    const world = view.world;
    clear(this.scoreBody);
    if (!world) return;
    const players = world.entities.filter((e): e is PlayerEntity => e.kind === 'player');
    players.sort((a, b) => b.score - a.score || b.kills - a.kills);
    for (const p of players) {
      const row = h('div', 'sb-row mono');
      row.classList.toggle('is-self', p.id === view.selfId);
      let roleName = String(p.role).toUpperCase();
      let color = '';
      try {
        const r = getRole(p.role);
        if (r) {
          roleName = r.name.toUpperCase();
          color = r.color;
        }
      } catch {
        /* ignore */
      }
      const nameCell = h('span', 'sb-c sb-name', p.name);
      if (color) nameCell.style.color = color;
      add(
        row,
        nameCell,
        h('span', 'sb-c', roleName),
        h('span', 'sb-c sb-num', String(p.kills)),
        h('span', 'sb-c sb-num', String(p.deaths)),
        h('span', 'sb-c sb-num', String(Math.round(p.score))),
        h('span', 'sb-c sb-num', `${Math.round(p.ping)}`),
      );
      if (!p.connected) row.classList.add('is-gone');
      this.scoreBody.appendChild(row);
    }
  }

  // ------------------------------------------------------------------ events

  /**
   * Harvest kill credit from the entity list.
   *
   * `GameEvent` of kind `death` names only the victim — there is no killer
   * field on the wire. But the server bumps `killer.kills` in the very same
   * tick it emits that death (`shared/combat.ts` does it one line before the
   * emit, and the co-op / PvP mode handlers mirror their scoring onto the
   * entities before the snapshot is serialised). So the authoritative killer
   * is exactly whoever's `kills` went up, and we read it off the snapshot.
   */
  private trackCredits(view: HudView): void {
    const world = view.world;
    if (!world) return;
    for (const e of world.entities) {
      if (e.kind !== 'player') continue;
      const seen = this.killTally.get(e.id);
      this.killTally.set(e.id, e.kills);
      // First sighting only seeds the tally — joining mid-match must not
      // dump that player's whole score into the feed.
      if (seen === undefined) continue;
      for (let n = seen; n < e.kills; n++) this.credits.push({ killer: e.id, at: this.clock });
    }
    const cutoff = this.clock - CREDIT_WINDOW;
    while (this.credits.length > 0 && this.credits[0].at < cutoff) this.credits.shift();
  }

  /**
   * Claim the credit that best explains `victim` dying, or null if no player
   * is accountable (environment, self-inflicted, or an enemy did it — enemies
   * have no score to increment, so they are simply unattributable).
   * Newest first: credits precede their death by well under a second.
   */
  private claimCredit(world: WorldState | null, victim: Entity | null): Entity | null {
    for (let i = this.credits.length - 1; i >= 0; i--) {
      const c = this.credits[i];
      if (victim && c.killer === victim.id) continue; // never credit the victim
      const killer = world?.entities.find((e) => e.id === c.killer) ?? null;
      if (victim && killer && !hostile(killer, victim)) continue;
      this.credits.splice(i, 1);
      return killer;
    }
    return null;
  }

  private consumeEvents(view: HudView): void {
    if (!view.events.length) return;
    const world = view.world;
    const find = (id: EntityId): Entity | null =>
      world?.entities.find((x) => x.id === id) ?? null;
    const byPlayerId = (pid: string): Entity | null =>
      world?.entities.find((x) => x.kind === 'player' && x.playerId === pid) ?? null;

    for (const ev of view.events) {
      switch (ev.t) {
        case 'hit':
          if (ev.target === view.selfId) {
            this.vignetteAmount = Math.min(1.15, this.vignetteAmount + 0.25 + ev.damage / 90);
            this.vignette.style.opacity = String(Math.min(1, this.vignetteAmount));
          }
          break;
        case 'death':
          this.feedDeath(view, ev.entity, ev.kind, find(ev.entity));
          break;
        case 'revive': {
          const by = byPlayerId(ev.by);
          const who = byPlayerId(ev.player);
          this.pushDuel(
            nameOf(by, ev.by),
            '✚',
            nameOf(who, ev.player),
            by?.id === view.selfId || who?.id === view.selfId,
            'is-revive',
            by?.id === view.selfId,
            who?.id === view.selfId,
          );
          break;
        }
        case 'objective':
          this.showToast(ev.label);
          break;
        case 'dialogue':
          this.pushDialogue(ev.speaker, ev.text, ev.durationMs);
          break;
        default:
          break;
      }
    }
  }

  /**
   * One death, rendered as who-killed-whom. Falls back to a cause-and-victim
   * line whenever no player is accountable, rather than inventing a killer.
   */
  private feedDeath(
    view: HudView,
    victimId: EntityId,
    eventKind: EntityKind,
    victim: Entity | null,
  ): void {
    const kind: EntityKind = victim?.kind ?? eventKind;
    // Projectiles and zones expire constantly; they are not news.
    if (kind !== 'player' && kind !== 'enemy') return;

    const coop = view.world?.mode === 'coop_story';
    const isSelf = victimId === view.selfId;
    const vName = nameOf(victim, kind === 'player' ? 'RUNNER' : 'HOSTILE');

    if (kind === 'enemy') {
      // Only the ones worth a line: bosses and elites.
      const archetype = victim && victim.kind === 'enemy' ? victim.archetype : '';
      if (!/boss|elite/i.test(archetype)) return;
      const killer = this.claimCredit(view.world ?? null, victim);
      if (killer) {
        this.pushDuel(nameOf(killer, 'RUNNER'), '▸', vName, killer.id === view.selfId, 'is-kill', killer.id === view.selfId, false);
      } else {
        this.pushFeed(vName, 'DESTROYED', false);
      }
      return;
    }

    // ---- a player went down ----------------------------------------------
    // Co-op emits a death when you are downed AND again when you bleed out.
    // `downed` on the snapshot tells the two apart.
    if (coop && victim && victim.kind === 'player' && !victim.downed) {
      this.pushFeed(vName, 'BLED OUT', isSelf);
      return;
    }

    const killer = this.claimCredit(view.world ?? null, victim);
    if (killer) {
      this.pushDuel(
        nameOf(killer, 'RUNNER'),
        '▸',
        vName,
        isSelf || killer.id === view.selfId,
        'is-kill',
        killer.id === view.selfId,
        isSelf,
      );
      return;
    }
    // Nobody scored: an enemy, the station itself, or their own ordnance.
    this.pushFeed(vName, coop ? 'DOWNED' : 'FLATLINED', isSelf);
  }

  // ------------------------------------------------------------------ chat

  /** True while the player is composing — `main.ts` must not read gameplay keys. */
  get isChatOpen(): boolean {
    return this.chatOpen;
  }

  /**
   * Open the composer. `onSend` fires on Enter with a non-empty line; Escape or a
   * blank Enter closes without sending. Focus is what makes this safe: while the
   * input is focused every keystroke belongs to the text field, so WASD types
   * instead of moving.
   */
  openChat(onSend: (text: string) => void): void {
    if (this.chatOpen) return;
    this.chatOpen = true;
    this.chatInput.value = '';
    this.chatInput.classList.remove('hidden');
    this.chatWrap.classList.add('composing');
    this.chatInput.focus();

    const finish = (send: boolean): void => {
      const text = this.chatInput.value.trim();
      this.chatInput.removeEventListener('keydown', onKey);
      this.chatInput.blur();
      this.chatInput.value = '';
      this.chatInput.classList.add('hidden');
      this.chatWrap.classList.remove('composing');
      this.chatOpen = false;
      if (send && text.length > 0) onSend(text.slice(0, CHAT_MAX_LEN));
    };
    const onKey = (e: KeyboardEvent): void => {
      // Stop gameplay handlers on window from ever seeing these.
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
    this.chatInput.addEventListener('keydown', onKey);
  }

  /** Render an incoming line. `self` highlights your own messages. */
  pushChat(name: string, text: string, self: boolean): void {
    const el = h('div', 'hud-chat-line');
    if (self) el.classList.add('is-you');
    add(el, h('span', 'hud-chat-name', name), h('span', 'hud-chat-text', text));
    this.chatLog.appendChild(el);
    while (this.chatLog.childElementCount > 6) {
      this.chatLog.removeChild(this.chatLog.firstElementChild as Element);
    }
    // Fade old lines out so chat never permanently occludes the arena.
    window.setTimeout(() => {
      el.classList.add('fading');
      window.setTimeout(() => el.remove(), 900);
    }, 12000);
  }

  pushFeed(subject: string, verb: string, self: boolean): void {
    const el = h('div', 'feed-line');
    if (self) el.classList.add('is-self');
    add(el, h('span', 'feed-subject', subject), h('span', 'feed-verb mono', verb));
    this.mountFeed(el);
  }

  /** `actor ▸ target` — the shape a kill feed is supposed to have. */
  private pushDuel(
    actor: string,
    arrow: string,
    target: string,
    self: boolean,
    cls: string,
    actorIsYou: boolean,
    targetIsYou: boolean,
  ): void {
    const el = h('div', `feed-line ${cls}`);
    if (self) el.classList.add('is-self');
    const a = h('span', 'feed-actor', actor);
    const t = h('span', 'feed-target', target);
    if (actorIsYou) a.classList.add('is-you');
    if (targetIsYou) t.classList.add('is-you');
    add(el, a, h('span', 'feed-arrow mono', arrow), t);
    this.mountFeed(el);
  }

  private mountFeed(el: HTMLElement): void {
    this.feed.appendChild(el);
    this.feedEntries.push({ el, ttl: 6 });
    while (this.feedEntries.length > 6) {
      const old = this.feedEntries.shift();
      old?.el.remove();
    }
  }

  pushDialogue(speaker: string, text: string, durationMs: number): void {
    this.dialogue = { speaker, text, shown: 0, ttl: Math.max(2, durationMs / 1000) };
    setText(this.dialogueSpeaker, speaker.toUpperCase());
    setText(this.dialogueText, '');
    this.dialogueBox.classList.add('visible');
  }

  /**
   * Announce a transition. The toast is for things that just *happened*; the
   * objective banner owns the running state, so anything still true a second
   * later belongs there and not here. Identical text inside the lock window is
   * dropped, which is what stops a per-second label from strobing.
   */
  showToast(text: string): void {
    if (!text) return;
    if (text === this.lastToastText && this.clock - this.lastToastAt < TOAST_REPEAT_LOCK) return;
    this.lastToastText = text;
    this.lastToastAt = this.clock;
    setText(this.toast, text);
    this.toast.classList.remove('visible');
    void this.toast.offsetWidth;
    this.toast.classList.add('visible');
    this.toastTtl = 3;
  }
}
