/**
 * Hippie locomotion: budgeted nav routing (a straight line when in line of sight, A* through a
 * per-tick request budget otherwise), waypoint following, separation steering through the
 * spatial hash, terrain/effect speed and walkability-constrained integration.
 */
import { AVATAR, HIPPIE, HIPPIE_AI, MAP_HALF } from '../../constants';
import { angleDiff, clamp, wrapAngle } from '../../math';
import type { PathOptions } from '../../nav/navgrid';
import type { Hippie } from '../../types';
import type { World } from '../../world';
import { hasEffect, speedMultiplier } from '../effects';
import { redTapeMovementMultiplier } from '../rituals';
import { brainOf } from './brain';
import type { Brain } from './brain';
import type { UnitsState } from './state';

/** Neighbours closer than this push each other apart. */
const SEPARATION = 1.0;
const SEPARATION_GAIN = 2.4;
/** Waypoints count as reached within this distance. */
const WAYPOINT_REACH = 0.9;
/** Get close to a partial endpoint before declaring a task unreachable. */
const BLOCKED_REACH = 0.25;
/** A routed goal must move this far (or this share of the trip) before a new route is planned. */
const REPLAN_MIN = 1.5;
const REPLAN_FRACTION = 0.2;
/** A blocked route is retried after this long (walls fall, gates open). */
const BLOCKED_RETRY = 5;
/** Slow down inside this distance of the final goal. */
const ARRIVE_SLOW = 1.2;
const STEER_RATE = 10;
const TURN_RATE = 10;
/** Seconds without progress before asking for a fresh route; fresh A* tries before giving up. */
const STUCK_TIME = 1.2;
const MAX_REPLANS = 2;
const MUD_CHECK_INTERVAL = 0.3;
const KNOCK_DRAG = 5;
/** Wobble ("TAKE A SHOT"): lateral sway amplitude (rad) and frequency (rad/s). */
const WOBBLE_SWAY = 0.9;
const WOBBLE_FREQ = 7;

const PATH_OPTS: PathOptions = { maxIter: HIPPIE_AI.pathMaxIter, partial: true };

/**
 * Head toward (x, z) this tick. Returns true once within `arrive` metres. Plans a straight
 * route when in line of sight, otherwise queues an A* request (see servicePathQueue).
 */
export function moveTo(world: World, sys: UnitsState, h: Hippie, b: Brain, x: number, z: number, arrive: number): boolean {
  const dx = x - h.pos.x;
  const dz = z - h.pos.z;
  const d2 = dx * dx + dz * dz;
  if (d2 <= arrive * arrive) {
    b.moving = false;
    return true;
  }
  b.moving = true;
  b.goalX = x;
  b.goalZ = z;
  b.goalRadius = arrive;
  const rx = x - b.routeX;
  const rz = z - b.routeZ;
  const replan = Math.max(REPLAN_MIN, REPLAN_FRACTION * Math.sqrt(d2));
  if (
    b.route === 'none' ||
    rx * rx + rz * rz > replan * replan ||
    // A small target move can still put it across a wall. Distance-only hysteresis must
    // not keep a now-obstructed direct route (or its final A* leg) alive indefinitely.
    ((b.route === 'direct' || (b.route === 'path' && b.path && b.pathIdx === b.path.length - 1 && (rx !== 0 || rz !== 0))) &&
      !world.nav.lineOfSight(h.pos.x, h.pos.z, x, z)) ||
    (b.route === 'blocked' && (world.time - b.routeAt > BLOCKED_RETRY || rx * rx + rz * rz > BLOCKED_REACH * BLOCKED_REACH))
  ) {
    b.routeX = x;
    b.routeZ = z;
    b.routeAt = world.time;
    b.replans = 0;
    b.stuckT = 0;
    b.path = null;
    b.pathIdx = 0;
    if (world.nav.lineOfSight(h.pos.x, h.pos.z, x, z)) b.route = 'direct';
    else requestPath(sys, h, b);
  }
  return false;
}

function requestPath(sys: UnitsState, h: Hippie, b: Brain): void {
  b.route = 'queued';
  if (b.queued) return;
  b.queued = true;
  sys.pathQueue.push(h.id);
}

/** A blocked route has led as close as it can: no path, or standing at its last waypoint. */
export function routeExhausted(h: Hippie, b: Brain): boolean {
  if (b.route !== 'blocked') return false;
  const path = b.path;
  if (!path || path.length === 0) return true;
  const end = path[path.length - 1];
  const dx = end.x - h.pos.x;
  const dz = end.z - h.pos.z;
  return b.pathIdx >= path.length - 1 && dx * dx + dz * dz <= BLOCKED_REACH * BLOCKED_REACH;
}

