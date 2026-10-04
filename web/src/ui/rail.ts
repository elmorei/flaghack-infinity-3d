import { matchSettings, endTime } from "../sim/matchSettings";
/**
 * Hearth rail (left): all four camps, always visible. Colour, name, title, the Signifier's
 * handle online, capture-stage badge, per-attacker pressure bars, overwrite countdown,
 * outposts, and a strike-through when a camp is eliminated. From The Burn until the match
 * ends, the camp Dawn would crown right now carries a "Dominant at dawn" marker: an asset to
 * hold when it is the player's, a target when it is a rival's. Pillar 4: Hearth stage and the
 * dawn race are legible at a glance.
 */
import { DAWN_TIME } from '../sim/constants';
import { dominanceOrder } from '../sim/systems/victory';
import { FACTION_IDS } from '../sim/types';
import type { Building, CaptureStage, FactionId, FactionState } from '../sim/types';
import type { World } from '../sim/world';
import { STAGE_INFO } from './catalog';
import type { UiHost, UiPart } from './core';
import { factionName, matchScreen, tutorialTarget } from './core';
import { dawnLead } from './dawn';
import { el, fmtClock, html, setAttr, setClass, setText, setVar, show } from './dom';
import { iconSvg } from './icons';
import { seatPlayer } from './online';

const STAGE_RANK: Record<CaptureStage, number> = {
  safe: 0,
  threatened: 1,
  contested: 2,
  contained: 3,
  overwritten: 4,
  captured: 5,
};

/** dominanceOrder sorts every standing camp, so the dawn call is re-made at most twice a second. */
const DAWN_RECOMPUTE_MS = 500;
const DAWN_CLOCK = fmtClock(DAWN_TIME);

/** How the dawn leader reads to the player: theirs to hold, a rival to bring down, or (out of the game) neutral. */
type DawnRole = 'own' | 'target' | 'neutral';

const DAWN_ROLE: Record<DawnRole, { label: string; icon: string; tag: string; act: string; tone: string }> = {
  own: {
    label: 'Hold till dawn',
    icon: iconSvg('defend'),
    tag: 'Yours to hold',
    act: `Hold your Hearths and loops until ${DAWN_CLOCK} and the Survey is yours.`,
    tone: 'tip-good',
  },
  target: {
    label: 'Dawn target',
    icon: iconSvg('attack'),
    tag: 'Your target',
    act: `Take one of their Hearths or out-survey them before ${DAWN_CLOCK}, or dawn crowns them.`,
    tone: 'tip-bad',
  },
  neutral: { label: 'Dominant at dawn', icon: '', tag: 'Leads the burn', act: '', tone: '' },
};

interface Card {
  root: HTMLElement;
  name: HTMLElement;
  /** The Signifier's handle online (text only), hidden for AI camps and offline. */
  handle: HTMLElement;
  badge: HTMLElement;
  stage: CaptureStage | null;
  outposts: HTMLElement;
  bars: HTMLElement[];
  fills: HTMLElement[];
  note: HTMLElement;
  dawn: HTMLElement;
  dawnLabel: HTMLElement;
  dawnRoleIcon: HTMLElement;
  dawnTag: HTMLElement;
  dawnWhy: HTMLElement;
  dawnAct: HTMLElement;
  dawnRole: DawnRole | null;
}

export class HearthRail implements UiPart {
  private host: UiHost;
  private root: HTMLElement;
  private cards: Card[] = [];
  private builtFor: World | null = null;
  /** session.spectator the cards were built for ("You" and rail-own depend on it). */
  private builtSpectator = false;
  private dawnAt = -Infinity;
  /** Camp currently carrying the dawn marker (null: none shown). */
  private dawnLeader: FactionId | null = null;

  constructor(host: UiHost, parent: HTMLElement) {
    this.host = host;
    this.root = el('div', 'rail', parent);
    tutorialTarget(this.root, 'rail');
    el('div', 'rail-title', this.root, 'Hearths');
  }

