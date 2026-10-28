# Fork iteration: configurable matches and controls

## Match setup

Begin the Survey opens the lobby for local games; joining a host opens the multiplayer lobby. Each of the four player seats has an On/Off toggle, and the number of days is selected in the lobby. At least one seat remains on. Offline, choose any enabled character with Play this character; other enabled seats use AI. Turning off the selected local seat moves you to another enabled seat. Disabled seats show a neutral numbered placeholder and have no avatar, Hearth, GCC, starting stock or Signifiers in the match. They also stay out of the Hearth rail, standings and end-of-match statistics. Their camp scenery remains part of the map.

In multiplayer, the leader controls match setup. A human must leave a seat before its camp can be disabled. New arrivals take only enabled seats; other arrivals spectate. Match settings travel with the authoritative world options so clients generate the same lattice. The network protocol is version 18; all players must use the same build.

Choose 0–5 days or Unlimited. A day means one complete daylight/night cycle. Default: 1 day at 600 seconds, with the Burn at 4:40 and Dawn deadline at 10:00. Explicit saved day lengths are preserved. With multiple days, the Burn occurs at the same point in the **last** cycle. The sky repeats each cycle. Zero days begins at ignition, with the Burn sky and simulation time 0:00; the boss still reveals 90 seconds later. With boss mode off, zero days retains the full remaining Burn night before Dawn (5 minutes 20 seconds at the default day length, or 160 seconds with a 300-second day). Conquest can finish a competitive match earlier; a single-camp creative/solo match finishes only at its time limit. Unlimited remains a separate choice with no time limit or scheduled Burn; competitive conquest still works. Previously saved Unlimited choices are migrated without changing their meaning.

Advanced Game Settings opens a separate window with a scrolling body, a fixed header and footer, and Done, close, Escape and backdrop dismissal. It contains the number of days, rival difficulty, random or fixed world seed, and all configurable match parameters below. Reset defaults preserves the lobby's player-seat selection. Online guests can inspect the settings; only the leader can edit them before the match. Advanced settings are bounded and applied at match creation:

| Setting | Range | Default |
| --- | --- | --- |
| Full day length | 300–7,200 seconds | 600 |
| Boss HP | 100–1,000,000 whole HP (100-HP spinner steps) | 50,000 |
| Lattice edge spacing | 6–12 metres | 8 |
| Starting lumber | 0–1,000 | 150 |
| Stock Flags per Hearth | 0–100 | 14 |
| Flag hoarding threshold | 0–1,000 | 24 |
| Starting Signifiers per camp | 0–12, limited to an equal share of the world population | 6 |
| Jump height multiplier | 0.1–5.0 | 1.0 (original height) |
| Maximum Signifiers (whole world) | 0–200 | 40 |
| Structures block flag placement | Off / On | Off |

Home-loop Flags and the avatar's six carried Flags are unchanged by stock tuning. Lore/help text that describes the original rules retains the original default values; the live clock uses the chosen match settings.

Jump height defaults to 3.0 and scales the jump apex (3.0 is three times the original height) for both authoritative movement and client prediction. Structure blocking reserves the corner nodes of standing camp buildings when enabled. Terrain, occupied nodes and crystals always prevent placement.

## Flag stock and hoarding

Each completed, working Workshop adds 10 to the camp's configurable hoarding threshold.
A Workshop holds up to 10 ordinary stock Flags, available for pickup. When it is full,
production continues and its excess Flags go to the nearest owned altar. Altars retain their
existing unlimited storage and the default starting stock of 14. The hoarding threshold is
still a soft attention-drain penalty, not a hard inventory cap.

Throwing a Flag directly into your completed altar or Workshop deposits that same Flag.
A full Workshop sends thrown deposits to the nearest owned altar too. Walls and other first
hits still intercept the throw; enemy combat and neutral recruitment keep their normal rules.
Capture transfers the ownership of stored Flags, and destruction cleans up or drops stock
through the normal building/Flag lifecycle.

