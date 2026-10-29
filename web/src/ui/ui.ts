/**
 * DOM UI root: title screen (with the host's join panel), the online lobby, HUD (Flags/stock
 * frame, lumber, ritual, hippies, attention, clock, tide/Burn timers, ability bar, drug slots,
 * build keys, C.M.I.), D.E.G.E.N. minimap + roster, Hearth rail, event feed, crosshair/prompt/
 * channel ring, Command View panels (plan tools, priorities, selection orders, build menu),
 * chakra ritual screen, codex (Liber HH), pause/settings, end screen, and online in-match
 * chat, standings (hold O), connection pill and host notices.
 * Owner: UI agent.
 *
 * Update discipline: events only touch part state; the DOM is written at <= 10 Hz and the
 * minimap canvas at <= 15 Hz. The only per-frame write is the drag-select rectangle. The root
 * never takes pointer events; only real widgets (class `ix`) do, so pointer lock and canvas
 * input stay with the controls. Online, the UI owns two keys outside the game's keymap: Enter
 * (chat) and O (hold for the standings), both ignored while a text field has the keyboard.
 */
import type { AppApi } from '../game/app';
import type { Screen } from '../game/session';
import type { GameEvent, Severity } from '../sim/events';
import type { V2 } from '../sim/math';
import type { FactionId } from '../sim/types';
import type { World } from '../sim/world';
import { ActionBar } from './actionbar';
import { Banners } from './banners';
import { ChakraScreen } from './chakras';
import { ChatOverlay } from './chat';
import { Codex } from './codex';
import { CommandPanels } from './command';
import type { BannerSpec, UiHost, UiLayout, UiPart } from './core';
import { matchScreen } from './core';
import { el, setClass } from './dom';
import { EndScreen } from './endscreen';
import { FeedPart } from './feed';
import { FrickFrackUI } from './frickFrack';
import { HelpOverlay } from './help';
import { HudPart, PerfOverlay } from './hud';
import { LobbyScreen } from './lobby';
import { Minimap } from './minimap';
import { MobileCommandUI } from './mobileCommand';
import { NetHud } from './netstatus';
import { PauseMenu } from './pause';
import { HearthRail } from './rail';
import { Roster } from './roster';
import { Scoreboard } from './scoreboard';
import { SceneryBenefitsPart } from './sceneryBenefits';
import { SeatChooser } from './seats';
import { SettingsPanel } from './settings';
import { UiSfx } from './sfx';
import { TitleScreen } from './title';
import { TutorialOverlay } from './tutorial/index';
import { LoadingVeil } from './veil';
import './ui.css';

const TICK_MS = 100;
const MAP_MS = 1000 / 15;
/** Virtual canvas the HUD is laid out for; the root zooms to fit the window. */
const DESIGN_W = 1422;
const DESIGN_H = 800;
/** Ignore the Escape press that caused the pause (it can arrive with the pointer-lock exit). */
const PAUSE_ESC_GRACE_MS = 300;

/** A blocked button hammered with the same reason posts it to the feed at most this often. */
const BLOCKED_REPEAT_MS = 1500;

export class GameUI {
  private app: AppApi;
  private rootEl: HTMLElement;
  private zoomed: HTMLElement;
  private hudLayer: HTMLElement;
  private parts: UiPart[] = [];
  private hud: HudPart;
  private minimap: Minimap;
  private banners: Banners;
  private veil: LoadingVeil;
  private chat: ChatOverlay;
  private lobby: LobbyScreen;
  private scoreboard: Scoreboard;
  /** Training Burn mentor, pointers and graduation (TutorialUI agent); its typewriter runs every frame. */
  private tutorialOverlay: TutorialOverlay;
  private frickFrack: FrickFrackUI;
  private seats: SeatChooser;
  private sfx: UiSfx;
  /** Last blocked-action reason posted, so a hammered button does not flood the feed. */
  private lastBlocked = { reason: '', at: -Infinity };
  private world: World | null = null;
  private screen: Screen | null = null;
  private lastTick = -Infinity;
  private lastMap = -Infinity;
  private pausedAt = 0;
  private uiMs = 0;
  private uiMaxMs = 0;
  private uiMaxWindow = 0;
  private uiMaxStart = 0;

