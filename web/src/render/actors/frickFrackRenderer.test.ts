import * as THREE from 'three';
import {describe, expect, it, vi} from 'vitest';
import type {RenderContext} from '../context';
import {buildFrickFrackWizard, cheatCardLabel, FrickFrackRenderer, WIZARD_HEIGHT} from './frickFrackRenderer';

function fixture() {
  const h = {id: 42, pos: {x: 10, z: 20}, facing: .8, koUntil: 0, status: 'idle'};
  const world = {frickFrack: {wizardId: h.id, drops: [] as any[]}, hippies: new Map([[h.id, h]]), time: 2, collision: {groundHeight: () => 3}};
  const ctx = {world, time: 4, shared: {unitAnchors: new Map()}, scene: new THREE.Scene()} as unknown as RenderContext;
  return {ctx, world, h, renderer: new FrickFrackRenderer(ctx)};
}

describe('Frick-frack actors', () => {
  it('builds a recognizable pointed-hat wizard without crowd instances or external assets', () => {
    const model = buildFrickFrackWizard();
    expect(model.children).toHaveLength(6);
    for (const name of ['wizard-purple-robes-and-hat', 'wizard-silver-beard', 'wizard-gold-stars', 'wizard-staff']) expect(model.getObjectByName(name)).toBeTruthy();
    const bounds = new THREE.Box3().setFromObject(model);
    expect(bounds.max.y).toBeGreaterThan(2.5); expect(bounds.max.y).toBeLessThan(WIZARD_HEIGHT + .1);
    expect(bounds.min.y).toBeCloseTo(.01, 1);
    expect((model.getObjectByName('wizard-purple-robes-and-hat') as THREE.Mesh).geometry.getAttribute('position').count).toBeGreaterThan(100);
  });
  it('uses rank and suit instead of ambiguous card values', () => {
    expect(cheatCardLabel(1, 0)).toBe('A♠'); expect(cheatCardLabel(10, 1)).toBe('10♥'); expect(cheatCardLabel(13, 3)).toBe('K♣');
  });
  it('follows the unique entity and its ground height without changing simulation data', () => {
    const e = fixture(); const before = JSON.stringify(e.h); e.renderer.update(.1);
    expect(e.renderer.wizard.visible).toBe(true); expect(e.renderer.wizard.position.toArray()).toEqual([10, 3, 20]);
    expect(e.ctx.shared.unitAnchors?.has(42)).toBe(true); expect(JSON.stringify(e.h)).toBe(before);
    e.h.pos = {x: 30, z: 40}; e.renderer.update(.1); expect(e.renderer.wizard.position.toArray()).toEqual([30, 3, 40]);
    e.world.hippies.clear(); e.renderer.update(.1); expect(e.renderer.wizard.visible).toBe(false); expect(e.ctx.shared.unitAnchors?.has(42)).toBe(false);
    e.renderer.dispose(); expect(e.ctx.scene.children).toHaveLength(0);
  });
  it('reconstructs pickup faces, removes collected drops, and disposes materials', () => {
    const e = fixture(); e.world.frickFrack.drops.push({id: 91, card: {id: 1, rank: 12, suit: 2}, pos: {x: 7, z: 8}, createdAt: 0});
    const before = JSON.stringify(e.world.frickFrack); e.renderer.update(.1);
    const card = e.renderer.group.getObjectByName('frick-frack-card-91') as THREE.Mesh;
    expect(card).toBeTruthy(); expect(card.userData.cardLabel).toBe('Q♦'); expect(card.position.x).toBe(7); expect(card.position.z).toBe(8);
    expect(card.position.y).toBeGreaterThan(3); expect(JSON.stringify(e.world.frickFrack)).toBe(before);
    const dispose = vi.spyOn(card.material as THREE.Material, 'dispose');
    e.world.frickFrack.drops.length = 0; e.renderer.update(.1); expect(e.renderer.group.getObjectByName(card.name)).toBeUndefined(); expect(dispose).toHaveBeenCalledOnce();
    e.renderer.dispose(); expect(e.ctx.scene.children).toHaveLength(0);
  });
  it('poses the wizard down during KO and restores it after recovery', () => {
    const e = fixture(); e.h.koUntil = 5; e.renderer.update(.5); expect(e.renderer.wizard.rotation.x).toBeLessThan(-1.5);
    e.world.time = 6; e.renderer.update(.5); expect(e.renderer.wizard.rotation.x).toBeGreaterThan(-.02); e.renderer.dispose();
  });
});
