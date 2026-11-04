# Flaghack Gaiden display branding

The mobile edition is **Flaghack Gaiden**. Desktop remains **FLAGHACK∞3D**.
Both are presentations of the same game and use the existing shared simulation,
multiplayer protocol, saves, host addresses, build identity and update URLs.

The existing device-layout resolver selects the name before game code loads. Its
`?view=mobile` and `?view=desktop` overrides also select the matching brand. Rotating
or resizing a page does not unexpectedly switch editions. Narrow desktop windows
and touchscreen PCs retain the desktop edition unless explicitly overridden.

Mobile uses a new gold/cream outlined pixel wordmark made from the already bundled,
SIL-OFL-licensed Press Start 2P font. Desktop keeps its original vector art. Browser
title, startup text/accessibility label, title footer and version links match the
selected edition. The static HTML retains a desktop fallback until JavaScript runs.

`application-name` and `apple-mobile-web-app-title` are updated as home-screen label
hints. This project has no web-app manifest or standalone PWA installation flow, and
this change does not add one. Actual shortcut naming and existing installed labels
are browser/OS-controlled; these metadata hints are not a promise to rename them.
Intro movie footage, shared host diagnostics and historical lore remain unchanged.

## Verification

- Unit tests cover both names, device/override selection, repeated application,
  metadata/accessibility labels, title art, desktop fallback and existing Join flows.
- `node scripts/verify-gaiden-branding-browser.mjs` checks the exact built `dist` in
  native sandboxed Chrome: Android portrait/landscape, a 320px phone, iPad desktop-UA,
  desktop, narrow touch PC, both explicit overrides, reload, lobby return, rotation
  and browser Back. It records screenshots plus `results.json`.
- The initial loading screenshot is a disclosed network-failure fixture: main JS is
  held and intro media fails so the real branded startup fallback can be inspected.
  Title and navigation captures use the production UI and renderer without UI mocks.
- `.github/workflows/gaiden-branding-preview.yml` runs checks and captures only on the
  isolated preview branch (or manual request). It does not deploy or publish.
- Browser device emulation is not physical-device or home-screen-install testing.
