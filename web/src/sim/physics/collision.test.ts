import { describe, expect, it } from 'vitest';
import { AVATAR, LEVEL_HEIGHT, MAP_HALF, SIM_DT } from '../constants';
import { generateMap } from '../map/mapgen';
import type { MapLayout, Obstacle } from '../map/mapgen';
import type { V3 } from '../math';
import { Rng } from '../rng';
import { CollisionWorld, GROUND_SHAPE, GROUND_TAG, STAGE_DECK_HEIGHT } from './collision';

const R = AVATAR.radius;
const H = AVATAR.height;
const STEP = AVATAR.stepHeight;

/** Drive a character like the avatar system does: set horizontal velocity, integrate gravity. */
function walk(world: CollisionWorld, pos: V3, vx: number, vz: number, seconds: number, ignoreTag?: number) {
  const vel = { x: vx, y: 0, z: vz };
  let hitWall = false;
  let onGround = false;
  for (let t = 0; t < seconds; t += SIM_DT) {
    vel.x = vx;
    vel.z = vz;
    vel.y -= AVATAR.gravity * SIM_DT;
    const r = world.moveCharacter(pos, vel, SIM_DT, R, H, STEP, ignoreTag);
    hitWall ||= r.hitWall;
    onGround = r.onGround;
  }
  return { hitWall, onGround, vel };
}

/** Axis-aligned rectangle as a polygon (CCW in x-z). */
function rect(x0: number, z0: number, x1: number, z1: number): [number[], number[]] {
  return [
    [x0, x1, x1, x0],
    [z0, z0, z1, z1],
  ];
}

/** Minimal layout carrying only the given obstacles. */
function layoutOf(obstacles: Obstacle[]): MapLayout {
  return {
    seed: 'test',
    half: MAP_HALF,
    camps: [],
    obstacles,
    roads: [],
    water: [],
    mud: [],
    soundCamps: [],
    pileSpots: [],
    neutralSpawns: [],
    effigy: { x: 0, z: 0 },
    isBlockedAt: () => false,
    groundAt: () => 'grass',
  };
}

