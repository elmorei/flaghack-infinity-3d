/** Independent structure capture using the same Survey pressure rules as Hearths. */
import { BUILDINGS, CAPTURE } from '../constants';
import { FACTION_IDS } from '../types';
import type { Building, Piece, StructureCaptureState, FactionId, Owner } from '../types';
import type { World } from '../world';
import type { Obstacle } from '../map/mapgen';
import { BUILDING_NAMES } from './buildings';
import { CaptureScratch, crystalMult, holdsHearth, sharedMult, threatened } from './capture';
import { suddenDeathMult } from './victory';
import { circleEnclosed, sceneryEnclosed, pieceEnclosed, pieceCaptureAnchor } from './structureEnclosure';

const scratches = new WeakMap<World, CaptureScratch>();
const sceneryScans = new WeakMap<World, { survey: number; topology: number; alive: number; obstacles: Obstacle[]; count: number; byId: Map<number, Obstacle> }>();
export function canCaptureStructure(b: Building): boolean {
  return b.kind !== 'hearth' && b.kind !== 'gcc';
}
export function canCaptureScenery(o: Obstacle): boolean {
  return o.kind === 'tent' || o.kind === 'dome' || o.kind === 'shade' ||
    o.kind === 'porta' || o.kind === 'art' || o.kind === 'car';
}
export function newStructureCapture(): StructureCaptureState {
  return { stage: 'safe', attacker: null, pressure: { 0: 0, 1: 0, 2: 0, 3: 0 }, overwriteAt: 0 };
}
export function resetStructureCapture(world: World): void {
  for (const b of world.buildings.values()) if (b.capture) b.capture = null;
  for (const p of world.pieces.values()) if (p.capture) p.capture = null;
  for (const id of world.sceneryCapture.keys()) if (world.destroyedScenery.has(id)) world.sceneryCapture.delete(id);
  for (const s of world.sceneryCapture.values()) Object.assign(s, newStructureCapture());
}

/** Transfers only this structure and its stored stock. No elimination, camp conversion or healing. */
export function captureStructure(world: World, b: Building, to: FactionId): boolean {
  if (!canCaptureStructure(b) || world.buildings.get(b.id) !== b || b.faction === to ||
      !world.factions[to].alive || world.effigyRevealedAt !== null) return false;
  const from = b.faction;
  b.faction = to;
  b.capture = newStructureCapture();
  for (const fl of world.flags.values()) if (fl.state === 'stock' && fl.holder === b.id) fl.owner = to;
  // Paid batches and current health/repair/construction stay with the structure. Their
  // production/recruitment/ward systems read its current faction at use and completion.
  capturedNotice(world, BUILDING_NAMES[b.kind], b.pos, from, to);
  return true;
}
export function capturePiece(world: World, p: Piece, to: FactionId): boolean {
  if (world.pieces.get(p.id) !== p || p.faction === to || !world.factions[to].alive || world.effigyRevealedAt !== null) return false;
  const from = p.faction;
  p.faction = to; p.capture = newStructureCapture();
  // Ownership controls repair/demolition/tint only; support and collision are geometric.
  capturedNotice(world, p.kind, pieceCaptureAnchor(world, p).pos, from, to);
  return true;
}
function capturedNotice(world: World, name: string, pos: { x: number; z: number }, from: Owner, to: FactionId): void {
  world.emit({ t: 'notify', faction: to, text: `Captured ${name}.`, severity: 'good', pos: { ...pos } });
  if (from !== -1) world.emit({ t: 'notify', faction: from, text: `Your ${name} was captured.`, severity: 'danger', pos: { ...pos } });
}

