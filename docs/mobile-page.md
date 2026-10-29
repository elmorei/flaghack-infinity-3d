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

The field keeps Menu, Home and the Degen / Plan toggle visible. Detailed command panels,
resources, priorities, roster and building controls live in full-screen menus with a clear
return to the field. Opening these menus does not pause a multiplayer match.

- Degen controls units: tap a friendly unit to select, then tap a contextual target/order.
- Plan controls capture planning: tap nodes using existing planning rules.
- Tapping a unit while in Plan selects it and returns to Degen.
- Long-pressing a node switches to Plan without issuing a capture command on release.
- Long-pressing a buildable space center opens a building picker for that space. Choose a
  building, inspect its preview, then Confirm or Cancel. Construction is never committed by
  a long-press alone.
- Dragging cancels pending long-presses. Additional touches, canceled touches, rotation and
  menu transitions cancel incomplete interactions rather than issuing stray orders.

Actual-match verification is separate from startup/menu testing:
`node scripts/verify-mobile-command-browser.cjs` exercises touch interactions and captures
portrait/landscape/desktop evidence using native Chrome with device emulation.

Public playstyle labels are Regular (avatar) and Degen (throne/RTS). Internal protocol
values remain unchanged. The Degen / Plan field toggle is separate from playstyle.
