import { describe, expect, it } from 'vitest';
import { spawnBeacon, spawnHippie } from '../factory';
import { Rng } from '../rng';
import type { FactionId } from '../types';
import { newMatch } from './econ/testkit';
import { aboveAttentionCap, popCap } from './economy';
import { giveFlag } from './flags';
import { updateHippies } from './hippies';
import { sceneryServiceOf } from './sceneryServices';
import { applyCommands } from './commands';
import { cmdTapBeacon } from './pings';
import { brainOf } from './units/brain';
import { unitsState } from './units/state';

function arena(seed = 'beacon-conversion') {
  const { world } = newMatch(seed);
  world.hippies.clear();
  world.time = 10;
  const av = world.avatarOf(0);
  av.pos.y = world.collision.groundHeight(av.pos.x, av.pos.z);
  const beacon = spawnBeacon(world, 1, av.pos, world.time + 60);
  const add = (f: FactionId | -1 = 1) => spawnHippie(world, f, { x: av.pos.x + 30, z: av.pos.z + 30 });
  const tap = () => cmdTapBeacon(world, { t: 'tapBeacon', faction: 0, beaconId: beacon.id });
  world.drainEvents();
  return { world, av, beacon, add, tap };
}

describe('dropped D.E.G.E.N. beacon conversion', () => {
  it('consumes the beacon with no eligible opponent population and grants no mesh intel', () => {
    const { world, beacon, tap } = arena();
    tap();
    expect(world.beacons.has(beacon.id)).toBe(false);
    expect(world.hippies.size).toBe(0);
    expect(world.factions[0].meshTap[1] ?? 0).toBe(0);
    expect(world.drainEvents().some(e => e.t === 'meshTapped')).toBe(false);
  });

  it('converts the only available opponent without spawning anyone or changing existing intel', () => {
    const { world, beacon, add, tap } = arena();
    const h = add();
    world.factions[0].meshTap[1] = 45;
    tap();
    expect(h.faction).toBe(0);
    expect(h.recruitedAt).toBe(world.time);
    expect(h.beacon).toBe(true);
    expect(world.hippies.size).toBe(1);
    expect(world.beacons.has(beacon.id)).toBe(false);
    expect(world.factions[0].meshTap[1]).toBe(45);
    expect(world.drainEvents()).toContainEqual({ t: 'recruited', hippieId: h.id, faction: 0, via: 'beacon' });
  });

  it('selects one or two distinct opponents reproducibly, with both quantities possible', () => {
    const outcomes = new Set<number>();
    const selections = new Set<string>();
    const run = (seed: string) => {
      const { world, add, tap } = arena();
      const rivals = Array.from({ length: 6 }, () => add());
      world.rng = new Rng(seed);
      tap();
      const ids = rivals.filter(h => h.faction === 0).map(h => h.id);
      expect(ids.length).toBeGreaterThanOrEqual(1);
      expect(ids.length).toBeLessThanOrEqual(2);
      expect(new Set(ids).size).toBe(ids.length);
      expect(world.hippies.size).toBe(6);
      return ids;
    };
    for (let i = 0; i < 8; i++) {
      const seed = `beacon-draw-${i}`;
      const ids = run(seed);
      expect(run(seed)).toEqual(ids);
      outcomes.add(ids.length);
      selections.add(ids.join(','));
    }
    expect([...outcomes].sort()).toEqual([1, 2]);
    expect(selections.size).toBeGreaterThan(1);
  });

  it('never converts neutral, friendly, other-rival, wizard, KO, respawning or dead hippies', () => {
    const { add, tap } = arena();
    const eligible = add();
    const invalid = [add(-1), add(0), add(2), add(), add(), add(), add()];
    invalid[3].wizard = true;
    invalid[4].status = 'ko';
    invalid[5].koUntil = 20;
    invalid[6].hp = 0;
    const factions = invalid.map(h => h.faction);
    tap();
    expect(eligible.faction).toBe(0);
    expect(invalid.map(h => h.faction)).toEqual(factions);
  });

  it('duplicate pickup cannot convert twice or spend additional random draws', () => {
    const { world, add, tap } = arena();
    Array.from({ length: 6 }, () => add());
    tap();
    const factions = [...world.hippies.values()].map(h => h.faction);
    const rng = JSON.stringify(world.rng);
    world.drainEvents();
    tap();
    expect([...world.hippies.values()].map(h => h.faction)).toEqual(factions);
    expect(JSON.stringify(world.rng)).toBe(rng);
    expect(world.drainEvents().filter(e => e.t === 'recruited')).toHaveLength(0);
  });

  it.each(['own', 'distant', 'high', 'knocked out', 'expired', 'rts'] as const)('rejects %s pickup without conversion', reason => {
    const { world, av, beacon, add, tap } = arena();
    const h = add();
    if (reason === 'own') beacon.faction = 0;
    if (reason === 'distant') beacon.pos.x += 10;
    if (reason === 'high') av.pos.y += 10;
    if (reason === 'knocked out') av.koUntil = world.time + 10;
    if (reason === 'expired') beacon.until = world.time;
    if (reason === 'rts') world.factions[0].controlMode = 'rts';
    const rng = JSON.stringify(world.rng);
    tap();
    expect(h.faction).toBe(1);
    expect(world.factions[0].meshTap[1] ?? 0).toBe(0);
    expect(JSON.stringify(world.rng)).toBe(rng);
    if (reason !== 'expired') expect(world.beacons.has(beacon.id)).toBe(true);
  });

  it('the authoritative command dispatcher ignores an eliminated picker', () => {
    const { world, beacon, add } = arena();
    const h = add();
    world.factions[0].alive = false;
    world.submit({ t: 'tapBeacon', faction: 0, beaconId: beacon.id });
    applyCommands(world);
    expect(h.faction).toBe(1);
    expect(world.beacons.has(beacon.id)).toBe(true);
  });

  it('clears the old camp task and reservations while preserving the carried Flag identity', () => {
    const { world, add, tap } = arena();
    const h = add();
    const flagId = world.avatarOf(1).carried.at(-1)!;
    expect(giveFlag(world, flagId, h.id)).toBe(true);
    const b = brainOf(h);
    b.task = 'pull'; b.flag = 777; b.node = 888; b.clearing = true;
    b.work = 4; b.path = [{ x: 0, z: 0 }]; b.route = 'path';
    h.job = 'raid'; h.order = { kind: 'move', to: { x: 1, z: 1 } };
    const state = unitsState(world);
    state.clearers[1] = 1;
    state.nodeReservations.set(888, h.id);
    state.flagClaims.set(777, h.id);
    tap();
    expect(h.faction).toBe(0);
    expect(h.job).toBeNull(); expect(h.order).toBeNull();
    expect(b.task).toBe('none'); expect(b.work).toBe(0); expect(b.path).toBeNull();
    expect(state.clearers[1]).toBe(0);
    expect(state.nodeReservations.has(888)).toBe(false);
    expect(state.flagClaims.has(777)).toBe(false);
    expect(h.carryingFlag).toBe(flagId);
    expect(world.flags.get(flagId)).toMatchObject({ state: 'carried', holder: h.id, owner: 0 });
  });

  it('releases an old GCC push immediately and retains carried lumber', () => {
    const { world, add, tap } = arena();
    const h = add();
    const gcc = world.gccOf(1)!;
    const b = brainOf(h);
    b.task = 'push'; b.target = gcc.id;
    gcc.gcc!.pushedBy = h.id;
    h.carryingLumber = 2;
    tap();
    expect(gcc.gcc!.pushedBy).toBe(-1);
    expect(h.carryingLumber).toBe(2);
    expect(h.faction).toBe(0);
  });

  it('releases a drum slot and a private scenery service reservation immediately', () => {
    const { world, add, tap } = arena();
    const h = add();
    const b = brainOf(h);
    b.task = 'drum'; b.target = 567; b.slot = 1;
    const slots = new Int32Array([-1, h.id]);
    unitsState(world).drumSlots.set(567, slots);
    h.brain.sceneryServices = { session: {
      id: 789, kind: 'shade', faction: 1, owner: 1, joined: 0, taskAt: -1,
      work: 0, phase: 'queue', point: { x: 1, z: 1 },
    }, reliefUntil: 0, retryAt: 0 };
    h.sceneryService = { id: 789, phase: 'queue' };
    tap();
    expect(slots[1]).toBe(-1);
    expect(sceneryServiceOf(h)).toBeNull();
    expect(h.sceneryService).toBeUndefined();
    expect(h.faction).toBe(0);
  });

  it('a distracted recruit stays converted when the real unit system resumes', () => {
    const { world, add, tap } = arena();
    const h = add();
    const b = brainOf(h);
    b.task = 'distracted'; b.danceUntil = world.time + 60;
    b.nextThinkAt = Infinity; b.hurt = true; b.stolen = true;
    h.attention = 0;
    tap();
    expect(h.attention).toBeGreaterThan(0);
    updateHippies(world, 1 / 30);
    expect(h.faction).toBe(0);
    expect(b.faction).toBe(0);
    expect(b.hurt).toBe(false); expect(b.stolen).toBe(false);
    expect(b.task).not.toBe('distracted');
  });

  it('allows recruitment above capacity and gives the recruit a new soft-cap place', () => {
    const { world, add, tap } = arena();
    const cap = popCap(world, 0);
    for (let i = 0; i < cap; i++) { const h = add(0); h.recruitedAt = 1; }
    const h = add(); h.recruitedAt = 0;
    tap();
    expect(h.faction).toBe(0);
    expect(h.recruitedAt).toBe(world.time);
    expect(aboveAttentionCap(world, h)).toBe(true);
    expect(h.attention).toBeGreaterThan(0);
  });
});
