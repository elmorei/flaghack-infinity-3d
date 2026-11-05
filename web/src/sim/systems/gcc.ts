/**
 * Geomantic Command Center: passives (automatic recruitment, Geomantic Advice reveal/observe radius, Flag Repair),
 * being pushed and recovery of legacy damaged/collapsed cart state.
 * Owner: Economy agent.
 *
 * Geomantic Advice (reveal + Zeno observation within GCC.adviceRadius) is read from the GCC's
 * position by the survey/render systems; pushing is the avatar/hippie systems' job via
 * buildings.moveBuilding. Command Centers are indestructible.
 */
import type { CommandOf } from '../commands';
import { BUILDINGS, GCC, GCC_REPAIR_SNAP } from '../constants';
import { FACTION_IDS } from '../types';
import type { Building, FactionId } from '../types';
import type { World } from '../world';
import { isCollapsed, repairBuilding, restoreGcc } from './buildings';
import { econ } from './econ/state';
import { updateGccMovement } from './gccMovement';
import { nearestPlantableNode, plantFlag } from './flags';
import { piecePosition, repairPiece } from './pieces';

/** With nothing to repair, Flag Repair looks for loose Flags again after this long. */
const REPAIR_IDLE_RESCAN = 0.5;

/** Is the faction's GCC currently standing (not collapsed)? */
export function gccActive(world: World, f: FactionId): boolean {
  const g = world.gccOf(f);
  return !!g && g.gcc !== null && !isCollapsed(g);
}

/** Retired command tombstone: legacy/replayed clients cannot execute removed GCC powers. */
export function cmdGcc(world: World, c: CommandOf<'gcc'>): void {
  world.emit({ t: 'rejected', faction: c.faction, reason: 'The Command Center no longer has active abilities.' });
}

/** Flag Repair: re-plant the nearest own loose Flag in range that has a free node close by. */
function replantOne(world: World, f: FactionId, g: Building): boolean {
  const ids = econ(world).idBuf;
  ids.length = 0;
  const r2 = GCC.repairRadius * GCC.repairRadius;
  for (const fl of world.flags.values()) {
    if (fl.state !== 'loose' || fl.owner !== f) continue;
    if ((fl.pos.x - g.pos.x) ** 2 + (fl.pos.z - g.pos.z) ** 2 <= r2) ids.push(fl.id);
  }
  if (ids.length === 0) return false;
  const d2 = (id: number): number => {
    const fl = world.flags.get(id);
    return fl ? (fl.pos.x - g.pos.x) ** 2 + (fl.pos.z - g.pos.z) ** 2 : Infinity;
  };
  ids.sort((a, b) => d2(a) - d2(b) || a - b);
  let planted = false;
  for (const id of ids) {
    const fl = world.flags.get(id);
    if (!fl) continue;
    const node = nearestPlantableNode(world, fl.pos, GCC_REPAIR_SNAP, f);
    if (node >= 0 && plantFlag(world, id, node, f, g.id)) {
      planted = true;
      break;
    }
  }
  ids.length = 0;
  return planted;
}

/** Flag Repair passives: a Flag re-planted every GCC.repairInterval, +GCC.repairHps to own pieces/buildings in range. */
function flagRepair(world: World, f: FactionId, g: Building, dt: number): void {
  const st = econ(world);
  // A charged repair fires as soon as a loose Flag turns up (rescanning twice a second), then waits the interval.
  const timer = Math.min(GCC.repairInterval, st.gccRepairTimer[f] + dt);
  st.gccRepairTimer[f] = timer;
  if (timer >= GCC.repairInterval) st.gccRepairTimer[f] = replantOne(world, f, g) ? 0 : GCC.repairInterval - REPAIR_IDLE_RESCAN;
  const heal = GCC.repairHps * dt;
  const r2 = GCC.repairRadius * GCC.repairRadius;
  for (const p of world.pieces.values()) {
    if (p.faction !== f || p.hp >= p.maxHp) continue;
    const pos = piecePosition(world, p);
    if (pos && (pos.x - g.pos.x) ** 2 + (pos.z - g.pos.z) ** 2 <= r2) repairPiece(p, heal);
  }
  for (const b of world.buildings.values()) {
    if (b === g || b.faction !== f || (!b.disabled && b.hp >= b.maxHp)) continue;
    const reach = GCC.repairRadius + BUILDINGS[b.kind].radius;
    if ((b.pos.x - g.pos.x) ** 2 + (b.pos.z - g.pos.z) ** 2 <= reach * reach) repairBuilding(world, b, heal);
  }
}

export function updateGcc(world: World, dt: number): void {
  for (const b of world.buildings.values()) restoreGcc(world, b);
  updateGccMovement(world, dt);
  for (const f of FACTION_IDS) {
    // Old snapshots can carry an in-flight retired channel. Cancel it without a conversion.
    const av = world.avatarOf(f);
    if (av?.action.kind === 'channel' && av.action.what === 'dialectics') av.action = { kind: 'idle' };
    const legacyCart = world.gccOf(f);
    if (legacyCart?.gcc) legacyCart.gcc.channelUntil = 0;
    if (!world.factions[f].alive) continue;
    const g = world.gccOf(f);
    if (!g || !g.gcc) continue;
    if (!isCollapsed(g)) flagRepair(world, f, g, dt);
  }
}
