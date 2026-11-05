/**
 * Hearth Ward: a pentagonal stone obelisk on a stepped plinth, its faces cut with runes that
 * glow in the owner's colour, a brass pyramidion, and above it the all-seeing eye: a gilded
 * two-faced lens in a brass ring, slowly scanning the camp. Every vibe-check pulse
 * (wardPulse) flares the eye and runes and sends a faction-coloured shock ring across the
 * ground out to the pulse radius.
 */
import * as THREE from 'three';
import { WARD_PULSE_RADIUS, WARD_EYE_CENTER_HEIGHT, WARD_REVEAL_HEIGHT, WARD_EYE_OUTER_RADIUS } from '../../sim/constants';
import type { GameEvent } from '../../sim/events';
import type { Building } from '../../sim/types';
import { BuildingView, type FrameInfo, type BuildingSpritePresentation } from './buildingView';
import type { ModelBuilder, ModelRecipe, StructureKit } from './kit';
import { extrudeUp, faceted, pentagon } from './shapes';
import { damp } from './util';

const TAU = Math.PI * 2;
const SHAFT_Y = 0.5;
const SHAFT_H = 3.2;
export const WARD_EYE_Y = WARD_EYE_CENTER_HEIGHT;
const EYE_Y = WARD_EYE_Y;
const EYE_R = 0.55;
const PULSE_TIME = 0.75;

function buildWard(mb: ModelBuilder): void {
  mb.add('stone', extrudeUp(pentagon(1.45, TAU / 10), 0.2, 0.03), 0, 0, 0);
  mb.add('stone', extrudeUp(pentagon(1.08, TAU / 10), 0.18, 0.02), 0, 0.26, 0);
  // Obelisk shaft: tapered pentagonal prism, rune-cut (runes material glows in faction colour).
  const shaft = faceted(new THREE.CylinderGeometry(0.33, 0.56, SHAFT_H, 5, 1, true));
  mb.add('runes', shaft, 0, SHAFT_Y + SHAFT_H / 2, 0, 0, TAU / 10, 0);
  mb.add('brass', faceted(new THREE.CylinderGeometry(0.6, 0.62, 0.06, 5)), 0, SHAFT_Y + 0.03, 0, 0, TAU / 10, 0);
  mb.add('brass', faceted(new THREE.CylinderGeometry(0.345, 0.36, 0.06, 5)), 0, SHAFT_Y + SHAFT_H - 0.03, 0, 0, TAU / 10, 0);
  // Pyramidion and the rod that carries the eye.
  mb.add('brass', faceted(new THREE.CylinderGeometry(0.0, 0.36, 0.42, 5)), 0, SHAFT_Y + SHAFT_H + 0.21, 0, 0, TAU / 10, 0);
  mb.rod('brass', [0, SHAFT_Y + SHAFT_H + 0.3, 0], [0, EYE_Y - EYE_R - 0.03, 0], 0.03, 6);
}

/** The scanning eye: brass ring, two lens faces, faction iris and black pupil on each side. */
function buildEye(mb: ModelBuilder): void {
  mb.add('brass', new THREE.TorusGeometry(EYE_R + 0.03, 0.045, 8, 36), 0, 0, 0);
  for (const s of [-1, 1]) {
    const ry = s > 0 ? 0 : Math.PI;
    mb.add('eye', new THREE.CircleGeometry(EYE_R, 36), 0, 0, s * 0.012, 0, ry, 0);
    // The painted almond sits slightly below centre on the lens face (see paintEye).
    mb.add('trim', new THREE.CircleGeometry(EYE_R * 0.16, 20), 0, -EYE_R * 0.12, s * 0.016, 0, ry, 0);
    mb.add('paint', new THREE.CircleGeometry(EYE_R * 0.075, 16), 0, -EYE_R * 0.12, s * 0.019, 0, ry, 0, 1, 1, 1, 0x050505);
  }
  // Gimbal pins.
  for (const s of [-1, 1]) mb.add('brass', new THREE.SphereGeometry(0.06, 10, 8), s * (EYE_R + 0.07), 0, 0);
}

/** Static model of the Hearth Ward (shared with its placement ghost). */
export const WARD_MODEL: ModelRecipe = { name: 'ward', build: buildWard };
export const WARD_EYE_MODEL: ModelRecipe = { name: 'wardEye', build: buildEye };

export class WardView extends BuildingView {
  private readonly eye = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private pulse = 1;
  private flare = 0;

  constructor(kit: StructureKit, b: Building) {
    super(kit, b, WARD_REVEAL_HEIGHT, 2.2);
    this.addStatic(kit.model(WARD_MODEL.name, WARD_MODEL.build));
    this.eye.position.y = EYE_Y;
    this.addStatic(kit.model(WARD_EYE_MODEL.name, WARD_EYE_MODEL.build), this.eye);
    this.body.add(this.eye);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(kit.geometry('pulseRing', () => new THREE.RingGeometry(0.86, 1, 64).rotateX(-Math.PI / 2)), this.ringMat);
    this.ring.position.y = 0.08;
    this.ring.visible = false;
    this.ring.renderOrder = 1;
    this.root.add(this.ring);
  }

  protected override onFaction(color: THREE.Color): void {
    this.ringMat.color.copy(color);
  }

  protected override animate(b: Building, f: FrameInfo, active: boolean): void {
    void b;
    // Scan: a slow sweep with a curious glance now and then.
    if (active) this.eye.rotation.y += f.dt * (0.45 + 0.35 * Math.sin(f.t * 0.37 + this.seed));
    this.eye.rotation.x = active ? Math.sin(f.t * 0.8 + this.seed) * 0.12 : 0.35;
    this.flare = damp(this.flare, 0, 3, f.dt);
    const glow = active ? 1 + 0.25 * Math.sin(f.t * 1.7) + this.flare * 3 : 0.15;
    const runes = this.mats.get('runes');
    if (runes instanceof THREE.MeshStandardMaterial) runes.emissiveIntensity = 1.2 * glow;
    const iris = this.mats.get('trim');
    if (iris instanceof THREE.MeshStandardMaterial) iris.emissiveIntensity = 1.2 * glow;
    if (this.pulse < 1) {
      this.pulse = Math.min(1, this.pulse + f.dt / PULSE_TIME);
      const r = WARD_PULSE_RADIUS * (1 - (1 - this.pulse) * (1 - this.pulse));
      this.ring.scale.set(r, 1, r);
      this.ringMat.opacity = (1 - this.pulse) * 0.85;
      this.ring.visible = true;
    } else {
      this.ring.visible = false;
    }
  }

  override onEvent(e: GameEvent, f: FrameInfo): void {
    super.onEvent(e, f);
    if (e.t !== 'wardPulse' || e.buildingId !== this.id) return;
    this.pulse = 0;
    this.flare = 1;
    const p = this.root.position;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU;
      f.sparks.emit(p.x, p.y + EYE_Y, p.z, Math.cos(a) * 4, (Math.random() - 0.3) * 2, Math.sin(a) * 4, 0.12, 0.04, 0.6, this.factionColor, 1, -2);
    }
  }

  protected override spritePresentation(_b: Building, _f: FrameInfo, active: boolean): BuildingSpritePresentation {
    return { state: active && this.pulse < 1 ? 'pulse' : 'idle', moving: active,
      height: WARD_EYE_CENTER_HEIGHT + WARD_EYE_OUTER_RADIUS, highlight: active ? this.flare : 0 };
  }

  override dispose(): void {
    this.ringMat.dispose();
    super.dispose();
  }
}
