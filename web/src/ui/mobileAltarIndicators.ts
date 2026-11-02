/** Non-interactive bearings for physical enemy altars, using the active render camera. */
import { Vector4, type Camera } from 'three';
import { buildingBaseHeight } from '../sim/buildingGeometry';
import type { Building } from '../sim/types';
import type { World } from '../sim/world';

export interface IndicatorRect { left: number; top: number; right: number; bottom: number }
export interface IndicatorViewport {
  width: number;
  height: number;
  /** Viewport-relative HUD rectangles. Arrow footprints are padded automatically. */
  reserved?: readonly IndicatorRect[];
  inset?: number;
}
export interface AltarClipTarget { id: number; color: string; x: number; y: number; z: number; w: number }
export interface AltarIndicator { id: number; color: string; x: number; y: number; angle: number }

/** Pure clip-space layout. No division by w: behind-camera targets keep the correct bearing. */
export function layoutAltarIndicators(targets: readonly AltarClipTarget[], viewport: IndicatorViewport): AltarIndicator[] {
  const { width, height } = viewport;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 64 || height < 64) return [];
  const inset = Math.max(16, viewport.inset ?? 20);
  const left = inset, right = width - inset, top = inset, bottom = height - inset;
  if (right <= left || bottom <= top) return [];
  const cx = width / 2, cy = height / 2;
  const result: AltarIndicator[] = [];
  // A sampled perimeter gives stable, deterministic separation, including around corners.
  const candidates: { x: number; y: number }[] = [];
  const addEdge = (x1: number, y1: number, x2: number, y2: number) => {
    const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 6);
    for (let i = 0; i < steps; i++) candidates.push({ x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps });
  };
  addEdge(left, top, right, top); addEdge(right, top, right, bottom);
  addEdge(right, bottom, left, bottom); addEdge(left, bottom, left, top);
  const allowed = candidates.filter(p => !(viewport.reserved ?? []).some(r =>
    p.x >= r.left - 16 && p.x <= r.right + 16 && p.y >= r.top - 16 && p.y <= r.bottom + 16));
  for (const t of [...targets].sort((a, b) => a.id - b.id)) {
    if (![t.x, t.y, t.z, t.w].every(Number.isFinite)) continue;
    if (t.w > 0 && Math.abs(t.x) <= t.w && Math.abs(t.y) <= t.w && t.z >= -t.w && t.z <= t.w) continue;
    let dx = t.x * width / 2, dy = -t.y * height / 2;
    // Directly behind/near the eye has no unique screen bearing; choose down, never NaN.
    if (Math.hypot(dx, dy) < 1e-8) { dx = 0; dy = 1; }
    const scale = Math.min((right - cx) / Math.abs(dx), (bottom - cy) / Math.abs(dy));
    const ideal = { x: cx + dx * scale, y: cy + dy * scale };
    let best: { x: number; y: number } | undefined, distance = Infinity;
    for (const p of allowed) {
      if (result.some(other => Math.abs(p.x - other.x) < 32 && Math.abs(p.y - other.y) < 32)) continue;
      const d = (p.x - ideal.x) ** 2 + (p.y - ideal.y) ** 2;
      if (d < distance) { best = p; distance = d; }
    }
    if (best) result.push({ ...best, id: t.id, color: t.color, angle: Math.atan2(dy, dx) });
  }
  return result;
}

/** Ownership comes from the live building, not the faction's potentially stale hearthIds. */
export function enemyAltars(world: World, player: number): Building[] {
  return [...world.buildings.values()].filter(b => b.kind === 'hearth' && !!b.hearth &&
    b.hp > 0 && b.faction !== -1 && b.faction !== player && !!world.factions[b.faction]?.alive);
}

export class MobileAltarIndicators {
  private root: HTMLDivElement;
  private arrows = new Map<number, HTMLSpanElement>();
  private clip = new Vector4();

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'mc-altar-indicators';
    this.root.setAttribute('aria-hidden', 'true');
    Object.assign(this.root.style, { position: 'fixed', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
    parent.appendChild(this.root);
  }

  update(world: World, camera: Camera, player: number, viewport: IndicatorViewport): void {
    // Controls can have moved the camera since its last render.
    camera.updateMatrixWorld();
    const targets = enemyAltars(world, player).map(b => {
      this.clip.set(b.pos.x, buildingBaseHeight(world, b), b.pos.z, 1)
        .applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
      return { id: b.id, color: world.factions[b.faction as 0 | 1 | 2 | 3].css,
        x: this.clip.x, y: this.clip.y, z: this.clip.z, w: this.clip.w };
    });
    const indicators = layoutAltarIndicators(targets, viewport);
    this.root.style.display = '';
    const active = new Set(indicators.map(i => i.id));
    for (const [id, arrow] of this.arrows) if (!active.has(id)) { arrow.remove(); this.arrows.delete(id); }
    for (const i of indicators) {
      let arrow = this.arrows.get(i.id);
      if (!arrow) {
        arrow = document.createElement('span');
        arrow.className = 'mc-altar-arrow';
        arrow.dataset.altarId = String(i.id);
        arrow.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M19 11 4 3 7 11 4 19Z" fill="currentColor" stroke="#111923" stroke-width="2" stroke-linejoin="round"/></svg>';
        Object.assign(arrow.style, { position: 'absolute', width: '22px', height: '22px', pointerEvents: 'none', filter: 'drop-shadow(0 1px 2px #000)' });
        this.root.appendChild(arrow); this.arrows.set(i.id, arrow);
      }
      arrow.style.color = i.color;
      arrow.style.left = `${i.x}px`; arrow.style.top = `${i.y}px`;
      arrow.style.transform = `translate(-50%, -50%) rotate(${i.angle}rad)`;
    }
  }

  hide(): void { this.root.style.display = 'none'; }
  dispose(): void { this.root.remove(); this.arrows.clear(); }
}
