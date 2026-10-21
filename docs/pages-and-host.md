# Browser play and the standalone match host

The public game is a static site: https://elmorei.github.io/flaghack-infinity-3d/ .
GitHub Pages serves only the browser game. It does **not** run a match server.
Solo play runs in the browser; multiplayer stays distributed, with one player's computer
running one authoritative match. Other players need only their browser and an invite.

## Host a match (Windows x64)

1. Open the game page and choose **Download Windows host**. That link downloads the host
   built from the **same source revision** as the page. The app is separate from the existing
   offline launcher and does not replace or update it.
2. Run `Flaghack-Host-Windows-x64.exe`. It is a portable, unsigned preview, not an installer.
   Node.js and a separate cloudflared installation are not needed. Download only from this
   repository's releases; a SHA256 checksum accompanies each executable. Windows or antivirus
   software may warn about an unsigned/unfamiliar executable. Do not treat this as a signed release.
3. Choose a match name and **Experimental Cloudflare Quick Tunnel**, then start the host.
   Wait until the app has verified that its public HTTPS endpoint reaches this exact match.
4. Copy the invite and share it privately. Open the same invite yourself to play in your browser.
   The first player to join leads the lobby and starts the match. Up to four players take camps;
   additional players spectate. Empty camps are AI-controlled.
5. Keep the host app and computer running while playing. **Stop** or closing the app ends the
   match and closes the tunnel. Restarting creates a new password and a new temporary invite.

The bundled simulation runs in a separate local process. Its HTTP listener binds only to
`127.0.0.1`; the app does not open firewall ports, configure a router, install a service, request
administrator access, or execute downloaded browser-game content as Node code.

### Experimental relay limitations

Cloudflare Quick Tunnels are an experimental convenience for testing and small casual matches,
not a guaranteed production hosting service. They have no uptime/SLA guarantee, the hostname
changes when restarted, and network restrictions or provider limits can prevent a connection.
A reachable information endpoint does not guarantee acceptable gameplay latency or that a
network permits WebSockets. The provider relays your game's traffic and sees connection metadata.
No Cloudflare account, domain, login, or saved credentials are required. The app uses a pinned
Cloudflare binary and its license, verified at build time. It does not update that binary at runtime.

[Cloudflare's Quick Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

### Bring your own public HTTPS endpoint

Choose the existing-endpoint mode and enter a root HTTPS origin such as
`https://match.example.com`. You must already have a trusted reverse proxy or tunnel forwarding
that origin to `http://127.0.0.1:8787` (or the port chosen in the app), including WebSocket upgrades
for `/ws`. The app checks `/api/info` and refuses a proxy pointing at another running match.
It does not provision an account, a domain, DNS, TLS, firewall rules, or router forwarding.

The game page must use HTTPS and the host must provide HTTPS/WSS. An HTTPS Pages client cannot
connect to an insecure HTTP server. A bare LAN address is not a substitute for a public HTTPS
endpoint, although the separate developer CLI can still serve same-origin LAN games.

## Join a match

Open the invite, choose a handle, then click **Join the burn**. Alternatively paste a host HTTPS
origin or full invite into **Host address or invite**, enter the password, and join. An invite
prefills fields but never contacts the remote host until you click Join. Solo play remains available.

Invite passwords live in the URL fragment, so they are not sent to GitHub Pages in its HTTP
request. The page removes invite fields from the address bar immediately. Anyone you share the
full invite with can join; don't publish it unless you intend to open the match. Reconnection
credentials are scoped to the exact destination host and remain only in the browser tab's session
storage. A token from one host is never offered to a different host.

Both protocol and exact source build must match. If the game page has updated, reload it and
use its matching host download. If an existing match becomes incompatible with the latest page,
finish it in already-open compatible tabs or restart with the new host. There is no central game
service and no automatic executable-update mechanism.

## Troubleshooting

- **Port in use:** stop another local host or choose a different non-privileged port.
- **Tunnel failed or endpoint never becomes ready:** check connectivity and restart for a new
  temporary URL, or use an already-configured HTTPS endpoint. Share the new invite, not the old one.
- **Different match:** your endpoint forwards to another process or port. Correct that forwarding.
- **Cannot reach host / CORS:** confirm the host is still running and that the configured game-page
  origin is allowed. The app allows the configured Pages origin exactly, not arbitrary websites.
- **Different build:** reload Pages and download its matching host. The existing offline launcher's
  update feed is intentionally unrelated to this host app.
- **Disconnected during play:** the browser retries transient drops for a short period. Closing
  the host or losing the tunnel permanently requires a new match/invite; no cloud save is promised.

## Developer builds

From `web/`, use `npm ci`, `npm test -- --maxWorkers=2`, and:

- `npm run build:pages`: static `dist/`, relative assets for a Pages project path, exact `build.json`.
- `npm run host-app:build`: trusted ESM server/runtime in `dist-host/`; does not start networking.
- `npm run host-app:test`: controller, URL validation, relay lifecycle and release workflow tests.
- `npm run host-app:package`: on Windows, build the runtime, fetch/hash-check the pinned official
  cloudflared binary/license and create the portable application in `host-release/`.
- `npm run host-app:dev`: run the host app from source after its runtime is built. The experimental
  mode needs the bundled Windows tunnel binary; existing HTTPS endpoint mode does not.

For the CLI server, pass `--allow-origin https://elmorei.github.io` (repeat for other trusted
origins), or use the comma-separated `FLAGHACK_ALLOWED_ORIGINS` environment variable. The allowlist
uses origins only, never URL paths. Same-origin browser requests and native clients without an
Origin header continue to work; passwords/build checks still apply.

The `pages-host-release.yml` workflow tests and builds pull requests without publishing. On
`main`, both the static client and Windows host are built from the same commit. An immutable
`host-<full commit SHA>` release is published first; only then is that exact client deployed to
Pages. The repository's Pages source must be configured to **GitHub Actions**. Publication does
not change the offline launcher, its update feed, or its installer workflow.

Windows CI validates the package and host start/stop behavior, not a live multi-computer game or
native GPU performance. A real Windows multiplayer smoke test and a signed distribution remain
release-quality follow-ups; do not infer those from automated unit tests.
