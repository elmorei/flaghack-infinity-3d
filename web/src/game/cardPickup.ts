/** Public dropped-card tag in the same HUD prompt channel used by dropped beacons. */
import { FRICK_FRACK_SIDEBOARD_CAP } from '../sim/frickFrack';
import type { FactionId } from '../sim/types';
import type { World } from '../sim/world';
import { sleeveCardDetails } from '../ui/frickFrackSleeve';

export function droppedCardPrompt(world: World, faction: FactionId, hovered: number): string | null {
  const av = world.avatarOf(faction);
  if (!av || av.koUntil > world.time) return null;
  let nearest = null as World['frickFrack']['drops'][number] | null;
  let distance = 3;
  for (const drop of world.frickFrack?.drops ?? []) {
    const ground = world.collision.groundHeight(drop.pos.x, drop.pos.z);
    const d = Math.hypot(av.pos.x - drop.pos.x, av.pos.y - ground, av.pos.z - drop.pos.z);
    if (d > 3) continue;
    if (drop.id === hovered) { nearest = drop; break; }
    if (d < distance) { nearest = drop; distance = d; }
  }
  if (!nearest) return null;
  const name = sleeveCardDetails(nearest.card).name;
  return `${name} · ${world.frickFrack.sideboards[faction].length >= FRICK_FRACK_SIDEBOARD_CAP ? 'Sleeve full' : 'Walk over to collect'}`;
}

/** Informational phone plaque. Degen has no avatar and must not promise a pickup action. */
export function nearbyPickupTag(world: World, faction: FactionId, hovered: number): string | null {
  const av = world.avatarOf(faction);
  if (!av || world.factions[faction].controlMode === 'rts' || av.koUntil > world.time) return null;
  const card = droppedCardPrompt(world, faction, hovered);
  let beacon: string | null = null;
  for (const b of world.beacons.values()) {
    const ground = world.collision.groundHeight(b.pos.x, b.pos.z);
    if (b.faction === faction || b.until <= world.time || Math.hypot(av.pos.x-b.pos.x,av.pos.y-ground,av.pos.z-b.pos.z)>3) continue;
    beacon = 'D.E.G.E.N. Beacon · Converts 1–2 rival Signifiers'; break;
  }
  return [card, beacon].filter(Boolean).join('\n') || null;
}
