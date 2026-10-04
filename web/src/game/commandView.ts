/**
 * Command View (the GCC table): tactical camera control (WASD / arrows / screen-edge /
 * middle-drag pan, wheel zoom toward the cursor), D.E.G.E.N. selection (drag box, click),
 * right-click context orders, Survey planning tools (node, enclose, pentacle, ring, Flag
 * Simulacra targeting), camp building placement and pings at the cursor.
 */
import type * as THREE from 'three';
import { Vector3 } from 'three';
import type { Command } from '../sim/commands';
import { GCC, LATTICE_MARGIN, MAP_HALF, START_HOME_RING_RADIUS } from '../sim/constants';
import { pentacleOf } from '../sim/lattice/geometry';
import { planEnclosure, planRing } from '../sim/lattice/planner';
import type { V2 } from '../sim/math';
import { isFlagProtected } from '../sim/systems/abilities';
import { canPlantAt } from '../sim/systems/flags';
import { gccActive } from '../sim/systems/gcc';
import type { EntityId, FactionId, HippieOrder, PingKind } from '../sim/types';
import type { World } from '../sim/world';
import { CMD_HEIGHT_MAX, CMD_HEIGHT_MIN, commandGroundPoint } from './cameraRig';
import type { Input } from './input';
import { LMB, MMB, RMB } from './input';
import type { GhostInfo, HoverInfo, PlanTool, SelectBox, Session } from './session';

/** Cursor travel (px²) that turns a click into a drag. */
const DRAG2 = 36;
/** Screen-edge pan band (px). */
const EDGE_BAND = 10;
/** Enclose tool: snap onto an enemy Hearth within this distance and keep the loop this far out. */
const HEARTH_SNAP = 8;
const HEARTH_MIN_RADIUS = 16;
const POINT_MIN_RADIUS = 4;
const ENCLOSE_MAX_RADIUS = 80;
/** A rival or orphaned real Flag on a planned loop costs more than a free node: it must be pulled first. */
const RIVAL_COST = 3;
/** Ring tool: one step beyond the current home Survey. */
const RING_STEP = 10;
const RING_MAX = 90;
/** Ring tool: radius decrement when the full step does not fit. */
const RING_RETRY = 3;
/** Command View reveals focus points this close to an active own GCC (Geomantic Advice reaches farther from the table). */
const COMMAND_REVEAL_RADIUS = 60;
/** Minimum time between enclose re-plans while the cursor moves (ms). */
const ENCLOSE_THROTTLE = 90;
/** Survey changes elsewhere (rivals planting) refresh a standing plan preview at most this often (ms). */
const PREVIEW_REFRESH = 250;

type OrderKind = 'none' | 'pull' | 'attack' | 'gather' | 'pushArm' | 'pushTo' | 'follow' | 'plant' | 'move' | 'defend';

const ORDER_LABEL: Record<OrderKind, string> = {
  none: '',
  pull: 'RMB  Pull this Flag',
  attack: 'RMB  Attack',
  gather: 'RMB  Gather lumber',
  pushArm: 'RMB  Push the Command Center…',
  pushTo: 'RMB  Push the Command Center here',
  follow: 'RMB  Follow the vexillomancer',
  plant: 'RMB  Plant a Flag here',
  move: 'RMB  Move   Ctrl+RMB  Defend',
  defend: 'Ctrl+RMB  Defend here',
};

/** Ping kind for the thing under the aim: enemy targets → attack, Ley Nodes → flag, else rally. */
export function pingKindAt(world: World, f: FactionId, hover: HoverInfo): PingKind {
  const he = hover.entity;
  if (he >= 0) {
    const fl = world.flags.get(he);
    if (fl && fl.owner !== f) return 'attack';
    const h = world.hippies.get(he);
    if (h && h.faction !== f && h.faction !== -1) return 'attack';
    const av = world.avatars.get(he);
    if (av && av.faction !== f) return 'attack';
    const b = world.buildings.get(he);
    if (b && b.faction !== f && b.faction !== -1) return 'attack';
    const pc = world.pieces.get(he);
    if (pc && pc.faction !== f && pc.faction !== -1) return 'attack';
  }
  return hover.node >= 0 ? 'flag' : 'rally';
}

