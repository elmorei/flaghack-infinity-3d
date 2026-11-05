# Mobile building sprites

Six building kinds use screen-facing sprites on mobile: Flag Hearth (altar),
Workshop, Drum Circle, Hearth Ward, Drug Lab, and Geomantic Command Center.
Desktop uses the existing models. Player walls, floors, ramps, and their placement
previews remain 3D by user request.

The atlas is baked from the actual model classes, not replacement illustrations.
`web/scripts/bake-building-sprites.mjs` uses native sandboxed Chrome through Vite.
The artifact-only `bake-mobile-scenery.yml` workflow can run this on macOS without
publishing gameplay. The provenance JSON records the source commit and source-file
hashes. The PNG contains fourteen clips, four camera directions and four frames
per clip: 224 cells on one 2048-square page (16 MiB decoded RGBA).

States are Hearth idle/seated, Workshop idle/working, Drum Circle idle/active,
Ward idle/pulse, Drug Lab idle/brewing, and GCC idle/moving/channel/wreck. Each
clip includes an explicit projected ground anchor and physical world scale.
Empty or edge-clipped cells cause the bake to fail. The seated Hearth excludes
its central pole/fire so it does not duplicate the combined ruler/throne art.

Alpha carries semantic masks: 0 is transparent, 224 marks faction material,
255 is ordinary cutout art, and 160 marks the GCC's live tabletop map. Map pixels
are found through white/black material-difference captures with normal model
depth testing, preserving the rim and other occluders. Their sRGB-encoded R/G
channels hold `.5 + .5 * localTableXZ`; after normal sRGB texture sampling,
runtime reconstructs local coordinates and rotates them by the actual cart
heading before sampling the existing live map texture. The map keeps its live
world updates and compass orientation without adding 3D table geometry.

The render integration retains live fire, capture-stage colors and pressure,
smoke, sparks, hoard frost, range/pulse indicators, recruitment dome, ownership,
construction, damage, disable/repair feedback, placement validity, and GCC
channel/rebuild states. Altar and Workshop stock use individual flag sprites,
not counts painted into the sheet; their caps remain thirty and ten. Hoarded
altar stock freezes while the large altar flag continues to wave. Boss-held
buildings use their actual kind and follow the existing held/consumption anchor.

Verification commands from the repository root:

```sh
node web/scripts/verify-building-atlas.cjs
npm --prefix web run typecheck
npm --prefix web test -- src/render/structures src/render/env/burn/boss/heldFlagMobile.test.ts --maxWorkers=2
```

`verify-building-atlas.cjs` checks manifest coverage, GPU-page budget, image
pixels, masks, clipping, frame-cell overlaps and exact provenance counts.
`verify-building-integration.mjs` exports an offline production-browser fixture
for the native browser verifier. These checks are separate from visual scene
review and physical-device performance testing.
