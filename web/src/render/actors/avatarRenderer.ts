/**
 * Vexillomancer avatars: one SkinnedMesh per faction animated procedurally from sim state.
 * Upper body follows the aim yaw while the hips turn toward the run direction; layers for
 * idle personality (mystic Beef, bird-like Crow, grooving Scarecrow, stately Jaguar), run
 * cycle, jump/fall/landing, staff swing (with trail), throw whip, plant crouch, pull tug,
 * chakra align / Dialectics channels (aura + levitation), Hold the Hearth (staff planted and
 * a contest aura, derived from capture's own rule since the sim treats it as passive), GCC
 * pushing, hit flinch, stun, and KO collapse → dissolve → hidden → materialize on respawn.
 * The quiver bundle on the back shows one small Flag per carried Flag. Acid Cop Vision shows
 * rival avatars through walls. Online, each human seat's handle floats above its avatar.
 */
import * as THREE from 'three';
import { AVATAR, CAPTURE } from '../../sim/constants';
import type { GameEvent } from '../../sim/events';
import { angleDiff, dist2 } from '../../sim/math';
import type { Avatar, AvatarAction, EntityId, FactionId } from '../../sim/types';
import type { RenderContext } from '../context';
import { AvatarFx } from './avatarFx';
import { BONE_NAMES, STAFF_TOP, buildAvatarRig, createAvatarMaterial, type AvatarRig, type AvatarUniforms } from './avatarModels';
import type { FlagRenderer } from './flagRenderer';
import type { ActorView } from './lod';
import type { Nameplates } from './nameplates';
import { RING, type UnitRings } from './overlays';
import { bump, clamp01, damp, easeOutCubic, hash01, kickDip } from './util';

const NB = BONE_NAMES.length;
const ROOT = BONE_NAMES.indexOf('root');
const HIPS = BONE_NAMES.indexOf('hips');
const SPINE = BONE_NAMES.indexOf('spine');
const CHEST = BONE_NAMES.indexOf('chest');
const HEAD = BONE_NAMES.indexOf('head');
const ARM_L = BONE_NAMES.indexOf('armL');
const FORE_L = BONE_NAMES.indexOf('foreL');
const ARM_R = BONE_NAMES.indexOf('armR');
const FORE_R = BONE_NAMES.indexOf('foreR');
const STAFF = BONE_NAMES.indexOf('staff');
const THIGH_L = BONE_NAMES.indexOf('thighL');
const SHIN_L = BONE_NAMES.indexOf('shinL');
const THIGH_R = BONE_NAMES.indexOf('thighR');
const SHIN_R = BONE_NAMES.indexOf('shinR');
const SKIRT_F = BONE_NAMES.indexOf('skirtF');
const SKIRT_B = BONE_NAMES.indexOf('skirtB');
const QUIVER = BONE_NAMES.indexOf('quiver');
const BAND = BONE_NAMES.indexOf('band');
const HAND_R = BONE_NAMES.indexOf('handR');
const HIPS_Y = 0.98;

const SWING_TIME = 0.5;
const THROW_TIME = 0.45;
const PLANT_TIME = 0.55;
const HIT_TIME = 0.3;
/** Gap between the top of the headgear and a nameplate's tail (m). */
const PLATE_CLEARANCE = 0.12;
/** Frames between nameplate line-of-sight tests per avatar (staggered: ~10 Hz at 60 fps). */
const PLATE_SIGHT_PERIOD = 6;
const KO_FALL = 0.55;
const KO_DISSOLVE = 0.7;
const RESPAWN_TIME = 0.6;
const QUIVER_SCALE = 0.42;

interface AvatarVis {
  id: EntityId;
  slot: FactionId;
  rig: AvatarRig;
  group: THREE.Group;
  material: THREE.MeshStandardMaterial;
  xray: THREE.SkinnedMesh;
  xrayMat: THREE.MeshBasicMaterial;
  u: AvatarUniforms;
  cur: Float32Array;
  tgt: Float32Array;
  bob: number;
  fall: number;
  yaw: number;
  hipYaw: number;
  phase: number;
  speed: number;
  air: number;
  wasGround: boolean;
  landAt: number;
  lastX: number;
  lastZ: number;
  actionKind: AvatarAction['kind'];
  actionStart: number;
  swingAt: number;
  throwAt: number;
  plantAt: number;
  hitAt: number;
  down: boolean;
  koAt: number;
  respawnAt: number;
  channel: number;
  /** Smoothed 0..1: standing at an own Hearth under capture (Hold the Hearth). */
  hold: number;
  /** Smoothed 0..1 weight of DJ Scarecrow's beat-locked groove (idle and standing only). */
  groove: number;
  /** Nameplate: last line-of-sight result (0/1) and its smoothed opacity. */
  plateSight: number;
  plateSeen: number;
  anchor: THREE.Vector3;
}

function put(a: Float32Array, i: number, x: number, y: number, z: number): void {
  a[i * 3] = x;
  a[i * 3 + 1] = y;
  a[i * 3 + 2] = z;
}

