import { describe, expect, it } from 'vitest';
import { LEVEL_HEIGHT, PIECE } from '../../constants';
import type { PieceKind } from '../../types';
import type { World } from '../../world';
import { applyFlip } from '../tides';
import { canBuildPiece, damagePiece, pieceAt } from '../pieces';
import { rampPolygon, wallSegment } from './pieceGeometry';
import { eventsOf, newMatch, placeAvatar, run } from './testkit';

/** Nearest edge/facet to the vexillomancer where a level-0 piece of `kind` may go right now. */
function buildableSlot(world: World, kind: PieceKind, accept: (id: number) => boolean = () => true): number {
  const lat = world.lattice;
  const av = world.avatarOf(0);
  const ids = kind === 'wall' ? lat.edges.map((e) => e.id) : lat.facets.map((f) => f.id);
  const centre = (id: number): [number, number] => {
    if (kind !== 'wall') return [lat.facets[id].cx, lat.facets[id].cz];
    const e = lat.edges[id];
    return [(lat.nodes[e.a].x + lat.nodes[e.b].x) / 2, (lat.nodes[e.a].z + lat.nodes[e.b].z) / 2];
  };
  const d = (id: number): number => Math.hypot(centre(id)[0] - av.pos.x, centre(id)[1] - av.pos.z);
  const pick = ids
    .filter((id) => d(id) < 14)
    .sort((a, b) => d(a) - d(b))
    .find((id) => accept(id) && canBuildPiece(world, 0, kind, kind === 'wall' ? id : -1, kind === 'wall' ? -1 : id, 0, 0).ok);
  if (pick === undefined) throw new Error(`no buildable ${kind} slot`);
  return pick;
}

/** Stand the vexillomancer in open ground between its camp and the centre. */
function openGround(world: World): void {
  const hearth = world.hearthOf(0)!;
  const len = Math.hypot(hearth.pos.x, hearth.pos.z);
  placeAvatar(world, 0, hearth.pos.x - (hearth.pos.x / len) * 24, hearth.pos.z - (hearth.pos.z / len) * 24);
  world.factions[0].lumber = 500;
}

