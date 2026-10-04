/**
 * Lessons 10–12: holding a Hearth against a loop, overwriting one, and the graduation walk.
 * The defense drill's raider is scripted here (no NPC brain): the Vexillosaint plants a loop
 * in DJ Scarecrow's colours round the trainee's Hearth, one Flag at a time, keeps it closed
 * until the trainee has Held the Hearth, and never lets the overwrite finish.
 */
import type { ObjectiveMarker } from '../../game/session';
import { AVATAR, CAPTURE, IMPLIED_MAX_ORDER } from '../../sim/constants';
import { criticalNodes } from '../../sim/lattice/geometry';
import { DRILL_PLANS, planDrillLoop, SPARRING_CAMP, TRAINING_CAMP } from '../../sim/scenarios/tutorial';
import { neutralizeHippie } from '../../sim/systems/victory';
import { geometryOwners } from '../../sim/systems/survey';
import { brainOf } from '../../sim/systems/units/brain';
import type { Building, FactionId, Hippie } from '../../sim/types';
import type { World } from '../../sim/world';
import { saint } from '../lesson';
import type { LessonScript } from '../lesson';
import { avatarDistance, EnclosureProbe, planPrint, plantFresh, recallFlags, topUpQuiver, topUpStock } from '../staging';

/** Seconds between the raider's Flags going in, and before a broken loop is mended. */
const RAID_PLANT_INTERVAL = 0.2;
const RAID_MEND_DELAY = 1.5;
/**
 * A drill loop node within threat range of a camp outside the drill costs this many extra
 * Flags: the loop swings wide of Dr. Crow's camp when it can, and passes near it only when
 * the trainee's own Flags leave no other way round.
 */
const RAID_CALM_COST = 40;
/** The drill's pressure never passes this (the overwrite needs 100). */
const RAID_PRESSURE_CAP = 85;
/** The raider's leftover Flags are recalled from this far round the trainee's Hearth. */
const RAID_RECALL_RADIUS = 90;
/** Critical Flags marked for the trainee to pull. */
const CRITICAL_MARKS = 3;
/** Conquest: Flags in the trainee's stock for the Signifiers, and the old loop recalled on a replay. */
const CONQUEST_STOCK = 26;
const CONQUEST_RECALL_RADIUS = 34;
/** Graduation: a lost Signifier drifts up once the trainee is this close to the cart, this close to it. */
const GIFT_ARRIVE_RADIUS = 14;
const GIFT_SPAWN_DISTANCE = 4;
/** The waiting Signifier is put back on its spot beside the cart once it strays this far (m). */
const GIFT_WAIT_SLACK = 2;
/** A new lost Signifier may wander up this long after the last one (they drift off between). */
const GIFT_ARRIVAL_GAP = 15;

