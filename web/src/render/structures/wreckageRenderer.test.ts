import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createMatch } from '../../sim/setup';
import { WreckageRenderer, wreckageFragments, wreckageStyle } from './wreckageRenderer';
import type { RenderContext } from '../context';
import type { Wreckage } from '../../sim/wreckage';
const record: Wreckage = { id: 'building:1', kind: 'workshop', pos: { x: 0, y: 0, z: 0 }, size: { x: 4, y: 5, z: 6 }, yaw: 0 };
describe('persistent wreckage', () => {
  it('is deterministic, material specific and bounded per object', () => {
    expect(wreckageFragments(record, 'a')).toEqual(wreckageFragments(record, 'a'));
    expect(wreckageFragments(record, 'a')).not.toEqual(wreckageFragments(record, 'b'));
    expect(wreckageFragments(record, 'a').length).toBeLessThanOrEqual(48);
    expect(wreckageStyle('tent')).toBe('cloth'); expect(wreckageStyle('car')).toBe('metal');
    expect(wreckageStyle('floor')).toBe('wood'); expect(wreckageStyle('rock')).toBe('stone');
    expect(wreckageFragments({...record, kind:'tent'}, 'a').some(f=>f.shape===2)).toBe(true);
  });
  it('scales with original dimensions instead of fixed rock piles', () => {
    const a = wreckageFragments(record, 'a'), b = wreckageFragments({...record,size:{x:8,y:10,z:12}},'a');
    for(let i=0;i<a.length;i++) { expect(b[i].pos.x).toBeCloseTo(a[i].pos.x*2); expect(b[i].pos.y).toBeCloseTo(a[i].pos.y*2); expect(b[i].scale.x).toBeCloseTo(a[i].scale.x*2); }
  });
  it('reconstructs prior destruction without events, no gameplay mutations, and resets cleanly', () => {
    const w = createMatch({seed:'wreck-render',difficulty:'normal',humans:[0],mode:'standard'});
    const prop = w.map.obstacles.find(o=>o.kind==='dome')!;w.destroyedScenery.add(prop.id);w.wreckage.push(record);
    const before = w.nav.version, ctx = { world:w,scene:new THREE.Scene() } as RenderContext;
    const a = new WreckageRenderer(ctx); expect(a.group.children).toHaveLength(3);
    const mesh=a.group.children[0] as THREE.InstancedMesh; expect(mesh.count).toBeGreaterThan(0);
    const matrix=Array.from(mesh.instanceMatrix.array);a.update(1);expect(Array.from(mesh.instanceMatrix.array)).toEqual(matrix);
    expect(w.nav.version).toBe(before);expect(w.drainEvents()).toEqual([]);
    w.destroyedScenery.clear();w.wreckage=[];a.update(1);expect(mesh.count).toBe(0);
    a.dispose();expect(ctx.scene.children).toHaveLength(0);
  });
});
