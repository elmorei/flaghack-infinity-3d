import { groundHeight } from '../../terrain';
import { describe, expect, it } from 'vitest';
import { BOSS_TIMING } from '../../boss';
import { BOSS_HEIGHT } from '../../bossDimensions';
import { BUILDING_HEIGHT, CRYSTAL_HEIGHT, WARD_FLAG_RADIUS } from '../../constants';
import { spawnBuilding, spawnCrystal, spawnFlag } from '../../factory';
import { createMatch } from '../../setup';
import { normalizeMatch } from '../../matchSettings';
import { spawnBoss, updateBoss } from '../boss';
import { damageEntity } from '../combat';
import { defendedPullRate } from '../flags';
import { updateBossOutcome } from '../victory';
import { activeBossCrystals, bossCrystalExposure, bossLightningTarget, syncBossLightning, updateBossLightning } from './lightning';

function encounter() {
  const world = createMatch({ seed: 'boss-defensive-lightning', difficulty: 'normal', humans: [0], mode: 'standard' });
  world.time = 100; world.effigyRevealedAt = 100;
  const boss = spawnBoss(world)!; boss.action = 'idle'; boss.pos = { x: 0, z: 0 };
  world.crystals.clear(); world.buildings.clear(); world.flags.clear(); world.hippies.clear(); world.pieces.clear();
  const crystal = (x: number, z = 0, scale = 1) => {
    const c = spawnCrystal(world, 0, 0, []); c.pos = { x, z }; c.scale = scale; c.growth = 1; return c;
  };
  const step = (dt: number) => { world.time += dt; world.tick++; updateBossLightning(world, boss, dt); };
  world.drainEvents();
  return { world, boss, crystal, step };
}
function wardEncounter() {
  const e = encounter(), flag = spawnFlag(e.world, { state: 'planted', owner: 0, pos: { x: 0, y: 0, z: 10 }, node: 0 });
  const ward = spawnBuilding(e.world, 'ward', 0, 0, 1); ward.pos = { x: WARD_FLAG_RADIUS, z: 10 };
  e.boss.action = 'grab'; e.boss.crouched = true; e.boss.actionAt = e.world.time;
  e.boss.target = { kind: 'flag', id: flag.id };
  return { ...e, flag, ward };
}

