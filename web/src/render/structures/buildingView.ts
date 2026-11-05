import { buildingLevel } from '../../sim/buildingGeometry';
import { LEVEL_HEIGHT, BUILDING_SCAFFOLD_HEADROOM, BUILDING_POP_START_SCALE } from '../../sim/constants';
/**
 * BuildingView: the common life of every building visual. Subclasses build their model
 * (cached per kind in the kit) and animate it; the base class handles what every building
 * shares:
 *
 * - placement on the building's facet (and the env's visual ground offset);
 * - owner colour: trims, pennants and runes recolour when a camp is captured;
 * - construction (built < 1): a scaffold, the model rising out of the ground behind a
 *   glowing seam (shader discard), and a holographic blueprint of the unbuilt part;
 *   completion pops the building with a squash-and-stretch and a sparkle;
 * - damage (hp < 50%): spreading cracks and scorch; disabled: darker, tilted, smoking,
 *   lamps and glows stutter.
 */
import * as THREE from 'three';
import { NEUTRAL_COLOR } from '../../sim/constants';
import type { GameEvent } from '../../sim/events';
import type { Building, BuildingKind, EntityId, Owner } from '../../sim/types';
import type { World } from '../../sim/world';
import type { RenderContext } from '../context';
import { MaterialSet, NO_REVEAL, type ModelBuilder, type ModelGeometry, type StructureKit } from './kit';
import type { PuffField } from './puffs';
import { damp, easeOutBack, easeOutCubic, flickerNoise } from './util';

/** Everything a view needs for one frame (built once per frame by the renderer). */
export interface FrameInfo {
  ctx: RenderContext;
  world: World;
  dt: number;
  /** Presentation clock (s). */
  t: number;
  /** 0 = full day, 1 = deep night. */
  night: number;
  /** World rotation.y that makes a cloth's local +x fly downwind (ctx.shared.wind). */
  windYaw: number;
  /** Wind strength 0..1.5. */
  wind: number;
  /** Stock Flags held by each Hearth (counted once per frame). */
  stock: ReadonlyMap<EntityId, number>;
  /** Shared soft smoke / vapour puffs (normal blending). */
  smoke: PuffField;
  /** Shared glowing sparks / embers / glitter (additive). */
  sparks: PuffField;
}

/** Shared colour constants for emitters (linear RGB, allocated once). */
export const SMOKE_GREY = new THREE.Color(0x6a6560);
export const DUST_TAN = new THREE.Color(0xb59c78);
export const SPARK_GOLD = new THREE.Color(0xffc040);
export const BLUEPRINT_CYAN = 0x8fe9ff;
/** Full visible assembly height, not the shorter collision proxy. */
export const BUILDING_SPRITE_HEIGHT: Record<BuildingKind, number> = {
  hearth: 8.41, workshop: 3, drumcircle: 2.4, ward: 5.405, druglab: 3.2, gcc: 3.4,
};

/** Presentation-only state consumed by the shared mobile atlas renderer. */
export interface BuildingSpritePresentation {
  state: string;
  moving: boolean;
  height?: number;
  rotation?: number;
  highlight?: number;
}

const POP_TIME = 0.55;
const TAU = Math.PI * 2;

/** A light scaffold around a footprint: posts, ledgers, braces, one plank deck. */
export function buildScaffold(mb: ModelBuilder, radius: number, height: number): void {
  const n = 6;
  const top = height + BUILDING_SCAFFOLD_HEADROOM;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + 0.26;
    pts.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  for (const [x, z] of pts) mb.rod('woodPale', [x, 0, z], [x, top, z], 0.05, 6);
  for (let y = 1.1; y < top; y += 1.3) {
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      mb.rod('woodPale', [a[0], y, a[1]], [b[0], y, b[1]], 0.035, 5);
      mb.box('iron', 0.1, 0.1, 0.1, a[0], y, a[1]);
    }
  }
  for (let i = 0; i < n; i += 2) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    mb.rod('woodPale', [a[0], 0.1, a[1]], [b[0], Math.min(top, 2.4), b[1]], 0.03, 5);
  }
  const a = pts[0];
  const b = pts[1];
  mb.beam('woodPale', [a[0] * 0.9, 1.15, a[1] * 0.9], [b[0] * 0.9, 1.15, b[1] * 0.9], 0.5, 0.05);
}

