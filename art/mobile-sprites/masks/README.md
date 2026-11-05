# Exposed-skin masks

`atlas-skin.webp` is an authored, atlas-aligned, binary selection for the original
modular Signifiers. White means exposed skin. Black means protected artwork. It
covers all 18 heads in both directions, every body row and walking frame, and the
rear flag foreground hand. It does not change the six unique cast characters.

Every cell was inspected with the selected pixels highlighted. The face masks
exclude eyes, mouths, hair, facial hair, hats, glasses and flowers. Body masks
exclude clothing, boots, tools, lumber, drums and flags. Dark drawn outlines stay
unchanged. Tan bucket and top-hat brims and drum surfaces were explicitly excluded
with spatial selection boundaries rather than a whole-image colour rule.

The reviewed selection is the build input, not a runtime colour heuristic. The
mask is packed into the original texture's unused alpha values: 192 means skin,
255 means other opaque art, and 0 remains transparent. The existing cutout shader
still renders surviving pixels fully opaque. RGB, silhouettes, anchors and UVs
are unchanged, and there is no additional runtime mask texture.

`atlas-skin.json` pins the source RGB, cutout and mask hashes and the selected
pixel counts for every cell. Changes to the source or mask require renewed visual
review. The original atlas builder applies the checked-in mask automatically.
The runtime manifest uses a SHA256-versioned image filename so stale browser
textures cannot hide a new skin mask. `atlas.webp` remains the authoring alias;
its bytes are identical to the versioned runtime image.

Run the independent checks from the repository root:

```sh
python scripts/tools/test_mobile_sprite_skin.py
```

The runtime selects the existing six model skin tones and applies them to these
marked pixels only. Runtime shader and browser tests cover tone selection and
the rendered result separately from these source-pixel checks.
