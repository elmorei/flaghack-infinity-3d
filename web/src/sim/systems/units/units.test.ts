import { describe, expect, it } from 'vitest';
import { AVATAR, HIPPIE, LEVEL_HEIGHT, SIM_DT } from '../../constants';
import type { GameEvent } from '../../events';
import { spawnFlag, spawnHippie, spawnZone } from '../../factory';
import { planEnclosure } from '../../lattice/planner';
import type { V3 } from '../../math';
import { normalizeMatch } from '../../matchSettings';
import { createMatch } from '../../setup';
import { Simulation } from '../../simulation';
import type { Avatar, AvatarInput, FactionId, Hippie, JobKind } from '../../types';
import type { World } from '../../world';
import { stepAvatarMotion, throwOrigin, throwVelocity } from '../avatars';
import type { AvatarMotionState } from '../avatars';
import { damageEntity } from '../combat';
import { applyEffect } from '../effects';
import { canPlantAt, depositToStock, plantFlag } from '../flags';
import { canBuildPiece } from '../pieces';
import { updateSurvey } from '../survey';

interface Match {
  world: World;
  sim: Simulation;
  events: GameEvent[];
}

function match(seed = 'units-suite'): Match {
  const world = createMatch({ seed, difficulty: 'normal', humans: [], mode: 'standard' });
  // No phason tides mid-test: they would decohere Flags under the scenario.
  world.tide.nextAt = Infinity;
  return { world, sim: new Simulation(world), events: [] };
}

/** Step `seconds` of sim time, collecting events; stops early when `until` returns true. */
function run(m: Match, seconds: number, until?: () => boolean): boolean {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    m.sim.step();
    for (const e of m.world.drainEvents()) m.events.push(e);
    if (until && until()) return true;
  }
  return false;
}

function input(m: Match, f: FactionId, over: Partial<Avatar['input']>): void {
  m.world.submit({ t: 'avatarInput', faction: f, input: { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0, ...over } });
}

function onlyJob(m: Match, f: FactionId, job: JobKind): void {
  const weights: Record<JobKind, number> = { survey: 0, gather: 0, defend: 0, raid: 0, ritual: 0 };
  weights[job] = 4;
  m.world.submit({ t: 'jobWeights', faction: f, weights });
}

function placeAvatar(av: Avatar, x: number, z: number): void {
  av.pos.x = x;
  av.pos.y = 0;
  av.pos.z = z;
  av.vel.x = 0;
  av.vel.y = 0;
  av.vel.z = 0;
}

/** A plantable node with no collision shapes within `clear` metres (open grass). */
function openNode(world: World, clear: number, near: { x: number; z: number }): number {
  let best = -1;
  let bestD = Infinity;
  for (const n of world.lattice.nodes) {
    if (n.boundary || Math.abs(n.x) > 120 || Math.abs(n.z) > 120 || !canPlantAt(world, n.id, 0)) continue;
    const d = (n.x - near.x) ** 2 + (n.z - near.z) ** 2;
    if (d >= bestD || world.collision.blockedCircle(n.x, n.z, clear, 0.05, 4)) continue;
    best = n.id;
    bestD = d;
  }
  return best;
}

/** Simulate a throw exactly like projectiles.ts (no obstacles) and return the landing range. */
function throwRange(av: Avatar, yaw: number, pitch: number): number {
  const p: V3 = throwOrigin(av.pos, yaw, { x: 0, y: 0, z: 0 });
  const v: V3 = throwVelocity(yaw, pitch, { x: 0, y: 0, z: 0 });
  for (let i = 0; i < 600; i++) {
    v.y -= AVATAR.gravity * SIM_DT;
    const ny = p.y + v.y * SIM_DT;
    if (ny <= 0) {
      const t = p.y / (p.y - ny);
      return Math.hypot(p.x + v.x * SIM_DT * t - av.pos.x, p.z + v.z * SIM_DT * t - av.pos.z);
    }
    p.x += v.x * SIM_DT;
    p.y = ny;
    p.z += v.z * SIM_DT;
  }
  return Infinity;
}

function hippiesOf(world: World, f: FactionId): Hippie[] {
  return [...world.hippies.values()].filter((h) => h.faction === f);
}

/** Plant a fresh faction-1 Flag on each node (squatting rival Flags). */
function squat(world: World, nodes: readonly number[]): void {
  for (const node of nodes) {
    const n = world.lattice.nodes[node];
    const fl = spawnFlag(world, { state: 'carried', owner: 1, holder: -1, pos: { x: n.x, y: 0, z: n.z } });
    if (!plantFlag(world, fl.id, node, 1, -1)) throw new Error('squat failed');
  }
}

