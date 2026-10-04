/**
 * End screens. Victory (world.winner is the player): FLAGISTAN APPROACHES. Defeat: YOUR SURVEY
 * HAS BEEN OVERWRITTEN, shown the moment the player's camp is eliminated with Spectate / Play
 * again / Title, and again (final) when the match ends. A dawn crowning (victory event reason
 * 'dawn') reads DAWN OVER THE BURN instead, names the dominant Survey and the measure that
 * decided it, and waits for its banner first. A seatless online watcher gets a neutral verdict.
 * All of them list every faction's stats and the match time.
 *
 * Online the host's leader takes everyone back to the lobby ("Back to lobby"), the others wait
 * for them, and anyone may leave; there is no local "Play again". Handles are written as text.
 */
import type { GameEvent } from '../sim/events';
import { dominanceOrder } from '../sim/systems/victory';
import type { FactionId, FactionStats } from '../sim/types';
import type { World } from '../sim/world';
import type { UiHost, UiPart } from './core';
import { DAWN_BANNER_S, factionName, matchScreen } from './core';
import { dawnLead } from './dawn';
import { button, el, fmtClock, html, setClass, show } from './dom';
import { iconSvg } from './icons';
import { DEFEAT_LINES, VICTORY_LINES } from './lore';
import { leaderName } from './online';
import { sigilSvg } from './title';
import { matchSettings } from '../sim/matchSettings';

type Mode = 'hidden' | 'eliminated' | 'victory' | 'defeat' | 'draw' | 'over';
/** How the match was won; the victory event's reason, absent meaning conquest. */
type EndReason = 'conquest' | 'dawn';

const MODES: readonly Exclude<Mode, 'hidden'>[] = ['victory', 'defeat', 'eliminated', 'draw', 'over'];

const ORDINAL: Record<number, string> = { 2: '2nd', 3: '3rd', 4: '4th' };

const STAT_ROWS: readonly (readonly [keyof FactionStats, string])[] = [
  ['flagsPlanted', 'Flags planted'],
  ['flagsPulled', 'Flags pulled'],
  ['flagsStolen', 'Flags stolen'],
  ['facetsPeak', 'Peak Survey (facets)'],
  ['crystalsManifested', 'Crystals manifested'],
  ['captures', 'Hearths captured'],
  ['hippiesRecruited', 'Signifiers recruited'],
  ['cmi', 'C.M.I.'],
];

export class EndScreen implements UiPart {
  private host: UiHost;
  private root: HTMLElement;
  private box: HTMLElement;
  private buttons: HTMLElement | null = null;
  private mode: Mode = 'hidden';
  private eliminatedBy: FactionId | null = null;
  private eliminated = false;
  private spectating = false;
  private reason: EndReason = 'conquest';
  /** performance.now() of the first tick that read screen 'ended' (a dawn crowning holds the cards back). */
  private endedAt = 0;
  /** Online button row state it was built for: leader or not, and whom the others wait for. */
  private buttonsKey = '';

  constructor(host: UiHost, parent: HTMLElement) {
    this.host = host;
    this.root = el('div', 'modal endscreen ix is-off', parent);
    this.box = el('div', 'modal-box end-box', this.root);
  }

  reset(_world: World): void {
    this.mode = 'hidden';
    this.eliminated = false;
    this.eliminatedBy = null;
    this.spectating = false;
    this.reason = 'conquest';
    this.endedAt = 0;
  }

  onEvent(e: GameEvent, _w: World): void {
    const s = this.host.app.session;
    if (e.t === 'eliminated' && !s.spectator && e.faction === s.playerFaction && matchScreen(s.screen)) {
      this.eliminated = true;
      this.eliminatedBy = e.by;
    }
    if (e.t === 'victory') this.reason = e.reason ?? 'conquest';
  }

  update(world: World | null, now: number): void {
    const s = this.host.app.session;
    let mode: Mode = 'hidden';
    if (world && s.screen === 'ended') {
      if (this.endedAt === 0) this.endedAt = now;
      // A dawn crowning lets its banner play over the live burn before the cards come up.
      const held = this.reason === 'dawn' && now - this.endedAt < DAWN_BANNER_S * 1000;
      if (!held) {
        if (s.spectator) mode = 'over';
        else mode = world.winner === s.playerFaction ? 'victory' : world.winner === null ? 'draw' : 'defeat';
      }
    } else {
      this.endedAt = 0;
      if (world && s.screen === 'playing' && this.eliminated && !this.spectating) mode = 'eliminated';
    }
    show(this.root, mode !== 'hidden' && !s.panels.codex && !s.panels.settings);
    if (mode !== this.mode) {
      this.mode = mode;
      if (mode === 'hidden' || !world) return;
      this.render(world, mode);
    }
    // The leader can change while the cards are up (the old one left): rebuild just the buttons.
    if (mode !== 'hidden' && this.buttons && this.onlineKey() !== this.buttonsKey) this.renderButtons(this.buttons, mode);
  }

  private onlineKey(): string {
    const net = this.host.app.net;
    if (!net) return 'offline';
    return net.isLeader ? 'leader' : `wait:${leaderName(net.lobby) ?? ''}`;
  }

