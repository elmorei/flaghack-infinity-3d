import { describe,expect,it } from 'vitest';
import { createMatch } from '../sim/setup';
import { spawnHippie, spawnFlag } from '../sim/factory';
import { newStructureCapture } from '../sim/systems/structureCapture';
import { depotHolder, updateSceneryDepots } from '../sim/systems/sceneryDepots';
import { SnapshotEncoder } from './codec';
import { NetMirror } from './mirror';
const wire=<T>(x:T):T=>JSON.parse(JSON.stringify(x));
describe('scenery services replication',()=>{
  it('replicates exact service occupancy and finite depot inventory in snapshots and deltas',()=>{
    const w=createMatch({seed:'services-wire',mode:'standard',difficulty:'normal',humans:[0,1,2,3]});
    const porta=w.map.obstacles.find(o=>o.kind==='porta')!,car=w.map.obstacles.find(o=>o.kind==='car')!;
    for(const o of [porta,car])w.sceneryCapture.set(o.id,{...newStructureCapture(),faction:0});
    const h=spawnHippie(w,0,{x:porta.x+4,z:porta.z}); h.sceneryService={id:porta.id,phase:'queue'};
    const fl=spawnFlag(w,{owner:0,state:'stock',pos:{x:car.x,y:0,z:car.z},holder:depotHolder(car.id)});
    const encoder=new SnapshotEncoder(w),peer=NetMirror.create(w.options,wire(encoder.full()));
    expect(peer.world.hippies.get(h.id)?.sceneryService).toEqual(h.sceneryService);
    expect(peer.world.flags.get(fl.id)?.holder).toBe(depotHolder(car.id)); expect(peer.world.stockCount(0)).toBe(w.stockCount(0));
    h.sceneryService={id:porta.id,phase:'serving'};
    w.sceneryCapture.get(car.id)!.faction=1; updateSceneryDepots(w); w.tick++; w.time++;
    peer.push(wire({tick:w.tick,time:w.time,acks:{},delta:encoder.delta([]),events:[]})); peer.catchUp();
    expect(peer.world.hippies.get(h.id)?.sceneryService?.phase).toBe('serving'); expect(peer.world.flags.get(fl.id)?.owner).toBe(1);
    expect(peer.world.stockCount(1)).toBe(w.stockCount(1));
    h.sceneryService=undefined; w.destroyedScenery.add(car.id); updateSceneryDepots(w); w.tick++;w.time++;
    peer.push(wire({tick:w.tick,time:w.time,acks:{},delta:encoder.delta([]),events:[]})); peer.catchUp();
    const late=NetMirror.create(w.options,wire(encoder.full()));
    for(const m of [peer,late]) {expect(m.world.hippies.get(h.id)?.sceneryService).toBeUndefined(); expect(m.world.flags.get(fl.id)?.state).toBe('loose');}
  });
});