/**
 * Plan cost of a Ley Node for faction `f` (Command View Survey tools): 0 already held (real or
 * implied), 1 free plantable node, RIVAL_COST a rival or orphaned real Flag that can be pulled,
 * Infinity otherwise. `relax` loosens the rules to name what walls a loop off when none exists:
 * 1 also passes Stabilize-protected Flags, 2 also every unblocked node.
 */
export function planNodeCost(world: World, f: FactionId, n: number, relax = 0): number {
  const sv = world.survey;
  if (sv.holder[n] === f) return 0;
  const flagId = sv.nodeFlag[n];
  if (flagId >= 0) {
    const fl = world.flags.get(flagId);
    return fl && (relax > 0 || !isFlagProtected(world, fl)) ? RIVAL_COST : Infinity;
  }
  if (canPlantAt(world, n, f)) return 1;
  return relax > 1 && !world.lattice.nodes[n].blocked ? 1 : Infinity;
}

export class CommandView {
  private input: Input;
  private queue: Command[];
  private box: SelectBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private boxing = false;
  private lmbDown = false;
  private grab: V2 = { x: 0, z: 0 };
  private grabbing = false;
  private g1: V2 = { x: 0, z: 0 };
  private g0: V2 = { x: 0, z: 0 };
  private v = new Vector3();
  private sx = 0;
  private sy = 0;
  /** GCC armed for a push order (second right-click picks the destination), or -1. */
  private pushArm: EntityId | -1 = -1;
  private okind: OrderKind = 'none';
  private otarget = -1;
  private ownCount = 0;
  private promptTag: OrderKind | 'enclose' | 'ring' = 'none';
  private promptCount = -1;
  private promptRival = -1;
  private promptText = '';
  private lastTool: PlanTool = 'select';

  // Planner cost context (the closure is created once and reads these).
  private cw: World | null = null;
  private cf: FactionId = 0;
  /** Diagnostic relaxation passed to planNodeCost (0 = the real rules). */
  private relax = 0;
  private readonly cost = (n: number): number => (this.cw ? planNodeCost(this.cw, this.cf, n, this.relax) : Infinity);

  // Enclose preview cache.
  private encX = NaN;
  private encZ = NaN;
  private encVersion = -1;
  private encAt = 0;
  private encLoop: number[] | null = null;
  private encNew = 0;
  private encRival = 0;
  /** Why no enclosure loop exists for the current preview ('' while one does). */
  private encWhy = '';
  // Ring preview cache.
  private ringVersion = -1;
  private ringAt = -Infinity;
  private ringLoop: number[] | null = null;
  private ringNew = 0;
  private ringRival = 0;
  /** Rival Flags on the loop last counted by countLoop. */
  private loopRival = 0;
  // Pentacle hover.
  private focus = -1;
  // Home Survey BFS scratch.
  private seen: Uint8Array = new Uint8Array(0);
  private bfs: number[] = [];

  constructor(input: Input, queue: Command[]) {
    this.input = input;
    this.queue = queue;
  }

  /** Forget per-visit state (entering/leaving the view, new match). */
  reset(s: Session): void {
    this.pushArm = -1;
    this.boxing = false;
    this.lmbDown = false;
    this.grabbing = false;
    s.selectBox = null;
    this.encLoop = null;
    this.encVersion = -1;
    this.encX = NaN;
    this.ringVersion = -1;
    this.ringAt = -Infinity;
    this.focus = -1;
    this.input.setCursor('');
  }

