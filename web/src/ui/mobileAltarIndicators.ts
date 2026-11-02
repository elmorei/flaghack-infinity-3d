/** Non-interactive bearings for live altars and the emerged boss, using the active render camera. */
import { Vector4, type Camera } from 'three';
import { BOSS_HEIGHT } from '../sim/bossDimensions';
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
  if (!Number.isFinite(inset) || right <= left || bottom <= top) return [];
  const cx = width / 2, cy = height / 2;
  const edgeWidth = right - left, edgeHeight = bottom - top;
  const perimeter = 2 * (edgeWidth + edgeHeight);
  // Clockwise arc length from the top-left corner. Keeping whole intervals (rather
  // than a pixel grid) preserves subpixel movement, including across corners.
  type Interval = [number, number];
  const edges = [
    { x: left, y: top, dx: 1, dy: 0, length: edgeWidth, start: 0 },
    { x: right, y: top, dx: 0, dy: 1, length: edgeHeight, start: edgeWidth },
    { x: right, y: bottom, dx: -1, dy: 0, length: edgeWidth, start: edgeWidth + edgeHeight },
    { x: left, y: bottom, dx: 0, dy: -1, length: edgeHeight, start: 2 * edgeWidth + edgeHeight },
  ];
  const excludeRect = (allowed: Interval[], rect: IndicatorRect): Interval[] => {
    for (const edge of edges) {
      const horizontal = edge.dx !== 0;
      const fixed = horizontal ? edge.y : edge.x;
      if (fixed < (horizontal ? rect.top : rect.left) || fixed > (horizontal ? rect.bottom : rect.right)) continue;
      const origin = horizontal ? edge.x : edge.y, direction = horizontal ? edge.dx : edge.dy;
      const a = ((horizontal ? rect.left : rect.top) - origin) / direction;
      const b = ((horizontal ? rect.right : rect.bottom) - origin) / direction;
      const lo = Math.max(0, Math.min(a, b)), hi = Math.min(edge.length, Math.max(a, b));
      if (lo > hi) continue;
      // A tiny margin keeps the closed obstacle boundary clear despite roundoff.
      const from = edge.start + lo - 1e-6, to = edge.start + hi + 1e-6;
      allowed = allowed.flatMap(([start, end]): Interval[] => {
        if (to < start || from > end) return [[start, end]];
        const remaining: Interval[] = [];
        if (from > start) remaining.push([start, from]);
        if (to < end) remaining.push([to, end]);
        return remaining;
      });
    }
    return allowed;
  };
  let allowed: Interval[] = [[0, perimeter]];
  for (const r of viewport.reserved ?? []) {
    if (![r.left, r.top, r.right, r.bottom].every(Number.isFinite)) continue;
    allowed = excludeRect(allowed, { left: r.left - 16, right: r.right + 16, top: r.top - 16, bottom: r.bottom + 16 });
  }
  const result: AltarIndicator[] = [];
  for (const t of [...targets].sort((a, b) => a.id - b.id)) {
    if (![t.x, t.y, t.z, t.w].every(Number.isFinite)) continue;
    if (t.w > 0 && Math.abs(t.x) <= t.w && Math.abs(t.y) <= t.w && t.z >= -t.w && t.z <= t.w) continue;
    let dx = t.x * width / 2, dy = -t.y * height / 2;
    // Directly behind/near the eye has no unique screen bearing; choose down, never NaN.
    if (Math.hypot(dx, dy) < 1e-8) { dx = 0; dy = 1; }
    const sx = (right - cx) / Math.abs(dx), sy = (bottom - cy) / Math.abs(dy);
    const scale = Math.min(sx, sy);
    const ideal = { x: cx + dx * scale, y: cy + dy * scale };
    const arc = sx <= sy
      ? dx > 0 ? edgeWidth + ideal.y - top : 2 * edgeWidth + edgeHeight + bottom - ideal.y
      : dy > 0 ? edgeWidth + edgeHeight + right - ideal.x : ideal.x - left;
    let bestArc: number | undefined, distance = Infinity;
    for (const [start, end] of allowed) {
      // Compare wraparound copies so crossing the top-left seam is continuous.
      for (const wanted of [arc, arc - perimeter, arc + perimeter]) {
        const candidate = Math.max(start, Math.min(end, wanted));
        const d = Math.abs(candidate - wanted);
        if (d < distance) { bestArc = candidate; distance = d; }
      }
    }
    if (bestArc === undefined) continue;
    const edge = edges.find(e => bestArc! <= e.start + e.length) ?? edges[3];
    const along = bestArc - edge.start;
    const point = { x: edge.x + edge.dx * along, y: edge.y + edge.dy * along };
    result.push({ ...point, id: t.id, color: t.color, angle: Math.atan2(dy, dx) });
    // Preserve the native-verified clearance for the full rotated SVG footprint.
    allowed = excludeRect(allowed, { left: point.x - 32, right: point.x + 32, top: point.y - 32, bottom: point.y + 32 });
  }
  return result;
}

