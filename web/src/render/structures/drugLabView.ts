/**
 * Drug Lab: a converted school bus (chrome-yellow, repainted with rainbow waves, flowers and
 * a pentagram eye, lettered VEXIHERBOLOGY; lit windows after dusk; crates and a solar panel
 * on the roof rack) with a tarp awning over a bubbling copper still on a tripod above a
 * small fire, its swan neck running to a hooped condenser barrel and a glass jug.
 *
 * The vapour tells what is brewing: Saffron puffs golden yellow, Luminous Dust glitters
 * silver-lilac, Acid Cop Vision boils off in cycling rainbow; idle, a thin grey steam.
 */
import * as THREE from 'three';
import type { GameEvent } from '../../sim/events';
import type { Building, DrugId } from '../../sim/types';
import { BuildingView, type FrameInfo, type BuildingSpritePresentation } from './buildingView';
import { Fire } from './fire';
import type { ModelBuilder, ModelRecipe, StructureKit } from './kit';
import { damp } from './util';

const TAU = Math.PI * 2;
const BUS_YELLOW = 0xf2b705;
const STILL_X = 2.0;
const STILL_Z = -0.7;
const POT_Y = 0.62;
/** World offset of the vapour vent (column top) in model space. */
const VENT: readonly [number, number, number] = [STILL_X, 1.82, STILL_Z];

const SAFFRON = new THREE.Color(1.0, 0.78, 0.12);
const DUST = new THREE.Color(0.85, 0.86, 1.0);
const DUST_GLITTER = [new THREE.Color(1, 1, 1), new THREE.Color(0.8, 0.7, 1.0), new THREE.Color(0.6, 0.95, 1.0)];
const STEAM = new THREE.Color(0.8, 0.8, 0.8);

function buildBus(mb: ModelBuilder): void {
  // Body, hood, roof.
  mb.box('paint', 2.16, 1.9, 4.5, 0, 1.5, -0.3, 0, 0, 0, BUS_YELLOW);
  mb.box('paint', 1.9, 0.9, 0.8, 0, 1.0, 2.35, 0, 0, 0, BUS_YELLOW);
  mb.box('paint', 2.24, 0.1, 4.6, 0, 2.5, -0.3, 0, 0, 0, 0xf5f0e0);
  // Crowned roof: the upper half of a cylinder along z, flattened.
  mb.add('paint', new THREE.CylinderGeometry(1.12, 1.12, 4.6, 16, 1, false, Math.PI / 2, Math.PI), 0, 2.5, -0.3, Math.PI / 2, 0, 0, 1, 1, 0.12, 0xf5f0e0);
  // Livery on both flanks (reads correctly from each side).
  for (const s of [-1, 1]) {
    mb.add('bus', new THREE.PlaneGeometry(4.5, 1.9), s * 1.085, 1.5, -0.3, 0, s * (Math.PI / 2), 0);
    for (let i = 0; i < 6; i++) {
      const z = -2.15 + i * 0.68;
      mb.add('window', new THREE.PlaneGeometry(0.56, 0.5), s * 1.092, 2.05, z, 0, s * (Math.PI / 2), 0);
      mb.box('iron', 0.02, 0.56, 0.05, s * 1.094, 2.05, z + 0.31);
    }
    mb.box('trim', 0.02, 0.06, 4.5, s * 1.09, 0.66, -0.3);
  }
  // Windshield, grille, lights, bumper.
  mb.add('window', new THREE.PlaneGeometry(1.9, 0.75), 0, 2.0, 1.955, 0, 0, 0);
  mb.box('iron', 1.3, 0.55, 0.04, 0, 1.0, 2.76);
  for (const s of [-1, 1]) mb.add('lamp', new THREE.SphereGeometry(0.11, 12, 8), s * 0.72, 1.12, 2.74);
  mb.box('iron', 2.1, 0.16, 0.14, 0, 0.55, 2.82);
  mb.box('iron', 2.1, 0.16, 0.14, 0, 0.55, -2.6);
  for (const s of [-1, 1]) mb.box('paint', 0.16, 0.22, 0.04, s * 0.85, 1.0, -2.56, 0, 0, 0, 0xd02020);
  mb.add('window', new THREE.PlaneGeometry(0.9, 0.6), 0, 1.95, -2.556, 0, Math.PI, 0);
  // Wheels.
  for (const s of [-1, 1]) {
    for (const z of [1.75, -1.8]) {
      mb.cyl('rubber', 0.45, 0.45, 0.32, s * 0.98, 0.45, z, 16, 0, 0, Math.PI / 2);
      mb.cyl('iron', 0.22, 0.22, 0.34, s * 0.98, 0.45, z, 12, 0, 0, Math.PI / 2);
    }
  }
  // Roof rack with crates and a solar panel.
  for (const s of [-1, 1]) mb.rod('iron', [s * 0.95, 2.72, -2.3], [s * 0.95, 2.72, 1.6], 0.025, 6);
  for (const z of [-2.2, -0.7, 0.8]) mb.rod('iron', [-0.95, 2.72, z], [0.95, 2.72, z], 0.02, 6);
  mb.box('woodPale', 0.7, 0.45, 0.55, -0.4, 2.98, -1.6);
  mb.box('wood', 0.55, 0.35, 0.5, 0.35, 2.93, -1.75);
  mb.add('glass', new THREE.PlaneGeometry(1.5, 1.0), 0, 2.86, 0.6, -Math.PI / 2 + 0.25, 0, 0);
  // Awning over the still on the +x flank.
  mb.push(1.85, 2.3, -0.6, 0, 0, -0.35);
  mb.add('canopy', new THREE.PlaneGeometry(1.55, 2.6), 0, 0, 0, -Math.PI / 2, 0, 0);
  mb.pop();
  for (const z of [-1.85, 0.65]) mb.rod('woodDark', [2.6, 0, z], [2.6, 2.05, z], 0.04, 6);
}

