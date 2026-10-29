/**
 * One running burn on the host: the only Simulation, the NPC controllers for every seat no human
 * drives, the per-player input queues and the NET_HZ replication frames.
 *
 * Each 60 Hz tick: every human seat consumes one queued input frame (starved: the previous input
 * again, ack unchanged; backlog over MAX_BACKLOG: every queued frame at once, all their commands
 * but only the newest input; a queue that stays two deep for DRAIN_WINDOW: two frames, so standing
 * latency drains), every command is stamped with the seat's faction, the NPC controllers think in
 * seat order, the simulation steps. Every second tick the drained events and the encoder's delta
 * go out as one state frame, serialized once and shared by every client.
 */
import { randomBytes } from 'node:crypto';
import { closeFrickFrackSession, resetFrickFrackEntropy } from '../src/sim/systems/frickFrack';
import { createAi } from '../src/ai';
import type { AiController } from '../src/ai';
import { SnapshotEncoder } from '../src/net/codec';
import type { FullSnapshot } from '../src/net/codec';
import { NET_HZ } from '../src/net/protocol';
import type { ClientMessage, ServerMessage } from '../src/net/protocol';
import { fitsLattice } from '../src/net/validate';
import type { LatticeSizes } from '../src/net/validate';
import type { Command, CommandOf } from '../src/sim/commands';
import { SIM_HZ } from '../src/sim/constants';
import { createMatch } from '../src/sim/setup';
import { Simulation } from '../src/sim/simulation';
import { FACTION_IDS } from '../src/sim/types';
import type { AvatarInput, FactionId, MatchOptions } from '../src/sim/types';
import type { World } from '../src/sim/world';

type InputMessage = Extract<ClientMessage, { t: 'input' }>;

const TICK_MS = 1000 / SIM_HZ;
const TICKS_PER_FRAME = SIM_HZ / NET_HZ;
/** Ticks one timer wake-up may catch up; a longer stall is skipped rather than replayed. */
const MAX_CATCH_UP = 5;
/** More queued input frames than this and the seat folds the whole queue into one tick. */
const MAX_BACKLOG = 6;
/** Ticks (0.5 s) over which a queue that never ran below two frames counts as standing latency. */
const DRAIN_WINDOW = 30;
/** Queued frames beyond this are refused (a client this far ahead is not keeping time). */
const MAX_QUEUE = 240;
/** Ticks (0.25 s) a seat may go without input before its vexillomancer stops moving. */
const STILL_AFTER_TICKS = 15;
/**
 * A fresh input sequence (after matchStart) must open at or below this seq: frames still in
 * flight from the previous sequence carry higher numbers and are dropped instead of blocking it.
 */
const FRESH_SEQ_LIMIT = 120;
/** Per-seat command budget: COMMANDS_PER_TICK refill (60/s), bursts up to COMMAND_BURST. */
const COMMANDS_PER_TICK = 1;
const COMMAND_BURST = 120;
/** This many consecutive failing simulation steps (10 s) and the burn is declared broken. */
const MAX_FAILED_STEPS = 600;
const FAULT_LOG_EVERY_MS = 10_000;
const SLOW_LOG_EVERY_MS = 10_000;
const STATS_EVERY_MS = 60_000;

export interface MatchListener {
  /** Commit validated control handoffs after this tick, before its authoritative snapshot. */
  beforeFrame?(): void;
  /** A state frame is serialized: send it to every client in the match, then admit joiners. */
  frame(text: string): void;
  /** world.phase just became 'ended'. */
  ended(): void;
  /** Replication failed: every client needs a fresh matchStart. */
  resync(): void;
  /** The simulation keeps failing; the match has stopped itself. */
  broken(): void;
}

interface HumanSeat {
  playerId: string;
  inputEpoch: number;
  queue: InputMessage[];
  /** Re-submitted each tick (the sim copies the input it is given). */
  inputCmd: CommandOf<'avatarInput'>;
  lastQueuedSeq: number;
  /** Ticks in a row without a queued frame. */
  starved: number;
  /** Shortest queue seen this drain window, and the window's tick count. */
  lowWater: number;
  windowTicks: number;
  budget: number;
}

