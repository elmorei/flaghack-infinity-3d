import { describe, expect, it, vi } from 'vitest';
import { createMatch } from '../setup';
import { normalizeMatch } from '../matchSettings';
import { spawnFlag, spawnHippie, spawnProjectile } from '../factory';
import { newStructureCapture } from './structureCapture';
import { sceneryServicePoint } from './sceneryBenefits';
import { dropLoose, depositToStock, takeFromStock, giveFlag } from './flags';
import { depotHolder, depotStock, getDepot, stockOwner, updateSceneryDepots, vehicleCapacity } from './sceneryDepots';
import { updateProjectiles } from './projectiles';
import { releaseTask, brainOf } from './units/brain';
import { deliveryHearth, hearthWithStock } from './units/targets';
import { unitsState } from './units/state';
import { act } from './units/act';
import { AVATAR, SIM_DT } from '../constants';
import { Simulation } from '../simulation';
import { SnapshotEncoder } from '../../net/codec';
import { NetMirror } from '../../net/mirror';
import { eliminate } from './victory';
import { flagProblems } from './rules/testWorld';
import { updateHippies } from './hippies';

function fixture(variant=0) {
  const world=createMatch({ seed:'vehicle-depots', difficulty:'normal', humans:[0], mode:'standard', match:normalizeMatch({startingSignifiers:0}) });
  world.hippies.clear();
  const o=world.map.obstacles.find(o=>o.kind==='car' && sceneryServicePoint(world,o))!;
  o.variant=variant;
  world.sceneryCapture.set(o.id,{...newStructureCapture(),faction:0});
  const holder=depotHolder(o.id), at=sceneryServicePoint(world,o)!;
  const unit=spawnHippie(world,0,at);
  function flag(owner:0|1=0) { return spawnFlag(world,{state:'loose', owner,holder:-1,pos:{x:at.x,y:0,z:at.z}}); }
  return {world,o,holder,at,unit,flag};
}

