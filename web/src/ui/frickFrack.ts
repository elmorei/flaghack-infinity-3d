import { handFlagBlocker } from '../sim/systems/recruitment';
import { frickFrackInputLocked } from '../game/frickFrackControls';
/** Regular-mode wizard dialogue and card table. Simulation owns every wager and card. */
import type { AppApi } from '../game/app';
import { FRICK_FRACK_DIALOGUE, FRICK_FRACK_LETTER_SECONDS, frickFrackTotal } from '../sim/frickFrack';
import type { FrickFrackCard, FrickFrackSession } from '../sim/frickFrack';
import type { Command } from '../sim/commands';
import type { World } from '../sim/world';
import type { UiHost, UiPart } from './core';
import { button, el, setText, show } from './dom';
import './frickFrack.css';

type TableAction = Extract<Command, { t: 'frickFrack' }>['action'];
const SUITS = ['♠', '♥', '♦', '♣'];
export function cardLabel(card: FrickFrackCard | null): string {
  if (card === null) return 'Hidden card';
  const rank = card.rank === 1 ? 'A' : card.rank === 11 ? 'J' : card.rank === 12 ? 'Q' : card.rank === 13 ? 'K' : String(card.rank);
  return `${rank}${SUITS[card.suit] ?? '?'}`;
}
export function revealedDialogue(text: string, elapsed: number): string {
  return text.slice(0, Math.max(0, Math.floor(elapsed / FRICK_FRACK_LETTER_SECONDS)));
}
export function clampWager(value: number, available: number): number {
  const cap = Math.max(0, Math.floor(available));
  if (cap === 0) return 0;
  return Math.max(1, Math.min(cap, Number.isFinite(value) ? Math.floor(value) : 1));
}
/** Public state only: no local card draws or optimistic settlement. */
export function activeFrickFrack(app: Pick<AppApi, 'world' | 'session'>): FrickFrackSession | null {
  const w = app.world, s = app.session;
  if (!w || !frickFrackInputLocked(w, s)) return null;
  return w.frickFrack?.sessions[s.playerFaction] ?? null;
}

export class FrickFrackUI implements UiPart {
  private readonly root: HTMLElement;
  private readonly offer: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly title: HTMLElement;
  private readonly status: HTMLElement;
  private readonly host: UiHost;
  private key = '';
  private pending = '';
  private pendingAt = 0;
  private text: HTMLElement | null = null;
  private textSource = '';
  private next: HTMLButtonElement | null = null;
  private active: FrickFrackSession | null = null;
  private wager = 1;
  private wagerInput: HTMLInputElement | null = null;
  private wagerAvailable = 0;
  private focusBefore: HTMLElement | null = null;

  constructor(host: UiHost, parent: HTMLElement) {
    this.host = host;
    this.offer = button('ff-offer ff-button ix is-off', parent, 'Give Flag to wizard', () => {
      const w = this.host.app.world, s = this.host.app.session;
      if (w && s.screen === 'playing' && !s.spectator && w.factions[s.playerFaction].controlMode !== 'rts' && !w.frickFrack.sessions[s.playerFaction] && !handFlagBlocker(w, s.playerFaction, w.frickFrack.wizardId))
        this.host.app.submit({ t: 'handFlag', faction: s.playerFaction, hippieId: w.frickFrack.wizardId });
    });
    this.root = el('section', 'ff-overlay ix is-off', parent);
    this.root.dataset.gamepadModal = 'frick-frack';
    this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-label', 'Frick-frack'); this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'ff-title');
    const panel = el('div', 'ff-panel', this.root);
    const header = el('header', 'ff-header', panel);
    const identity = el('div', '', header);
    el('div', 'ff-eyebrow', identity, 'A most legitimate diversion');
    this.title = el('h2', '', identity, 'Frick-frack'); this.title.id = 'ff-title';
    this.status = el('p', 'ff-status', panel);
    this.body = el('div', 'ff-body', panel);
    for (const event of ['pointerdown', 'pointerup', 'click', 'dblclick', 'wheel', 'touchstart', 'touchmove', 'touchend']) {
      this.root.addEventListener(event, (ev) => ev.stopPropagation());
    }
    this.root.addEventListener('keydown', (ev) => ev.stopPropagation());
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('fh-menu-back', this.onBack);
  }

