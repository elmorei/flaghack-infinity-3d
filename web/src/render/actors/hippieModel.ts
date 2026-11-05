/**
 * Hippie (Signifier) model: one merged low-poly geometry holding every body part and every
 * appearance variant (hair styles, hats, glasses, held props, faction bandana/armband). Each
 * vertex carries aTag = (part, slot, variant). Per instance, `aPose` (mat4 = 16 joint values)
 * drives a rigid-part skinning pass in the vertex shader and `aLook` (mat4) selects variants
 * and colours, so the whole crowd renders in one draw call. Tie-dye shirts are procedural in
 * the fragment shader from a per-instance seed.
 */
import * as THREE from 'three';
import { MeshBuilder, weld, type Vec3 } from './meshBuilder';
import { GLSL_COMMON, METAL_CAP } from './util';

/** Joint value indices inside the 16-float pose (column-major mat4 attribute). */
export const HJ = {
  torsoPitch: 0,
  torsoYaw: 1,
  torsoRoll: 2,
  headPitch: 3,
  headYaw: 4,
  armLPitch: 5,
  armLRoll: 6,
  armRPitch: 7,
  armRRoll: 8,
  thighL: 9,
  kneeL: 10,
  thighR: 11,
  kneeR: 12,
  spread: 13,
} as const;
export const POSE_SIZE = 16;

/** Look value indices inside the 16-float look (column-major mat4 attribute). */
export const HL = {
  shirtSeed: 0,
  skin: 1,
  hairColor: 2,
  pants: 3,
  hairStyle: 4,
  hat: 5,
  glasses: 6,
  prop: 7,
  factionR: 8,
  factionG: 9,
  factionB: 10,
  factionOn: 11,
  flash: 12,
  buff: 13,
  beard: 14,
  hatSeed: 15,
} as const;

export const PROP = { none: 0, axe: 1, hammer: 2, bongo: 3, lumber: 4 } as const;
export const HAIR_STYLES = 5; // 0 shag, 1 long, 2 afro, 3 buzz, 4 dreads
// Glasses ids: 0 none, 1 LED shades, 2 round sunglasses. Hats: 0 none, 1 headband,
// 2 flower crown, 3 bucket hat, 4 top hat, 5 beanie.

/** Rest-pose joint pivots (m), shared by the shader and CPU-side anchor maths. */
export const HP = {
  waist: [0, 0.92, 0],
  neck: [0, 1.45, 0],
  shoulderL: [0.2, 1.39, 0],
  shoulderR: [-0.2, 1.39, 0],
  hipL: [0.09, 0.9, 0],
  hipR: [-0.09, 0.9, 0],
  kneeL: [0.09, 0.49, 0],
  kneeR: [-0.09, 0.49, 0],
} as const satisfies Record<string, Vec3>;

/** Height of the head top in the rest pose (status icons and unit anchors sit above it). */
export const HIPPIE_HEAD_TOP = 1.74;

const PART = { hips: 0, torso: 1, head: 2, armL: 3, armR: 4, thighL: 5, shinL: 6, thighR: 7, shinR: 8 } as const;
const SLOT = {
  skin: 0,
  shirt: 1,
  pants: 2,
  hair: 3,
  shoes: 4,
  dark: 5,
  hat: 6,
  faction: 7,
  flower: 8,
  led: 9,
  lens: 10,
  wood: 11,
  metal: 12,
  drumskin: 13,
  bright: 14,
  gold: 15,
  lumber: 16,
  vine: 17,
} as const;
const CAT = { always: 0, hair: 1, hat: 2, glasses: 3, prop: 4, faction: 5, beard: 6 } as const;

function variant(cat: number, id: number): number {
  return cat * 16 + id;
}

function glslVec3(v: Vec3): string {
  return `vec3(${v.map((n) => n.toFixed(3)).join(', ')})`;
}

