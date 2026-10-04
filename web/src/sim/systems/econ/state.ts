/**
 * Private cross-tick state of the Economy systems (economy, buildings, pieces, abilities,
 * drugs, GCC). Lives in world.scratch so every new match starts clean; one typed instance
 * guarded by `instanceof` keeps the scratch access cast-free.
 */
import type { ShapeId } from '../../physics/collision';
import type { AvatarAction, Building, ChakraId, DrugId, EntityId, FactionId } from '../../types';
import type { World } from '../../world';

export interface AlignChannel {
  chakra: ChakraId;
  /** The exact action object put on the avatar; any replacement means the channel ended. */
  action: AvatarAction;
}

export interface DialecticsChannel {
  action: AvatarAction;
  gccId: EntityId;
}

export interface MarchEntry {
  faction: FactionId;
  until: number;
}

export interface PieceInfo {
  /** Node ids the piece was anchored to when built (2 for walls, 4 for facets); a re-tile changes them. */
  nodes: number[];
  /** Slot centre when built (pieces never move). */
  x: number;
  y: number;
  z: number;
}

export class EconState {
  /** Collision shape ids per building id (registerBuildingShape). */
  readonly buildingShapes = new Map<EntityId, ShapeId[]>();

  /** Piece slot index: slotKey(edge, level) → wall id; slotKey(facet, level) → deck/ramp id. */
  readonly edgeSlots = new Map<number, EntityId>();
  readonly facetSlots = new Map<number, EntityId>();
  readonly pieceInfo = new Map<EntityId, PieceInfo>();
  pieceLatticeVersion = 0;

  pileTimer = 0;
  /** world.tick the stock/hoarding tally was taken at (-Infinity: never). */
  stockTick = -Infinity;
  readonly hoarding: boolean[] = [false, false, false, false];
  readonly stock: number[] = [0, 0, 0, 0];
  /** Per-tick scratch for drummer counting (reused, never reallocated). */
  readonly circles: Building[] = [];
  readonly circleDrummers: number[] = [];

  readonly aligning: (AlignChannel | null)[] = [null, null, null, null];
  readonly dialectics: (DialecticsChannel | null)[] = [null, null, null, null];
  /** Forced March end per hippie id (the post-march exhaustion is applied when it lapses). */
  readonly marching = new Map<EntityId, MarchEntry>();

  readonly drugWasActive: Record<DrugId, boolean>[] = [0, 1, 2, 3].map(() => ({ saffron: false, dust: false, acidcop: false }));
  /** Luminous Dust hallucinations: node ids per faction, re-rolled while the Dust lasts. */
  readonly falseFlags: number[][] = [[], [], [], []];
  readonly falseFlagsRollAt: number[] = [0, 0, 0, 0];

  readonly gccRepairTimer: number[] = [0, 0, 0, 0];

  /** Reusable query buffers (lattice radius queries, id lists). */
  readonly nodeBuf: number[] = [];
  readonly idBuf: number[] = [];
}

export function econ(world: World): EconState {
  const s = world.scratch.economy;
  if (s instanceof EconState) return s;
  const fresh = new EconState();
  world.scratch.economy = fresh;
  return fresh;
}
