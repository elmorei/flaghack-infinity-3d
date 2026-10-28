/** Staging smoke test for bench/capture-rts-recruitment.mjs before spending runner time. */
import {describe,it,expect} from 'vitest';
import {normalizeMatch} from '../src/sim/matchSettings';
import {createMatch} from '../src/sim/setup';
import {spawnHippie} from '../src/sim/factory';
import {crystalAttackAim,throneAttackOrigin,updateCrystalAttacks} from '../src/sim/systems/crystalAttacks';
import {updateHippies} from '../src/sim/systems/hippies';
import {updateEconomy} from '../src/sim/systems/economy';
import {applyCommands} from '../src/sim/systems/commands';
import {brainOf} from '../src/sim/systems/units/brain';
import type {FactionId} from '../src/sim/types';
describe('runtime proof staging',()=>{
 it.each([0,1,2,3] as FactionId[])('finds genuine altar LOS for ruler %i',owner=>{
  const w=createMatch({seed:'rts-throne-proof',difficulty:'normal',mode:'standard',humans:[0,1,2,3],rtsFactions:[0,1,2,3],match:normalizeMatch({days:-1,bossMode:false,maxSignifiers:0,startingSignifiers:0,crystalAttacks:true})});
  w.time=470;const altar=w.hearthOf(owner)!,target=spawnHippie(w,((owner+1)%4) as FactionId,{x:0,z:0});let found=false;
  for(let i=0;i<36;i++){
   const a=altar.yaw+Math.PI/3+(i%2?-1:1)*Math.ceil(i/2)*Math.PI/18;
   const p={x:altar.pos.x+Math.sin(a)*10,z:altar.pos.z+Math.cos(a)*10};
   if(w.collision.blockedCircle(p.x,p.z,1,.1,5))continue;
   target.pos=p;const from=throneAttackOrigin(w,owner),to=crystalAttackAim(w,target);
   if(w.collision.raycast(from.x,from.y,from.z,to.x-from.x,to.y-from.y,to.z-from.z,Math.hypot(to.x-from.x,to.y-from.y,to.z-from.z)-.05,altar.id))continue;
   found=true;break;
  }
  expect(found).toBe(true);updateCrystalAttacks(w,0);expect(w.factions[owner].throneAttack?.target).toBe(target.id);expect(w.avatars.size).toBe(0);
 });
 it.each(['commanded','passive'])('completes the %s capture scene without creating people or flags',mode=>{
  const w=createMatch({seed:'recruitment-orders',difficulty:'normal',mode:'standard',humans:[0,1,2,3],rtsFactions:[0,1,2,3],match:normalizeMatch({days:3,bossMode:false,maxSignifiers:0,startingSignifiers:0,startingLumber:0})});
  w.time=470;const gcc=w.gccOf(0)!,home=w.hearthOf(0)!,anchor=mode==='commanded'?home:gcc;
  for(const b of w.buildings.values())if(b.kind==='gcc'||b.kind==='drumcircle')b.disabled=mode==='commanded'||b.id!==gcc.id;
  const neutral=spawnHippie(w,-1,w.nav.nearestWalkable(anchor.pos.x+(mode==='commanded'?10:23),anchor.pos.z));
  let worker;
  if(mode==='commanded'){
   worker=spawnHippie(w,0,w.nav.nearestWalkable(home.pos.x+5,home.pos.z));const idle=brainOf(neutral);idle.task='wander';idle.waitUntil=Infinity;
   w.submit({t:'order',faction:0,hippies:[worker.id],order:{kind:'recruit',target:neutral.id}});applyCommands(w);
  }
  const flags=w.flags.size,pop=w.hippies.size,stock=new Set([...w.flags.values()].filter(f=>f.state==='stock'&&f.owner===0).map(f=>f.id));let fetched=false;
  for(let i=0;i<1800&&neutral.faction!==0;i++){w.time+=1/30;w.tick++;updateHippies(w,1/30);if(mode==='passive')updateEconomy(w,1/30);if(worker&&stock.has(worker.carryingFlag))fetched=true;}
  expect(neutral.faction).toBe(0);expect(w.flags.size).toBe(flags);expect(w.hippies.size).toBe(pop);
  if(mode==='commanded'){expect(fetched).toBe(true);expect(stock.has(neutral.carryingFlag)).toBe(true);}
 });
});