/** Spherical cap (hair/beanie): theta measured from the top. */
function cap(
  r: number,
  thetaLen: number,
  tiltX: number,
  at: Vec3,
  scale: Vec3 = [1, 1, 1],
  widthSegments = 9,
  heightSegments = 4,
): [THREE.BufferGeometry, THREE.Matrix4] {
  const g = new THREE.SphereGeometry(r, widthSegments, heightSegments, 0, Math.PI * 2, 0, thetaLen);
  const m = new THREE.Matrix4()
    .makeRotationX(tiltX)
    .premultiply(new THREE.Matrix4().makeScale(scale[0], scale[1], scale[2]))
    .setPosition(at[0], at[1], at[2]);
  return [g, m];
}

/** The detailed hippie (inside ~40 m of the camera). */
export function buildHippieGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder([{ name: 'aTag', size: 3 }]);
  const tag = (part: number, slot: number, v = 0) => ({ aTag: [part, slot, v] });

  // Hips and legs.
  b.with(tag(PART.hips, SLOT.pants)).seg([0, 0.83, 0], [0, 0.99, 0], 0.15, 0.155, 6, 0.72);
  for (const side of [1, -1]) {
    const thigh = side > 0 ? PART.thighL : PART.thighR;
    const shin = side > 0 ? PART.shinL : PART.shinR;
    const x = 0.09 * side;
    b.with(tag(thigh, SLOT.pants)).seg([x, 0.93, 0], [x * 1.05, 0.48, 0], 0.076, 0.06, 6);
    b.with(tag(shin, SLOT.pants)).seg([x * 1.05, 0.5, 0], [x * 1.05, 0.08, 0], 0.058, 0.048, 6);
    b.with(tag(shin, SLOT.shoes)).box([x * 1.05, 0.04, 0.045], [0.1, 0.08, 0.22]);
  }

  // Torso, neck, faction bandana.
  b.with(tag(PART.torso, SLOT.shirt))
    .seg([0, 0.95, 0], [0, 1.39, 0], 0.155, 0.185, 6, 0.68)
    .seg([0, 1.38, 0], [0, 1.45, 0], 0.185, 0.11, 6, 0.7);
  b.with(tag(PART.torso, SLOT.skin)).seg([0, 1.42, 0], [0, 1.5, 0], 0.05, 0.048, 6);
  b.with(tag(PART.torso, SLOT.faction, variant(CAT.faction, 1)))
    .torus([0, 1.445, 0.005], [0, 1, 0], 0.068, 0.024, 3, 8)
    .cone([0, 1.44, 0.07], [0, 1.31, 0.11], 0.05, 3);

  // Head.
  b.with(tag(PART.head, SLOT.skin))
    .ball([0, 1.6, 0], 0.125, 1, [0.95, 1.08, 1])
    .cone([0, 1.585, 0.11], [0, 1.565, 0.158], 0.022, 4)
    .ball([0.122, 1.6, 0], 0.028, 0)
    .ball([-0.122, 1.6, 0], 0.028, 0);
  b.with(tag(PART.head, SLOT.dark))
    .box([0.045, 1.617, 0.112], [0.028, 0.03, 0.012])
    .box([-0.045, 1.617, 0.112], [0.028, 0.03, 0.012])
    .box([0, 1.535, 0.11], [0.05, 0.012, 0.012]);

  // Hair styles.
  const hair = (id: number) => b.with(tag(PART.head, SLOT.hair, variant(CAT.hair, id)));
  hair(0).add(...cap(0.138, 1.45, -0.45, [0, 1.605, -0.012], [1, 0.95, 1.05]));
  hair(1).add(...cap(0.138, 1.4, -0.4, [0, 1.605, -0.012]))
    .box([0, 1.47, -0.075], [0.24, 0.34, 0.07])
    .box([0.112, 1.5, -0.01], [0.05, 0.26, 0.1])
    .box([-0.112, 1.5, -0.01], [0.05, 0.26, 0.1]);
  hair(2).ball([0, 1.68, -0.09], 0.19, 1, [1.08, 0.95, 1]);
  hair(3).add(...cap(0.13, 1.25, -0.35, [0, 1.605, -0.008]));
  hair(4).add(...cap(0.136, 1.4, -0.4, [0, 1.605, -0.012]));
  for (let i = 0; i < 5; i++) {
    const x = (i - 2) * 0.04;
    hair(4).seg([x, 1.63, -0.1], [x * 1.35, 1.36, -0.15], 0.022, 0.018, 4);
  }
  b.with(tag(PART.head, SLOT.hair, variant(CAT.beard, 1)))
    .ball([0, 1.515, 0.07], 0.09, 1, [1, 0.95, 0.75])
    .box([0, 1.553, 0.118], [0.09, 0.02, 0.02]);

  // Hats (id 0 = bare head has no geometry).
  b.with(tag(PART.head, SLOT.bright, variant(CAT.hat, 1))).torus([0, 1.645, 0], [0, 1, 0], 0.128, 0.017, 3, 12);
  b.with(tag(PART.head, SLOT.vine, variant(CAT.hat, 2))).torus([0, 1.675, -0.005], [0, 1, 0.12], 0.13, 0.012, 3, 10);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const p: Vec3 = [Math.sin(a) * 0.13, 1.675 - Math.cos(a) * 0.015, Math.cos(a) * 0.13];
    b.with(tag(PART.head, SLOT.flower, variant(CAT.hat, 2))).add(new THREE.OctahedronGeometry(0.034), new THREE.Matrix4().makeTranslation(p[0], p[1], p[2]));
  }
  b.with(tag(PART.head, SLOT.hat, variant(CAT.hat, 3)))
    .seg([0, 1.655, 0], [0, 1.675, 0], 0.215, 0.15, 8)
    .seg([0, 1.665, 0], [0, 1.785, 0], 0.142, 0.128, 8);
  b.with(tag(PART.head, SLOT.hat, variant(CAT.hat, 4)))
    .seg([0, 1.685, 0], [0, 1.7, 0], 0.2, 0.2, 10)
    .seg([0, 1.695, 0], [0, 1.99, 0], 0.118, 0.13, 10);
  b.with(tag(PART.head, SLOT.bright, variant(CAT.hat, 4))).seg([0, 1.705, 0], [0, 1.75, 0], 0.122, 0.12, 10);
  b.with(tag(PART.head, SLOT.hat, variant(CAT.hat, 5))).add(...cap(0.142, 1.42, -0.15, [0, 1.625, -0.01]))
    .ball([0, 1.775, -0.03], 0.045, 0);
  b.with(tag(PART.head, SLOT.bright, variant(CAT.hat, 5))).torus([0, 1.63, -0.012], [0, 1, 0.15], 0.135, 0.022, 3, 10);

  // Glasses.
  b.with(tag(PART.head, SLOT.led, variant(CAT.glasses, 1))).box([0, 1.617, 0.122], [0.23, 0.048, 0.022]);
  b.with(tag(PART.head, SLOT.lens, variant(CAT.glasses, 1)))
    .box([0.118, 1.62, 0.05], [0.012, 0.016, 0.14])
    .box([-0.118, 1.62, 0.05], [0.012, 0.016, 0.14]);
  for (const x of [0.046, -0.046]) {
    b.with(tag(PART.head, SLOT.lens, variant(CAT.glasses, 2))).seg([x, 1.617, 0.117], [x, 1.617, 0.13], 0.036, 0.036, 8);
  }
  b.with(tag(PART.head, SLOT.gold, variant(CAT.glasses, 2))).box([0, 1.622, 0.126], [0.03, 0.008, 0.008]);

  // Arms (left = +x) with hands; faction armband on the left upper arm.
  for (const side of [1, -1]) {
    const part = side > 0 ? PART.armL : PART.armR;
    const x = 0.2 * side;
    b.with(tag(part, SLOT.shirt)).seg([x, 1.41, 0], [x * 1.075, 1.16, 0], 0.06, 0.05, 6);
    b.with(tag(part, SLOT.skin))
      .seg([x * 1.075, 1.18, 0], [x * 1.125, 0.9, 0.02], 0.043, 0.036, 6)
      .ball([x * 1.13, 0.85, 0.025], 0.042, 0, [0.85, 1.15, 1]);
  }
  b.with(tag(PART.armL, SLOT.faction, variant(CAT.faction, 1))).torus([0.207, 1.28, 0], [0.05, -1, 0], 0.058, 0.019, 3, 8);

  // Held props.
  const hx = -0.226;
  b.with(tag(PART.armR, SLOT.wood, variant(CAT.prop, PROP.axe))).seg([hx, 0.93, 0.03], [hx, 0.3, 0.03], 0.018, 0.016, 5);
  b.with(tag(PART.armR, SLOT.metal, variant(CAT.prop, PROP.axe))).box([hx, 0.36, 0.085], [0.026, 0.13, 0.13]);
  b.with(tag(PART.armR, SLOT.wood, variant(CAT.prop, PROP.hammer))).seg([hx, 0.92, 0.03], [hx, 0.6, 0.03], 0.016, 0.015, 5);
  b.with(tag(PART.armR, SLOT.metal, variant(CAT.prop, PROP.hammer))).box([hx, 0.62, 0.035], [0.05, 0.05, 0.15]);
  for (const x of [0.11, -0.11]) {
    // Tall enough that a kneeling drummer's hands land on the skin (see the drum strokes).
    b.with(tag(PART.hips, SLOT.wood, variant(CAT.prop, PROP.bongo))).seg([x, 0.42, 0.38], [x, 0.8, 0.38], 0.095, x > 0 ? 0.12 : 0.105, 7);
    b.with(tag(PART.hips, SLOT.drumskin, variant(CAT.prop, PROP.bongo))).seg([x, 0.8, 0.38], [x, 0.81, 0.38], 0.12, x > 0 ? 0.12 : 0.105, 7);
  }
  b.with(tag(PART.torso, SLOT.lumber, variant(CAT.prop, PROP.lumber)))
    .box([-0.2, 1.5, 0.02], [0.09, 0.05, 1.15], [0.05, 0.1, 0])
    .box([-0.15, 1.555, -0.02], [0.09, 0.05, 1.05], [0.03, -0.06, 0.1])
    .box([-0.25, 1.555, 0.05], [0.09, 0.05, 0.95], [-0.04, 0.14, -0.1]);

  // Flat shading derives normals from screen derivatives: drop unused attributes to stay
  // well under the vertex attribute limit (instanced mat4s take 12 slots).
  return weld(b.build(), ['normal', 'uv']);
}

