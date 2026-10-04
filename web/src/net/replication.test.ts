import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createAi } from '../ai';
import type { AiController } from '../ai';
import { SIM_HZ, TIDE_WARNING } from '../sim/constants';
import { spawnFlag, spawnHippie } from '../sim/factory';
import { planEnclosure } from '../sim/lattice/planner';
import { normalizeMatch } from '../sim/matchSettings';
import { createMatch } from '../sim/setup';
import { Simulation } from '../sim/simulation';
import { canPlaceBuilding } from '../sim/systems/buildings';
import { captureHearth } from '../sim/systems/capture';
import { econ } from '../sim/systems/econ/state';
import { canPlantAt, depositToStock, isBuildingCorner, plantFlag } from '../sim/systems/flags';
import { canBuildPiece, piecePosition } from '../sim/systems/pieces';
import { applyFlip } from '../sim/systems/tides';
import { FACTION_IDS } from '../sim/types';
import type { FactionId, MatchOptions, Piece, PieceKind } from '../sim/types';
import type { World } from '../sim/world';
import { SnapshotEncoder } from './codec';
import type { FullSnapshot } from './codec';
import { NetMirror } from './mirror';
import type { StateFrame } from './protocol';
import { CODECS, encodeRow, ENTITY_KINDS, FACTION_FIELDS, SURVEY_ARRAYS, WORLD_FIELDS, wireEqual } from './schema';

/** What the WebSocket delivers: the JSON text, parsed again. */
function overTheWire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function optionsFor(seed: string): MatchOptions {
  return { seed, difficulty: 'normal', humans: [], mode: 'standard' };
}

/** The host loop as HostServer runs it: AI, two sim ticks, one frame of everything drained. */
class Host {
  readonly world: World;
  readonly sim: Simulation;
  readonly ai: AiController;
  readonly encoder: SnapshotEncoder;
  /** Wall time spent in SnapshotEncoder.delta() per frame (ms). */
  readonly encodeMs: number[] = [];

  constructor(readonly options: MatchOptions) {
    this.world = createMatch(options);
    this.sim = new Simulation(this.world);
    this.ai = createAi(this.world, FACTION_IDS);
    this.encoder = new SnapshotEncoder(this.world);
  }

  /** `hook(0|1)` runs before each tick, `hook(2)` after the second; returns the frame as received. */
  frame(hook?: (at: number) => void): StateFrame {
    for (let i = 0; i < 2; i++) {
      hook?.(i);
      this.ai.update();
      this.sim.step();
    }
    hook?.(2);
    const w = this.world;
    const events = w.drainEvents();
    const t0 = performance.now();
    const delta = this.encoder.delta(events);
    this.encodeMs.push(performance.now() - t0);
    return overTheWire({ tick: w.tick, time: w.time, acks: {}, delta, events });
  }
}

/** Has the lattice re-tiled the slot under this piece (it falls on the host's next tick)? */
function doomed(world: World, p: Piece): boolean {
  const info = econ(world).pieceInfo.get(p.id);
  if (!info) return true;
  const lat = world.lattice;
  if (p.kind === 'wall') {
    const e = lat.edges[p.edge];
    return !((e.a === info.nodes[0] && e.b === info.nodes[1]) || (e.a === info.nodes[1] && e.b === info.nodes[0]));
  }
  return info.nodes.some((n) => !lat.facets[p.facet].nodes.includes(n));
}

/** Collision and nav answers the client relies on, probed at one spot. */
function probe(world: World, x: number, y: number, z: number): string {
  const hit = world.collision.raycast(x, y + 6, z, 0, -1, 0, 12);
  const hitText = hit ? `${hit.tag}@${hit.y.toFixed(4)}` : 'miss';
  const blocked = world.collision.blockedCircle(x, z, 0.3, Math.max(0, y - 0.5), y + 0.5);
  return `${hitText} ${blocked} ${world.nav.isWalkable(x, z)}`;
}

