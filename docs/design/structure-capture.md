# Independent structure capture

Player/AI workshops, drum circles, wards, drug labs and modular walls/floors/ramps can be captured individually. Neutral map tents, domes, shades, porta-potties, art installations and parked vehicles can also be claimed and recaptured. Command centers, stages, the effigy, natural trees and rocks are immune.

A living rival's closed flag Survey must cover the entire actual footprint, not just its center. Circle/rotated-box structures require every touched lattice facet to belong to the same attacker's Survey. Walls use their actual inset rectangle; floors/ramps use their full lattice rhombus. Footprints touching a map/lattice boundary or hole remain immune. Standing beside a structure alone never captures it.

Capture uses the Hearth pressure constants: 6 pressure/second before modifiers, 3/second decay after the loop breaks, and a final irreversible 3-second overwrite at 100 pressure. The owner's nearby avatar contests it; nearby loyal Signifiers and working wards slow it, and attacker crystals and the Burn accelerate it. The Hearth-only outpost speed multiplier is not applied. Multiple attackers retain independent pressure; stable faction ordering breaks ties. An eliminated attacker cancels its pending overwrite.

Capture changes only the target's allegiance, not the owner's other structures or Signifiers, and never eliminates a player. Existing health, disabled status, construction progress, paid lab batch and production progress remain. Stored flags transfer allegiance. Recruitment, production, lab output and ward effects subsequently use the new owner. Disabled structures still need repair. Modular-piece repair/demolition permissions and tint follow the new owner; mixed-owner supports and collision stay geometrically unchanged.

Neutral scenery gains ownership/capture markers, not invented production or recruitment powers. Original prop models, footprints, collision and destruction stay unchanged. Destroyed props lose their ownership markers and cannot be recaptured.

Capture rings, pressure arcs, enclosing beams and critical-flag reticles show the same pressure stages as Hearths. Ownership and capture state replicate to existing clients and late joiners. Multiplayer protocol 16 requires matching hosts and clients. AI avatars defend visible structure sieges by pulling critical loop flags, while Hearth defense retains priority.

The boss alliance cancels pending captures and prevents allied theft during the encounter. Existing Hearth camp conversion and elimination rules remain unchanged.