  private render(world: World, mode: Exclude<Mode, 'hidden'>): void {
    const s = this.host.app.session;
    const names = s.playerNames;
    const P: FactionId | null = s.spectator ? null : s.playerFaction;
    const win = mode === 'victory';
    for (const m of MODES) setClass(this.root, `m-${m}`, m === mode);
    const dawn = this.reason === 'dawn' && (mode === 'victory' || mode === 'defeat' || mode === 'over');
    setClass(this.root, 'm-dawn', dawn);
    const pick = (lines: readonly string[]): string => lines[Math.floor(Math.random() * lines.length)] ?? '';
    const winner = factionName(world, world.winner, names);
    let title: string;
    let sub: string;
    let verdict = '';
    if (dawn) {
      title = 'DAWN OVER THE BURN';
      sub = win ? 'The Survey is completed. Your Survey stands dominant.' : `${winner}'s Survey stands dominant.`;
      verdict = dawnVerdict(world, P, names);
    } else if (win) {
      title = 'FLAGISTAN APPROACHES';
      sub = pick(VICTORY_LINES);
    } else if (mode === 'draw' || (mode === 'over' && world.winner === null)) {
      title = 'THE SURVEY IS UNFINISHED';
      sub = 'No Hearth stands. The Crystal keeps its own counsel.';
    } else if (mode === 'over') {
      title = 'THE BURN IS DECIDED';
      sub = `${winner} holds the last Hearth. The Survey is completed.`;
    } else {
      title = 'YOUR SURVEY HAS BEEN OVERWRITTEN';
      const by = mode === 'eliminated' ? this.eliminatedBy : world.winner;
      sub =
        mode === 'eliminated'
          ? `${by !== null ? `Overwritten by ${factionName(world, by, names)}. ` : ''}${pick(DEFEAT_LINES)}`
          : `${world.winner !== null ? `${winner} holds the last Hearth. ` : ''}${pick(DEFEAT_LINES)}`;
    }

    this.box.textContent = '';
    html('div', 'end-sigil', sigilSvg(win || mode === 'over' ? 'sigil spin' : 'sigil'), this.box);
    el('h1', 'end-title', this.box, title);
    el('p', 'end-sub', this.box, sub);
    if (verdict) el('p', 'end-verdict', this.box, verdict);
    el('div', 'end-time', this.box, `Match time ${fmtClock(world.time)}`);
    statsTable(el('div', 'end-stats', this.box), world, P, names);
    this.buttons = el('div', 'end-buttons', this.box);
    this.renderButtons(this.buttons, mode);
  }

  private renderButtons(row: HTMLElement, mode: Exclude<Mode, 'hidden'>): void {
    const app = this.host.app;
    const net = app.net;
    this.buttonsKey = this.onlineKey();
    row.textContent = '';
    if (mode === 'eliminated') {
      button('btn', row, 'Spectate', () => {
        this.spectating = true;
      });
    }
    if (!net) {
      button('btn btn-primary', row, 'Back to lobby', () => this.host.veiledLoad(() => app.openLobby()), 'confirm');
      button('btn', row, 'Title', () => this.host.veiledLoad(() => app.quitToTitle()), 'back');
      return;
    }
    if (mode !== 'eliminated') {
      if (net.isLeader) button('btn btn-primary', row, 'Back to lobby', () => net.backToLobby(), 'confirm');
      else {
        const leader = leaderName(net.lobby);
        el('span', 'end-wait', row, leader ? `Waiting for ${leader} to gather the burn again…` : 'Waiting for a new leader…');
      }
    }
    button('btn', row, 'Leave the burn', () => this.host.veiledLoad(() => net.leave()), 'back');
  }

  dispose(): void {
    this.root.remove();
  }
}

/**
 * Every camp's stats, the viewer's own column first. Built from nodes, not markup: online the
 * column heads are Signifiers' handles.
 */
function statsTable(parent: HTMLElement, world: World, P: FactionId | null, names: Partial<Record<FactionId, string>>): void {
  const active = matchSettings(world.options).active;
  const order: FactionId[] = active.filter((id) => id !== P);
  if (P !== null && active.includes(P)) order.unshift(P);
  const table = el('table', 'stats', parent);
  const head = el('tr', '', el('thead', '', table));
  el('th', '', head);
  for (const f of order) {
    const fac = world.factions[f];
    if (!fac) continue;
    const th = el('th', `${fac.alive ? '' : 'dead'}${f === P ? ' you' : ''}`, head);
    th.style.setProperty('--fc', fac.css);
    if (world.winner === f) th.innerHTML = iconSvg('star', 'crown');
    el('span', 'who', th, factionName(world, f, names));
    // Online the character still names the camp under its Signifier's handle.
    if (names[f]) el('span', 'char', th, fac.name);
    if (!fac.alive) el('span', 'fate', th, `out ${fac.eliminatedAt !== null ? fmtClock(fac.eliminatedAt) : ''}`);
  }
  const body = el('tbody', '', table);
  for (const [key, label] of STAT_ROWS) {
    let best = 0;
    for (const f of order) best = Math.max(best, world.factions[f]?.stats[key] ?? 0);
    const tr = el('tr', '', body);
    el('td', 'stat-l', tr, label);
    for (const f of order) {
      const v = Math.round(world.factions[f]?.stats[key] ?? 0);
      el('td', v > 0 && v === Math.round(best) ? 'num best' : 'num', tr, String(v));
    }
  }
}

/**
 * The line under a dawn crowning: the measure that put the winner above the runner-up (the
 * same wording the Hearth rail's dawn marker used all night), plus the player's placing when
 * the player still stands but lost. dominanceOrder is the rule's own, so this can never
 * disagree with who was crowned.
 */
function dawnVerdict(world: World, player: FactionId | null, names: Partial<Record<FactionId, string>>): string {
  const order = dominanceOrder(world);
  const line = dawnLead(world, order, player, names);
  const rank = player === null ? -1 : order.indexOf(player);
  if (!line || rank <= 0) return line;
  return `${line} Your camp still stands, ${ORDINAL[rank + 1] ?? `#${rank + 1}`} of ${order.length}.`;
}
