/** Big, short flame poofs for authoritative structure removal facts.
 * A fixed ring pool keeps mass destruction at one draw and bounded GPU storage.
 * Smoke is only a brief cooling tail; no lights, damage or persistent fire is spawned. */
import * as THREE from 'three';
import type { EventOf } from '../../sim/events';
import type { V3 } from '../../sim/math';
import type { SharedUniforms } from './glsl';
import { ParticlePool, ParticleSpec, Shape } from './particles';
import { Prng } from './prng';

export const SCENERY_PARTICLE_CAPACITY = 2048;
export const SCENERY_ERUPTION_MAX_LIFE = 1.65;
export const STRUCTURE_FLAME_MAX_LIFE = .95;
const SMOKE = new THREE.Color(0x493c32);
const ASH = new THREE.Color(0x302d2b);
const FIRE = new THREE.Color(0xffb32c);
const TAU = Math.PI * 2;

export class SceneryEruptions {
  readonly mesh: ParticlePool['mesh'];
  private readonly pool: ParticlePool;
  private readonly spec = new ParticleSpec();
  // Separate namespaces prevent a prop ID from suppressing a camp structure's burst.
  private readonly seen = new Set<string>();
  private lastTime = -Infinity;
  private endsAt = -Infinity;

  constructor(shared: SharedUniforms, renderOrder = 14, private readonly density = 1) {
    this.pool = new ParticlePool(SCENERY_PARTICLE_CAPACITY, false, shared, renderOrder);
    this.mesh = this.pool.mesh;
    this.mesh.name = 'structure-destruction-flame-poofs';
  }

  onEvent(event: EventOf<'sceneryDestroyed'>, now: number): void {
    this.burst(`scenery:${event.sceneryId}`, event.sceneryId, event.pos, event.size, event.yaw, now);
  }

  onStructure(id: number, pos: V3, size: V3, now: number): void {
    this.burst(`structure:${id}`, id, pos, size, 0, now);
  }

  private burst(key: string, id: number, pos: V3, size: V3, yaw: number, now: number): void {
    if (!Number.isInteger(id) ||
        ![now, pos.x, pos.y, pos.z, size.x, size.y, size.z, yaw].every(Number.isFinite) ||
        Math.min(size.x, size.y, size.z) <= 0) return;
    this.clock(now);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.pool.now = now;
    this.endsAt = Math.max(this.endsAt, now + SCENERY_ERUPTION_MAX_LIFE);
    const rng = new Prng(Math.imul(id + 1, 0x9e3779b1));
    // Big enough to engulf the footprint, but capped for huge scenery and mass hits.
    const shrink = Math.min(1, 14 / Math.max(size.x, size.z));
    const width = size.x * shrink, depth = size.z * shrink;
    const span = Math.sqrt(width * depth), height = Math.min(size.y, 12);
    const radius = Math.min(4.5, 1.25 + span * .2 + height * .07);
    const quality = Number.isFinite(this.density) ? Math.max(.25, Math.min(1, this.density)) : 1;
    const lobes = Math.ceil(Math.min(15, 8 + span * .45) * quality);
    const smoke = Math.ceil(6 * quality);
    const c = Math.cos(yaw), s = Math.sin(yaw), spec = this.spec;
    // Smoke is written first so the bright lobes composite over it in this one draw.
    for (let i = 0; i < smoke + lobes; i++) {
      const flame = i >= smoke, angle = rng.next() * TAU;
      const x = rng.signed() * width * .22, z = rng.signed() * depth * .22;
      spec.reset().at(pos.x + x * c + z * s,
        pos.y + radius * .35 + rng.next() * Math.min(height * .15, .7), pos.z - x * s + z * c);
      if (flame) {
        // Closely overlapping, outward/upward rolling lobes make one billowing fireball.
        const puff = radius * rng.range(.7, 1);
        spec.vel(Math.cos(angle) * radius * .65, rng.range(2.8, 5.4), Math.sin(angle) * radius * .65)
          .time(rng.range(.7, STRUCTURE_FLAME_MAX_LIFE))
          .size(puff * .16, puff).phys(-.3, 1.8)
          .from(FIRE, 1, .98).to(FIRE, 1, .5)
          .look(Shape.Fireball, rng.signed() * .65, angle).anim(0, 0, .025);
      } else {
        const puff = radius * rng.range(.5, .7);
        spec.vel(Math.cos(angle) * .5, rng.range(.8, 1.6), Math.sin(angle) * .5)
          .time(rng.range(1.05, SCENERY_ERUPTION_MAX_LIFE))
          .size(puff * .4, puff * 1.35).phys(-.15, 1.6)
          .from(SMOKE, 1, .38).to(ASH, 1, 0)
          .look(Shape.Smoke, rng.signed() * .4, angle).anim(0, 0, .18);
      }
      this.pool.emit(spec);
    }
  }

  private clock(now: number): void {
    if (now < this.lastTime) this.reset();
    this.lastTime = now;
  }

  update(now: number): void {
    if (!Number.isFinite(now)) return;
    this.clock(now);
    if (now >= this.endsAt) {
      if (this.endsAt !== -Infinity) this.pool.clear();
      this.endsAt = -Infinity;
    }
    this.pool.flush();
  }

  /** Match resets clear deduplication and stale particles, reusing GPU buffers. */
  reset(): void {
    this.pool.clear();
    this.seen.clear();
    this.lastTime = this.endsAt = -Infinity;
  }

  dispose(): void { this.reset(); this.pool.dispose(); }
}
