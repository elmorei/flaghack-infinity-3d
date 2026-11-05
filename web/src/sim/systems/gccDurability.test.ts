import { describe, expect, it } from 'vitest';
import { buildingBaseHeight } from '../buildingGeometry';
import { BOSS_TIMING } from '../boss';
import { BOSS_GAIT } from '../bossGait';
import { BUILDING_HEIGHT, SIM_DT } from '../constants';
import { spawnBuilding, spawnFlag, spawnPiece } from '../factory';
import { normalizeMatch } from '../matchSettings';
import { createMatch } from '../setup';
import { leaveBuildingWreckage } from '../wreckage';
import { consumeBuilding, spawnBoss, updateBoss } from './boss';
import { blastBossEye } from './boss/eye';
import { chooseBossEyeTarget } from './boss/eyeTargeting';
import { collapseGcc, damageBuilding, disableBuilding, moveBuilding, registerBuildingShape, updateBuildings } from './buildings';
import { captureHearth } from './capture';
import { damageEntity } from './combat';
import { gccActive, updateGcc } from './gcc';
import { attachPiece, destroyPiece } from './pieces';
import { isRecruiter } from './recruitment';
import { eliminate } from './victory';

function fixture() {
  const world = createMatch({ seed: 'gcc-durability', difficulty: 'normal', humans: [0, 1], mode: 'standard',
    match: normalizeMatch({ maxSignifiers: 0 }) });
  const gcc = world.gccOf(0)!;
  const facet = world.lattice.facets.find(f => !f.boundary && Math.hypot(f.cx, f.cz) > 25 &&
    !world.collision.blockedCircle(f.cx, f.cz, 9, -20, 50) && world.nav.blockerOnSegment(f.cx, f.cz, f.cx, f.cz) === -1)!;
  expect(facet).toBeDefined();
  moveBuilding(world, gcc, facet.cx, facet.cz);
  world.survey.edgeLey.fill(-1); world.survey.version++;
  for (const av of world.avatars.values()) av.pos = { x: -100, y: 0, z: -100 };
  for (const h of world.hippies.values()) h.pos = { x: -100, z: -100 };
  world.drainEvents();
  const intact = () => {
    expect(world.buildings.get(gcc.id)).toBe(gcc);
    expect(gcc.hp).toBe(gcc.maxHp); expect(gcc.disabled).toBe(false);
    expect(gcc.gcc!.destroyedUntil).toBe(0);
    expect(world.collision.raycast(gcc.pos.x, 40, gcc.pos.z, 0, -1, 0, 60)?.tag).toBe(gcc.id);
    expect(world.nav.blockerOnSegment(gcc.pos.x, gcc.pos.z, gcc.pos.x, gcc.pos.z)).toBe(gcc.id);
    expect(world.wreckage.some(r => r.id === `building:${gcc.id}`)).toBe(false);
    expect(world.drainEvents().some(e => e.t === 'hit' && e.target === gcc.id ||
      e.t === 'buildingDisabled' && e.buildingId === gcc.id || e.t === 'gccDestroyed' || e.t === 'gccRebuilt')).toBe(false);
  };
  const boss = () => {
    world.time = 1000; world.effigyRevealedAt = 990;
    const b = spawnBoss(world)!; b.eye.nextFireAt = Infinity;
    return b;
  };
  return { world, gcc, facet, intact, boss };
}

