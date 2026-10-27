import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StartupOverlay } from './overlay';

class Element extends EventTarget {
  textContent = ''; hidden = false; disabled = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  removed = false;
  focus = vi.fn();
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  hasAttribute(key: string) { return this.attributes.has(key); }
  removeAttribute(key: string) { this.attributes.delete(key); }
  remove() { this.removed = true; }
  click() { this.dispatchEvent(new Event('click')); }
}
class Video extends Element {
  currentTime = 0; muted = false; defaultMuted = false; playsInline = false; preload = 'none';
  play = vi.fn(async () => {}); pause = vi.fn(); load = vi.fn();
  set src(value: string) { this.attributes.set('src', value); }
  get src() { return this.attributes.get('src') ?? ''; }
}
function fixture() {
  const video = new Video(), status = new Element(), skip = new Element(), sound = new Element(), reload = new Element();
  skip.disabled = true; skip.textContent = 'Loading…'; sound.hidden = true; reload.hidden = true;
  const elements = { '#startup-video': video, '#startup-status': status, '#startup-skip': skip, '#startup-sound': sound, '#startup-reload': reload };
  const root = Object.assign(new Element(), { querySelector: (selector: keyof typeof elements) => elements[selector] });
  const overlay = new StartupOverlay(root as unknown as HTMLElement);
  const finished = vi.fn(); void overlay.finished.then(finished);
  return { overlay, video, status, skip, sound, reload, root, finished };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('startup intro', () => {
  it('plays muted and fully, keeping Loading disabled until real game readiness', async () => {
    const f = fixture(); f.overlay.play('/game/assets/intro-hash.mp4');
    expect(f.video.src).toBe('/game/assets/intro-hash.mp4');
    expect(f.video.muted && f.video.defaultMuted && f.video.playsInline).toBe(true);
    expect(f.video.play).toHaveBeenCalledOnce(); expect(f.skip.disabled).toBe(true);
    f.skip.click(); await Promise.resolve(); expect(f.finished).not.toHaveBeenCalled();
    f.overlay.ready(); await Promise.resolve();
    expect(f.skip.disabled).toBe(false); expect(f.skip.textContent).toBe('Skip');
    expect(f.video.pause).not.toHaveBeenCalled(); expect(f.finished).not.toHaveBeenCalled();
    f.skip.click(); await Promise.resolve(); expect(f.finished).toHaveBeenCalledOnce();
    expect(f.video.src).toBe(''); expect(f.video.load).toHaveBeenCalledOnce(); f.overlay.dispose();
  });
  it('finishes naturally without cutting a ready intro short', async () => {
    const f = fixture(); f.overlay.play('/intro.mp4'); f.overlay.ready();
    await vi.advanceTimersByTimeAsync(7_000); f.video.currentTime = 7; f.video.dispatchEvent(new Event('timeupdate'));
    await vi.advanceTimersByTimeAsync(7_000); expect(f.finished).not.toHaveBeenCalled();
    f.video.dispatchEvent(new Event('ended')); await Promise.resolve(); expect(f.finished).toHaveBeenCalledOnce();
    f.overlay.dispose();
  });
  it('holds the last video frame with Loading when video ends before the game is ready', async () => {
    const f = fixture(); f.overlay.play('/intro.mp4'); f.video.dispatchEvent(new Event('ended'));
    await Promise.resolve(); expect(f.finished).not.toHaveBeenCalled(); expect(f.skip.disabled).toBe(true);
    expect(f.video.src).toBe('/intro.mp4'); expect(f.root.dataset.video).toBe('playing');
    expect(f.sound.hidden).toBe(true); expect(f.video.load).not.toHaveBeenCalled();
    f.overlay.ready(); await Promise.resolve(); expect(f.finished).toHaveBeenCalledOnce(); f.overlay.dispose();
  });
  it('never assigns or requests video on the warm/no-source path, but still waits for readiness', async () => {
    const f = fixture(); f.overlay.setStatus('Preparing the title scene…');
    expect(f.status.textContent).toBe('Preparing the title scene…');
    await Promise.resolve(); expect(f.finished).not.toHaveBeenCalled();
    f.overlay.ready(); await Promise.resolve(); f.overlay.dispose();
    expect(f.finished).toHaveBeenCalledOnce(); expect(f.video.src).toBe('');
    expect(f.video.play).not.toHaveBeenCalled(); expect(f.video.load).not.toHaveBeenCalled();
  });
  it('drops blocked autoplay and waits only for the game', async () => {
    const f = fixture(); f.video.play.mockRejectedValueOnce(new Error('NotAllowedError'));
    f.overlay.play('/intro.mp4'); await Promise.resolve();
    expect(f.video.src).toBe(''); expect(f.finished).not.toHaveBeenCalled();
    f.overlay.ready(); await Promise.resolve(); expect(f.finished).toHaveBeenCalledOnce(); f.overlay.dispose();
  });
  it('ignores media errors and a stalled stream rather than holding a ready game hostage', async () => {
    const failed = fixture(); failed.overlay.play('/intro.mp4'); failed.overlay.ready();
    failed.video.dispatchEvent(new Event('error')); await Promise.resolve(); expect(failed.finished).toHaveBeenCalledOnce(); failed.overlay.dispose();
    const stalled = fixture(); stalled.overlay.play('/intro.mp4'); stalled.overlay.ready();
    await vi.advanceTimersByTimeAsync(8_000); expect(stalled.finished).toHaveBeenCalledOnce(); stalled.overlay.dispose();
  });
  it('sound is explicit and isolated from saved game settings', async () => {
    const f = fixture(); f.overlay.play('/intro.mp4');
    expect(f.sound.hidden).toBe(false); expect(f.video.muted).toBe(true);
    f.sound.click(); expect(f.video.muted).toBe(false); expect(f.sound.textContent).toBe('Mute');
    expect(f.sound.attributes.get('aria-pressed')).toBe('true');
    f.video.play.mockRejectedValueOnce(new Error('blocked'));
    f.sound.click(); await Promise.resolve(); expect(f.video.muted).toBe(true); expect(f.sound.textContent).toBe('Sound on');
    f.overlay.dispose();
  });
  it('offers reload on game failure and cleans up media/listeners on disposal', () => {
    const f = fixture(); f.overlay.play('/intro.mp4'); f.overlay.fail();
    expect(f.video.src).toBe(''); expect(f.skip.hidden).toBe(true); expect(f.reload.hidden).toBe(false);
    expect(f.status.textContent).toMatch(/could not start/); expect(f.reload.focus).toHaveBeenCalledOnce();
    f.overlay.dispose(); const calls = f.video.play.mock.calls.length; f.sound.click();
    expect(f.video.play).toHaveBeenCalledTimes(calls); expect(f.root.removed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('focuses the startup dialog so Escape can skip without an earlier pointer click', async () => {
  const f = fixture(); expect(f.root.focus).toHaveBeenCalledWith({ preventScroll: true });
  f.overlay.play('/intro.mp4');
  const escape = () => f.root.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' }));
  escape(); await Promise.resolve(); expect(f.finished).not.toHaveBeenCalled();
  f.overlay.ready(); escape(); await Promise.resolve(); expect(f.finished).toHaveBeenCalledOnce(); f.overlay.dispose();
});
it('does not offer a dead sound toggle for silent placeholder footage', () => {
  const f = fixture(); f.overlay.play('/silent-placeholder.mp4', false);
  expect(f.sound.hidden).toBe(true); f.sound.click(); expect(f.video.muted).toBe(true); f.overlay.dispose();
});

it('does not mistake repeated stalled media events for actual playback progress', async () => {
  const f = fixture(); f.overlay.play('/intro.mp4'); f.overlay.ready();
  await vi.advanceTimersByTimeAsync(6_000);
  f.video.dispatchEvent(new Event('waiting')); f.video.dispatchEvent(new Event('timeupdate'));
  await vi.advanceTimersByTimeAsync(2_000); expect(f.finished).toHaveBeenCalledOnce(); f.overlay.dispose();
});
it('checks decoded playback progress when the main thread delayed media events', async () => {
  const f = fixture(); f.overlay.play('/intro.mp4'); f.overlay.ready(); f.video.currentTime = 7;
  await vi.advanceTimersByTimeAsync(8_000); expect(f.finished).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(8_000); expect(f.finished).toHaveBeenCalledOnce(); f.overlay.dispose();
});
