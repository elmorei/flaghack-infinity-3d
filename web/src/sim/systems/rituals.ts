/** Degen camp rites use authoritative world positions, not a camera or phantom avatar. */
import type { CommandOf } from '../commands';
import { MAP_HALF, RITUAL } from '../constants';
import { spawnZone } from '../factory';
import type { V2 } from '../math';
import type { Building, FactionId, Hippie, Piece, RitualId } from '../types';
import type { World } from '../world';
import { bossEncounterActive } from './boss/damage';
import { isCollapsed, repairBuilding } from './buildings';
import { econ } from './econ/state';
import { piecePosition, repairPiece } from './pieces';

export const RITUAL_NAMES: Record<RitualId, string> = { redtape: 'Red Tape Mandala', patchwork: 'Patchwork Litany' };
export function validSpellPoint(at: V2): boolean {
  return !!at && Number.isFinite(at.x) && Number.isFinite(at.z) && Math.abs(at.x) <= MAP_HALF && Math.abs(at.z) <= MAP_HALF;
}
function workingCircle(world: World, faction: FactionId): Building | undefined {
  return [...world.buildings.values()].find(b => b.faction === faction && b.kind === 'drumcircle' && b.built >= 1 && !b.disabled && b.hp > 0);
}
export function ritualBlocker(world: World, faction: FactionId, ritual: RitualId): string {
  const fac = world.factions[faction], cfg = RITUAL[ritual];
  if (!cfg) return 'Unknown camp ritual.';
  if (!fac?.alive) return 'Your camp has fallen.';
  if (fac.controlMode !== 'rts') return 'Camp rites are available in Degen mode.';
  if (!workingCircle(world, faction)) return 'Raise a working Drum Circle first.';
  if (ritual === 'redtape' && bossEncounterActive(world)) return 'All camps are allied during the boss fight.';
  if (fac.cooldowns[ritual] > world.time) return `${RITUAL_NAMES[ritual]} recharging (${Math.ceil(fac.cooldowns[ritual] - world.time)} s).`;
  if (fac.ritual < cfg.cost) return `Needs ${cfg.cost} Ritual (you have ${Math.floor(fac.ritual)}).`;
  return '';
}
function repairTargets(world: World, faction: FactionId, at: V2): (Building | Piece)[] {
  const candidates: { target: Building | Piece; distance: number }[] = [];
  for (const b of world.buildings.values()) {
    if (b.faction !== faction || b.kind === 'hearth' || b.kind === 'gcc' || b.built < 1 || b.hp <= 0 || b.disabled || isCollapsed(b) || b.hp >= b.maxHp) continue;
    const distance = (b.pos.x - at.x) ** 2 + (b.pos.z - at.z) ** 2;
    if (distance <= RITUAL.patchwork.radius ** 2) candidates.push({ target: b, distance });
  }
  for (const p of world.pieces.values()) {
    if (p.faction !== faction || p.hp <= 0 || p.hp >= p.maxHp) continue;
    const pos = piecePosition(world, p); if (!pos) continue;
    const distance = (pos.x - at.x) ** 2 + (pos.z - at.z) ** 2;
    if (distance <= RITUAL.patchwork.radius ** 2) candidates.push({ target: p, distance });
  }
  return candidates.sort((a, b) => a.distance - b.distance || a.target.id - b.target.id).map(c => c.target);
}
export function cmdRitual(world: World, c: CommandOf<'ritual'>): void {
  const why = ritualBlocker(world, c.faction, c.ritual);
  if (why || !validSpellPoint(c.at)) { world.emit({ t: 'rejected', faction: c.faction, reason: why || 'Choose a point inside the playa.' }); return; }
  if (c.ritual === 'patchwork' && repairTargets(world, c.faction, c.at).length === 0) {
    world.emit({ t: 'rejected', faction: c.faction, reason: 'No damaged, standing own structures in the circle.' }); return;
  }
  const cfg = RITUAL[c.ritual], fac = world.factions[c.faction];
  fac.ritual -= cfg.cost; fac.cooldowns[c.ritual] = world.time + cfg.cooldown;
  spawnZone(world, c.ritual, c.faction, c.at, cfg.radius, cfg.duration + (c.ritual === 'redtape' ? RITUAL.redtape.warning : 0), 1, workingCircle(world, c.faction)!.id);
}
/** This multiplier is read only by locomotion, never work or attack speed. */
export function redTapeMovementMultiplier(world: World, h: Hippie): number {
  if (h.faction < 0 || h.koUntil > world.time || bossEncounterActive(world)) return 1;
  for (const z of world.zones.values()) {
    const fac = world.factions[z.faction];
    if (z.kind !== 'redtape' || !fac.alive || fac.controlMode !== 'rts' || z.faction === h.faction || z.until <= world.time || world.time < z.bornAt + RITUAL.redtape.warning) continue;
    if ((h.pos.x - z.pos.x) ** 2 + (h.pos.z - z.pos.z) ** 2 <= z.radius ** 2) return 1 - RITUAL.redtape.slow;
  }
  return 1;
}
export function updateRituals(world: World, dt: number): void {
  const hurt = econ(world).structureHurtAt;
  for (const z of world.zones.values()) {
    if (z.kind !== 'patchwork' && z.kind !== 'redtape') continue;
    const fac = world.factions[z.faction];
    if (!fac.alive || fac.controlMode !== 'rts') { world.zones.delete(z.id); continue; }
    if (z.until <= world.time || z.kind !== 'patchwork') continue;
    let repaired = 0;
    for (const target of repairTargets(world, z.faction, z.pos)) {
      if (world.time - (hurt.get(target.id) ?? -Infinity) < RITUAL.patchwork.safeTime) continue;
      if (target.type === 'building') repairBuilding(world, target, RITUAL.patchwork.healPerSec * dt);
      else repairPiece(target, RITUAL.patchwork.healPerSec * dt);
      if (++repaired >= RITUAL.patchwork.targets) break;
    }
  }
}