describe('CollisionWorld', () => {
  it('stops a character walking into a wall and lets it slide along', () => {
    const w = new CollisionWorld();
    w.addBox(0, 5, 3, 0.1, 0, 0, LEVEL_HEIGHT, 7);
    const pos = { x: 0, y: 0, z: 0 };
    const res = walk(w, pos, 0, 8, 2);
    expect(res.hitWall).toBe(true);
    expect(pos.z).toBeLessThanOrEqual(5 - 0.1 - R + 1e-6);
    expect(pos.z).toBeGreaterThan(5 - 0.1 - R - 0.05);
    expect(pos.y).toBe(0);
    // Diagonal into the wall: slides along x and keeps moving past its end.
    const p2 = { x: 0, y: 0, z: 4 };
    walk(w, p2, 6, 6, 1.5);
    expect(p2.z).toBeGreaterThan(5);
    expect(p2.x).toBeGreaterThan(3);
  });

  it('steps onto low ledges but not onto knee-high ones', () => {
    const w = new CollisionWorld();
    w.addBox(0, 4, 2, 2, 0, 0, 0.4, 1);
    w.addBox(10, 4, 2, 2, 0, 0, 0.8, 2);
    const low = { x: 0, y: 0, z: 0 };
    const a = walk(w, low, 0, 6, 1);
    expect(low.y).toBeCloseTo(0.4, 6);
    expect(a.onGround).toBe(true);
    const high = { x: 10, y: 0, z: 0 };
    const b = walk(w, high, 0, 6, 1);
    expect(b.hitWall).toBe(true);
    expect(high.y).toBe(0);
    expect(high.z).toBeLessThan(2);
  });

  it('walks up a ramp from its low edge onto the deck at its top', () => {
    const w = new CollisionWorld();
    const [rx, rz] = rect(-2, 0, 2, 6);
    w.addRamp(rx, rz, 0, 1, 0, LEVEL_HEIGHT, 0.25, 3);
    const [dx, dz] = rect(-2, 6, 2, 10);
    w.addSlab(dx, dz, LEVEL_HEIGHT, 0.25, 4);
    const pos = { x: 0, y: 0, z: -2 };
    walk(w, pos, 0, 6, 0.75);
    // Midway up the ramp: y follows the slope.
    expect(pos.z).toBeGreaterThan(1);
    expect(pos.z).toBeLessThan(6);
    expect(pos.y).toBeCloseTo((LEVEL_HEIGHT * pos.z) / 6, 1);
    // A steeper 6.4 m ramp advances more slowly because each contact respects step height.
    // Continue driving to the top, with a bounded traversal time rather than the old 3.2 m timing.
    let res = walk(w, pos, 0, 6, SIM_DT);
    for (let t = 0; t < 2 && pos.z <= 6.1; t += SIM_DT) res = walk(w, pos, 0, 6, SIM_DT);
    expect(pos.z).toBeGreaterThan(6);
    expect(pos.y).toBeCloseTo(LEVEL_HEIGHT, 6);
    expect(res.onGround).toBe(true);
    expect(w.supportHeight(pos.x, pos.z, pos.y + STEP)).toBeCloseTo(LEVEL_HEIGHT, 6);
  });

  it.each([36, 72])('traverses a tall ramp with the %s-degree lattice facet run', angle => {
    const w = new CollisionWorld(), run = 8 * Math.sin(angle * Math.PI / 180);
    const [rx, rz] = rect(-2, 0, 2, run);
    w.addRamp(rx, rz, 0, 1, 0, LEVEL_HEIGHT, .25, 3);
    const [dx, dz] = rect(-2, run, 2, run + 4);
    w.addSlab(dx, dz, LEVEL_HEIGHT, .25, 4);
    const pos = { x: 0, y: 0, z: -2 };
    let result = walk(w, pos, 0, 6, SIM_DT);
    for (let t = 0; t < 5 && pos.z <= run + .2; t += SIM_DT) result = walk(w, pos, 0, 6, SIM_DT);
    expect(pos.z).toBeGreaterThan(run);
    expect(pos.y).toBeCloseTo(LEVEL_HEIGHT, 6);
    expect(result.onGround).toBe(true);
  });

  it.each(['slab', 'wall'] as const)('does not use tall ramp traversal to climb an oversized adjoining %s', kind => {
    const w = new CollisionWorld(), run = 8 * Math.sin(Math.PI / 5);
    const [rx, rz] = rect(-2, 0, 2, run);
    w.addRamp(rx, rz, 0, 1, 0, LEVEL_HEIGHT, .25, 3);
    if (kind === 'slab') {
      const [dx, dz] = rect(-2, run, 2, run + 4);
      w.addSlab(dx, dz, LEVEL_HEIGHT + 1, .25, 4);
    } else {
      w.addBox(0, run + .1, 2, .1, 0, LEVEL_HEIGHT, LEVEL_HEIGHT + 2, 4);
    }
    const pos = { x: 0, y: 0, z: -2 };
    const result = walk(w, pos, 0, 6, 5);
    expect(result.hitWall).toBe(true);
    expect(pos.z).toBeLessThan(run);
    expect(pos.y).toBeLessThanOrEqual(LEVEL_HEIGHT);
  });

  it.each([36, 72])('keeps the tall %s-degree ramp high edge and underside solid', angle => {
    const w = new CollisionWorld(), run = 8 * Math.sin(angle * Math.PI / 180);
    const [rx, rz] = rect(-2, 0, 2, run);
    w.addRamp(rx, rz, 0, 1, 0, LEVEL_HEIGHT, .25, 3);
    // A body intersecting the high vertical edge cannot enter from behind it.
    const side = { x: 0, y: LEVEL_HEIGHT - .75, z: run + 1 };
    const blocked = w.moveCharacter(side, { x: 0, y: 0, z: -6 }, .2, R, H, STEP);
    expect(blocked.hitWall).toBe(true);
    expect(side.z).toBeGreaterThanOrEqual(run + R - .01);
    // Jumping from underneath still collides with the sloped plank's underside.
    const under = { x: 0, y: 0, z: run / 2 }, velocity = { x: 0, y: 20, z: 0 };
    w.moveCharacter(under, velocity, .15, R, H, STEP);
    expect(under.y + H).toBeLessThanOrEqual(LEVEL_HEIGHT / 2 - .25 + .01);
    expect(velocity.y).toBe(0);
  });

  it('blocks a ramp from the side where it is at body height, but not under its high end', () => {
    const w = new CollisionWorld();
    const [rx, rz] = rect(-2, 0, 2, 6);
    w.addRamp(rx, rz, 0, 1, 0, LEVEL_HEIGHT, 0.25, 3);
    // Side approach where the surface is 1.6 m: a wall at chest height.
    const side = { x: -6, y: 0, z: 6 * 1.6 / LEVEL_HEIGHT };
    const a = walk(w, side, 6, 0, 1.5);
    expect(a.hitWall).toBe(true);
    expect(side.x).toBeLessThan(-2);
    expect(side.y).toBe(0);
    // Under the high end (underside above the head), a character walks straight through.
    const under = { x: -6, y: 0, z: 5.6 };
    walk(w, under, 6, 0, 2);
    expect(under.x).toBeGreaterThan(4);
    expect(under.y).toBe(0);
  });

  it('walks under a level-0 deck at ground level and lands on top when dropped', () => {
    const w = new CollisionWorld();
    const [dx, dz] = rect(-4, 2, 4, 10);
    w.addSlab(dx, dz, LEVEL_HEIGHT, 0.25, 5);
    const pos = { x: 0, y: 0, z: 0 };
    const a = walk(w, pos, 0, 8, 2);
    expect(a.hitWall).toBe(false);
    expect(pos.z).toBeGreaterThan(12);
    expect(pos.y).toBe(0);

    const drop = { x: 0, y: 7, z: 6 };
    const b = walk(w, drop, 0, 0, 2);
    expect(drop.y).toBeCloseTo(LEVEL_HEIGHT, 6);
    expect(b.onGround).toBe(true);
    expect(b.vel.y).toBe(0);
  });

  it('bumps the head on a deck when jumping beneath it', () => {
    const w = new CollisionWorld();
    const [dx, dz] = rect(-4, -4, 4, 4);
    w.addSlab(dx, dz, 2.6, 0.25, 5);
    const pos = { x: 0, y: 0, z: 0 };
    const vel: V3 = { x: 0, y: AVATAR.jumpSpeed, z: 0 };
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      vel.y -= AVATAR.gravity * SIM_DT;
      w.moveCharacter(pos, vel, SIM_DT, R, H, STEP);
      peak = Math.max(peak, pos.y);
    }
    expect(peak + H).toBeLessThanOrEqual(2.6 - 0.25 + 1e-6);
    expect(pos.y).toBe(0);
  });

  it('lets a running jump land on a parked car (box tops are walkable)', () => {
    const w = new CollisionWorld();
    w.addBox(0, 3, 1, 1.2, 0, 0, 1.2, 9);
    const pos = { x: 0, y: 0, z: 0 };
    const vel: V3 = { x: 0, y: AVATAR.jumpSpeed, z: AVATAR.runSpeed };
    let landed = false;
    for (let i = 0; i < 90; i++) {
      vel.y -= AVATAR.gravity * SIM_DT;
      vel.z = pos.z < 3 ? AVATAR.runSpeed : 0;
      const r = w.moveCharacter(pos, vel, SIM_DT, R, H, STEP);
      if (r.onGround && pos.y > 1) landed = true;
    }
    expect(landed).toBe(true);
    expect(pos.y).toBeCloseTo(1.2, 6);
    // Walking (no jump) into the same car is blocked.
    const walker = { x: 0, y: 0, z: 0 };
    expect(walk(w, walker, 0, AVATAR.runSpeed, 1).hitWall).toBe(true);
    expect(walker.y).toBe(0);
  });

  it('raycasts walls, rotated boxes, cylinders, deck undersides and the ground', () => {
    const w = new CollisionWorld();
    const wall = w.addBox(0, 5, 3, 0.1, 0, 0, LEVEL_HEIGHT, 7);
    const wallHit = w.raycast(0, 1, 0, 0, 0, 2, 50);
    expect(wallHit?.shape).toBe(wall);
    expect(wallHit?.tag).toBe(7);
    expect(wallHit?.dist).toBeCloseTo(4.9, 9);
    expect([wallHit?.nx, wallHit?.ny, wallHit?.nz]).toEqual([0, 0, -1]);
    // Over the wall top: the ray continues to the ground.
    const ground = w.raycast(0, 2, 0, 0, -1, 1, 50);
    expect(ground?.shape).toBe(GROUND_SHAPE);
    expect(ground?.tag).toBe(GROUND_TAG);
    expect(ground?.dist).toBeCloseTo(2 * Math.SQRT2, 9);
    expect(ground?.ny).toBe(1);
    expect(w.raycast(0, 1, 0, 0, 0, 1, 4)).toBeNull();
    expect(w.raycast(0, 1, 0, 0, 0, 1, 50, 7)).toBeNull();

    // 45° box: hits its corner-facing side with a diagonal normal.
    w.addBox(20, 0, 1, 1, Math.PI / 4, 0, 2, 8);
    const diag = w.raycast(20 - 5, 1, -5, 1, 0, 1, 20);
    expect(diag?.tag).toBe(8);
    expect(diag?.dist).toBeCloseTo(5 * Math.SQRT2 - 1, 6);
    expect(diag?.nx).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(diag?.nz).toBeCloseTo(-Math.SQRT1_2, 6);

    w.addCylinder(-20, 0, 1, 0, 10, 10);
    const tree = w.raycast(-30, 5, 0, 1, 0, 0, 50);
    expect(tree?.tag).toBe(10);
    expect(tree?.dist).toBeCloseTo(9, 9);
    expect(tree?.nx).toBeCloseTo(-1, 9);

    const [dx, dz] = rect(36, -4, 44, 4);
    w.addSlab(dx, dz, LEVEL_HEIGHT, 0.25, 11);
    const up = w.raycast(40, 1, 0, 0, 1, 0, 10);
    expect(up?.tag).toBe(11);
    expect(up?.dist).toBeCloseTo(LEVEL_HEIGHT - 0.25 - 1, 9);
    expect(up?.ny).toBe(-1);
    const down = w.raycast(40, 9, 0, 0, -1, 0, 20);
    expect(down?.dist).toBeCloseTo(9 - LEVEL_HEIGHT, 9);
    expect(down?.ny).toBe(1);
  });

  it('detects placement overlaps with ignoreTag, touching and vertical spans', () => {
    const w = new CollisionWorld();
    w.addBox(0, 0, 2, 0.1, 0, 0, LEVEL_HEIGHT, 7);
    expect(w.blockedCircle(0, 0.3, 0.5, 0, 2)).toBe(true);
    expect(w.blockedCircle(0, 0.3, 0.5, 0, 2, 7)).toBe(false);
    expect(w.blockedCircle(0, 0.6, 0.5, 0, 2)).toBe(false);
    expect(w.blockedCircle(0, 0, 0.5, LEVEL_HEIGHT, 2 * LEVEL_HEIGHT)).toBe(false);
    const [dx, dz] = rect(-4, 2, 4, 10);
    w.addSlab(dx, dz, LEVEL_HEIGHT, 0.25, 5);
    expect(w.blockedCircle(0, 6, 1, 0, 2)).toBe(false);
    expect(w.blockedCircle(0, 6, 1, LEVEL_HEIGHT - .1, LEVEL_HEIGHT + .1)).toBe(true);
  });

  it('moves a character through shapes tagged ignoreTag while every other shape still blocks', () => {
    const w = new CollisionWorld();
    // Push-out: walk through the tagged wall, stop at the untagged one behind it.
    w.addBox(0, 5, 3, 0.1, 0, 0, LEVEL_HEIGHT, 7);
    w.addBox(0, 10, 3, 0.1, 0, 0, LEVEL_HEIGHT, 8);
    const walker = { x: 0, y: 0, z: 0 };
    expect(walk(w, walker, 0, 8, 2, 7).hitWall).toBe(true);
    expect(walker.z).toBeGreaterThan(5 + 0.1 + R);
    expect(walker.z).toBeLessThanOrEqual(10 - 0.1 - R + 1e-6);

    // Ceiling: the tagged lower deck lets the head through; the untagged one above stops it.
    const [dx, dz] = rect(26, -4, 34, 4);
    w.addSlab(dx, dz, 2.6, 0.25, 5);
    w.addSlab(dx, dz, 3.0, 0.25, 6);
    const jumper = { x: 30, y: 0, z: 0 };
    const vel: V3 = { x: 0, y: AVATAR.jumpSpeed, z: 0 };
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      vel.y -= AVATAR.gravity * SIM_DT;
      w.moveCharacter(jumper, vel, SIM_DT, R, H, STEP, 5);
      peak = Math.max(peak, jumper.y);
    }
    expect(peak + H).toBeGreaterThan(2.6 - 0.25);
    expect(peak + H).toBeLessThanOrEqual(3.0 - 0.25 + 1e-6);

    // Support: standing on a tagged box top drops you to the ground; an untagged one holds you.
    w.addBox(60, 0, 1, 1, 0, 0, 1.2, 9);
    w.addBox(70, 0, 1, 1, 0, 0, 1.2, 10);
    const onTagged = { x: 60, y: 1.2, z: 0 };
    const onOther = { x: 70, y: 1.2, z: 0 };
    expect(walk(w, onTagged, 0, 0, 0.5, 9).onGround).toBe(true);
    expect(onTagged.y).toBe(0);
    expect(walk(w, onOther, 0, 0, 0.5, 9).onGround).toBe(true);
    expect(onOther.y).toBeCloseTo(1.2, 6);
  });

  it('removes shapes and recycles their ids', () => {
    const w = new CollisionWorld();
    const id = w.addBox(0, 5, 3, 0.1, 0, 0, LEVEL_HEIGHT, 7);
    w.remove(id);
    w.remove(id);
    expect(w.tagOf(id)).toBe(GROUND_TAG);
    const pos = { x: 0, y: 0, z: 0 };
    walk(w, pos, 0, 8, 1.5);
    expect(pos.z).toBeGreaterThan(10);
    const again = w.addCylinder(0, 20, 1, 0, 2, 12);
    expect(again).toBe(id);
    expect(w.tagOf(again)).toBe(12);
  });

  it('registers every map obstacle under tag -1 - id', () => {
    const map = generateMap('alchemy');
    const w = CollisionWorld.fromMap(map);
    for (const kind of ['tree', 'tent', 'car', 'porta', 'art'] as const) {
      const o = map.obstacles.find((q) => q.kind === kind);
      expect(o, kind).toBeDefined();
      if (!o) continue;
      // Straight down onto the footprint centre: the first thing hit is this obstacle's top.
      const hit = w.raycast(o.x, 40, o.z, 0, -1, 0, 80);
      expect(hit?.tag, kind).toBe(-1 - o.id);
      expect(hit?.y).toBeCloseTo(o.height + w.groundHeight(o.x, o.z), 6);
    }
  });

  it('builds shades you can walk under and stages you can jump onto', () => {
    const shade: Obstacle = { id: 0, kind: 'shade', x: 0, z: 0, shape: 'box', radius: 5, hx: 4, hz: 3, yaw: 0.7, height: 3.2, seed: 1, color: 0, variant: 0 };
    const stage: Obstacle = { id: 1, kind: 'stage', x: 40, z: 0, shape: 'box', radius: 7, hx: 6, hz: 3.5, yaw: 0, height: 6, seed: 2, color: 0, variant: 0 };
    const w = CollisionWorld.fromMap(layoutOf([shade, stage]));
    // Across the shade along its local x axis: poles stand at the corners, the canopy overhead.
    const c = Math.cos(shade.yaw);
    const s = Math.sin(shade.yaw);
    const pos = { x: -c * 7, y: 0, z: s * 7 };
    const run = walk(w, pos, c * 6, -s * 6, 14 / 6);
    expect(run.hitWall).toBe(false);
    expect(pos.x * c - pos.z * s).toBeGreaterThan(6);
    expect(pos.y).toBeCloseTo(w.groundHeight(pos.x, pos.z), 6);
    expect(w.supportHeight(0, 0, 10)).toBeCloseTo(shade.height + 2, 6);
    // Straight at a corner pole: blocked.
    const px = 3.85 * c + 2.85 * s;
    const pz = -3.85 * s + 2.85 * c;
    const pole = { x: px - 5, y: 0, z: pz };
    expect(walk(w, pole, 6, 0, 1.5).hitWall).toBe(true);

    // Stage: walking into the deck front is blocked, a running jump lands on the deck.
    const front = { x: 40, y: 0, z: 8 };
    expect(walk(w, front, 0, -6, 1.5).hitWall).toBe(true);
    expect(front.y).toBeCloseTo(w.groundHeight(front.x, front.z), 6);
    const jumper = { x: 40, y: w.groundHeight(40, 5.2), z: 5.2 };
    const vel: V3 = { x: 0, y: AVATAR.jumpSpeed, z: -AVATAR.runSpeed };
    for (let i = 0; i < 60; i++) {
      vel.y -= AVATAR.gravity * SIM_DT;
      vel.z = jumper.z > 1 ? -AVATAR.runSpeed : 0;
      w.moveCharacter(jumper, vel, SIM_DT, R, H, STEP);
    }
    expect(jumper.y).toBeCloseTo(STAGE_DECK_HEIGHT + w.groundHeight(stage.x, stage.z), 6);
  });

  it('moves a character in ~200 nearby shapes within budget', () => {
    const w = new CollisionWorld();
    const rng = new Rng('crowded');
    for (let i = 0; i < 200; i++) {
      const x = rng.range(-10, 10);
      const z = rng.range(-10, 10);
      const level = rng.int(0, 3) * LEVEL_HEIGHT;
      const kind = i % 4;
      if (kind === 0) w.addBox(x, z, rng.range(0.1, 4), 0.1, rng.range(0, Math.PI), level, level + LEVEL_HEIGHT, i + 1);
      else if (kind === 1) w.addCylinder(x, z, rng.range(0.2, 1), level, level + LEVEL_HEIGHT, i + 1);
      else if (kind === 2) w.addSlab(...rect(x - 4, z - 4, x + 4, z + 4), level + LEVEL_HEIGHT, 0.25, i + 1);
      else w.addRamp(...rect(x - 4, z - 4, x + 4, z + 4), 0, 1, level, level + LEVEL_HEIGHT, 0.25, i + 1);
    }
    const pos = { x: 0, y: 0, z: 0 };
    const vel = { x: 0, y: 0, z: 0 };
    const n = 20_000;
    let sink = 0;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const a = (i % 360) * 0.0174533;
      vel.x = Math.cos(a) * 8;
      vel.z = Math.sin(a) * 8;
      vel.y -= AVATAR.gravity * SIM_DT;
      sink += w.moveCharacter(pos, vel, SIM_DT, R, H, STEP).groundY;
      if (Math.abs(pos.x) > 9 || Math.abs(pos.z) > 9) {
        pos.x = 0;
        pos.z = 0;
      }
    }
    const perCall = (performance.now() - t0) / n;
    expect(Number.isFinite(sink)).toBe(true);
    // Budget 0.05 ms; asserted loosely for noisy CI.
    expect(perCall).toBeLessThan(0.15);
  });
});

