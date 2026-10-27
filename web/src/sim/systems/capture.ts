/**
 * Hearth capture state machine (safe → threatened → contained → contested → overwritten →
 * captured), per-attacker pressure with modifiers, and ownership conversion on capture.
 * Owner: SurveyRules agent.
 */
import {
  CAPTURE,
  CRYSTAL_PRESSURE_BONUS,
  CRYSTAL_PRESSURE_RADIUS,
  GCC,
  OUTPOST_PRESSURE_MULT,
  WARD_RADIUS,
} from '../constants';
import type { Severity } from '../events';
import { dist2 } from '../math';
import { updateStructureCapture, resetStructureCapture } from './structureCapture';
import { FACTION_IDS, NEUTRAL } from '../types';
import type { Building, CaptureStage, FactionId, HearthState, Owner } from '../types';
import type { World } from '../world';
import { isAvatarDown } from './avatars';
import { collapseGcc, disableBuilding, isCollapsed } from './buildings';
import { transferFlags } from './flags';
import { FACTION_SHORT, isFactionId } from './rules/factions';
import { eliminate, neutralizeHippie, suddenDeathMult } from './victory';

/** A Hearth's stage notice is not repeated within this many seconds (flicker guard). */
const NOTICE_QUIET = 8;
/** "Enemy Ley Lines near your Hearth" is a soft warning, given at most this often per Hearth. */
const THREAT_NOTICE_QUIET = 30;

/** Cross-tick private state of the capture system (lives in world.scratch.capture). */
export class CaptureScratch {
  /** Reused output buffer for lattice radius queries. */
  readonly near: number[] = [];
  /** `${hearthId}:${stage}` → world.time of the last notice. */
  readonly noticeAt = new Map<string, number>();
}

function scratchOf(world: World): CaptureScratch {
  const s = world.scratch.capture;
  if (s instanceof CaptureScratch) return s;
  const fresh = new CaptureScratch();
  world.scratch.capture = fresh;
  return fresh;
}

export function updateCapture(world: World, dt: number): void {
  // The encounter turns surviving camps into allies. Cancel even an overwrite that was
  // already counting down at reveal so it cannot eliminate a new ally during boss combat.
  if (world.effigyRevealedAt !== null) {
    for (const b of world.buildings.values()) {
      const hs = b.hearth;
      if (!hs || !isFactionId(b.faction)) continue;
      const prev = hs.stage;
      hs.stage = 'safe';
      hs.attacker = null;
      hs.overwriteAt = 0;
      for (const f of FACTION_IDS) hs.pressure[f] = 0;
      if (prev !== 'safe') world.emit({ t: 'hearthStage', hearthId: b.id, faction: b.faction,
        stage: 'safe', prev, attacker: null });
    }
    resetStructureCapture(world);
    return;
  }
  const sc = scratchOf(world);
  for (const b of world.buildings.values()) {
    const hs = b.hearth;
    const owner = b.faction;
    if (b.kind !== 'hearth' || !hs || !isFactionId(owner)) continue;
    if (hs.stage === 'overwritten') {
      if (world.time >= hs.overwriteAt) completeOverwrite(world, b, hs, owner);
      continue;
    }
    stepHearth(world, sc, b, hs, owner, dt);
  }
  updateStructureCapture(world, dt);
}

/**
 * Convert a Hearth to `to`: outpost Hearth for the captor, loser's buildings become the
 * captor's (disabled), loser's planted Flags neutral, hippies neutral, GCC destroyed, and
 * the loser eliminated if it has no Hearths left. Emits captured (+ eliminated).
 *
 * A loser that still holds other Hearths (outposts) keeps everything closer to those: only
 * the captured Hearth's own camp changes hands, and its GCC (if parked there) collapses and
 * is rebuilt at a remaining Hearth.
 */
