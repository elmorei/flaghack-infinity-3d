/** Mobile map props are cutout sprites. The collision/layout remains the original map. */
import * as THREE from 'three';
import canonical from '../../../../scripts/scenery-bake-specs.json';
import type { Obstacle } from '../../../sim/map/mapgen';
import type { EnvContext, EnvPart } from '../envTypes';
import type { SpritePose } from '../../actors/mobileSprites';
import { terrainHeight } from '../terrain';
import { obstacleRng } from './kit';
import { buildForestPlacements } from './trees';
import { stagePresentation, StageSigns } from './stages';
import { StageShow } from './stageShow';

/** Variant identity is never collapsed to a generic tent/tree/vehicle/art silhouette. */
export function scenerySpriteKey(o: Pick<Obstacle, 'kind' | 'variant'>): string {
  const count = o.kind === 'tent' || o.kind === 'car' ? 3 : o.kind === 'tree' ? 2 : o.kind === 'art' ? 6 : 1;
  return `scenery:${o.kind}:${Math.max(0, Math.min(count - 1, Math.floor(o.variant)))}`;
}

const CANONICAL = new Map(canonical.map(o => [scenerySpriteKey(o as Obstacle), o]));

/** Preserve the authored footprint aspect independently of a prop's random height. */
export function scenerySpriteScaleX(o: Obstacle, cameraYaw: number): number {
  const reference = CANONICAL.get(scenerySpriteKey(o));
  if (!reference || o.kind === 'tree') return 1; // Canopy width follows tree height, not its trunk radius.
  const side = Math.abs(Math.sin(cameraYaw - o.yaw)) > Math.abs(Math.cos(cameraYaw - o.yaw));
  const widthRatio = o.shape === 'circle' ? o.radius / reference.radius : side ? o.hz / reference.hz : o.hx / reference.hx;
  return widthRatio / (o.height / reference.height);
}

interface ForestSprite { pose: SpritePose; color: THREE.Color; key: string; }

export class MobilePropField implements EnvPart {
  private readonly forest: ForestSprite[] = [];
  private readonly color = new THREE.Color();
  private readonly rotors = new Map<number, {speed:number;phase:number}>();
  private readonly pose: SpritePose = { id: 0, x: 0, y: 0, z: 0, yaw: 0, height: 1, moving: false };
  private readonly group = new THREE.Group();
  private show: StageShow | null = null;
  private signs: StageSigns | null = null;
  private destroyed = new Set<number>();
  private readonly cameraDirection = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();

  constructor(private readonly env: EnvContext) {
    this.group.name = 'mobile-scenery-effects'; env.root.add(this.group);
    // Placement-only data, shared with desktop. No canopy/trunk model is constructed.
    const map = env.ctx.world.map, pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
    let index = 0;
    for (const sector of buildForestPlacements(map.half, map.seed, env.ctx.quality)) {
      for (const [variant, trees] of [sector.pines, sector.broadleaves].entries()) for (const tree of trees) {
        tree.matrix.decompose(pos, quat, scale);
        const yaw = new THREE.Euler().setFromQuaternion(quat).y;
        this.forest.push({ key: `scenery:tree:${variant}`, color: tree.color,
          pose: { id: -2000000 - index++, x: pos.x, y: pos.y, z: pos.z, yaw,
            height: scale.y * (variant === 0 ? 20 : 12), moving: false } });
      }
    }
    for (const o of map.obstacles) if (o.kind === 'art' && (o.variant === 2 || o.variant === 3)) {
      const rng = obstacleRng(o, 'art');
      const speed = o.variant === 2 ? rng.range(.12, .22) * (rng.chance(.5) ? 1 : -1) : rng.range(.7, 1.2);
      this.rotors.set(o.id, {speed, phase:rng.range(0, Math.PI * 2)});
    }
    this.buildStageEffects();
  }

  private buildStageEffects(): void {
    const map = this.env.ctx.world.map;
    const stages = stagePresentation(map.obstacles.filter(o => o.kind === 'stage'), map.soundCamps, this.env.ctx.quality);
    for (const rig of stages.rigs) {
      // Rigid stage effects use the stage origin's foundation, not a separate slope sample.
      const o = map.obstacles.find(p => p.id === rig.obstacleId)!;
      const ground = terrainHeight(o.x, o.z, map.half);
      rig.frame.elements[13] += ground; rig.front.y += ground;
      for (const fixture of rig.fixtures) fixture.y += ground;
    }
    for (const sign of stages.signs) {
      const o = map.obstacles.find(p => p.id === sign.obstacleId)!;
      const ground = terrainHeight(o.x, o.z, map.half);
      for (const corner of sign.corners) corner.y += ground;
    }
    if (stages.rigs.length) {
      this.show = new StageShow(this.env, stages.rigs);
      this.signs = new StageSigns(stages.signs); this.group.add(this.signs.mesh);
    }
    this.destroyed.clear();
  }

  update(_dt: number): void {
    const { world, shared } = this.env.ctx, sprites = shared.mobileSprites;
    if (!sprites) return;
    if ([...this.destroyed].some(id => !world.destroyedScenery.has(id))) {
      this.show?.dispose(); this.signs?.mesh.removeFromParent(); this.signs?.dispose();
      this.show = this.signs = null; this.buildStageEffects();
    }
    for (const id of world.destroyedScenery) if (!this.destroyed.has(id)) {
      this.destroyed.add(id); this.show?.removeScenery(id); this.signs?.removeScenery(id);
    }
    this.env.ctx.camera.getWorldDirection(this.cameraDirection);
    this.env.ctx.camera.getWorldPosition(this.cameraPosition);
    const orthographic = (this.env.ctx.camera as THREE.OrthographicCamera).isOrthographicCamera;
    for (const o of world.map.obstacles) {
      if (o.kind === 'effigy' || world.destroyedScenery.has(o.id)) continue;
      const p = this.pose;
      p.id = -1000000 - o.id; p.x = o.x; p.y = terrainHeight(o.x, o.z, world.map.half); p.z = o.z;
      p.yaw = o.yaw; p.height = o.height; p.moving = o.kind === 'art' && (o.variant === 2 || o.variant === 3);
      this.color.setHex(o.color);
      const cameraYaw = orthographic ? Math.atan2(-this.cameraDirection.x, -this.cameraDirection.z)
        : Math.atan2(this.cameraPosition.x - o.x, this.cameraPosition.z - o.z);
      const rotor = this.rotors.get(o.id);
      const frame = rotor ? ((Math.floor((rotor.phase + rotor.speed * this.env.uniforms.uTime.value) / (Math.PI / 2)) % 4) + 4) % 4 : undefined;
      sprites.object(scenerySpriteKey(o), p, { ownerColor: this.color, scaleX: scenerySpriteScaleX(o, cameraYaw), frame });
    }
    for (const tree of this.forest) sprites.object(tree.key, tree.pose, { ownerColor: tree.color });
    this.show?.update(); this.signs?.update(this.env.day.night);
  }

  dispose(): void {
    this.show?.dispose(); this.signs?.dispose(); this.group.removeFromParent(); this.forest.length = 0;
  }
}