/** Every replicated difference between the host world and a mirror (empty: equal). */
function differences(host: World, mirror: World, opts: { doomedPieces: boolean }): string[] {
  const out: string[] = [];
  const note = (s: string): void => {
    if (out.length < 25) out.push(s);
  };
  if (host.tick !== mirror.tick || host.time !== mirror.time) note(`clock: host ${host.tick}/${host.time}, mirror ${mirror.tick}/${mirror.time}`);

  for (const kind of ENTITY_KINDS) {
    const codec = CODECS[kind];
    const mirrorIds = new Set(codec.ids(mirror));
    let count = 0;
    for (const id of codec.ids(host)) {
      count++;
      if (!mirrorIds.has(id)) {
        note(`${kind} ${id} missing on the mirror`);
        continue;
      }
      const a = codec.row(host, id);
      const b = codec.row(mirror, id);
      a.forEach((v, i) => {
        if (!wireEqual(v, b[i])) note(`${kind} ${id} ${codec.keys[i]}: host ${JSON.stringify(v)} mirror ${JSON.stringify(b[i])}`);
      });
    }
    if (count !== mirrorIds.size) note(`${kind}: ${count} on the host, ${mirrorIds.size} on the mirror`);
  }

  host.factions.forEach((f, i) => {
    const a = encodeRow(FACTION_FIELDS, f, host);
    const b = encodeRow(FACTION_FIELDS, mirror.factions[i], mirror);
    a.forEach((v, k) => {
      if (!wireEqual(v, b[k])) note(`faction ${i} ${FACTION_FIELDS[k].key}: host ${JSON.stringify(v)} mirror ${JSON.stringify(b[k])}`);
    });
  });
  const ws = encodeRow(WORLD_FIELDS, host, host);
  const wm = encodeRow(WORLD_FIELDS, mirror, mirror);
  ws.forEach((v, k) => {
    if (!wireEqual(v, wm[k])) note(`world ${WORLD_FIELDS[k].key}: host ${JSON.stringify(v)} mirror ${JSON.stringify(wm[k])}`);
  });

  const hs = host.survey;
  const ms = mirror.survey;
  if (hs.version !== ms.version) note(`survey version ${hs.version} vs ${ms.version}`);
  if (!wireEqual(hs.surveySize, ms.surveySize)) note(`survey sizes ${hs.surveySize} vs ${ms.surveySize}`);
  if (!wireEqual(hs.focusNodes, ms.focusNodes)) note('focus nodes differ');
  for (const spec of SURVEY_ARRAYS) {
    const a = spec.get(hs);
    const b = spec.get(ms);
    for (let i = 0; i < a.length; i++) {
      if (Math.round(a[i] * spec.scale) !== Math.round(b[i] * spec.scale)) {
        note(`survey ${spec.key}[${i}] ${a[i]} vs ${b[i]}`);
        break;
      }
    }
  }

  const hl = host.lattice;
  const ml = mirror.lattice;
  if (hl.version !== ml.version) note(`lattice version ${hl.version} vs ${ml.version}`);
  hl.nodes.forEach((n, i) => {
    const m = ml.nodes[i];
    if (n.x !== m.x || n.z !== m.z || n.blocked !== m.blocked || !wireEqual(n.edges, m.edges)) note(`lattice node ${i} differs`);
  });
  hl.edges.forEach((e, i) => {
    if (e.a !== ml.edges[i].a || e.b !== ml.edges[i].b) note(`lattice edge ${i} differs`);
  });
  hl.facets.forEach((f, i) => {
    if (!wireEqual(f.nodes, ml.facets[i].nodes)) note(`lattice facet ${i} differs`);
  });

  for (const b of host.buildings.values()) {
    const a = probe(host, b.pos.x, 1, b.pos.z);
    const m = probe(mirror, b.pos.x, 1, b.pos.z);
    if (a !== m) note(`building ${b.id} (${b.kind}) collision/nav: host ${a} mirror ${m}`);
  }
  for (const p of host.pieces.values()) {
    if (!opts.doomedPieces && doomed(host, p)) continue;
    const at = piecePosition(host, p);
    const mp = mirror.pieces.get(p.id);
    if (!at || !mp) continue;
    const a = probe(host, at.x, at.y, at.z);
    const m = probe(mirror, at.x, at.y, at.z);
    if (a !== m) note(`piece ${p.id} (${p.kind} L${p.level}) collision/nav: host ${a} mirror ${m}`);
  }
  return out;
}

