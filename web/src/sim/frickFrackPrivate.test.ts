import { describe, expect, it } from 'vitest';
import type { World } from './world';
import { clearFrickFrackPrivateViews, getFrickFrackPrivateView as get, setFrickFrackPrivateView as set } from './frickFrackPrivate';
import type { FrickFrackPrivateView } from './frickFrackPrivate';
import { frickFrackWire } from '../net/frickFrack';
export function privateWorld(): World {
 return { phase:'playing',time:10,factions:{0:{alive:true},1:{alive:true}},frickFrack:{wizardId:1,sessions:{0:{id:7,revision:3,faction:0,phase:'playing',dialogueIndex:0,dialogueStartedAt:0,readyAt:0,wager:1,player:[],dealer:[{id:1,rank:2,suit:0},null],result:null,message:''}},sideboards:{0:[],1:[],2:[],3:[]},drops:[]} } as unknown as World;
}
export const privateView:FrickFrackPrivateView={sessionId:7,revision:3,kind:'dealer',cards:[{id:987654,rank:14,suit:2,tarot:true}],expiresAt:13};
describe('recipient-only Arcana knowledge',()=>{
 it('never puts knowledge into public world serialization or wire',()=>{const w=privateWorld(); const before=JSON.stringify(w);set(w,0,privateView);expect(JSON.stringify(w)).toBe(before);expect(JSON.stringify(frickFrackWire(w.frickFrack))).not.toContain('987654');expect(get(w,1)).toBeNull();expect(get(w,0)?.cards).toEqual(privateView.cards);});
 it('waits for delayed mirror revision and rejects stale updates',()=>{const w=privateWorld();w.frickFrack.sessions[0]!.revision=2;set(w,0,privateView);expect(get(w,0)).toBeNull();w.frickFrack.sessions[0]!.revision=3;expect(get(w,0)).not.toBeNull();set(w,0,{...privateView,revision:2});expect(get(w,0)?.revision).toBe(3);set(w,0,null);set(w,0,privateView);expect(get(w,0)).toBeNull();});
 it('expires and hides knowledge after action, outcome, elimination, or session end',()=>{for(const change of [(w:World)=>{w.time=13},(w:World)=>{w.frickFrack.sessions[0]!.revision++},(w:World)=>{w.frickFrack.sessions[0]!.phase='result'},(w:World)=>{w.factions[0].alive=false},(w:World)=>{delete w.frickFrack.sessions[0]},(w:World)=>{w.phase='ended' as World['phase']}]){const w=privateWorld();set(w,0,privateView);change(w);expect(get(w,0)).toBeNull();}});
 it('copies cards and clears all knowledge for reconnect/world disposal',()=>{const w=privateWorld();set(w,0,privateView);get(w,0)!.cards[0].rank=1;expect(get(w,0)!.cards[0].rank).toBe(14);clearFrickFrackPrivateViews(w);expect(get(w,0)).toBeNull();});
});
