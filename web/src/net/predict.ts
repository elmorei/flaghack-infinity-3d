/**
 * Client-side prediction of the local vexillomancer in an online burn. Every local tick the
 * very motion step the host runs (avatars.stepAvatarMotion) advances a private body with the
 * input just sent, so movement answers the keys at once instead of a round trip later.
 * Whenever a newer host frame arrives the body restarts from the host's word on the avatar and
 * replays every input the host has not consumed yet (seq > ack). The gap between what was on
 * screen and the corrected prediction then decays over ~120 ms (snapping beyond 3 m: respawns,
 * teleports), so corrections slide instead of popping. The shown transform is interpolated
 * between the last two ticks (the body steps at 60 Hz, screens refresh faster) and written into
 * the mirror's avatar (the mirror leaves it alone after setPredicted); the camera follows it
 * like any avatar.
 * Owner: Controls (NetClient role).
 */
import { SIM_DT } from '../sim/constants';
import type { V3 } from '../sim/math';
import { stepAvatarMotion } from '../sim/systems/avatars';
import type { AvatarMotionState } from '../sim/systems/avatars';
import type { AvatarInput, EntityId } from '../sim/types';
import type { World } from '../sim/world';
import type { AvatarKinematics } from './mirror';

/** The host's latest word as the mirror keeps it: the newest pushed frame, ahead of playback. */
export interface PredictionSource {
  latestAvatar(id: EntityId): AvatarKinematics | null;
  latestAck(playerId: string): number;
  latestTime(): number;
  latestTick(): number;
}

/** Inputs remembered for replay: 4.3 s at 60 Hz, far beyond any playable round trip. */
const HISTORY = 256;
/** Time constant (s) of the visual correction slide. */
const ERROR_DECAY = 0.12;
/** Corrections larger than this (m) snap instead of sliding. */
const SNAP_DISTANCE = 3;
/** Below this the residual offset is dropped (m). */
const ERROR_EPSILON = 1e-4;

export class AvatarPredictor {
  readonly avatarId: EntityId;
  /** Size of the last reconcile correction (m), 0 before the first; for overlays and tests. */
  correction = 0;
  private readonly world: World;
  private readonly playerId: string;
  /** The predicted body: the host's latest state plus every unacknowledged input. */
  private readonly body: AvatarMotionState;
  /** The body's position one tick earlier (render interpolation runs from here to body.pos). */
  private readonly prev: V3 = { x: 0, y: 0, z: 0 };
  private readonly inputs: AvatarInput[] = [];
  /** Which seq each history slot holds (-1 empty). */
  private readonly seqs = new Int32Array(HISTORY).fill(-1);
  private lastSeq = 0;
  /** Host ack and world time of the state the body was last rebuilt from. */
  private ack = 0;
  private baseTime = 0;
  private sourceTick = -1;
  private synced = false;
  /** Shown minus predicted position; decays toward zero. */
  private readonly err: V3 = { x: 0, y: 0, z: 0 };

  constructor(world: World, avatarId: EntityId, playerId: string) {
    this.world = world;
    this.avatarId = avatarId;
    this.playerId = playerId;
    const av = world.avatars.get(avatarId);
    this.body = {
      pos: { x: av ? av.pos.x : 0, y: av ? av.pos.y : 0, z: av ? av.pos.z : 0 },
      vel: { x: 0, y: 0, z: 0 },
      yaw: av ? av.yaw : 0,
      pitch: av ? av.pitch : 0,
      onGround: true,
      koUntil: av ? av.koUntil : 0,
      action: av ? av.action : { kind: 'idle' },
      effects: av ? av.effects : [],
      pushing: -1,
    };
    this.copyPrev();
    for (let i = 0; i < HISTORY; i++) this.inputs.push({ moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 });
  }

  /** One local tick: remember the input sent as `seq` and advance the body with it. */
  tick(seq: number, input: AvatarInput): void {
    const slot = seq % HISTORY;
    const kept = this.inputs[slot];
    kept.moveX = input.moveX;
    kept.moveZ = input.moveZ;
    kept.jump = input.jump;
    kept.sprint = input.sprint;
    kept.throwMode = input.throwMode === true;
    kept.yaw = input.yaw;
    kept.pitch = input.pitch;
    this.seqs[slot] = seq;
    this.lastSeq = seq;
    if (!this.synced) return;
    this.copyPrev();
    this.step(kept, this.baseTime + (seq - this.ack) * SIM_DT);
  }

