import { describe, expect, it, vi } from 'vitest';
import { bossFixture } from '../../tests/bossFixture';
import { createAi } from '../ai';
import { SnapshotEncoder } from '../net/codec';
import { createMatch } from '../sim/setup';
import { App } from './app';
import { Session } from './session';

/** Lifecycle tests avoid WebGL while exercising the real App handoff methods. */
function setup() {
  const world = createMatch({ seed: 'app-camp-takeover', difficulty: 'normal', mode: 'standard', humans: [0] });
  world.boss = bossFixture(); world.factions[0].alive = false;
  const app: any = Object.create(App.prototype);
  Object.assign(app, {
    session: new Session(), world, mirror: null, client: null, predictor: null,
    ai: new Map([1, 2, 3].map(f => [f, createAi(world, [f as 1 | 2 | 3])])),
    acc: .01, seq: 42, tickFresh: true, tickCmds: [{ t: 'plant', faction: 0, node: 1 }],
    tickInput: { moveX: 1, moveZ: 1, jump: true, sprint: true, yaw: 0, pitch: 0 },
    controls: { resetForSeat: vi.fn() }, renderer: { attach: vi.fn() }, audio: { unlock: vi.fn() }, tutorial: null,
    predictionOn: true,
  });
  app.session.screen = 'playing';
  return { app, world };
}

describe('App camp ownership transition', () => {
  it('adopts an existing local camp and removes only that camp’s AI controller', () => {
    const { app, world } = setup();
    const targetAvatar = world.avatarOf(2), flags = [...world.flags.values()], units = [...world.hippies.values()], buildings = [...world.buildings.values()];
    const otherBrain = app.ai.get(1);
    app.session.screen = 'paused';
    expect(app.takeBossCamp(2)).toBe(true);
    expect(app.session.playerFaction).toBe(2); expect(app.session.screen).toBe('paused');
    expect(world.options.humans).toEqual([2]); expect(world.factions[2].isPlayer).toBe(true);
    expect(app.ai.has(2)).toBe(false); expect(app.ai.get(1)).toBe(otherBrain);
    expect(world.avatarOf(2)).toBe(targetAvatar);
    expect([...world.flags.values()]).toEqual(flags); expect([...world.hippies.values()]).toEqual(units); expect([...world.buildings.values()]).toEqual(buildings);
    expect(app.controls.resetForSeat).toHaveBeenCalledOnce(); expect(app.tickCmds).toEqual([]); expect(app.tickFresh).toBe(false);
  });

  it('leaves controls and AI untouched for a failed local claim or an online spectator', () => {
    const { app, world } = setup();
    world.factions[2].alive = false;
    expect(app.takeBossCamp(2)).toBe(false); expect(app.ai.has(2)).toBe(true);
    app.session.spectator = true; expect(app.takeBossCamp(1)).toBe(false);
    expect(app.session.playerFaction).toBe(0); expect(app.controls.resetForSeat).not.toHaveBeenCalled();
  });

  it('sends only a request online and rebuilds prediction solely after the authoritative snapshot', () => {
    const { app, world } = setup();
    const requestBossTakeover = vi.fn();
    const client = { connected: true, status: 'match', pendingBossTakeover: null, playerId: 'me', requestBossTakeover,
      lobby: { phase: 'playing', seats: [0, 1, 2, 3].map(faction => ({ faction, playerId: faction === 0 ? 'me' : null })), players: [{ id: 'me', name: 'Player' }] } };
    app.client = client; app.mirror = {}; app.predictor = { stale: true }; app.session.camera.yaw = 2;
    expect(app.takeBossCamp(2)).toBe(true); expect(requestBossTakeover).toHaveBeenCalledExactlyOnceWith(2);
    expect(app.session.playerFaction).toBe(0); expect(app.session.camera.yaw).toBe(2);
    expect(app.predictor).toEqual({ stale: true }); expect(app.controls.resetForSeat).not.toHaveBeenCalled();
    // The server's accepted state changes ownership and sends a new snapshot; retain an open pause.
    world.options.humans = [2]; world.factions[0].isPlayer = false; world.factions[2].isPlayer = true;
    app.session.screen = 'paused';
    app.enterOnline(client, world.options, 2, new SnapshotEncoder(world).full());
    expect(app.session.playerFaction).toBe(2); expect(app.session.screen).toBe('paused');
    expect(app.predictor.avatarId).toBe(world.avatarOf(2).id); expect(app.seq).toBe(0); expect(app.tickCmds).toEqual([]);
    expect(app.tickInput).toMatchObject({ moveX: 0, moveZ: 0, jump: false, sprint: false, throwMode: false });
    expect(app.controls.resetForSeat).toHaveBeenCalledOnce(); expect(app.renderer.attach).toHaveBeenCalledOnce();
  });
});
