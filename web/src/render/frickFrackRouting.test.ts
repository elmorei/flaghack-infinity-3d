import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameRenderer } from './renderer';
import { setFrickFrackView } from './frickFrackView';
import { Session } from '../game/session';
import { newMatch } from '../sim/systems/econ/testkit';

afterEach(() => setFrickFrackView(null));
function setup() {
  const { world } = newMatch('engine-routing');
  const session = new Session(); session.screen = 'playing';
  world.frickFrack.sessions[0] = { id: 123, revision: 0, faction: 0, phase: 'betting', dialogueIndex: 0, dialogueStartedAt: 0, readyAt: 0, wager: 0, player: [], dealer: [], result: null, message: '' };
  setFrickFrackView({ sessionKey: '123:1', panel: { x: 0, y: 0, width: 320, height: 568 }, cards: [], reducedMotion: false });
  const update = vi.fn(), draw = vi.fn(), clear = vi.fn(), post = vi.fn();
  const state = { ctx: { world, session, time: 0, beat: 0, shared: {} }, modules: [{ update }], updateFx: vi.fn(),
    frickScene: { draw, clear }, renderer: {}, post: { render: post }, needsWarm: false, warmUntil: 0 };
  const render = () => GameRenderer.prototype.render.call(state as unknown as GameRenderer, .016);
  return { state, world, session, draw, clear, update, post, render };
}
describe('engine table GPU routing', () => {
  it('uses the shared engine and keeps simulation-owned time/effect modules advancing', () => {
    const f = setup(); expect(f.render()).toBe(true);
    expect(f.draw).toHaveBeenCalledOnce(); expect(f.post).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledWith(.016); expect(f.state.ctx.time).toBe(.016);
  });
  it.each(['paused', 'ended', 'spectator', 'ko', 'dialogue', 'removed', 'mismatch'])('restores normal rendering for %s', kind => {
    const f = setup();
    if (kind === 'paused' || kind === 'ended') f.session.screen = kind;
    if (kind === 'spectator') f.session.spectator = true;
    if (kind === 'ko') f.world.avatarOf(0)!.koUntil = f.world.time + 10;
    if (kind === 'dialogue') f.world.frickFrack.sessions[0]!.phase = 'dialogue';
    if (kind === 'removed') delete f.world.frickFrack.sessions[0];
    if (kind === 'mismatch') f.world.frickFrack.sessions[0]!.id++;
    f.render(); expect(f.draw).not.toHaveBeenCalled(); expect(f.clear).toHaveBeenCalledOnce(); expect(f.post).toHaveBeenCalledWith(.016);
  });
});