## Original scaffold burn with an exposed burning Flag and pole

The original scaffold fire, 55-second timber charring, crown-first 85–140-second nominal
lattice dissolve and lasting smoulder are preserved. The scaffold does not scale down,
and this variant adds no crater. Match scheduling and victory rules remain unchanged.

- At 20 seconds after ignition, the five guy/support wires and their pennants break loose
  and fall from rest with the game's existing gravity of 24 world-units/s². Their displacement
  follows ½gt², landing within about 1.24 seconds on the meadow or original plinth. Only then
  do the grounded remnants burn away; all are gone by 30 seconds. Ground anchors remain.
- Until 90 seconds, the top Flag and pole retain their original appearance and heat glow.
- At 90 seconds, the Flag, mast, straps and gold finial turn white-hot together. One group
  scales them equally in X, Y and Z about the plinth top, keeping the cloth attached to the
  pole. The rest of the scaffold and the plinth remain at their original size.
- Shrink starts gently, then accelerates, with a clearance guard against the original
  scaffold's remaining burning-height envelope. That envelope includes the original shader's
  maximum +17-second texture jitter and +11-second cell jitter, so burning fragments can
  persist until 168 seconds. The cloth's hoist stays above that conservative envelope rather
  than being pulled inside the scaffold; original permanent low stumps are excluded.
- Flag and pole share one set of colour/emission uniforms: white at 90 seconds, yellow at
  116, red at 142, black with no emission at 168, and fully consumed at 176. The longer visible
  descent does not alter the scaffold's original 150-second main burn or lasting smoulder.
- At 176 seconds, only the obsolete mast collision shapes retire on the host and mirrored
  clients. The original plinth, low charred remnants, map blocking and navigation remain.
- Tutorial keeps its original flag/pole appearance and collision because its lesson-owned
  ignition clock is separate from the replicated scheduled match clock.

The added curves in `render/env/burn/burnTimeline.ts` sample simulation time directly. Skipped
frames and late joins therefore show the correct stage without event history or frame counters.
The colour and depth materials use the same guy-line fall deformation and discard mask. The pole completion time
is shared with simulation through `sim/effigyBurn.ts`.

## Shared population and recruitment

Maximum Signifiers is the fixed population for the whole map, including all camps, neutrals and knocked-out hippies. Starting workers come from this pool; the remainder starts neutral. A knockout drops carried items, clears orders and returns the same hippie to a neutral spawn after 14 seconds. Recruitment changes allegiance without creating new hippies.

Working Drum Circles and Geomantic Command Centers each recruit one nearby neutral within 15 metres every 14 seconds, without a Flag or lumber cost. Neutrals within 60 metres drift toward the nearest working recruiter. A recruiter with nobody nearby waits until a neutral arrives. The GCC has no active powers; its recruitment, repair and advice are passive.

Aim at an awake, empty-handed neutral within 3 metres and press Interact (E by default) to hand them a carried Flag. Throwing a Flag directly into a neutral recruits them immediately without damage. Both transfers give them the actual Flag. Rival hippies still take damage from thrown Flags; a knockout makes them neutral when they respawn.

Camp capacity is a soft attention limit: 12 plus 6 per working Drum Circle, with no fixed ceiling. Flags and buildings can recruit beyond it, including beyond 40 in a camp. The newest recruits above capacity lose an additional 2 attention per second, including while idle, and cannot recover by resting at home. At zero they take the normal distraction break. Increasing capacity or losing members removes the excess penalty from hippies who now fit within capacity. The HUD shows recruited population / attention capacity, with excess count in its tooltip. The separate Maximum Signifiers setting controls the whole world's population and defaults to 200. Both population and jump height remain editable; explicitly saved choices are preserved.

## Controls

Settings → **Customize controls — keyboard, mouse & gamepad** contains action rows with separate keyboard, mouse and controller bindings. Click a keyboard field and press a key; Delete unbinds it. Escape remains available to close menus. Settings persist in this browser. Reset controls restores defaults.

