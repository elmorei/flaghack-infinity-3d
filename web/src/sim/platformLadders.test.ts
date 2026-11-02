import { describe, expect, it } from 'vitest';
import { AVATAR, LEVEL_HEIGHT, SIM_DT } from './constants';
import { spawnPiece } from './factory';
import { CollisionWorld } from './physics/collision';
import { createMatch } from './setup';
import { platformLadders, PLATFORM_LADDER_STANDOFF, type PlatformLadder } from './platformLadders';
import { stepAvatarMotion } from './systems/avatars';
import { applyEffect } from './systems/effects';
import { knockback } from './systems/combat';
import { attachPiece, destroyPiece } from './systems/pieces';
import { SnapshotEncoder } from '../net/codec';
import { NetMirror } from '../net/mirror';
import type { AvatarInput } from './types';

function fixture(level = 0) {
  const world = createMatch({ seed: 'platform-ladder', difficulty: 'normal', humans: [0], mode: 'standard' });
  world.collision = new CollisionWorld(); world.pieces.clear(); world.buildings.clear(); world.boss = null;
  const fc = world.lattice.facets.find(f => f.thick && !f.boundary && Math.abs(f.cx) < 50 && Math.abs(f.cz) < 50)!;
  const deck = spawnPiece(world, 'floor', 0, -1, fc.id, level, -1); attachPiece(world, deck);
  const ladder = platformLadders(world)[0];
  const av = world.avatarOf(0);
  av.pos = { x: ladder.x + ladder.nx * PLATFORM_LADDER_STANDOFF, y: ladder.bottomY, z: ladder.z + ladder.nz * PLATFORM_LADDER_STANDOFF };
  av.vel = {x:0,y:0,z:0}; av.onGround = true;
  return { world, deck, ladder, av };
}
function input(ladder: PlatformLadder, direction: number, jump = false): AvatarInput {
  return { moveX: ladder.nx * direction, moveZ: ladder.nz * direction, yaw: Math.atan2(-ladder.nx, -ladder.nz), pitch: 0, jump, sprint: false };
}
function ticks(f: ReturnType<typeof fixture>, value: AvatarInput, seconds: number) {
  for (let i = 0; i < Math.ceil(seconds / SIM_DT); i++) stepAvatarMotion(f.world, f.av, value, SIM_DT);
}