export function captureHearth(world: World, hearth: Building, to: FactionId): void {
  const hs = hearth.hearth;
  const from = hearth.faction;
  if (world.effigyRevealedAt !== null && isFactionId(from)) return;
  if (hearth.kind !== 'hearth' || !hs || from === to || !world.factions[to].alive) return;

  // The Hearth becomes the captor's outpost; its founder is remembered.
  const prev = hs.stage;
  hearth.faction = to;
  hearth.disabled = false;
  hearth.progress = 0;
  hs.stage = 'safe';
  hs.attacker = null;
  hs.overwriteAt = 0;
  hs.craftProgress = 0;
  for (const f of FACTION_IDS) hs.pressure[f] = 0;
  const captor = world.factions[to];
  captor.hearthIds.push(hearth.id);
  captor.stats.captures++;
  for (const fl of world.flags.values()) if (fl.state === 'stock' && fl.holder === hearth.id) fl.owner = to;
  world.emit({ t: 'captured', hearthId: hearth.id, from, to, pos: { ...hearth.pos } });
  world.emit({ t: 'hearthStage', hearthId: hearth.id, faction: to, stage: 'safe', prev, attacker: null });
  if (!isFactionId(from)) return;

  const loser = world.factions[from];
  const i = loser.hearthIds.indexOf(hearth.id);
  if (i >= 0) loser.hearthIds.splice(i, 1);
  world.emit({
    t: 'notify',
    faction: 'all',
    text: `${FACTION_SHORT[to]} has overwritten ${FACTION_SHORT[from]}'s Hearth.`,
    severity: 'epic',
    pos: { ...hearth.pos },
  });

  const remaining: Building[] = [];
  for (const id of loser.hearthIds) {
    const h = world.buildings.get(id);
    if (h) remaining.push(h);
  }
  const inCamp = (x: number, z: number): boolean => {
    const d = dist2(x, z, hearth.pos.x, hearth.pos.z);
    for (const h of remaining) if (dist2(x, z, h.pos.x, h.pos.z) < d) return false;
    return true;
  };

  for (const b of world.buildings.values()) {
    if (b.faction !== from || b.kind === 'hearth' || b.kind === 'gcc' || !inCamp(b.pos.x, b.pos.z)) continue;
    b.faction = to;
    b.capture = null;
    for (const fl of world.flags.values()) if (fl.state === 'stock' && fl.holder === b.id) fl.owner = to;
    disableBuilding(world, b);
  }
  if (remaining.length === 0) {
    eliminate(world, from, to);
    return;
  }
  transferFlags(world, from, NEUTRAL, (fl) => inCamp(fl.pos.x, fl.pos.z));
  // The fallen camp's Signifiers scatter neutral; those nearer a surviving Hearth stay loyal.
  for (const h of world.hippies.values()) {
    if (h.faction === from && inCamp(h.pos.x, h.pos.z)) neutralizeHippie(world, h);
  }
  const gcc = world.gccOf(from);
  if (gcc && !isCollapsed(gcc) && inCamp(gcc.pos.x, gcc.pos.z)) {
    collapseGcc(world, gcc, world.time + GCC.rebuildTime);
  }
}

// ── Stage machine ────────────────────────────────────────────────────────────

function stepHearth(world: World, sc: CaptureScratch, b: Building, hs: HearthState, owner: FactionId, dt: number): void {
  const facet = b.facet;
  let enclosing = 0;
  for (const a of FACTION_IDS) if (a !== owner && world.factions[a].alive && world.inSurvey(facet, a)) enclosing |= 1 << a;

  const contested = holdsHearth(world, b, owner);
  const shared = enclosing !== 0 ? sharedMult(world, b, hs, owner, contested) : 0;
  let encloser: FactionId | null = null;
  let leader: FactionId | null = null;
  for (const a of FACTION_IDS) {
    if (a === owner) continue;
    if (!world.factions[a].alive) {
      hs.pressure[a] = 0;
      continue;
    }
    if (enclosing & (1 << a)) {
      const rate = CAPTURE.baseRate * shared * crystalMult(world, a, b);
      hs.pressure[a] = Math.min(100, hs.pressure[a] + rate * dt);
      if (encloser === null || hs.pressure[a] > hs.pressure[encloser]) encloser = a;
    } else {
      hs.pressure[a] = Math.max(0, hs.pressure[a] - CAPTURE.decay * dt);
    }
    if (hs.pressure[a] > 0 && (leader === null || hs.pressure[a] > hs.pressure[leader])) leader = a;
  }

  let stage: CaptureStage;
  if (encloser !== null && hs.pressure[encloser] >= 100) {
    stage = 'overwritten';
    hs.overwriteAt = world.time + CAPTURE.overwriteTime;
  } else if (encloser !== null) {
    stage = contested ? 'contested' : 'contained';
  } else {
    stage = threatened(world, sc, b, owner) ? 'threatened' : 'safe';
  }
  // While contained, the leading attacker is whoever is enclosing; afterwards, the one whose
  // residual pressure is highest (it decays to zero).
  hs.attacker = encloser ?? leader;
  if (stage === hs.stage) return;
  const prev = hs.stage;
  hs.stage = stage;
  world.emit({ t: 'hearthStage', hearthId: b.id, faction: owner, stage, prev, attacker: hs.attacker });
  narrate(world, sc, b, owner, prev, stage, hs.attacker);
}

