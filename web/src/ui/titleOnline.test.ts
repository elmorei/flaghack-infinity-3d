import { afterEach, describe, expect, it, vi } from 'vitest';
import { TitleScreen } from './title';
import { Session } from '../game/session';
import type { UiHost } from './core';
import { PROTOCOL_VERSION } from '../net/protocol';
import { BUILD_ID } from '../net/build';

class Node {
  className = ''; textContent = ''; innerHTML = ''; type = ''; value = ''; href = ''; rel = ''; target = ''; focused = false;
  children: Node[] = []; parentElement: Node | null = null;
  dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  listeners = new Map<string, (event: any) => void>();
  classList = { contains: (name: string) => this.className.split(' ').includes(name), toggle: (name: string, on: boolean) => { const classes = new Set(this.className.split(' ').filter(Boolean)); if (on) classes.add(name); else classes.delete(name); this.className = [...classes].join(' '); } };
  constructor(readonly tagName = 'div') {}
  appendChild(node: Node) { node.parentElement = this; this.children.push(node); return node; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  addEventListener(name: string, listener: (event: any) => void) { this.listeners.set(name, listener); }
  click() { this.listeners.get('click')?.({ detail: 0, stopPropagation() {} }); }
  input(value: string) { this.value = value; this.listeners.get('input')?.({}); }
  key(key: string) { this.listeners.get('keydown')?.({ key, preventDefault() {} }); }
  focus() { this.focused = true; } blur() { this.focused = false; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
}
const all = (node: Node): Node[] => [node, ...node.children.flatMap(all)];
const text = (node: Node): string => [node.textContent, node.innerHTML.replace(/<[^>]*>/g, ''), ...node.children.map(text)].join(' ').trim();
const visible = (node: Node): boolean => !node.classList.contains('is-off') && (!node.parentElement || visible(node.parentElement));
function setup(invite = false, hosted = false, remote = true) {
  vi.stubGlobal('document', { createElement: (tag: string) => new Node(tag), documentElement: { dataset: { deviceLayout: 'mobile' } } });
  vi.stubGlobal('location', { protocol: 'https:', origin: 'https://pages.example', href: 'https://pages.example/game/?other=1#host=invite', reload: vi.fn() });
  const store = { getItem: vi.fn(() => ''), setItem: vi.fn() }; vi.stubGlobal('localStorage', store);
  const root = new Node(), session = new Session(); session.screen = 'title';
  const app: any = { session, remoteHostsAvailable: remote, hostInfo: hosted ? { serverName: 'Our burn', protocol: PROTOCOL_VERSION, build: BUILD_ID, instanceId: 'abc', phase: 'lobby', players: 0, seated: 0 } : null, inviteHost: invite ? 'https://remote.example' : null, invitePassword: invite ? 'invite-secret' : null, joiningHost: false, joinError: null, net: null };
  app.joinHost = vi.fn(async () => { app.joiningHost = true; });
  app.cancelJoin = vi.fn(() => { app.joiningHost = false; app.joinError = null; });
  app.openLobby = vi.fn(() => { app.cancelJoin(); session.screen = 'lobby'; });
  app.startTutorial = vi.fn(() => { app.cancelJoin(); session.screen = 'playing'; });
  const host = { app, veiledLoad: (fn: () => void) => fn() } as unknown as UiHost;
  const screen = new TitleScreen(host, root as unknown as HTMLElement);
  const update = () => screen.update(null, 0); update();
  const fields = all(root).filter(node => node.tagName === 'input');
  const button = (name: string) => all(root).find(node => node.tagName === 'button' && text(node) === name)!;
  const status = () => text(all(root).find(node => node.classList.contains('join-status-t'))!);
  return { root, screen, app, fields, button, update, status, store };
}
afterEach(() => vi.unstubAllGlobals());

describe('Pages Join screen', () => {
  it('preserves the offline launcher solo-first title with no Join or dead download link', () => {
    const { app, root, button, fields } = setup(true, false, false);
    expect(visible(button('Join the burn'))).toBe(false);
    expect(visible(button('Begin the Survey'))).toBe(true);
    expect(button('Begin the Survey').classList.contains('btn-primary')).toBe(true);
    expect(all(root).find(node => node.classList.contains('title'))!.classList.contains('hosted')).toBe(false);
    expect(visible(all(root).find(node => node.classList.contains('quote'))!)).toBe(true);
    expect(all(root).filter(node => node.tagName === 'a')).toHaveLength(0);
    expect(text(root)).toContain('Offline edition');
    fields[1].input('Alice'); button('Join the burn').click(); expect(app.joinHost).not.toHaveBeenCalled();
    button('Begin the Survey').click(); expect(app.session.screen).toBe('lobby');
  });

  it('keeps solo and remote Join visible, with no automatic request for an invite', () => {
    const { app, fields, button, root } = setup(true);
    expect(visible(button('Join the burn'))).toBe(true); expect(visible(button('Begin the Survey'))).toBe(true);
    expect(fields.map(f => f.value)).toEqual(['https://remote.example', '', 'invite-secret']);
    expect(fields[2].type).toBe('password'); expect(app.joinHost).not.toHaveBeenCalled();
    const links = all(root).filter(node => node.tagName === 'a');
    expect(links.map(link => link.href)).toEqual(['https://pages.example/game/?other=1&view=mobile#host=invite', 'https://pages.example/game/?other=1&view=desktop#host=invite']);
    expect(links[0].getAttribute('aria-current')).toBe('page');
    expect(text(root)).not.toMatch(/Windows|launcher|standalone.*app/i);
  });
  it('requires handle/target, and never joins as a side effect of typing or pasting', () => {
    const { app, fields, button, status } = setup();
    button('Join the burn').click(); expect(status()).toMatch(/address or invite/); expect(app.joinHost).not.toHaveBeenCalled();
    fields[0].input('https://host.example'); button('Join the burn').click(); expect(status()).toMatch(/handle/);
    fields[1].input('Alice'); fields[2].input('pw'); expect(app.joinHost).not.toHaveBeenCalled();
    fields[2].key('Enter'); expect(app.joinHost).toHaveBeenCalledExactlyOnceWith('Alice', 'pw', 'https://host.example');
    button('Join the burn').click(); expect(app.joinHost).toHaveBeenCalledOnce();
  });
  it('keeps the actual error visible after repeated Join clicks', () => {
    const { app, fields, button, status, update } = setup(true);
    fields[1].input('Alice'); button('Join the burn').click(); button('Join the burn').click();
    app.joiningHost = false; app.joinError = 'Could not reach the host. Check CORS.'; update();
    expect(status()).toBe(app.joinError); expect(app.joinHost).toHaveBeenCalledOnce();
  });

  it('extracts pasted invite secrets into the masked field and only persists the handle', () => {
    const { app, fields, button, store } = setup();
    fields[0].input('https://pages.example/game/#host=https%3A%2F%2Fremote.example&pw=a%26b'); fields[1].input(' Alice ');
    button('Join the burn').click();
    expect(fields[0].value).toBe('https://remote.example'); expect(fields[2].value).toBe('a&b');
    expect(app.joinHost).toHaveBeenCalledExactlyOnceWith('Alice', 'a&b', 'https://remote.example');
    expect(store.setItem).toHaveBeenCalledExactlyOnceWith('fh.handle.v1', 'Alice');
  });
  it('explains insecure input and cancels edits, Escape, Cancel, solo, and disposal', () => {
    const { app, fields, button, status, update, screen } = setup();
    fields[0].input('http://remote.example'); fields[1].input('Alice'); button('Join the burn').click();
    expect(status()).toMatch(/mixed content/); expect(app.joinHost).not.toHaveBeenCalled();
    fields[0].input('https://remote.example'); button('Join the burn').click(); update(); expect(visible(button('Cancel'))).toBe(true);
    fields[1].input('Bob'); expect(app.joiningHost).toBe(false);
    button('Join the burn').click(); fields[2].key('Escape'); expect(app.joiningHost).toBe(false);
    button('Join the burn').click(); button('Cancel').click(); expect(app.joiningHost).toBe(false);
    button('Join the burn').click(); button('Begin the Survey').click(); update(); expect(app.joiningHost).toBe(false); expect(app.session.screen).toBe('lobby');
    screen.dispose(); expect(app.cancelJoin).toHaveBeenCalled();
  });
  it('preserves host-served defaults and displays build mismatch with a reload option', () => {
    const { app, fields, status, button, update } = setup(false, true);
    expect(fields[0].value).toBe('https://pages.example');
    app.joinError = 'The page and host use different game builds. Reload this page and update the hosting app to the same release.'; update();
    expect(status()).toMatch(/different game builds/); expect(visible(button('Reload'))).toBe(true);
  });
});
