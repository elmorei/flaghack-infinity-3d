import { describe, expect, it } from 'vitest';
import { AVATAR, LEVEL_HEIGHT, SIM_DT } from '../../constants';
import { spawnPiece } from '../../factory';
import { CollisionWorld } from '../../physics/collision';
import { attachPiece, canBuildPiece, destroyPiece, isSupported } from '../pieces';
import { facetPolygon, rampHighEdge, rampPolygon } from './pieceGeometry';
import { newMatch } from './testkit';

const lattice = newMatch('rectangle-ramp-geometry').world.lattice;
const variants = [false, true].flatMap(thick => [0, 1, 2, 3].map(edge => ({ thick, edge })));
function inside(x: number, z: number, xs: number[], zs: number[]) {
  return xs.every((a, i) => {
    const j = (i + 1) % 4;
    return (xs[j] - a) * (z - zs[i]) - (zs[j] - zs[i]) * (x - a) >= -1e-7;
  });
}
function geometry(thick: boolean, edge: number) {
  const facet = lattice.facets.find(f => !f.boundary && f.thick === thick)!;
  const xs: number[] = [], zs: number[] = [], fx: number[] = [], fz: number[] = [];
  rampPolygon(lattice, facet.id, edge, xs, zs); facetPolygon(lattice, facet.id, fx, fz);
  return { facet, xs, zs, fx, fz };
}

