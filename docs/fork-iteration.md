# Fork iteration: configurable matches and controls

## Match setup

The title screen and multiplayer lobby expose one enable checkbox for each of the four camps. At least one camp remains enabled. Offline play controls the first enabled camp, and other enabled camps use AI. Disabled camps have no avatar, Hearth, GCC, starting stock or Signifiers. Their camp scenery remains part of the map.

In multiplayer, the leader controls match setup. A human must leave a seat before its camp can be disabled. New arrivals take only enabled seats; other arrivals spectate. Match settings travel with the authoritative world options so clients generate the same lattice. The network protocol is version 2; all players must use the same build.

Choose 1–5 days or Unlimited. A day means one complete daylight/night cycle. Default: 1 day at 1,800 seconds, preserving the original 14:00 Burn and 30:00 Dawn deadline. With multiple days, the Burn occurs at the same point in the **last** cycle. The sky repeats each cycle. Conquest can finish a competitive match earlier; a single-camp creative/solo match finishes only at its time limit. Unlimited has no time limit or scheduled Burn; competitive conquest still works.

Advanced settings are bounded and applied at match creation:

| Setting | Range | Default |
| --- | --- | --- |
| Full day length | 300–7,200 seconds | 1,800 |
| Lattice edge spacing | 6–12 metres | 8 |
| Starting lumber | 0–1,000 | 150 |
| Stock Flags per Hearth | 0–100 | 14 |
| Starting Signifiers per camp | 0–12 | 6 |

Home-loop Flags and the avatar's six carried Flags are unchanged by stock tuning. Lore/help text that describes the original rules retains the original default values; the live clock uses the chosen match settings.

## Controls

Settings → **Customize controls — keyboard, mouse & gamepad** contains action rows with separate keyboard, mouse and controller bindings. Click a keyboard field and press a key; Delete unbinds it. Escape remains available to close menus. Settings persist in this browser. Reset controls restores defaults.

Standard-mapped controllers use left stick movement, right stick camera look, A/Cross jump, X/Square interact, Y/Triangle quick throw, RT/R2 attack/build, LT/L2 aim, left stick click sprint, View/Select command view, and Menu/Start pause. The other default mappings appear in the settings table. Deadzone, controller look sensitivity, invert Y and swapping sticks are configurable. Keyboard and mouse remain active alongside the controller.

In Command View, the movement stick pans the camera and the look stick moves the cursor; the attack and aim bindings select/order. In menus, D-pad up/down moves focus, left/right changes a focused dropdown, A/Cross activates a control, and B/Circle or Menu/Start closes a panel or resumes. A keyboard remains necessary for text fields such as multiplayer passwords and names.

Controller movement/buttons are cleared on blur, disconnect and screen changes. A physical-controller and Windows launcher smoke test remain necessary on the user's hardware.
