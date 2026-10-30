import { describe, expect, it } from 'vitest';
import { AVATAR, BUILDINGS, RECRUIT_INTERVAL, RECRUIT_RADIUS, SIM_DT, WORKSHOP_FLAG_COST, WORKSHOP_FLAG_INTERVAL } from '../../constants';
import { spawnBuilding, spawnHippie } from '../../factory';
import { normalizeMatch } from '../../matchSettings';
import { createMatch } from '../../setup';
import { Simulation } from '../../simulation';
import { takeFromStock, craftFlag, dropLoose } from '../flags';
import { hoardThreshold, isHoarding, stockAt, updateEconomy } from '../economy';
import { captureHearth } from '../capture';
import { captureStructure, newStructureCapture } from '../structureCapture';
import { isRecruiter } from '../recruitment';
import { consumeBuilding, spawnBoss } from '../boss';
import { blastBossEye } from '../boss/eye';
import { hearthWithStock } from '../units/targets';
import { unitsState } from '../units/state';
import { freeThickFacet } from './testkit';
import { SnapshotEncoder } from '../../../net/codec';
import { NetMirror } from '../../../net/mirror';

function setup(base = 24) {
  const world = createMatch({ seed: 'station-storage', difficulty: 'normal', humans: [0], mode: 'standard', match: normalizeMatch({ hoardThreshold: base, startingSignifiers: 0 }) });
  world.hippies.clear();
  const hearth = world.hearthOf(0)!;
  const workshop = spawnBuilding(world, 'workshop', 0, freeThickFacet(world, hearth.pos.x, hearth.pos.z, 12, 'workshop'), 1);
  for (const fac of world.factions) fac.lumber = 0;
  return { world, workshop };
}

