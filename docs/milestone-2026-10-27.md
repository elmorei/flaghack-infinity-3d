# October 27 working milestone

This checkpoint combines the spoiler-free 25-second loading intro, taller structure-destruction flame poof, capturable functional/modular/neutral structures, and persistent material-scaled wreckage. It is not a main release or launcher feed update.

- Intro bypasses verified cached loads; otherwise Loading changes to Skip when ready. No boss footage.
- Fireball height is 1.45 times the approved original; damage and collision are unchanged.
- Capture uses full-footprint flag enclosure. Command centers, stages and unsurroundable structures remain immune. Ordinary capture never eliminates a player.
- Cosmetic rubble persists after boss destruction, with deterministic snapshots and bounded dynamic history. Existing wrecks/craters remain; eating and dismantling do not leave new debris.
- Multiplayer protocol 16 combines both new wire fields. Host and client must use the same build.

The separately reviewed one-second boss camera-lock correction is intentionally excluded. Main, iteration and its review branch are unchanged. Verification workflow is test-only and cannot publish artifacts as a release or deploy Pages.

Source checkpoints: intro cd5a567, structure capture 7510f4e, taller fireball 745f6af, wreckage b8b314a.