describe('rectangular ramp strips', () => {
  it.each(variants)('is the maximal contained rectangle for thick=$thick edge=$edge', ({ thick, edge }) => {
    const { xs, zs, fx, fz } = geometry(thick, edge);
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4, k = (i + 2) % 4;
      expect((xs[j] - xs[i]) * (xs[k] - xs[j]) + (zs[j] - zs[i]) * (zs[k] - zs[j])).toBeCloseTo(0, 8);
      expect(inside(xs[i], zs[i], fx, fz)).toBe(true);
      area += xs[i] * zs[j] - xs[j] * zs[i];
    }
    expect(area).toBeGreaterThan(0);
    const ex = fx[(edge + 1) % 4] - fx[edge], ez = fz[(edge + 1) % 4] - fz[edge];
    const length = Math.hypot(ex, ez), ux = ex / length, uz = ez / length;
    const shift = (fx[(edge + 3) % 4] - fx[edge]) * ux + (fz[(edge + 3) % 4] - fz[edge]) * uz;
    expect(Math.hypot(xs[1] - xs[0], zs[1] - zs[0])).toBeCloseTo(length - Math.abs(shift), 8);
    for (const i of [0, 1]) expect(ex * (zs[i] - fz[edge]) - ez * (xs[i] - fx[edge])).toBeCloseTo(0, 8);
    const high = (edge + 2) % 4;
    for (const i of [2, 3]) expect(ex * (zs[i] - fz[high]) - ez * (xs[i] - fx[high])).toBeCloseTo(0, 8);
  });

  it.each(variants)('has no collision in removed corners and remains traversable for thick=$thick edge=$edge', ({ thick, edge }) => {
    const { facet, xs, zs, fx, fz } = geometry(thick, edge);
    const col = new CollisionWorld();
    col.addRamp(xs, zs, 0, 1, 0, LEVEL_HEIGHT, .25, 123);
    let testedOutside = 0;
    for (let i = 0; i < 4; i++) {
      const x = fx[i] * .85 + facet.cx * .15, z = fz[i] * .85 + facet.cz * .15;
      if (inside(x, z, xs, zs)) continue;
      testedOutside++;
      expect(col.raycast(x, LEVEL_HEIGHT + 2, z, 0, -1, 0, LEVEL_HEIGHT + 1)).toBeNull();
    }
    expect(testedOutside).toBeGreaterThan(0);
    expect(col.raycast(facet.cx, LEVEL_HEIGHT + 2, facet.cz, 0, -1, 0, LEVEL_HEIGHT + 1)?.tag).toBe(123);
    const lx = (xs[0] + xs[1]) / 2, lz = (zs[0] + zs[1]) / 2;
    const hx = (xs[2] + xs[3]) / 2, hz = (zs[2] + zs[3]) / 2;
    const run = Math.hypot(hx - lx, hz - lz), ux = (hx - lx) / run, uz = (hz - lz) / run;
    col.addSlab([xs[3], xs[2], xs[2] + ux * 3, xs[3] + ux * 3], [zs[3], zs[2], zs[2] + uz * 3, zs[3] + uz * 3], LEVEL_HEIGHT, .25, 124);
    const pos = { x: lx - ux, y: 0, z: lz - uz }, vel = { x: 0, y: 0, z: 0 };
    let grounded = false;
    for (let t = 0; t < 5 && (pos.x - lx) * ux + (pos.z - lz) * uz < run + .2; t += SIM_DT) {
      vel.x = ux * 6; vel.z = uz * 6; vel.y -= AVATAR.gravity * SIM_DT;
      grounded = col.moveCharacter(pos, vel, SIM_DT, AVATAR.radius, AVATAR.height, AVATAR.stepHeight).onGround;
    }
    expect((pos.x - lx) * ux + (pos.z - lz) * uz).toBeGreaterThan(run);
    expect(pos.y).toBeCloseTo(LEVEL_HEIGHT, 6); expect(grounded).toBe(true);
  });

  it('uses the strip for placement and registered collision while retaining high-edge support and cascade', () => {
    const { world } = newMatch('rectangle-ramp-placement');
    world.collision = new CollisionWorld(); world.map.obstacles = []; world.map.water = []; world.buildings.clear();
    world.factions[0].lumber = 1000;
    const facet = world.lattice.facets.find(f => !f.boundary && !f.thick)!;
    world.avatarOf(0).pos = { x: facet.cx, y: 0, z: facet.cz };
    const xs: number[] = [], zs: number[] = [], fx: number[] = [], fz: number[] = [];
    rampPolygon(world.lattice, facet.id, 0, xs, zs); facetPolygon(world.lattice, facet.id, fx, fz);
    const corner = fx.map((x, i) => ({ x: x * .85 + facet.cx * .15, z: fz[i] * .85 + facet.cz * .15 }))
      .find(p => !inside(p.x, p.z, xs, zs))!;
    const obstacle = { id: 99999, kind: 'tree' as const, shape: 'circle' as const, x: corner.x, z: corner.z, radius: .05, height: 10, hx: .05, hz: .05, yaw: 0, seed: 1, color: 0, variant: 0 };
    world.map.obstacles.push(obstacle);
    expect(canBuildPiece(world, 0, 'ramp', -1, facet.id, 0, 0).ok).toBe(true);
    obstacle.x = facet.cx; obstacle.z = facet.cz;
    expect(canBuildPiece(world, 0, 'ramp', -1, facet.id, 0, 0).ok).toBe(false);
    world.map.obstacles = [];
    const ramp = spawnPiece(world, 'ramp', 0, -1, facet.id, 0, 0); attachPiece(world, ramp);
    expect(world.collision.raycast(corner.x, LEVEL_HEIGHT + 2, corner.z, 0, -1, 0, LEVEL_HEIGHT + 1)).toBeNull();
    expect(world.collision.raycast(facet.cx, LEVEL_HEIGHT + 2, facet.cz, 0, -1, 0, LEVEL_HEIGHT + 1)?.tag).toBe(ramp.id);
    const edge = rampHighEdge(world.lattice, facet.id, 0);
    expect(isSupported(world, 'wall', edge, -1, 1, -1)).toBe(true);
    const wall = spawnPiece(world, 'wall', 0, edge, -1, 1, -1); attachPiece(world, wall);
    destroyPiece(world, ramp);
    expect(world.pieces.has(wall.id)).toBe(false);
    expect(isSupported(world, 'wall', edge, -1, 1, -1)).toBe(false);
  });
});
