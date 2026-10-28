import { afterEach, describe, expect, it, vi } from 'vitest';
import { LobbyScreen } from './lobby';
import { Session } from '../game/session';
import type { UiHost } from './core';
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
  const root = new Node();
  vi.stubGlobal('HTMLElement', Node);
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { createElement: (tag: string) => new Node(tag), activeElement: null });
  const session = new Session(); session.screen = 'lobby';
  const net: any = online ? {
    status: 'lobby', version: 1, playerId: 'me', serverName: 'test', seat: 0, isLeader: true,
    notices: [], chat: [], reconnecting: false,
    lobby: { phase: 'lobby', leaderId: 'me', settings: { match: session.settings.match, difficulty: 'normal', seed: null },
      seats: [0,1,2,3].map(faction => ({ faction, playerId: faction === 0 ? 'me' : null })),
      players: [{ id: 'me', name: 'Player', seat: 0, ready: false, connected: true, controlMode: 'avatar' }] },
    setControlMode: vi.fn(), start: vi.fn(), setSettings: vi.fn(),
  } : null;
  const app: any = { session, net, world: null, startMatch: vi.fn() };
  const ui = new LobbyScreen({ app, veiledLoad: (fn: () => void) => fn() } as UiHost, root as any);
  ui.update(null, 0);
  return { ui, app, net, controls: ui as any };
}
afterEach(() => vi.unstubAllGlobals());
describe('RTS lobby selection', () => {
  it('starts local matches with only the selected RTS faction, preserves choice through updates, and permits switching back', () => {
    const { ui, app, controls } = setup();
    controls.controlMode.value = 'rts'; controls.controlMode.handlers.get('change')(); ui.update(null, 1);
    expect(controls.controlMode.value).toBe('rts'); controls.start.click();
    expect(app.startMatch.mock.calls[0][0].rtsFactions).toEqual([0]);
    controls.controlMode.value = 'avatar'; controls.controlMode.handlers.get('change')(); controls.start.click();
    expect(app.startMatch.mock.calls[1][0].rtsFactions).toEqual([]); ui.dispose();
  });
  it('sends own mode preference online and displays only host-acknowledged frozen mode', () => {
    const { ui, net, controls } = setup(true);
    controls.controlMode.value = 'rts'; controls.controlMode.handlers.get('change')();
    expect(net.setControlMode).toHaveBeenCalledWith('rts');
    net.lobby.players[0].controlMode = 'rts'; net.version++; ui.update(null, 1);
    expect(controls.controlMode.value).toBe('rts');
    net.lobby.phase = 'playing'; net.version++; ui.update(null, 2);
    expect(controls.controlMode.disabled).toBe(true); ui.dispose();
  });
});
