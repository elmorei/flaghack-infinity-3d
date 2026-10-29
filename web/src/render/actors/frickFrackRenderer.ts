/** The Frick-frack wizard and scarce physical cheat cards. Presentation never changes inventory. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { RenderContext } from '../context';
import { angleDiff } from '../../sim/math';
import { damp, hash01 } from './util';

export const WIZARD_HEIGHT = 2.57;
export const CHEAT_CARD_WIDTH = .5;
export const CHEAT_CARD_HEIGHT = .72;
const RANKS = ['?', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

/** Merged low-poly cloth, skin, beard, trim and staff; a distinct silhouette even at low quality. */
export function buildFrickFrackWizard(): THREE.Group {
  const root = new THREE.Group(); root.name = 'frick-frack-wizard';
  const parts: THREE.BufferGeometry[][] = Array.from({length: 6}, () => []);
  const add = (slot: number, g: THREE.BufferGeometry, x: number, y: number, z: number) => { g.translate(x, y, z); parts[slot].push(g); };
  const rod = (slot: number, a: number[], b: number[], r: number, top = r) => {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), delta = to.clone().sub(from);
    const g = new THREE.CylinderGeometry(top, r, delta.length(), 7);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
    const mid = from.add(to).multiplyScalar(.5); add(slot, g, mid.x, mid.y, mid.z);
  };
  // Long flared robe and broad sleeves; leather slippers remain visible below its hem.
  add(0, new THREE.CylinderGeometry(.22, .37, 1.21, 9), 0, .72, 0);
  add(0, new THREE.CylinderGeometry(.15, .25, .25, 9), 0, 1.42, 0);
  rod(0, [-.2, 1.38, 0], [-.43, .94, .12], .14, .17);
  rod(0, [.2, 1.38, 0], [.44, 1.13, .16], .15, .17);
  for (const x of [-.14, .14]) add(5, new THREE.BoxGeometry(.19, .12, .36), x, .07, .08);
  add(1, new THREE.SphereGeometry(.15, 9, 6), 0, 1.66, 0);
  add(1, new THREE.SphereGeometry(.065, 7, 4), -.44, .94, .15);
  add(1, new THREE.SphereGeometry(.065, 7, 4), .46, 1.13, .19);
  add(1, new THREE.ConeGeometry(.034, .09, 5).rotateX(Math.PI / 2), 0, 1.65, .16);
  // Flowing silver beard, shoulders of hair and two expressive brows.
  add(2, new THREE.ConeGeometry(.145, .48, 7).rotateZ(Math.PI), 0, 1.40, .145);
  add(2, new THREE.SphereGeometry(.17, 8, 6).scale(1.07, 1.15, .8), 0, 1.64, -.065);
  for (const x of [-.065, .065]) add(2, new THREE.BoxGeometry(.075, .025, .024), x, 1.725, .127);
  for (const x of [-.055, .055]) add(5, new THREE.SphereGeometry(.018, 5, 3), x, 1.69, .142);
  // Wide brim, tapering purple crown, bent tip; gold band and stitched stars.
  add(0, new THREE.CylinderGeometry(.38, .39, .055, 12), 0, 1.83, 0);
  add(0, new THREE.ConeGeometry(.245, .65, 9), 0, 2.14, 0);
  const tip = new THREE.ConeGeometry(.078, .25, 7).rotateZ(-.6);
  add(0, tip, .07, 2.44, 0);
  add(3, new THREE.CylinderGeometry(.239, .25, .07, 9), 0, 1.89, 0);
  add(3, new THREE.TorusGeometry(.3, .018, 4, 9).rotateX(Math.PI / 2), 0, .19, 0);
  const star = (x: number, y: number, z: number, r: number) => {
    const shape = new THREE.Shape();
    for (let i = 0; i < 10; i++) {
      const a = Math.PI / 2 + i * Math.PI / 5, s = i % 2 ? r * .42 : r;
      if (i === 0) shape.moveTo(Math.cos(a) * s, Math.sin(a) * s); else shape.lineTo(Math.cos(a) * s, Math.sin(a) * s);
    }
    shape.closePath(); add(3, new THREE.ShapeGeometry(shape), x, y, z);
  };
  star(0, 2.11, .164, .09); star(-.14, .74, .29, .075); star(.12, 1.04, .24, .07); star(.08, .43, .34, .09);
  // Crooked walking staff topped with a dim amber crystal; no postprocessing is required.
  rod(4, [.48, .03, .2], [.48, 1.75, .2], .035, .025);
  rod(4, [.48, 1.75, .2], [.58, 1.91, .2], .025);
  add(3, new THREE.OctahedronGeometry(.1), .58, 1.96, .2);
  const materials = [
    new THREE.MeshStandardMaterial({color: 0x63419b, roughness: .93, flatShading: true}),
    new THREE.MeshStandardMaterial({color: 0xd4a879, roughness: .8, flatShading: true}),
    new THREE.MeshStandardMaterial({color: 0xdce0de, roughness: .96, flatShading: true}),
    new THREE.MeshStandardMaterial({color: 0xe8c364, emissive: 0x7d4d0e, emissiveIntensity: .12, roughness: .55, side: THREE.DoubleSide}),
    new THREE.MeshStandardMaterial({color: 0x6d482d, roughness: 1, flatShading: true}),
    new THREE.MeshStandardMaterial({color: 0x24212b, roughness: .9}),
  ];
  parts.forEach((geometries, i) => {
    // ShapeGeometry and solid geometry all carry normals + UVs, permitting one draw per material.
    const flat = geometries.map(g => g.index ? g.toNonIndexed() : g);
    const geometry = mergeGeometries(flat, false)!;
    new Set([...geometries, ...flat]).forEach(g => g.dispose());
    const mesh = new THREE.Mesh(geometry, materials[i]);
    mesh.name = ['wizard-purple-robes-and-hat', 'wizard-face-and-hands', 'wizard-silver-beard', 'wizard-gold-stars', 'wizard-staff', 'wizard-eyes-and-slippers'][i];
    mesh.castShadow = mesh.receiveShadow = true; root.add(mesh);
  });
  return root;
}