/**
 * The distant hippie (beyond ~40 m: a couple of dozen pixels tall). Same rig pivots, tags and
 * variant ids as the detailed model with a fifth of the triangles; details below a pixel drop
 * out (shoes, hands, face, headband, flower crown, round shades, drum skins). Everything that
 * reads at a distance stays: silhouette, tie-dye, skin, hair, hats, LED shades, props and the
 * faction bandana and armband.
 */
export function buildHippieFarGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder([{ name: 'aTag', size: 3 }]);
  const tag = (part: number, slot: number, v = 0) => ({ aTag: [part, slot, v] });

  b.with(tag(PART.hips, SLOT.pants)).seg([0, 0.83, 0], [0, 0.99, 0], 0.15, 0.155, 5, 0.72, true);
  for (const side of [1, -1]) {
    const x = 0.09 * side;
    b.with(tag(side > 0 ? PART.thighL : PART.thighR, SLOT.pants)).seg([x, 0.93, 0], [x * 1.05, 0.48, 0], 0.076, 0.06, 4, 1, true);
    b.with(tag(side > 0 ? PART.shinL : PART.shinR, SLOT.pants)).seg([x * 1.05, 0.5, 0], [x * 1.05, 0.0, 0.02], 0.058, 0.05, 4, 1, true);
  }
  b.with(tag(PART.torso, SLOT.shirt))
    .seg([0, 0.95, 0], [0, 1.39, 0], 0.155, 0.185, 6, 0.68, true)
    .seg([0, 1.38, 0], [0, 1.47, 0], 0.185, 0.1, 6, 0.7, true);
  b.with(tag(PART.torso, SLOT.faction, variant(CAT.faction, 1)))
    .seg([0, 1.42, 0.005], [0, 1.47, 0.005], 0.09, 0.085, 5, 1, true)
    .cone([0, 1.44, 0.07], [0, 1.31, 0.11], 0.05, 3);
  b.with(tag(PART.head, SLOT.skin)).ball([0, 1.6, 0], 0.125, 0, [0.95, 1.08, 1]);

  const hair = (id: number) => b.with(tag(PART.head, SLOT.hair, variant(CAT.hair, id)));
  hair(0).add(...cap(0.138, 1.45, -0.45, [0, 1.605, -0.012], [1, 0.95, 1.05], 5, 2));
  hair(1).add(...cap(0.138, 1.4, -0.4, [0, 1.605, -0.012], [1, 1, 1], 5, 2)).box([0, 1.47, -0.075], [0.26, 0.34, 0.08]);
  hair(2).ball([0, 1.68, -0.09], 0.19, 0, [1.08, 0.95, 1]);
  hair(3).add(...cap(0.13, 1.25, -0.35, [0, 1.605, -0.008], [1, 1, 1], 5, 2));
  hair(4).add(...cap(0.136, 1.4, -0.4, [0, 1.605, -0.012], [1, 1, 1], 5, 2)).box([0, 1.48, -0.14], [0.2, 0.3, 0.06]);
  b.with(tag(PART.head, SLOT.hair, variant(CAT.beard, 1))).add(
    new THREE.OctahedronGeometry(0.09),
    new THREE.Matrix4().makeScale(1, 0.95, 0.75).setPosition(0, 1.515, 0.07),
  );

  b.with(tag(PART.head, SLOT.hat, variant(CAT.hat, 3)))
    .seg([0, 1.655, 0], [0, 1.675, 0], 0.215, 0.15, 6, 1, true)
    .seg([0, 1.665, 0], [0, 1.785, 0], 0.142, 0.128, 5);
  b.with(tag(PART.head, SLOT.hat, variant(CAT.hat, 4)))
    .seg([0, 1.685, 0], [0, 1.7, 0], 0.2, 0.2, 6, 1, true)
    .seg([0, 1.695, 0], [0, 1.99, 0], 0.118, 0.13, 5);
  b.with(tag(PART.head, SLOT.hat, variant(CAT.hat, 5))).add(...cap(0.142, 1.42, -0.15, [0, 1.625, -0.01], [1, 1, 1], 5, 2));
  b.with(tag(PART.head, SLOT.led, variant(CAT.glasses, 1))).box([0, 1.617, 0.122], [0.23, 0.048, 0.022]);

  for (const side of [1, -1]) {
    const part = side > 0 ? PART.armL : PART.armR;
    const x = 0.2 * side;
    b.with(tag(part, SLOT.shirt)).seg([x, 1.41, 0], [x * 1.075, 1.16, 0], 0.06, 0.05, 4, 1, true);
    b.with(tag(part, SLOT.skin)).seg([x * 1.075, 1.18, 0], [x * 1.13, 0.82, 0.02], 0.043, 0.04, 4, 1, true);
  }
  b.with(tag(PART.armL, SLOT.faction, variant(CAT.faction, 1))).seg([0.205, 1.31, 0], [0.208, 1.25, 0], 0.07, 0.068, 5, 1, true);

  const hx = -0.226;
  b.with(tag(PART.armR, SLOT.wood, variant(CAT.prop, PROP.axe))).seg([hx, 0.93, 0.03], [hx, 0.3, 0.03], 0.02, 0.018, 3, 1, true);
  b.with(tag(PART.armR, SLOT.metal, variant(CAT.prop, PROP.axe))).box([hx, 0.36, 0.085], [0.026, 0.13, 0.13]);
  b.with(tag(PART.armR, SLOT.wood, variant(CAT.prop, PROP.hammer))).seg([hx, 0.92, 0.03], [hx, 0.6, 0.03], 0.018, 0.017, 3, 1, true);
  b.with(tag(PART.armR, SLOT.metal, variant(CAT.prop, PROP.hammer))).box([hx, 0.62, 0.035], [0.05, 0.05, 0.15]);
  for (const x of [0.11, -0.11]) {
    b.with(tag(PART.hips, SLOT.wood, variant(CAT.prop, PROP.bongo))).seg([x, 0.42, 0.38], [x, 0.81, 0.38], 0.095, x > 0 ? 0.12 : 0.105, 5, 1, true);
  }
  b.with(tag(PART.torso, SLOT.lumber, variant(CAT.prop, PROP.lumber))).box([-0.2, 1.53, 0.02], [0.2, 0.1, 1.1], [0.04, 0.05, 0]);

  return weld(b.build(), ['normal', 'uv']);
}

