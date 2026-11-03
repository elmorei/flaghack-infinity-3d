/** Presentation only: authoritative banner events, with no simulation/input-mode changes. */
import type { BannerSpec } from './core';
import { el, html, setText, show } from './dom';

export interface MobileAnnouncementContext {
  /** Menus and table play own the screen; expiry continues while hidden. */
  visible(): boolean;
  reducedMotion?(): boolean;
}
interface Pending { spec: BannerSpec; at: number }
const MAX_QUEUE = 4;
const MAX_AGE_MS = 12000;

export class MobileAnnouncements {
  readonly element: HTMLElement;
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private panel: HTMLElement | null = null;
  private shown: HTMLElement | null = null;
  private ghost: HTMLElement | null = null;
  private advance: HTMLButtonElement | null = null;
  private text = '';
  private revealed = 0;
  private started = 0;
  private until = 0;
  private now = 0;
  private lastClick = -Infinity;

  constructor(parent: HTMLElement, private context: MobileAnnouncementContext) {
    this.element = el('div', 'mobile-announcements is-off', parent);
  }
  push(spec: BannerSpec): void {
    const at = performance.now();
    if (spec.urgent) this.reset();
    else {
      // Repeated events remain in the compact feed; do not repeat the same dialogue.
      if (this.current?.spec.title === spec.title && this.current.spec.sub === spec.sub) return;
      if (this.queue.some(p => p.spec.title === spec.title && p.spec.sub === spec.sub)) return;
      if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    }
    this.queue.push({ spec, at });
  }
  reset(): void {
    this.queue.length = 0;
    this.lastClick = -Infinity;
    this.clearCurrent();
    show(this.element, false);
  }
  private clearCurrent(): void {
    this.panel?.remove(); this.panel = null; this.current = null;
    this.shown = this.ghost = null; this.advance = null;
  }
  update(now: number): void {
    this.now = now;
    if (this.current && now >= this.until) this.clearCurrent();
    this.queue = this.queue.filter(p => now - p.at < (p.spec.urgent ? (p.spec.dur ?? 3) * 1000 : MAX_AGE_MS));
    const visible = this.context.visible();
    show(this.element, visible && (!!this.current || this.queue.length > 0));
    this.element.setAttribute('aria-hidden', String(!visible));
    this.element.inert = !visible;
    if (!visible) return;
    if (!this.current) {
      const next = this.queue.shift();
      if (next) this.open(next, now);
    }
    if (!this.current) { show(this.element, false); return; }
    this.reveal(this.context.reducedMotion?.() ? this.text.length : Math.max(this.revealed, Math.floor((now - this.started) * .036)));
  }
  private open(next: Pending, now: number): void {
    this.current = next;
    const b = next.spec;
    this.started = now; this.revealed = 0;
    this.text = b.sub ?? '';
    // An urgent dawn result must finish before the existing end-screen deadline.
    this.until = b.urgent ? next.at + (b.dur ?? 3) * 1000 : now + Math.max((b.dur ?? 3) * 1000, Math.min(10000, 4000 + this.text.length * 35));
    const panel = this.panel = el('section', `mp-dialogue ix tone-${b.tone}`, this.element);
    panel.setAttribute('aria-label', 'Match announcement');
    if (b.color) panel.style.setProperty('--accent', b.color);
    const portrait = html('div', 'mp-portrait', '<svg viewBox="0 0 24 24" shape-rendering="crispEdges" aria-hidden="true"><path fill="#26384a" d="M0 0h24v24H0z"/><path fill="#f7e8ba" d="M6 4h2v17H6zM4 21h6v2H4z"/><path fill="#efbd50" d="M8 4h12v8H8z"/><path fill="#b98032" d="M8 12h12v2H8z"/><path fill="#91b5b5" d="M14 18h2v2h-2zM18 20h2v2h-2z"/></svg>', panel);
    portrait.setAttribute('aria-hidden', 'true');
    const copy = el('div', 'mp-copy', panel);
    el('div', 'mp-speaker', copy, 'SURVEY');
    const accessible = el('div', 'mp-announcement-accessible', copy, `${b.title}. ${this.text}`);
    accessible.setAttribute('role', 'status'); accessible.setAttribute('aria-live', 'polite'); accessible.setAttribute('aria-atomic', 'true');
    const title = el('div', 'mp-title', copy, b.title); title.setAttribute('aria-hidden', 'true');
    const body = el('div', 'mp-text', copy); body.setAttribute('aria-hidden', 'true');
    this.shown = el('span', 'mp-revealed', body);
    this.ghost = el('span', 'mp-ghost', body, this.text);
    const actions = el('div', 'mp-actions', copy);
    this.advance = el('button', 'mp-advance', actions, 'Reveal'); this.advance.type = 'button';
    this.advance.addEventListener('click', e => {
      e.stopPropagation();
      if (!this.context.visible() || this.current !== next) return;
      // A double tap must not reveal, dismiss, then accidentally dismiss a new event.
      if (this.now - this.lastClick < 250) return;
      this.lastClick = this.now;
      if (this.revealed < this.text.length) this.reveal(this.text.length);
      else { this.clearCurrent(); this.update(this.now); }
    });
    const close = el('button', 'mp-close', actions, 'Close'); close.type = 'button';
    close.setAttribute('aria-label', 'Close announcements');
    close.addEventListener('click', e => {
      e.stopPropagation();
      if (this.current === next && this.context.visible()) this.reset();
    });
    // Consume only touches inside the card, never a full-screen input blocker.
    panel.addEventListener('pointerdown', e => e.stopPropagation());
  }
  private reveal(count: number): void {
    this.revealed = Math.min(count, this.text.length);
    if (this.shown) setText(this.shown, this.text.slice(0, this.revealed));
    if (this.ghost) setText(this.ghost, this.text.slice(this.revealed));
    if (this.advance) setText(this.advance, this.revealed < this.text.length ? 'Reveal' : this.queue.length ? 'Next ▸' : 'Continue ▸');
  }
  dispose(): void { this.reset(); this.element.remove(); }
}