export const defense: LessonScript = {
  id: 'defense',
  briefing: [
    saint('This is a drill. I am about to plant a loop around your Hearth in DJ Scarecrow\'s colours, the way a raid would.'),
    saint(
      'Your **Hearth rail** shows every Hearth\'s stage: Safe, Threatened, Contained, Contested, Overwritten. Inside an enemy Survey, pressure climbs to 100, and then the overwrite cannot be stopped.',
    ),
    saint('In this drill I will not let it finish. In a real burn, nobody will hold it for you.'),
  ],
  briefingHighlights: ['rail'],
  objectives: [
    {
      id: 'contained',
      text: 'Watch your Hearth on the rail as the loop closes',
      hint: 'The rail at the top lists every Hearth. Yours turns Threatened, then Contained.',
      highlights: ['rail', 'rail-own'],
    },
    {
      id: 'hold',
      text: 'Hold the Hearth: stand within 8 m of it',
      hint: 'Your presence alone slows the overwrite: the rail reads Contested while you stand there.',
      highlights: ['rail-own'],
    },
    {
      id: 'break',
      text: 'Break the loop: crosshair on one of its Flags, hold {key:E}',
      hint: 'Any Flag on a single loop is critical. Look at a marked Flag until the prompt says Pull, then hold E for a full second; without the crosshair on it, E plants a Flag of yours instead.',
      highlights: ['rail-own', 'prompt'],
    },
  ],
  debrief: [
    saint('One Flag breaks a loop. Raid Signifiers pull critical Flags for you, a Hearth Ward slows the pressure, and a Phason Shift can turn a loop node out from under them.'),
    saint('Where two Surveys overlap, the Crystal grows unstable: it shimmers, then throws lightning. You may have felt it.'),
  ],
  begin(ctx) {
    const { world, f } = ctx;
    const lat = world.lattice;
    const raider = SPARRING_CAMP;
    const hearth = world.hearthOf(f);
    const home = hearth ? { x: hearth.pos.x, z: hearth.pos.z } : null;
    const alive = (): boolean => world.factions[raider].alive && world.hearthOf(raider) !== undefined;
    // A previous drill's leftovers go home first.
    if (home) recallFlags(world, raider, (fl) => Math.hypot(fl.pos.x - home.x, fl.pos.z - home.z) <= RAID_RECALL_RADIUS);
    /** The raider's loop round the Hearth: the first drill plan that has one, or []. */
    const planLoop = (): number[] => {
      if (!hearth || !alive()) return [];
      for (const plan of DRILL_PLANS) {
        const loop = planDrillLoop(world, raider, f, plan, RAID_CALM_COST);
        if (loop) return loop;
      }
      return [];
    };
    /** A drill loop forced within threat range of a camp outside the drill stirs its rail entry: say why. */
    const explainStir = (): void => {
      const r2 = CAPTURE.threatRadius * CAPTURE.threatRadius;
      for (const n of loop) {
        const node = lat.nodes[n];
        for (const b of world.buildings.values()) {
          if (b.kind !== 'hearth' || b.faction === raider || b.faction === f || b.faction === -1) continue;
          if ((b.pos.x - node.x) ** 2 + (b.pos.z - node.z) ** 2 > r2) continue;
          ctx.say(
            `Your Flags leave my drill loop no way round but close to ${world.factions[b.faction].name}'s camp, so its rail entry reads Threatened too: rival Ley Lines within ${CAPTURE.threatRadius} m threaten any Hearth.`,
          );
          return;
        }
      }
    };
    let loop = planLoop();
    explainStir();
    let next = 0;
    let nextAt = world.time + RAID_PLANT_INTERVAL;
    let brokenSince = -1;
    let current = 0;

    const markCritical = (): void => {
      if (!hearth) return;
      const crit = criticalNodes(lat, geometryOwners(world), raider, hearth.facet, IMPLIED_MAX_ORDER);
      const av = world.avatarOf(f);
      crit.sort((a, b) => {
        const na = lat.nodes[a];
        const nb = lat.nodes[b];
        return Math.hypot(na.x - av.pos.x, na.z - av.pos.z) - Math.hypot(nb.x - av.pos.x, nb.z - av.pos.z) || a - b;
      });
      ctx.mark(crit.slice(0, CRITICAL_MARKS).map((n): ObjectiveMarker => ({ id: `c${n}`, kind: 'node', node: n, label: 'Pull this', color: world.factions[raider].color })));
    };
    return {
      activate(i) {
        current = i;
        if (!hearth) return;
        if (i === 1) ctx.mark([{ id: 'hold', kind: 'area', at: { x: hearth.pos.x, z: hearth.pos.z }, radius: CAPTURE.holdRadius, label: 'Hold the Hearth' }]);
        else if (i === 2) {
          markCritical();
          ctx.say('Contested: your presence slows the overwrite. Now break their loop. Leave the Hearth and the pressure climbs faster, so be quick.');
        }
      },
      tick() {
        if (!hearth || !alive()) return;
        const hs = hearth.hearth;
        // The drill never ends in an overwrite.
        if (hs && hs.pressure[raider] > RAID_PRESSURE_CAP) hs.pressure[raider] = RAID_PRESSURE_CAP;
        // Until the trainee has Held the Hearth, the raider plants the loop and mends it when broken.
        if (current >= 2 || world.time < nextAt) return;
        if (next < loop.length) {
          const n = loop[next];
          if (world.survey.nodeFlagOwner[n] === raider || plantFresh(world, raider, n) >= 0) {
            next++;
            nextAt = world.time + RAID_PLANT_INTERVAL;
            return;
          }
          // The trainee took a node: plan round it.
          loop = planLoop();
          explainStir();
          next = 0;
          return;
        }
        if (world.inSurvey(hearth.facet, raider)) {
          brokenSince = -1;
          return;
        }
        if (brokenSince < 0) {
          brokenSince = world.time;
          return;
        }
        if (world.time - brokenSince < RAID_MEND_DELAY) return;
        brokenSince = -1;
        loop = planLoop();
        explainStir();
        next = 0;
        ctx.say('The loop broke before you Held the Hearth. I am closing it again: get to your Hearth.');
      },
      event(e) {
        if (current === 2 && e.t === 'flagPulled' && e.prevOwner === raider) markCritical();
      },
      progress(i) {
        if (!hearth || loop.length === 0) return 1;
        const stage = hearth.hearth?.stage;
        const contained = world.inSurvey(hearth.facet, raider);
        if (i === 0) return (stage === 'contained' || stage === 'contested') && contained ? 1 : 0;
        if (i === 1) return stage === 'contested' ? 1 : 0;
        return contained ? 0 : 1;
      },
      end() {
        // The drill is over: the raider's Flags go home.
        if (home) recallFlags(world, raider, (fl) => Math.hypot(fl.pos.x - home.x, fl.pos.z - home.z) <= RAID_RECALL_RADIUS);
        const hs = hearth?.hearth;
        if (hs) hs.pressure[raider] = 0;
      },
    };
  },
};