/** Ownership comes from the live building, not the faction's potentially stale hearthIds. */
export function liveAltars(world: World): Building[] {
  return [...world.buildings.values()].filter(b => b.kind === 'hearth' && !!b.hearth &&
    b.hp > 0 && b.faction !== -1 && !!world.factions[b.faction]?.alive);
}

/** An unrevealed, dying or removed boss never advertises a hidden target. */
export function emergedBoss(world: World) {
  const boss = world.boss;
  return boss && world.effigyRevealedAt != null && world.time >= world.effigyRevealedAt &&
    world.time >= boss.spawnedAt && boss.hp > 0 && boss.deathAt === null &&
    boss.action !== 'death' && boss.action !== 'dead' ? boss : null;
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
    const targets = liveAltars(world).map(b => {
      this.clip.set(b.pos.x, buildingBaseHeight(world, b), b.pos.z, 1)
        .applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
      return { id: b.id, kind: 'altar' as 'altar' | 'boss', own: b.faction === player, color: world.factions[b.faction as 0 | 1 | 2 | 3].css,
        x: this.clip.x, y: this.clip.y, z: this.clip.z, w: this.clip.w };
    });
    const boss = emergedBoss(world);
    if (boss) {
      // Aim at the visible body's center rather than the terrain below a 32m figure.
      this.clip.set(boss.pos.x, world.collision.groundHeight(boss.pos.x, boss.pos.z) + BOSS_HEIGHT / 2, boss.pos.z, 1)
        .applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
      targets.push({ id: boss.id, kind: 'boss', own: false, color: '#fff0d0',
        x: this.clip.x, y: this.clip.y, z: this.clip.z, w: this.clip.w });
    }
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
      const target = targets.find(t => t.id === i.id)!;
      if (target.kind === 'altar' && arrow.dataset.bossId) {
        delete arrow.dataset.bossId; arrow.dataset.altarId = String(i.id);
        arrow.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M19 11 4 3 7 11 4 19Z" fill="currentColor" stroke="#111923" stroke-width="2" stroke-linejoin="round"/></svg>';
      }
      arrow.dataset.targetKind = target.kind;
      arrow.dataset.allegiance = target.kind === 'boss' ? 'boss' : target.own ? 'own' : 'enemy';
      if (target.kind === 'boss' && !arrow.dataset.bossId) {
        delete arrow.dataset.altarId;
        arrow.dataset.bossId = String(i.id);
        // Double chevron with a bright core distinguishes the Effigy from camp colors.
        arrow.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M20 11 11 2 2 2 8 11 2 20 11 20Z" fill="currentColor" stroke="#211019" stroke-width="2" stroke-linejoin="round"/><path d="M10 6 15 11 10 16" fill="none" stroke="#b3284f" stroke-width="2"/></svg>';
      }
      arrow.style.color = i.color;
      arrow.style.left = `${i.x}px`; arrow.style.top = `${i.y}px`;
      arrow.style.transform = `translate(-50%, -50%) rotate(${i.angle}rad)`;
    }
  }

  hide(): void { this.root.style.display = 'none'; }
  dispose(): void { this.root.remove(); this.arrows.clear(); }
}
