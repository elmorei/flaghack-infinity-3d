import { describe, expect, it } from 'vitest';
import { AVATAR, HIPPIE, SIM_DT } from '../constants';
import { spawnBuilding, spawnHippie } from '../factory';
import { normalizeMatch } from '../matchSettings';
import { createMatch } from '../setup';
import type { Hippie } from '../types';
import { damageEntity } from './combat';
import { eventsOf, freeThickFacet, newMatch, run } from './econ/testkit';
import { popCap, population } from './economy';
import { canPlantAt } from './flags';
import { updateHippies } from './hippies';
import { cmdHandFlag, handFlagBlocker, recruitNear } from './recruitment';
import { brainOf } from './units/brain';
import { unitsState } from './units/state';
import { neutralizeHippie } from './victory';

function arena() {
  const m = newMatch('recruitment-suite');
  const { world } = m;
  world.hippies.clear();
  world.tide.nextAt = Infinity;
  const n = world.lattice.nodes.find((n) => !n.boundary && Math.abs(n.x) < 100 && Math.abs(n.z) < 100 &&
    canPlantAt(world, n.id, 0) && !world.collision.blockedCircle(n.x, n.z, 12, 0.05, 4))!;
  const av = world.avatarOf(0);
  Object.assign(av.pos, { x: n.x, y: 0, z: n.z });
  return m;
}

function holdIdle(h: Hippie): void {
  const b = brainOf(h);
  b.faction = h.faction;
  b.task = h.faction === -1 ? 'wander' : 'idle';
  b.waitUntil = Infinity;
  b.nextThinkAt = Infinity;
}