/** The training camp's Hearth: the one Dr. Crow founded, wherever it stands now. */
function trainingHearth(world: World): Building | undefined {
  for (const b of world.buildings.values()) if (b.kind === 'hearth' && b.hearth?.founder === TRAINING_CAMP) return b;
  return undefined;
}

/**
 * Prop the training camp back up after an earlier overwrite (the lesson is being replayed):
 * the Hearth returns to Dr. Crow with its stock, his cardboard vexillomancer stands again and
 * the old loop round it goes back to the trainee's stock. Returns true if anything changed.
 */
function reviveTrainingCamp(world: World, f: FactionId, hearth: Building): boolean {
  const hs = hearth.hearth;
  const camp = world.factions[TRAINING_CAMP];
  if (!hs || (hearth.faction === TRAINING_CAMP && camp.alive)) return false;
  const holder = hearth.faction;
  if (holder !== -1) {
    const ids = world.factions[holder].hearthIds;
    const i = ids.indexOf(hearth.id);
    if (i >= 0) ids.splice(i, 1);
  }
  hearth.faction = TRAINING_CAMP;
  camp.alive = true;
  camp.eliminatedAt = null;
  camp.eliminatedBy = null;
  camp.hearthIds = [hearth.id];
  hs.stage = 'safe';
  hs.attacker = null;
  hs.overwriteAt = 0;
  hs.pressure[0] = 0;
  hs.pressure[1] = 0;
  hs.pressure[2] = 0;
  hs.pressure[3] = 0;
  for (const fl of world.flags.values()) if (fl.state === 'stock' && fl.holder === hearth.id) fl.owner = TRAINING_CAMP;
  const keeper = world.avatarOf(TRAINING_CAMP);
  keeper.koUntil = 0;
  keeper.hp = AVATAR.maxHp;
  recallFlags(world, f, (fl) => Math.hypot(fl.pos.x - hearth.pos.x, fl.pos.z - hearth.pos.z) <= CONQUEST_RECALL_RADIUS);
  return true;
}

