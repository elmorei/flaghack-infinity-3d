/** The card table is a real Three scene, drawn by the game's existing WebGL renderer.
 * Inputs are already-public cards only. This module never inspects a deck or private state. */
import * as THREE from 'three';
import type { FrickFrackCard } from '../sim/frickFrack';
import { tarotCardAsset } from '../ui/frickFrackTarot';
import { parodyCardSprite } from '../ui/frickFrackParody';
import { majorArcanaAsset } from '../ui/frickFrackArcana';

export interface Rect { x: number; y: number; width: number; height: number }
export interface CardView { key: string; card: FrickFrackCard | null; rect: Rect; defeated: boolean; order: number }
export interface TableView { sessionKey: string; panel: Rect; cards: CardView[]; reducedMotion: boolean }
export interface PublicArtwork { url: string; crop?: { x: number; y: number; width: number; height: number } }
/** Calling this with null is deliberately a complete privacy boundary. */
export function publicCardArtwork(card: FrickFrackCard | null): PublicArtwork | null {
  if (!card) return null;
  const sprite = parodyCardSprite(card);
  if (sprite) return { url: sprite.url, crop: { x: sprite.x, y: sprite.y, width: sprite.width, height: sprite.height } };
  const url = majorArcanaAsset(card) ?? tarotCardAsset(card);
  return url ? { url } : null;
}
export function faceSignature(card: FrickFrackCard | null, defeated = false): string {
  return card ? `${card.id}:${card.rank}:${card.suit}:${card.tarot ? 1 : 0}:${card.parody ?? ''}:${card.arcana ?? ''}:${card.value ?? ''}:${card.temporary ? 1 : 0}:${defeated ? 1 : 0}` : 'hidden';
}
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const ease = (n: number) => 1 - Math.pow(1 - clamp01(n), 3);
/** One clock controls the whole physical card, avoiding independent face/back tracks. */
export function cardMotion(elapsedMs: number, hidden: boolean, reduced: boolean, revealOnly = false): { progress: number; angle: number; lift: number } {
  if (reduced) return { progress: 1, angle: hidden ? Math.PI : 0, lift: 0 };
  const progress = revealOnly ? 1 : ease(elapsedMs / 330);
  const flip = ease((elapsedMs - (revealOnly ? 0 : 80)) / 250);
  return { progress, angle: hidden ? Math.PI : Math.PI * (1 - flip), lift: revealOnly ? 0 : Math.sin(clamp01(elapsedMs / 330) * Math.PI) * 20 };
}
export function containedImageRect(sw: number, sh: number, width: number, height: number): Rect {
  const ratio = Math.min(width / Math.max(1, sw), height / Math.max(1, sh));
  const w = sw * ratio, h = sh * ratio;
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

interface Face { texture: THREE.CanvasTexture; cancelled: boolean; image?: HTMLImageElement }
interface CardNode {
  group: THREE.Group; front: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  face: Face | null; signature: string; hidden: boolean; born: number; revealOnly: boolean; view: CardView; progress: number;
}
function canvas(width = 256, height = 384): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Card artwork requires a 2D texture canvas');
  return [c, ctx];
}
function texture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  return t;
}
function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r = 14): void {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
}
function makeBack(): THREE.CanvasTexture {
  const [c, ctx] = canvas();
  rounded(ctx, 2, 2, 252, 380); ctx.fillStyle = '#f5e8c9'; ctx.fill();
  rounded(ctx, 11, 11, 234, 362, 9); ctx.fillStyle = '#21374d'; ctx.fill();
  ctx.save(); ctx.clip(); ctx.strokeStyle = '#668393'; ctx.lineWidth = 1;
  for (let i = -400; i < 700; i += 16) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 384, 384); ctx.stroke(); ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i - 384, 384); ctx.stroke(); }
  ctx.restore();
  ctx.fillStyle = '#21374d'; ctx.beginPath(); ctx.ellipse(128, 192, 64, 78, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#e8c590'; ctx.lineWidth = 3; ctx.stroke();
  ctx.fillStyle = '#f3d9a4'; ctx.font = '76px Georgia'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('✦', 128, 188);
  ctx.font = 'bold 14px Georgia'; ctx.fillText('FRICK · FRACK', 128, 255);
  return texture(c);
}
function makeBlanket(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#f3e6cc'; ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#cf7764'; ctx.globalAlpha = .48;
  ctx.fillRect(0, 0, 128, 256); ctx.fillRect(0, 0, 256, 128); ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff4dc30'; for (let x = 0; x < 256; x += 4) ctx.fillRect(x, 0, 1, 256);
  ctx.fillStyle = '#613a2c20'; for (let y = 0; y < 256; y += 4) ctx.fillRect(0, y, 256, 1);
  const t = texture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
function makeShadow(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 22, 64, 64, 62); g.addColorStop(0, '#00000066'); g.addColorStop(1, '#00000000');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128); return texture(c);
}
function printValue(ctx: CanvasRenderingContext2D, card: FrickFrackCard): void {
  if (card.arcana !== undefined) return;
  const value = card.value !== undefined ? String(card.value) : card.parody !== undefined ? String(card.rank) : card.rank === 1 ? '1 / 11' : String(Math.min(card.rank, 10));
  ctx.fillStyle = '#fff4d7'; rounded(ctx, 160, 329, 78, 39, 8); ctx.fill();
  ctx.strokeStyle = '#4b3827'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#29252b'; ctx.font = 'bold 25px Georgia'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(value, 199, 350);
}
function paintStandard(ctx: CanvasRenderingContext2D, card: FrickFrackCard): void {
  const suit = ['♠', '♥', '♦', '♣'][card.suit] ?? '✦';
  const rank = card.rank === 1 ? 'A' : card.rank === 11 ? 'J' : card.rank === 12 ? 'Q' : card.rank === 13 ? 'K' : String(card.rank);
  ctx.fillStyle = card.suit === 1 || card.suit === 2 ? '#aa3e3b' : '#23323e';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 37px Georgia';
  ctx.fillText(rank, 33, 39); ctx.font = '30px Georgia'; ctx.fillText(suit, 33, 77);
  ctx.save(); ctx.translate(256, 384); ctx.rotate(Math.PI); ctx.font = 'bold 37px Georgia'; ctx.fillText(rank, 33, 39); ctx.font = '30px Georgia'; ctx.fillText(suit, 33, 77); ctx.restore();
  if (card.rank > 10) {
    ctx.font = 'bold 88px Georgia'; ctx.fillText(rank, 128, 171); ctx.font = '62px Georgia'; ctx.fillText(suit, 128, 251);
  } else {
    const count = Math.max(1, Math.min(10, card.rank));
    const rows = count <= 3 ? count : Math.ceil(count / 2);
    ctx.font = count === 1 ? '96px Georgia' : count <= 3 ? '54px Georgia' : '40px Georgia';
    for (let i = 0; i < count; i++) {
      const col = count <= 3 ? 128 : i === count - 1 && count % 2 ? 128 : i % 2 ? 166 : 90;
      const row = count <= 3 ? i : Math.floor(i / 2);
      ctx.fillText(suit, col, rows === 1 ? 192 : 118 + row * (148 / (rows - 1)));
    }
  }
  if (card.value !== undefined) printValue(ctx, card);
}
function makeFace(card: FrickFrackCard, defeated: boolean): Face {
  const [c, ctx] = canvas(); const face: Face = { texture: texture(c), cancelled: false };
  const base = () => { ctx.clearRect(0, 0, 256, 384); rounded(ctx, 2, 2, 252, 380); ctx.fillStyle = '#fff5df'; ctx.fill(); ctx.strokeStyle = '#ccbea0'; ctx.lineWidth = 3; ctx.stroke(); };
  const finish = () => {
    if (defeated) {
      ctx.fillStyle = '#21130f48'; ctx.fillRect(4, 4, 248, 376);
      ctx.strokeStyle = '#fff7da'; ctx.lineWidth = 22; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(48, 78); ctx.lineTo(208, 306); ctx.moveTo(208, 78); ctx.lineTo(48, 306); ctx.stroke();
      ctx.strokeStyle = '#c7372e'; ctx.lineWidth = 13; ctx.stroke();
      ctx.fillStyle = '#251914'; ctx.fillRect(22, 335, 212, 30); ctx.fillStyle = '#fff3d1'; ctx.textAlign = 'center'; ctx.font = 'bold 19px Georgia'; ctx.fillText('DEFEATED', 128, 356);
    }
    face.texture.needsUpdate = true;
  };
  base();
  const art = publicCardArtwork(card);
  if (!art) { paintStandard(ctx, card); finish(); return face; }
  // Only public faces create an artwork request. Hidden cards never reach makeFace().
  ctx.fillStyle = '#c8b794'; ctx.font = '32px Georgia'; ctx.textAlign = 'center'; ctx.fillText('✦', 128, 192); printValue(ctx, card); finish();
  const img = new Image(); face.image = img; img.decoding = 'async';
  img.onload = () => {
    if (face.cancelled) return;
    base(); const src = art.crop ?? { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
    const dst = containedImageRect(src.width, src.height, 236, 358);
    ctx.drawImage(img, src.x, src.y, src.width, src.height, 10 + dst.x, 10 + dst.y, dst.width, dst.height);
    printValue(ctx, card); finish();
  };
  img.src = art.url;
  return face;
}
function disposeFace(face: Face | null): void {
  if (!face) return; face.cancelled = true;
  if (face.image) { face.image.onload = null; face.image.onerror = null; }
  face.texture.dispose();
}

export class FrickFrackScene {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(0, 1, 1, 0, .1, 2000);
  private readonly plane = new THREE.PlaneGeometry(1, 1);
  private readonly backTexture = makeBack();
  private readonly blanketTexture = makeBlanket();
  private readonly shadowTexture = makeShadow();
  private readonly backMaterial = new THREE.MeshBasicMaterial({ map: this.backTexture, transparent: true, alphaTest: .02, toneMapped: false });
  private readonly blanketMaterial = new THREE.MeshBasicMaterial({ map: this.blanketTexture, toneMapped: false });
  private readonly blanket = new THREE.Mesh(this.plane, this.blanketMaterial);
  private readonly deck = new THREE.Group();
  private readonly cards = new Map<string, CardNode>();
  private key = '';
  private disposed = false;
  private drawCount = 0;
  private active = false;
  private width = 1;
  private height = 1;
  private panel: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private readonly raycaster = new THREE.Raycaster();
  constructor() {
    this.camera.position.z = 1000;
    this.blanket.position.z = -20; this.scene.add(this.blanket, this.deck);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(this.plane, this.backMaterial); m.position.set(i * .025, i * .023, i * .1); this.deck.add(m);
    }
  }
  /** Public-only diagnostic information; no private deck identities can enter this scene. */
  inspect(): { key: string; hidden: boolean; rotation: number; signature: string }[] {
    return [...this.cards].map(([key, node]) => ({ key, hidden: node.hidden, rotation: node.group.rotation.y, signature: node.signature }));
  }
  snapshot() {
    return { active: this.active, drawCount: this.drawCount, cardCount: this.cards.size, meshCount: 5 + this.cards.size * 3, sessionKey: this.key,
      cards: [...this.cards].map(([key, node]) => ({ key, hidden: node.hidden, defeated: node.view.defeated,
        x: node.group.position.x, y: this.height - node.group.position.y, width: node.view.rect.width, height: node.view.rect.height,
        rotationY: node.group.rotation.y, visible: node.group.visible, faceVisible: !node.hidden && Math.cos(node.group.rotation.y) > 0,
        faceUp: !node.hidden && Math.abs(node.group.rotation.y) < .01, animationProgress: node.progress,
        textureKey: node.signature })) };
  }
  /** Raycast actual engine geometry, not a second DOM hit box. */
  pick(clientX: number, clientY: number): string | null {
    if (!this.active || clientX < this.panel.x || clientY < this.panel.y || clientX > this.panel.x + this.panel.width || clientY > this.panel.y + this.panel.height) return null;
    this.camera.updateMatrixWorld(); this.scene.updateMatrixWorld(true);
    this.raycaster.setFromCamera(new THREE.Vector2(clientX / this.width * 2 - 1, 1 - clientY / this.height * 2), this.camera);
    const picks = [...this.cards].filter(([, n]) => n.group.visible).flatMap(([key, n]) => n.group.children.map(mesh => ({ key, mesh })));
    const hit = this.raycaster.intersectObjects(picks.map(p => p.mesh), false)[0];
    return hit ? picks.find(p => p.mesh === hit.object)?.key ?? null : null;
  }
  private remove(key: string, node: CardNode): void {
    this.scene.remove(node.group, node.shadow); disposeFace(node.face); node.front.material.dispose(); node.shadow.material.dispose(); this.cards.delete(key);
  }
  clear(): void { for (const [key, node] of this.cards) this.remove(key, node); this.key = ''; this.active = false; }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.clear(); this.plane.dispose();
    this.backTexture.dispose(); this.blanketTexture.dispose(); this.shadowTexture.dispose(); this.backMaterial.dispose(); this.blanketMaterial.dispose();
  }
  draw(renderer: THREE.WebGLRenderer, view: TableView, nowMs: number): void {
    if (this.disposed) return;
    if (view.sessionKey !== this.key) { this.clear(); this.key = view.sessionKey; }
    const width = renderer.domElement.clientWidth || window.innerWidth, height = renderer.domElement.clientHeight || window.innerHeight;
    this.active = true; this.width = width; this.height = height;
    this.camera.right = width; this.camera.top = height; this.camera.updateProjectionMatrix();
    const panel = view.panel; this.panel = { ...panel };
    this.blanket.position.set(panel.x + panel.width / 2, height - panel.y - panel.height / 2, -20);
    this.blanket.scale.set(panel.width, panel.height, 1); this.blanketTexture.repeat.set(panel.width / 180, panel.height / 180);
    const deckSize = Math.max(28, Math.min(52, panel.width * .07));
    const deckX = panel.x + panel.width - deckSize * .8 - 18, deckY = panel.y + 38;
    this.deck.position.set(deckX, height - deckY, 1); this.deck.scale.set(deckSize, deckSize * 1.5, 1); this.deck.rotation.z = -.10;
    const present = new Set(view.cards.map(c => c.key));
    for (const [key, node] of this.cards) if (!present.has(key)) this.remove(key, node);
    for (const item of view.cards) {
      let node = this.cards.get(item.key);
      const hidden = item.card === null, signature = faceSignature(item.card, item.defeated);
      if (!node) {
        const group = new THREE.Group();
        const front = new THREE.Mesh(this.plane, new THREE.MeshBasicMaterial({ map: this.backTexture, transparent: true, alphaTest: .02, toneMapped: false }));
        const back = new THREE.Mesh(this.plane, this.backMaterial); front.position.z = .06; back.position.z = -.06; back.rotation.y = Math.PI;
        group.add(front, back);
        const shadow = new THREE.Mesh(this.plane, new THREE.MeshBasicMaterial({ map: this.shadowTexture, transparent: true, depthWrite: false, toneMapped: false }));
        this.scene.add(group, shadow);
        node = { group, front, shadow, face: null, signature: '', hidden, born: nowMs + Math.min(3, item.order) * 32, revealOnly: false, view: item, progress: 0 };
        this.cards.set(item.key, node);
      }
      if (signature !== node.signature) {
        if (node.hidden && !hidden) { node.born = nowMs; node.revealOnly = true; }
        disposeFace(node.face); node.face = item.card ? makeFace(item.card, item.defeated) : null;
        node.front.material.map = node.face?.texture ?? this.backTexture; node.front.material.needsUpdate = true;
        node.signature = signature; node.hidden = hidden;
      }
      node.view = item;
      const motion = cardMotion(nowMs - node.born, hidden, view.reducedMotion || item.order < 0, node.revealOnly);
      node.progress = motion.progress;
      const x = deckX + (item.rect.x + item.rect.width / 2 - deckX) * motion.progress;
      const y = deckY + (item.rect.y + item.rect.height / 2 - deckY) * motion.progress;
      node.group.position.set(x, height - y + motion.lift, 10 + item.order * .15);
      node.group.scale.set(item.rect.width, item.rect.height, 1); node.group.rotation.y = motion.angle;
      node.group.rotation.z = Math.sin((item.order + 1) * 2.7) * .018 * motion.progress;
      node.shadow.position.set(x + 3 + motion.lift * .2, height - y - 5 - motion.lift * .2, 2);
      node.shadow.scale.set(item.rect.width * 1.5, item.rect.height * 1.28, 1);
      node.group.visible = item.rect.width > 0 && item.rect.height > 0; node.shadow.visible = node.group.visible;
    }
    const target = renderer.getRenderTarget();
    const viewport = renderer.getViewport(new THREE.Vector4()); const scissor = renderer.getScissor(new THREE.Vector4());
    const scissorTest = renderer.getScissorTest(), autoClear = renderer.autoClear, toneMapping = renderer.toneMapping;
    const clearColor = renderer.getClearColor(new THREE.Color()), clearAlpha = renderer.getClearAlpha();
    try {
      renderer.setRenderTarget(null); renderer.setViewport(0, 0, width, height); renderer.setScissorTest(false);
      renderer.autoClear = false; renderer.toneMapping = THREE.NoToneMapping; renderer.setClearColor('#1a302a', 1); renderer.clear(true, true, true);
      const x = Math.max(0, panel.x), y = Math.max(0, height - panel.y - panel.height);
      renderer.setScissor(x, y, Math.max(0, Math.min(width, panel.x + panel.width) - x), Math.max(0, Math.min(height, height - panel.y) - y));
      renderer.setScissorTest(true); renderer.render(this.scene, this.camera); this.drawCount++;
    } finally {
      renderer.setRenderTarget(target); renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest);
      renderer.setClearColor(clearColor, clearAlpha); renderer.autoClear = autoClear; renderer.toneMapping = toneMapping;
    }
  }
}
