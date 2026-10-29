/**
 * Hippie crowd: every hippie is one instance of the merged hippie model. Per frame each
 * hippie's displayed position eases toward its sim position (no tick jitter), facing turns
 * smoothly, the D.E.G.E.N. status picks a procedural animation that is blended into a
 * 16-joint pose, and look/variant data (tie-dye seed, skin, hair, hats, glasses, held prop,
 * faction bandana) is written to instanced attributes.
 *
 * Two levels of detail sharing one material: the detailed model in view within
 * HIPPIE_DETAIL_RANGE and the coarse model elsewhere; only hippies near the eye cast shadows
 * and those off screen and far away are skipped (one draw each, plus their shadow draws).
 * Also emits: the over-the-shoulder Flag of carriers, faction/selection rings, status badges
 * (own mesh; rivals only when tapped or under Acid Cop Vision) and head anchors.
 */
import * as THREE from 'three';
import type { GameEvent } from '../../sim/events';
import { angleDiff } from '../../sim/math';
import { NEUTRAL } from '../../sim/types';
import type { EntityId, Hippie } from '../../sim/types';
import type { RenderContext } from '../context';
import type { FlagRenderer } from './flagRenderer';
import {
  BEAT_ANIMS,
  JOG_CYCLE,
  RUN_CYCLE,
  applyHippieEffects,
  beatHippie,
  hippieAnimFor,
  poseHippie,
  propFor,
  type HippieAnim,
  type HippieRoot,
} from './hippieAnim';
import {
  HAIR_STYLES,
  HIPPIE_HEAD_TOP,
  HJ,
  HL,
  HP,
  POSE_SIZE,
  buildHippieFarGeometry,
  buildHippieGeometry,
  patchHippieMaterial,
  type HippieUniforms,
} from './hippieModel';
import { InstanceSet, PLACE, castShadowPrefix, showInstances, type ActorView } from './lod';
import { RING, STATUS_ICON, type StatusIcons, type UnitRings } from './overlays';
import { clamp01, damp, hash01b, writeTransform } from './util';

const INITIAL_CAPACITY = 256;
const SNAP_DIST2 = 16;
const ICON_SIZE = 0.26;
/** Detailed model within this distance of the eye (beyond: ~25 px tall). */
const HIPPIE_DETAIL_RANGE = 40;
/** Bounding sphere about the hips; covers raised arms, carried planks and a hippie lying down. */
const HIPPIE_MID_Y = 0.9;
const HIPPIE_RADIUS = 2;

/** One level of detail: its model, its instances and its mesh. */
interface HippieLevel {
  /** Instance attributes: matrix (16), aPose (16), aLook (16). */
  set: InstanceSet;
  geometry: THREE.BufferGeometry;
  mesh: THREE.InstancedMesh;
  /** InstanceSet generation currently bound to the mesh. */
  bound: number;
}

interface HippieVis {
  x: number;
  z: number;
  yaw: number;
  speed: number;
  phase: number;
  anim: HippieAnim;
  pose: Float32Array;
  root: HippieRoot;
  seed: number;
  scale: number;
  look: Float32Array;
  flashAt: number;
  joinedAt: number;
  seen: number;
  anchor: THREE.Vector3;
  /** Drawn at full detail last frame (level-of-detail hysteresis). */
  detailed: boolean;
  /** Smoothed 0..1 weight of the beat-locked layer, and the animation it belongs to. */
  groove: number;
  beatAnim: HippieAnim;
}

/** Hat id from a uniform roll: bare 34%, headband 20%, flower crown 14%, bucket 12%, top hat 8%, beanie 12%. */
function pickHat(r: number): number {
  if (r < 0.34) return 0;
  if (r < 0.54) return 1;
  if (r < 0.68) return 2;
  if (r < 0.8) return 3;
  if (r < 0.88) return 4;
  return 5;
}

