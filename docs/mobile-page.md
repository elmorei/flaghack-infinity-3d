# Mobile web presentation

The existing game URL selects its presentation before loading the game. Android, iPhone,
iPad and iPadOS desktop-mode Safari use mobile menus; ordinary touchscreen PCs retain the
PC version. An unknown narrow coarse-pointer touch device also uses mobile presentation.
The title offers Mobile version and PC version links (`?view=mobile` / `?view=desktop`)
for explicit overrides. There is no redirect or separate simulation/protocol, so project
subpaths, invite processing, saved options and startup cache behavior remain shared.

Portrait mobile startup uses the shot-reframed 432×768, 25-second silent intro. Landscape
mobile and PC use the existing widescreen movie. Selection is made once on entry; rotation
never restarts playback or downloads a second movie. See the adjacent asset provenance
JSON for crop expressions and source/output hashes. The source montage already runs at
1.2× speed; no additional speed change was applied.

Mobile menus use unscaled CSS pixels, safe-area padding, scrollable panels and touch-sized
controls. Title, Join, local/online lobby, Advanced Game Settings, Settings, help and Liber HH
are reformatted. Desktop gameplay HUD scaling remains; the mobile command field uses the minimal interface below. Windows host/launcher promotion is
hidden from the public title; host releases and joining existing hosts remain available.

The mobile command frontend uses the touch interface below; it does not add action-view
virtual joysticks or change faction rules. Real-device performance remains device-dependent.
Browser verification uses native Chrome with device emulation, not physical Android/iOS
hardware or Safari certification.

Verification: `npm test`, `npm run typecheck`, `npm run build:pages`, desktop/host tests,
existing startup browser smoke, and `node scripts/verify-mobile-browser.cjs` on stock macOS
Chrome. Set `LIVE_URL` to the deployed project URL to repeat the mobile smoke against Pages.

## Mobile command interface

The phone game uses a fixed diagonal isometric command view with finger-sized selection
areas. Drag pans the field; there is no pinch zoom, camera rotation or touch edge-panning.
The mobile renderer bypasses decorative full-screen postprocessing while retaining world
ownership, threats, lightning and other gameplay cues.

The field keeps Menu and the Degen / house / Plan bottom row visible. The house centers the camera on your camp. Detailed command panels,
resources, priorities, roster and building controls live in full-screen menus with a clear
return to the field. Opening these menus does not pause a multiplayer match.

- Degen controls units: tap a friendly unit to select, then tap a contextual target/order.
- Plan controls capture planning: tap nodes using existing planning rules.
- Tapping a unit while in Plan selects it and returns to Degen.
- Long-pressing a node switches to Plan without issuing a capture command on release.
- Long-pressing a buildable space center opens a building picker for that space. Choosing
  an affordable valid building starts construction immediately, with no confirmation screen.
  Unaffordable or invalid choices are disabled and greyed out. Back cancels the choice;
  the long-press alone never starts construction.
- Dragging cancels pending long-presses. Additional touches, canceled touches, rotation and
  menu transitions cancel incomplete interactions rather than issuing stray orders.

Selecting a Signifier and tapping an awake neutral orders a real Flag handoff. Tapping a
free node orders planting there. A selected group assigns only one awake Flag bearer,
preferring a member already holding a Flag; otherwise one member fetches available stock.
The rest move to the target without fetching more Flags. With no available Flag, the order
reports the shortage and leaves the group's previous orders intact.

Tap the Frick-frack wizard to open his dialogue. Mobile dialogue includes an animated pixel
portrait, with a reduced-motion alternative. Degen players need no selected unit or avatar:
wagers use actual owned camp stock, and payouts return to an owned Altar. Regular players
must approach the wizard and use carried Flags as before. Talking has no entry fee; the
host validates every wager, and exiting a committed hand forfeits it. The world continues
running during dialogue and play.

Actual-match verification is separate from startup/menu testing:
`node scripts/verify-mobile-command-browser.cjs` exercises touch interactions and captures
portrait/landscape/desktop evidence using native Chrome with device emulation.

Public playstyle labels are Regular (avatar) and Degen (throne/RTS). Internal protocol
values remain unchanged. The Degen / Plan field toggle is separate from playstyle.

## Degen Powers and shared drugs

Menu → Powers provides direct field placement: choose a spell, then tap the ground. No
Signifier selection is required. Cancel, opening a menu, long-pressing, or changing control
mode clears the pending spell; a camera drag never casts it. Availability is rechecked at
the tap and again by the host. Degen's new rites do not appear in Regular mode.

- Canton / Finial alignments take 4 seconds at an owned operational Altar and cost 30, 70,
  then 130 Ritual per level. Payment occurs on completion. Altar damage or ownership loss
  interrupts the channel without spending Ritual.
- Stabilize Zone retains its 16/20/24 m radii, 20-second duration, and 35-second cooldown.
  Degen places it directly at the tapped point. Level 3 protects the caster's planted Flags.
- Omega Pulse retains 12/16/20 m radii, 40 damage, 14 knockback, and a 75-second cooldown.
  Degen warns for 2 seconds at the tapped point; damage to the casting Altar interrupts it
  without refunding the committed cooldown. Level 3 can plant up to six actual friendly
  Flags carried by nearby awake Signifiers, never remote stock or generated Flags. Boss
  damage and allied-camp protections remain unchanged.
- Red Tape Mandala requires a working Drum Circle, costs 15 Ritual and has a 45-second
  cooldown. After a 1-second warning it slows rival Signifier movement by 25% in a 14 m
  circle for 12 seconds. It does not stack, damage units, slow work, or affect allies.
- Patchwork Litany requires a working Drum Circle, costs 20 Ritual and has a 60-second
  cooldown. For 15 seconds it repairs up to four nearest standing own structures within
  16 m at 8 HP/s after 3 seconds without damage. Altars, Command Centers, disabled or
  unfinished buildings, enemies and destroyed pieces are excluded. An empty cast is free.

All three existing drugs are available in either control mode. Each dose retains the
25-Lumber / 22-second brewing cost and its existing drawbacks. Saffron lasts 40 seconds,
boosting movement/work by 50% and Ritual by 0.3/s, followed by a 20-second 30% crash and
25% chance of 8–15 seconds of overstimulation. Luminous Dust lasts 30 seconds and generates
3–5 false Flags, rerolled every 10 seconds; without an avatar those hallucinations are
anchored near the camp. Acid Cop Vision taps rival meshes for 30 seconds while doubling
Signifier attention drain. No new drugs are added.

The host owns costs, cooldowns, warning clocks, repairs, damage and drug outcomes. Snapshots
replicate their state to current and late-joining peers. Ground cues read those clocks and
do not manufacture a blast when an interrupted warning disappears. Switching control mode
cancels pending alignment, Omega warnings and mode-specific rites; shared Canton/Finial
upgrades, drug inventory and all cooldowns persist. Spent rite costs are not refunded.
