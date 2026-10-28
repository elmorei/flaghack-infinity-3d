import { describe, expect, it } from 'vitest';
import { createMatch } from '../setup';
import { normalizeMatch } from '../matchSettings';
import { spawnBuilding, spawnHippie } from '../factory';
import { HIPPIE, DRUM_RITUAL_PER_SEC } from '../constants';
import { newStructureCapture } from './structureCapture';
import { popCap, updateEconomy } from './economy';
import { activeScenery, sceneryBenefitActive, sceneryLodging, sceneryRitualMultiplier, sceneryServicePoint, tentPlaces } from './sceneryBenefits';
import type { Obstacle } from '../map/mapgen';
function fixture() {
  const w = createMatch({ seed: 'scenery-benefits', mode: 'standard', difficulty: 'normal', humans: [0,1,2,3], match: normalizeMatch({ maxSignifiers: 0 }) });
  w.hippies.clear();
  const claim = (o: Obstacle, f: 0|1 = 0) => w.sceneryCapture.set(o.id, { ...newStructureCapture(), faction: f });
  return { w, claim };
}
describe('captured scenery economy', () => {
  it('grants capped lodging, never recruits or spawns people', () => {
    const {w,claim} = fixture(); const base=popCap(w,0), count=w.hippies.size;
    const tents=w.map.obstacles.filter(o=>o.kind==='tent');
    claim(tents[0]); expect(popCap(w,0)).toBe(base+tentPlaces(tents[0]));
    tents.forEach(o=>claim(o)); expect(sceneryLodging(w,0)).toBe(12);
    expect(popCap(w,0)).toBe(base+12); expect(w.hippies.size).toBe(count);
  });
  it('pauses active capture, not a mere threatened marker, and removes lost capacity', () => {
    const {w,claim}=fixture(); const o=w.map.obstacles.find(o=>o.kind==='tent')!; claim(o);
    const h=w.sceneryCapture.get(o.id)!;
    h.stage='threatened'; expect(sceneryBenefitActive(w,o.id,0)).toBe(true);
    for(const stage of ['contained','contested','overwritten'] as const) {h.stage=stage; expect(sceneryLodging(w,0)).toBe(0);}
    h.stage='safe'; h.faction=1; expect(sceneryLodging(w,0)).toBe(0); expect(sceneryLodging(w,1)).toBe(tentPlaces(o));
    w.destroyedScenery.add(o.id); expect(sceneryLodging(w,1)).toBe(0);
  });
  it('does not instantly delete excess people when tents are lost', () => {
    const {w,claim}=fixture(); const o=w.map.obstacles.find(o=>o.kind==='tent')!; claim(o);
    for(let i=0;i<HIPPIE.popCapBase+3;i++) spawnHippie(w,0,w.hearthOf(0)!.pos);
    const ids=[...w.hippies.keys()]; w.sceneryCapture.get(o.id)!.faction=1;
    expect(popCap(w,0)).toBe(HIPPIE.popCapBase); expect([...w.hippies.keys()]).toEqual(ids);
  });
  it('inspiration is faction-owned, range-limited, non-stacking and requires actual drummers', () => {
    const {w,claim}=fixture(); const arts=w.map.obstacles.filter(o=>o.kind==='art').slice(0,2);
    const facet=w.lattice.facets.find(f=>!f.boundary)!;
    const circle=spawnBuilding(w,'drumcircle',0,facet.id,1); circle.pos={x:arts[0].x,z:arts[0].z};
    arts[1].x=arts[0].x; arts[1].z=arts[0].z; arts.forEach(o=>claim(o));
    expect(sceneryRitualMultiplier(w,0,circle.pos)).toBe(1.25);
    expect(sceneryRitualMultiplier(w,1,circle.pos)).toBe(1);
    expect(sceneryRitualMultiplier(w,0,{x:circle.pos.x+26,z:circle.pos.z})).toBe(1);
    const before=w.factions[0].ritual; updateEconomy(w,1); expect(w.factions[0].ritual).toBe(before);
    const h=spawnHippie(w,0,circle.pos); h.status='drumming';
    updateEconomy(w,1); expect(w.factions[0].ritual-before).toBeCloseTo(DRUM_RITUAL_PER_SEC*1.25);
    w.sceneryCapture.get(arts[0].id)!.stage='contained'; w.sceneryCapture.get(arts[1].id)!.stage='contested';
    expect(sceneryRitualMultiplier(w,0,circle.pos)).toBe(1);
  });
  it('neutral, eliminated, and destroyed scenery never provide service', () => {
    const {w,claim}=fixture(); const o=w.map.obstacles.find(o=>o.kind==='shade')!;
    expect(activeScenery(w,'shade')).toEqual([]); claim(o); w.factions[0].alive=false;
    expect(activeScenery(w,'shade')).toEqual([]); w.factions[0].alive=true; w.destroyedScenery.add(o.id);
    expect(activeScenery(w,'shade')).toEqual([]);
  });
  it('service positions are walkable exterior points for circles and rotated boxes', () => {
    const {w}=fixture();
    for(const o of w.map.obstacles.filter(o=>['dome','shade','porta','car'].includes(o.kind)).slice(0,30)) {
      const p=sceneryServicePoint(w,o); if(!p)continue;
      expect(w.nav.isWalkable(p.x,p.z)).toBe(true);
      const dx=p.x-o.x,dz=p.z-o.z,c=Math.cos(o.yaw),s=Math.sin(o.yaw),x=c*dx-s*dz,z=s*dx+c*dz;
      expect(o.shape==='circle'?Math.hypot(x,z)>o.radius:Math.abs(x)>o.hx||Math.abs(z)>o.hz).toBe(true);
    }
  });
});
