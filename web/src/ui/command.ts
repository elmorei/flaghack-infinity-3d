/**
 * Command View panels (the GCC table): Survey plan tools,
 * Camp Priorities, the selection panel with orders, the camp build menu with live placement
 * reasons, Drug Lab brewing and the Geomantic Command Center status. Every change goes through
 * session fields or app.submit(Command); nothing here mutates the World.
 */
import type { PlanTool } from '../game/session';
import { BREW_COST, BREW_TIME, BUILDINGS, DRUG_MAX, GCC, RECRUIT_RADIUS, RECRUIT_INTERVAL } from '../sim/constants';
import { BUILDING_NAMES, canPlaceBuilding, isCollapsed } from '../sim/systems/buildings';
import { brewBlocker, dosesOwnedOrPending } from '../sim/systems/drugs';
import { DRUGS, JOBS } from '../sim/types';
import type { Building, DrugId, EntityId, FactionState, Hippie, JobKind } from '../sim/types';
import type { World } from '../sim/world';
import {
  BUILD_INFO,
  CAMP_BUILDINGS,
  DRUG_INFO,
  JOB_INFO,
  PLAN_TOOLS,
  STATUS_INFO,
} from './catalog';
import type { CampBuildingKind } from './catalog';
import { tutorialTarget } from './core';
import type { UiHost, UiLayout, UiPart } from './core';
import { button, el, escapeHtml, fmtCountdown, html, kbd, setAttr, setClass, setDisabled, setText, setVar, show } from './dom';
import { iconSvg } from './icons';

const MAX_CHIPS = 16;

interface JobRow {
  job: JobKind;
  notches: HTMLButtonElement[];
  count: HTMLElement;
}

interface LabRow {
  id: EntityId;
  root: HTMLElement;
  status: HTMLElement;
  fill: HTMLElement;
  queue: HTMLElement;
  brew: Map<DrugId, HTMLButtonElement>;
}

export class CommandPanels implements UiPart {
  private host: UiHost;
  private right: HTMLElement;
  private left: HTMLElement;
  private deck: HTMLElement;
  // Plan
  private planButtons = new Map<PlanTool | 'clear', HTMLButtonElement>();
  private encloseOptions: HTMLElement;
  private encloseTarget: HTMLButtonElement;
  private planHint: HTMLElement;
  private planCount: HTMLElement;
  // Priorities
  private jobs: JobRow[] = [];
  // Selection
  private sel: HTMLElement;
  private selTitle: HTMLElement;
  private selChips: HTMLElement;
  private selSig = '';
  private selOrders: HTMLElement;
  private selInfo: HTMLElement;
  private selInfoKey = '';
  // Build
  private buildButtons = new Map<CampBuildingKind, HTMLButtonElement>();
  private buildStatus: HTMLElement;
  // Labs
  private labPanel: HTMLElement;
  private labList: HTMLElement;
  private labs = new Map<EntityId, LabRow>();
  // GCC
  private gccStatus: HTMLElement;

