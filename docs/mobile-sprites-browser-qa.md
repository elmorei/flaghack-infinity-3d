# Mobile sprite preview QA

This preview workflow only builds, tests and uploads short-lived artifacts. It does not deploy, publish a release, or change a live branch.

## Implementation

The existing mobile presentation switch selects instanced, depth-tested, depth-writing sprite batches, one per atlas page. Desktop does not create these batches or request their images. Simulation, network messages, hit detection and cross-play rules are unchanged.

The 2048 × 4096 RGBA atlas contains the four faction leaders, Frick/Frack wizard, skeletal boss and the front/rear modular Signifier sheets. Body, head and rear Flag foreground stay in one batch. Camera-relative facing uses hysteresis, walking uses four deterministic frames, and default idle stays on its first frame. The vertex shader expands the quads in camera space, so the art stays flat to the screen at every pitch and roll. Pixel-derived foot baselines anchor the visible feet to the actual world position, rather than the padded cell edge. Source locomotion RGB remains unchanged.

Original procedural animation still runs privately for gameplay-facing attachment points and effects, but mapped character meshes, xray meshes and shadow casters are hidden in mobile presentation. Action clips are selected from the supplemental `mobileSpriteActions.json` manifest: 96 concrete animations (768 front/rear frame cells) plus 10 semantic aliases, packed into three 2048 × 2048 pages. A missing or unavailable clip uses the character's default sprite, never its model. One-shot clips use elapsed state time and restart on a new state transition, not the global match clock.

Seated leader sprites replace the seated character only; the existing throne furniture remains. A seated-only upright depth profile places raised pixels before the rear banners while retaining normal foreground occlusion. It changes only projected depth, not screen XY, UVs, scale or the exact foot anchor, and is bounded to one body height toward the camera. World, ground, flying, carried and boss-held flags use the same screen-facing presentation. Carried inventory counts and authoritative transforms remain unchanged. Flag ownership is preserved by tinted neutral ribbon pixels on standalone art and by a distinct owner badge beside flags baked into Signifier art. The owner comes from the carried Flag, not its carrier. Carried/flying poles can rotate within the screen plane. Planted poles have no finial ball, use exact per-frame pixel-edge tip metadata and full-cell UVs, and stay centered on the rendered node.

Loading/decode failure or a device texture-size limit keeps mapped actors in a built-in flat sprite placeholder. `atlasError` and `actionAtlasError` expose the failure to diagnostics. A missing image never turns a mapped actor back into a 3D model. Supplemental pages load independently; a failed action page falls back to base art while other loaded pages continue working.

Regenerate the atlas from the unpacked approved Mobile Sprite Pack with `python3 scripts/tools/build_mobile_sprite_atlas.py /absolute/path/to/unpacked-pack`. The script uses Pillow, verifies dimensions and every copied source pixel, and writes a lossless WebP plus source hashes and layout metadata. Alpha values are normalized exactly to the existing shader cutout: discarded pixels become transparent, surviving RGB is unchanged. The runtime atlas is about 2 MB; an uncompressed RGBA texture is 32 MiB. No mipmaps are allocated.

The original atlas plus three supplemental pages use 80 MiB of RGBA GPU storage before driver overhead; no mipmaps are allocated. Supplementary pages load independently, and only nonempty batches issue draw calls.

## Verification

Run against the final source revision:

1. In `web`, run `npm ci`, `npm test -- --maxWorkers=2`, `npm run build:pages`, and `npm run build:server`.
2. Provide Playwright 1.56.1 via `NODE_PATH`, and installed stock Google Chrome. Use a graphical native environment with WebGL available.
3. Run `node scripts/verify-mobile-sprites-browser.mjs` and `node scripts/verify-auto-style-browser.mjs`. The preview workflow also runs existing HUD/command regression checks.
4. Review `web/host-release/mobile-sprites-smoke/result.json`, natural/fixture screenshots, and the separate `auto-style-smoke/result.json`.

Chrome runs headful with its sandbox enabled and no security-disabling or rendering-backend override flags. Do not disable sandboxing to work around a restricted environment.

## What the evidence means

- Portrait, small-phone and landscape cases begin through the real title/lobby UI. Natural screenshots and framebuffer differences establish that sprites really appear in gameplay, not merely that atlas requests succeed.
- Animation/composition fixtures directly call the production renderer while synchronously isolating its scene. They exercise four front/away frames, idle, head substitution, the rear carrier's foreground Flag, and all six cast sheets. Fixture PNGs are read from actual native WebGL output before post-processing. They are explicitly staged, not recordings of gameplay actions.
- Camera-angle fixtures compare rendered widths, heights and foot baselines under shallow, steep and rolled views, against the projected world anchor. Unit tests separately validate the metadata-to-quad math for perspective and orthographic cameras.
- Terrain/building fixtures place a sprite inside/below actual scene geometry. Depth-tested pixel contributions are compared with the same geometry and depth testing disabled as a control.
- Combat/KO fixtures use real signifier integration and require zero corresponding 3D instances, including unsupported/default poses. Avatar, wizard, throne and boss state integration is covered by focused unit tests. Supplemental direct-art fixtures cover each shipped clip without claiming those fixtures are gameplay recordings.
- The crowd fixture creates 256 offline neutral signifiers (the ordinary no-beacon gameplay state, so stacked friendly status badges do not conceal the rendered actors) and requires at least 200 integrated sprites. It measures 120 requestAnimationFrame intervals, CPU render duration, whole-frame draw calls and actual sprite draw callbacks, and full-scene framebuffer contributions with depth testing enabled. A separate 256-unit friendly/beacon workload retains the same timing and per-page batch checks, verifies 256 visible badge instances and their framebuffer contribution, and records their expected dense overlap. Raw scene and diagnostic PNGs are saved even on failure. These runner measurements are not physical-phone benchmarks and do not establish a phone FPS target.
- The atlas-failure case blocks the real atlas request and requires visible flat placeholders with no corresponding 3D body or flag instances. Desktop checks require no sprite system, no sprite mesh and no atlas request.
- The separate automatic-style verifier uses real Node host processes, production Join/lobby controls, mixed mobile/desktop clients in both leader orders, and reconnects. No protocol or world state is injected there.

A syntax check is not a browser pass. A restricted execution environment that cannot launch Chrome or lacks WebGL leaves native visual/performance verification unrun. Inspect the exact-commit CI results before calling the preview ready.
