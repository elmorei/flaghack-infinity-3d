/**
 * Lessons 7–9: the Command Table and the Signifiers, building, Crystals and chakras. Grants
 * (Flags in stock, lumber, Ritual) are made at the beat that needs them and named by the
 * Vexillosaint when they would otherwise be a surprise.
 */
import type { ObjectiveMarker } from '../../game/session';
import { planNodeCost } from '../../game/commandView';
import { ALIGN_COST } from '../../sim/constants';
import { planEnclosure } from '../../sim/lattice/planner';
import { canPlantAt } from '../../sim/systems/flags';
import { CHAKRAS, JOBS } from '../../sim/types';
import type { FactionId, JobKind } from '../../sim/types';
import type { World } from '../../sim/world';
import { saint } from '../lesson';
import type { LessonScript } from '../lesson';
import { CALM_RADIUS } from '../../sim/scenarios/tutorial';
import { campSpots, EnclosureProbe, nearHearth, nodeDistance, planPrint, topUpQuiver, topUpStock } from '../staging';

/** The Enclose tool keeps a loop round a plain point at least this far out (commandView.ts). */
const POINT_MIN_RADIUS = 4;
const ENCLOSE_MAX_RADIUS = 80;
/** The Command drill wants a loop that needs this many new Flags (a few trips for the Signifiers). */
const COMMAND_FRESH_MIN = 3;
const COMMAND_FRESH_MAX = 8;
/** Command drill spots tried, from the wish (just past the home ring, off to the side) outward. */
const COMMAND_TRIES = 60;
/** Building drill: enough lumber for three pieces and a Workshop, with change. */
const BUILD_LUMBER = 160;
/** Crystal drill: lumber for the Drum Circle; a focus point within this of the Command Center. */
const CRYSTAL_LUMBER = 110;
const FOCUS_RANGE = 40;
/** Ritual lent above the cheapest alignment, so a stray drumbeat never leaves it short. */
const RITUAL_MARGIN = 5;

/** Fingerprint of the Camp Priorities. */
function weightsPrint(w: Record<JobKind, number>): number {
  let h = 0;
  for (const j of JOBS) h = h * 5 + w[j];
  return h;
}