/** The pickup face and the sideboard use the same familiar rank/suit notation. */
export function cheatCardLabel(rank: number, suit: number): string { return `${RANKS[rank] ?? '?'}${SUITS[suit] ?? '?'}`; }

export function makeCheatCardTexture(rank: number, suit: number): THREE.Texture {
  // Node-only geometry tests do not need a DOM; browsers always use the painted face.
  if (typeof document === 'undefined') return new THREE.Texture();
  const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 184;
  const g = canvas.getContext('2d');
  if (!g) return new THREE.Texture();
  g.fillStyle = '#fff9e6'; g.fillRect(0, 0, 128, 184);
  g.strokeStyle = '#c4a266'; g.lineWidth = 7; g.strokeRect(4, 4, 120, 176);
  g.fillStyle = suit === 1 || suit === 2 ? '#a92f42' : '#292837';
  g.font = 'bold 35px Georgia, serif'; g.textAlign = 'left'; g.textBaseline = 'top';
  g.fillText(RANKS[rank] ?? '?', 13, 11);
  g.font = '64px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(SUITS[suit] ?? '?', 64, 103);
  g.save(); g.translate(128, 184); g.rotate(Math.PI); g.font = 'bold 26px Georgia, serif'; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText(RANKS[rank] ?? '?', 12, 9); g.restore();
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}

interface CardView { mesh: THREE.Mesh; key: string }
export class FrickFrackRenderer {
  readonly group = new THREE.Group();
  readonly wizard = buildFrickFrackWizard();
  private readonly anchor = new THREE.Vector3();
  private readonly targetPosition = new THREE.Vector3();
  private anchorId = -1;
  private readonly cards = new Map<number, CardView>();
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly cardGeometry = new THREE.PlaneGeometry(CHEAT_CARD_WIDTH, CHEAT_CARD_HEIGHT);
  private wasVisible = false;

  constructor(private readonly ctx: RenderContext) {
    this.group.name = 'frick-frack-actors'; this.group.add(this.wizard); this.wizard.visible = false; ctx.scene.add(this.group);
  }

