/** Read-only encounter feedback. Every effect can be reconstructed on a late join. */
import * as THREE from 'three';
import type { BossState } from '../../../../sim/boss';
import { BOSS_FORCEFIELD_WIDTH, BOSS_FORCEFIELD_HEIGHT, BOSS_FORCEFIELD_CENTER_HEIGHT } from '../../../../sim/bossForcefield';
import { BOSS_GAMEPLAY_SCALE } from '../../../../sim/bossDimensions';
import type { EnvContext } from '../../envTypes';
import { groundHeight } from '../../../../sim/terrain';
import { MAP_HALF } from '../../../../sim/constants';
import { groundBossGeometry } from './groundGeometry';
import { Rng } from '../../../../sim/rng';
import { smooth } from './revealTimeline';
import { createCrater } from './revealFx';
import { bossForcefieldContacts } from './forcefieldContact';
import type { BossForcefieldContact } from './forcefieldContact';
import { flagSpriteRotation } from '../../../actors/flagSpriteTransform';

const ADD = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending };
const PLANE_VERTEX = `varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;

/** Original material values stay untouched; only the dying encounter receives char/erosion. */
export function applyBossDeathMaterial(material: THREE.Material, age: { value: number }): void {
  const before = material.onBeforeCompile, key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    before(shader, renderer); shader.uniforms.uBossDeathAge = age;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vBossBurn;')
      .replace('#include <skinning_vertex>', '#include <skinning_vertex>\nvBossBurn = transformed;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vBossBurn; uniform float uBossDeathAge;
      float bossAsh(vec3 p){return fract(sin(dot(floor(p*18.0),vec3(12.9898,78.233,37.719)))*43758.5453);}`)
      .replace('void main() {', `void main() {
        float bossBurnAway=smoothstep(6.0,12.0,uBossDeathAge);
        float bossBurnNoise=bossAsh(vBossBurn);
        if(uBossDeathAge>=0.0 && bossBurnNoise<bossBurnAway) discard;`);
    if (material instanceof THREE.MeshStandardMaterial) shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      float bossChar=smoothstep(0.4,5.0,uBossDeathAge);
      diffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.022,0.015,0.011),bossChar*0.96);
      float emberEdge=(1.0-smoothstep(0.025,0.12,bossBurnNoise-bossBurnAway))*step(6.0,uBossDeathAge);
      totalEmissiveRadiance+=vec3(1.0,0.13,0.012)*(emberEdge*2.0+bossChar*0.15)*(1.0-smoothstep(10.5,12.0,uBossDeathAge));`);
  };
  material.customProgramCacheKey = () => key + '-boss-death-v1';
}

export class BossCombatFx {
  readonly group = new THREE.Group();
  readonly deathAge = { value: -1 };
  private readonly geos = new Set<THREE.BufferGeometry>();
  private readonly mats = new Set<THREE.Material>();
  private readonly shieldGeometry = new THREE.PlaneGeometry(BOSS_FORCEFIELD_WIDTH, BOSS_FORCEFIELD_HEIGHT, 1, 1);
  private readonly shieldMaterial: THREE.ShaderMaterial;
  private readonly shields = new Map<number, THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>>();
  private readonly shieldTime = { value: 0 };
  private shieldContacts: BossForcefieldContact[] = [];
  private readonly stomp: THREE.Mesh;
  private readonly stompAge = { value: -1 };
  private readonly flames: { mesh: THREE.Mesh; bone: THREE.Bone }[] = [];
  private readonly fireUniforms: { uAge: { value: number }; uTime: { value: number }; uNoise: { value: THREE.Texture }; uBossFxScale: { value: number } };
  private readonly crater: THREE.Mesh;
  private groundAt = { x: Infinity, z: Infinity };
  private readonly held = new THREE.Group();
  private readonly heldFlag = new THREE.Group();
  private readonly heldBuilding = new THREE.Group();
  private readonly heldPiece = new THREE.Group();
  private readonly heldColor = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .7 });
  private readonly point = new THREE.Vector3();
  /** The simulation removes its meal before the final swallowing animation ends. */
  private heldBuildingKind: {id: number; kind: string} | null = null;

  constructor(private env: EnvContext, model: THREE.Group) {
    this.group.name = 'boss-combat-fx';
    this.fireUniforms = { uAge: this.deathAge, uTime: { value: 0 }, uNoise: { value: env.noise }, uBossFxScale: { value: BOSS_GAMEPLAY_SCALE } };
    const add = <T extends THREE.Mesh>(mesh: T, name: string, parent: THREE.Object3D = this.group): T => {
      mesh.name = name; mesh.frustumCulled = false; parent.add(mesh); this.geos.add(mesh.geometry);
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) this.mats.add(m);
      return mesh;
    };
    this.shieldMaterial = new THREE.ShaderMaterial({
      ...ADD, side: THREE.DoubleSide, uniforms: { uTime: this.shieldTime, uColor: { value: new THREE.Color() } }, vertexShader: PLANE_VERTEX,
      // More separate rings, with the original rim/wave/grid opacity and additive gain.
      // Repeating radius (rather than summing rings) prevents extra overlap brightness.
      fragmentShader: `uniform float uTime;uniform vec3 uColor;varying vec2 vUv;void main(){
        vec2 p=(vUv-.5)*vec2(1.0,1.65);float r=length(p);float rim=exp(-pow((r-.4)/.016,2.0));
        float ringDistance=abs(mod(r-uTime*.08+.0475,.095)-.0475);
        float wave=exp(-pow(ringDistance/.012,2.0));float grid=pow(max(0.0,cos(p.x*74.0)*cos(p.y*74.0)),12.0);
        float alpha=(rim*.65+wave*.9+grid*.16)*(1.0-smoothstep(.4,.61,r));
        gl_FragColor=vec4(uColor*alpha*2.3,alpha);#include <colorspace_fragment>}`.replace(';#include', ';\n#include'),
    });
    this.geos.add(this.shieldGeometry); this.mats.add(this.shieldMaterial);
    this.stomp = add(new THREE.Mesh(new THREE.RingGeometry(0, 6, 64, 8).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      ...ADD, side: THREE.DoubleSide, uniforms: { uAge: this.stompAge },
      vertexShader: `varying vec3 vLocal;void main(){vLocal=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: `uniform float uAge;varying vec3 vLocal;void main(){float r=length(vLocal.xz);float band=exp(-pow((r-(.5+uAge*7.0))/.16,2.0));float a=band*(1.0-smoothstep(.25,.8,uAge));gl_FragColor=vec4(vec3(.72,.48,.23)*a*1.7,a);\n#include <colorspace_fragment>}`,
    })), 'boss-stomp-impact');
    this.stomp.renderOrder = 3; this.stomp.scale.setScalar(BOSS_GAMEPLAY_SCALE);
    const flameGeo = new THREE.InstancedBufferGeometry();
    flameGeo.setAttribute('position', new THREE.Float32BufferAttribute([-.5,0,0,.5,0,0,.5,1,0,-.5,1,0], 3));
    flameGeo.setIndex([0, 1, 2, 0, 2, 3]); flameGeo.instanceCount = 7;
    const rng = new Rng('boss-combat-flames');
    flameGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(Float32Array.from({ length: 28 }, () => rng.next()), 4));
    const flameMat = new THREE.ShaderMaterial({ ...ADD, side: THREE.DoubleSide, uniforms: this.fireUniforms,
      vertexShader: `attribute vec4 aSeed;uniform float uAge;uniform float uTime;uniform float uBossFxScale;varying vec2 vUv;varying vec2 vSeed;
      void main(){float grow=smoothstep(0.0,1.8,uAge)*(1.0-smoothstep(9.0,12.0,uAge));
        vec3 center=vec3((aSeed.x-.5)*2.3,aSeed.y*1.2,(aSeed.z-.5)*2.3);vec4 p=modelViewMatrix*vec4(center*uBossFxScale,1.0);
        p.xy+=vec2(position.x*(1.0+aSeed.w),position.y*(2.0+aSeed.y*3.2))*grow*uBossFxScale;
        p.x+=sin(uTime*5.0+aSeed.z*20.0+position.y*4.0)*position.y*.24*grow*uBossFxScale;
        gl_Position=projectionMatrix*p;vUv=vec2(position.x+.5,position.y);vSeed=aSeed.xz;}`,
      fragmentShader: `uniform sampler2D uNoise;uniform float uTime;uniform float uAge;varying vec2 vUv;varying vec2 vSeed;
      void main(){float n=texture2D(uNoise,vec2(vUv.x*1.5,vUv.y*.8-uTime*.6)+vSeed*5.0).r;
        float width=(1.0-vUv.y)*.46;float body=1.0-smoothstep(width*.3,width+.08,abs(vUv.x-.5)+(n-.5)*.19);
        float a=body*(1.0-smoothstep(.55,1.0,vUv.y))*(1.0-smoothstep(9.5,12.0,uAge));if(a<.02)discard;
        vec3 color=mix(vec3(1.0,.055,.005),vec3(1.0,.68,.12),pow(1.0-vUv.y,2.0))*a*1.25;
        gl_FragColor=vec4(color,a);\n#include <colorspace_fragment>}`,
    });
    for (const name of ['pelvis', 'spine', 'chest', 'head', 'thighL', 'thighR']) {
      const bone = model.getObjectByName(name) as THREE.Bone;
      const mesh = add(new THREE.Mesh(flameGeo, flameMat), 'boss-death-fire-' + name); mesh.renderOrder = 7;
      this.flames.push({ mesh, bone });
    }
    this.crater = add(new THREE.Mesh(createCrater(new Rng('boss-death-crater')), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 })), 'boss-death-crater');
    this.crater.scale.setScalar(.65 * BOSS_GAMEPLAY_SCALE); this.crater.receiveShadow = true;
    this.held.name = 'boss-held-target'; (model.getObjectByName('handR') as THREE.Bone).add(this.held);
    this.held.position.set(0, 1.7, 0); this.held.add(this.heldFlag, this.heldBuilding, this.heldPiece);
    // Grip grows with the hand, but picked-up world objects retain their existing dimensions.
    for (const carried of [this.heldFlag, this.heldBuilding, this.heldPiece]) carried.scale.setScalar(1 / BOSS_GAMEPLAY_SCALE);
    const wood = new THREE.MeshStandardMaterial({ color: 0x6d4530, roughness: .95 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x241c18, roughness: .9 });
    add(new THREE.Mesh(new THREE.CylinderGeometry(.055, .06, 3.6, 6), wood), 'boss-held-flag-pole', this.heldFlag);
    const cloth = add(new THREE.Mesh(new THREE.PlaneGeometry(1.4, .9), this.heldColor), 'boss-held-flag-cloth', this.heldFlag); cloth.position.set(.7, .9, 0); this.heldColor.side = THREE.DoubleSide;
    add(new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.5, 1.8), wood), 'boss-held-building-body', this.heldBuilding);
    const roof = add(new THREE.Mesh(new THREE.ConeGeometry(1.9, 1.1, 4), this.heldColor), 'boss-held-building-roof', this.heldBuilding); roof.rotation.y = Math.PI / 4; roof.position.y = 1.3;
    const door = add(new THREE.Mesh(new THREE.BoxGeometry(.55, .9, .05), dark), 'boss-held-building-door', this.heldBuilding); door.position.set(0, -.3, .925);
    add(new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.7, .3), wood), 'boss-held-wall-planks', this.heldPiece);
    const stripe = add(new THREE.Mesh(new THREE.BoxGeometry(2.85, .25, .33), this.heldColor), 'boss-held-wall-stripe', this.heldPiece); stripe.position.y = .35;
    this.mats.add(this.heldColor);
    this.group.visible = false; this.held.visible = false;
  }

  update(boss: BossState | null | undefined, now: number): void {
    this.group.visible = !!boss; this.held.visible = !!boss?.held;
    if (boss?.held?.kind !== 'building') this.heldBuildingKind = null;
    this.deathAge.value = boss?.deathAt === null || boss?.deathAt === undefined ? -1 : Math.max(0, now - boss.deathAt);
    this.updateShields(boss, now);
    if (!boss) return;
    const origin = this.env.ctx.world.map.effigy;
    const x = boss.pos.x - origin.x, z = boss.pos.z - origin.z, death = this.deathAge.value;
    if ((death >= 4 || boss.action === 'stomp') && (this.groundAt.x !== boss.pos.x || this.groundAt.z !== boss.pos.z)) {
      this.groundAt = { ...boss.pos };
      const half = this.env.ctx.world.map.half ?? MAP_HALF;
      groundBossGeometry(this.crater.geometry, boss.pos, .65 * BOSS_GAMEPLAY_SCALE, half);
      groundBossGeometry(this.stomp.geometry, boss.pos, BOSS_GAMEPLAY_SCALE, half);
    }
    this.fireUniforms.uTime.value = now;
    for (const f of this.flames) {
      f.mesh.visible = death >= 0 && death < 12;
      if (f.mesh.visible) { f.bone.getWorldPosition(this.point); this.group.worldToLocal(this.point); f.mesh.position.copy(this.point); }
    }
    this.crater.visible = death >= 4;
    this.crater.position.set(x, .012, z);
    const actionAge = Math.max(0, now - boss.actionAt);
    this.stomp.visible = boss.action === 'stomp' && actionAge >= 1 && actionAge < 1.8;
    this.stompAge.value = actionAge - 1; this.stomp.position.set(x, .14 * BOSS_GAMEPLAY_SCALE, z);
    if (boss.held) {
      const owner = boss.held.faction; this.heldColor.color.set(owner === -1 ? 0xe4dfce : this.env.ctx.world.factions[owner].color);
      this.heldFlag.visible = boss.held.kind === 'flag'; this.heldPiece.visible = boss.held.kind === 'piece'; this.heldBuilding.visible = boss.held.kind === 'building';
      this.held.scale.setScalar(1 - smooth(2.55, 2.8, actionAge));
      const sprites = this.env.ctx.shared?.mobileSprites;
      if (boss.held.kind === 'flag' && sprites) {
        // The carried world Flag is intentionally skipped by FlagRenderer. Replace this
        // hand-attached proxy separately, using the same pose and consumption shrink.
        this.heldFlag.updateWorldMatrix(true, false);
        const m = this.heldFlag.matrixWorld.elements;
        const scale = Math.hypot(m[4], m[5], m[6]);
        if (sprites.flag({
          id: -1 - boss.held.id, x: m[12] - m[4] * 1.8, y: m[13] - m[5] * 1.8, z: m[14] - m[6] * 1.8,
          yaw: Math.atan2(m[8], m[10]), height: 3.6 * scale, moving: true,
        }, 'carried', {ribbon: this.heldColor.color, rotation: flagSpriteRotation(m, this.env.ctx.camera)})) {
          this.heldFlag.visible = false;
        }
      } else if (boss.held.kind === 'building' && sprites) {
        const building = this.env.ctx.world.buildings?.get(boss.held.id);
        if (building) this.heldBuildingKind = {id: building.id, kind: building.kind};
        const kind = this.heldBuildingKind?.id === boss.held.id ? this.heldBuildingKind.kind : 'unknown';
        this.heldBuilding.updateWorldMatrix(true, false);
        const m = this.heldBuilding.matrixWorld.elements, scale = Math.hypot(m[4], m[5], m[6]);
        // Keep the original held-target cue's bottom and size, including swallowing
        // shrink. A late join after consumption gets a flat placeholder, not a house.
        sprites.building(kind, {
          id: -6000000 - boss.held.id,
          x: m[12] - m[4] * .75, y: m[13] - m[5] * .75, z: m[14] - m[6] * .75,
          yaw: Math.atan2(m[8], m[10]), height: 2.6 * scale, moving: true,
        }, {ownerColor: this.heldColor.color, state: 'idle', rotation: flagSpriteRotation(m, this.env.ctx.camera),
          disabled: building?.disabled, damage: building && building.maxHp > 0 ? Math.max(0, 1 - building.hp / building.maxHp) : 0});
        this.heldBuilding.visible = false;
      }
    }
  }
  private updateShields(boss: BossState | null | undefined, now: number): void {
    const world = this.env.ctx.world, origin = world.map.effigy;
    this.shieldContacts = bossForcefieldContacts(world, boss, this.shieldContacts);
    this.shieldTime.value = now;
    const active = new Set(this.shieldContacts.map(c => c.edge));
    for (const [edge, mesh] of this.shields) if (!active.has(edge)) {
      mesh.removeFromParent(); mesh.material.dispose(); this.mats.delete(mesh.material); this.shields.delete(edge);
    }
    for (const contact of this.shieldContacts) {
      let mesh = this.shields.get(contact.edge);
      if (!mesh) {
        const material = this.shieldMaterial.clone(); material.uniforms.uTime = this.shieldTime;
        mesh = new THREE.Mesh(this.shieldGeometry, material);
        mesh.name = 'boss-faction-forcefield'; mesh.userData.edge = contact.edge;
        mesh.frustumCulled = false; mesh.renderOrder = 5;
        this.shields.set(contact.edge, mesh); this.mats.add(material); this.group.add(mesh);
      }
      mesh.material.uniforms.uColor.value.set(world.factions[contact.faction].color);
      mesh.position.set(contact.x - origin.x, groundHeight(contact.x, contact.z, world.map.half ?? MAP_HALF) + BOSS_FORCEFIELD_CENTER_HEIGHT, contact.z - origin.z);
      mesh.rotation.y = contact.yaw;
    }
  }
  dispose(): void {
    for (const g of this.geos) g.dispose(); for (const m of this.mats) m.dispose();
    this.held.removeFromParent(); this.group.removeFromParent();
  }
}
