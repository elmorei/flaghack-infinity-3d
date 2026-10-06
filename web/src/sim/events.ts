/**
 * Game events emitted by sim systems via world.emit(). Consumers (render, ui, audio, ai)
 * read them once per frame via world.drainEvents(). Events are facts that already happened.
 */
import type { V2, V3 } from './math';
import type {
  AbilityId,
  BuildingKind,
  CaptureStage,
  ChakraId,
  DrugId,
  EntityId,
  FactionId,
  GccAction,
  Owner,
  PieceKind,
  PingKind,
} from './types';

export type Severity = 'info' | 'good' | 'warn' | 'danger' | 'epic';

export type GameEvent =
  // Flags
  | { t: 'flagPlanted'; flagId: EntityId; node: number; faction: Owner; by: EntityId | -1; pos: V3 }
  | { t: 'flagPulled'; flagId: EntityId; node: number; faction: Owner; prevOwner: Owner; by: EntityId | -1; pos: V3 }
  | { t: 'flagThrown'; flagId: EntityId; faction: FactionId; from: V3; vel: V3 }
  | { t: 'flagLanded'; flagId: EntityId; node: number; pos: V3 }
  | { t: 'flagDecohered'; flagId: EntityId; node: number; pos: V3 }
  | { t: 'flagCrafted'; flagId: EntityId; faction: FactionId; at: EntityId }
  | { t: 'simulacrumCollapsed'; flagId: EntityId; kept: number; vanished: number; faction: FactionId }
  // Survey geometry
  | { t: 'leyLine'; edge: number; faction: FactionId; on: boolean }
  | { t: 'facetCrystallized'; facet: number; faction: FactionId }
  | { t: 'surveyChanged'; faction: FactionId; gained: number[]; lost: number[]; size: number }
  | { t: 'phasonFlip'; node: number; from: V2; to: V2; cause: 'tide' | 'ability' | 'storm' }
  | { t: 'tideWarning'; at: number }
  /**
   * A Phason Tide begins: `flips` nodes are chosen and turn as a wave front sweeps the burn
   * along unit vector `dir` over `duration` s (each turn arrives as its own phasonFlip; Flags
   * observed by their owner hold, so fewer may actually flip).
   */
  | { t: 'tide'; flips: number; dir?: V2; duration?: number }
  | { t: 'crystalManifest'; crystalId: EntityId; node: number; faction: FactionId; pos: V2 }
  | { t: 'crystalShatter'; crystalId: EntityId; node: number; faction: FactionId; pos: V2 }
  | { t: 'instability'; facet: number; level: 'shimmer' | 'discharge' | 'storm'; pos: V2 }
  | { t: 'discharge'; from: V3; to: V3; target: EntityId | -1 }
  // Conquest
  | { t: 'hearthStage'; hearthId: EntityId; faction: Owner; stage: CaptureStage; prev: CaptureStage; attacker: FactionId | null }
  | { t: 'captured'; hearthId: EntityId; from: Owner; to: FactionId; pos: V2 }
  | { t: 'eliminated'; faction: FactionId; by: FactionId | null }
  /** `reason` 'dawn': no single camp was left at DAWN_TIME and the dominant one was crowned. */
  | { t: 'victory'; faction: FactionId; reason?: 'conquest' | 'dawn' }
  | { t: 'burn' } // The Burn / sudden death begins
  // Units & combat
  | { t: 'swing'; by: EntityId; pos: V3; yaw: number }
  | { t: 'hit'; target: EntityId; by: EntityId | -1; amount: number; pos: V3 }
  | { t: 'ko'; id: EntityId; kind: 'avatar' | 'hippie'; faction: Owner; by: EntityId | -1; pos: V3 }
  | { t: 'respawn'; id: EntityId; kind: 'avatar' | 'hippie'; faction: Owner; pos: V3 }
  | { t: 'recruited'; hippieId: EntityId; faction: FactionId; via: 'drumcircle' | 'gcc' | 'hand' | 'throw' | 'dialectics' }
  | { t: 'distracted'; hippieId: EntityId; faction: Owner }
  | { t: 'harvest'; pileId: EntityId; by: EntityId; amount: number; pos: V2 }
  | { t: 'lumberDelivered'; faction: FactionId; amount: number; pos: V2 }
  // Structures
  | { t: 'pieceBuilt'; pieceId: EntityId; kind: PieceKind; faction: Owner; pos: V3 }
  | { t: 'pieceDestroyed'; pieceId: EntityId; kind: PieceKind; faction: Owner; pos: V3 }
  | { t: 'buildingPlaced'; buildingId: EntityId; kind: BuildingKind; faction: Owner; pos: V2 }
  | { t: 'buildingDone'; buildingId: EntityId; kind: BuildingKind; faction: Owner; pos: V2 }
  | { t: 'buildingDisabled'; buildingId: EntityId; kind: BuildingKind; faction: Owner; pos: V2 }
  | { t: 'buildingRepaired'; buildingId: EntityId; kind: BuildingKind; faction: Owner; pos: V2 }
  | { t: 'wardLightning'; buildingId: EntityId; flagId: EntityId; faction: Owner; from: V3; to: V3 }
  | { t: 'wardPulse'; buildingId: EntityId; faction: Owner; pos: V2 }
  // Economy / progression
  | { t: 'brewed'; faction: FactionId; drug: DrugId }
  | { t: 'drugUsed'; faction: FactionId; drug: DrugId }
  | { t: 'drugExpired'; faction: FactionId; drug: DrugId }
  | { t: 'alignStart'; faction: FactionId; chakra: ChakraId }
  | { t: 'aligned'; faction: FactionId; chakra: ChakraId; level: number }
  | { t: 'alignInterrupted'; faction: FactionId; chakra: ChakraId }
  | { t: 'ability'; faction: FactionId; ability: AbilityId; level: number; pos: V2; by: EntityId }
  | { t: 'gccAction'; faction: FactionId; action: GccAction; gccId: EntityId; pos: V2 }
  | { t: 'gccDestroyed'; faction: FactionId; gccId: EntityId; pos: V2 }
  | { t: 'gccRebuilt'; faction: FactionId; gccId: EntityId; pos: V2 }
  // D.E.G.E.N. mesh
  | { t: 'ping'; pingId: EntityId; kind: PingKind; faction: FactionId; pos: V2 }
  | { t: 'meshTapped'; faction: FactionId; target: FactionId; until: number }
  | { t: 'retransmit'; faction: FactionId }
  // Rejections and narration (UI feed, never required for correctness)
  | { t: 'rejected'; faction: FactionId; reason: string }
  | { t: 'notify'; faction: FactionId | 'all'; text: string; severity: Severity; pos?: V2 };

export type GameEventType = GameEvent['t'];
export type EventOf<T extends GameEventType> = Extract<GameEvent, { t: T }>;
