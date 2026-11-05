/**
 * Drum Circle: a ring of log seats with painted hand drums (djembes) around a small fire in
 * a stone ring, two poles strung with faction/yellow prayer bunting. When hippies drum here
 * the djembe skins bounce to a five-voice polyrhythm, the fire leaps on the downbeats and a
 * faction-coloured ritual glow pulses on the ground.
 */
import * as THREE from 'three';
import { DRUM_REACH } from '../../sim/constants';
import type { GameEvent } from '../../sim/events';
import type { Building } from '../../sim/types';
import { BuildingView, SPARK_GOLD, type FrameInfo, type BuildingSpritePresentation } from './buildingView';
import { Fire } from './fire';
import type { ModelBuilder, ModelRecipe, StructureKit } from './kit';
import { buildBunting } from './shapes';
import { damp } from './util';

const TAU = Math.PI * 2;
const SEATS = 6;
const SEAT_R = 2.2;
const DRUM_R = 1.68;
const RADIUS = 3.0;
/** Beats per second of each drum voice (a five-against-three-against-four texture). */
const TEMPO = [2.5, 1.5, 2.0, 3.0, 1.0, 2.0];
const DRUM_COLORS = [0xc0392b, 0x2e86ab, 0xf2b705, 0x7b4cc2, 0x27ae60, 0xe86fb0];
const FIRE_CORE = new THREE.Color(1.0, 0.9, 0.6);
const FIRE_BODY = new THREE.Color(1.0, 0.42, 0.08);

function buildCircle(mb: ModelBuilder): void {
  // Stone ring with coals.
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * TAU;
    mb.add('stone', new THREE.DodecahedronGeometry(0.16, 0), Math.cos(a) * 0.62, 0.1, Math.sin(a) * 0.62, a, a * 2, 0, 1.2, 0.8, 1);
  }
  mb.add('ember', new THREE.CircleGeometry(0.52, 16), 0, 0.04, 0, -Math.PI / 2, 0, 0);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.4;
    mb.rod('woodDark', [Math.cos(a) * 0.45, 0.08, Math.sin(a) * 0.45], [Math.cos(a) * 0.08, 0.38, Math.sin(a) * 0.08], 0.05, 6);
  }
  // Log seats, tangential to the ring, with pale cut ends.
  for (let i = 0; i < SEATS; i++) {
    const a = (i / SEATS) * TAU + TAU / (SEATS * 2);
    const x = Math.cos(a) * SEAT_R;
    const z = Math.sin(a) * SEAT_R;
    // Tangential log: axis along (-sin a, 0, cos a); pale cut ends face outward along it.
    const tx = -Math.sin(a);
    const tz = Math.cos(a);
    mb.add('bark', new THREE.CylinderGeometry(0.2, 0.22, 1.25, 12), x, 0.21, z, 0, Math.PI / 2 - a, Math.PI / 2);
    for (const s of [-1, 1]) {
      mb.add('woodPale', new THREE.CircleGeometry(0.205, 12), x + tx * s * 0.626, 0.21, z + tz * s * 0.626, 0, -a + (s > 0 ? 0 : Math.PI), 0);
    }
  }
  // Prayer bunting between two poles across the circle.
  const pa: [number, number, number] = [-2.55, 2.3, -0.9];
  const pb: [number, number, number] = [2.55, 2.3, 0.9];
  mb.rod('woodDark', [pa[0], 0, pa[2]], [pa[0], pa[1] + 0.1, pa[2]], 0.05, 6);
  mb.rod('woodDark', [pb[0], 0, pb[2]], [pb[0], pb[1] + 0.1, pb[2]], 0.05, 6);
  buildBunting(mb, pa, pb, 12, 0.35);
}

