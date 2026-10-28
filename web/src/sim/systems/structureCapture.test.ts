import { Brain } from '../../ai/brain';
import { structureDefenseFlag } from '../../ai/pilot';
import { describe, expect, it } from 'vitest';
import { CAPTURE, BREW_TIME } from '../constants';
import { spawnBuilding, spawnHippie, spawnFlag, spawnPiece } from '../factory';
import { normalizeMatch } from '../matchSettings';
import { createMatch } from '../setup';
import { captureStructure, capturePiece, updateStructureCapture } from './structureCapture';
import { updateCapture } from './capture';
import { sceneryBenefitActive } from './sceneryBenefits';
import { recruitNear } from './recruitment';
import { updateBuildings } from './buildings';
import { attachPiece, isSupported, cmdDemolish } from './pieces';
import { SnapshotEncoder } from '../../net/codec';
import { NetMirror } from '../../net/mirror';
import { planEnclosure } from '../lattice/planner';
import { freeCost, plantFresh, runRules } from './rules/testWorld';

function fixture() {
  const w = createMatch({ seed: 'capture-structures', difficulty: 'normal', mode: 'standard', humans: [0,1,2,3], match: normalizeMatch({ maxSignifiers: 0 }) });
  w.tide.nextAt = Infinity;
  for (const av of w.avatars.values()) av.pos = { x: -1000, y: 0, z: -1000 };
  for (const h of w.hippies.values()) h.pos = { x: -1000, z: -1000 };
  const facet = w.lattice.facets.find(f => !f.boundary && Math.hypot(f.cx, f.cz) < 30)!;
  const b = spawnBuilding(w, 'workshop', 1, facet.id, 1);
  const survey = (owner: number | null) => { w.survey.facetSurvey.fill(owner === null ? 0 : 1 << owner); w.survey.version++; };
  const step = (dt: number) => { w.time += dt; updateStructureCapture(w,dt); };
  return { w,b,facet,survey,step };
}

