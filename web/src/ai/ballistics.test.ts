import { describe, expect, it } from 'vitest';
import { AVATAR, SIM_DT } from '../sim/constants';
import { createMatch } from '../sim/setup';
import { Simulation } from '../sim/simulation';
import { canPlantAt } from '../sim/systems/flags';
import type { FactionId } from '../sim/types';
import { throwOrigin, throwVelocity } from '../sim/systems/avatars';
import { MAX_THROW_RANGE, solveThrow, solveThrowAtPoint } from './ballistics';
import type { ThrowAim } from './ballistics';

describe('throw solver', () => {
  it.each([
    [{ x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: 8 }],
    [{ x: 3, y: 4, z: -7 }, { x: 13, y: 12, z: 1 }],
    [{ x: 0, y: 20, z: 0 }, { x: -15, y: 25, z: -8 }],
  ])('intercepts elevated targets with exact rising and falling projectile segments', (feet, target) => {
    const aims: ThrowAim[] = [];
    for (const high of [false, true]) {
      const aim: ThrowAim = { yaw: 0, pitch: 0, flight: 0 };
      expect(solveThrowAtPoint(feet, target, high, aim)).toBe(true);
      const p = throwOrigin(feet, aim.yaw, { x: 0, y: 0, z: 0 });
      const vel = throwVelocity(aim.yaw, aim.pitch, { x: 0, y: 0, z: 0 });
      for (let at = 0; at < aim.flight; at += SIM_DT) {
        vel.y -= AVATAR.gravity * SIM_DT;
        const dt = Math.min(SIM_DT, aim.flight - at);
        p.x += vel.x * dt; p.y += vel.y * dt; p.z += vel.z * dt;
      }
      expect(Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z)).toBeLessThan(.001);
      aims.push(aim);
    }
    expect(aims[1].pitch).toBeGreaterThan(aims[0].pitch);
    expect(aims[1].flight).toBeGreaterThan(aims[0].flight);
  });

  it('rejects unreachable elevated and distant combat targets', () => {
    const feet = { x: 0, y: 0, z: 0 }, aim: ThrowAim = { yaw: 0, pitch: 0, flight: 0 };
    for (const high of [false, true]) {
      expect(solveThrowAtPoint(feet, { x: 0, y: 25, z: 10 }, high, aim)).toBe(false);
      expect(solveThrowAtPoint(feet, { x: 0, y: 0, z: 100 }, high, aim)).toBe(false);
    }
  });

  it('reaches about v²/g on flat ground and refuses targets beyond it', () => {
    expect(MAX_THROW_RANGE).toBeGreaterThan(26);
    expect(MAX_THROW_RANGE).toBeLessThan(33);
    const aim: ThrowAim = { yaw: 0, pitch: 0, flight: 0 };
    expect(solveThrow({ x: 0, y: 0, z: 0 }, 0, 0, MAX_THROW_RANGE + 2, false, aim)).toBe(false);
    expect(solveThrow({ x: 0, y: 0, z: 0 }, 0, 0, MAX_THROW_RANGE - 3, false, aim)).toBe(true);
  });

  it('finds a flat and a lobbed arc to the same spot, both landing on it', () => {
    const feet = { x: 3, y: 0, z: -7 };
    const flat: ThrowAim = { yaw: 0, pitch: 0, flight: 0 };
    const lob: ThrowAim = { yaw: 0, pitch: 0, flight: 0 };
    expect(solveThrow(feet, 15, 0, 10, false, flat)).toBe(true);
    expect(solveThrow(feet, 15, 0, 10, true, lob)).toBe(true);
    expect(lob.pitch).toBeGreaterThan(flat.pitch);
    expect(lob.flight).toBeGreaterThan(flat.flight);
  });

  it('a solved throw lands on its target node in the running sim', () => {
    const world = createMatch({ seed: 'ballistics', difficulty: 'normal', humans: [1], mode: 'standard' });
    const sim = new Simulation(world);
    const f: FactionId = 0;
    const av = world.avatarOf(f);
    const lat = world.lattice;
    // Open ground: a node pair 12-24 m apart with nothing between them.
    let from = -1;
    let to = -1;
    for (const n of lat.nodes) {
      if (Math.hypot(n.x, n.z) > 60 || n.blocked) continue;
      for (const m of lat.nodesInRadius(n.x, n.z, 24)) {
        const t = lat.nodes[m];
        const d = Math.hypot(t.x - n.x, t.z - n.z);
        if (d < 12 || !canPlantAt(world, m, f) || !world.nav.lineOfSight(n.x, n.z, t.x, t.z)) continue;
        if (world.collision.raycast(n.x, world.collision.groundHeight(n.x, n.z) + 1, n.z, t.x - n.x, world.collision.groundHeight(t.x, t.z) - world.collision.groundHeight(n.x, n.z), t.z - n.z, d)) continue;
        from = n.id;
        to = m;
        break;
      }
      if (to >= 0) break;
    }
    expect(to).toBeGreaterThanOrEqual(0);
    av.pos.x = lat.nodes[from].x;
    av.pos.z = lat.nodes[from].z;
    av.pos.y = world.collision.groundHeight(av.pos.x, av.pos.z);
    av.vel.x = av.vel.z = av.vel.y = 0;
    const target = lat.nodes[to];
    const aim: ThrowAim = { yaw: 0, pitch: 0, flight: 0 };
    expect(solveThrow(av.pos, target.x, world.collision.groundHeight(target.x, target.z), target.z, false, aim)).toBe(true);
    const flagId = av.carried[av.carried.length - 1];
    world.submit({ t: 'avatarInput', faction: f, input: { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: aim.yaw, pitch: aim.pitch } });
    world.submit({ t: 'throw', faction: f });
    let landed: { x: number; z: number; node: number } | null = null;
    for (let i = 0; i < 60 * 4 && !landed; i++) {
      sim.step();
      for (const e of world.drainEvents()) if (e.t === 'flagLanded' && e.flagId === flagId) landed = { x: e.pos.x, z: e.pos.z, node: e.node };
    }
    expect(landed).not.toBeNull();
    if (!landed) return;
    expect(landed.node).toBe(to);
    expect(Math.hypot(landed.x - target.x, landed.z - target.z)).toBeLessThan(AVATAR.throwSnapRadius);
  });
});
