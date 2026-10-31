import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { DIE_FACE_VALUES, dieMotion, dieRestQuaternion, visibleDieFace } from './frickFrackDie';
describe('authoritative table die presentation',()=>{
  it.each([1,2,3,4,5,6])('settles with actual face %s visible',result=>{
    expect(visibleDieFace(dieRestQuaternion(result))).toBe(result);
    const axes = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
    const faceNormal = new Vector3(...axes[DIE_FACE_VALUES.indexOf(result as typeof DIE_FACE_VALUES[number])] as [number,number,number]).applyQuaternion(dieRestQuaternion(result));
    expect(faceNormal.y).toBeGreaterThan(.7); expect(faceNormal.z).toBeGreaterThan(.5); // genuinely upper and visible, not the vertical front
    for(const p of [1,1.1,20]){
      const m=dieMotion(p,result);expect(visibleDieFace(m.rotation)).toBe(result);
      expect(m.x).toBeCloseTo(0);expect(m.y).toBeCloseTo(0);expect(m.lift).toBeCloseTo(0);
    }
  });
  it('uses standard opposite faces summing to seven',()=>{
    for(let i=0;i<6;i+=2)expect(DIE_FACE_VALUES[i]+DIE_FACE_VALUES[i+1]).toBe(7);
  });
  it('reduced motion shows authoritative face immediately without rerolling',()=>{
    for(let result=1;result<=6;result++){
      const m=dieMotion(.12,result,true);expect(m.progress).toBe(1);expect(visibleDieFace(m.rotation)).toBe(result);
    }
  });
  it('is deterministic at the same replicated progress regardless of draw history',()=>{
    expect(dieMotion(.37,4)).toEqual(dieMotion(.37,4));
    expect(dieMotion(.37,4).rotation.equals(dieMotion(.8,4).rotation)).toBe(false);
    expect(dieMotion(-1,3).progress).toBe(0);
  });
  it('rejects impossible result rather than silently rendering another face',()=>{
    for(const result of [0,7,1.5,NaN])expect(()=>dieRestQuaternion(result)).toThrow();
  });
});