describe('captured vehicle supply depots',()=>{
  it('accepts an actual friendly thrown flag at the vehicle collision surface',()=>{
    const {world,o,holder,flag}=fixture();world.hippies.clear();
    let at={x:o.x,z:o.z+o.hz+2};
    for(let i=0;i<32;i++){
      const a=i*Math.PI/16, p={x:o.x+Math.cos(a)*(o.radius+3),z:o.z+Math.sin(a)*(o.radius+3)};
      const ray=world.collision.raycast(p.x,world.collision.groundHeight(p.x,p.z)+.8,p.z,o.x-p.x,0,o.z-p.z,10);
      if(ray?.tag===-1-o.id){at=p;break;}
    }
    const fl=flag();
    const dx=o.x-at.x,dz=o.z-at.z,d=Math.hypot(dx,dz);
    const p=spawnProjectile(world,fl.id,world.avatarOf(0).id,0,
      {x:at.x,y:world.collision.groundHeight(at.x,at.z)+.8,z:at.z},
      {x:dx/d*20,y:1,z:dz/d*20});
    fl.state='flying';fl.holder=p.id;
    for(let i=0;i<90&&world.projectiles.has(p.id);i++)updateProjectiles(world,SIM_DT);
    expect(fl.state).toBe('stock');expect(fl.holder).toBe(holder);expect(world.projectiles.has(p.id)).toBe(false);
  });
  it('releases negative-holder fetch reservations when a worker is interrupted',()=>{
    const {world,holder,unit}=fixture(),b=brainOf(unit),sys=unitsState(world);
    b.task='fetchStock';b.target=holder;sys.fetchers.set(holder,1);
    releaseTask(world,unit,b);expect(sys.fetchers.has(holder)).toBe(false);
  });

  it('preserves real depot stock through full and delta snapshots for late joiners',()=>{
    const {world,o,holder,flag}=fixture();const fl=flag();depositToStock(world,fl.id,holder);
    const encoder=new SnapshotEncoder(world);
    const mirror=NetMirror.create(world.options,JSON.parse(JSON.stringify(encoder.full())));
    expect(depotStock(mirror.world,holder)).toBe(1);
    expect(mirror.world.flags.get(fl.id)?.holder).toBe(holder);
    expect(stockOwner(mirror.world,holder)).toBe(0);
    world.sceneryCapture.get(o.id)!.faction=1;updateSceneryDepots(world);world.tick++;
    mirror.push(JSON.parse(JSON.stringify({tick:world.tick,time:world.time,acks:{},delta:encoder.delta([]),events:[]})));
    mirror.catchUp();
    expect(stockOwner(mirror.world,holder)).toBe(1);
    const late=NetMirror.create(world.options,JSON.parse(JSON.stringify(encoder.full())));
    expect(stockOwner(late.world,holder)).toBe(1);expect(late.world.flags.get(fl.id)?.owner).toBe(1);
  });
  it('restocks an avatar at the vehicle exterior through ordinary simulation',()=>{
    const {world,holder,at,flag}=fixture();world.hippies.clear();
    const fl=flag();depositToStock(world,fl.id,holder);
    const av=world.avatarOf(0);
    for(const id of [...av.carried])dropLoose(world,id,{x:0,y:0,z:0});
    av.pos={...at,y:world.collision.groundHeight(at.x,at.z)};
    const sim=new Simulation(world);
    for(let i=0;i<Math.ceil((AVATAR.restockInterval+1)/SIM_DT);i++)sim.step();
    expect(av.carried).toContain(fl.id);expect(depotStock(world,holder)).toBe(0);
  });

  it.each([[0,3],[1,6],[2,10]])('variant %s has exactly %s real slots', (variant,capacity)=>{
    const {world,o,holder,flag}=fixture(variant);
    const initial=world.flags.size;
    for(let i=0;i<capacity;i++) expect(depositToStock(world,flag().id,holder)).toBe(true);
    expect(vehicleCapacity(o)).toBe(capacity);
    const overflow=flag();
    expect(depositToStock(world,overflow.id,holder)).toBe(false);
    expect(overflow.state).toBe('loose');
    expect(depotStock(world,holder)).toBe(capacity);
    expect(world.flags.size).toBe(initial+capacity+1);
  });
  it('takes and deposits the same flag without duplicated inventory',()=>{
    const {world,holder,unit,flag}=fixture();
    const fl=flag(), n=world.flags.size;
    expect(depositToStock(world,fl.id,holder)).toBe(true);
    expect(takeFromStock(world,holder,unit.id)?.id).toBe(fl.id);
    expect(unit.carryingFlag).toBe(fl.id);
    expect(depositToStock(world,fl.id,holder)).toBe(true);
    expect(unit.carryingFlag).toBe(-1);
    expect(world.flags.size).toBe(n); expect(depotStock(world,holder)).toBe(1);
  });
  it('denies enemy and neutral service; pause retains stock but stops transfers',()=>{
    const {world,o,holder,unit,flag}=fixture(); const fl=flag();
    depositToStock(world,fl.id,holder);
    expect(depositToStock(world,flag(1).id,holder)).toBe(false);
    const enemy=spawnHippie(world,1,unit.pos);
    expect(takeFromStock(world,holder,enemy.id)).toBeNull();
    world.sceneryCapture.get(o.id)!.stage='contained';
    expect(takeFromStock(world,holder,unit.id)).toBeNull();
    expect(depositToStock(world,flag().id,holder)).toBe(false);
    expect(stockOwner(world,holder)).toBe(0);
    updateSceneryDepots(world); expect(fl.state).toBe('stock');
    expect(flagProblems(world)).toEqual([]);
  });
  it('recapture transfers stock, destruction drops it once and neutralization releases it',()=>{
    const {world,o,holder,flag}=fixture();const fl=flag();depositToStock(world,fl.id,holder);
    world.sceneryCapture.get(o.id)!.faction=1;updateSceneryDepots(world);world.tick++;
    expect(fl.owner).toBe(1);expect(fl.holder).toBe(holder);
    const n=world.flags.size;world.destroyedScenery.add(o.id);updateSceneryDepots(world);updateSceneryDepots(world);
    expect(fl.state).toBe('loose');expect(fl.holder).toBe(-1);expect(world.flags.size).toBe(n);expect(fl.owner).toBe(1);
    expect(flagProblems(world)).toEqual([]);
  });
  it('workers choose finite depot stock and deliver lumber without generating flags',()=>{
    const {world,holder,unit,flag}=fixture(); depositToStock(world,flag().id,holder);
    const b=brainOf(unit), sys=unitsState(world);
    expect(hearthWithStock(world,sys,0,unit.pos.x,unit.pos.z,b)?.id).toBe(holder);
    unit.carryingLumber=7;b.task='haul';b.target=holder;
    const depot=getDepot(world,holder,unit.pos)!;b.px=depot.servicePoint.x;b.pz=depot.servicePoint.z;
    unit.pos={...depot.servicePoint};
    expect(deliveryHearth(world,unit,b,0)?.id).toBe(holder);
    const before=world.factions[0].lumber,n=world.flags.size;
    act(world,sys,unit,b,0,1/60);
    expect(world.factions[0].lumber).toBe(before+7);expect(unit.carryingLumber).toBe(0);expect(world.flags.size).toBe(n);
  });
  it('eliminated depot owners release neutral flags that survivors can recover',()=>{
    const {world,holder,at,flag}=fixture();const fl=flag();depositToStock(world,fl.id,holder);
    eliminate(world,0,null);updateSceneryDepots(world);
    expect(fl.state).toBe('loose');expect(fl.owner).toBe(-1);expect(fl.holder).toBe(-1);
    const survivor=spawnHippie(world,1,at);
    expect(giveFlag(world,fl.id,survivor.id)).toBe(true);expect(survivor.carryingFlag).toBe(fl.id);
    expect(flagProblems(world)).toEqual([]);
  });
  it('two workers racing the final slot preserve the losing worker cargo',()=>{
    const {world,holder,unit,at,flag}=fixture();
    for(let i=0;i<2;i++)depositToStock(world,flag().id,holder);
    const other=spawnHippie(world,0,at), a=flag(),b=flag();giveFlag(world,a.id,unit.id);giveFlag(world,b.id,other.id);
    const n=world.flags.size;
    for(const h of [unit,other]){
      const brain=brainOf(h);brain.task='stow';brain.target=holder;brain.px=at.x;brain.pz=at.z;
      act(world,unitsState(world),h,brain,0,SIM_DT);
    }
    expect(depotStock(world,holder)).toBe(3);expect(unit.carryingFlag).toBe(-1);
    expect(other.carryingFlag).toBe(b.id);expect(b.state).toBe('carried');expect(world.flags.size).toBe(n);
    expect(flagProblems(world)).toEqual([]);
  });
  it('recounts negative-holder fetch reservations across ticks',()=>{
    const {world,holder,unit,flag,at}=fixture();depositToStock(world,flag().id,holder);
    const b=brainOf(unit),sys=unitsState(world);b.task='fetchStock';b.target=holder;
    b.px=at.x;b.pz=at.z;unit.pos={x:at.x+20,z:at.z};
    sys.nextAllocAt.fill(Infinity);sys.nextSweepAt=Infinity;
    const count=vi.spyOn(sys.fetchers,'set');
    updateHippies(world,0);
    expect(count).toHaveBeenCalledWith(holder,1);
    count.mockRestore();
  });
  it('full depots are skipped for flag delivery but still accept lumber',()=>{
    const {world,holder,unit,flag}=fixture();for(let i=0;i<3;i++)depositToStock(world,flag().id,holder);
    unit.carryingFlag=flag().id;
    expect(deliveryHearth(world,unit,brainOf(unit),0)?.id).not.toBe(holder);
    unit.carryingFlag=-1;unit.carryingLumber=2;
    expect(deliveryHearth(world,unit,brainOf(unit),0)?.id).toBe(holder);
  });
});
