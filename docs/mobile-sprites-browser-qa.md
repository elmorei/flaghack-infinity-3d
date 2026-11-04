# Mobile sprite preview QA

This preview workflow only builds, tests and uploads short-lived artifacts. It does not deploy, publish a release, or change a live branch.

## Implementation

The existing mobile presentation switch selects one instanced, depth-tested, depth-writing sprite batch. Desktop does not create the batch or request its image. Simulation, network messages, hit detection and cross-play rules are unchanged.

The 2048 × 4096 RGBA atlas contains the four faction leaders, Frick/Frack wizard, skeletal boss and the front/rear modular Signifier sheets. Body, head and rear Flag foreground stay in one batch. Camera-relative facing uses hysteresis, walking uses four deterministic frames, and idle stays on its first frame. Pixel-derived foot baselines keep layered figures grounded with unchanged visible source RGB.

Original procedural animation still runs for anchors and immediate fallback. Unsupported attack, KO, reveal, airborne and effect states use their original 3D animation. Seated leaders retain their 3D thrones because no seated sprite art exists. Leaders' carried Flag bundles remain separate 3D equipment so inventory is never hidden. Sprite loading or decoding failure, or a GPU texture limit below 4096, retains the 3D models.

Regenerate the atlas from the unpacked approved Mobile Sprite Pack with `python3 scripts/tools/build_mobile_sprite_atlas.py /absolute/path/to/unpacked-pack`. The script uses Pillow, verifies dimensions and every copied source pixel, and writes a lossless WebP plus source hashes and layout metadata. Alpha values are normalized exactly to the existing shader cutout: discarded pixels become transparent, surviving RGB is unchanged. The runtime atlas is about 2 MB; an uncompressed RGBA texture is 32 MiB. No mipmaps are allocated.

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
- Terrain/building fixtures place a sprite inside/below actual scene geometry. Depth-tested pixel contributions are compared with the same geometry and depth testing disabled as a control.
- Combat/KO fixtures use real signifier integration and require actual 3D instance restoration. Boss reveal/death/attack support is covered by focused unit/integration tests, not claimed as browser-tested by the direct boss-art fixture.
- The crowd fixture creates 256 offline neutral signifiers (the ordinary no-beacon gameplay state, so stacked friendly status badges do not conceal the rendered actors) and requires at least 200 integrated sprites. It measures 120 requestAnimationFrame intervals, CPU render duration, whole-frame draw calls and actual sprite draw callbacks, and full-scene framebuffer contributions with depth testing enabled. A separate 256-unit friendly/beacon workload retains the same timing and single-batch checks, verifies 256 visible badge instances and their framebuffer contribution, and records their expected dense overlap. Raw scene and diagnostic PNGs are saved even on failure. These runner measurements are not physical-phone benchmarks and do not establish a phone FPS target.
- The atlas-failure case blocks the real atlas request and requires 3D fallback. Desktop checks require no sprite system, no sprite mesh and no atlas request.
- The separate automatic-style verifier uses real Node host processes, production Join/lobby controls, mixed mobile/desktop clients in both leader orders, and reconnects. No protocol or world state is injected there.

A syntax check is not a browser pass. A restricted execution environment that cannot launch Chrome or lacks WebGL leaves native visual/performance verification unrun. Inspect the exact-commit CI results before calling the preview ready.
