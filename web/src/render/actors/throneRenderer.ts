/** A seated ruler is presentation only: no entity, collision, inventory or avatar effects. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rtsThroneAltar } from '../../sim/rts';
import type { FactionId } from '../../sim/types';
import type { RenderContext } from '../context';
import { buildAvatarRig, createAvatarMaterial, type AvatarRig, type AvatarUniforms } from './avatarModels';

export const THRONE_SCALE = 1.55;
export const THRONE_PLATFORM_HEIGHT = .5;
type Point = [number, number, number];

/** Pipe-built reference silhouette: split asymmetrical black banners, not a generic royal chair. */
export function buildThrone(color: number): THREE.Group {
  const root = new THREE.Group(); root.name = 'rts-throne';
  const metal: THREE.BufferGeometry[] = [], black: THREE.BufferGeometry[] = [], stripes: THREE.BufferGeometry[] = [];
  const rod = (a: Point, b: Point, radius = .026) => {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), d = to.clone().sub(from);
    const g = new THREE.CylinderGeometry(radius, radius, d.length(), 8);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    g.translate(...from.add(to).multiplyScalar(.5).toArray() as Point); metal.push(g);
  };
  const box = (dest: THREE.BufferGeometry[], x: number, y: number, z: number, sx: number, sy: number, sz: number) => dest.push(new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z));
  const panel = (dest: THREE.BufferGeometry[], pts: [number, number][], z: number) => {
    const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(...p)));
    dest.push(new THREE.ShapeGeometry(shape).translate(0, 0, z));
  };
  for (const x of [-.58, .58]) {
    for (const z of [-.38, .4]) {
      rod([x, .04, z], [x, 1.02, z]);
      box(metal, x, .025, z, .18, .025, .13);
      for (const y of [.55, 1.02]) box(metal, x, y, z, .09, .08, .08);
    }
    rod([x, 1.02, -.38], [x, 1.02, .4]);
    rod([x, .55, -.38], [x, .55, .4]);
  }
  for (const z of [-.38, .4]) rod([-.58, .55, z], [.58, .55, z]);
  box(black, 0, .575, .01, 1.08, .055, .72);
  // A low matching pipe desk: narrow enough to leave torso, hands and banners visible.
  for (const x of [-.62,.62]) {
    for (const z of [.48,.94]) {
      rod([x,.03,z],[x,.99,z],.023);
      box(metal,x,.03,z,.13,.035,.11);
      box(metal,x,.97,z,.075,.07,.07);
    }
    rod([x,.95,.48],[x,.95,.94],.023);
  }
  rod([-.62,.95,.94],[.62,.95,.94],.023);
  box(black,0,1.005,.7,1.36,.065,.51);
  box(stripes,0,.997,.959,1.22,.025,.012);
  // Two cloth panels separated by an open slot; the left banner rises far higher.
  panel(black, [[-.51,.98],[-.51,2.18],[-.68,2.32],[-.68,3.9],[-.08,3.3],[-.08,.98]], -.39);
  panel(black, [[.03,.98],[.03,2.65],[.62,3.02],[.62,2.13],[.49,1.98],[.49,.98]], -.39);
  for (const [x, top] of [[-.54, 3.76],[-.04,3.3],[.53,2.96]]) rod([x,.55,-.41], [x,top,-.41], .018);
  rod([-.55,1.02,-.41],[.54,1.02,-.41],.02);
  rod([-.55,2.65,-.41],[.04,2.65,-.41],.018);
  for (const x of [-.54,-.04,.53]) for (const y of [1.03,1.8,2.6]) box(metal,x,y,-.41,.065,.085,.065);
  // Inset angular diagonal paint geometry, double-sided for reads from every map angle.
  panel(stripes,[[-.67,3.04],[-.67,2.86],[-.09,2.32],[-.09,2.5]],-.385);
  panel(stripes,[[-.56,2.33],[-.42,2.27],[-.09,3.27],[-.19,3.39]],-.384);
  panel(stripes,[[-.51,1.57],[-.51,1.75],[-.09,2.17],[-.09,1.98]],-.385);
  panel(stripes,[[.04,2.35],[.04,2.53],[.61,2.9],[.61,2.71]],-.385);
  panel(stripes,[[.13,2.44],[.25,2.53],[.49,2.02],[.49,1.78]],-.384);
  panel(stripes,[[.04,1.74],[.04,1.93],[.38,2.18],[.49,2.1]],-.385);
  // Matching paint on the back keeps ownership readable when orbiting the command map.
  stripes.push(...stripes.map(g => g.clone().translate(0, 0, -.016)));
  const materials = [new THREE.MeshStandardMaterial({color:0xc9d2d7,metalness:.8,roughness:.3}), new THREE.MeshStandardMaterial({color:0x080b10,roughness:.85,side:THREE.DoubleSide}), new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.16,roughness:.65,side:THREE.DoubleSide})];
  [metal,black,stripes].forEach((geometries,i) => {
    const merged = mergeGeometries(geometries, false)!;
    geometries.forEach(g=>g.dispose());
    const mesh = new THREE.Mesh(merged,materials[i]); mesh.name = ['throne-pipes','throne-black-banners','throne-faction-stripes'][i];
    mesh.castShadow = mesh.receiveShadow = true; root.add(mesh);
  });
  return root;
}

