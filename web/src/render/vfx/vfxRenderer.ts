/**
 * Event-driven VFX. GameEvents trigger one-shot bursts (Flag plants/pulls/throws, staff
 * swings and hits, splinters, KO stars, confetti, crystal glass, discharge lightning, Omega
 * Pulse shockwave + pentagram scorch, phason ripples, the OVERWRITTEN capture shockwave,
 * The Burn fireworks); persistent visuals are synced from World state every frame
 * (Stabilize domes, Priority Beacon pillars, D.E.G.E.N. ping beacons, capture vortices,
 * Forced March trails, thrown-Flag trails). Camera trauma goes to ctx.shared.shake.
 *
 * Everything is analytic and instanced: particles, rings, walls and arcs are written once
 * at spawn and animated on the GPU, persistent layers rewrite a few dozen instances per
 * frame, so the whole module costs ~10 draw calls and allocates nothing per frame.
 * Owner: RenderSurvey agent.
 */
import * as THREE from 'three';
import { ABILITY, CAPTURE, NEUTRAL_COLOR } from '../../sim/constants';
import type { EventOf, GameEvent } from '../../sim/events';
import type { Building, Hippie, Owner, Ping, Projectile, Zone } from '../../sim/types';
import type { RenderContext, RenderModule } from '../context';
import { ATLAS_RECTS, type AtlasKey } from './atlas';
import { Billboards } from './billboards';
import { Bolts } from './bolts';
import { Bursts } from './bursts';
import { ColumnStyle, Columns } from './columns';
import { Domes } from './domes';
import { Fireworks } from './fireworks';
import type { SharedUniforms } from './glsl';
import { GroundFx, RingStyle } from './groundFx';
import * as P from './palette';
import { ParticlePool } from './particles';
import { Prng, hashString } from './prng';
import { ShockWalls } from './shockWalls';
import { SwingArcs } from './swingArcs';

const TAU = Math.PI * 2;

/** Light (additive) particles: sparks, glows, stars, embers, fireworks. */
const ADD_CAPACITY = 8192;
/** Grime (alpha) particles: dust, smoke, chips, splinters, confetti. */
const GRIME_CAPACITY = 4096;

/** Draw order after the scene's own transparents: grime under light, markers last. */
const ORDER = { ground: 10, domes: 11, columns: 12, walls: 13, grime: 14, arcs: 15, bolts: 16, light: 17, boards: 18 } as const;

/** Burst "cost" allowed per frame for routine events (event floods degrade gracefully). */
const FRAME_BUDGET = 48;

const TRAIL_SLOTS = 48;
/** Spacing (m) between thrown-Flag trail points. */
const TRAIL_SPACING = 0.32;
/** Forced March speed lines per marching hippie per second. */
const MARCH_RATE = 26;
/** Capture-vortex motes per overwriting Hearth per second. */
const VORTEX_RATE = 150;
/** Priority Beacon motes per pillar per second. */
const BEACON_MOTE_RATE = 14;

const BANNERS = 6;

interface Banner {
  active: boolean;
  key: AtlasKey;
  x: number;
  y: number;
  z: number;
  born: number;
  life: number;
  height: number;
  minPx: number;
  rise: number;
  color: THREE.Color;
}

export class VfxRenderer implements RenderModule {
  private readonly ctx: RenderContext;
  private readonly shared: SharedUniforms = { uTime: { value: 0 }, uViewportH: { value: 720 }, uLight: { value: 1 } };
  private readonly rng: Prng;
  private readonly light: ParticlePool;
  private readonly grime: ParticlePool;
  private readonly ground: GroundFx;
  private readonly walls: ShockWalls;
  private readonly arcs: SwingArcs;
  private readonly bolts: Bolts;
  private readonly domes: Domes;
  private readonly columns: Columns;
  private readonly boards: Billboards;
  private readonly fireworks: Fireworks;
  private readonly fx: Bursts;
  private readonly factionColors: THREE.Color[] = [];
  private readonly neutral = new THREE.Color(NEUTRAL_COLOR);
  private readonly banners: Banner[] = [];
  // Thrown-Flag trail tracking: projectile id → last trail point (allocation-free table).
  private readonly trailId = new Float64Array(TRAIL_SLOTS).fill(-1);
  private readonly trailPos = new Float32Array(TRAIL_SLOTS * 3);
  private readonly trailSeen = new Uint32Array(TRAIL_SLOTS);
  private frame = 0;
  private dt = 0;
  private budget = FRAME_BUDGET;
  private swingCount = 0;

