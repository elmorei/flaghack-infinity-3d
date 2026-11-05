import { canPlaceBuilding } from '../sim/systems/buildings';
import type { Command } from '../sim/commands';
/** Mobile command chrome: the field stays clear; existing panels live in one full-screen menu. */
import type { Session } from '../game/session';
import { nearbyPickupTag } from '../game/cardPickup';
import type { BuildingKind } from '../sim/types';
import type { World } from '../sim/world';
import { MobilePowers, MOBILE_POWER_NAMES } from './mobilePowers';
import type { UiHost, UiLayout, UiPart } from './core';
import { button, el, setAttr, setClass, setText, setVar, show } from './dom';
import { MobileFieldStatus } from './mobileFieldStatus';
import { MobileAltarIndicators, type IndicatorViewport } from './mobileAltarIndicators';

type MobileTab = NonNullable<Session['mobileMenu']>;
/** Screen-space exclusion boxes belong to this game's root, including sibling overlays. */
export function mobileIndicatorReservedRects(field: HTMLElement): DOMRect[] {
  const controls = field.querySelectorAll<HTMLElement>('.mc-status-left, .mc-resources, .mc-modes, .mc-selected:not(.is-off), .mc-placement:not(.is-off), .mc-alert:not(.is-off), .mc-pickup:not(.is-off)');
  const dialogue = field.closest('.fh-root')?.querySelectorAll<HTMLElement>('.mobile-announcements:not(.is-off) .mp-dialogue') ?? [];
  return [...controls, ...dialogue].map(node => node.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
}

export function cancelMobileTarget(s: Session): void {
  s.tool = 'flag'; s.mobileBuildFacet = -1; s.mobileBuildConfirm = false;
  s.mobileAbility = null; s.mobileRitual = null; s.mobileBoxSelect = false; s.recruitTargeting = false;
  s.planPreview = []; s.planTool = s.mobileMode === 'build' ? 'node' : 'select';
  s.mobileCancelSerial++;
}
export function setMobileMode(s: Session, mode: Session['mobileMode']): void {
  cancelMobileTarget(s); s.mobileMode = mode; s.mobileMenu = null;
  s.planTool = mode === 'build' ? 'node' : 'select';
}
export function chooseMobileBuilding(s: Session, kind: BuildingKind, world: World, submit: (command: Command) => void): boolean {
  if (s.mobileBuildFacet < 0) return false;
  const facet = s.mobileBuildFacet, level = s.mobileBuildLevel;
  const check = canPlaceBuilding(world, s.playerFaction, kind, facet, level);
  if (!check.ok) { s.post(check.reason, 'warn'); return true; }
  // Consume the locked location before submitting so rapid duplicate taps cannot place twice.
  s.mobileMode = 'build'; s.buildingKind = kind; s.tool = 'flag'; s.mobileBuildFacet = -1;
  s.mobileMenu = null; s.mobileBuildConfirm = false; s.mobileCancelSerial++; s.ghost = null;
  submit({ t: 'placeBuilding', faction: s.playerFaction, kind, facet, ...(level ? { level } : {}) });
  return true;
}

export class MobileCommandUI implements UiPart {
  private root: HTMLElement;
  private field: HTMLElement;
  private menu: HTMLElement;
  private pages = new Map<MobileTab, HTMLElement>();
  private tabs = new Map<MobileTab, HTMLButtonElement>();
  private selected: HTMLElement;
  private selectionLabel: HTMLElement;
  private placement: HTMLElement;
  private placementLabel: HTMLElement;
  private cancel: HTMLButtonElement;
  private toast: HTMLElement;
  private pickup: HTMLElement;
  private modeButtons: HTMLButtonElement[];
  private buildHint: HTMLElement;
  private powers: MobilePowers;
  private switchMode: HTMLButtonElement;
  private lastOpen: MobileTab | null = null;
  private status: MobileFieldStatus;
  private statusHeader: HTMLElement;
  private altars: MobileAltarIndicators;
  private indicatorViewport: IndicatorViewport | null = null;

  constructor(private host: UiHost, layout: UiLayout, source: HTMLElement) {
    const s = host.app.session;
    this.root = el('div', 'mobile-command is-off');
    // Existing Settings/Codex/etc stay above this menu, not behind it.
    layout.overlay.prepend(this.root);
    this.field = el('div', 'mc-field', this.root);
    this.statusHeader = el('div', 'mc-status', this.field);
    const statusLeft = el('div', 'mc-status-left', this.statusHeader);
    const timing = el('div', 'mc-timing', statusLeft);
    timing.setAttribute('aria-label', 'Match time');
    const top = el('div', 'mc-top', statusLeft);
    button('btn ix', top, 'Menu', () => this.open('main'));
    const resources = el('section', 'mc-resources', this.statusHeader);
    resources.setAttribute('aria-label', 'Camp resources');
    this.toast = el('div', 'mc-alert is-off', this.field);
    this.toast.setAttribute('role', 'status');
    this.pickup = el('div', 'mc-pickup is-off', this.field);
    this.pickup.setAttribute('aria-label', 'Nearby pickups');
    this.selected = el('div', 'mc-selected ix is-off', this.field);
    this.selectionLabel = el('span', '', this.selected);
    button('btn', this.selected, 'Orders', () => this.open('units'));
    button('btn', this.selected, 'Clear', () => { s.selection.clear(); cancelMobileTarget(s); });
    this.placement = el('div', 'mc-placement ix is-off', this.field);
    this.placementLabel = el('div', 'mc-placement-label', this.placement);
    const placementActions = el('div', 'mc-actions', this.placement);
    this.cancel = button('btn', placementActions, 'Cancel', () => cancelMobileTarget(s));
    const modes = el('nav', 'mc-modes ix', this.field);
    modes.setAttribute('aria-label', 'Field mode');
    const degen = button('btn', modes, 'Degen', () => setMobileMode(s, 'units'));
    const home = button('btn mc-home', modes, '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5M5.5 9v12h5v-7h3v7h5V9"/></svg>', () => this.home());
    home.setAttribute('aria-label', 'Home'); home.title = 'Return to your camp';
    const plan = button('btn', modes, 'Plan', () => setMobileMode(s, 'build'));
    this.modeButtons = [degen, plan];
    this.altars = new MobileAltarIndicators(this.field);

    this.menu = el('section', 'mc-menu ix is-off', this.root);
    this.menu.setAttribute('role', 'dialog');
    this.menu.setAttribute('aria-label', 'Command menu');
    this.menu.setAttribute('aria-modal', 'true');
    const header = el('header', 'mc-menu-head', this.menu);
    el('h2', '', header, 'Command');
    button('btn', header, 'Back to field', () => this.close());
    const nav = el('nav', 'mc-tabs', this.menu);
    nav.setAttribute('aria-label', 'Command sections');
    for (const [id, label] of [['main', 'Overview'], ['units', 'Units'], ['plan', 'Plan'], ['build', 'Build'], ['powers', 'Powers'], ['settings', 'Settings']] as const) {
      const tab = button('btn', nav, label, () => this.open(id));
      this.tabs.set(id, tab);
      const page = el('div', 'mc-page is-off', this.menu);
      page.dataset.tab = id; this.pages.set(id, page);
    }
    const move = (selector: string, tab: MobileTab) => {
      const node = source.querySelector<HTMLElement>(selector);
      if (node) this.pages.get(tab)!.appendChild(node);
    };
    for (const selector of ['.cmi', '.rail', '.gcc-panel', '.feed', '.netpill']) move(selector, 'main');
    this.status = new MobileFieldStatus(source, resources, timing, this.pages.get('main')!);
    // Network loss must remain visible even when all normal HUD panels are tucked away.
    const reconnect = source.querySelector<HTMLElement>('.reconnect-card');
    if (reconnect) layout.overlay.appendChild(reconnect);
    for (const selector of ['.panel-sel', '.roster', '.panel-prio', '.scenery-benefit']) move(selector, 'units');
    move('.panel-plan', 'plan');
    this.buildHint = el('p', 'mc-hint', this.pages.get('build')!, 'Switch to Plan, then long-press the center of a buildable space to choose what goes there.');
    move('.panel-build', 'build'); move('.panel-labs', 'build');
    const units = this.pages.get('units')!;
    const selectActions = el('div', 'mc-actions', units);
    button('btn', selectActions, 'Select all units', () => {
      s.selection.clear();
      for (const h of host.app.world?.hippies.values() ?? []) if (h.faction === s.playerFaction && h.koUntil <= (host.app.world?.time ?? 0)) s.selection.add(h.id);
      setMobileMode(s, 'units');
    });
    button('btn', selectActions, 'Box select', () => {
      setMobileMode(s, 'units'); s.mobileBoxSelect = true;
    });
    this.powers = new MobilePowers(host, this.pages.get('powers')!);
    move('.abar', 'powers');
    const settings = this.pages.get('settings')!;
    this.switchMode = button('btn', settings, 'Switch control mode', () => {
      const world = host.app.world; if (!world) return;
      if (host.app.setControlMode?.(world.factions[s.playerFaction].controlMode === 'rts' ? 'avatar' : 'rts')) this.close();
    });
    this.switchMode.title = 'Switch between Regular and Degen. Mode-specific spell upgrades refund their Ritual costs.';
    button('btn', settings, 'Game settings', () => { s.panels.settings = true; s.mobileCancelSerial++; });
    button('btn', settings, 'Help', () => { s.panels.help = true; s.mobileCancelSerial++; });
    button('btn', settings, 'Liber HH', () => { s.panels.codex = true; s.mobileCancelSerial++; });
    const align = button('btn mc-avatar-only', settings, 'Chakras', () => { s.panels.chakras = true; s.mobileCancelSerial++; });
    align.title = 'Ritual alignment requires a roaming vexillomancer.';
    button('btn', settings, 'Leave game', () => { this.close(); host.app.setPaused(true); });
    el('p', 'mc-hint', settings, 'The match keeps running while command menus are open. Drag the field to pan. Camera angle and zoom stay fixed.');

    // Focus/select actions return to the field after their existing handlers run.
    this.menu.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('.rr')) queueMicrotask(() => this.close());
    }, true);
    // UI scrolling and pointer gestures never become field camera gestures.
    for (const event of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel']) {
      this.menu.addEventListener(event, e => e.stopPropagation());
    }
  }

  private open(tab: MobileTab): void {
    const s = this.host.app.session;
    if (s.mobileMenu !== tab) s.mobileCancelSerial++;
    s.mobileMenu = tab; s.mobileBuildConfirm = false;
    s.mobileAbility = null; s.mobileRitual = null; s.mobileBoxSelect = false;
  }
  private close(): void {
    const s = this.host.app.session;
    s.mobileMenu = null; s.mobileBuildConfirm = false; s.mobileCancelSerial++;
    if (s.tool !== 'building') s.mobileBuildFacet = -1;
  }
  private home(): void {
    const w = this.host.app.world, s = this.host.app.session;
    if (!w) return;
    s.mobileAbility = null; s.mobileRitual = null;
    for (const id of w.factions[s.playerFaction].hearthIds) {
      const b = w.buildings.get(id);
      if (b && b.faction === s.playerFaction) { s.camera.cmdX = b.pos.x; s.camera.cmdZ = b.pos.z; break; }
    }
    s.mobileCancelSerial++;
  }

  update(world: World | null, now: number): void {
    const s = this.host.app.session;
    const active = !!world && s.screen === 'playing' && s.view === 'command' && !s.spectator && world.factions[s.playerFaction].alive;
    show(this.root, active);
    if (!active || !world) { this.status.restoreOriginal(); this.indicatorViewport = null; this.altars.hide(); return; }
    const pickup = s.tool === 'building' ? null : nearbyPickupTag(world, s.playerFaction, s.hover.entity);
    setText(this.pickup, pickup ?? ''); show(this.pickup, !!pickup);
    const nested = s.panels.settings || s.panels.help || s.panels.codex || s.panels.chakras || s.campChoiceOpen;
    const open = s.mobileMenu !== null;
    this.status.setField(!open && !nested);
    show(this.menu, open && !nested); show(this.field, !open && !nested);
    this.menu.inert = nested;
    for (const [id, page] of this.pages) {
      show(page, s.mobileMenu === id);
      setAttr(this.tabs.get(id)!, 'aria-pressed', String(s.mobileMenu === id));
    }
    if (s.mobileMenu !== this.lastOpen) {
      this.pages.get(s.mobileMenu!)?.scrollTo?.(0, 0);
      this.lastOpen = s.mobileMenu;
    }
    setAttr(this.modeButtons[0], 'aria-pressed', String(s.mobileMode === 'units'));
    setAttr(this.modeButtons[1], 'aria-pressed', String(s.mobileMode === 'build'));
    const selected = s.selection.size;
    show(this.selected, selected > 0 && s.mobileBuildFacet < 0 && !s.mobileAbility && !s.mobileRitual && !s.mobileBoxSelect);
    setText(this.selectionLabel, `${selected} selected`);
    const preview = s.mobileBuildFacet >= 0 && s.tool === 'building';
    const targeting = preview || !!s.mobileAbility || !!s.mobileRitual || s.mobileBoxSelect || s.recruitTargeting || (s.planTool !== 'select' && s.planTool !== 'node');
    show(this.placement, targeting);
    setText(this.placementLabel, preview
      ? (s.ghost?.valid ? 'Choose a building from the menu.' : s.ghost?.reason || 'Checking placement…')
      : (s.mobileAbility || s.mobileRitual) ? `Tap the field for ${MOBILE_POWER_NAMES[(s.mobileAbility || s.mobileRitual)!]}.`
      : s.mobileBoxSelect ? 'Drag a box around your units.'
      : s.recruitTargeting ? 'Tap a neutral Signifier to recruit.' : 'Tap the field to set this plan.');
    setText(this.buildHint, s.mobileBuildFacet >= 0 ? 'Choose a building to start construction here immediately. Grey choices are unavailable.' : 'Switch to Plan, then long-press the center of a buildable space to choose what goes there.');
    setClass(this.root, 'mc-rts', world.factions[s.playerFaction].controlMode === 'rts');
    this.powers.update(world);
    setText(this.switchMode, world.factions[s.playerFaction].controlMode === 'rts' ? 'Switch to Regular (Avatar)' : 'Switch to Degen (RTS)');
    this.switchMode.disabled = !this.host.app.setControlMode;
    const alert = [...s.feed].reverse().find(x => ['warn', 'danger', 'epic'].includes(x.severity) && now - x.at < 5000);
    show(this.toast, !!alert);
    if (alert) setText(this.toast, alert.text);
    if (!open && !nested) {
      setVar(this.field, '--mc-status-bottom', `${this.statusHeader.getBoundingClientRect().bottom + 8}px`);
      const reserved = mobileIndicatorReservedRects(this.field);
      const style = getComputedStyle(this.field);
      const inset = Math.max(20, ...[style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(v => (parseFloat(v) || 0) + 13));
      this.indicatorViewport = { width: window.innerWidth, height: window.innerHeight, reserved, inset };
    } else { this.indicatorViewport = null; this.altars.hide(); }
  }

  /** Camera bearings refresh after every rendered frame, not the slower text HUD tick. */
  frame(): void {
    const { world, session: s, renderer } = this.host.app;
    if (!world || !this.indicatorViewport || s.screen !== 'playing' || s.view !== 'command' ||
      s.spectator || !world.factions[s.playerFaction].alive || s.mobileMenu !== null ||
      s.panels.settings || s.panels.help || s.panels.codex || s.panels.chakras || s.campChoiceOpen) {
      this.altars.hide(); return;
    }
    // Avoid one stale-layout frame during rotation; the next HUD tick measures the new safe bounds.
    if (this.indicatorViewport.width !== window.innerWidth || this.indicatorViewport.height !== window.innerHeight) { this.altars.hide(); return; }
    this.altars.update(world, renderer.camera, s.playerFaction, this.indicatorViewport);
  }

  reset(): void {
    const s = this.host.app.session;
    s.mobileMenu = null; setMobileMode(s, 'units');
  }
  dispose(): void { this.status.restoreOriginal(); this.altars.dispose(); this.root.remove(); }
}