  update(dt: number): void {
    const {world, time, shared} = this.ctx, state = world.frickFrack;
    const h = state ? world.hippies.get(state.wizardId) : undefined;
    if (this.anchorId !== (h?.id ?? -1)) {
      if (shared.unitAnchors?.get(this.anchorId) === this.anchor) shared.unitAnchors.delete(this.anchorId);
      this.anchorId = h?.id ?? -1;
    }
    this.wizard.visible = !!h;
    if (h) {
      const ground = shared.groundOffset?.(h.pos.x, h.pos.z) ?? world.collision.groundHeight(h.pos.x, h.pos.z);
      const targetY = ground + Math.max(0, h.airborne?.y ?? 0);
      if (!this.wasVisible || Math.hypot(h.pos.x - this.wizard.position.x, h.pos.z - this.wizard.position.z) > 4) this.wizard.position.set(h.pos.x, targetY, h.pos.z);
      else this.wizard.position.lerp(this.targetPosition.set(h.pos.x, targetY, h.pos.z), damp(14, dt));
      const ko = h.koUntil > world.time || h.status === 'ko';
      this.wizard.rotation.x += ((ko ? -Math.PI / 2 : 0) - this.wizard.rotation.x) * damp(10, dt);
      this.wizard.rotation.y += angleDiff(this.wizard.rotation.y, h.facing) * damp(10, dt);
      this.wizard.rotation.z = ko ? 0 : .012 * Math.sin(time * 1.7);
      this.wizard.updateMatrixWorld(true);
      this.anchor.set(0, 1.8, 0).applyMatrix4(this.wizard.matrixWorld); shared.unitAnchors?.set(h.id, this.anchor);
    }
    this.wasVisible = !!h;
    const seen = new Set<number>();
    for (const drop of state?.drops ?? []) {
      seen.add(drop.id); const key = `${drop.card.rank}:${drop.card.suit}`;
      let v = this.cards.get(drop.id);
      if (v && v.key !== key) { this.releaseCard(v); this.cards.delete(drop.id); v = undefined; }
      if (!v) {
        let texture = this.textures.get(key);
        if (!texture) { texture = makeCheatCardTexture(drop.card.rank, drop.card.suit); this.textures.set(key, texture); }
        const material = new THREE.MeshBasicMaterial({map: texture, side: THREE.DoubleSide, toneMapped: false});
        const mesh = new THREE.Mesh(this.cardGeometry, material); mesh.name = `frick-frack-card-${drop.id}`;
        mesh.userData.cardLabel = cheatCardLabel(drop.card.rank, drop.card.suit); this.group.add(mesh);
        v = {mesh, key}; this.cards.set(drop.id, v);
      }
      const ground = shared.groundOffset?.(drop.pos.x, drop.pos.z) ?? world.collision.groundHeight(drop.pos.x, drop.pos.z);
      v.mesh.position.set(drop.pos.x, ground + .48 + .08 * Math.sin(time * 2 + hash01(drop.id) * 6), drop.pos.z);
      // Tilted toward overhead cameras but still upright enough for Regular view; slowly turns for visibility.
      v.mesh.rotation.set(-.35, time * .45 + hash01(drop.id) * Math.PI * 2, .08);
    }
    for (const [id, v] of this.cards) if (!seen.has(id)) { this.releaseCard(v); this.cards.delete(id); }
  }

  private releaseCard(v: CardView): void { this.group.remove(v.mesh); (v.mesh.material as THREE.Material).dispose(); }
  dispose(): void {
    if (this.ctx.shared.unitAnchors?.get(this.anchorId) === this.anchor) this.ctx.shared.unitAnchors.delete(this.anchorId);
    for (const v of this.cards.values()) this.releaseCard(v); this.cards.clear();
    this.cardGeometry.dispose(); for (const texture of this.textures.values()) texture.dispose(); this.textures.clear();
    this.wizard.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); const materials = Array.isArray(o.material) ? o.material : [o.material]; materials.forEach(m => m.dispose()); } });
    this.ctx.scene.remove(this.group);
  }
}
