import { afterEach, describe, expect, it, vi } from 'vitest';
import { LobbyScreen } from './lobby';
import { Session } from '../game/session';
import { deviceLayout } from '../startup/device';
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

function setup(online = false, mobile = false) {
  const root = new Node();
  vi.stubGlobal('HTMLElement', Node);
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { createElement: (tag: string) => new Node(tag), activeElement: null, documentElement: { dataset: { deviceLayout: mobile ? 'mobile' : 'desktop' } } });
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
describe('automatic device play style', () => {
  it.each([true, false])('removes the selector and assigns only the local human (mobile=%s)', mobile => {
    const { ui, app, controls } = setup(false, mobile);
    expect(controls.controlMode).toBeUndefined();
    expect(JSON.stringify(controls.root.children, (key, value) => key === 'parentElement' ? undefined : value)).not.toContain('Your play style');
    // A stale former selector value cannot override the current resolved device layout.
    controls.localControlMode = mobile ? 'avatar' : 'rts';
    controls.start.click();
    expect(app.startMatch.mock.calls[0][0].rtsFactions).toEqual(mobile ? [0] : []);
    controls.seats[2].action.click(); ui.update(null, 1); controls.start.click();
    expect(app.startMatch.mock.calls[1][0].humans).toEqual([2]);
    expect(app.startMatch.mock.calls[1][0].rtsFactions).toEqual(mobile ? [2] : []);
    ui.dispose();
  });
  it.each([
    ['https://game.test/?view=desktop', 'Android', false],
    ['https://game.test/?view=mobile', 'Windows NT', true],
    ['https://game.test/', 'Windows NT', false],
  ] as const)('honors resolved view %s instead of narrow screen size', (url, userAgent, mobile) => {
    const resolved = deviceLayout({ url, userAgent, width: 390, height: 844, maxTouchPoints: 10, coarsePointer: true });
    const { ui, app, controls } = setup(false, resolved === 'mobile');
    controls.start.click();
    expect(app.startMatch.mock.calls[0][0].rtsFactions).toEqual(mobile ? [0] : []);
    ui.dispose();
  });
  it('leaves each online seat to its own handshake, without applying the host layout globally', () => {
    const { ui, net, controls } = setup(true, true);
    net.lobby.players.push({ id: 'pc', name: 'PC', seat: 1, ready: false, connected: true, controlMode: 'avatar' });
    net.lobby.seats[1].playerId = 'pc';
    net.lobby.players[0].controlMode = 'rts'; net.version++; ui.update(null, 1);
    expect(controls.seats[0].occupant.textContent).toBe('Player · Degen');
    expect(controls.seats[1].occupant.textContent).toBe('PC');
    expect(net.setControlMode).not.toHaveBeenCalled();
    expect(controls.controlMode).toBeUndefined();
    ui.dispose();
  });
});
