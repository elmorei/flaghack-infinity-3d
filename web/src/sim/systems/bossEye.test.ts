import { groundHeight } from '../terrain';
import { describe, expect, it, vi } from 'vitest';
import { BOSS_EYE_MAX_RANGE, BOSS_MAX_HP } from '../boss';
import { AVATAR, BUILDINGS, BUILDING_HEIGHT, HIPPIE, LEVEL_HEIGHT, SIM_DT } from '../constants';
import { spawnBuilding, spawnFlag, spawnHippie, spawnPiece, spawnPile, spawnProjectile } from '../factory';
import type { V3 } from '../math';
import { CollisionWorld } from '../physics/collision';
import { createMatch } from '../setup';
import type { BuildingKind, PieceKind } from '../types';
import { consumeBuilding, spawnBoss, updateBoss } from './boss';
import { blastBossEye, bossEyeRay, updateBossEye } from './boss/eye';
import { recordBossFlagThreat } from './boss/eyeThreats';
import { damageEntity } from './combat';
import { pieceBottom } from './econ/pieceGeometry';
import { giveFlag, plantFlag } from './flags';
import { attachPiece, piecePosition } from './pieces';
import { barrierFlags, bossLoopEdges } from './boss/barriers';
import { freeFocus, newMatch, plantFresh, runRules } from './rules/testWorld';
import { updateSurvey } from './survey';
import { brainOf } from './units/brain';
import { unitsState } from './units/state';

function encounter() {
  const world = createMatch({ seed: 'boss-eye', difficulty: 'normal', humans: [0, 1], mode: 'standard' });
  world.time = 100; world.effigyRevealedAt = 100; world.suddenDeath = true;
  const boss = spawnBoss(world)!;
  boss.action = 'idle'; boss.pos = { x: 0, z: 0 }; boss.yaw = 0;
  world.collision = new CollisionWorld(); world.map.obstacles = [];
  world.buildings.clear(); world.pieces.clear(); world.flags.clear(); world.hippies.clear(); world.crystals.clear(); world.piles.clear();
  for (const f of world.factions) { f.hearthIds = []; f.gccId = null; }
  for (const a of world.avatars.values()) { a.pos = { x: 100, y: 0, z: 50 + a.faction * 20 }; a.carried = []; }
  world.survey.edgeLey.fill(-1); world.survey.version++;
  const target = world.avatarOf(0); target.pos = { x: 0, y: 0, z: 40 };
  boss.target = { kind: 'avatar', id: target.id };
  world.drainEvents();
  return { world, boss, target, flagThreat: true };
}
function setTime(e: ReturnType<typeof encounter>, now: number) {
  e.world.time = now; e.world.tick++;
  // Clock/ray fixtures represent an actively attacking Flag thrower.
  if (e.flagThreat && e.boss.eye.chargeAt === null) recordBossFlagThreat(e.world, e.target.id);
  return updateBossEye(e.world, e.boss, SIM_DT);
}
function atDistance(origin: V3, direction: V3, distance: number): V3 {
  return { x: origin.x + direction.x * distance, y: origin.y + direction.y * distance, z: origin.z + direction.z * distance };
}