describe('domed gameplay ground', () => {
  it('uses the same two metre profile for support, walking and terrain rays', () => {
    const layout = layoutOf([]);
    const w = CollisionWorld.fromMap(layout);
    expect(w.supportHeight(0, 0, 100)).toBe(2);
    expect(w.supportHeight(layout.half, 0, 100)).toBe(0);
    const hit = w.raycast(0, 5, 0, 0, -1, 0, 10)!;
    expect(hit.shape).toBe(GROUND_SHAPE);
    expect(hit.y).toBeCloseTo(2, 7);
    expect(hit.ny).toBeCloseTo(1, 7);
    const slope = w.raycast(-layout.half, 1, 0, 1, 0, 0, layout.half)!;
    expect(slope.shape).toBe(GROUND_SHAPE);
    expect(slope.y).toBeCloseTo(w.groundHeight(slope.x, slope.z), 7);
    expect(slope.nx).toBeLessThan(0);
    const pos = { x: -layout.half + 2, y: w.groundHeight(-layout.half + 2, 0), z: 0 };
    const result = walk(w, pos, 8, 0, layout.half / 8);
    expect(result.onGround).toBe(true);
    expect(pos.y).toBeCloseTo(w.groundHeight(pos.x, pos.z), 6);
    const descending = walk(w, pos, 8, 0, layout.half / 8 - 1);
    expect(descending.onGround).toBe(true);
    expect(pos.y).toBeCloseTo(w.groundHeight(pos.x, pos.z), 6);
  });
});
