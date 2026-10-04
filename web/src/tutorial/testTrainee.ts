/**
 * Headless trainee for the Training Burn tests: plays every lesson the way a player would,
 * reading only what the player sees (the director's state and the world markers) and acting
 * only through Commands (world.submit) and the director's own controls (continue()). Not part
 * of the game bundle.
 */
import { solveThrow } from '../ai/ballistics';
import type { ThrowAim } from '../ai/ballistics';
import { planNodeCost } from '../game/commandView';
import type { ObjectiveMarker, Session } from '../game/session';
import type { Command } from '../sim/commands';
import { AVATAR, BUILDINGS, GCC } from '../sim/constants';
import { planEnclosure } from '../sim/lattice/planner';
import { TRAINING_CAMP, TRAINING_PLAYER } from '../sim/scenarios/tutorial';
import { canPlaceBuilding } from '../sim/systems/buildings';
import { canPlantAt, nearestPlantableNode } from '../sim/systems/flags';
import { canBuildPiece } from '../sim/systems/pieces';
import type { AvatarInput, BuildingKind, PieceKind } from '../sim/types';
import type { World } from '../sim/world';
import type { TutorialRun } from './types';

/** Seconds between repeated discrete actions (plant, pull, throw, build) while one is pending. */
const ACTION_GAP = 0.4;
/** Re-plan the walking route this often (s). */
const REPATH = 1;
/** Throws are made from this far from the target. */
const THROW_STAND = 11;

export class Trainee {
  private readonly world: World;
  private readonly session: Session;
  private readonly run: TutorialRun;
  private readonly f = TRAINING_PLAYER;
  private readonly input: AvatarInput = { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 };
  private readonly aim: ThrowAim = { yaw: 0, pitch: 0, flight: 0 };
  /** Task the per-task state below belongs to. */
  private task = '';
  private taskSince = 0;
  private actAt = 0;
  private goal: { x: number; z: number } | null = null;
  private path: { x: number; z: number }[] = [];
  private pathAt = -Infinity;
  /** Next time a stalled walk may hop. */
  private hopAt = 0;

  constructor(world: World, session: Session, run: TutorialRun) {
    this.world = world;
    this.session = session;
    this.run = run;
    this.input.yaw = world.avatarOf(this.f).yaw;
  }

  /** Like Controls.tick: submit this tick's commands before the director and the sim run. */
  tick(): void {
    const st = this.run.state;
    if (st.phase === 'briefing' || st.phase === 'complete') {
      this.run.continue();
      return;
    }
    if (st.phase !== 'active') return;
    const objective = st.objectives.find((o) => !o.done);
    if (!objective) return;
    const task = `${st.lesson.id}/${objective.id}`;
    if (task !== this.task) {
      this.task = task;
      this.taskSince = this.world.time;
      this.goal = null;
      this.actAt = 0;
    }
    this.input.moveX = 0;
    this.input.moveZ = 0;
    this.input.jump = false;
    this.input.sprint = false;
    this.play(task);
    this.steer();
    this.submit({ t: 'avatarInput', faction: this.f, input: { ...this.input } });
  }

  // ── Lessons ─────────────────────────────────────────────────────────────────

