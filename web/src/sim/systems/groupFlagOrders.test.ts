import { describe, expect, it } from 'vitest';
import { spawnHippie } from '../factory';
import { SIM_DT } from '../constants';
import { newMatch } from './econ/testkit';
import { cmdOrder, updateHippies } from './hippies';
import { canPlantAt, destroyFlag, giveFlag } from './flags';
import { brainOf } from './units/brain';
import { parseCommand } from '../../net/validate';

function setup() {
  const { world } = newMatch('group-flag-orders'); world.hippies.clear();
  const home = world.hearthOf(0)!, at = world.nav.nearestWalkable(home.pos.x + 5, home.pos.z);
  const workers = [0, 1, 2].map(i => spawnHippie(world, 0, { x: at.x + i, z: at.z }));
  const target = spawnHippie(world, -1, world.nav.nearestWalkable(home.pos.x + 11, home.pos.z));
  const idle = brainOf(target); idle.task = 'wander'; idle.waitUntil = Infinity;
  for (const b of world.buildings.values()) if (b.kind === 'gcc') b.disabled = true;
  return { world, workers, target };
}
describe('one Flag bearer per selected group order', () => {
  it('sends only the existing bearer to recruit and the rest of the group to the target', () => {
    const { world, workers, target } = setup(), flag = world.avatarOf(0).carried.at(-1)!;
    giveFlag(world, flag, workers[2].id);
    cmdOrder(world, { t: 'order', faction: 0, hippies: [...workers.map(h => h.id), workers[2].id], order: { kind: 'recruit', target: target.id } });
    expect(workers.filter(h => h.order?.kind === 'recruit')).toEqual([workers[2]]);
    expect(workers.slice(0, 2).map(h => h.order?.kind)).toEqual(['move', 'move']);
    expect(workers[2].carryingFlag).toBe(flag);
  });
  it('fetches only one actual stocked Flag for a group recruit command', () => {
    const { world, workers, target } = setup(); const count = world.flags.size;
    const stock = new Set([...world.flags.values()].filter(fl => fl.owner === 0 && fl.state === 'stock').map(fl => fl.id));
    const command = parseCommand({ t: 'order', faction: 0, hippies: workers.map(h => h.id), order: { kind: 'recruit', target: target.id } })!;
    expect(command.t).toBe('order'); if (command.t !== 'order') return; cmdOrder(world, command);
    expect(workers.filter(h => h.order?.kind === 'recruit')).toHaveLength(1);
    updateHippies(world, SIM_DT); expect(workers.filter(h => brainOf(h).task === 'fetchStock' || h.carryingFlag !== -1)).toHaveLength(1);
    for (let i = 0; i < 60 / SIM_DT && target.faction === -1; i++) { world.time += SIM_DT; world.tick++; updateHippies(world, SIM_DT); }
    expect(target.faction).toBe(0); expect(stock.has(target.carryingFlag)).toBe(true); expect(world.flags.size).toBe(count);
  });
  it('assigns exactly one planter for a selected group', () => {
    const { world, workers } = setup(), node = world.lattice.nodes.find(n => canPlantAt(world, n.id, 0))!;
    cmdOrder(world, { t: 'order', faction: 0, hippies: workers.map(h => h.id), order: { kind: 'plant', node: node.id } });
    expect(workers.filter(h => h.order?.kind === 'plant')).toHaveLength(1); expect(workers.filter(h => h.order?.kind === 'move')).toHaveLength(2);
  });
  it('reports no available Flag without destroying previous orders, or using enemy workers', () => {
    const { world, workers, target } = setup(); for (const id of [...world.flags.keys()]) destroyFlag(world, id);
    workers[0].order = { kind: 'move', to: { x: 12, z: 13 } }; const before = structuredClone(workers[0].order);
    world.drainEvents(); cmdOrder(world, { t: 'order', faction: 0, hippies: workers.map(h => h.id), order: { kind: 'recruit', target: target.id } });
    expect(workers[0].order).toEqual(before); expect(world.drainEvents()).toContainEqual(expect.objectContaining({ t: 'rejected', reason: expect.stringContaining('No Flag') }));
    cmdOrder(world, { t: 'order', faction: 1, hippies: workers.map(h => h.id), order: { kind: 'recruit', target: target.id } });
    expect(workers[0].order).toEqual(before);
  });
});
