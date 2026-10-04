import { matchSettings } from "../sim/matchSettings";
/**
 * Player controls: keyboard/mouse → camera, Session presentation state and Commands. Only
 * `app.submit(cmd)` changes the simulation: the continuous avatarInput every tick, and discrete
 * commands queued per frame and flushed right after that tick's avatarInput (so a throw flies
 * along the freshest aim). Action mode (third person, crosshair), the Command View (the GCC
 * table) and the title cinematic share one camera rig, so every hand-over is a smooth blend.
 * Owner: Controls agent.
 */
import { Vector3 } from 'three';
import type { Command, CommandOf } from '../sim/commands';
import { ALIGN_TIME, AVATAR, BUILDINGS, LEY_EDGE, PIECE } from '../sim/constants';
import { angleDiff, clamp, wrapAngle } from '../sim/math';
import type { V3 } from '../sim/math';
import { isFlagProtected } from '../sim/systems/abilities';
import { throwOrigin } from '../sim/systems/avatars';
import { isCollapsed } from '../sim/systems/buildings';
import { canRecruit, handFlagBlocker } from '../sim/systems/recruitment';
import { canPlantAt, nearestPlantableNode } from '../sim/systems/flags';
import { CHAKRA_ABILITY, CHAKRAS, DRUGS, FACTION_IDS } from '../sim/types';
import type { Avatar, Building, BuildingKind, EntityId, FactionId, Flag, PieceKind } from '../sim/types';
import type { World } from '../sim/world';
import { MAX_RANGE_PITCH, solveThrowPitch, ThrowPredictor } from './aim';
import type { AppApi } from './app';
import { BuildGhost } from './buildMode';
import { CameraRig, PITCH_MAX, PITCH_MIN } from './cameraRig';
import { CommandView, pingKindAt } from './commandView';
import { Input, LMB, MMB, RMB } from './input';
import { Picker } from './picking';
import type { GhostInfo, Screen, Session, ToolKind, ViewMode } from './session';

const DEG = Math.PI / 180;
/** View blend durations (s): the Tab swoop and the slower GCC Command Table dive. */
const BLEND_TIME = 0.6;
const DIVE_TIME = 1.35;
/** Command View height when arriving through the table. */
const DIVE_CMD_HEIGHT = 150;
/** Hold E this long at your GCC to start pushing it. */
const GCC_HOLD = 0.4;
/** Mouse-look radians per pixel at sensitivity 1, and the precision factor while aiming. */
const LOOK_SPEED = 0.0022;
const AIM_LOOK_SCALE = 0.7;
const NODE_PICK = 2.5;
const EDGE_PICK = 3;
const PICK_RANGE = 600;
/** Range along a sky-bound crosshair that still picks units/Flags. */
const SKY_PICK = 80;
/** Command View: small targets are at least this many pixels wide. */
const CMD_PICK_PX = 14;
/** While E is held on a pull, the next pull is re-issued at most this often (s). */
const PULL_RETRY = 0.2;
/** Holding Q keeps throwing after this delay (s). */
const Q_REPEAT_DELAY = 0.35;
/** Below this horizontal distance the Flag is tossed at your feet. */
const TOSS_DIST = 0.3;
const TOSS_PITCH = -1.2;
/** Starting action-camera orbit pitch for a new match. */
const START_PITCH = 0.32;
/** Spectators: the table's opening overview height, how fast it glides after a followed avatar, and the chase cam's turn rate. */
const SPECTATE_HEIGHT = 200;
const FOLLOW_GLIDE = 4;
const CHASE_TURN = 3;

/** Keys the game owns while playing (default browser behaviour suppressed, except Esc). */
const GAME_KEYS: Record<string, true> = {
  KeyW: true,
  KeyA: true,
  KeyS: true,
  KeyD: true,
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
  Space: true,
  ShiftLeft: true,
  ShiftRight: true,
  ControlLeft: true,
  ControlRight: true,
  KeyE: true,
  KeyQ: true,
  KeyF: true,
  KeyZ: true,
  KeyX: true,
  KeyC: true,
  KeyV: true,
  KeyB: true,
  KeyG: true,
  KeyH: true,
  KeyP: true,
  KeyT: true,
  KeyK: true,
  KeyJ: true,
  KeyL: true,
  KeyN: true,
  KeyR: true,
  Digit1: true,
  Digit2: true,
  Digit3: true,
  Digit4: true,
  Digit5: true,
  Digit6: true,
  Digit7: true,
  Digit8: true,
  F1: true,
  Tab: true,
  Backquote: true,
  Backspace: true,
  Escape: true,
  // Spectators and fallen camps: cycle the followed vexillomancer.
  BracketLeft: true,
  BracketRight: true,
};
/** Build tool keys: press again (or F) to put the tool away. */
const TOOL_KEYS: Record<string, ToolKind> = { KeyZ: 'wall', KeyX: 'floor', KeyC: 'ramp', KeyV: 'demolish' };
const PIECE_TOOL: Partial<Record<ToolKind, PieceKind>> = { wall: 'wall', floor: 'floor', ramp: 'ramp' };
const ABILITY_KEYS: readonly string[] = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'];
const DRUG_KEYS: readonly string[] = ['Digit6', 'Digit7', 'Digit8'];
/** B walks the camp buildings, then puts the tool away. */
const BUILD_CYCLE: readonly BuildingKind[] = ['workshop', 'drumcircle', 'ward', 'druglab'];

