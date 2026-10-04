import { burnTime, dayClock } from "../../sim/matchSettings";
/**
 * Environment: sky, sun/moon, day–night cycle, fog, ground (grass/dirt/roads/mud/pond),
 * map props (tents, domes, art, porta rows, trees, sound camps with lights, the Flag effigy
 * and its Burn), lumber piles, ambient particles. Sets ctx.sunDir / ctx.daylight.
 * Owner: RenderWorld agent.
 *
 * This module owns the frame's day state and the shared env uniforms; every layer lives in
 * its own EnvPart (see envTypes.ts) under one root group.
 */
import * as THREE from 'three';
import type { GameEvent } from '../../sim/events';
import type { RenderContext, RenderModule } from '../context';
import { burnStartFor } from './burn/burnTimeline';
import { Effigy } from './burn/effigy';
import { BURN_CHAR_SECONDS } from './envTypes';
import type { BurnState, EnvContext, EnvPart } from './envTypes';
import { GrassField } from './grass';
import { Ground } from './ground';
import { EnvLighting } from './lighting';
import { createNoiseTexture } from './noise';
import { AmbientParticles } from './particles';
import { LumberPiles } from './piles/lumberPiles';
import { PropField } from './props/propField';
import { SkyDome } from './sky';
import { terrainHeight } from './terrain';
import { ATTRACT_CLOCK, computeDayState, createDayState } from './timeOfDay';

/** Ambient warmth the fire adds to the hemisphere ground colour during The Burn. */
const FIRE_AMBIENT = new THREE.Color(0x5a2410);
/** Noise texture anisotropy per quality (the ground is seen at grazing angles). */
const NOISE_ANISOTROPY: Record<RenderContext['quality'], number> = { low: 1, medium: 2, high: 4 };

export class EnvRenderer implements RenderModule {
  private ctx: RenderContext;
  private env: EnvContext;
  private parts: EnvPart[];
  private fog: THREE.Fog;
  /** Published as ctx.shared.wind so Flags, banners and grass sway in one wind. */
  private wind = { x: 1, z: 0, strength: 0.6 };

  constructor(ctx: RenderContext) {
    this.ctx = ctx;
    const root = new THREE.Group();
    root.name = 'env';
    // The root stays at the origin; parts freeze their own static objects.
    root.matrixAutoUpdate = false;
    ctx.scene.add(root);

    const day = createDayState();
    const burn: BurnState = { active: false, startedAt: Infinity, elapsed: 0, progress: 0 };
    const lighting = new EnvLighting(ctx, root, day);
    this.env = {
      ctx,
      root,
      day,
      burn,
      uniforms: {
        uTime: { value: 0 },
        uNight: { value: 0 },
        uBeat: { value: 0 },
        uWind: { value: new THREE.Vector2(0.6, 0.35) },
        uBurn: { value: 0 },
        uSunDir: { value: day.lightDir },
        uSunColor: { value: new THREE.Color() },
        uFogColor: { value: day.fogColor },
      },
      noise: createNoiseTexture(ctx.renderer, NOISE_ANISOTROPY[ctx.quality]),
      fireLight: lighting.fireLight,
    };
    this.fog = new THREE.Fog(0xffffff, 100, 600);
    ctx.scene.fog = this.fog;
    const half = ctx.world.map.half;
    ctx.shared.groundOffset = (x, z) => terrainHeight(x, z, half);
    ctx.shared.wind = this.wind;
    ctx.shared.sunDisc = day.sunDir;
    this.syncDay();

    const env = this.env;
    const ground = new Ground(env);
    this.parts = [lighting, new SkyDome(env), ground];
    if (ctx.quality === 'high') this.parts.push(new GrassField(env, ground.typeTexture));
    this.parts.push(new PropField(env), new Effigy(env), new LumberPiles(env), new AmbientParticles(env, ground.typeTexture));
  }

  update(dt: number): void {
    this.syncDay();
    for (const p of this.parts) p.update(dt);
  }

  onEvent(e: GameEvent): void {
    for (const p of this.parts) p.onEvent?.(e);
  }

  dispose(): void {
    for (const p of this.parts) p.dispose();
    this.parts = [];
    this.ctx.scene.remove(this.env.root);
    this.env.noise.dispose();
    if (this.ctx.scene.fog === this.fog) this.ctx.scene.fog = null;
    delete this.ctx.shared.groundOffset;
    if (this.ctx.shared.wind === this.wind) delete this.ctx.shared.wind;
    if (this.ctx.shared.sunDisc === this.env.day.sunDir) delete this.ctx.shared.sunDisc;
  }

  /** Day palette, Burn clock, shared uniforms, fog, exposure and the ctx light hooks. */
  private syncDay(): void {
    const { ctx, env } = this;
    const world = ctx.world;
    const day = computeDayState(ctx.session.screen === 'title' ? ATTRACT_CLOCK : dayClock(world.options, world.time), env.day);

    const burn = env.burn;
    if (world.suddenDeath && !burn.active) {
      burn.active = true;
      burn.startedAt = world.options.mode === "tutorial" ? burnStartFor(world.time) : burnTime(world.options);
    }
    burn.elapsed = burn.active ? Math.max(0, world.time - burn.startedAt) : 0;
    burn.progress = Math.min(1, burn.elapsed / BURN_CHAR_SECONDS);
    if (burn.active) day.hemiGround.lerp(FIRE_AMBIENT, 0.35 * Math.min(1, burn.elapsed / 8));

    const u = env.uniforms;
    u.uTime.value = ctx.time;
    u.uNight.value = day.night;
    u.uBeat.value = ctx.beat;
    u.uBurn.value = burn.progress;
    u.uSunColor.value.copy(day.lightColor).multiplyScalar(day.lightIntensity);
    // Wind slowly veers and gusts (strength 0.3..0.95); one wind for every swaying thing.
    const veer = 0.55 + Math.sin(ctx.time * 0.031) * 0.35;
    const gust = 0.55 + 0.25 * Math.sin(ctx.time * 0.27) + 0.15 * Math.sin(ctx.time * 0.71 + 1.3);
    const wind = this.wind;
    wind.x = Math.cos(veer);
    wind.z = Math.sin(veer);
    wind.strength = gust;
    u.uWind.value.set(wind.x * gust, wind.z * gust);

    // Haze gives the meadow depth from eye level; the Command View camera hangs ~120 m up,
    // so the fog band moves out with height to keep the tactical map crisp.
    const lift = Math.max(0, ctx.camera.position.y - 8);
    this.fog.color.copy(day.fogColor);
    this.fog.near = day.fogNear + lift * 0.9;
    this.fog.far = day.fogFar + lift * 1.6;
    ctx.renderer.toneMappingExposure = day.exposure;
    ctx.sunDir.copy(day.lightDir);
    ctx.daylight = day.daylight;
  }
}