Standard-mapped controllers use left stick movement, right stick camera look, A/Cross jump, X/Square interact, Y/Triangle quick throw, RT/R2 attack/build, LT/L2 aim, left stick click sprint, View/Select command view, and Menu/Start pause. The other default mappings appear in the settings table. Deadzone, controller look sensitivity and swapping sticks are configurable. The main Settings panel has separate **Invert mouse** and **Invert gamepad** toggles. Each applies only to that device, even when both devices move in the same frame; neither reverses the Command View cursor. Both preferences persist independently. Keyboard and mouse remain active alongside the controller.

Sprinting uses a forward-leaning, arms-back Naruto run pose and prevents throwing Flags. Entering throw mode (RMB or LT/L2 by default) ends sprinting and automatically collects nearby loose ground Flags into the quiver, including when the quiver is empty. It respects quiver capacity and leaves planted Flags alone.

In Command View, the movement stick pans the camera and the look stick moves the cursor; the attack and aim bindings select/order. In menus, D-pad up/down moves focus, left/right changes a focused dropdown, A/Cross activates a control, and B/Circle or Menu/Start closes a panel or resumes. A keyboard remains necessary for text fields such as multiplayer passwords and names.

Controller movement/buttons are cleared on blur, disconnect and screen changes. A physical-controller smoke test remains necessary on the user's hardware.

## Boss reveal

- Internal match settings retain `bossMode`, default on, without exposing it in menus.
  Tutorial and the title/lobby attract world opt out; disabling it in code preserves
  the approved non-boss sequence.
- The simulation stores and replicates `effigyRevealedAt` exactly 90 seconds after
  the scheduled Burn. A skipped step or late join reconstructs the same state.
  Protocol version 12 includes this field and the full encounter state, including shared interrupt immunity, and validates the configurable hoarding threshold. It distinguishes
  zero-day ignition from Unlimited (`days: -1`). Older clients must reload.
- Reveal clears both original pedestal and mast collision, rebuilding static
  navigation and lattice plantability without discarding dynamic blockers.
- The last five seconds charge the original structure white. At 90 seconds it
  disappears into a white burst, shock ring, charred timber, embers and ash smoke.
  The actual rig rises through the ground during the 85–90 s white phase, glowing
  white with its arms crossed. In the final 0.55 s it opens its arms and tilts its
  head back, reaching the full gesture at 90 s. The same authoritative frame
  ends the white model charge instantly; the original material parameters and geometry
  remain unchanged. At that moment, **HE IS AWAKENED** appears on an opaque dark HUD
  plaque and the eruption produces five seconds of intense white illumination. It holds
  steady for 4.4 seconds, then smoothly recovers normal lighting by the five-second mark.
  The real, depth-writing rig excludes this point light and marks its HDR alpha coverage,
  so the existing final grade preserves a dark silhouette against the white halo and
  illuminated scenery, including through bloom. No new light or post-processing pass is
  added. The full back shell surrounds the rig from the first eruption frame; the black
  crater persists afterward. Timing comes from the replicated reveal timestamp, so pause,
  late join, reset and replay do not restart or prolong the announcement/glare.
- The original source GLB is unchanged; its original uniform scale makes the complete
  boss 32 m tall including its hat. Per-material runtime consolidation reduces
  594 draws to 31 while preserving all 401,386 triangles and 109 bones. The later
  rear-drape seam repair is confined to runtime-prepared cloth vertices, as described below.
- The reveal starts the cooperative encounter below. Ordinary Dawn and conquest
  endings stop during the fight. With a 300-second day the Burn is at 140 s and
  reveal at 230 s; the former 300-second Dawn deadline no longer ends the fight.

### Neutral Burn spectators