export class HippieRenderer {
  private readonly ctx: RenderContext;
  private readonly view: ActorView;
  private readonly flags: FlagRenderer;
  private readonly rings: UnitRings;
  private readonly icons: StatusIcons;
  private readonly anchors: Map<EntityId, THREE.Vector3>;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly depthMaterial: THREE.MeshDepthMaterial;
  private readonly uniforms: HippieUniforms;
  private readonly levels: HippieLevel[];
  private readonly vis = new Map<EntityId, HippieVis>();
  private frame = 0;
  private readonly target = new Float32Array(POSE_SIZE);
  private readonly targetRoot: HippieRoot = { bob: 0, pitch: 0, roll: 0, yaw: 0 };
  /** Beat-locked layer and the displayed pose (smoothed pose + layer) for the current hippie. */
  private readonly layer = new Float32Array(POSE_SIZE);
  private readonly layerRoot: HippieRoot = { bob: 0, pitch: 0, roll: 0, yaw: 0 };
  private readonly shown = new Float32Array(POSE_SIZE);
  /** The instance transform being built (column-major), before it is copied to its level. */
  private readonly m16 = new Float32Array(16);
  private readonly factionColors: THREE.Color[];
  private readonly white = new THREE.Color(1, 1, 1);
  private readonly mRoot = new THREE.Matrix4();
  private readonly mTorso = new THREE.Matrix4();
  private readonly mPivot = new THREE.Matrix4();
  private readonly mFlag = new THREE.Matrix4();
  private readonly carryLocal = new THREE.Matrix4();
  private readonly plantLocal = new THREE.Matrix4();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly waist = new THREE.Vector3(HP.waist[0], HP.waist[1], HP.waist[2]);

