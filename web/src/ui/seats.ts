/** Explicit camp choice: encounter recovery locally and online, ordinary online seats otherwise. */
import { FACTION_DEFS } from '../sim/constants';
import { FACTION_IDS } from '../sim/types';
import type { CaptureStage, FactionId } from '../sim/types';
import type { World } from '../sim/world';
import { STAGE_INFO } from './catalog';
import type { UiHost, UiPart } from './core';
import { button, el, html, setClass, setDisabled, setText, show } from './dom';
import { iconSvg } from './icons';
import { campChoices, canRecoverBossCamp, seatPlayer, watchingOnline } from './online';
import { portraitSvg } from './portraits';
import { worstHearth } from './rail';

const PENDING_MS = 4000;
interface SeatRow {
  root: HTMLElement;
  take: HTMLButtonElement;
  steer: HTMLElement;
  stats: HTMLElement;
  stage: HTMLElement;
  stageKey: CaptureStage | null;
}

export class SeatChooser implements UiPart {
  private root: HTMLElement;
  private heading: HTMLElement;
  private lede: HTMLElement;
  private list: HTMLElement;
  private rows: SeatRow[] = [];
  private empty: HTMLElement;
  private confirm: HTMLElement;
  private confirmFace: HTMLElement;
  private confirmTitle: HTMLElement;
  private confirmBtn: HTMLButtonElement;
  private backBtn: HTMLButtonElement;
  private watchBtn: HTMLButtonElement;
  private note: HTMLElement;
  private active = false;
  private picked: FactionId | null = null;
  private pickedShown: FactionId | null = null;
  private pending: FactionId | null = null;
  private pendingSince = 0;
  /** Offer once per fallen controlled camp; dismissal keeps spectating until reopened. */
  private offeredSeat: FactionId | null = null;

  constructor(private host: UiHost, parent: HTMLElement) {
    this.root = el('div', 'modal seats ix is-off', parent);
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Choose a camp');
    this.root.setAttribute('data-gamepad-modal', '');
    const box = el('div', 'modal-box frame seats-box', this.root);
    const head = el('div', 'modal-head', box);
    this.heading = el('h2', '', head, 'Play a camp');
    const close = button('panel-x', head, iconSvg('close'), () => this.close(), 'back');
    close.setAttribute('aria-label', 'Keep watching');
    this.lede = el('p', 'seats-lede', box, '');
    this.list = el('div', 'seats-list', box);
    for (const f of FACTION_IDS) this.rows.push(this.row(f));
    this.empty = el('div', 'seats-empty is-off', box, '');
    this.confirm = el('div', 'seats-confirm is-off', box);
    this.confirmFace = el('div', 'sc-face', this.confirm);
    const text = el('div', 'sc-text', this.confirm);
    this.confirmTitle = el('div', 'sc-title', text, '');
    el('div', 'sc-sub', text, 'Keep this camp’s avatar, Hearths, Flags and Signifiers. Its existing orders stay until you change them.');
    const buttons = el('div', 'sc-buttons', this.confirm);
    this.confirmBtn = button('btn btn-primary', buttons, 'Take over', () => this.take(), 'confirm');
    this.backBtn = button('btn', buttons, 'Back', () => this.unpick(), 'back');
    this.note = el('div', 'panel-hint seats-note', box, '');
    this.note.setAttribute('role', 'status');
    this.note.setAttribute('aria-live', 'polite');
    this.watchBtn = button('btn btn-small seats-watch', box, 'Keep watching', () => this.close(), 'back');
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('fh-menu-back', this.onMenuBack);
  }

  private row(f: FactionId): SeatRow {
    const def = FACTION_DEFS[f];
    const root = el('div', 'seat-row is-off', this.list);
    root.style.setProperty('--fc', def.css);
    html('div', 'sr-face', portraitSvg(f), root);
    const main = el('div', 'sr-main', root);
    el('div', 'sr-name', main, def.name);
    const steer = el('div', 'sr-steer', main, '');
    const stats = el('div', 'sr-stats', main, '');
    const stage = el('span', 'badge sr-stage', root, '');
    const take = button('btn btn-small btn-gold sr-take', root, 'Choose', () => this.pick(f), 'pick');
    take.setAttribute('aria-label', `Choose ${def.name}`);
    return { root, take, steer, stats, stage, stageKey: null };
  }