export const command: LessonScript = {
  id: 'command',
  briefing: [
    saint(
      'You are not alone. Your camp\'s hippies, the **Signifiers**, do most of the work, and you command them from the **Command Table**: {key:Tab} anywhere.',
    ),
    saint('There you set **Camp Priorities** and draw your **Survey Pattern**: ghost Flags your Signifiers fetch from the Hearth and plant for real.'),
  ],
  objectives: [
    { id: 'open', text: 'Open the Command View: {key:Tab}', hint: 'Tab works anywhere. Tab again comes back.' },
    {
      id: 'priority',
      text: 'Camp Priorities: raise **Survey** to 4',
      hint: 'The Priorities sliders set how many Signifiers take each job. Survey hands plant your plan.',
      highlights: ['priorities', 'priority-survey'],
    },
    {
      id: 'enclose',
      text: 'Pick **Enclose** ({key:E} in the Command View) and click inside the marked ring',
      hint: 'Enclose plans the cheapest loop around the spot you click, reusing the Flags you already hold. If the ring sits under a panel, pan the table with W A S D first.',
      highlights: ['plan-tools', 'plan-enclose'],
    },
    {
      id: 'fill',
      text: 'Let your Signifiers plant the plan until the marked ground joins your Survey',
      hint: 'Watch the D.E.G.E.N. roster: Survey hands fetch Flags from the Hearth and carry them out. You can throw Flags onto the ghosts to help.',
      highlights: ['degen-roster', 'hud-signifiers'],
    },
  ],
  debrief: [
    saint(
      'That is the command loop: priorities, pattern, patience. Your Signifiers fetch Flags, plant the plan, chop lumber and guard home while you do the dangerous work.',
    ),
  ],
  begin(ctx) {
    const { world, session, f } = ctx;
    const lat = world.lattice;
    const fac = world.factions[f];
    const probe = new EnclosureProbe(world);
    const cost = (n: number): number => planNodeCost(world, f, n);
    // A spot just outside the home Survey whose Enclose loop needs a handful of new Flags.
    let facet = -1;
    let spot = { x: 0, z: 0 };
    let fresh = 0;
    for (const p of campSpots(world, f, 20, 1.6).slice(0, COMMAND_TRIES)) {
      const target = lat.facetAt(p.x, p.z);
      if (target < 0 || world.inSurvey(target, f)) continue;
      const loop = planEnclosure(lat, { x: p.x, z: p.z, minRadius: POINT_MIN_RADIUS, maxRadius: ENCLOSE_MAX_RADIUS, cost });
      if (!loop) continue;
      let k = 0;
      for (const n of loop) if (cost(n) > 0) k++;
      if (k < COMMAND_FRESH_MIN || k > COMMAND_FRESH_MAX) continue;
      if (loop.some((n) => nearHearth(world, lat.nodes[n].x, lat.nodes[n].z, CALM_RADIUS, [f]))) continue;
      facet = target;
      spot = p;
      fresh = k;
      break;
    }
    topUpStock(world, f, fresh + 6);
    const weights0 = weightsPrint(fac.jobWeights);
    const plan0 = planPrint(fac.plan);
    let probedPlan = plan0;
    let planned = false;
    // The table opens wherever the player left it; the ring can hide under a HUD panel. Centre on
    // it once, the first time the Enclose objective is live in the Command View.
    let centred = false;
    return {
      activate(i) {
        if (facet >= 0 && i === 2) ctx.mark([{ id: 'spot', kind: 'area', at: spot, radius: 5, label: 'Enclose this' }]);
        if (i === 3) ctx.say('Every Signifier carries a D.E.G.E.N. beacon: the roster and the minimap show what each one is up to.');
      },
      progress(i) {
        if (facet < 0) return 1;
        switch (i) {
          case 0:
            // Evidence of the table: the view itself, or priorities and plans only it can change.
            return session.view === 'command' || weightsPrint(fac.jobWeights) !== weights0 || planPrint(fac.plan) !== plan0 ? 1 : 0;
          case 1:
            return fac.jobWeights.survey >= 4 ? 1 : 0;
          case 2: {
            if (!centred && session.view === 'command') {
              centred = true;
              session.camera.cmdX = spot.x;
              session.camera.cmdZ = spot.z;
            }
            const print = planPrint(fac.plan);
            if (print !== probedPlan) {
              probedPlan = print;
              planned = probe.encloses(world, f, fac.plan, facet);
            }
            return planned || world.inSurvey(facet, f) ? 1 : 0;
          }
          default:
            return world.inSurvey(facet, f) ? 1 : 0;
        }
      },
    };
  },
};

