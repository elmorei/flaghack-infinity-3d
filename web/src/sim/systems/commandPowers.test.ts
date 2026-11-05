import { describe, expect, it } from 'vitest';
import { ABILITY, ALIGN_COST, DRUG, RITUAL } from '../constants';
import { spawnBuilding, spawnFlag, spawnHippie, spawnPiece } from '../factory';
import { cmdAbility, cmdAlign, alignBlocker, abilityBlocker, updateAbilities } from './abilities';
import { cmdRitual, redTapeMovementMultiplier, ritualBlocker } from './rituals';
import { cmdDrug, drugBlocker, falseFlags, updateDrugs } from './drugs';
import { damageBuilding } from './buildings';
import { attachPiece, damagePiece } from './pieces';
import { econ } from './econ/state';
import { applyCommands } from './commands';
import { spawnBoss } from './boss';
import { plantFlag } from './flags';
import { setFactionControlMode } from '../controlMode';
import { updateHippies } from './hippies';
import { brainOf } from './units/brain';
import { normalizeMatch } from '../matchSettings';
import { speedMultiplier } from './effects';
import { commandPowersWorld, powerAdvance } from './commandPowersTestkit';

const at = { x: 10, z: 10 };
describe('authoritative avatarless Degen Powers', () => {
  it.each(['canton', 'finial'] as const)('aligns %s at the Altar and pays only after 4 s', chakra => {
    const w = commandPowersWorld(); cmdAlign(w, { t: 'align', faction: 0, chakra });
    expect(w.avatarOf(0)).toBeUndefined(); expect(w.factions[0].ritual).toBe(300);
    expect(alignBlocker(w, 0, chakra)).toMatch(/Already/);
    powerAdvance(w, 3.9); expect(w.factions[0].chakras[chakra]).toBe(0);
    powerAdvance(w, .11); expect(w.factions[0].chakras[chakra]).toBe(1);
    expect(w.factions[0].ritual).toBe(300 - ALIGN_COST[0]);
    expect([...w.zones.values()].filter(z => z.kind === 'alignment')).toHaveLength(0);
  });
  it('blocks avatar-only chakras, unaffordable upgrades, and damage-interrupted channels without spending', () => {
    const w = commandPowersWorld(); expect(alignBlocker(w, 0, 'hoist')).toMatch(/roaming/);
    w.factions[0].ritual = 29; expect(alignBlocker(w, 0, 'canton')).toMatch(/Needs/);
    w.factions[0].ritual = 300; cmdAlign(w, { t: 'align', faction: 0, chakra: 'finial' });
    w.time++; damageBuilding(w, w.hearthOf(0)!, .25, -1); powerAdvance(w, 4);
    expect(w.factions[0].chakras.finial).toBe(0); expect(w.factions[0].ritual).toBe(300);
  });
  it('rechecks the Altar owner and affordability when an alignment completes', () => {
    const w = commandPowersWorld(); cmdAlign(w, { t: 'align', faction: 0, chakra: 'canton' });
    w.factions[0].ritual = 2; powerAdvance(w, 4); expect(w.factions[0].chakras.canton).toBe(0);
    w.factions[0].ritual = 300; cmdAlign(w, { t: 'align', faction: 0, chakra: 'finial' });
    w.hearthOf(0)!.faction = 1; powerAdvance(w, 4); expect(w.factions[0].chakras.finial).toBe(0);
  });
  it.each([1, 2, 3])('places Stabilize level %i directly at a distant tap with unchanged tuning', level => {
    const w = commandPowersWorld(); w.factions[0].chakras.canton = level;
    const target = { x: -w.hearthOf(0)!.pos.x, z: -w.hearthOf(0)!.pos.z };
    cmdAbility(w, { t: 'ability', faction: 0, ability: 'stabilize', at: target, node: -1 });
    const z = [...w.zones.values()].find(z => z.kind === 'stabilize')!;
    expect(z.pos).toEqual(target); expect(z.radius).toBe(ABILITY.stabilize.radius[level - 1]);
    expect(z.until - z.bornAt).toBe(20); expect(w.factions[0].cooldowns.stabilize).toBe(135);
  });
  it.each([{ x: NaN, z: 0 }, { x: 151, z: 0 }, { x: 0, z: Infinity }])('rejects invalid power points without committing cooldown: %j', point => {
    const w = commandPowersWorld(); w.factions[0].chakras.finial = 1;
    cmdAbility(w, { t: 'ability', faction: 0, ability: 'omega', at: point, node: -1 });
    expect(w.factions[0].cooldowns.omega).toBe(0); expect(w.zones.size).toBe(0);
  });
  it('warns for 2 s then damages only enemy Signifiers in the tapped circle', () => {
    const w = commandPowersWorld(); w.factions[0].chakras.finial = 1;
    const enemy = spawnHippie(w, 1, at), own = spawnHippie(w, 0, at), neutral = spawnHippie(w, -1, at), far = spawnHippie(w, 1, { x: 40, z: 10 });
    const hp = enemy.hp; cmdAbility(w, { t: 'ability', faction: 0, ability: 'omega', at, node: -1 });
    expect([...w.zones.values()][0].kind).toBe('omegaCharge'); expect(w.factions[0].cooldowns.omega).toBe(175);
    powerAdvance(w, 1.9); expect(enemy.hp).toBe(hp);
    powerAdvance(w, .11); expect(enemy.hp).toBe(hp - 40);
    expect([own.hp, neutral.hp, far.hp]).toEqual([hp, hp, hp]);
    expect(w.drainEvents().filter(e => e.t === 'ability' && e.ability === 'omega')).toHaveLength(1);
  });
  it('Altar damage interrupts Omega without a blast or refunded cooldown', () => {
    const w = commandPowersWorld(); w.factions[0].chakras.finial = 1; const h = spawnHippie(w, 1, at), hp = h.hp;
    cmdAbility(w, { t: 'ability', faction: 0, ability: 'omega', at, node: -1 });
    w.time++; damageBuilding(w, w.hearthOf(0)!, .1, -1); powerAdvance(w, 2);
    expect(h.hp).toBe(hp); expect(w.factions[0].cooldowns.omega).toBe(175);
    expect(w.drainEvents().filter(e => e.t === 'ability')).toHaveLength(0);
  });
  it('Omega L3 plants only actual friendly Flags carried locally, never remote stock', () => {
    const w = commandPowersWorld(); w.factions[0].chakras.finial = 3;
    const local = spawnHippie(w, 0, at), far = spawnHippie(w, 0, { x: 90, z: 90 });
    for (const h of [local, far]) { const flag = spawnFlag(w, { owner: 0, state: 'carried', holder: h.id, pos: { ...h.pos, y: 0 } }); h.carryingFlag = flag.id; }
    const localId = local.carryingFlag, farId = far.carryingFlag, size = w.flags.size, stock = w.stockCount(0);
    cmdAbility(w, { t: 'ability', faction: 0, ability: 'omega', at, node: -1 }); powerAdvance(w, 2);
    expect(w.flags.get(localId)?.state).toBe('planted'); expect(local.carryingFlag).toBe(-1);
    expect(w.flags.get(farId)?.state).toBe('carried'); expect(far.carryingFlag).toBe(farId);
    expect(w.flags.size).toBe(size); expect(w.stockCount(0)).toBe(stock);
  });
  it('dispatch accepts unlocked powers, rites, and existing drugs without an avatar', () => {
    const w = commandPowersWorld(); w.factions[0].chakras.canton = 1; w.factions[0].drugs.dust = 1;
    w.submit({ t: 'ability', faction: 0, ability: 'stabilize', at, node: -1 });
    w.submit({ t: 'ritual', faction: 0, ritual: 'redtape', at }); w.submit({ t: 'drug', faction: 0, drug: 'dust' }); applyCommands(w);
    expect([...w.zones.values()].map(z => z.kind).sort()).toEqual(['redtape', 'stabilize']);
    expect(w.factions[0].drugs.dust).toBe(0); expect(falseFlags(w, 0).length).toBeGreaterThanOrEqual(3);
    expect(abilityBlocker(w, 0, 'beacon')).toMatch(/roaming/);
  });
});

