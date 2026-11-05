import { it, expect } from 'vitest';
import { createMatch } from '../setup';
import { Simulation } from '../simulation';
import { spawnHippie } from '../factory';
import { normalizeMatch } from '../matchSettings';
import { giveFlag } from './flags';
// The existing carrier walks into handoff range while the native group menu is open.
// Its command can legitimately begin and finish between consecutive render frames.
it('completes a nearby group recruitment in the command tick with exactly one physical handoff', () => {
 const w=createMatch({seed:'recruitment-orders',humans:[0],rtsFactions:[0],difficulty:'normal',mode:'standard',match:normalizeMatch({active:[0],bossMode:false,crystalAttacks:false,days:3,startingSignifiers:0,maxSignifiers:20})});
 const sim=new Simulation(w);w.hippies.clear();w.factions[0].plan.clear();w.factions[0].lumber=0;
 const home=w.hearthOf(0)!,start=w.nav.nearestWalkable(home.pos.x+5,home.pos.z), first=spawnHippie(w,0,start), second=spawnHippie(w,0,w.nav.nearestWalkable(start.x+2,start.z));first.order={kind:'defend',at:{...first.pos}};second.order={kind:'defend',at:{...second.pos}};
 const target=spawnHippie(w,-1,w.nav.nearestWalkable(home.pos.x+12,home.pos.z));const stock=[...w.flags.values()].filter(f=>f.state==='stock'&&f.owner===0).map(f=>f.id);giveFlag(w,stock[0],second.id);const d=Math.hypot(home.pos.x,home.pos.z)||1;second.order={kind:'move',to:w.nav.nearestWalkable(start.x-home.pos.x/d*40,start.z-home.pos.z/d*40)};
 for(let i=0;i<120;i++)sim.step();
 expect(target.faction).toBe(-1);expect(second.carryingFlag).toBe(stock[0]);
 const flagCount=w.flags.size;const stockCount=[...w.flags.values()].filter(f=>f.state==='stock'&&f.owner===0).length;
 w.submit({t:'order',faction:0,hippies:[first.id,second.id],order:{kind:'recruit',target:target.id}});sim.step();
 expect(target.faction).toBe(0);expect(target.carryingFlag).toBe(stock[0]);
 expect(second.carryingFlag).toBe(-1);expect(second.order).toBeNull();expect(first.order?.kind).toBe('move');
 expect(w.flags.size).toBe(flagCount);expect([...w.flags.values()].filter(f=>f.state==='stock'&&f.owner===0)).toHaveLength(stockCount);
 expect(w.drainEvents().filter(e=>e.t==='recruited')).toEqual([expect.objectContaining({t:'recruited',hippieId:target.id,faction:0,via:'hand'})]);
 expect(w.gccOf(0)?.disabled).toBe(false);
});
