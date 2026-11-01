import { groundHeight } from '../../terrain';
import { describe, expect, it } from 'vitest';
import { BOSS_EYE_BLAST_RADIUS, BOSS_EYE_MAX_RANGE, BOSS_EYE_TIMING } from '../../boss';
import { BOSS_GAMEPLAY_SCALE, BOSS_HEIGHT } from '../../bossDimensions';
import { AVATAR, LEVEL_HEIGHT, SIM_DT } from '../../constants';
import { spawnAvatar, spawnBuilding, spawnFlag, spawnHippie, spawnPiece, spawnProjectile } from '../../factory';
import { CollisionWorld } from '../../physics/collision';
import { createMatch } from '../../setup';
import { cmdThrow } from '../avatars';
import { spawnBoss } from '../boss';
import { damageEntity } from '../combat';
import { giveFlag } from '../flags';
import { attachPiece, piecePosition } from '../pieces';
import { updateProjectiles } from '../projectiles';
import { updateBossEye } from './eye';
import { BOSS_EYE_MIN_TARGET_DISTANCE, chooseBossEyeTarget } from './eyeTargeting';
import { BOSS_FLAG_THREAT_SECONDS, observeBossFlagThrow, recentBossFlagThreats, recordBossFlagThreat } from './eyeThreats';

function setup() {
  const world = createMatch({ seed: 'eye-strategy', difficulty: 'normal', humans: [0, 1], mode: 'standard' });
  world.time = 127; world.effigyRevealedAt = 100;
  const boss = spawnBoss(world)!; boss.action = 'idle'; boss.pos = { x: 0, z: 0 }; boss.yaw = 0;
  world.collision = new CollisionWorld(); world.map.obstacles = [];
  world.hippies.clear(); world.buildings.clear(); world.pieces.clear(); world.flags.clear(); world.projectiles.clear();
  for (const f of world.factions) { f.hearthIds = []; f.gccId = null; }
  for (const a of world.avatars.values()) { a.pos = { x: 100, y: 0, z: a.faction * 20 }; a.carried = []; }
  return { world, boss, avatar: world.avatarOf(0) };
}
function group(world: ReturnType<typeof setup>['world'], x: number, z: number, count = 3) {
  return Array.from({ length: count }, (_, i) => spawnHippie(world, -1, { x: x + i * .4, z }));
}