/** A mirror kept in lock-step with the host (every frame applied at once, as headless tools do). */
class LockstepClient {
  readonly mirror: NetMirror;
  readonly applyMs: number[] = [];

  constructor(options: MatchOptions, snapshot: FullSnapshot) {
    this.mirror = NetMirror.create(options, overTheWire(snapshot));
  }

  /** Apply one frame; returns the events the mirror re-emitted. */
  take(frame: StateFrame): string {
    const t0 = performance.now();
    this.mirror.push(frame);
    this.mirror.catchUp();
    this.applyMs.push(performance.now() - t0);
    return JSON.stringify(this.mirror.world.drainEvents());
  }
}

/** First piece slot of `kind` near the faction's vexillomancer the sim would accept now. */
function buildSlot(world: World, f: FactionId, kind: PieceKind, level: number, accept?: (edgeOrFacet: number) => boolean): { edge: number; facet: number; rampEdge: number } | null {
  const lat = world.lattice;
  const av = world.avatarOf(f);
  if (kind === 'wall') {
    const near = lat.nodesInRadius(av.pos.x, av.pos.z, 10);
    for (const n of near) {
      for (const e of lat.nodes[n].edges) {
        if (accept && !accept(e)) continue;
        if (canBuildPiece(world, f, 'wall', e, -1, level, -1).ok) return { edge: e, facet: -1, rampEdge: -1 };
      }
    }
    return null;
  }
  for (const facet of lat.facetsInRadius(av.pos.x, av.pos.z, 12)) {
    if (accept && !accept(facet)) continue;
    const rampEdge = kind === 'ramp' ? 0 : -1;
    if (canBuildPiece(world, f, kind, -1, facet, level, rampEdge).ok) return { edge: -1, facet, rampEdge };
  }
  return null;
}

function build(world: World, f: FactionId, kind: PieceKind, level: number, slot: { edge: number; facet: number; rampEdge: number }): void {
  world.submit({ t: 'build', faction: f, kind, edge: slot.edge, facet: slot.facet, level, rampEdge: slot.rampEdge });
}

/** A flippable corner of `facet` that no rule protects (not under a building, no zone). */
function flippableCorner(world: World, facet: number): number {
  const lat = world.lattice;
  for (const n of lat.facets[facet].nodes) {
    if (!lat.flippable(n) || isBuildingCorner(world, n)) continue;
    let zoned = false;
    for (const z of world.zones.values()) {
      if (z.kind === 'stabilize' && (lat.nodes[n].x - z.pos.x) ** 2 + (lat.nodes[n].z - z.pos.z) ** 2 <= z.radius * z.radius) zoned = true;
    }
    if (!zoned) return n;
  }
  return -1;
}

/** Strip a camp's home ring into its stock and close a planner loop of `attacker` Flags around its Hearth. */
function stageSiege(world: World, attacker: FactionId, victim: FactionId): void {
  const hearth = world.hearthOf(victim);
  if (!hearth || !world.factions[attacker].alive) return;
  for (const fl of Array.from(world.flags.values())) {
    if (fl.state === 'planted' && fl.owner === victim) depositToStock(world, fl.id, hearth.id);
  }
  const loop = planEnclosure(world.lattice, {
    x: hearth.pos.x,
    z: hearth.pos.z,
    minRadius: 9,
    cost: (n) => (canPlantAt(world, n, attacker) ? 1 : Infinity),
  });
  for (const node of loop ?? []) {
    const n = world.lattice.nodes[node];
    const fl = spawnFlag(world, { state: 'loose', owner: attacker, pos: { x: n.x, y: 0, z: n.z } });
    plantFlag(world, fl.id, node, attacker, -1);
  }
}

