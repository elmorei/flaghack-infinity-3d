# Flaghack Infinity

**FLAGHACK ∞ — Survey Flags** is a fast 3D 1v1v1v1 vexillomantic action-strategy game
that runs in the browser (three.js + TypeScript). You are a vexillomancer at a burn. You
throw, plant, pull and steal yellow Survey Flags on an invisible aperiodic **Ley Lattice**,
build Fortnite-speed structures, and command hippies from the **Geomantic Command Center**.
You conquer rival camps by enclosing their Flag Hearth inside your Survey until it is
**overwritten**. The last vexillomancer with a Hearth wins. Play solo against three NPC
rivals, or [host a burn](#hosting-a-multiplayer-burn) on your own machine that up to four
friends join from their browsers with a password.

> Under no conditions should you attempt to play a game that claims to be Flaghack.

## This fork

This iteration adds camp toggles, 1–5 days or Unlimited, advanced match settings, gamepad input and customizable controls. See [the fork guide](docs/fork-iteration.md).

## Play

```sh
cd web
npm install
npm run dev        # http://127.0.0.1:5173
```

`npm run build` produces a static `web/dist/` (serve it with `npm run preview`).

At the title, pick a rival difficulty (Chill / Normal / Hard / Vexillosaint) and choose
**Begin the Survey**. Your camp is at the north-west corner. Its rivals are:

- **Dr. Beelzebub Crow**: a surveyor who hunts Crystals and uses Phason Shift.
- **DJ Scarecrow**: a raider who steals Flags early.
- **President Jaguar**: a warden who hoards Flags and builds one huge enclosure.

New here? Start with the **Training Burn** on the title screen. The Vexillosaint, speaking
from your Geomantic Command Center, walks you through twelve short lessons: moving, planting
and throwing Flags, Ley Lines, the Survey, implied Flags, the turning Crystal, the Command
table, building, Crystals and chakras, defending a Hearth, the Overwrite, and recruiting
Signifiers. Each lesson awards a fragment of the **Seal of Flagistan**. Progress is saved in the
browser. The lesson panel restarts, skips or revisits any lesson; in the field, Tab frees the
cursor so you can click it. In a real burn, **Liber HH** (J) explains every rule in lore voice.

### Controls

| | |
|---|---|
| WASD / Space / Shift / Mouse | Move, jump, sprint, look (click to lock the pointer) |
| Q · RMB hold + LMB | Quick-throw a Flag · aimed throw (it plants on the node it lands near) |
| E | Plant · hold to pull · at your GCC: Command Table (hold: push the cart) |
| LMB | Swing your staff (harvest lumber, bonk rivals) or place the selected piece |
| Z / X / C / V / B | Tarp Wall / Deck / Ramp / Demolish / camp building |
| 1–5 | Chakra abilities: Priority Beacon, Forced March, Stabilize Zone, Phason Shift, Omega Pulse |
| 6 / 7 / 8 | Saffron, Luminous Dust, Acid Cop Vision |
| G / H / P / T | Rally Signifiers, send followers, D.E.G.E.N. ping, Retransmit "TAKE A SHOT" |
| Tab | Command View: select and order Signifiers, plan Surveys (N/E/P/R = Node/Enclose/Pentacle/Ring), set camp priorities |
| K / J / F1 / L / Esc | Chakras, Liber HH, help, lattice overlay, pause |

## Hosting a multiplayer burn

Up to four vexillomancers share one burn, more can watch, and NPCs take the empty camps. One
machine hosts: it runs the only simulation and serves the game. Everyone else plays in a
browser; nobody else installs anything.

### Quick start

From the repo root:

```sh
./host.sh --password saffron-pentacle-42
```

`host.sh` checks Node.js (22, or 20.19+), installs the dependencies when they are missing, builds
the client and the host, and starts it on port 8787. In `web/`, `npm run host -- --password …`
does the same. Leave out `--password` and the host makes one up from four lore words and two
digits. On start it prints:

- the local and LAN addresses;
- the password;
- a share link like `http://192.168.1.20:8787/#pw=saffron-pentacle-42`. The page fills in the
  password from the `#pw=` part, which browsers never send to the server.

| Option | |
|---|---|
| `--password <pw>` | What players type to join. `FLAGHACK_PASSWORD=…` works too. |
| `--port <n>` | HTTP + WebSocket port (default 8787). |
| `--name "<name>"` | Server name shown in the lobby (default `<hostname>'s burn`). |
| `--bind <address>` | Listen on one address only, e.g. `127.0.0.1` (default: every interface). |
| `--help` | Usage. |

Ctrl+C ends the burn: the host tells everyone before it closes. To restart without rebuilding,
run `node dist-server/main.js --password …` in `web/`.

### What friends do

1. Open the share link (or a LAN address, then type the password) and pick a handle.
2. The first four players take the camps in join order; later arrivals watch. Seats can be
   swapped in the lobby.
3. The first player to join leads. The leader picks the NPC difficulty and a seed (or a fresh
   random burn), then starts. NPCs take the empty camps.
4. If someone drops, their vexillomancer stands still for 5 seconds, then an NPC plays the camp
   until they return. A dropped connection reconnects by itself. After a page reload, choose
   Join again in the same tab: the handle is remembered, the password has to be typed again (the
   page removes it from the address bar), and the same seat comes back. During a burn, a
   spectator can take over any camp an NPC is playing.

### LAN and firewall

Anyone on the same network can use a printed LAN address. On Ubuntu with the ufw firewall
enabled, open the port first: `sudo ufw allow 8787/tcp`. Plain `http://` is fine: the game uses
nothing that browsers reserve for HTTPS.

### Over the internet

- **Port forwarding:** on your router, forward TCP 8787 to the host machine's LAN address. Then
  share `http://<your public IP>:8787/#pw=…`.
- **No port forwarding:** run a
  [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
  next to the host: `cloudflared tunnel --url http://localhost:8787`. Share the
  `https://….trycloudflare.com` address it prints, plus `#pw=…`. The page switches to secure
  WebSockets by itself.

The password is the only gate, so choose a long one when the host is reachable from the internet.
A made-up one has about 34 bits. Wrong guesses are throttled to 5 per minute per address (per /64
network for IPv6). A tunnel brings every player in from the host machine itself, so the host can
only tell them apart behind cloudflared, by the `CF-Connecting-IP` header Cloudflare sets. Through
other tunnels (`ssh -R`, bore, playit, ngrok) players share one budget of 5 wrong guesses a minute,
and a forged header buys an attacker at most 30 a minute through any one tunnel. A burn sends each
player about 30 KB/s, compressed.

### Developing against a host

`npm run dev` (port 5173) forwards `/api` and `/ws` to a host on port 8787, so a dev page can
join a local `npm run host`. `npx vitest run server` tests the host over real sockets.

### Troubleshooting

- **"Port 8787 is already in use":** another host (or another program) has the port. Stop it, or
  pass `--port 8788`.
- **Friends on the LAN can't connect:** check the firewall (`sudo ufw status`) and share the LAN
  address, not `localhost`. Guest and office Wi-Fi often isolate devices from each other.
- **"Reload the page":** the page and the host come from different builds. Reload, and the host
  serves the matching client.
- **"Too many wrong passwords":** wait a minute, then try again.
- **Node.js too old:** install Node 22, e.g. with `nvm install 22`.
- **Lag:** once a minute, the host's terminal logs tick times and frame sizes. Wired connections
  help the most.

## How it plays

- **Flags move reality.** A Flag occupies a Ley Node. When two adjacent nodes hold your
  Flags, a **Ley Line** joins them. Every facet your Ley Lines cut off from the edge of the
  burn joins your **Survey**.
- **Conquest.** Enclose a rival Hearth: Safe → Threatened → Contained → Contested (the
  owner stands at its Hearth) → Overwritten → Captured. Defenders break a loop by pulling
  any one Flag in it; the HUD marks the critical ones.
- **Signifiers** (hippies) do most of the work. They fetch, plant, chop, defend, raid and
  drum according to your Camp Priorities, and report what they're up to over their
  **D.E.G.E.N. Beacon** mesh. They form one fixed world population: knockouts respawn
  neutral. Drum Circles and the GCC recruit nearby neutrals, and handing or throwing a Flag
  recruits them directly. Recruitment may exceed camp capacity; excess recruits lose attention.
- **The Geomantic Command Center** is a pentagonal push-cart. Its live map tabletop is
  your Command View. It also does Flag Repair, automatic neutral recruitment,
  Flagellian Dialectics (convert rivals) and Flag Simulacra.
- **The Burn** comes at 14:00. The effigy burns and capture pressure escalates every two
  minutes. If more than one camp still stands at **Dawn** (30:00), the camp holding the most
  Hearths completes the Survey and wins.

### The Crystal is real quasicrystal physics

- The Ley Lattice is a genuine **Penrose rhombus tiling**, made with de Bruijn's pentagrid
  (cut-and-project from the 5-dimensional lattice Z⁵). Every node carries its 5D Ley
  coordinate, and every planted Flag chimes a note derived from it.
- **Phasons.** Every 75 s a **Phason Tide** sweeps the burn and flips hexagons of the
  tiling. Flags on flipped nodes decohere. Tides favour nodes near the edge of the
  perpendicular-space acceptance window, so the lattice heals toward perfect Penrose
  order. **Phason Shift** flips nodes on purpose.
- **Observation freezes the Crystal** (a quantum Zeno effect). Observed Flags survive
  tides. A Flag counts as observed when your vexillomancer, GCC, Hearth or Wards are
  near it, or when it has Ley Lines to two other Flags (Canon III). Finished loops are
  therefore tide-proof and half-built ones are not.
- **Superposition.** A Flag Simulacrum stands on two nodes at once until a rival comes
  close and collapses it to one.
- **The implied Flag fractal.** A free node at the exact midpoint of two of your Flags
  holds an implied Flag. This holds at edge scale and at the φ-inflated scale, so
  implications cascade to third order.
- **Crystal focus points** are the 5-fold star vertices. Holding all five neighbours (a
  **pentacle**) manifests a Crystal: Ritual income, capture pressure, and C.M.I.
- **Interference.** Overlapping Surveys build instability: moiré shimmer, Flag Psychosis,
  lightning discharges, and phason storms.

## Development

```sh
cd web
npm test               # vitest: sim rules, AI, net replication, the host over real sockets, the Training Burn course, headless all-AI matches
npm run typecheck
npm run eval:sim -- --seconds 300   # sim perf eval: p95 tick ms, all-AI match (--seed, --top N, --probes, --json)
bun bench/nav-eval.ts  # replayed nav workload benchmark
```

`web/bench/render-eval.js` is the browser render eval: p95 frame ms, JS split, draw calls,
triangles and program-variant switches. Run it from an omp JS eval cell against a hardware
GPU Chrome; see the file header. Each eval reports one score, so they plug into the
harness `/ratchet` hill-climb. In the browser console, `window.fh` stages scenarios:
`fh.advance(seconds)`, `fh.give({lumber, flags})` and `fh.encircle(faction, x, z, r)`.

### Layout (`web/src/`)

- `sim/`: pure, deterministic simulation (no DOM, no three.js). It contains `lattice/`
  (pentagrid, flips, survey geometry, loop planners), `map/`, `physics/` (2.5D
  collision), `nav/`, and `systems/` (rules called in fixed order).
- `ai/`: NPC vexillomancers. They read only what their faction could know and act only
  through `Command`s.
- `render/`: three.js presentation. It covers environment and post FX, actors
  (Flags, avatars, hippies), structures (GCC, Hearths, pieces), and the Survey layer
  plus VFX.
- `game/`: app loop (local and online drivers), input, cameras, Command View, build mode.
- `ui/`: DOM HUD and screens, including the online lobby, chat and the Training Burn mentor
  (`ui/tutorial/`).
- `audio/`: procedural WebAudio with no audio files.
- `net/`: multiplayer protocol, input validation, snapshot codec, the client's mirror world,
  playback interpolation and avatar prediction.
- `tutorial/`: the Training Burn director, course and lesson scripts.
- `../server/`: the Node host (HTTP + WebSocket on one port; lobby, authoritative match, NPC
  seats). `npm run build:server` bundles it to `web/dist-server/`.

## Docs

- `docs/design/2026-10-02-flaghack-infinity-3d.md`: the game design and build contract
  for this version. It covers every rule, number and architecture decision.
- `docs/brainstorms/2026-06-21-survey-flags-game-requirements.md`: product requirements.
- `docs/plans/2026-06-21-001-feat-survey-flags-prototype-plan.md`: the original Godot plan.
- Lore: [the Alch3my wiki](https://wiki.vexillomancy.org/index.php/Main_Page), especially
  [Geomantic Command Center](https://wiki.vexillomancy.org/wiki/Geomantic_Command_Center).

## Legacy Godot prototype

The repository root still holds the first Godot 4.6 scaffold (`project.godot`, `scripts/`,
`scenes/`, `tests/`, run with `./scripts/tools/run_gut.sh`). It is superseded by `web/`
and kept for reference; `web/.gdignore` keeps Godot from scanning the web project.
