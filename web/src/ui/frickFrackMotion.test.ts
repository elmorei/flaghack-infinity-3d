import { describe, expect, it } from 'vitest';
import type { FrickFrackSession } from '../sim/frickFrack';
import { tableSnapshot, planCardMotion, motionDuration, DEAL_MS, FLIP_MS } from './frickFrackMotion';
const c = (id: number) => ({id,rank: 3,suit: 0});
const session = (changes: Partial<FrickFrackSession> = {}): FrickFrackSession => ({id:1,revision:1,faction:0,phase:'playing',dialogueIndex:0,dialogueStartedAt:0,readyAt:0,wager:1,player:[c(1),c(2)],dealer:[c(3),null],result:null,message:'',...changes});
describe('public card choreography', () => {
  it('alternates opening cards and contains no hidden card identity', () => {
    const snapshot=tableSnapshot(session()), plan=planCardMotion(null,snapshot);
    expect(snapshot.cards.find(c=>c.hidden)?.key).toBe('dealer:hidden:0');
    expect(plan.map(m=>m.key)).toEqual(['card:1','card:3','card:2','dealer:hidden:0']);
    expect(plan.map(m=>m.delay)).toEqual([0,65,130,195]);
    expect(motionDuration(plan[3])).toBe(DEAL_MS);
    expect(Math.max(...plan.map(m => m.delay + motionDuration(m)))).toBe(515);
    expect(motionDuration(plan[0])).toBe(320);
  });
  it('does not redeal on revision, wager/resource change, or local picker rerender', () => {
    const s=session(), before=tableSnapshot(s);
    expect(planCardMotion(before,tableSnapshot({...s,revision:20,wager:3}))).toEqual([]);
  });
  it('deals only a new hit and preserves tombstones without replaying them', () => {
    const before=tableSnapshot(session());
    const after=tableSnapshot(session({player:[c(1),c(4)],defeated:[{side:'player',card:c(2)}],revealedCardOrder:[1,3,2,4]}));
    expect(planCardMotion(before,after).map(m=>m.key)).toEqual(['card:4']);
  });
  it('flips the authoritative revealed hole card, then deals additional dealer draws', () => {
    const before=tableSnapshot(session());
    const after=tableSnapshot(session({phase:'result',dealer:[c(3),c(4),c(5)],revealedCardOrder:[1,3,2,4,5]}));
    const plan=planCardMotion(before,after);
    expect(plan.map(m=>m.kind)).toEqual(['reveal','deal']);
    expect(motionDuration(plan[0])).toBe(FLIP_MS);
  });
  it('handles a revealed hole card defeated in the same authoritative update', () => {
    const after=session({dealer:[c(3)],defeated:[{side:'dealer',card:c(4)}],revealedCardOrder:[1,3,2,4]});
    expect(planCardMotion(tableSnapshot(session()),tableSnapshot(after))[0]).toMatchObject({key:'card:4',kind:'reveal'});
  });
  it('clears the previous hand and replays a fresh session without retaining identities', () => {
    const before=tableSnapshot(session()), empty=tableSnapshot(session({phase:'betting',player:[],dealer:[]}));
    expect(planCardMotion(before,empty)).toEqual([]);
    expect(planCardMotion(empty,tableSnapshot(session())).length).toBe(4);
    expect(planCardMotion(before,tableSnapshot(session({id:2}))).length).toBe(4);
  });
  it('does not redeal a still-hidden card when other dealer cards arrive', () => {
    const after=session({dealer:[c(3),c(9),null]});
    expect(planCardMotion(tableSnapshot(session()),tableSnapshot(after))).toEqual([{key:'card:9',kind:'deal',delay:0,hidden:false}]);
  });
  it('never mutates authoritative arrays or stores card face data', () => {
    const s=session(), before=JSON.stringify(s), snapshot=tableSnapshot(s);
    planCardMotion(null,snapshot);
    expect(JSON.stringify(s)).toBe(before);
    expect(JSON.stringify(snapshot)).not.toContain('rank');
    expect(JSON.stringify(snapshot)).not.toContain('suit');
  });
});
