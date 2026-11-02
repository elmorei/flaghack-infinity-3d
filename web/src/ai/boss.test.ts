import { groundHeight } from '../sim/terrain';
import { describe, expect, it } from 'vitest';
import { bossFixture } from '../../tests/bossFixture';
import { AVATAR, MAP_HALF, SIM_DT } from '../sim/constants';
import { spawnHippie } from '../sim/factory';
import { normalizeMatch } from '../sim/matchSettings';
import { CollisionWorld } from '../sim/physics/collision';
import { createMatch } from '../sim/setup';
import { Simulation } from '../sim/simulation';
import { applyCommands } from '../sim/systems/commands';
import { applyEffect } from '../sim/systems/effects';
import { dropLoose } from '../sim/systems/flags';
import { updateProjectiles } from '../sim/systems/projectiles';
import { NEUTRAL } from '../sim/types';
import { createAi } from './index';

function fixture(crouched = false) {
  const world = createMatch({ seed: 'ai-boss-throws', difficulty: 'normal', humans: [0, 1], mode: 'standard',
    match: normalizeMatch({ maxSignifiers: 0 }) });
  world.time = 245; world.effigyRevealedAt = 230; world.tide.nextAt = Infinity;
  world.boss = bossFixture();
  Object.assign(world.boss, { pos: { x: 5, z: 7 }, yaw: 0, action: 'idle', crouched,
    actionAt: world.time, nextAttackAt: Infinity, barrier: null, held: null,
    retaliateId: null, retaliateUntil: 0, objectiveAltarId: world.hearthOf(0)!.id });
  world.boss.eye.nextFireAt = Infinity;
  // The real command, throw and projectile pipeline, with scenery controlled per scenario.
  world.collision = new CollisionWorld(MAP_HALF, true);
  world.hippies.clear();
  const av = world.avatarOf(1);
  av.pos = grounded({ x: 5, y: 0, z: 24 }); av.vel = { x: 0, y: 0, z: 0 }; av.onGround = true;
  world.drainEvents();
  return { world, av, boss: world.boss, ai: createAi(world, [1]), sim: new Simulation(world) };
}

function shootOnce(f: ReturnType<typeof fixture>) {
  const { world, av, ai } = f, flagId = av.carried.at(-1)!;
  ai.update(); applyCommands(world);
  expect(world.flags.get(flagId)?.state).toBe('flying');
  expect(av.carried).not.toContain(flagId);
  expect(av.input).toMatchObject({ sprint: false, throwMode: true, moveX: 0, moveZ: 0 });
  const p = [...world.projectiles.values()][0];
  expect(Math.hypot(p.vel.x, p.vel.y, p.vel.z)).toBeCloseTo(AVATAR.throwSpeed);
  for (let tick = 0; tick < 150 && world.projectiles.size; tick++) {
    world.time += SIM_DT; world.tick++;
    updateProjectiles(world, SIM_DT);
  }
  return { flagId, events: world.drainEvents() };
}