Neutral hippies gather during the final 120 seconds before ignition, using ordinary
pathing to stable, spaced audience positions around the effigy. The ring starts 16 m
from its center, beyond the guy-line anchors, and expands for large crowds or enlarged
effigy footprints. Arrived spectators face the effigy. Zero-day games initialize only
starting neutrals in safe ring positions; Unlimited and tutorial worlds keep wandering.
Recruitment, KO and combat still interrupt watching. After the ordinary burn is consumed
the audience disperses; an active giant encounter instead takes priority immediately.

### Cooperative giant encounter

When the hidden, default-on encounter reaches its reveal, the giant becomes an authoritative
encounter. The approved 85–90 second effigy reveal is unchanged. Before that moment camps
remain rivals; afterward player-controlled and NPC camps are allies. Rival damage,
knockback and altar overwrites stop. Players can still pick up and
pull each other's Flags; ordinary pull timing, Ward/Crystal slowdown and Stabilize L3
protection still apply. NPC vexillomancers
and their Signifiers attack the giant. Priority Beacons can direct your Signifiers at it.

- The giant starts with 50,000 HP by default. The mode and health controls are deliberately
  absent from menus and settings so the reveal stays a surprise. Internal validated match
  fields remain available for testing and network configuration; they are sampled once at
  encounter creation and cannot heal a running boss. Saved UI settings older than version 3
  reset only the former encounter testing values to enabled/50,000, preserving other choices
  and version-2 zero-day starts. Earlier zero-day-to-Unlimited migration remains separate.
  Staff timing and damage are unchanged; cooperation, Signifiers and thrown Flags shorten
  the encounter.
- A thrown Flag deals 100 damage to the body or 300 to the face/head/hat, destroys the Flag, and
  bursts into a colored firework at the exact impact point. Swept collision regions follow
  the approved animated rig, including crouching, arms, skull and hat; walls still stop a
  throw before it reaches the giant.
- The giant uniformly chooses a random eligible altar using host-seeded randomness, briefly retaliates against
  attacking vexillomancers, walks standing over distance, and crouches for hand attacks.
  It turns toward a target before hand attacks or reversing its travel. Attack recovery
  keeps the settled stance, and a reached strategic altar takes priority over bystanders.
  The chosen altar stays locked until it is eaten or becomes invalid; then it randomly chooses another
  living camp altar. Each altar has equal selection weight, regardless of CMI or owner. Long routes zigzag ±15° in alternating 10 m legs,
  straighten within 40 m of the altar or near a boundary, and make bounded stops to crush
  scenery along the way. Retaliation and incidental melee cannot indefinitely replace the
  altar objective. Intact loops still block every step and protected hand reach.
  Swipes run in 1.2 seconds, hit once at 0.55 seconds, and recover for 0.275 seconds.
  They deal 100 damage to players and Signifiers and launch them through real ballistic
  flight. Swipes deal 110 damage to buildings and 150 to build pieces; lethal hits permanently
  destroy them, except altars. Stomps and steps crush other built structures. Grabs instantly
  consume any of the six camp-building types or wall/deck/ramp pieces on the authoritative
  eat event, regardless of remaining HP, construction progress or disabled/collapsed state.
  The giant can select a structure for a stomp, swipe or grab without a player standing nearby.
  Altars can only be destroyed by eating: swipe, foot and beam damage stop at 1 HP, and
  the giant deliberately crouches to eat an altar rather than stomping it indefinitely.
- A continuous player-movement hull blocks the body and leg gaps: 5.2 m radius, 32 m
  standing or 19.2 m crouched height. Swept contacts match local prediction, push safely
  against walls and defended loops, and disappear at death. Staff attacks still reach
  from the hull edge; projectile scoring continues to use the separate animated rig.
- During the fight its health replaces the top-center clock in the same ornate plaque.
  The day phase settles continuously into full night during the five-second emergence
  and stays there while the giant lives. At zero HP the sun starts rising smoothly,
  reaching Dawn over the existing 12-second death sequence. Sky, lighting, HUD and the
  audio fallback derive this from the same replicated timestamps; attacks, tides and
  the Burn keep advancing normally. Ordinary and tutorial day cycles are unchanged.
  Gentle, single lightning pulses illuminate its original materials for 0.9 seconds,
  spaced 8–14 seconds apart; reveal, death and menu screens do not flash.