/** The `count` nodes nearest to (x, z) where both factions 0 and 1 could plant. */
function openNodesNear(world: World, x: number, z: number, count: number): number[] {
  return world.lattice.nodes
    .filter((n) => canPlantAt(world, n.id, 0) && canPlantAt(world, n.id, 1))
    .sort((a, b) => (a.x - x) ** 2 + (a.z - z) ** 2 - ((b.x - x) ** 2 + (b.z - z) ** 2))
    .slice(0, count)
    .map((n) => n.id);
}

/**
 * Plan nodes `dist` metres from our Hearth toward the burn: the `squatted` nearest are held by
 * fresh faction-1 Flags, the next `free` are open.
 */
function squattedPlan(world: World, free: number, squatted: number, dist: number): { free: number[]; squatted: number[] } {
  const hearth = world.hearthOf(0);
  if (!hearth) throw new Error('no hearth');
  const d = dist / Math.SQRT2;
  const nodes = openNodesNear(world, hearth.pos.x + d, hearth.pos.z - d, free + squatted);
  squat(world, nodes.slice(0, squatted));
  return { free: nodes.slice(squatted), squatted: nodes.slice(0, squatted) };
}

describe('vexillomancer avatar', () => {
  it('blocks sprint throws and lets throw mode end sprinting before a same-tick throw', () => {
    const m = match();
    const av = m.world.avatarOf(0);
    const n = m.world.lattice.nodes[openNode(m.world, 14, { x: 0, z: 60 })];
    placeAvatar(av, n.x, n.z);
    const carried = av.carried.length;
    input(m, 0, { sprint: true, moveZ: 1 });
    run(m, 0.3);
    expect(av.vel.z).toBeCloseTo(AVATAR.sprintSpeed);
    m.world.submit({ t: 'throw', faction: 0 });
    run(m, SIM_DT);
    expect(av.carried).toHaveLength(carried);
    expect(m.world.projectiles.size).toBe(0);

    input(m, 0, { sprint: true, throwMode: true, moveZ: 1 });
    m.world.submit({ t: 'throw', faction: 0 });
    run(m, SIM_DT);
    expect(av.input.sprint).toBe(false);
    expect(av.carried).toHaveLength(carried - 1);
    expect(m.world.projectiles.size).toBe(1);
    run(m, 0.3);
    expect(av.vel.z).toBeCloseTo(AVATAR.runSpeed);
  });

  it('picks up nearby loose Flags in throw mode, including with an empty quiver, up to capacity', () => {
    const m = match();
    const av = m.world.avatarOf(0);
    for (const id of [...av.carried]) depositToStock(m.world, id, m.world.hearthOf(0)!.id);
    m.world.hippies.clear();
    const node = openNode(m.world, 8, { x: 0, z: 60 });
    const n = m.world.lattice.nodes[node];
    placeAvatar(av, n.x, n.z);
    const planted = spawnFlag(m.world, { state: 'loose', owner: 0, pos: { ...av.pos } });
    expect(plantFlag(m.world, planted.id, node, 0, av.id)).toBe(true);
    const loose = Array.from({ length: AVATAR.quiver + 1 }, () =>
      spawnFlag(m.world, { state: 'loose', owner: 1, pos: { x: n.x + 1, y: 0, z: n.z } }),
    );
    const far = spawnFlag(m.world, { state: 'loose', owner: 1, pos: { x: n.x + AVATAR.pullReach + 1, y: 0, z: n.z } });
    run(m, SIM_DT);
    expect(av.carried).toHaveLength(0);
    input(m, 0, { throwMode: true });
    run(m, SIM_DT);
    expect(av.carried).toHaveLength(AVATAR.quiver);
    expect(loose.filter((f) => f.state === 'carried' && f.holder === av.id && f.owner === 0)).toHaveLength(AVATAR.quiver);
    expect(loose.at(-1)!.state).toBe('loose');
    expect(far.state).toBe('loose');
    expect(planted.state).toBe('planted');
  });

  it('scales jump apex while preserving the original launch at 1.0', () => {
    const m = match();
    const av = m.world.avatarOf(0);
    const n = m.world.lattice.nodes[openNode(m.world, 4, { x: 0, z: 60 })];
    const peaks: number[] = [];
    for (const jumpHeight of [1, 2]) {
      m.world.options.match = normalizeMatch({ jumpHeight });
      placeAvatar(av, n.x, n.z);
      av.onGround = true;
      const cmd: AvatarInput = { moveX: 0, moveZ: 0, sprint: false, jump: true, yaw: 0, pitch: 0 };
      stepAvatarMotion(m.world, av, cmd, SIM_DT);
      expect(av.vel.y).toBeCloseTo(AVATAR.jumpSpeed * Math.sqrt(jumpHeight) - AVATAR.gravity * SIM_DT);
      cmd.jump = false;
      let peak = av.pos.y;
      for (let i = 0; i < 120; i++) {
        stepAvatarMotion(m.world, av, cmd, SIM_DT);
        peak = Math.max(peak, av.pos.y);
      }
      expect(av.onGround).toBe(true);
      peaks.push(peak);
    }
    expect(peaks[1] / peaks[0]).toBeCloseTo(2, 1);
  });

  it('runs, jumps and lands back on the ground', () => {
    const m = match();
    const av = m.world.avatarOf(0);
    const hearth = m.world.hearthOf(0);
    if (!hearth) throw new Error('no hearth');
    // Run sideways (perpendicular to the Hearth→avatar line): open camp ground.
    const ox = av.pos.x - hearth.pos.x;
    const oz = av.pos.z - hearth.pos.z;
    const ol = Math.hypot(ox, oz);
    const x0 = av.pos.x;
    const z0 = av.pos.z;
    input(m, 0, { moveX: -oz / ol, moveZ: ox / ol, yaw: Math.atan2(-oz, ox) });
    run(m, 1);
    expect(Math.hypot(av.pos.x - x0, av.pos.z - z0)).toBeGreaterThan(6);
    expect(av.pos.y).toBe(0);

    input(m, 0, { jump: true });
    run(m, SIM_DT);
    input(m, 0, {});
    let peak = 0;
    let airborne = false;
    run(m, 1.2, () => {
      peak = Math.max(peak, av.pos.y);
      if (!av.onGround) airborne = true;
      return false;
    });
    expect(airborne).toBe(true);
    // v² / 2g = 7.5² / 48 ≈ 1.17 m
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.3);
    expect(av.pos.y).toBe(0);
    expect(av.onGround).toBe(true);
  });

  it('plants a carried Flag on a node within reach', () => {
    const m = match();
    const av = m.world.avatarOf(0);
    const node = openNode(m.world, 2, { x: 0, z: 60 });
    const n = m.world.lattice.nodes[node];
    placeAvatar(av, n.x + 1.5, n.z);
    const flagId = av.carried[av.carried.length - 1];
    m.world.submit({ t: 'plant', faction: 0, node });
    run(m, SIM_DT);
    const fl = m.world.flags.get(flagId);
    expect(fl?.state).toBe('planted');
    expect(fl?.node).toBe(node);
    expect(m.world.survey.nodeFlagOwner[node]).toBe(0);
    expect(av.carried).not.toContain(flagId);
    expect(av.action.kind).toBe('plant');
  });

  it('throws a Flag that lands and snaps onto the aimed node', () => {
    const m = match();
    const av = m.world.avatarOf(0);
    const node = openNode(m.world, 14, { x: 0, z: 60 });
    const n = m.world.lattice.nodes[node];
    placeAvatar(av, n.x + 12, n.z);
    const yaw = Math.atan2(n.x - av.pos.x, n.z - av.pos.z);
    // Low arc: range grows with pitch here, so bisect for 12 m.
    let lo = -0.4;
    let hi = 0.6;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (throwRange(av, yaw, mid) < 12) lo = mid;
      else hi = mid;
    }
    input(m, 0, { yaw, pitch: lo });
    run(m, SIM_DT);
    const flagId = av.carried[av.carried.length - 1];
    m.world.submit({ t: 'throw', faction: 0 });
    run(m, SIM_DT);
    expect(m.world.flags.get(flagId)?.state).toBe('flying');
    expect(m.events.some((e) => e.t === 'flagThrown' && e.flagId === flagId)).toBe(true);
    run(m, 2, () => m.world.flags.get(flagId)?.state !== 'flying');
    const fl = m.world.flags.get(flagId);
    expect(fl?.state).toBe('planted');
    expect(fl?.node).toBe(node);
    expect(m.events.some((e) => e.t === 'flagLanded' && e.flagId === flagId && e.node === node)).toBe(true);
    expect(m.world.projectiles.size).toBe(0);
  });

  it('pulls an enemy Flag into its quiver', () => {
    const m = match();
    const av = m.world.avatarOf(0);
    const enemy = [...m.world.flags.values()].find((fl) => fl.owner === 1 && fl.state === 'planted');
    if (!enemy) throw new Error('faction 1 has no planted Flag');
    const h1 = m.world.hearthOf(1);
    if (!h1) throw new Error('no hearth');
    // Stand just outside the enemy ring Flag, on the side away from their Hearth.
    const dx = enemy.pos.x - h1.pos.x;
    const dz = enemy.pos.z - h1.pos.z;
    const dl = Math.hypot(dx, dz);
    placeAvatar(av, enemy.pos.x + (dx / dl) * 1.5, enemy.pos.z + (dz / dl) * 1.5);
    const quiver = av.carried.length;
    m.world.submit({ t: 'pull', faction: 0, flagId: enemy.id });
    run(m, SIM_DT);
    expect(av.action.kind).toBe('pull');
    run(m, AVATAR.pullEnemyTime * 0.5);
    expect(enemy.state).toBe('planted');
    run(m, AVATAR.pullEnemyTime * 0.6);
    expect(enemy.state).toBe('carried');
    expect(enemy.holder).toBe(av.id);
    expect(enemy.owner).toBe(0);
    expect(av.carried).toContain(enemy.id);
    expect(av.carried.length).toBe(quiver + 1);
  });

  it('goes Flagless at 0 HP: drops the quiver loose, then respawns at its Hearth', () => {
    const m = match();
    const av = m.world.avatarOf(0);
    const hearth = m.world.hearthOf(0);
    if (!hearth) throw new Error('no hearth');
    placeAvatar(av, hearth.pos.x + 30, hearth.pos.z - 30);
    const carried = av.carried.slice();
    expect(carried.length).toBeGreaterThan(0);
    damageEntity(m.world, av.id, AVATAR.maxHp + 50, -1);
    expect(av.koUntil).toBeGreaterThan(m.world.time);
    expect(av.carried.length).toBe(0);
    for (const id of carried) {
      const fl = m.world.flags.get(id);
      expect(fl?.state).toBe('loose');
      expect(Math.hypot((fl?.pos.x ?? 0) - av.pos.x, (fl?.pos.z ?? 0) - av.pos.z)).toBeLessThanOrEqual(AVATAR.koScatter + 1e-6);
    }
    // Commands are ignored while Flagless.
    input(m, 0, { moveX: 1 });
    run(m, AVATAR.respawnTime - 0.5);
    expect(av.koUntil).toBeGreaterThan(0);
    run(m, 1);
    expect(av.koUntil).toBe(0);
    expect(av.hp).toBe(AVATAR.maxHp);
    expect(Math.hypot(av.pos.x - hearth.pos.x, av.pos.z - hearth.pos.z)).toBeLessThan(12);
    expect(m.events.some((e) => e.t === 'respawn' && e.id === av.id)).toBe(true);
  });

  it('stepAvatarMotion on a copy replays the sim avatar bit-for-bit (client prediction)', () => {
    const m = match('units-motion');
    const world = m.world;
    // Only the vexillomancer under test moves here (a passing hippie's shove lands after its step).
    world.hippies.clear();
    const lat = world.lattice;
    const av = world.avatarOf(0);
    // Open grass with a ramp up onto a deck: walk up, hop on the deck, sprint off its far edge.
    const spot = lat.nodes[openNode(world, 12, { x: 0, z: 60 })];
    placeAvatar(av, spot.x, spot.z);
    const site = lat.facets
      .filter((fc) => fc.thick && !fc.boundary)
      .sort((a, b) => (a.cx - spot.x) ** 2 + (a.cz - spot.z) ** 2 - ((b.cx - spot.x) ** 2 + (b.cz - spot.z) ** 2))
      .flatMap((fc) => [0, 1, 2, 3].map((e) => ({ fc, e, deck: fc.neighbors[(e + 2) % 4] })))
      .find(
        ({ fc, e, deck }) =>
          deck >= 0 && canBuildPiece(world, 0, 'ramp', -1, fc.id, 0, e).ok && canBuildPiece(world, 0, 'floor', -1, deck, 0, -1).ok,
      );
    if (!site) throw new Error('no ramp site');
    const { fc, e } = site;
    const node = (k: number) => lat.nodes[fc.nodes[k % 4]];
    const lowX = (node(e).x + node(e + 1).x) / 2;
    const lowZ = (node(e).z + node(e + 1).z) / 2;
    const highX = (node(e + 2).x + node(e + 3).x) / 2;
    const highZ = (node(e + 2).z + node(e + 3).z) / 2;
    const span = Math.hypot(highX - lowX, highZ - lowZ);
    const dx = (highX - lowX) / span;
    const dz = (highZ - lowZ) / span;
    placeAvatar(av, lowX - dx * 3, lowZ - dz * 3);
    world.submit({ t: 'build', faction: 0, kind: 'ramp', edge: -1, facet: fc.id, level: 0, rampEdge: e });
    run(m, SIM_DT);
    // A level-0 deck stands on stilts at LEVEL_HEIGHT, flush with the level-0 ramp's top.
    world.submit({ t: 'build', faction: 0, kind: 'floor', edge: -1, facet: site.deck, level: 0, rampEdge: -1 });
    run(m, SIM_DT);
    expect(world.pieces.size).toBe(2);
    const yaw0 = Math.atan2(dx, dz);
    input(m, 0, { yaw: yaw0 });
    run(m, 0.2);

    // What the client predictor holds: its own kinematics plus the host's word on the rest.
    const copy: AvatarMotionState = {
      pos: { ...av.pos },
      vel: { ...av.vel },
      yaw: av.yaw,
      pitch: av.pitch,
      onGround: av.onGround,
      koUntil: av.koUntil,
      action: av.action,
      effects: av.effects,
      pushing: av.pushing,
    };
    const motion = (a: AvatarMotionState) => [a.pos.x, a.pos.y, a.pos.z, a.vel.x, a.vel.y, a.vel.z, a.yaw, a.pitch, a.onGround];
    let peak = 0;
    let airborneHigh = false;
    let landedAfterDeck = false;
    const tick = (i: number, inp: AvatarInput): void => {
      world.submit({ t: 'avatarInput', faction: 0, input: inp });
      m.sim.step();
      world.drainEvents();
      copy.koUntil = av.koUntil;
      copy.action = av.action;
      copy.effects = av.effects;
      copy.pushing = av.pushing;
      stepAvatarMotion(world, copy, inp, SIM_DT);
      expect({ tick: i, motion: motion(copy) }).toEqual({ tick: i, motion: motion(av) });
      peak = Math.max(peak, av.pos.y);
      if (av.pos.y > 2.5 && !av.onGround) airborneHigh = true;
      if (peak > 3 && av.pos.y === 0 && av.onGround) landedAfterDeck = true;
    };

    for (let i = 0; i < 300; i++) {
      const t = i * SIM_DT;
      let yaw = yaw0;
      if (t >= 2.2 && t < 3.6) yaw = yaw0 + (t - 2.2) * 2;
      else if (t >= 3.6) yaw = yaw0 + 2.8 - Math.PI / 4;
      const moving = t >= 0.2 && t < 4.4;
      // Mid-run stun window (the host's effects reach the predictor through the snapshot).
      if (i === 180) applyEffect(world, av, 'stun', 0.4);
      tick(i, {
        moveX: moving ? Math.sin(yaw) : 0,
        moveZ: moving ? Math.cos(yaw) : 0,
        jump: i === 100 || i === 200 || i === 240,
        sprint: (t > 1.2 && t < 2.2) || (t > 3.6 && t < 4.2),
        yaw,
        pitch: -0.1 + 0.3 * Math.sin(t),
      });
    }
    expect(peak).toBeGreaterThan(LEVEL_HEIGHT);
    expect(airborneHigh).toBe(true);
    expect(landedAfterDeck).toBe(true);

    // Flagless in mid-air: no control and frozen aim, but the body falls to the ground.
    tick(300, { moveX: 1, moveZ: 0, jump: true, sprint: false, yaw: 0, pitch: 0 });
    for (let i = 301; i < 318; i++) tick(i, { moveX: 1, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 });
    expect(av.onGround).toBe(false);
    damageEntity(world, av.id, AVATAR.maxHp * 2, -1);
    // The KO is a host-side discontinuity: the predictor re-seeds from the snapshot.
    copy.pos = { ...av.pos };
    copy.vel = { ...av.vel };
    copy.onGround = av.onGround;
    const koAt = { x: av.pos.x, z: av.pos.z, yaw: av.yaw };
    for (let i = 318; i < 390; i++) tick(i, { moveX: 0, moveZ: 1, jump: true, sprint: true, yaw: 1 + i * 0.01, pitch: 0.4 });
    expect(av.onGround).toBe(true);
    expect(av.pos.x).toBe(koAt.x);
    expect(av.pos.z).toBe(koAt.z);
    expect(av.yaw).toBe(koAt.yaw);
  });
});