export class Match {
  readonly world: World;
  private readonly sim: Simulation;
  private readonly encoder: SnapshotEncoder;
  private readonly listener: MatchListener;
  private readonly log: (line: string) => void;
  private readonly lattice: LatticeSizes;
  private readonly human: (HumanSeat | null)[] = [null, null, null, null];
  private readonly npc: (AiController | null)[] = [null, null, null, null];
  /** Last consumed seq per human player; serialized into every frame. */
  private readonly acks: Record<string, number> = {};
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private next = 0;
  private ticks = 0;
  private endedSeen = false;
  private failedSteps = 0;
  private faults = 0;
  private lastFault = '';
  private faultLoggedAt = 0;
  // Stats for the periodic log line.
  private statsAt = 0;
  private statTicks = 0;
  private statMs = 0;
  private statWorst = 0;
  private statOver = 0;
  private statFrames = 0;
  private statBytes = 0;
  private statSkipped = 0;
  private droppedCommands = 0;
  /** NPC think time of the current tick (ms), for the slow-tick report. */
  private npcMs = 0;
  private slowLoggedAt = 0;

  constructor(options: MatchOptions, listener: MatchListener, log: (line: string) => void) {
    this.world = createMatch(options);
    // The public map seed must not reveal the future shoe to network clients.
    resetFrickFrackEntropy(this.world, randomBytes(32).toString('hex'));
    this.sim = new Simulation(this.world);
    // Before the first step: the encoder's baseline is the freshly built world.
    this.encoder = new SnapshotEncoder(this.world);
    this.listener = listener;
    this.log = log;
    const lat = this.world.lattice;
    this.lattice = { nodes: lat.nodes.length, edges: lat.edges.length, facets: lat.facets.length };
  }

  /** State as of the last frame: send with matchStart, right after a frame went out. */
  full(): FullSnapshot {
    return this.encoder.full();
  }

  drivenByNpc(f: FactionId): boolean {
    return this.npc[f] !== null;
  }

  /**
   * A human drives seat `f` from now on (match start, a matchStart after a rejoin, a spectator
   * taking the seat). Any NPC lets go; the input queue and ack restart with the client's new
   * sequence, and the avatar stands still until the first frame arrives.
   */
  driveHuman(f: FactionId, playerId: string, inputEpoch: number): void {
    this.npc[f] = null;
    const prev = this.human[f];
    if (prev) delete this.acks[prev.playerId];
    this.human[f] = {
      playerId,
      inputEpoch,
      queue: [],
      inputCmd: { t: 'avatarInput', faction: f, input: this.stillInput(f) },
      lastQueuedSeq: 0,
      starved: 0,
      lowWater: Infinity,
      windowTicks: 0,
      budget: COMMAND_BURST,
    };
    this.acks[playerId] = 0;
  }

  /** The NPC drives seat `f` from now on; nothing more is submitted for it on a human's behalf. */
  driveNpc(f: FactionId): void {
    closeFrickFrackSession(this.world, f);
    const prev = this.human[f];
    if (prev) delete this.acks[prev.playerId];
    this.human[f] = null;
    if (!this.npc[f]) this.npc[f] = createAi(this.world, [f]);
  }

  /** The seat's human dropped: stand still (keep the aim) until they return or the NPC takes over. */
  holdStill(f: FactionId): void {
    closeFrickFrackSession(this.world, f);
    const seat = this.human[f];
    if (!seat) return;
    seat.queue.length = 0;
    seat.inputCmd.input = this.stillInput(f);
  }

