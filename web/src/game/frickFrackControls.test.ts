import { describe, expect, it } from 'vitest';
import { frickFrackTableOccludesWorld } from './frickFrackControls';
import { Controls } from './controls';
import { Session } from './session';
import { newMatch } from '../sim/systems/econ/testkit';
import type { Command } from '../sim/commands';

/** Real tick path, with held input from before the wizard took focus. */
describe('Frick-frack control boundary', () => {
  it('sends a neutral input and discards stale discrete actions during dialogue/table', () => {
    const {world} = newMatch('frick-controls'); const session = new Session();
    session.screen = 'playing'; session.view = 'action'; world.options.humans = [0];
    world.frickFrack.sessions[0] = {id: 1, revision: 0, faction: 0, phase: 'dialogue', dialogueIndex: 0, dialogueStartedAt: 0, readyAt: 10, wager: 0, player: [], dealer: [], result: null, message: ''};
    const sent: Command[] = [];
    const controls = Object.create(Controls.prototype) as any;
    Object.assign(controls, {
      app: {world, session, submit: (c: Command) => sent.push(structuredClone(c))}, world,
      input: {isDown: () => true, moveX: 1, moveY: 1, buttons: [true, true, true], shift: true},
      inputCmd: {t: 'avatarInput', faction: 0, input: {moveX: 1, moveZ: 1, jump: true, sprint: true, yaw: 0, pitch: 0}},
      queue: [{t: 'throw', faction: 0}, {t: 'swing', faction: 0}], throwQueued: true, jumpLatch: true,
    });
    world.avatarOf(0).yaw = 1.75; session.camera.yaw = -1;
    controls.tick();
    expect((sent[0] as Extract<Command,{t:'avatarInput'}>).input.yaw).toBe(1.75);
    expect(session.camera.yaw).toBe(-1);
    expect(sent).toHaveLength(1); expect(sent[0].t).toBe('avatarInput');
    expect((sent[0] as Extract<Command,{t:'avatarInput'}>).input).toMatchObject({moveX:0,moveZ:0,jump:false,sprint:false,throwMode:false});
    expect(controls.queue).toEqual([]); expect(controls.throwQueued).toBe(false);
    world.frickFrack.sessions[0]!.phase='playing'; controls.tick(); expect(sent).toHaveLength(2);
    delete world.frickFrack.sessions[0]; controls.tick();
    expect((sent[2] as Extract<Command,{t:'avatarInput'}>).input.moveX).not.toBe(0);
  });
});

describe('opaque card-table render hint', () => {
  it('excludes in-world dialogue and resumes for exit, KO, spectator, RTS and end', () => {
    const {world} = newMatch('frick-occlusion'); const session = new Session();
    session.screen = 'playing'; world.options.humans = [0];
    const table = world.frickFrack.sessions[0] = {id: 1, revision: 0, faction: 0, phase: 'dialogue', dialogueIndex: 0, dialogueStartedAt: 0, readyAt: 0, wager: 0, player: [], dealer: [], result: null, message: ''} as NonNullable<typeof world.frickFrack.sessions[0]>;
    for (const phase of ['dialogue', 'empty', 'chasing'] as const) { table.phase = phase; expect(frickFrackTableOccludesWorld(world, session)).toBe(false); }
    for (const phase of ['betting', 'playing', 'result'] as const) { table.phase = phase; expect(frickFrackTableOccludesWorld(world, session)).toBe(true); }
    world.avatarOf(0).koUntil = world.time + 5; expect(frickFrackTableOccludesWorld(world, session)).toBe(false); world.avatarOf(0).koUntil = 0;
    session.spectator = true; expect(frickFrackTableOccludesWorld(world, session)).toBe(false); session.spectator = false;
    world.factions[0].controlMode = 'rts'; expect(frickFrackTableOccludesWorld(world, session)).toBe(false); world.factions[0].controlMode = 'avatar';
    session.screen = 'ended'; expect(frickFrackTableOccludesWorld(world, session)).toBe(false); session.screen = 'playing';
    delete world.frickFrack.sessions[0]; expect(frickFrackTableOccludesWorld(world, session)).toBe(false);
  });
});