- The emergence uses CGEffex’s selected T-rex roar; occasional ecfike/123agumon vocals
  alternate roughly every 32 seconds during living combat, without vocal overlap or late-join replay.
  These sampled vocals play at identical level throughout the map, with cached decoding,
  shared reverb, master/SFX controls and output limiting. See [sound credits](../web/public/audio/boss/CREDITS.md).
  Death retains its distinct procedural bellow. Low footstep impacts follow
  the actual standing and crouching foot-contact phases; the eye has a three-second
  charging sound, a sustained five-second firing sound, and coalesced impact explosions. Destroyed scenery
  produces a coalesced crushing sound and a brief dark dust/debris eruption per removed prop.
  The eruption follows its grounded footprint and height, with capped size and a dedicated
  2,048-particle pool; duplicates and late-join reconstruction do not replay it.
  Footfall and deliberate stomp cues follow the exact
  authoritative damage-contact events. These use the existing spatial SFX,
  volume and mute controls, and do not replay old cues on late join or resume.
  Other boss cues retain horizontal direction but carry across the arena on a dedicated bus;
  their envelopes briefly lower music and other world effects without changing user volume.
- The original hat eye glows dimly. Every 30 seconds the giant pauses and charges for three
  seconds, tilting its head toward the first target. Its first shot is due 30 seconds after
  reveal. The complete white beam then stays visible for five seconds while the head sweeps
  through up to five useful target points. It follows the actual pupil's gaze and stops at
  the first terrain or structure surface (240 m maximum reach).
  The planted Flags sustaining actively shocking Crystals receive first priority, followed
  by rainbow arches, rainbow campers and LED totems, then other strongly lit installations. Groups of at least three
  units, non-altar structures and recent Flag throwers remain useful secondary targets.
  Ordinary unit targets must be at least 9.26 m away; isolated Signifiers around the feet
  are left to melee. Unreachable targets defer the beam instead of starting a futile charge.
  A 5 m spherical blast follows the moving impact. Fixed 60 Hz contacts and swept surface
  coverage deal 1,000 damage to each unit, building or build piece at most once per firing
  sequence, including targets that enter after firing begins. Surviving targets retain
  their remaining HP; lethal hits remove non-altar structures. Altars retain at least 1 HP.
  Flags hit by the blast fall loose and remain recoverable, including stock, carried,
  thrown and simulacrum Flags. Damage occurs around the impact, never along the beam.
  Every static scenery prop touched by the impact blast can explode: tents, domes, art,
  portas, trees, rocks, stages, shades and cars. Terrain and resource piles remain intact.
  Crystal retaliation aims at ground-level support Flags, preferring 5 m blast centers
  covering the most supports and sweeping uncovered groups afterward. Implied pentacle
  nodes are traced to their real planted parent Flags, including simulacra. The visual
  prism does not intercept the beam or shatter from a visual hit; normal Crystal rules
  shatter it when the supporting pattern breaks. This applies equally to the 75 m giant.
  The host replicates the route, live gaze/impact, sample index and once-per-beam hit ledger for late joins.
  Charge/fire cancel on death or the end of the match.
- Each fully grown ordinary Crystal shocks the living giant for 25 HP/s while its focus
  is within 50 m of the giant's ground center. The manifested giant Crystal deals 50 HP/s
  with unlimited range. Contributions stack independently and crossing-range exposure is
  integrated rather than billed once per frame. Each live Ward deals 25 HP/s while the
  giant is actually grabbing a planted Flag it protects. Existing player pull slowdown is
  unchanged. Persistent lightning starts at the Ward/Crystal tip, including
  the 75 m giant tip, and ends on the posed boss; mirrors never apply the damage themselves.