function buildStill(mb: ModelBuilder): void {
  // Tripod over a stone-ringed fire.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.3;
    mb.rod('iron', [STILL_X + Math.cos(a) * 0.55, 0, STILL_Z + Math.sin(a) * 0.55], [STILL_X, POT_Y - 0.05, STILL_Z], 0.02, 5);
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    mb.add('stone', new THREE.DodecahedronGeometry(0.1, 0), STILL_X + Math.cos(a) * 0.42, 0.06, STILL_Z + Math.sin(a) * 0.42, a, a, 0);
  }
  mb.add('ember', new THREE.CircleGeometry(0.34, 12), STILL_X, 0.03, STILL_Z, -Math.PI / 2, 0, 0);
  // Copper pot (lathe), column, swan neck, condenser barrel, jug.
  const pot: THREE.Vector2[] = [];
  const prof: [number, number][] = [
    [0.05, 0],
    [0.28, 0.04],
    [0.38, 0.2],
    [0.4, 0.36],
    [0.33, 0.56],
    [0.16, 0.7],
    [0.09, 0.74],
  ];
  for (const [r, y] of prof) pot.push(new THREE.Vector2(r, y));
  mb.add('copper', new THREE.LatheGeometry(pot, 20), STILL_X, POT_Y, STILL_Z);
  mb.cyl('copper', 0.075, 0.09, 0.5, STILL_X, POT_Y + 0.98, STILL_Z, 14);
  mb.add('copper', new THREE.SphereGeometry(0.11, 14, 10), STILL_X, POT_Y + 1.25, STILL_Z);
  const neck = new THREE.CatmullRomCurve3([
    new THREE.Vector3(STILL_X, POT_Y + 1.28, STILL_Z),
    new THREE.Vector3(STILL_X + 0.15, POT_Y + 1.38, STILL_Z + 0.45),
    new THREE.Vector3(STILL_X + 0.25, POT_Y + 1.1, STILL_Z + 0.95),
    new THREE.Vector3(STILL_X + 0.25, 0.9, STILL_Z + 1.2),
  ]);
  mb.add('copper', new THREE.TubeGeometry(neck, 24, 0.03, 8, false));
  mb.cyl('woodDark', 0.27, 0.25, 0.75, STILL_X + 0.25, 0.375, STILL_Z + 1.25, 16);
  for (const y of [0.15, 0.6]) mb.add('iron', new THREE.TorusGeometry(0.27, 0.012, 6, 24), STILL_X + 0.25, y, STILL_Z + 1.25, Math.PI / 2, 0, 0);
  mb.rod('copper', [STILL_X + 0.5, 0.18, STILL_Z + 1.25], [STILL_X + 0.75, 0.16, STILL_Z + 1.25], 0.015, 6);
  mb.add('glass', new THREE.SphereGeometry(0.13, 14, 10), STILL_X + 0.82, 0.13, STILL_Z + 1.25);
}

/** Static model of the Drug Lab bus (shared with its placement ghost). */
export const DRUGLAB_MODEL: ModelRecipe = { name: 'druglab', build: buildBus };

export class DrugLabView extends BuildingView {
  private readonly fire: Fire;
  private readonly thumper: THREE.Mesh;
  private brewing: DrugId | null = null;
  /** Last drug this lab boiled (the brewed event can arrive after the queue empties). */
  private lastBrew: DrugId | null = null;
  private boil = 0;
  private ventAcc = 0;
  private readonly tint = new THREE.Color();

