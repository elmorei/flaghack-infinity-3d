import { describe, expect, it } from 'vitest';
import { MobileTouch, MOBILE_LONG_PRESS_MS } from './mobileTouch';
const make = () => { const t = new MobileTouch(); t.enabled = true; return t; };
describe('mobile single-finger gesture lifecycle', () => {
  it('emits one tap on release, never on press', () => {
    const t = make(); t.down(1,20,30,0); expect(t.action).toBeNull(); t.up(1,23,32);
    expect(t.action?.kind).toBe('tap'); t.endFrame(); t.up(1,23,32); expect(t.action).toBeNull();
  });
  it('small jitter stays a tap but a drag never taps or holds', () => {
    const t = make(); t.down(1,20,30,0); t.move(1,60,70); t.poll(2000);
    expect(t.action).toBeNull(); expect(t.dx).toBe(40); expect(t.dy).toBe(40);
    t.up(1,60,70); expect(t.action?.kind).toBe('drag');
  });
  it('long press fires once and release never emits another action', () => {
    const t = make(); t.down(1,20,30,0); t.poll(MOBILE_LONG_PRESS_MS - 1); expect(t.action).toBeNull();
    t.poll(MOBILE_LONG_PRESS_MS); expect(t.action?.kind).toBe('hold'); t.endFrame();
    t.poll(3000); t.up(1,20,30); expect(t.action).toBeNull();
  });
  it('second finger poisons all pending actions until every finger lifts', () => {
    const t = make(); t.down(1,20,30,0); t.down(2,50,60,100); t.move(1,200,300); t.poll(2000);
    t.up(2,50,60); t.poll(3000); t.up(1,200,300); expect(t.action).toBeNull(); expect(t.dx).toBe(0);
    t.down(3,20,30,4000); t.up(3,20,30); expect(t.action?.kind).toBe('tap');
  });
  it('cancel drops pending tap, hold and pan state; stale release is ignored', () => {
    for (const kind of ['tap','hold','pan']) {
      const t = make(); t.down(1,20,30,0);
      if (kind === 'hold') t.poll(2000); if (kind === 'pan') t.move(1,200,300); if (kind === 'tap') t.up(1,20,30);
      t.cancel(); t.up(1,200,300); t.poll(3000);
      expect(t.action).toBeNull(); expect(t.active).toBe(false); expect(t.dx).toBe(0); expect(t.dragging).toBe(false);
    }
  });
  it('does not begin gestures when disabled', () => {
    const t = new MobileTouch(); t.down(1,20,30,0); t.poll(2000); t.up(1,20,30); expect(t.active).toBe(false); expect(t.action).toBeNull();
  });
});