describe('indestructible Command Centers', () => {
  it('rejects ordinary damage and disable/collapse/consume/salvage entry points without affecting motion or stock', () => {
    const { world, gcc, intact } = fixture();
    const flag = spawnFlag(world, { state: 'stock', owner: 0, holder: gcc.id, pos: { ...gcc.pos, y: 0 } });
    const av = world.avatarOf(0); av.pushing = gcc.id; gcc.gcc!.pushedBy = av.id;
    for (const amount of [.1, 110, gcc.maxHp, 1e9, Infinity]) {
      expect(damageBuilding(world, gcc, amount, -1)).toBe(false);
      expect(damageEntity(world, gcc.id, amount, world.avatarOf(1).id)).toBe(false);
    }
    disableBuilding(world, gcc); collapseGcc(world, gcc, world.time + 40); collapseGcc(world, gcc, Infinity);
    consumeBuilding(world, gcc); consumeBuilding(world, gcc, true); leaveBuildingWreckage(world, gcc);
    intact();
    expect(gcc.gcc!.pushedBy).toBe(av.id); expect(av.pushing).toBe(gcc.id);
    expect(flag.holder).toBe(gcc.id); expect(flag.state).toBe('stock');
    expect(gccActive(world, 0)).toBe(true); expect(isRecruiter(world, gcc)).toBe(true);
  });

  it.each(['grab', 'swipe', 'stomp', 'eye'] as const)('survives real boss %s attacks and repeated impact frames', attack => {
    const { world, gcc, intact, boss } = fixture(); const b = boss();
    Object.assign(b, { pos: { x: gcc.pos.x, z: gcc.pos.z - 2 }, yaw: 0,
      action: attack === 'eye' ? 'idle' : attack, actionAt: world.time,
      actionSeq: 20, hitSeq: -1, crouched: attack !== 'stomp', target: { kind: 'building', id: gcc.id } });
    if (attack === 'eye') {
      blastBossEye(world, b, { ...gcc.pos, y: buildingBaseHeight(world, gcc) });
      blastBossEye(world, b, { x: gcc.pos.x + 10, z: gcc.pos.z, y: buildingBaseHeight(world, gcc) },
        { x: gcc.pos.x - 10, z: gcc.pos.z, y: buildingBaseHeight(world, gcc) });
    } else {
      world.time += attack === 'grab' ? BOSS_TIMING.consume : attack === 'stomp' ? BOSS_TIMING.stompHit : BOSS_TIMING.swipeHit;
      updateBoss(world, SIM_DT); updateBoss(world, SIM_DT);
    }
    intact(); expect(b.held).toBeNull();
  });

  it('cannot be swallowed by a restored in-flight grasp', () => {
    const { world, gcc, intact, boss } = fixture(); const b = boss();
    Object.assign(b, { action: 'grab', actionAt: world.time, actionSeq: 4, hitSeq: -1,
      held: { kind: 'building', id: gcc.id, faction: 0, ...gcc.pos }, target: { kind: 'building', id: gcc.id } });
    world.time += BOSS_TIMING.consume; updateBoss(world, SIM_DT);
    intact(); expect(b.held).toBeNull();
  });

  it('keeps eye targeting but skips edible-cart targets so the boss can reach an altar', () => {
    const { world, gcc, boss } = fixture(); const b = boss();
    for (const other of world.buildings.values()) if (other !== gcc) moveBuilding(world, other, 300, 300);
    world.map.obstacles = []; world.flags.clear(); world.crystals.clear(); world.hippies.clear();
    for (const avatar of world.avatars.values()) avatar.pos = { x: 300, y: 0, z: 300 };
    Object.assign(b, { pos: { x: gcc.pos.x, z: gcc.pos.z - 20 }, yaw: 0, action: 'idle', actionAt: world.time });
    expect(chooseBossEyeTarget(world, b)).toEqual({ ...gcc.pos, y: buildingBaseHeight(world, gcc) + BUILDING_HEIGHT.gcc / 2 });
    const altar = world.hearthOf(3)!; moveBuilding(world, altar, gcc.pos.x, gcc.pos.z + 30);
    world.factions[3].stats.cmi = 1e6;
    Object.assign(b, { pos: { x: gcc.pos.x, z: gcc.pos.z - 6 }, nextAttackAt: 0, crouched: true, objectiveAltarId: altar.id });
    updateBoss(world, SIM_DT);
    expect(b.target).toEqual({ kind: 'building', id: altar.id });
    expect(['grab', 'stomp', 'swipe']).not.toContain(b.action);
  });

  it.each([false, true])('survives actual walking footfall (crouched=%s)', crouched => {
    const { world, gcc, intact, boss } = fixture(); const b = boss();
    for (const other of world.buildings.values()) if (other !== gcc) moveBuilding(world, other, -100, -100);
    const gait = crouched ? 'crouchWalk' : 'walk', foot = BOSS_GAIT[gait].feet[1];
    const at = { x: gcc.pos.x - foot.x, z: gcc.pos.z - foot.z };
    const altar = world.hearthOf(3)!; moveBuilding(world, altar, at.x, at.z + (crouched ? 20 : 35));
    world.factions[3].stats.cmi = 1e6;
    Object.assign(b, { pos: at, yaw: 0, action: 'idle', actionAt: world.time, crouched,
      objectiveAltarId: altar.id, nextAttackAt: 0, opportunisticAfter: 10000,
      nextSceneryStompStride: 10000, stride: BOSS_GAIT[gait].stride * BOSS_GAIT[gait].phases[1] - .01 });
    world.time += SIM_DT; updateBoss(world, SIM_DT);
    expect(world.drainEvents().some(e => e.t === 'bossFootfall' && !e.heavy)).toBe(true); intact();
  });

  it.each([false, true])('settles an elevated legacy cart after support destruction without salvage (boss=%s)', bossDestroyed => {
    const { world, gcc, facet, intact } = fixture();
    const deck = spawnPiece(world, 'floor', 0, -1, facet.id, 0, -1); attachPiece(world, deck);
    gcc.level = 1; registerBuildingShape(world, gcc);
    const stock = spawnFlag(world, { state: 'stock', owner: 0, holder: gcc.id, pos: { ...gcc.pos, y: 0 } });
    destroyPiece(world, deck, bossDestroyed);
    expect(world.pieces.has(deck.id)).toBe(false); expect(gcc.level).toBe(0);
    expect(stock.holder).toBe(gcc.id); expect(stock.state).toBe('stock'); intact();
  });

  it.each([1, 1010, Infinity])('recovers legacy collapsed/disabled HP in place immediately (old deadline=%s)', deadline => {
    const { world, gcc, intact } = fixture(); const at = { ...gcc.pos };
    gcc.hp = 0; gcc.disabled = true; gcc.gcc!.destroyedUntil = deadline;
    gcc.gcc!.moveTarget = { x: gcc.pos.x + 10, z: gcc.pos.z };
    registerBuildingShape(world, gcc); updateBuildings(world, SIM_DT); updateGcc(world, SIM_DT);
    intact(); expect(gcc.pos).toEqual(at); expect(isRecruiter(world, gcc)).toBe(true);
    expect(gcc.gcc!.moveTarget).toBeNull();
  });

  it('survives partial capture without relocating, and final elimination stops services without destroying the cart', () => {
    const { world, gcc, facet, intact } = fixture(); const home = world.hearthOf(0)!;
    spawnBuilding(world, 'hearth', 0, facet.id, 1); moveBuilding(world, gcc, home.pos.x + 6, home.pos.z);
    const at = { ...gcc.pos }; captureHearth(world, home, 1);
    expect(world.factions[0].alive).toBe(true); expect(gcc.pos).toEqual(at); expect(gccActive(world, 0)).toBe(true);
    eliminate(world, 0, 1); updateBuildings(world, SIM_DT); updateGcc(world, SIM_DT);
    expect(world.factions[0].alive).toBe(false); expect(world.factions[0].gccId).toBeNull();
    expect(isRecruiter(world, gcc)).toBe(false); expect(gccActive(world, 0)).toBe(false);
    expect(gcc.gcc!.pushedBy).toBe(-1); expect(gcc.gcc!.moveTarget).toBeNull(); intact();
  });
});
