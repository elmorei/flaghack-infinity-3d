/**
 * The Flag Hearth, camp core and conquest target: a ritual-industrial anchor. A pentagonal
 * stone fire pit with brick capstones around a bed of live coals and charred logs; a tall
 * flagpole rising out of the fire flying a large yellow Flag with the owner's ribbon at the
 * finial; a curved wooden rack showing the stock (one small upright Flag per stocked Flag,
 * up to 30; hoarded stock freezes still and frosts over); five carved totems in a pentagon.
 *
 * The fire reads the capture stage at a glance:
 *   safe        calm flame in the owner's colour
 *   threatened  flickering amber
 *   contained   streaked with the attacker's colour, fiercer with the leading pressure
 *   contested   violent two-colour flicker
 *   overwritten a white-hot column
 *   captured    the captor's colour (the Hearth now belongs to it)
 * One point light per Hearth (pooled by the renderer) carries the flame colour into the night.
 */
import * as THREE from 'three';
import { isHoarding } from '../../sim/systems/economy';
import { rtsThroneAltar } from '../../sim/rts';
import { angleDiff } from '../../sim/math';
import type { Building, FactionId } from '../../sim/types';
import { BuildingView, SMOKE_GREY, type FrameInfo } from './buildingView';
import { createFireStyle, dampFireStyle, Fire, type FireStyle } from './fire';
import type { ModelBuilder, ModelRecipe, StructureKit } from './kit';
import { extrudeUp, flagCloth, pennantCloth, pentagon } from './shapes';
import { flickerNoise } from './util';

const TAU = Math.PI * 2;
const PIT_OUT = 1.55;
const PIT_IN = 1.12;
const PIT_H = 0.46;
const POLE_H = 8.2;
const RACK_IN = 2.36;
const RACK_OUT = 2.68;
const RACK_SPAN = 1.08; // half-angle (rad) of the rack arc, centred behind the pit
const RACK_SLOTS = 30;
const TOTEM_R = 3.05;

const WHITE = new THREE.Color(1, 1, 1);
const AMBER = new THREE.Color(1.0, 0.58, 0.12);
const AMBER_CORE = new THREE.Color(1.0, 0.92, 0.7);
const WHITE_HOT = new THREE.Color(0.85, 0.95, 1.0);
const FROST = new THREE.Color(0.75, 0.9, 1.0);

/** Angle (yaw) of rack slot i: rows alternate inner/outer, filling from the centre outward. */
function rackSlot(i: number): { yaw: number; r: number } {
  const row = i % 2;
  const idx = Math.floor(i / 2);
  const step = (RACK_SPAN * 2) / 14;
  const off = Math.ceil(idx / 2) * step * (idx % 2 === 1 ? 1 : -1) + (row === 1 ? step * 0.5 : 0);
  return { yaw: Math.PI + off, r: row === 0 ? RACK_IN : RACK_OUT };
}

