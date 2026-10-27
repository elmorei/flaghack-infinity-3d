import { describe, expect, it } from 'vitest';
import { createMatch } from '../sim/setup';
import { spawnBuilding, spawnPiece } from '../sim/factory';
import { consumeBuilding } from '../sim/systems/boss';
import { attachPiece, destroyPiece } from '../sim/systems/pieces';
import { addWreckage, MAX_WRECKAGE } from '../sim/wreckage';
import { SnapshotEncoder } from './codec';
import { NetMirror } from './mirror';
import { WORLD_FIELDS } from './schema';
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const make = () => createMatch({ seed: 'durable-wreckage', difficulty: 'normal', humans: [0], mode: 'standard' });
describe('durable cosmetic structure wreckage', () => {
  it('records only destroyed buildings once; eating and extant disabled models are excluded', () => {
    const w = make(), facet = w.lattice.facets.find(f => !f.boundary)!;
    const b = spawnBuilding(w, 'workshop', 0, facet.id, 1); b.yaw = 1.25;
    consumeBuilding(w, b, true); consumeBuilding(w, b, true);
    expect(w.wreckage).toHaveLength(1); expect(w.wreckage[0]).toMatchObject({kind:'workshop',yaw:1.25});
    expect(w.wreckage[0].size.y).toBe(3);
    const eaten = spawnBuilding(w, 'ward', 0, facet.id, 1); consumeBuilding(w, eaten);
    consumeBuilding(w, w.hearthOf(0)!, true); expect(w.wreckage).toHaveLength(1);
  });
  it('measures real piece span and grounds collapsed elevated material; dismantling does not duplicate it', () => {
    const w = make(), facet = w.lattice.facets.find(f => !f.boundary)!;
    const p = spawnPiece(w,'wall',0,facet.edges[0],-1,0,-1); attachPiece(w,p);
    const edge = w.lattice.edges[p.edge], a=w.lattice.nodes[edge.a], b=w.lattice.nodes[edge.b];
    destroyPiece(w,p,true); expect(w.wreckage).toHaveLength(1);
    expect(w.wreckage[0].size.z).toBeCloseTo(Math.hypot(b.x-a.x,b.z-a.z));
    expect(w.wreckage[0].pos.y).toBe(w.collision.groundHeight(w.wreckage[0].pos.x,w.wreckage[0].pos.z));
    const ordinary = spawnPiece(w,'wall',0,facet.edges[1],-1,0,-1); attachPiece(w,ordinary);destroyPiece(w,ordinary);
    expect(w.wreckage).toHaveLength(1);
  });
  it('reconciles removal state on live clients, repeated frames, late joins and resets without effect replay', () => {
    const w=make(), encoder=new SnapshotEncoder(w), mirror=NetMirror.create(w.options,wire(encoder.full()));
    const facet=w.lattice.facets.find(f=>!f.boundary)!;
    const b=spawnBuilding(w,'workshop',0,facet.id,1); consumeBuilding(w,b,true); w.drainEvents();w.tick++;w.time++;
    const frame=wire({tick:w.tick,time:w.time,acks:{},delta:encoder.delta([]),events:[]});mirror.push(frame);mirror.catchUp();
    expect(mirror.world.wreckage).toHaveLength(1);mirror.push(frame);mirror.catchUp();expect(mirror.world.wreckage).toHaveLength(1);
    const late=NetMirror.create(w.options,wire(encoder.full()));expect(late.world.wreckage).toEqual(mirror.world.wreckage);
    expect(late.world.drainEvents()).toEqual([]);expect(make().wreckage).toEqual([]);
    expect(late.world.buildings.has(b.id)).toBe(false);
  });
  it('bounds oldest records and filters malformed or duplicate wire entries', () => {
    const w=make();for(let i=0;i<MAX_WRECKAGE+3;i++)addWreckage(w,{id:`piece:${i}`,kind:'wall',pos:{x:0,y:0,z:0},size:{x:1,y:2,z:3},yaw:0});
    expect(w.wreckage).toHaveLength(MAX_WRECKAGE);expect(w.wreckage[0].id).toBe('piece:3');
    const field=WORLD_FIELDS.find(f=>f.key==='wreckage')!;
    field.dec(w,[['piece:1','wall',0,0,0,100,200,300,0],['piece:1','wall',0,0,0,100,200,300,0],['piece:2','wall',0,0,0,-1,200,300,0],['no','wall',0,0,0,100,200,300,0]],w);
    expect(w.wreckage).toHaveLength(1);
  });
});
