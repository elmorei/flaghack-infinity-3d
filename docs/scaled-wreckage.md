# Scaled destruction wreckage

Boss-destroyed scenery and deleted camp buildings/modular pieces leave deterministic cosmetic wreckage. It is reconstructed from authoritative state, including on late joins, rather than replaying past destruction effects.

- Scenery uses its original footprint, orientation and height. Destroyed props remain in the canonical map, so no duplicate net payload is needed.
- Deleted buildings and pieces retain bounded records (newest 512) in the replicated World. Eviction removes the same old pile on existing clients and late joins.
- Cloth structures leave folded fabric and frame scraps; metal structures leave bent plates/frame fragments; wood pieces leave broken planks; rocks leave chips. Source dimensions scale the pile, including the spread of a fallen thin wall.
- Rubble is visual only. Existing destruction clears collision and navigation exactly as before. It grants no resources and does not block rebuilding.
- Existing disabled-building/GCC wreck models and effigy/boss craters are preserved. Swallowed entities and ordinary player dismantling do not create extra material.
- Up to 32 fragments per object are drawn in three shared instanced meshes, with no debris physics or per-frame simulation.

This branch adds a protocol field and uses version 15. The independent structure-capture branch also introduces version 15; a combined release must use a coordinated newer protocol (16) and matching clients/hosts.

Actual-game proof: `web/bench/capture-structure-wreckage.mjs`, eight seconds of real boss destruction and lingering aftermath. Run in a supported Chrome/WebGL environment, not a generated/composited substitute.