const HIPPIE_VERTEX_PARS = /* glsl */ `
attribute vec3 aTag;
attribute mat4 aPose;
attribute mat4 aLook;
varying vec3 vRest;
varying float vSlot;
varying vec4 vLookA;
varying vec4 vLookC;
varying vec4 vLookD;
const vec3 H_WAIST = ${glslVec3(HP.waist)};
const vec3 H_NECK = ${glslVec3(HP.neck)};
const vec3 H_SHOULDER_L = ${glslVec3(HP.shoulderL)};
const vec3 H_SHOULDER_R = ${glslVec3(HP.shoulderR)};
const vec3 H_HIP_L = ${glslVec3(HP.hipL)};
const vec3 H_HIP_R = ${glslVec3(HP.hipR)};
const vec3 H_KNEE_L = ${glslVec3(HP.kneeL)};
const vec3 H_KNEE_R = ${glslVec3(HP.kneeR)};
mat3 hRotX(float a) { float c = cos(a); float s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 hRotY(float a) { float c = cos(a); float s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
mat3 hRotZ(float a) { float c = cos(a); float s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
bool hippieVisible(float v) {
  float cat = floor(v / 16.0 + 0.001);
  float id = v - cat * 16.0;
  if (cat < 0.5) return true;
  if (cat < 1.5) return abs(id - aLook[1].x) < 0.5;
  if (cat < 2.5) return abs(id - aLook[1].y) < 0.5;
  if (cat < 3.5) return abs(id - aLook[1].z) < 0.5;
  if (cat < 4.5) return abs(id - aLook[1].w) < 0.5;
  if (cat < 5.5) return aLook[2].w > 0.5;
  return abs(id - aLook[3].z) < 0.5;
}
vec3 hippiePose(vec3 p) {
  // Hidden variants collapse to one point far below ground: zero-area, never rasterized.
  if (!hippieVisible(aTag.z)) return vec3(0.0, -50.0, 0.0);
  float part = aTag.x;
  mat3 torso = hRotY(aPose[0].y) * hRotX(aPose[0].x) * hRotZ(aPose[0].z);
  if (part < 0.5) return p;
  if (part < 1.5) return torso * (p - H_WAIST) + H_WAIST;
  if (part < 2.5) {
    p = hRotY(aPose[1].x) * hRotX(aPose[0].w) * (p - H_NECK) + H_NECK;
    return torso * (p - H_WAIST) + H_WAIST;
  }
  if (part < 3.5) {
    p = hRotX(-aPose[1].y) * hRotZ(aPose[1].z) * (p - H_SHOULDER_L) + H_SHOULDER_L;
    return torso * (p - H_WAIST) + H_WAIST;
  }
  if (part < 4.5) {
    p = hRotX(-aPose[1].w) * hRotZ(-aPose[2].x) * (p - H_SHOULDER_R) + H_SHOULDER_R;
    return torso * (p - H_WAIST) + H_WAIST;
  }
  float spread = aPose[3].y;
  if (part < 5.5) return hRotZ(spread) * hRotX(-aPose[2].y) * (p - H_HIP_L) + H_HIP_L;
  if (part < 6.5) {
    p = hRotX(aPose[2].z) * (p - H_KNEE_L) + H_KNEE_L;
    return hRotZ(spread) * hRotX(-aPose[2].y) * (p - H_HIP_L) + H_HIP_L;
  }
  if (part < 7.5) return hRotZ(-spread) * hRotX(-aPose[2].w) * (p - H_HIP_R) + H_HIP_R;
  p = hRotX(aPose[3].x) * (p - H_KNEE_R) + H_KNEE_R;
  return hRotZ(-spread) * hRotX(-aPose[2].w) * (p - H_HIP_R) + H_HIP_R;
}
`;

