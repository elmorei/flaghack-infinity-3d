import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILDINGS, LEVEL_HEIGHT } from '../../sim/constants';
import { createFaction } from '../../sim/factory';
import { EconState } from '../../sim/systems/econ/state';
import type { Building, BuildingKind, CaptureStage } from '../../sim/types';
import type { World } from '../../sim/world';
import type { RenderContext } from '../context';
import type { SpritePose } from '../actors/mobileSprites';
import { BUILDING_SPRITE_HEIGHT, type BuildingView, type FrameInfo } from './buildingView';
import { StructureKit } from './kit';
import { HearthView } from './hearthView';
import { WorkshopView } from './workshopView';
import { DrumCircleView } from './drumCircleView';
import { WardView } from './wardView';
import { DrugLabView } from './drugLabView';
import { GccView } from './gccView';
import { GhostRenderer } from './ghosts';

const kinds: BuildingKind[] = ['hearth', 'workshop', 'drumcircle', 'ward', 'druglab', 'gcc'];
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); vi.restoreAllMocks(); });

function fixture(kind: BuildingKind, mobile = true) {
  const def = BUILDINGS[kind];
  const b: Building = {
    id: 7, type: 'building', kind, faction: 0, pos: {x: 23, z: -31}, yaw: .3, facet: 0,
    hp: def.hp, maxHp: def.hp, built: 1, disabled: false, progress: 0,
    hearth: kind === 'hearth' ? {stage: 'safe', attacker: null, pressure: {0: 0, 1: 0, 2: 0, 3: 0}, overwriteAt: 0, founder: 0, craftProgress: 0, facet: 0} : null,
    lab: kind === 'druglab' ? {brewing: null, progress: 0, queue: []} : null,
    gcc: kind === 'gcc' ? {destroyedUntil: 0, pushedBy: -1, channelUntil: 0} : null,
  };
  const world = {time: 100, tick: 100, options: {}, factions: [0, 1, 2, 3].map(id => createFaction(id as 0 | 1 | 2 | 3, true, 'normal')),
    buildings: new Map([[b.id, b]]), flags: new Map(), hippies: new Map(), scratch: {},
    collision: {groundHeight: () => 4}, hearthOf: () => kind === 'hearth' ? b : undefined,
  } as unknown as World;
  const building = vi.fn((_kind: BuildingKind, _pose: SpritePose, _style: Record<string, unknown>) => true);
  const flag = vi.fn((_pose: SpritePose, _state: string, _style: Record<string, unknown>) => true);
  const ctx = {world, shared: {groundOffset: () => 4, ...(mobile ? {mobileSprites: {building, flag}} : {})}} as unknown as RenderContext;
  const frame = {ctx, world, t: 100, dt: .1, night: 1, wind: .6, windYaw: .2,
    stock: new Map<number, number>(), smoke: {emit: vi.fn()}, sparks: {emit: vi.fn()}} as unknown as FrameInfo;
  const kit = new StructureKit({capabilities: {getMaxAnisotropy: () => 1}} as unknown as THREE.WebGLRenderer, 'low');
  vi.spyOn(kit, 'texture').mockReturnValue(new THREE.CanvasTexture({width: 1, height: 1} as HTMLCanvasElement));
  const light = new THREE.PointLight();
  const view: BuildingView = kind === 'hearth' ? new HearthView(kit, b, light)
    : kind === 'workshop' ? new WorkshopView(kit, b)
    : kind === 'drumcircle' ? new DrumCircleView(kit, b)
    : kind === 'ward' ? new WardView(kit, b)
    : kind === 'druglab' ? new DrugLabView(kit, b) : new GccView(kit, b);
  cleanup.push(() => {view.dispose(); kit.dispose();});
  const body = view.root.getObjectByName(`building-models-${b.id}`)!;
  const effects = view.root.getObjectByName(`building-effects-${b.id}`)!;
  return {b, world, ctx, frame, view, body, effects, building, flag, light, kit};
}

