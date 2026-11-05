import { describe, expect, it } from 'vitest';
import { mobileAvatarMotion } from './mobileAvatar';
const still=()=>({moveX:0,moveZ:0,jump:false,sprint:false,yaw:0,pitch:0});
describe('touch avatar motion',()=>{
  it('walks toward a touch destination at bounded speed and faces travel',()=>{
    const input=still(); expect(mobileAvatarMotion({x:0,z:0},{x:3,z:4},input)).toBe(true);
    expect(input.moveX).toBeCloseTo(.6); expect(input.moveZ).toBeCloseTo(.8);
    expect(input.yaw).toBeCloseTo(Math.atan2(3,4));
  });
  it('stops on arrival, cancellation or a malformed destination',()=>{
    expect(mobileAvatarMotion({x:0,z:0},{x:.1,z:.1},still())).toBe(false);
    expect(mobileAvatarMotion({x:0,z:0},null,still())).toBe(false);
    expect(mobileAvatarMotion({x:0,z:0},{x:NaN,z:1},still())).toBe(false);
  });
});
