import { isMobileCommandLayout } from '../../game/mobileTouch';
/**
 * Survey layer: Ley Lattice lines + node markers (near the player in action mode, full map in
 * Command View with the 2017 cyan/red noise ground tint), Ley Lines (glowing faction beams),
 * crystallized/enclosed facets (translucent faction-tinted crystal glass with sweeping fill
 * on surveyChanged), plan ghost Flags, implied Flags (ghost yellow with halo), focus points
 * (when revealed), interference moiré on unstable facets, phason flip animations, Hearth
 * stage rings and containment beams, the throw arc, and tutorial objective markers.
 * Owner: RenderSurvey agent.
 *
 * Every layer reads lattice/survey state from the data textures in SurveyData; this module
 * wires events into it, drives the shared uniform block once per frame and rebuilds the
 * dynamic marker layers (decals, beams, sprites) from the feature controllers.
 */
import * as THREE from 'three';
import { groundHeight } from '../../sim/terrain';
import { NEUTRAL_COLOR } from '../../sim/constants';
import { gccActive } from '../../sim/systems/gcc';
import type { GameEvent } from '../../sim/events';
import type { RenderContext, RenderModule } from '../context';
import { BeamLayer } from './beams';
import { BossVisionFeature } from './bossVision';
import { CrystalLayer } from './crystals';
import { DecalLayer, createDecalMaterial } from './decals';
import { FacetLayer } from './facetLayer';
import { FocusFeature } from './focusPoints';
import { GhostFlagLayer } from './ghostFlags';
import { createSurveyUniforms } from './glsl';
import type { SurveyUniforms } from './glsl';
import { GroundLayer } from './groundLayer';
import { HearthFeature } from './hearthRings';
import { ImpliedPlanFeature } from './impliedPlan';
import { LatticeLayer } from './latticeLayer';
import { LeyLayer } from './leyLayer';
import { MarkedNodeLayer } from './markedNodes';
import { ObjectiveFeature } from './objectives';
import { PhasonFeature } from './phasonFx';
import { SpriteLayer } from './sprites';
import { SurveyData } from './surveyData';
import { AimFeature } from './throwArc';

/** Radius of the action-mode build grid around the vexillomancer (m). */
const GRID_RADIUS = 40;
/** Radius (m) of the ground patches probed for Survey coverage around the camera's view. */
const COVERAGE_RADIUS = 24;

export class SurveyRenderer implements RenderModule {
  private readonly ctx: RenderContext;
  private readonly data: SurveyData;
  private readonly u: SurveyUniforms;
  private readonly lattice: LatticeLayer;
  private readonly ground: GroundLayer;
  private readonly ley: LeyLayer;
  private readonly facets: FacetLayer;
  private readonly decalMat: THREE.ShaderMaterial;
  private readonly decals: DecalLayer;
  private readonly beams: BeamLayer;
  private readonly sprites: SpriteLayer;
  private readonly xray: SpriteLayer;
  private readonly aimGhosts: GhostFlagLayer;
  private readonly implied: ImpliedPlanFeature;
  private readonly marked: MarkedNodeLayer;
  private readonly focus: FocusFeature;
  private readonly hearths: HearthFeature;
  private readonly aim: AimFeature;
  private readonly phason: PhasonFeature;
  private readonly crystals: CrystalLayer;
  private readonly objectives: ObjectiveFeature;
  private readonly bossVision: BossVisionFeature;
  private readonly res = new THREE.Vector2();
  private readonly viewDir = new THREE.Vector3();
  private grid = 1;
  private dust = 0;
  private acid = 0;
  /** Eased share of the ground around the camera's view that lies inside a Survey. */
  private inside = 0;

