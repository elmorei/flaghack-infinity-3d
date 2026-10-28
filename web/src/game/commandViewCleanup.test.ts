import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera } from 'three';
import { CommandView } from './commandView';
import { Input, LMB, RMB } from './input';
import { Picker } from './picking';
import { Session } from './session';
import type { Command } from '../sim/commands';
import type { Piece } from '../sim/types';
import { newMatch } from '../sim/systems/econ/testkit';
import { canPlantAt } from '../sim/systems/flags';
import { spawnBoss } from '../sim/systems/boss';
import { cmdOrder, updateHippies } from '../sim/systems/hippies';
import { SIM_DT } from '../sim/constants';

/** Real input edges and command frames, without a renderer or browser. */
function setup() {
  const listeners = new Map<string, (event: any) => void>();
  class Element { isContentEditable = false; }
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('HTMLInputElement', class extends Element {});
  vi.stubGlobal('HTMLTextAreaElement', class extends Element {});
  vi.stubGlobal('HTMLSelectElement', class extends Element {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('window', {
    addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
    removeEventListener() {},
  });
  vi.stubGlobal('document', {
    activeElement: null, pointerLockElement: null,
    addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [],
  });
  const pad = {
    connected: true, mapping: 'standard', axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
  vi.stubGlobal('navigator', { getGamepads: () => [pad] });
  const canvas = {
    style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
    removeEventListener() {},
  };
  const input = new Input(canvas as unknown as HTMLCanvasElement);
  input.capturesKey = () => true;
  const { world } = newMatch('command-cleanup');
  const session = new Session();
  session.screen = 'playing'; session.view = 'command'; session.viewBlend = 1;
  const own = [...world.hippies.values()].filter(h => h.faction === 0);
  expect(own.length).toBeGreaterThan(0);
  session.selection.add(own[0].id);
  session.hover.point = { x: 18, y: 0, z: 23 };
  const queue: Command[] = [];
  const view = new CommandView(input, queue), camera = new PerspectiveCamera();
  const key = (type: 'keydown' | 'keyup', code: string) => listeners.get(type)!({
    code, target: null, preventDefault() {}, altKey: false, ctrlKey: false, metaKey: false, repeat: false,
  });
  const mouse = (type: 'mousedown' | 'mouseup', button = RMB) => listeners.get(type)!({
    button, clientX: 400, clientY: 300, preventDefault() {},
  });
  const frame = () => { const exit = view.frame(world, session, 0, camera, null); input.endFrame(); return exit; };
  const click = (button = RMB) => { mouse('mousedown', button); frame(); mouse('mouseup', button); frame(); };
  const revealBoss = () => { world.effigyRevealedAt = world.time; return spawnBoss(world)!; };
  return { world, session, input, queue, view, camera, own, pad, key, mouse, frame, click, revealBoss };
}

afterEach(() => vi.unstubAllGlobals());

describe('Command View context-order cleanup', () => {
  it.each(['enemy flag', 'enemy unit', 'enemy avatar', 'enemy building', 'enemy piece', 'own avatar', 'own GCC', 'lumber', 'node', 'ground', 'boss'])
    ('Ctrl+RMB forces a defend-at-cursor order over %s', target => {
      const { world, session, own, queue, key, click, revealBoss } = setup();
      switch (target) {
        case 'enemy flag': session.hover.entity = [...world.flags.values()].find(f => f.owner !== 0 && f.state === 'planted')!.id; break;
        case 'enemy unit': session.hover.entity = [...world.hippies.values()].find(h => h.faction === 1)!.id; break;
        case 'enemy avatar': session.hover.entity = world.avatarOf(1).id; break;
        case 'enemy building': session.hover.entity = world.hearthOf(1)!.id; break;
        case 'enemy piece': {
          const id = world.newId(); world.pieces.set(id, { id, faction: 1 } as Piece); session.hover.entity = id; break;
        }
        case 'own avatar': session.hover.entity = world.avatarOf(0).id; break;
        case 'own GCC': session.hover.entity = world.gccOf(0)!.id; break;
        case 'lumber': session.hover.entity = [...world.piles.values()][0].id; break;
        case 'node': {
          session.hover.node = world.lattice.nodes.findIndex(node => canPlantAt(world, node.id, 0));
          expect(session.hover.node).toBeGreaterThanOrEqual(0); break;
        }
        case 'boss': session.hover.entity = revealBoss().id; break;
      }
      key('keydown', 'ControlLeft'); click();
      expect(queue).toEqual([{ t: 'order', faction: 0, hippies: [own[0].id], order: { kind: 'defend', at: { x: 18, z: 23 } } }]);
      expect(session.prompt).toMatch(/Ctrl\+RMB.*Defend/i);
      expect(session.orderMarker).toMatchObject({ x: 18, z: 23, kind: 'defend' });
    });

  it('cancels an armed GCC push when Ctrl+RMB defends, including the preview prompt', () => {
    const { world, session, queue, key, frame, click } = setup();
    session.hover.entity = world.gccOf(0)!.id; click();
    expect(queue).toEqual([]);
    expect(session.prompt).toContain('Push the Command Center here');
    session.hover.entity = world.avatarOf(1).id;
    key('keydown', 'ControlLeft'); frame();
    expect(session.prompt).toMatch(/Ctrl\+RMB.*Defend/i);
    click();
    expect(queue[0]).toMatchObject({ t: 'order', order: { kind: 'defend' } });
    key('keyup', 'ControlLeft'); session.hover.entity = -1; click();
    expect(queue[1]).toMatchObject({ t: 'order', order: { kind: 'move', to: { x: 18, z: 23 } } });
    expect(session.prompt).not.toContain('Push the Command Center');
  });

  it('keeps ordinary right-click Follow available on the player avatar', () => {
    const { world, session, queue, click } = setup();
    session.hover.entity = world.avatarOf(0).id; click();
    expect(queue[0]).toMatchObject({ t: 'order', order: { kind: 'follow', avatarId: world.avatarOf(0).id } });
  });

  it.each(['node', 'enclose', 'ring', 'building'] as const)('Ctrl+RMB exits the %s tool and defends, while plain RMB only exits', tool => {
    const { session, queue, key, click } = setup();
    const armTool = () => {
      if (tool === 'building') session.tool = 'building'; else session.planTool = tool;
    };
    armTool(); click();
    expect(session.tool).toBe('flag'); expect(session.planTool).toBe('select'); expect(queue).toEqual([]);
    armTool(); key('keydown', 'ControlLeft'); click();
    expect(session.tool).toBe('flag'); expect(session.planTool).toBe('select');
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ t: 'order', order: { kind: 'defend', at: { x: 18, z: 23 } } });
  });

  it.each(['custom keyboard', 'gamepad'])('honors %s bindings for the defend override', device => {
    const { world, session, input, queue, pad, key, frame } = setup();
    session.hover.entity = world.hearthOf(1)!.id;
    input.controls.bindings.ControlLeft = [device === 'gamepad' ? 'Pad1' : 'KeyI'];
    if (device === 'gamepad') {
      pad.buttons[1].pressed = true; pad.buttons[6].pressed = true;
      input.pollGamepad(1 / 60, true, true);
    } else {
      input.controls.bindings.Mouse2 = ['KeyO']; key('keydown', 'KeyI'); key('keydown', 'KeyO');
    }
    frame();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ t: 'order', order: { kind: 'defend', at: { x: 18, z: 23 } } });
  });

  it.each(['R', 'custom keyboard', 'custom gamepad'])('retains %s access to the internal ring planner and Escape cancellation', device => {
    const { session, input, pad, key, frame } = setup();
    if (device === 'custom gamepad') {
      input.controls.bindings.KeyR = ['Pad3']; pad.buttons[3].pressed = true;
      input.pollGamepad(1 / 60, true, true);
    } else {
      const code = device === 'R' ? 'KeyR' : 'KeyI'; input.controls.bindings.KeyR = [code]; key('keydown', code);
    }
    frame();
    expect(session.planTool).toBe('ring');
    expect(session.prompt).toMatch(/home|ring/i);
    key('keydown', 'Escape');
    expect(frame()).toBe(false);
    expect(session.planTool).toBe('select');
    expect(session.planPreview).toEqual([]);
  });
});

