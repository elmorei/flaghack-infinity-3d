/**
 * Flag Workshop: an open-sided canopy (faction-tinted festival tarp, bunting along the front
 * edge) over a workbench with a half-cut Flag, a paint can and a bundle of poles; a line of
 * hanging half-made pale Flags; two sawhorses with a plank; a crossed lumber stack; a bolt
 * of Flag-yellow fabric on a stand. While the Workshop produces, the saw rasps and the
 * hammer strikes (sawdust, sparks); every crafted Flag pops a golden flourish.
 */
import * as THREE from 'three';
import { WORKSHOP_FLAG_CAPACITY } from '../../sim/constants';
import type { GameEvent } from '../../sim/events';
import type { Building } from '../../sim/types';
import { BuildingView, DUST_TAN, SPARK_GOLD, type FrameInfo, type BuildingSpritePresentation } from './buildingView';
import type { ModelBuilder, ModelRecipe, StructureKit } from './kit';
import { buildBunting, flagCloth } from './shapes';
import { damp } from './util';

const FRONT_Y = 2.55;
const BACK_Y = 2.25;
const POST_X = 1.6;
const POST_Z = 1.1;
const SAW_X = -0.95;
const SAW_Z = 0.95;
const HAMMER_POS: readonly [number, number, number] = [0.62, 0.99, -0.42];
const FLAG_YELLOW_LINEAR = new THREE.Color(1.0, 0.82, 0.1);

function buildWorkshop(mb: ModelBuilder): void {
  // Canopy: posts, rafters, sloped tarp, guy ropes, bunting.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const top = sz > 0 ? FRONT_Y : BACK_Y;
      mb.rod('woodDark', [sx * POST_X, 0, sz * POST_Z], [sx * POST_X, top, sz * POST_Z], 0.06, 7);
    }
    mb.rod('rope', [sx * POST_X, FRONT_Y - 0.05, POST_Z], [sx * 2.35, 0.02, 1.95], 0.008, 3);
    mb.box('woodDark', 0.06, 0.25, 0.06, sx * 2.35, 0.08, 1.95);
  }
  mb.beam('woodDark', [-POST_X - 0.1, FRONT_Y, POST_Z], [POST_X + 0.1, FRONT_Y, POST_Z], 0.08, 0.1);
  mb.beam('woodDark', [-POST_X - 0.1, BACK_Y, -POST_Z], [POST_X + 0.1, BACK_Y, -POST_Z], 0.08, 0.1);
  for (const x of [-POST_X, 0, POST_X]) mb.beam('woodDark', [x, BACK_Y + 0.06, -POST_Z - 0.1], [x, FRONT_Y + 0.06, POST_Z + 0.1], 0.06, 0.06);
  const slope = Math.atan2(FRONT_Y - BACK_Y, POST_Z * 2);
  const roof = new THREE.PlaneGeometry(POST_X * 2 + 0.4, (POST_Z * 2 + 0.4) / Math.cos(slope), 1, 1);
  mb.add('canopy', roof, 0, (FRONT_Y + BACK_Y) / 2 + 0.11, 0, -Math.PI / 2 + slope, 0, 0);
  buildBunting(mb, [-POST_X, FRONT_Y - 0.02, POST_Z + 0.07], [POST_X, FRONT_Y - 0.02, POST_Z + 0.07], 9, 0.12);

  // Workbench.
  mb.box('woodPale', 2.3, 0.08, 0.78, 0.1, 0.92, -0.5);
  for (const x of [-0.95, 1.15]) for (const z of [-0.82, -0.18]) mb.box('woodDark', 0.07, 0.88, 0.07, x, 0.44, z);
  mb.box('woodDark', 2.1, 0.05, 0.05, 0.1, 0.25, -0.82);
  mb.add('clothPale', new THREE.PlaneGeometry(0.62, 0.42), -0.35, 0.965, -0.5, -Math.PI / 2, 0, 0.18);
  mb.add('clothStill', new THREE.PlaneGeometry(0.3, 0.42), -0.35 + 0.14, 0.968, -0.5, -Math.PI / 2, 0, 0.18);
  mb.cyl('paint', 0.08, 0.08, 0.15, 0.95, 1.04, -0.6, 14, 0, 0, 0, 0xf2c200);
  mb.cyl('iron', 0.083, 0.083, 0.02, 0.95, 1.12, -0.6, 14);
  for (let i = 0; i < 6; i++) {
    mb.rod('woodPale', [-0.2 + i * 0.035, 0.985 + (i % 2) * 0.03, -0.25], [0.95 + i * 0.03, 0.985 + (i % 2) * 0.03, -0.32], 0.016, 5);
  }

  // Hanging half-made Flags under the back rafter.
  mb.rod('rope', [-POST_X, 2.02, -POST_Z], [POST_X, 2.02, -POST_Z], 0.006, 3);
  const widths = [0.62, 0.45, 0.62, 0.3, 0.55];
  for (let i = 0; i < 5; i++) {
    const x = -1.2 + i * 0.6;
    const g = flagCloth().rotateZ(-Math.PI / 2).scale(1, widths[i], 1).scale(0.62, 0.62, 1);
    mb.add(i === 2 ? 'cloth' : 'clothPale', g, x, 2.0, -POST_Z, 0, 0, 0);
    mb.box('woodPale', 0.025, 0.07, 0.02, x - 0.1, 2.0, -POST_Z + 0.01);
    mb.box('woodPale', 0.025, 0.07, 0.02, x + 0.1, 2.0, -POST_Z + 0.01);
  }

  // Sawhorses with a plank across.
  for (const x of [-1.55, -0.35]) {
    mb.box('woodPale', 0.09, 0.09, 0.95, x, 0.68, SAW_Z);
    for (const sz of [-0.38, 0.38]) {
      for (const sx of [-1, 1]) mb.rod('woodPale', [x, 0.66, SAW_Z + sz], [x + sx * 0.24, 0, SAW_Z + sz * 1.15], 0.028, 5);
    }
  }
  mb.box('woodPale', 1.75, 0.045, 0.26, -0.95, 0.745, SAW_Z);

  // Lumber stack, crossed layers.
  for (let layer = 0; layer < 5; layer++) {
    for (let i = 0; i < 4; i++) {
      const off = -0.27 + i * 0.18;
      const y = 0.06 + layer * 0.115;
      if (layer % 2 === 0) mb.box('woodPale', 1.5, 0.1, 0.15, 1.55 + (i % 2) * 0.04, y, 1.75 + off);
      else mb.box('wood', 0.15, 0.1, 1.5, 1.55 + off, y, 1.75 + (i % 2) * 0.04);
    }
  }

  // Bolt of Flag-yellow fabric on a stand, a length draped toward the bench.
  for (const z of [-0.65, 0.25]) {
    mb.rod('woodDark', [1.85, 0, z], [1.85, 1.15, z], 0.035, 6);
    mb.rod('woodDark', [2.15, 0, z], [1.85, 1.15, z], 0.03, 6);
  }
  mb.rod('iron', [1.85, 1.12, -0.75], [1.85, 1.12, 0.35], 0.02, 6);
  mb.cyl('clothStill', 0.17, 0.17, 0.85, 1.85, 1.12, -0.2, 18, Math.PI / 2, 0, 0);
  mb.add('clothStill', new THREE.PlaneGeometry(0.8, 0.55), 1.69, 0.88, -0.2, 0, Math.PI / 2, 0.25);
}

