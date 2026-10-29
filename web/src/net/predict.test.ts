import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../sim/constants';
import type { GameEvent } from '../sim/events';
import { createMatch } from '../sim/setup';
import { Simulation } from '../sim/simulation';
import { knockback } from '../sim/systems/combat';
import type { AvatarInput, EntityId, MatchOptions } from '../sim/types';
import type { World } from '../sim/world';
import { SnapshotEncoder } from './codec';
import { NetMirror } from './mirror';
import type { AvatarKinematics } from './mirror';
import { AvatarPredictor } from './predict';
import type { PredictionSource } from './predict';
import type { StateFrame } from './protocol';

const OPTIONS: MatchOptions = { seed: 'predict-net', difficulty: 'normal', humans: [0], mode: 'standard' };
const PLAYER = 'p1';
const TICK_MS = 1000 * SIM_DT;
/** Host frames go out every second tick (NET_HZ 30). */
const FRAME_EVERY = 2;

interface ExactFrame {
  tick: number;
  time: number;
  ack: number;
  kin: AvatarKinematics;
}

/** Unquantized host state, delivered as is: isolates the predictor from the wire format. */
class ExactFrames implements PredictionSource {
  frame: ExactFrame | null = null;
  latestAvatar(): AvatarKinematics | null {
    return this.frame ? this.frame.kin : null;
  }
  latestAck(): number {
    return this.frame ? this.frame.ack : 0;
  }
  latestTime(): number {
    return this.frame ? this.frame.time : 0;
  }
  latestTick(): number {
    return this.frame ? this.frame.tick : -1;
  }
}

function capture(world: World, id: EntityId, ack: number): ExactFrame {
  const av = world.avatars.get(id);
  if (!av) throw new Error('host avatar missing');
  return {
    tick: world.tick,
    time: world.time,
    ack,
    kin: {
      pos: { ...av.pos },
      vel: { ...av.vel },
      yaw: av.yaw,
      pitch: av.pitch,
      onGround: av.onGround,
      koUntil: av.koUntil,
      action: { ...av.action },
      effects: av.effects.map((e) => ({ ...e })),
      pushing: av.pushing,
    },
  };
}

/** Run, turn, sprint and hop: the movement mix a vexillomancer actually produces. */
function scripted(seq: number, out: AvatarInput): AvatarInput {
  const yaw = 0.6 + seq * 0.004;
  const moving = seq > 40;
  out.moveX = moving ? Math.sin(yaw) : 0;
  out.moveZ = moving ? Math.cos(yaw) : 0;
  out.sprint = seq > 140 && seq < 260;
  out.jump = seq % 97 === 0;
  out.yaw = yaw;
  out.pitch = 0.1;
  return out;
}

interface Run {
  /** Max |predicted - host| over steady-state inputs, in metres. */
  steadyError: number;
  starved: number;
  /** Largest per-render-frame jump of the shown position. */
  maxVisualStep: number;
  /** Correction applied at the reconcile that first saw the knockback (m). */
  knockCorrection: number;
  /** Shown offset left 0.6 s after that reconcile. */
  residualAfterKnock: number;
  /** Max |predicted - host| for inputs sent from 0.4 s after the knockback frame arrived. */
  recoveredError: number;
}

/**
 * Host and client in one process. Client inputs reach the host after one-way latency ± jitter
 * (ordered, like TCP); the host consumes one per tick behind a two-input jitter buffer (reusing
 * the last on starvation) and every second tick ships a frame back, again after latency ± jitter.
 * `wire`: frames are the real codec deltas, JSON round-tripped into a real NetMirror (positions
 * quantized to centimetres); otherwise the host's exact floats. The client predicts each tick and
 * renders at 120 Hz.
 */
