import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createMatch } from '../../sim/setup';
import type { HippieStatus } from '../../sim/types';
import type { RenderContext } from '../context';
import { HippieRenderer } from './hippieRenderer';
import { HIPPIE_SKIN_TONES, HL, hippieSkinIndex, patchHippieMaterial } from './hippieModel';
import { hash01b } from './util';
import type { FlagRenderer } from './flagRenderer';
import { PLACE, type ActorView } from './lod';
import type { StatusIcons, UnitRings } from './overlays';
import type { SpritePose } from './mobileSprites';

// These are the six existing procedural-model colors, not a new sprite palette.
const ORIGINAL_PALETTE = [0xf6d2b5, 0xeab68f, 0xc98e63, 0x9c6a45, 0x6e4a31, 0x4a3122];
const modelIndex = (look: number) => Math.trunc(Math.fround(hash01b(look, 2)) * 5.999);
const representativeSeeds = Array.from({length: 6}, (_, tone) => {
  for(let seed=0;seed<10000;seed++)if(modelIndex(seed)===tone)return seed;
  throw new Error('Missing original model palette identity '+tone);
});

function fixture(mobile: boolean, seed: number) {
  const world=createMatch({seed:'skin-identity-parity',difficulty:'normal',humans:[0,1,2,3],mode:'standard'});
  const h=[...world.hippies.values()].find(h=>h.id!==world.frickFrack?.wizardId)!;
  world.hippies.clear();world.hippies.set(h.id,h);h.look=seed;h.carryingFlag=-1;h.carryingLumber=0;h.effects=[];h.beacon=false;
  const signifier=vi.fn((_pose:SpritePose,..._args:unknown[])=>true);
  const ctx={world,scene:new THREE.Scene(),shared:{groundOffset:()=>0,...(mobile?{mobileSprites:{signifier,signifierNeedsFlag:()=>false}}:{})},time:5,beat:0,
    session:{playerFaction:0,hover:{entity:-1},selection:new Set()}} as unknown as RenderContext;
  const renderer=new HippieRenderer(ctx,{place:()=>PLACE.detailed,shadows:false} as unknown as ActorView,
    {pushMatrix:vi.fn(),ribbonColor:()=>new THREE.Color(0xffffff),markPulling:vi.fn()} as unknown as FlagRenderer,
    {push:vi.fn()} as unknown as UnitRings,{push:vi.fn()} as unknown as StatusIcons,new Map());
  return {world,h,ctx,renderer,signifier};
}

describe('existing model skin palette and sprite identity parity',()=>{
  it('retains all six original sRGB model colors and the actual desktop shader palette',()=>{
    expect([...HIPPIE_SKIN_TONES]).toEqual(ORIGINAL_PALETTE);
    const material=new THREE.MeshStandardMaterial();
    patchHippieMaterial(material,{uTime:{value:0},uFactionGlow:{value:0}},false);
    const shader={uniforms:{},vertexShader:'#include <common>\n#include <begin_vertex>\n#include <project_vertex>',fragmentShader:'#include <common>\n#include <color_fragment>'};
    material.onBeforeCompile(shader as never,{} as THREE.WebGLRenderer);
    const uniforms=shader.uniforms as {uSkin:{value:THREE.Color[]}};
    expect(uniforms.uSkin.value.map(color=>color.getHex())).toEqual(ORIGINAL_PALETTE);
    expect(shader.fragmentShader).toMatch(/uSkin\[int\(vLookA\.y \* 5\.999\)\]/);
    material.dispose();
  });

  it('uses the persisted look identity and the model’s exact six-way selection',()=>{
    const seen=new Set<number>();
    for(let seed=0;seed<100000;seed+=17){
      const uniformValue=Math.fround(hash01b(seed,2)),expected=modelIndex(seed);
      expect(hippieSkinIndex(uniformValue)).toBe(expected);seen.add(expected);
      expect(hippieSkinIndex(Math.fround(hash01b(JSON.parse(JSON.stringify(seed)),2)))).toBe(expected);
    }
    expect([...seen].sort()).toEqual([0,1,2,3,4,5]);
    expect(hippieSkinIndex(0)).toBe(0);expect(hippieSkinIndex(1)).toBe(5);
    for(let band=1;band<6;band++)for(const delta of [-1e-5,1e-5]){
      const value=Math.fround(band/5.999+delta);
      expect(hippieSkinIndex(value)).toBe(Math.trunc(value*5.999));
    }
  });

  for(const [tone,seed] of representativeSeeds.entries())it('keeps model tone '+tone+' through every work/combat/action state without mutating identity',()=>{
    const mobile=fixture(true,seed),desktop=fixture(false,seed);
    try{
      desktop.renderer.update(.1);
      const mesh=desktop.ctx.scene.children.find(o=>o instanceof THREE.InstancedMesh&&o.count>0) as THREE.InstancedMesh;
      expect(mesh).toBeDefined();
      const modelLook=mesh.geometry.getAttribute('aLook').array;
      expect(Math.trunc(modelLook[HL.skin]*5.999)).toBe(tone);
      expect(modelLook[HL.skin]).toBe(Math.fround(hash01b(seed,2)));
      const states=['idle','responding','hauling','chopping','planting','pulling','building','repairing','fighting','tearing','drumming','defending','distracted','ko'] as HippieStatus[];
      for(const status of states){
        mobile.h.status=status;const before=JSON.stringify(mobile.h);mobile.ctx.time+=.1;mobile.renderer.update(.1);
        expect(mobile.signifier.mock.lastCall?.[0].skinTone).toBe(tone);
        expect(JSON.stringify(mobile.h)).toBe(before);
      }
      mobile.h.status='idle';mobile.h.airborne={y:2,vy:1};mobile.renderer.update(.1);
      expect(mobile.signifier.mock.lastCall?.[0].skinTone).toBe(tone);
      mobile.h.airborne=undefined;
      for(const kind of ['stun','knockback','wobble','psychosis'] as const){
        mobile.h.effects=[{kind,until:100,mag:1,source:-1}];mobile.renderer.update(.1);
        expect(mobile.signifier.mock.lastCall?.[0].skinTone).toBe(tone);
      }
      expect(mobile.h.look).toBe(seed);expect(desktop.h.look).toBe(seed);
      expect(desktop.signifier).not.toHaveBeenCalled();
    } finally {mobile.renderer.dispose();desktop.renderer.dispose();}
  });
});
