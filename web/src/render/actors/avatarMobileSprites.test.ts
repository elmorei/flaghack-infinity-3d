import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createMatch } from '../../sim/setup';
import type { RenderContext } from '../context';
import { AvatarRenderer } from './avatarRenderer';
import type { ActorView } from './lod';
import type { FlagRenderer } from './flagRenderer';
import type { UnitRings } from './overlays';
import type { Nameplates } from './nameplates';

describe('avatar mobile sprite integration', () => {
  it('keeps starter carried flags as 3D equipment and falls back during swings', () => {
    const world = createMatch({seed: 'mobile-avatar-equipment', difficulty: 'normal', humans: [0,1,2,3], mode: 'standard'});
    const cast = vi.fn((_index: number, _pose: unknown, supported: boolean) => supported);
    const ctx = {world, scene: new THREE.Scene(), shared: {mobileSprites: {cast}}, time: 5, beat: 0,
      session: {playerFaction: 0, spectator: false, viewBlend: 1}} as unknown as RenderContext;
    const pushMatrix = vi.fn();
    const flags = {pushMatrix, ribbonColor: () => new THREE.Color(0xffff00), markPulling: vi.fn()} as unknown as FlagRenderer;
    const renderer = new AvatarRenderer(ctx, {casts: () => false} as unknown as ActorView, flags,
      {push: vi.fn()} as unknown as UnitRings, {has: () => false} as unknown as Nameplates, new Map());
    const avatars = [...world.avatars.values()];
    const carried = avatars.reduce((n, a) => n + a.carried.length, 0);
    expect(carried).toBeGreaterThan(0);
    const before = JSON.stringify(avatars);
    renderer.update(.1);
    expect(cast.mock.calls).toHaveLength(avatars.length);
    expect(cast.mock.calls.every(call => call[2])).toBe(true);
    expect(pushMatrix).toHaveBeenCalledTimes(carried);
    for (const a of avatars) expect(ctx.scene.getObjectByName(`actors-avatar-${a.faction}`)?.visible).toBe(false);
    expect(JSON.stringify(avatars)).toBe(before);
    const a = avatars[0];
    renderer.onEvent({t: 'swing', by: a.id} as Parameters<AvatarRenderer['onEvent']>[0]);
    ctx.time += .1; pushMatrix.mockClear(); renderer.update(.1);
    expect(cast.mock.calls.filter(call => call[0] === a.faction).at(-1)?.[2]).toBe(false);
    expect(ctx.scene.getObjectByName(`actors-avatar-${a.faction}`)?.visible).toBe(true);
    expect(pushMatrix).toHaveBeenCalledTimes(carried);
    renderer.dispose();
  });
});