/** Bow saw: blade along x, handle at +x; origin at the cut. */
function buildSaw(mb: ModelBuilder): void {
  mb.box('iron', 0.62, 0.11, 0.006, 0, 0.06, 0);
  mb.box('woodDark', 0.12, 0.14, 0.035, 0.36, 0.1, 0);
}

/** Hammer pivoting at the wrist (origin); head at the far end of the handle. */
function buildHammer(mb: ModelBuilder): void {
  mb.rod('woodDark', [0, 0, 0], [-0.32, 0, 0], 0.014, 6);
  mb.box('iron', 0.05, 0.05, 0.13, -0.33, 0, 0);
}

/** Static model of the Flag Workshop (shared with its placement ghost). */
export const WORKSHOP_MODEL: ModelRecipe = { name: 'workshop', build: buildWorkshop };

export class WorkshopView extends BuildingView {
  private readonly stockFlags: THREE.Group[] = [];
  private readonly saw = new THREE.Group();
  private readonly hammer = new THREE.Group();
  private lastProgress = Number.NaN;
  private working = 0;
  private hammerPhase = 0;
  private dustAcc = 0;

  constructor(kit: StructureKit, b: Building) {
    super(kit, b, 3.0, 2.8);
    this.addStatic(kit.model(WORKSHOP_MODEL.name, WORKSHOP_MODEL.build));
    this.saw.position.set(SAW_X, 0.77, SAW_Z);
    this.addStatic(kit.model('workshopSaw', buildSaw), this.saw);
    this.hammer.position.set(HAMMER_POS[0], HAMMER_POS[1], HAMMER_POS[2]);
    this.addStatic(kit.model('workshopHammer', buildHammer), this.hammer);
    this.body.add(this.saw, this.hammer);
    for (let i = 0; i < WORKSHOP_FLAG_CAPACITY; i++) {
      const flag = new THREE.Group();
      this.addStatic(kit.model('workshopStockFlag', (mb) => {
        mb.rod('woodDark', [0, 0, 0], [0, 1.2, 0], 0.018, 5);
        mb.add('cloth', flagCloth().scale(0.32, 0.32, 1), 0, 1.12, 0);
      }), flag);
      flag.position.set(-1.2 + (i % 5) * 0.48, 0.05, 1.5 + Math.floor(i / 5) * 0.25);
      flag.visible = false;
      this.body.add(flag);
      this.stockFlags.push(flag);
    }
  }

