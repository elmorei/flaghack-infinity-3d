import { describe, expect, it, vi } from 'vitest';
import { SnapshotEncoder } from '../../../net/codec';
import { NetMirror } from '../../../net/mirror';
import { HIPPIE, SIM_DT } from '../../constants';
import { bossRevealTime, EFFIGY_POLE_CONSUMED_AT } from '../../effigyBurn';
import { spawnHippie } from '../../factory';
import { burnTime, normalizeMatch, UNLIMITED_DAYS, type MatchSettings } from '../../matchSettings';
import { NavGrid } from '../../nav/navgrid';
import { CollisionWorld } from '../../physics/collision';
import { createMatch } from '../../setup';
import { NEUTRAL } from '../../types';
import type { World } from '../../world';
import { spawnBoss } from '../boss';
import { damageEntity } from '../combat';
import { applyEffect } from '../effects';
import { updateEffigy } from '../effigy';
import { updateHippies } from '../hippies';
import { brainOf } from './brain';
import { EFFIGY_AUDIENCE_RADIUS, EFFIGY_GATHER_SECONDS, effigyAudienceActive, prepareEffigyAudience } from './effigySpectators';

function match(settings: Partial<MatchSettings> = {}, seed = 'effigy-audience'): World {
  const world = createMatch({ seed, difficulty: 'normal', humans: [0], mode: 'standard',
    match: normalizeMatch({ startingSignifiers: 0, maxSignifiers: 16, ...settings }) });
  // Isolate audience navigation: active empty GCCs now intentionally call real recovery recruits.
  for (const b of world.buildings.values()) if (b.kind === 'gcc' || b.kind === 'drumcircle') b.disabled = true;
  return world;
}
function tick(world: World, seconds = SIM_DT): void {
  for (let i = 0; i < Math.ceil(seconds / SIM_DT); i++) {
    world.time += SIM_DT; world.tick++;
    updateHippies(world, SIM_DT);
  }
}
function gather(world: World): void {
  world.time = Math.max(0, burnTime(world.options) - EFFIGY_GATHER_SECONDS);
  updateHippies(world, SIM_DT);
}
function neutrals(world: World) { return [...world.hippies.values()].filter(h => h.faction === NEUTRAL); }
function poses(world: World) {
  return [...world.hippies.values()].map(h => ({ id: h.id, pos: { ...h.pos }, facing: h.facing, status: h.status, target: h.statusTarget && { ...h.statusTarget } }));
}
function expectWatching(world: World): void {
  for (const h of neutrals(world)) {
    expect(brainOf(h).task).toBe('watchBurn');
    expect(brainOf(h).moving, `hippie ${h.id} at ${JSON.stringify(h.pos)}`).toBe(false);
    expect(h.status).toBe('idle');
    expect(h.statusTarget).toEqual(world.map.effigy);
    const toward = Math.atan2(world.map.effigy.x - h.pos.x, world.map.effigy.z - h.pos.z);
    expect(Math.sin(h.facing)).toBeCloseTo(Math.sin(toward), 7);
    expect(Math.cos(h.facing)).toBeCloseTo(Math.cos(toward), 7);
    expect(Math.hypot(h.pos.x - world.map.effigy.x, h.pos.z - world.map.effigy.z)).toBeGreaterThan(EFFIGY_AUDIENCE_RADIUS - .6);
    expect(world.nav.isWalkable(h.pos.x, h.pos.z)).toBe(true);
  }
}