const PIECE_NAME: Record<PieceKind, string> = { wall: 'Tarp Wall', floor: 'Deck', ramp: 'Ramp' };
const BUILDING_NAME: Record<BuildingKind, string> = {
  hearth: 'Flag Hearth',
  workshop: 'Flag Workshop',
  drumcircle: 'Drum Circle',
  ward: 'Hearth Ward',
  druglab: 'Drug Lab',
  gcc: 'Geomantic Command Center',
};
const BUILD_PROMPT: Record<PieceKind, string> = {
  wall: `LMB  Build Tarp Wall (${PIECE.cost})`,
  floor: `LMB  Build Deck (${PIECE.cost})`,
  ramp: `LMB  Build Ramp (${PIECE.cost})`,
};
const DEMOLISH_PROMPT: Record<PieceKind, string> = {
  wall: `LMB  Demolish Tarp Wall (+${PIECE.refund})`,
  floor: `LMB  Demolish Deck (+${PIECE.refund})`,
  ramp: `LMB  Demolish Ramp (+${PIECE.refund})`,
};
const RAISE_PROMPT: Record<BuildingKind, string> = {
  hearth: '',
  workshop: `LMB  Raise Flag Workshop (${BUILDINGS.workshop.cost})`,
  drumcircle: `LMB  Raise Drum Circle (${BUILDINGS.drumcircle.cost})`,
  ward: `LMB  Raise Hearth Ward (${BUILDINGS.ward.cost})`,
  druglab: `LMB  Raise Drug Lab (${BUILDINGS.druglab.cost})`,
  gcc: '',
};

/** What E does right now. */
type ContextKind = 'none' | 'plant' | 'pull' | 'beacon' | 'gcc' | 'release' | 'handFlag';
const CONTEXT_PROMPT: Record<Exclude<ContextKind, 'pull'>, string> = {
  handFlag: 'E  Hand Flag to recruit Signifier',
  none: '',
  plant: 'E  Plant Flag',
  beacon: 'E  Tap the D.E.G.E.N. Beacon',
  gcc: 'E  Command Table   Hold E  Push',
  release: 'E  Release the Command Center',
};

/** A panel that needs the cursor is open (pointer stays unlocked; Esc closes it). */
function panelOpen(s: Session): boolean {
  const p = s.panels;
  return p.chakras || p.codex || p.help || p.settings;
}

/** The local player commands a seat in this world (not the attract burn, not an online spectator). */
function seated(world: World, s: Session): boolean {
  return !s.spectator && world.options.humans.includes(s.playerFaction);
}

/** Watching rather than playing: an online spectator, or a seat whose camp has fallen. */
function watching(world: World, s: Session): boolean {
  return s.spectator || (seated(world, s) && !world.factions[s.playerFaction].alive);
}

export class Controls {
  private app: AppApi;
  private input: Input;
  private rig = new CameraRig();
  private picker = new Picker();
  private thrower = new ThrowPredictor();
  private builder = new BuildGhost();
  private command: CommandView;
  /** Discrete commands waiting for the next tick (flushed right after its avatarInput). */
  private queue: Command[] = [];
  private world: World | null = null;
  private screen: Screen | null = null;
  private view: ViewMode = 'action';
  /** New world not yet set up for play (camera, tools). */
  private freshWorld = false;
  /** GCC whose tabletop the Command View was entered through (the dive), else null. */
  private dive: Building | null = null;

  // Aim: written per frame, read per tick.
  private aimYaw = 0;
  private throwPitch = 0;
  private throwQueued = false;
  private jumpLatch = false;
  /** Reused every tick (the sim copies the input it is given). */
  private inputCmd: CommandOf<'avatarInput'> = {
    t: 'avatarInput',
    faction: 0,
    input: { moveX: 0, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 },
  };

  // E context and holds.
  private ctxKind: ContextKind = 'none';
  private ctxNode = -1;
  private ctxTarget: EntityId | -1 = -1;
  private eMode: 'none' | 'pull' | 'gcc' = 'none';
  private eHeld = 0;
  private gccFired = false;
  private eGcc: Building | null = null;
  private lastPullAt = -Infinity;
  private lastSwingAt = -Infinity;
  private qHeld = 0;
  private lastThrowAt = -Infinity;
  // Turbo build / demolish: last slot acted on while LMB is held.
  private slotKind: PieceKind | '' = '';
  private slotEdge = -2;
  private slotFacet = -2;
  private slotLevel = -2;
  private slotRamp = -2;
  private lastDemolish: EntityId | -1 = -1;

  // Picking scratch.
  private hoverPoint: V3 = { x: 0, y: 0, z: 0 };
  private hand: V3 = { x: 0, y: 0, z: 0 };
  private ray = new Vector3();

  // Prompt caches (strings rebuilt only when their inputs change).
  private joinA: string | null = null;
  private joinB: string | null = null;
  private joined: string | null = null;
  private reasonKey = '';
  private reasonOf = '';
  private reasonText = '';
  private respawnSec = -1;
  private respawnText = '';

  constructor(app: AppApi, canvas: HTMLCanvasElement) {
    this.app = app;
    this.input = new Input(canvas);
    this.command = new CommandView(this.input, this.queue);
    const input = this.input;
    input.capturesKey = (code) => app.session.screen === 'playing' && (GAME_KEYS[code] === true || input.owns(code));
    input.onMenuBack = ()=>{const s=app.session;if(s.panels.settings)s.panels.settings=false;else if(s.panels.codex)s.panels.codex=false;else if(s.panels.help)s.panels.help=false;else if(s.panels.chakras)s.panels.chakras=false;else if(s.screen==='paused')app.setPaused(false);};
    input.onLockLost = () => {
      const s = app.session;
      if (s.screen === 'playing' && s.view === 'action' && !this.cursorWanted(s) && !this.spectating()) app.setPaused(true);
    };
    input.onCanvasDown = () => {
      const s = app.session;
      if (s.screen !== 'playing' || s.view !== 'action' || this.cursorWanted(s) || input.locked || input.lockUnavailable || this.spectating()) return false;
      input.requestLock(); // this click only grabs the pointer
      return true;
    };
    input.onKeyGesture = (code) => {
      // Pointer lock can only be requested inside a user gesture: take it now for keys that are
      // about to return the player to the action view.
      const s = app.session;
      if (s.screen !== 'playing' || this.spectating()) return;
      const p = s.panels;
      const open = (p.chakras ? 1 : 0) + (p.codex ? 1 : 0) + (p.help ? 1 : 0) + (p.settings ? 1 : 0);
      const closesLast = open === 1 && ((code === 'KeyK' && p.chakras) || (code === 'KeyJ' && p.codex) || (code === 'F1' && p.help));
      if ((code === 'Tab' && s.view === 'command' && open === 0) || (closesLast && s.view === 'action')) input.requestLock();
    };
  }