function add(a: Float32Array, i: number, x: number, y: number, z: number): void {
  a[i * 3] += x;
  a[i * 3 + 1] += y;
  a[i * 3 + 2] += z;
}

/** Blend bone `i`'s target toward (x, y, z) by weight `k` (layering an action over the base). */
function mixPut(a: Float32Array, i: number, x: number, y: number, z: number, k: number): void {
  a[i * 3] += (x - a[i * 3]) * k;
  a[i * 3 + 1] += (y - a[i * 3 + 1]) * k;
  a[i * 3 + 2] += (z - a[i * 3 + 2]) * k;
}

export class AvatarRenderer {
  private readonly ctx: RenderContext;
  private readonly view: ActorView;
  private readonly flags: FlagRenderer;
  private readonly rings: UnitRings;
  private readonly plates: Nameplates;
  private readonly fx: AvatarFx;
  /** Shared by the skinned avatars: three's default depth material would switch variants. */
  private readonly depthMaterial = new THREE.MeshDepthMaterial();
  private readonly byId = new Map<EntityId, AvatarVis>();
  private readonly list: AvatarVis[] = [];
  private readonly colors: THREE.Color[];
  private readonly time: THREE.IUniform<number> = { value: 0 };
  private readonly beat: THREE.IUniform<number> = { value: 0 };
  private frame = 0;
  private readonly m1 = new THREE.Matrix4();
  private readonly m2 = new THREE.Matrix4();
  private readonly m3 = new THREE.Matrix4();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly quiverScale = new THREE.Vector3(QUIVER_SCALE, QUIVER_SCALE, QUIVER_SCALE);
  private readonly e1 = new THREE.Euler();
  private readonly anchors: Map<EntityId, THREE.Vector3>;

  constructor(
    ctx: RenderContext,
    view: ActorView,
    flags: FlagRenderer,
    rings: UnitRings,
    plates: Nameplates,
    anchors: Map<EntityId, THREE.Vector3>,
  ) {
    this.ctx = ctx;
    this.view = view;
    this.flags = flags;
    this.rings = rings;
    this.plates = plates;
    this.anchors = anchors;
    this.colors = ctx.world.factions.map((f) => new THREE.Color(f.color));
    this.fx = new AvatarFx(ctx.scene, Math.max(4, ctx.world.factions.length));
  }

  onEvent(e: GameEvent): void {
    const t = this.ctx.time;
    switch (e.t) {
      case 'swing': {
        const v = this.byId.get(e.by);
        if (v) v.swingAt = t;
        break;
      }
      case 'flagThrown': {
        const av = this.ctx.world.avatarOf(e.faction);
        const v = av ? this.byId.get(av.id) : undefined;
        if (v) v.throwAt = t;
        break;
      }
      case 'flagPlanted': {
        const v = this.byId.get(e.by);
        if (v && t - v.plantAt > 0.3) v.plantAt = t;
        break;
      }
      case 'hit': {
        const v = this.byId.get(e.target);
        if (v) v.hitAt = t;
        break;
      }
      default:
        break;
    }
  }

  update(dt: number): void {
    const ctx = this.ctx;
    const w = ctx.world;
    const t = ctx.time;
    this.time.value = t;
    this.frame++;
    // Beat-pulsed glow (DJ Scarecrow's headphones and EQ): attack on the kick, then decay.
    const phase = ctx.beat - Math.floor(ctx.beat);
    this.beat.value = (1 - phase) * (1 - phase) * (1 - phase);
    this.fx.begin();
    const player = w.factions[ctx.session.playerFaction];
    const acid = player ? player.drugActive.acidcop > w.time : false;
    for (const av of w.avatars.values()) {
      const v = this.byId.get(av.id) ?? this.create(av);
      this.animate(v, av, dt);
      this.place(v, av, acid, dt);
    }
    this.fx.end(t, this.colors);
  }

  dispose(): void {
    for (const v of this.list) {
      this.ctx.scene.remove(v.group);
      v.rig.geometry.dispose();
      v.material.dispose();
      v.xrayMat.dispose();
      v.rig.mesh.skeleton.dispose();
    }
    this.list.length = 0;
    this.byId.clear();
    this.fx.dispose();
    this.depthMaterial.dispose();
  }

