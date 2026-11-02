# Elevated platforms

Construction levels are now 6.4 m high, twice the previous 3.2 m. Decks, connecting ramps and support walls share this spacing; building, character and map dimensions are unchanged. All hand-built camp buildings fit beneath a deck one construction level above, provided their footprints and other clearance rules permit it.

Every deck has four physical corner posts reaching the actual terrain, including stacked decks. Posts retain a small inward inset so the original ground-level flag positions remain accessible. Ground Flags continue claiming these nodes normally: building or removing platforms neither raises Flags nor removes their claims.

Ramps use a straight rectangular strip between opposite facet edges, leaving the rhombus’s side corners empty. Their rendered boards, placement ghost, collision and navigation blocker follow this strip; deck footprints and construction slots remain unchanged.

Each side without an adjacent same-level deck has a ladder. Adding a neighbor hides the shared-side ladder; removing it restores the ladder. Stacked exterior ladders share their visible rails.

## Climbing

- Move toward a ladder to climb. Keyboard and gamepad use the same avatar motion logic. Touch-stick input uses that logic where avatar control is available; phones currently use the existing command-only view, so they do not offer direct ladder climbing.
- Look roughly level to step onto the next platform. Look upward while climbing to continue to a higher stacked platform.
- Move away at the platform edge to descend.
- Release movement to hold position, or jump to push off the ladder.

Climbing requires a nearby exposed ladder and respects solid obstacles and ceilings. Removing its platform restores normal falling. Knockout, stun and knockback interrupt climbing. Client prediction and the authoritative simulation derive the same ladders from replicated pieces; no separate ladder state is required.

Hippie pathfinding remains ground/ramp-based. It does not automatically plan routes up ladders.

Existing building support rules remain: an elevated camp must sit on a flat, intact deck with enough footprint and headroom. Removing a supporting deck collapses its camp; ordinary collapse releases stored Flags, while boss destruction follows existing destructive behavior.
