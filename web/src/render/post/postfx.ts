import { burnTime, dayClock } from "../../sim/matchSettings";
/**
 * Post-processing: an EffectComposer chain of
 *   RenderPass (scene into a multisampled linear HDR target)
 *   → BloomChain (UnrealBloomPass pyramid: Flags, ley lines, crystals, fire, festival lights)
 *   → grade pass (time-of-day grade, The Burn, drug effects, Command View parchment and ink,
 *     sun flare, damage, flash, vignette, dither) which also tone-maps (ACES at
 *     renderer.toneMappingExposure) and sRGB-encodes onto the canvas: the OutputPass work,
 *     folded in to save a full-screen HDR pass.
 * Reads ctx.daylight, ctx.shared.fx, ctx.shared.sunDisc, world.suddenDeath and world.time
 * (the Burn grade follows the effigy's fire, burn/burnTimeline.ts).
 * Owner: RenderWorld agent (post slice).
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { burnStartFor, fireIntensity } from '../env/burn/burnTimeline';
import type { RenderContext } from '../context';
import { BloomChain } from './bloom';
import { createGradeMaterial } from './grade';
import type { GradeUniforms } from './grade';

type Quality = RenderContext['quality'];

/** MSAA samples of the scene target. */
const SAMPLES: Record<Quality, number> = { low: 0, medium: 2, high: 4 };
/** Bloom pyramid input as a fraction of the drawing buffer (the pyramid halves it again). */
const BLOOM_SCALE: Record<Quality, number> = { low: 0.5, medium: 0.75, high: 1 };
const BLOOM_STRENGTH: Record<Quality, number> = { low: 0.45, medium: 0.65, high: 0.8 };
/**
 * Weights the tighter mips over the widest ones (0.5 weighs all five equally): festival
 * lights keep a soft halo without a veil of haze lifting the night's blacks.
 */
const BLOOM_RADIUS = 0.35;
/**
 * Bloom luminance threshold (linear scene units, before exposure) by day and by night. Only
 * the light above it blooms (bloom.ts), so the lower night threshold lets Flags, ley lines
 * and festival lights glow without lifting surfaces that are merely lit.
 */
const THRESHOLD_DAY = 1.4;
const THRESHOLD_NIGHT = 0.75;
/** Angular radius (rad) of the fully bright core of the sky's sun disc (sky.ts). */
const SUN_CORE_RADIUS = 0.02;
/** Rate (1/s) at which the Burn grade follows the fire. */
const BURN_FADE = 0.6;
/** Share of the Burn grade daylight takes back: by day the fire lights its surroundings, not the sky. */
const BURN_DAYLIGHT_FALLOFF = 0.75;
/**
 * Facet instability is a gameplay value; its shimmer and moire start just before the 0.35
 * Flag Psychosis threshold and are full by the 0.65 crystal discharges.
 */
const INSTABILITY_VISIBLE = 0.25;
const INSTABILITY_FULL = 0.7;

export class PostFx {
  private ctx: RenderContext;
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloom: BloomChain;
  private grade: ShaderPass;
  private uniforms: GradeUniforms;
  /** Eased 0..1 Burn grade. */
  private burn = 0;
  /** Match clock when The Burn began (Infinity before): the fire's own clock, as env keeps it. */
  private burnStartedAt = Infinity;
  private sunPoint = new THREE.Vector3();
  private viewDir = new THREE.Vector3();

