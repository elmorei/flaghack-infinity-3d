/**
 * The Geomantic Command Center, after the 2017 cart: a black bevelled pentagonal body with
 * the yellow five-Flag pinwheel sigil spray-painted on its side panels, two big wooden cart
 * wheels whose spokes fly little yellow Flags, a push handle and the rolled Vexilloramanomicon
 * at the back, iron-strapped corners, two drum-top side tables with string-art pentagrams,
 * fairy lights under the table edge, two tall poles carrying the lettered yellow banner
 * (front: the four services; back: COMMAND CENTER / GEOMANTIC ADVICE), a faction pennant and a
 * Flag on the pole tops, a lantern, and the live miniature map as its tabletop.
 *
 * States: parked (faces its Hearth), pushed (wheels roll by distance, cart bobs, banner
 * snaps harder), Dialectics channel (golden motes spiral off the table), destroyed (tips
 * onto its side, a wheel rolls off, the mast snaps, lamps die, smoke), rebuilt (pops back
 * at the Hearth). At night a warm pool of light spills under the table.
 */
import * as THREE from 'three';
import { angleDiff } from '../../sim/math';
import type { GameEvent } from '../../sim/events';
import type { Building } from '../../sim/types';
import { BuildingView, SMOKE_GREY, SPARK_GOLD, type FrameInfo, type BuildingSpritePresentation } from './buildingView';
import type { ModelBuilder, ModelRecipe, StructureKit } from './kit';
import { extrudeUp, flagCloth, pennantCloth, pentagon } from './shapes';
import { GCC_TABLE_MAP_SIZE, GCC_TABLE_Y } from './tableMap';
import { damp, easeOutBack } from './util';
import { GccRecruitmentDome } from './gccRecruitmentDome';

const TAU = Math.PI * 2;
const BODY_R = 0.92;
const BODY_BOTTOM = 0.3;
const BODY_DEPTH = 0.6;
const BEVEL = 0.03;
const BODY_TOP = BODY_BOTTOM + BODY_DEPTH + BEVEL * 2;
const INRADIUS = BODY_R * Math.cos(Math.PI / 5);
const SLAB_TOP = 1.0;
const MAP_R = 0.86;
const LIP_R = 0.885;
const WHEEL_R = 0.5;
const AXLE_Z = -0.35;
const WHEEL_X = 0.99;
const POLE_X = 1.0;
const POLE_Z = -0.92;
const POLE_TOP = 3.35;
const MAST_PIVOT_Y = 0.45;
const BANNER_W = 1.9;
const BANNER_H = 0.95;
const BANNER_Y = 2.62;
const DRUM_R = 0.22;
const DRUM_OUT = BODY_R + DRUM_R + 0.05;
/** Pivot of the wreck roll: the cart's left bottom edge. */
const TIP_X = -0.95;

const WARM = new THREE.Color(1.0, 0.72, 0.42);
const MOTE = new THREE.Color(1.0, 0.85, 0.35);
const GLITCH_A = new THREE.Color(0.3, 1.0, 1.0);
const GLITCH_B = new THREE.Color(1.0, 0.3, 0.9);

/** Midpoint angle (yaw) of pentagon side k (between vertex k and k + 1). */
function sideYaw(k: number): number {
  return ((k + 0.5) * TAU) / 5;
}

