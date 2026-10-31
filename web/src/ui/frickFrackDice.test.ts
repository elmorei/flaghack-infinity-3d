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
    const n = { textContent: '', dataset: {}, disabled: false, addEventListener() {}, attrs: {} as Record<string, string>, appendChild() {}, replaceChildren() {},
      setAttribute(k: string, v: string) { this.attrs[k] = v; }, querySelectorAll: () => [], querySelector: () => null };
    created.push(n); return n;
  };
  vi.stubGlobal('document', { createElement: node });
  const actions: string[] = [];
  const controls: Record<string, { disabled: boolean }> = {};
  const fixture = Object.assign(Object.create(FrickFrackUI.prototype), {
    engineCards: new Map(), body: node(), title: node(), status: node(), frame() {}, hand() {}, renderPrivatePeek() {}, renderMajorPicker() {},
    action(_parent: unknown, label: string) { actions.push(label); const control = node(); controls[label] = control; return control; },
  });
  return { fixture, actions, created, controls };
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
    expect(frickFrackDicePresentation(s, 12)?.label).toContain('Cards deal automatically when it settles');
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
  it('keeps main actions and disabled wager input visible during rolling, with accessible live status', () => {
    const { fixture, actions, created } = renderFixture(); fixture.render(session(), 8, { time: 10.5 });
    expect(actions).toEqual(['Deal', 'Hit', 'Stand', 'Exit']);
    expect(created.some(n => n.className === 'ff-table-stage')).toBe(true);
    expect(created.some(n => n.className === 'ff-deck-stage' && n.attrs['aria-hidden'] === 'true')).toBe(true);
    expect(created.some(n => n.className === 'ff-target-title' && n.textContent === 'Rolling the target')).toBe(true);
    expect(created.some(n => n.attrs.role === 'status' && n.attrs['aria-live'] === 'polite')).toBe(true);
    expect(created.some(n => n.attrs['aria-label'] === 'Flags to wager')).toBe(true);
    expect(created.some(n => n.textContent === 'Deal hand')).toBe(false);
  });
  it.each(['rolling', 'betting', 'playing', 'result'] as const)('keeps actions in invariant order with phase-safe readiness in %s', phase => {
    const { fixture, actions, controls } = renderFixture();
    const s = { ...session(), phase }; fixture.active = s;
    fixture.render(s, 8, { time: 12, frickFrack: { sideboards: { 0: [] } } });
    expect(actions).toEqual(['Deal', 'Hit', 'Stand', 'Exit']);
    expect(controls.Deal.disabled).toBe(phase !== 'betting' && phase !== 'result');
    expect(controls.Hit.disabled).toBe(phase !== 'playing');
    expect(controls.Stand.disabled).toBe(phase !== 'playing');
    expect(controls.Again).toBeUndefined();
    expect(controls.Exit.disabled).toBe(false);
  });
  it.each(['betting', 'result'] as const)('allows selecting a wager before Deal in %s, but never with no Flags', phase => {
    const { fixture, controls } = renderFixture();
    const s = { ...session(), phase }; fixture.active = s; fixture.pending = '';
    fixture.render(s, 8, { time: 12, frickFrack: { sideboards: { 0: [] } } });
    fixture.setWager(3);
    expect(fixture.wagerInput.disabled).toBe(false);
    expect(fixture.wagerInput.value).toBe('3');
    fixture.render(s, 0, { time: 12, frickFrack: { sideboards: { 0: [] } } });
    expect(controls.Deal.disabled).toBe(true); expect(fixture.wagerInput.disabled).toBe(true);
  });
  it('explains the single Deal before the first roll without inventing a target', () => {
    const { fixture, created } = renderFixture(); const s = { ...session(), phase: 'betting' as const, dieResult: undefined, target: undefined };
    fixture.active = s; fixture.render(s, 8, { time: 12 });
    expect(created.some(n => n.textContent === 'Ready to deal')).toBe(true);
    expect(created.some(n => n.textContent.includes('Deal rolls the die and deals your hand'))).toBe(true);
    expect(created.some(n => n.textContent === 'Target 21')).toBe(false);
  });
  it('retains the committed wager while rolling even after the carried Flags are charged', () => {
    const { fixture } = renderFixture(); const s = { ...session(), wager: 5 }; fixture.active = s;
    fixture.render(s, 0, { time: 10.5 });
    expect(fixture.wagerInput.value).toBe('5'); expect(fixture.wagerInput.disabled).toBe(true);
    expect(fixture.status.textContent).toContain('Exit forfeits your wager.');
    fixture.setWager(1); expect(fixture.wager).toBe(5);
  });
  it('uses one Deal at result to commit the chosen wager and blocks duplicate or rolling commands', () => {
    const s = { ...session(), phase: 'result' as FrickFrackSession['phase'] };
    const submit = vi.fn();
    const app = { session: { screen: 'playing', playerFaction: 0, spectator: false },
      world: { phase: 'playing', time: 20, factions: [{ alive: true, controlMode: 'avatar' }],
        avatarOf: () => ({ koUntil: 0 }), frickFrack: { sessions: { 0: s } } }, submit };
    const fixture = Object.assign(Object.create(FrickFrackUI.prototype), { host: { app }, pending: '', root: { querySelectorAll: () => [] }, body: { querySelectorAll: () => [] } });
    fixture.send('bet', { wager: 3 }); fixture.send('bet', { wager: 3 });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toEqual({ t: 'frickFrack', faction: 0, sessionId: 7, revision: 2, action: 'bet', wager: 3 });
    s.phase = 'rolling'; s.revision++; fixture.pending = ''; fixture.send('bet', { wager: 3 });
    expect(submit).toHaveBeenCalledTimes(1);
    s.phase = 'betting'; s.revision++; fixture.send('bet', { wager: 3 });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1][0]).toMatchObject({ action: 'bet', wager: 3 });
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
    const control = { dataset: {}, attrs: {} as Record<string, string>, innerHTML: '', disabled: false,
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
    control.disabled = true; send.mockClear();
    click!({ stopPropagation() {}, detail: 0 });
    expect(send).not.toHaveBeenCalled();
  });
  it('excludes closed sleeve cards even when the browser retains their nonzero layout boxes', () => {
    const s = session(), r = { x: 100, y: 200, width: 72, height: 108 };
    const closed = { isConnected: true, closest: (): object | null => ({}), getClientRects: () => [r], getBoundingClientRect: () => r };
    const open = { ...closed, closest: () => null };
    const fixture = Object.assign(Object.create(FrickFrackUI.prototype), {
      host: { app: { world: { time: 10.625 } } }, engineRound: 0,
      engineCards: new Map([[closed, { key: 'sleeve:1', card: { id: 1, rank: 4, suit: 0 }, order: -1, defeated: false }],
        [open, { key: 'You:0', card: { id: 2, rank: 7, suit: 1 }, order: 0, defeated: false }]]),
      root: { querySelector: () => ({ getBoundingClientRect: () => ({ x: 0, y: 0, width: 320, height: 568 }) }) },
    });
    fixture.publishEngineView(s);
    expect(getFrickFrackView()?.cards.map(c => c.key)).toEqual(['You:0']);
  });
  it('explains six targets and preserves even-money base winnings', () => {
    const rules = FRICK_FRACK_TABLE_RULES.join(' ');
    expect(rules).toContain('20 + the roll (21–26)'); expect(rules).toContain('target minus 4');
    expect(rules).toContain('Base wins pay 1:1'); expect(rules).not.toContain('Closest to 21');
    expect(rules).not.toContain('stands on all 17s');
  });
});
