/**
 * Big centre banners for epic moments (Hearth contained, overwritten, Crystal manifested,
 * Phason Tide, The Burn, eliminations, chakra alignment). One at a time; a short queue keeps
 * simultaneous moments readable instead of stacking them.
 */
import type { World } from '../sim/world';
import type { BannerSpec, UiPart } from './core';
import { el } from './dom';
import { MobileAnnouncements, type MobileAnnouncementContext } from './mobileAnnouncements';

const MAX_QUEUE = 4;

export class Banners implements UiPart {
  private layer: HTMLElement;
  private mobile: MobileAnnouncements | null;
  private queue: BannerSpec[] = [];
  private current: HTMLElement | null = null;
  private currentUntil = 0;

  constructor(parent: HTMLElement, mobile?: MobileAnnouncementContext) {
    this.mobile = mobile ? new MobileAnnouncements(parent, mobile) : null;
    this.layer = el('div', 'banners', parent);
    if (mobile) this.layer.classList.add('is-off');
  }

  push(b: BannerSpec): void {
    if (this.mobile) { this.mobile.push(b); return; }
    if (b.urgent) {
      // The match is over: nothing queued earlier matters more, and the end screen is waiting.
      this.queue.length = 0;
      this.current?.remove();
      this.current = null;
    } else if (this.queue.length >= MAX_QUEUE) {
      // Under a flood (mass captures at The Burn) the oldest pending banner yields.
      this.queue.shift();
    }
    this.queue.push(b);
  }

  reset(_world: World): void {
    this.mobile?.reset();
    this.queue.length = 0;
    this.current?.remove();
    this.current = null;
  }

  update(_world: World | null, now: number): void {
    if (this.mobile) {
      if (!_world) this.mobile.reset();
      else this.mobile.update(now);
      return;
    }
    if (this.current && now >= this.currentUntil) {
      this.current.remove();
      this.current = null;
    }
    if (this.current) return;
    const b = this.queue.shift();
    if (!b) return;
    const dur = b.dur ?? 3;
    const node = el('div', `banner tone-${b.tone}`, this.layer);
    node.style.setProperty('--dur', `${dur}s`);
    if (b.color) node.style.setProperty('--accent', b.color);
    el('div', 'banner-rule', node);
    el('div', 'banner-title', node, b.title);
    if (b.sub) el('div', 'banner-sub', node, b.sub);
    el('div', 'banner-rule', node);
    this.current = node;
    this.currentUntil = now + dur * 1000;
  }

  dispose(): void {
    this.mobile?.dispose();
    this.layer.remove();
  }
}
