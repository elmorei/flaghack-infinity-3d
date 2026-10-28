import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../game/session';
import type { Obstacle } from '../sim/map/mapgen';
import type { World } from '../sim/world';
import type { Hippie, SceneryCaptureState } from '../sim/types';
import { depotHolder } from '../sim/systems/sceneryDepots';
import type { UiHost } from './core';
import { sceneryAtSurface, sceneryBenefitView, SceneryBenefitsPart } from './sceneryBenefits';

function prop(kind: Obstacle['kind'], id = 1, variant = 0): Obstacle {
  return { id, kind, x: 0, z: 0, shape: 'box', hx: 2, hz: 4, radius: Math.sqrt(20), height: 4, yaw: Math.PI / 2, seed: 1, color: 0xffffff, variant };
}
function claim(faction: SceneryCaptureState['faction'] = 0, stage: SceneryCaptureState['stage'] = 'safe'): SceneryCaptureState {
  return { faction, stage, attacker: null, pressure: { 0: 0, 1: 0, 2: 0, 3: 0 }, overwriteAt: 0 };
}
function setup(kind: Obstacle['kind'] = 'dome') {
  const o = prop(kind), session = new Session(); session.screen = 'playing';
  session.hover.point = { x: 0, y: 4, z: 0 };
  const world = { map: { obstacles: [o] }, destroyedScenery: new Set(), sceneryCapture: new Map([[o.id, claim()]]),
    factions: [0, 1, 2, 3].map(id => ({ id, alive: true, name: `Camp ${id}` })),
    collision: { groundHeight: () => 0 }, flags: new Map(), hippies: new Map() } as unknown as World;
  return { o, session, world };
}
function patient(world: World, id: number, propId: number, phase: 'approach' | 'queue' | 'serving' = 'serving'): void {
  world.hippies.set(id, { id, faction: 0, status: 'idle', sceneryService: { id: propId, phase } } as Hippie);
}

