/** Cosmetic, authoritative remnants. Never register collision or navigation blocking. */
import { BUILDINGS, BUILDING_HEIGHT, LEVEL_HEIGHT, PIECE } from './constants';
import type { V3 } from './math';
import type { Building, Piece } from './types';
import type { World } from './world';
import { econ } from './systems/econ/state';

export interface Wreckage {
  id: string;
  kind: string;
  pos: V3;
  size: V3;
  yaw: number;
}
export const MAX_WRECKAGE = 512;
/** Stable insertion ordering keeps identical oldest-first eviction on all peers. */
export function addWreckage(world: World, record: Wreckage): void {
  if (world.wreckage.some(r => r.id === record.id)) return;
  world.wreckage.push(record);
  if (world.wreckage.length > MAX_WRECKAGE) world.wreckage.splice(0, world.wreckage.length - MAX_WRECKAGE);
}
export function leaveBuildingWreckage(world: World, b: Building): void {
  if (b.kind === 'hearth') return;
  const span = BUILDINGS[b.kind].radius * 2;
  addWreckage(world, { id: `building:${b.id}`, kind: b.kind,
    pos: { x: b.pos.x, y: world.collision.groundHeight(b.pos.x, b.pos.z), z: b.pos.z },
    size: { x: span, y: BUILDING_HEIGHT[b.kind], z: span }, yaw: b.yaw });
}
export function leavePieceWreckage(world: World, p: Piece): void {
  const info = econ(world).pieceInfo.get(p.id);
  if (!info) return; // No built geometry exists for an unregistered piece.
  const points = info.nodes.map(n => world.lattice.nodes[n]).filter(Boolean);
  if (points.length < 2) return;
  const dx = points[1].x - points[0].x, dz = points[1].z - points[0].z;
  const yaw = Math.atan2(dx, dz), c = Math.cos(yaw), s = Math.sin(yaw);
  const xs = points.map(n => (n.x - info.x) * c - (n.z - info.z) * s);
  const zs = points.map(n => (n.x - info.x) * s + (n.z - info.z) * c);
  addWreckage(world, { id: `piece:${p.id}`, kind: p.kind,
    pos: { x: info.x, y: world.collision.groundHeight(info.x, info.z), z: info.z },
    size: { x: p.kind === 'wall' ? PIECE.wallThickness : Math.max(.1, Math.max(...xs) - Math.min(...xs)),
      y: p.kind === 'floor' ? .2 : LEVEL_HEIGHT,
      z: Math.max(.1, Math.max(...zs) - Math.min(...zs)) }, yaw });
}
