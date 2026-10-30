import { groundHeight } from '../../../../sim/terrain';
import { MAP_HALF } from '../../../../sim/constants';
import * as fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { BossCombatPose, BOSS_COMBAT_TIMING, BOSS_WALK_STRIDE } from './combatPose';
import { prepareBossModel, disposeBossModel, BOSS_SCALE } from './bossModel';
import { CROUCH_WALK_DATA } from './crouchWalkData';
import { BossReveal } from './bossReveal';
import { createDayState } from '../../timeOfDay';
import type { EnvContext } from '../../envTypes';
import { BOSS_GAMEPLAY_SCALE } from '../../../../sim/bossDimensions';
import { BOSS_TIMING, createBossEyeState, type BossState } from '../../../../sim/boss';
import { bossRecoilPoseTime } from '../../../../sim/bossRecoil';

async function model() {
  const b = fs.readFileSync(new URL('../../../../../public/models/boss/skeletal-boss.glb', import.meta.url));
  return prepareBossModel((await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '')).scene);
}
function boss(action: BossState['action'] = 'idle', crouched = false): BossState {
  return { lightning: [], id: 88, pos: { x: 12, z: -7 }, yaw: .7, hp: 5000, maxHp: 5000, spawnedAt: 100, action, actionAt: 110,
    eye: createBossEyeState(100), actionSeq: 3, hitSeq: -1, target: null, focusFaction: null,
    objectiveAltarId: null, routeStartStride: 0, nextSceneryStompStride: 0, opportunisticAfter: 0, retaliateId: null, retaliateUntil: 0,
    nextAttackAt: 0, interruptImmuneUntil: 0, deathAt: null, barrier: null, stride: 0, held: null, crouched };
}
function signature(m: THREE.Group): number[] {
  const values: number[] = [];
  m.traverse((o) => { if (o instanceof THREE.Bone) values.push(...o.position.toArray(), ...o.quaternion.toArray()); });
  return values;
}
function point(m: THREE.Group, name: string): THREE.Vector3 { return m.getObjectByName(name)!.getWorldPosition(new THREE.Vector3()); }
function matrices(m: THREE.Group): number[] { const a: number[] = []; m.updateMatrixWorld(true); m.traverse((o) => { if (o instanceof THREE.Bone) a.push(...o.matrix.elements); }); return a; }

