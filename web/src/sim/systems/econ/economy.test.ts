import { describe, expect, it } from 'vitest';
import { HEARTH_FLAG_COST, HEARTH_FLAG_INTERVAL, PILE_COUNT, PILE_RESPAWN_INTERVAL, RECRUIT_INTERVAL, RECRUIT_LUMBER } from '../../constants';
import { spawnBuilding, spawnHippie } from '../../factory';
import { normalizeMatch } from '../../matchSettings';
import { FACTION_IDS } from '../../types';
import { registerBuildingShape } from '../buildings';
import { popCap, population } from '../economy';
import { dismissHippies, eventsOf, freeThickFacet, newMatch, parkAvatarAway, run } from './testkit';

describe('economy', () => {
  it('a Hearth turns HEARTH_FLAG_COST lumber into one stock Flag every HEARTH_FLAG_INTERVAL, and stops when lumber runs out', () => {
    const h = newMatch();
    const { world } = h;
    dismissHippies(world, 0);
    parkAvatarAway(world, 0);
    const fac = world.factions[0];
    fac.lumber = HEARTH_FLAG_COST * 3 + 2;
    const stock0 = world.stockCount(0);

    run(h, HEARTH_FLAG_INTERVAL - 0.1);
    expect(world.stockCount(0)).toBe(stock0);
    run(h, 0.2);
    expect(world.stockCount(0)).toBe(stock0 + 1);
    expect(fac.lumber).toBe(HEARTH_FLAG_COST * 2 + 2);

    run(h, HEARTH_FLAG_INTERVAL * 4);
    expect(world.stockCount(0)).toBe(stock0 + 3);
    expect(fac.lumber).toBe(2);
    expect(eventsOf(h, 'flagCrafted').filter((e) => e.faction === 0)).toHaveLength(3);
  });

  it.each([40, 2])('a Drum Circle recruit takes a stock Flag and respects a configured cap of %i', (maxSignifiers) => {
    const h = newMatch();
    const { world } = h;
    world.options.match = normalizeMatch({ maxSignifiers });
    const hearth = world.hearthOf(0)!;
    dismissHippies(world, 0);
    parkAvatarAway(world, 0);
    const circle = spawnBuilding(world, 'drumcircle', 0, freeThickFacet(world, hearth.pos.x, hearth.pos.z, 12, 'drumcircle'), 1);
    registerBuildingShape(world, circle);
    world.factions[0].lumber = 100;
    const stockIds = new Set(world.stockOf(hearth.id).map((f) => f.id));
    const flags0 = world.flags.size;

    run(h, RECRUIT_INTERVAL + 0.1);
    const recruits = eventsOf(h, 'recruited').filter((e) => e.faction === 0);
    expect(recruits).toHaveLength(1);
    expect(recruits[0].via).toBe('drumcircle');
    const recruit = world.hippies.get(recruits[0].hippieId)!;
    expect(recruit.faction).toBe(0);
    const carried = world.flags.get(recruit.carryingFlag)!;
    expect(carried.state).toBe('carried');
    expect(carried.holder).toBe(recruit.id);
    expect(stockIds.has(carried.id)).toBe(true);
    const crafted = eventsOf(h, 'flagCrafted').length;
    expect(world.flags.size).toBe(flags0 + crafted);
    // 100 lumber - recruit - one Hearth craft.
    expect(world.factions[0].lumber).toBe(100 - RECRUIT_LUMBER - HEARTH_FLAG_COST);

    // Fill the camp to its cap: no more recruits.
    const cap = popCap(world, 0);
    expect(cap).toBeLessThanOrEqual(maxSignifiers);
    while (population(world, 0) < cap) spawnHippie(world, 0, { x: hearth.pos.x + 8, z: hearth.pos.z + 8 });
    const before = eventsOf(h, 'recruited').length;
    run(h, RECRUIT_INTERVAL * 2);
    expect(eventsOf(h, 'recruited').length).toBe(before);
    expect(population(world, 0)).toBe(cap);
  });

  it('a working Drum Circle raises the pop cap', () => {
    const h = newMatch();
    const { world } = h;
    const hearth = world.hearthOf(0)!;
    const base = popCap(world, 0);
    const circle = spawnBuilding(world, 'drumcircle', 0, freeThickFacet(world, hearth.pos.x, hearth.pos.z, 12, 'drumcircle'), 0);
    expect(popCap(world, 0)).toBe(base);
    circle.built = 1;
    expect(popCap(world, 0)).toBeGreaterThan(base);
    circle.disabled = true;
    expect(popCap(world, 0)).toBe(base);
  });

  it('depleted lumber piles vanish and fresh ones respawn at free pile spots', () => {
    const h = newMatch();
    const { world } = h;
    // No gatherers: only this test touches the piles.
    for (const f of FACTION_IDS) dismissHippies(world, f);
    const count0 = world.piles.size;
    expect(count0).toBeGreaterThan(0);
    const pile = [...world.piles.values()][0];
    pile.lumber = 0;
    run(h, 1 / 60);
    expect(world.piles.has(pile.id)).toBe(false);
    run(h, PILE_RESPAWN_INTERVAL + 0.1);
    expect(world.piles.size).toBe(count0 - 1 < PILE_COUNT ? count0 : count0 - 1);
  });
});
