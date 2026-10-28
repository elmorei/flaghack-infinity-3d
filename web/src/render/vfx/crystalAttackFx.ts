/** Snapshot-driven ordinary crystal warning/attack presentation; never simulates damage. */
import * as THREE from 'three';
import type { BossLightning } from '../../sim/boss';
import { CRYSTAL_ATTACK_WARNING, crystalAttackAim, crystalAttackOrigin, throneAttackOrigin } from '../../sim/systems/crystalAttacks';
import { rtsThroneAltar } from '../../sim/rts';
import type { World } from '../../sim/world';
import { LightningArc } from './bossLightningFx';
import { lightningSourceColor, setLightningPalette } from './lightningPalette';

interface LinkFx { arc: LightningArc; ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; seen: number; }
export class CrystalAttackFx {
  readonly group = new THREE.Group();
  private readonly links = new Map<number, LinkFx>();
  private frame = 0;
  constructor(private readonly renderOrder = 16) { this.group.name = 'crystal-unit-attacks'; }
  update(world: World, now: number, groundY: (x: number, z: number) => number): void {
    const frame = ++this.frame;
    if (world.phase === 'playing' && world.options.mode !== 'tutorial' && world.options.match?.crystalAttacks !== false && world.effigyRevealedAt === null) {
      const emitters = [...world.crystals.values()].filter(c => c.growth >= 1 && c.scale === 1 && world.factions[c.faction].alive)
        .map(c => ({ id: c.id, faction: c.faction, attack: c.attack, origin: crystalAttackOrigin(world, c), kind: 'crystal' as const }));
      const thrones = Object.values(world.factions).flatMap(f => {
        const altar = rtsThroneAltar(world, f.id);
        return altar ? [{ id: altar.id, faction: f.id, attack: f.throneAttack, origin: throneAttackOrigin(world, f.id), kind: 'ward' as const }] : [];
      });
      for (const crystal of [...emitters, ...thrones]) {
        const attack = crystal.attack;
        if (!attack || attack.faction !== crystal.faction) continue;
        const target = world.avatars.get(attack.target) ?? world.hippies.get(attack.target);
        if (!target || target.hp <= 0 || target.faction === crystal.faction || target.faction === -1 || !world.factions[target.faction].alive ||
          (target.type === 'avatar' && world.factions[target.faction].controlMode === 'rts')) continue;
        let fx = this.links.get(crystal.id);
        if (!fx) {
          const arc = new LightningArc(crystal.id, this.renderOrder, .24, 'crystal-unit-lightning');
          const ring = new THREE.Mesh(new THREE.RingGeometry(.7, 1, 32), new THREE.MeshBasicMaterial({ color: 0xffffff,
            transparent: true, opacity: .85, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
          ring.name = `crystal-unit-warning-${crystal.id}`; ring.rotation.x = -Math.PI / 2; ring.renderOrder = this.renderOrder;
          fx = { arc, ring, seen: frame }; this.links.set(crystal.id, fx); this.group.add(arc.mesh, ring);
        }
        fx.seen = frame;
        const link: BossLightning = { kind: crystal.kind, id: crystal.id, faction: crystal.faction,
          from: crystal.origin, to: crystalAttackAim(world, target) };
        const color = lightningSourceColor(world, link);
        setLightningPalette(fx.arc.mesh.material.uniforms.uCore.value, fx.arc.mesh.material.uniforms.uGlow.value, color);
        // readyAt is an authoritative simulation timestamp, not the local animation clock.
        // Snapshot time preserves the warning on late joins and freezes its progress while paused.
        const remaining = Math.max(0, attack.readyAt - world.time), warning = remaining > 0;
        fx.arc.update(link, Math.floor(now * 28), groundY, warning ? .12 : .8);
        fx.ring.visible = warning;
        fx.ring.material.color.set(color);
        fx.ring.material.opacity = .55 + .35 * (1 + Math.sin(now * 18)) / 2;
        fx.ring.position.set(target.pos.x, groundY(target.pos.x, target.pos.z) + .08, target.pos.z);
        fx.ring.scale.setScalar(.8 + Math.min(1, remaining / CRYSTAL_ATTACK_WARNING) * .6);
      }
    }
    for (const [id, fx] of this.links) if (fx.seen !== frame) { this.remove(fx); this.links.delete(id); }
    this.group.visible = this.links.size > 0;
  }
  private remove(fx: LinkFx): void { fx.arc.dispose(); fx.ring.removeFromParent(); fx.ring.geometry.dispose(); fx.ring.material.dispose(); }
  dispose(): void { for (const fx of this.links.values()) this.remove(fx); this.links.clear(); this.group.removeFromParent(); }
}
