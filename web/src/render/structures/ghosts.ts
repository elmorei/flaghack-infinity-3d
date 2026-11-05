/**
 * Placement ghosts from ctx.session.ghost: a holographic preview of the exact piece slot
 * (wall edge, deck/ramp facet at its level, ramp low side) or building footprint (facet
 * centre, facet yaw, the kind's real model) in cyan when valid, throbbing red when not,
 * with a footprint ring on the ground for buildings.
 */
import * as THREE from 'three';
import { BUILDINGS, LEVEL_HEIGHT } from '../../sim/constants';
import { facetYaw } from '../../sim/factory';
import type { BuildingKind, PieceKind } from '../../sim/types';
import { BUILDING_SPRITE_HEIGHT, type FrameInfo } from './buildingView';
import { DRUGLAB_MODEL } from './drugLabView';
import { DRUMCIRCLE_MODEL } from './drumCircleView';
import { GCC_MODEL } from './gccView';
import { HEARTH_MODEL } from './hearthView';
import type { HoloUniforms, ModelGeometry, ModelRecipe, StructureKit } from './kit';
import { pieceModels, pieceSlotMatrix } from './pieces';
import { WARD_MODEL } from './wardView';
import { WORKSHOP_MODEL } from './workshopView';

const VALID = new THREE.Color(0x3df2ff);
const INVALID = new THREE.Color(0xff3448);

const BUILDING_RECIPES: Record<BuildingKind, ModelRecipe> = {
  hearth: HEARTH_MODEL,
  gcc: GCC_MODEL,
  workshop: WORKSHOP_MODEL,
  drumcircle: DRUMCIRCLE_MODEL,
  ward: WARD_MODEL,
  druglab: DRUGLAB_MODEL,
};

function isPieceKind(k: PieceKind | BuildingKind): k is PieceKind {
  return k === 'wall' || k === 'floor' || k === 'ramp';
}

export class GhostRenderer {
  private readonly kit: StructureKit;
  private readonly group = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;
  private readonly uniforms: HoloUniforms;
  /** Two reusable meshes for piece ghosts (a wall has frame + tarp). */
  private readonly pieceParts: THREE.Mesh[];
  private readonly buildings = new Map<BuildingKind, THREE.Group>();
  private readonly ring: THREE.Mesh;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly models: { wall: ModelGeometry; decks: ModelGeometry[]; ramps: ModelGeometry[] };
  private readonly m = new THREE.Matrix4();

  constructor(kit: StructureKit, scene: THREE.Scene, latticeEdge: number) {
    this.kit = kit;
    const holo = kit.createHoloMaterial(0x3df2ff, { value: -1e5 });
    this.material = holo.material;
    this.uniforms = holo.uniforms;
    this.material.depthTest = true;
    this.pieceParts = [0, 1].map(() => {
      const mesh = new THREE.Mesh(undefined, this.material);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      this.group.add(mesh);
      return mesh;
    });
    this.models = pieceModels(kit, latticeEdge);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: VALID,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(kit.geometry('ghostRing', () => new THREE.RingGeometry(0.9, 1, 64).rotateX(-Math.PI / 2)), this.ringMat);
    this.ring.renderOrder = 5;
    this.group.add(this.ring);
    this.group.visible = false;
    scene.add(this.group);
  }

  update(f: FrameInfo): void {
    const ghost = f.ctx.session.ghost;
    const lat = f.world.lattice;
    for (const p of this.pieceParts) p.visible = false;
    for (const g of this.buildings.values()) g.visible = false;
    this.ring.visible = false;
    if (!ghost) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    const color = ghost.valid ? VALID : INVALID;
    this.uniforms.uColor.value.copy(color);
    this.uniforms.uPulse.value = ghost.valid ? 0.25 : 1;
    this.ringMat.color.copy(color);

    if (isPieceKind(ghost.kind)) {
      const ok = ghost.kind === 'wall' ? ghost.edge >= 0 && ghost.edge < lat.edges.length : ghost.facet >= 0 && ghost.facet < lat.facets.length;
      if (!ok) return;
      const variant = pieceSlotMatrix(lat, ghost.kind, ghost.edge, ghost.facet, ghost.level, ghost.rampEdge, 1, this.m, f.world.map.half);
      const model = ghost.kind === 'wall' ? this.models.wall : ghost.kind === 'floor' ? this.models.decks[variant] : this.models.ramps[variant];
      let i = 0;
      for (const geom of model.values()) {
        const part = this.pieceParts[i++];
        if (!part) break;
        part.geometry = geom;
        part.matrix.copy(this.m);
        part.visible = true;
      }
      return;
    }

    if (ghost.facet < 0 || ghost.facet >= lat.facets.length) return;
    const fc = lat.facets[ghost.facet];
    const gy = (f.ctx.shared.groundOffset?.(fc.cx, fc.cz) ?? f.world.collision.groundHeight(fc.cx, fc.cz)) + ghost.level * LEVEL_HEIGHT;
    const yaw = facetYaw(f.world, ghost.facet);
    const sprites = f.ctx.shared.mobileSprites;
    if (sprites) {
      sprites.building(ghost.kind, {
        id: -1800000000, x: fc.cx, y: gy, z: fc.cz, yaw,
        height: BUILDING_SPRITE_HEIGHT[ghost.kind], moving: false,
      }, { state: 'idle', ownerColor: color, buildProgress: 0, ghost: true });
    } else {
      const group = this.buildingGhost(ghost.kind);
      group.position.set(fc.cx, gy, fc.cz);
      group.rotation.y = yaw;
      group.visible = true;
    }
    const r = BUILDINGS[ghost.kind].radius;
    this.ring.position.set(fc.cx, gy + 0.06, fc.cz);
    this.ring.scale.set(r, 1, r);
    this.ring.visible = true;
  }

  private buildingGhost(kind: BuildingKind): THREE.Group {
    let g = this.buildings.get(kind);
    if (!g) {
      g = new THREE.Group();
      const recipe = BUILDING_RECIPES[kind];
      for (const geom of this.kit.model(recipe.name, recipe.build).values()) {
        const mesh = new THREE.Mesh(geom, this.material);
        mesh.renderOrder = 5;
        g.add(mesh);
      }
      this.group.add(g);
      this.buildings.set(kind, g);
    }
    return g;
  }

  dispose(): void {
    this.group.parent?.remove(this.group);
    this.material.dispose();
    this.ringMat.dispose();
  }
}