function buildCart(mb: ModelBuilder): void {
  const verts = pentagon(BODY_R - BEVEL);
  // Body and tabletop slab.
  mb.add('black', extrudeUp(verts, BODY_DEPTH, BEVEL), 0, BODY_BOTTOM, 0);
  mb.add('black', extrudeUp(pentagon(0.95), SLAB_TOP - BODY_TOP - 0.024, 0.012), 0, BODY_TOP, 0);
  // Chassis plate and axle.
  mb.add('iron', extrudeUp(pentagon(0.78), 0.035, 0), 0, BODY_BOTTOM - 0.05, 0);
  mb.rod('iron', [-WHEEL_X - 0.05, WHEEL_R, AXLE_Z], [WHEEL_X + 0.05, WHEEL_R, AXLE_Z], 0.03, 10);
  for (const s of [-1, 1]) mb.box('iron', 0.12, 0.16, 0.14, s * 0.78, WHEEL_R, AXLE_Z);

  // Side panels: the sigil on four sides (the back carries the scroll), each in a raised frame.
  for (let k = 0; k < 5; k++) {
    if (k === 2) continue;
    const a = sideYaw(k);
    const sx = Math.sin(a);
    const sz = Math.cos(a);
    const d = INRADIUS + BEVEL + 0.006;
    const y = 0.62;
    mb.add('sigil', new THREE.PlaneGeometry(0.86, 0.46), sx * d, y, sz * d, 0, a, 0);
    mb.push(sx * (d + 0.004), y, sz * (d + 0.004), 0, a, 0);
    mb.box('black', 0.94, 0.035, 0.025, 0, 0.245, 0);
    mb.box('black', 0.94, 0.035, 0.025, 0, -0.245, 0);
    mb.box('black', 0.035, 0.52, 0.025, 0.455, 0, 0);
    mb.box('black', 0.035, 0.52, 0.025, -0.455, 0, 0);
    mb.pop();
  }
  // Iron corner straps with brass rivets.
  for (const [x, z] of pentagon(BODY_R + 0.004)) {
    mb.rod('iron', [x, BODY_BOTTOM + 0.02, z], [x, BODY_TOP - 0.01, z], 0.022, 6);
    for (const y of [BODY_BOTTOM + 0.08, 0.62, BODY_TOP - 0.08]) {
      mb.add('brass', new THREE.SphereGeometry(0.016, 8, 6), x * 1.012, y, z * 1.012);
    }
  }
  // Map lip (wood) with brass corner caps, and the faction trim under the slab edge.
  const lip = pentagon(LIP_R);
  const slab = pentagon(0.968);
  for (let k = 0; k < 5; k++) {
    const a = lip[k];
    const b = lip[(k + 1) % 5];
    mb.beam('wood', [a[0], SLAB_TOP + 0.024, a[1]], [b[0], SLAB_TOP + 0.024, b[1]], 0.07, 0.05);
    mb.cyl('brass', 0.035, 0.04, 0.06, a[0], SLAB_TOP + 0.03, a[1], 10);
    const c = slab[k];
    const d = slab[(k + 1) % 5];
    mb.beam('trim', [c[0], BODY_TOP - 0.006, c[1]], [d[0], BODY_TOP - 0.006, d[1]], 0.018, 0.016);
    // Fairy lights sagging under the slab edge.
    const bulbs = 5;
    let px = c[0];
    let py = BODY_TOP - 0.03;
    let pz = c[1];
    for (let i = 1; i <= bulbs; i++) {
      const t = i / (bulbs + 1);
      const x = (c[0] + (d[0] - c[0]) * t) * 1.01;
      const z = (c[1] + (d[1] - c[1]) * t) * 1.01;
      const y = BODY_TOP - 0.03 - Math.sin(t * Math.PI) * 0.06;
      mb.rod('rope', [px, py, pz], [x, y, z], 0.004, 3);
      mb.add('lamp', new THREE.SphereGeometry(0.02, 8, 6), x, y - 0.018, z);
      px = x;
      py = y;
      pz = z;
    }
    mb.rod('rope', [px, py, pz], [d[0], BODY_TOP - 0.03, d[1]], 0.004, 3);
  }

  // Drum-top side tables flanking the front, mounted off the front corner straps (clear of the sigils).
  for (const [k, top] of [
    [1, 'drumTopA'],
    [4, 'drumTopB'],
  ] as const) {
    const a = (k * TAU) / 5;
    const sx = Math.sin(a);
    const sz = Math.cos(a);
    const cx = sx * DRUM_OUT;
    const cz = sz * DRUM_OUT;
    const yc = 0.895;
    mb.cyl('paint', DRUM_R, DRUM_R * 0.94, 0.19, cx, yc, cz, 24, 0, 0, 0, k === 1 ? 0xb8283a : 0x1f7f86);
    const disc = new THREE.CircleGeometry(DRUM_R * 0.98, 32);
    mb.add(top, disc, cx, yc + 0.097, cz, -Math.PI / 2, 0, 0);
    for (const y of [yc + 0.09, yc - 0.09]) {
      mb.add('brass', new THREE.TorusGeometry(DRUM_R, 0.011, 6, 32), cx, y, cz, Math.PI / 2, 0, 0);
    }
    // Rope lacing zig-zag.
    for (let i = 0; i < 12; i++) {
      const a0 = (i / 12) * TAU;
      const a1 = ((i + 0.5) / 12) * TAU;
      const r = DRUM_R + 0.006;
      mb.rod('rope', [cx + Math.cos(a0) * r, yc + 0.08, cz + Math.sin(a0) * r], [cx + Math.cos(a1) * r, yc - 0.08, cz + Math.sin(a1) * r], 0.004, 3);
    }
    // Iron bracket arm and strut from the corner strap.
    const ix = sx * (BODY_R + 0.01);
    const iz = sz * (BODY_R + 0.01);
    mb.beam('iron', [ix, 0.79, iz], [cx, 0.79, cz], 0.04, 0.025);
    mb.rod('iron', [ix, 0.5, iz], [sx * (DRUM_OUT - 0.08), 0.79, sz * (DRUM_OUT - 0.08)], 0.012, 5);
  }

  // Push handle at the back.
  const back = -(INRADIUS + 0.02);
  for (const s of [-1, 1]) {
    mb.rod('woodDark', [s * 0.3, 0.62, back], [s * 0.33, 0.95, -1.38], 0.028, 8);
    mb.box('iron', 0.1, 0.12, 0.05, s * 0.3, 0.62, back - 0.02);
  }
  mb.rod('woodDark', [-0.4, 0.95, -1.38], [0.4, 0.95, -1.38], 0.03, 10);
  mb.rod('rope', [-0.22, 0.95, -1.38], [0.22, 0.95, -1.38], 0.036, 10);

  // The rolled Vexilloramanomicon on the back panel, partly unrolled.
  const sz = back - 0.09;
  mb.rod('parchment', [-0.36, 0.88, sz], [0.36, 0.88, sz], 0.06, 16);
  for (const s of [-1, 1]) {
    mb.add('wood', new THREE.SphereGeometry(0.045, 10, 8), s * 0.4, 0.88, sz);
    mb.box('iron', 0.04, 0.09, 0.11, s * 0.3, 0.86, back - 0.045);
  }
  mb.box('paint', 0.05, 0.125, 0.125, 0.12, 0.88, sz, 0, 0, 0, 0x9a1420);
  mb.add('parchment', new THREE.PlaneGeometry(0.62, 0.4), 0, 0.64, back - 0.034, 0, Math.PI, 0);
  mb.rod('parchment', [-0.31, 0.445, back - 0.05], [0.31, 0.445, back - 0.05], 0.022, 10);

  // Brackets holding the mast poles to the rear corners.
  const rear = pentagon(BODY_R);
  for (const s of [-1, 1]) {
    const corner = s > 0 ? rear[2] : rear[3];
    for (const y of [0.45, 0.88]) {
      mb.beam('iron', [corner[0], y, corner[1]], [s * POLE_X, y, POLE_Z], 0.03, 0.03);
      mb.cyl('iron', 0.05, 0.05, 0.07, s * POLE_X, y, POLE_Z, 10);
    }
  }
}

