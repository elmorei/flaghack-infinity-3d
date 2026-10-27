# Boss structure flame poof

Local implementation on `feat/boss-structure-blast`, based on main `2938df0`.

- Replaces the tiny dark scenery puff with a large, rapidly expanding billowing flame burst.
- Yellow-white hot cores, irregular orange lobes, dark moving folds and upward roll follow the supplied visual reference. No external textures or copied photographic assets.
- Flame expires within 0.95 seconds; a lighter smoke tail finishes within 1.65 seconds. No persistent fire, light objects or new damage.
- Boss-crushed/swiped/eye-blasted buildings and pieces use the effect. Ordinary demolition and swallowed structures retain their existing behavior. Existing camera shake is retained.
- Cosmetic event markers replicate live; reconnect/late join does not replay historical explosions.
- One fixed 2,048-particle instanced draw, fewer lobes at low quality. GPU pixel-overdraw cost and the final look still require actual browser verification.

## Visual proof (not yet recorded)

From `web`, start the normal Vite dev server. In a supported Chrome/WebGL environment with Playwright and ffmpeg available, run:

```
node bench/capture-structure-fireball.mjs
```

The script uses the real boss blast function and real production scene/VFX, removes an actual dome, captures 120 frames and writes a four-second MP4 plus provenance. Capture is explicitly staged with a fixed camera and deterministic presentation clock. It is not generated footage.

Local Chromium execution is blocked by this environment's socket/sandbox initialization. No security flags or alternate route around the pending GitHub approval were used. The established macOS runner can record once its GitHub upload is approved. No screenshot/video or visual sign-off has been produced for this revision yet.
