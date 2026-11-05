/** Flat effigy art with the authoritative Burn curves and the original live fire/reveal FX. */
import * as THREE from 'three';
import type { GameEvent } from '../../../sim/events';
import { bossRevealEnabled } from '../../../sim/effigyBurn';
import type { EnvContext, EnvPart } from '../envTypes';
import type { SpritePose } from '../../actors/mobileSprites';
import { terrainHeight } from '../terrain';
import { BossReveal } from './boss/bossReveal';
import type { BossModelLoader } from './boss/bossModel';
import { bossCharge } from './boss/revealTimeline';
import { BurnFx } from './burnFx';
import type { BurnFxDrive } from './burnFx';
import type { BurnUniforms } from './charMaterial';
import { PLINTH_HEIGHT, LATTICE_TOP, MAST_TOP, burningScaffoldEnvelope, emberBed, emberRate,
  fireCeiling, fireFront, fireIntensity, flagBurnScale, ignitionFlare, sampleFlagHeat, smokeAmount } from './burnTimeline';

export class MobileEffigy implements EnvPart {
  readonly ready: Promise<void>;
  private readonly root = new THREE.Group();
  private readonly fx: BurnFx;
  private readonly boss: BossReveal | null;
  private readonly burnU: BurnUniforms;
  private readonly drive: BurnFxDrive = { flare: 0, smoke: 0, emberRate: 0, emberBed: 0 };
  private readonly pose: SpritePose = { id: -5000000, x: 0, y: 0, z: 0, yaw: 0, height: 1, moving: false };
  private readonly color = new THREE.Color();
  private flagYaw: number | null = null;
  constructor(private readonly env: EnvContext, loader?: BossModelLoader) {
    const at = env.ctx.world.map.effigy, y = terrainHeight(at.x, at.z, env.ctx.world.map.half);
    this.root.name = 'mobile-effigy-effects'; this.root.position.set(at.x, y, at.z); env.root.add(this.root);
    this.pose.x = at.x; this.pose.z = at.z;
    this.burnU = { uBurnTime: { value: 0 }, uFire: { value: 0 }, uFireFront: { value: 0 },
      uFireCeil: { value: fireCeiling(0) }, uUplight: { value: 1 }, uNoise: { value: env.noise },
      uFogNear: { value: env.day.fogNear }, uFogFar: { value: env.day.fogFar } };
    this.fx = new BurnFx(env, this.burnU); this.root.add(this.fx.group);
    this.boss = bossRevealEnabled(env.ctx.world.options) ? new BossReveal(env, loader) : null;
    this.ready = this.boss?.ready ?? Promise.resolve();
  }
  update(dt: number): void {
    const { burn, day, ctx } = this.env, sprites = ctx.shared.mobileSprites;
    const t = burn.active ? burn.elapsed : 0, revealed = this.boss !== null && ctx.world.effigyRevealedAt != null;
    this.root.visible = !revealed;
    if (revealed) { this.fx.update(false, this.drive); this.boss!.update(t); return; }
    const u = this.burnU, fire = burn.active ? fireIntensity(t) : 0;
    u.uBurnTime.value = t; u.uFire.value = fire; u.uFireFront.value = burn.active ? fireFront(t) : 0;
    u.uFireCeil.value = fireCeiling(t); u.uUplight.value = burn.active ? Math.max(0, 1 - t / 6) : 1;
    u.uFogNear.value = day.fogNear; u.uFogFar.value = day.fogFar;
    if (sprites) {
      const p = this.pose, ground = this.root.position.y;
      const charge = this.boss && burn.active ? bossCharge(t) : 0;
      p.id = -5000000; p.y = ground; p.height = PLINTH_HEIGHT; p.yaw = 0; p.moving = false;
      sprites.object('effigy:plinth', p);
      const crown = LATTICE_TOP + 1.1, remaining = (burningScaffoldEnvelope(t, crown) - PLINTH_HEIGHT) / (crown - PLINTH_HEIGHT);
      if (remaining > 0) {
        p.id = -5000001; p.y = ground + PLINTH_HEIGHT; p.height = crown - PLINTH_HEIGHT;
        this.color.setScalar(1 - Math.min(1, t / 55) * .78).lerp(new THREE.Color(1, 1, 1), charge);
        sprites.object('effigy:scaffold', p, { tint: this.color, cropTop: 1 - remaining });
      }
      const flagTime = ctx.world.options.mode === 'tutorial' ? 0 : t, scale = flagBurnScale(flagTime);
      if (scale > 0) {
        p.id = -5000002; p.y = ground + PLINTH_HEIGHT; p.height = (MAST_TOP - PLINTH_HEIGHT) * scale;
        const wind = this.env.uniforms.uWind.value, target = Math.atan2(-wind.y, wind.x);
        if (this.flagYaw === null) this.flagYaw = target;
        let turn = target - this.flagYaw; turn -= Math.round(turn / (Math.PI * 2)) * Math.PI * 2;
        this.flagYaw += turn * Math.min(1, dt * .9);
        p.yaw = this.flagYaw; p.moving = true;
        const heat = sampleFlagHeat(flagTime);
        this.color.setRGB(...heat.color).lerp(new THREE.Color(1, 1, 1), charge);
        sprites.object('effigy:flag', p, { heatColor: heat.active ? this.color : undefined });
      }
    }
    this.drive.flare = burn.active ? ignitionFlare(t) : 0; this.drive.smoke = burn.active ? smokeAmount(t) : 0;
    this.drive.emberRate = burn.active ? emberRate(t) : 0; this.drive.emberBed = burn.active ? emberBed(t) : 0;
    this.fx.update(burn.active, this.drive); this.boss?.update(t);
  }
  onEvent(event: GameEvent): void { this.boss?.onEvent(event); }
  dispose(): void { this.fx.dispose(); this.boss?.dispose(); this.root.removeFromParent(); }
}