export abstract class BuildingView {
  readonly id: EntityId;
  readonly kind: BuildingKind;
  /** World placement (position, yaw). Added to the scene by the renderer. */
  readonly root = new THREE.Group();
  /** Pop scale and disabled tilt apply here; models live under it. */
  protected readonly body = new THREE.Group();
  /** Billboard fire and ground/range effects must survive replacement of the model. */
  protected readonly effects = new THREE.Group();
  protected readonly kit: StructureKit;
  protected readonly mats: MaterialSet;
  /** Model height (construction reveal, smoke anchor). */
  protected readonly height: number;
  protected readonly radius: number;
  /** Owner currently shown; null forces the first recolour. */
  protected shownFaction: Owner | null = null;
  protected readonly factionColor = new THREE.Color(NEUTRAL_COLOR);
  /** Per-view seed for desynchronised animation. */
  protected readonly seed: number;
  private readonly staticMeshes: THREE.Mesh[] = [];
  private scaffold: { group: THREE.Group; mats: MaterialSet } | null = null;
  private blueprint: { twins: THREE.Mesh[]; material: THREE.ShaderMaterial } | null = null;
  private popT = 1;
  private tilt = 0;
  private disabledSmokeAcc = 0;
  private constructionDustAcc = 0;
  private readonly accessoryPoint = new THREE.Vector3();

  constructor(kit: StructureKit, b: Building, height: number, radius: number) {
    this.kit = kit;
    this.id = b.id;
    this.kind = b.kind;
    this.height = height;
    this.radius = radius;
    this.seed = (b.id * 2654435761) % 1000;
    this.mats = new MaterialSet(kit);
    this.root.name = `building-${b.kind}-${b.id}`;
    this.body.name = `building-models-${b.id}`;
    this.effects.name = `building-effects-${b.id}`;
    this.root.add(this.body, this.effects);
  }

  /** Add a cached static model under `parent` (default: body); it joins the blueprint. */
  protected addStatic(model: ModelGeometry, parent: THREE.Object3D = this.body, shadows = true): THREE.Mesh[] {
    const meshes = this.mats.addModel(parent, model, shadows);
    for (const m of meshes) this.staticMeshes.push(m);
    return meshes;
  }

  /** Per-frame sync from the simulation entity. */
  update(b: Building, f: FrameInfo): void {
    this.place(b, f);
    if (b.faction !== this.shownFaction) {
      this.shownFaction = b.faction;
      const hex = b.faction >= 0 ? f.world.factions[b.faction].color : NEUTRAL_COLOR;
      this.factionColor.setHex(hex);
      this.mats.setFaction(hex);
      this.onFaction(this.factionColor);
    }
    this.syncConstruction(b, f);
    this.syncCondition(b, f);
    const active = b.built >= 1 && !b.disabled;
    this.animate(b, f, active);
    // Effects keep the same completion pop/disabled transform as before, but are
    // not children of the hidden model group in mobile presentation.
    this.effects.position.copy(this.body.position);
    this.effects.quaternion.copy(this.body.quaternion);
    this.effects.scale.copy(this.body.scale);
    this.syncMobileSprite(b, f, active);
  }

  /** Default placement: on the facet centre, facing the facet's long diagonal. */
  protected place(b: Building, f: FrameInfo): void {
    const gy = (f.ctx.shared.groundOffset?.(b.pos.x, b.pos.z) ?? f.world.collision.groundHeight(b.pos.x, b.pos.z)) + buildingLevel(b) * LEVEL_HEIGHT;
    this.root.position.set(b.pos.x, gy, b.pos.z);
    this.root.rotation.y = b.yaw;
  }

  /** Owner changed (initial, capture). Materials are already recoloured. */
  protected onFaction(color: THREE.Color): void {
    void color;
  }

  /** Kind-specific animation. `active` = built and not disabled. */
  protected abstract animate(b: Building, f: FrameInfo, active: boolean): void;