describe('replication', () => {
  it('replicates sprint-to-throw pose intent with customized match settings', () => {
    const options = { ...optionsFor('throw-mode-wire'), match: normalizeMatch({ jumpHeight: 2, maxSignifiers: 3 }) };
    const world = createMatch(options);
    const sim = new Simulation(world);
    const input = { moveX: 0, moveZ: 1, jump: false, sprint: true, throwMode: false, yaw: 0, pitch: 0 };
    world.submit({ t: 'avatarInput', faction: 0, input });
    sim.step();
    const encoder = new SnapshotEncoder(world);
    const client = new LockstepClient(options, encoder.full());
    expect(client.mirror.world.options.match).toEqual(options.match);
    expect(client.mirror.world.avatarOf(0).input.sprint).toBe(true);
    expect(differences(world, client.mirror.world, { doomedPieces: false })).toEqual([]);
    world.drainEvents();

    world.submit({ t: 'avatarInput', faction: 0, input: { ...input, throwMode: true } });
    sim.step();
    const events = world.drainEvents();
    client.take(overTheWire({ tick: world.tick, time: world.time, acks: {}, delta: encoder.delta(events), events }));
    expect(client.mirror.world.avatarOf(0).input).toMatchObject({ sprint: false, throwMode: true });
    expect(differences(world, client.mirror.world, { doomedPieces: false })).toEqual([]);
  });

  for (const seed of ['net-a', 'net-b']) {
    it(`keeps mirrors equal to the host through a scripted burn (${seed})`, () => {
      // This long scripted scenario relies on the original AI routes with building corners reserved.
      const host = new Host({ ...optionsFor(seed), match: normalizeMatch({ structuresBlockFlagPlacement: true }) });
      const w = host.world;
      const client = new LockstepClient(host.options, host.encoder.full());
      expect(differences(w, client.mirror.world, { doomedPieces: true })).toEqual([]);
      let late: LockstepClient | null = null;

      const seconds = 240;
      const frames = (seconds * SIM_HZ) / 2;
      let built = 0;
      let pieceHere: { piece: number; facet: number } | null = null;
      let flippedUnderPiece = false;
      const seen = new Set<string>();
      for (let i = 0; i < frames && w.phase === 'playing'; i++) {
        const t = w.time;
        let hook: ((at: number) => void) | undefined;
        if (t >= 30 && built < 6 && i % 15 === 0) {
          // Walls, decks and ramps around faction 0's vexillomancer, then a wall on a wall.
          w.factions[0].lumber += 100;
          const kinds: [PieceKind, number][] = [
            ['wall', 0],
            ['floor', 0],
            ['ramp', 0],
            ['wall', 0],
            ['floor', 0],
            ['wall', 1],
          ];
          const [kind, level] = kinds[built];
          const slot = buildSlot(w, 0, kind, level);
          if (slot) build(w, 0, kind, level, slot);
          built++;
        }
        if (t >= 40 && !flippedUnderPiece && i % 5 === 0) {
          // A deck built on the frame's second tick, then a flip under it before the frame
          // goes out: its shapes stand on the lattice as it was when the deck went up.
          w.factions[0].lumber += 100;
          const slot = buildSlot(w, 0, 'floor', 0, (facet) => flippableCorner(w, facet) >= 0);
          if (slot) {
            hook = (at) => {
              if (at === 1) build(w, 0, 'floor', 0, slot);
              if (at === 2) {
                const node = flippableCorner(w, slot.facet);
                const piece = Array.from(w.pieces.values()).find((p) => p.facet === slot.facet && p.kind === 'floor');
                if (node >= 0 && piece && applyFlip(w, node, 'ability')) {
                  pieceHere = { piece: piece.id, facet: slot.facet };
                  flippedUnderPiece = true;
                }
              }
            };
          }
        }
        if (t >= 45 && t < 45 + 1 / 30 + 1e-9) {
          const victim = Array.from(w.pieces.values()).find((p) => p.faction === 0);
          if (victim) w.submit({ t: 'demolish', faction: 0, pieceId: victim.id });
        }
        if (t >= 50 && t < 50 + 1 / 30 + 1e-9) {
          for (const f of FACTION_IDS) {
            w.factions[f].lumber += 300;
            const hearth = w.hearthOf(f);
            if (!hearth) continue;
            const facet = w.lattice
              .facetsInRadius(hearth.pos.x, hearth.pos.z, 14)
              .find((fc) => canPlaceBuilding(w, f, 'ward', fc).ok);
            if (facet !== undefined) w.submit({ t: 'placeBuilding', faction: f, kind: 'ward', facet });
          }
        }
        if (t >= 60 && t < 60 + 1 / 30 + 1e-9) w.tide.nextAt = w.time + TIDE_WARNING + 1;
        if (t >= 90 && t < 90 + 1 / 30 + 1e-9) stageSiege(w, 2, 1);
        if (t >= 150 && t < 150 + 1 / 30 + 1e-9) {
          const hearth = w.hearthOf(3);
          if (hearth && w.factions[0].alive) captureHearth(w, hearth, 0);
        }

        const frame = host.frame(hook);
        for (const e of frame.events) seen.add(e.t);
        expect(client.take(frame)).toBe(JSON.stringify(frame.events));
        if (late) expect(late.take(frame)).toBe(JSON.stringify(frame.events));
        if (pieceHere && w.pieces.has(pieceHere.piece)) {
          // The doomed deck is still standing this frame: its collision must match exactly.
          expect(differences(w, client.mirror.world, { doomedPieces: true })).toEqual([]);
          pieceHere = null;
        }
        if (!late && w.time >= 170) {
          late = new LockstepClient(host.options, host.encoder.full());
          expect(differences(w, late.mirror.world, { doomedPieces: false })).toEqual([]);
        }
        if (i % 60 === 0) {
          expect(differences(w, client.mirror.world, { doomedPieces: true })).toEqual([]);
          if (late) expect(differences(w, late.mirror.world, { doomedPieces: false })).toEqual([]);
        }
      }
      expect(differences(w, client.mirror.world, { doomedPieces: true })).toEqual([]);
      expect(late).not.toBeNull();
      if (late) expect(differences(w, late.mirror.world, { doomedPieces: false })).toEqual([]);
      // The script really exercised what it claims.
      expect(flippedUnderPiece).toBe(true);
      expect(w.lattice.version).toBeGreaterThan(10);
      expect(w.factions[3].alive).toBe(false);
      for (const t of ['pieceBuilt', 'pieceDestroyed', 'buildingPlaced', 'phasonFlip', 'tide', 'captured', 'eliminated', 'flagPlanted', 'flagPulled']) {
        expect(seen.has(t), t).toBe(true);
      }
    });
  }
});