/** The 3 s overwrite cannot be stopped; only the captor falling first cancels it. */
function completeOverwrite(world: World, b: Building, hs: HearthState, owner: FactionId): void {
  const to = hs.attacker;
  if (to === null || !world.factions[to].alive) {
    if (to !== null) hs.pressure[to] = 0;
    hs.overwriteAt = 0;
    hs.attacker = null;
    hs.stage = 'safe';
    world.emit({ t: 'hearthStage', hearthId: b.id, faction: owner, stage: 'safe', prev: 'overwritten', attacker: null });
    return;
  }
  hs.stage = 'captured';
  world.emit({ t: 'hearthStage', hearthId: b.id, faction: owner, stage: 'captured', prev: 'overwritten', attacker: to });
  captureHearth(world, b, to);
}

/**
 * "Hold the Hearth": the owner's vexillomancer, up and about within CAPTURE.holdRadius, contests
 * the overwrite by being there in person. The owner's own Survey enclosing the Hearth does not
 * contest: every home ring encloses its Hearth from the start, so that would slow every attack
 * for as long as the ring stood (the overlap still breeds instability instead).
 */
export function holdsHearth(world: World, b: Pick<Building, 'pos'>, owner: FactionId): boolean {
  const av = world.avatars.get(world.factions[owner].avatarId);
  if (!av || isAvatarDown(world, av)) return false;
  return dist2(av.pos.x, av.pos.z, b.pos.x, b.pos.z) <= CAPTURE.holdRadius * CAPTURE.holdRadius;
}

/**
 * Pressure multiplier common to every attacker of this Hearth: contested (owner Holding it in
 * person) ×contestedMult, each defending hippie within defenderRadius ×defenderMult (floored at
 * defenderFloor), a working own Ward within WARD_RADIUS ×wardMult, a captured outpost (held by
 * anyone but its founder) ×OUTPOST_PRESSURE_MULT, and the Burn's escalating sudden death.
 * Outposts are softer so two survivors cannot trade the same Hearth back and forth for ever.
 */
export function sharedMult(world: World, b: Pick<Building, 'pos'>, hs: HearthState | null, owner: FactionId, contested: boolean): number {
  let m = contested ? CAPTURE.contestedMult : 1;
  const r2 = CAPTURE.defenderRadius * CAPTURE.defenderRadius;
  let defenders = 1;
  for (const h of world.hippies.values()) {
    if (h.faction === owner && h.koUntil <= world.time && dist2(h.pos.x, h.pos.z, b.pos.x, b.pos.z) <= r2) {
      defenders *= CAPTURE.defenderMult;
    }
  }
  m *= Math.max(CAPTURE.defenderFloor, defenders);
  const w2 = WARD_RADIUS * WARD_RADIUS;
  for (const w of world.buildings.values()) {
    if (w.kind !== 'ward' || w.faction !== owner || w.built < 1 || w.disabled) continue;
    if (dist2(w.pos.x, w.pos.z, b.pos.x, b.pos.z) <= w2) {
      m *= CAPTURE.wardMult;
      break;
    }
  }
  if (hs && hs.founder !== owner) m *= OUTPOST_PRESSURE_MULT;
  return m * suddenDeathMult(world);
}

/**
 * Attacker Crystals within 45 m add +15% each. After The Burn the Omega Node Crystal's bonus
 * doubles (+30%) and, burning at the effigy, it reaches every Hearth on the burn.
 */