describe('Workshop pickup stock and camp hoarding', () => {
  it('crafts 10 locally, stops spending while full, and resumes only into pickup space', () => {
    const { world, workshop } = setup();
    const fac = world.factions[0], initial = world.stockCount(0);
    fac.lumber = 1000;
    // Isolate Workshop production from passive Hearth crafting.
    for (let i = 0; i < 12; i++) {
      world.hearthOf(0)!.hearth!.craftProgress = -1000;
      updateEconomy(world, WORKSHOP_FLAG_INTERVAL);
    }
    expect(stockAt(world, workshop.id)).toBe(10);
    expect(world.stockCount(0)).toBe(initial + 10);
    expect(fac.lumber).toBe(1000 - 10 * WORKSHOP_FLAG_COST);
    const worker = spawnHippie(world, 0, workshop.pos);
    const flag = takeFromStock(world, workshop.id, worker.id)!;
    expect(flag).toMatchObject({ state: 'carried', holder: worker.id, owner: 0 });
    world.hearthOf(0)!.hearth!.craftProgress = -1000;
    updateEconomy(world, WORKSHOP_FLAG_INTERVAL);
    expect(fac.lumber).toBe(1000 - 11 * WORKSHOP_FLAG_COST);
    expect(world.stockOf(world.hearthOf(0)!.id)).toHaveLength(initial);
    expect(craftFlag(world, workshop.id)).toBeNull();
    expect(stockAt(world, workshop.id)).toBe(10);
  });


  it('full racks do not bank production or send Flags to an altar; base Hearth crafting remains independent', () => {
    const { world, workshop } = setup();
    for (let i = 0; i < 10; i++) craftFlag(world, workshop.id);
    const altar = world.hearthOf(0)!;
    world.factions[0].lumber = 100;
    altar.hearth!.craftProgress = -1000;
    updateEconomy(world, 100);
    expect(workshop.progress).toBe(0);
    expect(world.factions[0].lumber).toBe(100);
    takeFromStock(world, workshop.id, spawnHippie(world, 0, workshop.pos).id);
    updateEconomy(world, SIM_DT);
    expect(stockAt(world, workshop.id)).toBe(9);
    updateEconomy(world, WORKSHOP_FLAG_INTERVAL);
    expect(stockAt(world, workshop.id)).toBe(10);
    expect(world.factions[0].lumber).toBe(100 - WORKSHOP_FLAG_COST);
    const before = stockAt(world, altar.id);
    altar.hearth!.craftProgress = 100;
    updateEconomy(world, SIM_DT);
    expect(stockAt(world, altar.id)).toBe(before + 1);
    expect(stockAt(world, workshop.id)).toBe(10);
  });

  it('recruits existing nearby neutrals independently of a full rack without spending or spawning', () => {
    const { world, workshop } = setup();
    for (const b of world.buildings.values()) if (b.kind === 'gcc') b.disabled = true;
    for (let i = 0; i < 10; i++) craftFlag(world, workshop.id);
    const near = spawnHippie(world, -1, workshop.pos);
    const next = spawnHippie(world, -1, workshop.pos);
    const enemy = spawnHippie(world, 1, workshop.pos);
    const ko = spawnHippie(world, -1, workshop.pos); ko.status = 'ko'; ko.koUntil = 100;
    const wizard = spawnHippie(world, -1, workshop.pos); wizard.wizard = true;
    const far = spawnHippie(world, -1, { x: workshop.pos.x + RECRUIT_RADIUS + 1, z: workshop.pos.z });
    const flags = world.flags.size, units = world.hippies.size;
    updateEconomy(world, RECRUIT_INTERVAL - 1);
    expect(near.faction).toBe(-1);
    updateEconomy(world, 1);
    expect(near.faction).toBe(0);
    expect(next.faction).toBe(-1);
    updateEconomy(world, RECRUIT_INTERVAL);
    expect(next.faction).toBe(0);
    updateEconomy(world, RECRUIT_INTERVAL);
    expect(enemy.faction).toBe(1);
    for (const h of [ko, wizard, far]) expect(h.faction).toBe(-1);
    expect(world.hippies.size).toBe(units);
    expect(world.flags.size).toBe(flags);
    expect(world.factions[0].lumber).toBe(0);
    expect(workshop.progress).toBe(0);
    expect(world.drainEvents().filter(e => e.t === 'recruited').map(e => e.via)).toEqual(['workshop', 'workshop']);
  });

  it('keeps crafting and recruitment clocks separate and never crafts without the lumber cost', () => {
    const { world, workshop } = setup();
    for (const b of world.buildings.values()) if (b.kind === 'gcc') b.disabled = true;
    world.hearthOf(0)!.hearth!.craftProgress = -1000;
    const h = spawnHippie(world, -1, workshop.pos);
    world.factions[0].lumber = WORKSHOP_FLAG_COST * 2;
    for (let i = 0; i < RECRUIT_INTERVAL - 1; i++) updateEconomy(world, 1);
    expect(stockAt(world, workshop.id)).toBe(2);
    expect(h.faction).toBe(-1);
    updateEconomy(world, 1);
    expect(h.faction).toBe(0);
    updateEconomy(world, WORKSHOP_FLAG_INTERVAL * 4);
    expect(stockAt(world, workshop.id)).toBe(2);
    expect(world.factions[0].lumber).toBe(0);
  });

  it('pauses recruitment while contested, incomplete, disabled or defeated and uses the current owner after recapture', () => {
    const { world, workshop } = setup();
    for (const b of world.buildings.values()) if (b.kind === 'gcc') b.disabled = true;
    const h = spawnHippie(world, -1, workshop.pos);
    workshop.capture = { ...newStructureCapture(), stage: 'contested', attacker: 1 };
    updateEconomy(world, RECRUIT_INTERVAL);
    expect(h.faction).toBe(-1);
    for (const stage of ['contained', 'overwritten'] as const) {
      workshop.capture.stage = stage;
      expect(isRecruiter(world, workshop)).toBe(false);
    }
    workshop.capture = newStructureCapture();
    workshop.built = .5; updateEconomy(world, RECRUIT_INTERVAL);
    workshop.built = 1; workshop.disabled = true; updateEconomy(world, RECRUIT_INTERVAL);
    workshop.disabled = false; world.factions[0].alive = false; updateEconomy(world, RECRUIT_INTERVAL);
    expect(h.faction).toBe(-1);
    world.factions[0].alive = true;
    updateEconomy(world, RECRUIT_INTERVAL / 2);
    expect(captureStructure(world, workshop, 1)).toBe(true);
    updateEconomy(world, RECRUIT_INTERVAL / 2);
    expect(h.faction).toBe(1);
    const second = spawnHippie(world, -1, workshop.pos);
    expect(captureStructure(world, workshop, 0)).toBe(true);
    updateEconomy(world, RECRUIT_INTERVAL);
    expect(second.faction).toBe(0);
    const third = spawnHippie(world, -1, workshop.pos);
    world.buildings.delete(workshop.id);
    expect(isRecruiter(world, workshop)).toBe(false);
    updateEconomy(world, RECRUIT_INTERVAL);
    expect(third.faction).toBe(-1);
  });

  it('counts all camp stocks once and adds capacity only for completed working own stations', () => {
    const { world, workshop } = setup(14);
    expect(hoardThreshold(world, 0)).toBe(24);
    for (let i = 0; i < 10; i++) craftFlag(world, workshop.id);
    expect(world.stockCount(0)).toBe(24);
    expect(isHoarding(world, 0)).toBe(false);
    craftFlag(world, world.hearthOf(0)!.id);
    world.tick += 2;
    expect(isHoarding(world, 0)).toBe(true);
    workshop.disabled = true;
    expect(hoardThreshold(world, 0)).toBe(14);
    expect(takeFromStock(world, workshop.id, spawnHippie(world, 0, workshop.pos).id)).not.toBeNull();
    workshop.disabled = false; workshop.built = .5;
    expect(hoardThreshold(world, 0)).toBe(14);
    expect(craftFlag(world, workshop.id)).toBeNull();
    workshop.built = 1; workshop.faction = 1;
    expect(hoardThreshold(world, 0)).toBe(14);
    expect(hoardThreshold(world, 1)).toBe(24);
  });

  it('restocks the player through the normal simulation and offers stock to Signifiers', () => {
    const { world, workshop } = setup();
    const av = world.avatarOf(0);
    for (const id of [...av.carried]) dropLoose(world, id, { x: 0, y: 0, z: 0 });
    const flag = craftFlag(world, workshop.id)!;
    av.pos = { x: workshop.pos.x + BUILDINGS.workshop.radius + .1, y: 0, z: workshop.pos.z };
    const sys = unitsState(world);
    sys.stockByHearth.set(workshop.id, 1);
    expect(hearthWithStock(world, sys, 0, av.pos.x, av.pos.z)?.id).toBe(workshop.id);
    const sim = new Simulation(world);
    for (let i = 0; i < Math.ceil((AVATAR.restockInterval + 1) / SIM_DT); i++) sim.step();
    expect(av.carried).toContain(flag.id);
    expect(stockAt(world, workshop.id)).toBe(0);
  });

  it('transfers stock ownership on capture without loss, and eating removes contents once', () => {
    const { world, workshop } = setup();
    const flag = craftFlag(world, workshop.id)!;
    const count = world.flags.size;
    captureHearth(world, world.hearthOf(0)!, 1);
    expect(workshop.faction).toBe(1);
    expect(flag.owner).toBe(1);
    expect(world.flags.size).toBe(count);
    expect(takeFromStock(world, workshop.id, spawnHippie(world, 0, workshop.pos).id)).toBeNull();
    consumeBuilding(world, workshop);
    expect(world.flags.has(flag.id)).toBe(false);
    expect(world.flags.size).toBe(count - 1);
    consumeBuilding(world, workshop);
    expect(world.flags.size).toBe(count - 1);
  });

  it('spills Workshop contents as recoverable Flags when a beam destroys it', () => {
    const { world, workshop } = setup();
    world.effigyRevealedAt = world.time;
    const boss = spawnBoss(world)!;
    const flags = Array.from({ length: 10 }, () => craftFlag(world, workshop.id)!);
    workshop.hp = 1;
    blastBossEye(world, boss, { ...workshop.pos, y: 1 });
    expect(world.buildings.has(workshop.id)).toBe(false);
    for (const flag of flags) expect(world.flags.get(flag.id)).toMatchObject({ state: 'loose', holder: -1 });
  });

  it('replicates local stock and threshold to a late join without special wire fields', () => {
    const { world, workshop } = setup(40);
    for (let i = 0; i < 10; i++) craftFlag(world, workshop.id);
    const encoder = new SnapshotEncoder(world);
    const mirror = NetMirror.create(world.options, JSON.parse(JSON.stringify(encoder.full())));
    expect(stockAt(mirror.world, workshop.id)).toBe(10);
    expect(mirror.world.stockCount(0)).toBe(world.stockCount(0));
    expect(hoardThreshold(mirror.world, 0)).toBe(50);
    expect(isHoarding(mirror.world, 0)).toBe(false);
    const next = createMatch(world.options);
    expect(next.buildings.has(workshop.id)).toBe(false);
    expect(hoardThreshold(next, 0)).toBe(40);
  });
});
