/**
 * Hearth stage rings: a ground ring + arc meter around every Hearth, styled by capture stage
 * (safe = owner colour and calm; threatened = amber pulse; contained = capturing faction colour, arc = leading
 * pressure, beams from the enclosing loop's Ley Lines converge on the Hearth; contested =
 * owner/attacker flicker; overwritten = white column). When the PLAYER's Hearth is contained
 * or contested, the critical enemy Flags (any one pulled breaks the loop) get pulsing red
 * x-ray reticles. Loop edges and critical Flags are recomputed only when the survey changes.
 */
import * as THREE from 'three';
import type { Session } from '../../game/session';
import { BUILDINGS, IMPLIED_MAX_ORDER, NEUTRAL_COLOR } from '../../sim/constants';
import { criticalNodes, enclosureBoundary } from '../../sim/lattice/geometry';
import { pieceCaptureAnchor } from '../../sim/systems/structureEnclosure';
import { geometryOwners } from '../../sim/systems/survey';
import type { Building, CaptureStage, FactionId, Owner, StructureCaptureState } from '../../sim/types';
import type { World } from '../../sim/world';
import { BEAM } from './beams';
import type { BeamLayer } from './beams';
import { DECAL } from './decals';
import type { DecalLayer } from './decals';
import { BEAM_Y } from './glsl';
import { SPRITE } from './sprites';
import type { SpriteLayer } from './sprites';
import type { SurveyData } from './surveyData';

interface CaptureTarget { id: number; pos: { x: number; z: number }; facet: number; faction: Owner; hearth?: Building['hearth']; capture?: StructureCaptureState | null; radius: number; }
const RING_R = 7.5;
const STAGE_CODE: Record<CaptureStage, number> = {
  safe: 0,
  threatened: 1,
  contained: 2,
  contested: 3,
  overwritten: 4,
  captured: 4,
};
const AMBER = new THREE.Color(1.0, 0.62, 0.1);
const RED = new THREE.Color(1.0, 0.13, 0.12);
const WHITE = new THREE.Color(1.0, 1.0, 1.0);

interface LoopCache {
  stamp: number;
  topology: number;
  attacker: number;
  facet: number;
  edges: number[];
  critical: number[];
  criticalFor: number;
}

export class HearthFeature {
  private readonly world: World;
  private readonly session: Session;
  private readonly data: SurveyData;
  private readonly cache = new Map<number, LoopCache>();
  private readonly enclosed: Uint8Array;
  private readonly color = new THREE.Color();
  private readonly color2 = new THREE.Color();
  private readonly beamColor = new THREE.Color();
  private decals: DecalLayer | null = null;
  private beams: BeamLayer | null = null;
  private xray: SpriteLayer | null = null;
  private now = 0;
  private readonly visit = (b: Building): void => {
    if (b.hearth || b.capture) this.drawHearth({ ...b, radius: b.kind === 'hearth' ? RING_R : BUILDINGS[b.kind].radius + 1.2 });
  };

  constructor(world: World, session: Session, data: SurveyData) {
    this.world = world;
    this.session = session;
    this.data = data;
    this.enclosed = new Uint8Array(data.facetCount);
  }

  update(now: number, decals: DecalLayer, beams: BeamLayer, xray: SpriteLayer): void {
    this.now = now;
    this.decals = decals;
    this.beams = beams;
    this.xray = xray;
    this.world.buildings.forEach(this.visit);
    for (const p of this.world.pieces.values()) {
      if (p.capture) this.drawHearth({ ...pieceCaptureAnchor(this.world, p), id: p.id, faction: p.faction, capture: p.capture });
    }
    for (const o of this.world.map.obstacles) {
      const state = this.world.sceneryCapture.get(o.id);
      if (!state || this.world.destroyedScenery.has(o.id)) continue;
      this.drawHearth({ id: -1 - o.id, pos: { x: o.x, z: o.z }, facet: this.world.lattice.facetAt(o.x, o.z), faction: state.faction, capture: state, radius: o.radius + 1.2 });
    }
  }