describe('paid Degen camp rites', () => {
  it('requires Degen, a working Drum Circle, Ritual and a fresh cooldown', () => {
    const w = commandPowersWorld(); expect(ritualBlocker(w, 1, 'redtape')).toMatch(/Degen/);
    w.factions[0].ritual = 14; expect(ritualBlocker(w, 0, 'redtape')).toMatch(/15/);
    w.factions[0].ritual = 300;
    [...w.buildings.values()].find(b => b.kind === 'drumcircle' && b.faction === 0)!.disabled = true;
    expect(ritualBlocker(w, 0, 'redtape')).toMatch(/Drum Circle/);
  });
  it('Red Tape costs 15, warns 1 s, then slows only rival movement by 25%, without stacking', () => {
    const w = commandPowersWorld(); const enemy = spawnHippie(w, 1, at), own = spawnHippie(w, 0, at), neutral = spawnHippie(w, -1, at);
    cmdRitual(w, { t: 'ritual', faction: 0, ritual: 'redtape', at });
    expect(w.factions[0].ritual).toBe(285); expect(w.factions[0].cooldowns.redtape).toBe(145);
    expect(redTapeMovementMultiplier(w, enemy)).toBe(1); powerAdvance(w, 1);
    expect(redTapeMovementMultiplier(w, enemy)).toBe(.75); expect(speedMultiplier(w, enemy)).toBe(1);
    expect(redTapeMovementMultiplier(w, own)).toBe(1); expect(redTapeMovementMultiplier(w, neutral)).toBe(1);
    cmdRitual(w, { t: 'ritual', faction: 0, ritual: 'redtape', at }); expect(w.factions[0].ritual).toBe(285);
    w.factions[0].cooldowns.redtape = 0; cmdRitual(w, { t: 'ritual', faction: 0, ritual: 'redtape', at }); powerAdvance(w, 1);
    expect(redTapeMovementMultiplier(w, enemy)).toBe(.75); powerAdvance(w, 13); expect(redTapeMovementMultiplier(w, enemy)).toBe(1);
  });
  it('Patchwork repairs at most four nearest standing own structures, excluding Altars/GCC/disabled/rivals', () => {
    const w = commandPowersWorld(), facet = w.lattice.facets.find(f => !f.boundary)!;
    const buildings = Array.from({ length: 5 }, (_, i) => { const b = spawnBuilding(w, 'workshop', 0, facet.id, 1); b.pos = { x: at.x + i, z: at.z }; b.hp = 100; return b; });
    const excluded = [w.hearthOf(0)!, spawnBuilding(w, 'gcc', 0, facet.id, 1), spawnBuilding(w, 'workshop', 1, facet.id, 1), spawnBuilding(w, 'workshop', 0, facet.id, 1)];
    for (const b of excluded) { b.pos = { ...at }; b.hp = 100; } excluded[3].disabled = true;
    cmdRitual(w, { t: 'ritual', faction: 0, ritual: 'patchwork', at }); powerAdvance(w, 1);
    expect(buildings.map(b => b.hp)).toEqual([108, 108, 108, 108, 100]); expect(excluded.map(b => b.hp)).toEqual([100, 100, 100, 100]);
    expect(w.factions[0].ritual).toBe(280); expect(w.factions[0].cooldowns.patchwork).toBe(160);
    damageBuilding(w, buildings[0], .25, -1); powerAdvance(w, 2.9); expect(buildings[0].hp).toBe(107.75);
    powerAdvance(w, .11); expect(buildings[0].hp).toBeCloseTo(108.63);
  });
  it('repairs standing pieces, respects fractional damage pauses, and never resurrects pieces', () => {
    const w = commandPowersWorld(), facet = w.lattice.facets.find(f => !f.boundary)!;
    const p = spawnPiece(w, 'floor', 0, -1, facet.id, 0, -1); attachPiece(w, p); p.hp = 100;
    const point = { x: facet.cx, z: facet.cz }; cmdRitual(w, { t: 'ritual', faction: 0, ritual: 'patchwork', at: point });
    powerAdvance(w, 1); expect(p.hp).toBe(108); damagePiece(w, p, .1, -1);
    powerAdvance(w, 2.9); expect(p.hp).toBeCloseTo(107.9); powerAdvance(w, .2); expect(p.hp).toBeCloseTo(109.5);
    damagePiece(w, p, 1000, -1); powerAdvance(w, 4); expect(w.pieces.has(p.id)).toBe(false);
  });
  it('rejects empty Patchwork and invalid targets without costs and removes rites on mode loss', () => {
    const w = commandPowersWorld(); cmdRitual(w, { t: 'ritual', faction: 0, ritual: 'patchwork', at });
    cmdRitual(w, { t: 'ritual', faction: 0, ritual: 'redtape', at: { x: NaN, z: 0 } });
    expect(w.factions[0].ritual).toBe(300); expect(w.zones.size).toBe(0);
    cmdRitual(w, { t: 'ritual', faction: 0, ritual: 'redtape', at }); w.factions[0].controlMode = 'avatar'; updateAbilities(w, 0);
    expect(w.zones.size).toBe(0); expect(w.factions[0].ritual).toBe(285);
  });
  it('immune Command Center hits do not register a hurt timestamp', () => {
    const w = commandPowersWorld(), gcc = [...w.buildings.values()].find(b => b.kind === 'gcc')!;
    expect(damageBuilding(w, gcc, 100, -1)).toBe(false); expect(econ(w).structureHurtAt.has(gcc.id)).toBe(false);
  });
});