  /** Pan / zoom the Command View target (runs before the camera update). */
  controlCamera(s: Session, dt: number): void {
    const inp = this.input;
    const cam = s.camera;
    const w = inp.width;
    const h = inp.height;
    const aspect = w / h;
    let px = inp.moveX;
    let pz = inp.moveY;
    if (inp.isDown('KeyW') || inp.isDown('ArrowUp')) pz -= 1;
    if (inp.isDown('KeyS') || inp.isDown('ArrowDown')) pz += 1;
    if (inp.isDown('KeyA') || inp.isDown('ArrowLeft')) px -= 1;
    if (inp.isDown('KeyD') || inp.isDown('ArrowRight')) px += 1;
    if (inp.hasCursor && !inp.buttons[LMB] && !inp.buttons[MMB] && !inp.buttons[RMB]) {
      if (inp.mx < EDGE_BAND) px -= 1;
      else if (inp.mx > w - EDGE_BAND) px += 1;
      if (inp.my < EDGE_BAND) pz -= 1;
      else if (inp.my > h - EDGE_BAND) pz += 1;
    }
    if (px !== 0 || pz !== 0) {
      const l = Math.max(1, Math.hypot(px, pz));
      const speed = cam.cmdHeight * 0.9 * (inp.shift ? 2 : 1);
      cam.cmdX += (px / l) * speed * dt;
      cam.cmdZ += (pz / l) * speed * dt;
    }
    const nx = (inp.mx / w) * 2 - 1;
    const ny = 1 - (inp.my / h) * 2;
    if (inp.wheel !== 0) {
      // Zoom toward the cursor: the ground point under it stays put.
      const had = commandGroundPoint(cam, nx, ny, aspect, this.g0);
      const next = cam.cmdHeight * Math.exp(inp.wheel * 0.0012);
      cam.cmdHeight = next < CMD_HEIGHT_MIN ? CMD_HEIGHT_MIN : next > CMD_HEIGHT_MAX ? CMD_HEIGHT_MAX : next;
      if (had && commandGroundPoint(cam, nx, ny, aspect, this.g1)) {
        cam.cmdX += this.g0.x - this.g1.x;
        cam.cmdZ += this.g0.z - this.g1.z;
      }
    }
    if (inp.buttonPressed(MMB)) this.grabbing = commandGroundPoint(cam, nx, ny, aspect, this.grab);
    if (!inp.buttons[MMB]) this.grabbing = false;
    else if (this.grabbing && inp.dragDist2(MMB) > DRAG2 && commandGroundPoint(cam, nx, ny, aspect, this.g1)) {
      // Grab-pan: the map point under the cursor follows it.
      cam.cmdX += this.grab.x - this.g1.x;
      cam.cmdZ += this.grab.z - this.g1.z;
    }
    const lim = MAP_HALF + 10;
    cam.cmdX = cam.cmdX < -lim ? -lim : cam.cmdX > lim ? lim : cam.cmdX;
    cam.cmdZ = cam.cmdZ < -lim ? -lim : cam.cmdZ > lim ? lim : cam.cmdZ;
  }