/** Run queued A* requests FIFO, at most HIPPIE_AI.pathBudget per tick. */
export function servicePathQueue(world: World, sys: UnitsState): void {
  const q = sys.pathQueue;
  let budget = HIPPIE_AI.pathBudget;
  while (budget > 0 && sys.pathHead < q.length) {
    const h = world.hippies.get(q[sys.pathHead++]);
    if (!h) continue;
    const b = brainOf(h);
    b.queued = false;
    if (b.route !== 'queued' || h.status === 'ko') continue;
    budget--;
    const path = world.nav.findPath(h.pos.x, h.pos.z, b.routeX, b.routeZ, PATH_OPTS);
    b.pathIdx = 0;
    b.routeAt = world.time;
    if (!path || path.length === 0) {
      b.path = null;
      b.route = 'blocked';
      continue;
    }
    b.path = path;
    let end = path[path.length - 1];
    // A snapped endpoint is a cell centre, not the closest usable interaction point.
    // Advance safely toward the goal within that cell before judging its reachability.
    // This matters for Flags near blockers and for a moving cart's pushing position.
    const gap = Math.hypot(b.routeX - end.x, b.routeZ - end.z);
    if (gap > 1e-4) {
      let lo = 0;
      let hi = Math.min(1, world.nav.cell * Math.SQRT2 / gap);
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if (world.nav.lineOfSight(end.x, end.z, end.x + (b.routeX - end.x) * mid, end.z + (b.routeZ - end.z) * mid)) lo = mid;
        else hi = mid;
      }
      const refined = { x: end.x + (b.routeX - end.x) * lo, z: end.z + (b.routeZ - end.z) * lo };
      const previous = path.length > 1 ? path[path.length - 2] : h.pos;
      // Refinement can swing the preceding leg across an obstacle corner. Keep the old
      // endpoint as a waypoint whenever only its short final leg is known to be safe.
      if (world.nav.lineOfSight(previous.x, previous.z, refined.x, refined.z)) path[path.length - 1] = refined;
      else path.push(refined);
      end = refined;
    }
    const gx = end.x - b.routeX;
    const gz = end.z - b.routeZ;
    // Snapped/partial endpoints are only usable when they reach the task's interaction
    // radius; a fixed gap otherwise labels nearby unreachable goals as complete routes.
    b.route = gx * gx + gz * gz > b.goalRadius * b.goalRadius ? 'blocked' : 'path';
  }
  if (sys.pathHead >= q.length) {
    q.length = 0;
    sys.pathHead = 0;
  } else if (sys.pathHead > 256) {
    q.splice(0, sys.pathHead);
    sys.pathHead = 0;
  }
}

/** Effect, terrain and load speed factor (mud is sampled a few times a second, not every tick). */
function speedFactor(world: World, h: Hippie, b: Brain): number {
  let m = speedMultiplier(world, h) * redTapeMovementMultiplier(world, h);
  if (h.carryingLumber > 0) m *= HIPPIE.carryLumberSpeed;
  if (world.time >= b.mudCheckAt) {
    b.inMud = world.map.groundAt(h.pos.x, h.pos.z) === 'mud';
    b.mudCheckAt = world.time + MUD_CHECK_INTERVAL;
  }
  if (b.inMud) m *= HIPPIE.mudSpeed;
  return m;
}