describe('mirror playback', () => {
  it('plays frames a little behind the host, blends remote motion, holds through stalls, spares the predicted avatar', () => {
    const host = new Host(optionsFor('net-play'));
    const w = host.world;
    let now = 10_000;
    const mirror = NetMirror.create(host.options, overTheWire(host.encoder.full()), () => now);
    const m = mirror.world;

    // The host's motion at every frame time (wire precision), for checking the blend.
    type Pose = { x: number; z: number };
    const poses = new Map<number, Map<number, Pose>>();
    const snapshotPoses = (): Map<number, Pose> => {
      const out = new Map<number, Pose>();
      const cm = (v: number) => Math.round(v * 100) / 100;
      for (const h of w.hippies.values()) out.set(h.id, { x: cm(h.pos.x), z: cm(h.pos.z) });
      for (const av of w.avatars.values()) out.set(av.id, { x: cm(av.pos.x), z: cm(av.pos.z) });
      return out;
    };
    poses.set(w.time, snapshotPoses());

    // 6 s of frames sent every 1/30 s, arriving after 40 ms plus up to 16 ms of jitter, in
    // order; frames 90-104 are held up and arrive in one burst (a 0.5 s stall).
    const frames: { frame: StateFrame; at: number }[] = [];
    for (let k = 0; k < 180; k++) {
      const frame = host.frame();
      frame.acks = { p1: k + 1 };
      poses.set(frame.delta.time, snapshotPoses());
      let at = 10_000 + (k + 1) * (1000 / 30) + 40 + ((k * 7919) % 17);
      if (k >= 90 && k < 105) at = 10_000 + 106 * (1000 / 30) + 40;
      at = Math.max(at, frames.length > 0 ? frames[frames.length - 1].at : 0);
      frames.push({ frame, at });
    }

    const me = w.factions[0].avatarId;
    mirror.setPredicted(me);
    const mine = m.avatars.get(me);
    if (!mine) throw new Error('no avatar');
    mine.pos.x = 1234.5;

    let next = 0;
    let shown = m.time;
    let checkedBlends = 0;
    let stallHeld = 0;
    let prevHeld: Pose | null = null;
    let steady = 0;
    let steadyBlending = 0;
    const times = Array.from(poses.keys()).sort((a, b) => a - b);
    for (now = 10_000; now < frames[frames.length - 1].at + 400; now += 1000 / 60) {
      while (next < frames.length && frames[next].at <= now) mirror.push(frames[next++].frame);
      mirror.advance(now);
      expect(m.time).toBeGreaterThanOrEqual(shown);
      shown = m.time;
      expect(mine.pos.x).toBe(1234.5);
      if (next > 0) {
        const newest = frames[next - 1].frame;
        expect(mirror.latestAck('p1')).toBe(next);
        expect(mirror.latestTime()).toBe(newest.delta.time);
        const latest = mirror.latestAvatar(me);
        const hostPose = poses.get(newest.delta.time)?.get(me);
        if (latest && hostPose) expect(Math.abs(latest.pos.x - hostPose.x)).toBeLessThan(1e-6);
      }
      // Blend check: between two frames, remote hippies sit on the line between their host
      // poses at those frames.
      const ia = times.findIndex((t, i) => t <= m.time + 1e-9 && (i === times.length - 1 || times[i + 1] > m.time + 1e-9));
      const tA = times[ia];
      const tB = times[ia + 1];
      const nextQueued = next > 0 && tB !== undefined && frames.some((f, i) => i < next && f.frame.delta.time === tB);
      // Steady state (jitter only): the clock trails the newest frame, never by more than
      // 250 ms, and the next frame is already queued so motion blends instead of guessing.
      if (now > 10_500 && (next < 90 || next >= 110) && next < frames.length) {
        const lag = frames[next - 1].frame.delta.time - m.time;
        expect(lag).toBeGreaterThan(0);
        expect(lag).toBeLessThan(0.27);
        steady++;
        if (nextQueued) steadyBlending++;
      }
      if (tB !== undefined && nextQueued) {
        const a = poses.get(tA);
        const b = poses.get(tB);
        const alpha = (m.time - tA) / (tB - tA);
        for (const h of m.hippies.values()) {
          const pa = a?.get(h.id);
          const pb = b?.get(h.id);
          if (!pa || !pb || Math.hypot(pb.x - pa.x, pb.z - pa.z) > 6) continue;
          expect(Math.abs(h.pos.x - (pa.x + (pb.x - pa.x) * alpha))).toBeLessThan(0.011);
          expect(Math.abs(h.pos.z - (pa.z + (pb.z - pa.z) * alpha))).toBeLessThan(0.011);
          checkedBlends++;
        }
      }
      // Deep in the stall (nothing queued for > 0.1 s): motion holds still.
      if (next >= 90 && next < 105 && m.time === mirror.latestTime()) {
        const h = Array.from(m.hippies.values()).find((x) => x.vel.x !== 0 || x.vel.z !== 0);
        if (h && prevHeld && prevHeld.x === h.pos.x && prevHeld.z === h.pos.z) stallHeld++;
        prevHeld = h ? { x: h.pos.x, z: h.pos.z } : null;
      }
      m.drainEvents();
    }
    expect(next).toBe(frames.length);
    expect(m.tick).toBe(w.tick);
    expect(checkedBlends).toBeGreaterThan(5000);
    expect(stallHeld).toBeGreaterThan(5);
    expect(steadyBlending / steady).toBeGreaterThan(0.98);

    // Handing the avatar back to replication snaps it to the host's pose.
    mirror.setPredicted(null);
    expect(mine.pos.x).toBeCloseTo(w.avatarOf(0).pos.x, 1);
  });
});

