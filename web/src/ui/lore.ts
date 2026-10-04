/**
 * Player-facing lore text: title quotes, rival bios, the LIBER HH codex, end-screen
 * lines and tips. Pure data so screens stay layout-only. Every tuning number is interpolated
 * from sim/constants so the manual never contradicts the rules; the only literals left are
 * geometry facts (rhombus angles) and values private to a system (resonance +20%, the C.M.I.
 * formula, the TAKE A SHOT wobble).
 */
import {
  ABILITY,
  ALIGN_COST,
  ALIGN_RADIUS,
  ALIGN_TIME,
  AVATAR,
  BREW_COST,
  BREW_TIME,
  BUILD_TIME,
  BUILDINGS,
  BURN_TIME,
  CAPTURE,
  CRYSTAL_GROW_TIME,
  CRYSTAL_OBSERVE_RADIUS,
  CRYSTAL_PRESSURE_BONUS,
  CRYSTAL_PRESSURE_RADIUS,
  CRYSTAL_RITUAL_PER_SEC,
  DAWN_TIME,
  DAWN_WARNING,
  DISCHARGE_DAMAGE,
  DISCHARGE_STUN,
  DRUG,
  DRUG_MAX,
  DRUM_RITUAL_PER_SEC,
  DRUMMERS_PER_CIRCLE,
  GCC,
  HEARTH_FLAG_COST,
  HEARTH_FLAG_INTERVAL,
  HEARTH_OBSERVE_RADIUS,
  HIPPIE,
  HIPPIE_AI,
  HOARD_THRESHOLD,
  IMPLIED_MAX_ORDER,
  INSTABILITY_DECAY,
  INSTABILITY_DISCHARGE,
  INSTABILITY_RISE,
  INSTABILITY_SHIMMER,
  INSTABILITY_STORM,
  LEY_EDGE,
  MAX_BUILD_LEVEL,
  MESH_TAP_DURATION,
  OUTPOST_PRESSURE_MULT,
  PIECE,
  PROJECTILE,
  RECRUIT_INTERVAL,
  RECRUIT_RADIUS,
  RETRANSMIT_ATTENTION,
  RETRANSMIT_COOLDOWN,
  SUDDEN_DEATH_ESCALATE_EVERY,
  SUDDEN_DEATH_PRESSURE_MULT,
  TIDE_FRACTION,
  TIDE_INTERVAL,
  TIDE_INTERVAL_SUDDEN_DEATH,
  TIDE_WARNING,
  WARD_OBSERVE_RADIUS,
  WARD_PULSE_DAMAGE,
  WARD_PULSE_INTERVAL,
  WARD_PULSE_RADIUS,
  WARD_PULSE_STUN,
  WARD_RADIUS,
  WORKSHOP_FLAG_COST,
  WORKSHOP_FLAG_INTERVAL,
} from '../sim/constants';
import { EFFIGY_HEIGHT } from '../sim/map/mapgen';
import type { FactionId } from '../sim/types';
import { fmtClock } from './dom';

/** A fraction or multiplier excess as a whole percentage (0.6 → 60; 1.15 − 1 → 15). */
const pct = (fraction: number): number => Math.round(fraction * 100);
/** Pressure build rate while the owner holds a contained Hearth in person. */
const HOLD_PCT = pct(CAPTURE.contestedMult);
const BURN_CLOCK = fmtClock(BURN_TIME);
const DAWN_CLOCK = fmtClock(DAWN_TIME);
const CRYSTAL_BONUS_PCT = pct(CRYSTAL_PRESSURE_BONUS - 1);
const HOARD_PCT = pct(HIPPIE_AI.hoardDrainMult - 1);
const ESCALATE_MIN = SUDDEN_DEATH_ESCALATE_EVERY / 60;

export interface Quote {
  text: string;
  by?: string;
}

