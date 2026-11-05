# Mobile scenery cutouts

The scenery atlas is baked from FLAGHACK's existing procedural models, not unrelated placeholder artwork. Each tent, tree, car and installation variant has its own clip. Neutral gray pixels tagged with alpha 224 carry the exact white-versus-black model paint mask so each map object's original color can be restored without recoloring wheels, bark, windows, poles or other fixed details.

## Rebuild

Run `NODE_PATH=<Playwright installation>/node_modules node scripts/bake-scenery-sprites.mjs` from `web/` on a native desktop Chrome runner. Chrome runs with its sandbox enabled and default rendering backend. The script starts a temporary local Vite server and outputs `world-*.png`, `mobileSpriteWorld.json`, and `scenery-reference.json`. It does not deploy or modify gameplay state.

`web/scripts/scenery-bake-specs.json` contains explicit reference dimensions taken from `mapgen.ts`. Asset coverage does not depend on a particular randomly generated map happening to contain every variant. Validate with `node --test scripts/scenery-bake-specs.test.cjs`.

Every clip has four camera directions. Spiral and pinwheel rotors also have four animation frames; their poles/bases remain stationary. The manifest retains pixel-edge ground anchors and world-height calibration. Runtime scales horizontal footprint separately from height, and uses the same forest placement generator as desktop.

After native capture, run `python web/scripts/compact-scenery-atlas.py --source <native-output>/web` from the repository root. It requires Pillow, crops only wholly transparent margins with a two-pixel clear border, and packs variable-sized cells without resizing any pixel. Every original RGBA cell must reconstruct byte-for-byte before output is written. It translates pixel-edge anchors and per-frame foot positions, retains `heightPixels`, and records `sourceCellWidth` so explicit wreckage widths retain their original physical scale. Output page filenames contain content hashes; `scenery-compaction.json` records source hashes, crop rectangles and checks. Rerun with `--verify-only` to compare the checked-in pages to a fresh native capture.

The central effigy is split into plinth, scaffold and flag/mast cutouts so its burning scaffold and shrinking flag stay independent. Live fire, smoke, embers, light, stage shows and boss reveal effects remain driven by the existing simulation curves. Resource piles shrink with remaining stock. Destroyed scenery vanishes and material-specific wreckage persists, including on late joins; resetting authoritative destruction restores the original cutouts.

The central flag clip captures four poses of the original `FlagCloth` shader, preserving its pinned hoist, gold/saffron faces, folds and droop. Its mast has no finial ball. The sprite animates and follows the same eased wind direction as the original cloth. This distinct giant flag retains its own proportions rather than substituting a small carried-flag asset.

Desktop keeps its original models. Player-built walls, floors and ramps intentionally keep their existing precise 3D rendering on mobile too.