export const build: LessonScript = {
  id: 'build',
  briefing: [
    saint('Walls never hold territory: only Flags do. But tarp and timber shelter Flags, stop thrown ones and lift you up.'),
    saint('A piece costs 10 lumber and snaps to the lattice under your crosshair. Camp buildings rise only inside your Survey.'),
  ],
  briefingHighlights: ['hud-lumber'],
  objectives: [
    {
      id: 'wall',
      text: 'Raise a **Tarp Wall**: {key:Z}, aim at a Ley edge, {key:LMB}',
      hint: 'Z picks the wall; the ghost shows where it will stand. Hold LMB and sweep to raise several.',
      highlights: ['tools', 'tool-wall', 'hud-lumber'],
    },
    { id: 'ramp', text: 'A **Ramp**: {key:C}, then {key:LMB}', hint: 'A ramp rises from the facet edge facing you.', highlights: ['tool-ramp'] },
    { id: 'deck', text: 'A **Deck**: {key:X}, then {key:LMB}', hint: 'Decks stand on stilts; you can walk under them or jump up from a ramp.', highlights: ['tool-floor'] },
    {
      id: 'workshop',
      text: 'Raise a **Flag Workshop** inside your Survey: {key:B}, then {key:LMB} on a glowing facet',
      hint: 'B cycles the camp buildings (Workshop first). It needs a fat rhombus inside your Survey and 80 lumber.',
      highlights: ['tool-building', 'buildings-panel'],
    },
  ],
  debrief: [
    saint('The Workshop crafts a Flag every 5 seconds for 3 lumber. It holds 10 Flags for pickup here and adds 10 to your camp hoarding threshold. Additional Flags go to the altar. The base threshold is adjustable in Advanced Game Settings.'),
    saint('Hoarding is how Tartaria fell. "It\'s not about holding the Flag, it\'s about using the Flag to hold space."'),
  ],
  begin(ctx) {
    const { world, f } = ctx;
    const fac = world.factions[f];
    fac.lumber = Math.max(fac.lumber, BUILD_LUMBER);
    const built = [false, false, false, false];
    let current = 0;
    return {
      activate(i) {
        current = i;
      },
      event(e) {
        if (e.t === 'pieceBuilt' && e.faction === f) {
          if (current === 0 && e.kind === 'wall') built[0] = true;
          else if (current === 1 && e.kind === 'ramp') built[1] = true;
          else if (current === 2 && e.kind === 'floor') built[2] = true;
        } else if (e.t === 'buildingPlaced' && e.faction === f && e.kind === 'workshop' && current === 3) built[3] = true;
      },
      progress(i) {
        return built[i] ? 1 : 0;
      },
    };
  },
};

