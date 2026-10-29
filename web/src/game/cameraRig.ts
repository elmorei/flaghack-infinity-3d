/**
 * Camera rig. Every camera the player sees is a RigPose (look target, yaw, pitch, boom distance,
 * fov), so any two of them blend smoothly: the action over-the-shoulder boom, the Flagless orbit,
 * the Command View tilt, the GCC Command Table dive, the title cinematic and the end-of-match
 * orbit. Controls own input and pick the mode; the rig owns smoothing and writes the camera.
 */
import * as THREE from 'three';
import { GCC_TABLE_MAP_SIZE, GCC_TABLE_MAP_YAW, GCC_TABLE_Y } from '../render/structures/tableMap';
import { CAMP_CENTERS, MAP_HALF } from '../sim/constants';
import { smoothstep } from '../sim/math';
import type { V2 } from '../sim/math';
import { isCollapsed } from '../sim/systems/buildings';
import type { Avatar, Building, FactionId } from '../sim/types';
import type { World } from '../sim/world';
import { effigyCameraTarget } from './effigyCamera';
import type { CameraState } from './session';
import { isMobileCommandLayout } from './mobileTouch';

const DEG = Math.PI / 180;

/** Action orbit pitch limits (+ = camera above the head looking down). */
export const PITCH_MIN = -1.1;
export const PITCH_MAX = 1.25;
/** Command View tilt (look pitch) and zoom range (camera height, m). */
export const CMD_PITCH = -58 * DEG;
export const CMD_HEIGHT_MIN = 30;
export const CMD_HEIGHT_MAX = 260;
export const FOV_COMMAND = 50;
/** Fixed diagonal tactical view on phones. No user-controlled zoom or rotation. */
export const MOBILE_COMMAND_PITCH = -Math.atan(1 / Math.sqrt(2));
export const MOBILE_COMMAND_YAW = Math.PI * 1.25;
/** Keep actors approximately 28 CSS pixels tall at the centre in either orientation.
 * This changes only the window extent on resize, not the user's zoom level. */
export function mobileCommandHeight(viewportHeight: number): number {
  return Math.max(1, Number.isFinite(viewportHeight) ? viewportHeight : 720) * 0.035;
}
/** Fraction of the GCC dive spent descending onto the tabletop before the cut to world scale. */
export const DIVE_CUT = 0.4;

const PIVOT_HEIGHT = 1.62;
const SHOULDER = 0.6;
const AIM_BOOM = 4.4;
const MIN_BOOM = 0.35;
const CAMERA_MIN_Y = 0.2;
const FOV_ACTION = 72;
const FOV_SPRINT_KICK = 7;
const FOV_AIM_KICK = -10;
const FOV_DEATH = 60;
const FOV_TITLE = 42;
const FOV_DIVE = 50;
const DIVE_PITCH = -89 * DEG;
/** Camera height above the tabletop at the bottom of the dive: the live map fills the view. */
const DIVE_TABLE_HEIGHT = 0.55;
/** Title shot: look this far left of the subject so the GCC sits right of the menu. */
const TITLE_SIDE = 3.2;
/** World-scale camera distance that frames the battlefield exactly like the tabletop shot. */
const DIVE_WORLD_DIST = DIVE_TABLE_HEIGHT * ((2 * MAP_HALF) / GCC_TABLE_MAP_SIZE);

export interface RigPose {
  /** Point on the view ray the camera looks through. */
  tx: number;
  ty: number;
  tz: number;
  /** View yaw (0 = looking toward +z) and pitch (+ = looking up). */
  yaw: number;
  pitch: number;
  /** Camera distance back from the look target along the view ray. */
  dist: number;
  /** Vertical field of view (degrees). */
  fov: number;
}

export function newPose(): RigPose {
  return { tx: 0, ty: 0, tz: 0, yaw: 0, pitch: 0, dist: 1, fov: FOV_ACTION };
}

function copyPose(src: RigPose, dst: RigPose): void {
  dst.tx = src.tx;
  dst.ty = src.ty;
  dst.tz = src.tz;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.dist = src.dist;
  dst.fov = src.fov;
}