  /**
   * Selection, orders, plan tools and building placement after picking. `ghost` is the building
   * ghost when the building tool is active. Returns true when Esc asks to leave the view.
   */
  frame(world: World, s: Session, f: FactionId, camera: THREE.PerspectiveCamera, ghost: GhostInfo | null): boolean {
    const inp = this.input;
    this.pruneSelection(world, s);
    if (s.planTool !== this.lastTool) this.toolChanged(s);

    // Hotkeys.
    let exit = false;
    if (inp.wasPressed('KeyN')) this.setTool(s, 'node');
    if (inp.wasPressed('KeyE')) this.setTool(s, 'enclose');
    if (inp.wasPressed('KeyP')) this.setTool(s, 'pentacle');
    if (inp.wasPressed('KeyR')) this.setTool(s, 'ring');
    if (inp.wasPressed('Backspace')) this.queue.push({ t: 'plan', faction: f, op: 'clear', nodes: [] });
    if (inp.wasPressed('Escape')) {
      if (s.planTool !== 'select') this.setTool(s, 'select');
      else if (s.tool === 'building') s.tool = 'flag';
      else if (this.pushArm >= 0) this.pushArm = -1;
      else exit = true;
    }

    this.classify(world, s, f);
    this.updatePreview(world, s, f);

    // Left button: place / plan / select.
    if (inp.buttonPressed(LMB)) {
      if (s.tool === 'building') {
        if (ghost && ghost.valid) {
          this.queue.push({ t: 'placeBuilding', faction: f, kind: s.buildingKind, facet: ghost.facet });
          if (!inp.shift) s.tool = 'flag';
        }
      } else if (s.planTool !== 'select') this.planClick(world, s, f);
      else this.lmbDown = true;
    }
    if (this.lmbDown && inp.buttons[LMB] && inp.dragDist2(LMB) > DRAG2) {
      this.boxing = true;
      this.box.x0 = inp.downX[LMB];
      this.box.y0 = inp.downY[LMB];
      this.box.x1 = inp.mx;
      this.box.y1 = inp.my;
      s.selectBox = this.box;
    }
    if (this.lmbDown && !inp.buttons[LMB]) {
      if (this.boxing) this.boxSelect(world, s, f, camera);
      else this.clickSelect(s);
      this.lmbDown = false;
      this.boxing = false;
      s.selectBox = null;
    }

    // Right button: cancel a tool, else a context order for the selected Signifiers.
    if (inp.buttonPressed(RMB)) {
      if (s.tool === 'building') s.tool = 'flag';
      else if (s.planTool !== 'select') this.setTool(s, 'select');
      else this.issueOrder(world, s, f);
    }

    // Middle click (no drag) pings the spot.
    if (inp.buttonReleased(MMB) && inp.dragDist2(MMB) <= DRAG2 && s.hover.point) {
      const p = s.hover.point;
      this.queue.push({ t: 'ping', faction: f, kind: pingKindAt(world, f, s.hover), at: { x: p.x, z: p.z } });
    }

    inp.setCursor(this.grabbing && inp.buttons[MMB] ? 'grabbing' : s.planTool !== 'select' || s.tool === 'building' || this.pushArm >= 0 ? 'crosshair' : 'default');
    s.prompt = this.prompt(s);
    return exit;
  }

  private setTool(s: Session, tool: PlanTool): void {
    s.planTool = s.planTool === tool ? 'select' : tool;
    this.toolChanged(s);
  }

  private toolChanged(s: Session): void {
    this.lastTool = s.planTool;
    s.planPreview = [];
    this.encLoop = null;
    this.encVersion = -1;
    this.encX = NaN;
    this.ringVersion = -1;
    this.ringAt = -Infinity;
    this.focus = -1;
  }

  private pruneSelection(world: World, s: Session): void {
    for (const id of s.selection) {
      if (!world.hippies.has(id) && !world.buildings.has(id) && !world.flags.has(id) && !world.avatars.has(id)) s.selection.delete(id);
    }
  }