  constructor(host: UiHost, layout: UiLayout) {
    this.host = host;
    this.right = el('div', 'cmd-right cmd-stack', layout.colRight);
    this.left = el('div', 'cmd-left cmd-stack', layout.colLeft);
    this.deck = el('div', 'cmd-deck', layout.bottomCenter);

    // ── Survey plan tools ──
    const plan = this.panel(this.right, 'Survey plan', 'plan');
    const tools = el('div', 'plan-tools', plan);
    tutorialTarget(tools, 'plan-tools');
    for (const info of PLAN_TOOLS) {
      if (info.tool === 'ring') continue; // Expand home lives inside Enclose.
      const b = button(
        'plan-btn',
        tools,
        `${iconSvg(info.icon)}<span class="pb-name">${info.name}</span>${kbd(info.key)}`,
        () => {
          const ss = this.host.app.session;
          if (info.tool === 'clear') {
            this.host.app.submit({ t: 'plan', faction: ss.playerFaction, op: 'clear', nodes: [] });
            ss.planPreview = [];
          } else {
            ss.planTool = info.tool;
            ss.planPreview = [];
          }
        },
        // Clear is an action on the plan; the rest pick a tool.
        info.tool === 'clear' ? 'click' : 'pick',
      );
      b.title = info.hint;
      if (info.target) tutorialTarget(b, info.target);
      this.planButtons.set(info.tool, b);
    }
    this.encloseOptions = el('div', 'enclose-options plan-tools is-off', plan);
    this.encloseTarget = button('plan-btn', this.encloseOptions, `<span class="pb-name">At target</span>${kbd('E')}`, () => {
      this.host.app.session.planTool = 'enclose';
      this.host.app.session.planPreview = [];
    }, 'pick');
    const expand = button('plan-btn', this.encloseOptions, `<span class="pb-name">Expand home</span>${kbd('R')}`, () => {
      this.host.app.session.planTool = 'ring';
      this.host.app.session.planPreview = [];
    }, 'pick');
    expand.title = 'Enclose a wider ring around your home Survey.';
    tutorialTarget(expand, 'plan-ring');
    this.planButtons.set('ring', expand);
    this.planHint = el('div', 'panel-hint', plan, '');
    this.planCount = el('div', 'panel-meta', plan, '');

    // ── Camp priorities ──
    const prio = this.panel(this.right, 'Camp priorities', 'prio');
    tutorialTarget(prio, 'priorities');
    for (const job of JOBS) {
      const info = JOB_INFO[job];
      const row = el('div', 'job', prio);
      tutorialTarget(row, info.target);
      row.title = info.desc;
      html('span', 'job-ic', iconSvg(info.icon), row);
      el('span', 'job-name', row, info.name);
      const notchBox = el('span', 'notches', row);
      const notches: HTMLButtonElement[] = [];
      for (let v = 0; v <= 4; v++) {
        const n = button(
          'notch',
          notchBox,
          String(v),
          () => {
            const ss = this.host.app.session;
            this.host.app.submit({ t: 'jobWeights', faction: ss.playerFaction, weights: { [job]: v } });
          },
          'pick',
        );
        notches.push(n);
      }
      const count = el('span', 'job-count num', row, '0');
      count.title = 'Signifiers on this job';
      this.jobs.push({ job, notches, count });
    }

    // ── Geomantic Command Center (the cart's banner) ──
    const gcc = el('div', 'panel gcc-panel', this.left);
    tutorialTarget(gcc, 'gcc-panel');
    html(
      'div',
      'gcc-banner',
      '<span class="gb-main">GEOMANTIC COMMAND CENTER</span><span class="gb-sub">FLAG REPAIR · RECRUITMENT · GEOMANTIC ADVICE</span>',
      gcc,
    );
    this.gccStatus = el('div', 'panel-meta gcc-status', gcc, '');

    // ── Deck: selection ──
    this.sel = this.panel(this.deck, 'Selection', 'sel');
    this.selTitle = el('div', 'panel-meta', this.sel, '');
    this.selChips = el('div', 'chips', this.sel);
    this.selInfo = el('div', 'sel-info', this.sel);
    this.selOrders = el('div', 'sel-orders', this.sel);
    button('btn btn-small', this.selOrders, `${iconSvg('defend')}Hold position`, () => this.order('defend'));
    button('btn btn-small', this.selOrders, 'Recruit…', () => {
      const s = this.host.app.session;
      s.tool = 'flag'; s.planTool = 'select'; s.planPreview = [];
      s.recruitTargeting = true;
    });
    button('btn btn-small', this.selOrders, `${iconSvg('close')}Clear orders`, () => this.order('clear'));

    // ── Deck: build menu ──
    const build = this.panel(this.deck, 'Camp buildings', 'build');
    tutorialTarget(build, 'buildings-panel');
    const grid = el('div', 'build-grid', build);
    for (const kind of CAMP_BUILDINGS) {
      const info = BUILD_INFO[kind];
      const b = button(
        'build-btn',
        grid,
        `<span class="bb-ic">${iconSvg(info.icon)}</span><span class="bb-name">${info.name}</span><span class="bb-cost num">${info.cost}${iconSvg('lumber', 'ic-cost')}</span>`,
        () => {
          const ss = this.host.app.session;
          if (ss.tool === 'building' && ss.buildingKind === kind) ss.tool = 'flag';
          else {
            ss.tool = 'building';
            ss.buildingKind = kind;
          }
        },
        'toggle',
      );
      b.title = info.effect;
      this.buildButtons.set(kind, b);
    }
    this.buildStatus = el('div', 'panel-hint build-status', build, '');

    // ── Deck: Drug Labs ──
    this.labPanel = this.panel(this.deck, 'Drug labs', 'labs');
    el('div', 'panel-hint', this.labPanel,
      `Automatically brews random drugs, favoring low stock. Each dose uses ${BREW_COST} lumber. Queued orders go first after the current batch.`);
    this.labList = el('div', 'labs', this.labPanel);
  }

