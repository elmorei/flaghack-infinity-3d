import { frickFrackTableCards } from '../sim/frickFrackTable';
import { handFlagBlocker } from '../sim/systems/recruitment';
import { frickFrackInputLocked } from '../game/frickFrackControls';
/** Regular-mode wizard dialogue and card table. Simulation owns every wager and card. */
import type { AppApi } from '../game/app';
import { frickFrackDialogue, FRICK_FRACK_LETTER_SECONDS, frickFrackTotal } from '../sim/frickFrack';
import type { FrickFrackCard, FrickFrackSession } from '../sim/frickFrack';
import type { Command } from '../sim/commands';
import type { World } from '../sim/world';
import type { UiHost, UiPart } from './core';
import { button, el, setText, show } from './dom';
import './frickFrack.css';
import './frickFrackMotion.css';
import { tableSnapshot, planCardMotion, motionDuration, DEAL_MS, FLIP_MS } from './frickFrackMotion';
import type { TableSnapshot, CardMotion } from './frickFrackMotion';
import './frickFrackTarot.css';
import { tarotCardLabel, renderFrickFrackCard } from './frickFrackTarot';
import './frickFrackParody.css';
import { parodyCardLabel, renderParodyCard } from './frickFrackParody';
import { majorArcanaLabel, renderMajorArcanaCard } from './frickFrackArcana';
import { FRICK_FRACK_ARCANA } from '../sim/frickFrackArcana';
import { getFrickFrackPrivateView } from '../sim/frickFrackPrivate';
import './frickFrackArcana.css';

type TableCommand = Extract<Command, { t: 'frickFrack' }>;
type TableAction = TableCommand['action'];
type TableExtras = Pick<TableCommand, 'wager' | 'cardId' | 'targetCardIds' | 'value' | 'confirmCost' | 'choiceIndex'>;
/** Player-facing rules, kept outside the table layout for readable collapsed help. */
export const FRICK_FRACK_TABLE_RULES = [
  '136 cards: 52 standard, 56 Rider–Waite minor arcana, and 28 original CCG/sports cards. Major Arcana are one-use sideboard effects, never dealer draws.',
  'Closest to 21 without going over. Aces count as 1 or 11; courts count as 10. CCG cards use their printed VALUE 1–7, not decorative stats. Wizard stands on all 17s. Base wins pay 1:1, including blackjack; ties return your wager unless an Arcana changes the result. Extra winnings go to your altar stock.',
  'On reveal, CCG cards fight opponent CCG cards only. Friendly cards coexist; ordinary and tarot cards do not fight. The lower value is defeated; equal values both die. Defeated cards stay visible with an X, but do not count toward totals, poker prizes, effects or further fights.',
  'At hand end, your strongest pair, three of a kind, or four of a kind multiplies base win profit by 2, 3, or 4. These prizes do not stack. Your returned stake is not multiplied; The World’s extra stake is added separately.',
  'A non-bust five-card straight at hand end copies its highest printed card into your sleeve, even on a blackjack loss or push. No straight prize for a bust, and no mid-hand award.',
  'Poker uses printed ranks, never effect-modified values. Standard straights include A–2–3–4–5 or 10–J–Q–K–A, with no wraparound. Tarot Page counts as J; Queen and King keep their ranks. Tarot Knight is a distinct kind rank and cannot join a straight. CCG printed ranks are 1–7; printed 1 is an Ace for poker only.',
] as const;
const SUITS = ['♠', '♥', '♦', '♣'];
export function cardLabel(card: FrickFrackCard | null): string {
  if (card === null) return 'Hidden card';
  const major = majorArcanaLabel(card);
  if (major) return major;
  const parody = parodyCardLabel(card);
  if (parody) return parody;
  const tarot = tarotCardLabel(card);
  if (tarot) return tarot;
  const rank = card.rank === 1 ? 'A' : card.rank === 11 ? 'J' : card.rank === 12 ? 'Q' : card.rank === 13 ? 'K' : String(card.rank);
  return `${rank}${SUITS[card.suit] ?? '?'}${card.value !== undefined ? ` → ${card.value}` : ''}${card.temporary ? ' · temporary' : ''}`;
}
export function revealedDialogue(text: string, elapsed: number): string {
  return text.slice(0, Math.max(0, Math.floor(elapsed / FRICK_FRACK_LETTER_SECONDS)));
}
export function clampWager(value: number, available: number): number {
  const cap = Math.max(0, Math.floor(available));
  if (cap === 0) return 0;
  return Math.max(1, Math.min(cap, Number.isFinite(value) ? Math.floor(value) : 1));
}
/** UI guard only; the host repeats every validation before consuming a card or stake. */
export function canConfirmMajor(arcana: number, targets: readonly number[], hand: readonly FrickFrackCard[], value: number, wager: number, available: number): boolean {
  const spec = FRICK_FRACK_ARCANA[arcana];
  if (!spec) return false;
  const count = spec.target === 'two' ? 2 : spec.target === 'one' || spec.target === 'confirmOne' ? 1 : 0;
  if (targets.length !== count || new Set(targets).size !== count || targets.some(id => !hand.some(c => c.id === id))) return false;
  if (spec.target === 'value' && (!Number.isInteger(value) || value < 1 || value > 7)) return false;
  if (spec.target === 'confirmOne' && (!(wager > 0) || available < wager)) return false;
  if ((arcana === 0 || arcana === 10) && !hand.length) return false;
  return true;
}

