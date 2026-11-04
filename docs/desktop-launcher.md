# FLAGHACK solo desktop launcher (deprecated)

**The offline single-player Windows launcher is deprecated.** For current play, open the
[browser game](https://elmorei.github.io/flaghack-infinity-3d/). For multiplayer hosting, use the
separate [Windows match host](pages-and-host.md), which is not deprecated.

## What this means for existing players

- New players should use the browser game rather than install the solo launcher.
- Existing installations can still play their bundled or verified cached game offline.
  Deprecation does not uninstall the app, delete downloaded builds, reset preferences, or
  remove Training Burn progress. Browser storage is separate; progress is not automatically
  transferred to the browser.
- Published versioned installers, blockmaps, update manifests, and game bundles are retained
  for compatibility. This deprecation notice does not freeze or redirect the update feeds,
  increase bundle limits, or change the launcher's security boundary.
- The in-game notice reaches installed launchers when players install a compatible game-content
  update. A launcher-window notice is also included in source for future maintenance builds;
  this change does not require or publish a replacement installer.

The implementation and maintenance reference below describes the legacy launcher. It is not
an installation recommendation or a promise of future feature updates. Any future feed
retirement must be explicit and preserve the last working assets and existing local data.

## Legacy update paths

The Windows x64 Electron launcher has two independent update paths:

1. **Game content:** follows the selected `main` or `iteration` branch's actual
   commit. Downloads prebuilt browser assets without replacing Electron.
2. **Launcher runtime:** uses the existing full-app NSIS update feed. It updates
   Electron and launcher code only after an explicit install/restart confirmation.

Players need neither Git nor Node/npm. No source code is built on their machine.
Choosing main gameplay does not change an iteration launcher's binary release
channel or prevent it from receiving its next runtime update.

## Game updates and offline play

- Startup, branch selection, and **Check branch** check the selected branch's
  latest GitHub commit. The UI displays the selected branch, playable commit,
  source (cached/previous/bundled), and check result.
- A game update is offered only when the published bundle matches that exact tip.
  If CI has not finished, its build failed, or the feed is older, the UI reports
  a pending build rather than claiming the game is current.
- **Update game** downloads the matching bundle, verifies its compressed hash,
  per-file sizes/hashes and resource references, stages it in a new directory,
  then atomically replaces the small active pointer. No live files are overwritten.
- The branch is checked again before activation. If it moved during download,
  the current game remains selected and the user is asked to check again.
- Close the game before updating, restoring, or switching branches. Play remains
  independent of successful internet access or an update check.
- Each branch has its own cache. If a selected branch has no verified cached
  build, the UI explicitly labels the playable bundled fallback's actual branch.
  It does not pretend that bundled iteration content is a downloaded main build.
- A previous verified cached build is retained and can be restored. A new build
  that fails to initialize returns to the previous verified build or bundled
  fallback. Saved game preferences live outside the content cache and are kept.
- Incomplete or corrupt downloads do not replace the active pointer. Cached
  files are rehashed before Play. These checks protect transfer/storage integrity;
  they are not a publisher signature or protection from a compromised repository.

The desktop path is **offline single-player**. A small fixed loopback static
server serves browser assets and answers `/api/info` with 404. It does not run a
new client against an old multiplayer server. Browser/LAN hosting elsewhere in
the repository is unchanged; downloaded bundles cannot replace or execute Node
server code.

## Security boundary

Renderer sandboxing, context isolation, disabled Node integration, restricted
navigation/new windows, and validated IPC remain enabled. The game renderer can
request only its local static assets and narrowly scoped game preference storage.
Downloaded HTML receives a restrictive CSP. It cannot choose update URLs, run
shell commands, or access arbitrary filesystem paths.

Game requests start only at the approved repository's GitHub/API paths over
HTTPS. Redirects are restricted to GitHub and its release-asset hosts. Manifests
must name the expected branch and a full commit SHA, the exact immutable bundle
filename, supported runtime API 1, byte count, and SHA-256.

Bundle limits bound compressed/decompressed size, file size/count, and total
content. Validation rejects traversal, Windows reserved names, case-folding
collisions, symlinks, nonregular files, missing referenced resources, and remote
HTML/CSS resources. Only index.html, LICENSES.txt, and assets/audio/models trees
are accepted. Models/audio attribution files and dependency licenses are retained.

## Game-bundle publication

The three CI/support files needed on **each branch** are:

- `.github/workflows/game-bundles.yml`
- `.github/scripts/build-game-bundle.cjs`
- `web/desktop/game-bundle.cjs` (the shared data-format validator; no gameplay)

Installing those CI files on main does not merge iteration gameplay or launcher
code into main. The packer and shared validator need only that branch's existing
`web/package-lock.json`, `npm test`, `npm run build`, and runtime asset licenses.

A push to main or iteration builds that exact commit on Linux, runs game tests
with at most two workers to bound memory use,
creates and validates an immutable browser bundle, and uploads a CI artifact. A separate
publisher job has `contents: write`; the build job has read-only repository
access and no persisted checkout credential. No added credential or signing key
is required. The publisher verifies artifact identity/hash, checks the current
branch tip, uploads the immutable bundle, then publishes the small manifest last.
It never advertises a build already known to be behind the branch.

| Branch | Release tag | Manifest | Immutable payload |
| --- | --- | --- | --- |
| main | game-main | latest.json | game-main-`<40-char SHA>`.json.gz |
| iteration | game-iteration | latest.json | game-iteration-`<40-char SHA>`.json.gz |

Feed roots are `https://github.com/elmorei/flaghack-infinity-3d/releases/download/game-main/`
and the corresponding `game-iteration/` URL. Repository releases must be publicly
readable; no repository token is embedded in the launcher. A successful workflow
publication is required before a matching tip can be downloaded. Updating the
manifest is not an atomic GitHub operation; a temporary gap leaves old local
content usable and cannot activate a partial bundle.

The publisher keeps old immutable payloads. Do not delete versions that clients
may still be downloading. Publication permission covers the configured branch
assets and purpose; it is not general permission to publish unrelated content.

## Local development and Windows packaging

From `web/`, using Node 24:

```powershell
npm ci
npm run desktop:test
npm test
npm run desktop:dev
```

`desktop:build` typechecks/builds the Vite game and records the bundled branch and
commit. Git is needed only for this build-time metadata step. `desktop:package`
then packages Windows x64 NSIS with `--publish never`. Its outputs are the installer,
`.exe.blockmap`, and the binary channel's generated YAML under `desktop-release/`.

```powershell
$env:FLAGHACK_CHANNEL = 'iteration'
npm version 0.1.2-iteration.1 --no-git-tag-version --allow-same-version
npm run desktop:package
```

The installed binary updater keeps its existing `desktop-iteration/iteration.yml`
or `desktop-stable/latest.yml` feed, separate from game content. It requires a
higher SemVer, never automatically downgrades, downloads only when requested, and
installs only after explicit confirmation. Closing the launcher does not install
an update. Failed checks/downloads leave the installed application intact; this is
not a guarantee of rollback after Windows installation has begun.

Unsigned executables can trigger SmartScreen/antivirus warnings. No signing is
configured, and protections must not be disabled. A loose unpacked app is not a
substitute for validating the installed NSIS update path.

## Authorized Windows build trigger

The prepared Windows workflow preserves manual channel/version inputs and its
read-only repository permission. For the current authorized build, an iteration
push runs the Windows job only when the head commit message exactly matches:

`Update selected-branch launcher [desktop-build:0.1.2-iteration.1:20261012]`

This path checks out that immutable event SHA and fixes the build to iteration
version `0.1.2-iteration.1`. Ordinary pushes skip this job. Both this workflow and
the game-bundle workflow run the game test suite with `--maxWorkers=2` to avoid
unbounded worker memory use. Installer/feed publication remains a separate step.

## Acceptance checks

Automated tests cover real binary-updater HTTP/checksums, selected-branch game
updates, cache activation/rollback, corruption and interrupted downloads, unsafe
paths/symlinks, moving tips, offline fallback, static-server confinement, IPC,
startup failure, and install races. These do not alone certify Windows behavior.

Before declaring a release validated:

- Install on Windows, launch offline, verify rendering/audio/input and preferences.
- Verify both live branch feeds match their actual latest commits and download.
- Switch branches with cached content and verify the displayed/played commit.
- Simulate failed checks, corrupt payload, interrupted transfer, and startup failure.
- Download the next NSIS runtime update, cancel once, then confirm restart and
  verify the new version with game caches/preferences preserved.

## References

- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
- [electron-builder v26 updates](https://www.electron.build/v26/docs/features/auto-update/)
- [GitHub workflow triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