describe('mobile building presentation', () => {
  it.each(kinds)('maps %s to a flat sprite without changing the building', kind => {
    const e = fixture(kind), before = JSON.stringify(e.b);
    e.view.update(e.b, e.frame);
    expect(e.building).toHaveBeenCalledOnce();
    expect(e.building.mock.lastCall?.[0]).toBe(kind);
    expect(e.building.mock.lastCall?.[1]).toMatchObject({id: -6000000 - e.b.id, x: 23, y: 4, z: -31, height: BUILDING_SPRITE_HEIGHT[kind]});
    expect(e.body.visible).toBe(false);
    expect(e.effects.visible).toBe(true);
    expect(e.view.root.visible).toBe(true);
    expect(JSON.stringify(e.b)).toBe(before);
  });

  it.each(kinds)('retains %s models on desktop', kind => {
    const e = fixture(kind, false);
    e.view.update(e.b, e.frame);
    expect(e.building).not.toHaveBeenCalled(); expect(e.flag).not.toHaveBeenCalled();
    expect(e.body.visible).toBe(true);
  });

  it.each(['workshop', 'drumcircle', 'gcc'] as BuildingKind[])('keeps idle %s cloth waving without an active job', kind => {
    const e = fixture(kind); e.view.update(e.b, e.frame);
    expect(e.building.mock.lastCall?.[2].state).toBe('idle');
    expect(e.building.mock.lastCall?.[1].moving).toBe(true);
    e.b.disabled = true; e.view.update(e.b, e.frame);
    expect(e.building.mock.lastCall?.[1].moving).toBe(false);
  });

  it.each(['workshop', 'drumcircle', 'ward', 'druglab'] as BuildingKind[])('grounds %s on its actual platform level', kind => {
    const e = fixture(kind); e.b.level = 2;
    e.view.update(e.b, e.frame);
    expect(e.building.mock.lastCall?.[1].y).toBe(4 + 2 * LEVEL_HEIGHT);
  });

  it('keeps construction, damage, disable, repair and capture cues without model fallback', () => {
    const e = fixture('workshop'); e.b.built = .3;
    e.view.update(e.b, e.frame);
    expect(e.building.mock.lastCall?.[2]).toMatchObject({buildProgress: .3, disabled: false, damage: 0});
    // Scaffolds are hidden along with the model; construction is drawn by sprite reveal.
    expect(e.view.root.children.filter(c => c !== e.body && c !== e.effects).every(c => !c.visible)).toBe(true);
    e.b.built = 1; e.view.update(e.b, e.frame);
    expect(e.building.mock.lastCall?.[1].height).not.toBe(BUILDING_SPRITE_HEIGHT.workshop);
    expect(e.frame.sparks.emit).toHaveBeenCalled();
    e.b.hp = e.b.maxHp * .2; e.b.disabled = true; e.view.update(e.b, e.frame);
    expect(e.building.mock.lastCall?.[2]).toMatchObject({disabled: true, damage: expect.closeTo(.6)});
    expect(e.frame.smoke.emit).toHaveBeenCalled();
    e.b.hp = e.b.maxHp; e.b.disabled = false; e.b.faction = 1; e.view.update(e.b, e.frame);
    const style = e.building.mock.lastCall![2];
    expect(style).toMatchObject({disabled: false, damage: 0});
    expect((style.ownerColor as THREE.Color).getHex()).toBe(e.world.factions[1].color);
    expect(e.body.visible).toBe(false);
  });

  it('does not leave an independent building or stock sprite when the boss holds it', () => {
    const e = fixture('workshop');
    e.world.boss = {held: {kind: 'building', id: e.b.id}} as World['boss'];
    (e.frame.stock as Map<number, number>).set(e.b.id, 3);
    e.view.update(e.b, e.frame);
    expect(e.building).not.toHaveBeenCalled(); expect(e.flag).not.toHaveBeenCalled(); expect(e.body.visible).toBe(false);
  });

  it('keeps altar capture fire and exact stock counts, and omits the pole for a seated ruler', () => {
    const e = fixture('hearth'); (e.frame.stock as Map<number, number>).set(e.b.id, 3);
    for (const stage of ['safe', 'threatened', 'contained', 'contested', 'overwritten', 'captured'] as CaptureStage[]) {
      e.b.hearth!.stage = stage; e.b.hearth!.attacker = 1; e.b.hearth!.pressure[1] = 80;
      e.view.update(e.b, e.frame);
      expect(e.effects.children.some(o => o.visible)).toBe(true);
      expect(e.light.intensity).toBeGreaterThan(0);
    }
    expect(e.flag).toHaveBeenCalledTimes(18);
    e.world.factions[0].controlMode = 'rts'; e.view.update(e.b, e.frame);
    expect(e.building.mock.lastCall?.[2].state).toBe('seated');
    expect(e.building.mock.lastCall?.[1].height).toBe(2);
    expect(e.effects.children.every(o => !o.visible)).toBe(true);
    e.world.factions[0].controlMode = 'avatar'; e.view.update(e.b, e.frame);
    expect(e.building.mock.lastCall?.[2].state).toBe('idle');
    expect(e.building.mock.lastCall?.[1].height).toBe(8.41);
    expect(e.effects.children.some(o => o.visible)).toBe(true);
  });

  it('keeps workshop stock separate and advances its working animation only during production', () => {
    const e = fixture('workshop'); (e.frame.stock as Map<number, number>).set(e.b.id, 14);
    e.view.update(e.b, e.frame); expect(e.flag).toHaveBeenCalledTimes(10);
    expect(e.building.mock.lastCall?.[2].state).toBe('idle');
    e.b.progress = .1; e.view.update(e.b, e.frame);
    expect(e.building.mock.lastCall?.[2].state).toBe('working');
  });

  it('freezes hoarded altar stock and caps the rack at thirty flags', () => {
    const e = fixture('hearth'), economy = new EconState();
    economy.stockTick = e.world.tick; economy.hoarding[0] = true; e.world.scratch.economy = economy;
    (e.frame.stock as Map<number, number>).set(e.b.id, 40); e.view.update(e.b, e.frame);
    expect(e.flag).toHaveBeenCalledTimes(30); expect(e.flag.mock.calls.every(([pose]) => !pose.moving)).toBe(true);
    e.flag.mockClear(); economy.hoarding[0] = false; e.view.update(e.b, e.frame);
    expect(e.flag.mock.calls.every(([pose]) => pose.moving)).toBe(true);
  });

  it('uses sprite placement ghosts with exact platform height and cyan/red validity, then clears them', () => {
    const e = fixture('workshop'), scene = new THREE.Scene();
    const nodes = [{x: 0, z: 0}, {x: 8, z: 0}, {x: 10, z: 7}, {x: 2, z: 7}];
    e.world.lattice = {edge: 8, facets: [{id: 0, nodes: [0, 1, 2, 3], cx: 5, cz: 3.5}], nodes, edges: []} as unknown as World['lattice'];
    e.ctx.session = {ghost: {kind: 'workshop', facet: 0, edge: -1, level: 2, rampEdge: 0, valid: true}} as RenderContext['session'];
    const ghost = new GhostRenderer(e.kit, scene, 8); cleanup.push(() => ghost.dispose());
    ghost.update(e.frame);
    expect(e.building.mock.lastCall?.[1]).toMatchObject({x: 5, y: 4 + 2 * LEVEL_HEIGHT, z: 3.5});
    expect(e.building.mock.lastCall?.[2]).toMatchObject({ghost: true, buildProgress: 0});
    expect((e.building.mock.lastCall![2].ownerColor as THREE.Color).getHex()).toBe(0x3df2ff);
    e.ctx.session.ghost!.valid = false; ghost.update(e.frame);
    expect((e.building.mock.lastCall![2].ownerColor as THREE.Color).getHex()).toBe(0xff3448);
    e.building.mockClear(); e.ctx.session.ghost = null; ghost.update(e.frame);
    expect(e.building).not.toHaveBeenCalled(); expect(scene.children[0].visible).toBe(false);
  });

  it('preserves the GCC recruitment range through sprite replacement, wreck and rebuild', () => {
    const e = fixture('gcc'), dome = e.view.root.getObjectByName('gcc-recruitment-dome')!;
    e.view.update(e.b, e.frame); expect(dome.visible).toBe(true); expect(dome.parent).toBe(e.view.root);
    e.b.gcc!.channelUntil = 120; e.view.update(e.b, e.frame);
    expect(e.building.mock.lastCall?.[2].state).toBe('channel');
    e.b.gcc!.channelUntil = 0; e.b.pos.x += 1; e.view.update(e.b, e.frame);
    expect(e.building.mock.lastCall?.[2].state).toBe('moving');
    e.b.gcc!.destroyedUntil = 110; e.b.disabled = true; e.view.update(e.b, e.frame);
    expect(e.building.mock.lastCall?.[2].state).toBe('wreck'); expect(dome.visible).toBe(false);
    expect(e.building.mock.lastCall?.[2].rotation).toBe((e.body as THREE.Group).rotation.z);
    e.b.gcc!.destroyedUntil = 0; e.b.disabled = false; e.view.update(e.b, e.frame);
    expect(dome.visible).toBe(true); expect(e.body.visible).toBe(false);
  });

  it('keeps ward pulse and lab brewing effects independent of the models', () => {
    const ward = fixture('ward'); ward.view.onEvent({t: 'wardPulse', buildingId: ward.b.id} as Parameters<BuildingView['onEvent']>[0], ward.frame);
    ward.view.update(ward.b, ward.frame);
    expect(ward.building.mock.lastCall?.[2].state).toBe('pulse');
    expect(ward.view.root.children.some(o => o !== ward.body && o !== ward.effects && o.visible)).toBe(true);
    const lab = fixture('druglab'); lab.b.lab!.brewing = 'saffron'; lab.frame.dt = 1;
    lab.view.update(lab.b, lab.frame);
    expect(lab.building.mock.lastCall?.[2].state).toBe('brewing');
    expect(lab.effects.children.some(o => o.visible)).toBe(true);
    expect(lab.frame.smoke.emit).toHaveBeenCalled();
  });
});
