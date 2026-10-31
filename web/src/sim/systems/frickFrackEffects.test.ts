import {describe,it,expect} from 'vitest';
import {newMatch} from './econ/testkit';
import {initializeFrickFrack,offerFrickFrackFlag,cmdFrickFrack,resetFrickFrackEntropy,closeFrickFrackSession,updateFrickFrack} from './frickFrack';
import type {CommandOf} from '../commands';
import {frickFrackWire,frickFrackFromWire} from '../../net/frickFrack';
import {getFrickFrackPrivateView} from '../frickFrackPrivate';
import {frickFrackTotal} from '../frickFrack';
function table(seed='frick-136-25') {
 const {world:w}=newMatch('effect-integration');w.factions[0].isPlayer=true;initializeFrickFrack(w);
 const av=w.avatarOf(0),h=w.hippies.get(w.frickFrack.wizardId)!;h.pos={x:av.pos.x,z:av.pos.z};
 offerFrickFrackFlag(w,h,0,av.carried[0]);
 const command=(action:CommandOf<'frickFrack'>['action'],extra:Partial<CommandOf<'frickFrack'>>={})=>{const s=w.frickFrack.sessions[0]!;cmdFrickFrack(w,{t:'frickFrack',faction:0,sessionId:s.id,revision:s.revision,action,...extra});};
 for(let i=0;i<3;i++){w.time=w.frickFrack.sessions[0]!.readyAt;command(i<2?'next':'play');}
 // Preserve the target-21 effect scenarios independently of the new roll RNG.
 const roll=w.frickFrack.sessions[0]!;roll.target=21;roll.dieResult=1;w.time=roll.rollEndsAt!;updateFrickFrack(w);
 resetFrickFrackEntropy(w,seed);command('bet',{wager:1});
 const s=w.frickFrack.sessions[0]!;expect(s.phase).toBe('playing');
 const major=(arcana:number,extra:Partial<CommandOf<'frickFrack'>>={})=>{const c={id:w.newId(),rank:0,suit:0,arcana};w.frickFrack.sideboards[0].push(c);command('cheat',{cardId:c.id,...extra});return c;};
 return {w,av,s,command,major};
}
describe('authoritative effects, privacy and reveal pipeline',()=>{
 it('privately peeks without leaking the hole in snapshots or triggering combat; Sun publicly reveals',()=>{
  const {w,s,major}=table();major(2);const peek=getFrickFrackPrivateView(w,0)!;
  expect(peek?.kind).toBe('dealer');expect(s.dealer[1]).toBeNull();
  expect(JSON.stringify(frickFrackWire(w.frickFrack))).not.toContain(String(peek.cards[0].id));
  major(19);expect(s.arcana?.sun).toBe(true);expect(s.dealer.every(Boolean)).toBe(true);
  expect(frickFrackFromWire(frickFrackWire(w.frickFrack)).sessions[0]?.dealer).toEqual(s.dealer);
  expect(getFrickFrackPrivateView(w,0)).toBeNull();
 });
 it('resolves a newly drawn weaker CCG before bust checks and retains the winning visible card',()=>{
  const {s,command}=table();const ids=s.player.map(c=>c.id);command('hit');
  expect(s.player.map(c=>c.id)).toEqual(ids);expect(s.remark).toContain('defeats');expect(s.phase).toBe('playing');
  expect(s.dealer[0]?.parody).toBe(2);expect(s.dealer[0]?.rank).toBe(4);
  expect(s.defeated).toHaveLength(1);expect(s.defeated![0].side).toBe('player');expect(s.defeated![0].card.rank).toBe(3);
  expect(s.revealedCardOrder).toContain(s.defeated![0].card.id);
 });

 it('keeps tied CCG cards as public tombstones, excludes them from future combat and effect targets',()=>{
  const {w,s,command,major}=table();
  const active=s.dealer[0]!;expect(active.parody).not.toBeUndefined();
  const tie={id:w.newId(),rank:active.rank,suit:0,parody:1 as const};w.frickFrack.sideboards[0].push(tie);
  command('cheat',{cardId:tie.id});
  expect(s.defeated?.map(d=>d.card.id)).toEqual(expect.arrayContaining([tie.id,active.id]));
  expect(s.player.some(c=>c.id===tie.id)).toBe(false);expect(s.dealer.some(c=>c?.id===active.id)).toBe(false);
  const deadCount=s.defeated!.length, next={id:w.newId(),rank:1,suit:0,parody:3 as const};w.frickFrack.sideboards[0].push(next);
  command('cheat',{cardId:next.id});expect(s.defeated).toHaveLength(deadCount);expect(s.player.some(c=>c.id===next.id)).toBe(true);
  const emperor=major(4,{targetCardIds:[tie.id]});expect(w.frickFrack.sideboards[0]).toContainEqual(emperor);
  expect(frickFrackFromWire(frickFrackWire(w.frickFrack)).sessions[0]?.defeated).toEqual(s.defeated);
 });
 it('rejects inapplicable Star without consumption and advances feedback revision',()=>{
  const {w,s,major}=table(),before=s.revision;const c=major(17);
  expect(w.frickFrack.sideboards[0]).toContainEqual(c);expect(s.revision).toBe(before+1);expect(s.remark).toContain('stays');
 });
 it('requires the two-card choice before another action and consumes a major once',()=>{
  const {w,s,major,command}=table();const c=major(6),choices=s.arcana!.choices!;
  expect(choices).toHaveLength(2);expect(w.frickFrack.sideboards[0]).not.toContainEqual(c);
  const before=s.revision;command('hit');expect(s.revision).toBe(before);command('choose',{choiceIndex:2});expect(s.revision).toBe(before);
  command('choose',{choiceIndex:0});expect(s.arcana?.choices).toBeUndefined();expect(s.revision).toBe(before+1);
 });
 it('validates Devil cost confirmation before committing any extra Flags',()=>{
  const {w,av,s,major,command}=table();const before=av.carried.length,c=major(15,{targetCardIds:[s.player[0].id]});
  expect(av.carried.length).toBe(before);expect(s.wager).toBe(1);expect(w.frickFrack.sideboards[0]).toContainEqual(c);
  command('cheat',{cardId:c.id,targetCardIds:[s.player[0].id],confirmCost:true});expect(s.wager).toBe(2);
  expect(w.frickFrack.sideboards[0]).not.toContainEqual(c);expect(av.carried.length).toBe(before-1);
 });
 it('cleans temporary cards and private views on interruption without refunding the committed wager',()=>{
  const {w,av,major}=table();major(3);major(2);const before=av.carried.length;
  expect(w.frickFrack.sideboards[0].some(c=>c.temporary)).toBe(true);closeFrickFrackSession(w,0);
  expect(w.frickFrack.sideboards[0].some(c=>c.temporary)).toBe(false);expect(getFrickFrackPrivateView(w,0)).toBeNull();expect(av.carried.length).toBe(before);
 });
 it('replays a loss once with the already escrowed wager and no second Flag debit',()=>{
  const {w,av,s,major,command}=table('frick-136-9');major(20);const before=av.carried.length;command('hit');
  expect(s.arcana?.judgementUsed).toBe(true);expect(s.arcana?.judgement).toBe(false);expect(s.wager).toBe(1);
  expect(av.carried.length).toBeGreaterThanOrEqual(before);expect(s.player.length).toBeGreaterThan(0);
  if(s.phase==='playing'){const c=major(20);expect(w.frickFrack.sideboards[0]).toContainEqual(c);}
 });
 it('fixed value1 is not an ace and value/temporary/major/sports survive the wire',()=>{
  const {w,s,major}=table();major(4,{targetCardIds:[s.player[0].id]});major(3);
  w.frickFrack.sideboards[0].push({id:w.newId(),rank:0,suit:0,arcana:21},{id:w.newId(),rank:7,suit:0,parody:3});
  const copy=frickFrackFromWire(frickFrackWire(w.frickFrack));expect(copy.sideboards[0]).toEqual(w.frickFrack.sideboards[0]);expect(copy.sessions[0]?.player).toEqual(s.player);
  expect(frickFrackTotal([{id:1,rank:1,suit:0,value:1},{id:2,rank:10,suit:0}])).toBe(11);
 });
});
describe('poker settlement economy',()=>{
 it.each([2,3,4])('multiplies only winning profit for a %s-card rank group',count=>{
  const {w,av,s,command}=table();s.player=Array.from({length:count},(_,i)=>({id:w.newId(),rank:2,suit:i,value:count===2?10:count===3?7:5}));
  if(count!==3)s.player.push({id:w.newId(),rank:1,suit:0,value:1});
  const before=av.carried.length;command('stand');expect(s.result).toBe('win');expect(av.carried.length).toBe(before+1+count);
 });
 it('adds World profit separately from the poker multiplier',()=>{
  const {w,av,s,command,major}=table();major(21);s.player=[{id:w.newId(),rank:2,suit:0,value:10},{id:w.newId(),rank:2,suit:1,value:10},{id:w.newId(),rank:1,suit:2,value:1}];
  const before=av.carried.length;command('stand');expect(s.result).toBe('win');expect(av.carried.length).toBe(before+1+2+1);
 });
 it('awards a straight printed highest card even on a nonbusting blackjack loss',()=>{
  const {w,s,command}=table();s.player=[1,2,3,4,5].map(rank=>({id:w.newId(),rank,suit:0,value:1}));const original=s.player[4].id;
  command('stand');expect(s.result).toBe('lose');const bonus=w.frickFrack.sideboards[0].at(-1)!;
  expect(bonus).toMatchObject({rank:5,suit:0});expect(bonus.id).not.toBe(original);expect(bonus.value).toBeUndefined();expect(bonus.temporary).toBeUndefined();
 });
 it('keeps a full-sleeve straight reward as a physical pickup',()=>{
  const {w,s,command}=table();s.player=[1,2,3,4,5].map(rank=>({id:w.newId(),rank,suit:0,value:1}));
  while(w.frickFrack.sideboards[0].length<12)w.frickFrack.sideboards[0].push({id:w.newId(),rank:2,suit:0});
  command('stand');expect(w.frickFrack.sideboards[0]).toHaveLength(12);expect(w.frickFrack.drops.some(d=>d.card.rank===5)).toBe(true);
 });
 it('does not award on bust, exit, or the discarded Judgement loss',()=>{
  for(const kind of ['bust','exit','replay']) {
   const {w,s,command,major}=table();if(kind==='replay')major(20);
   s.player=[1,2,3,4,5].map(rank=>({id:w.newId(),rank,suit:0,value:kind==='bust'?10:1}));
   command(kind==='exit'?'exit':'stand');expect(w.frickFrack.sideboards[0]).toHaveLength(0);expect(w.frickFrack.drops).toHaveLength(0);
   if(kind==='replay')expect(s.arcana?.judgementUsed).toBe(true);
  }
 });
});
