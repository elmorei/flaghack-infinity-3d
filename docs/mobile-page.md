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
are reformatted. Existing gameplay HUD scaling remains. Windows host/launcher promotion is
hidden from the public title; host releases and joining existing hosts remain available.

This is a presentation release, not the complete mobile RTS control frontend. It does not
add virtual joysticks, RTS pinch/pan/selection gestures or change faction rules. Real-device
performance remains device-dependent. Browser verification uses native Chrome with device
emulation, not physical Android/iOS hardware or Safari certification.

Verification: `npm test`, `npm run typecheck`, `npm run build:pages`, desktop/host tests,
existing startup browser smoke, and `node scripts/verify-mobile-browser.cjs` on stock macOS
Chrome. Set `LIVE_URL` to the deployed project URL to repeat the mobile smoke against Pages.