  /** What a right-click would do right now (shared by the prompt and the order). */
  private classify(world: World, s: Session, f: FactionId): void {
    this.ownCount = 0;
    for (const id of s.selection) {
      const h = world.hippies.get(id);
      if (h && h.faction === f) this.ownCount++;
    }
    this.okind = 'none';
    this.otarget = -1;
    if (this.ownCount === 0 || !s.hover.point) return;
    if (this.pushArm >= 0) {
      this.okind = 'pushTo';
      return;
    }
    const he = s.hover.entity;
    if (he >= 0) {
      this.otarget = he;
      const fl = world.flags.get(he);
      if (fl && (fl.owner !== f || fl.state === 'loose')) {
        this.okind = 'pull';
        return;
      }
      const pc = world.pieces.get(he);
      if (pc && pc.faction !== f) {
        this.okind = 'attack';
        return;
      }
      const b = world.buildings.get(he);
      if (b && b.faction !== f && b.faction !== -1) {
        this.okind = 'attack';
        return;
      }
      if (b && b.kind === 'gcc' && b.faction === f) {
        this.okind = 'pushArm';
        return;
      }
      if (world.piles.has(he)) {
        this.okind = 'gather';
        return;
      }
      const h = world.hippies.get(he);
      if (h && h.faction !== f && h.faction !== -1) {
        this.okind = 'attack';
        return;
      }
      const av = world.avatars.get(he);
      if (av) {
        this.okind = av.faction === f ? 'follow' : 'attack';
        return;
      }
    }
    const node = s.hover.node;
    if (node >= 0 && canPlantAt(world, node, f)) {
      this.okind = 'plant';
      this.otarget = node;
      return;
    }
    this.okind = this.input.ctrl ? 'defend' : 'move';
  }

  private issueOrder(world: World, s: Session, f: FactionId): void {
    const p = s.hover.point;
    if (this.okind === 'none' || !p) {
      if (this.ownCount === 0) s.post('Select Signifiers first: drag a box over your hippies.');
      return;
    }
    if (this.okind === 'pushArm') {
      this.pushArm = this.otarget;
      return;
    }
    let order: HippieOrder;
    const at = { x: p.x, z: p.z };
    switch (this.okind) {
      case 'pull':
        order = { kind: 'pull', flagId: this.otarget };
        break;
      case 'attack':
        order = { kind: 'attack', target: this.otarget };
        break;
      case 'gather':
        order = { kind: 'gather', pileId: this.otarget };
        break;
      case 'follow':
        order = { kind: 'follow', avatarId: this.otarget };
        break;
      case 'plant':
        order = { kind: 'plant', node: this.otarget };
        break;
      case 'pushTo':
        order = { kind: 'push', gccId: this.pushArm, to: at };
        this.pushArm = -1;
        break;
      case 'defend':
        order = { kind: 'defend', at };
        break;
      default:
        order = { kind: 'move', to: at };
    }
    const hippies: EntityId[] = [];
    for (const id of s.selection) {
      const h = world.hippies.get(id);
      if (h && h.faction === f) hippies.push(id);
    }
    this.queue.push({ t: 'order', faction: f, hippies, order });
    this.mark(s, p.x, p.z, order.kind);
  }

  private mark(s: Session, x: number, z: number, kind: HippieOrder['kind'] | 'plan'): void {
    s.orderMarker = { x, z, kind, at: performance.now() };
  }

  private clickSelect(s: Session): void {
    const he = s.hover.entity;
    if (this.input.shift) {
      if (he < 0) return;
      if (s.selection.has(he)) s.selection.delete(he);
      else s.selection.add(he);
      return;
    }
    s.selection.clear();
    if (he >= 0) s.selection.add(he);
  }

  private boxSelect(world: World, s: Session, f: FactionId, camera: THREE.PerspectiveCamera): void {
    const b = this.box;
    const x0 = Math.min(b.x0, b.x1);
    const x1 = Math.max(b.x0, b.x1);
    const y0 = Math.min(b.y0, b.y1);
    const y1 = Math.max(b.y0, b.y1);
    if (!this.input.shift) s.selection.clear();
    for (const h of world.hippies.values()) {
      if (h.faction !== f || !this.project(camera, h.pos.x, 0.9, h.pos.z)) continue;
      if (this.sx >= x0 && this.sx <= x1 && this.sy >= y0 && this.sy <= y1) s.selection.add(h.id);
    }
  }

  /** World → canvas CSS px into (sx, sy); false when behind the camera. */
  private project(camera: THREE.PerspectiveCamera, x: number, y: number, z: number): boolean {
    this.v.set(x, y, z).project(camera);
    if (this.v.z > 1) return false;
    this.sx = ((this.v.x + 1) / 2) * this.input.width;
    this.sy = ((1 - this.v.y) / 2) * this.input.height;
    return true;
  }