/** Title-screen rotation + codex Quotes tab. Bank lines are verbatim from the lore digest. */
export const QUOTES: readonly Quote[] = [
  { text: 'Flags are the end of Flags / And the beginning of 10 thousand Flags', by: 'the Vexillian Scriptures' },
  { text: 'One Flag is the same as two / And all our Flags are One', by: 'the Vexillian Scriptures' },
  { text: 'the man burns away but flag remains' },
  { text: 'I moved a Flag and found myself moved' },
  { text: 'I made a Flag and found that I had been made a Flag' },
  { text: "The Survey will be completed. Survey Flags must be surveyed, it's in their nature." },
  { text: 'Losing the flags is the first step to finding them.' },
  { text: 'I do not want this Flag… It is sticky.' },
  { text: 'A Flag upon a mountain top, higher than the peak.' },
  { text: 'Every statement about Flags is true if you think about it hard enough' },
  { text: "It's not about holding the Flag, it's about using the Flag to hold space" },
  { text: 'Flags are a gateless gate, the invitation to all Madness' },
  { text: 'The Flag Has a Pole, The Pole is a Line, The Line Has a Point' },
  { text: 'Here we see the tools of the Vexillomancer: the Flag and another Flag.' },
  { text: 'Flags appear to be the same size at any distance.', by: 'Canon IV' },
  { text: 'Yellow means there is no master left for you in this world.' },
  { text: 'In truth all Flags are perfectly square. The skew is in their eyes' },
  { text: 'Grasping the sun tightly makes it slip though your fingers' },
  { text: "They get the yellow fabric from a freakin' other dimension!" },
  { text: 'Numbers were just made up by guys who were angry at poets.', by: 'Canon V' },
  { text: 'A Flag arrives long after it was here, and departs long before it arrives.' },
  { text: 'Flags is the herpes of objects', by: 'Dr. Beelzebub Crow' },
  {
    text: 'By finding a Flag, you move from false to true. By moving a Flag, you find the truth in the false.',
  },
  { text: "Who's ready to ASCEND up in this bitch?… Excelsior!" },
  { text: 'The first step to learning advanced knowledge is to forget how to read.', by: 'Mega Harvard' },
  { text: "That's why it's advanced.", by: 'Mega Harvard' },
  { text: 'we cannot yet risk the instability of a fully enlightened society.', by: 'President Jaguar' },
  { text: 'there ought to be flags', by: 'the first vexillomancer' },
  { text: 'Under no conditions should you attempt to play a game that claims to be Flaghack.' },
  { text: "The Acid Cops have an open file on him. It's mostly question marks." },
  // Short direct lines from the digest's page notes.
  { text: 'every Flag had to be within line of sight of two other Flags', by: 'Canon III' },
  { text: 'Five Flags the minimum number.', by: 'Canon III' },
  { text: "The focus is on 'moving' Flags on their map, not 'collecting' them.", by: 'Canon III' },
  { text: "if you do nothing, you're on whichever side is the bad guys.", by: 'Canon II.7' },
  { text: 'the country created in the semiotic blast radius of the perfect configuration of Flags', by: 'on Flagistan' },
  { text: "Use the SOS responsibly! If you want to spam 'TAKE A SHOT', use the retransmit feature.", by: 'D.E.G.E.N. manual' },
  { text: "LoRa antenna unscrews easily. Don't MOOP it!", by: 'D.E.G.E.N. manual' },
  { text: 'A shot does not partly hit a target, it hits or it misses.', by: 'on Retrocausality' },
  { text: 'Proper casting involves placing the flags far enough apart that they cannot all be seen at once.' },
  { text: 'the cold is the lack of activity', by: 'on the fall of Tartaria' },
];

export interface RivalBio {
  /** Short epithet line, e.g. 'Abstractor of the Quintessence · Psywar Correspondent'. */
  epithet: string;
  /** 2-3 short paragraphs (each <= 320 chars) of bio from the digest, lore voice, wry. */
  bio: string[];
  /** One paragraph: how this rival plays in the game. */
  playstyle: string;
  quote: Quote;
}

export const RIVAL_BIOS: Record<FactionId, RivalBio> = {
  0: {
    epithet: 'Abstractor of the Quintessence · Psywar Correspondent',
    bio: [
      'Abstractor of the Quintessence at Mega Harvard. His face has never been seen: the signature balaclava stays on. He founded the Institute for Advanced Levels in 2014, Mega Harvard in 2016 and, with Crow, Mega Harvard LLC in 2034. His Nobels include a Nobel Prize in Nobel Prizes.',
      'He secretly controlled the Too Late Show and later TLN, one of the first hyperconspiracies: too complex ever to be proved or disproved. An enemy of the state and a top target of the Acid Police. Every investigator sent after him has gone insane, missing, or defected.',
      'He is suspected of being able to advance out of control. In 2017 he built the Geomantic Command Center to illustrate Flagistan to hopelessly lost and confused hippies. Tonight the hippies are yours.',
    ],
    playstyle:
      'You. Three quarters of the work is command: set Camp Priorities, plan the Survey from the Command Table, rally hippies with G and send them with H. The last quarter is your own staff and quiver: throw Flags into the hard nodes, pull the critical Flag of a closing enemy loop, plant on their implied nodes. All five chakras, all three drugs and every GCC action are yours, and the rivals answer to exactly the same rules.',
    quote: { text: "It's not about holding the Flag, it's about using the Flag to hold space" },
  },
  1: {
    epithet: 'Host of the Too Late Show · Mogul of TLN',
    bio: [
      'Host of the Too Late Show and mogul of TLN. His Psywar Research Corporation built the memetic weapons that prompted the Noospheric Munitions Act of 2042. Most of his file reads [Redacted].',
      'He has disappeared, and is wanted for high crimes against transhumanity over the GA-FL-AL Tri-State Water Wars. He is suspected to be hiding among the Vexillians, which would explain the crimson ribbons on so many yellow Flags.',
    ],
    playstyle:
      `The Surveyor. Crow expands early and keeps expanding, hunts Crystal Focus points for pentacles and leans hard on Phason Shift: expect your loop nodes to hop out from under your Flags at ${ABILITY.phason.range} m range. Canon III will not save you from a Shift; only a Stabilize Zone will. Break his pentacles by pulling one of the five, and watch his C.M.I. climb if you do not.`,
    quote: { text: 'Flags is the herpes of objects', by: 'Dr. Beelzebub Crow' },
  },
  2: {
    epithet: 'Sonic Weaponeer · Class III Memetic Event',
    bio: [
      'A sonic weaponeer. The Acid Cops classify his sets as Class III Memetic Events, capable of altering beliefs within a 40-meter radius. Nobody within 40 meters has ever filed a complaint, which the Acid Cops find suspicious.',
      'He worked his way bottom up, in the dirt, in the crowd, and still runs rogue sets at unlicensed burns. The Acid Cops have an open file on him. It is mostly question marks.',
    ],
    playstyle:
      `The Raider. Scarecrow comes early and comes fast: Saffron-dosed hippies under Forced March sprint for the critical Flags of your loops, pull them and steal them home. Wall off your loop Flags, keep some hippies on Defend so SOS pings get answered, and let a Hearth Ward vibe-check his raiders. Survive the rush and his Saffron crash leaves his camp at −${pct(DRUG.crashMag)}% speed for ${DRUG.crashTime} s.`,
    quote: { text: "The Acid Cops have an open file on him. It's mostly question marks." },
  },
  3: {
    epithet: 'Re-elected Forever · Avatar of Lord Egregore',
    bio: [
      'A former Too Late Show contributor who became its arch nemesis and an informant for the PPF, fortified with Mega Harvard intelligence-enhancing drugs. Elected in 2040, he will continue to be elected every 4 years until the heat death of the universe. He wears a robe of royal purple.',
      'Thought to be the avatar of Lord Egregore, he banned enlightening memes under the Noospheric Munitions Act, then exempted the Flags, allegedly for a bribe in pricecoin. Not even the President can untangle a hyperconspiracy.',
      'From 2760 he and his schismmancers hoard Flags until, in 3296, they reach the inflagtion point and fracture the Time Crystal: the Great Chronoschism. Tonight he is merely practising.',
    ],
    playstyle:
      'The Warden. Jaguar builds Tarp Walls and Hearth Wards, hoards Flags in his Hearth, and doses Acid Cop Vision to read your planned nodes through walls. He is slow to start and then closes a huge enclosure late, often as The Burn approaches. Strike before the Wards go up; a Phason Shift does not care how many walls surround a loop node, and his hoard costs his hippies attention.',
    quote: { text: 'we cannot yet risk the instability of a fully enlightened society.', by: 'President Jaguar' },
  },
};

