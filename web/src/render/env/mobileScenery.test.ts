import * as THREE from 'three';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createMatch } from '../../sim/setup';
import { normalizeMatch } from '../../sim/matchSettings';
import type { EnvContext } from './envTypes';
import { createDayState } from './timeOfDay';
import { MobilePropField, scenerySpriteKey, scenerySpriteScaleX } from './props/mobilePropField';
import { MobileLumberPiles } from './piles/mobileLumberPiles';
import { MobileEffigy } from './burn/mobileEffigy';
import { buildForest, buildForestPlacements } from './props/trees';
import { createBatches, createClutterKit, disposeClutterKit } from './props/kit';
import { buildStages, stagePresentation } from './props/stages';
import { WreckageRenderer } from '../structures/wreckageRenderer';
import { groundHeight } from '../../sim/terrain';
import { PLINTH_HEIGHT, MAST_TOP, FLAG_CONSUMED_AT, flagBurnScale } from './burn/burnTimeline';

function environment() {
  const world = createMatch({ seed: 'mobile-scenery-render', difficulty: 'normal', humans: [0], mode: 'standard' });
  world.options.match = normalizeMatch({ bossMode: false });
  const object = vi.fn(), day = createDayState();
  const env = { ctx: { world, quality: 'low', time: 0, beat: 0, scene: new THREE.Scene(), shared: { mobileSprites: { object } },
    session: { viewBlend: 0 }, camera: new THREE.PerspectiveCamera(), renderer: { getDrawingBufferSize: (v: THREE.Vector2) => v.set(1000, 700) } },
    root: new THREE.Group(), day, burn: { active: false, startedAt: Infinity, elapsed: 0, progress: 0 },
    uniforms: { uTime: { value: 0 }, uNight: { value: 1 }, uBeat: { value: 0 }, uWind: { value: new THREE.Vector2() },
      uBurn: { value: 0 }, uSunDir: { value: new THREE.Vector3(0,1,0) }, uSunColor: { value: new THREE.Color() }, uFogColor: { value: new THREE.Color() } },
    noise: new THREE.DataTexture(new Uint8Array([127,127,127,255]),1,1), fireLight: new THREE.PointLight() } as unknown as EnvContext;
  // Copy scratch arguments when submitted, exactly as the instanced sprite batch does.
  const calls: { key: string; pose: Record<string, number>; style: Record<string, unknown> }[] = [];
  object.mockImplementation((key, pose, style = {}) => calls.push({key, pose:{...pose}, style:{...style,
    ...(style.ownerColor ? {ownerColor: style.ownerColor.clone()} : {}), ...(style.tint ? {tint: style.tint.clone()} : {})}}));
  return {env, world, calls};
}
beforeEach(() => {
  const ctx = new Proxy({measureText:()=>({width:10}),createLinearGradient:()=>({addColorStop(){}})}, {get:(target,key)=>key in target ? target[key as keyof typeof target] : ()=>{}});
  vi.stubGlobal('document',{createElement:()=>({width:1,height:1,getContext:()=>ctx})});
});
afterEach(()=>vi.unstubAllGlobals());