describe('revealed boss map targeting', () => {
  it('picks the live boss, retains its click selection, and issues Attack from real map input', () => {
    const { world, session, own, queue, click, frame, revealBoss } = setup();
    const boss = revealBoss(), picker = new Picker();
    const pick = () => picker.entityAlong(world, 0, boss.pos.x, 100, boss.pos.z, 0, -1, 0, 100, 0, true);
    expect(pick()).toBe(boss.id);
    session.hover.entity = pick(); click(LMB); frame();
    expect([...session.selection]).toEqual([boss.id]);
    session.selection.clear(); session.selection.add(own[0].id); frame();
    expect(session.prompt).toContain('RMB  Attack');
    click();
    expect(queue).toEqual([{ t: 'order', faction: 0, hippies: [own[0].id], order: { kind: 'attack', target: boss.id } }]);
    // The actual simulation accepts the picked ID and the ordered player unit can hurt it.
    const command = queue[0];
    if (command.t !== 'order') throw new Error('expected a map order');
    for (const id of world.hippies.keys()) if (id !== own[0].id) world.hippies.delete(id);
    world.factions[0].isPlayer = true;
    own[0].pos = { x: boss.pos.x + 1, z: boss.pos.z };
    cmdOrder(world, command);
    expect(own[0].order).toEqual({ kind: 'attack', target: boss.id });
    const hp = boss.hp;
    updateHippies(world, SIM_DT);
    expect(own[0].status).toBe('fighting'); expect(boss.hp).toBeLessThan(hp);
    expect(world.drainEvents()).toContainEqual(expect.objectContaining({ t: 'hit', target: boss.id, by: own[0].id }));
  });

  it('does not retain or attack a dying/dead boss, or pick one before reveal', () => {
    const { world, session, queue, click, frame, revealBoss } = setup();
    const picker = new Picker(), boss = revealBoss();
    const pick = () => picker.entityAlong(world, 0, boss.pos.x, 100, boss.pos.z, 0, -1, 0, 100, 0, true);
    world.effigyRevealedAt = null;
    expect(pick()).not.toBe(boss.id);
    world.effigyRevealedAt = world.time;
    for (const action of ['death', 'dead'] as const) {
      boss.action = action; boss.hp = 0; boss.deathAt = world.time;
      expect(pick()).not.toBe(boss.id);
      session.selection.add(boss.id); frame(); expect(session.selection.has(boss.id)).toBe(false);
      session.hover.entity = boss.id; click();
      expect(queue.at(-1)).not.toMatchObject({ t: 'order', order: { kind: 'attack', target: boss.id } });
    }
  });
});