  open(f: FactionId | null): void {
    const app = this.host.app;
    const recovery = !!app.world && canRecoverBossCamp(app, app.world);
    if (!recovery && app.session.screen === 'paused') app.setPaused(false);
    this.active = true;
    this.picked = f;
    this.pending = recovery ? app.net?.pendingBossTakeover ?? null : null;
    if (this.pending !== null) this.picked = this.pending;
    setText(this.note, '');
    this.update(app.world, performance.now());
    this.focusChoice();
  }

  private close(): void {
    this.active = false;
    this.picked = null;
    this.pending = null;
    this.host.app.session.campChoiceOpen = false;
    if (this.root.contains(document.activeElement)) (document.activeElement as HTMLElement | null)?.blur();
    show(this.root, false);
  }

  private pick(f: FactionId): void {
    if (this.pending !== null) return;
    const world = this.host.app.world;
    if (!world || !campChoices(this.host.app, world).includes(f)) return;
    this.picked = f;
    setText(this.note, '');
    this.update(world, performance.now());
    this.confirmBtn.focus();
  }

  private unpick(): void {
    if (this.pending !== null) return;
    this.picked = null;
    this.update(this.host.app.world, performance.now());
    this.focusChoice();
  }

  private take(): void {
    const app = this.host.app, world = app.world, f = this.picked;
    if (!world || f === null || this.pending !== null) return;
    if (!campChoices(app, world).includes(f)) {
      this.picked = null;
      setText(this.note, 'That camp is no longer available. Choose another surviving camp.');
      this.update(world, performance.now()); this.focusChoice(); return;
    }
    this.pendingSince = performance.now();
    if (canRecoverBossCamp(app, world)) {
      if (!app.takeBossCamp(f)) {
        this.picked = null;
        setText(this.note, 'That camp could not be claimed. Check the surviving camps and try again.');
      } else if (app.net) this.pending = f;
    } else if (app.net) {
      this.pending = f;
      app.net.setSeat(f);
    }
    this.update(app.world, this.pendingSince);
  }

  private back(): void {
    if (this.picked !== null && this.pending === null) this.unpick();
    else this.close();
  }

  private onMenuBack = (ev: Event): void => {
    if (!this.active || !this.host.app.session.campChoiceOpen) return;
    ev.preventDefault(); this.back();
  };

  private onKey = (ev: KeyboardEvent): void => {
    if (!this.active || !this.host.app.session.campChoiceOpen) return;
    if (ev.key === 'Escape') {
      ev.preventDefault(); ev.stopPropagation(); this.back();
    } else if (ev.key === 'Tab' || ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const buttons = Array.from(this.root.querySelectorAll<HTMLButtonElement>('button')).filter((b) => !b.disabled && b.getClientRects().length > 0);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const direction = ev.shiftKey || ev.key === 'ArrowUp' ? -1 : 1;
      buttons[(index + direction + buttons.length) % buttons.length]?.focus();
      ev.preventDefault(); ev.stopPropagation();
    }
  };

  private focusChoice(): void {
    if (!this.active) return;
    if (this.pending !== null) this.watchBtn.focus();
    else if (this.picked !== null) this.confirmBtn.focus();
    else (this.rows.find((row) => !row.root.classList.contains('is-off'))?.take ?? this.watchBtn).focus();
  }

  reset(): void { this.close(); this.offeredSeat = null; }

