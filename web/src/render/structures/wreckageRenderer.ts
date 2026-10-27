/** Durable, deterministic visual wrecks. No collision or gameplay geometry is added. */
import * as THREE from 'three';
import type { RenderContext, RenderModule } from '../context';
import { groundHeight } from '../../sim/terrain';
import type { Wreckage } from '../../sim/wreckage';
import { Prng, hashString } from '../vfx/prng';

export type DebrisStyle = 'cloth' | 'metal' | 'wood' | 'stone' | 'mixed';
export function wreckageStyle(kind: string): DebrisStyle {
  if (['tent', 'shade', 'drumcircle'].includes(kind)) return 'cloth';
  if (['dome', 'car', 'porta', 'art', 'ward', 'druglab'].includes(kind)) return 'metal';
  if (['tree', 'wall', 'floor', 'ramp', 'workshop', 'stage'].includes(kind)) return 'wood';
  if (kind === 'rock') return 'stone';
  return 'mixed';
}
interface Fragment { shape: number; pos: THREE.Vector3; scale: THREE.Vector3; rotation: THREE.Euler; color: number; }
const COLORS = { cloth: [0x796450, 0x554d49, 0x98856d], metal: [0x858f95, 0xb0b3ac, 0x626b70],
  wood: [0x49382a, 0x77604a, 0x302b27], stone: [0x77756e, 0x99968c, 0x4b4b47], mixed: [0x79766e, 0x504e49, 0x929087] };

/** Original footprint and height drive extent and pile depth; constant fragment budget. */
export function wreckageFragments(record: Wreckage, seed: string): Fragment[] {
  const rng = new Prng(hashString(`${seed}:${record.id}`)), style = wreckageStyle(record.kind);
  const width = Math.max(.2, record.size.x, record.kind === 'wall' ? record.size.y * .5 : 0), depth = Math.max(.2, record.size.z);
  const height = Math.min(record.size.y * .32, Math.min(width, depth) * .45);
  const colors = COLORS[style], count = style === 'cloth' ? 24 : 40;
  const out: Fragment[] = [];
  for (let i = 0; i < count; i++) {
    const angle = rng.range(0, Math.PI * 2), radius = Math.sqrt(rng.next()) * .34;
    const x = Math.cos(angle) * radius * width, z = Math.sin(angle) * radius * depth;
    const center = 1 - radius * 2.2;
    const beam = style === 'wood' || (style === 'metal' && i % 3 === 0) || i % 7 === 0;
    const cloth = style === 'cloth' && i % 3 !== 0;
    const chunk = style === 'stone' || (style === 'mixed' && i % 3 === 0);
    const sx = width * rng.range(beam ? .18 : .14, beam ? .45 : .32);
    const sz = depth * rng.range(cloth ? .14 : .04, cloth ? .32 : .17);
    const sy = cloth ? .025 : Math.max(.04, Math.min(height * rng.range(.08, .3), Math.min(width, depth) * .1));
    const y = Math.max(.04, height * center * rng.range(.2, .9));
    out.push({ shape: cloth ? 2 : chunk ? 1 : 0,
      pos: new THREE.Vector3(x, y, z), scale: new THREE.Vector3(sx, sy, sz),
      rotation: new THREE.Euler(rng.range(-.55, .55), rng.range(0, Math.PI * 2), rng.range(-.45, .45)),
      color: colors[rng.int(colors.length)] });
  }
  // A few recognisable broken upright panels/framework ends, like the reference ruin.
  if (style !== 'cloth' && style !== 'stone') for (let i = 0; i < 3; i++) {
    const h = Math.max(.1, height * rng.range(.5, 1.1));
    out.push({ shape: 0, pos: new THREE.Vector3(rng.range(-.32, .32) * width, h / 2, rng.range(-.32, .32) * depth),
      scale: new THREE.Vector3(width * rng.range(.06, .14), h, Math.max(.04, depth * .025)),
      rotation: new THREE.Euler(rng.range(-.6, .6), rng.range(0, Math.PI), rng.range(-.65, .65)), color: colors[0] });
  }
  return out;
}

