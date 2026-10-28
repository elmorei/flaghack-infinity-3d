/** One small context card for the scenery under the crosshair/cursor, never a forest of labels. */
import type { Session } from '../game/session';
import type { Obstacle } from '../sim/map/mapgen';
import type { V3 } from '../sim/math';
import type { World } from '../sim/world';
import { canCaptureScenery } from '../sim/systems/structureCapture';
import { SCENERY_BENEFITS, sceneryBenefitActive, sceneryBenefitDescription, sceneryLodging, tentPlaces } from '../sim/systems/sceneryBenefits';
import { depotHolder, depotStock, vehicleCapacity } from '../sim/systems/sceneryDepots';
import { SCENERY_SERVICE_TUNING } from '../sim/systems/sceneryServices';
import { factionName } from './core';
import type { UiHost, UiPart } from './core';
import { el, html, setAttr, setClass, setText, show } from './dom';
import { iconSvg } from './icons';
import type { IconName } from './icons';
import './sceneryBenefits.css';

export interface SceneryBenefitView {
  name: string; icon: IconName; owner: string; state: string; description: string;
  tone: 'neutral' | 'active' | 'paused' | 'full';
}

/** Static props are not selectable entities. Match the actual ray surface point to their
 * rotated footprint; do not select a distant neighbour merely because it is nearby. */
export function sceneryAtSurface(world: World, point: V3 | null, entity = -1): Obstacle | null {
  if (!point || entity >= 0) return null;
  let target: Obstacle | null = null, best = Infinity;
  for (const o of world.map.obstacles) {
    if (!canCaptureScenery(o) || world.destroyedScenery.has(o.id)) continue;
    const dx = point.x - o.x, dz = point.z - o.z;
    const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
    const x = c * dx - s * dz, z = s * dx + c * dz;
    const inside = o.shape === 'circle' ? x*x + z*z <= (o.radius + .12)**2 :
      Math.abs(x) <= o.hx + .12 && Math.abs(z) <= o.hz + .12;
    if (!inside) continue;
    const ground = world.collision.groundHeight(point.x, point.z);
    if (point.y < ground - .25 || point.y > ground + o.height + .5) continue;
    const distance = dx*dx + dz*dz;
    if (distance < best) { target = o; best = distance; }
  }
  return target;
}

function role(o: Obstacle): { name: string; icon: IconName } {
  switch (o.kind) {
    case 'tent': return { name: 'Tent lodging', icon: 'popcap' };
    case 'dome': return { name: 'Dome recovery station', icon: 'repair' };
    case 'shade': return { name: 'Shade rest stop', icon: 'attention' };
    case 'porta': return { name: 'Relief break', icon: 'clock' };
    case 'art': return { name: 'Art inspiration', icon: 'ritual' };
    case 'car': return { name: `${['Sedan', 'Van', 'Bus'][o.variant] ?? 'Vehicle'} supply depot`, icon: 'stock' };
    default: return { name: 'Scenery', icon: 'help' };
  }
}