function buildHearth(mb: ModelBuilder): void {
  // Pentagonal pit wall: five stone segments with brick capstones.
  const outer = pentagon(PIT_OUT, TAU / 10);
  const inner = pentagon(PIT_IN, TAU / 10);
  const capO = pentagon(PIT_OUT + 0.07, TAU / 10);
  const capI = pentagon(PIT_IN - 0.05, TAU / 10);
  for (let k = 0; k < 5; k++) {
    const n = (k + 1) % 5;
    const seg: [number, number][] = [outer[k], outer[n], inner[n], inner[k]];
    mb.add('stone', extrudeUp(seg, PIT_H - 0.04, 0.02), 0, 0, 0);
    const cap: [number, number][] = [capO[k], capO[n], capI[n], capI[k]];
    mb.add('brick', extrudeUp(cap, 0.07, 0.01), 0, PIT_H, 0);
  }
  // Stock rack: two curved rows on posts, rails with holes for the poles.
  const steps = 14;
  for (const r of [RACK_IN, RACK_OUT]) {
    for (let i = 0; i < steps; i++) {
      const a0 = Math.PI - RACK_SPAN - 0.06 + ((RACK_SPAN * 2 + 0.12) * i) / steps;
      const a1 = Math.PI - RACK_SPAN - 0.06 + ((RACK_SPAN * 2 + 0.12) * (i + 1)) / steps;
      for (const y of [0.24, 0.7]) {
        mb.beam('wood', [Math.sin(a0) * r, y, Math.cos(a0) * r], [Math.sin(a1) * r, y, Math.cos(a1) * r], 0.08, 0.06);
      }
    }
  }
  for (let i = 0; i <= 4; i++) {
    const a = Math.PI - RACK_SPAN - 0.06 + ((RACK_SPAN * 2 + 0.12) * i) / 4;
    const s = Math.sin(a);
    const c = Math.cos(a);
    for (const r of [RACK_IN, RACK_OUT]) mb.rod('woodDark', [s * r, 0, c * r], [s * r, 0.8, c * r], 0.05, 6);
    mb.beam('woodDark', [s * RACK_IN, 0.08, c * RACK_IN], [s * RACK_OUT, 0.08, c * RACK_OUT], 0.07, 0.07);
  }

  // Five carved totems in a pentagon.
  const profile: THREE.Vector2[] = [];
  const ph = 1.55;
  for (let i = 0; i <= 16; i++) {
    const y = (i / 16) * ph;
    const r = 0.13 + Math.sin(i * 1.3) * 0.025 - (i / 16) * 0.03 + (i % 4 === 0 ? 0.025 : 0);
    profile.push(new THREE.Vector2(Math.max(0.05, r), y));
  }
  const bands = [0xe0453a, 0xf2b705, 0x2fa8a0, 0x7b4cc2, 0xe86fb0];
  for (let k = 0; k < 5; k++) {
    const a = (k * TAU) / 5 + TAU / 10;
    const x = Math.sin(a) * TOTEM_R;
    const z = Math.cos(a) * TOTEM_R;
    mb.add('woodPale', new THREE.LatheGeometry(profile, 10), x, 0, z);
    mb.add('paint', new THREE.TorusGeometry(0.15, 0.03, 6, 14), x, 0.45, z, Math.PI / 2, 0, 0, 1, 1, 1, bands[k]);
    mb.add('paint', new THREE.TorusGeometry(0.14, 0.03, 6, 14), x, 0.85, z, Math.PI / 2, 0, 0, 1, 1, 1, bands[(k + 2) % 5]);
    mb.add('trim', new THREE.TorusGeometry(0.125, 0.022, 6, 14), x, 1.25, z, Math.PI / 2, 0, 0);
    mb.rod('woodDark', [x, ph, z], [x, ph + 0.42, z], 0.018, 5);
    mb.add('clothStill', flagCloth(), x, ph + 0.3, z, 0, a + Math.PI / 2, 0, 0.26, 0.26, 0.26);
  }
}

function buildHearthCenter(mb: ModelBuilder): void {
  // Coal bed and charred logs leaning in a teepee around the pole.
  mb.add('ember', extrudeUp(pentagon(PIT_IN - 0.02, TAU / 10), 0.08, 0), 0, 0.03, 0);
  for (let k = 0; k < 5; k++) {
    const a = (k * TAU) / 5 + 0.3;
    const c = Math.cos(a);
    const s = Math.sin(a);
    mb.rod('woodDark', [c * 0.95, 0.14, s * 0.95], [c * 0.16, 0.9, s * 0.16], 0.07, 7);
  }
  // The flagpole, collars and finial.
  mb.cyl('wood', 0.055, 0.085, POLE_H, 0, POLE_H / 2, 0, 12);
  mb.cyl('brass', 0.11, 0.11, 0.08, 0, 1.05, 0, 14);
  mb.cyl('brass', 0.075, 0.075, 0.06, 0, POLE_H - 0.1, 0, 12);
  mb.add('brass', new THREE.SphereGeometry(0.13, 16, 12), 0, POLE_H + 0.08, 0);

}

/** Static model of the Flag Hearth (shared with its placement ghost). */
export const HEARTH_MODEL: ModelRecipe = { name: 'hearth', build: mb => { buildHearth(mb); buildHearthCenter(mb); } };

export class HearthView extends BuildingView {
  private readonly fire: Fire;
  private readonly center = new THREE.Group();
  private readonly target: FireStyle = createFireStyle();
  private readonly flag: THREE.Mesh;
  private readonly ribbon: THREE.Mesh;
  private readonly stockPoles: THREE.InstancedMesh;
  private readonly stockCloth: THREE.InstancedMesh;
  private readonly light: THREE.PointLight | null;
  private readonly attackerColor = new THREE.Color();
  private shownStock = -1;
  private shownWind = Number.NaN;
  private emberAcc = 0;
  private smokeAcc = 0;
  private frostAcc = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly lightColor = new THREE.Color();