describe('independent structure Survey capture', () => {
  it('needs an enclosing Survey, not player proximity', () => {
    const {w,b,survey,step} = fixture(); survey(null); w.avatarOf(0).pos = {...b.pos,y:0}; step(30);
    expect(b.faction).toBe(1); expect(b.capture!.pressure[0]).toBe(0);
  });
  it('captures only the target after the same pressure and overwrite delay', () => {
    const {w,b,survey,step} = fixture(); const hearth = w.hearthOf(1)!;
    const hp = b.hp; survey(0); step(100/CAPTURE.baseRate);
    expect(b.capture!.stage).toBe('overwritten'); expect(b.faction).toBe(1);
    step(CAPTURE.overwriteTime-.01); expect(b.faction).toBe(1); step(.02);
    expect(b.faction).toBe(0); expect(b.hp).toBe(hp); expect(b.disabled).toBe(false);
    expect(hearth.faction).toBe(1); expect(w.factions[1].alive).toBe(true);
    expect(w.factions[0].stats.captures).toBe(0);
  });
  it('owner holding within altar radius contests at the same multiplier', () => {
    const {w,b,survey,step} = fixture(); w.avatarOf(1).pos={...b.pos,y:0}; survey(0); step(1);
    expect(b.capture!.stage).toBe('contested'); expect(b.capture!.pressure[0]).toBeCloseTo(6*.6);
  });
  it('decays broken-loop pressure and resolves multiple attackers deterministically', () => {
    const {b,w,facet,survey,step} = fixture(); survey(0); step(2); survey(null); step(1);
    expect(b.capture!.pressure[0]).toBe(9); expect(['safe','threatened']).toContain(b.capture!.stage);
    w.survey.facetSurvey.fill((1<<0)|(1<<2)); w.survey.version++; step(1); expect(b.capture!.attacker).toBe(0);
  });
  it('honors irreversible overwrite but cancels when attacker eliminated', () => {
    const {b,w,survey,step} = fixture(); survey(0); step(20); survey(null); w.factions[0].alive=false; step(3);
    expect(b.faction).toBe(1); expect(b.capture!.stage).toBe('safe');
  });
  it('captures neutral functional buildings and lets AI factions capture them', () => {
    const {b,survey,step} = fixture(); b.faction=-1; survey(2); step(20); step(3);
    expect(b.faction).toBe(2);
  });
  it('does not heal or complete captured damaged/unbuilt buildings', () => {
    const {w,b}=fixture(); b.hp=0; b.disabled=true; b.built=.4;
    expect(captureStructure(w,b,0)).toBe(true); expect(b.hp).toBe(0); expect(b.disabled).toBe(true); expect(b.built).toBe(.4);
  });
  it('captured drum circle recruits for the new owner without converting old people', () => {
    const {w,b}=fixture(); b.kind='drumcircle'; const neutral=spawnHippie(w,-1,{...b.pos}); const loyal=spawnHippie(w,1,{...b.pos});
    captureStructure(w,b,0); expect(recruitNear(w,b)).toBe(true); expect(neutral.faction).toBe(0); expect(loyal.faction).toBe(1);
  });
  it('captured lab awards a paid batch to the new owner only', () => {
    const {w,b}=fixture(); b.kind='druglab'; b.lab={brewing:'saffron',progress:1-.1/BREW_TIME,queue:[]};
    const old=w.factions[1].drugs.saffron; const next=w.factions[0].drugs.saffron;
    captureStructure(w,b,0); updateBuildings(w,.2);
    expect(w.factions[0].drugs.saffron).toBe(next+1); expect(w.factions[1].drugs.saffron).toBe(old);
  });
  it('transfers stored flags, not planted or carried flags', () => {
    const {w,b}=fixture();
    const stock=spawnFlag(w,{state:'stock',owner:1,holder:b.id,pos:{...b.pos,y:0}});
    const loose=spawnFlag(w,{state:'loose',owner:1,holder:-1,pos:{...b.pos,y:0}});
    captureStructure(w,b,0); expect(stock.owner).toBe(0); expect(loose.owner).toBe(1);
  });
  it('applies defending Signifiers and wards just as for Hearths', () => {
    const {w,b,survey,step}=fixture();
    spawnHippie(w,1,{...b.pos}); spawnBuilding(w,'ward',1,b.facet,1);
    survey(0); step(1); expect(b.capture!.pressure[0]).toBeCloseTo(CAPTURE.baseRate*CAPTURE.defenderMult*CAPTURE.wardMult);
  });
  it('does not transfer command centers or hearths via ordinary capture', () => {
    const {w}=fixture(); expect(captureStructure(w,w.hearthOf(1)!,0)).toBe(false); expect(captureStructure(w,w.gccOf(1)!,0)).toBe(false);
  });
  it('cancels pending capture on boss alliance and prevents direct transfer', () => {
    const {w,b,survey,step}=fixture(); survey(0); step(20); w.effigyRevealedAt=w.time; updateCapture(w,1);
    expect(b.capture).toBeNull(); expect(captureStructure(w,b,0)).toBe(false); expect(b.faction).toBe(1);
  });
  it('replicates pressure and owner to both existing peers and late joins', () => {
    const {w,b,survey,step}=fixture(); survey(0); step(1); w.drainEvents();
    const enc=new SnapshotEncoder(w); const mirror=NetMirror.create(w.options,JSON.parse(JSON.stringify(enc.full())));
    expect(mirror.world.buildings.get(b.id)!.capture).toEqual(b.capture);
    step(20); step(3); w.tick++; const events=w.drainEvents(); const frame=JSON.parse(JSON.stringify({tick:w.tick,time:w.time,acks:{},delta:enc.delta(events),events}));
    mirror.push(frame); mirror.catchUp(); expect(mirror.world.buildings.get(b.id)!.faction).toBe(0);
    expect(mirror.world.buildings.get(b.id)!.capture).toEqual(b.capture);
    const late=NetMirror.create(w.options,JSON.parse(JSON.stringify(enc.full()))); expect(late.world.buildings.get(b.id)!.faction).toBe(0);
  });
  it('uses a real planted loop through production capture updates', () => {
    const {w,b}=fixture(); const loop=planEnclosure(w.lattice,{x:b.pos.x,z:b.pos.z,minRadius:15,cost:freeCost(w,0)});
    expect(loop).not.toBeNull(); plantFresh(w,0,loop!); runRules(w,21); expect(b.faction).toBe(0);
  });
  it('captures neutral map structures, never stages or natural scenery', () => {
    const {w,survey,step}=fixture(); survey(0); step(20); step(3);
    const claimed = [...w.sceneryCapture].filter(([,h])=>h.faction===0);
    expect(claimed.length).toBeGreaterThan(0);
    for (const [id] of claimed) expect(['tent','dome','shade','porta','art','car']).toContain(w.map.obstacles.find(o=>o.id===id)!.kind);
    for (const o of w.map.obstacles.filter(o=>['stage','effigy','tree','rock'].includes(o.kind))) expect(w.sceneryCapture.has(o.id)).toBe(false);
  });
  it('neutral ownership can be contested and recaptured, and survives a late join', () => {
    const {w,survey,step}=fixture(); survey(0); step(20); step(3);
    const [id, state] = [...w.sceneryCapture].find(([,h])=>h.faction===0)!;
    const o=w.map.obstacles.find(o=>o.id===id)!; w.avatarOf(0).pos={x:o.x,y:0,z:o.z};
    survey(1); step(1); expect(state.stage).toBe('contested'); expect(state.pressure[1]).toBeGreaterThan(0);
    w.avatarOf(0).pos={x:-1000,y:0,z:-1000}; step(20); step(3); expect(state.faction).toBe(1);
    const encoder=new SnapshotEncoder(w); const mirror=NetMirror.create(w.options,JSON.parse(JSON.stringify(encoder.full())));
    expect(mirror.world.sceneryCapture.get(id)).toEqual(state);
    w.destroyedScenery.add(id); step(.1); expect(w.sceneryCapture.has(id)).toBe(false);
  });
  it('an off-map footprint remains immune even if its center facet is covered', () => {
    const {w,survey,step}=fixture(); const source=w.map.obstacles.find(o=>o.kind==='tent')!;
    const id=Math.max(...w.map.obstacles.map(o=>o.id))+1;
    w.map.obstacles.push({...source,id,x:w.map.half-1,z:0,shape:'circle',radius:5,hx:5,hz:5});
    survey(0); step(20); step(3); expect(w.sceneryCapture.has(id)).toBe(false);
  });
  it('captures walls, floors and ramps without changing their health or support geometry', () => {
    const {w,facet,survey,step}=fixture();
    const wall=spawnPiece(w,'wall',1,facet.edges[0],-1,0,-1);
    const floor=spawnPiece(w,'floor',1,-1,facet.id,1,-1);
    const ramp=spawnPiece(w,'ramp',1,-1,facet.id,2,0);
    const pieces=[wall,floor,ramp]; for(const p of pieces) {p.hp=17;p.shapeIds=[123+p.id];}
    survey(0); step(20); step(3);
    for(const p of pieces) {expect(p.faction).toBe(0);expect(p.hp).toBe(17);expect(p.shapeIds).toEqual([123+p.id]);}
    const mirror=NetMirror.create(w.options,JSON.parse(JSON.stringify(new SnapshotEncoder(w).full())));
    for(const p of pieces) {expect(mirror.world.pieces.get(p.id)!.faction).toBe(0);expect(mirror.world.pieces.get(p.id)!.capture).toEqual(p.capture);}
  });

  it('AI defends a visible ordinary structure by pulling an actual critical loop flag', () => {
    const {w,b}=fixture(); const loop=planEnclosure(w.lattice,{x:b.pos.x,z:b.pos.z,minRadius:15,cost:freeCost(w,0)})!;
    plantFresh(w,0,loop); runRules(w,.1); w.avatarOf(1).pos={...b.pos,y:0};
    const chosen=structureDefenseFlag(new Brain(w,1,0),w.avatarOf(1));
    expect(chosen).toBeGreaterThanOrEqual(0); expect(w.flags.get(chosen)!.owner).toBe(0);
    b.faction=0; b.capture=null; expect(structureDefenseFlag(new Brain(w,1,0),w.avatarOf(1))).toBe(-1);
  });

  it('retains claimed scenery allegiance but clears pressure on alliance reset', () => {
    const {w,survey,step}=fixture();survey(0);step(20);step(3);
    const [id,state]=[...w.sceneryCapture].find(([,h])=>h.faction===0)!;
    survey(1);step(1);w.effigyRevealedAt=w.time;updateCapture(w,1);
    expect(w.sceneryCapture.get(id)!.faction).toBe(0);expect(state.stage).toBe('safe');expect(state.attacker).toBeNull();expect(state.pressure[1]).toBe(0);
  });
  it('replicates claimed scenery recapture and destruction deletion to an existing peer', () => {
    const {w,survey,step}=fixture();survey(0);step(20);step(3);
    const [id]=[...w.sceneryCapture].find(([,h])=>h.faction===0)!;
    w.drainEvents();const enc=new SnapshotEncoder(w);const peer=NetMirror.create(w.options,JSON.parse(JSON.stringify(enc.full())));
    const flush=()=>{w.tick++;const events=w.drainEvents();peer.push(JSON.parse(JSON.stringify({tick:w.tick,time:w.time,acks:{},delta:enc.delta(events),events})));peer.catchUp();};
    survey(1);step(20);step(3);flush();expect(peer.world.sceneryCapture.get(id)!.faction).toBe(1);
    w.destroyedScenery.add(id);step(.1);flush();expect(peer.world.sceneryCapture.has(id)).toBe(false);expect(peer.world.destroyedScenery.has(id)).toBe(true);
  });
  it('capture keeps mixed-owner supports and moves demolition permission to the new owner', () => {
    const {w,facet}=fixture();const lower=spawnPiece(w,'floor',1,-1,facet.id,0,-1);attachPiece(w,lower);
    const upper=spawnPiece(w,'floor',1,-1,facet.id,1,-1);attachPiece(w,upper);
    const shapes=[...lower.shapeIds];capturePiece(w,lower,0);
    expect(upper.faction).toBe(1);expect(isSupported(w,'floor',-1,facet.id,1,-1)).toBe(true);expect(lower.shapeIds).toEqual(shapes);
    cmdDemolish(w,{t:'demolish',faction:1,pieceId:lower.id});expect(w.pieces.has(lower.id)).toBe(true);
    cmdDemolish(w,{t:'demolish',faction:0,pieceId:lower.id});expect(w.pieces.has(lower.id)).toBe(false);
  });

});

