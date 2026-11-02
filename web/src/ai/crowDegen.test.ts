import { describe, expect, it } from 'vitest';
import { createMatch } from '../sim/setup';
import { Simulation } from '../sim/simulation';
import { normalizeMatch } from '../sim/matchSettings';
import { SnapshotEncoder } from '../net/codec';
import { NetMirror } from '../net/mirror';
import { createAi } from '.';
import type { GameEvent } from '../sim/events';

const options = { seed: 'crow-degen', mode: 'standard' as const, difficulty: 'normal' as const, humans: [0] as [0], match: normalizeMatch({ maxSignifiers: 40, bossMode: false }) };
describe('Dr. Crow commands in Degen mode', () => {
  it('starts only NPC Crow without a roaming body and preserves human choices', () => {
    const world = createMatch(options);
    expect(world.factions.map(f => f.controlMode)).toEqual(['avatar', 'rts', 'avatar', 'avatar']);
    expect(world.avatarOf(1)).toBeUndefined();
    expect(world.factions[1].avatarId).toBe(-1);
    for (const mode of ['avatar', 'rts'] as const) {
      const human = createMatch({ ...options, humans: [0, 1], rtsFactions: mode === 'rts' ? [1] : [] });
      expect(human.factions[1].controlMode).toBe(mode);
      expect(!!human.avatarOf(1)).toBe(mode === 'avatar');
      expect([...world.flags.values()].filter(f => f.owner === 1)).toHaveLength([...human.flags.values()].filter(f => f.owner === 1).length);
      const ai = createAi(human, [1]); ai.update();
      expect(human.factions[1].controlMode).toBe(mode);
    }
    const tutorial = createMatch({ ...options, mode: 'tutorial' });
    expect(tutorial.factions[1].controlMode).toBe('avatar');
  });

  it('keeps building and surveying without personal avatar commands, including mirrored state', () => {
    const world = createMatch(options), ai = createAi(world, [1]), sim = new Simulation(world);
    const encoder = new SnapshotEncoder(world);
    const livePeer = NetMirror.create(world.options, JSON.parse(JSON.stringify(encoder.full())));
    const initialSurvey = world.survey.surveySize[1];
    const submitted: string[] = [], submit = world.submit.bind(world);
    world.submit = c => { if (c.faction === 1) submitted.push(c.t); submit(c); };
    const events: GameEvent[] = [];
    for (let i = 0; i < 60 * 90; i++) { ai.update(); sim.step(); events.push(...world.drainEvents()); }
    expect(world.avatarOf(1)).toBeUndefined();
    expect(submitted).toContain('placeBuilding');
    expect(world.survey.surveySize[1]).toBeGreaterThan(initialSurvey);
    expect(submitted).not.toContain('avatarInput');
    expect(submitted).not.toContain('throw');
    livePeer.push(JSON.parse(JSON.stringify({ tick: world.tick, time: world.time, acks: {}, delta: encoder.delta(events), events: [] }))); livePeer.catchUp();
    expect(livePeer.world.factions[1].controlMode).toBe('rts');
    expect(livePeer.world.avatarOf(1)).toBeUndefined();
    const peer = NetMirror.create(world.options, JSON.parse(JSON.stringify(encoder.full())));
    expect(peer.world.factions[1].controlMode).toBe('rts');
    expect(peer.world.avatarOf(1)).toBeUndefined();
  });
});