describe('neutral effigy audience', () => {
  it('starts only two minutes before the final ignition, without revealing anything or consuming RNG', () => {
    const w = match({ days: 3, dayLength: 300 });
    w.time = burnTime(w.options) - EFFIGY_GATHER_SECONDS - .01;
    expect(prepareEffigyAudience(w)).toBe(false);
    updateHippies(w, SIM_DT);
    expect(neutrals(w).every(h => brainOf(h).task === 'wander')).toBe(true);
    const rng = vi.spyOn(w.rng, 'next');
    w.time += .01;
    expect(prepareEffigyAudience(w)).toBe(true);
    expect(rng).not.toHaveBeenCalled();
    expect(w.boss).toBeNull(); expect(w.effigyRevealedAt).toBeNull();
    expect(w.drainEvents()).toEqual([]);
  });

  it('deterministically distributes the audience around all sides of the perimeter', () => {
    const a = match({ days: 0 }), b = match({ days: 0 });
    expect(poses(a)).toEqual(poses(b));
    expectWatching(a);
    const crowd = neutrals(a);
    const angles = crowd.map(h => (Math.atan2(h.pos.z, h.pos.x) + Math.PI * 2) % (Math.PI * 2)).sort((x, y) => x - y);
    for (let i = 0; i < angles.length; i++) {
      const gap = (i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2) - angles[i];
      expect(gap).toBeLessThan(Math.PI / 3);
    }
    for (const h of crowd) for (const other of crowd) {
      if (h.id !== other.id) expect(Math.hypot(h.pos.x - other.pos.x, h.pos.z - other.pos.z)).toBeGreaterThan(1.5);
    }
  });

  it.each(['effigy-audience', 'spectators-detours', 'spectators-third'])('walks the real map and reaches the ring before ignition: %s', seed => {
    const w = match({}, seed);
    gather(w);
    let routed = false;
    for (let i = 0; i < (EFFIGY_GATHER_SECONDS - 1) / SIM_DT; i++) {
      tick(w);
      for (const h of neutrals(w)) {
        routed ||= brainOf(h).route === 'path';
        expect(w.nav.isWalkable(h.pos.x, h.pos.z)).toBe(true);
      }
    }
    expect(routed).toBe(true);
    expect(w.time).toBeLessThan(burnTime(w.options));
    expectWatching(w);
  });

  it('walks around dynamic obstacles and reassigns a newly blocked ring slot', () => {
    const w = match({ maxSignifiers: 1 });
    const h = neutrals(w)[0]; h.pos = { x: 45, z: 0 };
    // A real colliding wall between the attendee and its ideal slot, with room around both ends.
    w.nav.blockSegment(30, -8, 30, 8, 1, 999999);
    w.collision.addBox(30, 0, .5, 8, 0, 0, 8, 999999);
    gather(w); tick(w, 45);
    expectWatching(w);
    const old = { ...h.pos };
    w.nav.blockCircle(old.x, old.z, 1, 999998);
    // Move the spectator away rather than materializing a wall through its body.
    h.pos = { x: 20, z: 12 }; h.vel = { x: 0, z: 0 };
    tick(w, 35);
    expectWatching(w);
    expect(Math.hypot(h.pos.x - old.x, h.pos.z - old.z)).toBeGreaterThan(1);
  });

  it('honors an enlarged actual effigy footprint instead of a hard-coded pedestal', () => {
    const w = match({ maxSignifiers: 8 });
    const effigy = w.map.obstacles.find(o => o.kind === 'effigy')!;
    effigy.radius = 22;
    w.collision = CollisionWorld.fromMap(w.map); w.nav = NavGrid.fromMap(w.map);
    gather(w); tick(w, 115);
    expectWatching(w);
    for (const h of neutrals(w)) expect(Math.hypot(h.pos.x, h.pos.z)).toBeGreaterThan(23);
  });

  it.each([0, 1, 2, 16, 200])('initializes %s zero-day spectators safely without moving starting recruits', count => {
    const w = match({ days: 0, maxSignifiers: count === 200 ? 200 : count + 8, startingSignifiers: count === 200 ? 0 : 2 });
    expect(neutrals(w)).toHaveLength(count);
    expect(w.time).toBe(0); expect(w.suddenDeath).toBe(true);
    expectWatching(w);
    for (const h of w.hippies.values()) if (h.faction !== NEUTRAL) {
      expect(Math.hypot(h.pos.x, h.pos.z)).toBeGreaterThan(60);
      expect(brainOf(h).task).toBe('none');
    }
    expect(w.boss).toBeNull(); expect(w.effigyRevealedAt).toBeNull();
  });

  it('brings a maximum 200-neutral crowd to reachable slots before the Burn', () => {
    const w = match({ maxSignifiers: 200 });
    const samples: number[] = [];
    const start = performance.now();
    gather(w);
    const planningMs = performance.now() - start;
    for (let i = 0; i < (EFFIGY_GATHER_SECONDS - 1) / SIM_DT; i++) {
      const before = performance.now(); tick(w); samples.push(performance.now() - before);
    }
    samples.sort((a, b) => a - b);
    if (process.env.EFFIGY_PERF) console.info('200-neutral audience', { planningMs, p50: samples[Math.floor(samples.length * .5)],
      p95: samples[Math.floor(samples.length * .95)], maxMs: samples.at(-1),
      arrived: neutrals(w).filter(h => !brainOf(h).moving).length });
    expectWatching(w);
  });

  it('leaves Unlimited, tutorial, earlier days and ended matches out of the audience', () => {
    const unlimited = match({ days: UNLIMITED_DAYS }); unlimited.time = 100000; unlimited.suddenDeath = true;
    const earlier = match({ days: 3, dayLength: 300 }); earlier.time = 300;
    const tutorial = createMatch({ seed: 'spectators-training', difficulty: 'normal', humans: [0], mode: 'tutorial',
      match: normalizeMatch({ days: 0 }) });
    const ended = match(); ended.phase = 'ended'; ended.time = burnTime(ended.options);
    for (const w of [unlimited, earlier, tutorial, ended]) expect(effigyAudienceActive(w)).toBe(false);
    updateHippies(unlimited, SIM_DT); updateHippies(earlier, SIM_DT);
    for (const w of [unlimited, earlier]) expect(neutrals(w).every(h => brainOf(h).task === 'wander')).toBe(true);
  });

  it('watches a non-boss burn, then returns to wandering when the mast has burned away', () => {
    const w = match({ days: 0, bossMode: false });
    tick(w, 100); expectWatching(w); expect(w.boss).toBeNull();
    w.time = EFFIGY_POLE_CONSUMED_AT; updateHippies(w, SIM_DT);
    expect(neutrals(w).every(h => brainOf(h).task === 'wander')).toBe(true);
  });

  it('preserves recruitment, KO/respawn, stun, and existing spectator slots', () => {
    const w = match({ days: 0 }), [recruit, knocked, stunned, observer] = neutrals(w);
    const fixed = { ...observer.pos };
    recruit.faction = 0;
    damageEntity(w, knocked.id, 1000, w.avatarOf(0).id);
    applyEffect(w, stunned, 'stun', 3, 1, w.avatarOf(0).id);
    const stunPos = { ...stunned.pos }, koPos = { ...knocked.pos };
    tick(w, .2);
    expect(brainOf(recruit).task).not.toBe('watchBurn');
    expect(knocked.status).toBe('ko'); expect(knocked.pos).toEqual(koPos);
    expect(stunned.pos).toEqual(stunPos);
    expect(observer.pos).toEqual(fixed);
    tick(w, HIPPIE.respawnTime + 60);
    expect(knocked.status).not.toBe('ko'); expect(knocked.faction).toBe(NEUTRAL);
    expect(brainOf(knocked).task).toBe('watchBurn'); expect(brainOf(knocked).moving).toBe(false);
    expect(observer.pos).toEqual(fixed);
  });

  it('hands control to the existing cooperative boss behavior at emergence', () => {
    const w = match({ days: 0 }), [h] = neutrals(w);
    h.faction = 1;
    w.time = bossRevealTime(w.options); updateEffigy(w);
    const boss = spawnBoss(w)!; boss.action = 'idle';
    updateHippies(w, SIM_DT);
    expect(effigyAudienceActive(w)).toBe(false);
    expect(brainOf(h).task).toBe('engage'); expect(brainOf(h).target).toBe(boss.id);
    expect(h.status).toBe('fighting');
    expect(neutrals(w).every(n => brainOf(n).task === 'wander')).toBe(true);
  });

  it('gives newly neutral attendees free slots without reshuffling the crowd', () => {
    const w = match({ days: 0 });
    const existing = poses(w);
    const newcomer = spawnHippie(w, NEUTRAL, { x: 40, z: 0 });
    tick(w, 25);
    expect(brainOf(newcomer).task).toBe('watchBurn'); expect(brainOf(newcomer).moving).toBe(false);
    // A passing newcomer may cause ordinary body separation, without moving the slot.
    for (const p of existing) {
      const h = w.hippies.get(p.id)!;
      expect(Math.hypot(h.pos.x - p.pos.x, h.pos.z - p.pos.z)).toBeLessThan(.36);
      expect(brainOf(h).px).toBe(p.pos.x); expect(brainOf(h).pz).toBe(p.pos.z);
    }
  });

  it('replicates poses to clients and late joins without client-side audience movement', () => {
    const host = match({ days: 0 });
    const encoder = new SnapshotEncoder(host);
    const mirror = NetMirror.create(host.options, JSON.parse(JSON.stringify(encoder.full())), () => 0);
    // Host authors a deliberately non-ring pose. Clients must never correct it to a ring.
    const h = neutrals(host)[0]; h.pos = { x: 55, z: 33 }; h.facing = .75;
    host.time = 10; host.tick = 200;
    const delta = encoder.delta([]);
    mirror.push(JSON.parse(JSON.stringify({ tick: host.tick, time: host.time, delta, acks: {}, events: [] })));
    mirror.catchUp();
    const late = NetMirror.create(host.options, JSON.parse(JSON.stringify(encoder.full())), () => 0);
    for (const peer of [mirror, late]) {
      expect(peer.world.hippies.get(h.id)!.pos).toEqual(h.pos);
      const before = poses(peer.world);
      peer.advance(20000); peer.advance(30000);
      expect(poses(peer.world)).toEqual(before);
      expect(peer.world.drainEvents()).toEqual([]);
    }
  });
});
