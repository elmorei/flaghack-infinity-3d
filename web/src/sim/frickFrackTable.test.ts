import {describe,it,expect} from 'vitest';
import type {FrickFrackSession} from './frickFrack';
import {frickFrackTotal} from './frickFrack';
import {frickFrackTableCards} from './frickFrackTable';
import {evaluateFrickFrackPoker} from './frickFrackPoker';
const card=(id:number,rank:number)=>({id,rank,suit:0,parody:0 as const});
function session():FrickFrackSession {return {id:1,revision:2,faction:0,phase:'playing',dialogueIndex:2,dialogueStartedAt:0,readyAt:0,wager:1,player:[card(1,4),card(3,2)],dealer:[card(4,6),null],result:null,message:'',defeated:[{side:'player',card:card(2,4)}],revealedCardOrder:[1,4,2,3]};}
describe('combat table tombstones',()=>{
 it('retains a defeated card in public reveal order without contributing to active total or poker',()=>{
  const s=session(), displayed=frickFrackTableCards(s,'player');
  expect(displayed.map(d=>d.card?.id)).toEqual([1,2,3]);
  expect(displayed.map(d=>d.defeated)).toEqual([false,true,false]);
  expect(frickFrackTotal(s.player)).toBe(6);expect(evaluateFrickFrackPoker(s.player).profitMultiplier).toBe(1);
  expect(frickFrackTableCards(s,'dealer').map(d=>d.card?.id??null)).toEqual([4,null]);
 });
 it('never duplicates active cards or mutates the authoritative hands',()=>{
  const s=session();s.defeated!.push({side:'player',card:card(1,4)});
  expect(frickFrackTableCards(s,'player')).toHaveLength(3);expect(s.player.map(c=>c.id)).toEqual([1,3]);
 });
});
