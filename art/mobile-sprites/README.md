# Supplemental mobile action art

These source grids were AI-generated using
`web/public/assets/mobile-sprites/atlas.webp` as the character/style reference.
The original walking atlas pixels are unchanged. `sources.json` records original PNG hashes, source dimensions, clip ordering and
aliases.

The generated grids are retained as lossless WebP. Source alpha is normalized to the
runtime cutout rule: alpha below 128 is transparent; surviving RGB is unchanged.
This removes low-alpha extraction noise without repainting the artwork. The packer
only extracts cells, scales with nearest-neighbour sampling, anchors them and packs
the pages. It finds actual transparent gutters because some generated grids do not
have perfectly uniform spacing.

## Coverage

- Four faction leaders each have 16 new clips: seated, swing, throw, plant, pull,
  align, channel, push, sprint, jump, fall, land, guard, hit, stun and KO.
- Aim shares the ready/guard pose. Respawn shares the recovery/landing pose while
  the renderer controls materialization. These are explicit manifest aliases.
- Signifiers have chop, kneel, tug, shove, kick, drum, dance, hammer, KO, stun,
  jump, hit and wobble. Jitter shares wobble. Existing walking/carrying/hauling
  bodies and all 18 personalized heads remain in use.
- The wizard adds KO, stun, jump and channel/gesture art. Its simulation uses
  ordinary idle/walking while wandering, following or conversing, with KO/stun
  and airborne handling before its special movement pass.
- The skeletal boss adds emerge, crouch, crouchWalk, rise, swipe, stomp, grab,
  recoil, death, dead, eye-charge and eye-fire.
- Flags add planted waving, grounded rippling and carried flutter. Thrown flags
  use the upright carried art with screen-plane rotation from the actual pole
  transform. The source grid also contains a diagonal flight preview, intentionally
  not packed so the runtime does not rotate it twice.

There are 96 concrete clips, 768 frames and ten explicit aliases in three 2048²
pages. Each clip has four frames in each of the front and away directions. Seated
leader art contains only the character, retaining the existing throne furniture.
Unknown future animation names use default sprite art, not visible 3D characters.

## Art briefs used

All character requests specified matching identity, clothing, palette, clean dark
outlines and shaded chibi game style, with a genuine transparent background; four
front action frames followed by four rear frames on each row; no labels, grid,
scenery or shadows; and complete figures within each cell.

- Leader action grids: seated on an invisible chair (body only), sweeping staff
  attack, overhand throw, planting, tugging, wide-arm alignment, gesturing channel,
  and pushing an invisible cart. Preserve each source character's distinct head,
  clothes, staff and faction palette.
- Leader motion grids: sprint, jump, fall, landing recovery, alert guard, hit recoil,
  stunned sway and collapse to prone KO.
- Modular Signifier grids: headless turquoise spiral-shirt bodies, jeans and boots;
  articulated work/combat/dance poses, followed by separate stun/jump/hit/wobble
  effects. Existing heads are composited using per-frame neck anchors; KO includes
  per-frame head rotation around the neck.
- Boss grid: preserve the source skull, tall eye-marked hat and military coat;
  render the twelve states listed above. A second image edit removed its backdrop.
- Wizard grid: preserve the purple starry hat/robe, silver beard and star-tipped
  staff; render KO, stun, jump and conversational gestures.
- Flag grid: yellow cloth, narrow brown wood pole and neutral white ownership
  ribbon, with planted, grounded, flying and carried states. A subsequent user
  correction explicitly removed every spherical finial from every flag state.
  All final poles have plain flat-cut wooden ends, with no ball ornaments.

## Coordinates and rendering

Anchors are **pixel-edge coordinates**, not pixel indices. Cell UVs use the exact
cell edges, nearest sampling and no mipmaps; each cell has transparent margins.
The lowest opaque edge is at y=124. Standing flags additionally carry
`poleTipByCell`, measured from the actual final pixels: x is the centroid of the
lowest opaque row's pixel centres, and y is that row's lower edge. This allows
half-pixel x coordinates and aligns the planted pole's bottom tip exactly to the
authoritative node centre without animation-frame drift.

Flag cloth stays yellow. The standalone white ribbon is tinted at runtime for
ownership; modular figures with baked flags use a separate ownership cue so
clothing and skin are not tinted. Only `signifier:kneel` has a baked flag among
the new action clips (`includesFlag: true`).

## Rebuild and verify

From the repository root, with Python and Pillow installed:

```sh
python scripts/tools/build_mobile_sprite_actions.py
python scripts/tools/test_mobile_sprite_actions.py
```

The pixel tests verify coverage, dimensions, binary alpha, nonempty cells, clear
margins, post-resize foot edges, real frame differences in both directions, exact
flag-tip metadata, yellow/white flag colours, absence of red extraction artifacts,
and modular head metadata. Review the resulting pages and personalized-head
composites visually as well. Runtime and browser tests are separate checks; these
pixel tests do not establish browser performance or visual integration by themselves.