export type CodexBlock =
  | { kind: 'h'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'quote'; text: string; by?: string }
  | { kind: 'canon'; title: string; text: string };

/** LIBER HH, tab 'How to Survey'. */
export const CODEX_SURVEY: readonly CodexBlock[] = [
  { kind: 'quote', text: 'Here we see the tools of the Vexillomancer: the Flag and another Flag.' },
  {
    kind: 'p',
    text: 'Every territory on this burn is made of Flags standing on Ley Nodes. Walls protect Flags, hippies carry them, buildings feed them, but nothing else encloses a single facet. Flags are always yellow; only the ribbon at the finial and the colour of the ley light say whose they are.',
  },
  { kind: 'h', text: 'The Quiver' },
  {
    kind: 'list',
    items: [
      `**Quiver**: you carry ${AVATAR.quiver} Flags. Stand within ${AVATAR.restockRadius} m of your Hearth and the quiver refills from camp stock.`,
      `**Hand Flag** (E while aiming at a nearby neutral): give one carried Flag to recruit that Signifier.`,
      `**Plant** (E): a ${AVATAR.plantTime} s tap on a free node within ${AVATAR.plantReach} m.`,
      `**Throw** (Q, or hold RMB to aim and click LMB): a flick at ${AVATAR.throwSpeed} m/s, ${AVATAR.throwCooldown} s cooldown. The Flag auto-plants on the nearest free node within ${AVATAR.throwSnapRadius} m of impact; otherwise it lies loose. A direct hit recruits a neutral hippie, who keeps the Flag; enemy hippies take damage and a ${PROJECTILE.hippieStun} s stun.`,
      `**Pull** (hold E): your own Flag in ${AVATAR.pullOwnTime} s, an enemy or neutral Flag in a ${AVATAR.pullEnemyTime} s channel. Pulled Flags go to your quiver if there is room, else they drop loose.`,
      `**Staff** (LMB with the Flag tool): a swing for ${AVATAR.swingDamage} damage to units and ${AVATAR.swingPieceDamage} to pieces; at a pile it chops ${AVATAR.swingLumber} lumber. The staff never plants.`,
      `**Flagless**: at 0 HP you drop every carried Flag loose and return to your Hearth after ${AVATAR.respawnTime} s.`,
    ],
  },
  { kind: 'h', text: 'Ley Nodes and Ley Lines' },
  {
    kind: 'p',
    text: `Beneath the grass lies the Ley Lattice: **Ley Nodes** joined by edges ${LEY_EDGE} m long. One Flag per node; nodes inside tents, domes and trees are blocked. An edge becomes a **Ley Line** only when both of its nodes are held by the same camp, and then it glows in that camp's colour.`,
  },
  { kind: 'h', text: 'Implied Flags' },
  {
    kind: 'p',
    text: `When two of your nodes have a free node at their **exact** midpoint, that node holds an **implied Flag** of yours. Implied Flags imply further Flags, up to order ${IMPLIED_MAX_ORDER}. They count for Ley Lines, facets, pentacles and enclosure, they cannot be pulled, and they vanish the moment a parent goes.`,
  },
  {
    kind: 'p',
    text: 'A real Flag of any camp planted on the node overrides the implication. Planting your own Flag on a rival\'s implied node is the politest way to delete it.',
  },
  {
    kind: 'canon',
    title: 'Flagistan',
    text: 'The midpoint between two Flags is an implied Flag. Midpoints between implied Flags give second-order implied Flags, and so on. At the center is an infinite-order implied Flag, also known as a crystal.',
  },
  { kind: 'h', text: 'The Survey' },
  {
    kind: 'p',
    text: 'A facet whose four nodes are all yours is **crystallized**. Your **Survey** is every facet that cannot reach the edge of the map without crossing one of your Ley Lines. Close a loop and everything inside it is surveyed. Crystallized facets always are.',
  },
  {
    kind: 'p',
    text: 'Where two Surveys overlap, the facet gathers **instability**: shimmer, Flag Psychosis, Crystal discharges and finally phason storms (see The Crystal). Once it shimmers, the camp holding most of its corners **resonates** and works 20% faster there; everyone else inside falls into Flag Psychosis.',
  },
  { kind: 'h', text: 'Overwriting a Hearth' },
  {
    kind: 'table',
    head: ['Stage', 'Condition'],
    rows: [
      ['**Safe**', `No enemy Survey facet or enemy Ley Line within ${CAPTURE.threatRadius} m.`],
      ['**Threatened**', `An enemy Survey facet or enemy Ley Line within ${CAPTURE.threatRadius} m.`],
      ['**Contained**', 'An enemy Survey encloses the Hearth. Pressure builds toward the overwrite.'],
      ['**Contested**', `Contained, but the owner's vexillomancer stands within ${CAPTURE.holdRadius} m (not Flagless) to **Hold the Hearth** in person: pressure builds at ${HOLD_PCT}%.`],
      ['**Overwritten**', `Pressure reached 100. A ${CAPTURE.overwriteTime} s overwrite begins and cannot be stopped.`],
      ['**Captured**', 'The Hearth belongs to the captor.'],
    ],
  },
  {
    kind: 'p',
    text: `Each attacker builds **pressure** from 0 to 100 at a base ${CAPTURE.baseRate} per second, about ${Math.round(100 / CAPTURE.baseRate)} s. When the Hearth is no longer contained, pressure decays ${CAPTURE.decay} per second. With several attackers, the highest pressure leads the overwrite.`,
  },
  {
    kind: 'table',
    head: ['Modifier', 'Pressure'],
    rows: [
      ['Held in person (Contested)', `×${CAPTURE.contestedMult}`],
      [`Each defending hippie within ${CAPTURE.defenderRadius} m`, `×${CAPTURE.defenderMult}, never below ×${CAPTURE.defenderFloor} in total`],
      [`The owner's Hearth Ward within ${WARD_RADIUS} m (one counts)`, `×${CAPTURE.wardMult}`],
      [`Each attacker Crystal within ${CRYSTAL_PRESSURE_RADIUS} m`, `×${CRYSTAL_PRESSURE_BONUS}`],
      ['A captured outpost (held by anyone but its founder)', `×${OUTPOST_PRESSURE_MULT}`],
      ['The Burn', `×${SUDDEN_DEATH_PRESSURE_MULT}, then +1 every ${ESCALATE_MIN} minutes`],
    ],
  },
  {
    kind: 'list',
    items: [
      'On capture the Hearth becomes the captor\'s **outpost Hearth**.',
      'The loser\'s buildings become the captor\'s, disabled until repaired.',
      'Their planted Flags turn neutral, pullable by anyone.',
      'Their hippies turn neutral. Their GCC is destroyed.',
    ],
  },
  {
    kind: 'p',
    text: 'A camp with no Hearth is eliminated. The last vexillomancer with a Hearth wins, unless the night runs out first: then **Dawn** crowns the dominant camp (below).',
  },
  { kind: 'h', text: 'The Burn' },
  {
    kind: 'p',
    text: `At **${BURN_CLOCK}** the Flag effigy on the Omega Node burns. Sudden death: containment pressure ×${SUDDEN_DEATH_PRESSURE_MULT}, rising by one every ${ESCALATE_MIN} minutes the Burn rages (the clock shows the current ×N), and Phason Tides every ${TIDE_INTERVAL_SUDDEN_DEATH} s. A Crystal on the Omega Node burns with the effigy: its bonus doubles to +${pct(2 * (CRYSTAL_PRESSURE_BONUS - 1))}% and reaches every Hearth on the burn.`,
  },
  { kind: 'h', text: 'Dawn' },
  {
    kind: 'p',
    text: `The Burn rages through the night, ${(DAWN_TIME - BURN_TIME) / 60} minutes of it. If more than one camp still stands at **${DAWN_CLOCK}**, dawn breaks over the burn and the Survey is completed by the **dominant** camp. No one else is eliminated; their Surveys simply stand second. Dominance is judged in order:`,
  },
  {
    kind: 'list',
    items: [
      'the most **Hearths** held, captured outposts included;',
      'then the largest **Survey**: the facets enclosed at that moment, not your best ever;',
      'then the highest **C.M.I.**',
    ],
  },
  {
    kind: 'p',
    text: `From The Burn on, the clock counts down to dawn, and everyone is warned ${DAWN_WARNING} s before it breaks. An outpost captured in the last minute counts in full; so does a loop closed in the last second.`,
  },
  { kind: 'h', text: 'Counterplay' },
  {
    kind: 'list',
    items: [
      '**Pull a loop Flag**: any one breaks the enclosure. The HUD marks the loop\'s **critical Flags**.',
      '**Phason Shift** a loop node out from under its Flag.',
      '**Plant on their implied node**: a real Flag overrides the implication.',
      '**Wall off** your own loop Flags with Tarp Walls.',
      `**Hold the Hearth**: stand within ${CAPTURE.holdRadius} m of your contained Hearth and pressure builds at ${HOLD_PCT}% while you are there.`,
      '**Ward**, **Stabilize**, and **Dialectics** their defenders into your camp.',
    ],
  },
  {
    kind: 'canon',
    title: 'Canon II.7',
    text: "Expand the Flag radius or contract it, fighting the obvious moop invasion. If you do nothing, you're on whichever side is the bad guys.",
  },
];

