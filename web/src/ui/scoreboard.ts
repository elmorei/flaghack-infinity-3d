/**
 * Standings: one row per camp (character, the Signifier playing it or the rivals' AI, Hearths,
 * Survey, Flags standing, C.M.I., ping) plus the spectators. `StandingsTable` is shared by the
 * hold-O scoreboard overlay and the online pause menu; for a watcher, every camp the AI steers
 * offers "Take over" (seats.ts confirms). Handles are written as text only.
 */
import type { AppApi } from '../game/app';
import { FACTION_DEFS } from '../sim/constants';
import { matchSettings } from '../sim/matchSettings';
import { FACTION_IDS } from '../sim/types';
import type { FactionId } from '../sim/types';
import type { World } from '../sim/world';
import { DIFFICULTY_INFO } from './catalog';
import { matchScreen } from './core';
import type { UiHost, UiPart } from './core';
import { button, el, fmtClock, html, setAttr, setClass, setText, show } from './dom';
import { iconSvg } from './icons';
import { fmtPing, pingTone, seatPlayer, takeableSeat, watchingOnline } from './online';
import { portraitSvg } from './portraits';

interface SeatRow {
  root: HTMLTableRowElement;
  who: HTMLElement;
  tags: HTMLElement;
  tagKey: string;
  hearths: HTMLElement;
  survey: HTMLElement;
  flags: HTMLElement;
  cmi: HTMLElement;
  ping: HTMLElement;
  /** Watchers only: take this AI-steered camp over. */
  take: HTMLButtonElement;
}

export class StandingsTable {
  readonly el: HTMLElement;
  private table: HTMLTableElement;
  private rows: SeatRow[] = [];
  private spectators: HTMLElement;
  private flagCount = [0, 0, 0, 0];

  constructor(parent: HTMLElement, onTake: (f: FactionId) => void) {
    this.el = el('div', 'standings', parent);
    this.table = el('table', 'standings-table', this.el);
    const head = el('tr', '', el('thead', '', this.table));
    for (const [label, cls] of HEADINGS) el('th', cls, head, label);
    const body = el('tbody', '', this.table);
    for (const f of FACTION_IDS) {
      const def = FACTION_DEFS[f];
      const root = el('tr', 'st-row', body);
      root.style.setProperty('--fc', def.css);
      html('td', 'st-face', portraitSvg(f, 'portrait sm'), root);
      const camp = el('td', 'st-camp', root);
      el('span', 'st-char', camp, def.name);
      el('span', 'st-title', camp, def.title);
      const whoCell = el('td', 'st-who', root);
      const who = el('span', 'st-handle', whoCell, '');
      const tags = el('span', 'st-tags', whoCell);
      this.rows.push({
        root,
        who,
        tags,
        tagKey: '',
        hearths: el('td', 'num', root, '0'),
        survey: el('td', 'num', root, '0'),
        flags: el('td', 'num', root, '0'),
        cmi: el('td', 'num', root, '0'),
        ping: el('td', 'num st-ping', root, '—'),
        // `ix` of its own: the hold-O overlay takes no pointer events, its buttons do.
        take: button('btn btn-tiny btn-gold st-take ix is-off', el('td', 'st-act', root), 'Take over', () => onTake(f), 'pick'),
      });
    }
    this.spectators = el('div', 'standings-spec is-off', this.el);
  }