- Rival NPC vexillomancers use their carried Flags against the giant, solving the actual
  ballistic throw with obstruction checks and cooldown/ammo limits. They choose reachable
  head/hat shots when possible and body shots otherwise, with melee as a fallback.
  Successful player and Signifier melee contacts create a small faction-colored firework
  on existing valid targets, including the giant, units, structures and lumber piles.
  Generic boss-damage bookkeeping does not add a duplicate burst at its body center.
- Every standing or crouched walking footfall is a 2.5 m-radius stomp at the measured sole
  landing point, dealing 140 damage once per contact and crushing scenery up to 5 m across.
  The deliberate stomp covers a larger 7.36 m radius and can crush any scenery size. Contact
  uses exact circular or rotated-box footprints and the durable removal/blocking cleanup
  shared with beam blasts. Only eating can remove an altar.
- Every intact Flag cycle, including nested loops and implied-Flag loops, blocks the whole
  giant footprint. About six thin rings in the current owner's color remain visible while
  each intact segment is within 5 m of the giant's center, including while crouching,
  eating or charging. Every qualifying segment gets its own line-aligned field, so both
  sides of a corner can appear at once. Their opacity is unchanged; a 5.3 m exit distance
  prevents flicker. Departure, a broken loop
  or boss death clears the field. When the giant actually breaks a loop by consuming or
  knocking down its supporting Flags, matching colored shards burst outward from the
  disappearing planes. This is a one-shot host fact, with no replay on late joins, no
  burst from proximity departure, and a fixed 2,048-particle pool. The giant must consume real supporting
  boundary Flags, rather than teleporting through a defense. A small loop also prevents a
  hand from reaching across it to consume an altar.
- Omega Pulse deals 500 damage to the giant within its unchanged 12/16/20 m
  level-dependent radius and keeps its 75-second cooldown. A successful pulse can interrupt
  an unconsumed grab with one second of recoil. The giant then has 20 seconds of shared
  interrupt immunity across all casters; damage still lands during immunity. A consumed
  target is never restored, and charging/firing the eye cannot be interrupted by the pulse.
  Ordinary target damage and all other spell behavior are unchanged.
- During its existing 30-second effect, Acid Cop Vision privately marks the giant's
  chosen altar and current tactical target. Once the eye commits to an attack, it also
  shows the dashed aim plan, separately from the actual firing ray and first impact.
  The plan is not a guarantee of clear line of sight or future damage. It reads existing
  authoritative intent rather than predicting random choices. The overlay disappears
  immediately on expiry, encounter death or leaving play; existing drug drawbacks remain.
- Losing an original altar does not eliminate a camp with another owned altar. Losing the
  final owned altar does. This rule applies in ordinary conquest and in the encounter.
- At zero HP the giant catches fire, falls to its knees and burns away for 12 seconds. Only
  then do the surviving camps win together. Losing every human camp no longer ends the
  encounter while any active camp still has an altar. Eliminated humans can choose an
  available surviving NPC camp and continue with its existing avatar and assets; camps
  reserved for disconnected humans cannot be taken. The encounter is lost only when every
  altar is gone. Dawn and conquest do not end an active giant encounter.

Combat decisions, hits and outcomes run on the host's fixed simulation clock. Snapshots and
state frames include movement, HP, action times, stance, held targets, barriers, airborne
Signifiers and the shared result. Late joins reconstruct the current state without replaying
old fireworks. Clients animate the approved 32 m, 109-bone model in place; its 594 source
primitives remain consolidated into 31 equal-material skinned draws. The original GLB,
topology, skin weights and material colors are preserved; a bounded preparation correction
is confined to the rear hat drape's shell/lining/edge/seam vertices to keep the skull covered.
Boss-off mode and the Training Burn keep their original behavior.
Standing travel uses an 8° forward lean and a 7.8 m stride while keeping its 4.3 m/s
speed; native crouch travel uses a 6 m stride at 2 m/s. Distance-driven cadence prevents the larger steps from speeding it up. Front coat
panels follow the legs, swipe/eat actions stay crouched, and the resting jaw is slightly
open. The rear hat drape stays attached to the hat while its lower portion follows the coat,
without jiggle; the ear flaps and cords retain their motion.