describe('shared population recruitment', () => {
  it('hands an actual quiver Flag to a neutral without creating either entity', () => {
    const { world } = arena();
    const av = world.avatarOf(0);
    const h = spawnHippie(world, -1, { x: av.pos.x, z: av.pos.z + 2 });
    const flagId = av.carried.at(-1)!;
    const flags = world.flags.size;
    const quiver = av.carried.length;
    world.time = 7;
    cmdHandFlag(world, { t: 'handFlag', faction: 0, hippieId: h.id });
    expect(h.faction).toBe(0);
    expect(h.recruitedAt).toBe(7);
    expect(h.carryingFlag).toBe(flagId);
    expect(world.flags.get(flagId)).toMatchObject({ state: 'carried', holder: h.id, owner: 0 });
    expect(av.carried).toHaveLength(quiver - 1);
    expect(world.hippies.size).toBe(1);
    expect(world.flags.size).toBe(flags);
    expect(world.drainEvents()).toContainEqual({ t: 'recruited', hippieId: h.id, faction: 0, via: 'hand' });
  });

  it('rejects handoffs to distant, affiliated, KO or obstructed targets without spending Flags', () => {
    const { world } = arena();
    const av = world.avatarOf(0);
    const h = spawnHippie(world, -1, { x: av.pos.x, z: av.pos.z + 8 });
    const quiver = [...av.carried];
    const rejected = () => {
      expect(handFlagBlocker(world, 0, h.id)).not.toBe('');
      cmdHandFlag(world, { t: 'handFlag', faction: 0, hippieId: h.id });
      expect(av.carried).toEqual(quiver);
    };
    rejected();
    h.pos.z = av.pos.z + 2;
    h.faction = 1;
    rejected();
    h.faction = -1;
    h.status = 'ko';
    rejected();
    h.status = 'idle';
    expect(handFlagBlocker(world, 0, h.id)).toBe('');
    world.collision.addBox(av.pos.x, av.pos.z + 1, 2, 0.1, 0, 0, 3, -9999);
    rejected();
    expect(h.faction).toBe(-1);
  });

  it('a thrown Flag recruits on contact without damage, preserving the Flag and population', () => {
    const m = arena();
    const { world } = m;
    const av = world.avatarOf(0);
    const h = spawnHippie(world, -1, { x: av.pos.x, z: av.pos.z + 7 });
    holdIdle(h);
    const carried = [...av.carried];
    const flags = world.flags.size;
    world.submit({ t: 'avatarInput', faction: 0, input: { moveX: 0, moveZ: 0, jump: false, sprint: false, throwMode: true, yaw: 0, pitch: -AVATAR.throwPitchBias } });
    world.submit({ t: 'throw', faction: 0 });
    for (let i = 0; i < 90 && h.faction === -1; i++) run(m, SIM_DT);
    expect(h.faction).toBe(0);
    expect(h.hp).toBe(HIPPIE.maxHp);
    expect(carried).toContain(h.carryingFlag);
    expect(world.flags.get(h.carryingFlag)).toMatchObject({ state: 'carried', holder: h.id, owner: 0 });
    expect(world.projectiles.size).toBe(0);
    expect(world.flags.size).toBe(flags);
    expect(world.hippies.size).toBe(1);
    expect(eventsOf(m, 'recruited').map((e) => e.via)).toEqual(['throw']);
  });

  it.each([0, 6])('with %i Drum Circles, recruits beyond capacity and drains only the newest excess recruits while idle at home', (circles) => {
    const { world } = arena();
    const home = world.hearthOf(0)!;
    const at = { x: home.pos.x + 6, z: home.pos.z };
    for (let i = 0; i < circles; i++) {
      spawnBuilding(world, 'drumcircle', 0, freeThickFacet(world, home.pos.x, home.pos.z, 12, 'drumcircle'), 1);
    }
    expect(popCap(world, 0)).toBe(12 + 6 * circles);
    // The oldest entity joins last: recruitment time, not entity age, chooses the excess.
    const extra = spawnHippie(world, -1, at);
    const established = Array.from({ length: popCap(world, 0) }, () => spawnHippie(world, 0, at));
    world.time = 10;
    const av = world.avatarOf(0);
    Object.assign(av.pos, { x: at.x + 1, y: 0, z: at.z });
    cmdHandFlag(world, { t: 'handFlag', faction: 0, hippieId: extra.id });
    expect(extra.faction).toBe(0);
    expect(population(world, 0)).toBe(popCap(world, 0) + 1);
    unitsState(world).nextAllocAt.fill(Infinity);
    for (const h of [extra, ...established]) { h.attention = 50; holdIdle(h); }
    updateHippies(world, 1);
    expect(extra.attention).toBe(50 - HIPPIE.overCapAttentionDrain);
    expect(established.every((h) => h.attention > 50)).toBe(true);
    extra.attention = HIPPIE.overCapAttentionDrain / 2;
    updateHippies(world, 1);
    expect(brainOf(extra).task).toBe('distracted');
    expect(world.drainEvents()).toContainEqual({ t: 'distracted', hippieId: extra.id, faction: 0 });

    const circle = spawnBuilding(world, 'drumcircle', 0, freeThickFacet(world, home.pos.x, home.pos.z, 12, 'drumcircle'), 1);
    extra.attention = 50;
    Object.assign(extra.pos, at);
    holdIdle(extra);
    updateHippies(world, 1);
    expect(extra.attention).toBeGreaterThan(50);
    circle.disabled = true;
    extra.attention = 50;
    holdIdle(extra);
    updateHippies(world, 1);
    expect(extra.attention).toBe(50 - HIPPIE.overCapAttentionDrain);
  });

  it('one camp can recruit more than 40 from a larger configured world population', () => {
    const world = createMatch({ seed: 'large-population', difficulty: 'normal', humans: [0], mode: 'standard',
      match: normalizeMatch({ maxSignifiers: 60, startingSignifiers: 0 }) });
    const gcc = world.gccOf(0)!;
    const ids = [...world.hippies.keys()];
    for (const h of world.hippies.values()) Object.assign(h.pos, { x: gcc.pos.x + 8, z: gcc.pos.z });
    for (let i = 0; i < 50; i++) expect(recruitNear(world, gcc)).toBe(true);
    expect(population(world, 0)).toBe(50);
    expect(popCap(world, 0)).toBe(12);
    expect([...world.hippies.values()].filter((h) => h.faction === -1)).toHaveLength(10);
    expect([...world.hippies.keys()]).toEqual(ids);
  });

  it('KO and camp elimination retain the same hippie, which respawns neutral and can join another camp', () => {
    const m = arena();
    const { world } = m;
    const av = world.avatarOf(0);
    const h = spawnHippie(world, 0, { x: av.pos.x, z: av.pos.z + 2 });
    h.order = { kind: 'follow', avatarId: av.id };
    damageEntity(world, h.id, HIPPIE.maxHp, -1);
    expect(h.order).toBeNull();
    neutralizeHippie(world, h);
    expect(h.status).toBe('ko');
    run(m, HIPPIE.respawnTime + SIM_DT);
    expect(world.hippies.get(h.id)).toBe(h);
    expect(world.hippies.size).toBe(1);
    expect(h).toMatchObject({ faction: -1, koUntil: 0, hp: HIPPIE.maxHp, beacon: false });
    const other = world.avatarOf(1);
    Object.assign(other.pos, { x: av.pos.x, y: 0, z: av.pos.z });
    Object.assign(h.pos, { x: other.pos.x, z: other.pos.z + 2 });
    cmdHandFlag(world, { t: 'handFlag', faction: 1, hippieId: h.id });
    expect(h.faction).toBe(1);
    expect(world.hippies.size).toBe(1);
  });

  it('competing recruiters claim a neutral once and unavailable buildings recruit nobody', () => {
    const { world } = arena();
    const a = world.gccOf(0)!;
    const b = world.gccOf(1)!;
    Object.assign(b.pos, a.pos);
    const h = spawnHippie(world, -1, { x: a.pos.x + 8, z: a.pos.z });
    a.disabled = true;
    expect(recruitNear(world, a)).toBe(false);
    a.disabled = false;
    a.built = 0.5;
    expect(recruitNear(world, a)).toBe(false);
    a.built = 1;
    expect(recruitNear(world, a)).toBe(true);
    expect(recruitNear(world, b)).toBe(false);
    expect(h.faction).toBe(0);
    expect(world.hippies.size).toBe(1);
  });
});