  private play(task: string): void {
    const world = this.world;
    const av = world.avatarOf(this.f);
    const gcc = world.gccOf(this.f);
    const hearth = world.hearthOf(this.f);
    switch (task) {
      case 'arrival/walk':
        this.goal ??= { x: av.pos.x + 7, z: av.pos.z };
        return;
      case 'arrival/look':
        this.input.yaw += 0.08;
        return;
      case 'arrival/sprint':
        this.goal ??= { x: av.pos.x + 20, z: av.pos.z - 20 };
        this.input.sprint = true;
        return;
      case 'arrival/jump':
        this.input.jump = true;
        return;
      case 'arrival/gcc':
      case 'graduation/gift':
        if (gcc) this.walkTo(gcc.pos.x, gcc.pos.z, 4);
        if (task === 'graduation/gift' && gcc) {
          for (const h of world.hippies.values()) {
            if (h.faction !== -1 || h.status === 'ko' || Math.hypot(h.pos.x - gcc.pos.x, h.pos.z - gcc.pos.z) > 15) continue;
            this.walkTo(h.pos.x, h.pos.z, 2);
            if (this.near(h.pos.x, h.pos.z, 2.5)) this.act({ t: 'handFlag', faction: this.f, hippieId: h.id });
            break;
          }
        }
        return;
      case 'flag/plant':
      case 'ley/line':
      case 'ley/replant':
      case 'survey/close':
      case 'implied/short':
      case 'implied/long':
      case 'crystal/pentacle':
        this.plantMarked();
        return;
      case 'flag/throw':
        this.throwAtMarker();
        return;
      case 'ley/pull':
        this.pullMarked('Pull this');
        return;
      case 'phason/away': {
        const lone = this.marker('Lone Flag');
        if (lone?.at && hearth) {
          const dx = hearth.pos.x - lone.at.x;
          const dz = hearth.pos.z - lone.at.z;
          const d = Math.hypot(dx, dz) || 1;
          this.walkTo(lone.at.x + (dx / d) * 22, lone.at.z + (dz / d) * 22, 1.5);
        }
        return;
      }
      case 'phason/watch':
        return;
      case 'phason/replant':
        this.replantFallen();
        return;
      case 'command/open':
        this.session.view = 'command';
        return;
      case 'command/priority':
        this.act({ t: 'jobWeights', faction: this.f, weights: { survey: 4 } });
        return;
      case 'command/enclose': {
        const spot = this.marker('Enclose this');
        if (spot?.at) this.enclose(spot.at.x, spot.at.z, 4);
        return;
      }
      case 'command/fill':
        this.session.view = 'action';
        return;
      case 'build/wall':
        this.buildPiece('wall');
        return;
      case 'build/ramp':
        this.buildPiece('ramp');
        return;
      case 'build/deck':
        this.buildPiece('floor');
        return;
      case 'build/workshop':
        this.placeBuilding('workshop');
        return;
      case 'crystal/drum':
        this.placeBuilding('drumcircle');
        return;
      case 'crystal/align':
        if (hearth && this.walkTo(hearth.pos.x, hearth.pos.z, BUILDINGS.hearth.radius + 3) && av.action.kind !== 'align') {
          this.act({ t: 'align', faction: this.f, chakra: 'canton' });
        }
        return;
      case 'crystal/cast':
        this.act({ t: 'ability', faction: this.f, ability: 'stabilize', at: { x: av.pos.x, z: av.pos.z }, node: -1 });
        return;
      case 'defense/contained':
      case 'defense/hold':
        if (hearth) this.walkTo(hearth.pos.x, hearth.pos.z, BUILDINGS.hearth.radius + 2);
        return;
      case 'defense/break':
        this.pullMarked('Pull this');
        return;
      case 'conquest/plan': {
        const target = this.trainingHearth();
        if (target) this.enclose(target.x, target.z, 16);
        return;
      }
      case 'conquest/contain':
        this.helpPlan();
        return;
      case 'conquest/overwrite':
        return;
      case 'graduation/ping':
        this.act({ t: 'ping', faction: this.f, kind: 'rally', at: { x: av.pos.x, z: av.pos.z } });
        return;
      case 'graduation/saffron':
        this.act({ t: 'drug', faction: this.f, drug: 'saffron' });
        return;
      default:
        throw new Error(`The trainee does not know task ${task}`);
    }
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  private submit(cmd: Command): void {
    this.world.submit(cmd);
  }

  /** A discrete command, at most once per ACTION_GAP. */
  private act(cmd: Command): void {
    if (this.world.time < this.actAt) return;
    this.actAt = this.world.time + ACTION_GAP;
    this.submit(cmd);
  }

  private marker(label: string): ObjectiveMarker | undefined {
    return this.session.markers.find((m) => m.label === label);
  }

  /** Plant on the nearest marked node that still lacks our Flag ("Plant here", "Plant", the gap…). */
  private plantMarked(): void {
    const world = this.world;
    const lat = world.lattice;
    const av = world.avatarOf(this.f);
    if (av.carried.length === 0) {
      this.restock();
      return;
    }
    let best = -1;
    let bestD = Infinity;
    for (const m of this.session.markers) {
      if (m.node === undefined || m.label === 'Implied Flag' || m.label === 'Focus point' || m.label === 'Your Flag') continue;
      if (world.survey.nodeFlagOwner[m.node] === this.f || !canPlantAt(world, m.node, this.f)) continue;
      const n = lat.nodes[m.node];
      const d = Math.hypot(n.x - av.pos.x, n.z - av.pos.z);
      if (d < bestD) {
        bestD = d;
        best = m.node;
      }
    }
    if (best < 0) return;
    const n = lat.nodes[best];
    if (this.walkTo(n.x, n.z, 1.8)) this.act({ t: 'plant', faction: this.f, node: best });
  }

  private pullMarked(label: string): void {
    const world = this.world;
    const lat = world.lattice;
    const av = world.avatarOf(this.f);
    let best = -1;
    let bestD = Infinity;
    for (const m of this.session.markers) {
      if (m.node === undefined || m.label !== label || world.survey.nodeFlag[m.node] < 0) continue;
      const n = lat.nodes[m.node];
      const d = Math.hypot(n.x - av.pos.x, n.z - av.pos.z);
      if (d < bestD) {
        bestD = d;
        best = m.node;
      }
    }
    if (best < 0) return;
    const n = lat.nodes[best];
    if (this.walkTo(n.x, n.z, 1.2) && av.action.kind !== 'pull') {
      this.act({ t: 'pull', faction: this.f, flagId: world.survey.nodeFlag[best] });
    }
  }

  private throwAtMarker(): void {
    const target = this.marker('Throw here');
    const av = this.world.avatarOf(this.f);
    if (!target?.at) return;
    if (av.carried.length === 0) {
      this.restock();
      return;
    }
    this.throwAt(target.at.x, target.at.z);
  }

  /** Walk within throwing range of (x, z), stop, aim and throw. */
  private throwAt(x: number, z: number): void {
    const av = this.world.avatarOf(this.f);
    const d = Math.hypot(x - av.pos.x, z - av.pos.z);
    if (d > THROW_STAND + 2) {
      this.walkTo(x + ((av.pos.x - x) / d) * THROW_STAND, z + ((av.pos.z - z) / d) * THROW_STAND, 1.5);
      return;
    }
    this.goal = null;
    if (Math.hypot(av.vel.x, av.vel.z) > 0.3 || !solveThrow(av.pos, x, 0, z, false, this.aim)) return;
    this.input.yaw = this.aim.yaw;
    this.input.pitch = this.aim.pitch;
    // The aim lands with this tick's input; the throw goes out on a later tick with it applied.
    if (Math.abs(av.input.yaw - this.aim.yaw) < 1e-6 && Math.abs(av.input.pitch - this.aim.pitch) < 1e-6) {
      this.act({ t: 'throw', faction: this.f });
    }
  }

  private replantFallen(): void {
    const world = this.world;
    const av = world.avatarOf(this.f);
    const at = this.marker('Fallen Flag')?.at;
    if (!at) return;
    for (const fl of world.flags.values()) {
      if (fl.state !== 'loose' || fl.owner !== this.f || Math.hypot(fl.pos.x - at.x, fl.pos.z - at.z) > 1) continue;
      if (this.walkTo(fl.pos.x, fl.pos.z, 1.2) && av.action.kind !== 'pull') this.act({ t: 'pull', faction: this.f, flagId: fl.id });
      return;
    }
    // In the quiver now: plant it on the nearest free node.
    const node = nearestPlantableNode(world, av.pos, 12, this.f);
    if (node < 0) return;
    const n = world.lattice.nodes[node];
    if (this.walkTo(n.x, n.z, 1.8)) this.act({ t: 'plant', faction: this.f, node });
  }

  /** The Enclose tool's loop around (x, z), committed the way the Command View commits it. */
  private enclose(x: number, z: number, minRadius: number): void {
    const world = this.world;
    const s = world.survey;
    const loop = planEnclosure(world.lattice, { x, z, minRadius, maxRadius: 80, cost: (n) => planNodeCost(world, this.f, n) });
    if (!loop) return;
    const nodes = loop.filter((n) => !(s.holder[n] === this.f && s.nodeFlagOwner[n] !== this.f));
    this.act({ t: 'plan', faction: this.f, op: 'add', nodes });
  }

  /** Throw Flags onto the nearest unfilled plan nodes, restocking at the Hearth between runs. */
  private helpPlan(): void {
    const world = this.world;
    const lat = world.lattice;
    const av = world.avatarOf(this.f);
    if (av.carried.length === 0) {
      this.restock();
      return;
    }
    let best = -1;
    let bestD = Infinity;
    for (const n of world.factions[this.f].plan) {
      if (!canPlantAt(world, n, this.f)) continue;
      const d = Math.hypot(lat.nodes[n].x - av.pos.x, lat.nodes[n].z - av.pos.z);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    if (best >= 0) this.throwAt(lat.nodes[best].x, lat.nodes[best].z);
  }

  private buildPiece(kind: PieceKind): void {
    if (this.world.time < this.actAt) return;
    const world = this.world;
    const lat = world.lattice;
    const av = world.avatarOf(this.f);
    if (kind === 'wall') {
      for (const e of lat.edges) {
        const a = lat.nodes[e.a];
        if (Math.hypot(a.x - av.pos.x, a.z - av.pos.z) > 12) continue;
        if (canBuildPiece(world, this.f, 'wall', e.id, -1, 0, -1).ok) {
          this.act({ t: 'build', faction: this.f, kind, edge: e.id, facet: -1, level: 0, rampEdge: -1 });
          return;
        }
      }
    } else {
      for (const fc of lat.facets) {
        if (Math.hypot(fc.cx - av.pos.x, fc.cz - av.pos.z) > 12) continue;
        if (canBuildPiece(world, this.f, kind, -1, fc.id, 0, 0).ok) {
          this.act({ t: 'build', faction: this.f, kind, edge: -1, facet: fc.id, level: 0, rampEdge: 0 });
          return;
        }
      }
    }
    // Nothing buildable in reach: walk out onto open ground past the camp.
    const hearth = world.hearthOf(this.f);
    if (hearth) this.walkTo(hearth.pos.x + 18, hearth.pos.z - 18, 2);
  }

  private placeBuilding(kind: BuildingKind): void {
    if (this.world.time < this.actAt) return;
    const world = this.world;
    for (const fc of world.lattice.facets) {
      if (canPlaceBuilding(world, this.f, kind, fc.id).ok) {
        this.act({ t: 'placeBuilding', faction: this.f, kind, facet: fc.id });
        return;
      }
    }
  }

  private trainingHearth(): { x: number; z: number } | null {
    for (const b of this.world.buildings.values()) {
      if (b.kind === 'hearth' && b.hearth?.founder === TRAINING_CAMP && b.faction === TRAINING_CAMP) return b.pos;
    }
    return null;
  }

  /** Walk to the Hearth until the quiver is full again. */
  private restock(): void {
    const hearth = this.world.hearthOf(this.f);
    if (hearth) this.walkTo(hearth.pos.x, hearth.pos.z, BUILDINGS.hearth.radius + AVATAR.restockRadius - 2);
  }

  // ── Movement ────────────────────────────────────────────────────────────────

  private near(x: number, z: number, r: number): boolean {
    const av = this.world.avatarOf(this.f);
    return Math.hypot(x - av.pos.x, z - av.pos.z) <= r;
  }

  /** Head for (x, z); true once within `r`. */
  private walkTo(x: number, z: number, r: number): boolean {
    if (this.near(x, z, r)) {
      this.goal = null;
      return true;
    }
    if (!this.goal || this.goal.x !== x || this.goal.z !== z) {
      this.goal = { x, z };
      this.pathAt = -Infinity;
    }
    return false;
  }

  /** Follow the nav path to the goal (straight at it when no path is found). */
  private steer(): void {
    const goal = this.goal;
    if (!goal) return;
    const world = this.world;
    const av = world.avatarOf(this.f);
    if (world.time - this.pathAt >= REPATH) {
      this.pathAt = world.time;
      this.path = world.nav.findPath(av.pos.x, av.pos.z, goal.x, goal.z) ?? [];
    }
    while (this.path.length > 0 && Math.hypot(this.path[0].x - av.pos.x, this.path[0].z - av.pos.z) < 0.9) this.path.shift();
    const to = this.path[0] ?? goal;
    const dx = to.x - av.pos.x;
    const dz = to.z - av.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return;
    this.input.moveX = dx / d;
    this.input.moveZ = dz / d;
    this.input.yaw = Math.atan2(dx, dz);
    // Stalled against something: hop now and then.
    if (Math.hypot(av.vel.x, av.vel.z) < 0.5 && world.time - this.taskSince > 1 && world.time >= this.hopAt) {
      this.input.jump = true;
      this.hopAt = world.time + 0.7;
    }
  }
}
