import { describe, expect, it } from 'vitest';
import { HIPPIE } from '../constants';
import { spawnHippie } from '../factory';
import { normalizeMatch } from '../matchSettings';
import { createMatch } from '../setup';
import type { Hippie } from '../types';
import { newStructureCapture } from './structureCapture';
import { sceneryServicePoint } from './sceneryBenefits';
import { updateSceneryService, cancelSceneryService, sceneryServiceOf, sceneryServiceOccupancy, SCENERY_SERVICE_TUNING as T } from './sceneryServices';
import { brainOf, beginTask } from './units/brain';
import { unitsState } from './units/state';
import { updateHippies } from './hippies';

function fixture(kind: 'dome' | 'shade' | 'porta') {
  const w = createMatch({seed:'scenery-services', difficulty:'normal', mode:'standard', humans:[0,1,2,3], match:normalizeMatch({maxSignifiers:0})});
  w.hippies.clear(); w.time=20;
  for(const av of w.avatars.values()) av.pos={x:-1000,y:0,z:-1000};
  const o = w.map.obstacles.find(o=>o.kind===kind && sceneryServicePoint(w,o))!;
  expect(o).toBeDefined();
  w.sceneryCapture.set(o.id,{...newStructureCapture(),faction:0});
  const sys=unitsState(w); sys.nextAllocAt.fill(Infinity);
  const add=(slot=0):Hippie=>{
    const p=sceneryServicePoint(w,o,undefined,slot)!;
    const h=spawnHippie(w,0,{...p}); h.hp=50; h.attention=40; h.job='gather';
    brainOf(h).lastHurtAt=-Infinity;
    return h;
  };
  const step=(h:Hippie,dt:number)=>updateSceneryService(w,sys,h,brainOf(h),0,dt);
  return {w,o,sys,add,step};
}

