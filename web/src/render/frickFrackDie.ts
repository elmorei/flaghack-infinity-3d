/** Public, deterministic dice presentation. The host result is never chosen here. */
import * as THREE from 'three';

export const DIE_FACE_VALUES = [3, 4, 2, 5, 1, 6] as const; // BoxGeometry +X,-X,+Y,-Y,+Z,-Z
const normals = [new THREE.Vector3(1,0,0),new THREE.Vector3(-1,0,0),new THREE.Vector3(0,1,0),new THREE.Vector3(0,-1,0),new THREE.Vector3(0,0,1),new THREE.Vector3(0,0,-1)];
const presentation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.68,-.35,0));
export function dieRestQuaternion(result: number): THREE.Quaternion {
  const index = DIE_FACE_VALUES.indexOf(result as typeof DIE_FACE_VALUES[number]);
  if (index < 0) throw new RangeError('A die result must be 1–6');
  return presentation.clone().multiply(new THREE.Quaternion().setFromUnitVectors(normals[index],new THREE.Vector3(0,1,0)));
}
export function visibleDieFace(rotation: THREE.Quaternion): number {
  let best=0, score=-Infinity;
  // The rolled face is the visible UPPER face, not merely the face closest to the camera.
  normals.forEach((n,i)=>{ const v=n.clone().applyQuaternion(rotation); if(v.z > 0 && v.y > score){score=v.y;best=i;} });
  return DIE_FACE_VALUES[best];
}
export function dieMotion(progress: number, result: number, reducedMotion = false) {
  const p=reducedMotion?1:Math.max(0,Math.min(1,progress));
  const rest=dieRestQuaternion(result), remaining=1-p;
  // Full rotations unwind into the exact host-selected face. No random visual outcome.
  const tumble=new THREE.Quaternion().setFromEuler(new THREE.Euler(remaining*Math.PI*6,remaining*Math.PI*4,remaining*Math.PI*2));
  return { progress:p, rotation:tumble.multiply(rest), x: -110*remaining*remaining,
    y: Math.sin(p*Math.PI*2)*16*remaining,
    lift: Math.abs(Math.sin(p*Math.PI*3))*34*remaining,
  };
}
export function createDie(): { mesh: THREE.Mesh<THREE.BoxGeometry,THREE.MeshBasicMaterial[]>; dispose():void } {
  const maps=DIE_FACE_VALUES.map(value=>{
    const c=document.createElement('canvas');c.width=c.height=128;const ctx=c.getContext('2d');
    if(!ctx)throw new Error('Die artwork requires a texture canvas');
    ctx.fillStyle='#fff3d8';ctx.fillRect(0,0,128,128);
    ctx.strokeStyle='#c5ab7a';ctx.lineWidth=6;ctx.strokeRect(3,3,122,122);
    ctx.fillStyle='#24354a';
    const pip=(x:number,y:number)=>{ctx.beginPath();ctx.arc(x,y,10,0,Math.PI*2);ctx.fill();};
    if(value%2)pip(64,64);
    if(value>=2){pip(32,32);pip(96,96);}
    if(value>=4){pip(96,32);pip(32,96);}
    if(value===6){pip(32,64);pip(96,64);}
    const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.generateMipmaps=false;t.minFilter=THREE.LinearFilter;return t;
  });
  const materials=maps.map(map=>new THREE.MeshBasicMaterial({map,toneMapped:false}));
  const geometry=new THREE.BoxGeometry(1,1,1),mesh=new THREE.Mesh(geometry,materials);
  return {mesh,dispose(){geometry.dispose();for(const m of materials)m.dispose();for(const t of maps)t.dispose();}};
}