describe('approved-rig combat presentation', () => {
  it('uses the authentic complete native in-place crouch cycle with a closed seam', () => {
    expect(CROUCH_WALK_DATA.duration).toBe(2.4); expect(CROUCH_WALK_DATA.stride).toBe(6);
    expect(CROUCH_WALK_DATA.bones).toHaveLength(109);
    expect(CROUCH_WALK_DATA.frames).toHaveLength(61);
    expect(CROUCH_WALK_DATA.frames[0].positions).toEqual(CROUCH_WALK_DATA.frames[60].positions);
    expect(CROUCH_WALK_DATA.frames[0].quaternions).toEqual(CROUCH_WALK_DATA.frames[60].quaternions);
    const i = CROUCH_WALK_DATA.bones.indexOf('root');
    for (const frame of CROUCH_WALK_DATA.frames) expect(frame.positions[i * 3 + 2]).toBeCloseTo(-3.55, 5);
  });
  it('samples every action reversibly without consuming host state or changing the 32m scale', async () => {
    const m = await model(), p = new BossCombatPose(m);
    for (const action of ['idle', 'walk', 'crouch', 'crouchWalk', 'rise', 'swipe', 'stomp', 'grab', 'recoil', 'death', 'dead'] as const) {
      const b = boss(action, true); b.stride = 1.4; if (action === 'death' || action === 'dead') b.deathAt = 110;
      const before = JSON.stringify(b);
      p.sample(b, 111.1); const first = signature(m);
      p.sample(boss('walk'), 140); p.sample(b, 111.1);
      expect(signature(m)).toEqual(first); expect(JSON.stringify(b)).toBe(before);
      expect(signature(m).every(Number.isFinite)).toBe(true);
      expect(m.scale.toArray()).toEqual([1, 1, 1]);
    }
    disposeBossModel(m);
  });
  it('recoils through only the existing crouched flinch, reverses to rest, and never moves the planted legs', async () => {
    const m = await model(), p = new BossCombatPose(m), b = boss('recoil', true);
    p.sample(b, b.actionAt); const start = signature(m), head = m.getObjectByName('head')!.quaternion.clone();
    const lower = ['root', 'pelvis', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'];
    const low = lower.map(name => m.getObjectByName(name)!.matrixWorld.clone());
    p.sample(b, b.actionAt + .25);
    expect(m.getObjectByName('head')!.quaternion.angleTo(head)).toBeGreaterThan(.1);
    for (const age of [0, .04, .13, .25, .5, .9, 1, 3]) {
      p.sample(b, b.actionAt + age); const recoil = signature(m);
      lower.forEach((name, i) => m.getObjectByName(name)!.matrixWorld.elements.forEach((v, j) => expect(v).toBeCloseTo(low[i].elements[j], 5)));
      p.sample(boss('death', true), b.actionAt + bossRecoilPoseTime(age));
      const original = signature(m);
      recoil.forEach((v, i) => expect(v).toBeCloseTo(original[i], 6));
    }
    p.sample(b, b.actionAt + 1); expect(signature(m)).toEqual(start);
    disposeBossModel(m);
  });
  it('loops by actual distance with no accumulated root translation', async () => {
    const m = await model(), p = new BossCombatPose(m);
    for (const action of ['walk', 'crouchWalk'] as const) {
      const b = boss(action); b.stride = 0; p.sample(b, 110); const first = matrices(m);
      b.stride = (action === 'walk' ? BOSS_WALK_STRIDE : CROUCH_WALK_DATA.stride * BOSS_SCALE) * 20; p.sample(b, 110);
      matrices(m).forEach((v, i) => expect(v).toBeCloseTo(first[i], 6));
      expect(Math.abs((m.getObjectByName('root') as THREE.Bone).position.z)).toBeLessThan(4);
    }
    disposeBossModel(m);
  });
  it('drives both front coat panels with their solved femur throughout standing walking', async () => {
    const m = await model(), p = new BossCombatPose(m);
    const rest = new Map<string, THREE.Quaternion>();
    for (const side of ['L', 'R']) for (const name of ['thigh', 'skirt_01front', 'skirt_02front'])
      rest.set(name + side, m.getObjectByName(name + side)!.getWorldQuaternion(new THREE.Quaternion()));
    const b = boss('walk');
    for (let i = 0; i <= 80; i++) {
      b.stride = i / 80 * BOSS_WALK_STRIDE; p.sample(b, 110);
      for (const side of ['L', 'R']) {
        const thigh = m.getObjectByName('thigh' + side)!;
        const delta = thigh.getWorldQuaternion(new THREE.Quaternion()).multiply(rest.get('thigh' + side)!.clone().invert());
        for (const segment of ['01', '02']) {
          const name = 'skirt_' + segment + 'front' + side;
          const expected = delta.clone().multiply(rest.get(name)!);
          const actual = m.getObjectByName(name)!.getWorldQuaternion(new THREE.Quaternion());
          expect(actual.angleTo(expected)).toBeLessThan(segment === '01' ? .002 : .05);
        }
      }
    }
    disposeBossModel(m);
  });
  it('keeps the deformed front coat ahead of both femurs across the standing stride', async () => {
    const m = await model(), p = new BossCombatPose(m), coat: THREE.SkinnedMesh[] = [];
    m.traverse(o => {
      if (!(o instanceof THREE.SkinnedMesh) || Array.isArray(o.material) || !/Coat \| (charcoal|inside)/.test(o.material.name)) return;
      o.material.side = THREE.DoubleSide; coat.push(o);
    });
    expect(coat).toHaveLength(2);
    const ray = new THREE.Raycaster(), forward = new THREE.Vector3(0, 0, 1), b = boss('walk');
    for (const phase of [0, .125, .25, .375, .5, .625, .75, .875]) {
      b.stride = phase * BOSS_WALK_STRIDE; p.sample(b, 110);
      for (const mesh of coat) mesh.computeBoundingSphere();
      for (const side of ['L', 'R']) for (const along of [.1, .5, .9]) {
        ray.set(point(m, 'thigh' + side).lerp(point(m, 'shin' + side), along), forward);
        const hits = ray.intersectObjects(coat, false);
        expect(hits.length).toBeGreaterThan(0);
        // More than the bone radius separates its centerline from the actual
        // CPU-skinned cloth surface, including the interpolated half-key poses.
        expect(hits[0].distance).toBeGreaterThan(.6);
      }
    }
    disposeBossModel(m);
  });
  it('keeps swipe and eating in the native crouch through windup, contact and recovery', async () => {
    const m = await model(), p = new BossCombatPose(m);
    const lower = ['root', 'pelvis', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR', 'skirt_01frontL', 'skirt_01frontR'];
    p.sample(boss('crouchWalk', true), 110);
    const low = lower.map(name => m.getObjectByName(name)!.matrixWorld.clone());
    for (const [action, duration] of [['swipe', BOSS_COMBAT_TIMING.swipe], ['grab', 3.8]] as const) {
      for (const age of [0, .32, .64, 1.1, 1.35, 2.25, duration - .1, duration]) {
        p.sample(boss(action, true), 110 + age); const expected = signature(m);
        // A stale or older false stance bit cannot select a standing variant.
        p.sample(boss(action, false), 110 + age);
        expect(signature(m)).toEqual(expected);
        lower.forEach((name, i) => m.getObjectByName(name)!.matrixWorld.elements.forEach((v, j) => expect(v).toBeCloseTo(low[i].elements[j], 5)));
      }
    }
    p.sample(boss('grab', true), 110.85);
    const reach = point(m, 'handR').distanceTo(point(m, 'jaw'));
    p.sample(boss('grab', true), 112.25);
    const bite = point(m, 'handR').distanceTo(point(m, 'jaw'));
    expect(bite).toBeLessThan(reach); expect(bite).toBeLessThan(2.4 * BOSS_GAMEPLAY_SCALE);
    disposeBossModel(m);
  });
  it('lengthens standing steps by 30% and plants the support foot at unchanged travel speed', async () => {
    const m = await model(), p = new BossCombatPose(m), b = boss('walk');
    expect(BOSS_WALK_STRIDE).toBeCloseTo(6 * BOSS_SCALE * 1.3, 8);
    const speed = 4.3, cycleSeconds = BOSS_WALK_STRIDE / speed;
    let anchor: THREE.Vector3 | null = null;
    for (const phase of [0, .1, .2, .3, .4, .5, .6]) {
      const elapsed = phase * cycleSeconds;
      b.stride = speed * elapsed; m.position.z = b.stride; p.sample(b, 110 + elapsed);
      const foot = point(m, 'footL');
      if (!anchor) anchor = foot;
      expect(foot.distanceTo(anchor)).toBeLessThan(.0001);
    }
    disposeBossModel(m);
  });
  it('runs the unchanged crouched swipe keys in half the time and matches the host contact', async () => {
    const m = await model(), p = new BossCombatPose(m);
    expect(BOSS_COMBAT_TIMING.swipe).toBe(1.2); expect(BOSS_COMBAT_TIMING.swipe).toBe(BOSS_TIMING.swipe);
    expect(BOSS_COMBAT_TIMING.swipeHit).toBe(.55); expect(BOSS_COMBAT_TIMING.swipeHit).toBe(BOSS_TIMING.swipeHit);
    const keys = (p as unknown as { clips: Map<string, { at: number }[]> }).clips.get('swipe')!;
    keys.forEach((key, i) => expect(key.at).toBeCloseTo([0, .32, .55, .68, 1.2][i], 8));
    p.sample(boss('crouchWalk', true), 110); const rest = point(m, 'handR');
    p.sample(boss('swipe', true), 110.55); expect(point(m, 'handR').distanceTo(rest)).toBeGreaterThan(4);
    p.sample(boss('swipe', true), 111.2); expect(point(m, 'handR').distanceTo(rest)).toBeLessThan(.0001);
    disposeBossModel(m);
  });
  it('leans the walking upper body forward while preserving upright planted feet', async () => {
    const m = await model(), p = new BossCombatPose(m);
    p.restoreRest(); const spine = m.getObjectByName('spine')!.getWorldQuaternion(new THREE.Quaternion());
    const feet = ['L', 'R'].map(side => m.getObjectByName('foot' + side)!.getWorldQuaternion(new THREE.Quaternion()));
    const b = boss('walk'); b.stride = 0; p.sample(b, 110);
    const delta = m.getObjectByName('spine')!.getWorldQuaternion(new THREE.Quaternion()).multiply(spine.invert());
    const direction = new THREE.Vector3(0, 1, 0).applyQuaternion(delta);
    expect(Math.atan2(direction.z, direction.y)).toBeCloseTo(THREE.MathUtils.degToRad(8), 5);
    ['L', 'R'].forEach((side, i) => expect(m.getObjectByName('foot' + side)!.getWorldQuaternion(new THREE.Quaternion()).angleTo(feet[i])).toBeLessThan(.0001));
    disposeBossModel(m);
  });
  it('fastens the upper drape to the hat while the lower edge follows the coat without jiggle', async () => {
    const m = await model(), upper = m.getObjectByName('rearflap_01')!, lower = m.getObjectByName('rearflap_02')!, chest = m.getObjectByName('chest')!;
    const rootPosition = upper.position.clone(), rootRotation = upper.quaternion.clone().normalize();
    const p = new BossCombatPose(m);
    const tip = () => chest.worldToLocal(lower.localToWorld(new THREE.Vector3(0, 2.24, 0)));
    p.sample(boss('idle'), 110); const anchor = tip();
    for (const action of ['walk', 'crouchWalk', 'swipe', 'grab', 'death'] as const) for (const phase of [0, .25, .5, .75]) {
      const b = boss(action, true); b.stride = phase * (action === 'walk' ? BOSS_WALK_STRIDE : CROUCH_WALK_DATA.stride * BOSS_SCALE);
      if (action === 'death') b.deathAt = 110;
      p.sample(b, 110 + phase * 8);
      expect(upper.position.distanceTo(rootPosition)).toBeLessThan(.00001);
      expect(upper.quaternion.clone().normalize().angleTo(rootRotation)).toBeLessThan(.00001);
      expect(tip().x).toBeCloseTo(anchor.x, 4); expect(tip().y).toBeCloseTo(anchor.y, 4);
      expect(tip().z).toBeLessThanOrEqual(anchor.z + .0001); expect(tip().z).toBeGreaterThanOrEqual(anchor.z - .4501);
      m.getObjectByName('head')!.rotateX(.5); m.updateWorldMatrix(true, true); p.stabilizeRearFlap();
      expect(upper.position.distanceTo(rootPosition)).toBeLessThan(.00001);
      expect(upper.quaternion.clone().normalize().angleTo(rootRotation)).toBeLessThan(.00001);
      expect(tip().x).toBeCloseTo(anchor.x, 4); expect(tip().y).toBeCloseTo(anchor.y, 4);
      expect(tip().z).toBeLessThanOrEqual(anchor.z + .0001); expect(tip().z).toBeGreaterThanOrEqual(anchor.z - .4501);
    }
    disposeBossModel(m);
  });
  it('keeps every upper rear-drape mesh vertex rigidly fastened to the moving hat', async () => {
    const m = await model(), head = m.getObjectByName('head')!, points: { mesh: THREE.SkinnedMesh; index: number; local: THREE.Vector3 }[] = [];
    m.traverse(o => {
      if (!(o instanceof THREE.SkinnedMesh)) return;
      const joints = o.geometry.getAttribute('skinIndex'), weights = o.geometry.getAttribute('skinWeight');
      for (let i = 0; i < joints.count; i++) {
        let attached = true, rear = 0;
        for (let j = 0; j < 4; j++) {
          const w = weights.getComponent(i, j), name = o.skeleton.bones[joints.getComponent(i, j)].name;
          if (name === 'rearflap_01') rear += w;
          if (w > .00001 && name !== 'head' && name !== 'rearflap_01') attached = false;
        }
        if (attached && rear > .00001) points.push({ mesh: o, index: i, local: head.worldToLocal(o.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(o.matrixWorld)) });
      }
    });
    expect(points.length).toBeGreaterThan(500);
    const pose = new BossCombatPose(m);
    for (const action of ['walk', 'crouchWalk', 'swipe', 'grab', 'death'] as const) for (const time of [.5, 2.25, 5.8]) for (const tilt of [.35, -1.3]) {
      const b = boss(action, true); b.stride = time; if (action === 'death') b.deathAt = 110;
      pose.sample(b, 110 + time); head.rotateX(tilt); m.updateMatrixWorld(true); pose.stabilizeRearFlap();
      let maximumDrift = 0;
      for (const point of points) maximumDrift = Math.max(maximumDrift, point.mesh.getVertexPosition(point.index, new THREE.Vector3()).applyMatrix4(point.mesh.matrixWorld)
        .distanceTo(head.localToWorld(point.local.clone())));
      expect(maximumDrift).toBeLessThan(.00002);
    }
    disposeBossModel(m);
  });
  it('rests with a slightly open mouth while retaining a much wider eating motion', async () => {
    const m = await model(), jaw = m.getObjectByName('jaw')!;
    const closed = jaw.quaternion.clone(), p = new BossCombatPose(m);
    p.sample(boss('idle'), 110); const resting = jaw.quaternion.clone();
    expect(resting.angleTo(closed)).toBeCloseTo(THREE.MathUtils.degToRad(5), 5);
    p.sample(boss('crouchWalk', true), 110);
    expect(jaw.quaternion.clone().normalize().angleTo(resting.clone().normalize())).toBeLessThan(.0001);
    p.sample(boss('grab', true), 112.25);
    expect(jaw.quaternion.angleTo(resting)).toBeGreaterThan(THREE.MathUtils.degToRad(20));
    disposeBossModel(m);
  });
  it('finishes stand/crouch transitions at the authoritative .65s boundary', async () => {
    const m = await model(), p = new BossCombatPose(m);
    p.restoreRest(); p.stabilizeRearFlap(); const rest = matrices(m);
    p.sample(boss('crouch'), 110.65); const low = matrices(m);
    p.sample(boss('crouchWalk'), 110); matrices(m).forEach((v, i) => expect(v).toBeCloseTo(low[i], 5));
    p.sample(boss('rise', true), 110.65);
    const standing = matrices(m);
    standing.forEach((v, i) => expect(v).toBeCloseTo(rest[i], 6));
    disposeBossModel(m);
  });
  it('keeps both feet planted while lowering into and rising out of attack crouch', async () => {
    const m = await model(), p = new BossCombatPose(m);
    p.restoreRest(); const standing = ['L', 'R'].map(side => point(m, 'foot' + side));
    p.sample(boss('crouchWalk', true), 110); const crouched = ['L', 'R'].map(side => point(m, 'foot' + side));
    for (let i = 0; i <= 40; i++) {
      const age = i / 40 * BOSS_COMBAT_TIMING.transition, u = i / 40, eased = u * u * (3 - 2 * u);
      p.sample(boss('crouch'), 110 + age);
      for (const [j, side] of ['L', 'R'].entries()) {
        const desired = standing[j].clone().lerp(crouched[j], eased);
        expect(point(m, 'foot' + side).distanceTo(desired)).toBeLessThan(.002);
      }
      const down = matrices(m);
      p.sample(boss('rise', true), 110 + BOSS_COMBAT_TIMING.transition - age);
      matrices(m).forEach((v, j) => expect(v).toBeCloseTo(down[j], 5));
    }
    disposeBossModel(m);
  });
  it('keeps planted transition poses local to the moving and turning boss', async () => {
    const m = await model(), p = new BossCombatPose(m);
    p.sample(boss('crouch'), 110.24); const before = matrices(m);
    m.position.set(12, 0, -7); m.rotation.y = 1.8;
    p.sample(boss('crouch'), 110.24);
    matrices(m).forEach((v, i) => expect(v).toBeCloseTo(before[i], 5));
    disposeBossModel(m);
  });
  it('plants the support foot through stomp and both knees during the crumple', async () => {
    const m = await model(), p = new BossCombatPose(m);
    for (const crouched of [false, true]) for (const t of [.68, 1]) {
      p.sample(boss('stomp', crouched), 110 + t);
      expect(point(m, 'footR').y).toBeCloseTo(1.17286 * BOSS_SCALE, 3);
    }
    const b = boss('death'); b.deathAt = 110;
    for (const t of [4, 5.8]) {
      p.sample(b, 110 + t);
      for (const side of ['L', 'R']) {
        expect(point(m, 'shin' + side).y).toBeCloseTo(.95 * BOSS_SCALE, 4);
        expect(point(m, 'foot' + side).y).toBeCloseTo(1.17286 * BOSS_SCALE, 4);
      }
    }
    expect(BOSS_COMBAT_TIMING.swipeHit).toBe(.55); expect(BOSS_COMBAT_TIMING.stompHit).toBe(1);
    expect(BOSS_COMBAT_TIMING.attach).toBe(1.35); expect(BOSS_COMBAT_TIMING.consume).toBe(2.8);
    disposeBossModel(m);
  });
  it('starts a crouched death from the crouched stance without a standing pop', async () => {
    const m = await model(), p = new BossCombatPose(m);
    p.sample(boss('crouchWalk', true), 110); const before = matrices(m);
    const b = boss('death', true); b.deathAt = 110; p.sample(b, 110);
    matrices(m).forEach((v, i) => expect(v).toBeCloseTo(before[i], 5));
    disposeBossModel(m);
  });
  it('follows authoritative position/facing, shows faction barrier, then disappears at12s leaving the crater', async () => {
    const b = boss();
    const nodes = [{ x: 14.36, z: -20, edges: [0, 3] }, { x: 14.36, z: 10, edges: [0, 1] },
      { x: 34.36, z: 10, edges: [1, 2] }, { x: 34.36, z: -20, edges: [2, 3] }];
    const lattice = { version: 0, nodes, edges: nodes.map((_, id) => ({ id, a: id, b: (id + 1) % 4 })) };
    const survey = { version: 0, edgeLey: new Int8Array([0, 0, 0, 0]) };
    const e = { root: new THREE.Group(), day: createDayState(), fireLight: new THREE.PointLight(), noise: new THREE.DataTexture(new Uint8Array([127,127,127,255]),1,1),
      ctx: { world: { lattice, survey, map: { effigy: { x: 0, z: 0 }, seed: 'combat-test' }, time: 112, boss: b, effigyRevealedAt: 100, factions: [{ color: 0x12bd45 }] },
        quality: 'low', session: { screen: 'playing' }, renderer: { getDrawingBufferSize: (v: THREE.Vector2) => v.set(1280,720) }, camera: new THREE.PerspectiveCamera(60) }, uniforms: { uFogColor: { value: new THREE.Color() } } } as unknown as EnvContext;
    const r = new BossReveal(e, model); await r.ready; expect(r.loadError).toBeNull(); r.update(102);
    const body = e.root.getObjectByName('boss-model-32m')!;
    expect(body.position.toArray()).toEqual([12,groundHeight(12,-7,MAP_HALF),-7]); expect(body.rotation.y).toBe(.7);
    // No collision-flash history is needed while the footprint is adjacent to this loop.
    expect(b.barrier).toBeNull(); r.update(102);
    const shield = e.root.getObjectByName('boss-faction-forcefield') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(shield.visible).toBe(true); expect(shield.material.uniforms.uColor.value.getHex()).toBe(0x12bd45);
    expect(shield.position.y).toBeCloseTo(groundHeight(shield.position.x + e.ctx.world.map.effigy.x, shield.position.z + e.ctx.world.map.effigy.z, MAP_HALF) + 7.5 * BOSS_GAMEPLAY_SCALE);
    const plane = shield.geometry as THREE.PlaneGeometry;
    expect(plane.parameters.width).toBe(10 * BOSS_GAMEPLAY_SCALE); expect(plane.parameters.height).toBe(20 * BOSS_GAMEPLAY_SCALE);
    expect(e.root.getObjectByName('boss-death-crater')!.scale.x).toBeCloseTo(.65 * BOSS_GAMEPLAY_SCALE);
    const fire = e.root.getObjectByName('boss-death-fire-head') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(fire.material.uniforms.uBossFxScale.value).toBe(BOSS_GAMEPLAY_SCALE);
    expect(shield.position.x).toBeCloseTo(14.36); expect(shield.position.z).toBeCloseTo(-7);
    b.action = 'death'; b.deathAt = 112; e.ctx.world.time = 123.99; r.update(113.99); expect(body.visible).toBe(true);
    e.ctx.world.time = 124; r.update(114); expect(body.visible).toBe(false);
    expect(e.root.getObjectByName('boss-death-crater')!.visible).toBe(true);
    expect(e.root.getObjectByName('boss-death-fire-head')!.visible).toBe(false);
    const before = JSON.stringify(b); r.update(114); expect(JSON.stringify(b)).toBe(before);
    r.dispose();
  });
});