  constructor(kit: StructureKit, b: Building) {
    super(kit, b, 3.2, 2.8);
    this.addStatic(kit.model(DRUGLAB_MODEL.name, DRUGLAB_MODEL.build));
    this.addStatic(kit.model('druglabStill', buildStill));
    this.fire = new Fire(kit, 2);
    this.fire.style.width = 0.55;
    this.fire.style.height = 0.55;
    this.fire.style.body.setRGB(1, 0.42, 0.08);
    this.fire.style.streak.setRGB(1, 0.42, 0.08);
    this.fire.mesh.position.set(STILL_X, 0.04, STILL_Z);
    this.effects.add(this.fire.mesh);
    this.thumper = new THREE.Mesh(
      kit.geometry('thumper', () => new THREE.SphereGeometry(0.1, 12, 8, 0, TAU, 0, Math.PI / 2)),
      this.mats.get('copper'),
    );
    this.thumper.position.set(STILL_X, POT_Y + 0.74, STILL_Z);
    this.body.add(this.thumper);
  }

  protected override animate(b: Building, f: FrameInfo, active: boolean): void {
    this.brewing = active && b.lab ? b.lab.brewing : null;
    if (this.brewing) this.lastBrew = this.brewing;
    this.boil = damp(this.boil, this.brewing ? 1 : 0, 2, f.dt);
    const st = this.fire.style;
    st.intensity = active ? 0.7 + 0.5 * this.boil : 0;
    st.turb = 0.5 + this.boil * 0.5;
    this.fire.apply();
    this.fire.mesh.visible = active;
    // The cap rattles while the wash boils.
    this.thumper.position.y = POT_Y + 0.74 + this.boil * Math.max(0, Math.sin(f.t * 23) * Math.sin(f.t * 7.7)) * 0.03;

    const p = this.root.position;
    const yaw = this.root.rotation.y;
    const vx = p.x + Math.cos(yaw) * VENT[0] + Math.sin(yaw) * VENT[2];
    const vz = p.z - Math.sin(yaw) * VENT[0] + Math.cos(yaw) * VENT[2];
    const vy = p.y + VENT[1];
    this.ventAcc += f.dt * (this.brewing ? 9 : active ? 1.2 : 0);
    while (this.ventAcc >= 1) {
      this.ventAcc -= 1;
      const jx = (Math.random() - 0.5) * 0.3;
      const jz = (Math.random() - 0.5) * 0.3;
      if (this.brewing === 'saffron') {
        f.smoke.emit(vx, vy, vz, jx, 0.9, jz, 0.25, 1.4, 2.4, SAFFRON, 0.7, 0.4);
      } else if (this.brewing === 'dust') {
        f.smoke.emit(vx, vy, vz, jx, 0.8, jz, 0.25, 1.2, 2.2, DUST, 0.45, 0.3);
        const gl = DUST_GLITTER[Math.floor(Math.random() * DUST_GLITTER.length)];
        f.sparks.emit(vx + jx * 2, vy + Math.random() * 0.6, vz + jz * 2, jx, 0.5 + Math.random(), jz, 0.05, 0.02, 1.8, gl, 1, 0.1);
      } else if (this.brewing === 'acidcop') {
        this.tint.setHSL((f.t * 0.35 + Math.random() * 0.25) % 1, 0.95, 0.6);
        f.smoke.emit(vx, vy, vz, jx, 1.0, jz, 0.22, 1.3, 2.3, this.tint, 0.75, 0.4);
      } else {
        f.smoke.emit(vx, vy, vz, jx, 0.6, jz, 0.15, 0.8, 1.8, STEAM, 0.25, 0.3);
      }
    }
  }

  override onEvent(e: GameEvent, f: FrameInfo): void {
    super.onEvent(e, f);
    if (e.t !== 'brewed' || e.faction !== this.shownFaction || e.drug !== this.lastBrew) return;
    const p = this.root.position;
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * TAU;
      this.tint.setHSL(e.drug === 'acidcop' ? i / 30 : e.drug === 'saffron' ? 0.13 : 0.72, 0.9, 0.65);
      f.sparks.emit(p.x, p.y + 2.4, p.z, Math.cos(a) * 2.2, 1.5 + Math.random(), Math.sin(a) * 2.2, 0.1, 0.03, 1.1, this.tint, 1, -1.5);
    }
  }

  protected override spritePresentation(_b: Building, _f: FrameInfo, active: boolean): BuildingSpritePresentation {
    const brewing = active && this.brewing !== null;
    return { state: brewing ? 'brewing' : 'idle', moving: brewing };
  }

  override dispose(): void {
    this.fire.dispose();
    super.dispose();
  }
}