function brokenSlab(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-.5, -.5); shape.lineTo(.28, -.5); shape.lineTo(.5, -.26);
  shape.lineTo(.43, .08); shape.lineTo(.5, .42); shape.lineTo(.06, .5);
  shape.lineTo(-.16, .36); shape.lineTo(-.5, .45); shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, steps: 1 });
  g.translate(0, 0, -.5); g.rotateX(-Math.PI / 2); return g;
}

function foldedFabric(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1, 3, 3); g.rotateX(-Math.PI / 2);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) p.setY(i, Math.sin(i * 2.7) * .22);
  g.computeVertexNormals(); return g;
}

export class WreckageRenderer implements RenderModule {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private material = new THREE.MeshStandardMaterial({ roughness: .93, metalness: .12, flatShading: true, side: THREE.DoubleSide });
  private geometries = [brokenSlab(), new THREE.IcosahedronGeometry(.65, 0), foldedFabric()];
  private lastScenery = -1;
  private lastWreckage: Wreckage[] | null = null;
  private lastIds = '';
  private lastScenerySet: Set<number> | null = null;
  private capacity = 0;
  private readonly obstacleById;
  constructor(private ctx: RenderContext) {
    this.group.name = 'persistent-structure-wreckage'; ctx.scene.add(this.group);
    this.obstacleById = new Map(ctx.world.map.obstacles.map(o => [o.id, o]));
    this.update(0);
  }
  update(_dt: number): void {
    const w = this.ctx.world, ids = `${w.wreckage.length}:${w.wreckage[0]?.id}:${w.wreckage.at(-1)?.id}`;
    if (this.lastScenerySet === w.destroyedScenery && this.lastScenery === w.destroyedScenery.size && this.lastWreckage === w.wreckage && this.lastIds === ids) return;
    this.lastScenerySet = w.destroyedScenery; this.lastScenery = w.destroyedScenery.size; this.lastWreckage = w.wreckage; this.lastIds = ids;
    const records: Wreckage[] = [...w.wreckage];
    for (const id of [...w.destroyedScenery].sort((a, b) => a - b)) {
      const o = this.obstacleById.get(id); if (!o || o.kind === 'effigy') continue;
      records.push({ id: `scenery:${id}`, kind: o.kind,
        pos: { x: o.x, y: groundHeight(o.x, o.z, w.map.half), z: o.z },
        size: { x: 2 * (o.shape === 'circle' ? o.radius : o.hx), y: o.height, z: 2 * (o.shape === 'circle' ? o.radius : o.hz) }, yaw: o.yaw });
    }
    const capacity = Math.max(32, records.length * 48);
    if (capacity > this.capacity) {
      for (const m of this.meshes) { this.group.remove(m); m.dispose(); }
      this.capacity = capacity;
      this.meshes = this.geometries.map((g, i) => {
        const m = new THREE.InstancedMesh(g, this.material, capacity); m.name = `wreckage-fragments-${i}`;
        m.castShadow = false; m.receiveShadow = true; this.group.add(m); return m;
      });
    }
    const counts = [0, 0, 0], matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), parent = new THREE.Matrix4();
    for (const r of records) {
      parent.makeRotationY(r.yaw); parent.setPosition(r.pos.x, r.pos.y, r.pos.z);
      for (const f of wreckageFragments(r, w.seed)) {
        rotation.setFromEuler(f.rotation); matrix.compose(f.pos, rotation, f.scale); matrix.premultiply(parent);
        // Ground every fragment to terrain independently; pile never floats on sloping sites.
        const e = matrix.elements, terrain = groundHeight(e[12], e[14], w.map.half);
        e[13] += terrain - r.pos.y;
        const m = this.meshes[f.shape], i = counts[f.shape]++;
        m.setMatrixAt(i, matrix); m.setColorAt(i, new THREE.Color(f.color));
      }
    }
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i]; m.count = counts[i]; m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true; m.computeBoundingSphere();
    }
  }
  dispose(): void {
    this.ctx.scene.remove(this.group); for (const m of this.meshes) m.dispose();
    for (const g of this.geometries) g.dispose(); this.material.dispose();
  }
}
