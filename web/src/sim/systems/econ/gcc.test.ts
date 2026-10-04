import { describe, expect, it } from 'vitest';
import { GCC, GCC_SIMULACRA_RANGE } from '../../constants';
import { spawnHippie } from '../../factory';
import { applyEffect } from '../effects';
import { canPlantAt, dropLoose, nearestPlantableNode } from '../flags';
import { eventsOf, newMatch, placeAvatar, run } from './testkit';
import type { Harness } from './testkit';

/** Stand the vexillomancer beside its GCC. */
function atTheCart(h: Harness): void {
  const g = h.world.gccOf(0)!;
  placeAvatar(h.world, 0, g.pos.x + 3, g.pos.z);
}

describe('gcc', () => {
  it('Flagellian Dialectics converts nearby enemy hippies after a rooted channel', () => {
    const h = newMatch();
    const { world } = h;
    const g = world.gccOf(0)!;
    atTheCart(h);
    const enemies = [spawnHippie(world, 1, { x: g.pos.x - 6, z: g.pos.z }), spawnHippie(world, 2, { x: g.pos.x, z: g.pos.z + 6 })];
    for (const e of enemies) applyEffect(world, e, 'stun', 10);

    world.submit({ t: 'gcc', faction: 0, action: 'dialectics', target: -1, nodes: [] });
    run(h, GCC.dialecticsChannel - 0.5);
    expect(world.avatarOf(0).action.kind).toBe('channel');
    expect(g.gcc!.channelUntil).toBeGreaterThan(world.time);
    for (const e of enemies) expect(e.faction).not.toBe(0);

    run(h, 0.6);
    for (const e of enemies) expect(e.faction).toBe(0);
    expect(eventsOf(h, 'recruited').map((e) => e.via)).toEqual(['dialectics', 'dialectics']);
    expect(world.avatarOf(0).action.kind).toBe('idle');
    expect(world.factions[0].cooldowns.dialectics).toBeGreaterThan(world.time);
  });

  it('allows Dialectics conversions beyond the camp soft cap without growing the world population', () => {
    const h = newMatch();
    const { world } = h;
    const g = world.gccOf(0)!;
    while (world.hippiesOf(0).length < 12) spawnHippie(world, 0, { x: g.pos.x + 20, z: g.pos.z });
    atTheCart(h);
    const enemies = [spawnHippie(world, 1, { x: g.pos.x - 6, z: g.pos.z }), spawnHippie(world, 2, { x: g.pos.x, z: g.pos.z + 6 })];
    for (const e of enemies) applyEffect(world, e, 'stun', 10);
    const total = world.hippies.size;
    world.submit({ t: 'gcc', faction: 0, action: 'dialectics', target: -1, nodes: [] });
    run(h, GCC.dialecticsChannel + 0.1);
    expect(enemies.every((e) => e.faction === 0)).toBe(true);
    expect(world.hippiesOf(0)).toHaveLength(14);
    expect(world.hippies.size).toBe(total);
  });

  it('Flag Simulacra plants one Flag on two nodes at once', () => {
    const h = newMatch();
    const { world } = h;
    const lat = world.lattice;
    const g = world.gccOf(0)!;
    atTheCart(h);
    const d = (n: number): number => Math.hypot(lat.nodes[n].x - g.pos.x, lat.nodes[n].z - g.pos.z);
    const free = lat.nodes
      .map((n) => n.id)
      .filter((n) => d(n) > 20 && d(n) < GCC_SIMULACRA_RANGE - 5 && canPlantAt(world, n, 0))
      .sort((a, b) => d(a) - d(b));
    const a = free[0];
    const b = free.find((n) => Math.hypot(lat.nodes[n].x - lat.nodes[a].x, lat.nodes[n].z - lat.nodes[a].z) > 20)!;
    const quiver = new Set(world.avatarOf(0).carried);

    world.submit({ t: 'gcc', faction: 0, action: 'simulacra', target: -1, nodes: [a, b] });
    run(h, 1 / 60);
    const flagId = world.survey.nodeFlag[a];
    expect(flagId).toBeGreaterThan(0);
    expect(world.survey.nodeFlag[b]).toBe(flagId);
    const flag = world.flags.get(flagId)!;
    expect(flag.node).toBe(a);
    expect(flag.altNode).toBe(b);
    expect(quiver.has(flagId)).toBe(true);
    expect(eventsOf(h, 'gccAction').map((e) => e.action)).toEqual(['simulacra']);
  });

  it('Flag Repair re-plants a loose own Flag near the cart', () => {
    const h = newMatch();
    const { world } = h;
    const g = world.gccOf(0)!;
    const av = world.avatarOf(0);
    const flagId = av.carried[0];
    // A metre from the free node nearest a spot 9 m from the cart: the home ring and the
    // buildings' corners take the nodes right around it.
    const node = world.lattice.nodes[nearestPlantableNode(world, { x: g.pos.x + 8, z: g.pos.z + 4 }, 20, 0)];
    dropLoose(world, flagId, { x: node.x + 1, y: 0, z: node.z });
    expect(world.flags.get(flagId)!.state).toBe('loose');
    run(h, GCC.repairInterval + 0.1);
    const flag = world.flags.get(flagId)!;
    expect(flag.state).toBe('planted');
    expect(flag.owner).toBe(0);
  });
});