  private panel(parent: HTMLElement, title: string, key: string): HTMLElement {
    const p = el('div', `panel panel-${key}`, parent);
    el('div', 'panel-title', p, title);
    return p;
  }

  private ownSelected(world: World): Hippie[] {
    const s = this.host.app.session;
    const out: Hippie[] = [];
    for (const id of s.selection) {
      const h = world.hippies.get(id);
      if (h && h.faction === s.playerFaction) out.push(h);
    }
    return out;
  }

  private order(kind: 'defend' | 'clear'): void {
    this.host.app.session.recruitTargeting = false;
    const w = this.host.app.world;
    const s = this.host.app.session;
    if (!w) return;
    const hs = this.ownSelected(w);
    if (hs.length === 0) return;
    const ids = hs.map((h) => h.id);
    if (kind === 'defend') {
      let x = 0;
      let z = 0;
      for (const h of hs) {
        x += h.pos.x;
        z += h.pos.z;
      }
      this.host.app.submit({ t: 'order', faction: s.playerFaction, hippies: ids, order: { kind: 'defend', at: { x: x / hs.length, z: z / hs.length } } });
    } else {
      this.host.app.submit({ t: 'order', faction: s.playerFaction, hippies: ids, order: null });
    }
  }

  update(world: World | null, _now: number): void {
    const s = this.host.app.session;
    const fac = world?.factions[s.playerFaction];
    const visible = s.screen === 'playing' && s.view === 'command' && !s.spectator && !!world && !!fac && fac.alive;
    show(this.right, visible);
    show(this.left, visible);
    show(this.deck, visible);
    if (!visible || !world || !fac) return;
    const t = world.time;
    const blend = Math.min(1, Math.max(0, s.viewBlend)).toFixed(2);
    setVar(this.right, '--vb', blend);
    setVar(this.left, '--vb', blend);
    setVar(this.deck, '--vb', blend);

    this.updatePlan(world, fac);
    this.updateJobs(world, fac);
    this.updateGcc(world, fac, t);
    this.updateSelection(world, fac);
    this.updateBuild(world, fac);
    this.updateLabs(world, fac);
  }

  private updatePlan(world: World, fac: FactionState): void {
    const s = this.host.app.session;
    const enclosing = s.planTool === 'enclose' || s.planTool === 'ring';
    show(this.encloseOptions, enclosing);
    setClass(this.encloseTarget, 'on', s.planTool === 'enclose');
    for (const [tool, b] of this.planButtons) setClass(b, 'on', tool === 'enclose' ? enclosing : tool === s.planTool);
    const info = PLAN_TOOLS.find((p) => p.tool === s.planTool);
    setText(this.planHint, info ? info.hint : '');
    let unfilled = 0;
    for (const n of fac.plan) if (world.survey.nodeFlagOwner[n] !== fac.id) unfilled++;
    setText(this.planCount, `Plan: ${fac.plan.size} nodes · ${unfilled} awaiting Flags`);
  }

  private updateJobs(world: World, fac: FactionState): void {
    const counts: Record<JobKind, number> = { survey: 0, gather: 0, defend: 0, raid: 0, ritual: 0 };
    for (const h of world.hippies.values()) if (h.faction === fac.id && h.job) counts[h.job]++;
    for (const row of this.jobs) {
      const w = fac.jobWeights[row.job];
      for (let v = 0; v < row.notches.length; v++) {
        setClass(row.notches[v], 'on', v <= w && w > 0);
        setClass(row.notches[v], 'cur', v === w);
      }
      setText(row.count, String(counts[row.job]));
    }
  }

