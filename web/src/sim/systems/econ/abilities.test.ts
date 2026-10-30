import { describe, expect, it } from 'vitest';
import { ABILITY, ALIGN_COST, ALIGN_TIME } from '../../constants';
import { spawnFlag, spawnHippie } from '../../factory';
import type { FactionId } from '../../types';
import type { World } from '../../world';
import { abilityBlocker, alignBlocker, inStabilizeZone } from '../abilities';
import { hasEffect } from '../effects';
import { canPlantAt, isBuildingCorner, plantFlag } from '../flags';
import { eventsOf, newMatch, placeAvatar, run } from './testkit';
import type { Harness } from './testkit';

/** Free nodes around (x, z) between rMin and rMax metres, nearest first. */
function freeNodes(world: World, f: FactionId, x: number, z: number, rMin: number, rMax: number): number[] {
  const lat = world.lattice;
  const d = (n: number): number => Math.hypot(lat.nodes[n].x - x, lat.nodes[n].z - z);
  return lat.nodes
    .map((n) => n.id)
    .filter((n) => d(n) >= rMin && d(n) <= rMax && canPlantAt(world, n, f))
    .sort((a, b) => d(a) - d(b));
}

/** Plant a fresh Flag of faction f on a node. */
function plantFresh(world: World, f: FactionId, node: number): number {
  const n = world.lattice.nodes[node];
  const fl = spawnFlag(world, { state: 'carried', owner: f, holder: -1, pos: { x: n.x, y: 0, z: n.z } });
  if (!plantFlag(world, fl.id, node, f, -1)) throw new Error('could not plant');
  return fl.id;
}

/** Stand a vexillomancer in open ground between its camp and the centre. */
function openGround(world: World, f: FactionId, dist = 30): { x: number; z: number } {
  const hearth = world.hearthOf(f)!;
  const len = Math.hypot(hearth.pos.x, hearth.pos.z);
  placeAvatar(world, f, hearth.pos.x - (hearth.pos.x / len) * dist, hearth.pos.z - (hearth.pos.z / len) * dist);
  const av = world.avatarOf(f);
  return { x: av.pos.x, z: av.pos.z };
}

/** Nearest flippable, unpinned node 15-50 m from the vexillomancer. */
function shiftTarget(h: Harness): number {
  const { world } = h;
  const lat = world.lattice;
  const av = world.avatarOf(0);
  const d = (n: number): number => Math.hypot(lat.nodes[n].x - av.pos.x, lat.nodes[n].z - av.pos.z);
  const node = lat.nodes
    .map((n) => n.id)
    .filter((n) => lat.flippable(n) && !isBuildingCorner(world, n) && d(n) > 15 && d(n) < 50)
    .sort((a, b) => d(a) - d(b))[0];
  if (node === undefined) throw new Error('no flippable node in range');
  return node;
}

