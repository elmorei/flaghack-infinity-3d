import { describe, expect, it } from 'vitest';
import { createMatch } from '../sim/setup';
import { SnapshotEncoder } from './codec';
import { NetMirror } from './mirror';
import { parseCommand } from './validate';
import { frickFrackWire, frickFrackFromWire } from './frickFrack';
import { WORLD_FIELDS, CODECS } from './schema';
const wire = <T>(v:T):T => JSON.parse(JSON.stringify(v));
const options = {seed:'frick-wire',mode:'standard' as const,difficulty:'normal' as const,humans:[0 as const]};
describe('Frick-frack public wire and commands', () => {
  it('accepts exact bounded commands and rejects payload smuggling', () => {
    const base={t:'frickFrack',faction:0,sessionId:1,revision:0};
    for (const action of ['next','play','decline','hit','stand','again','exit']) expect(parseCommand({...base,action})).toEqual({...base,action});
    expect(parseCommand({...base,action:'bet',wager:2})).toEqual({...base,action:'bet',wager:2});
    expect(parseCommand({...base,action:'cheat',cardId:1})).toEqual({...base,action:'cheat',cardId:1});
    for (const wager of [0,-1,.5,NaN,Infinity,'2',2147483648]) expect(parseCommand({...base,action:'bet',wager})).toBeNull();
    for (const revision of [-1,.1,NaN,'0']) expect(parseCommand({...base,revision,action:'hit'})).toBeNull();
    for (const action of ['hit','stand','exit','play']) expect(parseCommand({...base,action,wager:2})).toBeNull();
    expect(parseCommand({...base,action:'bet'})).toBeNull();
    expect(parseCommand({...base,action:'cheat',cardId:1,rank:1})).toBeNull();
    expect(parseCommand({...base,action:'settle',win:true})).toBeNull();
  });
  it('replicates wizard, public cards, drops, sideboards and session transitions with no hidden hole card', () => {
    const world=createMatch(options), state=world.frickFrack;
    expect(WORLD_FIELDS.length).toBeLessThan(31);
    expect(CODECS.hippies.fieldCount).toBeLessThan(31);
    const wizard=world.hippies.get(state.wizardId)!;
    expect(wizard.wizard).toBe(true);
    state.sessions[0]={id:91,revision:3,faction:0,phase:'playing',dialogueIndex:2,dialogueStartedAt:0,readyAt:3,wager:2,
      player:[{id:1,rank:10,suit:0}],dealer:[{id:2,rank:6,suit:1},{id:8675309,rank:9,suit:2}],result:null,message:''};
    state.sideboards[0]=[{id:3,rank:1,suit:0}];
    state.drops=[{id:4,card:{id:5,rank:3,suit:1},pos:{x:2,z:3},createdAt:1}];
    const encoder=new SnapshotEncoder(world), full=wire(encoder.full());
    expect(JSON.stringify(full)).not.toContain('8675309');
    const mirror=NetMirror.create(world.options,full);
    expect(mirror.world.hippies.get(wizard.id)?.wizard).toBe(true);
    expect(mirror.world.frickFrack.sessions[0]?.dealer).toEqual([{id:2,rank:6,suit:1},null]);
    expect(mirror.world.frickFrack.sideboards[0]).toEqual(state.sideboards[0]);
    expect(mirror.world.frickFrack.drops).toEqual(state.drops);
    state.sessions[0].phase='result'; state.sessions[0].result='win'; state.sessions[0].revision++;
    world.tick++;world.time+=1/60;
    mirror.push(wire({tick:world.tick,time:world.time,acks:{},delta:encoder.delta([]),events:[]}));mirror.catchUp();
    expect(mirror.world.frickFrack.sessions[0]).toEqual(state.sessions[0]);
    delete state.sessions[0];state.drops=[];state.sideboards[0]=[];world.tick++;world.time+=1/60;
    mirror.push(wire({tick:world.tick,time:world.time,acks:{},delta:encoder.delta([]),events:[]}));mirror.catchUp();
    expect(mirror.world.frickFrack.sessions[0]).toBeUndefined();
    expect(NetMirror.create(world.options,wire(encoder.full())).world.frickFrack.drops).toEqual([]);
  });
  it('replicates defeated table slots on full, delta and late join without exposing the hole card', () => {
    const world=createMatch(options), state=world.frickFrack;
    const dead={id:301,rank:3,suit:0,parody:0 as const};
    state.sessions[0]={id:92,revision:1,faction:0,phase:'playing',dialogueIndex:2,dialogueStartedAt:0,readyAt:3,wager:1,
      player:[{id:302,rank:5,suit:0}],dealer:[{id:303,rank:4,suit:0,parody:1},{id:8675309,rank:7,suit:0}],result:null,message:'',
      defeated:[{side:'player',card:dead}],revealedCardOrder:[302,303,301]};
    const encoder=new SnapshotEncoder(world), full=wire(encoder.full());
    expect(JSON.stringify(full)).not.toContain('8675309');
    const mirror=NetMirror.create(world.options,full);
    expect(mirror.world.frickFrack.sessions[0]?.defeated).toEqual(state.sessions[0].defeated);
    state.sessions[0].defeated!.push({side:'dealer',card:{id:304,rank:2,suit:0,parody:3}});
    state.sessions[0].revealedCardOrder!.push(304);state.sessions[0].revision++;world.tick++;world.time+=1/60;
    const delta=wire({tick:world.tick,time:world.time,acks:{},delta:encoder.delta([]),events:[]});
    expect(JSON.stringify(delta)).not.toContain('8675309');mirror.push(delta);mirror.catchUp();
    for(const replica of [mirror,NetMirror.create(world.options,wire(encoder.full()))]) {
      expect(replica.world.frickFrack.sessions[0]?.defeated).toEqual(state.sessions[0].defeated);
      expect(replica.world.frickFrack.sessions[0]?.revealedCardOrder).toEqual([302,303,301,304]);
      expect(replica.world.frickFrack.sessions[0]?.player).toEqual(state.sessions[0].player);
      expect(replica.world.frickFrack.sessions[0]?.dealer[1]).toBeNull();
    }
  });
  it('decodes only valid bounded public fields and ignores unexpected private properties', () => {
    const world=createMatch(options);
    const value=frickFrackWire(world.frickFrack);
    expect(frickFrackFromWire(value)).toEqual(world.frickFrack);
    expect(frickFrackFromWire([1,[],[],[[1,[2,99,1],0,0,0]]]).drops).toEqual([]);
    expect(frickFrackFromWire(null).wizardId).toBe(-1);
  });
});