/** LIBER HH, tab 'The Crystal'. */
export const CODEX_CRYSTAL: readonly CodexBlock[] = [
  {
    kind: 'p',
    text: 'The Ley Lattice is no metaphor. It is a genuine **Penrose rhombus tiling**, cast by de Bruijn\'s pentagrid: five families of parallel lines, one per Flag chakra, and every crossing of two lines becomes one rhombus. Its quasicrystal behaviour is the whole of vexillomancy.',
  },
  { kind: 'h', text: 'Sun and Moon Facets' },
  {
    kind: 'list',
    items: [
      '**Sun facets**: thick rhombi, 72° and 108°.',
      '**Moon facets**: thin rhombi, 36° and 144°.',
      'Across the burn, Sun facets outnumber Moon facets by a ratio that tends to **φ**, the golden ratio.',
      'Every node carries an integer **5D Ley coordinate** k ∈ Z⁵, a position on the ground and a hidden position in **perpendicular space**.',
    ],
  },
  {
    kind: 'p',
    text: `The lattice is centred on the **Omega Node**, a 5-fold star where five Sun facets meet at their points. The Flag effigy stands on it, ${EFFIGY_HEIGHT} m of wood waiting for The Burn.`,
  },
  { kind: 'h', text: 'Phason Flips' },
  {
    kind: 'p',
    text: 'The Crystal turns. In a **phason flip** a node with three neighbours hops across its hexagon, from v to v + e1 + e2 + e3, and the three facets around it re-tile. Any Flag on that node **decoheres**: it falls loose at its old spot and its Ley Lines snap.',
  },
  {
    kind: 'p',
    text: `Every ${TIDE_INTERVAL} s a **Phason Tide** sweeps the burn as a wave and turns about ${pct(TIDE_FRACTION)}% of the flippable nodes, after a ${TIDE_WARNING} s warning: "The Crystal is turning…". Tides favour nodes under high **perpendicular strain**, so the lattice heals itself back toward perfect Penrose order. After The Burn the tides come every ${TIDE_INTERVAL_SUDDEN_DEATH} s.`,
  },
  { kind: 'h', text: 'Observation Freezes the Crystal' },
  {
    kind: 'canon',
    title: 'Canon III',
    text: 'every Flag had to be within line of sight of two other Flags… Five Flags the minimum number.',
  },
  {
    kind: 'p',
    text: 'A watched Crystal never turns. Tides skip any node whose Flag is **observed** by its owner. A node is observed by your camp when it is:',
  },
  {
    kind: 'list',
    items: [
      'held by a Flag with Ley Lines to **two or more** other Flags (Canon III: the Flag observes itself);',
      `within ${AVATAR.observeRadius} m of you, the vexillomancer;`,
      `within ${GCC.adviceRadius} m of your Geomantic Command Center;`,
      `within ${HEARTH_OBSERVE_RADIUS} m of your Hearth;`,
      `within ${WARD_OBSERVE_RADIUS} m of one of your Hearth Wards;`,
      'inside one of your Stabilize Zones.',
    ],
  },
  {
    kind: 'p',
    text: 'Empty nodes flip freely. A completed loop is tide-proof; a dangling, half-built pattern is not. **Finish your casting.**',
  },
  {
    kind: 'p',
    text: `**Phason Shift**, the Field chakra, flips a node on purpose at up to ${ABILITY.phason.range} m. It ignores Canon III. Only a Stabilize Zone blocks it, which makes it the precision answer to a finished loop.`,
  },
  { kind: 'h', text: 'Focus Points and Pentacles' },
  {
    kind: 'p',
    text: `Every 5-fold star vertex is a **Crystal Focus**. Focus points are invisible, and they appear and vanish as phasons flip. Geomantic Advice reveals them within ${GCC.adviceRadius} m of your GCC; Luminous Dust reveals them all.`,
  },
  {
    kind: 'p',
    text: `Hold all five neighbours of a focus, the canonical five Flags, and you have a **pentacle**. Within ${CRYSTAL_GROW_TIME} s a **Crystal** manifests on the focus:`,
  },
  {
    kind: 'list',
    items: [
      `+${CRYSTAL_RITUAL_PER_SEC} Ritual per second for its owner;`,
      `+${CRYSTAL_BONUS_PCT}% containment pressure on enemy Hearths within ${CRYSTAL_PRESSURE_RADIUS} m;`,
      `observes every node within ${CRYSTAL_OBSERVE_RADIUS} m;`,
      'adds to your **C.M.I.**',
    ],
  },
  {
    kind: 'p',
    text: 'A Crystal shatters when its pentacle breaks or its focus node flips. Pull one of the five and it is gone.',
  },
  { kind: 'h', text: 'Flag Simulacra' },
  {
    kind: 'p',
    text: `The GCC can plant one Flag on **two nodes at once**. The superposed Flag counts as real on both, until an enemy unit comes within ${GCC.simulacraObserveRadius} m of either: then it collapses, 50/50, onto one node and the other vanishes with a glitch.`,
  },
  {
    kind: 'quote',
    text: 'Proper casting involves placing the flags far enough apart that they cannot all be seen at once.',
  },
  { kind: 'h', text: 'Interference' },
  {
    kind: 'p',
    text: `A facet inside two or more Surveys gathers instability from 0 to 1 at +${INSTABILITY_RISE} per second, and sheds it at ${INSTABILITY_DECAY} per second once the overlap ends.`,
  },
  {
    kind: 'table',
    head: ['Instability', 'Effect'],
    rows: [
      [`≥ ${INSTABILITY_SHIMMER}`, `Shimmer and moiré. **Flag Psychosis**: hippies inside lose attention ${HIPPIE_AI.psychosisDrainMult}× as fast, unless their camp holds most of the facet's corners.`],
      [`≥ ${INSTABILITY_DISCHARGE}`, `**Crystal discharge**: lightning every few seconds, stunning units ${DISCHARGE_STUN} s and dealing ${DISCHARGE_DAMAGE} damage to pieces and buildings.`],
      [`≥ ${INSTABILITY_STORM}`, '**Phason storms**: unobserved nodes flip on their own.'],
    ],
  },
  {
    kind: 'p',
    text: 'In a shimmering overlap, the camp holding most of a facet\'s corners **resonates** instead: its hippies work 20% faster there.',
  },
  { kind: 'h', text: 'C.M.I.' },
  {
    kind: 'p',
    text: 'The **Crystal Manifestation Index** is the old 2017 score, kept on the brass counter at bottom right. For each Crystal you own it adds 100 plus 10 for every 10 seconds the Crystal has lived, and 1 more for every facet of your Survey. It is a measure, not a currency: nothing is bought with it, and it never wins a game by itself.',
  },
  { kind: 'quote', text: 'One Flag is the same as two / And all our Flags are One', by: 'the Vexillian Scriptures' },
];