  update(world: World | null, now: number): void {
    const session = activeFrickFrack(this.host.app);
    const wasOpen = this.active !== null;
    const local = this.host.app.session;
    show(this.offer, !!world && !session && local.screen === 'playing' && !local.spectator && world.phase === 'playing' && world.factions[local.playerFaction].controlMode !== 'rts'
      && document.documentElement.dataset.deviceLayout === 'mobile' && local.mobileMenu === null && !Object.values(local.panels).some(Boolean)
      && !handFlagBlocker(world, local.playerFaction, world.frickFrack.wizardId));
    this.active = session;
    show(this.root, session !== null);
    if (!session || !world) {
      this.key = ''; this.pending = ''; this.text = null; this.next = null;
      if (wasOpen) { this.focusBefore?.blur(); this.focusBefore = null; }
      return;
    }
    if (!wasOpen) {
      this.focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // Pointer-lock reacquisition is deliberately left to the next canvas gesture.
      if (document.pointerLockElement) document.exitPointerLock?.();
    }
    const available = world.avatarOf(session.faction)?.carried.length ?? 0;
    const signature = `${session.id}:${session.revision}:${session.phase}:${available}:${world.frickFrack.sideboards[session.faction].map(c => c.id).join(',')}`;
    if (this.pending && (this.pending !== `${session.id}:${session.revision}` || now - this.pendingAt > 2500)) { this.pending = ''; this.key = ''; }
    if (signature !== this.key) {
      this.key = signature; this.render(session, available, world);
    }
    this.frame();
  }

  frame(): void {
    const session = this.active, w = this.host.app.world;
    if (!session || !w) return;
    if (this.text) setText(this.text, revealedDialogue(this.textSource, w.time - session.dialogueStartedAt));
    if (this.next) this.next.disabled = w.time + 1e-6 < session.readyAt || this.pending === `${session.id}:${session.revision}`;
    for (const b of this.body.querySelectorAll<HTMLButtonElement>('[data-ready-gate]')) b.disabled = w.time + 1e-6 < session.readyAt || this.pending === `${session.id}:${session.revision}`;
  }

  private render(s: FrickFrackSession, available: number, world: World): void {
    this.body.replaceChildren(); this.text = null; this.next = null; this.wagerInput = null;
    setText(this.title, s.phase === 'dialogue' || s.phase === 'empty' ? 'The Frick-frack Wizard' : 'Frick-frack');
    setText(this.status, `Holding ${available} Flag${available === 1 ? '' : 's'}${s.wager > 0 ? ` · Wager ${s.wager}` : ''} · The burn continues outside.`);
    if (s.phase === 'dialogue' || s.phase === 'empty') {
      el('div', 'ff-wizard-seal', this.body, '✦');
      el('div', 'ff-page-number', this.body, s.phase === 'dialogue' ? `A brief word · ${s.dialogueIndex + 1} / ${FRICK_FRACK_DIALOGUE.length}` : 'An unfortunate arithmetic');
      this.textSource = s.phase === 'empty' ? s.message : FRICK_FRACK_DIALOGUE[s.dialogueIndex] ?? '';
      this.text = el('p', 'ff-dialogue', this.body);
      const actions = el('div', 'ff-actions', this.body);
      if (s.phase === 'empty') this.action(actions, 'Return to the burn', 'exit');
      else if (s.dialogueIndex < FRICK_FRACK_DIALOGUE.length - 1) this.next = this.action(actions, 'Continue', 'next');
      else {
        this.next = this.action(actions, 'Yes, play Frick-frack', 'play');
        const decline = this.action(actions, 'No, thank you', 'decline');
        decline.dataset.readyGate = 'true';
      }
      el('p', 'ff-small', this.body, 'Let the wizard finish his thought.');
    } else {
      const cards = el('div', 'ff-hands', this.body);
      this.hand(cards, 'Wizard', s.dealer);
      this.hand(cards, 'You', s.player);
      if (s.message) el('p', `ff-result ff-${s.result ?? 'waiting'}`, this.body, s.message);
      if (s.phase === 'betting') {
        const field = el('label', 'ff-wager', this.body);
        el('span', '', field, 'Flags to wager');
        const row = el('div', 'ff-wager-row', field);
        this.wagerAvailable = available;
        this.wager = clampWager(this.wager, available);
        button('ff-button', row, '−', () => this.setWager(this.wager - 1)).setAttribute('aria-label', 'Wager one fewer Flag');
        this.wagerInput = el('input', '', row);
        this.wagerInput.type = 'number'; this.wagerInput.min = '1'; this.wagerInput.max = String(available); this.wagerInput.step = '1'; this.wagerInput.inputMode = 'numeric'; this.wagerInput.value = String(this.wager);
        this.wagerInput.addEventListener('change', () => this.setWager(Number(this.wagerInput?.value)));
        button('ff-button', row, '+', () => this.setWager(this.wager + 1)).setAttribute('aria-label', 'Wager one more Flag');
        button('ff-button', row, 'All', () => this.setWager(available));
        const actions = el('div', 'ff-actions', this.body);
        this.action(actions, 'Deal hand', 'bet', () => ({ wager: clampWager(Number(this.wagerInput?.value ?? this.wager), available) })).disabled = available < 1;
        this.action(actions, 'Leave table', 'exit');
      } else if (s.phase === 'playing') {
        const actions = el('div', 'ff-actions', this.body);
        this.action(actions, 'Hit', 'hit'); this.action(actions, 'Stand', 'stand');
        this.action(actions, 'Exit · forfeit wager', 'exit');
        const board = el('section', 'ff-sideboard', this.body);
        el('h3', '', board, 'Cards up your sleeve');
        el('p', 'ff-small', board, 'Play a known card instead of a random Hit. Each card is used once.');
        const picks = el('div', 'ff-cheats', board);
        const sideboard = world.frickFrack.sideboards[s.faction];
        if (!sideboard.length) el('span', 'ff-small', picks, 'Find rare cards dropped by downed hippies.');
        for (const card of sideboard) this.action(picks, cardLabel(card), 'cheat', () => ({ cardId: card.id })).setAttribute('aria-label', `Play ${cardLabel(card)} once`);
      } else if (s.phase === 'result') {
        const actions = el('div', 'ff-actions', this.body);
        this.action(actions, 'Another hand', 'again'); this.action(actions, 'Leave table', 'exit');
      }
      el('p', 'ff-rules', this.body, 'Closest to 21 without going over. Aces count as 1 or 11. Wizard stands on all 17s. Wins pay 1:1, including blackjack; ties return your wager. Extra winnings go to your altar stock.');
    }
    this.frame();
    for (const b of this.body.querySelectorAll<HTMLButtonElement>('[data-ready-gate]')) b.disabled = world.time < s.readyAt;
    this.body.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }

