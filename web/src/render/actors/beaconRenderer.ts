/**
 * Dropped D.E.G.E.N. beacons (MOOP!): a little handheld LoRa radio lying screen-up on the
 * ground, with its infamous knob, screw-on antenna and a blinking LED in the colour of the
 * original camp. A glow sprite and a ground pulse make it findable. One instanced draw.
 */
import * as THREE from 'three';
import type { RenderContext } from '../context';
import { MeshBuilder } from './meshBuilder';
import type { StatusIcons, UnitRings } from './overlays';
import { PICKUP_BLINK_HZ as BLINK_HZ, pushDroppedPickup } from './droppedPickup';
import { METAL_CAP, hash01, markInstancesDirty, writeTransform } from './util';

const CAPACITY = 64;
const SCALE = 2.4;

function buildRadio(): THREE.BufferGeometry {
  const b = new MeshBuilder([
    { name: 'color', size: 3 },
    { name: 'aSurf', size: 3 },
    { name: 'aLed', size: 1 },
  ]);
  const col = (hex: number) => {
    const c = new THREE.Color(hex);
    return [c.r, c.g, c.b];
  };
  b.with({ color: col(0x2b2f36), aSurf: [0.55, 0.1, 0], aLed: [0] }).box([0, 0.06, 0], [0.066, 0.12, 0.032]);
  b.with({ color: col(0x0d1f14), aSurf: [0.15, 0, 0.35], aLed: [0] }).box([0, 0.086, 0.0165], [0.048, 0.032, 0.002]);
  b.with({ color: col(0x9aa0a8), aSurf: [0.35, 0.6, 0], aLed: [0] }).seg([0.018, 0.12, 0], [0.018, 0.13, 0], 0.009, 0.009, 8);
  b.with({ color: col(0x15171a), aSurf: [0.4, 0.3, 0], aLed: [0] })
    .seg([-0.02, 0.118, 0], [-0.02, 0.215, 0], 0.0045, 0.003, 5)
    .ball([-0.02, 0.218, 0], 0.006, 0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      b.with({ color: col(0x5a606a), aSurf: [0.5, 0.2, 0], aLed: [0] }).box([(c - 1) * 0.015, 0.04 - r * 0.013, 0.0165], [0.009, 0.007, 0.002]);
    }
  }
  b.with({ color: col(0xffffff), aSurf: [0.2, 0, 0], aLed: [1] }).ball([0.018, 0.108, 0.0165], 0.0055, 1);
  const g = b.build();
  g.deleteAttribute('uv');
  return g;
}

export class BeaconRenderer {
  private readonly ctx: RenderContext;
  private readonly rings: UnitRings;
  private readonly icons: StatusIcons;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  /** Own depth material: three's shared default would switch variants between casters. */
  private readonly depthMaterial = new THREE.MeshDepthMaterial();
  private readonly mesh: THREE.InstancedMesh;
  private readonly ledAttr: THREE.InstancedBufferAttribute;
  private readonly time = { value: 0 };
  private readonly colors: THREE.Color[];

  constructor(ctx: RenderContext, rings: UnitRings, icons: StatusIcons) {
    this.ctx = ctx;
    this.rings = rings;
    this.icons = icons;
    this.colors = ctx.world.factions.map((f) => new THREE.Color(f.color));
    this.geometry = buildRadio();
    this.ledAttr = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4);
    this.ledAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aBeacon', this.ledAttr);
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true });
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.time;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute vec3 aSurf;\nattribute float aLed;\nattribute vec4 aBeacon;\nvarying vec3 vSurf;\nvarying float vLed;\nvarying vec4 vBeacon;',
        )
        .replace('#include <project_vertex>', '#include <project_vertex>\nvSurf = aSurf;\nvLed = aLed;\nvBeacon = aBeacon;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTime;\nvarying vec3 vSurf;\nvarying float vLed;\nvarying vec4 vBeacon;',
        )
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vBeacon.rgb, vLed);')
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vSurf.x;')
        .replace('#include <metalnessmap_fragment>', `float metalnessFactor = min(vSurf.y, ${METAL_CAP.toFixed(2)});`)
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          float blink = step(fract(uTime * ${BLINK_HZ.toFixed(2)} + vBeacon.w), 0.5);
          totalEmissiveRadiance += vBeacon.rgb * vLed * (0.4 + 3.0 * blink) + diffuseColor.rgb * vSurf.z;`,
        );
    };
    this.material.customProgramCacheKey = () => 'fh-beacon';
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, CAPACITY);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'actors-beacons';
    this.mesh.castShadow = ctx.quality !== 'low';
    this.mesh.customDepthMaterial = this.depthMaterial;
    this.mesh.count = 0;
    ctx.scene.add(this.mesh);
  }

  update(): void {
    const ctx = this.ctx;
    const t = ctx.time;
    this.time.value = t;
    const groundAt = ctx.shared.groundOffset;
    const mats = this.mesh.instanceMatrix.array;
    const led = this.ledAttr.array;
    let n = 0;
    for (const b of ctx.world.beacons.values()) {
      if (n >= CAPACITY) break;
      const ph = hash01(b.id);
      const gy = groundAt ? groundAt(b.pos.x, b.pos.z) : 0;
      // Lying screen-up, slightly askew, as if dropped mid-stride.
      writeTransform(mats, n * 16, b.pos.x, gy + 0.016 * SCALE, b.pos.z, ph * Math.PI * 2, -Math.PI / 2 + 0.1, (ph - 0.5) * 0.3, SCALE);
      const c = this.colors[b.faction];
      led[n * 4] = c.r;
      led[n * 4 + 1] = c.g;
      led[n * 4 + 2] = c.b;
      led[n * 4 + 3] = ph;
      pushDroppedPickup(this.rings, this.icons, b.pos.x, gy, b.pos.z, c, ph, t);
      n++;
    }
    this.mesh.count = n;
    markInstancesDirty(this.mesh.instanceMatrix, n);
    markInstancesDirty(this.ledAttr, n);
  }

  dispose(): void {
    this.ctx.scene.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
  }
}
