/** Regression checks for the numerical claims in bench/capture-scenery-benefits.mjs. */
import { describe,it,expect } from 'vitest';
import { createMatch } from '../sim/setup';
import { normalizeMatch } from '../sim/matchSettings';
import { spawnBuilding,spawnHippie,spawnFlag } from '../sim/factory';
import { sceneryServicePoint,sceneryRitualMultiplier,tentPlaces } from '../sim/systems/sceneryBenefits';
import { newStructureCapture } from '../sim/systems/structureCapture';
import { updateSceneryService } from '../sim/systems/sceneryServices';
import { unitsState } from '../sim/systems/units/state';
import { brainOf } from '../sim/systems/units/brain';
import { popCap,updateEconomy } from '../sim/systems/economy';
import { depotHolder,depotStock,vehicleCapacity } from '../sim/systems/sceneryDepots';
import { depositToStock } from '../sim/systems/flags';
import { DRUM_RITUAL_PER_SEC } from '../sim/constants';

describe('actual-game scenery capture numerical fixtures',()=>{
  for(const kind of ['tent','art','car','dome','shade','porta'] as const) it(`${kind}: real production four-second claim`,()=>{
    const w=createMatch({seed:'scenery-benefits-proof',difficulty:'normal',mode:'standard',humans:[0,1,2,3],match:normalizeMatch({days:-1,bossMode:false,maxSignifiers:0})});
    w.time=20;w.hippies.clear();w.sceneryCapture.clear();for(const a of w.avatars.values())a.pos={x:-1000,y:0,z:-1000};
    const o=w.map.obstacles.filter(o=>o.kind===kind&&sceneryServicePoint(w,o)).sort((a,b)=>Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z))[0];
    expect(o).toBeDefined();const cap=popCap(w,0);w.sceneryCapture.set(o.id,{...newStructureCapture(),faction:0});
    if(kind==='tent'){expect(popCap(w,0)-cap).toBe(tentPlaces(o));return;}
    if(kind==='car'){
      const p=sceneryServicePoint(w,o)!;const flags=Array.from({length:vehicleCapacity(o)+1},()=>spawnFlag(w,{state:'loose',owner:0,pos:{...p,y:0}}));
      const count=w.flags.size;for(const f of flags)depositToStock(w,f.id,depotHolder(o.id));
      expect(w.flags.size).toBe(count);expect(depotStock(w,depotHolder(o.id))).toBe(vehicleCapacity(o));expect(flags.at(-1)!.state).toBe('loose');return;
    }
    if(kind==='art'){
      const facet=w.lattice.facets.filter(f=>f.thick&&!f.boundary&&Math.hypot(f.cx-o.x,f.cz-o.z)<20&&Math.hypot(f.cx-o.x,f.cz-o.z)>6&&!w.collision.blockedCircle(f.cx,f.cz,4,.1,12)).sort((a,b)=>Math.hypot(a.cx-o.x,a.cz-o.z)-Math.hypot(b.cx-o.x,b.cz-o.z))[0];
      expect(facet).toBeDefined();const b=spawnBuilding(w,'drumcircle',0,facet.id,1);
      for(let i=0;i<4;i++){const h=spawnHippie(w,0,{x:b.pos.x+Math.cos(i*Math.PI/2)*2,z:b.pos.z+Math.sin(i*Math.PI/2)*2});h.status='drumming';}
      expect(sceneryRitualMultiplier(w,0,b.pos)).toBe(1.25);const before=w.factions[0].ritual;
      for(let i=0;i<120;i++){w.time+=1/30;updateEconomy(w,1/30);}
      expect(w.factions[0].ritual-before).toBeCloseTo(4*4*DRUM_RITUAL_PER_SEC*1.25,6);return;
    }
    const sys=unitsState(w),hs=Array.from({length:kind==='dome'?4:2},(_,slot)=>{
      const h=spawnHippie(w,0,sceneryServicePoint(w,o,undefined,slot)!);h.hp=kind==='dome'?50:100;h.attention=40;h.job='gather';brainOf(h).lastHurtAt=-Infinity;return h;
    });
    for(let i=0;i<120;i++){w.time+=1/30;for(const h of hs)updateSceneryService(w,sys,h,brainOf(h),0,1/30);}
    if(kind==='dome')for(const h of hs)expect(h.hp).toBeCloseTo(62,6);
    if(kind==='shade')for(const h of hs)expect(h.attention).toBeCloseTo(56,6);
    if(kind==='porta'){expect(hs[0].attention).toBeCloseTo(60,6);expect(hs[1].attention).toBeCloseTo(40,6);}
  });
});