  constructor(
    ctx: RenderContext,
    view: ActorView,
    flags: FlagRenderer,
    rings: UnitRings,
    icons: StatusIcons,
    anchors: Map<EntityId, THREE.Vector3>,
  ) {
    this.ctx = ctx;
    this.view = view;
    this.flags = flags;
    this.rings = rings;
    this.icons = icons;
    this.anchors = anchors;
    this.factionColors = ctx.world.factions.map((f) => new THREE.Color(f.color));
    this.uniforms = { uTime: { value: 0 }, uFactionGlow: { value: 0.3 } };
    this.material = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85 });
    this.depthMaterial = new THREE.MeshDepthMaterial();
    patchHippieMaterial(this.material, this.uniforms, false);
    patchHippieMaterial(this.depthMaterial, this.uniforms, true);
    this.levels = [this.makeLevel(buildHippieGeometry(), 'actors-hippies'), this.makeLevel(buildHippieFarGeometry(), 'actors-hippies-far')];

    // Over-the-shoulder carry: the pole rests on the right shoulder, held low in the right hand.
    const hand = new THREE.Vector3(-0.11, 0.99, 0.37);
    const shoulder = new THREE.Vector3(-0.2, 1.47, -0.02);
    const ay = shoulder.clone().sub(hand).normalize();
    const back = new THREE.Vector3(0, 0, -1);
    const ax = back.clone().addScaledVector(ay, -back.dot(ay)).normalize();
    const az = new THREE.Vector3().crossVectors(ax, ay);
    this.carryLocal
      .makeBasis(ax, ay, az)
      .scale(new THREE.Vector3(0.8, 0.8, 0.8))
      .setPosition(hand.clone().addScaledVector(ay, -0.55));
    // Planting: the Flag stands upright in front of the kneeling hippie, cloth trailing back.
    this.plantLocal.makeRotationY(Math.PI / 2).scale(new THREE.Vector3(0.85, 0.85, 0.85));
  }

  onEvent(e: GameEvent): void {
    const t = this.ctx.time;
    if (e.t === 'hit') {
      const v = this.vis.get(e.target);
      if (v) v.flashAt = t;
    } else if (e.t === 'recruited') {
      const v = this.vis.get(e.hippieId);
      if (v) v.joinedAt = t;
    }
  }

  update(dt: number): void {
    const ctx = this.ctx;
    const w = ctx.world;
    const t = ctx.time;
    const session = ctx.session;
    this.frame++;
    this.uniforms.uTime.value = t;
    this.uniforms.uFactionGlow.value = 0.3 + 0.6 * (1 - ctx.daylight);
    const groundAt = ctx.shared.groundOffset;
    const pf = session.playerFaction;
    const player = w.factions[pf];
    const acid = player.drugActive.acidcop > w.time;
    const hover = session.hover.entity;
    const m16 = this.m16;
    const beat = ctx.beat;
    for (const level of this.levels) level.set.begin();

    for (const h of w.hippies.values()) {
      // The unique wizard has a separate full robe/hat silhouette, not a second crowd body.
      if (h.id === w.frickFrack?.wizardId) continue;
      const v = this.vis.get(h.id) ?? this.create(h);
      v.seen = this.frame;

      // Ease toward the sim position; snap on respawn/teleport.
      const dx = h.pos.x - v.x;
      const dz = h.pos.z - v.z;
      let moved = 0;
      if (dx * dx + dz * dz > SNAP_DIST2) {
        v.x = h.pos.x;
        v.z = h.pos.z;
      } else {
        const k = damp(14, dt);
        v.x += dx * k;
        v.z += dz * k;
        moved = Math.hypot(dx * k, dz * k);
      }
      v.speed += (moved / Math.max(dt, 1e-3) - v.speed) * damp(8, dt);
      v.yaw += angleDiff(v.yaw, h.facing) * damp(10, dt);

      const anim = hippieAnimFor(h, v.speed);
      v.anim = anim;
      const run = anim === 'run' || anim === 'flee';
      v.phase += (moved / (run ? RUN_CYCLE : JOG_CYCLE)) * Math.PI * 2;
      const gait = clamp01(v.speed / 2.5);
      const tr = this.targetRoot;
      poseHippie(anim, t + v.seed * 10, v.phase, gait, v.seed, this.target, tr);
      let stun = false;
      let wobble = false;
      let jitter = false;
      let knock = false;
      let buff = 0;
      for (const e of h.effects) {
        if (e.until <= w.time) continue;
        if (e.kind === 'stun') stun = true;
        else if (e.kind === 'wobble') wobble = true;
        else if (e.kind === 'overstimulated' || e.kind === 'psychosis') jitter = true;
        else if (e.kind === 'knockback') knock = true;
        else if (e.kind === 'saffron' || e.kind === 'march' || e.kind === 'beacon') buff = 1;
      }
      if (stun || wobble || jitter || knock) applyHippieEffects(this.target, tr, t, v.seed, stun, wobble, jitter, knock);

      const kp = damp(anim === 'ko' ? 6 : 16, dt);
      const pose = v.pose;
      for (let j = 0; j < POSE_SIZE; j++) pose[j] += (this.target[j] - pose[j]) * kp;
      const root = v.root;
      root.bob += (tr.bob - root.bob) * kp;
      root.pitch += (tr.pitch - root.pitch) * kp;
      root.roll += (tr.roll - root.roll) * kp;
      root.yaw += angleDiff(root.yaw, tr.yaw) * kp;

      // The beat-locked layer is added after smoothing, which would make it lag the kick.
      const grooving = BEAT_ANIMS[anim] === true;
      if (grooving) v.beatAnim = anim;
      v.groove += ((grooving ? 1 : 0) - v.groove) * damp(5, dt);
      const shown = this.shown;
      shown.set(pose);
      let bob = root.bob;
      let pitch = root.pitch;
      let roll = root.roll;
      if (v.groove > 0.002) {
        const g = v.groove;
        const layer = this.layer;
        const lr = this.layerRoot;
        beatHippie(v.beatAnim, beat, v.seed, layer, lr);
        for (let j = 0; j < POSE_SIZE; j++) shown[j] += layer[j] * g;
        bob += lr.bob * g;
        pitch += lr.pitch * g;
        roll += lr.roll * g;
      }

      // Instance data: transform, pose, look.
      const gy = groundAt ? groundAt(v.x, v.z) : 0;
      const airborneY = Math.max(0, h.airborne?.y ?? 0);
      writeTransform(m16, 0, v.x, gy + airborneY + bob * v.scale, v.z, v.yaw + root.yaw, pitch, roll, v.scale);
      const look = v.look;
      look[HL.prop] = propFor(anim, h);
      const fc = h.faction === NEUTRAL ? this.white : this.factionColors[h.faction];
      look[HL.factionR] = fc.r;
      look[HL.factionG] = fc.g;
      look[HL.factionB] = fc.b;
      look[HL.factionOn] = h.faction === NEUTRAL ? 0 : 1;
      const flash = clamp01(1 - (t - v.flashAt) / 0.18);
      look[HL.flash] = Math.max(flash, h.id === hover ? 0.18 : 0);
      look[HL.buff] = buff * (0.6 + 0.4 * Math.sin(t * 5 + v.seed * 6));
      const place = this.view.place(v.x, gy + airborneY + HIPPIE_MID_Y, v.z, HIPPIE_RADIUS, HIPPIE_DETAIL_RANGE, v.detailed);
      v.detailed = place === PLACE.detailed;
      if (place !== PLACE.skip) {
        const set = this.levels[v.detailed ? 0 : 1].set;
        const slot = place === PLACE.coarse ? set.plain() : set.caster();
        const attrs = set.attrs;
        attrs[0].array.set(m16, slot * 16);
        attrs[1].array.set(shown, slot * POSE_SIZE);
        attrs[2].array.set(look, slot * 16);
      }

      // Torso pivot (same maths as the shader) for anchors and the carried Flag.
      this.mRoot.fromArray(m16);
      this.euler.set(shown[HJ.torsoPitch], shown[HJ.torsoYaw], shown[HJ.torsoRoll], 'YXZ');
      this.mTorso.makeRotationFromEuler(this.euler);
      this.mPivot.makeTranslation(this.waist.x, this.waist.y, this.waist.z).multiply(this.mTorso);
      this.mPivot.multiply(this.mTorso.makeTranslation(-this.waist.x, -this.waist.y, -this.waist.z));
      this.mPivot.premultiply(this.mRoot);
      v.anchor.set(0, HIPPIE_HEAD_TOP - 0.1, 0).applyMatrix4(this.mPivot);

      if (h.carryingFlag >= 0) {
        const f = w.flags.get(h.carryingFlag);
        const ribbon = this.flags.ribbonColor(f ? f.owner : h.faction);
        const ph = hash01b(h.carryingFlag, 3);
        if (anim === 'kneel') {
          const push = -0.12 + 0.05 * Math.sin(t * 7 + v.seed * 4);
          this.mFlag.makeTranslation(0, 0.42 + push, 0.42).multiply(this.plantLocal).premultiply(this.mRoot);
          this.flags.pushMatrix(this.mFlag, ph, this.flags.windStrength * 0.8, 0, 0.2, 0, ribbon);
        } else {
          this.mFlag.copy(this.mPivot).multiply(this.carryLocal);
          this.flags.pushMatrix(this.mFlag, ph, 0.45 + Math.min(1, v.speed / 8) * 0.6, Math.min(0.35, v.speed / 16), 0.1, 0, ribbon);
        }
      }
      if (h.status === 'pulling' && h.statusTarget) {
        const node = w.lattice.nearestNode(h.statusTarget.x, h.statusTarget.z, 1.5);
        const fid = node >= 0 ? w.survey.nodeFlag[node] : -1;
        if (fid >= 0) this.flags.markPulling(fid, 0.5 + 0.5 * Math.sin(t * 3 + v.seed));
      }

      // Rings: faction identity, selection, recruitment flourish.
      const ringY = gy + 0.03;
      if (h.faction !== NEUTRAL) {
        const ko = anim === 'ko' ? 0.35 : 1;
        this.rings.push(v.x, ringY, v.z, 0.5 * v.scale, fc, 0.75 * ko, RING.hippie, 0);
      }
      if (session.selection.has(h.id)) this.rings.push(v.x, ringY + 0.005, v.z, 0.72, fc, 1, RING.selected, v.seed);
      if (t - v.joinedAt < 1.2) this.rings.push(v.x, ringY + 0.01, v.z, 1.6, fc, 1.4 * (1 - (t - v.joinedAt) / 1.2), RING.pulse, 0);

      // D.E.G.E.N. badge: own mesh always; rivals only when tapped or through Acid Cop Vision.
      if (h.beacon && h.faction !== NEUTRAL) {
        const visible = h.faction === pf || acid || (player.meshTap[h.faction] ?? 0) > w.time;
        if (visible) {
          this.icons.push(v.anchor.x, v.anchor.y + 0.42, v.anchor.z, ICON_SIZE, STATUS_ICON[h.status], 1, clamp01(h.attention / 100), fc, 0);
        }
      }
    }

    for (const level of this.levels) {
      level.set.finish();
      if (level.bound !== level.set.generation) this.bind(level);
      showInstances(level.mesh, level.set, this.view.shadows);
    }

    if (this.frame % 60 === 0) {
      for (const [id, v] of this.vis) {
        if (v.seen === this.frame) continue;
        this.vis.delete(id);
        this.anchors.delete(id);
      }
    }
  }

  dispose(): void {
    for (const level of this.levels) {
      this.ctx.scene.remove(level.mesh);
      level.mesh.dispose();
      level.geometry.dispose();
    }
    this.material.dispose();
    this.depthMaterial.dispose();
    for (const id of this.vis.keys()) this.anchors.delete(id);
    this.vis.clear();
  }

  private create(h: Hippie): HippieVis {
    const s = h.look;
    const look = new Float32Array(16);
    const hair = Math.floor(hash01b(s, 5) * HAIR_STYLES);
    let hat = pickHat(hash01b(s, 6));
    // An afro does not fit under a hat; it gets a headband instead.
    if (hair === 2 && hat >= 3) hat = 1;
    const g = hash01b(s, 7);
    look[HL.shirtSeed] = hash01b(s, 1);
    look[HL.skin] = hash01b(s, 2);
    look[HL.hairColor] = hash01b(s, 3);
    look[HL.pants] = hash01b(s, 4);
    look[HL.hairStyle] = hair;
    look[HL.hat] = hat;
    look[HL.glasses] = g < 0.12 ? 1 : g < 0.3 ? 2 : 0;
    look[HL.beard] = hash01b(s, 8) < 0.28 ? 1 : 0;
    look[HL.hatSeed] = hash01b(s, 9);
    const v: HippieVis = {
      x: h.pos.x,
      z: h.pos.z,
      yaw: h.facing,
      speed: 0,
      phase: hash01b(s, 11) * Math.PI * 2,
      anim: 'idle',
      pose: new Float32Array(POSE_SIZE),
      root: { bob: 0, pitch: 0, roll: 0, yaw: 0 },
      seed: hash01b(s, 12),
      scale: 0.92 + hash01b(s, 10) * 0.16,
      look,
      flashAt: -10,
      joinedAt: -10,
      seen: this.frame,
      anchor: new THREE.Vector3(h.pos.x, HIPPIE_HEAD_TOP, h.pos.z),
      detailed: false,
      groove: 0,
      beatAnim: 'dance',
    };
    this.vis.set(h.id, v);
    this.anchors.set(h.id, v.anchor);
    return v;
  }

  private makeLevel(geometry: THREE.BufferGeometry, name: string): HippieLevel {
    const set = new InstanceSet([16, POSE_SIZE, 16], INITIAL_CAPACITY);
    const mesh = new THREE.InstancedMesh(geometry, this.material, 1);
    mesh.name = name;
    mesh.customDepthMaterial = this.depthMaterial;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.count = 0;
    castShadowPrefix(mesh, set);
    this.ctx.scene.add(mesh);
    const level: HippieLevel = { set, geometry, mesh, bound: -1 };
    this.bind(level);
    return level;
  }

  /** Point a level's mesh at its current instance attributes (after creation or growth). */
  private bind(level: HippieLevel): void {
    const attrs = level.set.attrs;
    level.mesh.dispose();
    level.geometry.dispose();
    level.mesh.instanceMatrix = attrs[0];
    level.geometry.setAttribute('aPose', attrs[1]);
    level.geometry.setAttribute('aLook', attrs[2]);
    level.bound = level.set.generation;
  }
}