/** Steer, separate and integrate one tick of movement. */
export function locomote(world: World, sys: UnitsState, h: Hippie, b: Brain, dt: number): void {
  let dvx = 0;
  let dvz = 0;
  let speed = 0;
  if (b.moving) {
    let wx = b.goalX;
    let wz = b.goalZ;
    const path = b.path;
    if (path && (b.route === 'path' || b.route === 'blocked')) {
      while (b.pathIdx < path.length - 1) {
        const wp = path[b.pathIdx];
        const ex = wp.x - h.pos.x;
        const ez = wp.z - h.pos.z;
        if (ex * ex + ez * ez > WAYPOINT_REACH * WAYPOINT_REACH) break;
        const next = path[b.pathIdx + 1];
        if (!world.nav.lineOfSight(h.pos.x, h.pos.z, next.x, next.z)) break;
        b.pathIdx++;
      }
      // Never discard a safe endpoint to aim inside its blocker. A live moving target may
      // replace the last waypoint only when that last leg remains clear.
      if (b.pathIdx < path.length - 1 || b.route === 'blocked' || !world.nav.lineOfSight(h.pos.x, h.pos.z, wx, wz)) {
        wx = path[b.pathIdx].x;
        wz = path[b.pathIdx].z;
      }
    }
    const dx = wx - h.pos.x;
    const dz = wz - h.pos.z;
    const d = Math.hypot(dx, dz);
    speed = HIPPIE.speed * b.pace * speedFactor(world, h, b);
    const toGoal = Math.hypot(b.goalX - h.pos.x, b.goalZ - h.pos.z);
    if (toGoal < ARRIVE_SLOW) speed *= Math.max(0.35, toGoal / ARRIVE_SLOW);
    if (d > 1e-4) {
      dvx = (dx / d) * speed;
      dvz = (dz / d) * speed;
    }
    if (hasEffect(world, h, 'wobble')) {
      const a = Math.sin(world.time * WOBBLE_FREQ + h.id) * WOBBLE_SWAY;
      const c = Math.cos(a) * HIPPIE_AI.wobbleSpeed;
      const s = Math.sin(a) * HIPPIE_AI.wobbleSpeed;
      const rx = dvx * c - dvz * s;
      dvz = dvx * s + dvz * c;
      dvx = rx;
    }
  }

  // Separation from other hippies (and vexillomancers), softer while standing at work.
  let sx = 0;
  let sz = 0;
  const items = sys.hash.items;
  const n = sys.hash.query(h.pos.x, h.pos.z, SEPARATION, sys.near);
  for (let i = 0; i < n; i++) {
    const o = items[sys.near[i]];
    if (o === h || o.status === 'ko') continue;
    const ox = h.pos.x - o.pos.x;
    const oz = h.pos.z - o.pos.z;
    const d2 = ox * ox + oz * oz;
    if (d2 < 1e-8) {
      // Exactly stacked: split along an id-derived direction (deterministic).
      sx += Math.sin(h.id * 2.399);
      sz += Math.cos(h.id * 2.399);
      continue;
    }
    const d = Math.sqrt(d2);
    const push = (SEPARATION - d) / SEPARATION;
    sx += (ox / d) * push;
    sz += (oz / d) * push;
  }
  const avoid = SEPARATION + AVATAR.radius;
  for (const av of world.avatars.values()) {
    if (av.koUntil > 0 || av.pos.y - world.collision.groundHeight(av.pos.x, av.pos.z) > 1.5) continue;
    const ox = h.pos.x - av.pos.x;
    const oz = h.pos.z - av.pos.z;
    const d2 = ox * ox + oz * oz;
    if (d2 >= avoid * avoid || d2 < 1e-8) continue;
    const d = Math.sqrt(d2);
    sx += (ox / d) * ((avoid - d) / avoid);
    sz += (oz / d) * ((avoid - d) / avoid);
  }
  const gain = b.moving ? SEPARATION_GAIN : SEPARATION_GAIN * 0.5;
  dvx += sx * gain;
  dvz += sz * gain;

  const k = Math.min(1, dt * STEER_RATE);
  h.vel.x += (dvx - h.vel.x) * k;
  h.vel.z += (dvz - h.vel.z) * k;
  const px = h.pos.x;
  const pz = h.pos.z;
  stepWalkable(world, h, dt);

  if (b.moving && speed > 0.5) {
    const moved = Math.hypot(h.pos.x - px, h.pos.z - pz);
    if (moved < speed * dt * 0.25) b.stuckT += dt;
    else b.stuckT = Math.max(0, b.stuckT - dt * 0.5);
    if (b.stuckT > STUCK_TIME) {
      b.stuckT = 0;
      if (b.route === 'direct' || (b.route === 'path' && b.replans < MAX_REPLANS)) {
        b.replans++;
        requestPath(sys, h, b);
      } else if (b.route === 'path') {
        b.route = 'blocked';
        b.routeAt = world.time;
      }
    }
  }

  const v2 = h.vel.x * h.vel.x + h.vel.z * h.vel.z;
  if (v2 > 0.09) {
    const turn = TURN_RATE * dt;
    h.facing = wrapAngle(h.facing + clamp(angleDiff(h.facing, Math.atan2(h.vel.x, h.vel.z)), -turn, turn));
  }
}

/** Knocked-back hippies slide with their impulse, decaying. */
export function slide(world: World, h: Hippie, dt: number): void {
  stepWalkable(world, h, dt);
  const k = Math.max(0, 1 - KNOCK_DRAG * dt);
  h.vel.x *= k;
  h.vel.z *= k;
}

/** Integrate velocity, sliding along blocked nav cells (a hippie already inside one may leave). */
function stepWalkable(world: World, h: Hippie, dt: number): void {
  const nav = world.nav;
  const nx = h.pos.x + h.vel.x * dt;
  const nz = h.pos.z + h.vel.z * dt;
  if (nav.isWalkable(nx, nz) || !nav.isWalkable(h.pos.x, h.pos.z)) {
    h.pos.x = nx;
    h.pos.z = nz;
  } else if (nav.isWalkable(nx, h.pos.z)) {
    h.pos.x = nx;
    h.vel.z = 0;
  } else if (nav.isWalkable(h.pos.x, nz)) {
    h.pos.z = nz;
    h.vel.x = 0;
  } else {
    h.vel.x = 0;
    h.vel.z = 0;
  }
  const lim = MAP_HALF - 1;
  h.pos.x = clamp(h.pos.x, -lim, lim);
  h.pos.z = clamp(h.pos.z, -lim, lim);
}
