/** Presentation only: the simulation owns the reveal timestamp and the cleared obstacle. */
import * as THREE from 'three';
import type { EnvContext } from '../../envTypes';
import { BOSS_HEIGHT, disposeBossModel, loadBossModel } from './bossModel';
import type { BossModelLoader } from './bossModel';
import { RevealFx } from './revealFx';
import { BossRevealPose } from './revealPose';
import { BossCombatPose, BOSS_COMBAT_TIMING } from './combatPose';
import { BossCombatFx, applyBossDeathMaterial } from './combatFx';
import { BossImpactFx } from './impactFx';
import { BossEyeBeamFx } from './eyeBeamFx';
import type { GameEvent } from '../../../../sim/events';
import { EFFIGY_BOSS_REVEAL_AT } from '../../../../sim/effigyBurn';
import { groundHeight, TERRAIN_GLSL } from '../../../../sim/terrain';
import { MAP_HALF } from '../../../../sim/constants';
import { BOSS_GAMEPLAY_SCALE } from '../../../../sim/bossDimensions';
import { applyBossChargeMaterial, bossCharge, bossEmergence, bossFlash, smooth } from './revealTimeline';
import { bossAwakeningLevel } from '../../../../sim/bossPresentation';
import { applyBossAwakeningMaterial } from './awakeningMaterial';

/** Above noon sunlight even at the far arena edge, with finite HDR values. */
export const BOSS_ERUPTION_LIGHT_INTENSITY = 1200;

function clipAtGround(material: THREE.Material, half: number): void {
  const before = material.onBeforeCompile;
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer);
    shader.uniforms.uBossTerrainHalf = { value: half };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vBossWorldPosition;')
      .replace('#include <skinning_vertex>', '#include <skinning_vertex>\nvBossWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vBossWorldPosition; uniform float uBossTerrainHalf;\n${TERRAIN_GLSL}`)
      .replace('void main() {', 'void main() {\nif (vBossWorldPosition.y < groundHeight(vBossWorldPosition.xz, uBossTerrainHalf) + 0.028) discard;');
  };
  material.customProgramCacheKey = () => key + '-boss-ground-clip-v2';
}

export class BossReveal {
  readonly ready: Promise<void>;
  readonly root = new THREE.Group();
  private model: THREE.Group | null = null;
  private gesture: BossRevealPose | null = null;
  private combat: BossCombatPose | null = null;
  private combatFx: BossCombatFx | null = null;
  private eyeFx: BossEyeBeamFx | null = null;
  private fx: RevealFx;
  private impacts: BossImpactFx;
  private depth = new THREE.MeshDepthMaterial();
  private disposed = false;
  private age = -1;
  private burnElapsed = 0;
  private uWhite = { value: 0 };
  private uAwakening = { value: 0 };
  private readonly fireDistance: number;
  private readonly fireDecay: number;
  /** Available for diagnostics; an unavailable asset never substitutes a fake boss. */
  loadError: unknown = null;