/** Djembe goblet body (unit, top at y = 0.6) for instancing. */
function djembeBody(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const prof: [number, number][] = [
    [0.12, 0],
    [0.115, 0.05],
    [0.085, 0.2],
    [0.075, 0.28],
    [0.11, 0.38],
    [0.16, 0.5],
    [0.175, 0.58],
    [0.17, 0.6],
  ];
  for (const [r, y] of prof) pts.push(new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(pts, 16);
}

/** Static model of the Drum Circle (shared with its placement ghost). */
export const DRUMCIRCLE_MODEL: ModelRecipe = { name: 'drumcircle', build: buildCircle };

export class DrumCircleView extends BuildingView {
  private readonly fire: Fire;
  private readonly bodies: THREE.InstancedMesh;
  private readonly skins: THREE.InstancedMesh;
  private readonly glow: THREE.Mesh;
  private readonly glowMat: THREE.MeshBasicMaterial;
  private readonly drumPos: [number, number][] = [];
  private readonly phase = new Float32Array(SEATS);
  private readonly hit = new Float32Array(SEATS);
  private drumming = 0;
  private readonly m = new THREE.Matrix4();
  private readonly color = new THREE.Color();

  constructor(kit: StructureKit, b: Building) {
    super(kit, b, 2.4, RADIUS);
    this.addStatic(kit.model(DRUMCIRCLE_MODEL.name, DRUMCIRCLE_MODEL.build));
    this.fire = new Fire(kit, 3);
    this.fire.style.core.copy(FIRE_CORE);
    this.fire.style.body.copy(FIRE_BODY);
    this.fire.style.streak.copy(FIRE_BODY);
    this.fire.style.width = 0.95;
    this.fire.style.height = 1.15;
    this.fire.mesh.position.y = 0.06;
    this.effects.add(this.fire.mesh);

    this.bodies = this.mats.instancedMesh(kit.geometry('djembe', djembeBody), 'plain', SEATS, true);
    this.skins = this.mats.instancedMesh(
      kit.geometry('djembeSkin', () => new THREE.CircleGeometry(0.17, 16).rotateX(-Math.PI / 2).translate(0, 0.602, 0)),
      'plain',
      SEATS,
      false,
    );
    for (let i = 0; i < SEATS; i++) {
      const a = (i / SEATS) * TAU + TAU / (SEATS * 2);
      this.drumPos.push([Math.cos(a) * DRUM_R, Math.sin(a) * DRUM_R]);
      this.bodies.setColorAt(i, this.color.setHex(DRUM_COLORS[i]));
      this.skins.setColorAt(i, this.color.setHex(0xe6d8b8));
      this.phase[i] = i * 0.37;
    }
    this.layoutDrums();
    this.body.add(this.bodies, this.skins);

    this.glowMat = new THREE.MeshBasicMaterial({
      map: kit.texture('glow'),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.glow = new THREE.Mesh(kit.geometry('groundQuad', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), this.glowMat);
    this.glow.scale.setScalar(RADIUS * 2.6);
    this.glow.position.y = 0.05;
    this.glow.renderOrder = 1;
    this.root.add(this.glow);
  }

  protected override onFaction(color: THREE.Color): void {
    this.glowMat.color.copy(color);
  }

  private layoutDrums(): void {
    for (let i = 0; i < SEATS; i++) {
      const [x, z] = this.drumPos[i];
      const k = this.hit[i];
      // Skin hit: a quick squash of the whole drum, read as a bounce.
      this.m.makeScale(1 + k * 0.05, 1 - k * 0.07, 1 + k * 0.05).setPosition(x, 0, z);
      this.bodies.setMatrixAt(i, this.m);
      this.skins.setMatrixAt(i, this.m);
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.skins.instanceMatrix.needsUpdate = true;
  }

  protected override animate(b: Building, f: FrameInfo, active: boolean): void {
    // Count this camp's drummers (hippie status, same rule radius as the sim).
    let drummers = 0;
    if (active) {
      const r = RADIUS + DRUM_REACH;
      for (const h of f.world.hippies.values()) {
        if (h.status !== 'drumming' || h.faction !== b.faction) continue;
        const dx = h.pos.x - b.pos.x;
        const dz = h.pos.z - b.pos.z;
        if (dx * dx + dz * dz <= r * r) drummers++;
      }
    }
    this.drumming = damp(this.drumming, Math.min(1, drummers / 2), 3, f.dt);
    let beat = 0;
    for (let i = 0; i < SEATS; i++) {
      this.phase[i] += f.dt * TEMPO[i] * (i < drummers + 2 ? 1 : 0.5);
      if (this.phase[i] >= 1) {
        this.phase[i] -= 1;
        if (this.drumming > 0.2) this.hit[i] = 1;
      }
      this.hit[i] = Math.max(0, this.hit[i] - f.dt * 7);
      beat = Math.max(beat, this.hit[i]);
    }
    this.layoutDrums();

    const st = this.fire.style;
    st.intensity = active ? 0.9 + 0.35 * beat * this.drumming : 0;
    st.height = 1.1 + 0.45 * beat * this.drumming;
    st.turb = 0.5 + this.drumming * 0.6;
    st.flicker = 0.15;
    this.fire.apply();
    this.fire.mesh.visible = active;
    this.glowMat.opacity = this.drumming * (0.18 + 0.22 * beat) * (0.5 + 0.5 * f.night);
  }

  override onEvent(e: GameEvent, f: FrameInfo): void {
    super.onEvent(e, f);
    if (e.t === 'recruited' && e.via === 'drumcircle' && e.faction === this.shownFaction) {
      const h = f.world.hippies.get(e.hippieId);
      const p = this.root.position;
      if (h && (h.pos.x - p.x) ** 2 + (h.pos.z - p.z) ** 2 < 64) this.burst(f.sparks, SPARK_GOLD, 24, 1.2, 2.2, 0.14, -1);
    }
  }

  protected override spritePresentation(_b: Building, _f: FrameInfo, active: boolean): BuildingSpritePresentation {
    const drumming = active && this.drumming > 0.1;
    return { state: drumming ? 'active' : 'idle', moving: active };
  }

  override dispose(): void {
    this.fire.dispose();
    this.bodies.dispose();
    this.skins.dispose();
    this.glowMat.dispose();
    super.dispose();
  }
}
