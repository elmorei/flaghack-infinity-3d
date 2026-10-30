/**
 * Bottom-centre action bar: the tool strip (F Z X C V B with costs, current tool lit), the five
 * chakra ability slots (key, icon, level pips, cooldown sweep, locked/blocked state, tooltip
 * with per-level effect and the sim's abilityBlocker reason) and the three drug slots (doses,
 * active timer, Saffron crash). Tooltips only exist when the cursor is free (Command View or
 * unlocked pointer); the bar never takes pointer events in action view.
 */
import type { ToolKind } from '../game/session';
import { ABILITY, ALIGN_COST, BUILDINGS, DRUG } from '../sim/constants';
import { abilityBlocker } from '../sim/systems/abilities';
import { drugBlocker } from '../sim/systems/drugs';
import { CHAKRAS, DRUGS } from '../sim/types';
import type { ChakraId, DrugId } from '../sim/types';
import type { World } from '../sim/world';
import { BUILD_INFO, CHAKRA_INFO, DRUG_INFO, TOOL_INFO } from './catalog';
import { matchScreen, tutorialTarget } from './core';
import type { UiHost, UiPart } from './core';
import { el, escapeHtml, fmtCountdown, html, setClass, setDisabled, setText, setVar, show } from './dom';
import { iconSvg } from './icons';

interface AbilitySlot {
  chakra: ChakraId;
  root: HTMLElement;
  pips: HTMLElement[];
  cdText: HTMLElement;
  tip: HTMLElement;
  tipKey: string;
}

interface DrugSlot {
  drug: DrugId;
  root: HTMLElement;
  doses: HTMLElement;
  timer: HTMLElement;
  tip: HTMLElement;
  tipKey: string;
}

interface ToolSlot {
  tool: ToolKind;
  root: HTMLElement;
  icon: HTMLElement;
  name: HTMLElement;
  cost: HTMLElement;
  iconKey: string;
}

export class ActionBar implements UiPart {
  private host: UiHost;
  private root: HTMLElement;
  private abilities: AbilitySlot[] = [];
  private drugs: DrugSlot[] = [];
  private tools: ToolSlot[] = [];
  private hovered: AbilitySlot | DrugSlot | null = null;

  constructor(host: UiHost, parent: HTMLElement) {
    this.host = host;
    this.root = el('div', 'abar', parent);

    const strip = el('div', 'tools', this.root);
    tutorialTarget(strip, 'tools');
    for (const info of TOOL_INFO) {
      const root = el('div', 'tool', strip);
      if (info.target) tutorialTarget(root, info.target);
      root.title = info.tool === 'building' ? 'Camp building (B cycles the kind)' : info.name;
      el('span', 'tool-key', root, info.key);
      const icon = html('span', 'tool-ic', iconSvg(info.icon), root);
      const name = el('span', 'tool-name', root, info.name);
      const cost = el('span', 'tool-cost num', root, info.cost > 0 ? String(info.cost) : info.cost < 0 ? `+${-info.cost}` : '');
      root.dataset.sfx = 'pick';
      root.addEventListener('click', () => {
        this.host.app.session.tool = info.tool;
      });
      this.tools.push({ tool: info.tool, root, icon, name, cost, iconKey: info.icon });
    }

    const row = el('div', 'slots', this.root);
    const abil = el('div', 'slot-group', row);
    for (const chakra of CHAKRAS) {
      const info = CHAKRA_INFO[chakra];
      const root = el('div', 'slot ab', abil);
      tutorialTarget(root, info.target);
      root.dataset.chakra = chakra;
      el('span', 'slot-key', root, info.key);
      html('span', 'slot-ic', iconSvg(info.icon), root);
      const pipBox = el('span', 'slot-pips', root);
      const pips = [el('i', '', pipBox), el('i', '', pipBox), el('i', '', pipBox)];
      el('span', 'slot-sweep', root);
      const cdText = el('span', 'slot-cdt num', root, '');
      html('span', 'slot-lock', iconSvg('lock'), root);
      const tip = el('div', 'tip', root);
      const slot: AbilitySlot = { chakra, root, pips, cdText, tip, tipKey: '' };
      this.hoverable(root, slot);
      this.abilities.push(slot);
    }
    el('span', 'slot-sep', row);
    const drugs = el('div', 'slot-group', row);
    for (const drug of DRUGS) {
      const info = DRUG_INFO[drug];
      const root = el('div', 'slot drug', drugs);
      tutorialTarget(root, info.target);
      root.dataset.drug = drug;
      el('span', 'slot-key', root, info.key);
      html('span', 'slot-ic', iconSvg(info.icon), root);
      el('span', 'slot-sweep', root);
      const doses = el('span', 'slot-doses num', root, '0');
      const timer = el('span', 'slot-cdt num', root, '');
      const tip = el('div', 'tip', root);
      const slot: DrugSlot = { drug, root, doses, timer, tip, tipKey: '' };
      this.hoverable(root, slot);
      root.dataset.sfx = 'click';
      root.addEventListener('click', () => {
        const s = this.host.app.session;
        const w = this.host.app.world;
        const blocker = w ? drugBlocker(w, s.playerFaction, drug) : 'No burn in progress.';
        if (blocker) this.host.blocked(blocker);
        else this.host.app.submit({ t: 'drug', faction: s.playerFaction, drug });
      });
      this.drugs.push(slot);
    }
  }