describe('captured scenery context information', () => {
  it('matches actual rotated footprints, excludes unrelated targets and destroyed scenery', () => {
    const { world, o } = setup('car');
    expect(sceneryAtSurface(world, { x: 3.9, y: 3, z: 0 })).toBe(o);
    expect(sceneryAtSurface(world, { x: 0, y: 3, z: 3 })).toBeNull();
    expect(sceneryAtSurface(world, { x: 0, y: 100, z: 0 })).toBeNull();
    expect(sceneryAtSurface(world, { x: 0, y: 3, z: 0 }, 17)).toBeNull();
    world.destroyedScenery.add(o.id);
    expect(sceneryAtSurface(world, { x: 0, y: 3, z: 0 })).toBeNull();
  });

  it('matches circular footprints but never immune stages', () => {
    const { world, o } = setup(); o.shape = 'circle'; o.radius = 3;
    expect(sceneryAtSurface(world, { x: 2, y: 1, z: 2 })).toBe(o);
    expect(sceneryAtSurface(world, { x: 2.9, y: 1, z: 2.9 })).toBeNull();
    o.kind = 'stage';
    expect(sceneryAtSurface(world, { x: 0, y: 1, z: 0 })).toBeNull();
  });

  it('describes neutral benefits without claiming they are already enabled', () => {
    const { world, o, session } = setup('tent'); world.sceneryCapture.clear();
    const v = sceneryBenefitView(world, o, session);
    expect(v.owner).toBe('Neutral'); expect(v.tone).toBe('neutral');
    expect(v.state).toContain('capture'); expect(v.description).toContain('+2');
  });

  it('pauses only real capture, retains threat-only services and handles owner loss', () => {
    const { world, o, session } = setup();
    for (const stage of ['contained', 'contested', 'overwritten'] as const) {
      world.sceneryCapture.set(o.id, claim(0, stage));
      expect(sceneryBenefitView(world, o, session).state).toContain('Paused');
    }
    world.sceneryCapture.set(o.id, claim(0, 'threatened'));
    expect(sceneryBenefitView(world, o, session).tone).toBe('active');
    world.factions[0].alive = false;
    expect(sceneryBenefitView(world, o, session).state).toContain('owner eliminated');
  });

  it('reports depot real stock and full capacity for all vehicle sizes', () => {
    const { world, o, session } = setup('car');
    for (const [variant, capacity] of [3, 6, 10].entries()) {
      o.variant = variant; world.flags.clear();
      for (let i = 0; i < capacity; i++) world.flags.set(i, { state: 'stock', holder: depotHolder(o.id) } as never);
      const v = sceneryBenefitView(world, o, session);
      expect(v.state).toContain(`${capacity}/${capacity}`); expect(v.tone).toBe('full');
    }
  });

  it('uses replicated service states, excluding approach and KO from occupancy', () => {
    const { world, o, session } = setup();
    for (let i = 0; i < 4; i++) patient(world, i, o.id);
    patient(world, 10, o.id, 'approach'); patient(world, 11, o.id, 'queue');
    patient(world, 12, o.id); world.hippies.get(12)!.status = 'ko';
    const v = sceneryBenefitView(world, o, session);
    expect(v.state).toContain('4/4'); expect(v.state).toContain('1 waiting'); expect(v.tone).toBe('full');
    o.kind = 'porta'; world.hippies.clear();
    expect(sceneryBenefitView(world, o, session).state).toContain('Available');
    patient(world, 1, o.id);
    expect(sceneryBenefitView(world, o, session).state).toContain('In use');
  });

  it('shows the lodging cap and changes owner display immediately on recapture', () => {
    const { world, o, session } = setup('tent'); o.variant = 2;
    for (let i = 2; i < 7; i++) { world.map.obstacles.push(prop('tent', i, 2)); world.sceneryCapture.set(i, claim()); }
    expect(sceneryBenefitView(world, o, session).state).toContain('cap reached');
    world.sceneryCapture.set(o.id, claim(1)); session.playerNames[1] = '<Rival>';
    const v = sceneryBenefitView(world, o, session);
    expect(v.owner).toBe('<Rival>'); expect(v.state).toContain('+3/12');
  });

  it('gives art and shade concise role descriptions', () => {
    const { world, o, session } = setup('art');
    expect(sceneryBenefitView(world, o, session).description).toMatch(/25%.*25m/);
    o.kind = 'shade'; patient(world, 1, o.id);
    expect(sceneryBenefitView(world, o, session).state).toContain('1/4 resting');
  });
});

class Node {
  className = ''; textContent = ''; innerHTML = ''; children: Node[] = []; parentElement: Node | null = null;
  attributes = new Map<string, string>();
  classList = {
    contains: (key: string) => this.className.split(' ').includes(key),
    toggle: (key: string, on: boolean) => { const classes = new Set(this.className.split(' ').filter(Boolean)); if (on) classes.add(key); else classes.delete(key); this.className = [...classes].join(' '); },
  };
  appendChild(node: Node) { node.parentElement = this; this.children.push(node); return node; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); }
}
afterEach(() => vi.unstubAllGlobals());

it('shows only the hovered scenery card, with accessible text and cleanup on mode changes', () => {
  vi.stubGlobal('document', { createElement: () => new Node() });
  const { world, session } = setup(); const root = new Node();
  const part = new SceneryBenefitsPart({ app: { session } } as UiHost, root as unknown as HTMLElement);
  const node = part.element as unknown as Node;
  part.update(world, 0);
  expect(node.getAttribute('aria-hidden')).toBe('false');
  expect(node.getAttribute('aria-label')).toContain('Dome recovery station');
  for (const screen of ['paused', 'ended', 'title', 'lobby'] as const) {
    session.screen = screen; part.update(world, 0); expect(node.classList.contains('is-off')).toBe(true);
  }
  session.screen = 'playing'; session.aim.active = true; part.update(world, 0);
  expect(node.classList.contains('is-off')).toBe(true);
  session.aim.active = false; part.update(world, 0); expect(node.classList.contains('is-off')).toBe(false);
  part.reset(); expect(node.getAttribute('aria-hidden')).toBe('true');
  part.dispose(); expect(root.children).toHaveLength(0);
});