/** Smootherstep: zero velocity and acceleration at both ends, so blends never lurch. */
export function ease(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * Blend two poses. Yaw takes the shortest arc; distance blends geometrically so a 6 m → 140 m
 * pull-out reads as one steady rise instead of a lurch at the start.
 */
export function blendPose(a: RigPose, b: RigPose, t: number, out: RigPose): void {
  let dy = (b.yaw - a.yaw) % (2 * Math.PI);
  if (dy > Math.PI) dy -= 2 * Math.PI;
  else if (dy < -Math.PI) dy += 2 * Math.PI;
  out.tx = a.tx + (b.tx - a.tx) * t;
  out.ty = a.ty + (b.ty - a.ty) * t;
  out.tz = a.tz + (b.tz - a.tz) * t;
  out.yaw = a.yaw + dy * t;
  out.pitch = a.pitch + (b.pitch - a.pitch) * t;
  out.dist = Math.exp(Math.log(a.dist) + (Math.log(b.dist) - Math.log(a.dist)) * t);
  out.fov = a.fov + (b.fov - a.fov) * t;
}

/**
 * Ground point (y = 0) under normalized device coords (nx, ny) for the Command View pose implied
 * by `cam` (target cmdX/cmdZ, height cmdHeight), independent of the live (smoothed) camera.
 * Used for zoom-toward-cursor and grab-panning. Returns false if that ray misses the ground.
 */
export function commandGroundPoint(cam: CameraState, nx: number, ny: number, aspect: number, out: V2): boolean {
  const mobile = isMobileCommandLayout();
  const pitch = mobile ? MOBILE_COMMAND_PITCH : CMD_PITCH;
  const yaw = mobile ? MOBILE_COMMAND_YAW : Math.PI;
  const sp = Math.sin(pitch), cp = Math.cos(pitch);
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const dist = cam.cmdHeight / -sp;
  const tanH = Math.tan((FOV_COMMAND * DEG) / 2);
  const rx = nx * tanH * aspect, uy = ny * tanH;
  // Forward (sy*cp,sp,cy*cp), right (-cy,0,sy), up (-sy*sp,cp,-cy*sp).
  const dx = sy * cp - cy * rx - sy * sp * uy;
  const dy = sp + cp * uy;
  const dz = cy * cp + sy * rx - cy * sp * uy;
  if (dy >= -1e-6) return false;
  const t = cam.cmdHeight / -dy;
  out.x = cam.cmdX - sy * cp * dist + dx * t;
  out.z = cam.cmdZ - cy * cp * dist + dz * t;
  return true;
}

export type RigMode = 'title' | 'play' | 'ended';

export class CameraRig {
  /** Final pose of the last frame (before trauma shake). */
  readonly pose = newPose();
  /** Unshaken view ray of the last frame (crosshair picking). */
  readonly origin = new THREE.Vector3();
  readonly dir = new THREE.Vector3();

  private effigyLocked = false;
  private effigyTurn = 0;
  private effigyYaw = 0;
  private effigyPitch = 0;
  private mode: RigMode | null = null;
  private hasPose = false;
  private from = newPose();
  private transT = 0;
  private transDur = 0;
  private near = newPose();
  private far = newPose();
  private tmp = newPose();
  private base = newPose();

  private pivotY = 0;
  private pivotReady = false;
  private boom = 6.5;
  private boomWant = 6.5;
  private fovKick = 0;
  private wasDown = false;
  private orbitYaw = 0;
  private clock = 0;
  private shakeClock = 0;
  private focusX = 0;
  private focusZ = 0;
  private focusReady = false;
  private cmdX = 0;
  private cmdZ = 0;
  private cmdH = 120;
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');

  /** Blend from whatever is on screen now into the next pose over `dur` seconds. */
  startTransition(dur: number): void {
    if (!this.hasPose) return;
    copyPose(this.pose, this.from);
    this.transT = 0;
    this.transDur = dur;
  }

  setMode(mode: RigMode, dur: number): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.effigyLocked = false;
    this.startTransition(dur);
  }

  /** New world: drop smoothing state that refers to the old one (the on-screen pose is kept). */
  resetFollow(): void {
    this.effigyLocked = false;
    this.pivotReady = false;
    this.focusReady = false;
    this.wasDown = false;
  }

  /** Jump the smoothed Command View target to the session values (entering the view). */
  snapCommand(cam: CameraState): void {
    this.cmdX = cam.cmdX;
    this.cmdZ = cam.cmdZ;
    this.cmdH = cam.cmdHeight;
  }

  updateTitle(world: World, f: FactionId, dt: number): void {
    this.clock += dt;
    const t = this.clock;
    const gcc = world.gccOf(f);
    const hearth = world.hearthOf(f);
    const standing = gcc && !isCollapsed(gcc) ? gcc : undefined;
    const camp = CAMP_CENTERS[f];
    const hx = hearth ? hearth.pos.x : camp.x;
    const hz = hearth ? hearth.pos.z : camp.z;
    let fx = standing ? standing.pos.x : hx;
    let fz = standing ? standing.pos.z : hz;
    if (!standing) {
      // No cart to frame: stand off the Hearth toward the burn instead.
      const l = Math.hypot(camp.x, camp.z) || 1;
      fx -= (camp.x / l) * 9;
      fz -= (camp.z / l) * 9;
    }
    if (!this.focusReady) {
      this.focusX = fx;
      this.focusZ = fz;
      this.focusReady = true;
    }
    const k = Math.min(1, dt * 1.5);
    this.focusX += (fx - this.focusX) * k;
    this.focusZ += (fz - this.focusZ) * k;
    // Sweep an arc on the burn side of the cart so the GCC holds the foreground and the Hearth
    // (with its stock and ring) sits behind it, breathing in and out like a slow dolly.
    const base = Math.atan2(this.focusX - hx, this.focusZ - hz);
    const a = base + 0.8 * Math.sin(t * 0.065);
    const r = 7.4 + 1.8 * Math.sin(t * 0.047 + 0.6);
    const cx = this.focusX + Math.sin(a) * r;
    const cy = 2.3 + 0.7 * Math.sin(t * 0.053 + 1.3);
    const cz = this.focusZ + Math.cos(a) * r;
    let lx = this.focusX + (hx - this.focusX) * 0.42;
    let lz = this.focusZ + (hz - this.focusZ) * 0.42;
    // Aim left of the subject so the cart sits in the right half, clear of the title menu.
    const vy = Math.atan2(lx - cx, lz - cz);
    lx += Math.cos(vy) * TITLE_SIDE;
    lz -= Math.sin(vy) * TITLE_SIDE;
    this.lookFrom(cx, cy, cz, lx, 1.7, lz, FOV_TITLE, this.base);
    this.finish(dt);
  }

  updateEnded(world: World, f: FactionId, dt: number): void {
    this.orbitYaw += dt * 0.09;
    const winner = world.winner;
    const h = winner !== null ? world.hearthOf(winner) : world.hearthOf(f);
    const camp = CAMP_CENTERS[winner ?? f];
    const p = this.base;
    p.tx = h ? h.pos.x : camp.x;
    p.ty = 2.4;
    p.tz = h ? h.pos.z : camp.z;
    p.yaw = this.orbitYaw;
    p.pitch = -0.34;
    p.dist = 24;
    p.fov = 50;
    this.finish(dt);
  }

  /**
   * Playing: the action (or Flagless) pose blended toward the Command View by `blend` (0..1,
   * linear; eased here). With `dive` the blend runs through the GCC Command Table instead.
   */
  updatePlay(
    world: World,
    av: Avatar,
    f: FactionId,
    cam: CameraState,
    blend: number,
    dive: Building | null,
    aiming: boolean,
    sprinting: boolean,
    dt: number,
  ): void {
    const focus = effigyCameraTarget(world);
    if (!focus && this.effigyLocked) {
      this.effigyLocked = false;
      // Command/Flagless views return to their own pose; action retains the focused heading.
      this.startTransition(0.65);
    }
    const down = av.koUntil > world.time;
    if (down !== this.wasDown) {
      this.wasDown = down;
      if (down) this.orbitYaw = cam.yaw;
      else this.pivotReady = false;
      if (blend < 1) this.startTransition(down ? 0.8 : 0.9);
    }
    if (down) this.deathPose(world, av, f, dt, this.near);
    else this.actionPose(world, av, cam, aiming, sprinting, dt, this.near);

    if (blend <= 0) copyPose(this.near, this.base);
    else {
      this.commandPose(world, cam, dt, this.far);
      if (dive) {
        if (blend < DIVE_CUT) {
          this.tablePose(world, dive, this.tmp);
          blendPose(this.near, this.tmp, ease(blend / DIVE_CUT), this.base);
        } else {
          this.tableWorldPose(world, this.tmp);
          blendPose(this.tmp, this.far, ease((blend - DIVE_CUT) / (1 - DIVE_CUT)), this.base);
        }
      } else blendPose(this.near, this.far, ease(blend), this.base);
    }
    this.finish(dt);
    if (focus) {
      const p = this.pose;
      if (!this.effigyLocked) {
        this.effigyLocked = true;
        this.effigyTurn = 0;
        this.effigyYaw = p.yaw;
        this.effigyPitch = p.pitch;
        // The emergence owns orientation until release, including an interrupted mode blend.
        this.transDur = 0;
      }
      this.effigyTurn += Math.max(0, dt);
      // Rotate at the current camera location; do not teleport the player's viewpoint.
      const cp = Math.cos(p.pitch);
      const cx = p.tx - Math.sin(p.yaw) * cp * p.dist;
      const cy = p.ty - Math.sin(p.pitch) * p.dist;
      const cz = p.tz - Math.cos(p.yaw) * cp * p.dist;
      const dx = focus.x - cx, dy = focus.y - cy, dz = focus.z - cz;
      const yaw = Math.atan2(dx, dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
      let arc = (yaw - this.effigyYaw) % (2 * Math.PI);
      if (arc > Math.PI) arc -= 2 * Math.PI;
      if (arc < -Math.PI) arc += 2 * Math.PI;
      const turn = ease(this.effigyTurn / 1.1);
      p.yaw = this.effigyYaw + arc * turn;
      p.pitch = this.effigyPitch + (pitch - this.effigyPitch) * turn;
      p.tx = cx + Math.sin(p.yaw) * Math.cos(p.pitch) * p.dist;
      p.ty = cy + Math.sin(p.pitch) * p.dist;
      p.tz = cz + Math.cos(p.yaw) * Math.cos(p.pitch) * p.dist;
      if (!down && blend === 0) {
        cam.yaw = p.yaw;
        cam.pitch = -p.pitch;
      }
    }
  }

  /** Write the pose (plus trauma shake) into the three.js camera. */
  apply(camera: THREE.PerspectiveCamera, trauma: number, dt: number): void {
    const p = this.pose;
    const cp = Math.cos(p.pitch);
    this.dir.set(Math.sin(p.yaw) * cp, Math.sin(p.pitch), Math.cos(p.yaw) * cp);
    this.origin.set(p.tx - this.dir.x * p.dist, p.ty - this.dir.y * p.dist, p.tz - this.dir.z * p.dist);
    camera.position.copy(this.origin);
    // Trauma²-scaled smooth multi-sine wobble: deterministic, no RNG, decays with the trauma.
    this.shakeClock += dt;
    const s = this.shakeClock;
    // Touch targeting needs a stable field; impact geometry/audio still convey attacks.
    const k = isMobileCommandLayout() ? 0 : trauma * trauma;
    const sy = k * 0.045 * (Math.sin(s * 39.1) + 0.6 * Math.sin(s * 23.3 + 1.7));
    const sx = k * 0.045 * (Math.sin(s * 31.7 + 0.4) + 0.6 * Math.sin(s * 17.9 + 2.9));
    const sz = k * 0.06 * Math.sin(s * 27.3 + 4.1);
    this.euler.set(p.pitch + sx, p.yaw + Math.PI + sy, sz, 'YXZ');
    camera.quaternion.setFromEuler(this.euler);
    if (Math.abs(camera.fov - p.fov) > 0.01) {
      camera.fov = p.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }

  private finish(dt: number): void {
    if (this.hasPose && this.transT < this.transDur) {
      this.transT += dt;
      blendPose(this.from, this.base, ease(this.transT / this.transDur), this.pose);
    } else copyPose(this.base, this.pose);
    this.hasPose = true;
  }

  private lookFrom(cx: number, cy: number, cz: number, lx: number, ly: number, lz: number, fov: number, out: RigPose): void {
    const dx = lx - cx;
    const dy = ly - cy;
    const dz = lz - cz;
    const h = Math.hypot(dx, dz);
    out.tx = lx;
    out.ty = ly;
    out.tz = lz;
    out.yaw = Math.atan2(dx, dz);
    out.pitch = Math.atan2(dy, h);
    out.dist = Math.hypot(h, dy);
    out.fov = fov;
  }

  private actionPose(world: World, av: Avatar, cam: CameraState, aiming: boolean, sprinting: boolean, dt: number, out: RigPose): void {
    const col = world.collision;
    // Pivot x/z lock to the avatar (it never swims on screen); y eases so jumps feel weighty.
    const wantY = av.pos.y + PIVOT_HEIGHT;
    if (!this.pivotReady) {
      this.pivotY = wantY;
      this.boom = cam.dist;
      this.boomWant = cam.dist;
      this.pivotReady = true;
    }
    this.pivotY += (wantY - this.pivotY) * Math.min(1, dt * 14);
    const py = this.pivotY;
    const yaw = cam.yaw;
    const pitch = -cam.pitch;
    // Shoulder offset to the right of the view, tucked in when hugging a wall.
    const rx = -Math.cos(yaw);
    const rz = Math.sin(yaw);
    let shoulder = SHOULDER;
    const side = col.raycast(av.pos.x, py, av.pos.z, rx, 0, rz, SHOULDER + 0.25);
    if (side) shoulder = Math.max(0, side.dist - 0.25);
    const sx = av.pos.x + rx * shoulder;
    const sz = av.pos.z + rz * shoulder;
    // Boom back along the view ray; snaps in at once (never clips), eases back out.
    const cp = Math.cos(pitch);
    const dx = Math.sin(yaw) * cp;
    const dy = Math.sin(pitch);
    const dz = Math.cos(yaw) * cp;
    this.boomWant += ((aiming ? AIM_BOOM : cam.dist) - this.boomWant) * Math.min(1, dt * 10);
    let len = this.boomWant;
    const hit = col.raycast(sx, py, sz, -dx, -dy, -dz, len + 0.3);
    if (hit) len = Math.max(MIN_BOOM, hit.dist - 0.3);
    if (dy > 1e-3) len = Math.min(len, Math.max(MIN_BOOM, (py - CAMERA_MIN_Y) / dy));
    if (len < this.boom) this.boom = len;
    else this.boom += (len - this.boom) * Math.min(1, dt * 4);
    const kick = (sprinting ? FOV_SPRINT_KICK : 0) + (aiming ? FOV_AIM_KICK : 0);
    this.fovKick += (kick - this.fovKick) * Math.min(1, dt * 6);
    out.tx = sx;
    out.ty = py;
    out.tz = sz;
    out.yaw = yaw;
    out.pitch = pitch;
    out.dist = this.boom;
    out.fov = FOV_ACTION + this.fovKick;
  }

  /** Flagless: a slow orbit over the body that drifts to the Hearth just before respawn. */
  private deathPose(world: World, av: Avatar, f: FactionId, dt: number, out: RigPose): void {
    this.orbitYaw += dt * 0.22;
    const hearth = world.hearthOf(f);
    // Eliminated (koUntil = Infinity): no respawn to drift toward, keep orbiting the body.
    const k = hearth && Number.isFinite(av.koUntil) ? smoothstep(av.koUntil - 2, av.koUntil - 0.3, world.time) : 0;
    const hx = hearth ? hearth.pos.x : av.pos.x;
    const hz = hearth ? hearth.pos.z : av.pos.z;
    out.tx = av.pos.x + (hx - av.pos.x) * k;
    out.ty = av.pos.y * (1 - k) + world.collision.groundHeight(hx, hz) * k + 1;
    out.tz = av.pos.z + (hz - av.pos.z) * k;
    out.yaw = this.orbitYaw;
    out.pitch = -0.62;
    out.dist = 11 + 5 * k;
    out.fov = FOV_DEATH;
  }

  private commandPose(world: World, cam: CameraState, dt: number, out: RigPose): void {
    // Glide toward the session target so minimap jumps animate; wheel/pan stay responsive.
    const k = Math.min(1, dt * 12);
    this.cmdX += (cam.cmdX - this.cmdX) * k;
    this.cmdZ += (cam.cmdZ - this.cmdZ) * k;
    const mobile = isMobileCommandLayout();
    // Orientation resize must not produce a zoom animation or temporarily shrink actors.
    if (mobile) this.cmdH = cam.cmdHeight;
    else this.cmdH += (cam.cmdHeight - this.cmdH) * k;
    out.tx = this.cmdX;
    out.ty = world.collision.groundHeight(this.cmdX, this.cmdZ);
    out.tz = this.cmdZ;
    out.yaw = mobile ? MOBILE_COMMAND_YAW : Math.PI;
    out.pitch = mobile ? MOBILE_COMMAND_PITCH : CMD_PITCH;
    out.dist = this.cmdH / -Math.sin(out.pitch);
    out.fov = FOV_COMMAND;
  }

  /** Just above the GCC tabletop, looking straight down at the live map, north up. */
  private tablePose(world: World, gcc: Building, out: RigPose): void {
    out.tx = gcc.pos.x;
    out.ty = GCC_TABLE_Y + world.collision.groundHeight(gcc.pos.x, gcc.pos.z);
    out.tz = gcc.pos.z;
    out.yaw = Math.PI + GCC_TABLE_MAP_YAW;
    out.pitch = DIVE_PITCH;
    out.dist = DIVE_TABLE_HEIGHT;
    out.fov = FOV_DIVE;
  }

  /** The same framing at world scale: the tabletop map becomes the battlefield. */
  private tableWorldPose(world: World, out: RigPose): void {
    out.tx = 0;
    out.ty = world.collision.groundHeight(0, 0);
    out.tz = 0;
    out.yaw = Math.PI + GCC_TABLE_MAP_YAW;
    out.pitch = DIVE_PITCH;
    out.dist = DIVE_WORLD_DIST;
    out.fov = FOV_DIVE;
  }
}