  constructor(ctx: RenderContext) {
    this.ctx = ctx;
    const { scene, world, session } = ctx;
    this.data = new SurveyData(world);
    const d = this.data;
    this.u = createSurveyUniforms({ node: d.nodeTex, aux: d.auxTex, edge: d.edgeTex, facet: d.facetTex }, world.map.half);
    const palette = this.u.uFactionColor.value;
    for (let f = 0; f < 4; f++) palette[f].setHex(world.factions[f].color);
    palette[4].setHex(NEUTRAL_COLOR);

    this.ground = new GroundLayer(scene, this.u, world.map.half);
    this.facets = new FacetLayer(scene, d, this.u, ctx.quality === 'low');
    this.lattice = new LatticeLayer(scene, d, this.u);
    this.ley = new LeyLayer(scene, d, this.u);
    this.decalMat = createDecalMaterial(this.u);
    this.implied = new ImpliedPlanFeature(scene, world, session, d, this.u, this.decalMat);
    this.marked = new MarkedNodeLayer(world, session, d, this.u, ctx.shared.fx);
    ctx.shared.commandOverlay = this.marked.scene;
    this.decals = new DecalLayer(scene, this.decalMat, 1024, 5);
    this.beams = new BeamLayer(scene, this.u, 512, 10);
    this.sprites = new SpriteLayer(scene, this.u, 256, 11, false, this.implied.atlas);
    this.xray = new SpriteLayer(scene, this.u, 64, 100, true, this.implied.atlas);
    this.aimGhosts = new GhostFlagLayer(scene, this.u, 4);
    this.crystals = new CrystalLayer(scene, world, this.u);
    this.focus = new FocusFeature(world, session, d);
    this.hearths = new HearthFeature(world, session, d);
    this.aim = new AimFeature(world, session);
    this.phason = new PhasonFeature(world, d, this.lattice, this.u);
    this.objectives = new ObjectiveFeature(scene, world, session, d, this.u, ctx.shared);
    this.bossVision = new BossVisionFeature(scene, world, session, this.u);
  }

  onEvent(e: GameEvent): void {
    const now = this.ctx.time;
    switch (e.t) {
      case 'flagPlanted':
        this.data.notePlanted(e.node, now);
        break;
      case 'surveyChanged':
        this.data.noteSurveyChanged(e.gained, e.lost, now);
        break;
      case 'phasonFlip':
        this.phason.onFlip(e, now);
        break;
      case 'tideWarning':
        this.phason.onTideWarning(e, now);
        break;
      case 'tide':
        this.phason.onTide(e, now);
        break;
      case 'crystalManifest':
      case 'crystalShatter':
        this.crystals.onEvent(e, now);
        break;
      default:
        break;
    }
  }

  update(frameDt: number): void {
    // The app's first frame can hand us a slightly negative dt (rAF stamp before the loop's
    // start); easing and decays must never run backwards.
    const dt = frameDt > 0 ? Math.min(frameDt, 0.25) : 0;
    const ctx = this.ctx;
    const w = ctx.world;
    const s = ctx.session;
    const now = ctx.time;
    const u = this.u;

    u.uTime.value = now;
    u.uViewBlend.value = s.viewBlend;
    ctx.renderer.getDrawingBufferSize(this.res);
    u.uResolution.value.copy(this.res);
    u.uPx.value = ctx.renderer.getPixelRatio();
    u.uCameraNear.value = ctx.camera.near;
    const av = w.avatarOf(s.playerFaction);
    const at = av?.pos ?? w.hearthOf(s.playerFaction)?.pos ?? { x: 0, z: 0 };
    u.uAvatar.value.set(at.x, at.z);
    const gcc = gccActive(w, s.playerFaction) ? w.gccOf(s.playerFaction) : undefined;
    if (gcc) u.uGcc.value.set(gcc.pos.x, gcc.pos.z, 1);
    else u.uGcc.value.z = 0;
    const pf = w.factions[s.playerFaction];
    const k = Math.min(1, dt * 4);
    this.grid += ((s.showLattice ? 1 : 0) - this.grid) * k;
    this.dust += ((pf.drugActive.dust > w.time ? 1 : 0) - this.dust) * k;
    this.acid += ((pf.drugActive.acidcop > w.time ? 1 : 0) - this.acid) * k;
    u.uReveal.value.set(this.grid, this.dust, GRID_RADIUS, this.acid);
    const hv = s.hover;
    const lat = w.lattice;
    const hNode = hv.node < lat.nodes.length ? hv.node : -1;
    const hEdge = hv.edge < lat.edges.length ? hv.edge : -1;
    const hFacet = hv.facet < lat.facets.length ? hv.facet : -1;
    // A flag aims at nodes: the hovered facet is only highlighted on the Command View table
    // and with the deck/ramp/building tools.
    const facetTool = s.tool === 'floor' || s.tool === 'ramp' || s.tool === 'building';
    u.uHover.value.set(hNode, hEdge, hFacet, Math.max(s.viewBlend, facetTool ? 1 : 0));
    if (hFacet >= 0) {
      const fe = lat.facets[hFacet].edges;
      u.uHoverEdges.value.set(fe[0], fe[1], fe[2], fe[3]);
    } else u.uHoverEdges.value.set(-1, -1, -1, -1);
    u.uSunDir.value.copy(ctx.sunDir);
    u.uDaylight.value = ctx.daylight;
    // Night energy budget: Survey glass is a tint, not a light (see SurveyUniforms.uGlow).
    const day = THREE.MathUtils.smoothstep(ctx.daylight, 0.05, 0.6);
    const coverage = this.surveyCoverage() * (1 - s.viewBlend);
    this.inside += (coverage - this.inside) * Math.min(1, dt * 3);
    u.uGlow.value.set(
      1 / Math.max(1, ctx.renderer.toneMappingExposure),
      this.inside,
      THREE.MathUtils.lerp(0.85, 1, day),
      THREE.MathUtils.lerp(0.7, 1, day),
    );

    this.data.update(now);
    this.lattice.setTargetingVisible(!isMobileCommandLayout() || s.mobileMode === 'build');
    this.lattice.update();
    this.ley.update();
    this.facets.update();
    this.ground.update();

    this.decals.reset();
    this.beams.reset();
    this.sprites.reset();
    this.xray.reset();
    this.aimGhosts.reset();
    this.phason.update(now, dt, this.decals);
    this.crystals.update(now, this.decals, this.beams);
    this.focus.update(dt, this.decals, this.beams);
    this.hearths.update(now, this.decals, this.beams, this.xray);
    this.aim.update(now, this.sprites, this.decals, this.beams, this.aimGhosts);
    this.implied.update();
    this.marked.update();
    this.decals.commit();
    this.beams.commit();
    this.sprites.commit();
    this.xray.commit();
    this.aimGhosts.commit();
    // Pixels per metre at 1 m of view distance, for markers that keep a minimum screen size.
    const projScale = ctx.camera.projectionMatrix.elements[5] * 0.5 * this.res.y;
    this.objectives.update(now, ctx.camera, projScale, this.res, u.uPx.value);
    this.bossVision.update(ctx.camera, this.res, u.uPx.value);
  }