  reset(world: World): void {
    for (const c of this.cards) c.root.remove();
    this.cards = [];
    this.builtFor = world;
    const s = this.host.app.session;
    this.builtSpectator = s.spectator;
    // The player's own camp: none on the attract burn or for a seatless online watcher.
    const mine = !s.spectator && world.options.humans.includes(s.playerFaction) ? s.playerFaction : null;
    for (const f of world.factions) {
      const root = el('div', 'rail-card', this.root);
      root.style.setProperty('--fc', f.css);
      if (f.id === mine) tutorialTarget(root, 'rail-own');
      const top = el('div', 'rc-top', root);
      el('span', 'rc-sigil', top);
      const name = el('span', 'rc-name', top, f.name);
      if (f.id === mine) el('span', 'rc-you', top, 'You');
      const badge = el('span', 'badge', top, '');
      const handle = el('div', 'rc-handle is-off', root, '');
      el('div', 'rc-title', root, f.title);
      // The dawn marker sits under the title; its tooltip needs the cursor (see updateDawn).
      const dawn = el('div', 'rc-dawn is-off', root);
      html('span', 'rc-dawn-ic', iconSvg('dawn'), dawn);
      const dawnLabel = el('span', 'rc-dawn-l', dawn, '');
      const dawnRoleIcon = el('span', 'rc-dawn-role', dawn);
      const tip = el('div', 'tip', dawn);
      const head = el('h4', '', tip, 'Dominant at dawn ');
      const dawnTag = el('span', '', head, '');
      const dawnWhy = el('p', '', tip, '');
      const dawnAct = el('p', '', tip, '');
      const press = el('div', 'rc-press', root);
      const bars: HTMLElement[] = [];
      const fills: HTMLElement[] = [];
      for (const a of FACTION_IDS) {
        const bar = el('div', 'pbar is-off', press);
        bar.style.setProperty('--ac', world.factions[a]?.css ?? '#fff');
        bar.title = `${factionName(world, a, s.playerNames)}'s containment pressure`;
        fills.push(el('i', '', bar));
        bars.push(bar);
      }
      const outposts = el('span', 'rc-out is-off', top, '');
      const note = el('div', 'rc-note is-off', root, '');
      this.cards.push({
        root,
        name,
        handle,
        badge,
        stage: null,
        outposts,
        bars,
        fills,
        note,
        dawn,
        dawnLabel,
        dawnRoleIcon,
        dawnTag,
        dawnWhy,
        dawnAct,
        dawnRole: null,
      });
    }
    this.dawnAt = -Infinity;
    this.dawnLeader = null;
  }

  update(world: World | null, now: number): void {
    const s = this.host.app.session;
    const visible = matchScreen(s.screen) && world !== null;
    show(this.root, visible);
    if (!visible || !world) return;
    if (this.builtFor !== world || this.builtSpectator !== s.spectator) this.reset(world);
    const lobby = this.host.app.net?.lobby ?? null;
    for (const f of world.factions) {
      const card = this.cards[f.id];
      if (!card) continue;
      show(card.root,matchSettings(world.options).active.includes(f.id));
      setClass(card.root, 'dead', !f.alive);
      // Online: who plays the camp; a dropped Signifier's camp is run by the AI until they return.
      const handle = s.playerNames[f.id] ?? '';
      show(card.handle, handle !== '');
      setText(card.handle, handle);
      setClass(card.handle, 'lost', handle !== '' && seatPlayer(lobby, f.id)?.connected === false);
      const worst = worstHearth(world, f);
      const stage: CaptureStage = !f.alive ? 'captured' : (worst?.hearth?.stage ?? 'safe');
      if (stage !== card.stage) {
        if (card.stage) card.badge.classList.remove(`st-${card.stage}`);
        card.badge.classList.add(`st-${stage}`);
        card.stage = stage;
      }
      setText(card.badge, f.alive ? STAGE_INFO[stage].label : 'Eliminated');
      setAttr(card.badge, 'title', f.alive ? STAGE_INFO[stage].desc : '');
      const outposts = f.hearthIds.length - 1;
      show(card.outposts, f.alive && outposts > 0);
      if (outposts > 0) setText(card.outposts, `+${outposts}`);

      const h = worst?.hearth;
      for (const a of FACTION_IDS) {
        const bar = card.bars[a];
        const p = f.alive && h && a !== f.id ? h.pressure[a] : 0;
        show(bar, p > 0.5);
        if (p > 0.5) setVar(card.fills[a], '--p', (p / 100).toFixed(3));
      }

      let note = '';
      if (!f.alive) {
        note = f.eliminatedBy !== null ? `Overwritten by ${factionName(world, f.eliminatedBy, s.playerNames)}` : 'Survey lost';
      } else if (h && stage === 'overwritten' && h.overwriteAt > 0) {
        note = `Overwrite in ${Math.max(0, h.overwriteAt - world.time).toFixed(1)} s`;
      } else if (h && h.attacker !== null && (stage === 'contained' || stage === 'contested')) {
        note =
          stage === 'contested'
            ? `Held against ${factionName(world, h.attacker, s.playerNames)}`
            : `Contained by ${factionName(world, h.attacker, s.playerNames)}`;
      }
      setText(card.note, note);
      show(card.note, note !== '');
    }
    this.updateDawn(world, now);
  }

