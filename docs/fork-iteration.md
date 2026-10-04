# Fork iteration: configurable matches and controls

## Match setup

Begin the Survey opens the lobby for local games; joining a host opens the multiplayer lobby. Each of the four player seats has an On/Off toggle, and the number of days is selected in the lobby. At least one seat remains on. Offline, choose any enabled character with Play this character; other enabled seats use AI. Turning off the selected local seat moves you to another enabled seat. Disabled seats show a neutral numbered placeholder and have no avatar, Hearth, GCC, starting stock or Signifiers in the match. They also stay out of the Hearth rail, standings and end-of-match statistics. Their camp scenery remains part of the map.

In multiplayer, the leader controls match setup. A human must leave a seat before its camp can be disabled. New arrivals take only enabled seats; other arrivals spectate. Match settings travel with the authoritative world options so clients generate the same lattice. The network protocol is version 4; all players must use the same build.

Choose 1–5 days or Unlimited. A day means one complete daylight/night cycle. Default: 1 day at 1,800 seconds, preserving the original 14:00 Burn and 30:00 Dawn deadline. With multiple days, the Burn occurs at the same point in the **last** cycle. The sky repeats each cycle. Conquest can finish a competitive match earlier; a single-camp creative/solo match finishes only at its time limit. Unlimited has no time limit or scheduled Burn; competitive conquest still works.

Advanced Game Settings opens a separate window with a scrolling body, a fixed header and footer, and Done, close, Escape and backdrop dismissal. It contains the number of days, rival difficulty, random or fixed world seed, and all configurable match parameters below. Reset defaults preserves the lobby's player-seat selection. Online guests can inspect the settings; only the leader can edit them before the match. Advanced settings are bounded and applied at match creation:

| Setting | Range | Default |
| --- | --- | --- |
| Full day length | 300–7,200 seconds | 1,800 |
| Lattice edge spacing | 6–12 metres | 8 |
| Starting lumber | 0–1,000 | 150 |
| Stock Flags per Hearth | 0–100 | 14 |
| Starting Signifiers per camp | 0–12, limited to an equal share of the world population | 6 |
| Jump height multiplier | 0.1–5.0 | 1.0 (original height) |
| Maximum Signifiers (whole world) | 0–200 | 40 |
| Structures block flag placement | Off / On | Off |

Home-loop Flags and the avatar's six carried Flags are unchanged by stock tuning. Lore/help text that describes the original rules retains the original default values; the live clock uses the chosen match settings.

Jump height scales the jump apex (2.0 is twice the original height) for both authoritative movement and client prediction. Structure blocking reserves the corner nodes of standing camp buildings when enabled. Terrain, occupied nodes and crystals always prevent placement.

## Shared population and recruitment

Maximum Signifiers is the fixed population for the whole map, including all camps, neutrals and knocked-out hippies. Starting workers come from this pool; the remainder starts neutral. A knockout drops carried items, clears orders and returns the same hippie to a neutral spawn after 14 seconds. Recruitment changes allegiance without creating new hippies.

Working Drum Circles and Geomantic Command Centers each recruit one nearby neutral within 15 metres every 14 seconds, without a Flag or lumber cost. Neutrals within 60 metres drift toward the nearest working recruiter. A recruiter with nobody nearby waits until a neutral arrives. The GCC's former Gift action is removed; its other powers remain available.

Aim at an awake, empty-handed neutral within 3 metres and press Interact (E by default) to hand them a carried Flag. Command View also offers **Hand Flag** for a selected neutral within reach. Throwing a Flag directly into a neutral recruits them immediately without damage. Both transfers give them the actual Flag. Rival hippies still take damage from thrown Flags; a knockout makes them neutral when they respawn.

Camp capacity is a soft attention limit: 12 plus 6 per working Drum Circle, with no fixed ceiling. Flags, buildings and Dialectics can recruit beyond it, including beyond 40 in a camp. The newest recruits above capacity lose an additional 2 attention per second, including while idle, and cannot recover by resting at home. At zero they take the normal distraction break. Increasing capacity or losing members removes the excess penalty from hippies who now fit within capacity. The HUD shows recruited population / attention capacity, with excess count in its tooltip. The separate Maximum Signifiers setting controls the whole world's population and must be raised above its default of 40 for a match with more than 40 hippies total.

## Controls

Settings → **Customize controls — keyboard, mouse & gamepad** contains action rows with separate keyboard, mouse and controller bindings. Click a keyboard field and press a key; Delete unbinds it. Escape remains available to close menus. Settings persist in this browser. Reset controls restores defaults.

Standard-mapped controllers use left stick movement, right stick camera look, A/Cross jump, X/Square interact, Y/Triangle quick throw, RT/R2 attack/build, LT/L2 aim, left stick click sprint, View/Select command view, and Menu/Start pause. The other default mappings appear in the settings table. Deadzone, controller look sensitivity and swapping sticks are configurable. The main Settings panel has separate **Invert mouse** and **Invert gamepad** toggles. Each applies only to that device, even when both devices move in the same frame; neither reverses the Command View cursor. Both preferences persist independently. Keyboard and mouse remain active alongside the controller.

Sprinting uses a forward-leaning, arms-back Naruto run pose and prevents throwing Flags. Entering throw mode (RMB or LT/L2 by default) ends sprinting and automatically collects nearby loose ground Flags into the quiver, including when the quiver is empty. It respects quiver capacity and leaves planted Flags alone.

In Command View, the movement stick pans the camera and the look stick moves the cursor; the attack and aim bindings select/order. In menus, D-pad up/down moves focus, left/right changes a focused dropdown, A/Cross activates a control, and B/Circle or Menu/Start closes a panel or resumes. A keyboard remains necessary for text fields such as multiplayer passwords and names.

Controller movement/buttons are cleared on blur, disconnect and screen changes. A physical-controller smoke test remains necessary on the user's hardware.