  private updateGcc(world: World, fac: FactionState, t: number): void {
    const gcc = world.gccOf(fac.id);
    let status: string;
    if (!gcc?.gcc) status = 'No cart: your Geomantic Command Center is gone';
    else if (isCollapsed(gcc)) status = `Collapsed · rebuilt at the Hearth in ${fmtCountdown(gcc.gcc.destroyedUntil - t)}`;
    else {
      const advice = `Geomantic Advice ${GCC.adviceRadius} m`;
      status = gcc.gcc.pushedBy !== -1 ? `Rolling · ${advice}` : `Parked · ${advice} · Flag Repair ${GCC.repairRadius} m`;
    }
    if (gcc && !isCollapsed(gcc) && !gcc.disabled) status += ` · Recruits nearby neutrals (${RECRUIT_RADIUS} m / ${RECRUIT_INTERVAL} s)`;
    setText(this.gccStatus, status);
  }

  private updateSelection(world: World, fac: FactionState): void {
    const s = this.host.app.session;
    const own = this.ownSelected(world);
    let neutral = 0;
    let other: Building | null = null;
    for (const id of s.selection) {
      const h = world.hippies.get(id);
      if (h && h.faction === -1) neutral++;
      const b = world.buildings.get(id);
      if (b) other = b;
    }
    const any = own.length > 0 || neutral > 0 || other !== null;
    show(this.sel, any);
    if (!any) {
      this.selSig = '';
      return;
    }
    setText(
      this.selTitle,
      own.length > 0
        ? `${own.length} Signifier${own.length === 1 ? '' : 's'} selected${neutral ? ` · ${neutral} neutral` : ''}`
        : neutral > 0
          ? `${neutral} neutral Signifier${neutral === 1 ? '' : 's'}: hand or throw a Flag to recruit`
          : '',
    );
    let sig = '';
    for (let i = 0; i < own.length && i < MAX_CHIPS; i++) sig += `${own[i].id}:${own[i].status};`;
    sig += own.length;
    if (sig !== this.selSig) {
      this.selSig = sig;
      let markup = '';
      for (let i = 0; i < own.length && i < MAX_CHIPS; i++) {
        const h = own[i];
        const st = STATUS_INFO[h.status];
        markup += `<span class="chip tone-${st.tone}" title="${escapeHtml(h.name)} · ${st.label}">${iconSvg(st.icon)}${escapeHtml(h.name.split(' ')[0])}</span>`;
      }
      if (own.length > MAX_CHIPS) markup += `<span class="chip chip-more">+${own.length - MAX_CHIPS}</span>`;
      this.selChips.innerHTML = markup;
    }
    show(this.selChips, own.length > 0);
    show(this.selOrders, own.length > 0);

    let info = '';
    if (other) {
      const name = BUILDING_NAMES[other.kind];
      const owner = other.faction === -1 ? 'Neutral' : (world.factions[other.faction]?.name ?? '');
      const hp = `${Math.round(other.hp)}/${other.maxHp} HP`;
      const state = other.disabled ? 'Disabled' : other.built < 1 ? `Building ${Math.round(other.built * 100)}%` : 'Working';
      info = `${name} · ${owner} · ${hp} · ${state}`;
      if (other.faction === fac.id && other.kind === 'druglab') info += ' · brew below';
    }
    if (info !== this.selInfoKey) {
      this.selInfoKey = info;
      setText(this.selInfo, info);
    }
    show(this.selInfo, info !== '');
  }

  private updateBuild(world: World, fac: FactionState): void {
    const s = this.host.app.session;
    for (const [kind, b] of this.buildButtons) {
      setClass(b, 'on', s.tool === 'building' && s.buildingKind === kind);
      setClass(b, 'poor', fac.lumber < BUILDINGS[kind].cost);
    }
    let status = 'Buildings snap to thick facets inside your own Survey.';
    let bad = false;
    const kind = s.buildingKind;
    if (s.tool === 'building' && kind !== 'hearth' && kind !== 'gcc') {
      if (s.hover.facet < 0) status = `Hover a thick facet in your Survey to raise the ${BUILD_INFO[kind].name}.`;
      else {
        const check = canPlaceBuilding(world, fac.id, kind, s.hover.facet);
        status = check.ok ? `Click to raise the ${BUILD_INFO[kind].name} (${BUILDINGS[kind].cost} lumber).` : check.reason;
        bad = !check.ok;
      }
    }
    setText(this.buildStatus, status);
    setClass(this.buildStatus, 'bad', bad);
  }

