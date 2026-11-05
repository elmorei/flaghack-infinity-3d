import { describe, expect, it } from 'vitest';
import { BUILD_TIME, BUILDINGS, GCC, WARD_PULSE_INTERVAL } from '../../constants';
import { spawnBuilding } from '../../factory';
import { canPlaceBuilding, damageBuilding, isCollapsed, registerBuildingShape } from '../buildings';
import { gccActive } from '../gcc';
import { dismissHippies, eventsOf, freeThickFacet, newMatch, parkAvatarAway, placeAvatar, run } from './testkit';

describe('buildings', () => {
  it('placement is refused outside the own Survey, accepted inside, and completes after BUILD_TIME', () => {
    const h = newMatch();
    const { world } = h;
    const lat = world.lattice;
    const hearth = world.hearthOf(0)!;
    world.factions[0].lumber = 500;

    const outside = lat.facets.find(
      (fc) => fc.thick && !fc.boundary && !world.inSurvey(fc.id, 0) && Math.hypot(fc.cx - hearth.pos.x, fc.cz - hearth.pos.z) > 60,
    )!;
    expect(canPlaceBuilding(world, 0, 'workshop', outside.id)).toEqual({ ok: false, reason: 'Build inside your own Survey.' });

    const inside = [...lat.facets]
      .sort((a, b) => Math.hypot(a.cx - hearth.pos.x, a.cz - hearth.pos.z) - Math.hypot(b.cx - hearth.pos.x, b.cz - hearth.pos.z))
      .find((fc) => world.inSurvey(fc.id, 0) && canPlaceBuilding(world, 0, 'workshop', fc.id).ok)!;
    expect(inside).toBeDefined();

    dismissHippies(world, 0);
    parkAvatarAway(world, 0, 60);
    world.submit({ t: 'placeBuilding', faction: 0, kind: 'workshop', facet: inside.id });
    run(h, 1 / 60);
    const placed = eventsOf(h, 'buildingPlaced');
    expect(placed).toHaveLength(1);
    const ws = world.buildings.get(placed[0].buildingId)!;
    expect(ws.kind).toBe('workshop');
    expect(ws.built).toBeLessThan(1);
    expect(world.factions[0].lumber).toBeLessThanOrEqual(500 - BUILDINGS.workshop.cost);
    expect(world.collision.blockedCircle(ws.pos.x, ws.pos.z, 0.5, 0.5, 1)).toBe(true);
    // The same facet is now taken.
    expect(canPlaceBuilding(world, 0, 'workshop', inside.id).ok).toBe(false);

    run(h, BUILD_TIME - 0.3);
    expect(ws.built).toBeLessThan(1);
    expect(eventsOf(h, 'buildingDone')).toHaveLength(0);
    run(h, 0.4);
    expect(ws.built).toBe(1);
    expect(eventsOf(h, 'buildingDone').map((e) => e.buildingId)).toEqual([ws.id]);
  });

  it('a building at 0 HP is disabled until repaired to full; the Hearth never drops below 1 HP', () => {
    const h = newMatch();
    const { world } = h;
    const hearth = world.hearthOf(0)!;
    dismissHippies(world, 0);
    parkAvatarAway(world, 0, 60);
    // Out of the GCC's Flag Repair range, so only the vexillomancer can mend it.
    const gcc = world.gccOf(0)!;
    const ward = spawnBuilding(world, 'ward', 0, freeThickFacet(world, gcc.pos.x, gcc.pos.z, GCC.repairRadius + 8, 'ward'), 1);
    registerBuildingShape(world, ward);

    expect(damageBuilding(world, ward, ward.maxHp + 50, -1)).toBe(true);
    expect(ward.disabled).toBe(true);
    expect(ward.hp).toBe(0);
    expect(damageBuilding(world, ward, 10, -1)).toBe(false);
    run(h, 1 / 60);
    expect(eventsOf(h, 'buildingDisabled').map((e) => e.buildingId)).toEqual([ward.id]);

    // Nobody near: it stays down. The vexillomancer standing by repairs it.
    run(h, 2);
    expect(ward.hp).toBe(0);
    ward.hp = ward.maxHp - 5;
    placeAvatar(world, 0, ward.pos.x + BUILDINGS.ward.radius + 2, ward.pos.z);
    run(h, 1);
    expect(ward.disabled).toBe(false);
    expect(ward.hp).toBe(ward.maxHp);
    expect(eventsOf(h, 'buildingRepaired').map((e) => e.buildingId)).toEqual([ward.id]);

    expect(damageBuilding(world, hearth, 1e6, -1)).toBe(true);
    expect(hearth.hp).toBe(1);
    expect(hearth.disabled).toBe(false);
    expect(damageBuilding(world, hearth, 10, -1)).toBe(false);
  });

  it('a GCC ignores lethal damage and keeps its body without a rebuild countdown', () => {
    const h = newMatch();
    const { world } = h;
    const gcc = world.gccOf(0)!;
    const { x, z } = gcc.pos;
    expect(damageBuilding(world, gcc, gcc.maxHp * 10, -1)).toBe(false);
    expect(isCollapsed(gcc)).toBe(false);
    expect(gccActive(world, 0)).toBe(true);
    expect(gcc.hp).toBe(gcc.maxHp);
    expect(world.collision.blockedCircle(x, z, 0.3, 0.3, 0.9)).toBe(true);
    run(h, 1 / 60);
    expect(eventsOf(h, 'gccDestroyed')).toEqual([]);
    expect(eventsOf(h, 'gccRebuilt')).toEqual([]);
    expect(gcc.pos).toEqual({ x, z });
  });

  it('a Hearth Ward vibe-checks enemy hippies that come close', () => {
    const h = newMatch();
    const { world } = h;
    const hearth = world.hearthOf(0)!;
    const ward = spawnBuilding(world, 'ward', 0, freeThickFacet(world, hearth.pos.x, hearth.pos.z, 12, 'ward'), 1);
    registerBuildingShape(world, ward);
    ward.progress = WARD_PULSE_INTERVAL;
    const enemy = [...world.hippies.values()].find((hp) => hp.faction === 1)!;
    enemy.pos.x = ward.pos.x + BUILDINGS.ward.radius + 3;
    enemy.pos.z = ward.pos.z;
    run(h, 1 / 60);
    const pulses = eventsOf(h, 'wardPulse');
    expect(pulses.map((e) => e.buildingId)).toEqual([ward.id]);
    expect(enemy.effects.some((e) => e.kind === 'stun')).toBe(true);
  });
});
