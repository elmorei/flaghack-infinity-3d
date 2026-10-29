import { isMobileCommandLayout } from '../../game/mobileTouch';
/**
 * Implied Flags and plan ghosts. Implied Flags (the implied Flag fractal) are holographic
 * yellow Flags with a halo in the implying faction's colour and a Roman order glyph (I–III).
 * In action view, plan ghosts mark the player's unheld Survey Pattern nodes (dashed ring +
 * faint ghost Flag in faction colour); rivals' plans join while the player taps their
 * D.E.G.E.N. mesh or is on Acid Cop Vision. Planned nodes still held by a rival (or orphaned)
 * real Flag are pull targets instead: a red-orange dashed ring with an X at the Flag's foot
 * and chevrons climbing off its top. Command View plan-tool previews spin brighter.
 * Command View uses persistent post-grade dots/Xs for the player's marked plan instead.
 * Instances are anchored to nodes and rebuilt only when the inputs change.
 */
import * as THREE from 'three';
import type { Session } from '../../game/session';
import { FLAG_YELLOW } from '../../sim/constants';
import { FACTION_IDS } from '../../sim/types';
import type { World } from '../../sim/world';
import { DECAL, DecalLayer } from './decals';
import { GHOST, GhostFlagLayer } from './ghostFlags';
import type { SurveyUniforms } from './glsl';
import { SPRITE, SpriteLayer } from './sprites';
import type { SurveyData } from './surveyData';

/** Ghost cloths stream downwind like the real Flags do (radians, about +y). */
const WIND_YAW = 0.6;

export class ImpliedPlanFeature {
  private readonly world: World;
  private readonly session: Session;
  private readonly data: SurveyData;
  private readonly ghosts: GhostFlagLayer;
  private readonly decals: DecalLayer;
  private readonly glyphs: SpriteLayer;
  private readonly yellow = new THREE.Color(FLAG_YELLOW);
  private readonly color = new THREE.Color();
  private readonly glyphColor = new THREE.Color();
  private readonly white = new THREE.Color(1, 1, 1);
  private readonly pull = new THREE.Color(1.0, 0.36, 0.08);
  private readonly pullTint = new THREE.Color();
  private lastStamp = -1;
  private lastTopology = -1;
  private lastVisible = -1;
  private lastPreview = -1;
  private lastCommand = false;
  private readonly planHash = new Float64Array(4);
  private hashAcc = 0;
  private readonly hashNode = (n: number): void => {
    this.hashAcc += ((n * 2654435761) % 1000003) + 1;
  };
  private emitFaction = 0;
  private emitAlpha = 0;
  private readonly emitPlanNode = (n: number): void => {
    const s = this.world.survey;
    if (n < 0 || n >= this.data.nodeCount) return;
    if (s.holder[n] === this.emitFaction || this.data.lat.nodes[n].blocked) return;
    const seed = ((n * 0.754877) % 1 + 1) % 1;
    // A rival (or orphaned) real Flag holds this node: it must be pulled before planting, so
    // mark it as a pull target instead of a ghost Flag.
    if (s.nodeFlag[n] >= 0 && s.nodeFlagOwner[n] !== this.emitFaction) {
      const a = this.emitAlpha + 0.15;
      this.decals.push(DECAL.pull, 0, 0, 1.6, 0, this.pullTint, a, 0.15, 10, 0.9, seed, n);
      this.glyphs.push(SPRITE.yank, 0, 3.4, 0, 0.34, this.pullTint, a, seed, 0, 12, n);
      return;
    }
    this.ghosts.push(GHOST.plan, n, 0, 0, WIND_YAW + seed * 0.5, this.color, this.emitAlpha * 0.55, seed);
    this.decals.push(DECAL.dash, 0, 0, 1.15, 0, this.color, this.emitAlpha, 0.6, 9, 0.5, 0.12, n);
  };

  constructor(scene: THREE.Scene, world: World, session: Session, data: SurveyData, shared: SurveyUniforms, decalMat: THREE.ShaderMaterial) {
    this.world = world;
    this.session = session;
    this.data = data;
    this.ghosts = new GhostFlagLayer(scene, shared, 1024);
    this.decals = new DecalLayer(scene, decalMat, 2048, 5);
    this.glyphs = new SpriteLayer(scene, shared, 1024, 9, false);
  }

  /** The Roman-numeral glyph atlas (shared with the other sprite layers). */
  get atlas(): THREE.CanvasTexture {
    return this.glyphs.glyphAtlas;
  }