function simulate(latencyMs: number, jitterMs: number, knockAtTick: number | null, wire: boolean): Run {
  const host = createMatch(OPTIONS);
  const hostSim = new Simulation(host);
  const avatarId = host.factions[0].avatarId;
  const encoder = new SnapshotEncoder(host);
  const exact = new ExactFrames();
  exact.frame = capture(host, avatarId, 0);
  const mirror = wire ? NetMirror.create(OPTIONS, JSON.parse(JSON.stringify(encoder.full()))) : null;
  const client = mirror ? mirror.world : createMatch(OPTIONS);
  const source: PredictionSource = mirror ?? exact;
  const predictor = new AvatarPredictor(client, avatarId, PLAYER);
  if (mirror) mirror.setPredicted(avatarId);

  let rngState = 12345;
  const jitter = (): number => {
    rngState = (rngState * 1103515245 + 12345) % 2147483648;
    return (rngState / 2147483648 - 0.5) * 2 * jitterMs;
  };

  const toHost: { at: number; seq: number; input: AvatarInput }[] = [];
  const toClient: { at: number; tick: number; exact: ExactFrame; text: string }[] = [];
  let lastToHost = 0;
  let lastToClient = 0;
  const fifo: { seq: number; input: AvatarInput }[] = [];
  let hostInput: AvatarInput = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 };
  let ack = 0;
  let buffering = true;
  let starved = 0;
  let events: GameEvent[] = [];
  const predicted = new Map<number, { x: number; z: number; at: number }>();
  const actual = new Map<number, { x: number; z: number }>();

  let seq = 0;
  let nextHost = TICK_MS;
  let nextClient = TICK_MS * 0.37;
  let lastClientTick = 0;
  let nextRender = 0;
  let knockDeliveredAt = -1;
  let knockCorrection = 0;
  let residualAfterKnock = 0;
  let maxVisualStep = 0;
  const shown = { x: 0, z: 0, set: false };
  const clientAv = client.avatars.get(avatarId);
  if (!clientAv) throw new Error('client avatar missing');
  const scratch: AvatarInput = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 };

  for (let now = 0; now < 7000; now += 0.25) {
    while (toHost.length > 0 && toHost[0].at <= now) {
      const m = toHost.shift();
      if (m) fifo.push({ seq: m.seq, input: m.input });
    }
    while (toClient.length > 0 && toClient[0].at <= now) {
      const m = toClient.shift();
      if (!m) continue;
      if (mirror) {
        const frame: StateFrame = JSON.parse(m.text);
        mirror.push(frame);
      } else exact.frame = m.exact;
      if (knockAtTick !== null && knockDeliveredAt < 0 && m.tick >= knockAtTick) knockDeliveredAt = now;
    }
    if (now >= nextHost) {
      nextHost += TICK_MS;
      if (buffering && fifo.length >= 2) buffering = false;
      const next = buffering ? undefined : fifo.shift();
      if (next) {
        hostInput = next.input;
        ack = next.seq;
      } else if (!buffering) starved++;
      host.submit({ t: 'avatarInput', faction: 0, input: hostInput });
      hostSim.step();
      for (const e of host.drainEvents()) events.push(e);
      const hav = host.avatars.get(avatarId);
      if (hav && next) actual.set(next.seq, { x: hav.pos.x, z: hav.pos.z });
      if (knockAtTick !== null && host.tick === knockAtTick && hav) {
        knockback(host, avatarId, { x: hav.pos.x - 1, z: hav.pos.z - 0.5 }, 9);
      }
      if (host.tick % FRAME_EVERY === 0) {
        const frame: StateFrame = { tick: host.tick, time: host.time, acks: { [PLAYER]: ack }, delta: encoder.delta(events), events };
        events = [];
        lastToClient = Math.max(lastToClient, now + latencyMs + jitter());
        toClient.push({ at: lastToClient, tick: host.tick, exact: capture(host, avatarId, ack), text: JSON.stringify(frame) });
      }
    }
    if (now >= nextClient) {
      nextClient += TICK_MS;
      lastClientTick = now;
      seq++;
      const input = { ...scripted(seq, scratch) };
      predictor.tick(seq, input);
      const p = predictor.predictedPos;
      predicted.set(seq, { x: p.x, z: p.z, at: now });
      lastToHost = Math.max(lastToHost, now + latencyMs + jitter());
      toHost.push({ at: lastToHost, seq, input });
    }
    if (now >= nextRender) {
      nextRender += 1000 / 120;
      const before = predictor.correction;
      predictor.frame(source, 1 / 120, (now - lastClientTick) / TICK_MS);
      if (knockDeliveredAt >= 0 && knockCorrection === 0 && predictor.correction !== before) knockCorrection = predictor.correction;
      if (shown.set) maxVisualStep = Math.max(maxVisualStep, Math.hypot(clientAv.pos.x - shown.x, clientAv.pos.z - shown.z));
      shown.x = clientAv.pos.x;
      shown.z = clientAv.pos.z;
      shown.set = true;
      if (knockDeliveredAt >= 0 && residualAfterKnock === 0 && now >= knockDeliveredAt + 600) residualAfterKnock = predictor.errorDistance + 1e-9;
    }
  }

  let steadyError = 0;
  let recoveredError = 0;
  for (const [k, p] of predicted) {
    const h = actual.get(k);
    if (!h || k < 60) continue;
    const e = Math.hypot(p.x - h.x, p.z - h.z);
    if (knockDeliveredAt < 0) steadyError = Math.max(steadyError, e);
    else if (p.at >= knockDeliveredAt + 400) recoveredError = Math.max(recoveredError, e);
  }
  return { steadyError, starved, maxVisualStep, knockCorrection, residualAfterKnock, recoveredError };
}

