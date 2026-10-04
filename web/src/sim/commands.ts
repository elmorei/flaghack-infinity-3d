/**
 * Commands are the ONLY way the player UI and NPC AI change the simulation.
 * Submit with world.submit(cmd); the simulation validates and applies them at the start of
 * the next tick (see systems/commands.ts). Invalid commands emit a 'rejected' event and
 * change nothing.
 */
import type { V2 } from './math';
import type {
  AbilityId,
  AvatarInput,
  BuildingKind,
  ChakraId,
  DrugId,
  EntityId,
  FactionId,
  GccAction,
  HippieOrder,
  JobKind,
  PieceKind,
  PingKind,
} from './types';

export type Command =
  /** Continuous avatar control; latest one per tick wins. */
  | { t: 'avatarInput'; faction: FactionId; input: AvatarInput }
  /** Plant a carried Flag on a node within reach. */
  | { t: 'plant'; faction: FactionId; node: number }
  /** Throw a carried Flag along the avatar's current aim (yaw/pitch from input). */
  | { t: 'throw'; faction: FactionId }
  /** Begin pulling a planted/loose Flag within reach (channel; cancelled by moving away). */
  | { t: 'pull'; faction: FactionId; flagId: EntityId }
  /** Hand a carried Flag to a neutral hippie within reach. */
  | { t: 'handFlag'; faction: FactionId; hippieId: EntityId }
  /** Staff swing (melee / harvest). */
  | { t: 'swing'; faction: FactionId }
  /** Fortnite-style piece. Wall: edge; floor/ramp: facet (+ rampEdge low-side index). */
  | { t: 'build'; faction: FactionId; kind: PieceKind; edge: number; facet: number; level: number; rampEdge: number }
  | { t: 'demolish'; faction: FactionId; pieceId: EntityId }
  /** Camp building on a thick facet inside own Survey. */
  | { t: 'placeBuilding'; faction: FactionId; kind: BuildingKind; facet: number }
  /** Edit the faction's Survey plan. 'set' replaces it. */
  | { t: 'plan'; faction: FactionId; op: 'add' | 'remove' | 'set' | 'clear'; nodes: number[] }
  | { t: 'jobWeights'; faction: FactionId; weights: Partial<Record<JobKind, number>> }
  | { t: 'order'; faction: FactionId; hippies: EntityId[]; order: HippieOrder | null }
  /** Rally hippies within radius of the avatar to follow it (G). */
  | { t: 'rally'; faction: FactionId }
  /** Send all followers at a target point/entity (H). */
  | { t: 'sendFollowers'; faction: FactionId; at: V2; target: EntityId | -1 }
  | { t: 'ability'; faction: FactionId; ability: AbilityId; at: V2; node: number }
  | { t: 'align'; faction: FactionId; chakra: ChakraId }
  | { t: 'drug'; faction: FactionId; drug: DrugId }
  | { t: 'brew'; faction: FactionId; labId: EntityId; drug: DrugId }
  /** GCC actions. simulacra: nodes [a, b]; dialectics: none. */
  | { t: 'gcc'; faction: FactionId; action: GccAction; target: EntityId | -1; nodes: number[] }
  /** Start/stop pushing the own GCC (avatar must be within 3 m). */
  | { t: 'pushGcc'; faction: FactionId; on: boolean }
  | { t: 'ping'; faction: FactionId; kind: PingKind; at: V2 }
  | { t: 'retransmit'; faction: FactionId }
  /** Pick up a dropped D.E.G.E.N. beacon within reach. */
  | { t: 'tapBeacon'; faction: FactionId; beaconId: EntityId };

export type CommandType = Command['t'];
export type CommandOf<T extends CommandType> = Extract<Command, { t: T }>;