  update(): void {
    const w = this.world;
    const p = this.session.playerFaction;
    const pf = w.factions[p];
    // Which factions' plans the player can see right now (bit f).
    const hideTargets = isMobileCommandLayout() && this.session.mobileMode !== 'build';
    let visible = hideTargets ? 0 : 1 << p;
    const acid = pf.drugActive.acidcop > w.time;
    for (let i = 0; i < FACTION_IDS.length; i++) {
      const f = FACTION_IDS[i];
      if (f === p) continue;
      const tap = pf.meshTap[f];
      if (!hideTargets && (acid || (tap !== undefined && tap > w.time))) visible |= 1 << f;
    }
    let planChanged = false;
    for (let f = 0; f < 4; f++) {
      this.hashAcc = w.factions[f].plan.size * 7919;
      if ((visible & (1 << f)) !== 0) w.factions[f].plan.forEach(this.hashNode);
      if (this.hashAcc !== this.planHash[f]) {
        this.planHash[f] = this.hashAcc;
        planChanged = true;
      }
    }
    const command = this.session.view === 'command';
    const preview = isMobileCommandLayout() && this.session.mobileMode !== 'build' ? [] : this.session.planPreview;
    this.hashAcc = preview.length * 31;
    for (let i = 0; i < preview.length; i++) this.hashNode(preview[i]);
    const previewHash = this.hashAcc;

    if (
      !planChanged &&
      command === this.lastCommand &&
      visible === this.lastVisible &&
      previewHash === this.lastPreview &&
      this.data.surveyStamp === this.lastStamp &&
      this.data.topology === this.lastTopology
    ) {
      return;
    }
    this.lastCommand = command;
    this.lastVisible = visible;
    this.lastPreview = previewHash;
    this.lastStamp = this.data.surveyStamp;
    this.lastTopology = this.data.topology;
    this.rebuild(visible);
  }

  private rebuild(visible: number): void {
    const w = this.world;
    const s = w.survey;
    this.ghosts.reset();
    this.decals.reset();
    this.glyphs.reset();

    for (let n = 0; n < this.data.nodeCount; n++) {
      const f = s.impliedOwner[n];
      const order = s.impliedOrder[n];
      if (f < 0 || order <= 0 || s.nodeFlagOwner[n] >= 0) continue;
      const seed = ((n * 0.754877) % 1 + 1) % 1;
      const fc = w.factions[f];
      this.color.setHex(fc ? fc.color : 0xffffff);
      this.ghosts.push(GHOST.implied, n, 0, 0, WIND_YAW + seed * 0.5, this.yellow, 0.9 - order * 0.12, seed);
      this.decals.push(DECAL.halo, 0, 0, 1.0 + order * 0.15, 0, this.color, 0.9, 0.7, 0.72, 0.35, seed, n);
      this.glyphColor.copy(this.color).lerp(this.white, 0.35);
      this.glyphs.push(SPRITE.glyph, 0, 3.15, 0, 0.24, this.glyphColor, 0.95, Math.min(3, order) - 1, 0, 9, n);
    }

    for (let f = 0; f < 4; f++) {
      if ((visible & (1 << f)) === 0) continue;
      if (f === this.session.playerFaction && this.session.view === 'command') continue;
      const fc = w.factions[f];
      this.color.setHex(fc.color);
      // Pull targets read red-orange in the player's plan, leaning to the planner's colour in rivals'.
      this.pullTint.copy(this.pull);
      if (f !== this.session.playerFaction) this.pullTint.lerp(this.color, 0.55);
      this.emitFaction = f;
      this.emitAlpha = f === this.session.playerFaction ? 0.85 : 0.55;
      fc.plan.forEach(this.emitPlanNode);
    }

    const preview = isMobileCommandLayout() && this.session.mobileMode !== 'build' ? [] : this.session.planPreview;
    if (preview.length > 0) {
      this.color.setHex(w.factions[this.session.playerFaction].color).lerp(this.white, 0.3);
      for (let i = 0; i < preview.length; i++) {
        const n = preview[i];
        if (n < 0 || n >= this.data.nodeCount) continue;
        this.decals.push(DECAL.dash, 0, 0, 1.45, 0, this.color, 1, 0.8, 7, 1.6, 0.25, n);
        this.ghosts.push(GHOST.plan, n, 0, 0, WIND_YAW, this.color, 0.6, 0.5);
      }
    }

    this.ghosts.commit();
    this.decals.commit();
    this.glyphs.commit();
  }

  dispose(): void {
    this.ghosts.dispose();
    this.decals.dispose();
    this.glyphs.dispose();
  }
}
