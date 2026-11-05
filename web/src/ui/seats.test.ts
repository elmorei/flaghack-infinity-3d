import { afterEach, describe, expect, it, vi } from 'vitest';
import { bossFixture } from '../../tests/bossFixture';
import { Input } from '../game/input';
import { Session } from '../game/session';
import { applyBossTakeover } from '../sim/bossTakeover';
import { createMatch } from '../sim/setup';
import type { FactionId } from '../sim/types';
import type { UiHost } from './core';
import { campChoices } from './online';
import { SeatChooser } from './seats';

/** Test actual choice handlers/focus with a small DOM; visual layout is tested separately. */
class Node {
  tagName: string; className = ''; textContent = ''; innerHTML = ''; children: Node[] = []; parentElement: Node | null = null;
  disabled = false; isContentEditable = false; dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  style = { setProperty() {} }; handlers = new Map<string, (event: any) => void>();
  constructor(tag = 'div') { this.tagName = tag; }
  classList = {
    contains: (key: string) => this.className.split(' ').includes(key),
    add: (key: string) => this.classList.toggle(key, true), remove: (key: string) => this.classList.toggle(key, false),
    toggle: (key: string, on: boolean) => { const list = new Set(this.className.split(' ').filter(Boolean)); if (on) list.add(key); else list.delete(key); this.className = [...list].join(' '); },
  };
  appendChild(node: Node) { node.parentElement = this; this.children.push(node); return node; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  addEventListener(key: string, fn: (event: any) => void) { this.handlers.set(key, fn); }
  removeEventListener() {}
  getClientRects(): object[] { return this.classList.contains('is-off') || (this.parentElement && !this.parentElement.getClientRects().length) ? [] : [{}]; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  contains(node: Node | null): boolean { return node === this || this.children.some(child => child.contains(node)); }
  closest(): null { return null; }
  querySelectorAll(): Node[] { return this.children.flatMap(child => [...(child.tagName === 'button' ? [child] : []), ...child.querySelectorAll()]); }
  focus() { (document as any).activeElement = this; }
  blur() { if (document.activeElement === this as any) (document as any).activeElement = null; }
  click() { if (!this.disabled) this.handlers.get('click')?.({ detail: 0, stopPropagation() {} }); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
  find(cls: string): Node | undefined { return this.classList.contains(cls) ? this : this.children.map(child => child.find(cls)).find(Boolean); }
}
function setup(online = false) {
  const listeners = new Map<string, Set<(e: any) => void>>();
  const root = new Node();
  vi.stubGlobal('HTMLElement', Node); vi.stubGlobal('HTMLButtonElement', Node);
  vi.stubGlobal('HTMLInputElement', class {}); vi.stubGlobal('HTMLTextAreaElement', class {}); vi.stubGlobal('HTMLSelectElement', class {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('window', {
    addEventListener: (name: string, fn: (e: any) => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
    removeEventListener: (name: string, fn: (e: any) => void) => listeners.get(name)?.delete(fn),
    dispatchEvent: (ev: Event) => { for (const fn of listeners.get(ev.type) ?? []) fn(ev); return !ev.defaultPrevented; },
  });
  vi.stubGlobal('document', {
    createElement: (tag: string) => new Node(tag), activeElement: null, pointerLockElement: null,
    querySelector: () => root.find('seats')?.getClientRects().length ? root.find('seats') : null,
    querySelectorAll: () => root.querySelectorAll(), addEventListener() {}, removeEventListener() {},
  });
  const pad = { connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
  vi.stubGlobal('navigator', { getGamepads: () => [pad] });
  const world = createMatch({ seed: 'camp-chooser', mode: 'standard', difficulty: 'normal', humans: [0] });
  const session = new Session(); session.screen = 'playing';
  const net: any = online ? {
    seat: 0, pendingBossTakeover: null, bossTakeoverError: null,
    lobby: { phase: 'playing', seats: [0, 1, 2, 3].map(faction => ({ faction, playerId: faction === 0 ? 'me' : null })), players: [{ id: 'me', name: 'Player', connected: true }] },
    setSeat: vi.fn(),
  } : null;
  const app: any = { world, session, net, setPaused: vi.fn() };
  app.takeBossCamp = vi.fn((faction: FactionId) => {
    if (net) { net.pendingBossTakeover = faction; return true; }
    if (!applyBossTakeover(world, session.playerFaction, faction, [1, 2, 3])) return false;
    session.playerFaction = faction; return true;
  });
  const chooser = new SeatChooser({ app } as UiHost, root as any);
  const update = () => chooser.update(world, performance.now());
  const reveal = () => { world.boss = bossFixture(); world.factions[session.playerFaction].alive = false; update(); };
  const controls = chooser as any;
  return { root, app, net, world, session, pad, chooser, controls, update, reveal, listeners };
}
afterEach(() => vi.unstubAllGlobals());

describe('surviving camp choice', () => {
  it('offers eliminated players camps before the encounter without choosing automatically', () => {
    const { world, session, app, root, update, reveal } = setup();
    world.factions[0].alive = false; world.effigyRevealedAt = 0; update();
    expect(session.campChoiceOpen).toBe(true);
    reveal();
    expect(session.campChoiceOpen).toBe(true);
    expect(campChoices(app, world)).toEqual([1, 2, 3]);
    expect(root.find('seats-list')!.getClientRects()).not.toEqual([]);
    expect(app.takeBossCamp).not.toHaveBeenCalled(); expect(session.playerFaction).toBe(0);
  });

  it('keeps spectating on dismissal, can reopen, and offers another choice after repeated elimination', () => {
    const { controls, chooser, reveal, update, session, world, app } = setup();
    reveal(); controls.close(); update();
    expect(session.campChoiceOpen).toBe(false); expect(session.playerFaction).toBe(0);
    chooser.open(null); controls.pick(2); controls.take();
    expect(session.playerFaction).toBe(2); expect(session.campChoiceOpen).toBe(false);
    expect(app.takeBossCamp).toHaveBeenCalledExactlyOnceWith(2);
    world.factions[2].alive = false; update();
    expect(session.campChoiceOpen).toBe(true); expect(controls.picked).toBeNull();
    expect(campChoices(app, world)).toEqual([1, 3]);
  });

  it('clears a dismissed offer on restart and offers a new fallen camp', () => {
    const { chooser, controls, reveal, update, world, session, app } = setup();
    reveal(); controls.close(); chooser.reset();
    world.boss = null; world.factions[0].alive = true; session.screen = 'title'; update();
    expect(session.campChoiceOpen).toBe(false);
    session.screen = 'playing'; world.factions[0].alive = false; update();
    expect(session.campChoiceOpen).toBe(true); expect(app.takeBossCamp).not.toHaveBeenCalled();
    reveal(); expect(session.campChoiceOpen).toBe(true); expect(controls.picked).toBeNull();
  });

  it('shows a no-camps watch state without claiming or ending the encounter', () => {
    const { reveal, world, session, root, app } = setup();
    for (const faction of [1, 2, 3]) world.factions[faction].alive = false;
    reveal();
    expect(root.find('seats-empty')!.textContent).toContain('No surviving AI camps');
    expect(session.campChoiceOpen).toBe(true); expect(app.takeBossCamp).not.toHaveBeenCalled();
    expect(world.phase).toBe('playing');
  });

  it('includes online spectators but excludes reserved disconnected humans', () => {
    const { reveal, world, session, net, app, controls, update } = setup(true);
    net.lobby.seats[1].playerId = 'away';
    net.lobby.players.push({ id: 'away', connected: false, name: 'Away' });
    world.options.humans.push(1); reveal();
    expect(campChoices(app, world)).toEqual([2, 3]);
    controls.close(); session.spectator = true; net.seat = null; update();
    expect(campChoices(app, world)).toEqual([2, 3]); expect(session.campChoiceOpen).toBe(false);
    expect(net.setSeat).not.toHaveBeenCalled();
  });

  it('keeps old control/camera while pending, blocks double requests, and refreshes a race rejection', () => {
    const { controls, reveal, session, net, app, update, root } = setup(true);
    reveal(); session.camera.yaw = 1.23; controls.pick(1); controls.take(); controls.take();
    expect(app.takeBossCamp).toHaveBeenCalledTimes(1); expect(session.playerFaction).toBe(0);
    expect(session.camera.yaw).toBe(1.23); expect(controls.confirmBtn.disabled).toBe(true);
    net.lobby.seats[1].playerId = 'racer'; net.pendingBossTakeover = null; net.bossTakeoverError = 'Another player claimed that camp.'; update();
    expect(controls.picked).toBeNull(); expect(controls.pending).toBeNull();
    expect(root.find('seats-note')!.textContent).toContain('Another player');
    expect(controls.rows[1].root.getClientRects()).toEqual([]);
    controls.pick(2); controls.take(); expect(app.takeBossCamp).toHaveBeenLastCalledWith(2);
    expect(net.setSeat).not.toHaveBeenCalled();
  });

  it('revalidates a camp that falls between selection and confirmation', () => {
    const { controls, reveal, world, app, session } = setup();
    reveal(); controls.pick(1); world.factions[1].alive = false; controls.take();
    expect(app.takeBossCamp).not.toHaveBeenCalled(); expect(session.playerFaction).toBe(0);
    expect(controls.picked).toBeNull(); expect(controls.note.textContent).toContain('no longer available');
  });

  it('preserves a paused game and keyboard navigation stays inside the chooser', () => {
    const { controls, reveal, chooser, session, app } = setup();
    reveal(); controls.close(); session.screen = 'paused'; chooser.open(null);
    expect(session.screen).toBe('paused'); expect(app.setPaused).not.toHaveBeenCalled();
    const ev = { key: 'Tab', shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    controls.onKey(ev); expect(ev.preventDefault).toHaveBeenCalled();
    expect(controls.root.contains(document.activeElement)).toBe(true);
    controls.pick(3); controls.take(); expect(session.screen).toBe('paused');
  });

  it('routes controller confirm/back through the modal and keeps ownership when watching', () => {
    const { controls, reveal, pad, session, app } = setup(true);
    reveal();
    const input = new Input(new Node('canvas') as any);
    pad.buttons[0].pressed = true; input.pollGamepad(.016, false, false);
    expect(controls.picked).toBe(1);
    pad.buttons[0].pressed = false; input.pollGamepad(.016, false, false);
    pad.buttons[1].pressed = true; input.pollGamepad(.016, false, false);
    expect(controls.picked).toBeNull(); expect(session.campChoiceOpen).toBe(true);
    pad.buttons[1].pressed = false; input.pollGamepad(.016, false, false);
    pad.buttons[1].pressed = true; input.pollGamepad(.016, false, false);
    expect(session.campChoiceOpen).toBe(false); expect(app.net.seat).toBe(0);
    expect(app.net.setSeat).not.toHaveBeenCalled();
  });
});