/** Poles, banner, lantern; built around the snap pivot (0, MAST_PIVOT_Y, POLE_Z). */
function buildMast(mb: ModelBuilder): void {
  const y0 = -MAST_PIVOT_Y;
  for (const s of [-1, 1]) {
    mb.rod('woodDark', [s * POLE_X, 0.12 + y0, 0], [s * POLE_X, POLE_TOP + y0, 0], 0.035, 8);
    mb.add('brass', new THREE.SphereGeometry(0.055, 12, 10), s * POLE_X, POLE_TOP + y0 + 0.04, 0);
    mb.cyl('brass', 0.0, 0.03, 0.09, s * POLE_X, POLE_TOP + y0 + 0.12, 0, 8);
    // Lashings from banner grommets to the pole.
    for (const t of [-0.45, 0, 0.45]) {
      const y = BANNER_Y + y0 + t * BANNER_H;
      mb.rod('rope', [s * (BANNER_W / 2 - 0.02), y, 0], [s * (POLE_X - 0.03), y, 0], 0.006, 3);
    }
  }
  mb.add('banner', new THREE.PlaneGeometry(BANNER_W, BANNER_H, 28, 10), 0, BANNER_Y + y0, 0);
  // Lantern on the left pole.
  const lx = -POLE_X + 0.16;
  const ly = 2.0 + y0;
  mb.beam('iron', [-POLE_X, ly + 0.2, 0], [lx, ly + 0.2, 0], 0.015, 0.015);
  mb.rod('iron', [lx, ly + 0.2, 0], [lx, ly + 0.12, 0], 0.005, 3);
  mb.cyl('iron', 0.0, 0.06, 0.05, lx, ly + 0.1, 0, 6);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    mb.rod('iron', [lx + Math.cos(a) * 0.045, ly + 0.08, Math.sin(a) * 0.045], [lx + Math.cos(a) * 0.045, ly - 0.06, Math.sin(a) * 0.045], 0.004, 3);
  }
  mb.cyl('iron', 0.05, 0.05, 0.015, lx, ly - 0.065, 0, 6);
  mb.add('lamp', new THREE.SphereGeometry(0.035, 10, 8), lx, ly, 0);
}