Verification includes simulation/action-window tests, full encounter runs, animated-region
projectile tests, real host/two-client/late-join tests, and production-shader visual proofs.
The current cloud executor cannot launch Chromium's socket service; the shader proofs are
not a browser gameplay certification. A final interactive browser playtest is still useful
before release. Publishing this branch does not deploy the game.
Boss sound scheduling and synthesis have automated coverage; audible output still needs
checking in a browser with Web Audio enabled.

### Command View cleanup

Enclose now contains **At target** (E) and **Expand home** (R). Expand home preserves the former Ring planner's wider home boundary; Node and Pentacle stay separate. Plans and direct unit orders remain different: Clear plan does not remove planted Flags, and Clear orders returns selected workers to automatic jobs.

Right-click your avatar to make selected workers follow. **Hold position** guards the group's current center. Ctrl+right-click always defends the clicked position, overriding hovered nodes, entities and active tools. The revealed, living boss can be targeted directly with right-click Attack. Wall, Deck, Ramp and Demolish controls are shown in action view only; camp-building placement remains available on the map. Flag-here pings are markers, not planting orders.


## Gentle gameplay terrain dome

The square arena rises smoothly to 2 metres at the central effigy base. Every point on all four playable edges stays at the original zero height. The summit and border have horizontal tangents; outside decorative hills are unchanged. Terrain elevation is shared by physics, rendering and network mirrors. Avatars, Flags, projectiles, structures, scenery, survey markings and the Boss use the same ground profile. Horizontal lattice positions and gameplay radii are unchanged. Multiplayer protocol 13 rejects older clients with a reload hint; terrain heights, shared encounter state and input ownership epochs require the same version on every peer.

## Optional capture and Crystal rules

Advanced Game Settings → **Optional rules** has three independent switches, all **On** by
default. Choices are saved in this browser and apply to the next match only. Old saves
without these fields use On; explicit Off choices survive reloads and restarts. Reset defaults
restores all three to On while preserving enabled seats. Online guests can inspect the host's
choices, but only the lobby leader can change them before starting. Protocol **18** carries
the exact rules and Crystal target locks; older clients/hosts must update together.

- **Building Capture:** controls enclosure capture of ordinary camp buildings, modular walls,
  floors and ramps, and capturable neutral scenery. Original altar/Hearth capture and its
  camp-conversion consequences remain active. Turning this rule off never strips existing
  ownership, stored Flags, collision geometry or captured-scenery benefits. Capture progress
  is cleared, not completed, when the rule is disabled; AI ignores those disabled sieges.
- **Crystal Flag Protection:** controls the existing 2× pull-time multiplier on a grown
  Crystal's sustaining Flags and its associated flag-protection lightning. Wards retain
  their existing protection. It does not enable or disable unit attacks.
- **Crystal Attacks:** grown ordinary Crystals warn for **1 second**, then shock one hostile
  unit within **16 m** at **12 HP/s**. A valid target stays locked; solid cover, retreat,
  knockout, allegiance changes or loss of the Crystal's sustaining pattern end the attack.
  A new target always gets a new warning. Overlapping Crystals deal at most **18 HP/s** to
  one victim. Attacks do not stun or reset pull progress, do not target neutrals or friends,
  and introduce no new Crystal health bar. The Training Burn retains its lesson behavior.

The existing Crystal/Ward lightning against the giant is separate and unchanged by these
switches. During the existing shared-alliance encounter, ordinary camp units are friendly and
are not targeted. Warning rings and attack arcs use the source Crystal owner's current color.
The host alone applies damage; clients and late joins render its replicated lock and timer.