describe('authoritative boss eye clock', () => {
  it('waits 27 seconds, charges for three, fires at 30, sweeps for five seconds and repeats 30 seconds after firing', () => {
    const e = encounter(), { boss, world } = e;
    const raycast = vi.spyOn(world.collision, 'raycast');
    expect(boss.eye.nextFireAt).toBe(130);
    expect(setTime(e, 126.999)).toBe(false); expect(boss.eye.chargeAt).toBeNull();
    expect(setTime(e, 127)).toBe(true); expect(boss.eye.chargeAt).toBe(127);
    expect(setTime(e, 129.999)).toBe(true); expect(boss.eye.firedAt).toBeNull(); expect(raycast).not.toHaveBeenCalled();
    expect(setTime(e, 130)).toBe(true); expect(boss.eye.firedAt).toBe(130); expect(boss.eye.nextFireAt).toBe(160);
    e.target.pos.x = 70;
    for (const time of [130, 130.01, 130.25, 130.499, 134.999]) {
      expect(setTime(e, time)).toBe(true); expect(boss.eye.firedAt).toBe(130);
    }
    expect(raycast).toHaveBeenCalledTimes(300);
    expect(setTime(e, 135)).toBe(false); expect(boss.eye.chargeAt).toBeNull(); expect(boss.eye.origin).toBeNull();
    e.target.hp = AVATAR.maxHp; e.target.koUntil = 0;
    expect(setTime(e, 156.999)).toBe(false); expect(setTime(e, 157)).toBe(true);
    expect(boss.eye.chargeAt).toBe(157); expect(setTime(e, 160)).toBe(true);
    expect(boss.eye.firedAt).toBe(160); expect(raycast).toHaveBeenCalledTimes(302);
  });
  it('never skips the charge or replays missed attacks after a large clock jump', () => {
    const e = encounter(), raycast = vi.spyOn(e.world.collision, 'raycast');
    expect(setTime(e, 180)).toBe(true); expect(e.boss.eye.chargeAt).toBe(180);
    expect(e.boss.eye.nextFireAt).toBe(183); expect(e.boss.eye.firedAt).toBeNull();
    setTime(e, 182.999); expect(raycast).not.toHaveBeenCalled();
    setTime(e, 200); expect(e.boss.eye.firedAt).toBe(200); expect(e.boss.eye.nextFireAt).toBe(230);
    setTime(e, 200.2); expect(raycast).toHaveBeenCalledTimes(13);
    e.target.hp = AVATAR.maxHp; e.target.koUntil = 0;
    setTime(e, 400); expect(raycast).toHaveBeenCalledTimes(13);
    setTime(e, 400.05); expect(e.boss.eye.chargeAt).toBe(400.05); expect(e.boss.eye.firedAt).toBeNull();
    setTime(e, 403.05); expect(raycast).toHaveBeenCalledTimes(14); expect(e.boss.eye.nextFireAt).toBe(433.05);
  });
  it('waits for a valid target, then locks its point throughout the complete charge', () => {
    const e = encounter(); e.boss.target = null; e.flagThreat = false;
    expect(setTime(e, 127)).toBe(false); expect(e.boss.eye.chargeAt).toBeNull();
    e.boss.target = { kind: 'avatar', id: e.target.id }; e.flagThreat = true; setTime(e, 140);
    const target = { ...e.boss.eye.target! }; e.target.pos = { x: -70, y: 30, z: -70 };
    setTime(e, 142.999); expect(e.boss.eye.target).toEqual(target); expect(e.boss.eye.firedAt).toBeNull();
    setTime(e, 143); expect(e.boss.eye.target).toEqual(target); expect(e.boss.eye.firedAt).toBe(143);
  });
  it.each(['crouch', 'rise', 'emerge'] as const)('waits for %s and gives a full charge afterward', action => {
    const e = encounter(); e.boss.action = action;
    expect(setTime(e, 127)).toBe(false); expect(e.boss.eye.chargeAt).toBeNull();
    e.boss.action = 'idle'; setTime(e, 131);
    expect(e.boss.eye.chargeAt).toBe(131); expect(e.boss.eye.nextFireAt).toBe(134); expect(e.boss.eye.firedAt).toBeNull();
  });
  it('interrupts a pending melee hit and halts movement while charging and firing', () => {
    const e = encounter(); e.target.pos = { x: 0, y: 0, z: 2 };
    for (const x of [-1, 0, 1]) spawnHippie(e.world, -1, { x, z: 40 });
    e.boss.action = 'stomp'; e.boss.actionAt = 126; e.boss.actionSeq = 12; e.boss.hitSeq = 11;
    const start = { ...e.boss.pos };
    e.world.time = 127; updateBoss(e.world, SIM_DT);
    expect(e.boss.action).toBe('idle'); expect(e.boss.eye.chargeAt).toBe(127); expect(e.target.hp).toBe(AVATAR.maxHp);
    e.world.time = 129.9; updateBoss(e.world, SIM_DT); expect(e.boss.pos).toEqual(start); expect(e.target.hp).toBe(AVATAR.maxHp);
    e.world.time = 130; updateBoss(e.world, SIM_DT);
    e.world.time = 130.49; updateBoss(e.world, SIM_DT); expect(e.boss.pos).toEqual(start);
  });
  it.each([128, 130.2])('death at %s immediately cancels charge or beam and never fires afterward', time => {
    const e = encounter(), raycast = vi.spyOn(e.world.collision, 'raycast');
    setTime(e, 127); if (time > 130) setTime(e, 130);
    const fired = raycast.mock.calls.length;
    e.world.time = time; damageEntity(e.world, e.boss.id, BOSS_MAX_HP, -1);
    expect(e.boss.action).toBe('death'); expect(e.boss.eye.chargeAt).toBeNull(); expect(e.boss.eye.firedAt).toBeNull();
    e.world.time = 160; updateBoss(e.world, SIM_DT);
    expect(e.boss.eye.origin).toBeNull(); expect(raycast).toHaveBeenCalledTimes(fired);
  });
});