/** A cart wheel in its own frame: axle along x, wheel in the yz-plane. */
function buildWheel(mb: ModelBuilder): void {
  mb.add('paint', new THREE.TorusGeometry(0.455, 0.032, 8, 48), 0, 0, 0, 0, Math.PI / 2, 0, 1, 1, 1, 0x8a5a32);
  mb.add('paint', new THREE.TorusGeometry(0.49, 0.018, 6, 48), 0, 0, 0, 0, Math.PI / 2, 0, 1, 1, 1, 0x2a2a2c);
  mb.cyl('paint', 0.075, 0.075, 0.16, 0, 0, 0, 16, 0, 0, Math.PI / 2, 0x4a3020);
  mb.cyl('paint', 0.05, 0.062, 0.04, 0.1, 0, 0, 16, 0, 0, Math.PI / 2, 0xc9973a);
  const m = new THREE.Matrix4();
  const t = new THREE.Vector3();
  const d = new THREE.Vector3();
  const axis = new THREE.Vector3(-1, 0, 0);
  for (let k = 0; k < 10; k++) {
    const a = (k * TAU) / 10;
    const c = Math.cos(a);
    const s = Math.sin(a);
    mb.rod('paint', [0, c * 0.06, s * 0.06], [0, c * 0.44, s * 0.44], 0.014, 6, 0xa87a4f);
    // Little yellow Flag near the rim, all flying the same way: a pinwheel.
    d.set(0, c, s);
    t.set(0, -s, c);
    m.makeBasis(t, d, axis).setPosition(d.x * 0.36, d.y * 0.36, d.z * 0.36);
    mb.addMatrix('clothStill', new THREE.PlaneGeometry(0.17, 0.11).translate(0.085, 0, 0), m);
  }
}

/** Static model of the GCC cart (shared with its placement ghost). */
export const GCC_MODEL: ModelRecipe = { name: 'gcc', build: buildCart };

export class GccView extends BuildingView {
  private readonly recruitmentDome: GccRecruitmentDome;
  private readonly tip = new THREE.Group();
  private readonly cart = new THREE.Group();
  private readonly mast = new THREE.Group();
  private readonly wheelR = new THREE.Group();
  private readonly wheelL = new THREE.Group();
  private readonly pennant: THREE.Mesh;
  private readonly poleFlag: THREE.Mesh;
  private readonly table: THREE.Mesh;
  private readonly tableUv: THREE.BufferAttribute;
  private readonly tableVerts: [number, number][];
  private readonly pool: THREE.Mesh;
  private readonly poolMat: THREE.MeshBasicMaterial;
  private readonly tableMat: THREE.MeshStandardMaterial | null;
  private heading = 0;
  private uvHeading = Number.NaN;
  private lastX = Number.NaN;
  private lastZ = 0;
  private wheelAngle = 0;
  private freeSpin = 0;
  private speed = 0;
  private wreck = 0;
  private wrecked = false;
  private rebuildT = 1;
  private smokeAcc = 0;
  private moteAcc = 0;

