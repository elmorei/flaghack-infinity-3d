import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileAnnouncements } from './mobileAnnouncements';
import { Banners } from './banners';
import type { World } from '../sim/world';
class Node {
  className = ''; textContent = ''; innerHTML = ''; type = ''; inert = false;
  children: Node[] = []; parentElement: Node | null = null;
  attributes = new Map<string, string>(); listeners = new Map<string, (event: { stopPropagation(): void }) => void>();
  style = { setProperty: vi.fn() };
  classList = {
    contains: (key: string) => this.className.split(' ').includes(key),
    add: (key: string) => this.classList.toggle(key, true),
    toggle: (key: string, on: boolean) => { const c = new Set(this.className.split(' ').filter(Boolean)); if (on) c.add(key); else c.delete(key); this.className = [...c].join(' '); },
  };
  appendChild(node: Node) { node.parentElement = this; this.children.push(node); return node; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key); }
  addEventListener(type: string, callback: (event: { stopPropagation(): void }) => void) { this.listeners.set(type, callback); }
  click() { this.listeners.get('click')?.({ stopPropagation() {} }); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); }
}
function find(node: Node, cls: string): Node | undefined {
  if (node.classList.contains(cls)) return node;
  for (const child of node.children) { const result = find(child, cls); if (result) return result; }
}
function setup() {
  vi.stubGlobal('document', { createElement: () => new Node() });
  let now = 0; vi.stubGlobal('performance', { now: () => now });
  let visible = true, reduced = false;
  const root = new Node();
  const context = { visible: () => visible, reducedMotion: () => reduced };
  const ui = new MobileAnnouncements(root as unknown as HTMLElement, context);
  const tick = (time: number) => { now = time; ui.update(time); };
  const push = (title = 'PHASON TIDE', sub = 'The Crystal turns', urgent = false, dur?: number) => ui.push({ title, sub, urgent, dur, tone: 'tide' });
  return { root, ui, context, tick, push, get: (cls: string) => find(root, cls)!, visible: (v: boolean) => { visible = v; }, reduced: () => { reduced = true; } };
}
afterEach(() => vi.unstubAllGlobals());
describe('mobile announcements', () => {
  it('reveals text once then advances, guards rapid taps and stale buttons', () => {
    const f = setup(); f.push(); f.push('THE BURN', 'Sudden death'); f.tick(0);
    const old = f.get('mp-advance'), oldClose = f.get('mp-close'); expect(f.get('mp-revealed').textContent).toBe('');
    old.click(); expect(f.get('mp-revealed').textContent).toBe('The Crystal turns');
    old.click(); expect(f.get('mp-title').textContent).toBe('PHASON TIDE');
    f.tick(300); old.click(); expect(f.get('mp-title').textContent).toBe('THE BURN');
    old.click(); oldClose.click(); expect(f.get('mp-title').textContent).toBe('THE BURN');
    f.get('mp-advance').click(); expect(f.get('mp-revealed').textContent).toBe('');
    f.tick(600); f.get('mp-advance').click(); expect(f.get('mp-revealed').textContent).toBe('Sudden death');
  });
  it('shows full text immediately for reduced motion without live-region typewriter spam', () => {
    const f = setup(); f.reduced(); f.push(); f.tick(0);
    expect(f.get('mp-revealed').textContent).toBe('The Crystal turns');
    expect(f.get('mp-announcement-accessible').textContent).toBe('PHASON TIDE. The Crystal turns');
    expect(f.get('mp-text').getAttribute('aria-hidden')).toBe('true');
  });
  it('bounds and deduplicates the queue and Close dismisses pending notices', () => {
    const f = setup(); f.push('Current'); f.tick(0);
    for (let i = 0; i < 8; i++) f.push(`Event ${i}`);
    f.push('Event 7'); f.reduced(); f.tick(1); f.get('mp-advance').click();
    expect(f.get('mp-title').textContent).toBe('Event 4');
    f.get('mp-close').click(); f.tick(500); expect(find(f.root, 'mp-dialogue')).toBeUndefined();
  });
  it('hides and disables in menus while allowing old notices to expire', () => {
    const f = setup(); f.push(); f.tick(0); f.visible(false); f.tick(1000);
    expect(f.get('mobile-announcements').inert).toBe(true);
    expect(f.get('mobile-announcements').classList.contains('is-off')).toBe(true);
    f.get('mp-advance').click(); expect(f.get('mp-revealed').textContent).toBe('');
    f.push('Hidden event'); f.tick(15000); f.visible(true); f.tick(15100);
    expect(find(f.root, 'mp-dialogue')).toBeUndefined();
  });
  it('urgent results replace old events and keep their original deadline even hidden', () => {
    const f = setup(); f.push('Old'); f.tick(0); f.push('Queued');
    f.push('DAWN', 'The match ends', true, 3.6); f.tick(100);
    expect(f.get('mp-title').textContent).toBe('DAWN');
    f.tick(3599); expect(f.get('mp-title').textContent).toBe('DAWN');
    f.tick(3600); expect(find(f.root, 'mp-dialogue')).toBeUndefined();
    f.visible(false); f.push('DAWN', 'End', true, 3.6); f.tick(8000); f.visible(true); f.tick(8001);
    expect(find(f.root, 'mp-dialogue')).toBeUndefined();
  });
  it('reset clears the whole previous world; disposal removes the layer', () => {
    const f = setup(); f.push(); f.tick(0); f.push('Queued'); f.ui.reset(); f.tick(100);
    expect(find(f.root, 'mp-dialogue')).toBeUndefined(); f.ui.dispose(); expect(f.root.children).toEqual([]);
  });
  it('routes only explicitly mobile banners and clears on world detach', () => {
    const f = setup(); f.ui.dispose();
    const banners = new Banners(f.root as unknown as HTMLElement, f.context);
    banners.push({ title: 'TIDE', tone: 'tide' }); banners.update({} as World, 0);
    expect(find(f.root, 'mp-title')?.textContent).toBe('TIDE');
    expect(find(f.root, 'banner-title')).toBeUndefined();
    banners.update(null, 100); expect(find(f.root, 'mp-dialogue')).toBeUndefined();
    banners.dispose(); expect(f.root.children).toEqual([]);
  });
  it('keeps the legacy desktop path, timing and markup intact', () => {
    const f = setup(); f.ui.dispose();
    const banners = new Banners(f.root as unknown as HTMLElement);
    banners.push({ title: 'DAWN', sub: 'Result', tone: 'dawn', dur: 3.6 });
    banners.update({} as World, 0);
    expect(find(f.root, 'banner-title')?.textContent).toBe('DAWN');
    expect(find(f.root, 'mobile-announcements')).toBeUndefined();
    banners.update({} as World, 3600); expect(find(f.root, 'banner')).toBeUndefined(); banners.dispose();
  });
});
