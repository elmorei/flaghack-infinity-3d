/** Mobile presentation is selected before boot; safe in node tests and desktop bundles. */
export function isMobileCommandLayout(): boolean {
  return typeof document !== 'undefined' && document.documentElement?.dataset?.deviceLayout === 'mobile';
}
export const MOBILE_LONG_PRESS_MS = 550;
export const MOBILE_DRAG_PX = 10;
export interface MobileTouchAction { kind: 'tap' | 'hold' | 'drag'; x: number; y: number; startX: number; startY: number }
/** Pure single-finger recognizer. A second finger poisons the whole gesture until all lift. */
export class MobileTouch {
  enabled = false;
  private pointers = new Set<number>();
  private id = -1;
  private at = 0;
  private blocked = false;
  private held = false;
  dragging = false;
  x = 0; y = 0; startX = 0; startY = 0;
  dx = 0; dy = 0;
  action: MobileTouchAction | null = null;
  get active(): boolean { return this.pointers.size > 0; }
  down(id: number, x: number, y: number, now: number): void {
    if (!this.enabled) return;
    this.pointers.add(id);
    if (this.pointers.size !== 1 || this.blocked) { this.blocked = true; this.action = null; this.dx = this.dy = 0; return; }
    this.id = id; this.x = this.startX = x; this.y = this.startY = y;
    this.at = now; this.held = this.dragging = false; this.action = null;
  }
  move(id: number, x: number, y: number): void {
    if (this.blocked || id !== this.id || !this.pointers.has(id)) return;
    const oldX = this.x, oldY = this.y;
    this.x = x; this.y = y;
    if (Math.hypot(x - this.startX, y - this.startY) >= MOBILE_DRAG_PX) this.dragging = true;
    if (this.dragging && !this.held) { this.dx += x - oldX; this.dy += y - oldY; }
  }
  poll(now: number): void {
    if (!this.blocked && this.active && !this.dragging && !this.held && now - this.at >= MOBILE_LONG_PRESS_MS) {
      this.held = true; this.action = this.make('hold');
    }
  }
  up(id: number, x: number, y: number): void {
    if (!this.pointers.has(id)) return;
    this.move(id, x, y);
    if (!this.blocked && id === this.id && !this.held) this.action = this.make(this.dragging ? 'drag' : 'tap');
    this.pointers.delete(id);
    if (!this.active) { this.id = -1; this.blocked = false; this.dragging = false; }
  }
  private make(kind: MobileTouchAction['kind']): MobileTouchAction { return { kind, x: this.x, y: this.y, startX: this.startX, startY: this.startY }; }
  cancel(): void { this.pointers.clear(); this.id = -1; this.blocked = this.held = this.dragging = false; this.endFrame(); }
  endFrame(): void { this.action = null; this.dx = this.dy = 0; }
}