  constructor(ctx: RenderContext) {
    this.ctx = ctx;
    const renderer = ctx.renderer;
    const size = renderer.getSize(new THREE.Vector2());
    const pixelRatio = renderer.getPixelRatio();
    const target = new THREE.WebGLRenderTarget(size.x * pixelRatio, size.y * pixelRatio, {
      type: THREE.HalfFloatType,
      samples: SAMPLES[ctx.quality],
    });
    target.texture.name = 'PostFx.scene';
    this.composer = new EffectComposer(renderer, target);

    this.renderPass = new RenderPass(ctx.scene, ctx.camera);
    this.bloom = new BloomChain(BLOOM_SCALE[ctx.quality], BLOOM_STRENGTH[ctx.quality], BLOOM_RADIUS, THRESHOLD_DAY);
    const { material, uniforms } = createGradeMaterial();
    this.uniforms = uniforms;
    uniforms.tBloom.value = this.bloom.texture;
    uniforms.tBloomLow.value = this.bloom.lowTexture;
    this.grade = new ShaderPass(material);
    // The grade draws straight to the canvas. With no pass swapping, the scene always lands in
    // the composer's read buffer and its write buffer is never bound (so never allocated).
    this.grade.needsSwap = false;

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.grade);
    this.setSize(size.x, size.y);
  }

  /** Canvas size in CSS pixels; the composer applies the renderer's pixel ratio. */
  setSize(w: number, h: number): void {
    this.composer.setPixelRatio(this.ctx.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    const scene = this.composer.readBuffer;
    this.uniforms.uTexel.value.set(1 / scene.width, 1 / scene.height);
    this.uniforms.uAspect.value = scene.width / scene.height;
  }

  render(dt: number): void {
    const { ctx, uniforms: u } = this;
    const smoothstep = THREE.MathUtils.smoothstep;
    const daylight = ctx.daylight;
    const night = 1 - smoothstep(daylight, 0.05, 0.55);
    this.bloom.threshold = THRESHOLD_NIGHT + (THRESHOLD_DAY - THRESHOLD_NIGHT) * daylight;

    // Golden warmth peaks from late afternoon through sunset and fades out over dusk.
    const warm = smoothstep(daylight, 0.05, 0.6) * (1 - 0.35 * smoothstep(daylight, 0.9, 1));
    // The Burn grade follows the fire: full while the effigy blazes, easing as it smoulders
    // (so the night can deepen) and giving way as daylight returns at Dawn.
    const world = ctx.world;
    if (world.suddenDeath && this.burnStartedAt === Infinity) this.burnStartedAt = world.options.mode === "tutorial" ? burnStartFor(world.time) : burnTime(world.options);
    const fire = world.suddenDeath
      ? fireIntensity(Math.max(0, world.time - this.burnStartedAt)) * (1 - BURN_DAYLIGHT_FALLOFF * daylight)
      : 0;
    this.burn += (fire - this.burn) * Math.min(1, dt * BURN_FADE);
    const flicker = 0.05 * Math.sin(ctx.time * 7.3) + 0.03 * Math.sin(ctx.time * 12.9 + 1.7);
    u.uGrade.value.set(warm, night, this.burn, flicker);

    const fx = ctx.shared.fx;
    if (fx) {
      u.uFxA.value.set(fx.dust, fx.acid, fx.saffron, fx.crash);
      const instability = smoothstep(fx.instability, INSTABILITY_VISIBLE, INSTABILITY_FULL);
      u.uFxB.value.set(fx.damage, fx.command, instability, fx.flash);
    } else {
      u.uFxA.value.set(0, 0, 0, 0);
      u.uFxB.value.set(0, 0, 0, 0);
    }
    u.uTime.value = ctx.time;
    u.uExposure.value = ctx.renderer.toneMappingExposure;
    this.aimSunFlare();
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
    this.renderPass.dispose();
    this.bloom.dispose();
    this.grade.dispose();
  }

  /** Projects the visible sun for the flare; a zero gate hides it (set, behind or off screen). */
  private aimSunFlare(): void {
    const sun = this.uniforms.uSun.value;
    sun.z = 0;
    const disc = this.ctx.shared.sunDisc;
    if (!disc || disc.y < -0.03) return;
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    if (cam.getWorldDirection(this.viewDir).dot(disc) < 0.2) return;
    const ndc = this.sunPoint.copy(cam.position).add(disc).project(cam);
    const x = ndc.x * 0.5 + 0.5;
    const y = ndc.y * 0.5 + 0.5;
    const smoothstep = THREE.MathUtils.smoothstep;
    const gate = smoothstep(Math.min(x, 1 - x, y, 1 - y), -0.02, 0.05) * smoothstep(disc.y, -0.03, 0.02);
    const radius = (0.5 * Math.tan(SUN_CORE_RADIUS)) / Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    sun.set(x, y, gate, radius);
  }
}