describe('boss eye ray and first impact', () => {
  it('starts at the real pupil, aims at the locked point, and stops on the first structure', () => {
    const e = encounter(); setTime(e, 127);
    const ray = bossEyeRay(e.world, e.boss), target = e.boss.eye.target!;
    expect(ray.origin.y).toBeGreaterThan(20); expect(ray.origin.y).toBeLessThan(32);
    expect(Math.hypot(ray.direction.x, ray.direction.y, ray.direction.z)).toBeCloseTo(1, 12);
    const range = Math.hypot(target.x - ray.origin.x, target.y - ray.origin.y, target.z - ray.origin.z);
    const endpoint = atDistance(ray.origin, ray.direction, range);
    expect(endpoint.x).toBeCloseTo(target.x, 5); expect(endpoint.y).toBeCloseTo(target.y, 5); expect(endpoint.z).toBeCloseTo(target.z, 5);
    const first = atDistance(ray.origin, ray.direction, 12), second = atDistance(ray.origin, ray.direction, 24);
    e.world.collision.addBox(first.x, first.z, 2, .4, 0, 0, 30, -30);
    e.world.collision.addBox(second.x, second.z, 2, .4, 0, 0, 30, -31);
    const expected = e.world.collision.raycast(ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z, BOSS_EYE_MAX_RANGE, e.boss.id)!;
    expect(expected.tag).toBe(-30); setTime(e, 130);
    expect(e.boss.eye.impact).toEqual({ x: expected.x, y: expected.y, z: expected.z }); expect(e.target.hp).toBe(AVATAR.maxHp);
  });
  it('damages new arrivals in the live impact but never bodies along the beam corridor', () => {
    const e = encounter(); setTime(e, 127);
    const ray = bossEyeRay(e.world, e.boss), crossing = atDistance(ray.origin, ray.direction, 8);
    const bystander = e.world.avatarOf(1); bystander.pos = { x: crossing.x, y: crossing.y - AVATAR.height / 2, z: crossing.z };
    setTime(e, 130); expect(e.boss.eye.impact!.y).toBeCloseTo(0, 10);
    expect(e.target.hp).toBe(0); expect(bystander.hp).toBe(AVATAR.maxHp);
    const newcomer = spawnHippie(e.world, -1, e.boss.eye.impact!);
    for (const time of [130, 130.1, 130.49]) setTime(e, time);
    expect(newcomer.hp).toBe(0);
    const events = e.world.drainEvents();
    expect(events.filter(event => event.t === 'ko' && event.id === e.target.id)).toHaveLength(1);
    expect(events.filter(event => event.t === 'hit' && event.target === e.target.id)).toMatchObject([{ amount: 1000 }]);
  });
  it('caps a skyward miss at 240 meters and never explodes at the fallback endpoint', () => {
    const e = encounter(); setTime(e, 127); e.target.pos = { x: 0, y: 50, z: 40 };
    e.boss.eye.target = { x: 0, y: 50, z: 40 }; e.boss.eye.route = [{ ...e.boss.eye.target }];
    const ray = bossEyeRay(e.world, e.boss), survivor = e.world.avatarOf(1);
    survivor.pos = atDistance(ray.origin, ray.direction, 240);
    const raycast = vi.spyOn(e.world.collision, 'raycast'); setTime(e, 130);
    expect(raycast.mock.calls[0][6]).toBe(240); expect(raycast.mock.calls[0][7]).toBe(e.boss.id);
    expect(e.boss.eye.impact).toBeNull(); expect(e.boss.eye.firedAt).toBe(130); expect(survivor.hp).toBe(AVATAR.maxHp);
  });
  it('damages a surviving target by exactly 1000 once throughout the sweeping beam', () => {
    const e = encounter(); e.target.hp = 2500; setTime(e, 127); setTime(e, 130);
    expect(e.target.hp).toBe(1500);
    for (const time of [130, 130.1, 130.25, 130.499, 130.5]) setTime(e, time);
    expect(e.target.hp).toBe(1500); expect(e.target.koUntil).toBe(0);
    expect(e.world.drainEvents().filter(event => event.t === 'hit' && event.target === e.target.id)).toMatchObject([{ amount: 1000 }]);
  });
});

