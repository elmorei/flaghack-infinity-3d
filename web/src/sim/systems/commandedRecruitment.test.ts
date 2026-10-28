import { describe, expect, it, vi } from 'vitest';
import { SIM_DT } from '../constants';
import { spawnHippie } from '../factory';
import { burnTime } from '../matchSettings';
import { createMatch } from '../setup';
import { Simulation } from '../simulation';
import { normalizeMatch } from '../matchSettings';
import { newMatch } from './econ/testkit';
import { moveBuilding } from './buildings';
import { damageEntity } from './combat';
import { giveFlag } from './flags';
import { cmdOrder, updateHippies } from './hippies';
import { canRecruit, recruitNear, recoveryRecruiter, updateRecoveryCalls } from './recruitment';
import { act } from './units/act';
import { brainOf } from './units/brain';
import { decide } from './units/decide';
import { unitsState } from './units/state';

function setup() {
  const { world } = newMatch('recruitment-orders');
  world.hippies.clear();
  const av = world.avatarOf(0);
  const at = world.lattice.nodes.find(n => !n.boundary && Math.abs(n.x) < 100 && Math.abs(n.z) < 100 && !world.collision.blockedCircle(n.x, n.z, 15, .05, 4))!;
  const worker = spawnHippie(world, 0, { x: at.x, z: at.z });
  const neutral = spawnHippie(world, -1, { x: at.x + 1, z: at.z });
  const flagId = av.carried.at(-1)!;
  giveFlag(world, flagId, worker.id);
  return { world, worker, neutral, flagId, sys: unitsState(world) };
}
function ordered(e: ReturnType<typeof setup>) {
  cmdOrder(e.world, { t: 'order', faction: 0, hippies: [e.worker.id], order: { kind: 'recruit', target: e.neutral.id } });
  const b = brainOf(e.worker);
  decide(e.world, e.sys, e.worker, b, 0);
  return b;
}

describe('commanded recruitment', () => {
  it('physically hands off the same flag, creating neither flag nor person', () => {
    const e = setup(), n = e.world.flags.size, b = ordered(e);
    act(e.world, e.sys, e.worker, b, 0, SIM_DT);
    expect(e.neutral.faction).toBe(0);
    expect(e.neutral.carryingFlag).toBe(e.flagId);
    expect(e.worker.carryingFlag).toBe(-1);
    expect(e.world.flags.get(e.flagId)?.holder).toBe(e.neutral.id);
    expect(e.world.flags.size).toBe(n);
    expect(e.world.hippies.size).toBe(2);
    expect(e.worker.order).toBeNull();
  });
  it('fetches an actual stocked flag before walking to handoff', () => {
    const e = setup();
    giveFlag(e.world, e.flagId, e.world.avatarOf(0).id);
    for (const b of e.world.buildings.values()) if (b.kind === 'gcc') b.disabled = true;
    const home = e.world.hearthOf(0)!;
    Object.assign(e.worker.pos, e.world.nav.nearestWalkable(home.pos.x + 5, home.pos.z));
    Object.assign(e.neutral.pos, e.world.nav.nearestWalkable(home.pos.x + 10, home.pos.z));
    const idle = brainOf(e.neutral); idle.task = 'wander'; idle.waitUntil = Infinity;
    const stock = new Set([...e.world.flags.values()].filter(f => f.state === 'stock' && f.owner === 0).map(f => f.id));
    const flags = e.world.flags.size;
    cmdOrder(e.world, { t: 'order', faction: 0, hippies: [e.worker.id], order: { kind: 'recruit', target: e.neutral.id } });
    for (let i = 0; i < 60 / SIM_DT && e.neutral.faction === -1; i++) {
      e.world.time += SIM_DT; e.world.tick++; updateHippies(e.world, SIM_DT);
    }
    expect(e.neutral.faction).toBe(0);
    expect(stock.has(e.neutral.carryingFlag)).toBe(true);
    expect(e.world.flags.size).toBe(flags);
    expect(e.worker.carryingFlag).toBe(-1);
  });
  it('canceling a queued stock fetch releases its reservation without touching inventory', () => {
    const e = setup(); giveFlag(e.world, e.flagId, e.world.avatarOf(0).id);
    cmdOrder(e.world, { t: 'order', faction: 0, hippies: [e.worker.id], order: { kind: 'recruit', target: e.neutral.id } });
    updateHippies(e.world, SIM_DT);
    const b = brainOf(e.worker), depot = b.target;
    expect(b.task).toBe('fetchStock');
    expect(e.sys.fetchers.get(depot)).toBe(1);
    cmdOrder(e.world, { t: 'order', faction: 0, hippies: [e.worker.id], order: null });
    expect(e.sys.fetchers.get(depot) ?? 0).toBe(0);
    expect(e.worker.carryingFlag).toBe(-1);
    expect(e.neutral.faction).toBe(-1);
  });
  it('a KO recruiter drops its flag rather than remotely completing the order', () => {
    const e = setup(); ordered(e);
    damageEntity(e.world, e.worker.id, 1000, e.world.avatarOf(1).id);
    updateHippies(e.world, SIM_DT);
    expect(e.worker.status).toBe('ko');
    expect(e.neutral.faction).toBe(-1);
    expect(e.worker.carryingFlag).toBe(-1);
    expect(e.world.flags.get(e.flagId)?.state).toBe('loose');
  });
  it('two workers racing to the same neutral transfer only one real flag', () => {
    const e = setup();
    const other = spawnHippie(e.world, 0, { ...e.worker.pos });
    const flag = e.world.avatarOf(0).carried.at(-1)!;
    giveFlag(e.world, flag, other.id);
    const b = ordered(e);
    cmdOrder(e.world, { t: 'order', faction: 0, hippies: [other.id], order: { kind: 'recruit', target: e.neutral.id } });
    const ob = brainOf(other); decide(e.world, e.sys, other, ob, 0);
    act(e.world, e.sys, e.worker, b, 0, SIM_DT);
    act(e.world, e.sys, other, ob, 0, SIM_DT);
    expect(e.neutral.carryingFlag).toBe(e.flagId);
    expect(other.carryingFlag).toBe(flag);
    expect(other.order).toBeNull();
  });
  it.each(['claimed', 'ko', 'cancel', 'far', 'wall'] as const)('does not transfer on %s; preserves worker inventory', why => {
    const e = setup(), b = ordered(e);
    if (why === 'claimed') e.neutral.faction = 1;
    if (why === 'ko') { e.neutral.koUntil = 12; e.neutral.status = 'ko'; }
    if (why === 'cancel') cmdOrder(e.world, { t: 'order', faction: 0, hippies: [e.worker.id], order: null });
    if (why === 'far') e.neutral.pos.x += 20;
    if (why === 'wall') vi.spyOn(e.world.collision, 'raycast').mockReturnValue({} as never);
    act(e.world, e.sys, e.worker, b, 0, SIM_DT);
    expect(e.worker.carryingFlag).toBe(e.flagId);
    expect(e.neutral.carryingFlag).toBe(-1);
  });
  it('ignores a command claiming an enemy worker', () => {
    const e = setup();
    cmdOrder(e.world, { t: 'order', faction: 1, hippies: [e.worker.id], order: { kind: 'recruit', target: e.neutral.id } });
    expect(e.worker.order).toBeNull();
  });
  it('ends an unreachable handoff without losing its flag', () => {
    const e = setup(), b = ordered(e);
    e.neutral.pos.x += 20;
    b.route = 'blocked'; b.routeAt = e.world.time; b.routeX = e.neutral.pos.x; b.routeZ = e.neutral.pos.z;
    act(e.world, e.sys, e.worker, b, 0, SIM_DT);
    expect(e.worker.order).toBeNull();
    expect(e.worker.carryingFlag).toBe(e.flagId);
  });
});