/** LIBER HH, tab 'Camp'. */
export const CODEX_CAMP: readonly CodexBlock[] = [
  { kind: 'h', text: 'Signifiers' },
  {
    kind: 'p',
    text: `Your hippies, the **Signifiers**, do most of the work of the Survey. Each runs at ${HIPPIE.speed} m/s, has ${HIPPIE.maxHp} vibes, carries one Flag or ${HIPPIE.gatherAmount} lumber, and has **attention** from 0 to 100.`,
  },
  {
    kind: 'p',
    text: `Attention drains ${HIPPIE.attentionDrain} per second while working, ${HIPPIE.attentionDrain * HIPPIE_AI.psychosisDrainMult} per second in Flag Psychosis. At 0 a hippie is distracted and wanders to the nearest sound camp for ${HIPPIE.distractedTime} s, returning at ${HIPPIE.distractedRecoverTo}. Idle hippies recover ${HIPPIE.attentionRecover} per second near your Hearth or a Drum Circle. Hippies share a fixed world population. At 0 vibes they drop what they carry and respawn neutral after ${HIPPIE.respawnTime} s. Camps can recruit beyond their attention capacity; the newest excess recruits lose an additional ${HIPPIE.overCapAttentionDrain} attention/s, even when idle, and cannot recover by resting at home. They take normal distraction breaks at 0 attention.`,
  },
  { kind: 'h', text: 'Jobs and Orders' },
  {
    kind: 'list',
    items: [
      '**Survey**: fetch a Flag and plant it on the nearest planned node.',
      '**Gather**: chop a lumber pile, haul it home.',
      '**Defend**: guard the Hearth, answer SOS, shove intruders, pull enemy Flags inside your Survey.',
      '**Raid**: pull the enemy Flags that threaten your Hearth first, else those on the nearest enemy Survey boundary, and steal them home.',
      '**Ritual**: drum at a Drum Circle.',
    ],
  },
  {
    kind: 'p',
    text: `Set each job from 0 to 4 in **Camp Priorities**; idle hippies divide themselves by those weights. From the Command View, select hippies and right click to give direct orders. On foot, **G** rallies every hippie within ${HIPPIE_AI.rallyRadius} m to follow you and **H** sends your followers at the crosshair.`,
  },
  {
    kind: 'canon',
    title: 'Hoarding Is Villainy',
    text: `Hoarding Flags caused the fall of Tartaria. Keep more than ${HOARD_THRESHOLD} Flags in your Hearth stock and your hippies' attention drains ${HOARD_PCT}% faster, for the cold is the lack of activity.`,
  },
  { kind: 'h', text: 'Buildings' },
  {
    kind: 'p',
    text: `Camp buildings snap to the centre of a Sun facet **inside your own Survey** and complete in ${BUILD_TIME} s, faster with a hippie helping. At 0 HP they are disabled until hippies repair them.`,
  },
  {
    kind: 'table',
    head: ['Building', 'Lumber', 'Effect'],
    rows: [
      ['**Flag Hearth**', '—', `${BUILDINGS.hearth.hp} HP. Crafts 1 Flag every ${HEARTH_FLAG_INTERVAL} s for ${HEARTH_FLAG_COST} lumber and keeps your stock. Cannot be destroyed, only overwritten.`],
      ['**Flag Workshop**', `${BUILDINGS.workshop.cost}`, `+1 Flag every ${WORKSHOP_FLAG_INTERVAL} s for ${WORKSHOP_FLAG_COST} lumber.`],
      [
        '**Drum Circle**',
        `${BUILDINGS.drumcircle.cost}`,
        `Automatically recruits one existing neutral within ${RECRUIT_RADIUS} m every ${RECRUIT_INTERVAL} s, with no Flag or lumber cost. +${HIPPIE.popCapPerDrumCircle} attention capacity. Up to ${DRUMMERS_PER_CIRCLE} drummers, +${DRUM_RITUAL_PER_SEC} Ritual/s each.`,
      ],
      [
        '**Hearth Ward**',
        `${BUILDINGS.ward.cost}`,
        `−${pct(1 - CAPTURE.wardMult)}% enemy pressure on your Hearths within ${WARD_RADIUS} m. Observes ${WARD_OBSERVE_RADIUS} m. Vibe-check pulse every ${WARD_PULSE_INTERVAL} s: enemy hippies within ${WARD_PULSE_RADIUS} m stunned ${WARD_PULSE_STUN} s, ${WARD_PULSE_DAMAGE} damage.`,
      ],
      ['**Drug Lab**', `${BUILDINGS.druglab.cost}`, `Brews one dose every ${BREW_TIME} s for ${BREW_COST} lumber, up to ${DRUG_MAX} of each drug.`],
    ],
  },
  { kind: 'h', text: 'Pieces' },
  {
    kind: 'p',
    text: `Pieces cost ${PIECE.cost} lumber, pop in instantly and have ${PIECE.hp} HP: **Z** Tarp Wall on a Ley edge, **X** Deck on a facet, **C** Ramp up one level, **V** Demolish your own piece for a ${PIECE.refund} lumber refund. Levels run 0 to ${MAX_BUILD_LEVEL}; anything above ground needs support from the level below.`,
  },
  { kind: 'h', text: 'The Geomantic Command Center' },
  {
    kind: 'p',
    text: `A black pentagonal cart with Flag-spoked wheels and a tabletop map of the burn. Use the **Command Table** to dive into the Command View. Hold E at the cart to push it at ${GCC.pushSpeed} m/s. If it collapses it is rebuilt at your Hearth after ${GCC.rebuildTime} s.`,
  },
  {
    kind: 'list',
    items: [
      `**Geomantic Advice**: reveals the lattice and focus points within ${GCC.adviceRadius} m and observes those nodes.`,
      `**Flag Repair**: every ${GCC.repairInterval} s re-plants one loose Flag of yours within ${GCC.repairRadius} m and mends your pieces and buildings there.`,
      `**Recruitment**: like a Drum Circle, automatically recruits one existing neutral within ${RECRUIT_RADIUS} m every ${RECRUIT_INTERVAL} s, without a Flag or lumber cost.`,
      `**Flagellian Dialectics** (${GCC.dialecticsCooldown} s cooldown, ${GCC.dialecticsChannel} s channel at the cart): converts up to ${GCC.dialecticsMax} enemy hippies within ${GCC.dialecticsRadius} m.`,
      `**Flag Simulacra** (${GCC.simulacraCooldown} s cooldown): one Flag on two nodes at once.`,
    ],
  },
  { kind: 'h', text: 'Drugs' },
  {
    kind: 'table',
    head: ['Drug', 'Effect', 'Risk'],
    rows: [
      [
        '**Saffron** (Vexillicrocus tea)',
        `${DRUG.duration.saffron} s: every hippie +${pct(DRUG.saffronMag)}% work and move speed; +${DRUG.saffronRitualPerSec} Ritual/s.`,
        `${DRUG.crashTime} s crash at −${pct(DRUG.crashMag)}% speed; each hippie has a ${pct(DRUG.overstimChance)}% chance to wander off overstimulated.`,
      ],
      [
        '**Luminous Dust**',
        `${DRUG.duration.dust} s: the whole lattice, focus points, strain and enemy simulacra revealed; your throws snap within ${AVATAR.throwSnapRadiusDust} m.`,
        `Screen distortion, minimap noise, and ${DRUG.falseFlagsMin}–${DRUG.falseFlagsMax} hallucinated False Flags.`,
      ],
      [
        '**Acid Cop Vision**',
        `${DRUG.duration.acidcop} s: every rival's hippies, tasks, planned nodes and avatar, through walls.`,
        `Paranoia: attention drains ×${HIPPIE_AI.paranoiaDrainMult}; phantom pursuers on your minimap.`,
      ],
    ],
  },
  { kind: 'h', text: 'The D.E.G.E.N. Mesh' },
  {
    kind: 'p',
    text: 'Every hippie carries a **D.E.G.E.N. Beacon**, the Distributed Entity Geolocation and Entity Navigator. Your mesh shows each hippie\'s position and status on the minimap, the Command View and the roster. Rival meshes stay dark.',
  },
  {
    kind: 'list',
    items: [
      '**Pings**: Rally, Attack, Flag-here and SOS (P or middle mouse).',
      `**SOS**: a hurt hippie pings on its own; Defend hippies within ${HIPPIE.sosRespondRadius} m respond.`,
      `**Retransmit: TAKE A SHOT** (${RETRANSMIT_COOLDOWN} s cooldown): every hippie on your mesh gains ${RETRANSMIT_ATTENTION} attention and wobbles for 2 s.`,
      `**MOOP**: a knocked-out enemy may drop its beacon. Pick it up to tap that camp's mesh for ${MESH_TAP_DURATION} s.`,
    ],
  },
  {
    kind: 'quote',
    text: "Use the SOS responsibly! If you want to spam 'TAKE A SHOT', use the retransmit feature.",
    by: 'D.E.G.E.N. manual',
  },
  { kind: 'h', text: 'Chakras' },
  {
    kind: 'p',
    text: `Five **Flag chakras**, one per Ley direction, named for the anatomy of a Flag: **Hoist** (Priority Beacon), **Fly** (Forced March), **Canton** (Stabilize Zone), **Field** (Phason Shift) and **Finial** (Omega Pulse). Align them with Ritual within ${ALIGN_RADIUS} m of your Hearth in a ${ALIGN_TIME} s channel: ${ALIGN_COST[0]}, ${ALIGN_COST[1]} and ${ALIGN_COST[2]} Ritual for levels 1, 2 and 3. Ritual comes from drumming, Crystals and Saffron, never from the size of your Survey.`,
  },
];