  constructor(root: HTMLElement, app: AppApi) {
    this.app = app;
    this.rootEl = el('div', 'fh-root', root);
    this.sfx = new UiSfx(this.rootEl, app);
    this.zoomed = el('div', 'fh-ui', this.rootEl);
    this.hudLayer = el('div', 'fh-hud', this.zoomed);
    // Banners sit between the HUD and the modal layer.
    this.banners = new Banners(this.zoomed);
    const region = (cls: string): HTMLElement => el('div', `region ${cls}`, this.hudLayer);
    const layout: UiLayout = {
      colLeft: region('col-left'),
      colRight: region('col-right'),
      topCenter: region('top-center'),
      center: region('center'),
      bottomCenter: region('bottom-center'),
      bottomLeft: region('bottom-left'),
      bottomRight: region('bottom-right'),
      overlay: el('div', 'fh-overlay', this.zoomed),
      raw: el('div', 'fh-raw', this.rootEl),
    };
    // Last child of the zoomed layer: the veil covers the HUD, banners and every modal.
    this.veil = new LoadingVeil(this.zoomed);

    const host: UiHost = {
      app,
      banner: (b: BannerSpec) => {
        if (matchScreen(this.app.session.screen)) this.banners.push(b);
      },
      post: (text: string, severity: Severity, pos?: V2) => this.app.session.post(text, severity, pos),
      flash: (pos: V2, color: string) => this.minimap.flash(pos, color),
      veiledLoad: (action: () => void) => this.veil.run(action),
      blocked: (reason: string) => {
        const now = performance.now();
        if (reason === this.lastBlocked.reason && now - this.lastBlocked.at < BLOCKED_REPEAT_MS) return;
        this.lastBlocked = { reason, at: now };
        this.app.session.post(reason, 'warn');
      },
      chooseSeat: (f: FactionId | null) => this.seats.open(f),
    };

    this.hud = new HudPart(host, layout);
    const rail = new HearthRail(host, layout.colLeft);
    this.minimap = new Minimap(host, layout.colRight);
    const command = new CommandPanels(host, layout);
    const roster = new Roster(host, layout.colRight);
    const sceneryBenefits = new SceneryBenefitsPart(host, layout.colRight);
    const bar = new ActionBar(host, layout.bottomCenter);
    const feed = new FeedPart(host, layout.bottomLeft);
    this.chat = new ChatOverlay(host, layout.bottomLeft);
    const net = new NetHud(host, layout);
    const perf = new PerfOverlay(host, layout.bottomRight, () => this.uiMs);
    this.tutorialOverlay = new TutorialOverlay(host, layout);
    this.parts.push(this.hud, rail, this.minimap, command, roster, sceneryBenefits, bar, feed, this.chat, net, perf, this.banners, this.tutorialOverlay);
    this.lobby = new LobbyScreen(host, layout.overlay);
    this.scoreboard = new Scoreboard(host, layout.overlay);
    this.parts.push(
      new TitleScreen(host, layout.overlay),
      this.lobby,
      this.scoreboard,
      new EndScreen(host, layout.overlay),
      new PauseMenu(host, layout.overlay),
      new ChakraScreen(host, layout.overlay),
      new HelpOverlay(host, layout.overlay),
      new Codex(host, layout.overlay),
      new SettingsPanel(host, layout.overlay),
    );
    // Last in the overlay: taking a camp is asked over the pause menu and the end cards alike.
    this.seats = new SeatChooser(host, layout.overlay);
    this.parts.push(this.seats);
    if (document.documentElement.dataset.deviceLayout === 'mobile') {
      this.parts.push(new MobileCommandUI(host, layout, this.rootEl));
    }

    this.frickFrack = new FrickFrackUI(host, layout.raw);
    this.parts.push(this.frickFrack);

    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.onResize();
  }

  /** Average and worst UI update cost (ms) for perf overlays and evals. */
  get perf(): { avgMs: number; maxMs: number } {
    return { avgMs: this.uiMs, maxMs: this.uiMaxMs };
  }

  onEvents(events: GameEvent[]): void {
    const w = this.app.world;
    if (!w || events.length === 0) return;
    if (w !== this.world) this.attach(w);
    for (const e of events) {
      for (const p of this.parts) p.onEvent?.(e, w);
    }
  }