describe('captured scenery recovery services',()=>{
  it('heals a stationary patient at a real exterior dome point, never in the solid center',()=>{
    const {w,o,add,step}=fixture('dome');const h=add();
    expect(Math.hypot(h.pos.x-o.x,h.pos.z-o.z)).toBeGreaterThan(o.radius);
    expect(step(h,2)).toBe(true);expect(h.hp).toBe(56);expect(h.status).toBe('idle');
    expect(h.sceneryService).toEqual({id:o.id,phase:'serving'});expect(w.nav.isWalkable(h.pos.x,h.pos.z)).toBe(true);
  });
  it('does not heal during approach or within five seconds of damage',()=>{
    const {w,add,step}=fixture('dome');const h=add();
    brainOf(h).lastHurtAt=w.time-4;expect(step(h,1)).toBe(false);expect(h.hp).toBe(50);
    w.time+=2;h.pos.x+=8;expect(step(h,1)).toBe(true);expect(h.hp).toBe(50);expect(h.sceneryService?.phase).toBe('approach');
  });
  it('serves at most four dome patients and advances a FIFO exterior queue',()=>{
    const {w,o,add,step}=fixture('dome');const hs=Array.from({length:5},(_,i)=>add(i));
    for(const h of hs)step(h,1);
    expect(hs.map(h=>h.hp)).toEqual([53,53,53,53,50]);
    expect(sceneryServiceOccupancy(w,o.id)).toEqual({serving:4,queued:1,approaching:0});
    cancelSceneryService(w,hs[0]);hs[4].pos={...sceneryServicePoint(w,o,undefined,3)!};step(hs[4],1);
    expect(hs[4].hp).toBe(53);expect(hs[4].sceneryService?.phase).toBe('serving');
  });
  it('does not recover a moving worker merely inside the shade radius',()=>{
    const {add,step}=fixture('shade');const h=add();h.pos.x+=8;
    step(h,1);expect(h.attention).toBe(40);expect(h.status).toBe('walking');
  });
  it('restores attention only after arrival, with no excess-population recovery',()=>{
    const {add,step,sys}=fixture('shade');const h=add();step(h,2);expect(h.attention).toBe(48);
    sys.overCap.add(h.id);expect(step(h,2)).toBe(false);expect(h.attention).toBe(48);expect(h.sceneryService).toBeUndefined();
  });
  it('completes a three-second toilet visit then enforces personal cooldown across toilets',()=>{
    const {w,add,step}=fixture('porta');const h=add();step(h,2);expect(h.attention).toBe(40);
    w.time+=1;step(h,1);expect(h.attention).toBe(60);expect(h.sceneryService).toBeUndefined();
    w.time+=6;expect(step(h,3)).toBe(false);expect(h.attention).toBe(60);
    w.time+=T.portaCooldownSeconds;expect(step(h,3)).toBe(true);expect(h.attention).toBe(80);
  });
  it('allows only one toilet occupant and does not apply queued attention rewards',()=>{
    const {o,w,add,step}=fixture('porta');const a=add(),b=add(1);step(a,1);step(b,2);
    expect(b.attention).toBe(40);expect(b.sceneryService?.phase).toBe('queue');
    expect(sceneryServiceOccupancy(w,o.id)).toEqual({serving:1,queued:1,approaching:0});
  });
  it('capture, active siege, destruction and new orders release services without free rewards',()=>{
    for(const reason of ['capture','siege','destroy','order','ko','faction'] as const){
      const {w,o,add,step}=fixture('porta');const h=add();step(h,2);
      if(reason==='capture')w.sceneryCapture.get(o.id)!.faction=1;
      if(reason==='siege')w.sceneryCapture.get(o.id)!.stage='contained';
      if(reason==='destroy')w.destroyedScenery.add(o.id);
      if(reason==='order')h.order={kind:'move',to:{x:0,z:0}};
      if(reason==='ko')h.status='ko';
      if(reason==='faction')h.faction=1;
      expect(step(h,1),reason).toBe(false);expect(h.attention,reason).toBe(40);expect(h.sceneryService,reason).toBeUndefined();
    }
  });
  it('does not interrupt carrying, explicit commands or combat tasks',()=>{
    const {w,add,step}=fixture('dome');
    const h=add();h.carryingLumber=10;expect(step(h,1)).toBe(false);h.carryingLumber=0;
    h.order={kind:'defend',at:{...h.pos}};expect(step(h,1)).toBe(false);h.order=null;
    beginTask(w,h,brainOf(h),'engage');expect(step(h,1)).toBe(false);expect(h.hp).toBe(50);
  });
  it('keeps the job and returns to normal decision state on completion',()=>{
    const {add,step}=fixture('dome');const h=add();h.hp=99;step(h,1);expect(h.hp).toBe(HIPPIE.maxHp);
    expect(step(h,1)).toBe(false);expect(h.job).toBe('gather');expect(brainOf(h).task).toBe('none');
  });
  it('the full unit update uses the service without double-counting home recovery',()=>{
    const {w,o,add}=fixture('shade');const h=add();
    w.hearthOf(0)!.pos={...h.pos};
    updateHippies(w,1);expect(h.attention).toBe(44);expect(h.sceneryService?.id).toBe(o.id);
  });
  it('travels through normal navigation to an exterior rest point without teleporting',()=>{
    const {w,o,add}=fixture('shade');const h=add();
    const service=sceneryServicePoint(w,o)!;
    h.pos={...w.nav.nearestWalkable(service.x+9,service.z+5)};
    const original={...h.pos};updateHippies(w,.1);
    expect(Math.hypot(h.pos.x-original.x,h.pos.z-original.z)).toBeLessThan(2);
    for(let i=0;i<200 && h.attention<60;i++){w.time+=.1;updateHippies(w,.1);}
    expect(h.attention).toBeGreaterThanOrEqual(60);expect(w.nav.isWalkable(h.pos.x,h.pos.z)).toBe(true);
    expect(h.status).toBe('idle');expect(h.sceneryService?.phase).toBe('serving');
  });
  it('active rivals interrupt services but eliminated avatars do not',()=>{
    const {w,add,step}=fixture('dome');const h=add();const av=w.avatarOf(1);av.pos={...h.pos,y:0};
    expect(step(h,1)).toBe(false);expect(h.hp).toBe(50);
    w.factions[1].alive=false;expect(step(h,1)).toBe(true);expect(h.hp).toBe(53);
  });
  it('boss alliance shares safe local services, without transferring capacity or ownership',()=>{
    const {w,o,add,step}=fixture('dome');const h=add();w.sceneryCapture.get(o.id)!.faction=1;
    expect(step(h,1)).toBe(false);w.effigyRevealedAt=w.time;w.time+=1;
    expect(step(h,1)).toBe(true);expect(h.hp).toBe(53);expect(w.sceneryCapture.get(o.id)!.faction).toBe(1);
  });
  it('actual HP loss cancels treatment and queued reservation on the next unit tick',()=>{
    const {w,add}=fixture('dome');const h=add();updateHippies(w,1);expect(h.hp).toBe(53);
    const b=brainOf(h);b.hurt=true;b.lastHurtAt=w.time;h.hp=40;
    updateHippies(w,1);expect(h.hp).toBe(40);expect(h.sceneryService).toBeUndefined();expect(sceneryServiceOf(h)).toBeNull();
  });
});