const HIPPIE_FRAGMENT_PARS = /* glsl */ `
uniform float uTime;
uniform float uFactionGlow;
uniform vec3 uSkin[6];
uniform vec3 uHair[8];
uniform vec3 uPants[6];
uniform vec3 uHat[8];
uniform vec3 uBright[8];
varying vec3 vRest;
varying float vSlot;
varying vec4 vLookA;
varying vec4 vLookC;
varying vec4 vLookD;
${GLSL_COMMON}
vec3 hippieTieDye(vec3 lp, float seed) {
  float kind = floor(seed * 5.0);
  vec2 q = vec2(lp.x, lp.y - 1.17) * 7.0;
  float r = length(q);
  // atan(0, 0) is undefined (NaN on some GPUs) on the chest centre line; nudge x.
  float a = atan(q.y, q.x + 1e-4) / 6.2832;
  float h;
  if (kind < 1.0) h = a + r * 0.32 + seed * 7.0;
  else if (kind < 2.0) h = r * 0.42 + seed * 5.0;
  else if (kind < 3.0) h = lp.y * 2.6 + sin(lp.x * 11.0 + seed * 40.0) * 0.18 + seed * 3.0;
  else if (kind < 4.0) h = a * 2.0 + sin(r * 2.5) * 0.25 + seed * 9.0;
  else h = seed * 13.0 + lp.y * 0.6;
  float sat = kind < 4.0 ? 0.78 : 0.5;
  vec3 c = fhHsv2rgb(vec3(fract(h), sat, 0.95));
  c *= 0.86 + 0.14 * sin(a * 37.7 + r * 3.0);
  return fhSrgbToLinear(c);
}
vec3 hippieAlbedo(float slot) {
  int s = int(slot + 0.5);
  if (s == ${SLOT.skin}) return uSkin[int(vLookA.y * 5.999)];
  if (s == ${SLOT.shirt}) return hippieTieDye(vRest, vLookA.x);
  if (s == ${SLOT.pants}) return uPants[int(vLookA.w * 5.999)];
  if (s == ${SLOT.hair}) return uHair[int(vLookA.z * 7.999)];
  if (s == ${SLOT.shoes}) return vec3(0.03, 0.025, 0.02);
  if (s == ${SLOT.dark}) return vec3(0.012);
  if (s == ${SLOT.hat}) return uHat[int(vLookD.w * 7.999)];
  if (s == ${SLOT.faction}) return vLookC.rgb;
  if (s == ${SLOT.flower}) return fhSrgbToLinear(fhHsv2rgb(vec3(fhHash13(floor(vRest * 40.0)), 0.55, 1.0)));
  if (s == ${SLOT.led}) return fhSrgbToLinear(fhHsv2rgb(vec3(fract(uTime * 0.6 + vRest.x * 3.0), 1.0, 1.0)));
  if (s == ${SLOT.lens}) return vec3(0.015, 0.015, 0.025);
  if (s == ${SLOT.wood}) return vec3(0.3, 0.16, 0.07);
  if (s == ${SLOT.metal}) return vec3(0.55, 0.57, 0.6);
  if (s == ${SLOT.drumskin}) return vec3(0.8, 0.68, 0.45);
  if (s == ${SLOT.bright}) return uBright[int(fract(vLookD.w * 7.31) * 7.999)];
  if (s == ${SLOT.gold}) return vec3(0.85, 0.6, 0.18);
  if (s == ${SLOT.lumber}) return vec3(0.6, 0.4, 0.2);
  return vec3(0.08, 0.3, 0.06);
}
`;