export function crystalMult(world: World, attacker: FactionId, b: Pick<Building, 'pos'>): number {
  const r2 = CRYSTAL_PRESSURE_RADIUS * CRYSTAL_PRESSURE_RADIUS;
  let m = 1;
  for (const c of world.crystals.values()) {
    if (c.faction !== attacker || c.growth < 1) continue;
    if (world.suddenDeath && c.node === world.lattice.omegaNode) m *= 1 + 2 * (CRYSTAL_PRESSURE_BONUS - 1);
    else if (dist2(c.pos.x, c.pos.z, b.pos.x, b.pos.z) <= r2) m *= CRYSTAL_PRESSURE_BONUS;
  }
  return m;
}

/**
 * Threatened: a living rival's Survey facet or Ley Line reaches within CAPTURE.threatRadius
 * (touches a node inside it). Scanned fresh each time into a reused buffer, so phason flips
 * never invalidate anything.
 */
export function threatened(world: World, sc: CaptureScratch, b: Pick<Building, 'pos'>, owner: Owner): boolean {
  const lat = world.lattice;
  const s = world.survey;
  let rivals = 0;
  for (const fac of world.factions) if (fac.alive && fac.id !== owner) rivals |= 1 << fac.id;
  if (rivals === 0) return false;
  const near = sc.near;
  near.length = 0;
  lat.nodesInRadius(b.pos.x, b.pos.z, CAPTURE.threatRadius, near);
  for (let i = 0; i < near.length; i++) {
    const node = lat.nodes[near[i]];
    for (let j = 0; j < node.edges.length; j++) {
      const l = s.edgeLey[node.edges[j]];
      if (l >= 0 && rivals & (1 << l)) return true;
    }
    for (let j = 0; j < node.facets.length; j++) if (s.facetSurvey[node.facets[j]] & rivals) return true;
  }
  return false;
}

// ── Narration ────────────────────────────────────────────────────────────────

function narrate(
  world: World,
  sc: CaptureScratch,
  b: Building,
  owner: FactionId,
  prev: CaptureStage,
  stage: CaptureStage,
  attacker: FactionId | null,
): void {
  const key = `${b.id}:${stage}`;
  const last = sc.noticeAt.get(key) ?? -Infinity;
  const quiet = stage === 'threatened' ? THREAT_NOTICE_QUIET : NOTICE_QUIET;
  if (world.time - last < quiet) return;
  sc.noticeAt.set(key, world.time);

  const tell = (to: FactionId, text: string, severity: Severity): void => {
    world.emit({ t: 'notify', faction: to, text, severity, pos: { ...b.pos } });
  };
  const victim = FACTION_SHORT[owner];
  const enemy = attacker !== null ? FACTION_SHORT[attacker] : 'an enemy';
  const broken = (prev === 'contained' || prev === 'contested') && (stage === 'threatened' || stage === 'safe');

  if (broken) {
    tell(owner, 'The loop is broken. Your Hearth breathes again.', 'good');
    if (attacker !== null) tell(attacker, `Your loop around ${victim}'s Hearth is broken.`, 'warn');
    return;
  }
  switch (stage) {
    case 'threatened':
      if (prev === 'safe') {
        tell(owner, `Enemy Ley Lines within ${CAPTURE.threatRadius} m of your Hearth. The Survey is closing in.`, 'info');
      }
      return;
    case 'contained':
      tell(owner, `Your Hearth is CONTAINED by ${enemy}'s Survey. Pull a loop Flag!`, 'danger');
      if (attacker !== null) tell(attacker, `${victim}'s Hearth is contained. Hold the loop!`, 'good');
      return;
    case 'contested':
      tell(owner, `You Hold the Hearth in person. ${enemy}'s overwrite slows while you stand here.`, 'warn');
      if (attacker !== null) tell(attacker, `${victim} Holds the Hearth in person. Drive them off or the overwrite crawls!`, 'warn');
      return;
    case 'overwritten':
      tell(owner, `OVERWRITE! ${enemy} is rewriting your Hearth. It cannot be stopped.`, 'danger');
      if (attacker !== null) tell(attacker, `Overwriting ${victim}'s Hearth…`, 'epic');
      return;
    default:
      return;
  }
}
