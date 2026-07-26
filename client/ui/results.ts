/**
 * VOIDLINE — post-match results.
 * Standings table from `MatchResult`, plus the co-op chapter-cleared state.
 */

import type { MatchResult } from '@shared/protocol.js';
import type { PlayerId, RoleId, Team } from '@shared/types.js';
import { getRole } from '@shared/roles.js';
import { CHAPTER_NAMES } from './lobby.js';
import { add, button, clear, clock, h, setText } from './dom.js';

export interface ResultsCallbacks {
  onContinue(): void;
  onLeave(): void;
}

export class ResultsScreen {
  readonly root: HTMLElement;

  private headline: HTMLElement;
  private subline: HTMLElement;
  private metaEl: HTMLElement;
  private bodyEl: HTMLElement;
  private calloutEl: HTMLElement;

  constructor(cb: ResultsCallbacks) {
    this.root = h('div', 'screen screen-results hidden');
    const shell = h('div', 'results-shell');

    const head = h('div', 'results-head');
    this.headline = h('h2', 'results-headline', '');
    this.subline = h('div', 'results-subline mono', '');
    add(head, this.headline, this.subline);
    shell.appendChild(head);

    this.metaEl = h('div', 'results-meta mono');
    shell.appendChild(this.metaEl);

    const table = h('div', 'results-table');
    const hdr = h('div', 'results-row results-header mono');
    add(
      hdr,
      h('span', 'rc rc-rank', '#'),
      h('span', 'rc rc-name', 'RUNNER'),
      h('span', 'rc rc-role', 'ROLE'),
      h('span', 'rc rc-num', 'SCORE'),
      h('span', 'rc rc-num', 'K'),
      h('span', 'rc rc-num', 'D'),
      h('span', 'rc rc-num', 'DEALT'),
      h('span', 'rc rc-num', 'TAKEN'),
      h('span', 'rc rc-num', 'CHARGED'),
      h('span', 'rc rc-num', 'REVIVES'),
    );
    this.bodyEl = h('div', 'results-body');
    add(table, hdr, this.bodyEl);
    shell.appendChild(table);

    this.calloutEl = h('div', 'results-callouts');
    shell.appendChild(this.calloutEl);

    const actions = h('div', 'results-actions');
    add(
      actions,
      button('BACK TO LOBBY', 'primary', () => cb.onContinue()),
      button('LEAVE ROOM', 'danger', () => cb.onLeave()),
    );
    shell.appendChild(actions);

    this.root.appendChild(shell);
  }

  show(result: MatchResult, selfId: PlayerId, selfTeam: Team | null): void {
    this.root.classList.remove('hidden');
    this.render(result, selfId, selfTeam);
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  private render(result: MatchResult, selfId: PlayerId, selfTeam: Team | null): void {
    const coop = result.mode === 'coop_story';
    const cleared = coop ? result.chapterCleared === true || result.winner === 'players' : false;

    let headline: string;
    let tone: string;
    if (coop) {
      headline = cleared ? 'CHAPTER CLEARED' : 'RUN LOST';
      tone = cleared ? 'win' : 'loss';
    } else {
      const top = result.standings[0];
      const iWon = selfTeam ? result.winner === selfTeam : top?.playerId === selfId;
      headline = iWon ? 'VICTORY' : 'DEFEAT';
      tone = iWon ? 'win' : 'loss';
    }
    this.root.dataset.tone = tone;
    setText(this.headline, headline);

    if (coop) {
      const idx = Math.max(0, Math.min(CHAPTER_NAMES.length - 1, (result.chapter ?? 1) - 1));
      setText(
        this.subline,
        cleared
          ? `CH ${String(result.chapter ?? 1).padStart(2, '0')} · ${CHAPTER_NAMES[idx]} · NEXT CHAPTER UNLOCKED`
          : `CH ${String(result.chapter ?? 1).padStart(2, '0')} · ${CHAPTER_NAMES[idx]} · THE STATION HOLDS`,
      );
    } else {
      const top = result.standings[0];
      setText(
        this.subline,
        top ? `${result.winner.toUpperCase()} TAKES IT · TOP RUNNER ${top.name.toUpperCase()}` : result.winner.toUpperCase(),
      );
    }

    setText(this.metaEl, `${modeLabel(result.mode)}  ·  DURATION ${clock(result.durationSec)}`);

    clear(this.bodyEl);
    result.standings.forEach((s, i) => {
      const row = h('div', 'results-row mono');
      row.classList.toggle('is-self', s.playerId === selfId);
      let roleName = String(s.role).toUpperCase();
      let color = '';
      try {
        const r = getRole(s.role as RoleId);
        if (r) {
          roleName = r.name.toUpperCase();
          color = r.color;
        }
      } catch {
        /* content module unavailable */
      }
      const nameCell = h('span', 'rc rc-name', s.name);
      if (color) nameCell.style.color = color;
      const roleCell = h('span', 'rc rc-role', roleName);
      if (color) roleCell.style.color = color;
      add(
        row,
        h('span', 'rc rc-rank', String(i + 1)),
        nameCell,
        roleCell,
        h('span', 'rc rc-num rc-score', String(Math.round(s.score))),
        h('span', 'rc rc-num', String(s.kills)),
        h('span', 'rc rc-num', String(s.deaths)),
        h('span', 'rc rc-num', String(Math.round(s.damageDealt))),
        h('span', 'rc rc-num', String(Math.round(s.damageTaken))),
        h('span', 'rc rc-num', String(s.slotsCharged)),
        h('span', 'rc rc-num', String(s.revives)),
      );
      this.bodyEl.appendChild(row);
    });

    clear(this.calloutEl);
    const best = (
      key: 'damageDealt' | 'slotsCharged' | 'kills' | 'revives',
    ): MatchResult['standings'][number] | null =>
      result.standings.reduce<MatchResult['standings'][number] | null>(
        (acc, s) => (!acc || s[key] > acc[key] ? s : acc),
        null,
      );
    const callouts: Array<[string, string]> = [];
    const dmg = best('damageDealt');
    if (dmg && dmg.damageDealt > 0) callouts.push(['HEAVIEST OUTPUT', `${dmg.name} · ${Math.round(dmg.damageDealt)}`]);
    const charged = best('slotsCharged');
    if (charged && charged.slotsCharged > 0) callouts.push(['CLEANEST ROUTING', `${charged.name} · ${charged.slotsCharged} slots`]);
    const rev = best('revives');
    if (rev && rev.revives > 0) callouts.push(['PULLED THEM BACK', `${rev.name} · ${rev.revives}`]);
    const kills = best('kills');
    if (kills && kills.kills > 0) callouts.push(['MOST KILLS', `${kills.name} · ${kills.kills}`]);
    for (const [label, value] of callouts) {
      const c = h('div', 'callout');
      add(c, h('span', 'callout-label mono', label), h('span', 'callout-value', value));
      this.calloutEl.appendChild(c);
    }
  }
}

function modeLabel(mode: string): string {
  if (mode === 'pvp_duel') return 'DUEL';
  if (mode === 'pvp_arena') return 'ARENA';
  if (mode === 'coop_story') return 'CO-OP STORY';
  return mode.toUpperCase();
}