  private hand(parent: HTMLElement, name: string, cards: readonly (FrickFrackCard | null)[]): void {
    const hand = el('section', 'ff-hand', parent);
    const known = cards.filter((c): c is FrickFrackCard => c !== null);
    const total = known.length && !cards.includes(null) ? ` · ${frickFrackTotal(known)}` : '';
    el('h3', '', hand, `${name}${total}`);
    const row = el('div', 'ff-card-row', hand);
    if (!cards.length) el('span', 'ff-small', row, 'Waiting for the deal');
    for (const card of cards) {
      const tile = el('div', `ff-card${card === null ? ' ff-card-back' : card.suit === 1 || card.suit === 2 ? ' ff-card-red' : ''}`, row, card === null ? '✦' : cardLabel(card));
      tile.setAttribute('aria-label', cardLabel(card));
    }
  }

  private setWager(value: number): void { this.wager = clampWager(value, this.wagerAvailable); if (this.wagerInput) this.wagerInput.value = String(this.wager); }
  private action(parent: HTMLElement, text: string, action: TableAction, extra?: () => { wager?: number; cardId?: number }): HTMLButtonElement {
    return button('ff-button', parent, text, () => this.send(action, extra?.()), 'confirm');
  }
  private send(action: TableAction, extra?: { wager?: number; cardId?: number }): void {
    const s = activeFrickFrack(this.host.app), w = this.host.app.world;
    if (!s || !w || this.pending === `${s.id}:${s.revision}`) return;
    if ((action === 'next' || action === 'play' || action === 'decline') && w.time < s.readyAt) return;
    this.pending = `${s.id}:${s.revision}`; this.pendingAt = performance.now();
    this.host.app.submit({ t: 'frickFrack', faction: s.faction, sessionId: s.id, revision: s.revision, action, ...extra });
    for (const b of this.body.querySelectorAll<HTMLButtonElement>('button')) b.disabled = true;
  }
  private onBack = (ev: Event): void => { if (!this.active) return; ev.preventDefault(); if (this.active.phase !== 'dialogue') this.send('exit'); };
  private onKey = (ev: KeyboardEvent): void => {
    if (!activeFrickFrack(this.host.app)) return;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); if (!ev.repeat && this.active?.phase !== 'dialogue') this.send('exit'); return; }
    // Other game shortcuts must not fire through this modal. Tab retains native focus traversal.
    if (ev.key !== 'Tab' && !(ev.target instanceof Node && this.root.contains(ev.target))) ev.stopPropagation();
    if (ev.key === 'Tab') {
      const buttons = [...this.root.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last?.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first?.focus(); }
      ev.stopPropagation();
    }
  };
  dispose(): void { window.removeEventListener('keydown', this.onKey, true); window.removeEventListener('fh-menu-back', this.onBack); this.root.remove(); this.offer.remove(); }
}
