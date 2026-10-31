import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrickFrackUI, FRICK_FRACK_TABLE_RULES, frickFrackDicePresentation } from './frickFrack';
import type { FrickFrackSession } from '../sim/frickFrack';
import { getFrickFrackView, setFrickFrackView } from '../render/frickFrackView';
const session = (dieResult = 4): FrickFrackSession => ({
  id: 7, revision: 2, faction: 0, phase: 'rolling', dialogueIndex: 2, dialogueStartedAt: 0, readyAt: 0,
  wager: 0, player: [], dealer: [], result: null, message: '', dieResult, target: 20 + dieResult,
  rollStartedAt: 10, rollEndsAt: 11.25, rollNumber: 2,
});
afterEach(() => { vi.unstubAllGlobals(); setFrickFrackView(null); });
function renderFixture() {
  const created: { textContent: string; className?: string; attrs: Record<string, string> }[] = [];
  const node = () => {
    const n = { textContent: '', attrs: {} as Record<string, string>, appendChild() {}, replaceChildren() {},
      setAttribute(k: string, v: string) { this.attrs[k] = v; }, querySelectorAll: () => [], querySelector: () => null };
    created.push(n); return n;
  };
  vi.stubGlobal('document', { createElement: node });
  const actions: string[] = [];
  const fixture = Object.assign(Object.create(FrickFrackUI.prototype), {
    engineCards: new Map(), body: node(), title: node(), status: node(), frame() {}, hand() {},
    action(_parent: unknown, label: string) { actions.push(label); return { disabled: false }; },
  });
  return { fixture, actions, created };
}
describe('authoritative target die presentation', () => {
  it.each([1, 2, 3, 4, 5, 6])('shows rolled %s and its fixed target after the roll', die => {
    const s = session(die); s.phase = 'betting'; const view = frickFrackDicePresentation(s, 20)!;
    expect(view.label).toContain(`Rolled ${die}`); expect(view.label).toContain(`Target ${20 + die}`);
    expect(view.label).toContain(`stands at ${16 + die}`); expect(view.result).toBe(die); expect(view.progress).toBe(1);
    s.phase = 'playing'; expect(frickFrackDicePresentation(s, 50)).toEqual(view);
    s.phase = 'result'; expect(frickFrackDicePresentation(s, 60)).toEqual(view);
  });
  it('derives progress from host time without revealing numeric status during rolling', () => {
    const s = session();
    expect(frickFrackDicePresentation(s, 9)?.progress).toBe(0);
    expect(frickFrackDicePresentation(s, 10.625)?.progress).toBe(.5);
    expect(frickFrackDicePresentation(s, 12)?.progress).toBe(1);
    expect(frickFrackDicePresentation(s, 12)?.label).toContain('Betting opens when it settles');
    expect(frickFrackDicePresentation(s, 12)?.label).not.toContain('24');
    expect(s.dieResult).toBe(4); expect(s.target).toBe(24);
  });
  it('does not restart on betting, rerender or identical reconnect snapshot', () => {
    const s = session(); const before = frickFrackDicePresentation(s, 10.8)!;
    expect(frickFrackDicePresentation(JSON.parse(JSON.stringify(s)), 10.8)).toEqual(before);
    s.phase = 'betting'; expect(frickFrackDicePresentation(s, 12)?.rollKey).toBe(before.rollKey);
    s.rollNumber!++; expect(frickFrackDicePresentation(s, 12)?.rollKey).not.toBe(before.rollKey);
  });
  it.each([undefined, 0, 7, NaN, 2.5])('omits nonexistent or invalid die data %s', dieResult => {
    expect(frickFrackDicePresentation({ ...session(), dieResult }, 20)).toBeNull();
  });
  it('shows only Leave during rolling, with accessible live status and no wager input', () => {
    const { fixture, actions, created } = renderFixture(); fixture.render(session(), 8, { time: 10.5 });
    expect(actions).toEqual(['Leave table']);
    expect(created.some(n => n.className === 'ff-table-stage')).toBe(true);
    expect(created.some(n => n.className === 'ff-deck-stage' && n.attrs['aria-hidden'] === 'true')).toBe(true);
    expect(created.some(n => n.className === 'ff-target-title' && n.textContent === 'Rolling the target')).toBe(true);
    expect(created.some(n => n.attrs.role === 'status' && n.attrs['aria-live'] === 'polite')).toBe(true);
    expect(created.some(n => n.attrs['aria-label'] === 'Flags to wager')).toBe(false);
    expect(created.some(n => n.textContent === 'Deal hand')).toBe(false);
  });
  it('publishes die lane and unchanged authoritative progress in read-only phase', () => {
    const s = session(), rect = { x: 12, y: 20, width: 160, height: 82 };
    const fixture = Object.assign(Object.create(FrickFrackUI.prototype), {
      host: { app: { world: { time: 10.625 } } }, engineRound: 9, engineCards: new Map(),
      deckStage: { isConnected: true, getBoundingClientRect: () => ({ x: 25, y: 200, width: 80, height: 120 }) },
      reducedMotion: { matches: true }, dieStage: { isConnected: true, getBoundingClientRect: () => rect },
      root: { querySelector: () => ({ getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 568 }) }) },
    });
    fixture.publishEngineView(s);
    expect(getFrickFrackView()).toMatchObject({ sessionKey: '7:2', reducedMotion: true,
      die: { result: 4, progress: .5, rollKey: '7:2', rect }, deck: { x: 25, y: 200, width: 80, height: 120 } });
    s.phase = 'betting'; fixture.publishEngineView(s);
    expect(getFrickFrackView()).toMatchObject({ sessionKey: '7:2', die: { progress: 1, result: 4, rollKey: '7:2' } });
  });
  it('styles actions by semantic command without changing the live label or callback', () => {
    let click: ((ev: { stopPropagation(): void; detail: number }) => void) | undefined;
    const control = { dataset: {}, attrs: {} as Record<string, string>, innerHTML: '',
      setAttribute(key: string, value: string) { this.attrs[key] = value; },
      addEventListener(_event: string, callback: typeof click) { click = callback; }, blur() {} };
    vi.stubGlobal('document', { createElement: () => control });
    const send = vi.fn();
    const fixture = Object.assign(Object.create(FrickFrackUI.prototype), { send });
    fixture.action({ appendChild() {} }, 'Stand', 'stand');
    expect(control.attrs['data-action']).toBe('stand');
    expect(control.innerHTML).toBe('Stand');
    click!({ stopPropagation() {}, detail: 0 });
    expect(send).toHaveBeenCalledWith('stand', undefined);
  });
  it('explains six targets and preserves even-money base winnings', () => {
    const rules = FRICK_FRACK_TABLE_RULES.join(' ');
    expect(rules).toContain('20 + the roll (21–26)'); expect(rules).toContain('target minus 4');
    expect(rules).toContain('Base wins pay 1:1'); expect(rules).not.toContain('Closest to 21');
    expect(rules).not.toContain('stands on all 17s');
  });
});