describe('mobile scenery cutouts', () => {
  it('retains every variant, source size/color, terrain anchor and destruction without models', () => {
    const {env,world,calls}=environment(), field=new MobilePropField(env);
    const before = world.nav.version; field.update(0);
    const propCalls=calls.filter(c=>c.pose.id<=-1000000 && c.pose.id>-2000000);
    expect(propCalls).toHaveLength(world.map.obstacles.filter(o=>o.kind!=='effigy').length);
    for(const o of world.map.obstacles.filter(o=>o.kind!=='effigy')) {
      const c=propCalls.find(c=>c.pose.id===-1000000-o.id)!;
      expect(c.key).toBe(scenerySpriteKey(o));expect(c.pose.height).toBe(o.height);
      expect(c.pose.y).toBeCloseTo(groundHeight(o.x,o.z,world.map.half));
      expect((c.style.ownerColor as THREE.Color).getHex()).toBe(o.color);
    }
    const forbidden:string[]=[];env.root.traverse(o=>{if(/props-rough|tree-canopies|forest-pines|art-spirals/.test(o.name))forbidden.push(o.name);});expect(forbidden).toEqual([]);
    const removed=world.map.obstacles.find(o=>o.kind==='stage')!;world.destroyedScenery.add(removed.id);calls.length=0;field.update(0);
    expect(calls.some(c=>c.pose.id===-1000000-removed.id)).toBe(false);
    const forestCount=calls.filter(c=>c.pose.id<=-2000000).length;expect(forestCount).toBeGreaterThan(100);
    world.destroyedScenery.clear();calls.length=0;field.update(0);expect(calls.some(c=>c.pose.id===-1000000-removed.id)).toBe(true);
    expect(world.nav.version).toBe(before);field.dispose();expect(env.root.children).toHaveLength(0);
  });
  it('keeps footprint aspect separate from object height and canopy/trunk dimensions', () => {
    const {world}=environment(), car={...world.map.obstacles.find(o=>o.kind==='car')!, variant:0, hx:1.9, hz:2.25, height:1.45, yaw:0};
    expect(scenerySpriteScaleX(car,0)).toBeCloseTo(2);
    expect(scenerySpriteScaleX(car,Math.PI/2)).toBeCloseTo(1);
    expect(scenerySpriteScaleX({...car,height:2.9},0)).toBeCloseTo(1);
    const tree=world.map.obstacles.find(o=>o.kind==='tree')!;
    expect(scenerySpriteScaleX({...tree,radius:100},0)).toBe(1);
  });
  it('shares exact forest layout and stage FX placements with desktop', () => {
    const {env,world}=environment(), placements=buildForestPlacements(world.map.half,world.map.seed,'low'), desktop=buildForest(world.map.half,world.map.seed,'low');
    expect(placements).toEqual(desktop.sectors);desktop.pine.dispose();desktop.broadleaf.dispose();
    const stage=world.map.obstacles.filter(o=>o.kind==='stage'), out=createBatches('low'),kit=createClutterKit();
    const a=stagePresentation(stage,world.map.soundCamps,'low'),b=buildStages(stage,world.map.soundCamps,kit,out);
    expect(a.rigs).toEqual(b.rigs);
    for(let i=0;i<a.signs.length;i++)for(let k=0;k<4;k++)expect(a.signs[i].corners[k].distanceTo(b.signs[i].corners[k])).toBeLessThan(1e-12);
    disposeClutterKit(kit);for(const batch of [out.solid,out.gloss,out.low,out.cloth,out.lights])batch.build()?.dispose();out.strings.build().dispose();
    env.noise.dispose();
  });
  it('shrinks and removes all three resource pile kinds with authoritative stock', () => {
    const {env,world,calls}=environment();world.piles.clear();
    for(const [i,kind] of (['pallets','lumber','moop'] as const).entries())world.piles.set(i,{id:i,type:'pile',kind,pos:{x:i*2,z:0},lumber:100,max:100});
    const piles=new MobileLumberPiles(env);piles.update(0);expect(calls.map(c=>c.key)).toEqual(['pile:pallets','pile:lumber','pile:moop']);
    const full=calls[0].pose.height;world.piles.get(0)!.lumber=20;world.piles.get(1)!.lumber=0;world.piles.delete(2);calls.length=0;piles.update(0);
    expect(calls).toHaveLength(1);expect(calls[0].pose.height).toBeLessThan(full);expect(env.root.children).toHaveLength(0);piles.dispose();
  });
  it('renders durable material-specific wrecks on late joins and removes them on reset', () => {
    const {env,world,calls}=environment();world.wreckage=[{id:'test',kind:'wall',pos:{x:0,y:3,z:0},size:{x:5,y:3,z:.4},yaw:.7}];
    const car=world.map.obstacles.find(o=>o.kind==='car')!;world.destroyedScenery.add(car.id);
    const renderer=new WreckageRenderer(env.ctx);expect(renderer.group.children).toHaveLength(0);expect(calls.map(c=>c.key)).toEqual(['wreckage:wood','wreckage:metal']);expect(calls[0].pose.y).toBeCloseTo(groundHeight(0,0,world.map.half));
    calls.length=0;world.wreckage=[];world.destroyedScenery.clear();renderer.update(0);expect(calls).toHaveLength(0);renderer.dispose();
  });
  it('keeps fire FX and independent flag heat/shrink without rendering effigy models', () => {
    const {env,calls}=environment(), effigy=new MobileEffigy(env);effigy.update(0);
    expect(calls.map(c=>c.key)).toEqual(['effigy:plinth','effigy:scaffold','effigy:flag']);
    expect(calls.find(c=>c.key==='effigy:flag')!.pose.moving).toBe(true);
    expect(calls.find(c=>c.key==='effigy:scaffold')!.pose.moving).toBe(false);
    env.uniforms.uWind.value.set(0,1);calls.length=0;effigy.update(1);
    expect(calls.find(c=>c.key==='effigy:flag')!.pose.yaw).toBeLessThan(0);
    expect(calls.find(c=>c.key==='effigy:scaffold')!.pose.yaw).toBe(0);
    expect(env.root.getObjectByName('effigy-lattice')).toBeUndefined();expect(env.root.getObjectByName('effigy-mast')).toBeUndefined();
    env.burn.active=true;env.burn.elapsed=120;calls.length=0;effigy.update(0);
    expect(calls.find(c=>c.key==='effigy:flag')!.pose.height).toBeCloseTo((MAST_TOP-PLINTH_HEIGHT)*flagBurnScale(120));
    expect(calls.find(c=>c.key==='effigy:scaffold')!.style.cropTop).toBeGreaterThan(0);
    env.burn.elapsed=FLAG_CONSUMED_AT+1;calls.length=0;effigy.update(0);expect(calls.map(c=>c.key)).toEqual(['effigy:plinth']);
    effigy.dispose();expect(env.root.children).toHaveLength(0);
  });
});