describe('authoritative defensive boss lightning', () => {
  it.each([false, true])('preserves boss crystal/ward lightning with ordinary crystal rules %s', enabled => {
    const e = wardEncounter(), start = e.boss.hp;
    e.world.options.match = normalizeMatch({ crystalAttacks: enabled, crystalFlagProtection: enabled, buildingCapture: enabled });
    e.crystal(5); e.step(1);
    expect(e.boss.hp).toBe(start - 50);
    expect(e.boss.lightning.map(link => link.kind).sort()).toEqual(['crystal', 'ward']);
    expect(defendedPullRate(e.world, e.flag, 1, false)).toBeLessThan(1);
  });
  it('stacks two ordinary Crystals at 50 damage per second with inclusive ground-space boundaries', () => {
    const e = encounter(), start = e.boss.hp;
    e.crystal(50); e.crystal(0, -50); const outside = e.crystal(50.0001); e.step(1);
    expect(e.boss.hp).toBe(start - 50); expect(activeBossCrystals(e.world, e.boss)).toHaveLength(2);
    expect(e.boss.lightning.map(a => a.id)).not.toContain(outside.id);
    expect(e.world.drainEvents().filter(a => a.t === 'hit')).toMatchObject([{ amount: 25 }, { amount: 25 }]);
  });
  it.each([1, 10, 60, 144])('applies exactly one second of DPS in %s steps', steps => {
    const e = encounter(), start = e.boss.hp; e.crystal(5); e.crystal(-5); e.crystal(500, 500, 10);
    for (let i = 0; i < steps; i++) e.step(1 / steps);
    expect(start - e.boss.hp).toBeCloseTo(100, 7);
  });
  it('gives the manifested Easter-egg Crystal unlimited range and 50 DPS independently of ordinary Crystals', () => {
    const e = encounter(), giant = e.crystal(1000, -1000, 10), start = e.boss.hp;
    e.crystal(1000, 1000); e.crystal(0); e.step(2); expect(e.boss.hp).toBe(start - 150);
    expect(activeBossCrystals(e.world, e.boss).map(c => c.id)).toContain(giant.id);
    expect(e.boss.lightning.find(a => a.id === giant.id)?.from).toEqual({ x: 1000, y: 75, z: -1000 });
    giant.pos = { x: -800, z: 800 }; e.step(1); expect(e.boss.hp).toBe(start - 225);
  });
  it('never shocks from unmanifested, eliminated or removed Crystals', () => {
    const e = encounter(), c = e.crystal(0, 0, 10), start = e.boss.hp;
    c.growth = .9999; e.step(1); expect(e.boss.hp).toBe(start); expect(e.boss.lightning).toEqual([]);
    c.growth = 1; e.world.factions[0].alive = false; e.step(1); expect(e.boss.hp).toBe(start);
    e.world.factions[0].alive = true; e.world.crystals.delete(c.id); e.step(1); expect(e.boss.hp).toBe(start);
  });
  it.each([1, 20, 120])('integrates entry and exit exposure across a 50 m boundary in %s movement steps', steps => {
    const e = encounter(), start = e.boss.hp; e.crystal(0); e.boss.pos.x = 60; updateBossLightning(e.world, e.boss, 0);
    for (let i = 1; i <= steps; i++) { e.boss.pos.x = 60 - 20 * i / steps; e.step(1 / steps); }
    expect(start - e.boss.hp).toBeCloseTo(12.5, 7);
    for (let i = 1; i <= steps; i++) { e.boss.pos.x = 40 + 20 * i / steps; e.step(1 / steps); }
    expect(start - e.boss.hp).toBeCloseTo(25, 7); expect(e.boss.lightning).toEqual([]);
  });
  it('integrates a full-circle pass in one coarse tick and handles a tangent or stationary boundary', () => {
    expect(bossCrystalExposure({ x: -60, z: 0 }, { x: 60, z: 0 }, { x: 0, z: 0 })).toBeCloseTo(5 / 6);
    expect(bossCrystalExposure({ x: -60, z: 50 }, { x: 60, z: 50 }, { x: 0, z: 0 })).toBe(0);
    expect(bossCrystalExposure({ x: 50, z: 0 }, { x: 50, z: 0 }, { x: 0, z: 0 })).toBe(1);
    const e = encounter(), start = e.boss.hp; e.crystal(0); e.boss.pos.x = -60;
    updateBossLightning(e.world, e.boss, 0); e.boss.pos.x = 60; e.step(1.2); expect(start - e.boss.hp).toBeCloseTo(25, 8);
  });
  it('does not replay damage at a duplicate timestamp or bill paused/invalid dt', () => {
    const e = encounter(), start = e.boss.hp; e.crystal(0); e.step(1);
    for (let i = 0; i < 10; i++) updateBossLightning(e.world, e.boss, 1);
    expect(e.boss.hp).toBe(start - 25);
    for (const dt of [0, -1, NaN, Infinity]) { e.world.time++; updateBossLightning(e.world, e.boss, dt); }
    expect(e.boss.hp).toBe(start - 25);
  });
  it('uses only live Wards that protect the actual planted Flag under attack', () => {
    const e = wardEncounter(), start = e.boss.hp; e.step(1); expect(e.boss.hp).toBe(start - 25);
    expect(e.boss.lightning).toMatchObject([{ kind: 'ward', id: e.ward.id, from: { y: groundHeight(e.ward.pos.x,e.ward.pos.z,e.world.map.half) + BUILDING_HEIGHT.ward } }]);
    e.ward.pos.x += .0001; e.step(.1); expect(e.boss.hp).toBe(start - 25);
    e.ward.pos.x -= .0001; e.ward.faction = 1; e.step(.1); expect(e.boss.hp).toBe(start - 25);
    e.ward.faction = 0; e.ward.built = .99; e.step(.1); expect(e.boss.hp).toBe(start - 25);
    e.ward.built = 1; e.ward.disabled = true; e.step(.1); expect(e.boss.hp).toBe(start - 25);
    e.ward.disabled = false; e.flag.state = 'loose'; e.step(.1); expect(e.boss.hp).toBe(start - 25);
  });
  it.each(['idle', 'walk', 'crouch', 'stomp', 'swipe'] as const)('does not shock a %s boss merely because a protected Flag is nearby', action => {
    const e = wardEncounter(), start = e.boss.hp; e.boss.action = action; e.step(.5);
    expect(e.boss.hp).toBe(start); expect(e.boss.lightning).toEqual([]);
  });
  it('does not defend a nearby unrelated target or a Flag outside arm reach', () => {
    const e = wardEncounter(), start = e.boss.hp;
    e.boss.target = { kind: 'avatar', id: e.world.avatarOf(0).id }; e.step(.1); expect(e.boss.hp).toBe(start);
    e.boss.target = { kind: 'flag', id: e.flag.id }; e.boss.pos.x = 100; e.step(.1); expect(e.boss.hp).toBe(start);
  });
  it('bills only the Flag attack window even if a coarse step spans consumption, then clears after consumption', () => {
    const e = wardEncounter(), start = e.boss.hp; e.step(4);
    expect(start - e.boss.hp).toBeCloseTo(25 * BOSS_TIMING.consume, 8); expect(e.boss.lightning).toEqual([]);
    e.world.time = 100; e.boss.actionAt = 100; delete e.world.scratch.bossLightningClock;
    e.world.time += BOSS_TIMING.consume; updateBoss(e.world, BOSS_TIMING.consume);
    expect(e.world.flags.has(e.flag.id)).toBe(false); expect(e.boss.lightning).toEqual([]);
  });
  it('preserves player Flag-pull semantics: lightning still slows pulling and never hurts ordinary units', () => {
    const e = wardEncounter(), avatar = e.world.avatarOf(1), hp = avatar.hp;
    expect(defendedPullRate(e.world, e.flag, 1, true)).toBeLessThan(1); expect(avatar.hp).toBe(hp); expect(e.boss.hp).toBe(e.boss.maxHp);
    expect(e.world.drainEvents().filter(a => a.t === 'wardLightning')).toHaveLength(1);
  });
  it('replicates exact scale-correct source tips and a posed boss endpoint', () => {
    const e = encounter(), c = e.crystal(0), large = e.crystal(500, 0, 10);
    e.boss.crouched = true; e.boss.action = 'grab'; e.boss.yaw = 1.4; syncBossLightning(e.world, e.boss);
    expect(BOSS_HEIGHT).toBe(32); expect(e.boss.lightning.find(a => a.id === c.id)?.from.y).toBe(2 + CRYSTAL_HEIGHT);
    expect(e.boss.lightning.find(a => a.id === large.id)?.from.y).toBe(75);
    for (const arc of e.boss.lightning) expect(arc.to).toEqual(bossLightningTarget(e.boss, e.world.time));
    expect(e.boss.lightning[0].to.y).toBeLessThan(BOSS_HEIGHT);
  });
  it('lethal lightning uses normal boss death and stops a ready eye attack before it can fire', () => {
    const e = encounter(); e.crystal(0); e.boss.hp = 1; e.boss.eye.nextFireAt = 100; e.world.time = 101; updateBoss(e.world, 1);
    expect(e.boss.hp).toBe(0); expect(e.boss.action).toBe('death'); expect(e.boss.eye.firedAt).toBeNull(); expect(e.boss.lightning).toEqual([]);
    e.world.drainEvents(); e.world.time++; updateBoss(e.world, 1); expect(e.world.drainEvents().filter(a => a.t === 'hit')).toEqual([]);
  });
  it('clears immediately when another source kills the boss or the match ends', () => {
    const e = encounter(); e.crystal(0); e.step(1); expect(e.boss.lightning).toHaveLength(1);
    damageEntity(e.world, e.boss.id, e.boss.hp, -1); expect(e.boss.lightning).toEqual([]);
    const ended = encounter(); ended.crystal(0); ended.step(1); ended.world.factions[0].alive = false;
    updateBossOutcome(ended.world); expect(ended.world.phase).toBe('ended'); expect(ended.boss.lightning).toEqual([]);
    const hp = ended.boss.hp; ended.step(1); expect(ended.boss.hp).toBe(hp);
  });
});
