/** Mobile command chrome: the field stays clear; existing panels live in one full-screen menu. */
import type { Session } from '../game/session';
import { abilityBlocker } from '../sim/systems/abilities';
import { CHAKRAS } from '../sim/types';
import type { BuildingKind } from '../sim/types';
import type { World } from '../sim/world';
import { CHAKRA_INFO } from './catalog';
import type { UiHost, UiLayout, UiPart } from './core';
import { button, el, setAttr, setClass, setText, show } from './dom';

type MobileTab = NonNullable<Session['mobileMenu']>;
export function cancelMobileTarget(s: Session): void {
  s.tool = 'flag'; s.mobileBuildFacet = -1; s.mobileBuildConfirm = false;
  s.mobileAbility = null; s.mobileBoxSelect = false; s.recruitTargeting = false;
  s.planPreview = []; s.planTool = s.mobileMode === 'build' ? 'node' : 'select';
  s.mobileCancelSerial++;
}
export function setMobileMode(s: Session, mode: Session['mobileMode']): void {
  cancelMobileTarget(s); s.mobileMode = mode; s.mobileMenu = null;
  s.planTool = mode === 'build' ? 'node' : 'select';
}
export function chooseMobileBuilding(s: Session, kind: BuildingKind): boolean {
  if (s.mobileBuildFacet < 0) return false;
  s.mobileMode = 'build'; s.buildingKind = kind; s.tool = 'building';
  s.mobileMenu = null; s.mobileBuildConfirm = false; s.mobileCancelSerial++;
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
  private confirm: HTMLButtonElement;
  private cancel: HTMLButtonElement;
  private toast: HTMLElement;
  private modeButtons: HTMLButtonElement[];
  private buildHint: HTMLElement;
  private powers: HTMLElement;
  private abilities = new Map<string, HTMLButtonElement>();
  private lastOpen: MobileTab | null = null;

  constructor(private host: UiHost, layout: UiLayout, source: HTMLElement) {
    const s = host.app.session;
    this.root = el('div', 'mobile-command is-off');
    // Existing Settings/Codex/etc stay above this menu, not behind it.
    layout.overlay.prepend(this.root);
    this.field = el('div', 'mc-field', this.root);
    const top = el('div', 'mc-top', this.field);
    button('btn ix', top, 'Menu', () => this.open('main'));
    button('btn ix', top, 'Home', () => this.home());
    this.toast = el('div', 'mc-alert is-off', this.field);
    this.toast.setAttribute('role', 'status');
    this.selected = el('div', 'mc-selected ix is-off', this.field);
    this.selectionLabel = el('span', '', this.selected);
    button('btn', this.selected, 'Orders', () => this.open('units'));
    button('btn', this.selected, 'Clear', () => { s.selection.clear(); cancelMobileTarget(s); });
    this.placement = el('div', 'mc-placement ix is-off', this.field);
    this.placementLabel = el('div', 'mc-placement-label', this.placement);
    const placementActions = el('div', 'mc-actions', this.placement);
    this.confirm = button('btn btn-primary', placementActions, 'Confirm', () => { s.mobileBuildConfirm = true; });
    this.cancel = button('btn', placementActions, 'Cancel', () => cancelMobileTarget(s));
    const modes = el('nav', 'mc-modes ix', this.field);
    modes.setAttribute('aria-label', 'Field mode');
    this.modeButtons = [
      button('btn', modes, 'Degen', () => setMobileMode(s, 'units')),
      button('btn', modes, 'Plan', () => setMobileMode(s, 'build')),
    ];

    this.menu = el('section', 'mc-menu ix is-off', this.root);
    this.menu.setAttribute('role', 'dialog');
    this.menu.setAttribute('aria-label', 'Command menu');
    this.menu.setAttribute('aria-modal', 'true');
    const header = el('header', 'mc-menu-head', this.menu);
    el('h2', '', header, 'Command');
    button('btn', header, 'Back to field', () => this.close());
    const nav = el('nav', 'mc-tabs', this.menu);
    nav.setAttribute('aria-label', 'Command sections');
    for (const [id, label] of [['main', 'Overview'], ['units', 'Units'], ['plan', 'Plan'], ['build', 'Build'], ['settings', 'Settings']] as const) {
      const tab = button('btn', nav, label, () => this.open(id));
      this.tabs.set(id, tab);
      const page = el('div', 'mc-page is-off', this.menu);
      page.dataset.tab = id; this.pages.set(id, page);
    }
    const move = (selector: string, tab: MobileTab) => {
      const node = source.querySelector<HTMLElement>(selector);
      if (node) this.pages.get(tab)!.appendChild(node);
    };
    for (const selector of ['.res', '.clock', '.cmi', '.rail', '.gcc-panel', '.feed', '.netpill']) move(selector, 'main');
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
    this.powers = el('section', 'mc-powers', this.pages.get('plan')!);
    el('h3', '', this.powers, 'Powers');
    const powerButtons = el('div', 'mc-power-buttons', this.powers);
    for (const chakra of CHAKRAS) {
      const info = CHAKRA_INFO[chakra];
      const b = button('btn', powerButtons, info.abilityName, () => {
        const w = host.app.world;
        const why = w ? abilityBlocker(w, s.playerFaction, info.ability) : 'No burn in progress.';
        if (why) { host.blocked(why); return; }
        cancelMobileTarget(s); s.mobileAbility = info.ability; this.close();
      });
      this.abilities.set(chakra, b);
    }
    // Drug use and ritual details remain reachable for avatar factions; RTS cannot use them.
    move('.abar', 'plan');
    const settings = this.pages.get('settings')!;
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
    s.mobileAbility = null; s.mobileBoxSelect = false;
  }
  private close(): void {
    const s = this.host.app.session;
    s.mobileMenu = null; s.mobileBuildConfirm = false; s.mobileCancelSerial++;
    if (s.tool !== 'building') s.mobileBuildFacet = -1;
  }
  private home(): void {
    const w = this.host.app.world, s = this.host.app.session;
    if (!w) return;
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
    if (!active || !world) return;
    const nested = s.panels.settings || s.panels.help || s.panels.codex || s.panels.chakras || s.campChoiceOpen;
    const open = s.mobileMenu !== null;
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
    show(this.selected, selected > 0 && s.mobileBuildFacet < 0 && !s.mobileAbility && !s.mobileBoxSelect);
    setText(this.selectionLabel, `${selected} selected`);
    const preview = s.mobileBuildFacet >= 0 && s.tool === 'building';
    const targeting = preview || !!s.mobileAbility || s.mobileBoxSelect || s.recruitTargeting || (s.planTool !== 'select' && s.planTool !== 'node');
    show(this.placement, targeting);
    show(this.confirm, preview);
    this.confirm.disabled = preview && !s.ghost?.valid;
    setText(this.placementLabel, preview
      ? (s.ghost?.valid ? 'Place building here?' : s.ghost?.reason || 'Checking placement…')
      : s.mobileAbility ? 'Tap the field to target this power.'
      : s.mobileBoxSelect ? 'Drag a box around your units.'
      : s.recruitTargeting ? 'Tap a neutral Signifier to recruit.' : 'Tap the field to set this plan.');
    setText(this.buildHint, s.mobileBuildFacet >= 0 ? 'Choose a building for this space. Review its preview on the field before confirming.' : 'Switch to Plan, then long-press the center of a buildable space to choose what goes there.');
    setClass(this.root, 'mc-rts', world.factions[s.playerFaction].controlMode === 'rts');
    show(this.powers, world.factions[s.playerFaction].controlMode !== 'rts');
    for (const chakra of CHAKRAS) {
      const b = this.abilities.get(chakra)!;
      const why = abilityBlocker(world, s.playerFaction, CHAKRA_INFO[chakra].ability);
      b.disabled = why !== ''; b.title = why || CHAKRA_INFO[chakra].abilityName;
    }
    const alert = [...s.feed].reverse().find(x => ['warn', 'danger', 'epic'].includes(x.severity) && now - x.at < 5000);
    show(this.toast, !!alert);
    if (alert) setText(this.toast, alert.text);
  }

  reset(): void {
    const s = this.host.app.session;
    s.mobileMenu = null; setMobileMode(s, 'units');
  }
  dispose(): void { this.root.remove(); }
}