describe('pieces', () => {
  it('a wall costs lumber and stands on its Ley edge: a ray across the edge hits it', () => {
    const h = newMatch();
    const { world } = h;
    openGround(world);
    const edge = buildableSlot(world, 'wall');
    world.submit({ t: 'build', faction: 0, kind: 'wall', edge, facet: -1, level: 0, rampEdge: 0 });
    run(h, 1 / 60);
    const wall = pieceAt(world, 'wall', edge, -1, 0)!;
    expect(wall).toBeDefined();
    expect(world.factions[0].lumber).toBe(500 - PIECE.cost);
    expect(eventsOf(h, 'pieceBuilt').map((e) => e.pieceId)).toEqual([wall.id]);
    expect(canBuildPiece(world, 0, 'wall', edge, -1, 0, 0).reason).toBe('Something is already built here.');

    const seg = wallSegment(world.lattice, edge, [0, 0, 0, 0]);
    const mx = (seg[0] + seg[2]) / 2;
    const mz = (seg[1] + seg[3]) / 2;
    const len = Math.hypot(seg[2] - seg[0], seg[3] - seg[1]);
    const nx = -(seg[3] - seg[1]) / len;
    const nz = (seg[2] - seg[0]) / len;
    const hit = world.collision.raycast(mx + nx * 2, 1.5, mz + nz * 2, -nx, 0, -nz, 4);
    expect(hit).not.toBeNull();
    expect(hit!.tag).toBe(wall.id);
    expect(hit!.dist).toBeCloseTo(2 - PIECE.wallThickness / 2, 1);
  });

  it('a deck is walkable at its level top', () => {
    const h = newMatch();
    const { world } = h;
    openGround(world);
    const facet = buildableSlot(world, 'floor');
    world.submit({ t: 'build', faction: 0, kind: 'floor', edge: -1, facet, level: 0, rampEdge: 0 });
    run(h, 1 / 60);
    expect(pieceAt(world, 'floor', -1, facet, 0)).toBeDefined();
    const fc = world.lattice.facets[facet];
    expect(world.collision.supportHeight(fc.cx, fc.cz, 10) - world.collision.groundHeight(fc.cx, fc.cz)).toBeCloseTo(LEVEL_HEIGHT, 2);
    // Floors and ramps share the facet slot.
    expect(canBuildPiece(world, 0, 'ramp', -1, facet, 0, 0).ok).toBe(false);
  });

  it('a ramp rises from its low edge to one level up', () => {
    const h = newMatch();
    const { world } = h;
    const lat = world.lattice;
    openGround(world);
    const facet = buildableSlot(world, 'ramp');
    world.submit({ t: 'build', faction: 0, kind: 'ramp', edge: -1, facet, level: 0, rampEdge: 1 });
    run(h, 1 / 60);
    expect(pieceAt(world, 'ramp', -1, facet, 0)?.rampEdge).toBe(1);
    const fc = lat.facets[facet];
    const xs: number[] = [], zs: number[] = [];
    rampPolygon(lat, facet, 1, xs, zs);
    const at = (i: number, j: number): number => {
      // Just inside the rectangular strip at its low/high landing midpoint.
      const mx = (xs[i] + xs[j]) / 2;
      const mz = (zs[i] + zs[j]) / 2;
      return world.collision.supportHeight(mx + (fc.cx - mx) * 0.1, mz + (fc.cz - mz) * 0.1, 10);
    };
    const low = at(0, 1) - world.collision.groundHeight(fc.cx, fc.cz);
    const high = at(2, 3) - world.collision.groundHeight(fc.cx, fc.cz);
    expect(low).toBeLessThan(0.6);
    expect(high).toBeGreaterThan(LEVEL_HEIGHT - 0.6);
    expect(world.collision.supportHeight(fc.cx, fc.cz, 10) - world.collision.groundHeight(fc.cx, fc.cz)).toBeCloseTo(LEVEL_HEIGHT / 2, 1);
  });

  it('a level-1 deck needs support; destroying the support brings it down', () => {
    const h = newMatch();
    const { world } = h;
    openGround(world);
    const facet = buildableSlot(world, 'floor');
    expect(canBuildPiece(world, 0, 'floor', -1, facet, 1, 0)).toEqual({
      ok: false,
      reason: 'Needs support: a wall, deck or ramp one level below.',
    });

    world.submit({ t: 'build', faction: 0, kind: 'floor', edge: -1, facet, level: 0, rampEdge: 0 });
    run(h, 1 / 60);
    expect(canBuildPiece(world, 0, 'floor', -1, facet, 1, 0).ok).toBe(true);
    world.submit({ t: 'build', faction: 0, kind: 'floor', edge: -1, facet, level: 1, rampEdge: 0 });
    run(h, 1 / 60);
    const lower = pieceAt(world, 'floor', -1, facet, 0)!;
    const upper = pieceAt(world, 'floor', -1, facet, 1)!;
    expect(upper).toBeDefined();
    const fc = world.lattice.facets[facet];
    expect(world.collision.supportHeight(fc.cx, fc.cz, 20) - world.collision.groundHeight(fc.cx, fc.cz)).toBeCloseTo(2 * LEVEL_HEIGHT, 2);

    expect(damagePiece(world, lower, PIECE.hp, -1)).toBe(true);
    run(h, 1 / 60);
    expect(world.pieces.has(lower.id)).toBe(false);
    expect(world.pieces.has(upper.id)).toBe(false);
    expect(eventsOf(h, 'pieceDestroyed').map((e) => e.pieceId)).toEqual([lower.id, upper.id]);
    expect(world.collision.supportHeight(fc.cx, fc.cz, 20) - world.collision.groundHeight(fc.cx, fc.cz)).toBe(0);
  });

  it('a wall on a level-0 deck edge stands at level 1; demolishing refunds and cascades', () => {
    const h = newMatch();
    const { world } = h;
    openGround(world);
    const facet = buildableSlot(world, 'floor');
    const edge = world.lattice.facets[facet].edges[0];
    expect(canBuildPiece(world, 0, 'wall', edge, -1, 1, 0).ok).toBe(false);
    world.submit({ t: 'build', faction: 0, kind: 'floor', edge: -1, facet, level: 0, rampEdge: 0 });
    world.submit({ t: 'build', faction: 0, kind: 'wall', edge, facet: -1, level: 1, rampEdge: 0 });
    run(h, 1 / 60);
    const deck = pieceAt(world, 'floor', -1, facet, 0)!;
    const wall = pieceAt(world, 'wall', edge, -1, 1)!;
    expect(wall).toBeDefined();
    const lumber = world.factions[0].lumber;
    world.submit({ t: 'demolish', faction: 0, pieceId: deck.id });
    run(h, 1 / 60);
    expect(world.factions[0].lumber).toBe(lumber + PIECE.refund);
    expect(world.pieces.has(wall.id)).toBe(false);
  });

  it('the Crystal turning under a wall brings it down', () => {
    const h = newMatch();
    const { world } = h;
    const lat = world.lattice;
    openGround(world);
    const edge = buildableSlot(world, 'wall', (e) => lat.flippable(lat.edges[e].a) || lat.flippable(lat.edges[e].b));
    world.submit({ t: 'build', faction: 0, kind: 'wall', edge, facet: -1, level: 0, rampEdge: 0 });
    run(h, 1 / 60);
    const wall = pieceAt(world, 'wall', edge, -1, 0)!;
    const e = lat.edges[edge];
    const node = lat.flippable(e.a) ? e.a : e.b;
    expect(applyFlip(world, node, 'ability')).toBe(true);
    run(h, 1 / 60);
    expect(world.pieces.has(wall.id)).toBe(false);
    expect(eventsOf(h, 'pieceDestroyed').map((ev) => ev.pieceId)).toEqual([wall.id]);
  });
});