describe('rival AI throws real Flags at the cooperative boss', () => {
  it.each([false, true])('hits the %s crouched boss, consumes a Flag once and keeps the altar objective', crouched => {
    const f = fixture(crouched), { world, boss, av } = f;
    const hp = boss.hp, altar = boss.objectiveAltarId, carried = av.carried.length;
    const { flagId, events } = shootOnce(f), impacts = events.filter(e => e.t === 'bossImpact');
    expect(impacts).toHaveLength(1);
    expect(impacts[0]).toMatchObject({ by: av.id, faction: 1, flagId,
      headshot: crouched, amount: crouched ? 300 : 100 });
    expect(boss.hp).toBe(hp - (crouched ? 300 : 100));
    expect(av.carried).toHaveLength(carried - 1);
    expect(world.flags.has(flagId)).toBe(false);
    expect(world.projectiles.size).toBe(0);
    expect(boss.objectiveAltarId).toBe(altar);
    expect(world.buildings.has(altar!)).toBe(true);
    updateProjectiles(world, SIM_DT);
    expect(boss.hp).toBe(hp - (crouched ? 300 : 100));
  });

  it('uses reachable headshots from an elevated firing position', () => {
    const f = fixture(); f.av.pos.y = 20;
    const hp = f.boss.hp;
    const { events } = shootOnce(f);
    expect(events.filter(e => e.t === 'bossImpact')).toMatchObject([{ headshot: true, amount: 300 }]);
    expect(f.boss.hp).toBe(hp - 300);
  });

  it.each([false, true])('aims at rotated targets from multiple directions and distances (crouched=%s)', crouched => {
    for (const angle of [0, .8, 2.2, 3.1]) for (const distance of [8, 17, 25]) {
      const f = fixture(crouched);
      f.boss.yaw = .65;
      f.av.pos.x = f.boss.pos.x + Math.sin(angle) * distance;
      f.av.pos.z = f.boss.pos.z + Math.cos(angle) * distance;
      f.av.pos.y = groundHeight(f.av.pos.x, f.av.pos.z, MAP_HALF);
      const { events } = shootOnce(f);
      expect(events.filter(e => e.t === 'bossImpact')).toHaveLength(1);
    }
  });

  it('will not throw into a tall obstruction or accidentally deposit at friendly storage', () => {
    for (const storage of [false, true]) {
      const { world, av, boss, ai } = fixture(), ammo = [...av.carried], hp = boss.hp;
      const altar = world.hearthOf(1)!, stock = world.stockOf(altar.id).length;
      // Actual friendly hearth tag exercises the projectile's deposit destination.
      world.collision.addBox(5, 20, 12, .5, 0, 0, 40, storage ? altar.id : -9000);
      ai.update(); applyCommands(world);
      expect(av.carried).toEqual(ammo);
      expect(world.projectiles.size).toBe(0);
      expect(world.stockOf(altar.id).length).toBe(stock);
      expect(boss.hp).toBe(hp);
      expect(Math.hypot(av.input.moveX, av.input.moveZ)).toBeGreaterThan(0);
      expect(world.drainEvents().some(e => e.t === 'flagThrown')).toBe(false);
    }
  });

  it('finds an elevated arc over a low wall and still damages the boss', () => {
    const f = fixture();
    f.world.collision.addBox(5, 16, 8, .5, 0, 0, 4, -9000);
    const hp = f.boss.hp;
    const { events } = shootOnce(f);
    expect(events.filter(e => e.t === 'bossImpact')).toHaveLength(1);
    expect(f.boss.hp).toBe(hp - 100);
  });

  it('honors the throw cooldown and holds a firing position between releases', () => {
    const { world, ai, av } = fixture(), count = av.carried.length;
    ai.update(); applyCommands(world);
    expect(av.carried).toHaveLength(count - 1);
    const ready = av.throwReadyAt;
    for (let i = 0; i < 8; i++) {
      world.time += SIM_DT; world.tick++; ai.update(); applyCommands(world);
      expect(world.time).toBeLessThan(ready);
      expect(av.carried).toHaveLength(count - 1);
      expect(av.input.moveX).toBe(0); expect(av.input.moveZ).toBe(0);
    }
    world.time = ready; ai.update(); applyCommands(world);
    expect(av.carried).toHaveLength(count - 2);
  });

  it.each(['stunned', 'knocked out', 'cooling down'] as const)('does not release Flags while %s', condition => {
    const { world, av, ai } = fixture(), ammo = av.carried.length;
    if (condition === 'stunned') applyEffect(world, av, 'stun', 1);
    else if (condition === 'knocked out') av.koUntil = world.time + 1;
    else av.throwReadyAt = world.time + 1;
    ai.update(); applyCommands(world);
    expect(av.carried).toHaveLength(ammo);
    expect(world.projectiles.size).toBe(0);
    expect(world.drainEvents().some(e => e.t === 'flagThrown')).toBe(false);
  });

  it('with no ammunition closes distance and uses normal melee, without attacking allied factions', () => {
    const f = fixture(), { world, ai, av, boss, sim } = f;
    for (const id of [...av.carried]) dropLoose(world, id, { x: -50, y: 0, z: -50 });
    ai.update(); applyCommands(world);
    expect(world.projectiles.size).toBe(0);
    expect(Math.hypot(av.input.moveX, av.input.moveZ)).toBeGreaterThan(0);
    av.pos = grounded({ x: boss.pos.x, y: 0, z: boss.pos.z + 6 });
    const ally = world.avatarOf(0); ally.pos = { x: av.pos.x, y: 0, z: av.pos.z - 1 };
    const hp = boss.hp, allyHp = ally.hp;
    ai.update(); sim.step();
    expect(av.action.kind).toBe('swing');
    for (let i = 0; i < 14; i++) sim.step();
    expect(boss.hp).toBe(hp - AVATAR.swingDamage);
    expect(ally.hp).toBe(allyHp);
  });

  it('the full sim delivers boss damage while the surviving altar remains the encounter objective', () => {
    const { world, ai, sim, boss } = fixture(), hp = boss.hp, altar = boss.objectiveAltarId;
    const events = [];
    for (let i = 0; i < 70; i++) { ai.update(); sim.step(); events.push(...world.drainEvents()); }
    const impacts = events.filter(e => e.t === 'bossImpact');
    expect(impacts.length).toBeGreaterThan(0);
    expect(boss.hp).toBeLessThan(hp);
    expect(boss.objectiveAltarId).toBe(altar);
    expect(world.buildings.get(altar!)?.hp).toBeGreaterThan(0);
    expect(world.factions[0].alive).toBe(true);
  });

  it('leads a walking boss with live AI observations in the full simulation', () => {
    const { world, ai, sim, boss } = fixture(), altar = boss.objectiveAltarId;
    boss.nextAttackAt = 0; boss.nextSceneryStompStride = Infinity;
    world.scratch.bossRetaliateAfter = Infinity;
    const start = { ...boss.pos }, events = [];
    for (let i = 0; i < 180; i++) { ai.update(); sim.step(); events.push(...world.drainEvents()); }
    const throws = events.filter(e => e.t === 'flagThrown'), hits = events.filter(e => e.t === 'bossImpact');
    expect(Math.hypot(boss.pos.x - start.x, boss.pos.z - start.z)).toBeGreaterThan(5);
    expect(throws.length).toBeGreaterThan(1);
    expect(hits.length).toBeGreaterThanOrEqual(throws.length / 2);
    expect(boss.objectiveAltarId).toBe(altar);
    expect(world.buildings.get(altar!)?.hp).toBeGreaterThan(0);
  });

  it('ignores faction allies as projectile blockers but avoids a neutral catching the throw', () => {
    const f = fixture();
    // A catcher overlapping the throwing hand catches every possible release in the real sim.
    spawnHippie(f.world, NEUTRAL, { x: f.av.pos.x + .25, z: f.av.pos.z - .35 });
    const ammo = f.av.carried.length;
    f.ai.update(); applyCommands(f.world);
    expect(f.av.carried).toHaveLength(ammo);
    expect(f.world.projectiles.size).toBe(0);
    f.world.hippies.clear();
    spawnHippie(f.world, 0, { x: f.av.pos.x + .25, z: f.av.pos.z - .35 });
    f.world.time += .25;
    const { events } = shootOnce(f);
    expect(events.filter(e => e.t === 'bossImpact')).toHaveLength(1);
  });

  it('does not fire at a dying boss or replace pre-boss survey behavior', () => {
    const f = fixture(), ammo = f.av.carried.length;
    f.boss.hp = 0;
    f.ai.update(); applyCommands(f.world);
    expect(f.av.carried).toHaveLength(ammo);
    expect(f.world.projectiles.size).toBe(0);
    expect(f.av.input).toMatchObject({ moveX: 0, moveZ: 0, sprint: false, throwMode: false });
    f.world.boss = null;
    f.world.tick = 10;
    f.ai.update();
    expect(f.ai.inspect(1)!.view.at).toBe(f.world.time);
  });
});

function grounded(p: { x: number; y: number; z: number }) { return { ...p, y: p.y + groundHeight(p.x, p.z, MAP_HALF) }; }