describe('single 1000-damage, 5-meter boss eye blast', () => {
  it('uses inclusive 3D body boundaries and never damages its own boss', () => {
    const { world, boss } = encounter(), inside = world.avatarOf(0), outside = world.avatarOf(1);
    inside.pos = { x: 5 + AVATAR.radius, y: 10, z: 0 }; outside.pos = { x: 5 + AVATAR.radius + .001, y: 10, z: 0 };
    const highInside = spawnHippie(world, -1, { x: 0, z: 0 }); highInside.airborne = { y: 15.5 - groundHeight(0,0,world.map.half), vy: 0 };
    const highOutside = spawnHippie(world, -1, { x: 0, z: 0 }); highOutside.airborne = { y: 15.501 - groundHeight(0,0,world.map.half), vy: 0 };
    blastBossEye(world, boss, { x: 0, y: 10.5, z: 0 });
    expect(inside.hp).toBe(0); expect(outside.hp).toBe(AVATAR.maxHp);
    expect(highInside.status).toBe('ko'); expect(highOutside.status).not.toBe('ko');
    expect(world.drainEvents().filter(e => e.t === 'hit')).toMatchObject([{ amount: 1000 }, { amount: 1000 }]);
    blastBossEye(world, boss, { x: 0, y: 0, z: 0 }); expect(boss.hp).toBe(BOSS_MAX_HP);
  });
  it('subtracts exactly 1000 from stronger avatars and hippies instead of forcing a KO', () => {
    const { world, boss, target } = encounter(); target.pos = { x: 0, y: 0, z: 0 }; target.hp = 1600;
    const strong = spawnHippie(world, -1, { x: 1, z: 0 }); strong.hp = 2100;
    const lethal = spawnHippie(world, -1, { x: -1, z: 0 }); lethal.hp = 1000;
    blastBossEye(world, boss, { x: 0, y: 0, z: 0 });
    expect(target.hp).toBe(600); expect(target.koUntil).toBe(0);
    expect(strong.hp).toBe(1100); expect(strong.status).not.toBe('ko'); expect(lethal.status).toBe('ko');
    expect(world.drainEvents().filter(e => e.t === 'hit')).toMatchObject([{ amount: 1000 }, { amount: 1000 }, { amount: 1000 }]);
  });
  it.each((Object.keys(BUILDINGS) as BuildingKind[]).flatMap(kind => [0, 2].map(level => ({ kind, level }))))('applies 1000 damage to $kind at level $level at its boundary while preserving the altar floor', ({ kind, level }) => {
    const { world, boss } = encounter();
    const strong = spawnBuilding(world, kind, -1, 0, .1), lethal = spawnBuilding(world, kind, -1, 1, 1), outside = spawnBuilding(world, kind, -1, 2, 1);
    strong.level = level; lethal.level = level; outside.level = level;
    strong.hp = 2500; strong.maxHp = 2500; lethal.hp = 1000; lethal.maxHp = 1000;
    strong.pos = { x: 5 + BUILDINGS[kind].radius, z: 0 }; lethal.pos = { x: -5 - BUILDINGS[kind].radius, z: 0 };
    outside.pos = { x: 0, z: 5 + BUILDINGS[kind].radius + .001 };
    const outsideHp = outside.hp;
    // encounter() deliberately uses flat collision terrain; test that actual surface
    // rather than the unrelated procedural dome, plus the authoritative deck level.
    blastBossEye(world, boss, { x: 0, y: world.collision.groundHeight(strong.pos.x, strong.pos.z) + level * LEVEL_HEIGHT + BUILDING_HEIGHT[kind] / 2, z: 0 });
    expect(world.buildings.has(strong.id)).toBe(true); expect(strong.hp).toBe(1500);
    expect(world.buildings.has(lethal.id)).toBe(kind === 'hearth'); expect(outside.hp).toBe(outsideHp);
    if (kind === 'hearth') expect(lethal.hp).toBe(1);
    expect(world.drainEvents().filter(e => e.t === 'buildingDisabled' && e.buildingId === lethal.id)).toHaveLength(kind === 'hearth' ? 0 : 1);
  });
  it('floors altars at 1 through repeated beams and eliminates a camp only when its final altar is eaten', () => {
    const { world, boss } = encounter();
    const first = spawnBuilding(world, 'hearth', 0, 0, 1), final = spawnBuilding(world, 'hearth', 0, 1, 1);
    first.pos = { x: 0, z: 0 }; final.pos = { x: 30, z: 0 }; final.hp = 1000;
    const stock = spawnFlag(world, { state: 'stock', owner: 0, holder: first.id, pos: { x: 100, y: 0, z: 100 } });
    blastBossEye(world, boss, { x: 0, y: 0, z: 0 });
    expect(first.hp).toBe(500); expect(world.factions[0].hearthIds).toEqual([first.id, final.id]);
    expect(world.flags.get(stock.id)).toMatchObject({ state: 'loose', holder: -1, owner: 0, pos: { x: 0, y: 0, z: 0 } });
    for (let i = 0; i < 3; i++) {
      blastBossEye(world, boss, { x: 0, y: 0, z: 0 }); blastBossEye(world, boss, { x: 30, y: 0, z: 0 });
    }
    expect(first.hp).toBe(1); expect(final.hp).toBe(1);
    expect(world.factions[0].alive).toBe(true); expect(world.factions[0].hearthIds).toEqual([first.id, final.id]);
    expect(world.flags.has(stock.id)).toBe(true); expect(world.hearthOf(0)).toBe(first);
    expect(world.drainEvents().filter(e => e.t === 'eliminated' && e.faction === 0)).toHaveLength(0);
    consumeBuilding(world, first);
    expect(world.factions[0].alive).toBe(true); expect(world.factions[0].hearthIds).toEqual([final.id]);
    expect(world.hearthOf(0)).toBe(final);
    consumeBuilding(world, final); consumeBuilding(world, final);
    expect(world.factions[0].alive).toBe(false); expect(world.factions[0].hearthIds).toEqual([]);
    expect(world.drainEvents().filter(e => e.t === 'eliminated' && e.faction === 0)).toHaveLength(1);
  });
  it('knocks stock flags loose while their low-HP altar survives the beam', () => {
    const { world, boss } = encounter(), altar = spawnBuilding(world, 'hearth', -1, 0, 1);
    altar.pos = { x: 0, z: 0 }; altar.hp = 1000;
    const flag = spawnFlag(world, { state: 'stock', owner: 0, holder: altar.id, pos: { x: 100, y: 0, z: 100 } });
    blastBossEye(world, boss, { x: 0, y: 0, z: 0 });
    expect(world.buildings.has(altar.id)).toBe(true); expect(altar.hp).toBe(1);
    expect(world.flags.get(flag.id)).toMatchObject({ state: 'loose', holder: -1, pos: { x: 0, y: 0, z: 0 } });
  });
  it('preserves stock outside the sphere even when the altar cylinder intersects it', () => {
    const { world, boss } = encounter(), altar = spawnBuilding(world, 'hearth', -1, 0, 1);
    altar.pos = { x: 7, z: 0 }; altar.hp = 500;
    const flag = spawnFlag(world, { state: 'stock', owner: 0, holder: altar.id, pos: { x: 0, y: 0, z: 0 } });
    blastBossEye(world, boss, { x: 0, y: 0, z: 0 });
    expect(world.buildings.has(altar.id)).toBe(true); expect(altar.hp).toBe(1);
    expect(world.flags.get(flag.id)).toMatchObject({ state: 'stock', holder: altar.id });
  });
  it.each(['wall', 'floor', 'ramp'] as PieceKind[])('subtracts 1000 from upper-level %s and removes collision only on the lethal shot', kind => {
    const { world, boss } = encounter(), facet = world.lattice.facetAt(0, 0), edge = world.lattice.facets[facet].edges[0];
    const piece = spawnPiece(world, kind, -1, edge, facet, 2, 0); attachPiece(world, piece); piece.hp = 1700; piece.maxHp = 1700;
    const at = piecePosition(world, piece)!, blast = { x: at.x, y: (piece.level + 1) * LEVEL_HEIGHT + 5, z: at.z };
    blastBossEye(world, boss, { x: at.x, y: pieceBottom(kind, 2) - 5.001, z: at.z }); expect(piece.hp).toBe(1700);
    blastBossEye(world, boss, blast); expect(world.pieces.has(piece.id)).toBe(true); expect(piece.hp).toBe(700); expect(piece.shapeIds.length).toBeGreaterThan(0);
    blastBossEye(world, boss, blast); expect(world.pieces.has(piece.id)).toBe(false); expect(piece.shapeIds).toHaveLength(0);
    expect(world.drainEvents().filter(e => e.t === 'pieceDestroyed' && e.pieceId === piece.id)).toHaveLength(1);
  });
  it('measures carried flags before KO scatter and drops the same recoverable flag at the carrier', () => {
    const { world, boss, target } = encounter(); target.pos = { x: 5, y: 0, z: 0 };
    const flag = spawnFlag(world, { state: 'loose', owner: 0, pos: { x: 100, y: 0, z: 100 } });
    expect(giveFlag(world, flag.id, target.id)).toBe(true);
    vi.spyOn(world.rng, 'range').mockReturnValue(Math.PI / 2); vi.spyOn(world.rng, 'next').mockReturnValue(.99);
    blastBossEye(world, boss, { x: 0, y: 0, z: 0 });
    expect(world.flags.get(flag.id)).toMatchObject({ state: 'loose', owner: 0, holder: -1, pos: { x: 5, y: 0, z: 0 } });
    expect(target.carried).not.toContain(flag.id);
    target.hp = AVATAR.maxHp; target.koUntil = 0;
    expect(giveFlag(world, flag.id, target.id)).toBe(true); expect(target.carried).toContain(flag.id);
  });
  it('knocks flags from surviving carriers while respecting the exact point-radius boundary', () => {
    const { world, boss, target } = encounter(), outside = world.avatarOf(1);
    target.pos = { x: 5, y: 0, z: 0 }; target.hp = 1600;
    outside.pos = { x: 5.001, y: 0, z: 0 }; outside.hp = 1600;
    const flags = [target, outside].map(a => { const f = spawnFlag(world, { state: 'loose', owner: a.faction, pos: a.pos }); expect(giveFlag(world, f.id, a.id)).toBe(true); return f; });
    blastBossEye(world, boss, { x: 0, y: 0, z: 0 });
    expect(target.hp).toBe(600); expect(outside.hp).toBe(600);
    expect(flags[0].state).toBe('loose'); expect(flags[1].state).toBe('carried'); expect(outside.carried).toContain(flags[1].id);
  });
  it('measures flying flags at projectile positions, preserves the flag and removes its projectile', () => {
    const { world, boss, target } = encounter();
    const flag = spawnFlag(world, { state: 'flying', owner: 0, pos: { x: 100, y: 0, z: 100 } });
    const projectile = spawnProjectile(world, flag.id, target.id, 0, { x: 5, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }); flag.holder = projectile.id;
    blastBossEye(world, boss, { x: 0, y: 0, z: 0 });
    expect(world.flags.get(flag.id)).toMatchObject({ state: 'loose', owner: 0, holder: -1, pos: { x: 5, y: 0, z: 0 } });
    expect(world.projectiles.has(projectile.id)).toBe(false);
  });
  it('clears surviving hippie hands, flag claims and pull channels when their flag is knocked down', () => {
    const { world, boss, target } = encounter();
    const carrier = spawnHippie(world, 0, { x: 0, z: 0 }); carrier.hp = 1600;
    const flag = spawnFlag(world, { state: 'loose', owner: 0, pos: { x: 0, y: 0, z: 0 } });
    expect(giveFlag(world, flag.id, carrier.id)).toBe(true);
    const brain = brainOf(carrier); brain.flag = flag.id; brain.task = 'plant';
    carrier.status = 'planting'; carrier.order = { kind: 'pull', flagId: flag.id };
    unitsState(world).flagClaims.set(flag.id, carrier.id);
    target.action = { kind: 'pull', flagId: flag.id, t: 0, dur: 3 };
    blastBossEye(world, boss, { x: 0, y: 0, z: 0 });
    expect(carrier.hp).toBe(600); expect(carrier.carryingFlag).toBe(-1); expect(carrier.order).toBeNull();
    expect(brain.flag).toBe(-1); expect(brain.task).toBe('none'); expect(unitsState(world).flagClaims.has(flag.id)).toBe(false);
    expect(target.action.kind).toBe('idle'); expect(world.flags.get(flag.id)?.state).toBe('loose');
  });
  it('knocks down a simulacrum at its alternate node and clears both survey references', () => {
    const { world, boss } = encounter(), nodes = world.lattice.nodes;
    const node = nodes.findIndex((n, id) => !n.blocked && world.survey.nodeFlag[id] < 0);
    const alt = nodes.findIndex((n, id) => id !== node && !n.blocked && Math.hypot(n.x - nodes[node].x, n.z - nodes[node].z) > 30 && world.survey.nodeFlag[id] < 0);
    const flag = spawnFlag(world, { state: 'loose', owner: 0, pos: { x: nodes[node].x, y: 0, z: nodes[node].z } });
    expect(plantFlag(world, flag.id, node, 0, -1)).toBe(true); flag.altNode = alt;
    world.survey.nodeFlag[alt] = flag.id; world.survey.nodeFlagOwner[alt] = 0;
    blastBossEye(world, boss, { x: nodes[alt].x, y: 0, z: nodes[alt].z });
    expect(world.flags.get(flag.id)).toMatchObject({ state: 'loose', node: -1, altNode: -1, holder: -1 });
    expect(world.survey.nodeFlag[node]).toBe(-1); expect(world.survey.nodeFlag[alt]).toBe(-1);
  });
  it('opens a planted flag loop without destroying its supporting flags', () => {
    const world = newMatch('beam-loop'); world.effigyRevealedAt = world.time; const boss = spawnBoss(world)!;
    const edge = bossLoopEdges(world)[0], support = barrierFlags(world, edge)[0]; expect(support).toBeDefined();
    blastBossEye(world, boss, { ...support.pos }); updateSurvey(world, SIM_DT);
    expect(world.flags.get(support.id)?.state).toBe('loose'); expect(bossLoopEdges(world)).not.toContain(edge);
  });
  it('leaves piles and intact crystals alone, then normal crystal rules react when sustaining flags fall', () => {
    const world = newMatch('beam-pentacle'); world.tide.nextAt = Infinity; runRules(world, SIM_DT);
    const node = freeFocus(world, 3), flags = plantFresh(world, 3, world.lattice.neighbors(node)); runRules(world, SIM_DT);
    const crystal = [...world.crystals.values()].find(c => c.node === node)!;
    world.effigyRevealedAt = world.time; const boss = spawnBoss(world)!;
    const pile = spawnPile(world, 'lumber', crystal.pos, 500);
    blastBossEye(world, boss, { ...crystal.pos, y: 0 });
    expect(world.crystals.has(crystal.id)).toBe(true); expect(pile.lumber).toBe(500);
    const support = world.flags.get(flags[0])!; blastBossEye(world, boss, { ...support.pos });
    expect(world.flags.get(support.id)?.state).toBe('loose'); runRules(world, SIM_DT);
    expect(world.crystals.has(crystal.id)).toBe(false); expect(world.flags.has(support.id)).toBe(true);
  });
});
