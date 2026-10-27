# Startup intro and cache-aware loading

The HTML contains the loading shell before the game JavaScript or fonts are downloaded.
The small startup entry loads the game separately and starts a self-hosted intro alongside it
on cold starts. It does not embed YouTube or contact a video provider.

## Playback and readiness

- The intro starts muted, inline. **Sound on**, when the source has audio, affects only the video, not saved game settings.
- The button says **Loading…** and is disabled while the title scene is being prepared.
- A successful rendered title frame changes the button to **Skip**. Readiness does not cut the
  video short: it plays to the end unless the player skips it.
- If the video finishes before the game is ready, its last frame stays behind **Loading…**
  until the same readiness signal arrives.
- Failed/blocked playback or an eight-second media stall drops the video and waits only for
  the game. A game startup failure offers **Reload** instead of exposing a broken scene.
- The title world is prepared but its simulation, controls, controller menu navigation and
  game audio do not run behind the intro. GPU redraws stop after the first successful frame.
  Ending the intro resets held input before resuming the title. No real match starts silently.

Loading labels describe actual work (code, fonts, title scene), not fabricated percentages.
Title readiness is not a promise that every later match-specific asset is already loaded;
for example, the optional boss model is not necessary for the title screen.

## Cached starts

A previous visit is not sufficient to skip the intro. After a successful startup and settled
fonts, the page remembers the exact source-build SHA and successfully loaded same-project
JS/CSS/font/image URLs. This is metadata only, not a service-worker or application asset cache.

Before the next game import, the startup entry probes every recorded URL with browser
`fetch` using `cache: 'only-if-cached'` and `mode: 'same-origin'`. A warm result requires every
response and its body to be available; there is no network fallback. A different build,
partial eviction, unavailable storage/API, malformed record or 250 ms verification timeout
keeps the ordinary cold-start flow. Unsupported resource-timing metadata also fails safely
back to cold starts. Cached video availability is irrelevant: a verified warm startup never
assigns a video source or requests video bytes.

Even cached code must initialize its scene and GPU. Warm starts retain the minimal loader
until the same actual-render readiness signal arrives. There is no service worker to keep
old HTML or an old game release alive.

## Media replacement

The optional source is selected in `web/src/startup/media.ts`. Import a compressed H.264/AAC
MP4 with `?url` so Vite fingerprints its filename; retain `playsinline`, muted autoplay and
fast-start MP4 metadata. Keep the whole approved source duration. A missing source may remain
`null` during local preparation, which uses normal loading without requesting a nonexistent
video. Do not publish a missing or synthetic test fixture as a finished intro.

The supplied original intro is deferred until a playable source is supplied.
The current replacement is a temporary 25-second montage captured from the actual unmodified
production game at `2938df043f50bb798362e3e6b04e63009cb9767b`, staged with offline test controls
and cinematic camera framing. It is not AI-generated footage or a recording of a live player.
The 5.70 MB MP4 is 1280×720, 30 fps, H.264/yuv420p with fast-start metadata. All footage runs
at 1.2× speed. It has no audio, so the Sound button is intentionally hidden. All boss footage
has been removed; the ending shows a nighttime contested altar with boss mode disabled.
That safe final frame remains visible if loading takes longer than the video.
Provenance, capture run, encoding and SHA-256 are recorded in
`web/src/startup/assets/gameplay-intro-provenance.json`. The original intro remains deferred.

## Validation and release

Tests cover cache-only verification, new builds/eviction/storage failures, full-playback and
skip gating, autoplay/media failures, readiness versus shader warmup, frozen game/audio and
held-controller handoff. `scripts/verify-pages-build.cjs` checks project-subpath asset URLs,
the initial shell and a lightweight entry separate from deferred game code/styles.
The release workflow tests that exact built artifact in stock Chrome on macOS with its native
Metal renderer, without browser security or GPU-blocklist overrides. Browser evidence covers
cold/real warm cache, partial eviction, blocked/failed media and video ending before readiness.

The existing coordinated Pages/Windows-host release workflow remains required: both use the
same exact source SHA, and the matching host must be published before the updated Pages
client. Do not update the unrelated offline-launcher feed as part of this feature.