/** Pure presentation from replicated world state; works for the host and late-joining peers. */
export function sceneryBenefitView(world: World, o: Obstacle, session: Pick<Session, 'playerFaction' | 'playerNames'>): SceneryBenefitView {
  const claim = world.sceneryCapture.get(o.id), owner = claim?.faction ?? -1;
  const view: SceneryBenefitView = { ...role(o), owner: owner === -1 ? 'Neutral' :
    owner === session.playerFaction ? 'Your camp' : factionName(world, owner, session.playerNames),
    state: 'Surround the whole footprint to capture', description: sceneryBenefitDescription(o), tone: 'neutral' };
  if (world.destroyedScenery.has(o.id)) { view.state = 'Destroyed • no benefit'; return view; }
  if (owner === -1) return view;
  if (!sceneryBenefitActive(world, o.id)) {
    view.tone = 'paused';
    view.state = world.factions[owner]?.alive ? 'Paused • enemy capture in progress' : 'Inactive • owner eliminated';
    return view;
  }
  view.tone = 'active'; view.state = 'Active';
  if (o.kind === 'tent') {
    const places = sceneryLodging(world, owner);
    view.state = `+${tentPlaces(o)} lodging • camp total +${places}/${SCENERY_BENEFITS.lodgingMax}`;
    if (places >= SCENERY_BENEFITS.lodgingMax) { view.tone = 'full'; view.state += ' (cap reached)'; }
  } else if (o.kind === 'car') {
    const stock = depotStock(world, depotHolder(o.id)), max = vehicleCapacity(o);
    view.state = `${stock}/${max} Flags • ${stock >= max ? 'flag storage full' : 'accepting supplies'}`;
    if (stock >= max) view.tone = 'full';
  } else if (o.kind === 'art') {
    view.state = `Active • ${SCENERY_BENEFITS.artRange} m inspiration range`;
  } else {
    let serving = 0, queued = 0;
    for (const h of world.hippies.values()) {
      if (h.status === 'ko' || h.sceneryService?.id !== o.id) continue;
      if (h.sceneryService.phase === 'serving') serving++;
      else if (h.sceneryService.phase === 'queue') queued++;
    }
    if (o.kind === 'porta') {
      view.state = serving ? 'In use • one Signifier at a time' : 'Available • quick relief break';
      if (serving) view.tone = 'full';
    } else if (o.kind === 'dome') {
      view.state = `${serving}/${SCENERY_SERVICE_TUNING.domePatients} patients • ${serving >= SCENERY_SERVICE_TUNING.domePatients ? 'recovery slots full' : 'recovery available'}`;
      if (serving >= SCENERY_SERVICE_TUNING.domePatients) view.tone = 'full';
    } else {
      view.state = `${serving}/${SCENERY_SERVICE_TUNING.shadePlaces} resting • ${serving >= SCENERY_SERVICE_TUNING.shadePlaces ? 'rest slots full' : 'attention recovery'}`;
      if (serving >= SCENERY_SERVICE_TUNING.shadePlaces) view.tone = 'full';
    }
    if (queued) view.state += ` • ${queued} waiting`;
  }
  return view;
}

export class SceneryBenefitsPart implements UiPart {
  readonly element: HTMLElement;
  private readonly icon: HTMLElement;
  private readonly name: HTMLElement;
  private readonly owner: HTMLElement;
  private readonly state: HTMLElement;
  private readonly description: HTMLElement;
  private iconName: IconName | null = null;

  constructor(private readonly host: UiHost, parent: HTMLElement) {
    this.element = el('section', 'scenery-benefit panel is-off', parent);
    setAttr(this.element, 'aria-hidden', 'true');
    const heading = el('div', 'scenery-benefit-heading', this.element);
    this.icon = html('span', 'scenery-benefit-icon', '', heading);
    setAttr(this.icon, 'aria-hidden', 'true');
    this.name = el('strong', 'scenery-benefit-name', heading);
    this.owner = el('span', 'scenery-benefit-owner', this.element);
    this.state = el('div', 'scenery-benefit-state', this.element);
    setAttr(this.state, 'role', 'status');
    setAttr(this.state, 'aria-live', 'polite');
    setAttr(this.state, 'aria-atomic', 'true');
    this.description = el('p', 'scenery-benefit-description', this.element);
  }

  update(world: World | null, _now: number): void {
    const s = this.host.app.session;
    const prop = world && s.screen === 'playing' && !s.selectBox && !s.aim.active ?
      sceneryAtSurface(world, s.hover.point, s.hover.entity) : null;
    show(this.element, prop !== null);
    setAttr(this.element, 'aria-hidden', String(prop === null));
    if (!world || !prop) return;
    const view = sceneryBenefitView(world, prop, s);
    if (view.icon !== this.iconName) { this.icon.innerHTML = iconSvg(view.icon); this.iconName = view.icon; }
    setText(this.name, view.name); setText(this.owner, view.owner);
    setText(this.state, view.state); setText(this.description, view.description);
    setAttr(this.element, 'aria-label', `${view.name}. ${view.owner}. ${view.state}. ${view.description}`);
    for (const tone of ['neutral', 'active', 'paused', 'full']) setClass(this.element, `scenery-${tone}`, view.tone === tone);
  }

  reset(): void { show(this.element, false); setAttr(this.element, 'aria-hidden', 'true'); }
  dispose(): void { this.element.remove(); }
}