describe('shared drug costs and drawbacks', () => {
  it('Saffron spends one dose, cannot stack, preserves 40 s benefit and 20 s crash', () => {
    const w = commandPowersWorld(), h = spawnHippie(w, 0, at); w.factions[0].drugs.saffron = 2;
    cmdDrug(w, { t: 'drug', faction: 0, drug: 'saffron' }); updateDrugs(w, 0);
    expect(w.factions[0].drugs.saffron).toBe(1); expect(speedMultiplier(w, h)).toBe(1.5);
    expect(drugBlocker(w, 0, 'saffron')).toMatch(/already/); cmdDrug(w, { t: 'drug', faction: 0, drug: 'saffron' });
    expect(w.factions[0].drugs.saffron).toBe(1); w.time += DRUG.duration.saffron; updateDrugs(w, 0);
    expect(w.factions[0].saffronCrashUntil).toBe(w.time + 20); expect(speedMultiplier(w, h)).toBe(.7);
  });
  it('Dust generates false Flags without an avatar, rerolls, expires and never creates real Flags', () => {
    const w = commandPowersWorld(), size = w.flags.size; w.factions[0].drugs.dust = 1;
    cmdDrug(w, { t: 'drug', faction: 0, drug: 'dust' }); updateDrugs(w, 0); const before = [...falseFlags(w, 0)];
    expect(before.length).toBeGreaterThanOrEqual(3); expect(before.length).toBeLessThanOrEqual(5);
    w.time += 10; updateDrugs(w, 0); expect(falseFlags(w, 0)).not.toEqual(before);
    expect(w.flags.size).toBe(size); w.time += 20; updateDrugs(w, 0); expect(falseFlags(w, 0)).toHaveLength(0);
  });
  it('Acid Cop spends one dose and taps every living rival for 30 s', () => {
    const w = commandPowersWorld(); w.factions[0].drugs.acidcop = 1; cmdDrug(w, { t: 'drug', faction: 0, drug: 'acidcop' });
    expect(w.factions[0].drugs.acidcop).toBe(0); expect(w.factions[0].drugActive.acidcop).toBe(130);
    for (const f of [1, 2, 3] as const) expect(w.factions[0].meshTap[f]).toBe(130);
    expect(RITUAL.patchwork.duration).toBe(15);
  });
});