  /**
   * 0..1: distance-weighted share of the ground around the camera (under it, and where its
   * view meets the ground at most 40 m ahead) that lies inside any faction's Survey. Glass
   * emission backs off as this grows, because the glass then covers most of the screen.
   */
  private surveyCoverage(): number {
    const cam = this.ctx.camera;
    const facets = this.ctx.world.lattice.facets;
    const mask = this.ctx.world.survey.facetSurvey;
    cam.getWorldDirection(this.viewDir);
    const ax = cam.position.x;
    const az = cam.position.z;
    const t = this.viewDir.y < -0.05 ? Math.min(40, (cam.position.y - groundHeight(ax, az, this.ctx.world.map.half)) / -this.viewDir.y) : 20;
    const bx = ax + this.viewDir.x * t;
    const bz = az + this.viewDir.z * t;
    const r2 = COVERAGE_RADIUS * COVERAGE_RADIUS;
    let inside = 0;
    let total = 0;
    for (let f = 0; f < facets.length; f++) {
      const fc = facets[f];
      const da2 = (fc.cx - ax) ** 2 + (fc.cz - az) ** 2;
      const db2 = (fc.cx - bx) ** 2 + (fc.cz - bz) ** 2;
      if (da2 >= r2 && db2 >= r2) continue;
      const w = (da2 < r2 ? 1 - Math.sqrt(da2) / COVERAGE_RADIUS : 0) + (db2 < r2 ? 1 - Math.sqrt(db2) / COVERAGE_RADIUS : 0);
      total += w;
      if (mask[f] !== 0) inside += w;
    }
    return total > 0 ? inside / total : 0;
  }

  dispose(): void {
    this.ground.dispose();
    this.facets.dispose();
    this.lattice.dispose();
    this.ley.dispose();
    this.implied.dispose();
    this.marked.dispose();
    delete this.ctx.shared.commandOverlay;
    this.decals.dispose();
    this.beams.dispose();
    this.sprites.dispose();
    this.xray.dispose();
    this.aimGhosts.dispose();
    this.crystals.dispose();
    this.objectives.dispose();
    this.bossVision.dispose();
    this.decalMat.dispose();
    this.data.dispose();
  }
}