describe('hippies', () => {
  it('Survey hippies fill a 6-node plan from Hearth stock with no hand placement (AE2)', () => {
    const m = match();
    const world = m.world;
    onlyJob(m, 0, 'survey');
    const hearth = world.hearthOf(0);
    if (!hearth) throw new Error('no hearth');
    // Six free nodes just outside the home ring, toward the burn.
    const toward = { x: hearth.pos.x + 14, z: hearth.pos.z - 14 };
    const plan = world.lattice.nodes
      .filter((n) => canPlantAt(world, n.id, 0))
      .sort((a, b) => (a.x - toward.x) ** 2 + (a.z - toward.z) ** 2 - ((b.x - toward.x) ** 2 + (b.z - toward.z) ** 2))
      .slice(0, 6)
      .map((n) => n.id);
    expect(plan.length).toBe(6);
    world.submit({ t: 'plan', faction: 0, op: 'set', nodes: plan });
    const filled = (): boolean => plan.every((n) => world.survey.nodeFlagOwner[n] === 0);
    expect(run(m, 60, filled)).toBe(true);
    const ids = new Set(hippiesOf(world, 0).map((h) => h.id));
    const byHippies = m.events.filter((e) => e.t === 'flagPlanted' && plan.includes(e.node) && ids.has(e.by));
    expect(byHippies.length).toBe(6);
  });

  it('Raid hippies pull a critical Flag of a rival loop around their Hearth', () => {
    const m = match();
    const world = m.world;
    const hearth = world.hearthOf(0);
    if (!hearth?.hearth) throw new Error('no hearth');
    const lat = world.lattice;
    // Clear our home ring into the stock so the rival loop can close around the Hearth.
    for (const fl of world.flags.values()) if (fl.owner === 0 && fl.state === 'planted') depositToStock(world, fl.id, hearth.id);
    updateSurvey(world, 0);
    const loop = planEnclosure(lat, {
      x: hearth.pos.x,
      z: hearth.pos.z,
      minRadius: 14,
      cost: (n) => (lat.nodes[n].blocked || !canPlantAt(world, n, 1) ? Infinity : 1),
    });
    if (!loop) throw new Error('no loop');
    for (const node of loop) {
      const n = lat.nodes[node];
      const fl = spawnFlag(world, { state: 'carried', owner: 1, holder: -1, pos: { x: n.x, y: 0, z: n.z } });
      expect(plantFlag(world, fl.id, node, 1, -1)).toBe(true);
    }
    updateSurvey(world, 0);
    const facet = hearth.hearth.facet;
    expect(world.inSurvey(facet, 1)).toBe(true);
    onlyJob(m, 0, 'raid');
    const broken = run(m, 45, () => !world.inSurvey(facet, 1));
    expect(broken).toBe(true);
    const pulled = m.events.find((e) => e.t === 'flagPulled' && e.prevOwner === 1 && loop.includes(e.node));
    expect(pulled).toBeDefined();
    if (pulled?.t !== 'flagPulled') return;
    expect(world.hippies.get(pulled.by)?.faction).toBe(0);
    // ...and the stolen Flag is carried home into the Hearth stock.
    expect(run(m, 30, () => world.flags.get(pulled.flagId)?.state === 'stock')).toBe(true);
    expect(world.flags.get(pulled.flagId)?.holder).toBe(hearth.id);
    expect(world.factions[0].stats.flagsStolen).toBeGreaterThan(0);
  });

  it('a KO drops the carried Flag loose and the hippie respawns at its Hearth', () => {
    const m = match();
    const world = m.world;
    const hearth = world.hearthOf(0);
    if (!hearth) throw new Error('no hearth');
    const h = hippiesOf(world, 0)[0];
    h.pos.x = hearth.pos.x + 40;
    h.pos.z = hearth.pos.z - 40;
    // It picks up a loose Flag lying at its feet (ordered pull).
    const given = spawnFlag(world, { state: 'loose', owner: 0, pos: { x: h.pos.x + 0.5, y: 0, z: h.pos.z } });
    world.submit({ t: 'order', faction: 0, hippies: [h.id], order: { kind: 'pull', flagId: given.id } });
    expect(run(m, 3, () => h.carryingFlag === given.id)).toBe(true);
    const at = { x: h.pos.x, z: h.pos.z };
    damageEntity(world, h.id, HIPPIE.maxHp, -1);
    expect(h.status).toBe('ko');
    expect(h.carryingFlag).toBe(-1);
    expect(given.state).toBe('loose');
    expect(Math.hypot(given.pos.x - at.x, given.pos.z - at.z)).toBeLessThan(1e-6);
    run(m, HIPPIE.respawnTime - 0.5);
    expect(h.status).toBe('ko');
    run(m, 1);
    expect(h.status).not.toBe('ko');
    expect(h.hp).toBe(HIPPIE.maxHp);
    expect(Math.hypot(h.pos.x - hearth.pos.x, h.pos.z - hearth.pos.z)).toBeLessThan(12);
  });

  it('attention runs out → distracted at a sound camp → recovers to work', () => {
    const m = match();
    const world = m.world;
    onlyJob(m, 0, 'defend');
    run(m, 1);
    const h = hippiesOf(world, 0)[0];
    expect(h.job).toBe('defend');
    h.attention = 0.2;
    expect(run(m, 2, () => h.status === 'distracted')).toBe(true);
    expect(m.events.some((e) => e.t === 'distracted' && e.hippieId === h.id)).toBe(true);
    let recoveredWith = -1;
    const back = run(m, HIPPIE.distractedTime + 50, () => {
      if (h.status === 'distracted') return false;
      recoveredWith = h.attention;
      return true;
    });
    expect(back).toBe(true);
    expect(recoveredWith).toBeGreaterThanOrEqual(HIPPIE.distractedRecoverTo - 1);
    run(m, 2);
    expect(h.status).not.toBe('distracted');
    expect(h.job).toBe('defend');
  });

  it('an SOS from a hurt hippie brings a Defend hippie running', () => {
    const m = match();
    const world = m.world;
    onlyJob(m, 0, 'defend');
    const hearth = world.hearthOf(0);
    if (!hearth) throw new Error('no hearth');
    const [victim] = hippiesOf(world, 0);
    const spot = { x: hearth.pos.x + 28, z: hearth.pos.z - 24 };
    victim.pos.x = spot.x;
    victim.pos.z = spot.z;
    world.submit({ t: 'order', faction: 0, hippies: [victim.id], order: { kind: 'defend', at: spot } });
    run(m, 2);
    const raider = spawnHippie(world, 1, { x: 0, z: 0 });
    damageEntity(world, victim.id, 10, raider.id);
    const sos = [...world.pings.values()].find((p) => p.kind === 'sos' && p.from === victim.id);
    expect(sos).toBeDefined();
    let responder: Hippie | undefined;
    const came = run(m, 20, () => {
      responder = hippiesOf(world, 0).find(
        (h) => h !== victim && h.status === 'responding' && Math.hypot(h.pos.x - spot.x, h.pos.z - spot.z) < 5,
      );
      return responder !== undefined;
    });
    expect(came).toBe(true);
    expect(responder?.job).toBe('defend');
  });

  it('with no raiders, one Survey hand pulls rival Flags off the plan and replants them as ours', () => {
    const m = match();
    const world = m.world;
    onlyJob(m, 0, 'survey');
    const { free, squatted } = squattedPlan(world, 5, 2, 24);
    const plan = [...free, ...squatted];
    world.submit({ t: 'plan', faction: 0, op: 'set', nodes: plan });
    const squatters = squatted.map((n) => world.survey.nodeFlag[n]);
    let maxPullers = 0;
    let stalled = false;
    const done = run(m, 90, () => {
      let pullers = 0;
      for (const h of hippiesOf(world, 0)) {
        const t = h.statusTarget;
        if (!t) continue;
        squatted.forEach((node, i) => {
          const fl = world.flags.get(squatters[i]);
          const n = world.lattice.nodes[node];
          if (fl?.state !== 'planted' || fl.owner !== 1 || Math.hypot(n.x - t.x, n.z - t.z) > 0.05) return;
          if (h.status === 'pulling') pullers++;
          // Nobody walks a Flag to a node that is still squatted.
          if (h.status === 'carrying' || h.status === 'planting') stalled = true;
        });
      }
      maxPullers = Math.max(maxPullers, pullers);
      return plan.every((n) => world.survey.nodeFlagOwner[n] === 0);
    });
    expect(done).toBe(true);
    expect(stalled).toBe(false);
    expect(maxPullers).toBe(1);
    // Pull, then plant: each squatter now stands on its old node as one of ours.
    squatted.forEach((node, i) => expect(world.survey.nodeFlag[node]).toBe(squatters[i]));
  });

  it('a raider pulls rival Flags off our plan before closer threats, never Stabilize-protected ones', () => {
    const m = match();
    const world = m.world;
    const hearth = world.hearthOf(0);
    if (!hearth) throw new Error('no hearth');
    // A single raider, so the order it takes targets in is observable.
    for (const h of hippiesOf(world, 0).slice(1)) world.hippies.delete(h.id);
    onlyJob(m, 0, 'raid');
    // Two squatters on the plan beyond the Hearth's threat radius...
    const { squatted } = squattedPlan(world, 0, 2, 45);
    const [open, warded] = squatted;
    const openFlag = world.survey.nodeFlag[open];
    const wardedFlag = world.survey.nodeFlag[warded];
    // ...one of them under faction 1's L3 Stabilize Zone (unpullable)...
    const wn = world.lattice.nodes[warded];
    spawnZone(world, 'stabilize', 1, { x: wn.x, z: wn.z }, 2, 999, 3);
    // ...and a rival Flag much closer, inside threat range but off the plan.
    const [threat] = openNodesNear(world, hearth.pos.x + 14, hearth.pos.z + 14, 1);
    squat(world, [threat]);
    world.submit({ t: 'plan', faction: 0, op: 'set', nodes: squatted });
    expect(run(m, 40, () => world.survey.nodeFlagOwner[open] === 0)).toBe(true);
    const ourPulls = m.events.filter((e) => e.t === 'flagPulled' && world.hippies.get(e.by)?.faction === 0);
    expect(ourPulls.length).toBe(1);
    expect(ourPulls[0].t === 'flagPulled' && ourPulls[0].flagId).toBe(openFlag);
    // Pull, then plant: the squatter stands on its node again, as ours.
    expect(world.survey.nodeFlag[open]).toBe(openFlag);
    run(m, 15);
    expect(world.survey.nodeFlagOwner[warded]).toBe(1);
    expect(m.events.some((e) => e.t === 'flagPulled' && e.flagId === wardedFlag)).toBe(false);
  });

  it('a push order rolls the GCC to the ordered spot, then the hippie goes back to work', () => {
    const m = match();
    const world = m.world;
    const gcc = world.gccOf(0);
    if (!gcc) throw new Error('no gcc');
    const [pusher] = hippiesOf(world, 0);
    // Six metres straight on from the Hearth through the cart: open camp ground whichever way
    // setup parked it.
    const hearth = world.hearthOf(0);
    if (!hearth) throw new Error('no hearth');
    const away = Math.hypot(gcc.pos.x - hearth.pos.x, gcc.pos.z - hearth.pos.z);
    const to = { x: gcc.pos.x + ((gcc.pos.x - hearth.pos.x) / away) * 6, z: gcc.pos.z + ((gcc.pos.z - hearth.pos.z) / away) * 6 };
    world.submit({ t: 'order', faction: 0, hippies: [pusher.id], order: { kind: 'push', gccId: gcc.id, to } });
    let hauled = false;
    const done = run(m, 20, () => {
      if (pusher.status === 'hauling') hauled = true;
      return pusher.order === null;
    });
    expect(done).toBe(true);
    expect(hauled).toBe(true);
    expect(Math.hypot(gcc.pos.x - to.x, gcc.pos.z - to.z)).toBeLessThan(1.5);
    expect(gcc.gcc?.pushedBy).toBe(-1);
  });

  it('steps 150 hippies inside the tick budget', () => {
    const m = match('units-perf');
    const world = m.world;
    let n = world.hippies.size;
    for (let i = 0; n < 150; i++, n++) {
      const f = (i % 4) as FactionId;
      const hearth = world.hearthOf(f);
      if (!hearth) throw new Error('no hearth');
      const a = (i * 2.399) % (Math.PI * 2);
      spawnHippie(world, f, { x: hearth.pos.x + Math.sin(a) * 9, z: hearth.pos.z + Math.cos(a) * 9 });
    }
    expect(world.hippies.size).toBe(150);
    run(m, 2);
    let total = 0;
    const ticks = 600;
    for (let i = 0; i < ticks; i++) {
      m.sim.step();
      world.drainEvents();
      total += m.sim.timings.hippies;
    }
    const avg = total / ticks;
    expect(avg).toBeLessThan(3);
  });
});