  /**
   * Once per render frame: rebuild on a newer host frame, slide the correction, show the result.
   * `alpha` (0..1) is how far the clock has run into the next local tick.
   */
  frame(source: PredictionSource, dt: number, alpha: number): void {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    const b = this.body;
    const p = this.prev;
    const e = this.err;
    const tick = source.latestTick();
    if (!this.synced || tick !== this.sourceTick) {
      this.sourceTick = tick;
      const wasSynced = this.synced;
      const shownX = p.x + (b.pos.x - p.x) * a + e.x;
      const shownY = p.y + (b.pos.y - p.y) * a + e.y;
      const shownZ = p.z + (b.pos.z - p.z) * a + e.z;
      if (this.reconcile(source) && wasSynced) {
        e.x = shownX - (p.x + (b.pos.x - p.x) * a);
        e.y = shownY - (p.y + (b.pos.y - p.y) * a);
        e.z = shownZ - (p.z + (b.pos.z - p.z) * a);
        this.correction = Math.hypot(e.x, e.y, e.z);
        if (this.correction > SNAP_DISTANCE) this.clearError();
      }
    }
    if (!this.synced) return;
    const k = Math.exp(-dt / ERROR_DECAY);
    e.x *= k;
    e.y *= k;
    e.z *= k;
    if (Math.abs(e.x) + Math.abs(e.y) + Math.abs(e.z) < ERROR_EPSILON) this.clearError();
    const av = this.world.avatars.get(this.avatarId);
    if (!av) return;
    av.pos.x = p.x + (b.pos.x - p.x) * a + e.x;
    av.pos.y = p.y + (b.pos.y - p.y) * a + e.y;
    av.pos.z = p.z + (b.pos.z - p.z) * a + e.z;
    av.vel.x = b.vel.x;
    av.vel.y = b.vel.y;
    av.vel.z = b.vel.z;
    av.yaw = b.yaw;
    av.pitch = b.pitch;
    av.onGround = b.onGround;
  }

  /** Current visual offset from the prediction (m). */
  get errorDistance(): number {
    return Math.hypot(this.err.x, this.err.y, this.err.z);
  }

  /** The predicted position after the newest input (no interpolation, no smoothing). */
  get predictedPos(): Readonly<V3> {
    return this.body.pos;
  }

  /** Rebuild the body from the host's newest word; false when there is none yet. */
  private reconcile(source: PredictionSource): boolean {
    const latest = source.latestAvatar(this.avatarId);
    if (!latest) return false;
    const b = this.body;
    b.pos.x = latest.pos.x;
    b.pos.y = latest.pos.y;
    b.pos.z = latest.pos.z;
    b.vel.x = latest.vel.x;
    b.vel.y = latest.vel.y;
    b.vel.z = latest.vel.z;
    b.yaw = latest.yaw;
    b.pitch = latest.pitch;
    b.onGround = latest.onGround;
    b.koUntil = latest.koUntil;
    b.action = latest.action;
    b.effects = latest.effects;
    b.pushing = latest.pushing;
    this.ack = source.latestAck(this.playerId);
    this.baseTime = source.latestTime();
    this.copyPrev();
    for (let seq = this.ack + 1; seq <= this.lastSeq; seq++) {
      const slot = seq % HISTORY;
      // Older than the history (a stall of seconds): the host's word stands as is.
      if (this.seqs[slot] !== seq) break;
      this.copyPrev();
      this.step(this.inputs[slot], this.baseTime + (seq - this.ack) * SIM_DT);
    }
    if (!this.synced) {
      this.synced = true;
      this.clearError();
    }
    return true;
  }

  private copyPrev(): void {
    this.prev.x = this.body.pos.x;
    this.prev.y = this.body.pos.y;
    this.prev.z = this.body.pos.z;
  }

  private clearError(): void {
    this.err.x = 0;
    this.err.y = 0;
    this.err.z = 0;
  }

  /** The host's motion step for one tick, run at that tick's host time (effects expire by it). */
  private step(input: AvatarInput, time: number): void {
    const w = this.world;
    const saved = w.time;
    w.time = time;
    stepAvatarMotion(w, this.body, input, SIM_DT);
    w.time = saved;
  }
}
