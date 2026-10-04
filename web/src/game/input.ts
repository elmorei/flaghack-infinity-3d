import { defaultControls, stick } from './bindings';
import type { ControlSettings } from './bindings';
/**
 * Raw browser input for the game canvas: held/pressed keys (KeyboardEvent.code), mouse buttons
 * with press positions, pointer-lock movement, wheel and cursor position. Edge flags (pressed /
 * released) accumulate between frames and are consumed by `endFrame()`, so a tap shorter than a
 * frame is never lost. Keys typed into form fields never reach the game, and only presses that
 * start on the canvas count (UI widgets keep their own clicks).
 */

export const LMB = 0;
export const MMB = 1;
export const RMB = 2;

/** Pointer-lock movement spikes larger than this are browser glitches (lock engage), not input. */
const MAX_MOVE_EVENT = 300;

function isTypingTarget(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    (t instanceof HTMLElement && t.isContentEditable)
  );
}

export class Input {
  readonly canvas: HTMLCanvasElement;
  /** Physical keys currently held. */
  private held = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  /** Mouse buttons held (only presses that began on the canvas). */
  private mouseButtons = [false, false, false];
  get buttons(): boolean[] {
    return [0, 1, 2].map((b) => this.isDown(`Mouse${b}`));
  }
  controls: ControlSettings = defaultControls();
  private padHeld = new Set<string>();
  private padPressed = new Set<string>();
  private padReleased = new Set<string>();
  moveX = 0;
  moveY = 0;
  gamepadActive = false;
  private focused = true;
  onMenuBack: (() => void) | null = null;
  private menuButtons = new Set<number>();
  private navigateMenu(pad: Gamepad | undefined): void {
    const next = new Set<number>();
    if (pad && this.focused)
      pad.buttons.forEach((b, i) => {
        if (b.pressed) next.add(i);
      });
    const pressed = (i: number) => next.has(i) && !this.menuButtons.has(i);
    const elements = Array.from(document.querySelectorAll<HTMLElement>('button,input,select,summary,a[href]')).filter(
      (e) => e.getClientRects().length > 0 && !(e as HTMLButtonElement).disabled && !e.closest('[inert]'),
    );
    if (pressed(13) || pressed(12)) {
      const direction = pressed(13) ? 1 : -1;
      const current = elements.indexOf(document.activeElement as HTMLElement);
      elements[(current + direction + elements.length) % elements.length]?.focus();
    }
    const selected = document.activeElement;
    if (selected instanceof HTMLSelectElement && (pressed(14) || pressed(15))) {
      selected.selectedIndex = Math.max(
        0,
        Math.min(selected.options.length - 1, selected.selectedIndex + (pressed(15) ? 1 : -1)),
      );
      selected.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (pressed(0)) {
      if (selected instanceof HTMLElement && elements.includes(selected)) selected.click();
      else elements[0]?.focus();
    }
    if (pressed(1) || pressed(9)) {
      const unhandled = window.dispatchEvent(new Event('fh-menu-back', { cancelable: true }));
      if (unhandled) this.onMenuBack?.();
    }
    this.menuButtons = next;
  }
  private physical(code: string, edge: number): boolean {
    if (code.startsWith('Mouse')) {
      const b = Number(code.slice(5));
      return edge === 0 ? this.mouseButtons[b] : edge === 1 ? this.btnPressed[b] : this.btnReleased[b];
    }
    return (
      (edge === 0 ? this.held : edge === 1 ? this.pressed : this.released).has(code) ||
      (edge === 0 ? this.padHeld : edge === 1 ? this.padPressed : this.padReleased).has(code)
    );
  }
  private mapped(code: string, edge: number): boolean {
    return (this.controls.bindings[code] ?? [code]).some((k) => this.physical(k, edge));
  }
  owns(code: string): boolean {
    return code === 'Escape' || Object.values(this.controls.bindings).some((list) => list.includes(code));
  }
  pollGamepad(dt: number, enabled: boolean, cursor: boolean): void {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = Array.from(pads).find((p) => p?.connected && p.mapping === 'standard');
    const next = new Set<string>();
    this.moveX = this.moveY = 0;
    if (!enabled) this.navigateMenu(pad ?? undefined);
    else this.menuButtons = new Set(pad?.buttons.flatMap((b, i) => (b.pressed ? [i] : [])) ?? []);
    this.gamepadActive = !!pad && enabled && this.focused;
    if (this.gamepadActive && pad) {
      pad.buttons.forEach((b, i) => {
        if (b.pressed || b.value > 0.55) next.add(`Pad${i}`);
      });
      const swap = this.controls.swapSticks ? 2 : 0,
        look = this.controls.swapSticks ? 0 : 2;
      [this.moveX, this.moveY] = stick(pad.axes[swap] ?? 0, pad.axes[swap + 1] ?? 0, this.controls.deadzone);
      const [x, y] = stick(pad.axes[look] ?? 0, pad.axes[look + 1] ?? 0, this.controls.deadzone);
      if (cursor) {
        this.mx = Math.max(0, Math.min(this.width, this.mx + x * 700 * dt));
        this.my = Math.max(0, Math.min(this.height, this.my + y * 700 * dt));
        this.hasCursor = true;
      } else {
        this.dx += x * 700 * dt * this.controls.lookSpeed;
        this.dy += y * 700 * dt * this.controls.lookSpeed * (this.controls.invertPadY ? -1 : 1);
      }
    }
    for (const k of next) if (!this.padHeld.has(k)) this.padPressed.add(k);
    for (const k of this.padHeld) if (!next.has(k)) this.padReleased.add(k);
    this.padHeld = next;
    for (let b = 0; b < 3; b++)
      if (this.buttonPressed(b) && !this.btnPressed[b]) {
        this.downX[b] = this.mx;
        this.downY[b] = this.my;
      }
  }
  private btnPressed = [false, false, false];
  private btnReleased = [false, false, false];
  /** Cursor position (canvas CSS px) at the latest press of each button. */
  readonly downX = [0, 0, 0];
  readonly downY = [0, 0, 0];
  /** Look movement accumulated since the last frame (CSS px). */
  dx = 0;
  dy = 0;
  /** Wheel accumulated since the last frame (pixels; + = away from the screen top / zoom out). */
  wheel = 0;
  /** Cursor position in canvas CSS px. */
  mx = 0;
  my = 0;
  /** The cursor is over the page (edge-pan only while true). */
  hasCursor = false;
  locked = false;
  /** Pointer lock failed without ever succeeding (headless / sandboxed frame): mouse-look follows the cursor. */
  lockUnavailable = false;
  /**
   * Canvas CSS box (px), refreshed only by a ResizeObserver and window resize: reading layout
   * every frame while the HUD rewrites the DOM would force a synchronous reflow.
   */
  width = 1;
  height = 1;
  private left = 0;
  private top = 0;
  private cursorStyle = '';
  private resizer: ResizeObserver;
  /** Decides whether a key belongs to the game right now (preventDefault + recorded). */
  capturesKey: (code: string) => boolean = () => false;
  /** Pointer lock lost by the user (Esc, alt-tab), not by `exitLock()`. */
  onLockLost: (() => void) | null = null;
  /** Mousedown on the canvas; return true to consume it (e.g. the click that grabs the pointer). */
  onCanvasDown: ((button: number) => boolean) | null = null;
  /** Keydown hook that runs inside the user gesture (pointer lock can only be requested there). */
  onKeyGesture: ((code: string) => void) | null = null;

  private lockEverWorked = false;
  private expectUnlock = false;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.resizer = new ResizeObserver(this.measure);
    this.resizer.observe(canvas);
    window.addEventListener('resize', this.measure);
    this.measure();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('focus', this.onFocus);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    document.addEventListener('mouseleave', this.onMouseLeave);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('pointerlockerror', this.onLockError);
    canvas.addEventListener('mousedown', this.onMouseDown);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  isDown(code: string): boolean {
    return this.mapped(code, 0);
  }

  wasPressed(code: string): boolean {
    return this.mapped(code, 1);
  }

  wasReleased(code: string): boolean {
    return !this.mapped(code, 0) && this.mapped(code, 2);
  }

  /** Mark a press as handled so later handlers this frame ignore it. */
  consume(code: string): void {
    for (const k of this.controls.bindings[code] ?? [code]) {
      this.pressed.delete(k);
      this.padPressed.delete(k);
    }
  }

  get shift(): boolean {
    return this.isDown('ShiftLeft');
  }

  get ctrl(): boolean {
    return this.isDown('ControlLeft');
  }

  /** A text field (chat, forms) has the keyboard: the game keeps its hands off. */
  get typing(): boolean {
    return isTypingTarget(document.activeElement);
  }

  buttonPressed(b: number): boolean {
    return this.mapped(`Mouse${b}`, 1);
  }

  buttonReleased(b: number): boolean {
    return this.mapped(`Mouse${b}`, 2);
  }

  /** Squared cursor travel since the latest press of button b. */
  dragDist2(b: number): number {
    const dx = this.mx - this.downX[b];
    const dy = this.my - this.downY[b];
    return dx * dx + dy * dy;
  }

  requestLock(): void {
    if (this.locked || this.disposed || document.pointerLockElement === this.canvas) return;
    // Outside a user gesture (an online match starting from a host message) the browser refuses
    // the lock; that must not read as "pointer lock unavailable" here, so wait for the next click.
    const activation = navigator.userActivation;
    if (activation && !activation.isActive) return;
    try {
      const result: unknown = this.canvas.requestPointerLock();
      if (result instanceof Promise) result.catch(() => this.lockFailed());
    } catch {
      this.lockFailed();
    }
  }

  exitLock(): void {
    if (document.pointerLockElement !== this.canvas) return;
    this.expectUnlock = true;
    document.exitPointerLock();
  }

  /** Forget every held key/button (focus loss, pause, view switch). */
  clear(): void {
    for (const code of this.held) this.released.add(code);
    this.held.clear();
    this.padHeld.clear();
    this.padPressed.clear();
    this.moveX = this.moveY = 0;
    for (let b = 0; b < 3; b++) {
      if (this.buttons[b]) this.btnReleased[b] = true;
      this.mouseButtons[b] = false;
    }
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
  }

  /** Consume this frame's edges and deltas. */
  endFrame(): void {
    this.pressed.clear();
    this.padPressed.clear();
    this.padReleased.clear();
    this.released.clear();
    for (let b = 0; b < 3; b++) {
      this.btnPressed[b] = false;
      this.btnReleased[b] = false;
    }
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.exitLock();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('focus', this.onFocus);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    document.removeEventListener('mouseleave', this.onMouseLeave);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('pointerlockerror', this.onLockError);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.resizer.disconnect();
    window.removeEventListener('resize', this.measure);
    this.setCursor('');
  }

  /** Set the canvas cursor, touching the DOM only when it changes. */
  setCursor(cursor: string): void {
    if (cursor === this.cursorStyle) return;
    this.cursorStyle = cursor;
    this.canvas.style.cursor = cursor;
  }

  /** ResizeObserver callbacks run after layout, so this read never forces a reflow there. */
  private measure = (): void => {
    const r = this.canvas.getBoundingClientRect();
    this.left = r.left;
    this.top = r.top;
    this.width = r.width || 1;
    this.height = r.height || 1;
  };

  private lockFailed(): void {
    if (!this.lockEverWorked) this.lockUnavailable = true;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (isTypingTarget(e.target)) return;
    // Browser/OS chords (reload, devtools, copy) are never game input.
    if (e.altKey || ((e.ctrlKey || e.metaKey) && !e.code.startsWith('Control') && !e.code.startsWith('Meta'))) return;
    if (!this.capturesKey(e.code)) return;
    if (e.code !== 'Escape') e.preventDefault();
    if (e.repeat) return;
    this.held.add(e.code);
    this.pressed.add(e.code);
    const virtual =
      Object.keys(this.controls.bindings).find((k) => this.controls.bindings[k].includes(e.code)) ?? e.code;
    this.onKeyGesture?.(virtual);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (!this.held.has(e.code)) return;
    this.held.delete(e.code);
    this.released.add(e.code);
  };

  private onBlur = (): void => {
    this.focused = false;
    this.clear();
  };
  private onFocus = (): void => {
    this.focused = true;
  };

  private updateCursor(e: MouseEvent): void {
    this.mx = e.clientX - this.left;
    this.my = e.clientY - this.top;
    this.hasCursor = true;
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (this.locked || this.lockUnavailable) {
      if (Math.abs(e.movementX) < MAX_MOVE_EVENT && Math.abs(e.movementY) < MAX_MOVE_EVENT) {
        this.dx += e.movementX;
        this.dy += e.movementY;
      }
    }
    if (!this.locked) this.updateCursor(e);
  };

  private onMouseLeave = (): void => {
    this.hasCursor = false;
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button > 2) return;
    if (!this.locked) this.updateCursor(e);
    if (e.button === MMB) e.preventDefault(); // no autoscroll
    if (this.onCanvasDown?.(e.button)) return;
    this.mouseButtons[e.button] = true;
    this.btnPressed[e.button] = true;
    this.downX[e.button] = this.mx;
    this.downY[e.button] = this.my;
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button > 2 || !this.mouseButtons[e.button]) return;
    this.mouseButtons[e.button] = false;
    this.btnReleased[e.button] = true;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    this.wheel += e.deltaY * scale;
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private onLockChange = (): void => {
    const locked = document.pointerLockElement === this.canvas;
    this.locked = locked;
    if (locked) {
      this.lockEverWorked = true;
      this.lockUnavailable = false;
      return;
    }
    if (this.expectUnlock) {
      this.expectUnlock = false;
      return;
    }
    this.clear();
    this.onLockLost?.();
  };

  private onLockError = (): void => {
    this.lockFailed();
  };
}