describe('exposed platform ladders', () => {
  it('creates four sides and hides only the shared side of same-level adjacent decks', () => {
    const f = fixture(); expect(platformLadders(f.world)).toHaveLength(4);
    const fc = f.world.lattice.facets[f.deck.facet], neighbor = fc.neighbors[0];
    const second = spawnPiece(f.world, 'floor', 0, -1, neighbor, 0, -1); attachPiece(f.world, second);
    const exposed = platformLadders(f.world);
    expect(exposed).toHaveLength(6);
    expect(exposed.some(l => l.edge === fc.edges[0])).toBe(false);
    destroyPiece(f.world, second);
    expect(platformLadders(f.world)).toHaveLength(4);
    expect(platformLadders(f.world).some(l => l.edge === fc.edges[0])).toBe(true);
  });
  it('does not hide a ladder behind a different-level neighboring deck', () => {
    const f = fixture(), fc = f.world.lattice.facets[f.deck.facet];
    const second = spawnPiece(f.world, 'floor', 0, -1, fc.neighbors[0], 1, -1); attachPiece(f.world, second);
    expect(platformLadders(f.world)).toHaveLength(8);
  });
  it.each([1, .45])('climbs to the actual deck and descends with shared movement input magnitude %s', magnitude => {
    const f = fixture();
    ticks(f, input(f.ladder, -magnitude), LEVEL_HEIGHT / (4.2 * magnitude) + .25);
    expect(f.av.pos.y).toBeCloseTo(f.ladder.topY, 4);
    const outward = (f.av.pos.x - f.ladder.x) * f.ladder.nx + (f.av.pos.z - f.ladder.z) * f.ladder.nz;
    expect(outward).toBeLessThan(-.08); // Actual walk-on, without moving feet in the fixture.
    ticks(f, input(f.ladder, magnitude), LEVEL_HEIGHT / (4.2 * magnitude) + .65);
    expect(f.av.pos.y).toBeCloseTo(f.ladder.bottomY, 4);
  });
  it('holds position when input is released, and jump dismounts outward', () => {
    const f = fixture(); ticks(f, input(f.ladder, -1), .5);
    const y = f.av.pos.y; expect(y).toBeGreaterThan(.5);
    ticks(f, input(f.ladder, 0), .5); expect(f.av.pos.y).toBeCloseTo(y, 5);
    ticks(f, input(f.ladder, 0, true), .2);
    const out = (f.av.pos.x - f.ladder.x) * f.ladder.nx + (f.av.pos.z - f.ladder.z) * f.ladder.nz;
    expect(out).toBeGreaterThan(PLATFORM_LADDER_STANDOFF + .2);
  });
  it('boards the first stacked deck normally and can continue upward by looking up', () => {
    const f = fixture();
    const upper = spawnPiece(f.world, 'floor', 0, -1, f.deck.facet, 1, -1); attachPiece(f.world, upper);
    ticks(f, input(f.ladder, -1), LEVEL_HEIGHT / 4.2 + .25);
    expect(f.av.pos.y).toBeCloseTo(LEVEL_HEIGHT, 4);
    expect((f.av.pos.x-f.ladder.x)*f.ladder.nx+(f.av.pos.z-f.ladder.z)*f.ladder.nz).toBeLessThan(-.08);
    const second = fixture();
    const next = spawnPiece(second.world, 'floor', 0, -1, second.deck.facet, 1, -1); attachPiece(second.world, next);
    ticks(second, {...input(second.ladder,-1),pitch:.65}, 2 * LEVEL_HEIGHT / 4.2 + .25);
    expect(second.av.pos.y).toBeCloseTo(2 * LEVEL_HEIGHT, 4);
  });
  it('cannot climb a distant ladder, or pass a solid ceiling in the ladder lane', () => {
    const f = fixture();
    f.av.pos.x += f.ladder.nx * 4; f.av.pos.z += f.ladder.nz * 4;
    ticks(f, input(f.ladder, -1), .1); expect(f.av.pos.y).toBe(0);
    f.av.pos = {x:f.ladder.x + f.ladder.nx * PLATFORM_LADDER_STANDOFF,y:0,z:f.ladder.z + f.ladder.nz * PLATFORM_LADDER_STANDOFF};
    f.world.collision.addBox(f.av.pos.x, f.av.pos.z, 2, 2, 0, 3, 3.2, 991);
    ticks(f, input(f.ladder, -1), 2);
    expect(f.av.pos.y + AVATAR.height).toBeLessThanOrEqual(3 + 1e-6);
  });
  it('restores normal falling when the supporting deck disappears', () => {
    const f = fixture(); ticks(f, input(f.ladder, -1), .5);
    const y = f.av.pos.y; destroyPiece(f.world, f.deck);
    ticks(f, input(f.ladder, 0), .5); expect(f.av.pos.y).toBeLessThan(y);
  });
  it.each(['ko', 'stun', 'knockback'] as const)('does not cling when interrupted by %s', effect => {
    const f = fixture(); ticks(f, input(f.ladder,-1), .6); ticks(f,input(f.ladder,0),.1);
    const y=f.av.pos.y;
    if(effect==='ko') f.av.koUntil=f.world.time+10;
    else if(effect==='stun') applyEffect(f.world,f.av,'stun',10,1);
    else knockback(f.world,f.av.id,{x:f.av.pos.x-f.ladder.nx,z:f.av.pos.z-f.ladder.nz},6);
    ticks(f,input(f.ladder,0),.5);
    if(effect==='knockback') expect((f.av.pos.x-f.ladder.x)*f.ladder.nx+(f.av.pos.z-f.ladder.z)*f.ladder.nz).toBeGreaterThan(1);
    else expect(f.av.pos.y).toBeLessThan(y);
  });
  it('derives identical ladder geometry and motion on a replicated world', () => {
    const f = fixture();
    // Both worlds use the same actual collision terrain for this isolated geometry test.
    const mirror = NetMirror.create(f.world.options, JSON.parse(JSON.stringify(new SnapshotEncoder(f.world).full())));
    mirror.world.collision = new CollisionWorld();
    for (const p of mirror.world.pieces.values()) { p.shapeIds = []; attachPiece(mirror.world, p); }
    expect(platformLadders(mirror.world)).toEqual(platformLadders(f.world));
    const other = mirror.world.avatarOf(0); other.pos = {...f.av.pos}; other.vel = {...f.av.vel};
    for (let i=0;i<120;i++) { const command=input(f.ladder,-1); stepAvatarMotion(f.world,f.av,command,SIM_DT); stepAvatarMotion(mirror.world,other,command,SIM_DT); }
    expect(other.pos).toEqual(f.av.pos); expect(other.vel).toEqual(f.av.vel);
  });
});