  protected spritePresentation(_b: Building, _f: FrameInfo, active: boolean): BuildingSpritePresentation {
    return { state: 'idle', moving: active };
  }

  /** Optional real inventory sprites, not a stock count baked into building artwork. */
  protected spriteAccessories(_b: Building, _f: FrameInfo): void {}

  protected spriteStockFlag(f: FrameInfo, index: number, x: number, y: number, z: number, height: number, moving = true): void {
    const sprites = f.ctx.shared.mobileSprites;
    if (!sprites) return;
    this.body.updateWorldMatrix(true, false);
    const p = this.accessoryPoint.set(x, y, z).applyMatrix4(this.body.matrixWorld);
    sprites.flag({
      id: -2000000000 - this.id * 64 - index,
      x: p.x, y: p.y, z: p.z, yaw: f.windYaw,
      height: height * this.body.scale.y, moving,
    }, 'planted', { ribbon: this.factionColor });
  }

  private syncMobileSprite(b: Building, f: FrameInfo, active: boolean): void {
    const sprites = f.ctx.shared.mobileSprites;
    this.body.visible = !sprites;
    if (this.scaffold) this.scaffold.group.visible = !sprites;
    if (!sprites || (f.world.boss?.held?.kind === 'building' && f.world.boss.held.id === b.id)) return;
    const visual = this.spritePresentation(b, f, active), p = this.root.position;
    sprites.building(b.kind, {
      id: -6000000 - b.id, x: p.x, y: p.y, z: p.z, yaw: this.root.rotation.y,
      height: (visual.height ?? BUILDING_SPRITE_HEIGHT[b.kind]) * this.body.scale.y,
      moving: visual.moving,
    }, {
      state: visual.state, ownerColor: this.factionColor,
      buildProgress: Math.max(0, Math.min(1, b.built)),
      damage: b.maxHp > 0 ? Math.max(0, Math.min(1, (0.5 - b.hp / b.maxHp) * 2)) : 0,
      disabled: b.disabled, highlight: visual.highlight,
      rotation: visual.rotation ?? this.body.rotation.z,
      scaleX: this.body.scale.x / Math.max(0.001, this.body.scale.y),
    });
    this.spriteAccessories(b, f);
  }

  onEvent(e: GameEvent, f: FrameInfo): void {
    if (e.t === 'buildingDisabled' && e.buildingId === this.id) {
      this.burst(f.smoke, SMOKE_GREY, 14, this.height * 0.6, 1.6, 0.7, 0.4);
    } else if (e.t === 'buildingRepaired' && e.buildingId === this.id) {
      this.burst(f.sparks, SPARK_GOLD, 24, this.height * 0.5, 2.4, 0.18, 0);
    }
  }