export function majorPublicBlocker(arcana: number, s: FrickFrackSession): string | null {
  if (s.phase !== 'playing') return 'Major Arcana are played during a hand.';
  if (s.arcana?.choices?.length) return 'Finish the current choice first.';
  if ([2,18,19].includes(arcana) && !s.dealer.includes(null)) return 'There is no hidden dealer card to affect.';
  if ((arcana === 0 || arcana === 10) && !s.player.length) return 'There is no card in your hand to replace.';
  if ((arcana === 8 && s.arcana?.strength) || (arcana === 11 && s.arcana?.justice) || (arcana === 21 && s.arcana?.world)) return 'This effect is already active for this hand.';
  if (arcana === 20 && (s.arcana?.judgement || s.arcana?.judgementUsed)) return 'Judgement is already armed or has been used this hand.';
  if (arcana === 17 && s.arcana?.starUsed) return 'The Star can recover a card only once per hand.';
  return null;
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
  private sideboardOpen = false;
  private selectedMajor: number | null = null;
  private majorTargets: number[] = [];
  private majorValue = 1;
  private tableState: TableSnapshot | null = null;
  private motions = new Map<string, CardMotion & { startedAt: number }>();
  private animations: Animation[] = [];

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
    this.root.classList.toggle('ff-in-world', session?.phase === 'dialogue' || session?.phase === 'empty');
    document.documentElement.classList.toggle('ff-conversation-active', session !== null);
    if (!session || !world) {
      this.clearCardMotion(); this.tableState = null;
      this.key = ''; this.pending = ''; this.text = null; this.next = null; this.selectedMajor = null; this.majorTargets = [];
      if (wasOpen) { this.focusBefore?.blur(); this.focusBefore = null; }
      return;
    }
    if (!wasOpen) {
      this.focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // Pointer-lock reacquisition is deliberately left to the next canvas gesture.
      if (document.pointerLockElement) document.exitPointerLock?.();
    }
    const available = world.avatarOf(session.faction)?.carried.length ?? 0;
    const privateView = getFrickFrackPrivateView(world, session.faction);
    const signature = `${session.id}:${session.revision}:${session.phase}:${available}:${world.frickFrack.sideboards[session.faction].map(c => c.id).join(',')}:${privateView?.expiresAt ?? 0}`;
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
    this.rememberCardMotion(s);
    this.cancelAnimations();
    this.body.replaceChildren(); this.text = null; this.next = null; this.wagerInput = null;
    setText(this.title, s.phase === 'dialogue' || s.phase === 'empty' ? 'The Frick-frack Wizard' : 'Frick-frack');
    setText(this.status, `Holding ${available} Flag${available === 1 ? '' : 's'}${s.wager > 0 ? ` · Wager ${s.wager}` : ''} · The burn continues outside.`);
    if (s.phase === 'dialogue' || s.phase === 'empty') {
      el('div', 'ff-wizard-seal', this.body, '✦');
      el('div', 'ff-page-number', this.body, s.phase === 'dialogue' ? `A brief word · ${s.dialogueIndex + 1} / ${frickFrackDialogue(s.dialogueVariant).length}` : 'An unfortunate arithmetic');
      this.textSource = s.phase === 'empty' ? s.message : frickFrackDialogue(s.dialogueVariant)[s.dialogueIndex] ?? '';
      this.text = el('p', 'ff-dialogue', this.body);
      const actions = el('div', 'ff-actions', this.body);
      if (s.phase === 'empty') this.action(actions, 'Return to the burn', 'exit');
      else if (s.dialogueIndex < frickFrackDialogue(s.dialogueVariant).length - 1) this.next = this.action(actions, 'Continue', 'next');
      else {
        this.next = this.action(actions, 'Yes, play Frick-frack', 'play');
        const decline = this.action(actions, 'No, thank you', 'decline');
        decline.dataset.readyGate = 'true';
      }
      el('p', 'ff-small', this.body, 'Let the wizard finish his thought.');
    } else {
      const cards = el('div', 'ff-hands', this.body);
      const top = el('div', 'ff-table-topline', cards);
      const deck = el('div', 'ff-deck', top); deck.setAttribute('aria-hidden', 'true');
      el('span', '', deck); el('span', '', deck);
      el('div', 'ff-deck-card ff-card-back', deck, '✦');
      el('p', 'ff-table-note', top, 'The wizard’s picnic blanket');
      this.hand(cards, 'Wizard', s.dealer, s);
      this.hand(cards, 'You', s.player, s);
      if (s.remark) { const remark = el('p', 'ff-wizard-remark', this.body, s.remark); remark.setAttribute('role', 'status'); }
      if (s.message) el('p', `ff-result ff-${s.result ?? 'waiting'}`, this.body, s.message);
      if (s.phase === 'betting') {
        const field = el('label', 'ff-wager', this.body);
        el('span', '', field, 'Flags to wager');
        const row = el('div', 'ff-wager-row', field);
        this.wagerAvailable = available;
        this.wager = clampWager(this.wager, available);
        button('ff-button', row, '−', () => this.setWager(this.wager - 1)).setAttribute('aria-label', 'Wager one fewer Flag');
        this.wagerInput = el('input', '', row);
        this.wagerInput.setAttribute('aria-label', 'Flags to wager');
        this.wagerInput.type = 'number'; this.wagerInput.min = '1'; this.wagerInput.max = String(available); this.wagerInput.step = '1'; this.wagerInput.inputMode = 'numeric'; this.wagerInput.value = String(this.wager);
        this.wagerInput.addEventListener('change', () => this.setWager(Number(this.wagerInput?.value)));
        button('ff-button', row, '+', () => this.setWager(this.wager + 1)).setAttribute('aria-label', 'Wager one more Flag');
        button('ff-button', row, 'All', () => this.setWager(available));
        const actions = el('div', 'ff-actions ff-main-actions', this.body);
        this.action(actions, 'Deal hand', 'bet', () => ({ wager: clampWager(Number(this.wagerInput?.value ?? this.wager), available) })).disabled = available < 1;
        this.action(actions, 'Leave table', 'exit');
      } else if (s.phase === 'playing') {
        const actions = el('div', 'ff-actions ff-main-actions', this.body);
        const choosing = !!s.arcana?.choices?.length;
        this.action(actions, 'Hit', 'hit').disabled = choosing; this.action(actions, 'Stand', 'stand').disabled = choosing;
        this.action(actions, 'Exit · forfeit wager', 'exit');
        if (choosing) this.renderChoices(s);
        this.renderActiveEffects(s);
        this.renderPrivatePeek(world, s);
        const board = el('details', 'ff-sideboard', this.body);
        board.open = this.sideboardOpen;
        board.addEventListener('toggle', () => { this.sideboardOpen = board.open; });
        const count = world.frickFrack.sideboards[s.faction].length;
        el('summary', '', board, `Cards up your sleeve · ${count}`);
        el('p', 'ff-small', board, 'Number cards add their value to your hand. Major Arcana bend the rules. Every card is used once.');
        const picks = el('div', 'ff-cheats', board);
        const sideboard = world.frickFrack.sideboards[s.faction];
        if (!sideboard.length) el('span', 'ff-small', picks, 'Find rare cards dropped by downed hippies.');
        for (const card of sideboard) {
          if (card.arcana !== undefined) {
            const option = el('div', 'ff-cheat-option', picks);
            const spec = FRICK_FRACK_ARCANA[card.arcana];
            const pick = button('ff-button', option, '', () => {
              this.selectedMajor = card.id; this.majorTargets = []; this.majorValue = 1; this.sideboardOpen = true;
              this.render(s, available, world);
            });
            renderMajorArcanaCard(pick, card);
            pick.setAttribute('aria-label', `Inspect ${spec.name}`); pick.disabled = choosing;
            el('span', 'ff-cheat-name', option, spec.name);
          } else {
            const pick = this.action(picks, cardLabel(card), 'cheat', () => ({ cardId: card.id }));
            renderParodyCard(pick, card); renderFrickFrackCard(pick, card);
            pick.setAttribute('aria-label', `Play ${cardLabel(card)} once`); pick.disabled = choosing;
          }
        }
        if (!choosing) this.renderMajorPicker(board, s, available, world);
      } else if (s.phase === 'result') {
        const actions = el('div', 'ff-actions ff-main-actions', this.body);
        this.action(actions, 'Another hand', 'again'); this.action(actions, 'Leave table', 'exit');
      }
      const rules = el('details', 'ff-rules', this.body);
      el('summary', '', rules, 'Rules · combat & poker prizes');
      for (const rule of FRICK_FRACK_TABLE_RULES) el('p', '', rules, rule);
    }
    this.animateCards();
    this.frame();
    for (const b of this.body.querySelectorAll<HTMLButtonElement>('[data-ready-gate]')) b.disabled = world.time < s.readyAt;
    this.body.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }

  private hand(parent: HTMLElement, name: string, cards: readonly (FrickFrackCard | null)[], session: FrickFrackSession): void {
    const hand = el('section', `ff-hand ff-hand-${name === 'Wizard' ? 'dealer' : 'player'}`, parent);
    const known = cards.filter((c): c is FrickFrackCard => c !== null);
    const displayed = frickFrackTableCards(session, name === 'Wizard' ? 'dealer' : 'player');
    const total = displayed.length && !cards.includes(null) ? ` · ${frickFrackTotal(known)}` : '';
    const heading = el('h3', '', hand);
    el('span', '', heading, name === 'Wizard' ? 'The Wizard' : 'Your hand');
    if (total) el('span', 'ff-total', heading, total.slice(3));
    const row = el('div', 'ff-card-row', hand);
    if (!displayed.length) el('span', 'ff-small', row, 'Waiting for the deal');
    let hiddenIndex = 0;
    for (const {card, defeated} of displayed) {
      const slot = el('div', 'ff-card-slot', row);
      slot.dataset.motionKey = card ? `card:${card.id}` : `${name === 'Wizard' ? 'dealer' : 'player'}:hidden:${hiddenIndex++}`;
      const tile = el('div', `ff-card${card === null ? ' ff-card-back' : card.suit === 1 || card.suit === 2 ? ' ff-card-red' : ''}`, slot, card === null ? '✦' : cardLabel(card));
      if (card) tile.dataset.cardId = String(card.id);
      renderFrickFrackCard(tile, card);
      renderParodyCard(tile, card);
      tile.setAttribute('aria-label', `${cardLabel(card)}${defeated ? ' — defeated, does not count' : ''}`);
      if (defeated) {
        tile.classList.add('ff-card-defeated');
        const cross = el('span', 'ff-defeated-cross', tile, 'X'); cross.setAttribute('aria-hidden', 'true');
        el('span', 'ff-defeated-label', tile, 'DEFEATED');
      }
      if (card?.value !== undefined && !card.tarot && card.parody === undefined) el('span', 'ff-card-override', tile, String(card.value));
    }
  }

  private renderChoices(s: FrickFrackSession): void {
    const panel = el('section', 'ff-choice-panel', this.body);
    el('h3', '', panel, 'Choose one card');
    el('p', 'ff-small', panel, 'Keep one. The other is discarded.');
    const options = el('div', 'ff-choice-options', panel);
    for (const [index, card] of (s.arcana?.choices ?? []).entries()) {
      const option = el('div', 'ff-choice-option', options);
      const face = el('div', 'ff-card', option, cardLabel(card));
      renderFrickFrackCard(face, card); renderParodyCard(face, card);
      this.action(option, `Keep ${cardLabel(card)}`, 'choose', () => ({ choiceIndex: index as 0 | 1 }));
    }
  }

  private renderPrivatePeek(world: World, s: FrickFrackSession): void {
    const peek = getFrickFrackPrivateView(world, s.faction);
    if (!peek) return;
    const panel = el('section', 'ff-private-peek', this.body);
    panel.setAttribute('role', 'status');
    queueMicrotask(() => { if (panel.isConnected) panel.scrollIntoView({ block: 'nearest' }); });
    el('h3', '', panel, peek.kind === 'dealer' ? 'Private glance · hidden card' : 'Private glance · next three cards');
    el('p', 'ff-small', panel, 'Only you can see this glimpse. It closes shortly and does not reveal or play these cards.');
    const row = el('div', 'ff-card-row', panel);
    for (const card of peek.cards) {
      const face = el('div', 'ff-card', row, cardLabel(card));
      renderFrickFrackCard(face, card); renderParodyCard(face, card);
    }
  }

  private renderActiveEffects(s: FrickFrackSession): void {
    const a = s.arcana;
    if (!a) return;
    const labels = [a.strength && 'Strength · next bust protected', a.justice && 'Justice · ties win',
      a.world && 'World · exact 21 pays 2:1', a.judgement && !a.judgementUsed && 'Judgement · replay armed',
      a.softDealer !== undefined && `Wizard hand is ${a.softDealer ? 'soft' : 'hard'}`].filter(Boolean) as string[];
    if (labels.length) el('p', 'ff-active-effects', this.body, labels.join(' • '));
  }

  private renderMajorPicker(parent: HTMLElement, s: FrickFrackSession, available: number, world: World): void {
    const card = world.frickFrack.sideboards[s.faction].find(c => c.id === this.selectedMajor);
    if (!card || card.arcana === undefined) { this.selectedMajor = null; return; }
    const spec = FRICK_FRACK_ARCANA[card.arcana];
    const panel = el('section', 'ff-major-picker', parent);
    panel.setAttribute('aria-label', `${spec.name} effect`);
    queueMicrotask(() => { if (panel.isConnected) panel.scrollIntoView({ block: 'nearest' }); });
    el('h3', '', panel, spec.name);
    el('p', '', panel, spec.description);
    const needsOne = spec.target === 'one' || spec.target === 'confirmOne';
    const count = spec.target === 'two' ? 2 : needsOne ? 1 : 0;
    this.majorTargets = this.majorTargets.filter(id => s.player.some(c => c.id === id)).slice(0, count);
    if (count) {
      el('p', 'ff-small', panel, `Choose ${count === 1 ? 'a card' : 'two different cards'} in your hand.`);
      const targets = el('div', 'ff-target-options', panel);
      for (const [index, target] of s.player.entries()) {
        const selected = this.majorTargets.includes(target.id);
        const pick = button(`ff-button${selected ? ' ff-target-selected' : ''}`, targets, `Card ${index + 1}: ${cardLabel(target)}`, () => {
          this.majorTargets = selected ? this.majorTargets.filter(id => id !== target.id)
            : [...this.majorTargets.slice(-(count - 1 || this.majorTargets.length)), target.id].slice(-count);
          this.render(s, available, world);
        });
        pick.setAttribute('aria-pressed', String(selected));
      }
    }
    if (spec.target === 'value') {
      const field = el('label', 'ff-value-choice', panel, 'Value for the next draw');
      const select = el('select', '', field); select.setAttribute('aria-label', 'Next draw value');
      for (let value = 1; value <= 7; value++) { const option = el('option', '', select, String(value)); option.value = String(value); }
      select.value = String(this.majorValue); select.addEventListener('change', () => { this.majorValue = Number(select.value); });
    }
    const costly = spec.target === 'confirmOne';
    if (costly) el('p', 'ff-cost-warning', panel, `The Devil costs ${s.wager} more Flags. Your wager becomes ${s.wager * 2}. This payment cannot be undone.`);
    const actions = el('div', 'ff-actions', panel);
    const confirm = this.action(actions, costly ? `Pay ${s.wager} Flags & use The Devil` : `Use ${spec.name}`, 'cheat', () => ({
      cardId: card.id, ...(count ? { targetCardIds: [...this.majorTargets] } : {}),
      ...(spec.target === 'value' ? { value: this.majorValue } : {}), ...(costly ? { confirmCost: true } : {}),
    }));
    const blocker = majorPublicBlocker(card.arcana, s);
    confirm.disabled = !!blocker || !canConfirmMajor(card.arcana, this.majorTargets, s.player, this.majorValue, s.wager, available);
    if (blocker) el('p', 'ff-small', panel, blocker);
    if (costly && available < s.wager) el('p', 'ff-small', panel, 'You do not have enough held Flags to double this wager.');
    button('ff-button', actions, 'Cancel', () => { this.selectedMajor = null; this.majorTargets = []; this.render(s, available, world); });
  }


  /** Revisions and UI rerenders may replace DOM during a deal. Keep the original
   * wall-clock start, so resource updates never redeal or prolong a card. */
  private rememberCardMotion(s: FrickFrackSession): void {
    const next = tableSnapshot(s), now = performance.now();
    if (this.tableState?.sessionId !== next.sessionId || !next.cards.length) this.clearCardMotion();
    const keys = new Set(next.cards.map(c => c.key));
    for (const [key, motion] of this.motions) {
      if (!keys.has(key) || now >= motion.startedAt + motionDuration(motion)) this.motions.delete(key);
    }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) this.clearCardMotion();
    else for (const motion of planCardMotion(this.tableState, next)) {
      this.motions.set(motion.key, { ...motion, startedAt: now + motion.delay });
    }
    this.tableState = next;
  }

  private animateCards(): void {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { this.clearCardMotion(); return; }
    const deck = this.body.querySelector<HTMLElement>('.ff-deck-card');
    if (!deck || typeof deck.animate !== 'function') return;
    const origin = deck.getBoundingClientRect(), now = performance.now();
    for (const slot of this.body.querySelectorAll<HTMLElement>('.ff-card-slot')) {
      const motion = this.motions.get(slot.dataset.motionKey ?? '');
      const face = slot.querySelector<HTMLElement>('.ff-card');
      if (!motion || !face || now >= motion.startedAt + motionDuration(motion)) continue;
      const target = slot.getBoundingClientRect();
      if (!target.width || !target.height) continue;
      const dx = origin.left + origin.width / 2 - (target.left + target.width / 2);
      const dy = origin.top + origin.height / 2 - (target.top + target.height / 2);
      const delay = motion.startedAt - now;
      const animate = (node: HTMLElement, frames: Keyframe[], duration: number, start: number) => {
        this.animations.push(node.animate(frames, { duration, delay: start, fill: 'backwards', easing: 'cubic-bezier(.2,.75,.25,1)' }));
      };
      if (motion.kind === 'deal') {
        animate(slot, [
          { transform: `translate(${dx}px,${dy}px) rotate(-13deg) scale(.74)`, opacity: 0 },
          { transform: `translate(${dx * .7}px,${dy * .7}px) rotate(-8deg) scale(.94)`, opacity: 1, offset: .16 },
          { transform: 'translate(0,-3px) rotate(1.5deg) scale(1.025)', opacity: 1, offset: .82 },
          { transform: 'translate(0,0) rotate(0) scale(1)', opacity: 1 },
        ], DEAL_MS, delay);
      }
      if (!motion.hidden) {
        // Opaque decorative back covers the face until the midpoint. The face
        // itself only exists once the public session has authoritatively revealed it.
        const back = el('div', 'ff-motion-back', face, '✦'); back.setAttribute('aria-hidden', 'true');
        const flipDelay = delay + (motion.kind === 'deal' ? DEAL_MS : 0);
        animate(face, [{ transform: 'rotateY(-180deg)' }, { transform: 'rotateY(0)' }], FLIP_MS, flipDelay);
        animate(back, [{ opacity: 1, offset: 0 }, { opacity: 1, offset: .49 }, { opacity: 0, offset: .5 }, { opacity: 0, offset: 1 }], FLIP_MS, flipDelay);
      }
    }
  }
  private cancelAnimations(): void { for (const animation of this.animations) animation.cancel(); this.animations = []; }
  private clearCardMotion(): void { this.cancelAnimations(); this.motions.clear(); }

  private setWager(value: number): void { this.wager = clampWager(value, this.wagerAvailable); if (this.wagerInput) this.wagerInput.value = String(this.wager); }
  private action(parent: HTMLElement, text: string, action: TableAction, extra?: () => TableExtras): HTMLButtonElement {
    return button('ff-button', parent, text, () => this.send(action, extra?.()), 'confirm');
  }
  private send(action: TableAction, extra?: TableExtras): void {
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
      const buttons = [...this.root.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last?.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first?.focus(); }
      ev.stopPropagation();
    }
  };
  dispose(): void { this.clearCardMotion(); this.tableState = null; window.removeEventListener('keydown', this.onKey, true); window.removeEventListener('fh-menu-back', this.onBack); document.documentElement.classList.remove('ff-conversation-active'); this.root.remove(); this.offer.remove(); }
}