export const conquest: LessonScript = {
  id: 'conquest',
  briefing: [
    saint('Now the other side of the siege. Dr. Beelzebub Crow is missing, presumed Vexillian, and his camp stands unattended just beyond yours.'),
    saint('Enclose his Hearth in your Survey and keep the loop closed: Contained, then Overwritten, then Captured.'),
    saint('In the Command View the **Enclose** tool snaps to an enemy Hearth and plans the cheapest loop around it, outside its defenders\' reach.'),
  ],
  briefingHighlights: ['rail'],
  objectives: [
    {
      id: 'plan',
      text: 'Plan a loop around Dr. Crow\'s Hearth: **Enclose**, then click his Hearth',
      hint: 'Tab, then E for Enclose, and click on or near his Hearth. The ghost loop shows how many new Flags it needs.',
      highlights: ['plan-tools', 'plan-enclose'],
    },
    {
      id: 'contain',
      text: 'Close the loop: your Signifiers plant the plan; throw Flags onto the ghosts to help',
      hint: 'Raise Survey and lower Gather in Camp Priorities for more hands. Your Hearth refills your quiver.',
      highlights: ['priorities', 'priority-survey', 'hud-flags'],
    },
    {
      id: 'overwrite',
      text: 'Hold the loop until his Hearth is **Overwritten** and **Captured**',
      hint: 'Pressure climbs about 6 a second with nobody defending. Keep every loop Flag standing.',
      highlights: ['rail'],
      target: 100,
    },
  ],
  debrief: [
    saint('Captured. That Hearth is your outpost now, its stock is yours, and Dr. Crow is Flagless. In a real burn, the last camp with a Hearth wins.'),
  ],
  begin(ctx) {
    const { world, f } = ctx;
    const hearth = trainingHearth(world);
    if (hearth && reviveTrainingCamp(world, f, hearth)) ctx.say('I have propped Dr. Crow\'s camp back up for another go.');
    topUpStock(world, f, CONQUEST_STOCK);
    topUpQuiver(world, f, AVATAR.quiver);
    const probe = new EnclosureProbe(world);
    const plan = world.factions[f].plan;
    let probed = -1;
    let planned = false;
    let captured = false;
    return {
      activate(i) {
        if (!hearth) return;
        if (i === 0) ctx.mark([{ id: 'crow', kind: 'entity', entity: hearth.id, label: 'Dr. Crow\'s Hearth', color: world.factions[TRAINING_CAMP].color }]);
        if (i === 2) ctx.say('Contained. Pressure is building; keep the loop closed.');
      },
      event(e) {
        if (hearth && e.t === 'captured' && e.hearthId === hearth.id && e.to === f) captured = true;
      },
      progress(i) {
        if (!hearth) return i === 2 ? 100 : 1;
        const ours = world.inSurvey(hearth.facet, f);
        if (i === 0) {
          // Plans only change by command: probe the geometry when the plan does.
          const print = planPrint(plan);
          if (print !== probed) {
            probed = print;
            planned = probe.encloses(world, f, plan, hearth.facet);
          }
          return planned || ours || captured ? 1 : 0;
        }
        if (i === 1) return ours || captured ? 1 : 0;
        if (captured || hearth.faction === f) return 100;
        return Math.min(99, Math.floor(hearth.hearth?.pressure[f] ?? 0));
      },
    };
  },
};