export interface HippieUniforms {
  uTime: THREE.IUniform<number>;
  uFactionGlow: THREE.IUniform<number>;
}

/** Palettes (sRGB hex; THREE.Color converts to linear for the shader). */
export const HIPPIE_SKIN_TONES = [0xf6d2b5, 0xeab68f, 0xc98e63, 0x9c6a45, 0x6e4a31, 0x4a3122] as const;
/** Same bucket boundaries as the model shader's int(vLookA.y * 5.999). */
export function hippieSkinIndex(look: number): number {
  return Math.floor(Math.max(0, Math.min(1, Number.isFinite(look) ? look : 0)) * 5.999);
}
const HAIR = [0x2a1a10, 0x4b2e19, 0x7a4a24, 0xc9a25a, 0xe8d29a, 0xa4401e, 0x8a8a8a, 0x6a3fb0];
const PANTS = [0x2f4a78, 0x3b3f46, 0x6b4a2e, 0x7a6a3a, 0x5a2f5f, 0x2f5a3a];
const HAT = [0x8a5a2e, 0x2b2b2b, 0xd8c8a0, 0x3d6b3d, 0x7a2e2e, 0x2e4e7a, 0xc96a2e, 0x6a3a8a];
const BRIGHT = [0xff3b6b, 0xffb000, 0x3bd6ff, 0x9bff3b, 0xff6bf0, 0xffffff, 0xff5a1f, 0x6b5bff];