  /** Radial puff burst around the building (completion, repair, disable). */
  protected burst(
    field: PuffField,
    color: THREE.Color,
    n: number,
    y: number,
    speed: number,
    size: number,
    buoyancy: number,
  ): void {
    const p = this.root.position;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + Math.random() * 0.4;
      const r = this.radius * (0.4 + Math.random() * 0.5);
      field.emit(
        p.x + Math.cos(a) * r,
        p.y + y * (0.4 + Math.random() * 0.8),
        p.z + Math.sin(a) * r,
        Math.cos(a) * speed * (0.5 + Math.random()),
        speed * (0.3 + Math.random() * 0.7),
        Math.sin(a) * speed * (0.5 + Math.random()),
        size,
        size * 2.5,
        0.9 + Math.random() * 0.8,
        color,
        0.8,
        buoyancy,
      );
    }
  }

  private syncConstruction(b: Building, f: FrameInfo): void {
    const u = this.mats.u;
    if (b.built < 1) {
      if (!this.scaffold) this.beginConstruction();
      const k = easeOutCubic(Math.max(0, b.built));
      u.uReveal.value = this.root.position.y + 0.02 + k * (this.height + 0.25);
      this.constructionDustAcc += f.dt * 6;
      while (this.constructionDustAcc >= 1) {
        this.constructionDustAcc -= 1;
        const a = Math.random() * TAU;
        const p = this.root.position;
        f.smoke.emit(
          p.x + Math.cos(a) * this.radius * 0.9,
          p.y + 0.2,
          p.z + Math.sin(a) * this.radius * 0.9,
          Math.cos(a) * 0.6,
          0.5,
          Math.sin(a) * 0.6,
          0.5,
          1.6,
          1.4,
          DUST_TAN,
          0.45,
          0.2,
        );
      }
    } else if (this.scaffold) {
      this.endConstruction();
      u.uReveal.value = NO_REVEAL;
      this.popT = 0;
      this.burst(f.sparks, SPARK_GOLD, 30, this.height * 0.7, 3, 0.2, 0);
      this.burst(f.smoke, DUST_TAN, 12, 0.3, 1.8, 0.8, 0.2);
    }
    if (this.popT < 1) {
      this.popT = Math.min(1, this.popT + f.dt / POP_TIME);
      const s = BUILDING_POP_START_SCALE + (1 - BUILDING_POP_START_SCALE) * easeOutBack(this.popT);
      this.body.scale.set(2 - s, s, 2 - s);
    } else if (this.body.scale.y !== 1) {
      this.body.scale.set(1, 1, 1);
    }
  }

  private beginConstruction(): void {
    // The scaffold has its own materials: it must not be clipped by the reveal seam.
    const scaffoldMats = new MaterialSet(this.kit);
    const group = new THREE.Group();
    scaffoldMats.addModel(
      group,
      this.kit.model(`scaffold:${this.kind}`, (mb) => buildScaffold(mb, this.radius, this.height)),
      false,
    );
    this.root.add(group);
    this.scaffold = { group, mats: scaffoldMats };
    const holo = this.kit.createHoloMaterial(BLUEPRINT_CYAN, this.mats.u.uReveal);
    holo.uniforms.uOpacity.value = 0.55;
    const twins: THREE.Mesh[] = [];
    for (const m of this.staticMeshes) {
      const twin = new THREE.Mesh(m.geometry, holo.material);
      m.parent?.add(twin);
      twins.push(twin);
    }
    this.blueprint = { twins, material: holo.material };
  }

  private endConstruction(): void {
    if (this.scaffold) {
      this.root.remove(this.scaffold.group);
      this.scaffold.mats.dispose();
      this.scaffold = null;
    }
    if (this.blueprint) {
      for (const twin of this.blueprint.twins) twin.parent?.remove(twin);
      this.blueprint.material.dispose();
      this.blueprint = null;
    }
  }

  private syncCondition(b: Building, f: FrameInfo): void {
    const u = this.mats.u;
    const frac = b.maxHp > 0 ? b.hp / b.maxHp : 1;
    let dmg = frac < 0.5 ? (0.5 - frac) * 2 : 0;
    if (b.disabled) dmg = Math.max(dmg, 0.85);
    u.uDamage.value = damp(u.uDamage.value, dmg, 3, f.dt);
    this.tilt = damp(this.tilt, b.disabled ? 1 : 0, 2.5, f.dt);
    const lean = this.tilt * 0.075;
    this.body.rotation.set(Math.sin(this.seed) * lean, 0, Math.cos(this.seed) * lean);
    u.uDarken.value = this.tilt * 0.3;
    if (b.disabled) {
      u.uFlicker.value = flickerNoise(f.t * 2.3, this.seed) > 0.35 ? 0.9 : 0.08;
      this.disabledSmokeAcc += f.dt * 5;
      const p = this.root.position;
      while (this.disabledSmokeAcc >= 1) {
        this.disabledSmokeAcc -= 1;
        f.smoke.emit(
          p.x + (Math.random() - 0.5) * this.radius,
          p.y + this.height * (0.6 + Math.random() * 0.3),
          p.z + (Math.random() - 0.5) * this.radius,
          0.3,
          0.9,
          0.1,
          0.6,
          2.6,
          3.2,
          SMOKE_GREY,
          0.55,
          0.3,
        );
      }
    } else {
      u.uFlicker.value = 1;
    }
  }

  dispose(): void {
    this.endConstruction();
    this.root.parent?.remove(this.root);
    this.mats.dispose();
  }
}