export const graduation: LessonScript = {
  id: 'graduation',
  briefing: [
    saint('One last walk around the burn before the Seal is whole.'),
    saint(
      '**The Burn** comes at 14:00: the effigy burns, overwrites run double and the Crystal turns every 40 seconds. If several camps still stand at **Dawn**, 30:00, the most dominant completes the Survey.',
    ),
    saint(
      'Your D.E.G.E.N. beacon talks to every Signifier on your mesh: rally, attack, Flag-here, and an SOS they raise themselves when hurt. "Use the SOS responsibly."',
    ),
    saint(
      'Your Command Center automatically recruits nearby neutral Signifiers, like a Drum Circle. Hand or throw a Flag to recruit a neutral yourself. The cart also converts rivals with **Flagellian Dialectics**, and plants **Flag Simulacra**: one Flag on two nodes at once, until an enemy looks.',
    ),
  ],
  briefingHighlights: ['clock', 'minimap'],
  objectives: [
    {
      id: 'ping',
      text: 'Ping the D.E.G.E.N. mesh: {key:P}',
      hint: 'P pings where your crosshair points: an enemy means Attack, a Ley Node means Flag-here, anything else Rally.',
      highlights: ['minimap'],
    },
    {
      id: 'gift',
      text: 'Go to your Command Center and recruit the lost Signifier',
      hint: 'Hand a Flag to the nearby neutral with E, throw one at them, or let the cart recruit them automatically.',
      highlights: ['gcc-panel', 'hand-flag'],
    },
    {
      id: 'saffron',
      text: 'Drink the Saffron tea I left on your shelf: {key:6}',
      hint: '6, 7 and 8 take Saffron, Luminous Dust and Acid Cop Vision when you have them. Drug Labs brew more.',
      highlights: ['drug-6'],
    },
  ],
  debrief: [
    saint('Every drug has its price. Saffron speeds your Signifiers for 40 seconds, then they crash, and some wander off overstimulated. Luminous Dust shows the whole lattice and lies to you; Acid Cop Vision shows every rival and makes your hippies paranoid.'),
    saint('"I moved a Flag and found myself moved." The Seal of Flagistan is whole.'),
  ],
  begin(ctx) {
    const { world, f } = ctx;
    const fac = world.factions[f];
    topUpStock(world, f, 4);
    let current = 0;
    let pinged = false;
    let gifted = false;
    let drank = false;
    let nextArrival = 0;
    let lost: Hippie | null = null;
    return {
      activate(i) {
        current = i;
        const gcc = world.gccOf(f);
        if (i === 1) {
          topUpStock(world, f, 2);
          if (gcc) ctx.mark([{ id: 'gcc', kind: 'entity', entity: gcc.id, label: 'Recruitment here' }]);
        } else if (i === 2) {
          ctx.mark([]);
          fac.drugs.saffron = Math.max(1, fac.drugs.saffron);
        }
      },
      tick() {
        if (current !== 1 || gifted) return;
        const gcc = world.gccOf(f);
        if (!gcc || avatarDistance(world, f, gcc.pos.x, gcc.pos.z) > GIFT_ARRIVE_RADIUS) return;
        // The lost Signifier waits idle beside the cart (lingering on the units' own wander clock),
        // put back on its spot if anything shoves it off; a new one comes if it is gone or taken.
        const toCentre = Math.atan2(-gcc.pos.z, -gcc.pos.x);
        const spot = world.nav.nearestWalkable(gcc.pos.x + Math.cos(toCentre) * GIFT_SPAWN_DISTANCE, gcc.pos.z + Math.sin(toCentre) * GIFT_SPAWN_DISTANCE);
        if (lost && world.hippies.get(lost.id) === lost && lost.faction === -1 && lost.koUntil <= world.time) {
          brainOf(lost).waitUntil = Infinity;
          if (Math.hypot(lost.pos.x - spot.x, lost.pos.z - spot.z) > GIFT_WAIT_SLACK) {
            lost.pos.x = spot.x;
            lost.pos.z = spot.z;
          }
          return;
        }
        if (world.time < nextArrival) return;
        // Reuse a member of the shared population instead of creating a tutorial-only recruit.
        lost = [...world.hippies.values()].find((h) => h.faction === -1 && h.status !== 'ko')
          ?? [...world.hippies.values()].find((h) => h.status !== 'ko') ?? null;
        if (!lost) return;
        neutralizeHippie(world, lost);
        lost.pos.x = spot.x;
        lost.pos.z = spot.z;
        lost.vel.x = 0;
        lost.vel.z = 0;
        topUpQuiver(world, f, 1);
        brainOf(lost).waitUntil = Infinity;
        nextArrival = world.time + GIFT_ARRIVAL_GAP;
        ctx.mark([
          { id: 'gcc', kind: 'entity', entity: gcc.id, label: 'Recruitment here' },
          { id: 'lost', kind: 'entity', entity: lost.id, label: 'Lost Signifier' },
        ]);
        ctx.say('A lost Signifier waits beside your cart. Aim at them and hand over a Flag ({key:E}), throw a Flag, or wait for the cart to recruit them. Extra recruits beyond capacity lose attention.');
      },
      event(e) {
        if (e.t === 'ping' && e.faction === f && current === 0) pinged = true;
        else if (e.t === 'recruited' && e.faction === f && (e.via === 'hand' || e.via === 'throw' || e.via === 'gcc' || e.via === 'drumcircle') && current === 1) gifted = true;
        else if (e.t === 'drugUsed' && e.faction === f && e.drug === 'saffron' && current === 2) drank = true;
      },
      progress(i) {
        if (i === 0) return pinged ? 1 : 0;
        if (i === 1) return gifted ? 1 : 0;
        return drank ? 1 : 0;
      },
    };
  },
};