  update(world: World | null, now: number): void {
    const app = this.host.app, s = app.session, net = app.net;
    const recovery = !!world && canRecoverBossCamp(app, world);
    // A first elimination (including late reconnect) offers every eligible camp; never auto-select.
    if (recovery && this.offeredSeat !== s.playerFaction && s.screen === 'playing') {
      this.offeredSeat = s.playerFaction;
      this.active = true; this.picked = null; this.pending = net?.pendingBossTakeover ?? null;
      if (this.pending !== null) this.picked = this.pending;
      setText(this.note, '');
    }
    if (!this.active || !world || (!recovery && !watchingOnline(app, world)) ||
        (s.screen !== 'playing' && !(recovery && s.screen === 'paused'))) {
      if (this.active) this.close();
      return;
    }
    const wasOpen = s.campChoiceOpen;
    s.campChoiceOpen = true;
    show(this.root, true);
    const choices = campChoices(app, world);
    setText(this.heading, recovery ? 'Choose a surviving camp' : 'Play a camp');
    setText(this.lede, recovery
      ? 'Your camp has fallen, but the fight goes on. Choose a surviving AI camp to take command, or keep watching.'
      : 'The rivals’ AI steers these camps. Take one over where it stands.');
    setText(this.empty, recovery
      ? world.factions[s.playerFaction].controlMode === 'rts'
        ? 'No compatible RTS camps are available. Avatar camps require a roaming body; keep watching the surviving camps.'
        : 'No surviving AI camps are available. Keep watching: the surviving camps can still win together.'
      : 'Every camp has its Signifier or has fallen. Watch on: a seat may yet free up.');
    if (recovery && this.pending !== null && net?.pendingBossTakeover === null) {
      this.pending = null; this.picked = null;
      setText(this.note, net.bossTakeoverError ?? 'The available camps changed. Choose a surviving camp.');
    } else if (this.pending !== null && now - this.pendingSince > PENDING_MS) {
      if (recovery) setText(this.note, 'Waiting for the host to confirm. You can keep watching meanwhile.');
      else {
        this.pending = null; this.picked = null;
        setText(this.note, 'That camp is no longer free. Choose another camp.');
      }
    }
    if (this.picked !== null && this.pending === null && !choices.includes(this.picked)) {
      setText(this.note, `${FACTION_DEFS[this.picked].name} is no longer free.`);
      this.picked = null;
    }
    const confirming = this.picked !== null;
    show(this.confirm, confirming); show(this.lede, !confirming); show(this.list, !confirming);
    if (this.picked !== null) {
      const f = this.picked;
      if (this.pickedShown !== f) {
        this.pickedShown = f;
        this.confirm.style.setProperty('--fc', FACTION_DEFS[f].css);
        this.confirmFace.innerHTML = portraitSvg(f);
      }
      const pending = this.pending !== null;
      setText(this.confirmTitle, pending ? `Taking over ${FACTION_DEFS[f].name}…` : `Take over ${FACTION_DEFS[f].name}'s camp?`);
      setText(this.confirmBtn, pending ? 'Asking the host…' : 'Take over');
      this.confirmBtn.disabled = pending; this.backBtn.disabled = pending;
      setDisabled(this.confirmBtn, pending); setClass(this.confirm, 'pending', pending);
      show(this.empty, false);
    } else {
      for (const f of FACTION_IDS) {
        const row = this.rows[f], fac = world.factions[f], ok = choices.includes(f);
        show(row.root, ok);
        if (!ok) continue;
        const away = recovery ? null : seatPlayer(net?.lobby ?? null, f);
        setText(row.steer, away ? `${away.name} is away · the rivals’ AI holds the camp` : 'AI-controlled camp');
        const hearths = fac.hearthIds.length;
        setText(row.stats, `${hearths} ${hearths === 1 ? 'Hearth' : 'Hearths'} · Survey ${world.survey.surveySize[f]} facets`);
        const stage: CaptureStage = worstHearth(world, fac)?.hearth?.stage ?? 'safe';
        if (stage !== row.stageKey) {
          if (row.stageKey) row.stage.classList.remove(`st-${row.stageKey}`);
          row.stage.classList.add(`st-${stage}`); row.stageKey = stage;
          setText(row.stage, STAGE_INFO[stage].label); row.stage.title = STAGE_INFO[stage].desc;
        }
      }
      show(this.empty, choices.length === 0);
    }
    if (!wasOpen || (this.root.contains(document.activeElement) && !(document.activeElement as HTMLElement).getClientRects().length)) this.focusChoice();
  }

  dispose(): void {
    this.close();
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('fh-menu-back', this.onMenuBack);
    this.root.remove();
  }
}