describe('commanded recruitment interaction', () => {
  it('right-click orders selected workers to recruit a real neutral', () => {
    const { world, session, queue, click } = setup();
    const neutral = [...world.hippies.values()].find(h => h.faction === -1)!;
    session.hover.entity = neutral.id; click();
    expect(queue[0]).toMatchObject({ t: 'order', order: { kind: 'recruit', target: neutral.id } });
    expect(session.prompt).toContain('Recruit with a Flag');
  });
  it('armed Recruit uses left click, rejects hostile targets, and cancels cleanly', () => {
    const { world, session, queue, click, key, frame, view } = setup();
    session.recruitTargeting = true;
    session.hover.entity = world.avatarOf(1).id; click(LMB);
    expect(queue).toEqual([]); expect(session.recruitTargeting).toBe(true);
    expect(session.prompt).toContain('Choose a neutral');
    session.hover.entity = [...world.hippies.values()].find(h => h.faction === -1)!.id;
    click(LMB);
    expect(queue[0]).toMatchObject({ order: { kind: 'recruit', target: session.hover.entity } });
    expect(session.recruitTargeting).toBe(false);
    session.recruitTargeting = true; click(RMB);
    expect(session.recruitTargeting).toBe(false); expect(queue).toHaveLength(1);
    session.recruitTargeting = true; key('keydown', 'Escape');
    expect(frame()).toBe(false); expect(session.recruitTargeting).toBe(false);
    session.recruitTargeting = true; view.reset(session); expect(session.recruitTargeting).toBe(false);
  });
});

  it('Recruit replaces a previously armed GCC push destination', () => {
    const { world, session, queue, click } = setup();
    session.hover.entity = world.gccOf(0)!.id; click();
    expect(session.prompt).toContain('Push the Command Center here');
    session.recruitTargeting = true;
    session.hover.entity = [...world.hippies.values()].find(h => h.faction === -1)!.id;
    click(LMB);
    expect(queue[0]).toMatchObject({ order: { kind: 'recruit', target: session.hover.entity } });
    expect(session.recruitTargeting).toBe(false);
  });
