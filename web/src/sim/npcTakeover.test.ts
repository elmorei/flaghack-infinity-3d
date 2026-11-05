import { describe, expect, it, vi } from 'vitest';
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
  it('does not transfer ownership, refund upgrades or discard commands when the selected mode cannot be applied', () => {
    const w = fixture(), camp = w.factions[1];
    w.factions[0].alive = false;
    camp.chakras.hoist = 2; camp.ritual = 7;
    // A legacy camp can retain an altar entry but have no usable avatar anchor.
    const hearth = vi.spyOn(w, 'hearthOf').mockReturnValue(undefined);
    const cart = vi.spyOn(w, 'gccOf').mockReturnValue(undefined);
    const before = structuredClone({ options: w.options, factions: w.factions });
    const command = { t: 'swing' as const, faction: 1 as const };
    w.submit(command);
    expect(npcTakeoverSeats(w, 0, [1, 2, 3])).toContain(1);
    expect(applyNpcTakeover(w, 0, 1, [1, 2, 3], 'avatar')).toBe(false);
    expect({ options: w.options, factions: w.factions }).toEqual(before);
    expect(w.takeCommands()).toEqual([command]);
    expect(w.avatarOf(1)).toBeUndefined();
    hearth.mockRestore(); cart.mockRestore();
  });
});
