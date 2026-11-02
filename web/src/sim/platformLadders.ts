/** Live deck-edge ladders shared by presentation, authority and client prediction. */
import { AVATAR, LEVEL_HEIGHT } from './constants';
import type { AvatarInput, Piece } from './types';
import type { World } from './world';
import type { AvatarMotionState } from './systems/avatars';
import { bossPlayerHull } from './systems/boss/playerCollision';

export const PLATFORM_LADDER_WIDTH = 0.8;
export const PLATFORM_LADDER_CLIMB_SPEED = 4.2;
/** Rail stands just outside the plank; a climber's body stays clear of its solid edge. */
export const PLATFORM_LADDER_RAIL_OFFSET = 0.08;
export const PLATFORM_LADDER_STANDOFF = AVATAR.radius + 0.18;

export interface PlatformLadder {
  pieceId: number;
  facet: number;
  level: number;
  /** Lattice edge and facet-side indices. */
  edge: number;
  side: number;
  /** Edge midpoint, not the outward-offset rail position. */
  x: number;
  z: number;
  /** Unit normal pointing away from the platform. */
  nx: number;
  nz: number;
  bottomY: number;
  topY: number;
}
interface Cache { signature: string; ladders: PlatformLadder[] }
const caches = new WeakMap<World, Cache>();

/** Ladders appear on every exposed side; joining/removing a deck changes them immediately. */
export function platformLadders(world: World): readonly PlatformLadder[] {
  const floors: Piece[] = [];
  const held = world.boss?.held?.kind === 'piece' ? world.boss.held.id : -1;
  let signature = `${world.lattice.version}:${held}|`;
  for (const p of world.pieces.values()) if (p.kind === 'floor' && p.id !== held) {
    floors.push(p); signature += `${p.id}:${p.facet}:${p.level};`;
  }
  const cached = caches.get(world);
  if (cached?.signature === signature) return cached.ladders;
  const occupied = new Set(floors.map(p => `${p.facet}:${p.level}`));
  const ladders: PlatformLadder[] = [];
  for (const p of floors) {
    const fc = world.lattice.facets[p.facet];
    if (!fc) continue;
    const topY = world.collision.groundHeight(fc.cx, fc.cz) + (p.level + 1) * LEVEL_HEIGHT;
    for (let side = 0; side < fc.edges.length; side++) {
      const edge = world.lattice.edges[fc.edges[side]];
      if (edge.facets.some(f => f !== p.facet && occupied.has(`${f}:${p.level}`))) continue;
      const a = world.lattice.nodes[edge.a], b = world.lattice.nodes[edge.b];
      const x = (a.x + b.x) / 2, z = (a.z + b.z) / 2;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-6) continue;
      let nx = (b.z - a.z) / length, nz = -(b.x - a.x) / length;
      if ((x - fc.cx) * nx + (z - fc.cz) * nz < 0) { nx = -nx; nz = -nz; }
      const bottomY = world.collision.groundHeight(x + nx * PLATFORM_LADDER_STANDOFF, z + nz * PLATFORM_LADDER_STANDOFF);
      ladders.push({ pieceId: p.id, facet: p.facet, level: p.level, edge: edge.id, side, x, z, nx, nz, bottomY, topY });
    }
  }
  caches.set(world, { signature, ladders });
  return ladders;
}

/** No private latch: position + input determine climbing identically on host and predictor. */
export function stepPlatformLadder(world: World, av: AvatarMotionState, input: AvatarInput, dt: number): boolean {
  if (dt <= 0) return false;
  let chosen: PlatformLadder | undefined;
  let best = Infinity;
  for (const ladder of platformLadders(world)) {
    const dx = av.pos.x - ladder.x, dz = av.pos.z - ladder.z;
    const along = dx * -ladder.nz + dz * ladder.nx;
    const outward = dx * ladder.nx + dz * ladder.nz;
    if (Math.abs(along) > PLATFORM_LADDER_WIDTH * .5 + .12 || outward < -AVATAR.radius - .18 || outward > PLATFORM_LADDER_STANDOFF + .28) continue;
    if (av.pos.y < ladder.bottomY - .12 || av.pos.y > ladder.topY + .12) continue;
    // Normal movement boards the nearest deck. Looking up while climbing explicitly
    // continues along overlapping stacked ladders, without forcing the topmost landing.
    const continueUp = input.pitch > .35 && input.moveX * ladder.nx + input.moveZ * ladder.nz < -.05;
    const score = (continueUp ? -ladder.topY : Math.max(0, ladder.topY - av.pos.y)) + Math.abs(along) * .1;
    if (score < best) { best = score; chosen = ladder; }
  }
  if (!chosen) return false;
  const l = chosen;
  const dx = av.pos.x - l.x, dz = av.pos.z - l.z;
  const outward = dx * l.nx + dz * l.nz;
  const along = dx * -l.nz + dz * l.nx;
  const drive = input.moveX * l.nx + input.moveZ * l.nz;
  const strafe = input.moveX * -l.nz + input.moveZ * l.nx;
  const atTop = av.pos.y >= l.topY - 1e-6;
  const atBottom = av.pos.y <= l.bottomY + .02;
  // Ordinary walking on the deck/ground and deliberate sideways dismount stay ordinary motion.
  if ((atBottom && drive >= -.05) || Math.abs(strafe) > .65 || (atTop && outward < -.08 && drive <= .05)) return false;
  if (!atTop && !atBottom && outward < AVATAR.radius) return false; // Never attach through the slab.
  if (input.jump) {
    av.vel.x = l.nx * 5; av.vel.z = l.nz * 5;
    av.vel.y = AVATAR.jumpSpeed * .7; av.onGround = false;
    move(world, av, dt);
    return true;
  }

  const nearTrack = Math.abs(outward - PLATFORM_LADDER_STANDOFF) < .025;
  let vertical = 0;
  let normal = 0;
  if (atTop) {
    if (drive < -.05) normal = -AVATAR.runSpeed * Math.min(1, -drive); // Walk onto the top, not through it.
    else if (drive > .05) {
      if (!nearTrack) normal = Math.min(AVATAR.runSpeed, (PLATFORM_LADDER_STANDOFF - outward) / dt);
      else vertical = -PLATFORM_LADDER_CLIMB_SPEED * Math.min(1, drive);
    }
  } else if (!nearTrack) {
    normal = Math.max(-AVATAR.runSpeed, Math.min(AVATAR.runSpeed, (PLATFORM_LADDER_STANDOFF - outward) / dt));
  } else vertical = -PLATFORM_LADDER_CLIMB_SPEED * Math.max(-1, Math.min(1, drive));
  const tangent = Math.max(-AVATAR.runSpeed, Math.min(AVATAR.runSpeed, -along / dt));
  av.vel.x = l.nx * normal - l.nz * tangent;
  av.vel.z = l.nz * normal + l.nx * tangent;
  av.vel.y = vertical > 0 ? Math.min(vertical, (l.topY - av.pos.y) / dt) : Math.max(vertical, (l.bottomY - av.pos.y) / dt);
  move(world, av, dt);
  // A ladder supports a stationary climber but does not turn the body into a ground jumper.
  if (av.pos.y > l.bottomY + .02 && av.pos.y < l.topY - .02) av.onGround = false;
  return true;
}
function move(world: World, av: AvatarMotionState, dt: number): void {
  const result = world.collision.moveCharacter(av.pos, av.vel, dt, AVATAR.radius, AVATAR.height, 0,
    undefined, bossPlayerHull(world.boss, world.time, world.map.half));
  av.onGround = result.onGround;
}