describe('abilities', () => {
  it('aligning a chakra spends Ritual only when the channel completes, and unlocks its ability', () => {
    const h = newMatch();
    const { world } = h;
    const fac = world.factions[0];
    fac.ritual = ALIGN_COST[0] + 10;
    expect(abilityBlocker(world, 0, 'phason')).toMatch(/Align the Field chakra/);

    world.submit({ t: 'align', faction: 0, chakra: 'field' });
    run(h, ALIGN_TIME / 2);
    expect(eventsOf(h, 'alignStart')).toHaveLength(1);
    expect(world.avatarOf(0).action.kind).toBe('align');
    expect(fac.ritual).toBe(ALIGN_COST[0] + 10);
    expect(fac.chakras.field).toBe(0);

    run(h, ALIGN_TIME / 2 + 0.1);
    expect(fac.ritual).toBeCloseTo(10, 5);
    expect(fac.chakras.field).toBe(1);
    expect(eventsOf(h, 'aligned')).toEqual([{ t: 'aligned', faction: 0, chakra: 'field', level: 1 }]);
    expect(world.avatarOf(0).action.kind).toBe('idle');
    expect(abilityBlocker(world, 0, 'phason')).toBe('');
  });

  it('an interrupted alignment costs nothing; it can be restarted away from the Hearth', () => {
    const h = newMatch();
    const { world } = h;
    const fac = world.factions[0];
    fac.ritual = 100;
    world.submit({ t: 'align', faction: 0, chakra: 'hoist' });
    run(h, 1);
    world.avatarOf(0).action = { kind: 'idle' };
    run(h, ALIGN_TIME);
    expect(fac.ritual).toBe(100);
    expect(fac.chakras.hoist).toBe(0);

    const hearth = world.hearthOf(0)!;
    placeAvatar(world, 0, hearth.pos.x * 0.5, hearth.pos.z * 0.5);
    world.submit({ t: 'align', faction: 0, chakra: 'hoist' });
    run(h, 1 / 60);
    expect(eventsOf(h, 'rejected')).toHaveLength(0);
    expect(world.avatarOf(0).action.kind).toBe('align');
    run(h, ALIGN_TIME);
    expect(fac.chakras.hoist).toBe(1);
    expect(fac.ritual).toBeCloseTo(100 - ALIGN_COST[0], 5);
  });

  it.each([0, 1, 2, 3] as const)('faction %i can align far from its Hearth without spending Flags', (f) => {
    const h = newMatch();
    const { world } = h;
    const fac = world.factions[f];
    openGround(world, f, 45);
    const av = world.avatarOf(f);
    const hearth = world.hearthOf(f)!;
    expect(Math.hypot(av.pos.x - hearth.pos.x, av.pos.z - hearth.pos.z)).toBeGreaterThan(30);
    fac.ritual = ALIGN_COST[0];
    const flags = [...av.carried];
    expect(alignBlocker(world, f, 'field')).toBe('');
    world.submit({ t: 'align', faction: f, chakra: 'field' });
    run(h, ALIGN_TIME + 0.1);
    expect(fac.chakras.field).toBe(1);
    expect(fac.ritual).toBeCloseTo(0, 5);
    expect(av.carried).toEqual(flags);
  });

  it('remote alignment still enforces Ritual, maximum level, life and channel prerequisites', () => {
    const { world } = newMatch();
    const fac = world.factions[0];
    openGround(world, 0, 45);
    const av = world.avatarOf(0);
    fac.ritual = 0;
    expect(alignBlocker(world, 0, 'field')).toMatch(/Needs .* Ritual/);
    fac.ritual = 1000;
    fac.chakras.field = 3;
    expect(alignBlocker(world, 0, 'field')).toMatch(/fully aligned/);
    fac.chakras.field = 0;
    av.koUntil = world.time + 5;
    expect(alignBlocker(world, 0, 'field')).toMatch(/Flagless/);
    av.koUntil = 0;
    av.action = { kind: 'align', chakra: 'hoist', t: world.time };
    expect(alignBlocker(world, 0, 'field')).toMatch(/Already aligning/);
    fac.alive = false;
    expect(alignBlocker(world, 0, 'field')).toMatch(/camp has fallen/);
  });

  it('Degen factions still require a roaming avatar and cannot spend Ritual through alignment', () => {
    const h = newMatch();
    const { world } = h;
    const fac = world.factions[0];
    fac.controlMode = 'rts';
    world.avatars.delete(fac.avatarId);
    fac.avatarId = -1;
    fac.ritual = 100;
    expect(alignBlocker(world, 0, 'field')).toMatch(/requires a roaming/);
    world.submit({ t: 'align', faction: 0, chakra: 'field' });
    run(h, 1 / 60);
    expect(eventsOf(h, 'rejected').at(-1)?.reason).toMatch(/requires a roaming/);
    expect(fac.ritual).toBe(100);
    expect(fac.chakras.field).toBe(0);
  });

  it('Phason Shift turns the targeted node and starts its cooldown', () => {
    const h = newMatch();
    const { world } = h;
    const lat = world.lattice;
    world.factions[0].chakras.field = 1;
    const node = shiftTarget(h);
    const from = { x: lat.nodes[node].x, z: lat.nodes[node].z };
    world.submit({ t: 'ability', faction: 0, ability: 'phason', at: from, node });
    run(h, 1 / 60);
    expect(Math.hypot(lat.nodes[node].x - from.x, lat.nodes[node].z - from.z)).toBeGreaterThan(1);
    const cast = eventsOf(h, 'ability');
    expect(cast).toHaveLength(1);
    expect(cast[0]).toMatchObject({ ability: 'phason', level: 1, faction: 0 });
    expect(world.factions[0].cooldowns.phason).toBeCloseTo(world.time + ABILITY.phason.cooldown, 5);
    expect(abilityBlocker(world, 0, 'phason')).toMatch(/recharging/);
  });

  it('a Stabilize Zone refuses Phason Shift inside it', () => {
    const h = newMatch();
    const { world } = h;
    const lat = world.lattice;
    const fac = world.factions[0];
    fac.chakras.field = 1;
    fac.chakras.canton = 1;
    const node = shiftTarget(h);
    const at = { x: lat.nodes[node].x, z: lat.nodes[node].z };
    world.submit({ t: 'ability', faction: 0, ability: 'stabilize', at, node: -1 });
    run(h, 1 / 60);
    expect(inStabilizeZone(world, at)).toBe(true);
    world.submit({ t: 'ability', faction: 0, ability: 'phason', at, node });
    run(h, 1 / 60);
    expect(lat.nodes[node].x).toBe(at.x);
    expect(lat.nodes[node].z).toBe(at.z);
    expect(fac.cooldowns.phason).toBe(0);
    run(h, ABILITY.stabilize.duration);
    expect(inStabilizeZone(world, at)).toBe(false);
    expect(world.zones.size).toBe(0);
  });

  it('Forced March speeds nearby hippies, then leaves them exhausted with less attention', () => {
    const h = newMatch();
    const { world } = h;
    world.factions[0].chakras.fly = 1;
    const av = world.avatarOf(0);
    const hippie = spawnHippie(world, 0, { x: av.pos.x + 3, z: av.pos.z });
    world.submit({ t: 'ability', faction: 0, ability: 'march', at: { x: av.pos.x, z: av.pos.z }, node: -1 });
    run(h, 1 / 60);
    expect(hasEffect(world, hippie, 'march')).toBe(true);
    hippie.attention = 90;
    run(h, ABILITY.march.duration[0]);
    expect(hasEffect(world, hippie, 'march')).toBe(false);
    expect(hasEffect(world, hippie, 'exhausted')).toBe(true);
    expect(hippie.attention).toBeLessThanOrEqual(90 - ABILITY.march.attentionCost + 1);
  });

  it('Priority Beacon on a planned node sends nearby hippies to plant it, hastened', () => {
    const h = newMatch();
    const { world } = h;
    const fac = world.factions[0];
    fac.chakras.hoist = 1;
    const c = openGround(world, 0, 20);
    const node = freeNodes(world, 0, c.x, c.z, 5, 20)[0];
    fac.plan.add(node);
    const at = { x: world.lattice.nodes[node].x, z: world.lattice.nodes[node].z };
    const own = world.hippiesOf(0).filter((hp) => Math.hypot(hp.pos.x - at.x, hp.pos.z - at.z) <= ABILITY.beacon.radius[0]);
    expect(own.length).toBeGreaterThan(0);

    world.submit({ t: 'ability', faction: 0, ability: 'beacon', at, node });
    run(h, 2 / 60);
    expect(eventsOf(h, 'ability').map((e) => e.ability)).toEqual(['beacon']);
    for (const hp of own) {
      expect(hasEffect(world, hp, 'beacon')).toBe(true);
      expect(hp.order).toEqual({ kind: 'plant', node });
    }
    const zone = [...world.zones.values()].find((z) => z.kind === 'beacon')!;
    expect(zone.radius).toBe(ABILITY.beacon.radius[0]);
  });

  it('Omega Pulse knocks enemy Flags loose outward, hurts enemy hippies, and at L3 plants the quiver (planned nodes first)', () => {
    const h = newMatch();
    const { world } = h;
    const fac = world.factions[0];
    fac.chakras.finial = 3;
    const c = openGround(world, 0);
    const near = freeNodes(world, 1, c.x, c.z, 3, 12);
    const enemyFlags = near.slice(0, 2).map((n) => plantFresh(world, 1, n));
    const before = enemyFlags.map((id) => Math.hypot(world.flags.get(id)!.pos.x - c.x, world.flags.get(id)!.pos.z - c.z));
    const enemy = spawnHippie(world, 1, { x: c.x + 4, z: c.z });
    const planned = freeNodes(world, 0, c.x, c.z, 14, ABILITY.omega.radius[2] - 1)[0];
    fac.plan.add(planned);
    const quiver = world.avatarOf(0).carried.length;
    expect(quiver).toBeGreaterThan(0);

    world.submit({ t: 'ability', faction: 0, ability: 'omega', at: c, node: -1 });
    run(h, 1 / 60);
    expect(eventsOf(h, 'ability').map((e) => e.ability)).toEqual(['omega']);
    enemyFlags.forEach((id, i) => {
      const fl = world.flags.get(id)!;
      expect(fl.state).toBe('loose');
      expect(Math.hypot(fl.pos.x - c.x, fl.pos.z - c.z)).toBeGreaterThan(before[i] + 1);
    });
    expect(enemy.hp).toBeLessThan(100);
    expect(world.avatarOf(0).carried).toHaveLength(0);
    expect(world.flags.get(world.survey.nodeFlag[planned])?.owner).toBe(0);
    expect([...world.zones.values()].map((z) => z.kind)).toEqual(['omega']);
    run(h, ABILITY.omega.zoneTime + 0.1);
    expect(world.zones.size).toBe(0);
  });

  it('Flags inside their owner’s L3 Stabilize Zone hold against an enemy Omega Pulse', () => {
    const h = newMatch();
    const { world } = h;
    world.factions[0].chakras.canton = 3;
    world.factions[1].chakras.finial = 1;
    const c = openGround(world, 1);
    const node = freeNodes(world, 0, c.x, c.z, 3, 8)[0];
    const flagId = plantFresh(world, 0, node);
    placeAvatar(world, 0, c.x + 10, c.z + 10);
    const at = { x: world.lattice.nodes[node].x, z: world.lattice.nodes[node].z };
    world.submit({ t: 'ability', faction: 0, ability: 'stabilize', at, node: -1 });
    run(h, 1 / 60);
    world.submit({ t: 'ability', faction: 1, ability: 'omega', at: c, node: -1 });
    run(h, 1 / 60);
    expect(eventsOf(h, 'ability').map((e) => e.ability)).toEqual(['stabilize', 'omega']);
    expect(world.flags.get(flagId)!.state).toBe('planted');
  });
});
