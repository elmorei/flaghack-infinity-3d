/**
 * Session: player-side presentation state (never simulation truth). Shared by game/
 * (controls write it), render/ (reads it) and ui/ (reads + writes panels/tools).
 */
import { DEFAULT_MATCH } from "../sim/matchSettings";
import { defaultControls } from "./bindings";
import type { Severity } from '../sim/events';
import type { V2, V3 } from '../sim/math';
import type { BuildingKind, Difficulty, EntityId, FactionId, HippieOrder, PieceKind } from '../sim/types';

/**
 * 'lobby': configuring a local or hosted match (the attract burn plays behind it).
 * 'paused' online only opens the menu: the host's burn keeps running.
 */
export type Screen = 'title' | 'lobby' | 'playing' | 'paused' | 'ended';

/**
 * A world-space objective marker (tutorial goals; render/survey draws them, the tutorial UI
 * points at off-screen ones). Exactly one anchor applies: node, entity or at.
 */
export interface ObjectiveMarker {
  id: string;
  kind: 'node' | 'entity' | 'point' | 'area';
  node?: number;
  entity?: EntityId;
  at?: V2;
  /** Area markers: ring radius (m). */
  radius?: number;
  label?: string;
  /** Default FLAG_YELLOW. */
  color?: number;
}
export type ViewMode = 'action' | 'command';
/** Action-mode tool (what LMB / E do). */
export type ToolKind = 'flag' | 'wall' | 'floor' | 'ramp' | 'demolish' | 'building';
/**
 * Command View Survey planning tool. 'simulacra' = Flag Simulacra targeting: the next two
 * plan-node clicks become the superposed pair (UI arms it; controls collect + submit).
 */
export type PlanTool = 'select' | 'node' | 'enclose' | 'pentacle' | 'ring' | 'simulacra';

export interface AimInfo {
  /** Throw aim held (RMB) or quick-throw preview. */
  active: boolean;
  /** Predicted throw arc points (world). */
  arc: V3[];
  landing: V3 | null;
  /** Node the throw would plant on (-1 none). */
  node: number;
}

export interface GhostInfo {
  kind: PieceKind | BuildingKind;
  edge: number;
  facet: number;
  level: number;
  rampEdge: number;
  valid: boolean;
  reason: string;
}

export interface HoverInfo {
  /** Ground/structure point under the crosshair (action) or cursor (command). */
  point: V3 | null;
  node: number;
  facet: number;
  edge: number;
  entity: EntityId | -1;
}

/** Command View drag-select rectangle in canvas CSS pixels. */
export interface SelectBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A just-issued Command View order or plan commit, for a brief ground acknowledgement. */
export interface OrderMarker {
  x: number;
  z: number;
  kind: HippieOrder['kind'] | 'plan';
  /** performance.now() when issued. */
  at: number;
}

export interface FeedItem {
  id: number;
  text: string;
  severity: Severity;
  /** performance.now() when posted. */
  at: number;
  pos?: V2;
}

export interface Settings {
  match: import("../sim/matchSettings").MatchSettings;
  controls: import("./bindings").ControlSettings;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  mouseSensitivity: number;
  invertMouseY: boolean;
  quality: 'low' | 'medium' | 'high';
  showFps: boolean;
  difficulty: Difficulty;
}

export interface CameraState {
  /** Action camera orbit yaw/pitch (radians) and distance. */
  yaw: number;
  pitch: number;
  dist: number;
  /** Command View camera target and zoom (height). */
  cmdX: number;
  cmdZ: number;
  cmdHeight: number;
}

export class Session {
  playerFaction: FactionId = 0;
  screen: Screen = 'title';
  view: ViewMode = 'action';
  /** Camera blend 0 = action, 1 = command (animated by controls). */
  viewBlend = 0;
  tool: ToolKind = 'flag';
  buildingKind: BuildingKind = 'workshop';
  planTool: PlanTool = 'select';
  selection = new Set<EntityId>();
  hover: HoverInfo = { point: null, node: -1, facet: -1, edge: -1, entity: -1 };
  aim: AimInfo = { active: false, arc: [], landing: null, node: -1 };
  ghost: GhostInfo | null = null;
  /** Nodes previewed by a planning tool before committing (Command View). */
  planPreview: number[] = [];
  /** Command View LMB drag-select rectangle (UI draws it), or null. */
  selectBox: SelectBox | null = null;
  /** Last Command View order/plan click (render draws a fading ground marker). */
  orderMarker: OrderMarker | null = null;
  pointerLocked = false;
  /** Lattice overlay visible in action mode (L toggles). */
  showLattice = true;
  panels = { chakras: false, codex: false, degen: false, help: false, settings: false };
  /** Context prompt shown near the crosshair, e.g. "E  Pull Flag". */
  prompt: string | null = null;
  /** Progress 0..1 of the current channel (pull/align) for the crosshair ring, or -1. */
  channel = -1;
  feed: FeedItem[] = [];
  camera: CameraState = { yaw: 0, pitch: 0.35, dist: 6.5, cmdX: 0, cmdZ: 0, cmdHeight: 120 };
  settings: Settings = {
    match: {...DEFAULT_MATCH, active:[...DEFAULT_MATCH.active]},
    controls: defaultControls(),
    masterVolume: 0.8,
    musicVolume: 0.6,
    sfxVolume: 0.9,
    mouseSensitivity: 1,
    invertMouseY: false,
    quality: 'high',
    showFps: false,
    difficulty: 'normal',
  };
  debug = false;
  /** Online spectator: watches without a seat (no gameplay input, free camera). */
  spectator = false;
  /** Online: player handles by seat (nameplates, Hearth rail, feed). Empty offline. */
  playerNames: Partial<Record<FactionId, string>> = {};
  /** Online spectator / fallen camp: the faction whose vexillomancer the camera follows ([ and ] cycle), else null. */
  followFaction: FactionId | null = null;
  /** World objective markers (tutorial). Owned by the tutorial director; cleared on new match. */
  markers: ObjectiveMarker[] = [];
  private feedId = 1;

  post(text: string, severity: Severity = 'info', pos?: V2): void {
    this.feed.push({ id: this.feedId++, text, severity, at: performance.now(), pos });
    if (this.feed.length > 40) this.feed.splice(0, this.feed.length - 40);
  }
}