  constructor(ctx: RenderContext) {
    this.ctx = ctx;
    const w = ctx.world;
    this.rng = new Prng(hashString(`vfx:${w.seed}`));
    for (let f = 0; f < 4; f++) {
      const fs = w.factions[f];
      this.factionColors.push(new THREE.Color(fs ? fs.color : NEUTRAL_COLOR));
    }
    const density = ctx.quality === 'low' ? 0.45 : ctx.quality === 'medium' ? 0.75 : 1;
    this.light = new ParticlePool(ADD_CAPACITY, true, this.shared, ORDER.light);
    this.grime = new ParticlePool(GRIME_CAPACITY, false, this.shared, ORDER.grime);
    this.ground = new GroundFx(512, this.shared, ORDER.ground);
    this.walls = new ShockWalls(64, this.shared, ORDER.walls);
    this.arcs = new SwingArcs(48, this.shared, ORDER.arcs);
    this.bolts = new Bolts(this.rng, ORDER.bolts);
    this.domes = new Domes(12, this.shared, ORDER.domes);
    this.columns = new Columns(64, this.shared, ORDER.columns);
    this.boards = new Billboards(64, this.shared, ctx.renderer, ORDER.boards);
    this.fireworks = new Fireworks(this.light, this.rng, ctx.camera, density);
    this.fx = new Bursts(this.light, this.grime, this.ground, this.walls, this.rng, density);
    for (let i = 0; i < BANNERS; i++) {
      this.banners.push({ active: false, key: 'overwritten', x: 0, y: 0, z: 0, born: 0, life: 1, height: 1, minPx: 0, rise: 0, color: new THREE.Color() });
    }
    ctx.scene.add(
      this.ground.mesh,
      this.domes.mesh,
      this.columns.mesh,
      this.walls.mesh,
      this.grime.mesh,
      this.arcs.mesh,
      this.bolts.mesh,
      this.light.mesh,
      this.boards.mesh,
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private color(o: Owner): THREE.Color {
    return o < 0 ? this.neutral : this.factionColors[o];
  }

  /** Visual ground height (env may displace terrain outside the playable map). */
  private groundY(x: number, z: number): number {
    const g = this.ctx.shared.groundOffset;
    return g ? g(x, z) : 0;
  }

  /** Spend routine-burst budget; false once this frame's flood allowance is used up. */
  private spend(cost: number): boolean {
    if (this.budget < cost) return false;
    this.budget -= cost;
    return true;
  }

  /** Keep every spawner's clock at the presentation time. */
  private syncClock(): void {
    const now = this.ctx.time;
    this.light.now = now;
    this.grime.now = now;
    this.ground.now = now;
    this.walls.now = now;
    this.arcs.now = now;
  }

  /**
   * Add camera trauma for an impact at (x, z): full strength within `near` metres of the
   * player's avatar, quadratic falloff to zero at `far`, never below `floor`.
   */
  private shake(x: number, z: number, amount: number, near: number, far: number, floor = 0): void {
    const w = this.ctx.world;
    const av = w.avatars.get(w.factions[this.ctx.session.playerFaction].avatarId);
    const d = av ? Math.hypot(x - av.pos.x, z - av.pos.z) : far;
    const k = d <= near ? 1 : d >= far ? 0 : 1 - (d - near) / (far - near);
    const add = Math.max(floor, amount * k * k);
    if (add <= 0) return;
    const sh = this.ctx.shared;
    sh.shake = Math.min(1, (sh.shake ?? 0) + add);
  }

  private isPlayerAvatar(id: number): boolean {
    const w = this.ctx.world;
    return id === w.factions[this.ctx.session.playerFaction].avatarId;
  }

  private banner(key: AtlasKey, x: number, y: number, z: number, color: THREE.Color, height: number, minPx: number, life: number, rise: number): void {
    let slot = this.banners[0];
    for (const b of this.banners) {
      if (!b.active) {
        slot = b;
        break;
      }
      if (b.born < slot.born) slot = b;
    }
    slot.active = true;
    slot.key = key;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.born = this.ctx.time;
    slot.life = life;
    slot.height = height;
    slot.minPx = minPx;
    slot.rise = rise;
    slot.color.copy(color);
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  onEvent(e: GameEvent): void {
    this.syncClock();
    const w = this.ctx.world;
    const fx = this.fx;
    switch (e.t) {
      case 'flagPlanted': {
        if (!this.spend(1)) break;
        fx.plant(e.pos.x, e.pos.y + this.groundY(e.pos.x, e.pos.z), e.pos.z, this.color(e.faction));
        break;
      }
      case 'flagPulled': {
        if (!this.spend(1)) break;
        fx.pull(e.pos.x, e.pos.y + this.groundY(e.pos.x, e.pos.z), e.pos.z, this.color(e.prevOwner));
        break;
      }
      case 'flagThrown': {
        if (!this.spend(1)) break;
        fx.throwLaunch(e.from.x, e.from.y + this.groundY(e.from.x, e.from.z), e.from.z, e.vel.x, e.vel.y, e.vel.z);
        break;
      }
      case 'flagLanded': {
        if (!this.spend(1)) break;
        fx.landed(e.pos.x, e.pos.y + this.groundY(e.pos.x, e.pos.z), e.pos.z);
        break;
      }
      case 'flagDecohered': {
        if (!this.spend(2)) break;
        fx.glassGlitch(e.pos.x, e.pos.y + this.groundY(e.pos.x, e.pos.z) + 1.2, e.pos.z, 1);
        break;
      }
      case 'simulacrumCollapsed': {
        const gone = w.lattice.nodes[e.vanished];
        if (gone) fx.glassGlitch(gone.x, this.groundY(gone.x, gone.z) + 1.2, gone.z, 1.4);
        const kept = w.lattice.nodes[e.kept];
        if (kept) {
          const gy = this.groundY(kept.x, kept.z) + 0.05;
          this.ground.ring(RingStyle.Glow, kept.x, gy, kept.z, 0.3, 2.6, 0.2, 0.6, P.YELLOW, 2.4);
          this.ground.ring(RingStyle.Ripple, kept.x, gy, kept.z, 0.2, 3.5, 0.25, 0.8, this.color(e.faction), 1.8);
        }
        break;
      }
      case 'leyLine': {
        if (e.on || !this.spend(1)) break;
        const edge = w.lattice.edges[e.edge];
        if (!edge) break;
        const a = w.lattice.nodes[edge.a];
        const b = w.lattice.nodes[edge.b];
        if (!a || !b) break;
        const len = Math.max(Math.hypot(b.x - a.x, b.z - a.z), 0.001);
        const mx = (a.x + b.x) * 0.5;
        const mz = (a.z + b.z) * 0.5;
        fx.leySnap(mx, this.groundY(mx, mz) + 1, mz, (b.x - a.x) / len, (b.z - a.z) / len, this.color(e.faction));
        break;
      }
      case 'crystalManifest': {
        fx.crystalManifest(e.pos.x, this.groundY(e.pos.x, e.pos.z), e.pos.z);
        break;
      }
      case 'crystalShatter': {
        fx.crystalShatter(e.pos.x, this.groundY(e.pos.x, e.pos.z), e.pos.z);
        this.shake(e.pos.x, e.pos.z, 0.45, 12, 60);
        break;
      }
      case 'crystalLightning':
      case 'wardLightning': {
        const fy = e.from.y + this.groundY(e.from.x, e.from.z);
        const ty = e.to.y + this.groundY(e.to.x, e.to.z);
        this.bolts.strike(this.ctx.time, e.from.x, fy, e.from.z, e.to.x, ty, e.to.z);
        break;
      }
      case 'discharge': {
        const fy = e.from.y + this.groundY(e.from.x, e.from.z);
        const ty = e.to.y + this.groundY(e.to.x, e.to.z);
        this.bolts.strike(this.ctx.time, e.from.x, fy, e.from.z, e.to.x, ty, e.to.z);
        fx.dischargeImpact(e.to.x, ty, e.to.z);
        this.shake(e.to.x, e.to.z, 0.35, 8, 45);
        break;
      }
      case 'hearthStage': {
        if (e.stage !== 'overwritten') break;
        const h = w.buildings.get(e.hearthId);
        if (!h) break;
        const c = e.attacker === null ? P.WHITE : this.color(e.attacker);
        const gy = this.groundY(h.pos.x, h.pos.z);
        this.ground.ring(RingStyle.Shock, h.pos.x, gy + 0.06, h.pos.z, 16, 2, 1.2, 0.9, c, 2.4);
        this.walls.spawn(h.pos.x, gy, h.pos.z, 1, 14, 10, 0.9, c, 1.8);
        this.shake(h.pos.x, h.pos.z, 0.3, 20, 80);
        break;
      }
      case 'captured': {
        const c = this.color(e.to);
        const gy = this.groundY(e.pos.x, e.pos.z);
        fx.captured(e.pos.x, gy, e.pos.z, c);
        this.banner('overwritten', e.pos.x, gy + 9, e.pos.z, c, 6, 64, 2.8, 2.5);
        this.shake(e.pos.x, e.pos.z, 1, 40, 220, 0.35);
        break;
      }
      case 'burn': {
        const ef = w.map.effigy;
        this.fireworks.start(this.ctx.time, ef.x, ef.z);
        fx.burnStart(ef.x, this.groundY(ef.x, ef.z), ef.z);
        this.shake(ef.x, ef.z, 0.6, 60, 260, 0.25);
        break;
      }
      case 'swing': {
        if (!this.spend(1)) break;
        const av = w.avatars.get(e.by);
        const c = av ? this.color(av.faction) : P.WARM_WHITE;
        // Alternate the tilt so consecutive swings sweep forehand / backhand.
        const tilt = this.swingCount++ % 2 === 0 ? 0.55 : -0.55;
        this.arcs.spawn(e.pos.x, e.pos.y + this.groundY(e.pos.x, e.pos.z) + 1.1, e.pos.z, e.yaw, tilt, 2.7, 0.28, c, 2.2);
        break;
      }
      case 'hit': {
        const toPlayer = this.isPlayerAvatar(e.target);
        const byPlayer = e.by >= 0 && this.isPlayerAvatar(e.by);
        if (!toPlayer && !byPlayer && !this.spend(1)) break;
        fx.hit(e.pos.x, e.pos.y + this.groundY(e.pos.x, e.pos.z) + 1, e.pos.z, toPlayer);
        if (toPlayer) this.shake(e.pos.x, e.pos.z, 0.3 + Math.min(0.4, e.amount / 100), 1000, 2000);
        else if (byPlayer) this.shake(e.pos.x, e.pos.z, 0.12, 1000, 2000);
        break;
      }
      case 'ko': {
        if (!this.spend(2)) break;
        const gy = e.pos.y + this.groundY(e.pos.x, e.pos.z);
        const anchor = this.ctx.shared.unitAnchors?.get(e.id);
        const headY = anchor ? anchor.y : gy + (e.kind === 'avatar' ? 1.85 : 1.6);
        fx.ko(e.pos.x, gy, e.pos.z, headY);
        if (e.kind === 'avatar' && this.isPlayerAvatar(e.id)) this.shake(e.pos.x, e.pos.z, 0.45, 1000, 2000);
        break;
      }
      case 'recruited': {
        const h = w.hippies.get(e.hippieId);
        if (!h || !this.spend(1)) break;
        fx.recruit(h.pos.x, this.groundY(h.pos.x, h.pos.z), h.pos.z, this.color(e.faction));
        break;
      }
      case 'harvest': {
        if (!this.spend(1)) break;
        fx.chips(e.pos.x, this.groundY(e.pos.x, e.pos.z), e.pos.z);
        break;
      }
      case 'pieceBuilt': {
        if (!this.spend(1)) break;
        fx.dust(e.pos.x, e.pos.y + this.groundY(e.pos.x, e.pos.z), e.pos.z, 8, 1.2, 0.8);
        break;
      }
      case 'pieceDestroyed': {
        if (!this.spend(2)) break;
        const gy = e.pos.y + this.groundY(e.pos.x, e.pos.z);
        fx.splinters(e.pos.x, gy + 1, e.pos.z, 22);
        fx.dust(e.pos.x, gy, e.pos.z, 8, 1.4, 1);
        this.shake(e.pos.x, e.pos.z, 0.18, 6, 25);
        break;
      }
      case 'buildingDone': {
        fx.confetti(e.pos.x, this.groundY(e.pos.x, e.pos.z), e.pos.z, this.color(e.faction));
        break;
      }
      case 'buildingDisabled': {
        fx.wreck(e.pos.x, this.groundY(e.pos.x, e.pos.z), e.pos.z, 1);
        this.shake(e.pos.x, e.pos.z, 0.2, 8, 35);
        break;
      }
      case 'gccDestroyed': {
        fx.wreck(e.pos.x, this.groundY(e.pos.x, e.pos.z), e.pos.z, 1.3);
        this.shake(e.pos.x, e.pos.z, 0.3, 10, 45);
        break;
      }
      case 'wardPulse': {
        if (!this.spend(1)) break;
        fx.wardPulse(e.pos.x, this.groundY(e.pos.x, e.pos.z), e.pos.z, this.color(e.faction));
        break;
      }
      case 'ability': {
        this.onAbility(e);
        break;
      }
      case 'ping': {
        if (e.faction !== this.ctx.session.playerFaction) break;
        const c = P.PING_COLORS[e.kind];
        const gy = this.groundY(e.pos.x, e.pos.z) + 0.06;
        this.ground.ring(RingStyle.Glow, e.pos.x, gy, e.pos.z, 0.3, 4, 0.3, 0.6, c, 2.6);
        this.walls.spawn(e.pos.x, gy, e.pos.z, 0.3, 3, 3.5, 0.5, c, 1.6);
        break;
      }
      case 'meshTapped': {
        if (e.faction !== this.ctx.session.playerFaction) break;
        const av = w.avatars.get(w.factions[e.faction].avatarId);
        if (av) fx.meshGlitch(av.pos.x, av.pos.y + this.groundY(av.pos.x, av.pos.z), av.pos.z);
        break;
      }
      case 'retransmit': {
        if (e.faction !== this.ctx.session.playerFaction) break;
        const av = w.avatars.get(w.factions[e.faction].avatarId);
        if (!av) break;
        const gy = av.pos.y + this.groundY(av.pos.x, av.pos.z);
        fx.takeShot(av.pos.x, gy, av.pos.z);
        this.banner('takeShot', av.pos.x, gy + 3.2, av.pos.z, P.PING_COLORS.shot, 1.3, 30, 1.8, 3);
        w.hippies.forEach(this.wobbleIfMine);
        break;
      }
      default:
        break;
    }
  }

  private onAbility(e: EventOf<'ability'>): void {
    const w = this.ctx.world;
    const lvl = Math.min(2, Math.max(0, e.level - 1));
    const c = this.color(e.faction);
    const x = e.pos.x;
    const z = e.pos.z;
    const gy = this.groundY(x, z);
    switch (e.ability) {
      case 'omega': {
        let R: number = ABILITY.omega.radius[lvl];
        w.zones.forEach((zone) => {
          if (zone.kind === 'omega' && zone.faction === e.faction && Math.abs(zone.pos.x - x) + Math.abs(zone.pos.z - z) < 1) R = zone.radius;
        });
        const caster = w.avatars.get(e.by);
        this.fx.omega(x, gy, z, R, c, caster ? Math.PI / 2 - caster.yaw : this.rng.next() * TAU);
        this.shake(x, z, 0.85, R, R * 5);
        break;
      }
      case 'phason': {
        this.fx.phason(x, gy, z, Math.max(5, ABILITY.phason.radius[lvl] + 2), c);
        this.shake(x, z, 0.12, 10, 40);
        break;
      }
      case 'stabilize': {
        this.fx.castFlash(x, gy, z, c, ABILITY.stabilize.radius[lvl]);
        this.shake(x, z, 0.15, 15, 50);
        break;
      }
      case 'beacon': {
        this.fx.castFlash(x, gy, z, c, 6);
        break;
      }
      case 'march': {
        const caster = w.avatars.get(e.by);
        const mx = caster ? caster.pos.x : x;
        const mz = caster ? caster.pos.z : z;
        this.fx.marchCast(mx, this.groundY(mx, mz), mz, c, ABILITY.march.radius);
        break;
      }
    }
  }

  // ── Per-frame World sync (allocation-free: bound callbacks, preallocated tables) ──

  private readonly wobbleIfMine = (h: Hippie): void => {
    if (h.faction !== this.ctx.session.playerFaction || h.status === 'ko') return;
    const anchor = this.ctx.shared.unitAnchors?.get(h.id);
    const headY = anchor ? anchor.y : this.groundY(h.pos.x, h.pos.z) + 1.6;
    this.fx.wobble(h.pos.x, headY, h.pos.z);
  };

  private readonly trailProjectile = (p: Projectile): void => {
    const x = p.pos.x;
    const y = p.pos.y + this.groundY(p.pos.x, p.pos.z);
    const z = p.pos.z;
    let slot = -1;
    for (let i = 0; i < TRAIL_SLOTS; i++) {
      if (this.trailId[i] === p.id) {
        slot = i;
        break;
      }
    }
    const tp = this.trailPos;
    if (slot < 0) {
      for (let i = 0; i < TRAIL_SLOTS; i++) {
        if (this.trailId[i] < 0) {
          slot = i;
          break;
        }
      }
      if (slot < 0) return;
      this.trailId[slot] = p.id;
      tp[slot * 3] = x;
      tp[slot * 3 + 1] = y;
      tp[slot * 3 + 2] = z;
      this.trailSeen[slot] = this.frame;
      this.fx.trail(x, y, z);
      return;
    }
    this.trailSeen[slot] = this.frame;
    const lx = tp[slot * 3];
    const ly = tp[slot * 3 + 1];
    const lz = tp[slot * 3 + 2];
    const steps = Math.min(12, Math.floor(Math.hypot(x - lx, y - ly, z - lz) / TRAIL_SPACING));
    if (steps === 0) return;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      this.fx.trail(lx + (x - lx) * t, ly + (y - ly) * t, lz + (z - lz) * t);
    }
    tp[slot * 3] = x;
    tp[slot * 3 + 1] = y;
    tp[slot * 3 + 2] = z;
  };

  private readonly marchHippie = (h: Hippie): void => {
    if (h.status === 'ko') return;
    const now = this.ctx.world.time;
    let marching = false;
    for (let i = 0; i < h.effects.length; i++) {
      const ef = h.effects[i];
      if (ef.kind === 'march' && ef.until > now) {
        marching = true;
        break;
      }
    }
    if (!marching) return;
    const count = Math.floor(this.dt * MARCH_RATE + this.rng.next());
    if (count === 0) return;
    const c = this.color(h.faction);
    const gy = this.groundY(h.pos.x, h.pos.z);
    for (let i = 0; i < count; i++) this.fx.marchTrail(h.pos.x, gy, h.pos.z, h.vel.x, h.vel.z, c);
  };

  /** Priority Beacon target: the targeted entity's position when it still exists. */
  private beaconAnchor(z: Zone): { x: number; z: number } {
    const w = this.ctx.world;
    if (z.target >= 0) {
      const t = w.flags.get(z.target) ?? w.buildings.get(z.target) ?? w.hippies.get(z.target) ?? w.avatars.get(z.target);
      if (t) return t.pos;
    }
    return z.pos;
  }

  private readonly syncZone = (z: Zone): void => {
    const w = this.ctx.world;
    const now = this.ctx.time;
    const age = w.time - z.bornAt;
    const left = z.until - w.time;
    if (left <= 0 || age < 0) return;
    const fade = Math.min(1, age / 0.6) * Math.min(1, left / 1.2);
    const c = this.color(z.faction);
    if (z.kind === 'stabilize') {
      const gy = this.groundY(z.pos.x, z.pos.z);
      const reveal = THREE.MathUtils.smoothstep(age, 0, 0.9);
      this.domes.add(z.pos.x, gy, z.pos.z, z.radius, c, 0.9, fade, reveal, (z.id * 0.6180339887) % 1);
      this.ground.halo(z.pos.x, gy + 0.06, z.pos.z, z.radius, 0.35, c, 2.2 * fade, 0, 0);
      this.ground.halo(z.pos.x, gy + 0.06, z.pos.z, z.radius * 0.94, 0.12, c, 1.4 * fade, now * 0.2, 5);
    } else if (z.kind === 'beacon') {
      const at = this.beaconAnchor(z);
      const gy = this.groundY(at.x, at.z);
      this.columns.add(ColumnStyle.Beacon, at.x, gy, at.z, 1.6, 60, c, 2.6, fade, z.id);
      this.columns.add(ColumnStyle.Beacon, at.x, gy, at.z, 0.4, 75, P.WHITE, 1.2, fade, z.id + 1.7);
      this.ground.halo(at.x, gy + 0.08, at.z, 3.6, 0.3, c, 2.4 * fade, now * 1.2, 5);
      this.ground.halo(at.x, gy + 6, at.z, 3.2, 0.4, c, 2.4 * fade, -now * 2, 5);
      this.ground.halo(at.x, gy + 13, at.z, 2.4, 0.32, c, 2 * fade, now * 2.6, 3);
      const motes = Math.floor(this.dt * BEACON_MOTE_RATE * fade + this.rng.next());
      for (let i = 0; i < motes; i++) this.fx.beaconMote(at.x, gy, at.z, c);
    }
    // Omega and phason zones are brief; their visuals are the ability-event bursts.
  };

  private readonly syncPing = (p: Ping): void => {
    if (p.faction !== this.ctx.session.playerFaction) return;
    const w = this.ctx.world;
    const now = this.ctx.time;
    const left = p.until - w.time;
    const age = w.time - p.bornAt;
    if (left <= 0 || age < 0) return;
    const fade = Math.min(1, age / 0.25) * Math.min(1, left);
    const c = P.PING_COLORS[p.kind];
    const sos = p.kind === 'sos';
    const flash = sos && (now * 2.5) % 1 > 0.5 ? 0.3 : 1;
    const gy = this.groundY(p.pos.x, p.pos.z);
    this.columns.add(ColumnStyle.Ping, p.pos.x, gy, p.pos.z, 0.32, 28, c, 2.6 * flash, fade, p.id);
    this.ground.halo(p.pos.x, gy + 0.06, p.pos.z, 1.5, 0.18, c, 2.4 * fade * flash, now * 1.5, 5);
    if (sos) {
      const ph = (now * 1.2) % 1;
      this.ground.halo(p.pos.x, gy + 0.06, p.pos.z, 1.5 + ph * 4, 0.25, c, 2.2 * fade * (1 - ph), 0, 0);
    }
    const bob = Math.sin(now * 2.2 + p.id) * 0.25;
    this.boards.add(ATLAS_RECTS[p.kind], p.pos.x, gy + 6.2 + bob, p.pos.z, 2.2, 34, c, 1.5 * flash, fade, 0.15, 0);
  };

  private readonly syncVortex = (b: Building): void => {
    const h = b.hearth;
    if (b.kind !== 'hearth' || !h || h.stage !== 'overwritten') return;
    const w = this.ctx.world;
    const now = this.ctx.time;
    const c = h.attacker === null ? P.WHITE : this.color(h.attacker);
    const left = h.overwriteAt > 0 ? h.overwriteAt - w.time : CAPTURE.overwriteTime * 0.5;
    const p = 1 - THREE.MathUtils.clamp(left / CAPTURE.overwriteTime, 0, 1);
    const gy = this.groundY(b.pos.x, b.pos.z);
    this.columns.add(ColumnStyle.Vortex, b.pos.x, gy, b.pos.z, 2.2 + p * 1.2, 40 + p * 30, c, 1.6 + p * 2.2, 1, b.id);
    this.ground.halo(b.pos.x, gy + 0.06, b.pos.z, 7 - p * 3, 0.5, c, 2 + p * 2, -now * (2 + p * 6), 5);
    this.ground.halo(b.pos.x, gy + 0.06, b.pos.z, 12 - p * 5, 0.3, P.YELLOW, 1.5 + p, now * 1.5, 10);
    const motes = Math.floor(this.dt * VORTEX_RATE * (0.6 + p) + this.rng.next());
    for (let i = 0; i < motes; i++) this.fx.vortexMote(b.pos.x, gy, b.pos.z, c);
  };

  private drawBanners(now: number): void {
    for (let i = 0; i < BANNERS; i++) {
      const b = this.banners[i];
      if (!b.active) continue;
      const t = (now - b.born) / b.life;
      if (t >= 1) {
        b.active = false;
        continue;
      }
      const grow = 1 - (1 - Math.min(1, t * 1.6)) ** 3;
      const alpha = Math.min(1, t / 0.05) * (1 - THREE.MathUtils.smoothstep(t, 0.62, 1));
      const white = Math.max(0, 1 - t * 5);
      this.boards.add(ATLAS_RECTS[b.key], b.x, b.y + b.rise * t, b.z, b.height * (0.7 + 0.55 * grow), b.minPx, b.color, 2.2, alpha, white, 0);
    }
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    const ctx = this.ctx;
    const w = ctx.world;
    const now = ctx.time;
    this.frame++;
    // The app's first frame can report a negative dt; emitters must never see one.
    this.dt = Math.max(0, dt);
    this.syncClock();
    this.shared.uTime.value = now;
    this.shared.uViewportH.value = Math.max(1, ctx.renderer.domElement.height);
    this.shared.uLight.value = 0.3 + 0.7 * ctx.daylight;

    w.projectiles.forEach(this.trailProjectile);
    for (let i = 0; i < TRAIL_SLOTS; i++) if (this.trailId[i] >= 0 && this.trailSeen[i] !== this.frame) this.trailId[i] = -1;
    w.hippies.forEach(this.marchHippie);

    this.ground.beginPersistent();
    this.columns.begin();
    this.domes.begin();
    this.boards.begin();
    w.zones.forEach(this.syncZone);
    w.pings.forEach(this.syncPing);
    w.buildings.forEach(this.syncVortex);
    this.drawBanners(now);

    this.bolts.update(now);
    this.fireworks.update(now);

    this.light.flush();
    this.grime.flush();
    this.ground.flush();
    this.walls.flush();
    this.arcs.flush();
    this.columns.flush();
    this.domes.flush();
    this.boards.flush();
    this.budget = FRAME_BUDGET;
  }

  dispose(): void {
    this.light.dispose();
    this.grime.dispose();
    this.ground.dispose();
    this.walls.dispose();
    this.arcs.dispose();
    this.bolts.dispose();
    this.domes.dispose();
    this.columns.dispose();
    this.boards.dispose();
  }
}
