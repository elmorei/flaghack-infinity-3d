/**
 * Level of detail and shadow budgeting for the instanced actor batches (Flags, hippies).
 *
 * ActorView holds the frame's camera eye and frustum and bins every instance:
 *   - detailed: in view and close, drawn with the full model (and casting a shadow);
 *   - coarse caster: within ACTOR_SHADOW_RANGE of the eye but not detailed, drawn with the
 *     light model; it casts even when off screen because its shadow can fall into view;
 *   - coarse: in view beyond the shadow range, light model, colour pass only;
 *   - skip: off screen and beyond the shadow range.
 *
 * InstanceSet holds one level's per-instance attributes. Casters are written from the front
 * and colour-only instances from the back; finish() closes the gap, so the colour pass draws
 * instances [0, count) and the shadow pass [0, castCount) (see castShadowPrefix).
 */
import * as THREE from 'three';
import { markInstancesDirty } from './util';

/** Actors farther than this from the eye cast no shadow (at that range it is a few pixels). */
export const ACTOR_SHADOW_RANGE = 50;

/** Widening of the detail range for instances already detailed, so the boundary does not flicker. */
const HYSTERESIS = 1.1;

export const PLACE = { skip: -1, detailed: 0, coarseCaster: 1, coarse: 2 } as const;
export type Placement = (typeof PLACE)[keyof typeof PLACE];

export class ActorView {
  readonly eye = new THREE.Vector3();
  /** False on the 'low' quality tier, which has no shadow map. */
  readonly shadows: boolean;
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly point = new THREE.Vector3();
  private parallelDetailDistance2: number | null = null;

  constructor(shadows: boolean) {
    this.shadows = shadows;
  }

  /** Capture this frame's camera (call once per frame before placing instances). */
  update(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    // Parallel actors do not shrink with depth. Use a 720px/50deg reference view's
    // equivalent distance at this pixel scale, rather than changing detail with pitch.
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const cssHeight = Number(camera.userData.cssHeight) || 720;
      const equivalent = 720 / (camera.projectionMatrix.elements[5] * cssHeight * Math.tan(25 * Math.PI / 180));
      this.parallelDetailDistance2 = equivalent * equivalent;
    } else this.parallelDetailDistance2 = null;
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection);
  }

  /** Whether an actor at this point casts a shadow this frame. */
  casts(x: number, y: number, z: number): boolean {
    return this.shadows && this.eye.distanceToSquared(this.point.set(x, y, z)) < ACTOR_SHADOW_RANGE * ACTOR_SHADOW_RANGE;
  }

  /**
   * Bin an instance bounded by the sphere (x, y, z, radius). `detailRange` is the distance
   * from the eye within which the detailed model is used (it must stay below the shadow range:
   * detailed instances always cast); `wasDetailed` applies the hysteresis.
   */
  place(x: number, y: number, z: number, radius: number, detailRange: number, wasDetailed: boolean): Placement {
    const center = this.sphere.center.set(x, y, z);
    this.sphere.radius = radius;
    const d2 = this.eye.distanceToSquared(center);
    const visible = this.frustum.intersectsSphere(this.sphere);
    const near = wasDetailed ? detailRange * HYSTERESIS : detailRange;
    if (visible && (this.parallelDetailDistance2 ?? d2) < near * near) return PLACE.detailed;
    if (this.shadows && d2 < ACTOR_SHADOW_RANGE * ACTOR_SHADOW_RANGE) return PLACE.coarseCaster;
    return visible ? PLACE.coarse : PLACE.skip;
  }
}

function dynamicAttribute(array: Float32Array, itemSize: number): THREE.InstancedBufferAttribute {
  const attr = new THREE.InstancedBufferAttribute(array, itemSize);
  attr.setUsage(THREE.DynamicDrawUsage);
  return attr;
}

export class InstanceSet {
  /** One attribute per item size; replaced (doubled) when full, which bumps `generation`. */
  readonly attrs: THREE.InstancedBufferAttribute[] = [];
  /** Instances drawn in the colour pass after finish(). */
  count = 0;
  /** Leading instances that also cast shadows after finish(). */
  castCount = 0;
  /** Bumped whenever `attrs` are reallocated: owners rebind them to their meshes. */
  generation = 0;
  private readonly sizes: readonly number[];
  private capacity: number;
  private front = 0;
  private back = 0;

  constructor(sizes: readonly number[], capacity: number) {
    this.sizes = sizes;
    this.capacity = capacity;
    for (const size of sizes) this.attrs.push(dynamicAttribute(new Float32Array(capacity * size), size));
  }

  begin(): void {
    this.front = 0;
    this.back = 0;
  }

  /** Slot for an instance drawn in the colour and shadow passes. */
  caster(): number {
    if (this.front + this.back >= this.capacity) this.grow();
    return this.front++;
  }

  /** Slot for an instance drawn in the colour pass only. */
  plain(): number {
    if (this.front + this.back >= this.capacity) this.grow();
    this.back++;
    return this.capacity - this.back;
  }

  /** Close the gap between the caster and colour-only blocks and flag the range for upload. */
  finish(): void {
    const { front, back, capacity } = this;
    if (back > 0 && capacity - back !== front) {
      for (let i = 0; i < this.attrs.length; i++) {
        const size = this.sizes[i];
        this.attrs[i].array.copyWithin(front * size, (capacity - back) * size, capacity * size);
      }
    }
    this.count = front + back;
    this.castCount = front;
    for (const attr of this.attrs) markInstancesDirty(attr, this.count);
  }

  /** Double the capacity, keeping both blocks at their ends. */
  private grow(): void {
    const cap = this.capacity * 2;
    for (let i = 0; i < this.attrs.length; i++) {
      const size = this.sizes[i];
      const old = this.attrs[i].array;
      const array = new Float32Array(cap * size);
      array.set(old.subarray(0, this.front * size));
      array.set(old.subarray((this.capacity - this.back) * size, this.capacity * size), (cap - this.back) * size);
      this.attrs[i] = dynamicAttribute(array, size);
    }
    this.capacity = cap;
    this.generation++;
  }
}

/** In the shadow pass, draw only the set's leading shadow casters. */
export function castShadowPrefix(mesh: THREE.InstancedMesh, set: InstanceSet): void {
  mesh.onBeforeShadow = () => {
    mesh.count = set.castCount;
  };
  mesh.onAfterShadow = () => {
    mesh.count = set.count;
  };
}

/** Apply a finished set to a mesh: colour-pass count, and no draw at all when empty. */
export function showInstances(mesh: THREE.InstancedMesh, set: InstanceSet, shadows: boolean): void {
  mesh.count = set.count;
  mesh.visible = set.count > 0;
  mesh.castShadow = shadows && set.castCount > 0;
}