  /** Queue one input frame for a human seat; false when refused (stale seq, not this player's seat, overflow). */
  pushInput(f: FactionId, playerId: string, msg: InputMessage): boolean {
    const seat = this.human[f];
    if (!seat || seat.playerId !== playerId || msg.inputEpoch !== seat.inputEpoch) return false;
    if (msg.seq <= seat.lastQueuedSeq || (seat.lastQueuedSeq === 0 && msg.seq > FRESH_SEQ_LIMIT)) return false;
    if (seat.queue.length >= MAX_QUEUE) return false;
    seat.lastQueuedSeq = msg.seq;
    seat.queue.push(msg);
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.next = performance.now();
    this.statsAt = Date.now();
    this.loop();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Drift-corrected fixed step: ticks are scheduled on an absolute clock (`next`), so timer
   * jitter never accumulates; one wake-up catches up at most MAX_CATCH_UP ticks and a longer
   * stall (GC, a suspended laptop) is skipped instead of replayed, so the loop never spirals.
   */
  private loop = (): void => {
    this.timer = undefined;
    if (!this.running) return;
    const now = performance.now();
    let steps = 0;
    while (now >= this.next && steps < MAX_CATCH_UP && this.running) {
      const t0 = performance.now();
      this.tick();
      const ms = performance.now() - t0;
      this.statTicks++;
      this.statMs += ms;
      if (ms > this.statWorst) this.statWorst = ms;
      if (ms > TICK_MS) this.slowTick(ms);
      this.next += TICK_MS;
      steps++;
    }
    if (!this.running) return;
    if (now - this.next > MAX_CATCH_UP * TICK_MS) {
      this.statSkipped += Math.floor((now - this.next) / TICK_MS);
      this.next = now;
    }
    this.maybeLogStats();
    this.timer = setTimeout(this.loop, Math.max(0, this.next - performance.now()));
  };

  private tick(): void {
    for (const f of FACTION_IDS) {
      const seat = this.human[f];
      if (seat) this.feed(f, seat);
    }
    // Seat order 0..3: N single-seat controllers then play exactly like one four-seat controller.
    const npcStart = performance.now();
    for (const f of FACTION_IDS) {
      const npc = this.npc[f];
      if (!npc) continue;
      try {
        npc.update();
      } catch (err) {
        this.fault(`NPC ${f}`, err);
      }
    }
    this.npcMs = performance.now() - npcStart;
    try {
      this.sim.step();
      this.failedSteps = 0;
    } catch (err) {
      this.fault('simulation', err);
      if (++this.failedSteps >= MAX_FAILED_STEPS) {
        this.stop();
        this.listener.broken();
        return;
      }
    }
    this.ticks++;
    if (this.ticks % TICKS_PER_FRAME === 0) this.sendFrame();
    if (!this.endedSeen && this.world.phase === 'ended') {
      this.endedSeen = true;
      this.listener.ended();
    }
  }

  private feed(f: FactionId, seat: HumanSeat): void {
    seat.budget = Math.min(COMMAND_BURST, seat.budget + COMMANDS_PER_TICK);
    const q = seat.queue;
    // A queue that never dipped below two frames for a whole window is pure latency (typically a
    // burst the client sent after a stall): fold one extra frame now and then to drain it.
    if (q.length < seat.lowWater) seat.lowWater = q.length;
    let drain = false;
    if (++seat.windowTicks === DRAIN_WINDOW) {
      drain = seat.lowWater >= 2;
      seat.windowTicks = 0;
      seat.lowWater = Infinity;
    }
    if (q.length === 0) {
      // Starved (a late packet, or a hidden tab whose page stopped sending): the previous input
      // holds briefly, then the vexillomancer stops instead of sprinting on into the woods.
      if (++seat.starved === STILL_AFTER_TICKS) seat.inputCmd.input = this.stillInput(f);
      this.world.submit(seat.inputCmd);
      return;
    }
    seat.starved = 0;
    // A deep backlog means a stall delivered frames in a burst (or the client runs fast): fold the
    // whole queue into this tick so its latency recovers at once instead of staying behind.
    const take = q.length > MAX_BACKLOG ? q.length : drain && q.length >= 2 ? 2 : 1;
    const newest = q[take - 1];
    seat.inputCmd.input = newest.input;
    // The input goes first so this tick's throw flies along this tick's aim (as offline).
    this.world.submit(seat.inputCmd);
    for (let i = 0; i < take; i++) this.submitCommands(f, seat, q[i].cmds);
    this.acks[seat.playerId] = newest.seq;
    if (take === q.length) q.length = 0;
    else for (let i = 0; i < take; i++) q.shift();
  }

  private submitCommands(f: FactionId, seat: HumanSeat, cmds: Command[]): void {
    for (const c of cmds) {
      // The frame's input is the seat's only avatar input; the budget caps floods of the rest.
      if (c.t === 'avatarInput' || !fitsLattice(c, this.lattice)) continue;
      if (seat.budget < 1) {
        this.droppedCommands++;
        continue;
      }
      seat.budget--;
      c.faction = f;
      this.world.submit(c);
    }
  }

  private sendFrame(): void {
    let text: string;
    try {
      const w = this.world;
      this.listener.beforeFrame?.();
      const events = w.drainEvents();
      const delta = this.encoder.delta(events);
      const msg: ServerMessage = { t: 'state', frame: { tick: w.tick, time: w.time, acks: this.acks, delta, events } };
      text = JSON.stringify(msg);
    } catch (err) {
      this.fault('replication', err);
      this.listener.resync();
      return;
    }
    this.statFrames++;
    this.statBytes += text.length;
    this.listener.frame(text);
  }

  /** An over-budget tick, with its busiest part (at most one line per SLOW_LOG_EVERY_MS). */
  private slowTick(ms: number): void {
    this.statOver++;
    const now = Date.now();
    if (now - this.slowLoggedAt < SLOW_LOG_EVERY_MS) return;
    this.slowLoggedAt = now;
    let busiest = 'NPCs';
    let busiestMs = this.npcMs;
    for (const [system, t] of Object.entries(this.sim.timings)) {
      if (t <= busiestMs) continue;
      busiest = system;
      busiestMs = t;
    }
    this.log(`slow tick: ${ms.toFixed(1)} ms of a ${TICK_MS.toFixed(1)} ms budget (busiest: ${busiest} ${busiestMs.toFixed(1)} ms)`);
  }

  /** Neutral input for seat `f`: no movement, the avatar's current aim. */
  private stillInput(f: FactionId): AvatarInput {
    const av = this.world.avatars.get(this.world.factions[f].avatarId);
    return { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: av ? av.input.yaw : 0, pitch: av ? av.input.pitch : 0 };
  }

  /** Errors are logged in full once, then summarized at most every FAULT_LOG_EVERY_MS. */
  private fault(where: string, err: unknown): void {
    this.faults++;
    this.lastFault = `${where}: ${err instanceof Error ? err.message : String(err)}`;
    const now = Date.now();
    if (this.faultLoggedAt === 0) {
      this.log(`burn error in ${where}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      this.faultLoggedAt = now;
      this.faults = 0;
    } else if (now - this.faultLoggedAt >= FAULT_LOG_EVERY_MS) {
      this.log(`burn errors: ${this.faults} in the last ${Math.round((now - this.faultLoggedAt) / 1000)} s (latest ${this.lastFault})`);
      this.faultLoggedAt = now;
      this.faults = 0;
    }
  }

  private maybeLogStats(): void {
    const now = Date.now();
    if (now - this.statsAt < STATS_EVERY_MS || this.statTicks === 0) return;
    const t = Math.floor(this.world.time);
    const clock = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    const npcs = this.npc.filter((c) => c !== null).length;
    const kb = this.statFrames > 0 ? this.statBytes / this.statFrames / 1024 : 0;
    let line = `burn ${clock} · tick avg ${(this.statMs / this.statTicks).toFixed(2)} ms, worst ${this.statWorst.toFixed(1)} ms`;
    if (this.statOver > 0) line += `, ${this.statOver} over the ${TICK_MS.toFixed(1)} ms budget`;
    if (this.statSkipped > 0) line += `, ${this.statSkipped} skipped after stalls`;
    line += ` · frames ${kb.toFixed(1)} KB · ${npcs} NPC seat${npcs === 1 ? '' : 's'}`;
    if (this.droppedCommands > 0) line += ` · ${this.droppedCommands} commands over budget dropped`;
    if (this.faults > 0) line += ` · ${this.faults} more errors (latest ${this.lastFault})`;
    this.log(line);
    this.faults = 0;
    this.statsAt = now;
    this.statTicks = 0;
    this.statMs = 0;
    this.statWorst = 0;
    this.statOver = 0;
    this.statFrames = 0;
    this.statBytes = 0;
    this.statSkipped = 0;
    this.droppedCommands = 0;
  }
}
