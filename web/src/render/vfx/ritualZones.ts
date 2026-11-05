/** Flat terrain-following power ink. Authoritative zone state controls warning/progress;
 * no simulation mutation, inferred explosion or actor-model fallback. */
import * as THREE from 'three';
import { isMobileCommandLayout } from '../../game/mobileTouch';
import type { Session } from '../../game/session';
import { ABILITY, MAP_HALF, RITUAL } from '../../sim/constants';
import { ABILITY_CHAKRA } from '../../sim/systems/abilities';
import { TERRAIN_GLSL } from '../../sim/terrain';
import type { Zone, ZoneKind } from '../../sim/types';
import type { World } from '../../sim/world';
import { fxMaterial, FOG_FRAG_GLSL, OUTPUT_GLSL } from './glsl';
import { MOBILE_SPRITE_ORDER } from '../actors/mobileSprites';

const STYLES: Partial<Record<ZoneKind, number>> = {redtape: 0, patchwork: 1, omegaCharge: 2, alignment: 3};
const TINT = {redtape: 0xff4a51, patchwork: 0x67ffd1, omegaCharge: 0xffbd42};
type Ink = THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
export function mobilePowerPreview(w: World, s: Session, mobile: boolean) {
  if (!mobile || w.phase !== 'playing' || s.screen !== 'playing' || s.view !== 'command' || s.spectator || s.campChoiceOpen || s.mobileMenu !== null || Object.values(s.panels).some(Boolean)) return null;
  const f = w.factions[s.playerFaction];
  const self = f?.controlMode !== 'rts' && (s.mobileAbility === 'march' || s.mobileAbility === 'omega');
  const p = self ? w.avatarOf(s.playerFaction)?.pos : s.hover.point;
  if (!f?.alive || !p || !Number.isFinite(p.x) || !Number.isFinite(p.z) || Math.abs(p.x) > MAP_HALF || Math.abs(p.z) > MAP_HALF) return null;
  if (s.mobileRitual) return {x: p.x, z: p.z, radius: RITUAL[s.mobileRitual].radius, color: TINT[s.mobileRitual]};
  const ability = s.mobileAbility; if (!ability) return null;
  const level = Math.min(3, f.chakras[ABILITY_CHAKRA[ability]]); if (level < 1) return null;
  const radius = ability === 'march' ? ABILITY.march.radius : Math.max(2.5, ABILITY[ability].radius[level - 1]);
  return {x: p.x, z: p.z, radius, color: ability === 'omega' ? TINT.omegaCharge : f.color};
}
const VERT = `
uniform vec2 uCenter; uniform float uRadius; uniform float uMapHalf;
varying vec2 vLocal; varying vec2 vWorld;
#include <fog_pars_vertex>
${TERRAIN_GLSL}
void main(){
  vLocal=position.xz;vWorld=uCenter+vLocal*uRadius;
  vec3 wp=vec3(vWorld.x,groundHeight(vWorld,uMapHalf)+0.12,vWorld.y);
  vec4 mvPosition=viewMatrix*vec4(wp,1.0);gl_Position=projectionMatrix*mvPosition;
  #include <fog_vertex>
}`;
const FRAG = `
uniform float uMapHalf;uniform float uStyle;uniform float uProgress;uniform float uWarning;uniform float uFade;uniform float uTime;uniform vec3 uTint;
varying vec2 vLocal;varying vec2 vWorld;
#include <fog_pars_fragment>
float band(float x,float at,float width,float aa){return 1.0-smoothstep(width,width+aa,abs(x-at));}
void main(){
  float r=length(vLocal);if(r>1.0||max(abs(vWorld.x),abs(vWorld.y))>uMapHalf)discard;
  float aa=max(fwidth(r)*1.3,0.003),a=fract(atan(vLocal.y,vLocal.x)/6.28318530718+1.0);
  float edge=band(r,0.99,0.01,aa),ink=0.0,wash=0.0;
  if(uStyle<0.5){
    float stripe=step(0.48,fract((vLocal.x+vLocal.y)*17.0));
    ink=max(edge*step(0.22,fract(a*32.0-uTime*0.18)),band(r,0.91,0.055,aa)*stripe*mix(0.95,0.35,uWarning));wash=0.035*(1.0-uWarning)+0.015;
  }else if(uStyle<1.5){
    vec2 grid=abs(fract(vWorld*0.23)-0.5),fw=max(fwidth(vWorld*0.23),vec2(0.006));
    float seam=max(1.0-smoothstep(0.012,0.012+fw.x,grid.x),1.0-smoothstep(0.012,0.012+fw.y,grid.y));
    ink=max(edge*step(0.25,fract(a*40.0)),seam*step(0.5,fract((vWorld.x+vWorld.y)*1.1))*0.45);wash=0.035+0.018*(0.5+0.5*sin(uTime*2.5));
  }else if(uStyle<2.5){
    ink=max(edge,max(band(r,mix(0.94,0.12,uProgress),0.018,aa)*0.85,step(a,uProgress)*band(r,0.90,0.018,aa)));wash=0.035+0.07*uProgress;
  }else if(uStyle<3.5){
    ink=max(edge*step(a,uProgress),band(r,0.73,0.025,aa)*step(0.3,fract(a*4.0-uTime*0.16)));
    ink=max(ink,band(r,0.46,0.016,aa)*step(0.45,fract(a*6.0+uTime*0.12)));wash=0.04;
  }else{ink=max(edge*step(0.24,fract(a*32.0)),band(r,0.89,0.006,aa)*0.35);wash=0.025;}
  float alpha=clamp((ink*0.70+wash)*uFade,0.0,0.85);if(alpha<0.001)discard;
  gl_FragColor=vec4(uTint*alpha*1.35,alpha);
  ${FOG_FRAG_GLSL}
  ${OUTPUT_GLSL}
}`;
export class RitualZoneFx {
  readonly group = new THREE.Group();
  private readonly geometry = new THREE.PlaneGeometry(2, 2, 32, 32).rotateX(-Math.PI / 2);
  private readonly zones = new Map<number, Ink>();
  private readonly preview: Ink;
  constructor(private readonly mobile = isMobileCommandLayout()) {
    this.group.name = 'degen-power-zones'; this.preview = this.make('mobile-power-radius-preview');
    this.preview.visible = false; this.group.add(this.preview);
  }
  private make(name: string): Ink {
    const mat = fxMaterial({vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide, uniforms: {
      uCenter: {value: new THREE.Vector2()}, uRadius: {value: 1}, uMapHalf: {value: MAP_HALF}, uStyle: {value: 4},
      uProgress: {value: 0}, uWarning: {value: 0}, uFade: {value: 1}, uTime: {value: 0}, uTint: {value: new THREE.Color()},
    }});
    mat.transparent = !this.mobile;
    const mesh = new THREE.Mesh(this.geometry, mat); mesh.name = name;
    mesh.renderOrder = this.mobile ? MOBILE_SPRITE_ORDER - .25 : 10;
    mesh.frustumCulled = false; return mesh;
  }
  update(w: World, s: Session, time: number): void {
    for (const [id, mesh] of this.zones) {
      const z = w.zones.get(id);
      if (w.phase !== 'playing' || !z || STYLES[z.kind] === undefined || z.until <= w.time || z.bornAt > w.time) {
        this.group.remove(mesh); mesh.material.dispose(); this.zones.delete(id);
      }
    }
    if (w.phase === 'playing') for (const z of w.zones.values()) {
      if (STYLES[z.kind] === undefined || z.until <= w.time || z.bornAt > w.time) continue;
      let mesh = this.zones.get(z.id);
      if (!mesh) {mesh = this.make(`power-zone-${z.kind}-${z.id}`); this.zones.set(z.id, mesh); this.group.add(mesh);}
      this.sync(mesh, z, w, time);
    }
    const p = mobilePowerPreview(w, s, this.mobile); this.preview.visible = p !== null;
    if (p) {const u = this.preview.material.uniforms;u.uCenter.value.set(p.x,p.z);u.uRadius.value=p.radius;u.uTint.value.set(p.color);u.uTime.value=time;}
    this.group.visible = this.zones.size > 0 || this.preview.visible;
  }
  private sync(mesh: Ink, z: Zone, w: World, time: number): void {
    const u=mesh.material.uniforms,age=w.time-z.bornAt,left=z.until-w.time;
    u.uCenter.value.set(z.pos.x,z.pos.z);u.uRadius.value=z.radius;u.uStyle.value=STYLES[z.kind];u.uTime.value=time;
    u.uProgress.value=THREE.MathUtils.clamp(age/Math.max(.001,z.until-z.bornAt),0,1);
    u.uWarning.value=z.kind==='redtape'&&age<RITUAL.redtape.warning?1:0;
    u.uFade.value=Math.min(1,.35+age/.2)*(z.kind==='omegaCharge'||z.kind==='alignment'?1:Math.min(1,left/.6));
    u.uTint.value.set(z.kind==='alignment'?w.factions[z.faction].color:TINT[z.kind as keyof typeof TINT]);
  }
  dispose(): void {
    for(const mesh of this.zones.values())mesh.material.dispose();
    this.preview.material.dispose();this.geometry.dispose();this.zones.clear();this.group.clear();this.group.removeFromParent();
  }
}
