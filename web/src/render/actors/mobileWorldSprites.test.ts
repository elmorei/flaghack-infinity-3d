import * as THREE from 'three';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {RenderContext} from '../context';
import atlas from './mobileSpriteAtlas.json';
import actions from './mobileSpriteActions.json';
import {MobileSprites, type SpritePose} from './mobileSprites';

vi.mock('./mobileSpriteBuildings.json', () => ({default:{pages:[],clips:{}}}));
vi.mock('./mobileSpriteWorld.json', () => {
  const clip = {page:0,x:0,y:0,w:128,h:128,cellWidth:32,cellHeight:32,columns:4,rows:4,anchor:[16,30],
    footYByCell:Array.from({length:4},()=>[30,30,30,30]),heightPixels:28,frameDurationMs:140,loop:true,
    directionRows:{front:0,right:1,away:2,left:3}};
  return {default:{pages:[{image:'/assets/mobile-sprites/test-world.webp',width:128,height:128},
    {image:'/assets/mobile-sprites/test-world-seated.webp',width:128,height:128}],clips:{
    'scenery:tent:0:idle':{...clip}, 'building:hearth:idle':{...clip},
    'building:hearth:seated':{...clip,page:1}, 'effigy:scaffold:idle':{...clip,sourceCellWidth:64},
  }}};
});
const pending:{load:()=>void;fail:()=>void}[]=[];
const all:MobileSprites[]=[];
const pose:SpritePose={id:0,x:2,y:1,z:3,yaw:0,height:2.8,moving:true};
beforeEach(()=>{
  pending.length=0;
  vi.spyOn(THREE.TextureLoader.prototype,'load').mockImplementation((url,onLoad,_progress,onError)=>{
    const base=url.endsWith(atlas.image),page=actions.pages.find(p=>url.endsWith(p.image));
    const texture=new THREE.Texture<HTMLImageElement>(); texture.image={width:base?atlas.width:page?.width??128,height:base?atlas.height:page?.height??128} as HTMLImageElement;
    if(url.includes('test-world'))pending.push({load:()=>onLoad?.(texture),fail:()=>onError?.(new Error('Unavailable'))});else onLoad?.(texture);
    return texture;
  });
});
afterEach(()=>{all.splice(0).forEach(s=>s.dispose());vi.restoreAllMocks();});
function setup(ready=true){
  const camera=new THREE.OrthographicCamera(-10,10,10,-10,.1,100);camera.position.set(2,8,15);camera.lookAt(2,1,3);
  const ctx={scene:new THREE.Scene(),camera,renderer:{capabilities:{maxTextureSize:4096}},time:.29} as unknown as RenderContext;
  const sprites=new MobileSprites(ctx);all.push(sprites);if(ready)pending.forEach(p=>p.load());sprites.begin();return{ctx,sprites};
}
function active(s:MobileSprites){s.end();return s.meshes.find(m=>m.visible)!;}
describe('world sprite batching',()=>{
  it('selects all four directions and keeps each ground contact fixed',()=>{
    const {sprites}=setup();
    for(const [i,direction]of ['front','left','away','right'].entries()){
      sprites.begin();sprites.object('scenery:tent:0',{...pose,yaw:i*Math.PI/2});const mesh=active(sprites);
      expect(sprites.samples[0]).toMatchObject({direction,clip:'idle',frame:2});
      const size=mesh.geometry.getAttribute('aSize'),offset=mesh.geometry.getAttribute('aOffset'),center=mesh.geometry.getAttribute('aCenter');
      expect((1-30/32)*size.getY(0)+offset.getY(0)).toBeCloseTo(0,6);
      expect([center.getX(0),center.getY(0),center.getZ(0)]).toEqual([2,1,3]);
    }
  });
  it('forwards owner mask, continuous highlight, damage, construction and ghost cues',()=>{
    const {sprites}=setup(),ownerColor=new THREE.Color(0xe43a52);
    sprites.building('hearth',pose,{ownerColor,buildProgress:.5,damage:.4,highlight:.5,rotation:.4,scaleX:1.5});
    const mesh=active(sprites),g=mesh.geometry;
    expect(g.getAttribute('aOwner').getX(0)).toBeCloseTo(ownerColor.r);expect(g.getAttribute('aOwner').getW(0)).toBe(1);
    expect(g.getAttribute('aWorld').getX(0)).toBeCloseTo(1-30/32+28/32*.5);
    expect(g.getAttribute('aWorld').getZ(0)).toBe(0);
    expect(g.getAttribute('aTint').getX(0)).toBeCloseTo((1-.4*.32)*1.1);
    expect(g.getAttribute('aRotation').getX(0)).toBeCloseTo(.4);
    expect(g.getAttribute('aSize').getX(0)).toBeCloseTo(32*pose.height/28*1.5);
    expect(mesh.material.depthTest).toBe(true);expect(mesh.material.depthWrite).toBe(true);
    sprites.begin();sprites.building('hearth',pose,{ownerColor,ghost:true,buildProgress:0});
    expect(active(sprites).geometry.getAttribute('aWorld').getZ(0)).toBe(1);
  });
  it('crops a burning scaffold from its top without moving the bottom or UVs',()=>{
    const {sprites}=setup();sprites.object('effigy:scaffold',pose,{frame:3,cropTop:.5,opacity:.4,width:6,heatColor:new THREE.Color(0xffffff)});
    const g=active(sprites).geometry;
    expect(sprites.samples[0].frame).toBe(3);
    expect(g.getAttribute('aWorld').getW(0)).toBeCloseTo(1-30/32+28/32*.5);
    expect(g.getAttribute('aWorld').getY(0)).toBeCloseTo(.4);
    expect(g.getAttribute('aSize').getX(0)).toBe(3); // Cropped half-width keeps original capture-window scale.
    expect(g.getAttribute('aHeat').getW(0)).toBe(1); expect(g.getAttribute('aHeat').getX(0)).toBe(1);
    expect(g.getAttribute('aRect').getX(0)).toBe(.75);
    expect(g.getAttribute('aCenter').getY(0)).toBe(pose.y);
  });
  it('freezes disabled/static art and defaults missing states',()=>{
    const {sprites}=setup();sprites.building('hearth',{...pose,moving:false},{state:'future-state',disabled:true});
    const g=active(sprites).geometry;
    expect(sprites.samples[0]).toMatchObject({clip:'idle',requestedClip:'future-state',frame:0});
    expect(sprites.fallbackCount).toBe(1);expect(g.getAttribute('aTint').getX(0)).toBeCloseTo(.38);
  });
  it('shares the live GCC map texture and uses the exact heading without extra image allocation',()=>{
    const {sprites,ctx}=setup(),texture=new THREE.Texture();ctx.shared={gccTableTexture:texture};
    sprites.building('hearth',pose,{tableYaw:Math.PI/2});const mesh=active(sprites),table=mesh.geometry.getAttribute('aTable');
    expect(table.getX(0)).toBeCloseTo(0);expect(table.getY(0)).toBeCloseTo(1);
    expect(mesh.material.uniforms.uTableMap.value).toBe(texture);expect(mesh.material.uniforms.uTableReady.value).toBe(1);
    expect(mesh.material.uniforms.uTableSpan.value).toBe(1.3);
    expect(mesh.material.fragmentShader).toContain('abs(c.a-160./255.)');
    expect(mesh.material.fragmentShader).toContain('local.x*vTable.x+local.y*vTable.y');
    ctx.shared.gccTableTexture=undefined;active(sprites);expect(mesh.material.uniforms.uTableReady.value).toBe(0);
    const dispose=vi.spyOn(texture,'dispose');sprites.dispose();expect(dispose).not.toHaveBeenCalled();
  });
  it('never substitutes the tall altar for missing occupied-hearth art',()=>{
    const {sprites}=setup(false);pending[0].load();pending[1].fail();
    sprites.building('hearth',pose,{state:'seated'});
    expect(active(sprites).name).toBe('mobile-sprite-placeholders');
    expect(sprites.samples[0]).toMatchObject({placeholder:true,requestedClip:'seated'});
    expect(sprites.worldAtlasError).toBe(true);
  });
  it('keeps missing and failed scenery as sprites and updates reused GPU styles',()=>{
    const {sprites}=setup(false);pending.forEach(p=>p.fail());
    expect(sprites.object('scenery:unknown:0',pose,{ghost:true,ownerColor:new THREE.Color(0xff0000)})).toBe(true);
    const mesh=active(sprites),style=mesh.geometry.getAttribute('aWorld') as THREE.InstancedBufferAttribute;
    expect(sprites.samples[0].placeholder).toBe(true);expect(style.version).toBeGreaterThan(0);
    sprites.begin();sprites.object('scenery:unknown:0',pose);active(sprites);
    expect(style.getZ(0)).toBe(0);expect(style.getY(0)).toBe(1);
    expect(style.updateRanges).toEqual([{start:0,count:4}]);
  });
});