export const crystal: LessonScript = {
  id: 'crystal',
  briefing: [
    saint('Five-fold **focus points** hide in the lattice: nodes where five fat rhombi meet. Hold all five neighbours, the pentacle, and a **Crystal** manifests.'),
    saint('Your Command Center reveals focus points near it. I have marked one. A Crystal gives Ritual, watches the ground around it and adds to your C.M.I.'),
    saint('Ritual buys **chakra alignments** from anywhere, and each chakra wakes an ability.'),
  ],
  briefingHighlights: ['cmi'],
  objectives: [
    {
      id: 'pentacle',
      text: 'Hold the pentacle: plant Flags on the five nodes around the marked focus',
      hint: 'Plant on each of the five markers, or plan them with the Pentacle tool ({key:P} in the Command View) and let your Signifiers do it.',
      highlights: ['plan-pentacle', 'cmi'],
      target: 5,
    },
    {
      id: 'drum',
      text: 'Raise a **Drum Circle** inside your Survey: {key:B} until it shows, then {key:LMB}',
      hint: 'Drummers earn Ritual and the circle recruits new Signifiers. Press B twice to reach it.',
      highlights: ['tool-building', 'buildings-panel'],
    },
    {
      id: 'align',
      text: 'Align a chakra: open the chakras ({key:K}) and Align',
      hint: 'You can align anywhere. Hold still for 4 seconds; getting hit interrupts alignment.',
      highlights: ['chakras-panel', 'align-button', 'hud-ritual'],
    },
    {
      id: 'cast',
      text: 'Cast the ability you just woke: {key:1} to {key:5}',
      hint: 'Hoist is 1 (Priority Beacon), Fly 2 (Forced March), Canton 3 (Stabilize Zone), Field 4 (Phason Shift), Finial 5 (Omega Pulse).',
      highlights: ['ability-1', 'ability-2', 'ability-3', 'ability-4', 'ability-5'],
    },
  ],
  debrief: [
    saint('Five chakras, one per Ley direction, named for the parts of a Flag: Hoist, Fly, Canton, Field and Finial. Each deeper level costs more Ritual and reaches further.'),
  ],
  begin(ctx) {
    const { world, f } = ctx;
    const lat = world.lattice;
    const fac = world.factions[f];
    fac.lumber = Math.max(fac.lumber, CRYSTAL_LUMBER);
    const focus = focusNode(world, f);
    const ring = focus >= 0 ? lat.neighbors(focus) : [];
    topUpQuiver(world, f, 6);
    let current = 0;
    let drummed = false;
    let aligned = false;
    let cast = false;
    const crystalHere = (): boolean => {
      for (const c of world.crystals.values()) if (c.node === focus && c.faction === f) return true;
      return false;
    };
    return {
      activate(i) {
        current = i;
        if (i === 0 && focus >= 0) {
          const markers: ObjectiveMarker[] = [{ id: 'focus', kind: 'node', node: focus, label: 'Focus point', color: world.factions[f].color }];
          for (const n of ring) markers.push({ id: `p${n}`, kind: 'node', node: n, label: 'Plant' });
          ctx.mark(markers);
        } else if (i === 1) ctx.mark([]);
        else if (i === 2) {
          let cheapest = Infinity;
          for (const c of CHAKRAS) if (fac.chakras[c] < ALIGN_COST.length) cheapest = Math.min(cheapest, ALIGN_COST[fac.chakras[c]]);
          if (Number.isFinite(cheapest) && fac.ritual < cheapest + RITUAL_MARGIN) {
            fac.ritual = cheapest + RITUAL_MARGIN;
            ctx.say('Drummers earn Ritual slowly, a tenth a second each. I have lent you enough for one alignment.');
          }
          ctx.mark([]);
        } else if (i === 3) ctx.mark([]);
      },
      event(e) {
        if (e.t === 'crystalManifest' && e.faction === f && e.node === focus && current === 0) {
          ctx.say('A Crystal: the infinite-order implied Flag. It sustains your Flags and lends weight to every siege within 45 m.');
        } else if (e.t === 'buildingPlaced' && e.faction === f && e.kind === 'drumcircle' && current === 1) drummed = true;
        else if (e.t === 'aligned' && e.faction === f && current === 2) aligned = true;
        else if (e.t === 'ability' && e.faction === f && current === 3) cast = true;
      },
      progress(i) {
        switch (i) {
          case 0: {
            if (focus < 0 || crystalHere()) return 5;
            let held = 0;
            for (const n of ring) if (world.survey.holder[n] === f) held++;
            return Math.min(4, held);
          }
          case 1:
            return drummed ? 1 : 0;
          case 2:
            return aligned ? 1 : 0;
          default:
            return cast ? 1 : 0;
        }
      },
    };
  },
};

/**
 * The focus point for the pentacle drill: a 5-fold star within FOCUS_RANGE of the Command
 * Center (where Geomantic Advice reveals it), without a Crystal, whose five neighbours are all
 * yours or free for you. Nearest the cart first; -1 if none.
 */
function focusNode(world: World, f: FactionId): number {
  const lat = world.lattice;
  const s = world.survey;
  const gcc = world.gccOf(f) ?? world.hearthOf(f);
  if (!gcc) return -1;
  let best = -1;
  let bestD = Infinity;
  for (const n of s.focusNodes) {
    const d = nodeDistance(world, n, gcc.pos.x, gcc.pos.z);
    if (d > FOCUS_RANGE || d > bestD || (d === bestD && n > best) || lat.nodes[n].blocked || s.nodeFlag[n] >= 0) continue;
    let crystal = false;
    for (const c of world.crystals.values()) if (c.node === n) crystal = true;
    if (crystal) continue;
    const calm = (m: number): boolean => !nearHearth(world, lat.nodes[m].x, lat.nodes[m].z, CALM_RADIUS, [f]);
    if (!lat.neighbors(n).every((m) => calm(m) && (s.holder[m] === f || canPlantAt(world, m, f)))) continue;
    best = n;
    bestD = d;
  }
  return best;
}