describe('independent strategic eye targeting', () => {
  it('ignores its close melee hippie and chooses the larger real five-meter crowd', () => {
    const { world, boss } = setup(), feet = spawnHippie(world, -1, { x: 0, z: 3 });
    boss.target = { kind: 'hippie', id: feet.id };
    group(world, 0, 30, 3); group(world, 30, 30, 7);
    const at = chooseBossEyeTarget(world, boss)!;
    expect(at.x).toBeGreaterThan(25); expect(at.z).toBe(30);
    expect(Math.hypot(at.x, at.z)).toBeGreaterThan(BOSS_EYE_MIN_TARGET_DISTANCE);
  });
  it('never selects close-foot crowds, isolated units, plain Flags or eat-only altars', () => {
    const { world, boss, avatar } = setup();
    group(world, 0, 3, 8); spawnHippie(world, -1, { x: 0, z: 40 });
    const altar = spawnBuilding(world, 'hearth', 0, 0, 1); altar.pos = { x: 0, z: 35 };
    spawnFlag(world, { owner: 0, state: 'loose', pos: { x: 0, y: 0, z: 30 } });
    avatar.pos = { x: 0, y: 0, z: 15 }; damageEntity(world, boss.id, 10, avatar.id);
    boss.target = { kind: 'building', id: altar.id };
    expect(boss.retaliateId).toBe(avatar.id); expect(chooseBossEyeTarget(world, boss)).toBeNull();
  });
  it('keeps even a Flag attacker beyond the footprint plus blast margin, with an inclusive boundary', () => {
    const { world, boss, avatar } = setup();
    avatar.pos = { x: 0, y: 0, z: BOSS_EYE_MIN_TARGET_DISTANCE - .001 }; recordBossFlagThreat(world, avatar.id);
    expect(chooseBossEyeTarget(world, boss)).toBeNull();
    avatar.pos.z = BOSS_EYE_MIN_TARGET_DISTANCE; recordBossFlagThreat(world, avatar.id);
    expect(chooseBossEyeTarget(world, boss)).toEqual(avatar.pos);
  });
  it('reserves the scaled pupil envelope without scaling the five-meter blast or 240-meter ray', () => {
    const { world, boss, avatar } = setup();
    expect(BOSS_HEIGHT).toBe(32); expect(BOSS_EYE_MIN_TARGET_DISTANCE).toBeCloseTo(9.26);
    expect(BOSS_EYE_BLAST_RADIUS).toBe(5); expect(BOSS_EYE_MAX_RANGE).toBe(240);
    const limit = Math.sqrt((BOSS_EYE_MAX_RANGE - 24 * BOSS_GAMEPLAY_SCALE) ** 2 - groundHeight(0,0,world.map.half) ** 2);
    avatar.pos = { x: 0, y: 0, z: limit + .001 }; recordBossFlagThreat(world, avatar.id);
    expect(chooseBossEyeTarget(world, boss)).toBeNull();
    avatar.pos.z = limit; recordBossFlagThreat(world, avatar.id);
    expect(chooseBossEyeTarget(world, boss)).toEqual(avatar.pos);
  });
  it.each([0, 2])('targets live gameplay structures at level %s and ignores dead buildings', level => {
    const { world, boss } = setup();
    const dead = spawnBuilding(world, 'gcc', 0, 0, 1); dead.pos = { x: 0, z: 20 }; dead.hp = 0;
    const live = spawnBuilding(world, 'workshop', 0, 1, 1, level); live.pos = { x: 0, z: 60 };
    expect(chooseBossEyeTarget(world, boss)).toEqual({ x: 0, y: world.collision.groundHeight(0, 60) + level * LEVEL_HEIGHT + 1.5, z: 60 });
    world.buildings.delete(live.id); expect(chooseBossEyeTarget(world, boss)).toBeNull();
  });
  it('recognizes player-built pieces as structures', () => {
    const { world, boss } = setup(), facet = world.lattice.facetAt(0, 40);
    const p = spawnPiece(world, 'floor', 0, -1, facet, 0, -1); attachPiece(world, p);
    expect(chooseBossEyeTarget(world, boss)).toEqual(piecePosition(world, p));
  });
  it('scores blast-local groups rather than unrelated scattered or vertically separated units', () => {
    const { world, boss } = setup(); group(world, 30, 35);
    for (const z of [20, 35, 50, 65, 80]) spawnHippie(world, -1, { x: -35, z });
    const elevated = group(world, 0, 35, 6); elevated.forEach((h, i) => { h.airborne = { y: i * 12, vy: 0 }; });
    const at = chooseBossEyeTarget(world, boss)!;
    expect(at.x).toBeGreaterThan(25); expect(at.z).toBe(35);
  });
  it('finds a group spread around an empty center, with no unit at the ideal impact point', () => {
    const { world, boss } = setup();
    for (let i = 0; i < 3; i++) { const angle = i * Math.PI * 2 / 3; spawnHippie(world, -1, { x: Math.cos(angle) * 4.7, z: 40 + Math.sin(angle) * 4.7 }); }
    const at = chooseBossEyeTarget(world, boss)!; expect(at.x).toBeCloseTo(0); expect(at.z).toBeCloseTo(40);
  });
  it('prioritizes a recent Flag thrower over an ordinary staff retaliator, while a large crowd can win', () => {
    const { world, boss, avatar } = setup(), staff = world.avatarOf(1);
    avatar.pos = { x: 0, y: 0, z: 35 }; staff.pos = { x: 30, y: 0, z: 0 };
    recordBossFlagThreat(world, avatar.id); damageEntity(world, boss.id, 10, staff.id);
    const workshop = spawnBuilding(world, 'workshop', -1, 0, 1); workshop.pos = { x: -30, z: 0 };
    expect(chooseBossEyeTarget(world, boss)).toEqual(avatar.pos);
    group(world, 35, 35, 8); expect(chooseBossEyeTarget(world, boss)!.x).toBeGreaterThan(30);
  });
  it.each(['ko', 'dead', 'removed', 'expired', 'eliminated'] as const)('ignores a %s Flag threat', state => {
    const { world, boss, avatar } = setup(); avatar.pos = { x: 0, y: 0, z: 40 }; recordBossFlagThreat(world, avatar.id);
    if (state === 'ko') avatar.koUntil = world.time + 10;
    if (state === 'dead') avatar.hp = 0;
    if (state === 'removed') world.avatars.delete(avatar.id);
    if (state === 'expired') world.time += BOSS_FLAG_THREAT_SECONDS;
    if (state === 'eliminated') world.factions[avatar.faction].alive = false;
    expect(chooseBossEyeTarget(world, boss)).toBeNull(); expect(recentBossFlagThreats(world).size).toBe(0);
  });
  it('defers without consuming cooldown, rechecks after .5s, then holds a full charge and five-second shot', () => {
    const { world, boss } = setup();
    expect(updateBossEye(world, boss, SIM_DT)).toBe(false); expect(boss.eye.nextFireAt).toBe(130);
    group(world, 0, 40); world.time = 127.49; expect(updateBossEye(world, boss, SIM_DT)).toBe(false);
    world.time = 127.5; expect(updateBossEye(world, boss, SIM_DT)).toBe(true);
    expect(boss.eye.chargeAt).toBe(127.5); expect(boss.eye.nextFireAt).toBe(130.5);
    const point = { ...boss.eye.target! }; world.hippies.clear();
    world.time = 130.49; updateBossEye(world, boss, SIM_DT); expect(boss.eye.firedAt).toBeNull();
    world.time = 130.5; updateBossEye(world, boss, SIM_DT);
    expect(boss.eye.target).toEqual(point); expect(boss.eye.nextFireAt).toBe(160.5);
    const shot = structuredClone(boss.eye);
    world.time = 130.99; updateBossEye(world, boss, SIM_DT); expect(boss.eye.firedAt).toBe(shot.firedAt); expect(boss.eye.target).toEqual(shot.target); expect(boss.eye.sample).toBe(29);
    world.time = 135.5; updateBossEye(world, boss, SIM_DT); expect(boss.eye.chargeAt).toBeNull();
    expect(BOSS_EYE_TIMING).toEqual({ period: 30, charge: 3, beam: 5 });
  });
  it('wakes deferred selection for new aggression and keeps its locked point if the attacker dies', () => {
    const { world, boss, avatar } = setup(); avatar.pos = { x: 0, y: 0, z: 30 };
    expect(updateBossEye(world, boss, SIM_DT)).toBe(false);
    world.time += .1; recordBossFlagThreat(world, avatar.id); expect(updateBossEye(world, boss, SIM_DT)).toBe(true);
    const point = { ...boss.eye.target! }; avatar.pos.x = 80; avatar.hp = 0; avatar.koUntil = 200;
    world.time += 3; updateBossEye(world, boss, SIM_DT);
    expect(boss.eye.target).toEqual(point); expect(boss.eye.firedAt).toBe(world.time);
  });
});

