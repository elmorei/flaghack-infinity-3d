import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';

const calls = vi.hoisted(() => ({
  render: vi.fn(() => false), attach: vi.fn(), renderEvents: vi.fn(),
  controlsUpdate: vi.fn(), controlsTick: vi.fn(), resetControls: vi.fn(), uiUpdate: vi.fn(), uiEvents: vi.fn(),
  audioUpdate: vi.fn(), audioEvents: vi.fn(), unlock: vi.fn(),
  step: vi.fn(), ai: vi.fn(), drainEvents: vi.fn(() => []), submit: vi.fn(),
  titleCamera: vi.fn(), applyCamera: vi.fn(),
}));
vi.mock('../render/renderer', () => ({ GameRenderer: class {
  camera = {}; attach = calls.attach; render = calls.render; onEvents = calls.renderEvents;
} }));
vi.mock('./controls', () => ({ Controls: class { update = calls.controlsUpdate; tick = calls.controlsTick; resetForSeat = calls.resetControls; } }));
vi.mock('./cameraRig', () => ({ CameraRig: class { setMode() {} updateTitle = calls.titleCamera; apply = calls.applyCamera; } }));
vi.mock('../ui/ui', () => ({ GameUI: class { update = calls.uiUpdate; onEvents = calls.uiEvents; } }));
vi.mock('../audio/audio', () => ({ GameAudio: class { update = calls.audioUpdate; onEvents = calls.audioEvents; unlock = calls.unlock; beat() { return null; } } }));
vi.mock('../ai', () => ({ createAi: () => ({ update: calls.ai }) }));
vi.mock('../sim/setup', () => ({ createMatch: (options: unknown) => ({
  options, time: 0, phase: 'playing', drainEvents: calls.drainEvents, submit: calls.submit,
}) }));
vi.mock('../sim/simulation', () => ({ Simulation: class { step = calls.step; } }));

let frames: FrameRequestCallback[];
let now: number;
const root = { querySelector: () => ({}) } as unknown as HTMLElement;
function frame(dt = 20): void {
  now += dt;
  const next = frames.shift();
  expect(next).toBeTypeOf('function');
  next!(now);
}
function app(pending = true): App {
  return new App(root, { hostInfo: null, invitePassword: null, startupPending: pending });
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.render.mockReset().mockReturnValue(false);
  frames = []; now = 0;
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('location', { search: '', origin: 'https://example.com' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('App intro readiness', () => {
  it('waits for an actual draw, keeping simulation, menu/gamepad polling and game audio frozen', async () => {
    const game = app();
    const ready = vi.fn(); void game.ready.then(ready);
    frame(); frame(1000);
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    expect(calls.render.mock.calls).toEqual([[0, false], [0, false]]);
    expect(calls.titleCamera).toHaveBeenCalledOnce();
    expect(calls.applyCamera).toHaveBeenCalledOnce();
    expect(calls.uiUpdate).toHaveBeenCalledExactlyOnceWith(0);
    expect(calls.controlsUpdate).not.toHaveBeenCalled();
    expect(calls.controlsTick).not.toHaveBeenCalled();
    expect(calls.step).not.toHaveBeenCalled();
    expect(calls.ai).not.toHaveBeenCalled();
    expect(calls.drainEvents).not.toHaveBeenCalled();
    expect(calls.audioUpdate).not.toHaveBeenCalled();
    expect(calls.audioEvents).not.toHaveBeenCalled();
    expect(calls.unlock).not.toHaveBeenCalled();

    calls.render.mockReturnValue(true);
    frame(); await game.ready;
    expect(ready).toHaveBeenCalledOnce();
    expect(game.startupPending).toBe(true);
    frame(1000);
    expect(calls.render).toHaveBeenCalledTimes(3);
    expect(calls.step).not.toHaveBeenCalled();
    expect(calls.controlsUpdate).not.toHaveBeenCalled();
    expect(calls.audioUpdate).not.toHaveBeenCalled();
  });

  it('does not start/join a match or accept commands behind the intro', async () => {
    const game = app(); const world = game.world;
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    game.openLobby(); game.startMatch(); game.startTutorial(); game.quitToTitle();
    game.fastForward(5); game.submit({ t: 'avatarInput', faction: 0, input: { moveX: 1, moveZ: 0, jump: false, sprint: false, yaw: 0, pitch: 0 } });
    expect(game.takeBossCamp(1)).toBe(false);
    await game.joinHost('Player', 'secret', 'https://host.example');
    expect(game.session.screen).toBe('title'); expect(game.world).toBe(world);
    expect(calls.attach).toHaveBeenCalledOnce();
    expect(calls.submit).not.toHaveBeenCalled(); expect(calls.step).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled(); expect(calls.unlock).not.toHaveBeenCalled();
  });

  it('releases once, discards intro elapsed time, and resumes normal frames without unlocking sound', async () => {
    const game = app(); calls.render.mockReturnValue(true);
    frame(); await game.ready;
    now += 10_000;
    game.finishStartup(); game.finishStartup();
    expect(game.startupPending).toBe(false);
    expect(calls.resetControls).toHaveBeenCalledOnce();
    frame(1);
    expect(calls.step).not.toHaveBeenCalled();
    expect(calls.controlsUpdate).toHaveBeenCalledExactlyOnceWith(.001);
    expect(calls.audioUpdate).toHaveBeenCalledExactlyOnceWith(.001);
    frame(20);
    expect(calls.step).toHaveBeenCalledOnce();
    expect(calls.ai).toHaveBeenCalled();
    expect(calls.unlock).not.toHaveBeenCalled();
    game.openLobby(); expect(game.session.screen).toBe('lobby');
  });

  it('rejects readiness on a startup draw failure and does not repeatedly try the broken scene', async () => {
    const game = app(); const failure = new Error('GPU draw failed');
    const rejected = expect(game.ready).rejects.toBe(failure);
    calls.render.mockImplementation(() => { throw failure; });
    frame(); await rejected;
    frame();
    expect(calls.render).toHaveBeenCalledOnce();
    expect(calls.step).not.toHaveBeenCalled(); expect(game.startupPending).toBe(true);
  });

  it('rejects readiness if initial title preparation fails', async () => {
    const game = app(); const failure = new Error('UI preparation failed');
    const rejected = expect(game.ready).rejects.toBe(failure);
    calls.uiUpdate.mockImplementationOnce(() => { throw failure; });
    frame(); await rejected;
    expect(calls.render).not.toHaveBeenCalled();
  });

  it('keeps default App construction live without waiting for an intro', async () => {
    const game = new App(root); calls.render.mockReturnValue(true);
    frame(); await game.ready;
    expect(game.startupPending).toBe(false);
    expect(calls.controlsUpdate).toHaveBeenCalledExactlyOnceWith(.02);
    expect(calls.step).toHaveBeenCalledOnce(); expect(calls.audioUpdate).toHaveBeenCalledOnce();
    expect(calls.titleCamera).not.toHaveBeenCalled();
  });
});
