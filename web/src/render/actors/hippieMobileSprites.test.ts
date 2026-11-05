import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createMatch } from '../../sim/setup';
import type { EffectKind, HippieStatus } from '../../sim/types';
import type { RenderContext } from '../context';
import { HippieRenderer } from './hippieRenderer';
import type { FlagRenderer } from './flagRenderer';
import { PLACE, type ActorView } from './lod';
import type { StatusIcons, UnitRings } from './overlays';
import type { SpritePose } from './mobileSprites';

function fixture(mobile = true) {
  const world = createMatch({seed: 'mobile-signifier-actions', difficulty: 'normal', humans: [0,1,2,3], mode: 'standard'});
  const h = [...world.hippies.values()].find(h => h.id !== world.frickFrack?.wizardId)!;
  world.hippies.clear(); world.hippies.set(h.id, h); h.carryingFlag = -1; h.carryingLumber = 0; h.effects = []; h.beacon = false;
  const signifier = vi.fn((_pose: SpritePose, _head: number, _body: number, _animation: string, _flagColor?: THREE.Color) => true);
  const ctx = {world, scene: new THREE.Scene(), shared: {groundOffset: () => 4, ...(mobile ? {mobileSprites: {signifier, signifierNeedsFlag: () => true}} : {})}, time: 5, beat: 0,
    session: {playerFaction: 0, hover: {entity: -1}, selection: new Set()}} as unknown as RenderContext;
  const flags = {pushMatrix: vi.fn(), ribbonColor: (owner: number) => new THREE.Color(owner === -1 ? 0xffffff : world.factions[owner].color), markPulling: vi.fn()} as unknown as FlagRenderer;
  const renderer = new HippieRenderer(ctx, {place: () => PLACE.detailed, shadows: false} as unknown as ActorView,
    flags, {push: vi.fn()} as unknown as UnitRings, {push: vi.fn()} as unknown as StatusIcons, new Map());
  const models = () => ctx.scene.children.filter(o => o.name.startsWith('actors-hippies')) as THREE.InstancedMesh[];
  return {ctx, world, h, signifier, flags, renderer, models};
}

describe('signifier sprite integration', () => {
  it('keeps every stationary work, combat and KO pose in sprites without changing the sim', () => {
    const e = fixture();
    try {
      const states: [HippieStatus, string][] = [
        ['idle', 'idle'], ['chopping', 'chop'], ['planting', 'kneel'], ['pulling', 'tug'], ['hauling', 'haul'],
        ['building', 'hammer'], ['repairing', 'hammer'], ['fighting', 'shove'], ['tearing', 'kick'],
        ['drumming', 'drum'], ['distracted', 'dance'], ['defending', 'guard'], ['ko', 'ko'],
      ];
      for (const [status, clip] of states) {
        e.h.status = status; const before = JSON.stringify(e.h); e.ctx.time += .1; e.renderer.update(.1);
        expect(e.signifier.mock.lastCall?.[3]).toBe(clip);
        expect(e.signifier.mock.lastCall?.[0].y).toBe(4);
        expect(e.models().every(mesh => mesh.count === 0 && !mesh.visible)).toBe(true);
        expect(JSON.stringify(e.h)).toBe(before);
      }
    } finally { e.renderer.dispose(); }
  });
  it('uses effect/jump clips instead of exposing effect-deformed 3D bodies', () => {
    const e = fixture(); e.h.status = 'idle';
    try {
      for (const [kind, clip] of [['stun', 'stun'], ['knockback', 'hit'], ['wobble', 'wobble'], ['psychosis', 'jitter']] as [EffectKind, string][]) {
        e.h.effects = [{kind, until: 100, mag: 1, source: -1}]; e.renderer.update(.1);
        expect(e.signifier.mock.lastCall?.[3]).toBe(clip);
        expect(e.models().every(mesh => mesh.count === 0)).toBe(true);
      }
      e.h.effects = []; e.h.airborne = {y: 3, vy: 1}; e.renderer.update(.1);
      expect(e.signifier.mock.lastCall?.[3]).toBe('jump'); expect(e.signifier.mock.lastCall?.[0].y).toBe(7);
      expect(e.models().every(mesh => mesh.count === 0)).toBe(true);
    } finally { e.renderer.dispose(); }
  });
  it('keeps the actual carried flag visible for action sheets without baked equipment', () => {
    const e = fixture(); e.h.status = 'planting'; e.h.faction = 0;
    const flag = [...e.world.flags.values()][0]; flag.owner = 2; e.h.carryingFlag = flag.id;
    try {
      e.renderer.update(.1); expect(e.signifier.mock.lastCall?.[3]).toBe('kneel');
      expect(e.flags.pushMatrix).toHaveBeenCalledOnce();
      expect(e.signifier.mock.lastCall?.[4]?.getHex()).toBe(new THREE.Color(e.world.factions[2].color).getHex());
      expect(e.signifier.mock.lastCall?.[4]?.getHex()).not.toBe(new THREE.Color(e.world.factions[0].color).getHex());
      expect(e.models().every(mesh => mesh.count === 0)).toBe(true);
    } finally { e.renderer.dispose(); }
  });
  it('continues to draw procedural bodies in desktop presentation' , () => {
    const e = fixture(false); e.h.status = 'fighting';
    try { e.renderer.update(.1); expect(e.signifier).not.toHaveBeenCalled(); expect(e.models().some(mesh => mesh.count === 1 && mesh.visible)).toBe(true); }
    finally { e.renderer.dispose(); }
  });
});