describe('actual Flag aggression hooks', () => {
  it('records successful aimed throws, without confusing empty hands, sideways throws or staff damage', () => {
    const { world, boss, avatar } = setup(); avatar.pos = { x: 0, y: 0, z: 20 }; avatar.input.yaw = Math.PI; avatar.input.pitch = .2;
    cmdThrow(world, { t: 'throw', faction: 0 }); expect(recentBossFlagThreats(world).size).toBe(0);
    damageEntity(world, boss.id, 10, avatar.id); expect(recentBossFlagThreats(world).size).toBe(0);
    const flag = spawnFlag(world, { state: 'loose', owner: 0, pos: avatar.pos }); giveFlag(world, flag.id, avatar.id);
    avatar.input.yaw = Math.PI / 2; cmdThrow(world, { t: 'throw', faction: 0 });
    expect(world.projectiles.size).toBe(1); expect(recentBossFlagThreats(world).size).toBe(0);
    world.time += AVATAR.throwCooldown;
    const next = spawnFlag(world, { state: 'loose', owner: 0, pos: avatar.pos }); giveFlag(world, next.id, avatar.id);
    avatar.input.yaw = Math.PI; cmdThrow(world, { t: 'throw', faction: 0 });
    expect(recentBossFlagThreats(world).get(avatar.id)).toBe(world.time);
  });
  it('bounds throw memory to four avatars and clears it for a replacement boss', () => {
    const { world, boss, avatar } = setup();
    for (const a of world.avatars.values()) { recordBossFlagThreat(world, a.id); world.time += .01; }
    const replacement = spawnAvatar(world, 0, { x: 0, z: 30 }); recordBossFlagThreat(world, replacement.id);
    expect(recentBossFlagThreats(world).size).toBe(4); expect(recentBossFlagThreats(world).has(avatar.id)).toBe(false);
    boss.id = world.newId(); expect(recentBossFlagThreats(world).size).toBe(0);
  });
  it('rejects away-facing, too-short and skyward ballistic throws', () => {
    const { world, avatar } = setup();
    for (const [from, velocity] of [[{ x: 0, y: 1.5, z: 20 }, { x: 0, y: 0, z: 26 }],
      [{ x: 0, y: 1.5, z: 100 }, { x: 0, y: 0, z: -26 }],
      [{ x: 0, y: 50, z: 20 }, { x: 0, y: 20, z: -26 }]] as const) {
      const projectile = spawnProjectile(world, -1, avatar.id, avatar.faction, from, velocity);
      observeBossFlagThrow(world, projectile); expect(recentBossFlagThreats(world).size).toBe(0);
    }
  });
  it.each([0, 2])('recognizes an incoming hat-height Flag, but rejects a trajectory %s meters above it', offset => {
    const { world, boss, avatar } = setup(), near = 20 / 26;
    // Its apex is exactly at the 32 m hat height over the boss. Across the whole
    // horizontal body envelope the accepted arc stays above the old 24 m ceiling.
    const from = { x: 0, y: BOSS_HEIGHT - AVATAR.gravity * near * near / 2 + offset, z: 20 };
    const flag = spawnFlag(world, { state: 'flying', owner: 0, pos: from });
    const projectile = spawnProjectile(world, flag.id, avatar.id, 0, from, { x: 0, y: AVATAR.gravity * near, z: -26 });
    flag.holder = projectile.id; observeBossFlagThrow(world, projectile);
    expect(recentBossFlagThreats(world).has(avatar.id)).toBe(offset === 0);
    expect(boss.hp).toBe(boss.maxHp); expect(world.projectiles.has(projectile.id)).toBe(true);
    expect(world.flags.get(flag.id)?.state).toBe('flying');
  });
  it('records a confirmed Flag hit even if its launch was not observed', () => {
    const { world, boss, avatar } = setup();
    const flag = spawnFlag(world, { state: 'flying', owner: 0, pos: { x: 0, y: 10, z: 10 } });
    const projectile = spawnProjectile(world, flag.id, avatar.id, 0, flag.pos, { x: 0, y: 0, z: -200 }); flag.holder = projectile.id;
    updateProjectiles(world, .1);
    expect(world.flags.has(flag.id)).toBe(false); expect(boss.hp).toBeLessThan(boss.maxHp);
    expect(recentBossFlagThreats(world).get(avatar.id)).toBe(world.time);
  });
});