  /**
   * Mark the camp Dawn would crown right now (dominanceOrder()[0]) from The Burn until the
   * match ends. Its tooltip explains the call with the end screen's own wording (dawnLead).
   */
  private updateDawn(world: World, now: number): void {
    const s = this.host.app.session;
    // Tooltips need the cursor: only while it is free (Command View or an unlocked pointer).
    const ix = s.view === 'command' || !s.pointerLocked;
    for (const c of this.cards) setClass(c.dawn, 'ix', ix);
    const live = world.suddenDeath && world.phase === 'playing';
    // Before The Burn (and after it is cleared at the end) there is nothing to mark or unmark.
    if (!live && this.dawnLeader === null) return;
    if (live && now - this.dawnAt < DAWN_RECOMPUTE_MS) return;
    this.dawnAt = now;
    // A seatless watcher has no camp: every leader reads neutral.
    const P = s.spectator ? null : s.playerFaction;
    const order = live ? dominanceOrder(world) : [];
    const leader: FactionId | null = order.length >= 2 ? order[0] : null;
    this.dawnLeader = leader;
    const role: DawnRole = P === null ? 'neutral' : leader === P ? 'own' : world.factions[P]?.alive ? 'target' : 'neutral';
    for (const f of FACTION_IDS) {
      const c = this.cards[f];
      if (!c) continue;
      const lead = f === leader;
      show(c.dawn, lead);
      setClass(c.root, 'dawn-own', lead && role === 'own');
      setClass(c.root, 'dawn-target', lead && role === 'target');
      if (!lead) continue;
      const r = DAWN_ROLE[role];
      if (c.dawnRole !== role) {
        c.dawnRole = role;
        setText(c.dawnLabel, r.label);
        c.dawnRoleIcon.innerHTML = r.icon;
        setText(c.dawnTag, `${r.tag} · dawn at ${fmtClock(endTime(world.options))}`);
        c.dawnAct.className = r.tone;
        setText(c.dawnAct, r.act.replace(DAWN_CLOCK,fmtClock(endTime(world.options))));
        show(c.dawnAct, r.act !== '');
      }
      // Text only: the reason names camps by their Signifiers' handles online.
      setText(c.dawnWhy, dawnLead(world, order, P, s.playerNames));
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

/** The camp's Hearth in the most trouble: the worst capture stage, then the strongest pressure. */
export function worstHearth(world: World, fac: FactionState): Building | null {
  let worst: Building | null = null;
  let worstAt = -1;
  for (const id of fac.hearthIds) {
    const b = world.buildings.get(id);
    if (!b?.hearth) continue;
    const score = worstScore(b);
    if (score > worstAt) {
      worst = b;
      worstAt = score;
    }
  }
  return worst;
}

function worstScore(b: Building): number {
  const h = b.hearth;
  if (!h) return -1;
  let maxP = 0;
  for (const a of FACTION_IDS) maxP = Math.max(maxP, h.pressure[a]);
  return STAGE_RANK[h.stage] * 1000 + maxP;
}