  /** Per frame: input → camera, session (hover/aim/ghost/prompt) and discrete commands. */
  update(dt: number): void {
    const app = this.app;
    const s = app.session;
    const world = app.world;
    if (!world) return;
    const fresh = world !== this.world;
    if (fresh) this.attachWorld(world, s);
    // A new burn (Play again) is a fresh start even when the screen stays 'playing'.
    if (fresh || s.screen !== this.screen) this.screenChanged(s);
    const f = s.playerFaction;
    const av = world.avatars.get(world.factions[f].avatarId);
    const inPlay = s.screen === 'playing' && av !== undefined && (seated(world, s) || s.spectator);
    const watcher = inPlay && watching(world, s);
    // A text field (chat) has the keyboard: keys held when it opened must not keep the vexillomancer running.
    this.input.controls = s.settings.controls;
    const typing = this.input.typing;
    this.input.pollGamepad(Math.min(dt,0.05),inPlay&&!typing&&!this.cursorWanted(s),s.view==='command');
    if (typing) this.input.clear();
    if (inPlay && av && this.freshWorld) this.beginMatch(s, av);

    if (inPlay && av) {
      this.toggles(world, s, av, watcher);
      if (s.view !== this.view) {
        if (s.view === 'command') this.enterCommand(s, watcher ? null : av.pos, null);
        else this.exitCommand(s);
      }
      if ((s.view === 'command' || watcher || typing || this.cursorWanted(s)) && this.input.locked) this.input.exitLock();
      s.pointerLocked = this.input.locked;
      if (s.view === 'command') this.command.controlCamera(s, dt);
      else if (!watcher) this.look(s);
      if (watcher) this.spectate(world, s, dt);
    }
    this.animateBlend(s, dt);
    this.updateCamera(world, s, av, watcher, dt);
    if (inPlay && av && !watcher && !typing) {
      this.pick(world, s, av);
      this.targetedKeys(s, av);
      if (s.view === 'action') this.actionFrame(world, s, av, dt);
      else this.commandFrame(world, s, av);
    } else this.idle(s);
    this.input.endFrame();
  }

  /** Per sim tick: submit the player's continuous avatarInput, then this frame's commands. */
  tick(): void {
    const s = this.app.session;
    const world = this.app.world;
    if (!world || world !== this.world || s.screen !== 'playing' || !seated(world, s)) return;
    const av = world.avatars.get(world.factions[s.playerFaction].avatarId);
    if (!av) return;
    if (!world.factions[s.playerFaction].alive) {
      // Spectating: a fallen camp sends nothing (commands queued this frame fall with it).
      this.queue.length = 0;
      this.throwQueued = false;
      return;
    }
    const inp = this.input;
    const cmd = this.inputCmd;
    const out = cmd.input;
    out.moveX = 0;
    out.moveZ = 0;
    out.jump = false;
    out.sprint = false;
    out.throwMode = false;
    if (s.view === 'action' && av.koUntil <= world.time) {
      // WASD relative to the camera yaw; yaw 0 faces +z, screen-right is (-cos, sin).
      const fwd = (inp.isDown('KeyW') ? 1 : 0) - (inp.isDown('KeyS') ? 1 : 0) - inp.moveY;
      const side = (inp.isDown('KeyD') ? 1 : 0) - (inp.isDown('KeyA') ? 1 : 0) + inp.moveX;
      const yaw = s.camera.yaw;
      let mx = Math.sin(yaw) * fwd - Math.cos(yaw) * side;
      let mz = Math.cos(yaw) * fwd + Math.sin(yaw) * side;
      const l = Math.hypot(mx, mz);
      if (l > 1) {
        mx /= l;
        mz /= l;
      }
      out.moveX = mx;
      out.moveZ = mz;
      out.jump = this.jumpLatch || inp.isDown('Space');
      out.throwMode = inp.buttons[RMB];
      out.sprint = inp.shift && !out.throwMode;
    }
    this.jumpLatch = false;
    // Face where the camera looks; a throw tick turns to the crosshair point with the solved arc.
    if (s.view === 'action') {
      out.yaw = this.throwQueued ? this.aimYaw : s.camera.yaw;
      out.pitch = this.throwQueued ? this.throwPitch : -s.camera.pitch;
    }
    cmd.faction = s.playerFaction;
    this.app.submit(cmd);
    for (const c of this.queue) this.app.submit(c);
    this.queue.length = 0;
    this.throwQueued = false;
  }

