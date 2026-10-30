import * as fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { BOSS_EYE_TIMING, BOSS_EYE_BLAST_RADIUS, BOSS_EYE_MAX_RANGE, createBossEyeState, type BossState } from '../../../../sim/boss';
import { BOSS_HEIGHT, BOSS_MODEL_SCALE, BOSS_GAMEPLAY_SCALE } from '../../../../sim/bossDimensions';
import { bossEyeRay } from '../../../../sim/systems/boss/eye';
import { prepareBossModel, disposeBossModel } from './bossModel';
import { BossCombatPose } from './combatPose';
import { BossEyeBeamFx, readBossEyeGaze } from './eyeBeamFx';
import { BossReveal } from './bossReveal';
import { createDayState } from '../../timeOfDay';
import type { EnvContext } from '../../envTypes';

async function model() {
  const b = fs.readFileSync(new URL('../../../../../public/models/boss/skeletal-boss.glb', import.meta.url));
  return prepareBossModel((await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '')).scene);
}
function boss(): BossState {
  return { lightning: [], id: 88, pos: { x: 12, z: -7 }, yaw: .7, hp: 5000, maxHp: 5000, spawnedAt: 100, action: 'idle', actionAt: 110,
    actionSeq: 3, hitSeq: -1, target: null, focusFaction: null,
    objectiveAltarId: null, routeStartStride: 0, nextSceneryStompStride: 0, opportunisticAfter: 0, retaliateId: null, retaliateUntil: 0,
    nextAttackAt: 0, interruptImmuneUntil: 0, deathAt: null, barrier: null, stride: 0, held: null, crouched: false, eye: createBossEyeState(100) };
}
function parent(m: THREE.Group, fx: BossEyeBeamFx) { const p = new THREE.Group(); p.position.set(-9, 0, 13); p.add(m, fx.group); p.updateMatrixWorld(true); return p; }
function materialValues(m: THREE.Group) {
  const values: unknown[] = [];
  m.traverse(o => { if (o instanceof THREE.SkinnedMesh && o.material instanceof THREE.MeshStandardMaterial)
    values.push([o.material.name, ...o.material.color.toArray(), ...o.material.emissive.toArray(), o.material.emissiveIntensity, o.material.roughness, o.material.metalness]); });
  return values;
}

