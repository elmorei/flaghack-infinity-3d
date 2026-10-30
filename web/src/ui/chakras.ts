/**
 * Chakra screen (session.panels.chakras, K): the five Flag chakras on a pentagon around a
 * Flag, each wired to its place in Flag anatomy (Finial, Fly, Field, Hoist, Canton). Selecting
 * one shows its ability, per-level effects, current level and the align button (Ritual cost,
 * 4 s channel anywhere), with channel progress.
 */
import { ALIGN_COST } from '../sim/constants';
import { alignBlocker } from '../sim/systems/abilities';
import type { GameEvent } from '../sim/events';
import { CHAKRAS } from '../sim/types';
import type { ChakraId } from '../sim/types';
import type { World } from '../sim/world';
import { ALIGN_NOTE, CHAKRA_INFO } from './catalog';
import { matchScreen, tutorialTarget } from './core';
import type { UiHost, UiPart } from './core';
import { button, el, escapeHtml, html, setClass, setDisabled, setText, setVar, show } from './dom';
import { ICONS, iconSvg } from './icons';

const CX = 220;
const CY = 222;
const RING = 168;

/** Pentagon vertex per chakra (Finial on top, like the pole's crown). */
const VERTEX: Record<ChakraId, number> = { finial: 0, fly: 1, field: 2, hoist: 3, canton: 4 };

/** Where each chakra lives on the central Flag drawing. */
const ANCHOR: Record<ChakraId, [number, number]> = {
  finial: [170, 100],
  canton: [200, 140],
  fly: [298, 168],
  field: [252, 186],
  hoist: [173, 176],
};

function vertexPos(c: ChakraId): [number, number] {
  const a = -Math.PI / 2 + (VERTEX[c] * 2 * Math.PI) / 5;
  return [CX + Math.cos(a) * RING, CY + Math.sin(a) * RING];
}

function diagramSvg(): string {
  const star: string[] = [];
  for (const i of [0, 2, 4, 1, 3]) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    star.push(`${(CX + Math.cos(a) * RING).toFixed(1)} ${(CY + Math.sin(a) * RING).toFixed(1)}`);
  }
  const ring: string[] = [];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    ring.push(`${(CX + Math.cos(a) * RING).toFixed(1)},${(CY + Math.sin(a) * RING).toFixed(1)}`);
  }
  let leaders = '';
  let nodes = '';
  for (const c of CHAKRAS) {
    const [x, y] = vertexPos(c);
    const [ax, ay] = ANCHOR[c];
    const info = CHAKRA_INFO[c];
    leaders += `<path class="ck-lead ck-lead-${c}" d="M${x.toFixed(1)} ${y.toFixed(1)} L${ax} ${ay}"/><circle class="ck-anchor ck-anchor-${c}" cx="${ax}" cy="${ay}" r="3.2"/>`;
    const labelY = y + (y > CY ? 52 : -40);
    nodes +=
      `<g class="ck-node" data-chakra="${c}" data-sfx="pick" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">` +
      `<circle class="ck-halo" r="38"/><circle class="ck-disc" r="30"/>` +
      `<svg x="-15" y="-17" width="30" height="30" viewBox="0 0 24 24" class="ic" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[info.icon]}</svg>` +
      `<text class="ck-key" y="23">${info.key}</text>` +
      `<g class="ck-pips"><circle cx="-10" cy="34" r="3.4"/><circle cx="0" cy="36" r="3.4"/><circle cx="10" cy="34" r="3.4"/></g>` +
      `<text class="ck-name" y="${(labelY - y).toFixed(1)}">${info.name.toUpperCase()}</text>` +
      `</g>`;
  }
  const flag =
    `<g class="ck-flag">` +
    `<path class="ck-pole" d="M170 312 V104"/><circle class="ck-finial" cx="170" cy="99" r="6"/>` +
    `<path class="ck-cloth" d="M172 116 C206 104 236 132 300 112 V214 C236 234 206 206 172 218 Z"/>` +
    `<path class="ck-canton" d="M172 116 C190 110 206 114 222 120 V164 C206 158 190 156 172 160 Z"/>` +
    `</g>`;
  return (
    `<svg class="ck-svg" viewBox="0 0 440 450" aria-hidden="true">` +
    `<polygon class="ck-ring" points="${ring.join(' ')}"/>` +
    `<path class="ck-star" d="M${star.join(' L')} Z"/>${flag}${leaders}${nodes}</svg>`
  );
}

export class ChakraScreen implements UiPart {
  private host: UiHost;
  private root: HTMLElement;
  private svgNodes = new Map<ChakraId, SVGGElement>();
  private selected: ChakraId = 'hoist';
  private shownFor: ChakraId | null = null;
  private ritual: HTMLElement;
  private dTitle: HTMLElement;
  private dSub: HTMLElement;
  private dSummary: HTMLElement;
  private dLevels: HTMLElement;
  private dLevelsKey = '';
  private dMeta: HTMLElement;
  private alignBtn: HTMLButtonElement;
  private where: HTMLElement;
  private progress: HTMLElement;
  private progressFill: HTMLElement;
  private lastReject = '';
  private wasOpen = false;

