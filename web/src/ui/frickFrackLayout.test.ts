import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrickFrackUI } from './frickFrack';
import { GameUI } from './ui';
import { getFrickFrackView, setFrickFrackView } from '../render/frickFrackView';

afterEach(() => { vi.unstubAllGlobals(); setFrickFrackView(null); });
function tableFixture() {
  const geometry = vi.fn(() => { throw new Error('Geometry read before publication'); });
  const gate = { disabled: false };
  const node = () => ({ textContent: '', appendChild() {}, replaceChildren() {},
    getBoundingClientRect: geometry, getClientRects: geometry,
    querySelectorAll: () => [gate], querySelector: () => ({ focus() {} }) });
  const session = { id: 1, phase: 'empty', message: 'No Flags', wager: 0, readyAt: 10, dialogueStartedAt: 0, revision: 1 };
  const fixture = Object.assign(Object.create(FrickFrackUI.prototype), {
    active: session, host: { app: { world: { time: 2 } } }, body: node(), root: node(), title: node(), status: node(),
    text: null, next: gate, pending: '', engineCards: new Map(), publishEngineView: geometry, action: () => gate,
  });
  return { fixture, geometry, gate, node, session };
}

describe('Frick-frack write/read layout batching', () => {
  it('updates readiness without reading card geometry', () => {
    const { fixture, geometry, gate } = tableFixture();
    fixture.frame();
    expect(gate.disabled).toBe(true); expect(geometry).not.toHaveBeenCalled();
  });
  it('rebuilds DOM and applies focus/readiness without publishing geometry', () => {
    const { fixture, geometry, node, session } = tableFixture();
    vi.stubGlobal('document', { createElement: node });
    fixture.render(session, 0, { time: 2 });
    expect(geometry).not.toHaveBeenCalled();
  });
  it('publishes the current public view only in the explicit read phase, and clears stale views', () => {
    const { fixture, session } = tableFixture();
    fixture.publishEngineView = vi.fn(); fixture.publishEngineFrame();
    expect(fixture.publishEngineView).toHaveBeenCalledExactlyOnceWith(session);
    setFrickFrackView({ sessionKey: 'old', panel: { x: 0, y: 0, width: 10, height: 10 }, cards: [], reducedMotion: false });
    fixture.active = null; fixture.publishEngineFrame(); expect(getFrickFrackView()).toBeNull();
  });
  it.each([true, false])('measures exactly once after all scheduled UI writers (tick=%s)', tick => {
    const order: string[] = [], write = (name: string) => () => { order.push(name); };
    const world = {}, session = { screen: 'playing', panels: {}, spectator: false };
    const fixture = {
      app: { world, session }, world, screen: 'playing', lastTick: tick ? -Infinity : Infinity, lastMap: -Infinity,
      hud: { frame: write('hud') }, tutorialOverlay: { frame: write('tutorial') },
      frickFrack: { frame: write('table-writes'), publishEngineFrame: write('measure') },
      rootEl: { classList: { contains: () => false, toggle: write('root-write') } },
      parts: [{ update: write('part-rebuild') }], minimap: { draw: write('minimap') },
      uiMs: 0, uiMaxWindow: 0, uiMaxStart: Infinity, veil: { frame: write('veil') },
    };
    GameUI.prototype.update.call(fixture as unknown as GameUI, 0);
    expect(order.filter(s => s === 'measure')).toHaveLength(1);
    expect(order.indexOf('measure')).toBeGreaterThan(order.indexOf('minimap'));
    expect(order.indexOf('measure')).toBeGreaterThan(order.indexOf('table-writes'));
    if (tick) expect(order.indexOf('measure')).toBeGreaterThan(order.indexOf('part-rebuild'));
    expect(order.at(-1)).toBe('veil');
  });
});