  private hoverable(root: HTMLElement, slot: AbilitySlot | DrugSlot): void {
    root.addEventListener('mouseenter', () => {
      this.hovered = slot;
      slot.tipKey = '';
      const w = this.host.app.world;
      if (w) this.refreshTip(w, slot);
    });
    root.addEventListener('mouseleave', () => {
      if (this.hovered === slot) this.hovered = null;
    });
  }

  update(world: World | null, _now: number): void {
    const s = this.host.app.session;
    const fac = world?.factions[s.playerFaction];
    const visible = matchScreen(s.screen) && !s.spectator && !!world && !!fac && fac.alive;
    show(this.root, visible);
    if (!visible || !world || !fac) return;
    const t = world.time;
    // Pointer events only while the cursor is free; in action view the bar must never eat clicks.
    setClass(this.root, 'ix', s.view === 'command' || !s.pointerLocked);

    for (const slot of this.tools) {
      show(slot.root, s.view !== 'command' || slot.tool === 'flag' || slot.tool === 'building');
      const active = s.tool === slot.tool;
      setClass(slot.root, 'on', active);
      if (slot.tool === 'building') {
        const kind = s.buildingKind;
        if (kind !== 'hearth' && kind !== 'gcc') {
          const info = BUILD_INFO[kind];
          if (slot.iconKey !== info.icon) {
            slot.iconKey = info.icon;
            slot.icon.innerHTML = iconSvg(info.icon);
          }
          setText(slot.name, info.name);
          setText(slot.cost, String(BUILDINGS[kind].cost));
          setClass(slot.root, 'poor', fac.lumber < BUILDINGS[kind].cost);
        }
      } else {
        const info = TOOL_INFO.find((ti) => ti.tool === slot.tool);
        setClass(slot.root, 'poor', !!info && info.cost > 0 && fac.lumber < info.cost);
      }
    }

    for (const slot of this.abilities) {
      const info = CHAKRA_INFO[slot.chakra];
      const level = fac.chakras[slot.chakra];
      for (let i = 0; i < 3; i++) setClass(slot.pips[i], 'on', i < level);
      const remaining = fac.cooldowns[info.ability] - t;
      const cooling = level > 0 && remaining > 0;
      const blocker = level > 0 && !cooling ? abilityBlocker(world, s.playerFaction, info.ability) : '';
      setClass(slot.root, 'locked', level === 0);
      setClass(slot.root, 'cooling', cooling);
      setClass(slot.root, 'blocked', blocker !== '');
      setClass(slot.root, 'ready', level > 0 && !cooling && blocker === '');
      setVar(slot.root, '--p', cooling ? Math.min(1, remaining / ABILITY[info.ability].cooldown).toFixed(3) : '0');
      setText(slot.cdText, cooling ? String(Math.ceil(remaining)) : '');
    }

    for (const slot of this.drugs) {
      const doses = fac.drugs[slot.drug];
      const activeLeft = fac.drugActive[slot.drug] - t;
      const crashLeft = slot.drug === 'saffron' ? fac.saffronCrashUntil - t : 0;
      setText(slot.doses, `×${doses}`);
      setClass(slot.root, 'empty', doses <= 0 && activeLeft <= 0);
      setDisabled(slot.root, drugBlocker(world, s.playerFaction, slot.drug) !== '');
      setClass(slot.root, 'active', activeLeft > 0);
      setClass(slot.root, 'crash', activeLeft <= 0 && crashLeft > 0);
      const p = activeLeft > 0 ? activeLeft / DRUG.duration[slot.drug] : crashLeft > 0 ? crashLeft / DRUG.crashTime : 0;
      setVar(slot.root, '--p', Math.min(1, p).toFixed(3));
      setText(slot.timer, activeLeft > 0 ? String(Math.ceil(activeLeft)) : crashLeft > 0 ? String(Math.ceil(crashLeft)) : '');
    }

    if (this.hovered) this.refreshTip(world, this.hovered);
  }