  update(_dt: number): void {
    const t0 = performance.now();
    const s = this.app.session;
    const world = this.app.world;
    if (world && world !== this.world) this.attach(world);
    if (s.screen !== this.screen) this.onScreen(this.screen, s.screen, t0);

    this.hud.frame();
    this.tutorialOverlay.frame(t0);
    this.frickFrack.frame();
    if (t0 - this.lastTick >= TICK_MS) {
      this.lastTick = t0;
      const root = this.rootEl;
      setClass(root, 'scr-title', s.screen === 'title');
      setClass(root, 'scr-lobby', s.screen === 'lobby');
      setClass(root, 'scr-playing', s.screen === 'playing');
      setClass(root, 'scr-paused', s.screen === 'paused');
      setClass(root, 'scr-ended', s.screen === 'ended');
      setClass(root, 'spectator', s.spectator && matchScreen(s.screen));
      setClass(root, 'view-command', s.view === 'command');
      setClass(root, 'modal-open', s.campChoiceOpen || s.panels.codex || s.panels.settings || s.panels.chakras || s.panels.help);
      for (const p of this.parts) p.update(world, t0);
    }
    if (t0 - this.lastMap >= MAP_MS) {
      this.lastMap = t0;
      this.minimap.draw(world, t0);
    }

    const ms = performance.now() - t0;
    this.uiMs = this.uiMs * 0.95 + ms * 0.05;
    this.uiMaxWindow = Math.max(this.uiMaxWindow, ms);
    if (t0 - this.uiMaxStart > 1000) {
      this.uiMaxMs = this.uiMaxWindow;
      this.uiMaxWindow = 0;
      this.uiMaxStart = t0;
    }
    // After the timing window: the load the veil runs is not UI cost.
    this.veil.frame(performance.now());
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.sfx.dispose();
    for (const p of this.parts) p.dispose?.();
    this.parts = [];
    this.rootEl.remove();
  }

  private attach(world: World): void {
    this.world = world;
    for (const p of this.parts) p.reset?.(world);
  }

  private onScreen(prev: Screen | null, next: Screen, now: number): void {
    const panels = this.app.session.panels;
    const menu = (sc: Screen | null): boolean => sc === 'title' || sc === 'lobby';
    if (menu(next) || (menu(prev) && next === 'playing')) {
      // A fresh burn or the attract loop: nothing from the last session stays open.
      panels.chakras = false;
      panels.codex = false;
      panels.help = false;
      panels.settings = false;
      panels.degen = false;
    }
    if (next === 'ended') {
      panels.chakras = false;
      panels.help = false;
    }
    if (next === 'paused') this.pausedAt = now;
    this.screen = next;
  }

  private onResize = (): void => {
    const z = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
    const zoom = Math.max(0.72, Math.min(1.6, z)).toFixed(3);
    this.zoomed.style.setProperty('zoom', zoom);
    this.zoomed.style.setProperty('--desktop-ui-zoom', zoom);
  };

  /**
   * Escape outside of play (title / lobby / pause / end), where the controls do not listen. In
   * play the controls close any open panel on Escape (in their next update), so only the sound
   * is ours. Online, Enter opens the chat and O shows the standings while held.
   */
  private onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Enter' || ev.code === 'KeyO') {
      this.onOnlineKey(ev);
      return;
    }
    if (ev.key !== 'Escape' || ev.repeat) return;
    const s = this.app.session;
    const p = s.panels;
    if (s.screen === 'playing') {
      if (p.chakras || p.codex || p.help || p.settings) this.sfx.back();
      return;
    }
    if (p.settings) p.settings = false;
    else if (p.codex) p.codex = false;
    else if (s.screen === 'paused' && performance.now() - this.pausedAt > PAUSE_ESC_GRACE_MS) this.app.setPaused(false);
    else return;
    this.sfx.back();
    ev.preventDefault();
  };

  /** Enter / O while no text field has the keyboard (fields handle their own keys). */
  private onOnlineKey(ev: KeyboardEvent): void {
    if (!this.app.net || this.app.session.campChoiceOpen || ev.isComposing || typingIn(ev.target)) return;
    if (ev.code === 'KeyO') {
      if (ev.repeat || !matchScreen(this.app.session.screen)) return;
      this.scoreboard.setHeld(true);
      // Show at once rather than on the next 10 Hz tick: holding a key wants an instant answer.
      this.scoreboard.update(this.app.world, performance.now());
      return;
    }
    // Enter on a focused button presses it; only a free keyboard opens the chat.
    if (ev.repeat || ev.target instanceof HTMLButtonElement) return;
    if (this.chat.openInput() || this.lobby.focusChat()) ev.preventDefault();
  }

  private onKeyUp = (ev: KeyboardEvent): void => {
    if (ev.code !== 'KeyO') return;
    this.scoreboard.setHeld(false);
    this.scoreboard.update(this.app.world, performance.now());
  };

  /** Alt-tab mid-hold never delivers the keyup. */
  private onBlur = (): void => {
    this.scoreboard.setHeld(false);
  };
}

/** A text field (or editable element) has the keyboard: its keys are typing, not commands. */
function typingIn(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}
