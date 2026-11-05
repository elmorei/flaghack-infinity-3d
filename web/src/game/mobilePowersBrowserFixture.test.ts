import { expect, it } from 'vitest';
import { createMatch } from '../sim/setup';
import { normalizeMatch } from '../sim/matchSettings';
import { spawnBuilding } from '../sim/factory';
import { cmdAlign, updateAbilities, alignBlocker, abilityBlocker } from '../sim/systems/abilities';
import { ritualBlocker, cmdRitual } from '../sim/systems/rituals';
import { cmdDrug, falseFlags } from '../sim/systems/drugs';
import { canPlaceBuilding } from '../sim/systems/buildings';

it('validates the exact native Powers seed and real host prerequisites before browser interaction', () => {
  const w = createMatch({ seed: 'mobile-powers-native-qa', mode: 'standard', difficulty: 'normal', humans: [0, 1, 2, 3], rtsFactions: [0], match: normalizeMatch({ bossMode: false, days: 3, startingSignifiers: 0, maxSignifiers: 0 }) });
  w.factions[0].ritual = 300; w.factions[0].lumber = 1000;
  const altar = w.hearthOf(0)!;
  const circle = spawnBuilding(w, 'drumcircle', 0, altar.facet, 1);
  const buildFacet = w.lattice.facets.find(fc => canPlaceBuilding(w, 0, 'workshop', fc.id).ok)!;
  expect(buildFacet).toBeDefined();
  const workshop = spawnBuilding(w, 'workshop', 0, buildFacet.id, 1); workshop.hp = 100;
  const clear = w.lattice.facets.find(fc => Math.hypot(fc.cx - workshop.pos.x, fc.cz - workshop.pos.z) < 12 && canPlaceBuilding(w, 0, 'workshop', fc.id).ok);
  expect(clear).toBeDefined();
  const target = { x: clear!.cx, z: clear!.cz };
  expect(circle.disabled).toBe(false); expect(w.avatarOf(0)).toBeUndefined();
  expect(w.lattice.facets.some(fc => canPlaceBuilding(w, 0, 'workshop', fc.id).ok)).toBe(true);
  for (const chakra of ['canton', 'finial'] as const) {
    expect(alignBlocker(w, 0, chakra)).toBe(''); cmdAlign(w, { t: 'align', faction: 0, chakra });
    w.time += 4.01; updateAbilities(w, 0); expect(w.factions[0].chakras[chakra]).toBe(1);
  }
  expect(w.factions[0].ritual).toBe(240); expect(abilityBlocker(w, 0, 'omega')).toBe(''); expect(abilityBlocker(w, 0, 'stabilize')).toBe('');
  for (const ritual of ['redtape', 'patchwork'] as const) { expect(ritualBlocker(w, 0, ritual)).toBe(''); cmdRitual(w, { t: 'ritual', faction: 0, ritual, at: target }); }
  expect(w.factions[0].ritual).toBe(205);
  for (const drug of ['saffron', 'dust', 'acidcop'] as const) { w.factions[0].drugs[drug] = 1; cmdDrug(w, { t: 'drug', faction: 0, drug }); expect(w.factions[0].drugs[drug]).toBe(0); }
  expect(falseFlags(w, 0).length).toBeGreaterThanOrEqual(3);
  // No allied Crystal may quietly add Ritual to a browser affordability assertion.
  expect([...w.crystals.values()].filter(c => c.faction === 0)).toHaveLength(0);
});
