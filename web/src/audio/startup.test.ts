import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppApi } from '../game/app';
import { Session } from '../game/session';
import { GameAudio } from './audio';

const calls = vi.hoisted(() => ({
  construct: vi.fn(), resume: vi.fn(), volumes: vi.fn(), listener: vi.fn(), prune: vi.fn(),
  events: vi.fn(), hover: vi.fn(), music: vi.fn(), ambience: vi.fn(), mentor: vi.fn(), beat: vi.fn(() => 4),
}));
vi.mock('./engine', () => ({ AudioEngine: class {
  ctx = { state: 'running', resume: calls.resume }; setVolumes = calls.volumes;
  setListener = calls.listener; prune = calls.prune;
  constructor() { calls.construct(); }
} }));
vi.mock('./sfx', () => ({ Sfx: class { play = calls.events; uiHover = calls.hover; } }));
vi.mock('./boss', () => ({ BossAudio: class { tracker = { reset() {}, update() {} }; onEvents() {} } }));
vi.mock('./music', () => ({ Music: class { reset() {} update = calls.music; beat = calls.beat; } }));
vi.mock('./ambience', () => ({ Ambience: class { update = calls.ambience; } }));
vi.mock('./mentor', () => ({ MENTOR_CHARS_PER_SEC: 30, MentorVoice: class { speak = calls.mentor; } }));
vi.mock('./cues', () => ({ Cues: class {} }));
vi.mock('./soundscape', async importOriginal => ({ ...await importOriginal<object>(), measure() {} }));

function fixture(pending: boolean | undefined = true) {
  const session = new Session();
  Object.assign(session.settings, { masterVolume: .3, musicVolume: 0, sfxVolume: .7 });
  const app = {
    startupPending: pending, session, net: null,
    world: { time: 0, phase: 'playing', boss: null, factions: [{ avatarId: 1 }], suddenDeath: false },
    renderer: { ctx: null, camera: { position: { x: 0, y: 0, z: 0 }, matrixWorld: { elements: [] } } },
  };
  return { app, audio: new GameAudio(app as unknown as AppApi) };
}
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('window', new EventTarget()); });
afterEach(() => vi.unstubAllGlobals());

describe('intro sound isolation', () => {
  it('ignores intro Sound/Skip gestures and explicit unlock while pending, preserving volume settings', () => {
    const { app, audio } = fixture();
    const settings = structuredClone(app.session.settings);
    window.dispatchEvent(new Event('pointerdown')); window.dispatchEvent(new Event('keydown'));
    audio.unlock(); audio.update(.1); audio.onEvents([{ t: 'notify', faction: 'all', severity: 'info', text: 'test' }]);
    audio.uiHover(); expect(audio.mentorSpeak('test')).toBe(0); expect(audio.beat()).toBeNull();
    expect(calls.construct).not.toHaveBeenCalled(); expect(calls.events).not.toHaveBeenCalled();
    expect(calls.volumes).not.toHaveBeenCalled(); expect(calls.hover).not.toHaveBeenCalled();
    expect(app.session.settings).toEqual(settings);
  });

  it('unlocks only on a new post-intro gesture, then uses the existing stored volume settings', () => {
    const { app, audio } = fixture();
    window.dispatchEvent(new Event('pointerdown'));
    app.startupPending = false;
    audio.update(.016);
    expect(calls.construct).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pointerdown')); audio.update(.016); audio.uiHover();
    expect(calls.construct).toHaveBeenCalledOnce();
    expect(calls.volumes).toHaveBeenCalledExactlyOnceWith(app.session.settings, false, .55);
    expect(app.session.settings).toMatchObject({ masterVolume: .3, musicVolume: 0, sfxVolume: .7 });
    expect(calls.music).toHaveBeenCalledOnce(); expect(calls.hover).toHaveBeenCalledOnce();
    expect(audio.beat()).toBe(4);
  });

  it('does not unlock from held Enter repeats after that press skips the intro', () => {
    const { app, audio } = fixture();
    const enter = (repeat: boolean) => Object.assign(new Event('keydown'), { key: 'Enter', code: 'Enter', repeat });
    window.dispatchEvent(enter(false));
    app.startupPending = false;
    window.dispatchEvent(enter(true)); window.dispatchEvent(enter(true));
    audio.update(.016);
    expect(calls.construct).not.toHaveBeenCalled(); expect(calls.music).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('keyup'));
    window.dispatchEvent(enter(false)); audio.update(.016);
    expect(calls.construct).toHaveBeenCalledOnce(); expect(calls.music).toHaveBeenCalledOnce();
  });

  it('also guards frame/event/UI audio paths when audio parts already exist', () => {
    const { app, audio } = fixture(false); audio.unlock();
    app.startupPending = true;
    audio.update(.016); audio.onEvents([{ t: 'notify', faction: 'all', severity: 'info', text: 'test' }]); audio.uiHover();
    expect(audio.beat()).toBeNull(); expect(audio.mentorSpeak('test')).toBe(0);
    expect(calls.volumes).not.toHaveBeenCalled(); expect(calls.events).not.toHaveBeenCalled();
    expect(calls.hover).not.toHaveBeenCalled(); expect(calls.mentor).not.toHaveBeenCalled();
    app.startupPending = false; audio.update(.016); audio.uiHover();
    expect(calls.volumes).toHaveBeenCalledOnce(); expect(calls.hover).toHaveBeenCalledOnce();
  });

  it('keeps callers without startupPending compatible', () => {
    const { app, audio } = fixture(); Reflect.deleteProperty(app, 'startupPending');
    window.dispatchEvent(new Event('keydown')); audio.update(.016);
    expect(calls.construct).toHaveBeenCalledOnce(); expect(calls.volumes).toHaveBeenCalledOnce();
  });
});