describe('optional Building Capture', () => {
  it('blocks direct and surveyed building/piece/neutral-scenery captures, but leaves altar capture active', () => {
    const { w, b, facet, survey, step } = fixture();
    w.options.match!.buildingCapture = false;
    const piece = spawnPiece(w, 'wall', 1, facet.edges[0], -1, 0, -1);
    survey(0); step(20); step(3);
    expect(b.faction).toBe(1); expect(b.capture ?? null).toBeNull();
    expect(piece.faction).toBe(1); expect(piece.capture ?? null).toBeNull();
    expect(w.sceneryCapture.size).toBe(0);
    expect(captureStructure(w, b, 0)).toBe(false);
    expect(capturePiece(w, piece, 0)).toBe(false);
    b.faction = -1; expect(captureStructure(w, b, 0)).toBe(false);
    // Hearth capture is its own rule: independent progress must still advance.
    const hearth = w.hearthOf(1)!;
    updateCapture(w, 20);
    expect(hearth.hearth!.stage).toBe('overwritten');
    w.time += CAPTURE.overwriteTime + .01; updateCapture(w, .01);
    expect(hearth.faction).toBe(0);
  });

  it('clears stale pressure without stripping ownership, stock, geometry or captured benefits', () => {
    const { w, b, facet, survey, step } = fixture();
    const piece = spawnPiece(w, 'wall', 1, facet.edges[0], -1, 0, -1);
    const stock = spawnFlag(w, { state: 'stock', owner: 1, holder: b.id, pos: { ...b.pos, y: 0 } });
    survey(0); step(20); step(3);
    expect(b.faction).toBe(0); expect(piece.faction).toBe(0);
    const claims = [...w.sceneryCapture].filter(([, state]) => state.faction === 0);
    expect(claims.length).toBeGreaterThan(0);
    const hp = b.hp, shapeIds = [...piece.shapeIds];
    survey(2); step(20); // Even a pending overwrite cannot finish while disabled.
    w.options.match!.buildingCapture = false; step(3);
    expect(b.faction).toBe(0); expect(b.hp).toBe(hp); expect(b.capture).toBeNull();
    expect(piece.faction).toBe(0); expect(piece.shapeIds).toEqual(shapeIds); expect(piece.capture).toBeNull();
    expect(stock.owner).toBe(0);
    for (const [id] of claims) expect(w.sceneryCapture.get(id)).toMatchObject({ faction: 0, stage: 'safe', attacker: null, pressure: { 0: 0, 1: 0, 2: 0, 3: 0 } });
    for (const [id] of claims) expect(sceneryBenefitActive(w, id)).toBe(true);
    const peer = NetMirror.create(w.options, JSON.parse(JSON.stringify(new SnapshotEncoder(w).full())));
    expect(peer.world.options.match?.buildingCapture).toBe(false);
    expect(peer.world.sceneryCapture).toEqual(w.sceneryCapture);
    // Restoring this fixture option requires a fresh full pressure cycle, even with unchanged geometry.
    w.options.match!.buildingCapture = true; step(.1);
    expect(b.faction).toBe(0); expect(b.capture!.pressure[2]).toBeCloseTo(CAPTURE.baseRate * .1);
  });

  it('keeps the AI from defending disabled capture pressure', () => {
    const { w, b } = fixture();
    const loop = planEnclosure(w.lattice, { x: b.pos.x, z: b.pos.z, minRadius: 15, cost: freeCost(w, 0) })!;
    plantFresh(w, 0, loop); runRules(w, .1); w.avatarOf(1).pos = { ...b.pos, y: 0 };
    expect(structureDefenseFlag(new Brain(w, 1, 0), w.avatarOf(1))).toBeGreaterThanOrEqual(0);
    w.options.match!.buildingCapture = false;
    expect(structureDefenseFlag(new Brain(w, 1, 0), w.avatarOf(1))).toBe(-1);
  });
});
