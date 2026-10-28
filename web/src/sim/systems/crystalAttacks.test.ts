import { describe, expect, it } from 'vitest';
import { crystalAttackFixture } from '../../../tests/crystalAttackFixture';
import { CRYSTAL_ATTACK_DPS, updateCrystalAttacks } from './crystalAttacks';
import { damageEntity } from './combat';
import { updateCrystals } from './crystals';
import { freeFocus, newMatch, plantFresh, runRules } from './rules/testWorld';
import { CollisionWorld } from '../physics/collision';
import { spawnHippie } from '../factory';
import { dropLoose } from './flags';
import { HIPPIE, SIM_DT } from '../constants';
import { act } from './units/act';
import { brainOf } from './units/brain';
import { decide } from './units/decide';
import { unitsState } from './units/state';

describe('ordinary crystal unit defense', () => {
  it('warns for a full second, then a lone raider takes 12 HP/s without stun or resetting its pull', () => {
    const e = crystalAttackFixture(), c = e.crystal(), h = e.unit();
    const av = [...e.world.avatars.values()].find(a => a.faction === 1)!;
    av.pos = { x: 8, y: 0, z: 0 }; av.action = { kind: 'pull', flagId: -1, t: .8, dur: 4.8 };
    updateCrystalAttacks(e.world, 0); expect(c.attack).toEqual({ target: av.id, readyAt: 11, faction: 0 });
    e.step(.9); expect(av.hp).toBe(200); e.step(.1); expect(av.hp).toBe(200);
    e.step(3); expect(av.hp).toBeCloseTo(164); expect(h.hp).toBe(100);
    expect(av.action).toEqual({ kind: 'pull', flagId: -1, t: .8, dur: 4.8 }); expect(av.effects).toEqual([]);
    updateCrystalAttacks(e.world, 3); expect(av.hp).toBeCloseTo(164); // same timestamp cannot double-bill
  });
  it('keeps its first raider locked while a second attacker advances and ignores nearby defenders/neutrals', () => {
    const e = crystalAttackFixture(), c = e.crystal(), first = e.unit(12), second = e.unit(14), defender = e.unit(2, 0, 0), neutral = e.unit(1, 0, -1);
    updateCrystalAttacks(e.world, 0); second.pos.x = 3; e.step(2);
    expect(c.attack?.target).toBe(first.id); expect(first.hp).toBe(88); expect(second.hp).toBe(100);
    expect(defender.hp).toBe(100); expect(neutral.hp).toBe(100);
    first.pos.x = 17; e.step(.1); expect(c.attack?.target).toBe(second.id); expect(c.attack?.readyAt).toBeCloseTo(e.world.time + 1);
    e.step(.9); expect(second.hp).toBe(100); e.step(.2); expect(second.hp).toBeCloseTo(98.8);
  });
  it('caps overlapping sources at 18 HP/s, independent of count and timestep partition', () => {
    const run = (count: number, steps: number[]) => {
      const e = crystalAttackFixture(), h = e.unit(); for (let i = 0; i < count; i++) e.crystal(0, i * .1);
      updateCrystalAttacks(e.world, 0); for (const dt of steps) e.step(dt); return h.hp;
    };
    expect(run(1, [3])).toBeCloseTo(76); expect(run(2, [3])).toBeCloseTo(64); expect(run(6, [3])).toBeCloseTo(64);
    expect(run(6, Array(180).fill(1 / 60))).toBeCloseTo(64, 7);
  });
  it('integrates staggered warning expiries without applying the overlap cap too early', () => {
    const e = crystalAttackFixture(), h = e.unit(); e.crystal(); updateCrystalAttacks(e.world, 0);
    e.step(.5); e.crystal(0, 1); updateCrystalAttacks(e.world, 0); e.step(2);
    expect(h.hp).toBeCloseTo(76); // .5 s at 12, then 1 s at 18
  });
  it('drops the lock behind solid cover and warns again after retreat/re-entry', () => {
    const e = crystalAttackFixture(), c = e.crystal(), h = e.unit(); updateCrystalAttacks(e.world, 0); e.step(1.5);
    const hp = h.hp, wall = e.world.collision.addBox(5, 0, .2, 3, 0, 0, 10, 999);
    e.step(2); expect(c.attack).toBeNull(); expect(h.hp).toBe(hp);
    e.world.collision.remove(wall); e.step(.1); expect(c.attack?.readyAt).toBeCloseTo(e.world.time + 1);
    h.pos.x = 16.001; e.step(2); expect(c.attack).toBeNull(); expect(h.hp).toBe(hp);
    h.pos.x = 16; e.step(.1); expect(c.attack).not.toBeNull(); e.step(1); expect(h.hp).toBe(hp);
    e.step(.5); expect(h.hp).toBeCloseTo(hp - 6);
  });
  it('excludes growing/giant crystals and resets on disabled settings, tutorial, owner change, KO, alliance and match end', () => {
    const e = crystalAttackFixture(), c = e.crystal(), h = e.unit();
    c.growth = .99; updateCrystalAttacks(e.world, 0); expect(c.attack).toBeNull(); c.growth = 1;
    c.scale = 10; e.step(2); expect(c.attack).toBeNull(); c.scale = 1;
    e.world.options.match!.crystalAttacks = false; e.step(2); expect(c.attack).toBeNull(); e.world.options.match!.crystalAttacks = true;
    e.world.options.mode = 'tutorial'; e.step(2); expect(c.attack).toBeNull(); e.world.options.mode = 'standard';
    e.step(0); const firstReady = c.attack!.readyAt; c.faction = 2; e.step(.5); expect(c.attack!.readyAt).toBeGreaterThan(firstReady);
    h.status = 'ko'; e.step(2); expect(c.attack).toBeNull(); h.status = 'idle'; e.step(0); expect(c.attack).not.toBeNull();
    e.world.effigyRevealedAt = e.world.time; e.step(2); expect(c.attack).toBeNull(); expect(damageEntity(e.world, h.id, 10, c.id)).toBe(false);
    e.world.effigyRevealedAt = null; e.step(0); e.world.phase = 'ended'; e.step(2); expect(c.attack).toBeNull(); expect(h.hp).toBe(100);
  });
  it.each([1, 2])('a raider completes a protected support-Flag pull under %s crystal(s) without losing progress', count => {
    const e = crystalAttackFixture(), flag = [...e.world.flags.values()].find(f => f.owner === 1 && f.state === 'planted')!;
    const h = e.unit(flag.pos.x, flag.pos.z, 0); h.order = { kind: 'pull', flagId: flag.id };
    for (let i = 0; i < count; i++) { const c = e.crystal(flag.pos.x + 5, flag.pos.z + i, 1); c.pentacle = [flag.node]; }
    const brain = brainOf(h), state = unitsState(e.world); decide(e.world, state, h, brain, 0);
    updateCrystalAttacks(e.world, 0);
    for (let i = 0; i < Math.ceil((HIPPIE.pullEnemyTime * 2 + SIM_DT) / SIM_DT); i++) {
      e.world.time += SIM_DT; e.world.tick++; act(e.world, state, h, brain, 0, SIM_DT); updateCrystalAttacks(e.world, SIM_DT);
    }
    expect(flag.state).toBe('carried'); expect(flag.holder).toBe(h.id); expect(h.hp).toBeGreaterThan(25);
    expect(h.effects).toEqual([]); expect(h.status).not.toBe('ko');
  });
  it('a real sustaining pentacle loss shatters the source and ends damage without crystal HP', () => {
    const world = newMatch('attack-real-pentacle'); world.tide.nextAt = Infinity; runRules(world, 1 / 30);
    const node = freeFocus(world, 0), ids = plantFresh(world, 0, world.lattice.neighbors(node)); runRules(world, 1 / 30);
    const c = [...world.crystals.values()].find(c => c.node === node)!; c.growth = 1; world.collision = new CollisionWorld();
    world.hippies.clear(); for (const a of world.avatars.values()) a.pos = { x: 140, y: 0, z: 100 + a.faction * 10 };
    const h = spawnHippie(world, 1, { x: c.pos.x + 10, z: c.pos.z });
    updateCrystalAttacks(world, 0); expect(c.attack?.target).toBe(h.id); world.time += 2; updateCrystalAttacks(world, 2); expect(h.hp).toBeCloseTo(100 - CRYSTAL_ATTACK_DPS);
    const flag = world.flags.get(ids[0])!; dropLoose(world, flag.id, { ...flag.pos }); runRules(world, 1 / 30); updateCrystals(world, 0);
    expect(world.crystals.has(c.id)).toBe(false); const hp = h.hp; world.time += 3; updateCrystalAttacks(world, 3); expect(h.hp).toBe(hp); expect(c).not.toHaveProperty('hp');
  });
});
