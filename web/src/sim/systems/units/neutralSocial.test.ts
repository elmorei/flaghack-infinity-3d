import { describe, expect, it, vi } from 'vitest';
import { spawnBuilding, spawnHippie } from '../../factory';
import { burnTime } from '../../matchSettings';
import { registerBuildingShape } from '../buildings';
import { freeThickFacet, newMatch } from '../econ/testkit';
import { brainOf } from './brain';
import { arriveNeutralSocial, neutralSocialVisit, SOCIAL_CAPACITY } from './neutralSocial';
import { attractToRecruiter, pickWanderSpot } from './act';
import { unitsState } from './state';
import { recruitNear } from '../recruitment';

function fixture(faction: 0|1|2|3 = 0) {
  const { world } = newMatch('neutral-social');
  world.hippies.clear();
  for (const b of world.buildings.values()) if (b.kind === 'gcc') b.disabled = true;
  const home = world.hearthOf(faction)!;
  const circle = spawnBuilding(world, 'drumcircle', faction, freeThickFacet(world, home.pos.x, home.pos.z, 15, 'drumcircle'), 1);
  registerBuildingShape(world, circle);
  const at = world.nav.nearestWalkable(circle.pos.x + 12, circle.pos.z);
  return { world, circle, add: () => spawnHippie(world, -1, { ...at }) };
}
describe('bounded neutral social visits', () => {
  it.each([0,1,2,3] as const)('faction %s reserves at most eight distinct walkable visitor slots', faction => {
    const { world, add } = fixture(faction);
    const people = Array.from({length: 20}, add);
    const visits = people.map(h => neutralSocialVisit(world, h, brainOf(h))).filter(v => !!v);
    expect(visits.length).toBeGreaterThan(0); expect(visits.length).toBeLessThanOrEqual(SOCIAL_CAPACITY);
    expect(new Set(visits.map(v => `${v.x}:${v.z}`)).size).toBe(visits.length);
    expect(visits.every(v => world.nav.isWalkable(v.x,v.z))).toBe(true);
    expect(world.hippies.size).toBe(20);
  });
  it('circulates a crowded group instead of keeping the first visitors indefinitely', () => {
    const {world,add}=fixture();
    const people=Array.from({length:20},add);
    const accepted=people.filter(h=>{const v=neutralSocialVisit(world,h,brainOf(h));if(v)arriveNeutralSocial(world,v);return !!v;});
    expect(accepted.length).toBeGreaterThan(0); expect(accepted.length).toBeLessThanOrEqual(8);
    world.time=31;
    expect(accepted.every(h=>!neutralSocialVisit(world,h,brainOf(h)))).toBe(true);
    const newcomers=people.filter(h=>!accepted.includes(h)).filter(h=>neutralSocialVisit(world,h,brainOf(h)));
    expect(newcomers.length).toBeGreaterThan(0); expect(newcomers.length).toBeLessThanOrEqual(8);
  });
  it('bounds blocked slot work and backs off scans without making paths in the social allocator', () => {
    const {world,add}=fixture(),h=add(),b=brainOf(h);
    const walk=vi.spyOn(world.nav,'isWalkable').mockReturnValue(false);
    const path=vi.spyOn(world.nav,'findPath');
    expect(neutralSocialVisit(world,h,b)).toBeUndefined();
    expect(walk.mock.calls.length).toBeLessThanOrEqual(8);
    const calls=walk.mock.calls.length;
    for(let i=0;i<60;i++)neutralSocialVisit(world,h,b);
    expect(walk.mock.calls.length).toBe(calls); expect(path).not.toHaveBeenCalled();
  });
  it('leaves after a finite 15–30 second visit and cannot immediately revisit', () => {
    const { world, add } = fixture(), h=add(), b=brainOf(h);
    const visit=neutralSocialVisit(world,h,b)!; expect(visit).toBeDefined();
    Object.assign(h.pos,{x:visit.x,z:visit.z}); arriveNeutralSocial(world,visit);
    expect(visit.until-world.time).toBeGreaterThanOrEqual(15); expect(visit.until-world.time).toBeLessThanOrEqual(30);
    world.time=visit.until+.1;
    expect(neutralSocialVisit(world,h,b)).toBeUndefined();
    world.time+=29; expect(neutralSocialVisit(world,h,b)).toBeUndefined();
    world.time+=32; expect(neutralSocialVisit(world,h,b)).toBeDefined();
  });
  it('releases visits on capture, destruction, recruitment and the final Burn', () => {
    const {world,circle,add}=fixture(), h=add(), b=brainOf(h);
    expect(neutralSocialVisit(world,h,b)).toBeDefined(); circle.faction=1; world.time+=1;
    expect(neutralSocialVisit(world,h,b)).toBeUndefined();
    world.time+=61; expect(neutralSocialVisit(world,h,b)).toBeDefined();
    circle.hp=0; world.time+=1; expect(neutralSocialVisit(world,h,b)).toBeUndefined();
    circle.hp=500; world.time+=61; expect(neutralSocialVisit(world,h,b)).toBeDefined();
    h.faction=1; b.task='idle'; world.time+=1; expect(neutralSocialVisit(world,h,b)).toBeUndefined(); expect(b.task).toBe('idle');
    h.faction=-1; world.time=burnTime(world.options)-100; expect(neutralSocialVisit(world,h,b)).toBeUndefined();
  });
  it.each(['gcc','workshop'] as const)('%s does not park passers-by, but still recruits them', kind => {
    const { world, circle, add }=fixture(); circle.disabled=true;
    const recruiter=kind==='gcc'?world.gccOf(0)!:spawnBuilding(world,'workshop',0,circle.facet,1);
    recruiter.disabled=false;
    if(kind==='workshop') registerBuildingShape(world,recruiter);
    const h=add(); Object.assign(h.pos,world.nav.nearestWalkable(recruiter.pos.x+10,recruiter.pos.z));
    const b=brainOf(h); expect(attractToRecruiter(world,unitsState(world),h,b)).toBe(false);
    const n=world.hippies.size; expect(recruitNear(world,recruiter)).toBe(true); expect(world.hippies.size).toBe(n);
  });
  it('samples broad walkable destinations reproducibly instead of only static camp/spawn clusters', () => {
    const sample=()=>{ const {world,add}=fixture(),h=add(),b=brainOf(h); const points=[];
      for(let i=0;i<80;i++){pickWanderSpot(world,h,b);points.push({x:b.px,z:b.pz});}return {world,points}; };
    const a=sample(),b=sample(); expect(a.points).toEqual(b.points);
    const remote=a.points.filter(p=>a.world.map.soundCamps.every(c=>Math.hypot(p.x-c.x,p.z-c.z)>20));
    expect(remote.length).toBeGreaterThan(40); expect(remote.every(p=>a.world.nav.isWalkable(p.x,p.z))).toBe(true);
  });
});
