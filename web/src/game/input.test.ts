import { afterEach, describe, expect, it, vi } from 'vitest';
import { Input } from './input';
import { Controls } from './controls';
import { Session } from './session';
import type { AppApi } from './app';
import { newMatch, placeAvatar } from '../sim/systems/econ/testkit';
import { defaultControls } from './bindings';
function setup() {
  const listeners = new Map<string, (e: any) => void>();
  class Element {
    isContentEditable = false;
  }
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('HTMLInputElement', class extends Element {});
  vi.stubGlobal('HTMLTextAreaElement', class extends Element {});
  vi.stubGlobal('HTMLSelectElement', class extends Element {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('window', {
    addEventListener: (n: string, f: any) => listeners.set(n, f),
    removeEventListener: () => {},
  });
  vi.stubGlobal('document', {
    activeElement: null,
    pointerLockElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: () => [],
  });
  let pad: any = {
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
  vi.stubGlobal('navigator', { getGamepads: () => (pad ? [pad] : []) });
  const canvas = {
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    addEventListener: (n: string, f: any) => listeners.set(n, f),
    removeEventListener: () => {},
  };
  const input = new Input(canvas as unknown as HTMLCanvasElement);
  input.capturesKey = () => true;
  return {
    input,
    pad,
    listeners,
    disconnect: () => {
      pad = null;
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
describe('mapped input and gamepad lifecycle', () => {
  it.each([false, true])('keeps mouse inversion independent with gamepad inversion %s', (invertPadY) => {
    const { input, pad, listeners } = setup();
    input.controls.invertPadY = invertPadY;
    input.locked = true;
    pad.axes[3] = 1;
    input.pollGamepad(1 / 60, true, false);
    const gamepadY = input.lookY(false);
    expect(Math.sign(gamepadY)).toBe(invertPadY ? -1 : 1);
    expect(input.lookY(true)).toBe(gamepadY);

    // Both devices move in the same frame: only the mouse contribution changes sign.
    listeners.get('mousemove')!({ movementX: 0, movementY: 10 });
    expect(input.lookY(false)).toBeCloseTo(gamepadY + 10);
    expect(input.lookY(true)).toBeCloseTo(gamepadY - 10);
    input.endFrame();
    expect(input.lookY(false)).toBe(0);

    // A neutral stick never changes the mouse's direction.
    pad.axes[3] = 0;
    listeners.get('mousemove')!({ movementX: 0, movementY: 10 });
    input.pollGamepad(1 / 60, true, false);
    expect(input.lookY(false)).toBe(10);
    expect(input.lookY(true)).toBe(-10);
    input.clear();
    expect(input.lookY(false)).toBe(0);
  });

  it('clears vertical gamepad look on focus loss and does not invert the command cursor', () => {
    const { input, pad, listeners } = setup();
    input.controls.invertPadY = true;
    pad.axes[3] = 1;
    input.pollGamepad(1 / 60, true, false);
    expect(input.lookY(false)).toBeLessThan(0);
    listeners.get('blur')!({});
    expect(input.lookY(false)).toBe(0);
    listeners.get('focus')!({});
    input.my = 300;
    input.pollGamepad(0.1, true, true);
    expect(input.my).toBe(370);
    expect(input.lookY(false)).toBe(0);
  });

  it('polls analog movement and turns controller buttons into action edges', () => {
    const { input, pad } = setup();
    pad.axes = [0.6, -0.4, 0.5, 0];
    pad.buttons[0].pressed = true;
    input.pollGamepad(1 / 60, true, false);
    expect(input.moveX).toBeGreaterThan(0);
    expect(input.moveY).toBeLessThan(0);
    expect(input.wasPressed('Space')).toBe(true);
    expect(input.dx).toBeGreaterThan(0);
    input.endFrame();
    input.pollGamepad(1 / 60, true, false);
    expect(input.wasPressed('Space')).toBe(false);
    expect(input.isDown('Space')).toBe(true);
    pad.buttons[0].pressed = false;
    input.pollGamepad(1 / 60, true, false);
    expect(input.wasReleased('Space')).toBe(true);
  });
  it('stops held movement and buttons on disconnect and blur', () => {
    const { input, pad, disconnect, listeners } = setup();
    pad.axes[0] = 1;
    pad.buttons[7].pressed = true;
    input.pollGamepad(1 / 60, true, false);
    expect(input.buttons[0]).toBe(true);
    listeners.get('blur')!({});
    input.pollGamepad(1 / 60, true, false);
    expect(input.buttons[0]).toBe(false);
    expect(input.moveX).toBe(0);
    listeners.get('focus')!({});
    disconnect();
    input.pollGamepad(1 / 60, true, false);
    expect(input.gamepadActive).toBe(false);
  });
  it('rebinds physical keyboard keys and mouse buttons to gameplay actions', () => {
    const { input, listeners } = setup();
    input.controls = defaultControls();
    input.controls.bindings.KeyW = ['KeyI'];
    input.controls.bindings.Mouse0 = ['KeyO'];
    const event = (code: string) => ({
      code,
      target: null,
      preventDefault: () => {},
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      repeat: false,
    });
    listeners.get('keydown')!(event('KeyI'));
    listeners.get('keydown')!(event('KeyO'));
    expect(input.isDown('KeyW')).toBe(true);
    expect(input.buttons[0]).toBe(true);
    expect(input.buttonPressed(0)).toBe(true);
    listeners.get('keyup')!(event('KeyO'));
    expect(input.buttonReleased(0)).toBe(true);
  });
  it('moves the command cursor with the look stick', () => {
    const { input, pad } = setup();
    input.mx = 400;
    input.my = 300;
    pad.axes[2] = 1;
    input.pollGamepad(0.1, true, true);
    expect(input.mx).toBe(470);
    expect(input.dx).toBe(0);
  });
});

// Exercise mapped device input through real controls handlers without a renderer loop.
describe('Command View access and GCC interaction', () => {
  function controlsSetup() {
    const fixture = setup();
    const session = new Session();
    session.screen = 'playing';
    const { world } = newMatch();
    const controls = new Controls({ session, world } as AppApi, fixture.input.canvas);
    const handlers = controls as any;
    const input = handlers.input as Input;
    const avatar = world.avatarOf(0);
    const cart = world.gccOf(0)!;
    placeAvatar(world, 0, cart.pos.x + 3, cart.pos.z);
    session.hover.entity = cart.id;
    const key = (type: string, code: string) => fixture.listeners.get(type)!({
      code, target: null, preventDefault() {}, altKey: false, ctrlKey: false, metaKey: false, repeat: false,
    });
    return { ...fixture, session, world, handlers, input, avatar, cart, key };
  }

  it.each(['keyboard', 'gamepad'])('does not open the map when %s interact is tapped at the cart', (device) => {
    const { session, world, handlers, input, avatar, pad, key } = controlsSetup();
    handlers.resolveContext(world, session, avatar);
    expect(handlers.ctxKind).toBe('gcc');
    expect(handlers.actionPrompt(world, session, avatar, false)).toBe('Hold E  Push');
    for (let tap = 0; tap < 2; tap++) {
      if (device === 'keyboard') key('keydown', 'KeyE');
      else { pad.buttons[2].pressed = true; input.pollGamepad(0.016, true, false); }
      handlers.contextKey(world, session, avatar, 0.016);
      input.endFrame();
      if (device === 'keyboard') key('keyup', 'KeyE');
      else { pad.buttons[2].pressed = false; input.pollGamepad(0.016, true, false); }
      handlers.contextKey(world, session, avatar, 0.016);
      input.endFrame();
      expect(session.view).toBe('action');
      expect(handlers.queue).toEqual([]);
    }
  });

  it('preserves hold-to-push and tap-to-release at the cart', () => {
    const { session, world, handlers, input, avatar, key } = controlsSetup();
    handlers.resolveContext(world, session, avatar);
    key('keydown', 'KeyE');
    handlers.contextKey(world, session, avatar, 0);
    input.endFrame();
    handlers.contextKey(world, session, avatar, 0.41);
    handlers.contextKey(world, session, avatar, 0.41);
    expect(handlers.queue).toEqual([{ t: 'pushGcc', faction: 0, on: true }]);
    key('keyup', 'KeyE');
    handlers.contextKey(world, session, avatar, 0);
    input.endFrame();
    avatar.pushing = world.gccOf(0)!.id;
    handlers.resolveContext(world, session, avatar);
    expect(handlers.actionPrompt(world, session, avatar, false)).toBe('E  Release the Command Center');
    key('keydown', 'KeyE');
    handlers.contextKey(world, session, avatar, 0);
    expect(handlers.queue.at(-1)).toEqual({ t: 'pushGcc', faction: 0, on: false });
    expect(session.view).toBe('action');
  });

  it.each(['keyboard', 'gamepad', 'custom keyboard', 'custom gamepad'])('keeps %s map toggling global, including without a cart', (device) => {
    const { session, world, handlers, input, avatar, cart, pad, key } = controlsSetup();
    world.buildings.delete(cart.id);
    const custom = device.startsWith('custom');
    const gamepad = device.includes('gamepad');
    const physical = custom ? (gamepad ? 'Pad3' : 'KeyM') : (gamepad ? 'Pad8' : 'Tab');
    if (custom) input.controls.bindings.Tab = [physical];
    for (const expected of ['command', 'action', 'command', 'action']) {
      if (gamepad) { pad.buttons[Number(physical.slice(3))].pressed = true; input.pollGamepad(0.016, true, session.view === 'command'); }
      else key('keydown', physical);
      handlers.toggles(world, session, avatar, false);
      expect(session.view).toBe(expected);
      expect(session.camera.cmdX).toBe(avatar.pos.x);
      expect(session.camera.cmdZ).toBe(avatar.pos.z);
      input.endFrame();
      if (gamepad) { pad.buttons[Number(physical.slice(3))].pressed = false; input.pollGamepad(0.016, true, session.view === 'command'); }
      else key('keyup', physical);
      input.endFrame();
    }
  });
});

describe('confirmed camp control handoff', () => {
  it('clears held controller actions and waits for neutral sticks before driving a new avatar', () => {
    const { input, pad } = setup();
    pad.buttons[0].pressed = true; pad.buttons[7].pressed = true; pad.axes[0] = 1;
    input.pollGamepad(.016, true, false); input.resetForSeat();
    input.pollGamepad(.016, true, false);
    expect(input.wasPressed('Space')).toBe(false); expect(input.buttons[0]).toBe(false); expect(input.moveX).toBe(0);
    pad.buttons[0].pressed = false; pad.buttons[7].pressed = false; pad.axes[0] = 0;
    input.pollGamepad(.016, true, false); input.endFrame();
    pad.buttons[0].pressed = true; pad.axes[0] = 1; input.pollGamepad(.016, true, false);
    expect(input.wasPressed('Space')).toBe(true); expect(input.moveX).toBeGreaterThan(0);
  });

  it('resets queued commands, selection, drag, aim, follow camera and contextual actions', () => {
    const fixture = setup(), session = new Session(), { world } = newMatch();
    session.screen = 'playing'; session.playerFaction = 2;
    const controls = new Controls({ session, world } as AppApi, fixture.input.canvas), internals = controls as any;
    session.view = 'command'; session.viewBlend = 1; session.followFaction = 1;
    session.selection.add(world.avatarOf(0).id); session.selectBox = { x0: 1, y0: 1, x1: 2, y1: 2 };
    session.planPreview = [1, 2]; session.planTool = 'enclose'; session.tool = 'building';
    session.aim = { active: true, node: 1, arc: [{ x: 1, y: 1, z: 1 }], landing: { x: 1, y: 1, z: 1 } };
    session.orderMarker = { x: 0, z: 0, kind: 'plan', at: 0 };
    internals.queue.push({ t: 'plant', faction: 0, node: 1 });
    internals.throwQueued = true; internals.jumpLatch = true; internals.eMode = 'gcc'; internals.gccFired = true;
    controls.resetForSeat();
    expect(internals.queue).toEqual([]); expect(internals.throwQueued).toBe(false); expect(internals.jumpLatch).toBe(false);
    expect(internals.eMode).toBe('none'); expect(internals.gccFired).toBe(false);
    expect(session.selection.size).toBe(0); expect(session.selectBox).toBeNull(); expect(session.planPreview).toEqual([]);
    expect(session.aim).toEqual({ active: false, node: -1, arc: [], landing: null });
    expect(session.tool).toBe('flag'); expect(session.planTool).toBe('select'); expect(session.orderMarker).toBeNull();
    expect(session.view).toBe('action'); expect(session.followFaction).toBeNull();
    expect(session.camera.yaw).toBe(world.avatarOf(2).yaw); expect(session.camera.cmdX).toBe(world.avatarOf(2).pos.x);
    expect(session.prompt).toBeNull(); expect(session.channel).toBe(-1);
  });
});

describe('emergence look lock', () => {
  it.each(['mouse', 'gamepad'])('discards %s look while preserving movement and restores fresh look', async device => {
    const { normalizeMatch } = await import('../sim/matchSettings');
    const { bossRevealTime } = await import('../sim/effigyBurn');
    const fixture = setup(), session = new Session(), { world } = newMatch('camera-input');
    world.options.humans = [0];
    world.options.match = normalizeMatch({ bossMode: true, days: 0 });
    world.suddenDeath = true;
    const reveal = bossRevealTime(world.options);
    world.time = reveal;
    const submitted: any[] = [];
    session.screen = 'playing';
    const handlers = new Controls({ session, world, submit: (command: any) => submitted.push(structuredClone(command)) } as unknown as AppApi, fixture.input.canvas) as any;
    handlers.world = world;
    const input = handlers.input as Input;
    input.locked = true;
    fixture.listeners.get('keydown')!({ code: 'KeyW', target: null, preventDefault() {}, altKey: false, ctrlKey: false, metaKey: false, repeat: false });
    const yaw = session.camera.yaw, pitch = session.camera.pitch;
    for (let i = 0; i < 90; i++) {
      if (device === 'mouse') fixture.listeners.get('mousemove')!({ movementX: 70, movementY: 60 });
      else { fixture.pad.axes[2] = 1; fixture.pad.axes[3] = 1; input.pollGamepad(1 / 60, true, false); }
      handlers.look(session);
      expect(session.camera.yaw).toBe(yaw); expect(session.camera.pitch).toBe(pitch);
      input.endFrame();
    }
    world.time = reveal + 0.999;
    if (device === 'mouse') fixture.listeners.get('mousemove')!({ movementX: 70, movementY: 60 });
    else input.pollGamepad(1 / 60, true, false);
    handlers.look(session);
    expect(session.camera.yaw).toBe(yaw); expect(session.camera.pitch).toBe(pitch);
    input.endFrame();
    handlers.tick();
    expect(Math.hypot(submitted[0].input.moveX, submitted[0].input.moveZ)).toBeGreaterThan(0);
    fixture.pad.axes[2] = fixture.pad.axes[3] = 0;
    world.time = reveal + 1;
    input.pollGamepad(1 / 60, true, false);
    handlers.look(session);
    expect(session.camera.yaw).toBe(yaw); expect(session.camera.pitch).toBe(pitch);
    if (device === 'mouse') fixture.listeners.get('mousemove')!({ movementX: 10, movementY: 0 });
    else { fixture.pad.axes[2] = 1; input.pollGamepad(1 / 60, true, false); }
    handlers.look(session);
    expect(session.camera.yaw).not.toBe(yaw);
  });
});