function colorArray(hexes: readonly number[]): THREE.Color[] {
  return hexes.map((h) => new THREE.Color(h));
}

/**
 * Patch a standard (colour pass) or depth (shadow pass) material with the hippie pose and
 * variant logic. Uniform objects are shared so callers update them once per frame.
 */
export function patchHippieMaterial(mat: THREE.Material, u: HippieUniforms, depth: boolean): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = u.uTime;
    shader.uniforms.uFactionGlow = u.uFactionGlow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${HIPPIE_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', 'vec3 transformed = hippiePose(position);')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vRest = position;
        vSlot = aTag.y;
        vLookA = aLook[0];
        vLookC = aLook[2];
        vLookD = aLook[3];`,
      );
    if (depth) return;
    shader.uniforms.uSkin = { value: colorArray(HIPPIE_SKIN_TONES) };
    shader.uniforms.uHair = { value: colorArray(HAIR) };
    shader.uniforms.uPants = { value: colorArray(PANTS) };
    shader.uniforms.uHat = { value: colorArray(HAT) };
    shader.uniforms.uBright = { value: colorArray(BRIGHT) };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${HIPPIE_FRAGMENT_PARS}`)
      .replace('#include <color_fragment>', 'diffuseColor.rgb = hippieAlbedo(vSlot);')
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = 0.85;
        if (abs(vSlot - ${SLOT.lens}.0) < 0.5 || abs(vSlot - ${SLOT.led}.0) < 0.5) roughnessFactor = 0.18;
        if (abs(vSlot - ${SLOT.metal}.0) < 0.5 || abs(vSlot - ${SLOT.gold}.0) < 0.5) roughnessFactor = 0.35;`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `float metalnessFactor = (abs(vSlot - ${SLOT.metal}.0) < 0.5 || abs(vSlot - ${SLOT.gold}.0) < 0.5) ? ${METAL_CAP.toFixed(2)} : 0.0;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (abs(vSlot - ${SLOT.led}.0) < 0.5) totalEmissiveRadiance += diffuseColor.rgb * 2.2;
        if (abs(vSlot - ${SLOT.faction}.0) < 0.5) totalEmissiveRadiance += diffuseColor.rgb * uFactionGlow;
        totalEmissiveRadiance += vec3(1.0) * vLookD.x * 0.9;
        totalEmissiveRadiance += vec3(1.0, 0.72, 0.2) * vLookD.y * 0.2;`,
      );
  };
  mat.customProgramCacheKey = () => (depth ? 'fh-hippie-depth' : 'fh-hippie');
}
