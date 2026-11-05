import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Session } from '../../game/session';
import { ABILITY, RITUAL, MAP_HALF } from '../../sim/constants';
import { createMatch } from '../../sim/setup';
import { normalizeMatch } from '../../sim/matchSettings';
import { spawnZone } from '../../sim/factory';
import { MOBILE_SPRITE_ORDER } from '../actors/mobileSprites';
import { mobilePowerPreview, RitualZoneFx } from './ritualZones';
function fixture(rts = true) {
  const w=createMatch({seed:'power-ink-recovery',humans:[0],rtsFactions:rts?[0]:[],mode:'standard',difficulty:'normal',match:normalizeMatch({active:[0],startingSignifiers:0})});
  w.time=100;const s=new Session();s.screen='playing';s.view='command';s.hover.point={x:12,y:0,z:18};return{w,s};
}
const find=(fx:RitualZoneFx,name:string)=>fx.group.getObjectByName(name) as THREE.Mesh<THREE.PlaneGeometry,THREE.ShaderMaterial>;
describe('power zone ink',()=>{
  it('renders four distinct flat ground styles behind sprites without replacing legacy effects',()=>{
    const {w,s}=fixture(),fx=new RitualZoneFx(true);
    for(const kind of ['redtape','patchwork','omegaCharge','alignment','stabilize','beacon','omega','phason'] as const)spawnZone(w,kind,0,{x:5,z:8},14,12,1);
    const before=JSON.stringify([...w.zones.values()]);fx.update(w,s,10000);
    const meshes=fx.group.children.filter(m=>m.name.startsWith('power-zone-')) as ReturnType<typeof find>[];
    expect(meshes).toHaveLength(4);expect(meshes.map(m=>m.material.uniforms.uStyle.value)).toEqual([0,1,2,3]);
    for(const m of meshes){expect(m.material.transparent).toBe(false);expect(m.material.blending).toBe(THREE.CustomBlending);expect(m.material.depthTest).toBe(true);expect(m.material.depthWrite).toBe(false);expect(m.renderOrder).toBeLessThan(MOBILE_SPRITE_ORDER);expect(m.material.uniforms.uRadius.value).toBe(14);expect(m.material.uniforms.uCenter.value.toArray()).toEqual([5,8]);expect(m.material.vertexShader).toContain('groundHeight(vWorld,uMapHalf)+0.12');expect(m.material.fragmentShader).toContain('max(abs(vWorld.x),abs(vWorld.y))>uMapHalf');expect(m.geometry.getAttribute('position').count).toBe(1089);}
    expect(JSON.stringify([...w.zones.values()])).toBe(before);fx.dispose();
  });
  it('uses simulation time for charge/alignment and removes cancellation without inferring an explosion',()=>{
    const {w,s}=fixture(),fx=new RitualZoneFx(true),z=spawnZone(w,'omegaCharge',0,{x:0,z:0},12,2,1),a=spawnZone(w,'alignment',0,{x:0,z:0},3,4,3);
    fx.update(w,s,10000);const m=find(fx,`power-zone-omegaCharge-${z.id}`),am=find(fx,`power-zone-alignment-${a.id}`),buffer=m.geometry.getAttribute('position').array;
    fx.update(w,s,20000);expect(m.material.uniforms.uProgress.value).toBe(0);w.time++;fx.update(w,s,0);expect(m.material.uniforms.uProgress.value).toBe(.5);expect(am.material.uniforms.uProgress.value).toBe(.25);expect(m.geometry.getAttribute('position').array).toBe(buffer);
    const dispose=vi.spyOn(m.material,'dispose');w.zones.delete(z.id);fx.update(w,s,0);expect(dispose).toHaveBeenCalledOnce();expect(find(fx,m.name)).toBeUndefined();w.time+=4;fx.update(w,s,0);expect(fx.group.visible).toBe(false);fx.dispose();
  });
  it('distinguishes warning from active Mandala, updates owner tint and preserves desktop transparency',()=>{
    const {w,s}=fixture(),fx=new RitualZoneFx(false),z=spawnZone(w,'redtape',0,{x:0,z:0},14,13,1),a=spawnZone(w,'alignment',0,{x:0,z:0},3,4,3);
    fx.update(w,s,0);const m=find(fx,`power-zone-redtape-${z.id}`);expect(m.material.transparent).toBe(true);expect(m.material.uniforms.uWarning.value).toBe(1);
    w.time+=RITUAL.redtape.warning;w.factions[0].color=0x123456;fx.update(w,s,0);expect(m.material.uniforms.uWarning.value).toBe(0);expect(find(fx,`power-zone-alignment-${a.id}`).material.uniforms.uTint.value).toEqual(new THREE.Color(0x123456));
    w.phase='ended';fx.update(w,s,0);expect(fx.group.visible).toBe(false);fx.dispose();
  });
  it('reuses geometry and disposes per-zone materials exactly once',()=>{
    const {w,s}=fixture(),fx=new RitualZoneFx(true),p=find(fx,'mobile-power-radius-preview'),gd=vi.spyOn(p.geometry,'dispose');
    for(let i=0;i<4;i++){const z=spawnZone(w,'patchwork',0,{x:i,z:i},16,15,1);fx.update(w,s,0);const m=find(fx,`power-zone-patchwork-${z.id}`),md=vi.spyOn(m.material,'dispose');expect(m.geometry).toBe(p.geometry);w.zones.delete(z.id);fx.update(w,s,0);expect(md).toHaveBeenCalledOnce();}
    expect(gd).not.toHaveBeenCalled();fx.dispose();expect(gd).toHaveBeenCalledOnce();expect(fx.group.children).toHaveLength(0);
  });
});
describe('mobile power target guide',()=>{
  it('tracks exact gameplay radii and current target without a selected unit',()=>{
    const {w,s}=fixture(),fx=new RitualZoneFx(true);expect(s.selection.size).toBe(0);
    for(const kind of ['redtape','patchwork'] as const){s.mobileRitual=kind;expect(mobilePowerPreview(w,s,true)).toMatchObject({x:12,z:18,radius:RITUAL[kind].radius});}s.mobileRitual=null;
    for(const kind of ['omega','stabilize'] as const)for(const level of [1,2,3]){s.mobileAbility=kind;w.factions[0].chakras[kind==='omega'?'finial':'canton']=level;expect(mobilePowerPreview(w,s,true)?.radius).toBe(ABILITY[kind].radius[level-1]);}
    fx.update(w,s,0);const p=find(fx,'mobile-power-radius-preview');expect(p.visible).toBe(true);expect(p.material.uniforms.uRadius.value).toBe(24);s.mobileAbility=null;fx.update(w,s,0);expect(p.visible).toBe(false);fx.dispose();
  });
  it('matches Regular self-centered Omega/March simulation semantics',()=>{
    const {w,s}=fixture(false);w.avatarOf(0)!.pos={x:20,y:0,z:30};w.factions[0].chakras.finial=1;w.factions[0].chakras.fly=1;
    for(const kind of ['omega','march'] as const){s.mobileAbility=kind;expect(mobilePowerPreview(w,s,true)).toMatchObject({x:20,z:30});}
  });
  it('hides for overlays, cancellation, invalid point, spectators and nonmobile or ended contexts',()=>{
    const {w,s}=fixture();s.mobileRitual='redtape';const hidden=()=>expect(mobilePowerPreview(w,s,true)).toBeNull();
    expect(mobilePowerPreview(w,s,false)).toBeNull();s.mobileMenu='powers';hidden();s.mobileMenu=null;s.campChoiceOpen=true;hidden();s.campChoiceOpen=false;s.panels.help=true;hidden();s.panels.help=false;
    s.spectator=true;hidden();s.spectator=false;s.screen='paused';hidden();s.screen='playing';
    for(const p of [null,{x:NaN,y:0,z:0},{x:MAP_HALF+1,y:0,z:0}]){s.hover.point=p;hidden();}s.hover.point={x:0,y:0,z:0};w.phase='ended';hidden();
  });
});