export function poseSeatedRuler(rig: AvatarRig, time: number): void {
  const b = rig.bones;
  b.hips.position.y = .63;
  b.thighL.rotation.set(-Math.PI/2,0,.08); b.thighR.rotation.set(-Math.PI/2,0,-.08);
  b.shinL.rotation.x = b.shinR.rotation.x = Math.PI/2;
  b.skirtF.rotation.x = -1.1; b.skirtB.rotation.x = .15;
  b.armL.rotation.set(-.9,0,.48); b.armR.rotation.set(-.9,0,-.48);
  b.foreL.rotation.x = b.foreR.rotation.x = -.9;
  b.staff.rotation.set(.8,0,-.3);
  // A quiet live ruler, never inherited combat, KO or Hold-the-Hearth animation.
  b.chest.rotation.x = .015*Math.sin(time*1.4);
  b.head.rotation.set(-.06,.08*Math.sin(time*.35),0);
  b.band.rotation.y = time*rig.style.bandSpin;
  b.quiver.scale.setScalar(0);
}

interface ThroneView { group: THREE.Group; rig: AvatarRig; u: AvatarUniforms; color: number }
export class ThroneRenderer {
  readonly group = new THREE.Group();
  private views = new Map<FactionId,ThroneView>();
  constructor(private readonly ctx: RenderContext) { this.group.name='rts-rulers'; ctx.scene.add(this.group); }
  update(): void {
    const w=this.ctx.world;
    for (const f of w.factions) {
      const altar = rtsThroneAltar(w,f.id);
      let v=this.views.get(f.id);
      if (!altar) { if(v) v.group.visible=false; continue; }
      if(v && v.color!==f.color) { this.release(v); this.views.delete(f.id); v=undefined; }
      if(!v) { v=this.create(f.id,f.color); this.views.set(f.id,v); }
      v.group.visible=!(w.boss?.held?.kind==='building' && w.boss.held.id===altar.id);
      const ground=this.ctx.shared.groundOffset?.(altar.pos.x,altar.pos.z) ?? w.collision.groundHeight(altar.pos.x,altar.pos.z);
      v.group.position.set(altar.pos.x,ground,altar.pos.z); v.group.rotation.y=altar.yaw;
      v.u.uTime.value=this.ctx.time; v.u.uBeat.value=0;
      poseSeatedRuler(v.rig,this.ctx.time);
      v.group.updateMatrixWorld(true);
    }
  }
  private create(faction: FactionId,color: number): ThroneView {
    const group = new THREE.Group(); group.name=`rts-ruler-${faction}`;
    const platform = new THREE.Mesh(new THREE.CylinderGeometry(1.9,2.05,THRONE_PLATFORM_HEIGHT,5),new THREE.MeshStandardMaterial({color:0x31333d,metalness:.25,roughness:.7}));
    platform.position.y=THRONE_PLATFORM_HEIGHT/2; platform.castShadow=platform.receiveShadow=true;
    const chair=buildThrone(color); chair.position.y=THRONE_PLATFORM_HEIGHT; chair.scale.setScalar(THRONE_SCALE);
    const u:AvatarUniforms={uTime:{value:0},uBeat:{value:0},uDissolve:{value:0},uFlash:{value:0},uGlowBoost:{value:.1},uEdge:{value:new THREE.Color(color)}};
    const rig=buildAvatarRig(faction,createAvatarMaterial(u)); rig.mesh.name=`rts-seated-avatar-${faction}`;
    rig.mesh.position.y=THRONE_PLATFORM_HEIGHT; rig.mesh.scale.setScalar(THRONE_SCALE); rig.mesh.castShadow=rig.mesh.receiveShadow=true;
    group.add(platform,chair,rig.mesh); this.group.add(group);
    return {group,rig,u,color};
  }
  private release(v:ThroneView): void {
    v.group.removeFromParent(); v.rig.mesh.skeleton.dispose();
    v.group.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();const ms=Array.isArray(o.material)?o.material:[o.material];ms.forEach(m=>m.dispose());}});
  }
  dispose(): void { this.views.forEach(v=>this.release(v)); this.views.clear(); this.group.removeFromParent(); }
}