  private create(av: Avatar): AvatarVis {
    const u: AvatarUniforms = {
      uTime: this.time,
      uBeat: this.beat,
      uDissolve: { value: 0 },
      uFlash: { value: 0 },
      uGlowBoost: { value: 0 },
      uEdge: { value: this.colors[av.faction].clone() },
    };
    const material = createAvatarMaterial(u);
    const rig = buildAvatarRig(av.faction, material);
    rig.mesh.name = `actors-avatar-${av.faction}`;
    rig.mesh.receiveShadow = true;
    rig.mesh.customDepthMaterial = this.depthMaterial;
    const xrayMat = new THREE.MeshBasicMaterial({
      color: this.colors[av.faction],
      transparent: true,
      opacity: 0.35,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const xray = new THREE.SkinnedMesh(rig.geometry, xrayMat);
    xray.bind(rig.mesh.skeleton, rig.mesh.bindMatrix);
    xray.frustumCulled = false;
    xray.renderOrder = 9;
    xray.name = `actors-avatar-${av.faction}-xray`;
    xray.visible = false;
    const group = new THREE.Group();
    group.add(rig.mesh, xray);
    this.ctx.scene.add(group);
    const v: AvatarVis = {
      id: av.id,
      slot: av.faction,
      rig,
      group,
      material,
      xray,
      xrayMat,
      u,
      cur: new Float32Array(NB * 3),
      tgt: new Float32Array(NB * 3),
      bob: 0,
      fall: 0,
      yaw: av.yaw,
      hipYaw: 0,
      phase: 0,
      speed: 0,
      air: 0,
      wasGround: true,
      landAt: -10,
      lastX: av.pos.x,
      lastZ: av.pos.z,
      actionKind: av.action.kind,
      actionStart: -10,
      swingAt: -10,
      throwAt: -10,
      plantAt: -10,
      hitAt: -10,
      down: av.koUntil > this.ctx.world.time,
      koAt: -10,
      respawnAt: -10,
      channel: 0,
      hold: 0,
      groove: 0,
      plateSight: 0,
      plateSeen: 0,
      anchor: new THREE.Vector3(av.pos.x, av.pos.y + 1.9, av.pos.z),
    };
    this.byId.set(av.id, v);
    this.anchors.set(av.id, v.anchor);
    this.list.push(v);
    return v;
  }

  private animate(v: AvatarVis, av: Avatar, dt: number): void {
    const t = this.ctx.time;
    const world = this.ctx.world;
    const style = v.rig.style;
    const tg = v.tgt;
    tg.fill(0);

    // Locomotion measurements from actual motion (robust to any sim velocity semantics).
    const dx = av.pos.x - v.lastX;
    const dz = av.pos.z - v.lastZ;
    v.lastX = av.pos.x;
    v.lastZ = av.pos.z;
    const dist = Math.hypot(dx, dz);
    const inst = dist > 3 ? 0 : dist / Math.max(dt, 1e-3);
    v.speed += (inst - v.speed) * damp(10, dt);
    const gait = clamp01(v.speed / 3);
    v.yaw += angleDiff(v.yaw, av.yaw) * damp(16, dt);
    let hipTarget = 0;
    let dir = 1;
    if (v.speed > 0.5 && dist > 1e-4 && dist < 3) {
      const moveYaw = Math.atan2(dx, dz);
      let rel = angleDiff(v.yaw, moveYaw);
      if (Math.abs(rel) > 1.9) {
        dir = -1;
        rel = angleDiff(v.yaw, moveYaw + Math.PI);
      }
      hipTarget = Math.max(-0.75, Math.min(0.75, rel)) * gait;
    }
    v.hipYaw += (hipTarget - v.hipYaw) * damp(8, dt);
    if (dist < 3) v.phase += (dir * dist * Math.PI * 2) / (v.speed > 9 ? 2.7 : 2.2);
    v.air += ((av.onGround ? 0 : 1) - v.air) * damp(12, dt);
    if (av.onGround && !v.wasGround) v.landAt = t;
    v.wasGround = av.onGround;
    if (av.action.kind !== v.actionKind) {
      v.actionKind = av.action.kind;
      v.actionStart = t;
      if (av.action.kind === 'swing' && t - v.swingAt > 0.3) v.swingAt = t;
      if (av.action.kind === 'plant' && t - v.plantAt > 0.3) v.plantAt = t;
    }

    let bob = 0;
    let channelTarget = 0;
    let fast = false;

    // Idle personality.
    switch (style.idle) {
      case 'mystic': {
        const br = Math.sin(t * 1.4);
        put(tg, CHEST, 0.02 * br, 0, 0);
        put(tg, HEAD, -0.04 + 0.03 * Math.sin(t * 0.6), 0.15 * Math.sin(t * 0.31), 0);
        put(tg, ARM_L, -0.22, 0, 0.14);
        put(tg, FORE_L, -0.55, 0, 0);
        put(tg, ARM_R, -0.12, 0, -0.1);
        put(tg, FORE_R, -0.6, 0, 0);
        put(tg, STAFF, 0.72, 0, 0.1);
        bob = 0.01 * br;
        break;
      }
      case 'bird': {
        const k = Math.floor(t / 1.4 + v.slot * 0.37);
        put(tg, SPINE, style.hunch * 0.5, 0, 0);
        put(tg, CHEST, style.hunch, 0, 0);
        put(tg, HEAD, 0.08 + 0.15 * (hash01(k * 3 + 1) - 0.5), (hash01(k * 7 + v.slot) - 0.5) * 1.1, (hash01(k * 5 + 2) - 0.5) * 0.5);
        put(tg, ARM_L, 0.35, 0, 0.12);
        put(tg, FORE_L, -1.25, 0, -0.3);
        put(tg, ARM_R, -0.2, 0, -0.06);
        put(tg, FORE_R, -0.35, 0, 0);
        put(tg, STAFF, 0.55, 0, 0);
        break;
      }
      case 'groove': {
        // A loose DJ stance; the bounce on the kick is added after smoothing (end of animate).
        bob = -0.012;
        put(tg, SHIN_L, 0.16, 0, 0);
        put(tg, SHIN_R, 0.16, 0, 0);
        put(tg, CHEST, style.hunch, 0, 0);
        put(tg, ARM_L, -0.38, 0, 0.2);
        put(tg, FORE_L, -0.9, 0, 0);
        put(tg, ARM_R, -0.15, 0, -0.1);
        put(tg, FORE_R, -0.55, 0, 0);
        put(tg, STAFF, 0.7, 0, 0);
        break;
      }
      case 'stately': {
        const br = Math.sin(t * 1.1);
        put(tg, CHEST, style.hunch + 0.02 * br, 0, 0);
        put(tg, HEAD, -0.12, 0.2 * Math.sin(t * 0.25), 0);
        const wave = (t + v.slot * 2.3) % 7;
        if (wave < 1.8) {
          const k = bump(wave / 1.8);
          put(tg, ARM_L, -0.3 * k, 0, 0.12 + 2.3 * k);
          put(tg, FORE_L, -0.4 * k, 0, 0.35 * Math.sin(t * 10) * k);
        } else {
          put(tg, ARM_L, -0.1, 0, 0.12);
          put(tg, FORE_L, -0.25, 0, 0);
        }
        put(tg, ARM_R, -0.15, 0, -0.1);
        put(tg, FORE_R, -0.6, 0, 0);
        put(tg, STAFF, 0.75, 0, 0);
        break;
      }
    }

    // Run cycle (cross-faded with idle by gait).
    if (gait > 0.01) {
      const s = Math.sin(v.phase);
      const c = Math.cos(v.phase);
      const g = gait;
      mixPut(tg, THIGH_L, -0.85 * s, 0, 0.03, g);
      mixPut(tg, THIGH_R, 0.85 * s, 0, -0.03, g);
      mixPut(tg, SHIN_L, 0.15 + 1.25 * Math.max(0, c), 0, 0, g);
      mixPut(tg, SHIN_R, 0.15 + 1.25 * Math.max(0, -c), 0, 0, g);
      mixPut(tg, ARM_L, 0.75 * s, 0, 0.12, g);
      mixPut(tg, FORE_L, -0.8, 0, 0, g);
      mixPut(tg, ARM_R, -0.45 * s - 0.2, 0, -0.12, g);
      mixPut(tg, FORE_R, -0.7, 0, 0, g);
      mixPut(tg, STAFF, 0.9, 0, 0, g);
      mixPut(tg, SPINE, 0.12, 0, 0, g);
      mixPut(tg, CHEST, 0.05 + style.hunch, -0.12 * s, 0, g);
      mixPut(tg, HEAD, -0.08, 0.06 * s, 0, g);
      const swingAmt = Math.abs(s);
      mixPut(tg, SKIRT_F, -0.5 * swingAmt, 0, 0, g);
      mixPut(tg, SKIRT_B, 0.3 * swingAmt, 0, 0, g);
      bob += (0.06 * (Math.abs(c) - 0.5) - bob) * g;
    }

    // Airborne tuck and landing squash.
    if (v.air > 0.01) {
      const a = v.air;
      const falling = av.vel.y < -2 ? 1 : 0;
      mixPut(tg, THIGH_L, -0.7, 0, 0.05, a);
      mixPut(tg, SHIN_L, 1.1, 0, 0, a);
      mixPut(tg, THIGH_R, -0.2, 0, -0.05, a);
      mixPut(tg, SHIN_R, 0.6, 0, 0, a);
      mixPut(tg, ARM_L, -0.3, 0, 0.6 + 0.4 * falling, a);
      mixPut(tg, SPINE, 0.08, 0, 0, a);
      mixPut(tg, SKIRT_F, -0.3, 0, 0, a);
      mixPut(tg, SKIRT_B, 0.25, 0, 0, a);
    }
    const land = (t - v.landAt) / 0.25;
    if (land < 1) {
      const k = 1 - land;
      add(tg, SHIN_L, 0.6 * k, 0, 0);
      add(tg, SHIN_R, 0.6 * k, 0, 0);
      add(tg, THIGH_L, -0.4 * k, 0, 0);
      add(tg, THIGH_R, -0.4 * k, 0, 0);
      bob -= 0.1 * k;
    }

    // Naruto sprint: forward lean, level gaze, and straight arms trailing behind the body.
    // Use the replicated sprint intent, so buffs/knockback do not trigger the pose.
    if (av.input.sprint && !av.input.throwMode && av.pushing < 0 && gait > 0.01) {
      const g = gait;
      mixPut(tg, SPINE, 0.58, 0, 0, g);
      mixPut(tg, CHEST, 0.12 + style.hunch * 0.3, 0, 0, g);
      mixPut(tg, HEAD, -0.55, 0, 0, g);
      mixPut(tg, ARM_L, 1.05, 0, 0.13, g);
      mixPut(tg, ARM_R, 1.05, 0, -0.13, g);
      mixPut(tg, FORE_L, -0.06, 0, 0, g);
      mixPut(tg, FORE_R, -0.06, 0, 0, g);
      mixPut(tg, STAFF, 0.1, 0, 0, g);
    }

    // Aim: the head and chest follow the aim pitch.
    add(tg, HEAD, -av.pitch * 0.45, 0, 0);
    add(tg, CHEST, -av.pitch * 0.2, 0, 0);
    // Lower body turns toward the run direction, chest stays on the aim.
    add(tg, HIPS, 0, v.hipYaw, 0);
    add(tg, SPINE, 0, -v.hipYaw * 0.55, 0);
    add(tg, CHEST, 0, -v.hipYaw * 0.45, 0);

    // Hold the Hearth: the staff is planted only while standing guard (running keeps the run
    // cycle); the contest aura shows either way.
    v.hold += ((this.holdingHearth(av) ? 1 : 0) - v.hold) * damp(4, dt);
    const hold = v.hold * (1 - gait) * (1 - v.air);
    if (hold > 0.001) {
      mixPut(tg, ARM_R, -0.9, 0, 0.25, hold);
      mixPut(tg, FORE_R, -0.6, 0, 0, hold);
      mixPut(tg, ARM_L, -0.9, 0, -0.25, hold);
      mixPut(tg, FORE_L, -0.6, 0, 0, hold);
      mixPut(tg, STAFF, 1.5, 0, 0, hold);
      mixPut(tg, SPINE, 0.1, 0, 0, hold);
      mixPut(tg, HEAD, 0.15, 0, 0, hold);
    }
    channelTarget = 0.7 * v.hold;

    // GCC pushing.
    if (av.pushing >= 0) {
      mixPut(tg, ARM_L, -1.45, 0, -0.2, 1);
      mixPut(tg, ARM_R, -1.45, 0, 0.2, 1);
      mixPut(tg, FORE_L, -0.25, 0, 0, 1);
      mixPut(tg, FORE_R, -0.25, 0, 0, 1);
      mixPut(tg, SPINE, 0.35, 0, 0, 1);
      mixPut(tg, STAFF, 1.2, 0, 0, 1);
    }

    // Actions.
    const action = av.action;
    const since = t - v.actionStart;
    if (action.kind === 'pull') {
      const k = clamp01(since / 0.12);
      const tug = Math.sin(t * 12);
      mixPut(tg, SPINE, -0.25 + 0.06 * tug, 0, 0, k);
      mixPut(tg, CHEST, -0.1, 0, 0, k);
      mixPut(tg, ARM_L, -1.05 - 0.1 * tug, 0, -0.18, k);
      mixPut(tg, FORE_L, -0.35, 0, 0, k);
      mixPut(tg, ARM_R, -0.95 - 0.1 * tug, 0, 0.18, k);
      mixPut(tg, FORE_R, -0.35, 0, 0, k);
      mixPut(tg, STAFF, 0.6, 0, 0.6, k);
      mixPut(tg, THIGH_L, -0.45, 0, 0, k);
      mixPut(tg, SHIN_L, 0.55, 0, 0, k);
      mixPut(tg, THIGH_R, 0.25, 0, 0, k);
      mixPut(tg, SHIN_R, 0.35, 0, 0, k);
      bob += (-0.12 - bob) * k;
      this.flags.markPulling(action.flagId, action.dur > 0 ? since / action.dur : 0.5);
    } else if (action.kind === 'align') {
      const k = clamp01(since / 0.3);
      mixPut(tg, ARM_L, -0.25, 0, 2.35, k);
      mixPut(tg, FORE_L, -0.35, 0, 0, k);
      mixPut(tg, ARM_R, -0.25, 0, -2.35, k);
      mixPut(tg, FORE_R, -0.35, 0, 0, k);
      mixPut(tg, STAFF, 0, 0, 0, k);
      mixPut(tg, HEAD, -0.35, 0, 0, k);
      mixPut(tg, CHEST, -0.12, 0, 0, k);
      mixPut(tg, SHIN_L, 0.3, 0, 0, k);
      mixPut(tg, SHIN_R, 0.2, 0, 0, k);
      mixPut(tg, SKIRT_F, -0.12 + 0.06 * Math.sin(t * 3), 0, 0, k);
      mixPut(tg, SKIRT_B, 0.12 + 0.06 * Math.sin(t * 3 + 1), 0, 0, k);
      bob += (0.14 + 0.04 * Math.sin(t * 2) - bob) * k;
      channelTarget = 1;
    } else if (action.kind === 'channel') {
      // Flagellian Dialectics at the cart: arguing with the whole upper body.
      const k = clamp01(since / 0.3);
      mixPut(tg, ARM_L, -1.2 - 0.4 * Math.sin(t * 3), 0, 0.3 + 0.3 * Math.sin(t * 2.3), k);
      mixPut(tg, FORE_L, -0.8 + 0.4 * Math.sin(t * 4), 0, 0, k);
      mixPut(tg, ARM_R, -0.6 + 0.3 * Math.sin(t * 2.7 + 1), 0, -0.15, k);
      mixPut(tg, HEAD, 0.1 * Math.sin(t * 3.3), 0.3 * Math.sin(t * 1.1), 0, k);
      channelTarget = 0.6;
    }

    const swing = (t - v.swingAt) / SWING_TIME;
    if (swing < 1) {
      fast = true;
      const k = swing < 0.75 ? 1 : 1 - (swing - 0.75) / 0.25;
      let sweep: number;
      let twist: number;
      if (swing < 0.3) {
        const e = easeOutCubic(swing / 0.3);
        sweep = -0.9 * e;
        twist = -0.75 * e;
      } else if (swing < 0.62) {
        const u = (swing - 0.3) / 0.32;
        const e = u * u * (3 - 2 * u);
        sweep = -0.9 + 2.9 * e;
        twist = -0.75 + 1.45 * e;
      } else {
        sweep = 2.0;
        twist = 0.7;
      }
      mixPut(tg, ARM_R, 0, sweep, -1.35, k);
      mixPut(tg, FORE_R, -0.25, 0, 0, k);
      mixPut(tg, STAFF, 1.57, 0, 0, k);
      mixPut(tg, CHEST, 0.05, twist * 0.6, 0, k);
      mixPut(tg, SPINE, 0.1, twist * 0.4, 0, k);
      mixPut(tg, ARM_L, -0.6, 0, 0.5, k);
    }

    const thr = (t - v.throwAt) / THROW_TIME;
    if (thr < 1) {
      fast = true;
      const k = thr < 0.7 ? 1 : 1 - (thr - 0.7) / 0.3;
      let f: number;
      let elbow: number;
      let twist: number;
      if (thr < 0.08) {
        const e = thr / 0.08;
        f = 0.3 + 3.2 * e;
        elbow = -1.6 * e;
        twist = 0.5 * e;
      } else if (thr < 0.35) {
        const u = (thr - 0.08) / 0.27;
        const e = u * u;
        f = 3.5 - 2.6 * e;
        elbow = -1.6 + 1.5 * e;
        twist = 0.5 - 0.95 * e;
      } else {
        f = 0.9;
        elbow = -0.1;
        twist = -0.45;
      }
      mixPut(tg, ARM_L, -f, 0, 0.15, k);
      mixPut(tg, FORE_L, elbow, 0, 0, k);
      mixPut(tg, CHEST, 0.1, twist, 0, k);
      mixPut(tg, SPINE, 0.05, twist * 0.5, 0, k);
    }

    const plant = (t - v.plantAt) / PLANT_TIME;
    if (plant < 1) {
      const k = plant < 0.2 ? plant / 0.2 : plant < 0.6 ? 1 : 1 - (plant - 0.6) / 0.4;
      mixPut(tg, THIGH_L, -1.1, 0, 0, k);
      mixPut(tg, SHIN_L, 1.5, 0, 0, k);
      mixPut(tg, THIGH_R, 0.1, 0, 0, k);
      mixPut(tg, SHIN_R, 1.4, 0, 0, k);
      mixPut(tg, SPINE, 0.4, 0, 0, k);
      mixPut(tg, CHEST, 0.25, 0, 0, k);
      mixPut(tg, HEAD, 0.3, 0, 0, k);
      mixPut(tg, ARM_L, -1.0, 0, 0.1, k);
      mixPut(tg, FORE_L, -0.3, 0, 0, k);
      bob += (-0.4 - bob) * k;
    }

    const hit = (t - v.hitAt) / HIT_TIME;
    v.u.uFlash.value = hit < 1 ? 0.7 * (1 - hit) : 0;
    if (hit < 1) {
      const k = bump(hit);
      add(tg, CHEST, -0.3 * k, 0, 0);
      add(tg, HEAD, -0.25 * k, 0, 0);
    }

    let stunned = false;
    for (const e of av.effects) if (e.kind === 'stun' && e.until > world.time) stunned = true;
    if (stunned) {
      add(tg, HEAD, 0.2, 0.45 * Math.sin(t * 8), 0.25 * Math.cos(t * 8));
      mixPut(tg, ARM_L, 0.1, 0, 0.1, 0.7);
      mixPut(tg, ARM_R, 0.1, 0, -0.1, 0.7);
    }

    // KO: collapse, dissolve into the Crystal, stay hidden until respawn; then materialize.
    const down = av.koUntil > world.time;
    if (down && !v.down) v.koAt = t;
    if (!down && v.down) v.respawnAt = t;
    v.down = down;
    let fallTarget = 0;
    let dissolve = 0;
    if (down) {
      const k = (t - v.koAt) / KO_FALL;
      const e = clamp01(k);
      fallTarget = 1.45 * e * e;
      mixPut(tg, SHIN_L, 0.9, 0, 0, clamp01(k * 2));
      mixPut(tg, SHIN_R, 0.7, 0, 0, clamp01(k * 2));
      mixPut(tg, ARM_L, -1.3, 0, 0.3, e);
      mixPut(tg, ARM_R, -1.3, 0, -0.3, e);
      dissolve = clamp01((t - v.koAt - KO_FALL * 0.8) / KO_DISSOLVE);
      channelTarget = 0;
    } else {
      const r = (t - v.respawnAt) / RESPAWN_TIME;
      if (r < 1) dissolve = 1 - r;
    }
    v.fall = down ? fallTarget : v.fall + (0 - v.fall) * damp(20, dt);
    v.u.uDissolve.value = dissolve;
    v.channel += (channelTarget - v.channel) * damp(5, dt);
    v.u.uGlowBoost.value = v.channel * 1.5;

    // Blend toward the targets and apply to the bones.
    const k = damp(fast ? 40 : 18, dt);
    const cur = v.cur;
    for (let i = 0; i < cur.length; i++) cur[i] += (tg[i] - cur[i]) * k;
    v.bob += (bob - v.bob) * damp(fast ? 30 : 14, dt);
    const bones = v.rig.mesh.skeleton.bones;
    for (let i = 0; i < NB; i++) {
      if (i === QUIVER || i === ROOT || i === BAND) continue;
      bones[i].rotation.set(cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]);
    }
    bones[ROOT].rotation.set(v.fall, 0, 0);
    bones[BAND].rotation.set(0, t * style.bandSpin * (1 + 3 * v.channel), 0);
    bones[HIPS].position.y = HIPS_Y + v.bob;

    // DJ Scarecrow's groove rides the festival beat clock. It is added after the smoothing
    // above, which would otherwise make the bounce trail the kick; any action, running, a jump
    // or holding the Hearth fades it out.
    const idle = action.kind === 'idle' && av.pushing < 0 && swing >= 1 && thr >= 1 && plant >= 1 && !down && !stunned;
    const grooveTarget = style.idle === 'groove' && idle ? (1 - gait) * (1 - v.air) * (1 - v.hold) : 0;
    v.groove += (grooveTarget - v.groove) * damp(6, dt);
    if (v.groove > 0.002) {
      const beat = this.ctx.beat;
      const dip = kickDip(beat) * v.groove;
      // Half-time sway: the lean changes side on every beat.
      const sway = Math.cos(Math.PI * beat) * v.groove;
      bones[THIGH_L].rotation.x -= 0.09 * dip;
      bones[THIGH_R].rotation.x -= 0.09 * dip;
      bones[SHIN_L].rotation.x += 0.18 * dip;
      bones[SHIN_R].rotation.x += 0.18 * dip;
      bones[HEAD].rotation.x += 0.15 * dip;
      bones[HEAD].rotation.z += 0.06 * sway;
      bones[CHEST].rotation.z += 0.07 * sway;
      bones[ARM_L].rotation.x -= 0.22 * dip;
      bones[HIPS].position.y -= 0.032 * dip;
    }
  }

  /**
   * Mirrors capture's "Hold the Hearth" rule: the avatar is up and within CAPTURE.holdRadius of
   * one of its faction's Hearths that an enemy Survey contains (holding it makes it contested).
   */
  private holdingHearth(av: Avatar): boolean {
    const w = this.ctx.world;
    if (av.koUntil > w.time) return false;
    const r2 = CAPTURE.holdRadius * CAPTURE.holdRadius;
    for (const id of w.factions[av.faction].hearthIds) {
      const b = w.buildings.get(id);
      if (!b || !b.hearth) continue;
      const stage = b.hearth.stage;
      if ((stage === 'contained' || stage === 'contested') && dist2(av.pos.x, av.pos.z, b.pos.x, b.pos.z) <= r2) return true;
    }
    return false;
  }

  /**
   * Clear line from the eye to a point. Map obstacles, buildings and build pieces block it
   * (units do not), except sculptures: their movement shapes wrap open frames (pinwheels,
   * spirals, arches) that you see straight through. CollisionWorld.raycast allocates its hit
   * record only when something is in the way, and callers stagger these queries at ~10 Hz.
   */
  private inSight(x: number, y: number, z: number): boolean {
    const w = this.ctx.world;
    const eye = this.view.eye;
    let ox = eye.x;
    let oy = eye.y;
    let oz = eye.z;
    const dx = x - ox;
    const dy = y - oy;
    const dz = z - oz;
    const d = Math.hypot(dx, dy, dz);
    // Stop just short of the target so the deck or ramp it stands on never counts.
    let reach = d - 0.3;
    let ignore: number | undefined;
    for (let pass = 0; pass < 3 && reach > 0.2; pass++) {
      const hit = w.collision.raycast(ox, oy, oz, dx, dy, dz, reach, ignore);
      if (!hit) return true;
      const obstacle = hit.tag <= -1 ? w.map.obstacles[-1 - hit.tag] : undefined;
      if (!obstacle || obstacle.kind !== 'art') return false;
      // Continue from where the ray entered the sculpture, ignoring it.
      ox = hit.x;
      oy = hit.y;
      oz = hit.z;
      reach -= hit.dist;
      ignore = hit.tag;
    }
    return reach <= 0.2;
  }

  private place(v: AvatarVis, av: Avatar, acid: boolean, dt: number): void {
    const ctx = this.ctx;
    const t = ctx.time;
    const groundAt = ctx.shared.groundOffset;
    const lift = clamp01(1 - av.pos.y / 0.3);
    const gy = groundAt ? groundAt(av.pos.x, av.pos.z) * lift : 0;
    const hidden = v.down && v.u.uDissolve.value >= 1;
    v.group.position.set(av.pos.x, av.pos.y + gy, av.pos.z);
    v.group.rotation.set(0, v.yaw, 0);
    v.rig.mesh.visible = !hidden;
    v.rig.mesh.castShadow = v.u.uDissolve.value < 0.5 && this.view.casts(av.pos.x, av.pos.y + 1, av.pos.z);
    v.xray.visible = acid && !hidden && v.slot !== ctx.session.playerFaction;
    v.group.updateMatrixWorld(true);
    const bones = v.rig.mesh.skeleton.bones;

    v.anchor.set(0, 0.12, 0).applyMatrix4(bones[HEAD].matrixWorld);
    const color = this.colors[v.slot];

    if (!hidden) {
      this.rings.push(av.pos.x, av.pos.y + gy + 0.035, av.pos.z, 0.95, color, 0.85 + 0.8 * v.channel, RING.avatar, v.slot * 0.25);
      this.fx.aura(av.pos.x, av.pos.y + gy, av.pos.z, v.channel, color, 0.85);
      this.pushQuiver(v, av);
    }

    // Online nameplate: every seat with a handle; your own only from the Command View table.
    // Plates draw over the scene, so a staggered line-of-sight test to the head keeps walls
    // from leaking rivals' positions (Acid Cop Vision and spectators see through them).
    const session = ctx.session;
    const own = !session.spectator && v.slot === session.playerFaction;
    if (!v.down && (!own || session.viewBlend > 0.5) && this.plates.has(v.slot)) {
      if (own || acid || session.spectator) v.plateSight = 1;
      else if ((this.frame + v.slot * 2) % PLATE_SIGHT_PERIOD === 0) v.plateSight = this.inSight(v.anchor.x, v.anchor.y, v.anchor.z) ? 1 : 0;
      v.plateSeen += (v.plateSight - v.plateSeen) * damp(10, dt);
      const alpha = v.plateSeen * (1 - v.u.uDissolve.value);
      this.plates.push(v.slot, av.pos.x, av.pos.y + gy + v.rig.style.crown + PLATE_CLEARANCE, av.pos.z, alpha);
    } else {
      v.plateSight = 0;
      v.plateSeen = 0;
    }

    // Swing trail: hand → finial, bright only through the strike.
    const swing = (t - v.swingAt) / SWING_TIME;
    const hand = this.v1.setFromMatrixPosition(bones[HAND_R].matrixWorld);
    const tip = this.v2.set(0, STAFF_TOP + 0.06, 0).applyMatrix4(bones[STAFF].matrixWorld);
    this.fx.trailSample(v.slot, hand, tip, swing > 0.22 && swing < 0.75 && !hidden ? 1 : 0, t);
  }

  /** The quiver bundle: one small Flag per carried Flag, fanned out of the tube mouth. */
  private pushQuiver(v: AvatarVis, av: Avatar): void {
    const n = av.carried.length;
    if (n === 0) return;
    const quiver = v.rig.mesh.skeleton.bones[QUIVER].matrixWorld;
    const spread = Math.min(0.14, 0.95 / n);
    const wave = 0.35 + Math.min(1, v.speed / 10) * 0.75;
    const trail = Math.min(0.45, v.speed / 18);
    const ribbon = this.flags.ribbonColor(av.faction);
    for (let i = 0; i < n; i++) {
      const id = av.carried[i];
      const ph = hash01(id);
      const fan = (i - (n - 1) / 2) * spread;
      // Fan about the mouth: bases cross inside the tube, tops splay like arrows.
      this.m1.makeRotationZ(fan);
      this.m2.makeTranslation(0, -0.36 + (ph - 0.5) * 0.08, 0);
      this.e1.set((ph - 0.5) * 0.2 + (i % 2 ? 0.07 : -0.07), Math.PI / 2 + (ph - 0.5) * 0.6, 0);
      this.m3.makeRotationFromEuler(this.e1).scale(this.quiverScale);
      this.m1.multiply(this.m2).multiply(this.m3).premultiply(quiver);
      this.flags.pushMatrix(this.m1, ph, wave, trail, 0, 0, ribbon);
    }
  }
}
