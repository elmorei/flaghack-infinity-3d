import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrickFrackUI, majorPublicBlocker } from './frickFrack';
import { setFrickFrackPrivateView } from '../sim/frickFrackPrivate';
import type { World } from '../sim/world';
import type { FrickFrackCard, FrickFrackSession } from '../sim/frickFrack';

class NodeStub {
  children: NodeStub[] = [];
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = ''; textContent = ''; innerHTML = ''; disabled = false; inert = false;
  focus = vi.fn(); blur = vi.fn(); remove = vi.fn();
  classList = { contains: () => false, toggle: vi.fn() };
  listeners: Record<string, (ev: unknown) => void> = {};
  appendChild(node: NodeStub) { this.children.push(node); }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(type: string, listener: (ev: unknown) => void) { this.listeners[type] = listener; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
}
function fixture(cards: FrickFrackCard[] = [{ id: 10, rank: 4, suit: 0 }, { id: 11, rank: 4, suit: 0 }, { id: 12, rank: 7, suit: 1 }]) {
  const s: FrickFrackSession = { id: 20, revision: 3, faction: 0, phase: 'playing', dialogueIndex: 0, dialogueStartedAt: 0, readyAt: 0, wager: 1, player: [], dealer: [null], result: null, message: '' };
  const submit = vi.fn(), render = vi.fn();
  const world = { phase: 'playing', time: 100, factions: [{ alive: true, controlMode: 'fps' }, { alive: true, controlMode: 'fps' }], avatarOf: () => ({ carried: [], koUntil: 0 }), frickFrack: { sessions: { 0: s }, sideboards: { 0: cards, 1: [{ id: 99, rank: 1, suit: 0 }] } } };
  const session = { playerFaction: 0, spectator: false, screen: 'playing' };
  const body = new NodeStub(), root = new NodeStub();
  const ui = Object.assign(Object.create(FrickFrackUI.prototype), {
    host: { app: { world, session, submit } }, active: s, body, root, render,
    sideboardOpen: true, selectedMajor: cards[0]?.id ?? null, sleeveIndex: 0, majorTargets: [1], majorValue: 7,
    pending: '', lastSleevePlayAt: -Infinity, engineCard: vi.fn(),
  });
  vi.stubGlobal('document', { createElement: () => new NodeStub() });
  return { ui, s, world, session, cards, submit, render, body, root };
}
function flatten(node: NodeStub): NodeStub[] { return [node, ...node.children.flatMap(flatten)]; }
afterEach(() => vi.unstubAllGlobals());

describe('sleeve viewer interactions', () => {
  it.each(['betting', 'rolling', 'result', 'dialogue', 'playing'] as const)('does not rebuild unchanged %s state on each update', phase => {
    const { ui, s, world, render } = fixture(); s.phase = phase;
    if (phase === 'playing') s.arcana = { choices: [{ id: 77, rank: 2, suit: 0 }] };
    Object.assign(ui, { offer: new NodeStub(), key: '', frame: vi.fn(), engineRound: 0, tableWorld: world, lastChoosing: false });
    vi.stubGlobal('document', { documentElement: new NodeStub(), createElement: () => new NodeStub() });
    ui.update(world, 1000); ui.update(world, 1100); ui.update(world, 1200);
    expect(render).toHaveBeenCalledExactlyOnceWith(s, 0, world);
    expect(ui.frame).toHaveBeenCalledTimes(3);
  });
  it('closes on transition into a choice, but preserves explicit inspection after reopening', () => {
    const { ui, s, world, render } = fixture();
    const originalViewer = new NodeStub();
    Object.assign(ui, { offer: new NodeStub(), key: '', frame: vi.fn(), tableWorld: world, lastChoosing: false, sleeveViewer: originalViewer });
    vi.stubGlobal('document', { documentElement: new NodeStub(), createElement: () => new NodeStub() });
    ui.update(world, 1000); expect(ui.sideboardOpen).toBe(true);
    s.arcana = { choices: [{ id: 77, rank: 2, suit: 0 }] }; s.revision++;
    ui.update(world, 1100);
    expect(ui.sideboardOpen).toBe(false); expect(originalViewer.remove).toHaveBeenCalledOnce();
    // Reopening is a local inspection; no authoritative revision changes.
    const reopenedViewer = new NodeStub(); ui.sideboardOpen = true; ui.sleeveViewer = reopenedViewer; ui.body.inert = true;
    ui.update(world, 1200); ui.update(world, 1300);
    expect(ui.sideboardOpen).toBe(true); expect(ui.body.inert).toBe(true);
    expect(reopenedViewer.remove).not.toHaveBeenCalled(); expect(render).toHaveBeenCalledTimes(2);
  });
  it.each(['dealer', 'next'] as const)('shows a new private %s peek immediately, but lets the sleeve reopen', kind => {
    const { ui, s, world, render } = fixture();
    Object.assign(ui, { offer: new NodeStub(), key: '', frame: vi.fn(), tableWorld: world, lastChoosing: false, lastPeekKey: '' });
    vi.stubGlobal('document', { documentElement: new NodeStub(), createElement: () => new NodeStub() });
    ui.update(world, 1000); expect(ui.sideboardOpen).toBe(true);
    s.revision++;
    setFrickFrackPrivateView(world as unknown as World, 0, {
      sessionId: s.id, revision: s.revision, kind, expiresAt: world.time + (kind === 'dealer' ? 3 : 5),
      cards: [{ id: 77, rank: 2, suit: 0 }],
    });
    ui.update(world, 1100);
    expect(ui.sideboardOpen).toBe(false);
    expect(render).toHaveBeenCalledTimes(2);
    ui.sideboardOpen = true; ui.body.inert = true;
    ui.update(world, 1200); ui.update(world, 1300);
    expect(ui.sideboardOpen).toBe(true); expect(ui.body.inert).toBe(true);
    expect(render).toHaveBeenCalledTimes(2);
  });
  it('does not dismiss inspection for an expired or not-yet-entitled peek', () => {
    const { ui, s, world } = fixture();
    Object.assign(ui, { offer: new NodeStub(), key: '', frame: vi.fn(), tableWorld: world, lastChoosing: false, lastPeekKey: '' });
    vi.stubGlobal('document', { documentElement: new NodeStub(), createElement: () => new NodeStub() });
    ui.update(world, 1000);
    setFrickFrackPrivateView(world as unknown as World, 0, {
      sessionId: s.id, revision: s.revision + 1, kind: 'dealer', expiresAt: world.time + 3,
      cards: [{ id: 77, rank: 2, suit: 0 }],
    });
    ui.update(world, 1100); expect(ui.sideboardOpen).toBe(true);
    world.time += 4; s.revision++;
    ui.update(world, 1200); expect(ui.sideboardOpen).toBe(true);
  });
  it('browses physical card identities, including duplicate faces, without submitting a play', () => {
    const { ui, submit, render } = fixture();
    ui.browseSleeve(1);
    expect(ui.selectedMajor).toBe(11); expect(ui.sleeveIndex).toBe(1);
    expect(ui.majorTargets).toEqual([]); expect(ui.majorValue).toBe(1);
    ui.browseSleeve(1); expect(ui.selectedMajor).toBe(12);
    ui.browseSleeve(-1); expect(ui.selectedMajor).toBe(11);
    expect(submit).not.toHaveBeenCalled(); expect(render).toHaveBeenCalledTimes(3);
  });
  it('clamps navigation at either end instead of unexpectedly wrapping', () => {
    const { ui } = fixture();
    ui.browseSleeve(-1); expect(ui.selectedMajor).toBe(10);
    ui.browseSleeve(100); expect(ui.selectedMajor).toBe(12);
    ui.browseSleeve(1); expect(ui.selectedMajor).toBe(12);
  });
  it('keeps the slot after consumption and clamps when the last copy disappears', () => {
    const { ui, s, world, cards, submit } = fixture();
    ui.selectedMajor = 11; ui.sleeveIndex = 1; cards.splice(1, 1);
    ui.renderSleeve(s, 0, world);
    expect(ui.selectedMajor).toBe(12); expect(ui.sleeveIndex).toBe(1);
    cards.pop(); ui.renderSleeve(s, 0, world);
    expect(ui.selectedMajor).toBe(10); expect(ui.sleeveIndex).toBe(0);
    expect(submit).not.toHaveBeenCalled();
  });
  it.each([0, 1])('disables both arrows for %s cards', count => {
    const { ui, s, world, root } = fixture(count ? [{ id: 10, rank: 4, suit: 0 }] : []);
    ui.renderSleeve(s, 0, world);
    const arrows = flatten(root).filter(n => ['previous', 'next'].includes(n.dataset.sleeveControl));
    expect(arrows).toHaveLength(2); expect(arrows.every(n => n.disabled)).toBe(true);
    expect(ui.body.inert).toBe(true);
  });
  it('closes inspection without a play/exit and restores focus to Sleeve', () => {
    const { ui, submit, body, render } = fixture();
    const opener = new NodeStub(); body.querySelector = () => opener as never;
    ui.closeSleeve();
    expect(ui.sideboardOpen).toBe(false); expect(ui.selectedMajor).toBeNull(); expect(ui.majorTargets).toEqual([]);
    expect(opener.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(render).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
  });
  it.each(['spectator', 'faction', 'screen', 'closed'] as const)('does not browse stale or unowned inventory (%s)', mode => {
    const { ui, session, render, submit } = fixture();
    if (mode === 'spectator') session.spectator = true;
    if (mode === 'faction') session.playerFaction = 1;
    if (mode === 'screen') session.screen = 'title';
    if (mode === 'closed') ui.sideboardOpen = false;
    ui.browseSleeve(1);
    expect(ui.selectedMajor).toBe(10); expect(render).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  });
  it('submits a play only once while awaiting authoritative revision', () => {
    const { ui, submit } = fixture();
    ui.send('cheat', { cardId: 10 }); ui.send('cheat', { cardId: 10 });
    expect(submit).toHaveBeenCalledExactlyOnceWith({ t: 'frickFrack', faction: 0, sessionId: 20, revision: 3, action: 'cheat', cardId: 10 });
    expect(ui.pending).toBe('20:3');
  });
  it('debounces a second tap even after acknowledgement selects the successor', () => {
    const { ui, s, submit } = fixture();
    let now = 1000; vi.stubGlobal('performance', { now: () => now });
    ui.send('cheat', { cardId: 10 });
    expect(submit).toHaveBeenCalledTimes(1);
    s.revision++; ui.pending = ''; now = 1100;
    ui.send('cheat', { cardId: 11 });
    expect(submit).toHaveBeenCalledTimes(1); expect(ui.pending).toBe('');
    now = 1600; ui.send('cheat', { cardId: 11 });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenLastCalledWith({ t: 'frickFrack', faction: 0, sessionId: 20, revision: 4, action: 'cheat', cardId: 11 });
  });
  it.each([13, 16])('explains why Major %s cannot affect an empty player hand', arcana => {
    const { s } = fixture();
    expect(majorPublicBlocker(arcana, s)).toBe('There is no card in your hand to affect.');
    s.player = [{ id: 55, rank: 6, suit: 0 }];
    expect(majorPublicBlocker(arcana, s)).toBeNull();
  });
  it.each([5, 16])('explains why Major %s cannot affect an empty wizard hand', arcana => {
    const { s } = fixture(); s.player = [{ id: 55, rank: 6, suit: 0 }]; s.dealer = [];
    expect(majorPublicBlocker(arcana, s)).toBe('The wizard has no cards to affect.');
    s.dealer = [null]; expect(majorPublicBlocker(arcana, s)).toBeNull();
  });
  it.each(['rolling', 'result', 'betting'] as const)('does not submit cards outside the playing phase (%s)', phase => {
    const { ui, s, submit } = fixture(); s.phase = phase;
    ui.send('cheat', { cardId: 10 }); expect(submit).not.toHaveBeenCalled();
  });
  it('does not submit a card while an Arcana choice needs completion', () => {
    const { ui, s, submit } = fixture(); s.arcana = { choices: [{ id: 77, rank: 2, suit: 0 }] };
    ui.send('cheat', { cardId: 10 }); expect(submit).not.toHaveBeenCalled();
  });
});
