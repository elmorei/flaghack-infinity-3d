/**
 * Pause menu (session.screen 'paused'): Resume, Settings, Liber HH, Quit to title (two-step
 * confirm so a stray click never abandons a Survey), plus a rotating tip. Online the host's burn
 * never stops, so the menu reads "The burn goes on", shows the standings (handles, camps, ping)
 * and its last button leaves the burn instead; a watcher may also take over an AI-steered camp.
 */
import type { World } from '../sim/world';
import type { UiHost, UiPart } from './core';
import { button, el, html, setClass, setText, show } from './dom';
import { TIPS } from './lore';
import { campChoices, canRecoverBossCamp } from './online';
import { StandingsTable } from './scoreboard';
import { sigilSvg } from './title';

export class PauseMenu implements UiPart {
  private host: UiHost;
  private root: HTMLElement;
  private title: HTMLElement;
  private sub: HTMLElement;
  private quit: HTMLButtonElement;
  private playCamp: HTMLButtonElement;
  private controlMode: HTMLButtonElement;
  private quitArmed = false;
  private online = false;
  private standingsWrap: HTMLElement;
  private standings: StandingsTable;
  private tip: HTMLElement;
  private wasOpen = false;
  private tipIdx = Math.floor(Math.random() * TIPS.length);

  constructor(host: UiHost, parent: HTMLElement) {
    this.host = host;
    this.root = el('div', 'modal pause ix is-off', parent);
    const box = el('div', 'modal-box frame pause-box', this.root);
    html('div', 'pause-sigil', sigilSvg('sigil'), box);
    this.title = el('h2', 'pause-title', box, 'Paused');
    this.sub = el('div', 'pause-sub', box, 'The Crystal holds its breath.');
    const body = el('div', 'pause-body', box);
    const menu = el('div', 'pause-menu', body);
    button('btn btn-primary', menu, 'Resume', () => this.host.app.setPaused(false), 'back');
    this.controlMode = button('btn', menu, 'Switch control mode', () => {
      const app = this.host.app, world = app.world;
      if (world) app.setControlMode?.(world.factions[app.session.playerFaction].controlMode === 'rts' ? 'avatar' : 'rts');
    });
    this.controlMode.title = 'Keep your camp. Removed mode-specific spell upgrades are refunded as Ritual.';
    // Online watchers: take over a camp the rivals' AI steers (seats.ts asks to confirm).
    this.playCamp = button('btn btn-gold is-off', menu, 'Play a camp', () => this.host.chooseSeat(null), 'confirm');
    button('btn', menu, 'Settings', () => {
      this.host.app.session.panels.settings = true;
    });
    button('btn', menu, 'Liber HH', () => {
      this.host.app.session.panels.codex = true;
    });
    this.quit = button('btn btn-danger', menu, 'Quit to title', () => {
      if (!this.quitArmed) {
        this.quitArmed = true;
        setText(this.quit, this.online ? 'Leave this burn for good?' : 'Abandon this Survey?');
        return;
      }
      const net = this.host.app.net;
      this.host.veiledLoad(() => {
        if (net) net.leave();
        else this.host.app.quitToTitle();
      });
    });
    this.standingsWrap = el('div', 'pause-standings is-off', body);
    el('div', 'panel-title', this.standingsWrap, 'Standings');
    this.standings = new StandingsTable(this.standingsWrap, (f) => this.host.chooseSeat(f));
    this.tip = el('p', 'pause-tip', box, '');
  }

  update(world: World | null, _now: number): void {
    const s = this.host.app.session;
    const open = s.screen === 'paused';
    // Settings / codex opened from here cover the menu; it comes back when they close.
    show(this.root, open && !s.panels.settings && !s.panels.codex);
    if (open && !this.wasOpen) {
      this.online = this.host.app.net !== null;
      setClass(this.root, 'online', this.online);
      show(this.standingsWrap, this.online);
      setText(this.title, this.online ? 'The burn goes on' : 'Paused');
      const camp = this.host.app.session.spectator ? 'the camps fight' : 'your camp fights';
      setText(this.sub, this.online ? `The host never stops the burn: ${camp} on while you read.` : 'The Crystal holds its breath.');
      this.tipIdx = (this.tipIdx + 1) % TIPS.length;
      setText(this.tip, TIPS[this.tipIdx] ?? '');
      this.quitArmed = false;
      setText(this.quit, this.online ? 'Leave the burn' : 'Quit to title');
    }
    this.wasOpen = open;
    if (!open || !world) return;
    show(this.controlMode, !s.spectator && !!world.factions[s.playerFaction]?.alive && world.options.mode !== 'tutorial');
    setText(this.controlMode, world.factions[s.playerFaction]?.controlMode === 'rts' ? 'Switch to Avatar' : 'Switch to RTS');
    if (this.online) this.standings.update(this.host.app, world);
    const recovery = canRecoverBossCamp(this.host.app, world);
    setText(this.playCamp, recovery ? 'Choose a surviving camp' : 'Play a camp');
    show(this.playCamp, recovery || campChoices(this.host.app, world).length > 0);
  }

  dispose(): void {
    this.root.remove();
  }
}