  private drawHearth(b: CaptureTarget): void {
    const h = b.hearth ?? b.capture;
    const decals = this.decals;
    const beams = this.beams;
    if (!h || !decals || !beams) return;
    const w = this.world;
    const stage = STAGE_CODE[h.stage];
    const attacker = h.attacker;
    const pressure = attacker === null ? 0 : Math.min(1, h.pressure[attacker] / 100);
    const owner = b.faction >= 0 ? w.factions[b.faction].color : NEUTRAL_COLOR;
    const attackerColor = attacker === null ? 0xffffff : w.factions[attacker].color;
    switch (h.stage) {
      case 'safe':
        this.color.setHex(owner);
        break;
      case 'threatened':
        this.color.copy(AMBER);
        break;
      case 'contained':
        this.color.setHex(attacker === null ? owner : attackerColor);
        break;
      case 'contested':
        this.color.setHex(owner);
        break;
      default:
        this.color.copy(WHITE);
    }
    const ring = decals.push(DECAL.hearth, b.pos.x, b.pos.z, b.radius, 0, this.color, stage === 0 ? 0.7 : 1, 0.7, stage, pressure, b.id * 0.31);
    if (h.stage === 'contested') decals.setColor2(ring, this.color2.setHex(attackerColor));

    if (stage >= 2 && attacker !== null) {
      const loop = this.loopFor(b, attacker);
      const dispX = this.data.dispX;
      const dispZ = this.data.dispZ;
      const edges = this.data.lat.edges;
      // Capture inflow identifies the enclosing faction, not generic danger red.
      // Defender-only critical-flag reticles below retain their warning colour.
      this.beamColor.setHex(attackerColor);
      if (h.stage === 'overwritten') this.beamColor.lerp(WHITE, 0.6);
      for (let i = 0; i < loop.edges.length; i++) {
        const e = edges[loop.edges[i]];
        if (!e) continue;
        const mx = (dispX[e.a] + dispX[e.b]) * 0.5;
        const mz = (dispZ[e.a] + dispZ[e.b]) * 0.5;
        beams.push(BEAM.inflow, mx, BEAM_Y, mz, b.pos.x, 2.4, b.pos.z, 0.1, this.beamColor, 0.35 + pressure * 0.45, 7, i * 1.7);
      }
      if (b.faction === this.session.playerFaction && (h.stage === 'contained' || h.stage === 'contested')) {
        this.drawCritical(loop, b, attacker);
      }
    }
    if (h.stage === 'overwritten' || h.stage === 'captured') {
      const k = h.overwriteAt > 0 ? Math.max(0, Math.min(1, 1 - (h.overwriteAt - w.time) / 3)) : 1;
      beams.push(BEAM.pillar, b.pos.x, 0, b.pos.z, b.pos.x, 90, b.pos.z, 3 + k * 4, WHITE, 0.8 + k, 14, b.id);
      decals.push(DECAL.halo, b.pos.x, b.pos.z, RING_R * (1.2 + k * 0.6), 0, WHITE, 0.6 + k * 0.6, 0.9, 0.8, 1.2, 0);
    }
  }

  private drawCritical(loop: LoopCache, b: CaptureTarget, attacker: FactionId): void {
    const xray = this.xray;
    const decals = this.decals;
    if (!xray || !decals) return;
    if (loop.criticalFor !== this.data.surveyStamp) {
      loop.criticalFor = this.data.surveyStamp;
      loop.critical = criticalNodes(this.data.lat, geometryOwners(this.world), attacker, b.facet, IMPLIED_MAX_ORDER);
    }
    for (let i = 0; i < loop.critical.length; i++) {
      const n = loop.critical[i];
      xray.push(SPRITE.reticle, 0, 3.0, 0, 0.6, RED, 1, i * 0.9, this.now * 0.8, 16, n);
      decals.push(DECAL.critical, 0, 0, 1.5, 0, RED, 0.95, 0.75, 0, 0, 0, n);
    }
  }

  /** Enclosing-loop Ley Line edges for this Hearth and attacker (cached per survey stamp). */
  private loopFor(b: CaptureTarget, attacker: FactionId): LoopCache {
    const h = b.hearth;
    const facet = h ? h.facet : b.facet;
    let c = this.cache.get(b.id);
    if (!c) {
      c = { stamp: -1, topology: -1, attacker: -1, facet: -1, edges: [], critical: [], criticalFor: -1 };
      this.cache.set(b.id, c);
    }
    if (c.stamp !== this.data.surveyStamp || c.topology !== this.data.topology || c.attacker !== attacker || c.facet !== facet) {
      c.stamp = this.data.surveyStamp;
      c.topology = this.data.topology;
      c.attacker = attacker;
      c.facet = facet;
      c.criticalFor = -1;
      const fs = this.world.survey.facetSurvey;
      const bit = 1 << attacker;
      for (let f = 0; f < this.enclosed.length; f++) this.enclosed[f] = (fs[f] & bit) !== 0 ? 1 : 0;
      c.edges = facet >= 0 ? enclosureBoundary(this.data.lat, this.enclosed, facet) : [];
    }
    return c;
  }
}