  constructor(private env: EnvContext, loader: BossModelLoader = loadBossModel) {
    this.fireDistance = env.fireLight.distance;
    this.fireDecay = env.fireLight.decay;
    const at = env.ctx.world.map.effigy;
    this.root.name = 'boss-reveal';
    this.root.position.set(at.x, 0, at.z);
    env.root.add(this.root);
    this.fx = new RevealFx(env);
    this.root.add(this.fx.group);
    this.impacts = new BossImpactFx(env); this.root.add(this.impacts.group);
    clipAtGround(this.depth, env.ctx.world.map.half ?? MAP_HALF);
    this.ready = loader().then(async (model) => {
      if (this.disposed) { disposeBossModel(model); return; }
      this.model = model;
      // Capture the real bind/rest pose before the reveal constructor changes the arms.
      this.combat = new BossCombatPose(model);
      this.eyeFx = new BossEyeBeamFx(model, () => this.combat?.stabilizeRearFlap());
      const combatFx = this.combatFx = new BossCombatFx(env, model);
      const materials = new Set<THREE.Material>();
      model.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
        o.customDepthMaterial = this.depth;
      });
      for (const material of materials) {
        clipAtGround(material, env.ctx.world.map.half ?? MAP_HALF);
        applyBossDeathMaterial(material, combatFx.deathAge);
        // Shader override only: the original material parameters are never mutated.
        if (material instanceof THREE.MeshStandardMaterial) {
          applyBossChargeMaterial(material, this.uWhite);
          applyBossAwakeningMaterial(material, this.uAwakening);
        }
      }
      applyBossDeathMaterial(this.depth, combatFx.deathAge);
      this.root.add(model);
      this.root.add(combatFx.group);
      this.root.add(this.eyeFx.group);
      this.gesture = new BossRevealPose(model);
      this.pose();
      // The model is loaded at match start, long before ignition. Warm its real skinning shaders.
      if (typeof env.ctx.renderer.compileAsync === 'function' && env.ctx.scene) {
        const visible = model.visible;
        model.visible = true;
        await env.ctx.renderer.compileAsync(model, env.ctx.camera, env.ctx.scene);
        model.visible = visible;
      }
    }).catch((error: unknown) => {
      this.loadError = error;
      console.error('The skeletal boss model could not be loaded', error);
    });
  }

  private pose(): void {
    const emerged = this.age >= 0 ? 1 : bossEmergence(this.burnElapsed);
    // While waiting for authoritative state, remain white even if a client clock runs ahead.
    // The first authoritative reveal frame restores the source materials with no fade.
    this.uWhite.value = this.age < 0 && emerged > 0 ? 1 : 0;
    if (!this.model) return;
    const world = this.env.ctx.world, boss = world.boss;
    if (boss && this.age >= 0 && this.age >= BOSS_COMBAT_TIMING.emerge && boss.action !== 'emerge') {
      // The host bakes a zero-phase idle pivot while the eye attack holds still.
      this.combat?.sample(boss, boss.eye?.chargeAt != null ? boss.spawnedAt : world.time);
    } else {
      this.combat?.restoreRest();
      this.gesture?.sample(this.age >= 0 ? EFFIGY_BOSS_REVEAL_AT + this.age : this.burnElapsed);
      if (boss && this.age >= 0) this.combat?.settleReveal(smooth(.35, BOSS_COMBAT_TIMING.emerge, this.age));
    }
    this.model.visible = emerged > 0 || this.age >= 0;
    if (boss?.deathAt !== null && boss?.deathAt !== undefined && world.time - boss.deathAt >= BOSS_COMBAT_TIMING.death) this.model.visible = false;
    this.model.position.x = boss && this.age >= 0 ? boss.pos.x - world.map.effigy.x : 0;
    this.model.position.z = boss && this.age >= 0 ? boss.pos.z - world.map.effigy.z : 0;
    this.model.rotation.y = boss && this.age >= 0 ? boss.yaw : 0;
    const at = boss && this.age >= 0 ? boss.pos : world.map.effigy;
    this.model.position.y = groundHeight(at.x, at.z, world.map.half ?? MAP_HALF) + BOSS_HEIGHT * (emerged - 1);
    this.model.updateMatrixWorld(true);
    // End screens freeze match time. Never leave a final killing beam stuck on screen.
    const eyeBoss = this.age >= 0 && world.phase !== 'ended' ? boss : null;
    this.eyeFx?.aim(eyeBoss, world.time);
    this.eyeFx?.update(eyeBoss, world.time);
    this.combatFx?.update(this.age >= 0 ? boss : null, world.time);
    if (boss && this.model.visible) {
      const sprite = this.env.ctx.shared?.mobileSprites?.cast(5, {id: boss.id, x: at.x,
        y: groundHeight(at.x, at.z, world.map.half ?? MAP_HALF), z: at.z, yaw: boss.yaw,
        height: BOSS_HEIGHT, moving: boss.action === 'walk'},
        this.age >= BOSS_COMBAT_TIMING.emerge && (boss.action === 'idle' || boss.action === 'walk')
        && !boss.crouched && boss.hp > 0 && boss.deathAt === null && boss.eye?.chargeAt == null
        && boss.eye?.firedAt == null && !boss.held && !boss.barrier && boss.lightning.length === 0);
      if (sprite) this.model.visible = false;
    }
  }

  update(burnElapsed: number): void {
    this.burnElapsed = burnElapsed;
    const world = this.env.ctx.world;
    const revealed = world.effigyRevealedAt;
    const screen = this.env.ctx.session.screen;
    const present = screen === 'playing' || screen === 'paused';
    this.uAwakening.value = present ? bossAwakeningLevel(world) : 0;
    this.age = revealed === null || revealed === undefined ? -1 : Math.max(0, world.time - revealed);
    this.pose();
    this.fx.update(this.age);
    this.impacts.update(world.time);
    const light = this.env.fireLight;
    light.distance = this.fireDistance;
    light.decay = this.fireDecay;
    if (this.age < 0) {
      const charge = bossCharge(burnElapsed);
      if (charge > 0) {
        light.color.lerp(new THREE.Color(1, 1, 1), charge);
        light.intensity += 180 * charge * charge;
        light.position.y = groundHeight(world.map.effigy.x, world.map.effigy.z, world.map.half ?? MAP_HALF) + 12 * BOSS_GAMEPLAY_SCALE;
      }
      return;
    }
    const flash = bossFlash(this.age);
    light.position.set(world.map.effigy.x, groundHeight(world.map.effigy.x, world.map.effigy.z, world.map.half ?? MAP_HALF) + 9 * BOSS_GAMEPLAY_SCALE, world.map.effigy.z);
    // The burst surrounds the boss, rather than re-whitening its just-restored materials.
    light.color.setRGB(1, 0.34, 0.08);
    light.intensity = flash * 45 + 24 * Math.exp(-this.age * 0.9);
    if (this.uAwakening.value > 0) {
      light.color.setRGB(1, 1, 1);
      light.distance = (world.map.half ?? MAP_HALF) * 6;
      // Cinematic map-wide radiance avoids an inverse-square singularity in the
      // half-float HDR buffer when flying debris passes through the source.
      light.decay = 0;
      light.intensity += BOSS_ERUPTION_LIGHT_INTENSITY * this.uAwakening.value;
    }
    const death = this.combatFx?.deathAge.value ?? -1;
    if (death >= 0 && death < 12 && world.boss) {
      light.position.set(world.boss.pos.x, groundHeight(world.boss.pos.x, world.boss.pos.z, world.map.half ?? MAP_HALF) + 5 * BOSS_GAMEPLAY_SCALE, world.boss.pos.z);
      light.intensity = 65 * smooth(0, 1.5, death) * (1 - smooth(8, 12, death));
    }
  }

  onEvent(event: GameEvent): void { this.impacts.onEvent(event); }

  dispose(): void {
    this.disposed = true;
    this.uAwakening.value = 0;
    this.env.fireLight.distance = this.fireDistance;
    this.env.fireLight.decay = this.fireDecay;
    this.env.fireLight.intensity = 0;
    this.combatFx?.dispose();
    this.eyeFx?.dispose();
    if (this.model) disposeBossModel(this.model);
    this.depth.dispose();
    this.fx.dispose();
    this.impacts.dispose();
    this.root.removeFromParent();
  }
}