  /** Tooltip markup is rebuilt only when its content key changes (it embeds live reasons/timers). */
  private refreshTip(world: World, slot: AbilitySlot | DrugSlot): void {
    const s = this.host.app.session;
    const fac = world.factions[s.playerFaction];
    if (!fac) return;
    let markup: string;
    if ('chakra' in slot) {
      const info = CHAKRA_INFO[slot.chakra];
      const level = fac.chakras[slot.chakra];
      const remaining = fac.cooldowns[info.ability] - world.time;
      const blocker = level > 0 ? abilityBlocker(world, s.playerFaction, info.ability) : '';
      const lines = info.levels
        .map((txt, i) => `<li class="${i + 1 === level ? 'cur' : i < level ? 'had' : ''}"><b>L${i + 1}</b> ${escapeHtml(txt)}</li>`)
        .join('');
      let status: string;
      if (level === 0) status = `<p class="tip-bad">Locked. Align the ${info.name} chakra (K): ${ALIGN_COST[0]} Ritual.</p>`;
      else if (remaining > 0) status = `<p class="tip-wait">Recharging: ${fmtCountdown(remaining)}</p>`;
      else if (blocker) status = `<p class="tip-bad">${escapeHtml(blocker)}</p>`;
      else status = '<p class="tip-good">Ready. Cast at the crosshair or cursor.</p>';
      markup =
        `<h4>${escapeHtml(info.abilityName)} <span>${info.name} chakra · ${info.key}</span></h4>` +
        `<p>${escapeHtml(info.summary)}</p><ul>${lines}</ul>` +
        `<p class="tip-meta">Cooldown ${info.cooldown} s</p>${status}`;
    } else {
      const info = DRUG_INFO[slot.drug];
      const doses = fac.drugs[slot.drug];
      const left = fac.drugActive[slot.drug] - world.time;
      const blocker = left > 0 ? '' : drugBlocker(world, s.playerFaction, slot.drug);
      const status =
        left > 0
          ? `<p class="tip-good">Active: ${fmtCountdown(left)}</p>`
          : blocker
            ? `<p class="tip-bad">${escapeHtml(blocker)}</p>`
            : `<p class="tip-good">${doses} dose${doses === 1 ? '' : 's'} ready. Press ${info.key} or click.</p>`;
      markup =
        `<h4>${escapeHtml(info.name)} <span>${info.key} · ${info.duration} s</span></h4>` +
        `<p>${escapeHtml(info.effect)}</p><p class="tip-risk"><b>Risk:</b> ${escapeHtml(info.risk)}</p>${status}`;
    }
    if (markup === slot.tipKey) return;
    slot.tipKey = markup;
    slot.tip.innerHTML = markup;
  }

  dispose(): void {
    this.root.remove();
  }
}
