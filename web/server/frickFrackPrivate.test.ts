import { describe, expect, it } from 'vitest';
import { Room } from './room';
import { setFrickFrackPrivateView } from '../src/sim/frickFrackPrivate';
import type { World } from '../src/sim/world';
import type { FrickFrackPrivateView } from '../src/sim/frickFrackPrivate';
function privateWorld(): World {
 return { phase:'playing',time:10,factions:{0:{alive:true},1:{alive:true}},frickFrack:{wizardId:1,sessions:{0:{id:7,revision:3,faction:0,phase:'playing',dialogueIndex:0,dialogueStartedAt:0,readyAt:0,wager:1,player:[],dealer:[{id:1,rank:2,suit:0},null],result:null,message:''}},sideboards:{0:[],1:[],2:[],3:[]},drops:[]} } as unknown as World;
}
const privateView:FrickFrackPrivateView={sessionId:7,revision:3,kind:'dealer',cards:[{id:987654,rank:14,suit:2,tarot:true}],expiresAt:13};

// Exercise the production dispatch against authenticated room-player records, without sockets/timers.
describe('private Arcana recipient dispatch',()=>{
 it('sends only to owner, deduplicates, clears expiry and resends after epoch change',()=>{
  const world=privateWorld(), sent:{conn:unknown;msg:any}[]=[];
  const owner={inMatch:true,conn:{id:'owner'},seat:0,inputEpoch:4};
  const rival={inMatch:true,conn:{id:'rival'},seat:1,inputEpoch:8};
  const watcher={inMatch:true,conn:{id:'watcher'},seat:null,inputEpoch:1};
  const room=Object.assign(Object.create(Room.prototype),{match:{world},players:new Map<string, {inMatch:boolean;conn:{id:string};seat:number|null;inputEpoch:number}>([['owner',owner],['rival',rival],['watcher',watcher]]),privateKnowledgeSent:new WeakMap(),send:(conn:unknown,msg:any)=>sent.push({conn,msg})});
  setFrickFrackPrivateView(world,0,privateView);room.sendPrivateKnowledge();
  expect(sent).toHaveLength(1);expect(sent[0]).toEqual({conn:owner.conn,msg:{t:'frickFrackPrivate',seat:0,inputEpoch:4,view:privateView}});
  room.sendPrivateKnowledge();expect(sent).toHaveLength(1);
  owner.inputEpoch++;room.sendPrivateKnowledge();expect(sent).toHaveLength(2);expect(sent[1].msg.inputEpoch).toBe(5);
  world.time=13;room.sendPrivateKnowledge();expect(sent).toHaveLength(3);expect(sent[2].msg.view).toBeNull();expect(sent.every(x=>x.conn===owner.conn)).toBe(true);
 });
});