  constructor(kit: StructureKit, b: Building) {
    super(kit, b, 3.4, 1.6);
    this.recruitmentDome = new GccRecruitmentDome(this.root);
    this.tip.position.x = TIP_X;
    this.cart.position.x = -TIP_X;
    this.body.add(this.tip);
    this.tip.add(this.cart);
    this.addStatic(kit.model(GCC_MODEL.name, GCC_MODEL.build), this.cart);

    this.mast.position.set(0, MAST_PIVOT_Y, POLE_Z);
    this.cart.add(this.mast);
    this.addStatic(kit.model('gccMast', buildMast), this.mast);

    const wheel = kit.model('gccWheel', buildWheel);
    this.wheelR.position.set(WHEEL_X, WHEEL_R, AXLE_Z);
    this.cart.add(this.wheelR);
    this.addStatic(wheel, this.wheelR);
    this.wheelL.rotation.order = 'YXZ';
    this.wheelL.rotation.y = Math.PI;
    this.wheelL.position.set(-WHEEL_X, WHEEL_R, AXLE_Z);
    this.body.add(this.wheelL);
    this.addStatic(wheel, this.wheelL);

    this.pennant = new THREE.Mesh(kit.geometry('pennant', pennantCloth), this.mats.get('trimCloth'));
    this.pennant.scale.set(0.6, 0.8, 1);
    this.pennant.position.set(POLE_X, POLE_TOP - MAST_PIVOT_Y - 0.16, 0);
    this.poleFlag = new THREE.Mesh(kit.geometry('flagCloth', flagCloth), this.mats.get('cloth'));
    this.poleFlag.scale.setScalar(0.42);
    this.poleFlag.position.set(-POLE_X, POLE_TOP - MAST_PIVOT_Y - 0.17, 0);
    this.mast.add(this.pennant, this.poleFlag);

    // Tabletop map: a pentagon whose UVs keep the map compass-true as the cart turns.
    this.tableVerts = pentagon(MAP_R);
    const pos = new Float32Array(6 * 3);
    const idx: number[] = [];
    for (let k = 0; k < 5; k++) {
      pos[(k + 1) * 3] = this.tableVerts[k][0];
      pos[(k + 1) * 3 + 2] = this.tableVerts[k][1];
      // Counter-clockwise seen from above so the face points up.
      idx.push(0, 1 + k, 1 + ((k + 1) % 5));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    this.tableUv = new THREE.BufferAttribute(new Float32Array(12), 2);
    geo.setAttribute('uv', this.tableUv);
    geo.setIndex(idx);
    const tableMat = this.mats.get('table');
    this.tableMat = tableMat instanceof THREE.MeshStandardMaterial ? tableMat : null;
    if (this.tableMat && kit.tableTexture) {
      this.tableMat.emissiveMap = kit.tableTexture;
      this.tableMat.emissive.setRGB(0, 0, 0);
    }
    this.table = new THREE.Mesh(geo, tableMat);
    this.table.position.y = GCC_TABLE_Y;
    this.table.receiveShadow = true;
    this.cart.add(this.table);

    // Night light pool on the ground (additive decal, no real light).
    this.poolMat = new THREE.MeshBasicMaterial({
      map: kit.texture('glow'),
      color: WARM,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.pool = new THREE.Mesh(kit.geometry('groundQuad', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), this.poolMat);
    this.pool.scale.setScalar(5.6);
    this.pool.position.y = 0.04;
    this.pool.renderOrder = 1;
    this.root.add(this.pool);
  }

  protected override place(b: Building, f: FrameInfo): void {
    const gy = f.ctx.shared.groundOffset?.(b.pos.x, b.pos.z) ?? 0;
    if (Number.isNaN(this.lastX) || Math.hypot(b.pos.x - this.lastX, b.pos.z - this.lastZ) > 3) {
      // First sight or rebuilt at the Hearth: park facing the camp.
      const hearth = b.faction !== -1 ? f.world.hearthOf(b.faction) : undefined;
      this.heading = hearth ? Math.atan2(hearth.pos.x - b.pos.x, hearth.pos.z - b.pos.z) : b.yaw;
      this.speed = 0;
    } else {
      const dx = b.pos.x - this.lastX;
      const dz = b.pos.z - this.lastZ;
      const d = Math.hypot(dx, dz);
      if (d > 1e-4) {
        const motion = Math.atan2(dx, dz);
        const fwd = Math.cos(angleDiff(this.heading, motion));
        // Pushed from behind, the front leads; a backward nudge just rolls the wheels back.
        if (fwd > -0.3) this.heading += angleDiff(this.heading, motion) * (1 - Math.exp(-5 * f.dt));
        this.wheelAngle += (fwd >= 0 ? d : -d) / WHEEL_R;
      }
      this.speed = damp(this.speed, f.dt > 0 ? d / f.dt : 0, 8, f.dt);
    }
    this.lastX = b.pos.x;
    this.lastZ = b.pos.z;
    this.root.position.set(b.pos.x, gy, b.pos.z);
    this.root.rotation.y = this.heading;
  }

  protected override animate(b: Building, f: FrameInfo, active: boolean): void {
    this.recruitmentDome.update(b, f.world);
    const gcc = b.gcc;
    // Collapsed from the moment it falls until the sim actually rebuilds it (destroyedUntil reset to 0).
    const destroyed = !!gcc && gcc.destroyedUntil !== 0;
    const u = this.mats.u;
    if (destroyed && !this.wrecked) {
      this.wrecked = true;
      this.wreck = 0;
      this.burst(f.smoke, SMOKE_GREY, 18, 0.8, 2, 0.8, 0.5);
    } else if (!destroyed && this.wrecked) {
      this.wrecked = false;
      this.wreck = 0;
      this.rebuildT = 0;
      this.burst(f.sparks, SPARK_GOLD, 40, 1.2, 3, 0.2, 0);
    }
    if (this.wrecked) this.wreck = Math.min(1, this.wreck + f.dt / 0.9);
    this.poseWreck(this.wrecked ? this.wreck : 0);
    if (this.rebuildT < 1) {
      this.rebuildT = Math.min(1, this.rebuildT + f.dt / 0.8);
      this.body.scale.setScalar(Math.max(0.05, easeOutBack(this.rebuildT)));
    }
    if (this.wrecked) {
      u.uDarken.value = 0.45;
      u.uFlicker.value = 0;
      u.uDamage.value = 1;
      this.smokeAcc += f.dt * 4;
      while (this.smokeAcc >= 1) {
        this.smokeAcc -= 1;
        const p = this.root.position;
        f.smoke.emit(
          p.x + (Math.random() - 0.5) * 1.6,
          p.y + 0.4,
          p.z + (Math.random() - 0.5) * 1.6,
          0.2,
          0.8,
          0.1,
          0.5,
          2.4,
          3.5,
          SMOKE_GREY,
          0.5,
          0.25,
        );
      }
    }

    // Rolling and pushing.
    const pushed = !!gcc && gcc.pushedBy !== -1 && !this.wrecked;
    const roll = this.speed > 0.05 ? 1 : 0;
    this.cart.position.y = roll * Math.abs(Math.sin(this.wheelAngle * 2)) * 0.012;
    this.cart.rotation.z = roll * Math.sin(this.wheelAngle) * 0.012;
    this.wheelR.rotation.x = this.wrecked ? this.freeSpin : this.wheelAngle;
    if (!this.wrecked) this.wheelL.rotation.x = -this.wheelAngle;
    this.freeSpin += f.dt * (this.wrecked ? 1.2 * (1 - this.wreck * 0.6) : 0);
    const bannerAmp = this.mats.uniform('banner', 'uWaveAmp');
    if (bannerAmp) bannerAmp.value = damp(bannerAmp.value, pushed ? 0.11 : this.wrecked ? 0.015 : 0.05, 3, f.dt);

    // Pennant and pole Flag fly downwind (relative to the cart and the snapped mast).
    const mastYaw = this.root.rotation.y;
    this.pennant.rotation.y = f.windYaw - mastYaw;
    this.poleFlag.rotation.y = f.windYaw - mastYaw;

    // Table: compass-true UVs, night glow, Dialectics channel shimmer.
    if (this.heading !== this.uvHeading) this.updateTableUv();
    const channel = !!gcc && gcc.channelUntil > f.world.time;
    if (this.tableMat) {
      const glow = this.wrecked ? 0 : f.night * 0.18 + (channel ? 0.35 + 0.25 * Math.sin(f.t * 9) : 0);
      this.tableMat.emissive.setRGB(glow, glow * 0.85, glow * 0.6);
    }
    if (channel && active) {
      this.moteAcc += f.dt * 30;
      const p = this.root.position;
      while (this.moteAcc >= 1) {
        this.moteAcc -= 1;
        const a = f.t * 3 + Math.random() * TAU;
        const r = 0.3 + Math.random() * 0.5;
        f.sparks.emit(p.x + Math.cos(a) * r, p.y + GCC_TABLE_Y + 0.05, p.z + Math.sin(a) * r, -Math.sin(a) * 1.2, 1.4 + Math.random(), Math.cos(a) * 1.2, 0.09, 0.02, 1.4, MOTE, 0.9, 0.3);
      }
    }

    // Warm pool of light under the table after dusk.
    this.poolMat.opacity = this.wrecked ? 0 : f.night * 0.5 * this.body.scale.y;
  }

  protected override spritePresentation(b: Building, f: FrameInfo, active: boolean): BuildingSpritePresentation {
    const channel = active && !!b.gcc && b.gcc.channelUntil > f.world.time;
    const moving = active && this.speed > 0.05;
    return {
      state: this.wrecked ? 'wreck' : channel ? 'channel' : moving ? 'moving' : 'idle',
      moving: active && !this.wrecked,
      // The wreck clip already includes the tipped cart and snapped mast. Rotating
      // that whole image again would double the fall and move it off its contact.
      rotation: this.body.rotation.z,
      highlight: channel ? 0.5 + Math.sin(f.t * 9) * 0.25 : 0,
    };
  }

  /** Blend between the standing cart (w = 0) and the wreck (w = 1). */
  private poseWreck(w: number): void {
    // Fall: accelerate over, then a small settling bounce.
    const fall = w < 0.6 ? (w / 0.6) * (w / 0.6) : 1 - Math.sin(((w - 0.6) / 0.4) * Math.PI) * 0.08;
    this.tip.rotation.z = fall * 1.22;
    this.tip.position.y = -fall * 0.06;
    this.mast.rotation.x = fall * 1.05;
    this.mast.rotation.z = -fall * 0.35;
    // The left wheel breaks off and lies flat in the dirt beside the wreck.
    const off = Math.min(1, w * 1.4);
    this.wheelL.position.set(-WHEEL_X - off * 0.75, WHEEL_R * (1 - off) + off * 0.035, AXLE_Z + off * 0.55);
    this.wheelL.rotation.z = off * (Math.PI / 2);
    if (w > 0) this.wheelL.rotation.x = -this.wheelAngle - off * 2.4;
  }

  private updateTableUv(): void {
    this.uvHeading = this.heading;
    const c = Math.cos(this.heading);
    const s = Math.sin(this.heading);
    const uv = this.tableUv;
    uv.setXY(0, 0.5, 0.5);
    for (let k = 0; k < 5; k++) {
      const [lx, lz] = this.tableVerts[k];
      const wx = lx * c + lz * s;
      const wz = -lx * s + lz * c;
      uv.setXY(k + 1, 0.5 + wx / GCC_TABLE_MAP_SIZE, 0.5 - wz / GCC_TABLE_MAP_SIZE);
    }
    uv.needsUpdate = true;
  }

  override onEvent(e: GameEvent, f: FrameInfo): void {
    super.onEvent(e, f);
    if (e.t !== 'gccAction' || e.gccId !== this.id) return;
    const p = this.root.position;
    const n = e.action === 'dialectics' ? 50 : 26;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = 1 + Math.random() * 2.5;
      const col = e.action === 'simulacra' ? (i % 2 === 0 ? GLITCH_A : GLITCH_B) : MOTE;
      f.sparks.emit(p.x, p.y + GCC_TABLE_Y + 0.1, p.z, Math.cos(a) * sp, 1.5 + Math.random() * 2, Math.sin(a) * sp, 0.12, 0.03, 1.1, col, 1, -1.5);
    }
  }

  override dispose(): void {
    this.recruitmentDome.dispose();
    this.poolMat.dispose();
    this.table.geometry.dispose();
    super.dispose();
  }
}