  constructor(kit: StructureKit, b: Building, light: THREE.PointLight | null) {
    super(kit, b, POLE_H, 3.2);
    this.addStatic(kit.model('hearth-base', buildHearth));
    this.body.add(this.center);
    this.addStatic(kit.model('hearth-center', buildHearthCenter), this.center);
    this.fire = new Fire(kit, 3);
    this.fire.mesh.position.y = 0.1;
    this.body.add(this.fire.mesh);

    this.flag = new THREE.Mesh(kit.geometry('flagCloth', flagCloth), this.mats.get('cloth'));
    this.flag.scale.setScalar(2.3);
    this.flag.position.y = POLE_H - 0.95;
    this.flag.castShadow = true;
    this.ribbon = new THREE.Mesh(kit.geometry('pennant', pennantCloth), this.mats.get('trimCloth'));
    this.ribbon.scale.set(1.3, 0.55, 1);
    this.ribbon.position.y = POLE_H - 0.12;
    this.body.add(this.flag, this.ribbon);

    const pole = kit.geometry('stockPole', () => new THREE.CylinderGeometry(0.017, 0.02, 1.55, 6).translate(0, 0.775, 0));
    this.stockPoles = this.mats.instancedMesh(pole, 'woodDark', RACK_SLOTS, false);
    this.stockCloth = this.mats.instancedMesh(kit.geometry('flagCloth', flagCloth), 'cloth', RACK_SLOTS, true);
    this.stockPoles.count = 0;
    this.stockCloth.count = 0;
    this.body.add(this.stockPoles, this.stockCloth);

    // The pooled light stays a scene child (stable light count); it is moved here each frame.
    this.light = light;
  }