/** End-screen flavour lines; screen title is 'FLAGISTAN APPROACHES'. */
export const VICTORY_LINES: readonly string[] = [
  'The last Hearth on the burn crafts Flags in your colour.',
  'Every Ley Line hums one chord. Beyond the perceptual horizon, Flagistan draws one facet nearer.',
  'Losing the flags was the first step to finding them. You found all of them.',
  'The Survey will be completed. Tonight it was completed by you.',
];

/** End-screen flavour lines; screen title is 'YOUR SURVEY HAS BEEN OVERWRITTEN'. */
export const DEFEAT_LINES: readonly string[] = [
  'Your Hearth now crafts Flags for someone else.',
  'Your hippies wander the burn, neutral and unbeaconed, in search of a sound camp.',
  'The man burns away but flag remains. The Flags were never yours; they were only resting.',
];

/** One-sentence gameplay tips in lore voice. */
export const TIPS: readonly string[] = [
  'Pull any one Flag of a closing loop and the whole enclosure falls; the HUD marks the critical ones.',
  'A Flag with Ley Lines to two others observes itself, so a finished loop shrugs off the Phason Tide.',
  'Phason Shift ignores Canon III; only a Stabilize Zone keeps a node from hopping.',
  'Plant a real Flag on a rival\'s implied node and the implication evaporates.',
  `Your quiver refills from Hearth stock whenever you stand within ${AVATAR.restockRadius} m of the Hearth.`,
  `A thrown Flag plants itself on the nearest free node within ${AVATAR.throwSnapRadius} m of where it lands.`,
  `Keep more than ${HOARD_THRESHOLD} Flags in your Hearth and your hippies' attention drains ${HOARD_PCT}% faster: hoarding is villainy.`,
  `Break the loop and the siege unwinds: pressure on a Hearth that is no longer contained decays ${CAPTURE.decay} per second.`,
  `Every defending hippie within ${CAPTURE.defenderRadius} m of a Hearth slows the overwrite, down to ×${CAPTURE.defenderFloor} speed.`,
  `A Crystal adds ${CRYSTAL_BONUS_PCT}% containment pressure to every enemy Hearth within ${CRYSTAL_PRESSURE_RADIUS} m.`,
  'Five Flags around a hidden Crystal Focus make a pentacle; Geomantic Advice and Luminous Dust show where.',
  `Stand within ${CAPTURE.holdRadius} m of your contained Hearth to Hold it in person: pressure builds at ${HOLD_PCT}% while you are there.`,
  `At ${BURN_CLOCK} the Flag burns: pressure ×${SUDDEN_DEATH_PRESSURE_MULT}, burning hotter every ${ESCALATE_MIN} minutes, and the Crystal turns every ${TIDE_INTERVAL_SUDDEN_DEATH} s.`,
  `If several camps still stand at ${DAWN_CLOCK}, dawn crowns the one with the most Hearths, then the largest Survey, then the highest C.M.I.`,
  'Saffron is fast and the crash is faster; dose before the push, not during the defence.',
  `Answer SOS pings: Defend hippies within ${HIPPIE.sosRespondRadius} m come running, and so should you.`,
  `Retransmit TAKE A SHOT when attention runs low; it gives every hippie ${RETRANSMIT_ATTENTION} more.`,
  `An enemy beacon dropped in the dirt taps their mesh for ${MESH_TAP_DURATION} s. MOOP responsibly.`,
  `Overlapping Surveys grow unstable; above ${INSTABILITY_DISCHARGE} the Crystal discharges lightning on everyone inside.`,
];