describe('replication budget', () => {
  it('stays small and fast with four AI camps and ~150 hippies', () => {
    const host = new Host(optionsFor('net-budget'));
    const w = host.world;
    const camps = w.map.camps;
    for (let n = w.hippies.size; n < 150; n++) {
      const c = camps[n % camps.length];
      const at = w.nav.nearestWalkable(c.x + ((n * 7) % 40) - 20, c.z + ((n * 13) % 40) - 20);
      spawnHippie(w, c.faction, at);
    }
    const client = new LockstepClient(host.options, host.encoder.full());
    const bytes: number[] = [];
    const deflated: number[] = [];
    const frames = (120 * SIM_HZ) / 2;
    for (let i = 0; i < frames && w.phase === 'playing'; i++) {
      if (i === 900) w.tide.nextAt = w.time + TIDE_WARNING + 1;
      const frame = host.frame();
      const json = JSON.stringify(frame);
      bytes.push(json.length);
      deflated.push(deflateRawSync(Buffer.from(json)).length);
      client.take(frame);
    }
    expect(differences(w, client.mirror.world, { doomedPieces: true })).toEqual([]);
    // A mid-match (re)join snapshot, two minutes in.
    const full = JSON.stringify(host.encoder.full());

    const stats = (xs: number[]) => {
      const s = xs.slice().sort((a, b) => a - b);
      return { avg: s.reduce((a, b) => a + b, 0) / s.length, p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
    };
    const raw = stats(bytes);
    const z = stats(deflated);
    // Skip the first second: JIT warm-up dominates it.
    const enc = stats(host.encodeMs.slice(30));
    const app = stats(client.applyMs.slice(30));
    console.log(
      [
        `hippies ${w.hippies.size}, frames ${bytes.length}, full snapshot ${(full.length / 1024).toFixed(1)} KB (deflated ${(deflateRawSync(Buffer.from(full)).length / 1024).toFixed(1)} KB)`,
        `frame JSON bytes avg ${raw.avg.toFixed(0)} p95 ${raw.p95} max ${raw.max}; deflateRaw avg ${z.avg.toFixed(0)} p95 ${z.p95} max ${z.max}`,
        `encode ms avg ${enc.avg.toFixed(3)} p95 ${enc.p95.toFixed(3)} max ${enc.max.toFixed(3)}; mirror apply ms avg ${app.avg.toFixed(3)} p95 ${app.p95.toFixed(3)} max ${app.max.toFixed(3)}`,
      ].join('\n'),
    );
    expect(raw.avg).toBeLessThan(12 * 1024);
    // Timing targets are 1.5 ms (encode) and 1 ms (apply); asserted with headroom for slow CI.
    expect(enc.avg).toBeLessThan(3);
    expect(app.avg).toBeLessThan(2);
  });
});