  protected override animate(b: Building, f: FrameInfo, active: boolean): void {
    void active;
    const seated = b.faction >= 0 && rtsThroneAltar(f.world, b.faction as FactionId)?.id === b.id;
    this.center.visible = !seated;
    this.flag.visible = this.ribbon.visible = this.fire.mesh.visible = !seated;
    const hs = b.hearth;
    const stage = hs ? hs.stage : 'safe';
    const fc = this.factionColor;
    const tgt = this.target;
    const t = f.t;
    if (hs && hs.attacker !== null) this.attackerColor.setHex(f.world.factions[hs.attacker].color);
    else this.attackerColor.copy(fc);
    const pressure = hs && hs.attacker !== null ? hs.pressure[hs.attacker] / 100 : 0;

    // Stage → target flame.
    tgt.core.copy(fc).lerp(WHITE, 0.65);
    tgt.body.copy(fc);
    tgt.streak.copy(this.attackerColor);
    tgt.split = 0;
    tgt.turb = 0.35;
    tgt.flicker = 0.08;
    tgt.intensity = 1;
    tgt.white = 0;
    tgt.width = 2.0;
    tgt.height = 2.7;
    if (stage === 'threatened') {
      tgt.core.copy(AMBER_CORE);
      tgt.body.copy(AMBER);
      tgt.streak.copy(fc);
      tgt.split = 0.25;
      tgt.turb = 0.75;
      tgt.flicker = 0.45;
      tgt.intensity = 1.05;
      tgt.height = 2.9;
    } else if (stage === 'contained') {
      tgt.split = 0.25 + 0.7 * pressure;
      tgt.turb = 0.6 + 0.7 * pressure;
      tgt.flicker = 0.2 + 0.2 * pressure;
      tgt.intensity = 1 + 0.5 * pressure;
      tgt.height = 2.7 + 1.5 * pressure;
      tgt.width = 2.0 + 0.4 * pressure;
    } else if (stage === 'contested') {
      tgt.split = 0.5;
      tgt.turb = 1.6;
      tgt.flicker = 0.55;
      tgt.intensity = 1.3;
      tgt.height = 3.4;
      tgt.width = 2.3;
    } else if (stage === 'overwritten') {
      tgt.core.copy(WHITE);
      tgt.body.copy(WHITE_HOT);
      tgt.white = 1;
      tgt.turb = 0.3;
      tgt.flicker = 0.1;
      tgt.intensity = 2.0;
      tgt.width = 0.95;
      tgt.height = 11;
    }
    const st = this.fire.style;
    dampFireStyle(st, tgt, stage === 'overwritten' ? 1.6 : 3, f.dt);
    if (stage === 'contested') {
      // Violent two-colour struggle: the colours wrestle for the body of the flame.
      st.split = 0.5 + 0.45 * Math.sin(t * 13 + Math.sin(t * 5.3) * 2);
      st.height = tgt.height + 0.5 * flickerNoise(t * 1.5, this.seed);
    }
    this.fire.apply();

    // Light: flame colour, flicker, mostly a night presence.
    if (this.light) {
      const flick = 1 + st.flicker * 0.5 * flickerNoise(t, this.seed) + 0.06 * Math.sin(t * 17);
      this.light.intensity = (4 + f.night * 36) * st.intensity * flick;
      this.lightColor.copy(st.body).lerp(st.core, 0.35).lerp(WHITE, st.white * 0.6);
      this.light.color.copy(this.lightColor);
      const rp = this.root.position;
      this.light.position.set(rp.x, rp.y + 1.9 + st.white * 3, rp.z);
    }

    // Embers, overwrite sparks and a thin smoke column.
    const p = this.root.position;
    this.emberAcc += seated ? 0 : f.dt * (5 + st.turb * 6 + st.white * 30);
    while (this.emberAcc >= 1) {
      this.emberAcc -= 1;
      const a = Math.random() * TAU;
      const r = Math.random() * 0.6 * (1 - st.white * 0.7);
      f.sparks.emit(
        p.x + Math.cos(a) * r,
        p.y + 0.5 + Math.random() * 0.6,
        p.z + Math.sin(a) * r,
        (Math.random() - 0.5) * 0.8,
        2 + Math.random() * 2.5 + st.white * 6,
        (Math.random() - 0.5) * 0.8,
        0.05 + Math.random() * 0.05,
        0.02,
        1.2 + Math.random() * 1.4,
        Math.random() < 0.5 ? st.body : st.core,
        1,
        0.6,
      );
    }
    this.smokeAcc += seated ? 0 : f.dt * 1.4;
    while (this.smokeAcc >= 1) {
      this.smokeAcc -= 1;
      f.smoke.emit(p.x, p.y + st.height * 0.9, p.z, 0.3, 0.8, 0.15, 0.6, 2.8, 4.5, SMOKE_GREY, 0.28, 0.25);
    }

    // The big Flag and the owner's ribbon fly downwind.
    const rel = f.windYaw - this.root.rotation.y;
    this.flag.rotation.y = rel;
    this.ribbon.rotation.y = rel;

    // Stock rack.
    const stock = f.stock.get(b.id) ?? 0;
    const shown = Math.min(RACK_SLOTS, stock);
    const windMoved = Number.isNaN(this.shownWind) || Math.abs(angleDiff(this.shownWind, rel)) > 0.03;
    if (shown !== this.shownStock || windMoved) this.layoutStock(shown, rel);
    const hoard = b.faction !== -1 && isHoarding(f.world, b.faction);
    // Only the racked stock freezes (its own instanced cloth); the Hearth's great Flag keeps flying.
    const amp = this.mats.uniform('cloth', 'uWaveAmp', true);
    if (amp) amp.value = hoard ? 0.012 : 0.07;
    if (hoard) {
      // Hoarding is villainy: the cold is the lack of activity.
      this.frostAcc += f.dt * 10;
      while (this.frostAcc >= 1) {
        this.frostAcc -= 1;
        const sl = rackSlot(Math.floor(Math.random() * shown));
        const yaw = sl.yaw + this.root.rotation.y;
        f.sparks.emit(
          p.x + Math.sin(yaw) * sl.r + (Math.random() - 0.5) * 0.6,
          p.y + 0.8 + Math.random() * 1.0,
          p.z + Math.cos(yaw) * sl.r + (Math.random() - 0.5) * 0.6,
          0,
          -0.15,
          0,
          0.05,
          0.03,
          2,
          FROST,
          0.8,
          0,
        );
      }
    }
  }

  private layoutStock(n: number, windRel: number): void {
    this.shownStock = n;
    this.shownWind = windRel;
    for (let i = 0; i < n; i++) {
      const sl = rackSlot(i);
      const x = Math.sin(sl.yaw) * sl.r;
      const z = Math.cos(sl.yaw) * sl.r;
      this.m.makeTranslation(x, 0.02, z);
      this.stockPoles.setMatrixAt(i, this.m);
      this.e.set(0, windRel, 0);
      this.q.setFromEuler(this.e);
      this.m.compose(this.p.set(x, 1.38, z), this.q, this.s.set(0.5, 0.5, 0.5));
      this.stockCloth.setMatrixAt(i, this.m);
    }
    this.stockPoles.count = n;
    this.stockCloth.count = n;
    this.stockPoles.instanceMatrix.needsUpdate = true;
    this.stockCloth.instanceMatrix.needsUpdate = true;
    this.stockPoles.computeBoundingSphere();
    this.stockCloth.computeBoundingSphere();
  }

  override dispose(): void {
    if (this.light) this.light.intensity = 0;
    this.fire.dispose();
    this.stockPoles.dispose();
    this.stockCloth.dispose();
    super.dispose();
  }
}