it('shared AOE preserves boss damage and alliance protections, and Red Tape cannot slow allies', () => {
  const w = commandPowersWorld(); w.effigyRevealedAt = w.time; const boss = spawnBoss(w)!; boss.pos = { ...at };
  w.factions[0].chakras.finial = 1; const ally = spawnHippie(w, 1, at), hp = ally.hp, bossHp = boss.hp;
  cmdAbility(w, { t: 'ability', faction: 0, ability: 'omega', at, node: -1 }); powerAdvance(w, 2);
  expect(boss.hp).toBe(bossHp - 500); expect(ally.hp).toBe(hp); expect(ritualBlocker(w, 0, 'redtape')).toMatch(/allied/);
  expect(redTapeMovementMultiplier(w, ally)).toBe(1);
});

it('Stabilize L3 protects planted friendly Flags from remote Omega and protection ends on expiry', () => {
  const w = commandPowersWorld(); w.factions[0].chakras.finial = 1; w.factions[1].controlMode = 'rts'; w.factions[1].chakras.canton = 3;
  const node = w.lattice.nodes.find(n => !n.blocked && w.survey.nodeFlag[n.id] < 0 && Math.hypot(n.x - at.x, n.z - at.z) < 5)!;
  const flag = spawnFlag(w, { owner: 1, state: 'loose', holder: -1, pos: { x: node.x, y: 0, z: node.z } });
  expect(plantFlag(w, flag.id, node.id, 1, -1)).toBe(true);
  cmdAbility(w, { t: 'ability', faction: 1, ability: 'stabilize', at, node: -1 });
  cmdAbility(w, { t: 'ability', faction: 0, ability: 'omega', at, node: -1 }); powerAdvance(w, 2); expect(flag.state).toBe('planted');
  powerAdvance(w, 20); w.factions[0].cooldowns.omega = 0;
  cmdAbility(w, { t: 'ability', faction: 0, ability: 'omega', at, node: -1 }); powerAdvance(w, 2); expect(flag.state).toBe('loose');
});

