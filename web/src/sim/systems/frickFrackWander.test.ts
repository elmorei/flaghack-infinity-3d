import { describe, expect, it, vi } from 'vitest';
import { newMatch } from './econ/testkit';
import { initializeFrickFrack, stepFrickFrackWizard, offerFrickFrackFlag, closeFrickFrackSession, updateFrickFrack } from './frickFrack';
import { wizardCircuitRadius } from './frickFrackWander';
import { updateHippies } from './hippies';
import { cmdThrow } from './avatars';
import { brainOf } from './units/brain';
import { unitsState } from './units/state';
import type { World } from '../world';
import { insideEffigyCrater } from '../effigyCrater';
function arena(seed = 'wizard-circuit') {
  const {world:w}=newMatch(seed);w.factions[0].isPlayer=true;initializeFrickFrack(w);
  const h=w.hippies.get(w.frickFrack.wizardId)!;
  for(const other of [...w.hippies.values()])if(other!==h)w.hippies.delete(other.id);
  return {w,h,b:brainOf(h)};
}
function step(w:World,seconds:number){for(let i=0;i<Math.ceil(seconds*30);i++){w.time+=1/30;updateFrickFrack(w);updateHippies(w,1/30);}}
const radius=(w:World,p:{x:number;z:number})=>Math.hypot(p.x-w.map.effigy.x,p.z-w.map.effigy.z);
describe('wizard effigy circuit',()=>{
 it('does not consume the shared world RNG while choosing circuit goals',()=>{
  const {w,h,b}=arena();const random=vi.spyOn(w.rng,'next');
  for(let i=0;i<300;i++){w.time+=1/30;stepFrickFrackWizard(w,unitsState(w),h,b,1/30);}
  expect(random).not.toHaveBeenCalled();random.mockRestore();
 });
 it.each(['wizard-circuit','wizard-second','wizard-third'])('returns from camp and circulates using real navigation: %s',seed=>{
  const {w,h,b}=arena(seed);step(w,100);
  expect(radius(w,h.pos)).toBeLessThan(wizardCircuitRadius(w)+6);
  const start={...h.pos};let travelled=0,previous={...h.pos};
  for(let i=0;i<900;i++){step(w,1/30);travelled+=Math.hypot(h.pos.x-previous.x,h.pos.z-previous.z);previous={...h.pos};expect(radius(w,h.pos)).toBeGreaterThan(wizardCircuitRadius(w)-2);}
  expect(travelled).toBeGreaterThan(15);expect(Math.hypot(start.x-h.pos.x,start.z-h.pos.z)).toBeGreaterThan(5);
  expect(b.task).toBe('wander');expect(h.faction).toBe(-1);expect(h.wizard).toBe(true);
 });
 it('uses bounded walkable targets and actual enlarged effigy footprint',()=>{
  const {w,h,b}=arena();const effigy=w.map.obstacles.find(o=>o.kind==='effigy')!;
  if(effigy.shape!=='circle')throw Error('expected effigy circle');effigy.radius=25;
  stepFrickFrackWizard(w,unitsState(w),h,b,1/30);
  expect(radius(w,{x:b.px,z:b.pz})).toBeGreaterThan(28);
  expect(radius(w,{x:b.px,z:b.pz})).toBeLessThan(wizardCircuitRadius(w)+5);
  expect(w.nav.isWalkable(b.px,b.pz)).toBe(true);
 });
 it('remains outside the crater after the effigy is removed, without changing boss state',()=>{
  const {w,h}=arena();step(w,100);w.effigyRevealedAt=w.time;
  w.map.obstacles=w.map.obstacles.filter(o=>o.kind!=='effigy');const boss=w.boss;
  for(let i=0;i<900;i++){step(w,1/30);expect(insideEffigyCrater(w,h.pos)).toBe(false);}
  expect(w.boss).toBe(boss);expect(radius(w,h.pos)).toBeLessThan(wizardCircuitRadius(w)+6);
 });
 it('is deterministic and respects idle pauses, chase priority, dialogue lock, then returns',()=>{
  const first=arena(),second=arena();step(first.w,20);step(second.w,20);expect(first.h.pos).toEqual(second.h.pos);
  const {w,h,b}=first;const pos=w.nav.nearestWalkable(50,50);h.pos={...pos};h.vel={x:0,z:0};b.task='wander';b.waitUntil=w.time+30;
  step(w,1);expect(h.pos).toEqual(pos);
  const av=w.avatarOf(0);Object.assign(av.pos,{x:pos.x+1,z:pos.z,y:w.collision.groundHeight(pos.x+1,pos.z)});
  cmdThrow(w,{t:'throw',faction:0});const p=[...w.projectiles.values()].find(p=>p.thrower===av.id)!;
  expect(offerFrickFrackFlag(w,h,0,p.flagId)).toBe(true);step(w,.1);
  expect(w.frickFrack.sessions[0]?.phase).toBe('dialogue');const locked={...h.pos};step(w,3);expect(h.pos).toEqual(locked);
  closeFrickFrackSession(w,0);step(w,100);expect(radius(w,h.pos)).toBeLessThan(wizardCircuitRadius(w)+6);
 });
});