  // ── Survey planning ──────────────────────────────────────────────────────────

  private updatePreview(world: World, s: Session, f: FactionId): void {
    const p = s.hover.point;
    switch (s.planTool) {
      case 'node': {
        const n = s.hover.node;
        if (n < 0) s.planPreview.length = 0;
        else if (s.planPreview.length !== 1 || s.planPreview[0] !== n) {
          s.planPreview.length = 0;
          s.planPreview.push(n);
        }
        return;
      }
      case 'enclose': {
        if (!p) return;
        let x = p.x;
        let z = p.z;
        let minRadius = POINT_MIN_RADIUS;
        const hearth = this.enemyHearthNear(world, f, x, z);
        if (hearth) {
          x = hearth.x;
          z = hearth.z;
          minRadius = HEARTH_MIN_RADIUS;
        }
        const version = world.survey.version * 1000 + world.lattice.version;
        const now = performance.now();
        const moved = Math.hypot(x - this.encX, z - this.encZ) > 1.5 || Number.isNaN(this.encX);
        // Cursor moves re-plan quickly; Survey changes elsewhere only a few times a second.
        if ((moved || version !== this.encVersion) && now - this.encAt >= (moved ? ENCLOSE_THROTTLE : PREVIEW_REFRESH)) {
          this.encX = x;
          this.encZ = z;
          this.encVersion = version;
          this.encAt = now;
          this.cw = world;
          this.cf = f;
          this.encLoop = planEnclosure(world.lattice, { x, z, minRadius, maxRadius: ENCLOSE_MAX_RADIUS, cost: this.cost });
          this.encNew = this.countLoop(this.encLoop);
          this.encRival = this.loopRival;
          this.encWhy = this.encLoop ? '' : this.encloseBlocker(world, x, z, minRadius);
          s.planPreview = this.encLoop ? this.encLoop.slice() : [];
        }
        return;
      }
      case 'pentacle': {
        const focus = p ? this.revealedFocusNear(world, f, s, p.x, p.z) : -1;
        if (focus !== this.focus) {
          this.focus = focus;
          s.planPreview = focus >= 0 ? pentacleOf(world.lattice, focus) : [];
        }
        return;
      }
      case 'ring': {
        const version = world.survey.version * 1000 + world.lattice.version;
        const now = performance.now();
        if (version === this.ringVersion || now - this.ringAt < PREVIEW_REFRESH) return;
        this.ringAt = now;
        this.ringVersion = version;
        const hearth = world.hearthOf(f);
        if (!hearth) {
          this.ringLoop = null;
          s.planPreview = [];
          return;
        }
        const home = Math.max(START_HOME_RING_RADIUS, this.homeSurveyRadius(world, f));
        this.cw = world;
        this.cf = f;
        // A full step out may run into the burn's edge or obstacles: take the widest ring that fits.
        this.ringLoop = null;
        for (let r = Math.min(RING_MAX, home + RING_STEP); r > home && !this.ringLoop; r -= RING_RETRY) {
          this.ringLoop = planRing(world.lattice, hearth.pos.x, hearth.pos.z, r, this.cost);
        }
        this.ringNew = this.countLoop(this.ringLoop);
        this.ringRival = this.loopRival;
        s.planPreview = this.ringLoop ? this.ringLoop.slice() : [];
        return;
      }
      case 'simulacra':
      case 'select':
        return;
    }
  }