it('mode switches cancel pending channels and paid rites but preserve shared unlocks and cooldowns', () => {
  const w = commandPowersWorld(); w.factions[0].chakras.finial = 1; w.factions[0].chakras.canton = 1;
  cmdAlign(w, { t: 'align', faction: 0, chakra: 'canton' });
  cmdAbility(w, { t: 'ability', faction: 0, ability: 'omega', at, node: -1 });
  cmdRitual(w, { t: 'ritual', faction: 0, ritual: 'redtape', at });
  const ritual = w.factions[0].ritual;
  expect(setFactionControlMode(w, 0, 'avatar')).toBe(true); powerAdvance(w, 5);
  expect(w.zones.size).toBe(0); expect(w.factions[0].ritual).toBe(ritual);
  expect(w.factions[0].chakras.canton).toBe(1); expect(w.factions[0].chakras.finial).toBe(1);
  expect(w.factions[0].cooldowns.omega).toBe(175); expect(w.factions[0].cooldowns.redtape).toBe(145);
});

it('Acid Cop paranoia doubles actual working Signifier attention drain', () => {
  const losses: number[] = [];
  for (const active of [false, true]) {
    const w = commandPowersWorld('acid-cop-attention'); w.options.match = normalizeMatch({ maxSignifiers: 20 });
    const h = spawnHippie(w, 0, at); updateHippies(w, 0);
    h.attention = 100; const brain = brainOf(h); brain.task = 'goto'; brain.nextThinkAt = w.time + 100;
    brain.px = 70; brain.pz = 70;
    if (active) { w.factions[0].drugs.acidcop = 1; cmdDrug(w, { t: 'drug', faction: 0, drug: 'acidcop' }); }
    updateHippies(w, 1); losses.push(100 - h.attention);
  }
  expect(losses[0]).toBeGreaterThan(0); expect(losses[1]).toBeCloseTo(losses[0] * 2, 8);
});