  protected override animate(b: Building, f: FrameInfo, active: boolean): void {
    const stock = f.stock.get(b.id) ?? 0;
    for (let i = 0; i < this.stockFlags.length; i++) this.stockFlags[i].visible = i < stock;
    const producing = active && !Number.isNaN(this.lastProgress) && b.progress !== this.lastProgress;
    this.lastProgress = b.progress;
    this.working = damp(this.working, producing ? 1 : 0, producing ? 6 : 1.5, f.dt);
    const w = this.working;
    // Saw: long strokes along the plank; the hammer rises and strikes the bench.
    this.saw.position.x = SAW_X + Math.sin(f.t * 9) * 0.2 * w;
    this.saw.rotation.z = Math.sin(f.t * 9 + 0.6) * 0.06 * w;
    const prev = this.hammerPhase;
    this.hammerPhase = (this.hammerPhase + f.dt * 1.6 * w) % 1;
    const lift = this.hammerPhase < 0.75 ? Math.sin((this.hammerPhase / 0.75) * Math.PI * 0.5) : 1 - (this.hammerPhase - 0.75) / 0.25;
    this.hammer.rotation.z = -0.05 - lift * 1.1 * w;
    const p = this.root.position;
    if (w > 0.3 && prev > this.hammerPhase) {
      // Strike: a few sparks off the bench.
      const yaw = this.root.rotation.y;
      const hx = p.x + Math.cos(yaw) * (HAMMER_POS[0] - 0.33) + Math.sin(yaw) * HAMMER_POS[2];
      const hz = p.z - Math.sin(yaw) * (HAMMER_POS[0] - 0.33) + Math.cos(yaw) * HAMMER_POS[2];
      for (let i = 0; i < 5; i++) {
        f.sparks.emit(hx, p.y + 1.0, hz, (Math.random() - 0.5) * 2, 1 + Math.random() * 1.5, (Math.random() - 0.5) * 2, 0.04, 0.02, 0.4, SPARK_GOLD, 1, -6);
      }
    }
    this.dustAcc += f.dt * 10 * w;
    while (this.dustAcc >= 1) {
      this.dustAcc -= 1;
      const yaw = this.root.rotation.y;
      const sx = this.saw.position.x;
      const x = p.x + Math.cos(yaw) * sx + Math.sin(yaw) * SAW_Z;
      const z = p.z - Math.sin(yaw) * sx + Math.cos(yaw) * SAW_Z;
      f.smoke.emit(x, p.y + 0.72, z, (Math.random() - 0.5) * 0.4, -0.2, (Math.random() - 0.5) * 0.4, 0.06, 0.25, 0.9, DUST_TAN, 0.6, -1.5);
    }
  }

  override onEvent(e: GameEvent, f: FrameInfo): void {
    super.onEvent(e, f);
    if (e.t !== 'flagCrafted' || e.at !== this.id) return;
    const p = this.root.position;
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      f.sparks.emit(p.x, p.y + 1.3, p.z, Math.cos(a) * 1.6, 1.8 + Math.random(), Math.sin(a) * 1.6, 0.1, 0.03, 0.9, FLAG_YELLOW_LINEAR, 1, -2);
    }
  }

  protected override spritePresentation(_b: Building, _f: FrameInfo, active: boolean): BuildingSpritePresentation {
    const working = active && this.working > 0.1;
    return { state: working ? 'working' : 'idle', moving: active };
  }

  protected override spriteAccessories(b: Building, f: FrameInfo): void {
    const count = Math.min(WORKSHOP_FLAG_CAPACITY, f.stock.get(b.id) ?? 0);
    for (let i = 0; i < count; i++) this.spriteStockFlag(f, i, -1.2 + (i % 5) * 0.48, 0.05, 1.5 + Math.floor(i / 5) * 0.25, 1.2);
  }
}