describe('avatar prediction', () => {
  it('matches the host exactly in steady state under latency and jitter', () => {
    for (const [latency, jitter] of [
      [20, 4],
      [45, 6],
      [90, 7],
    ]) {
      const run = simulate(latency, jitter, null, false);
      expect(run.starved, `latency ${latency}`).toBe(0);
      expect(run.steadyError, `latency ${latency}`).toBeLessThan(0.05);
      // Interpolated between ticks: at most a sprint's 1/120 s of travel per 120 Hz frame (0.096 m).
      expect(run.maxVisualStep, `latency ${latency}`).toBeLessThan(0.11);
    }
  });

  it('stays within centimetres when replaying from the real wire (quantized codec + mirror)', () => {
    const run = simulate(45, 6, null, true);
    expect(run.starved).toBe(0);
    expect(run.steadyError).toBeLessThan(0.05);
    expect(run.maxVisualStep).toBeLessThan(0.11);
  });

  it('slides a host-side knockback in without a pop, then predicts it exactly', () => {
    const run = simulate(45, 6, 330, false);
    // The knockback was a real surprise to the client...
    expect(run.knockCorrection).toBeGreaterThan(0.3);
    // ...corrected by sliding (not snapped)...
    expect(run.knockCorrection).toBeLessThan(3);
    expect(run.maxVisualStep).toBeLessThan(0.25);
    expect(run.residualAfterKnock).toBeLessThan(0.05);
    // ...and once the client knows, its predictions match the host again.
    expect(run.recoveredError).toBeLessThan(0.05);
  });
});

describe('Frick-frack prediction lock', () => {
  it('does not replay stale movement while the public session locks the avatar', () => {
    const world=createMatch(OPTIONS),av=world.avatarOf(0),source=new ExactFrames();
    const start=world.nav.nearestWalkable(10,10);av.pos.x=start.x;av.pos.z=start.z;av.pos.y=world.collision.groundHeight(start.x,start.z);
    source.frame=capture(world,av.id,0);
    const predictor=new AvatarPredictor(world,av.id,PLAYER);
    predictor.frame(source,0,0);
    world.frickFrack.sessions[0]={id:1,revision:0,faction:0,phase:'dialogue',dialogueIndex:0,dialogueStartedAt:0,readyAt:5,wager:0,player:[],dealer:[],result:null,message:''};
    for(let seq=1;seq<=30;seq++) {predictor.tick(seq,{moveX:1,moveZ:1,jump:true,sprint:true,yaw:2,pitch:1});predictor.frame(source,SIM_DT,1);}
    expect(av.pos.x).toBeCloseTo(start.x,5);expect(av.pos.z).toBeCloseTo(start.z,5);
    expect(av.yaw).toBe(source.frame.kin.yaw);
  });
});