  update(app: AppApi, world: World): void {
    const s = app.session;
    const net = app.net;
    const lobby = net?.lobby ?? null;
    const me = s.spectator ? null : s.playerFaction;
    setClass(this.table, 'offline', !net);
    const canTake = watchingOnline(app, world);
    const flags = this.flagCount;
    flags.fill(0);
    const owners = world.survey.nodeFlagOwner;
    for (let i = 0; i < owners.length; i++) if (owners[i] >= 0) flags[owners[i]]++;
    const aiLabel = `AI · ${DIFFICULTY_INFO[lobby?.settings.difficulty ?? world.options.difficulty].name}`;
    const active = matchSettings(world.options).active;
    for (const f of FACTION_IDS) {
      const row = this.rows[f];
      const fac = world.factions[f];
      show(row.root, active.includes(f));
      if (!active.includes(f)) continue;
      if (!fac) continue;
      const human = seatPlayer(lobby, f);
      setClass(row.root, 'you', f === me);
      setClass(row.root, 'dead', !fac.alive);
      // Online the seat's Signifier; offline the player and the rivals' AI.
      const handle = net ? (human?.name ?? aiLabel) : f === me ? 'You' : aiLabel;
      setText(row.who, handle);
      setClass(row.who, 'ai', net ? !human : f !== me);
      const leader = !!human && human.id === lobby?.leaderId;
      const lost = !!human && !human.connected;
      const tagKey = `${f === me && !!net ? 'y' : ''}${leader ? 'l' : ''}${lost ? 'x' : ''}`;
      if (tagKey !== row.tagKey) {
        row.tagKey = tagKey;
        // Static markup only: the handle itself lives in its own text node above.
        row.tags.innerHTML =
          (f === me && net ? '<span class="tag you">you</span>' : '') +
          (leader ? `<span class="tag lead" title="Leads the lobby">${iconSvg('star')}</span>` : '') +
          (lost ? '<span class="tag lost" title="Connection lost: the AI holds the camp until they return">away</span>' : '');
      }
      setText(row.hearths, fac.alive ? String(fac.hearthIds.length) : `out ${fac.eliminatedAt !== null ? fmtClock(fac.eliminatedAt) : ''}`);
      setText(row.survey, String(world.survey.surveySize[f]));
      setText(row.flags, String(flags[f]));
      setText(row.cmi, String(Math.round(fac.stats.cmi)));
      // The player's own round trip is measured right here; the host's figure lags behind it.
      const ping = human && net && human.id === net.playerId && net.ping > 0 ? net.ping : (human?.ping ?? 0);
      const live = !!human && human.connected;
      setText(row.ping, live ? fmtPing(ping) : '');
      setAttr(row.ping, 'data-tone', live ? pingTone(ping) : 'unknown');
      show(row.take, canTake && takeableSeat(world, lobby, f));
    }
    const watchers = lobby ? lobby.players.filter((p) => p.seat === null).map((p) => p.name) : [];
    show(this.spectators, watchers.length > 0);
    setText(this.spectators, watchers.length > 0 ? `Watching from the dark: ${watchers.join(', ')}` : '');
  }
}

const HEADINGS: readonly (readonly [string, string])[] = [
  ['', 'st-face'],
  ['Camp', 'st-camp'],
  ['Signifier', 'st-who'],
  ['Hearths', 'num'],
  ['Survey', 'num'],
  ['Flags', 'num'],
  ['C.M.I.', 'num'],
  ['Ping', 'num st-ping'],
  ['', 'st-act'],
];

/** Hold O during a match: the standings over the live burn, gone on release. */
export class Scoreboard implements UiPart {
  private host: UiHost;
  private root: HTMLElement;
  private meta: HTMLElement;
  private table: StandingsTable;
  private held = false;

  constructor(host: UiHost, parent: HTMLElement) {
    this.host = host;
    this.root = el('div', 'scoreboard is-off', parent);
    const head = el('div', 'sb-head', this.root);
    el('h2', '', head, 'Standings');
    this.meta = el('span', 'sb-meta', head, '');
    this.table = new StandingsTable(this.root, (f) => this.host.chooseSeat(f));
    el('div', 'sb-foot', this.root, 'Release O to return to the burn');
  }

  /** O pressed / released (or the window lost focus mid-hold). */
  setHeld(held: boolean): void {
    this.held = held;
  }

  update(world: World | null, _now: number): void {
    const s = this.host.app.session;
    const visible = this.held && !!world && matchScreen(s.screen) && s.screen !== 'paused';
    show(this.root, visible);
    if (!visible || !world) return;
    const net = this.host.app.net;
    setText(this.meta, `${net ? `${net.serverName} · ` : ''}${fmtClock(world.time)}`);
    this.table.update(this.host.app, world);
  }

  dispose(): void {
    this.root.remove();
  }
}
