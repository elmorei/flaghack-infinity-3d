import { describe, expect, it } from 'vitest';
import { applyNpcTakeover, npcTakeoverSeats } from './npcTakeover';
import { createMatch } from './setup';
function fixture() { return createMatch({ seed: 'general-camp-takeover', difficulty: 'normal', mode: 'standard', humans: [0] }); }
describe('general NPC camp takeover', () => {
  it('supports both late spectators and eliminated players before the boss appears', () => {
    const w = fixture();
    expect(npcTakeoverSeats(w, null, [1,2,3])).toEqual([1,2,3]);
    expect(npcTakeoverSeats(w, 0, [1,2,3])).toEqual([]);
    w.factions[0].alive = false;
    expect(npcTakeoverSeats(w, 0, [1,2,3])).toEqual([1,2,3]);
    const units = [...w.hippies.values()], buildings = [...w.buildings.values()];
    expect(applyNpcTakeover(w, 0, 2, [1,2,3], 'rts')).toBe(true);
    expect(w.options.humans).toEqual([2]); expect(w.factions[2].controlMode).toBe('rts');
    expect([...w.hippies.values()]).toEqual(units); expect([...w.buildings.values()]).toEqual(buildings);
  });
  it('does not adopt reserved, dead or inactive camps or restart an ended game', () => {
    const w = fixture();
    expect(applyNpcTakeover(w, null, 2, [1,3])).toBe(false);
    w.factions[2].alive = false; expect(applyNpcTakeover(w, null, 2, [1,2,3])).toBe(false);
    w.phase = 'ended'; expect(npcTakeoverSeats(w, null, [1,3])).toEqual([]);
  });
});