  dispose(): void {
    this.input.dispose();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  private attachWorld(world: World, s: Session): void {
    this.world = world;
    this.queue.length = 0;
    this.throwQueued = false;
    this.jumpLatch = false;
    this.dive = null;
    // A fresh burn always opens in the action view (quitting from the table must not leave
    // the title screen tinted as the Command View).
    s.view = 'action';
    s.viewBlend = 0;
    this.view = 'action';
    s.followFaction = null;
    if (s.spectator) {
      // A spectator starts over the table, looking down on the whole burn.
      s.view = 'command';
      s.viewBlend = 1;
      this.view = 'command';
      s.camera.cmdX = 0;
      s.camera.cmdZ = 0;
      s.camera.cmdHeight = SPECTATE_HEIGHT;
      this.rig.snapCommand(s.camera);
    }
    this.freshWorld = true;
    this.rig.resetFollow();
    this.command.reset(s);
    this.releaseHolds();
    s.selection.clear();
    s.planPreview = [];
    s.planTool = 'select';
    s.tool = 'flag';
    s.orderMarker = null;
  }

  /**
   * Watching instead of playing: an online spectator, or a camp that has fallen while the burn
   * plays on. The camera still works (orbit or chase cam, Command View pan/zoom, [ and ] cycle
   * the followed vexillomancer), the pointer stays free for the menus, and no gameplay input
   * reaches the sim.
   */
  private spectating(): boolean {
    const w = this.app.world;
    return w !== null && watching(w, this.app.session);
  }

  /** A modal wants the mouse (panels, the Training Burn's graduation): no lock, no auto-pause. */
  private cursorWanted(s: Session): boolean {
    return panelOpen(s) || this.app.tutorial?.state.phase === 'graduated';
  }

  /**
   * Spectator frame. Esc lets go of the followed vexillomancer, else backs out of the table (a
   * fallen camp's orbit) or opens the menu. The table glides after the followed avatar until a
   * hand pans it; the chase cam turns with the followed avatar's facing.
   */
  private spectate(world: World, s: Session, dt: number): void {
    const inp = this.input;
    if (inp.wasPressed('BracketRight')) this.cycleFollow(world, s, 1);
    if (inp.wasPressed('BracketLeft')) this.cycleFollow(world, s, -1);
    let target = this.followed(world, s);
    if (inp.wasPressed('Escape')) {
      if (target) {
        s.followFaction = null;
        target = null;
      } else if (s.view === 'command' && !s.spectator) this.exitCommand(s);
      else this.app.setPaused(true);
    }
    const cam = s.camera;
    if (s.view === 'command') {
      const panning = inp.isDown('KeyW') || inp.isDown('KeyA') || inp.isDown('KeyS') || inp.isDown('KeyD') || inp.isDown('ArrowUp') || inp.isDown('ArrowDown') || inp.isDown('ArrowLeft') || inp.isDown('ArrowRight') || inp.buttons[MMB];
      if (target && panning) {
        s.followFaction = null;
        target = null;
      }
      if (target) {
        const k = Math.min(1, dt * FOLLOW_GLIDE);
        cam.cmdX += (target.pos.x - cam.cmdX) * k;
        cam.cmdZ += (target.pos.z - cam.cmdZ) * k;
      }
    } else if (target) {
      const k = Math.min(1, dt * CHASE_TURN);
      cam.yaw = wrapAngle(cam.yaw + angleDiff(cam.yaw, target.yaw) * k);
      cam.pitch += (START_PITCH - cam.pitch) * k;
    } else if (s.spectator) {
      // Nobody left to stand behind: back over the table.
      this.enterCommand(s, null, null);
    }
    s.selection.clear();
    if (s.planPreview.length > 0) s.planPreview = [];
    s.planTool = 'select';
    s.tool = 'flag';
  }

  /** A faction whose vexillomancer can be followed: still in the burn, with a body. */
  private followable(world: World, f: FactionId): Avatar | null {
    const fac = world.factions[f];
    if (!fac.alive) return null;
    return world.avatars.get(fac.avatarId) ?? null;
  }

  /** The followed vexillomancer, letting go when its camp has fallen. */
  private followed(world: World, s: Session): Avatar | null {
    if (s.followFaction === null) return null;
    const av = this.followable(world, s.followFaction);
    if (!av) s.followFaction = null;
    return av;
  }

  private cycleFollow(world: World, s: Session, dir: 1 | -1): void {
    const n = FACTION_IDS.length;
    const from = s.followFaction ?? (dir > 0 ? n - 1 : 0);
    for (let i = 1; i <= n; i++) {
      const f = FACTION_IDS[(from + dir * i + n) % n];
      if (!this.followable(world, f)) continue;
      if (f !== s.followFaction) {
        s.followFaction = f;
        // Glide to the new subject instead of cutting.
        this.rig.startTransition(0.7);
      }
      return;
    }
    s.followFaction = null;
  }

  /** First playing frame of a match: camera behind the vexillomancer, facing the burn. */
  private beginMatch(s: Session, av: Avatar): void {
    this.freshWorld = false;
    s.camera.yaw = av.yaw;
    s.camera.pitch = START_PITCH;
    this.aimYaw = av.yaw;
    this.view = s.view;
  }

  private screenChanged(s: Session): void {
    this.screen = s.screen;
    this.input.clear();
    this.releaseHolds();
    s.selectBox = null;
    if (s.screen === 'playing') {
      // Keys belong to the burn now, not to the menu button that started it.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      // Resume / Begin: the click that got us here still counts as a gesture.
      if (s.view === 'action' && !this.cursorWanted(s) && !this.spectating()) this.input.requestLock();
    } else this.input.exitLock();
  }

  private releaseHolds(): void {
    this.eMode = 'none';
    this.eHeld = 0;
    this.gccFired = false;
    this.eGcc = null;
    this.qHeld = 0;
    this.slotKind = '';
    this.lastDemolish = -1;
  }

  private toggles(world: World, s: Session, av: Avatar, watcher: boolean): void {
    const inp = this.input;
    const p = s.panels;
    if (inp.wasPressed('Escape') && panelOpen(s)) {
      p.chakras = false;
      p.codex = false;
      p.help = false;
      p.settings = false;
      inp.consume('Escape');
    }
    if (inp.wasPressed('KeyK') && !watcher) p.chakras = !p.chakras;
    if (inp.wasPressed('KeyJ')) p.codex = !p.codex;
    if (inp.wasPressed('F1')) p.help = !p.help;
    if (inp.wasPressed('KeyL')) s.showLattice = !s.showLattice;
    if (inp.wasPressed('Backquote')) s.debug = !s.debug;
    if (inp.wasPressed('Tab')) {
      if (s.view === 'action') {
        const target = watcher ? this.followed(world, s) : av;
        this.enterCommand(s, target ? target.pos : null, null);
      } else {
        // A spectator's chase cam needs someone to chase.
        if (s.spectator && s.followFaction === null) this.cycleFollow(world, s, 1);
        if (!s.spectator || s.followFaction !== null) this.exitCommand(s);
      }
    }
  }

  /** Enter the Command View centred on `at` (null keeps the table where it was) or dive through a GCC. */
  private enterCommand(s: Session, at: { x: number; z: number } | null, gcc: Building | null): void {
    this.view = 'command';
    s.view = 'command';
    this.dive = gcc;
    const cam = s.camera;
    const centre = gcc ? gcc.pos : at;
    if (centre) {
      cam.cmdX = centre.x;
      cam.cmdZ = centre.z;
    }
    if (gcc) cam.cmdHeight = DIVE_CMD_HEIGHT;
    this.rig.snapCommand(cam);
    this.input.exitLock();
    this.releaseHolds();
    this.command.reset(s);
    s.aim.active = false;
    s.aim.arc.length = 0;
    s.aim.landing = null;
    s.aim.node = -1;
  }

  private exitCommand(s: Session): void {
    this.view = 'action';
    s.view = 'action';
    // Leaving mid-dive: glide from wherever the dive got to.
    if (this.dive && s.viewBlend < 1) this.rig.startTransition(0.45);
    this.dive = null;
    this.command.reset(s);
    s.planTool = 'select';
    s.planPreview = [];
    s.ghost = null;
    this.releaseHolds();
  }

  // ── Camera ─────────────────────────────────────────────────────────────────

  private look(s: Session): void {
    const inp = this.input;
    if ((!inp.locked && !inp.lockUnavailable && !inp.gamepadActive) || this.cursorWanted(s)) return;
    const k = LOOK_SPEED * s.settings.mouseSensitivity * (s.aim.active ? AIM_LOOK_SCALE : 1);
    const cam = s.camera;
    cam.yaw = wrapAngle(cam.yaw - inp.dx * k);
    cam.pitch = clamp(cam.pitch + inp.lookY(s.settings.invertMouseY) * k, PITCH_MIN, PITCH_MAX);
  }

  private animateBlend(s: Session, dt: number): void {
    const target = s.view === 'command' ? 1 : 0;
    const step = dt / (this.dive ? DIVE_TIME : BLEND_TIME);
    s.viewBlend = target > s.viewBlend ? Math.min(target, s.viewBlend + step) : Math.max(target, s.viewBlend - step);
  }

  private updateCamera(world: World, s: Session, av: Avatar | undefined, watcher: boolean, dt: number): void {
    const rig = this.rig;
    const f = s.playerFaction;
    if (s.screen === 'title' || s.screen === 'lobby' || !av || !(seated(world, s) || s.spectator)) {
      rig.setMode('title', 1.6);
      rig.updateTitle(world, f, dt);
    } else if (s.screen === 'ended') {
      rig.setMode('ended', 2.2);
      rig.updateEnded(world, f, dt);
    } else {
      rig.setMode('play', 1.8);
      // Watchers ride along with whoever they follow; a fallen camp otherwise orbits its own body.
      const subject = (watcher ? this.followed(world, s) : null) ?? av;
      const sprinting = Math.hypot(subject.vel.x, subject.vel.z) > AVATAR.runSpeed + 0.5;
      rig.updatePlay(world, subject, subject.faction, s.camera, s.viewBlend, this.dive, s.aim.active && !watcher, sprinting, dt);
    }
    // Camera trauma: VFX adds it, the camera spends it (muted over the tactical table).
    const shared = this.app.renderer.ctx?.shared;
    let trauma = 0;
    if (shared) {
      trauma = shared.shake ?? 0;
      shared.shake = Math.max(0, trauma - dt * 1.5);
    }
    rig.apply(this.app.renderer.camera, Math.min(1, trauma) * (1 - s.viewBlend), dt);
  }

  // ── Picking ────────────────────────────────────────────────────────────────

  private pick(world: World, s: Session, av: Avatar): void {
    const f = s.playerFaction;
    const camera = this.app.renderer.camera;
    const hv = s.hover;
    let ox: number;
    let oy: number;
    let oz: number;
    let dx: number;
    let dy: number;
    let dz: number;
    const commandView = s.view === 'command';
    if (commandView) {
      const w = this.input.width;
      const h = this.input.height;
      this.ray.set((this.input.mx / w) * 2 - 1, 1 - (this.input.my / h) * 2, 0.5).unproject(camera).sub(camera.position).normalize();
      ox = camera.position.x;
      oy = camera.position.y;
      oz = camera.position.z;
      dx = this.ray.x;
      dy = this.ray.y;
      dz = this.ray.z;
    } else {
      // Crosshair ray, started at the avatar's depth so nothing behind you is picked.
      const o = this.rig.origin;
      const d = this.rig.dir;
      const t0 = Math.max(0, (av.pos.x - o.x) * d.x + (av.pos.y + 1 - o.y) * d.y + (av.pos.z - o.z) * d.z - 0.6);
      ox = o.x + d.x * t0;
      oy = o.y + d.y * t0;
      oz = o.z + d.z * t0;
      dx = d.x;
      dy = d.y;
      dz = d.z;
    }
    const picker = this.picker;
    if (!picker.cast(world, ox, oy, oz, dx, dy, dz, PICK_RANGE)) {
      hv.point = null;
      hv.node = -1;
      hv.edge = -1;
      hv.facet = -1;
      hv.entity = picker.entityAlong(world, f, ox, oy, oz, dx, dy, dz, SKY_PICK, 0, commandView);
      return;
    }
    const p = this.hoverPoint;
    p.x = picker.point.x;
    p.y = picker.point.y;
    p.z = picker.point.z;
    hv.point = p;
    let minR = 0;
    let nodeR = NODE_PICK;
    if (commandView) {
      // Metres per pixel at the cursor's depth: tiny Signifiers stay clickable from on high.
      const wpp = (2 * picker.dist * Math.tan((camera.fov * DEG) / 2)) / this.input.height;
      minR = Math.min(6, CMD_PICK_PX * wpp);
      nodeR = clamp(CMD_PICK_PX * wpp, NODE_PICK, matchSettings(world.options).gridScale / 2);
    }
    const lat = world.lattice;
    hv.node = lat.nearestNode(p.x, p.z, nodeR);
    hv.edge = lat.nearestEdge(p.x, p.z, EDGE_PICK);
    hv.facet = lat.facetAt(p.x, p.z);
    hv.entity = picker.entityAlong(world, f, ox, oy, oz, dx, dy, dz, picker.dist + 1, minR, commandView);
  }

  // ── Keys shared by both views ──────────────────────────────────────────────

  private targetedKeys(s: Session, av: Avatar): void {
    const inp = this.input;
    const f = s.playerFaction;
    const hv = s.hover;
    const ax = hv.point ? hv.point.x : av.pos.x;
    const az = hv.point ? hv.point.z : av.pos.z;
    for (let i = 0; i < ABILITY_KEYS.length; i++) {
      if (inp.wasPressed(ABILITY_KEYS[i])) {
        this.queue.push({ t: 'ability', faction: f, ability: CHAKRA_ABILITY[CHAKRAS[i]], at: { x: ax, z: az }, node: hv.node });
      }
    }
    for (let i = 0; i < DRUG_KEYS.length; i++) {
      if (inp.wasPressed(DRUG_KEYS[i])) this.queue.push({ t: 'drug', faction: f, drug: DRUGS[i] });
    }
    if (inp.wasPressed('KeyG')) this.queue.push({ t: 'rally', faction: f });
    if (inp.wasPressed('KeyH')) this.queue.push({ t: 'sendFollowers', faction: f, at: { x: ax, z: az }, target: hv.entity });
    if (inp.wasPressed('KeyT')) this.queue.push({ t: 'retransmit', faction: f });
    if (inp.wasPressed('KeyB')) {
      if (s.tool !== 'building') s.tool = 'building';
      else {
        const next = BUILD_CYCLE.indexOf(s.buildingKind) + 1;
        if (next >= BUILD_CYCLE.length) {
          s.tool = 'flag';
          s.buildingKind = BUILD_CYCLE[0];
        } else s.buildingKind = BUILD_CYCLE[next];
      }
    }
  }

  // ── Action mode ────────────────────────────────────────────────────────────

  private actionFrame(world: World, s: Session, av: Avatar, dt: number): void {
    const inp = this.input;
    const f = s.playerFaction;
    const down = av.koUntil > world.time;
    if (inp.wasPressed('Escape') && !inp.locked) this.app.setPaused(true);
    inp.setCursor(inp.lockUnavailable ? 'crosshair' : '');

    // Tools.
    if (inp.wasPressed('KeyF')) s.tool = 'flag';
    for (const code in TOOL_KEYS) {
      if (inp.wasPressed(code)) s.tool = s.tool === TOOL_KEYS[code] ? 'flag' : TOOL_KEYS[code];
    }

    this.solveAim(s, av);
    // Throw mode remains active with an empty quiver so nearby loose Flags can be collected.
    const aiming = !down && inp.buttons[RMB];
    if (aiming) {
      this.thrower.predict(world, av, f, this.aimYaw, this.throwPitch, s.aim);
      s.aim.active = true;
    } else this.clearAim(s);

    s.ghost = down || aiming ? null : this.ghostFor(world, s, av);
    this.resolveContext(world, s, av);

    if (down) {
      if (this.eMode === 'pull' || this.eMode === 'gcc') this.releaseHolds();
    } else {
      this.contextKey(world, s, av, dt);
      if (inp.wasPressed('Space')) this.jumpLatch = true;
      if (inp.wasPressed('KeyQ')) {
        this.qHeld = 0;
        this.tryThrow(world, av);
      } else if (inp.isDown('KeyQ')) {
        this.qHeld += dt;
        if (this.qHeld >= Q_REPEAT_DELAY && world.time - this.lastThrowAt >= AVATAR.throwCooldown) this.tryThrow(world, av);
      }
      if (aiming) {
        if (inp.buttonPressed(LMB)) this.tryThrow(world, av);
      } else this.primary(world, s);
      if (inp.wasPressed('KeyP') || (inp.buttonReleased(MMB) && inp.dragDist2(MMB) < 36)) {
        const p = s.hover.point;
        this.queue.push({ t: 'ping', faction: f, kind: pingKindAt(world, f, s.hover), at: { x: p ? p.x : av.pos.x, z: p ? p.z : av.pos.z } });
      }
    }
    s.channel = this.channel(world, av);
    s.prompt = this.actionPrompt(world, s, av, aiming);
  }

  /**
   * Throw aim: yaw from the hand toward the crosshair point (so the shoulder offset does not
   * skew short throws) and the low-arc pitch that lands there; beyond reach, the longest throw.
   * The hand sits forward/right of the facing, so the origin is re-solved once with the new yaw.
   */
  private solveAim(s: Session, av: Avatar): void {
    const p = s.hover.point;
    let yaw = s.camera.yaw;
    let pitch = MAX_RANGE_PITCH;
    if (p) {
      for (let pass = 0; pass < 2; pass++) {
        const o = throwOrigin(av.pos, yaw, this.hand);
        const dx = p.x - o.x;
        const dz = p.z - o.z;
        const d = Math.hypot(dx, dz);
        if (d <= TOSS_DIST) {
          pitch = TOSS_PITCH;
          break;
        }
        yaw = Math.atan2(dx, dz);
        pitch = solveThrowPitch(d, p.y - o.y) ?? MAX_RANGE_PITCH;
      }
    }
    this.aimYaw = yaw;
    this.throwPitch = pitch - AVATAR.throwPitchBias;
  }

  private clearAim(s: Session): void {
    const aim = s.aim;
    aim.active = false;
    aim.arc.length = 0;
    aim.landing = null;
    aim.node = -1;
  }

  private tryThrow(world: World, av: Avatar): void {
    if (this.input.shift && !this.input.buttons[RMB]) return;
    if (av.carried.length === 0 || this.throwQueued) return;
    this.queue.push({ t: 'throw', faction: av.faction });
    this.throwQueued = true;
    this.lastThrowAt = world.time;
  }

  private ghostFor(world: World, s: Session, av: Avatar): GhostInfo | null {
    if (s.tool === 'building') return this.builder.building(world, s.playerFaction, s.buildingKind, s.hover.point);
    const kind = PIECE_TOOL[s.tool];
    if (!kind) return null;
    const o = this.rig.origin;
    const d = this.rig.dir;
    return this.builder.piece(world, s.playerFaction, kind, av, s.hover.point, o.x, o.y, o.z, d.x, d.y, d.z);
  }

  /** LMB in action mode: swing, Fortnite turbo-build, raise a building, demolish. */
  private primary(world: World, s: Session): void {
    const inp = this.input;
    const f = s.playerFaction;
    const pressed = inp.buttonPressed(LMB);
    const held = inp.buttons[LMB];
    if (!held && !pressed) {
      this.slotKind = '';
      this.lastDemolish = -1;
      return;
    }
    const piece = PIECE_TOOL[s.tool];
    if (piece) {
      const g = s.ghost;
      if (!g || !g.valid) return;
      const same = this.slotKind === piece && g.edge === this.slotEdge && g.facet === this.slotFacet && g.level === this.slotLevel && g.rampEdge === this.slotRamp;
      if (pressed || !same) {
        this.queue.push({ t: 'build', faction: f, kind: piece, edge: g.edge, facet: g.facet, level: g.level, rampEdge: g.rampEdge });
        this.slotKind = piece;
        this.slotEdge = g.edge;
        this.slotFacet = g.facet;
        this.slotLevel = g.level;
        this.slotRamp = g.rampEdge;
      }
      return;
    }
    switch (s.tool) {
      case 'flag':
        if (pressed || world.time - this.lastSwingAt >= AVATAR.swingTime) {
          this.queue.push({ t: 'swing', faction: f });
          this.lastSwingAt = world.time;
        }
        return;
      case 'building': {
        const g = s.ghost;
        if (pressed && g && g.valid) {
          this.queue.push({ t: 'placeBuilding', faction: f, kind: s.buildingKind, facet: g.facet });
          if (!inp.shift) s.tool = 'flag';
        }
        return;
      }
      case 'demolish': {
        const pc = world.pieces.get(s.hover.entity);
        if (pc && pc.faction === f && (pressed || pc.id !== this.lastDemolish)) {
          this.queue.push({ t: 'demolish', faction: f, pieceId: pc.id });
          this.lastDemolish = pc.id;
        }
        return;
      }
    }
  }

  // ── E: the context action ──────────────────────────────────────────────────

  private pullable(world: World, fl: Flag): boolean {
    return (fl.state === 'planted' || fl.state === 'loose') && !isFlagProtected(world, fl);
  }

  private gccInReach(av: Avatar, g: Building): boolean {
    if (isCollapsed(g)) return false;
    return Math.hypot(g.pos.x - av.pos.x, g.pos.z - av.pos.z) - BUILDINGS.gcc.radius <= AVATAR.gccPushReach && av.pos.y <= 1;
  }

  /**
   * What E does: the thing under the crosshair first (a pullable Flag, a rival beacon, your
   * GCC), then planting a carried Flag on the hovered or nearest free node, then whatever is in
   * reach (loose Flags, rival/orphan planted Flags, beacons, your GCC). Your own planted Flags
   * are only pulled when you aim at them, so a stray E never breaks your own loop.
   */
  private resolveContext(world: World, s: Session, av: Avatar): void {
    const f = s.playerFaction;
    this.ctxKind = 'none';
    this.ctxNode = -1;
    this.ctxTarget = -1;
    if (av.koUntil > world.time) return;
    if (av.pushing >= 0) {
      this.ctxKind = 'release';
      return;
    }
    const ax = av.pos.x;
    const az = av.pos.z;
    const he = s.hover.entity;
    if (he >= 0) {
      if (world.hippies.has(he) && !handFlagBlocker(world, f, he)) {
        this.ctxKind = 'handFlag';
        this.ctxTarget = he;
        return;
      }
      const fl = world.flags.get(he);
      if (fl && this.pullable(world, fl) && Math.hypot(fl.pos.x - ax, fl.pos.z - az) <= AVATAR.pullReach) {
        this.ctxKind = 'pull';
        this.ctxTarget = he;
        return;
      }
      const bc = world.beacons.get(he);
      if (bc && bc.faction !== f && Math.hypot(bc.pos.x - ax, bc.pos.z - az) <= AVATAR.beaconReach) {
        this.ctxKind = 'beacon';
        this.ctxTarget = he;
        return;
      }
      const b = world.buildings.get(he);
      if (b && b.kind === 'gcc' && b.faction === f && this.gccInReach(av, b)) {
        this.ctxKind = 'gcc';
        this.ctxTarget = he;
        return;
      }
    }
    if (av.carried.length > 0) {
      let node = s.hover.node;
      if (node >= 0) {
        const n = world.lattice.nodes[node];
        if (Math.hypot(n.x - ax, n.z - az) > AVATAR.plantReach || !canPlantAt(world, node, f)) node = -1;
      }
      if (node < 0) node = nearestPlantableNode(world, av.pos, AVATAR.plantReach, f);
      if (node >= 0) {
        this.ctxKind = 'plant';
        this.ctxNode = node;
        return;
      }
    }
    let best: EntityId | -1 = -1;
    let bestD: number = AVATAR.pullReach;
    for (const fl of world.flags.values()) {
      if (fl.state !== 'loose' && !(fl.state === 'planted' && fl.owner !== f)) continue;
      const d = Math.hypot(fl.pos.x - ax, fl.pos.z - az);
      if (d <= bestD && this.pullable(world, fl)) {
        best = fl.id;
        bestD = d;
      }
    }
    if (best >= 0) {
      this.ctxKind = 'pull';
      this.ctxTarget = best;
      return;
    }
    for (const bc of world.beacons.values()) {
      if (bc.faction !== f && Math.hypot(bc.pos.x - ax, bc.pos.z - az) <= AVATAR.beaconReach) {
        this.ctxKind = 'beacon';
        this.ctxTarget = bc.id;
        return;
      }
    }
    const g = world.gccOf(f);
    if (g && this.gccInReach(av, g)) {
      this.ctxKind = 'gcc';
      this.ctxTarget = g.id;
    }
  }

  private contextKey(world: World, s: Session, av: Avatar, dt: number): void {
    const inp = this.input;
    const f = s.playerFaction;
    if (inp.wasPressed('KeyE')) {
      switch (this.ctxKind) {
        case 'handFlag':
          this.queue.push({ t: 'handFlag', faction: f, hippieId: this.ctxTarget });
          break;
        case 'plant':
          this.queue.push({ t: 'plant', faction: f, node: this.ctxNode });
          break;
        case 'pull':
          this.queue.push({ t: 'pull', faction: f, flagId: this.ctxTarget });
          this.eMode = 'pull';
          this.lastPullAt = world.time;
          break;
        case 'beacon':
          this.queue.push({ t: 'tapBeacon', faction: f, beaconId: this.ctxTarget });
          break;
        case 'gcc':
          this.eMode = 'gcc';
          this.eHeld = 0;
          this.gccFired = false;
          this.eGcc = world.buildings.get(this.ctxTarget) ?? null;
          break;
        case 'release':
          this.queue.push({ t: 'pushGcc', faction: f, on: false });
          break;
        case 'none':
          break;
      }
    } else if (inp.isDown('KeyE')) {
      if (this.eMode === 'pull') {
        // Keep harvesting: once a pull lands, start on the next Flag in reach.
        if (av.action.kind !== 'pull' && this.ctxKind === 'pull' && world.time - this.lastPullAt >= PULL_RETRY) {
          this.queue.push({ t: 'pull', faction: f, flagId: this.ctxTarget });
          this.lastPullAt = world.time;
        }
      } else if (this.eMode === 'gcc') {
        this.eHeld += dt;
        if (!this.gccFired && this.eHeld >= GCC_HOLD) {
          this.queue.push({ t: 'pushGcc', faction: f, on: true });
          this.gccFired = true;
        }
      }
    }
    if (inp.wasReleased('KeyE')) {
      if (this.eMode === 'pull' && av.action.kind === 'pull') this.queue.push({ t: 'pull', faction: f, flagId: -1 });
      if (this.eMode === 'gcc' && !this.gccFired && this.eGcc && this.gccInReach(av, this.eGcc)) {
        this.enterCommand(s, av.pos, this.eGcc);
      }
      this.eMode = 'none';
      this.eGcc = null;
    }
  }

  private channel(world: World, av: Avatar): number {
    const act = av.action;
    let c = -1;
    if (act.kind === 'pull') c = (world.time - act.t) / act.dur;
    else if (act.kind === 'align') c = (world.time - act.t) / ALIGN_TIME;
    else if (act.kind === 'channel' && Number.isFinite(act.dur)) c = (world.time - act.t) / act.dur;
    else if (this.eMode === 'gcc' && !this.gccFired) c = this.eHeld / GCC_HOLD;
    return c < 0 ? -1 : Math.min(1, c);
  }

  // ── Command View ───────────────────────────────────────────────────────────

  private commandFrame(world: World, s: Session, av: Avatar): void {
    const f = s.playerFaction;
    const ghost = s.tool === 'building' ? this.builder.building(world, f, s.buildingKind, s.hover.point) : null;
    s.ghost = ghost;
    this.clearAim(s);
    const exit = this.command.frame(world, s, f, this.app.renderer.camera, ghost);
    if (s.tool === 'building') s.prompt = this.buildingPrompt(ghost, s.buildingKind);
    s.channel = this.channel(world, av);
    if (exit) this.exitCommand(s);
  }

  // ── Prompts ────────────────────────────────────────────────────────────────

  private actionPrompt(world: World, s: Session, av: Avatar, aiming: boolean): string | null {
    if (av.koUntil > world.time) {
      if (!Number.isFinite(av.koUntil)) return 'Flagless. No Hearth remains to call you back';
      const sec = Math.ceil(av.koUntil - world.time);
      if (sec !== this.respawnSec) {
        this.respawnSec = sec;
        this.respawnText = `Flagless. The Hearth calls you back in ${sec}`;
      }
      return this.respawnText;
    }
    if (aiming) {
      if (av.carried.length === 0) return 'Quiver empty: move near loose Flags to collect them';
      const target = world.hippies.get(s.hover.entity);
      if (target && canRecruit(target)) return 'LMB  Throw Flag to recruit Signifier';
      return s.aim.node >= 0 ? 'LMB  Throw: the Flag plants on the Ley Node' : 'LMB  Throw: the Flag lands loose';
    }
    let tool: string | null = null;
    const piece = PIECE_TOOL[s.tool];
    if (piece) {
      const g = s.ghost;
      tool = !g ? `${PIECE_NAME[piece]}: aim at the Ley Lattice` : g.valid ? BUILD_PROMPT[piece] : this.reason(PIECE_NAME[piece], g.reason);
    } else if (s.tool === 'building') tool = this.buildingPrompt(s.ghost, s.buildingKind);
    else if (s.tool === 'demolish') {
      const pc = world.pieces.get(s.hover.entity);
      tool = pc && pc.faction === s.playerFaction ? DEMOLISH_PROMPT[pc.kind] : 'Demolish: aim at one of your pieces';
    }
    let e: string | null = null;
    if (this.ctxKind === 'pull') e = this.pullPrompt(world, s.playerFaction);
    else if (this.ctxKind !== 'none') e = CONTEXT_PROMPT[this.ctxKind];
    return this.join(tool, e);
  }

  private pullPrompt(world: World, f: FactionId): string {
    const fl = world.flags.get(this.ctxTarget);
    if (!fl || fl.state === 'loose') return 'E  Take up Flag';
    if (fl.owner === f) return 'Hold E  Pull Flag';
    return fl.owner === -1 ? 'Hold E  Pull orphan Flag' : 'Hold E  Pull enemy Flag';
  }

  private buildingPrompt(g: GhostInfo | null, kind: BuildingKind): string {
    if (!g) return `${BUILDING_NAME[kind]}: aim at a Sun facet in your Survey`;
    return g.valid ? RAISE_PROMPT[kind] : this.reason(BUILDING_NAME[kind], g.reason);
  }

  /** "<thing>: <why not>" for an invalid ghost, rebuilt only when either part changes. */
  private reason(name: string, why: string): string {
    if (name !== this.reasonKey || why !== this.reasonOf) {
      this.reasonKey = name;
      this.reasonOf = why;
      this.reasonText = `${name}: ${why}`;
    }
    return this.reasonText;
  }

  private join(a: string | null, b: string | null): string | null {
    if (!a || !b) return a ?? b;
    if (a !== this.joinA || b !== this.joinB) {
      this.joinA = a;
      this.joinB = b;
      this.joined = `${a}   ${b}`;
    }
    return this.joined;
  }

  /** Not playing (title / paused / ended / spectating): nothing under the crosshair, nothing to prompt. */
  private idle(s: Session): void {
    const hv = s.hover;
    hv.point = null;
    hv.node = -1;
    hv.edge = -1;
    hv.facet = -1;
    hv.entity = -1;
    this.clearAim(s);
    s.ghost = null;
    s.prompt = null;
    s.channel = -1;
    s.selectBox = null;
    s.pointerLocked = this.input.locked;
    this.input.setCursor('');
  }
}