describe('passive recovery', () => {
  it('prioritizes real GCC attraction over pre-Burn audience with zero workers and resources', () => {
    const e = setup(); e.world.hippies.delete(e.worker.id);
    e.world.factions[0].lumber = 0;
    const gcc = e.world.gccOf(0)!;
    // A genuine open approach near the existing recruiter.
    const p = e.world.nav.nearestWalkable(gcc.pos.x + 24, gcc.pos.z);
    Object.assign(e.neutral.pos, p);
    e.world.time = burnTime(e.world.options) - 100;
    updateHippies(e.world, SIM_DT);
    expect(e.neutral.statusTarget).toEqual(gcc.pos);
    expect(brainOf(e.neutral).task).not.toBe('watchBurn');
    expect(e.world.hippies.size).toBe(1);
  });
  it.each(['recovery-a', 'recovery-b', 'recovery-c'])('walks a far-pool survivor back on real map %s, without money or spawning', seed => {
    const world = createMatch({ seed, difficulty: 'normal', humans: [0], mode: 'standard', rtsFactions: [0], match: normalizeMatch({ startingSignifiers: 0, maxSignifiers: 1, bossMode: false }) });
    // Only our functioning GCC; no competing call can preclaim the lone neutral.
    const gcc = world.gccOf(0)!;
    for (const b of world.buildings.values()) if (b.id !== gcc.id && (b.kind === 'gcc' || b.kind === 'drumcircle')) b.disabled = true;
    for (const f of world.factions) f.lumber = 0;
    const sim = new Simulation(world);
    const neutral = [...world.hippies.values()][0];
    expect(neutral.faction).toBe(-1);
    const p = world.nav.nearestWalkable(0, 35);
    Object.assign(neutral.pos, p);
    expect(Math.hypot(p.x - gcc.pos.x, p.z - gcc.pos.z)).toBeGreaterThan(60);
    const count = world.hippies.size, flags = world.flags.size;
    world.time = burnTime(world.options) - 100;
    updateRecoveryCalls(world);
    expect(recoveryRecruiter(world, neutral)?.id).toBe(gcc.id);
    const start = { ...neutral.pos };
    updateHippies(world, SIM_DT);
    expect(Math.hypot(neutral.pos.x - start.x, neutral.pos.z - start.z)).toBeLessThan(1);
    for (let i = 0; i < 240 / SIM_DT && neutral.faction === -1; i++) {
      sim.step();
    }
    expect(neutral.faction).toBe(0);
    expect(Math.hypot(neutral.pos.x - gcc.pos.x, neutral.pos.z - gcc.pos.z)).toBeLessThanOrEqual(15);
    expect(world.hippies.size).toBe(count);
    expect(world.flags.size).toBe(flags)
    expect(world.factions[0].lumber).toBe(0);
  });
  it('reserves only one neutral per empty GCC, and respects commanded claims', () => {
    const e = setup(), gcc = e.world.gccOf(0)!;
    e.world.hippies.delete(e.worker.id);
    for (const b of e.world.buildings.values()) if (b.id !== gcc.id && b.kind === 'gcc') b.disabled = true;
    const p = e.world.nav.nearestWalkable(0, 35);
    Object.assign(e.neutral.pos, p);
    const other = spawnHippie(e.world, -1, { x: p.x + 2, z: p.z });
    updateRecoveryCalls(e.world);
    expect([e.neutral, other].filter(h => recoveryRecruiter(e.world, h))).toHaveLength(1);
  });
  it('competing empty GCCs reserve different shared-pool individuals', () => {
    const e = setup(); e.world.hippies.delete(e.worker.id);
    for (const b of e.world.buildings.values()) if (b.kind === 'gcc' && b.faction !== 0 && b.faction !== 1) b.disabled = true;
    const p = e.world.nav.nearestWalkable(0, 35);
    Object.assign(e.neutral.pos, p);
    const other = spawnHippie(e.world, -1, e.world.nav.nearestWalkable(p.x + 3, p.z));
    updateRecoveryCalls(e.world);
    const calls = [e.neutral, other].map(h => recoveryRecruiter(e.world, h)?.id);
    expect(calls.every(id => id !== undefined)).toBe(true);
    expect(new Set(calls).size).toBe(2);
  });
  it('does not globally steal commanded targets and releases calls when GCC ownership becomes invalid', () => {
    const e = setup(), gcc = e.world.gccOf(0)!;
    e.world.hippies.delete(e.worker.id);
    for (const b of e.world.buildings.values()) if (b.id !== gcc.id && b.kind === 'gcc') b.disabled = true;
    const p = e.world.nav.nearestWalkable(0, 35);
    Object.assign(e.neutral.pos, p);
    const rival = spawnHippie(e.world, 1, { x: p.x + 30, z: p.z });
    rival.order = { kind: 'recruit', target: e.neutral.id };
    updateRecoveryCalls(e.world);
    expect(recoveryRecruiter(e.world, e.neutral)).toBeUndefined();
    rival.order = null; e.world.time += 1; updateRecoveryCalls(e.world);
    expect(recoveryRecruiter(e.world, e.neutral)?.id).toBe(gcc.id);
    gcc.disabled = true;
    expect(recoveryRecruiter(e.world, e.neutral)).toBeUndefined();
  });
  it('invalidates a global recovery approach immediately when the GCC moves', () => {
    const e = setup(), gcc = e.world.gccOf(0)!;
    e.world.hippies.delete(e.worker.id);
    for (const b of e.world.buildings.values()) if (b.id !== gcc.id && b.kind === 'gcc') b.disabled = true;
    Object.assign(e.neutral.pos, e.world.nav.nearestWalkable(0, 35));
    updateRecoveryCalls(e.world);
    expect(recoveryRecruiter(e.world, e.neutral)?.id).toBe(gcc.id);
    moveBuilding(e.world, gcc, gcc.pos.x + 2, gcc.pos.z);
    expect(recoveryRecruiter(e.world, e.neutral)).toBeUndefined();
    e.world.time += 1; updateRecoveryCalls(e.world);
    expect(recoveryRecruiter(e.world, e.neutral)?.id).toBe(gcc.id);
  });
  it('cannot enlist through a blocked approach, from empty pool, or a destroyed GCC', () => {
    const e = setup(), gcc = e.world.gccOf(0)!;
    Object.assign(e.neutral.pos, { x: gcc.pos.x + 8, z: gcc.pos.z });
    vi.spyOn(e.world.collision, 'raycast').mockReturnValue({} as never);
    expect(recruitNear(e.world, gcc)).toBe(false);
    expect(canRecruit(e.neutral)).toBe(true);
    vi.restoreAllMocks(); gcc.disabled = true;
    expect(recruitNear(e.world, gcc)).toBe(false);
    gcc.disabled = false; e.world.hippies.clear();
    expect(recruitNear(e.world, gcc)).toBe(false);
  });
  it('never recovers an eliminated faction', () => {
    const e = setup(), gcc = e.world.gccOf(0)!;
    Object.assign(e.neutral.pos, { x: gcc.pos.x + 8, z: gcc.pos.z });
    e.world.factions[0].alive = false;
    expect(recruitNear(e.world, gcc)).toBe(false);
  });
});