  constructor(host: UiHost, parent: HTMLElement) {
    this.host = host;
    this.root = el('div', 'modal chakras ix is-off', parent);
    const box = el('div', 'modal-box frame chakra-box', this.root);
    tutorialTarget(box, 'chakras-panel');
    const head = el('div', 'modal-head', box);
    el('h2', '', head, 'The Five Flag Chakras');
    this.ritual = el('span', 'modal-meta num', head, '');
    button(
      'panel-x',
      head,
      iconSvg('close'),
      () => {
        this.host.app.session.panels.chakras = false;
      },
      'back',
    );
    const body = el('div', 'chakra-body', box);
    const diagram = html('div', 'chakra-diagram', diagramSvg(), body);
    for (const g of diagram.querySelectorAll<SVGGElement>('.ck-node')) {
      const c = CHAKRAS.find((k) => k === g.dataset.chakra);
      if (!c) continue;
      this.svgNodes.set(c, g);
      g.addEventListener('click', () => {
        this.selected = c;
      });
    }
    const detail = el('div', 'chakra-detail', body);
    this.dTitle = el('h3', '', detail, '');
    this.dSub = el('div', 'chakra-sub', detail, '');
    this.dSummary = el('p', 'chakra-summary', detail, '');
    this.dLevels = el('ol', 'chakra-levels', detail);
    this.dMeta = el('div', 'panel-meta', detail, '');
    this.alignBtn = button(
      'btn btn-primary align-btn',
      detail,
      '',
      () => {
        const s = this.host.app.session;
        const w = this.host.app.world;
        // A blocked align shows its reason here instead of round-tripping a rejected command.
        const blocker = w ? alignBlocker(w, s.playerFaction, this.selected) : 'No burn in progress.';
        this.lastReject = blocker;
        if (!blocker) this.host.app.submit({ t: 'align', faction: s.playerFaction, chakra: this.selected });
      },
      'confirm',
    );
    tutorialTarget(this.alignBtn, 'align-button');
    const bar = el('div', 'bar align-bar is-off', detail);
    this.progressFill = el('i', '', bar);
    this.progress = bar;
    this.where = el('div', 'chakra-where', detail, '');
    el('p', 'chakra-note', detail, `${ALIGN_NOTE} Ritual comes from drumming, Crystals and Saffron.`);
  }

  onEvent(e: GameEvent, _w: World): void {
    const P = this.host.app.session.playerFaction;
    if (e.t === 'rejected' && e.faction === P && this.host.app.session.panels.chakras) this.lastReject = e.reason;
    if (e.t === 'aligned' && e.faction === P) this.lastReject = '';
  }

  update(world: World | null, _now: number): void {
    const s = this.host.app.session;
    const fac = world?.factions[s.playerFaction];
    const open = s.panels.chakras && matchScreen(s.screen) && !s.spectator && !!world && !!fac;
    show(this.root, open);
    if (open && !this.wasOpen) this.lastReject = '';
    this.wasOpen = open;
    if (!open || !world || !fac) return;
    setText(this.ritual, `${Math.floor(fac.ritual)} Ritual`);

    for (const [c, g] of this.svgNodes) {
      const lvl = fac.chakras[c];
      setClass(g, 'sel', c === this.selected);
      for (let i = 1; i <= 3; i++) setClass(g, `lv${i}`, lvl >= i);
    }

    const c = this.selected;
    const info = CHAKRA_INFO[c];
    const level = fac.chakras[c];
    if (this.shownFor !== c) {
      this.shownFor = c;
      setText(this.dTitle, `${info.name} · ${info.abilityName}`);
      setText(this.dSub, `The ${info.name} is ${info.anatomy}. Key ${info.key} · cooldown ${info.cooldown} s`);
      setText(this.dSummary, info.summary);
      this.dLevelsKey = '';
    }
    const levelsKey = `${c}:${level}`;
    if (levelsKey !== this.dLevelsKey) {
      this.dLevelsKey = levelsKey;
      this.dLevels.innerHTML = info.levels
        .map(
          (txt, i) =>
            `<li class="${i + 1 === level ? 'cur' : i < level ? 'had' : ''}"><span class="lv">L${i + 1}</span><span>${escapeHtml(txt)}</span><span class="cost num">${ALIGN_COST[i]}</span></li>`,
        )
        .join('');
    }
    setText(this.dMeta, level === 0 ? 'Not yet aligned.' : `Aligned to level ${level} of ${ALIGN_COST.length}.`);

    const av = world.avatars.get(fac.avatarId);
    const aligning = av?.action.kind === 'align' ? av.action : null;
    const maxed = level >= ALIGN_COST.length;
    const blocker = alignBlocker(world, fac.id, c);
    setText(this.alignBtn, maxed ? 'Fully aligned' : `Align to level ${level + 1} · ${ALIGN_COST[level]} Ritual`);
    setClass(this.alignBtn, 'blocked', blocker !== '');
    setDisabled(this.alignBtn, blocker !== '');

    show(this.progress, aligning !== null);
    if (aligning) setVar(this.progressFill, '--p', Math.min(1, Math.max(0, s.channel)).toFixed(3));

    let where: string;
    if (aligning) where = `Aligning the ${CHAKRA_INFO[aligning.chakra].name}… hold still.`;
    else if (this.lastReject) where = this.lastReject;
    else if (blocker) where = blocker;
    else where = 'Align from anywhere. Hold still while the Flag listens.';
    setText(this.where, where);
    setClass(this.where, 'ok', !aligning && !this.lastReject && blocker === '');
    setClass(this.where, 'bad', !aligning && (this.lastReject !== '' || blocker !== ''));
  }

  dispose(): void {
    this.root.remove();
  }
}