  private planClick(world: World, s: Session, f: FactionId): void {
    const plan = world.factions[f].plan;
    switch (s.planTool) {
      case 'node': {
        const n = s.hover.node;
        if (n < 0) return;
        this.queue.push({ t: 'plan', faction: f, op: plan.has(n) ? 'remove' : 'add', nodes: [n] });
        this.markNode(world, s, n);
        return;
      }
      case 'enclose':
        if (this.encLoop) this.commit(world, s, f, this.encLoop);
        return;
      case 'pentacle':
        if (this.focus >= 0) this.commit(world, s, f, pentacleOf(world.lattice, this.focus));
        return;
      case 'ring':
        if (this.ringLoop) this.commit(world, s, f, this.ringLoop);
        return;
      case 'simulacra': {
        const n = s.hover.node;
        if (n < 0 || !canPlantAt(world, n, f) || s.planPreview.includes(n)) return;
        s.planPreview.push(n);
        this.markNode(world, s, n);
        if (s.planPreview.length >= 2) {
          this.queue.push({ t: 'gcc', faction: f, action: 'simulacra', target: -1, nodes: [s.planPreview[0], s.planPreview[1]] });
          s.planTool = 'select';
          this.toolChanged(s);
        }
        return;
      }
      case 'select':
        return;
    }
  }

  /** Add a planned loop; nodes we already hold only by implication need no real Flag. */
  private commit(world: World, s: Session, f: FactionId, loop: readonly number[]): void {
    const sv = world.survey;
    const nodes: number[] = [];
    let cx = 0;
    let cz = 0;
    for (const n of loop) {
      cx += world.lattice.nodes[n].x;
      cz += world.lattice.nodes[n].z;
      if (sv.holder[n] === f && sv.nodeFlagOwner[n] !== f) continue;
      nodes.push(n);
    }
    if (nodes.length === 0) return;
    this.queue.push({ t: 'plan', faction: f, op: 'add', nodes });
    this.mark(s, cx / loop.length, cz / loop.length, 'plan');
  }

  private markNode(world: World, s: Session, n: number): void {
    const node = world.lattice.nodes[n];
    this.mark(s, node.x, node.z, 'plan');
  }

  /** Flags a loop still needs planted (returned); rival Flags to pull on it go to `loopRival`. */
  private countLoop(loop: number[] | null): number {
    this.loopRival = 0;
    if (!loop) return 0;
    let k = 0;
    for (const n of loop) {
      const c = this.cost(n);
      if (c === RIVAL_COST) this.loopRival++;
      else if (c > 0) k++;
    }
    return k;
  }

  /**
   * Short reason no enclosure exists around (x, z): relax the node rules a step at a time (at
   * most two extra plans, only when the real one fails) to name what walls the loop off.
   */
  private encloseBlocker(world: World, x: number, z: number, minRadius: number): string {
    const lat = world.lattice;
    if (lat.facetAt(x, z) < 0) return 'Enclose: beyond the Ley Lattice';
    const opts = { x, z, minRadius, maxRadius: ENCLOSE_MAX_RADIUS, cost: this.cost };
    let why: string;
    this.relax = 2;
    if (!planEnclosure(lat, opts)) {
      const room = lat.half - LATTICE_MARGIN - Math.max(Math.abs(x), Math.abs(z));
      why = room < minRadius + lat.edge ? 'Enclose: too close to the edge of the burn' : 'Enclose: obstacles leave no Ley loop within reach';
    } else {
      this.relax = 1;
      why = planEnclosure(lat, opts) ? 'Enclose: a Stabilize Zone shields the Flags in the way' : 'Enclose: camp buildings and Crystals wall it off';
    }
    this.relax = 0;
    return why;
  }

  private enemyHearthNear(world: World, f: FactionId, x: number, z: number): V2 | null {
    for (const fac of world.factions) {
      if (fac.id === f) continue;
      for (const id of fac.hearthIds) {
        const b = world.buildings.get(id);
        if (b && Math.hypot(b.pos.x - x, b.pos.z - z) <= HEARTH_SNAP) return b.pos;
      }
    }
    return null;
  }

