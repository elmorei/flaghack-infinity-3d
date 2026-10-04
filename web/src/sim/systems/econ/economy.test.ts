import { describe, expect, it } from 'vitest';
import { HEARTH_FLAG_COST, HEARTH_FLAG_INTERVAL, PILE_COUNT, PILE_RESPAWN_INTERVAL, RECRUIT_INTERVAL } from '../../constants';
import { spawnBuilding, spawnHippie } from '../../factory';
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

  it.each(['drumcircle', 'gcc'] as const)('%s recruits existing neutrals repeatedly without spawning or resource costs', (kind) => {
    const h = newMatch();
    const { world } = h;
    world.hippies.clear();
    for (const f of world.factions) f.lumber = 0;
    const hearth = world.hearthOf(0)!;
    const recruiter = kind === 'gcc' ? world.gccOf(0)!
      : spawnBuilding(world, 'drumcircle', 0, freeThickFacet(world, hearth.pos.x, hearth.pos.z, 12, 'drumcircle'), 1);
    for (const b of world.buildings.values()) if (b.kind === 'gcc' && b !== recruiter) b.disabled = true;
    if (kind === 'drumcircle') registerBuildingShape(world, recruiter);
    const a = spawnHippie(world, -1, { x: recruiter.pos.x + 8, z: recruiter.pos.z });
    const b = spawnHippie(world, -1, { x: recruiter.pos.x - 8, z: recruiter.pos.z });
    // Freeze their wandering; recruitment itself is not a movement operation.
    a.effects.push({ kind: 'stun', until: 1000, mag: 1, source: -1 });
    b.effects.push({ kind: 'stun', until: 1000, mag: 1, source: -1 });
    const flags = world.flags.size;
    run(h, RECRUIT_INTERVAL - 0.1);
    expect(population(world, 0)).toBe(0);
    run(h, 0.2);
    expect(population(world, 0)).toBe(1);
    run(h, RECRUIT_INTERVAL);
    expect(population(world, 0)).toBe(2);
    expect(world.hippies.size).toBe(2);
    expect(world.flags.size).toBe(flags);
    expect(world.factions[0].lumber).toBe(0);
    expect(eventsOf(h, 'recruited').map((e) => e.via)).toEqual([kind, kind]);
    run(h, RECRUIT_INTERVAL * 2);
    expect(world.hippies.size).toBe(2);
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