/** Shared stage engine. Footprint enclosure is supplied by each real structure shape. */
function stepCapture(world: World, sc: CaptureScratch, target: { pos: { x: number; z: number } }, name: string,
  owner: Owner, hs: StructureCaptureState, dt: number, enclosed: (f: FactionId) => boolean): FactionId | null {
  if (hs.stage === 'overwritten') {
    const to = hs.attacker;
    if (to === null || !world.factions[to].alive || to === owner) { Object.assign(hs, newStructureCapture()); return null; }
    return world.time >= hs.overwriteAt ? to : null;
  }
  let enclosing = 0;
  for (const f of FACTION_IDS) if (f !== owner && world.factions[f].alive && enclosed(f)) enclosing |= 1 << f;
  const contested = enclosing !== 0 && owner !== -1 && holdsHearth(world, target, owner);
  // No defender/ward scans for idle structures outside enemy Surveys.
  const multiplier = enclosing === 0 ? 0 : owner === -1 ? suddenDeathMult(world) : sharedMult(world, target, null, owner, contested);
  let encloser: FactionId | null = null;
  let leader: FactionId | null = null;
  for (const a of FACTION_IDS) {
    if (a === owner || !world.factions[a].alive) { hs.pressure[a] = 0; continue; }
    if (enclosing & (1 << a)) {
      hs.pressure[a] = Math.min(100, hs.pressure[a] + CAPTURE.baseRate * multiplier * crystalMult(world, a, target) * dt);
      if (encloser === null || hs.pressure[a] > hs.pressure[encloser]) encloser = a;
    } else hs.pressure[a] = Math.max(0, hs.pressure[a] - CAPTURE.decay * dt);
    if (hs.pressure[a] > 0 && (leader === null || hs.pressure[a] > hs.pressure[leader])) leader = a;
  }
  const prev = hs.stage;
  hs.attacker = encloser ?? leader;
  hs.stage = encloser === null ? (threatened(world, sc, target, owner) ? 'threatened' : 'safe') :
    hs.pressure[encloser] >= 100 ? 'overwritten' : contested ? 'contested' : 'contained';
  if (hs.stage === 'overwritten') hs.overwriteAt = world.time + CAPTURE.overwriteTime;
  if (prev !== hs.stage && hs.stage === 'overwritten') {
    if (owner !== -1) world.emit({ t: 'notify', faction: owner, text: `OVERWRITE! Your ${name} is being captured.`, severity: 'danger', pos: { ...target.pos } });
    if (encloser !== null) world.emit({ t: 'notify', faction: encloser, text: `Overwriting ${name}…`, severity: 'good', pos: { ...target.pos } });
  }
  return null;
}

export function updateStructureCapture(world: World, dt: number): void {
  // Destroyed props cannot retain capture progress or ownership markers after late joins.
  for (const id of world.sceneryCapture.keys()) if (world.destroyedScenery.has(id)) world.sceneryCapture.delete(id);
  if (world.effigyRevealedAt !== null) { resetStructureCapture(world); return; }
  let sc = scratches.get(world);
  if (!sc) { sc = new CaptureScratch(); scratches.set(world, sc); }
  for (const b of world.buildings.values()) {
    if (!canCaptureStructure(b)) continue;
    const hs = b.capture ?? (b.capture = newStructureCapture());
    const to = stepCapture(world, sc, b, BUILDING_NAMES[b.kind], b.faction, hs, dt,
      f => circleEnclosed(world, b.pos.x, b.pos.z, BUILDINGS[b.kind].radius, f));
    if (to !== null) captureStructure(world, b, to);
  }
  for (const p of world.pieces.values()) {
    const hs = p.capture ?? (p.capture = newStructureCapture());
    const anchor = pieceCaptureAnchor(world, p);
    const to = stepCapture(world, sc, anchor, p.kind, p.faction, hs, dt, f => pieceEnclosed(world, p, f));
    if (to !== null) capturePiece(world, p, to);
  }
  // Unclaimed scenery can only become enclosed when Survey geometry (or living seats)
  // changes. Do not rescan every map prop at 60 Hz while all flags remain unchanged.
  let alive = 0;
  for (const f of FACTION_IDS) if (world.factions[f].alive) alive |= 1 << f;
  let scan = sceneryScans.get(world);
  if (!scan || scan.survey !== world.survey.version || scan.topology !== world.lattice.version ||
      scan.alive !== alive || scan.obstacles !== world.map.obstacles || scan.count !== world.map.obstacles.length) {
    scan = { survey: world.survey.version, topology: world.lattice.version, alive,
      obstacles: world.map.obstacles, count: world.map.obstacles.length, byId: new Map(world.map.obstacles.map(o => [o.id, o])) };
    sceneryScans.set(world, scan);
    for (const o of world.map.obstacles) {
      if (world.sceneryCapture.has(o.id) || !canCaptureScenery(o) || world.destroyedScenery.has(o.id)) continue;
      if (FACTION_IDS.some(f => (alive & (1 << f)) !== 0 && sceneryEnclosed(world, o, f)))
        world.sceneryCapture.set(o.id, { ...newStructureCapture(), faction: -1 });
    }
  }
  for (const [id, hs] of world.sceneryCapture) {
    const o = scan.byId.get(id);
    if (!o || !canCaptureScenery(o) || world.destroyedScenery.has(id)) { world.sceneryCapture.delete(id); continue; }
    const target = { pos: { x: o.x, z: o.z } };
    const to = stepCapture(world, sc, target, o.kind, hs.faction, hs, dt, f => sceneryEnclosed(world, o, f));
    if (to !== null) {
      const from = hs.faction;
      Object.assign(hs, newStructureCapture(), { faction: to });
      capturedNotice(world, o.kind, target.pos, from, to);
    }
  }
}
