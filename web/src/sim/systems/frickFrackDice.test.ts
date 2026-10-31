import { describe, expect, it } from 'vitest';
import { newMatch } from './econ/testkit';
import { Rng } from '../rng';
import { FRICK_FRACK_ROLL_SECONDS, frickFrackTarget, frickFrackTotal } from '../frickFrack';
import { frickFrackDealerSoft } from '../frickFrackArcana';
import { evaluateFrickFrackPoker } from '../frickFrackPoker';
import { initializeFrickFrack, offerFrickFrackFlag, cmdFrickFrack, resetFrickFrackEntropy, updateFrickFrack } from './frickFrack';
import { frickFrackFromWire, frickFrackWire } from '../../net/frickFrack';
import { SnapshotEncoder } from '../../net/codec';
import { NetMirror } from '../../net/mirror';
import type { CommandOf } from '../commands';
function seedFor(face:number) { for(let n=0;n<1000;n++) { const seed=`roll-${n}`;if(new Rng(seed).int(1,6)===face)return seed; }throw new Error('No seed'); }
function table(face=1) {
 const {world:w}=newMatch('dice-table');w.factions[0].isPlayer=true;initializeFrickFrack(w);
 const av=w.avatarOf(0),wizard=w.hippies.get(w.frickFrack.wizardId)!;wizard.pos={x:av.pos.x,z:av.pos.z};
 expect(offerFrickFrackFlag(w,wizard,0,av.carried[0])).toBe(true);
 const s=w.frickFrack.sessions[0]!;
 const command=(action:CommandOf<'frickFrack'>['action'],extra:Partial<CommandOf<'frickFrack'>>={})=>cmdFrickFrack(w,{t:'frickFrack',faction:0,sessionId:s.id,revision:s.revision,action,...extra});
 for(let i=0;i<2;i++){w.time=s.readyAt;command('next');}
 resetFrickFrackEntropy(w,seedFor(face));w.time=s.readyAt;command('play');
 const ready=()=>{w.time=s.rollEndsAt!;updateFrickFrack(w);};
 const deal=()=>{ready();resetFrickFrackEntropy(w,'normal');command('bet',{wager:1});};
 return{w,av,wizard,s,command,ready,deal};
}
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
describe('host-authoritative rolled Frick-frack targets',()=>{
 it.each([1,2,3,4,5,6])('rolls face%s once, reveals before betting, and uses corresponding dealer threshold',face=>{
  const {w,av,s,command,ready}=table(face),before=[...av.carried],rev=s.revision;
  expect(s).toMatchObject({phase:'rolling',dieResult:face,target:20+face,rollNumber:1});
  expect(s.rollEndsAt!-s.rollStartedAt!).toBeCloseTo(FRICK_FRACK_ROLL_SECONDS);
  for(const action of ['bet','play','again','hit','stand'] as const)command(action,action==='bet'?{wager:1}:{});
  expect(s.revision).toBe(rev);expect(av.carried).toEqual(before);expect(s.wager).toBe(0);
  w.time=s.rollEndsAt!-.001;updateFrickFrack(w);expect(s.phase).toBe('rolling');ready();
  expect(s.phase).toBe('betting');expect(s.revision).toBe(rev+1);
  for(let i=0;i<3;i++)updateFrickFrack(w);expect(s.revision).toBe(rev+1);
  resetFrickFrackEntropy(w,'normal');command('bet',{wager:1});
  expect(s.phase).toBe('playing');expect(s.target).toBe(20+face);
  s.player=[10,10,face].map((value,i)=>({id:w.newId(),rank:i+2,suit:0,value}));
  command('stand');expect(s.result).not.toBe('lose');
  expect(frickFrackTotal(s.dealer,s.target)).toBeGreaterThanOrEqual(s.target!-4);
  expect(s.target).toBe(20+face);expect(s.dieResult).toBe(face);
 });
 it('replays identically with the same host entropy and cannot reroll with stale commands',()=>{
  const a=table(4),b=table(4);expect(a.s).toEqual(b.s);
  const stale={t:'frickFrack' as const,faction:0 as const,sessionId:a.s.id,revision:a.s.revision,action:'bet' as const,wager:1};
  a.ready();const before=copy(a.s);cmdFrickFrack(a.w,stale);expect(a.s).toEqual(before);
  a.deal();a.command('stand');const last=a.s.rollNumber;resetFrickFrackEntropy(a.w,seedFor(6));a.command('again');
  expect(a.s).toMatchObject({phase:'rolling',dieResult:6,target:26,rollNumber:last!+1,wager:0});
  const revision=a.s.revision;a.command('again');expect(a.s.revision).toBe(revision);
 });
 it('preserves one public roll through full snapshots, deltas and late joining without private shoe data',()=>{
  const {w,s,ready,deal}=table(6),encoder=new SnapshotEncoder(w);
  const mirror=NetMirror.create(w.options,copy(encoder.full()));expect(mirror.world.frickFrack.sessions[0]).toEqual(s);
  ready();w.tick++;mirror.push(copy({tick:w.tick,time:w.time,acks:{},delta:encoder.delta([]),events:[]}));mirror.catchUp();
  expect(mirror.world.frickFrack.sessions[0]).toEqual(s);
  deal();w.tick++;encoder.delta([]);const wire=copy(encoder.full());expect(JSON.stringify(wire)).not.toContain('frick-frack:dice-table');
  const late=NetMirror.create(w.options,wire).world.frickFrack.sessions[0]!;
  expect(late).toMatchObject({target:26,dieResult:6,rollNumber:1});expect(late.dealer[1]).toBeNull();
 });
 it('uses rolled targets for flexible aces, soft dealer hands and poker bust checks',()=>{
  const cards=[1,1,4].map((rank,id)=>({id,rank,suit:0}));
  expect(frickFrackTotal(cards,26)).toBe(26);expect(frickFrackTotal(cards,21)).toBe(16);
  expect(frickFrackDealerSoft([{id:1,rank:1,suit:0},{id:2,rank:10,suit:0},{id:3,rank:5,suit:0}],26)).toBe(true);
  expect(frickFrackDealerSoft([{id:1,rank:1,suit:0},{id:2,rank:10,suit:0},{id:3,rank:5,suit:0}],21)).toBe(false);
  const pair=[{id:1,rank:8,suit:0,value:10},{id:2,rank:8,suit:1,value:10},{id:3,rank:6,suit:0}];
  expect(evaluateFrickFrackPoker(pair,26).profitMultiplier).toBe(2);expect(evaluateFrickFrackPoker(pair,21).profitMultiplier).toBe(1);
 });
 it('Strength protects only above the rolled target and World rewards the exact rolled target',()=>{
  const {w,s,command,deal}=table(6);deal();s.arcana={strength:true,world:true};
  s.player=[{id:w.newId(),rank:10,suit:0},{id:w.newId(),rank:9,suit:1}];
  const card={id:w.newId(),rank:7,suit:2};w.frickFrack.sideboards[0].push(card);
  command('cheat',{cardId:card.id});expect(s.player).toContainEqual(card);expect(s.arcana.strength).toBe(true);
  expect(s.result).toBe('win');expect(s.message).toContain('You win 2 Flags.');
 });
 it('Judgement keeps the committed target and does not reroll a replay',()=>{
  const {w,s,command,deal}=table(6);deal();s.arcana={judgement:true};
  s.player=[10,10,10].map((rank)=>({id:w.newId(),rank,suit:0}));const roll=[s.target,s.dieResult,s.rollStartedAt,s.rollEndsAt,s.rollNumber];
  command('stand');expect(s.arcana?.judgementUsed).toBe(true);expect([s.target,s.dieResult,s.rollStartedAt,s.rollEndsAt,s.rollNumber]).toEqual(roll);
 });
 it.each(['exit','ko','end'] as const)('allows interruption while rolling: %s without a wager debit',cause=>{
  const {w,av,s,command}=table(2),flags=[...av.carried];
  if(cause==='exit')command('exit');else{if(cause==='ko')av.koUntil=w.time+5;else w.phase='ended';updateFrickFrack(w);}
  expect(w.frickFrack.sessions[0]).toBeUndefined();expect(av.carried).toEqual(flags);expect(s.wager).toBe(0);
 });
 it('rejects malformed/mismatched roll wire and retains old target21 snapshots',()=>{
  const {w}=table(3);const raw=copy(frickFrackWire(w.frickFrack)) as any[];
  expect(frickFrackFromWire(raw).sessions[0]?.target).toBe(23);
  for(const [index,value] of [[17,7],[18,26],[19,Infinity],[20,-1],[21,0]]){
   const bad=copy(raw);bad[1][0][index]=value;expect(frickFrackFromWire(bad).sessions[0]).toBeUndefined();
  }
  const legacy=copy(raw);legacy[1][0]=legacy[1][0].slice(0,17);legacy[1][0][3]='betting';
  expect(frickFrackTarget(frickFrackFromWire(legacy).sessions[0]!)).toBe(21);
  legacy[1][0][3]='rolling';expect(frickFrackFromWire(legacy).sessions[0]).toBeUndefined();
 });
});
