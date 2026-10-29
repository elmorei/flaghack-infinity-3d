import { describe, expect, it } from 'vitest';
import { createFrickFrackDeck, createFrickFrackCheatCard, frickFrackTotal, createFrickFrackState } from './frickFrack';
import { Rng } from './rng';
import { frickFrackFromWire, frickFrackWire } from '../net/frickFrack';
describe('Frick-frack combined ordinary and Minor Arcana deck', () => {
  const deck = () => { let id = 0; return createFrickFrackDeck(() => ++id); };
  it('adds all56 Minor Arcana to all52 ordinary cards with unique identities', () => {
    const cards = deck(); expect(cards).toHaveLength(136); expect(new Set(cards.map(c => c.id)).size).toBe(136);
    expect(cards.filter(c => !c.tarot && c.parody === undefined)).toHaveLength(52); expect(cards.filter(c => c.tarot)).toHaveLength(56);
    for (let suit = 0; suit < 4; suit++) {
      expect(cards.filter(c => !c.tarot && c.parody === undefined && c.suit === suit).map(c => c.rank)).toEqual(Array.from({length:13}, (_, i) => i + 1));
      expect(cards.filter(c => c.tarot && c.suit === suit).map(c => c.rank)).toEqual(Array.from({length:14}, (_, i) => i + 1));
    }
    expect(cards.filter(c => Math.min(c.rank,10) === 10)).toHaveLength(36);
    expect(cards.filter(c => c.rank === 1 && c.parody === undefined)).toHaveLength(8);
  });
  it('adds four complete literal-value CCG families without putting major effects in the main shoe', () => {
    const cards=deck();
    for (const family of [0,1,2,3]) expect(cards.filter(c=>c.parody===family).map(c=>c.rank)).toEqual([1,2,3,4,5,6,7]);
    expect(cards.some(c=>c.arcana!==undefined)).toBe(false);
    expect(frickFrackTotal([{id:1,rank:1,suit:0,parody:3},{id:2,rank:10,suit:0}])).toBe(11);
    const drops=Array.from({length:102},(_,i)=>createFrickFrackCheatCard(i,i));
    expect(drops.filter(c=>c.arcana!==undefined).map(c=>c.arcana)).toEqual(Array.from({length:22},(_,i)=>i));
    expect(drops.filter(c=>c.parody!==undefined)).toHaveLength(28);
    expect(drops.filter(c=>c.arcana===undefined&&c.parody===undefined)).toHaveLength(52);
  });
  it('shuffles all136 identities deterministically without replacing or losing either family', () => {
    const a = deck(), b = deck(); new Rng('mixed-shoe').shuffle(a); new Rng('mixed-shoe').shuffle(b);
    expect(a).toEqual(b); expect(a).not.toEqual(deck());
    expect(a.slice().sort((x,y) => x.id-y.id)).toEqual(deck());
  });
  it('scores allfour tarot courts as10 and tarot aces flexibly as1/11', () => {
    for (const rank of [11,12,13,14]) expect(frickFrackTotal([{id:1,rank,suit:0,tarot:true}])).toBe(10);
    expect(frickFrackTotal([{id:1,rank:1,suit:0,tarot:true},{id:2,rank:14,suit:2,tarot:true}])).toBe(21);
    expect(frickFrackTotal([{id:1,rank:1,suit:0,tarot:true},{id:2,rank:1,suit:1},{id:3,rank:10,suit:2}])).toBe(12);
  });
  it('replicates tarot family and rank14 while masking the dealer hole card', () => {
    const state = createFrickFrackState();
    state.sessions[0] = {id:1,revision:0,faction:0,phase:'playing',dialogueIndex:2,dialogueStartedAt:0,readyAt:0,wager:1,
      player:[{id:1,rank:14,suit:0,tarot:true}],dealer:[{id:2,rank:12,suit:1,tarot:true},{id:987654321,rank:14,suit:2,tarot:true}],result:null,message:''};
    const encoded = frickFrackWire(state); expect(JSON.stringify(encoded)).not.toContain('987654321');
    const decoded = frickFrackFromWire(encoded);
    expect(decoded.sessions[0]?.player).toEqual(state.sessions[0].player);
    expect(decoded.sessions[0]?.dealer).toEqual([{id:2,rank:12,suit:1,tarot:true},null]);
    state.sessions[0].phase = 'result'; expect(frickFrackFromWire(frickFrackWire(state)).sessions[0]?.dealer).toEqual(state.sessions[0].dealer);
  });
  it('rejects rank14 ordinary cards and nonboolean tarot payloads', () => {
    expect(frickFrackFromWire([1,[],[[[1,14,0]]],[]]).sideboards[0]).toEqual([]);
    expect(frickFrackFromWire([1,[],[[[1,14,0,'yes']]],[]]).sideboards[0]).toEqual([]);
    expect(frickFrackFromWire([1,[],[[[1,14,0,true]]],[]]).sideboards[0]).toEqual([{id:1,rank:14,suit:0,tarot:true}]);
  });
});