  private updateLabs(world: World, fac: FactionState): void {
    const seen = new Set<EntityId>();
    for (const b of world.buildings.values()) {
      if (b.kind !== 'druglab' || b.faction !== fac.id || !b.lab) continue;
      seen.add(b.id);
      let row = this.labs.get(b.id);
      if (!row) row = this.addLab(b.id);
      const lab = b.lab;
      const working = b.built >= 1 && !b.disabled;
      let status: string;
      if (!working) status = b.disabled ? 'Disabled: needs repair' : `Under construction ${Math.round(b.built * 100)}%`;
      else if (lab.brewing) status = `Brewing ${DRUG_INFO[lab.brewing].name}`;
      else if (DRUGS.every(d => dosesOwnedOrPending(world, fac.id, d) >= DRUG_MAX) && lab.queue.length === 0) status = 'Shelves full or reserved';
      else if (fac.lumber < BREW_COST) status = `Waiting for ${BREW_COST} lumber`;
      else status = lab.queue.length > 0 ? 'Queued brew starting' : 'Automatic brew starting';
      setText(row.status, status);
      setVar(row.fill, '--p', (lab.brewing ? Math.min(1, lab.progress) : 0).toFixed(3));
      setText(row.queue, lab.queue.length > 0 ? `Priority queue: ${lab.queue.map((d) => DRUG_INFO[d].name).join(', ')}` : 'Automatic selection');
      for (const [drug, btn] of row.brew) {
        const blocker = brewBlocker(world, fac.id, b.id, drug);
        setClass(btn, 'blocked', blocker !== '');
        setDisabled(btn, blocker !== '');
        setClass(btn, 'poor', fac.lumber < BREW_COST);
        setAttr(btn, 'title', blocker || `Brew ${DRUG_INFO[drug].name}: ${BREW_COST} lumber, ${BREW_TIME} s`);
      }
    }
    for (const [id, row] of this.labs) {
      if (seen.has(id)) continue;
      row.root.remove();
      this.labs.delete(id);
    }
    show(this.labPanel, this.labs.size > 0);
  }

  private addLab(id: EntityId): LabRow {
    const root = el('div', 'lab', this.labList);
    const head = el('div', 'lab-head', root);
    const status = el('span', 'lab-status', head, '');
    const bar = el('div', 'bar lab-bar', root);
    const fill = el('i', '', bar);
    const queue = el('div', 'panel-meta lab-queue', root, '');
    const btns = el('div', 'lab-brew', root);
    const brew = new Map<DrugId, HTMLButtonElement>();
    for (const drug of DRUGS) {
      const info = DRUG_INFO[drug];
      const b = button(
        'brew-btn',
        btns,
        `${iconSvg(info.icon)}<span>${info.name}</span><span class="num">${BREW_COST}</span>`,
        () => {
          const s = this.host.app.session;
          const w = this.host.app.world;
          const blocker = w ? brewBlocker(w, s.playerFaction, id, drug) : 'No burn in progress.';
          if (blocker) this.host.blocked(blocker);
          else this.host.app.submit({ t: 'brew', faction: s.playerFaction, labId: id, drug });
        },
        'confirm',
      );
      b.title = `Brew ${info.name}: ${BREW_COST} lumber, ${BREW_TIME} s`;
      brew.set(drug, b);
    }
    const row: LabRow = { id, root, status, fill, queue, brew };
    this.labs.set(id, row);
    return row;
  }

  reset(_world: World): void {
    for (const row of this.labs.values()) row.root.remove();
    this.labs.clear();
    this.selSig = '';
    this.selInfoKey = '';
  }

  dispose(): void {
    this.right.remove();
    this.left.remove();
    this.deck.remove();
  }
}