  /** Nearest focus to (x, z) that the player can see (same reveal rule the Survey layer draws). */
  private revealedFocusNear(world: World, f: FactionId, s: Session, x: number, z: number): number {
    const lat = world.lattice;
    const fac = world.factions[f];
    const dust = fac.drugActive.dust > world.time;
    const gcc = gccActive(world, f) ? world.gccOf(f) : undefined;
    const reach = s.viewBlend > 0.5 ? COMMAND_REVEAL_RADIUS : GCC.adviceRadius;
    let best = -1;
    let bestD = Math.max(6, lat.edge);
    for (const n of world.survey.focusNodes) {
      const node = lat.nodes[n];
      if (!dust && (!gcc || Math.hypot(node.x - gcc.pos.x, node.z - gcc.pos.z) > reach)) continue;
      const d = Math.hypot(node.x - x, node.z - z);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /** Farthest facet centre of the home Survey (the enclosed component around the main Hearth). */
  private homeSurveyRadius(world: World, f: FactionId): number {
    const hearth = world.hearthOf(f);
    if (!hearth) return 0;
    const lat = world.lattice;
    const start = lat.facetAt(hearth.pos.x, hearth.pos.z);
    if (start < 0 || !world.inSurvey(start, f)) return 0;
    if (this.seen.length !== lat.facets.length) this.seen = new Uint8Array(lat.facets.length);
    else this.seen.fill(0);
    const q = this.bfs;
    q.length = 0;
    q.push(start);
    this.seen[start] = 1;
    let r = 0;
    for (let i = 0; i < q.length; i++) {
      const fc = lat.facets[q[i]];
      r = Math.max(r, Math.hypot(fc.cx - hearth.pos.x, fc.cz - hearth.pos.z));
      for (const nb of fc.neighbors) {
        if (nb < 0 || this.seen[nb] || !world.inSurvey(nb, f)) continue;
        this.seen[nb] = 1;
        q.push(nb);
      }
    }
    return r;
  }

  private prompt(s: Session): string | null {
    if (s.tool === 'building') return null; // the controls compose the building prompt from the ghost
    switch (s.planTool) {
      case 'node':
        return 'LMB  Toggle planned Ley Node   RMB  Done';
      case 'enclose':
        return this.encLoop ? this.label('enclose', this.encNew, this.encRival) : this.encWhy || 'Enclose: point at a spot or an enemy Hearth';
      case 'pentacle':
        return this.focus >= 0 ? 'LMB  Plan pentacle around this Crystal focus   RMB  Cancel' : 'Pentacle: point at a revealed Crystal focus';
      case 'ring':
        return this.ringLoop ? this.label('ring', this.ringNew, this.ringRival) : 'Ring: no home ring fits here';
      case 'simulacra':
        return s.planPreview.length === 0 ? 'Flag Simulacra: choose the first node   RMB  Cancel' : 'Flag Simulacra: choose the second node, far from the first';
      case 'select':
        break;
    }
    if (this.pushArm >= 0) return 'RMB  Push the Command Center here   Esc  Cancel';
    if (this.okind === 'none') return this.ownCount > 0 ? null : 'Drag  Select Signifiers   Tab  Return';
    return this.label(this.okind, this.ownCount);
  }

  /** Counted prompt text, rebuilt only when its inputs change (no per-frame string churn). */
  private label(tag: OrderKind | 'enclose' | 'ring', n: number, rival = 0): string {
    if (tag === this.promptTag && n === this.promptCount && rival === this.promptRival) return this.promptText;
    this.promptTag = tag;
    this.promptCount = n;
    this.promptRival = rival;
    if (tag === 'enclose' || tag === 'ring') {
      const pull = rival > 0 ? ` · ${rival} rival Flag${rival === 1 ? '' : 's'} to pull` : '';
      const what = tag === 'enclose' ? 'enclosure' : 'home ring';
      this.promptText = `LMB  Plan ${what}: ${n} new Flag${n === 1 ? '' : 's'}${pull}   RMB  Cancel`;
    } else this.promptText = `${ORDER_LABEL[tag]}   (${n} selected)`;
    return this.promptText;
  }
}