describe('original hat eye and five-second sweeping beam presentation', () => {
  it('scales the eye halo and beam width with the 32 m rig while keeping the blast and attack clock fixed', async () => {
    const m = await model(), fx = new BossEyeBeamFx(m);
    expect(BOSS_HEIGHT).toBe(32); expect(m.userData.height).toBe(32);
    expect(m.scale.toArray()).toEqual([BOSS_MODEL_SCALE, BOSS_MODEL_SCALE, BOSS_MODEL_SCALE]);
    expect(BOSS_MODEL_SCALE).toBe(1); expect(BOSS_GAMEPLAY_SCALE).toBe(1.6);
    const core = fx.group.getObjectByName('boss-eye-white-core')!, beamHalo = fx.group.getObjectByName('boss-eye-white-halo')!;
    expect(core.scale.x).toBeCloseTo(.12, 10); expect(core.scale.y).toBeCloseTo(.12, 10);
    expect(beamHalo.scale.x).toBeCloseTo(.384, 10);
    const halo = fx.group.getObjectByName('boss-eye-charge-halo') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(halo.material.uniforms.uBossScale.value).toBe(1.6);
    expect(halo.material.fragmentShader).toContain('(0.045+uPower*.65)');
    expect((beamHalo as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>).material.uniforms.uAlpha.value).toBe(.18);
    expect(BOSS_EYE_TIMING).toEqual({ period: 30, charge: 3, beam: 5 });
    expect(BOSS_EYE_BLAST_RADIUS).toBe(5); expect(BOSS_EYE_MAX_RANGE).toBe(240);
    for (const name of ['boss-eye-impact-explosion', 'boss-eye-impact-rays'])
      expect(fx.group.getObjectByName(name)!.scale.toArray()).toEqual([5, 5, 5]);
    fx.dispose(); disposeBossModel(m);
  });
  it('uses the actual fully head-weighted front pupil vertex in every pose and yaw', async () => {
    const m = await model(), combat = new BossCombatPose(m), head = m.getObjectByName('head') as THREE.Bone;
    let pupil!: THREE.SkinnedMesh;
    m.traverse(o => { if (o instanceof THREE.SkinnedMesh && !Array.isArray(o.material) && o.material.name === 'HAT | Obsidian pupil') pupil = o; });
    expect(pupil).toBeDefined();
    const points = pupil.geometry.getAttribute('position'), weights = pupil.geometry.getAttribute('skinWeight'), joints = pupil.geometry.getAttribute('skinIndex');
    let front = 0;
    for (let i = 0; i < points.count; i++) {
      if (points.getZ(i) > points.getZ(front)) front = i;
      expect(weights.getX(i)).toBe(1); expect(pupil.skeleton.bones[joints.getX(i)].name).toBe('head');
    }
    m.position.set(12, 0, -7); m.rotation.y = .73;
    for (const action of ['idle', 'walk', 'crouchWalk', 'swipe', 'grab'] as const) {
      const b = boss(); b.action = action; b.stride = 1.2; combat.sample(b, 111.1); m.updateMatrixWorld(true);
      const gaze = readBossEyeGaze(head);
      const actual = pupil.getVertexPosition(front, new THREE.Vector3()).applyMatrix4(pupil.matrixWorld);
      expect(gaze.origin.distanceTo(actual)).toBeLessThan(.00001);
      expect(gaze.direction.length()).toBeCloseTo(1, 10);
    }
    disposeBossModel(m);
  });

  it('adds dim emission only to seven original eye materials without recoloring or changing mesh data', async () => {
    const m = await model(), before = materialValues(m), fx = new BossEyeBeamFx(m);
    expect(materialValues(m)).toEqual(before);
    let eyes = 0, other = 0;
    m.traverse(o => {
      if (!(o instanceof THREE.SkinnedMesh) || !(o.material instanceof THREE.MeshStandardMaterial)) return;
      const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader,
        uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.standard.uniforms) } as Parameters<THREE.Material['onBeforeCompile']>[0];
      o.material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      if (shader.uniforms.uBossEyePower) { eyes++; expect(shader.uniforms.uBossEyePower.value).toBe(0); expect(shader.fragmentShader).toContain('(0.28 + uBossEyePower * 2.5)'); }
      else other++;
    });
    expect(eyes).toBe(7); expect(other).toBe(24); expect(m.userData.consolidatedDraws).toBe(31);
    fx.dispose(); disposeBossModel(m);
  });

  it('brightens across three seconds, tilts the real head into the target and reapplies the upper-back drape constraint', async () => {
    const m = await model(), combat = new BossCombatPose(m), fx = new BossEyeBeamFx(m, () => combat.stabilizeRearFlap()), p = parent(m, fx);
    const b = boss(); b.eye.chargeAt = 127; b.eye.target = { x: 4, y: 0, z: 39 };
    m.position.set(12, 0, -7); m.rotation.y = .7;
    const powers: number[] = [];
    for (const time of [127, 128, 129, 130]) {
      combat.sample(b, b.spawnedAt); p.updateMatrixWorld(true);
      fx.aim(b, time); fx.update(b, time); powers.push(fx.power.value);
      const flap = m.getObjectByName('rearflap_01')!, before = flap.getWorldPosition(new THREE.Vector3()), rotation = flap.getWorldQuaternion(new THREE.Quaternion()).normalize();
      combat.stabilizeRearFlap();
      expect(flap.getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeLessThan(1e-6);
      // Final cloth scaling can add tiny decomposition length error; compare unit rotations.
      expect(flap.getWorldQuaternion(new THREE.Quaternion()).normalize().angleTo(rotation)).toBeLessThan(1e-6);
    }
    expect(powers[0]).toBe(0); expect(powers[3]).toBe(1); expect(powers[1]).toBeLessThan(powers[2]);
    const gaze = readBossEyeGaze(m.getObjectByName('head') as THREE.Bone), target = new THREE.Vector3(4, 0, 39);
    expect(new THREE.Ray(gaze.origin, gaze.direction).distanceToPoint(target)).toBeLessThan(.00001);
    fx.dispose(); disposeBossModel(m);
  });

  it('sweeps a full white beam from the actual pupil to each live first impact for exactly five seconds', async () => {
    const m = await model(), combat = new BossCombatPose(m), fx = new BossEyeBeamFx(m, () => combat.stabilizeRearFlap()), p = parent(m, fx), b = boss();
    b.eye.chargeAt = 127; b.eye.firedAt = 130; b.eye.origin = { x: 12, y: 16, z: -7 };
    b.eye.impact = { x: 12, y: 0, z: 23 }; b.eye.direction = { x: 0, y: -16 / 34, z: 30 / 34 };
    const beam = fx.group.getObjectByName('boss-eye-beam')!, impact = fx.group.getObjectByName('boss-eye-impact-explosion') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    const rays = fx.group.getObjectByName('boss-eye-impact-rays')!;
    const identities = fx.group.children.map(o => o.id);
    fx.update(b, 129.999); expect(beam.visible).toBe(false);
    let previous: THREE.Vector3 | null = null;
    for (const [i, now] of [130, 130.00001, 132.2, 134.999999].entries()) {
      m.position.set(b.pos.x - p.position.x, 0, b.pos.z - p.position.z); m.rotation.y = b.yaw + i * .08;
      b.eye.target = { x: -12 + i * 12, y: 0, z: 28 + i * 2 };
      b.eye.impact = { ...b.eye.target };
      const before = JSON.stringify(b);
      combat.sample(b, b.spawnedAt); p.updateMatrixWorld(true); fx.aim(b, now); fx.update(b, now); p.updateMatrixWorld(true);
      const gaze = readBossEyeGaze(m.getObjectByName('head') as THREE.Bone);
      const start = beam.localToWorld(new THREE.Vector3()), end = beam.localToWorld(new THREE.Vector3(0, 0, 1));
      expect(beam.visible).toBe(true); expect(impact.visible).toBe(true); expect(rays.visible).toBe(true);
      expect(start.distanceTo(gaze.origin)).toBeLessThan(1e-8);
      expect(new THREE.Ray(gaze.origin, gaze.direction).distanceToPoint(end)).toBeLessThan(.00001);
      expect(end.distanceTo(new THREE.Vector3(b.eye.impact.x, b.eye.impact.y, b.eye.impact.z))).toBeLessThan(1e-8);
      expect(beam.scale.z).toBeCloseTo(start.distanceTo(end), 10);
      expect(impact.getWorldPosition(new THREE.Vector3()).distanceTo(end)).toBeLessThan(1e-8);
      expect(impact.getWorldScale(new THREE.Vector3()).toArray()).toEqual([5, 5, 5]);
      expect(impact.material.uniforms.uShotAge.value).toBeCloseTo(now - 130, 8);
      expect(impact.material.fragmentShader).toContain('float pulse=');
      expect(impact.material.fragmentShader).not.toContain('float fade=');
      expect(fx.power.value).toBe(1); expect(JSON.stringify(b)).toBe(before);
      expect(fx.group.children.map(o => o.id)).toEqual(identities);
      if (previous) expect(previous.distanceTo(end)).toBeGreaterThan(10);
      previous = end;
      const flap = m.getObjectByName('rearflap_01')!, position = flap.getWorldPosition(new THREE.Vector3());
      combat.stabilizeRearFlap(); expect(flap.getWorldPosition(new THREE.Vector3()).distanceTo(position)).toBeLessThan(1e-6);
    }
    fx.update(b, 135); expect(beam.visible).toBe(false); expect(impact.visible).toBe(false); expect(fx.power.value).toBe(0);
    // The first hit vanishes immediately when the host ray misses; no old blast is retained.
    b.eye.impact = null; combat.sample(b, b.spawnedAt); p.updateMatrixWorld(true); fx.aim(b, 133); fx.update(b, 133); p.updateMatrixWorld(true);
    expect(beam.visible).toBe(true); expect(beam.scale.z).toBeCloseTo(240, 8); expect(impact.visible).toBe(false); expect(rays.visible).toBe(false);
    const gaze = readBossEyeGaze(m.getObjectByName('head') as THREE.Bone), end = beam.localToWorld(new THREE.Vector3(0, 0, 1));
    expect(end.distanceTo(gaze.origin.clone().addScaledVector(gaze.direction, 240))).toBeLessThan(.00001);
    b.hp = 0; b.deathAt = 133; fx.update(b, 133);
    expect(fx.group.visible).toBe(false); expect(beam.visible).toBe(false); expect(fx.power.value).toBe(0);
    fx.dispose(); expect(fx.group.parent).toBeNull(); disposeBossModel(m);
  });

  it('cleans up old beam and impact meshes on reset and reuses the same objects on a new sequence', async () => {
    const m = await model(), combat = new BossCombatPose(m), fx = new BossEyeBeamFx(m), p = parent(m, fx), b = boss();
    b.eye.chargeAt = 127; b.eye.firedAt = 130; b.eye.target = { x: 0, y: 0, z: 30 };
    b.eye.origin = { x: 0, y: 27, z: 0 }; b.eye.direction = { x: 0, y: -1, z: 1 }; b.eye.impact = { ...b.eye.target };
    const objects = fx.group.children.slice();
    combat.sample(b, b.spawnedAt); p.updateMatrixWorld(true); fx.aim(b, 132.6); fx.update(b, 132.6);
    expect(fx.group.getObjectByName('boss-eye-beam')!.visible).toBe(true);
    fx.update(null, 132.6);
    for (const name of ['boss-eye-beam', 'boss-eye-impact-explosion', 'boss-eye-impact-rays']) expect(fx.group.getObjectByName(name)!.visible).toBe(false);
    expect(fx.power.value).toBe(0);
    b.eye = createBossEyeState(140); fx.update(b, 141);
    expect(fx.group.getObjectByName('boss-eye-beam')!.visible).toBe(false); expect(fx.power.value).toBe(0);
    b.eye.chargeAt = 157; b.eye.firedAt = 160; b.eye.target = { x: 30, y: 0, z: 18 };
    b.eye.origin = { x: 0, y: 27, z: 0 }; b.eye.direction = { x: 1, y: -1, z: 1 }; b.eye.impact = { ...b.eye.target };
    combat.sample(b, b.spawnedAt); p.updateMatrixWorld(true); fx.aim(b, 163); fx.update(b, 163); p.updateMatrixWorld(true);
    expect(fx.group.getObjectByName('boss-eye-beam')!.visible).toBe(true);
    expect(fx.group.getObjectByName('boss-eye-impact-explosion')!.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([30, 0, 18]);
    expect(fx.group.children).toEqual(objects);
    fx.dispose(); disposeBossModel(m);
  });

  it('clears a final beam when the ended match clock freezes inside its five-second window', async () => {
    const b = boss(); b.eye.chargeAt = 127; b.eye.firedAt = 130; b.eye.target = { x: 28, y: 0, z: 40 };
    b.eye.origin = { x: 12, y: 17, z: -7 }; b.eye.direction = { x: 0, y: -1, z: 0 }; b.eye.impact = { x: 12, y: 0, z: -7 };
    const e = { root: new THREE.Group(), day: createDayState(), fireLight: new THREE.PointLight(), noise: new THREE.DataTexture(new Uint8Array([127,127,127,255]),1,1),
      ctx: { world: { lattice: { version: 0, nodes: [], edges: [] }, survey: { version: 0, edgeLey: new Int8Array() }, map: { half: 150, effigy: { x: 0, z: 0 }, seed: 'eye-end-test' }, time: 130.2, phase: 'playing', boss: b, effigyRevealedAt: 100, factions: [{ color: 0x12bd45 }] },
        quality: 'low', session: { screen: 'playing' }, renderer: { getDrawingBufferSize: (v: THREE.Vector2) => v.set(1280,720) }, camera: new THREE.PerspectiveCamera(60) }, uniforms: { uFogColor: { value: new THREE.Color() } } } as unknown as EnvContext;
    const r = new BossReveal(e, model); await r.ready; expect(r.loadError).toBeNull(); r.update(120.2);
    expect(e.root.getObjectByName('boss-eye-beam')!.visible).toBe(true);
    const state = JSON.stringify(b); e.ctx.world.phase = 'ended'; r.update(120.2);
    expect(e.root.getObjectByName('boss-eye-fx')!.visible).toBe(false);
    expect(e.root.getObjectByName('boss-eye-beam')!.visible).toBe(false);
    expect(e.root.getObjectByName('boss-eye-impact-explosion')!.visible).toBe(false);
    expect(JSON.stringify(b)).toBe(state);
    r.dispose();
  });

  it('reconstructs late-joined charge/fire through BossReveal without accumulating head rotations', async () => {
    const b = boss(); b.eye.chargeAt = 127; b.eye.target = { x: 28, y: 0, z: 40 };
    const e = { root: new THREE.Group(), day: createDayState(), fireLight: new THREE.PointLight(), noise: new THREE.DataTexture(new Uint8Array([127,127,127,255]),1,1),
      ctx: { world: { lattice: { version: 0, nodes: [], edges: [] }, survey: { version: 0, edgeLey: new Int8Array() }, map: { half: 150, effigy: { x: 0, z: 0 }, seed: 'eye-test' }, time: 129, boss: b, effigyRevealedAt: 100, factions: [{ color: 0x12bd45 }] },
        quality: 'low', session: { screen: 'playing' }, renderer: { getDrawingBufferSize: (v: THREE.Vector2) => v.set(1280,720) }, camera: new THREE.PerspectiveCamera(60) }, uniforms: { uFogColor: { value: new THREE.Color() } } } as unknown as EnvContext;
    const r = new BossReveal(e, model); await r.ready; expect(r.loadError).toBeNull(); r.update(119);
    const head = e.root.getObjectByName('head') as THREE.Bone, initial = head.quaternion.toArray();
    for (let i = 0; i < 5; i++) r.update(119);
    expect(head.quaternion.toArray()).toEqual(initial);
    e.ctx.world.time = 130; r.update(120);
    const gaze = readBossEyeGaze(head), authoritative = bossEyeRay(e.ctx.world, b);
    expect(gaze.origin.distanceTo(new THREE.Vector3(authoritative.origin.x, authoritative.origin.y, authoritative.origin.z))).toBeLessThan(.00001);
    expect(gaze.direction.distanceTo(new THREE.Vector3(authoritative.direction.x, authoritative.direction.y, authoritative.direction.z))).toBeLessThan(.000001);
    b.eye.origin = authoritative.origin; b.eye.direction = authoritative.direction; b.eye.impact = b.eye.target; b.eye.firedAt = 130;
    const first = head.quaternion.toArray(); e.ctx.world.time = 133.4; r.update(123.4);
    expect(head.quaternion.toArray()).toEqual(first);
    expect(e.root.getObjectByName('boss-eye-beam')!.visible).toBe(true);
    for (const crouched of [false, true]) for (const yaw of [-1.4, 0, .7, 2.4]) {
      b.crouched = crouched; b.yaw = yaw; r.update(123.4);
      const actual = readBossEyeGaze(head), ray = bossEyeRay(e.ctx.world, b);
      expect(actual.origin.distanceTo(new THREE.Vector3(ray.origin.x, ray.origin.y, ray.origin.z))).toBeLessThan(.00001);
      expect(actual.direction.distanceTo(new THREE.Vector3(ray.direction.x, ray.direction.y, ray.direction.z))).toBeLessThan(.000001);
    }
    e.ctx.world.phase = 'ended'; r.update(123.4);
    expect(e.root.getObjectByName('boss-eye-fx')!.visible).toBe(false);
    expect(e.root.getObjectByName('boss-eye-beam')!.visible).toBe(false);
    expect(e.root.getObjectByName('boss-eye-impact-explosion')!.visible).toBe(false);
    r.dispose();
  });
});
