import { sleeveCardDetails } from './frickFrackSleeve';
import { flagCounter } from './flagCounter';
import { setFrickFrackView } from '../render/frickFrackView';
import type { CardView, Rect } from '../render/frickFrackScene';
import { frickFrackTableCards } from '../sim/frickFrackTable';
import { handFlagBlocker } from '../sim/systems/recruitment';
import { frickFrackInputLocked } from '../game/frickFrackControls';
/** Regular-mode wizard dialogue and card table. Simulation owns every wager and card. */
import type { AppApi } from '../game/app';
import { frickFrackDialogue, FRICK_FRACK_LETTER_SECONDS, frickFrackTotal, frickFrackTarget } from '../sim/frickFrack';
import type { FrickFrackCard, FrickFrackSession } from '../sim/frickFrack';
import type { Command } from '../sim/commands';
import type { World } from '../sim/world';
import type { UiHost, UiPart } from './core';
import { button as domButton, el, setText, show } from './dom';
import './frickFrack.css';
import './frickFrackTarot.css';
import { tarotCardLabel } from './frickFrackTarot';
import './frickFrackParody.css';
import { parodyCardLabel } from './frickFrackParody';
import { majorArcanaLabel } from './frickFrackArcana';
import { FRICK_FRACK_ARCANA } from '../sim/frickFrackArcana';
import { getFrickFrackPrivateView } from '../sim/frickFrackPrivate';
import './frickFrackArcana.css';
import './frickFrackEngine.css';

/** Native disabled semantics plus an explicit guard for dispatched events. */
const button: typeof domButton = (cls, parent, markup, onClick, sfx) => {
  const control = domButton(cls, parent, markup, ev => { if (!control.disabled) onClick(ev); }, sfx);
  return control;
};

type TableCommand = Extract<Command, { t: 'frickFrack' }>;
type TableAction = TableCommand['action'];
type TableExtras = Pick<TableCommand, 'wager' | 'cardId' | 'targetCardIds' | 'value' | 'confirmCost' | 'choiceIndex'>;
/** Player-facing rules, kept outside the table layout for readable collapsed help. */
export const FRICK_FRACK_TABLE_RULES = [
  '136 cards: 52 standard, 56 Rider–Waite minor arcana, and 28 original CCG/sports cards. Major Arcana are one-use sideboard effects, never dealer draws.',
  'Choose your wager, then press Deal once. Your wager is committed while the wizard rolls one six-sided die on the blanket and automatically deals the cards. Leaving during the roll or hand forfeits your wager. The target is 20 + the roll (21–26), fixed for the whole hand. Closest to that target without going over wins. Aces count as 1 or 11; courts count as 10. CCG cards use their printed VALUE 1–7, not decorative stats. The wizard stands at the target minus 4, including soft hands. Base wins pay 1:1, including a two-card target; ties return your wager unless an Arcana changes the result. Extra winnings go to your altar stock.',
  'On reveal, CCG cards fight opponent CCG cards only. Friendly cards coexist; ordinary and tarot cards do not fight. The lower value is defeated; equal values both die. Defeated cards stay visible with an X, but do not count toward totals, poker prizes, effects or further fights.',
  'At hand end, your strongest pair, three of a kind, or four of a kind multiplies base win profit by 2, 3, or 4. These prizes do not stack. Your returned stake is not multiplied; The World’s extra stake is added separately.',
  'A non-bust five-card straight at hand end copies its highest printed card into your sleeve, even on a blackjack loss or push. No straight prize for a bust, and no mid-hand award.',
  'Poker uses printed ranks, never effect-modified values. Standard straights include A–2–3–4–5 or 10–J–Q–K–A, with no wraparound. Tarot Page counts as J; Queen and King keep their ranks. Tarot Knight is a distinct kind rank and cannot join a straight. CCG printed ranks are 1–7; printed 1 is an Ace for poker only.',
] as const;
/** Roll presentation reads authoritative state/time only; a rerender cannot reroll the die. */
export function frickFrackDicePresentation(s: FrickFrackSession, worldTime: number): { result: number; progress: number; rollKey: string; label: string } | null {
  const result = s.dieResult;
  if (!Number.isInteger(result) || result! < 1 || result! > 6) return null;
  const duration = (s.rollEndsAt ?? 0) - (s.rollStartedAt ?? 0);
  const progress = s.phase === 'rolling' ? Math.max(0, Math.min(1, duration > 0 ? (worldTime - (s.rollStartedAt ?? 0)) / duration : 0)) : 1;
  const label = s.phase === 'rolling' ? 'The wizard is rolling the die… Cards deal automatically when it settles.'
    : `Rolled ${result} · Target ${frickFrackTarget(s)} · Wizard stands at ${frickFrackTarget(s) - 4}`;
  return { result: result!, progress, rollKey: `${s.id}:${s.rollNumber ?? 0}`, label };
}
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
  if ([0,10,12,13,16].includes(arcana) && !s.player.length) return 'There is no card in your hand to affect.';
  if ([5,16,19].includes(arcana) && !s.dealer.length) return 'The wizard has no cards to affect.';
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
  private readonly flags: HTMLElement;
  private readonly flagValue: HTMLElement;
  private readonly host: UiHost;
  private key = '';
  private pending = '';
  private pendingAt = 0;
  private lastSleevePlayAt = -Infinity;
  private text: HTMLElement | null = null;
  private textSource = '';
  private next: HTMLButtonElement | null = null;
  private active: FrickFrackSession | null = null;
  private tableWorld: World | null = null;
  private wager = 1;
  private wagerInput: HTMLInputElement | null = null;
  private wagerAvailable = 0;
  private focusBefore: HTMLElement | null = null;
  private sideboardOpen = false;
  private selectedMajor: number | null = null;
  private sleeveIndex = 0;
  private sleeveViewer: HTMLElement | null = null;
  private majorTargets: number[] = [];
  private majorValue = 1;
  private readonly engineCards = new Map<HTMLElement, { card: FrickFrackCard | null; key: string; order: number; defeated: boolean }>();
  private engineRound = 0;
  private dieStage: HTMLElement | null = null;
  private deckStage: HTMLElement | null = null;
  private dieLabel: HTMLElement | null = null;
  private lastEnginePhase = '';
  private readonly reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

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
    this.flags = el('div', 'ff-flag-counter res frame', panel);
    this.flagValue = flagCounter(this.flags).value;
    this.flags.setAttribute('role', 'status');
    this.flags.setAttribute('aria-label', 'Available player Flags');
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
    if (session?.phase === 'betting' && this.lastEnginePhase !== 'betting') this.engineRound++;
    this.lastEnginePhase = session?.phase ?? '';
    if (world !== this.tableWorld || !session || session.id !== this.active?.id || session.faction !== this.active?.faction || session.phase !== 'playing' || session.arcana?.choices?.length) {
      this.sideboardOpen = false; this.selectedMajor = null; this.majorTargets = []; this.sleeveIndex = 0;
      this.sleeveViewer?.remove(); this.sleeveViewer = null; this.body.inert = false; this.key = "";
    }
    this.active = session; this.tableWorld = world;
    show(this.root, session !== null);
    this.root.classList.toggle('ff-in-world', session?.phase === 'dialogue' || session?.phase === 'empty');
    document.documentElement.classList.toggle('ff-conversation-active', session !== null);
    if (!session || !world) {
      setFrickFrackView(null); this.engineCards.clear(); this.dieStage = null; this.deckStage = null; this.dieLabel = null;
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
    const signature = `${session.faction}:${session.id}:${session.revision}:${session.phase}:${available}:${world.frickFrack.sideboards[session.faction].map(c => c.id).join(',')}:${privateView?.expiresAt ?? 0}`;
    if (this.pending && (this.pending !== `${session.id}:${session.revision}` || now - this.pendingAt > 2500)) { this.pending = ''; this.key = ''; }
    if (signature !== this.key) {
      this.key = signature; this.render(session, available, world);
    }
    this.frame();
  }

  frame(): void {
    const session = this.active, w = this.host.app.world;
    if (!session || !w) { setFrickFrackView(null); return; }
    if (this.dieLabel) { const die = frickFrackDicePresentation(session, w.time); if (die) setText(this.dieLabel, die.label); }
    if (this.text) setText(this.text, revealedDialogue(this.textSource, w.time - session.dialogueStartedAt));
    if (this.next) this.next.disabled = w.time + 1e-6 < session.readyAt || this.pending === `${session.id}:${session.revision}`;
    for (const b of this.body.querySelectorAll<HTMLButtonElement>('[data-ready-gate]')) b.disabled = w.time + 1e-6 < session.readyAt || this.pending === `${session.id}:${session.revision}`;
  }

  /** Geometry reads run once after the UI root finishes its DOM writes. */
  publishEngineFrame(): void {
    const session = this.active;
    if (!session || !this.host.app.world) { setFrickFrackView(null); return; }
    this.publishEngineView(session);
  }

  private render(s: FrickFrackSession, available: number, world: World): void {
    this.body.inert = false;
    const focused = this.sleeveViewer?.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.sleeveControl : undefined;
    this.sleeveViewer?.remove(); this.sleeveViewer = null;
    this.engineCards.clear(); this.dieStage = null; this.deckStage = null; this.dieLabel = null;
    this.body.replaceChildren(); this.text = null; this.next = null; this.wagerInput = null;
    setText(this.title, s.phase === 'dialogue' || s.phase === 'empty' ? 'The Frick-frack Wizard' : 'Frick-frack');
    if (this.flagValue) setText(this.flagValue, String(available));
    setText(this.status, `${s.wager > 0 ? `Wager ${s.wager} · ` : ''}${s.phase === 'playing' || s.phase === 'rolling' ? 'Exit forfeits your wager.' : 'The burn continues outside.'}`);
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
      const stage = el('div', 'ff-table-stage', this.body);
      this.deckStage = el('div', 'ff-deck-stage', stage);
      this.deckStage.setAttribute('aria-hidden', 'true');
      const die = frickFrackDicePresentation(s, world.time);
      {
        const tray = el('section', 'ff-die-tray', stage);
        tray.setAttribute('aria-label', 'Target die');
        this.dieStage = el('div', 'ff-die-stage', tray);
        this.dieStage.setAttribute('aria-hidden', 'true');
        const target = el('div', 'ff-target-panel', tray);
        el('h3', 'ff-target-title', target, s.phase === 'rolling' ? 'Rolling the target' : die ? `Target ${frickFrackTarget(s)}` : 'Ready to deal');
        this.dieLabel = el('p', 'ff-die-label', target, die?.label ?? 'Choose your wager. Deal rolls the die and deals your hand.');
        this.dieLabel.setAttribute('role', 'status'); this.dieLabel.setAttribute('aria-live', 'polite');
        this.dieLabel.setAttribute('aria-atomic', 'true');
      }
      const cards = el('div', 'ff-hands', stage);
      this.hand(cards, 'Wizard', s.dealer, s);
      this.hand(cards, 'You', s.player, s);
      const notices = el('div', 'ff-table-notices', this.body);
      if (s.remark) { const remark = el('p', 'ff-wizard-remark', notices, s.remark); remark.setAttribute('role', 'status'); }
      if (s.message) el('p', `ff-result ff-${s.result ?? 'waiting'}`, notices, s.message);
      const betting = s.phase === 'betting' || s.phase === 'result', playing = s.phase === 'playing';
      const committed = playing || s.phase === 'rolling';
      const choosing = !!s.arcana?.choices?.length;
      const field = el('label', 'ff-wager', this.body);
      el('span', '', field, 'Flags to wager');
      const row = el('div', 'ff-wager-row', field);
      this.wagerAvailable = available;
      this.wager = committed ? s.wager : clampWager(this.wager, available);
      const adjust = (label: string, name: string, value: () => number) => {
        const b = button('ff-button', row, label, () => { if (!b.disabled) this.setWager(value()); });
        b.setAttribute('aria-label', name); b.dataset.wager = label;
        b.disabled = !betting || available < 1;
        return b;
      };
      adjust('−', 'Wager one fewer Flag', () => this.wager - 1);
      this.wagerInput = el('input', '', row);
      this.wagerInput.setAttribute('aria-label', 'Flags to wager');
      this.wagerInput.type = 'number'; this.wagerInput.min = '1'; this.wagerInput.max = String(available);
      this.wagerInput.step = '1'; this.wagerInput.inputMode = 'numeric'; this.wagerInput.value = String(this.wager);
      this.wagerInput.disabled = !betting || available < 1;
      this.wagerInput.addEventListener('change', () => { if (!this.wagerInput?.disabled) this.setWager(Number(this.wagerInput?.value)); });
      adjust('+', 'Wager one more Flag', () => this.wager + 1);
      adjust('All', 'Wager all available Flags', () => this.wagerAvailable);
      const actions = el('div', 'ff-actions ff-main-actions', this.body);
      this.action(actions, 'Deal', 'bet', () => ({ wager: clampWager(Number(this.wagerInput?.value ?? this.wager), available) })).disabled = !betting || available < 1;
      this.action(actions, 'Hit', 'hit').disabled = !playing || choosing;
      this.action(actions, 'Stand', 'stand').disabled = !playing || choosing;
      const sleeve = button('ff-button', actions, 'Sleeve', () => {
        if (sleeve.disabled) return;
        this.sideboardOpen = true; this.render(s, available, world);
      });
      sleeve.dataset.action = 'sleeve'; sleeve.disabled = !playing;
      sleeve.setAttribute('aria-expanded', String(playing && this.sideboardOpen)); sleeve.setAttribute('aria-controls', 'ff-sleeve');
      const exit = this.action(actions, 'Exit', 'exit');
      exit.setAttribute('aria-label', committed ? 'Exit · forfeit wager' : 'Leave table');
      exit.title = committed ? 'Leaving forfeits your wager' : 'Leave table';
      this.updateWagerControls();
      const extras = el('div', 'ff-extras', this.body);
      if (playing) {
        if (choosing) this.renderChoices(s, extras);
        this.renderActiveEffects(s, extras);
        this.renderPrivatePeek(world, s, extras);
        if (this.sideboardOpen) this.renderSleeve(s, available, world);

      }
    }
    this.frame();
    if (this.pending) for (const b of this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('[data-action],input,select')) b.disabled = true;
    for (const b of this.body.querySelectorAll<HTMLButtonElement>('[data-ready-gate]')) b.disabled = world.time < s.readyAt;
    const focusScope = this.sleeveViewer ?? this.body;
    const restored = focused ? focusScope.querySelector<HTMLButtonElement>(`[data-sleeve-control="${focused}"]:not(:disabled)`) : null;
    (restored ?? focusScope.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus({ preventScroll: true });
  }

  private hand(parent: HTMLElement, name: string, cards: readonly (FrickFrackCard | null)[], session: FrickFrackSession): void {
    const hand = el('section', `ff-hand ff-hand-${name === 'Wizard' ? 'dealer' : 'player'}`, parent);
    const known = cards.filter((c): c is FrickFrackCard => c !== null);
    const displayed = frickFrackTableCards(session, name === 'Wizard' ? 'dealer' : 'player');
    const total = displayed.length && !cards.includes(null) ? ` · ${frickFrackTotal(known, frickFrackTarget(session))}` : '';
    const heading = el('h3', '', hand);
    el('span', '', heading, name === 'Wizard' ? 'The Wizard' : 'Your hand');
    if (total) el('span', 'ff-total', heading, total.slice(3));
    const row = el('div', 'ff-card-row', hand);
    if (!displayed.length) el('span', 'ff-small', row, 'Waiting for the deal');
    for (const [index, {card, defeated}] of displayed.entries()) {
      const tile = el('div', `ff-card${card === null ? ' ff-card-back' : card.suit === 1 || card.suit === 2 ? ' ff-card-red' : ''}`, row, card === null ? '✦' : cardLabel(card));
      if (card) tile.dataset.cardId = String(card.id);
      this.engineCard(tile, card, `${name}:${index}`, index * 2 + (name === 'Wizard' ? 0 : 1), defeated);
      tile.setAttribute('aria-label', `${cardLabel(card)}${defeated ? ' — defeated, does not count' : ''}`);
      if (defeated) {
        tile.classList.add('ff-card-defeated');
        const cross = el('span', 'ff-defeated-cross', tile, 'X'); cross.setAttribute('aria-hidden', 'true');
        el('span', 'ff-defeated-label', tile, 'DEFEATED');
      }
      if (card?.value !== undefined && !card.tarot && card.parody === undefined) el('span', 'ff-card-override', tile, String(card.value));
    }
  }

  private renderChoices(s: FrickFrackSession, parent: HTMLElement): void {
    const panel = el('section', 'ff-choice-panel', parent);
    el('h3', '', panel, 'Choose one card');
    el('p', 'ff-small', panel, 'Keep one. The other is discarded.');
    const options = el('div', 'ff-choice-options', panel);
    for (const [index, card] of (s.arcana?.choices ?? []).entries()) {
      const option = el('div', 'ff-choice-option', options);
      const face = el('div', 'ff-card', option, cardLabel(card));
      this.engineCard(face, card, `extra:${this.engineCards.size}:${card.id}`, -1);
      this.action(option, `Keep ${cardLabel(card)}`, 'choose', () => ({ choiceIndex: index as 0 | 1 }));
    }
  }

  private renderPrivatePeek(world: World, s: FrickFrackSession, parent: HTMLElement): void {
    const peek = getFrickFrackPrivateView(world, s.faction);
    if (!peek) return;
    const panel = el('section', 'ff-private-peek', parent);
    panel.setAttribute('role', 'status');
    queueMicrotask(() => { if (panel.isConnected) panel.scrollIntoView({ block: 'nearest' }); });
    el('h3', '', panel, peek.kind === 'dealer' ? 'Private glance · hidden card' : 'Private glance · next three cards');
    el('p', 'ff-small', panel, 'Only you can see this glimpse. It closes shortly and does not reveal or play these cards.');
    const row = el('div', 'ff-card-row', panel);
    for (const card of peek.cards) {
      const face = el('div', 'ff-card', row, cardLabel(card));
      this.engineCard(face, card, `extra:${this.engineCards.size}:${card.id}`, -1);
    }
  }

  private renderActiveEffects(s: FrickFrackSession, parent: HTMLElement): void {
    const a = s.arcana;
    if (!a) return;
    const labels = [a.strength && 'Strength · next bust protected', a.justice && 'Justice · ties win',
      a.world && `World · exact ${frickFrackTarget(s)} pays 2:1`, a.judgement && !a.judgementUsed && 'Judgement · replay armed',
      a.softDealer !== undefined && `Wizard hand is ${a.softDealer ? 'soft' : 'hard'}`].filter(Boolean) as string[];
    if (labels.length) el('p', 'ff-active-effects', parent, labels.join(' • '));
  }

  private closeSleeve(): void {
    this.sideboardOpen = false; this.selectedMajor = null; this.majorTargets = [];
    this.refreshSleeve();
    this.body.querySelector<HTMLButtonElement>('[data-action="sleeve"]')?.focus({ preventScroll: true });
  }
  private refreshSleeve(): void {
    const s = activeFrickFrack(this.host.app), w = this.host.app.world;
    if (s && w) this.render(s, w.avatarOf(s.faction)?.carried.length ?? 0, w);
  }
  private browseSleeve(delta: number): void {
    const s = activeFrickFrack(this.host.app), w = this.host.app.world;
    if (!s || !w || !this.sideboardOpen) return;
    const cards = w.frickFrack.sideboards[s.faction];
    const current = Math.max(0, cards.findIndex(c => c.id === this.selectedMajor));
    this.sleeveIndex = Math.max(0, Math.min(cards.length - 1, current + delta));
    this.selectedMajor = cards[this.sleeveIndex]?.id ?? null;
    this.majorTargets = []; this.majorValue = 1; this.refreshSleeve();
  }
  private renderSleeve(s: FrickFrackSession, available: number, world: World): void {
    const cards = world.frickFrack.sideboards[s.faction];
    let index = cards.findIndex(c => c.id === this.selectedMajor);
    if (index < 0) { index = Math.max(0, Math.min(this.sleeveIndex, cards.length - 1)); this.majorTargets = []; this.majorValue = 1; }
    this.sleeveIndex = index;
    const card = cards[index]; this.selectedMajor = card?.id ?? null;
    this.body.inert = true;
    const viewer = this.sleeveViewer = el('section', 'ff-sleeve-viewer', this.root);
    viewer.id = 'ff-sleeve'; viewer.setAttribute('role', 'dialog'); viewer.setAttribute('aria-modal', 'true');
    viewer.setAttribute('aria-labelledby', 'ff-sleeve-title');
    const header = el('header', 'ff-sleeve-header', viewer);
    el('h3', '', header, 'Cards up your sleeve').id = 'ff-sleeve-title';
    const close = button('ff-button', header, 'Close', () => this.closeSleeve());
    close.dataset.sleeveControl = 'close'; close.setAttribute('aria-label', 'Close sleeve and return to table');
    const content = el('div', 'ff-sleeve-content', viewer);
    const showcase = el('div', 'ff-sleeve-showcase', content);
    const previous = button('ff-button ff-sleeve-arrow', showcase, '‹', () => this.browseSleeve(-1));
    previous.dataset.sleeveControl = 'previous'; previous.setAttribute('aria-label', 'Previous sleeve card'); previous.disabled = !card || index === 0;
    const face = el('div', 'ff-sleeve-card', showcase);
    if (card) this.engineCard(face, card, `sleeve-viewer:${card.id}`, -1);
    const next = button('ff-button ff-sleeve-arrow', showcase, '›', () => this.browseSleeve(1));
    next.dataset.sleeveControl = 'next'; next.setAttribute('aria-label', 'Next sleeve card'); next.disabled = !card || index === cards.length - 1;
    const details = el('div', 'ff-sleeve-details', content);
    const position = el('p', 'ff-sleeve-index', details, card ? `${index + 1} of ${cards.length} · One use` : 'No cards in your sleeve');
    position.setAttribute('role', 'status');
    if (!card) { el('p', '', details, 'Find rare cards dropped by downed hippies. Close to return to your hand.'); return; }
    const info = sleeveCardDetails(card);
    el('p', 'ff-sleeve-family', details, info.family);
    el('h2', '', details, info.name);
    el('p', 'ff-sleeve-description', details, info.description);
    if (s.remark) el('p', 'ff-sleeve-feedback', details, s.remark).setAttribute('role', 'status');
    if (this.pending) el('p', 'ff-sleeve-feedback', details, 'Waiting for the table…').setAttribute('role', 'status');
    if (card.arcana !== undefined) this.renderMajorPicker(details, s, available, world);
    else {
      const play = this.action(details, 'Play Card', 'cheat', () => ({ cardId: card.id }));
      play.dataset.sleeveControl = 'play'; play.disabled = !!this.pending || !!s.arcana?.choices?.length || s.phase !== 'playing';
      if (play.disabled) el('p', '', details, this.pending ? 'Waiting for the table…' : s.phase !== 'playing' ? 'Cards are played during a hand.' : 'Finish the current choice first.');
    }
    el('p', 'ff-sleeve-hint', details, 'Browse with the arrows. A card is only used when you press Play Card.');
  }

  private renderMajorPicker(parent: HTMLElement, s: FrickFrackSession, available: number, world: World): void {
    const card = world.frickFrack.sideboards[s.faction].find(c => c.id === this.selectedMajor);
    if (!card || card.arcana === undefined) { this.selectedMajor = null; return; }
    const spec = FRICK_FRACK_ARCANA[card.arcana];
    const panel = el('section', 'ff-major-picker', parent);
    panel.setAttribute('aria-label', `${spec.name} effect`);

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
        pick.setAttribute('aria-pressed', String(selected)); pick.dataset.sleeveControl = `target-${target.id}`;
      }
    }
    if (spec.target === 'value') {
      const field = el('label', 'ff-value-choice', panel, 'Value for the next draw');
      const select = el('select', '', field); select.setAttribute('aria-label', 'Next draw value'); select.dataset.sleeveControl = 'value';
      for (let value = 1; value <= 7; value++) { const option = el('option', '', select, String(value)); option.value = String(value); }
      select.value = String(this.majorValue); select.addEventListener('change', () => { this.majorValue = Number(select.value); });
    }
    const costly = spec.target === 'confirmOne';
    if (costly) el('p', 'ff-cost-warning', panel, `The Devil costs ${s.wager} more Flags. Your wager becomes ${s.wager * 2}. This payment cannot be undone.`);
    const actions = el('div', 'ff-actions', panel);
    const confirm = this.action(actions, costly ? `Play Card · Pay ${s.wager} Flags` : 'Play Card', 'cheat', () => ({
      cardId: card.id, ...(count ? { targetCardIds: [...this.majorTargets] } : {}),
      ...(spec.target === 'value' ? { value: this.majorValue } : {}), ...(costly ? { confirmCost: true } : {}),
    }));
    confirm.dataset.sleeveControl = 'play';
    const blocker = majorPublicBlocker(card.arcana, s);
    confirm.disabled = !!blocker || !canConfirmMajor(card.arcana, this.majorTargets, s.player, this.majorValue, s.wager, available);
    if (blocker) el('p', 'ff-small', panel, blocker);
    if (costly && available < s.wager) el('p', 'ff-small', panel, 'You do not have enough held Flags to double this wager.');
    if (confirm.disabled && !blocker && !(costly && available < s.wager)) el('p', 'ff-small', panel, `Select ${count} ${count === 1 ? 'card' : 'different cards'} from your hand to play this effect.`);
  }

  /** Accessible placeholders lay out/pick cards; all visible artwork is engine mesh. */
  private engineCard(tile: HTMLElement, card: FrickFrackCard | null, key: string, order: number, defeated = false): void {
    tile.classList.add('ff-engine-card');
    if (card?.tarot) tile.classList.add('ff-tarot-card');
    if (card?.parody !== undefined) tile.classList.add('ff-parody-card');
    if (card?.arcana !== undefined) tile.classList.add('ff-arcana-card');
    tile.dataset.engineKey = key;
    tile.setAttribute('aria-label', `${cardLabel(card)}${defeated ? ' — defeated, does not count' : ''}`);
    this.engineCards.set(tile, { card: card ? { ...card } : null, key, order, defeated });
  }

  private publishEngineView(s: FrickFrackSession): void {
    if (!['rolling', 'betting', 'playing', 'result'].includes(s.phase)) { setFrickFrackView(null); return; }
    const panel = this.root.querySelector<HTMLElement>('.ff-panel');
    if (!panel) return;
    const rect = (r: DOMRect): Rect => ({ x: r.x, y: r.y, width: r.width, height: r.height });
    const cards: CardView[] = [];
    // One read-only layout batch; there are no per-card writes or DOM animation tracks.
    for (const [tile, value] of this.engineCards) {
      // Closed <details> may retain layout boxes in Chromium; those cards must not become phantom meshes.
      if (!tile.isConnected || tile.closest('details:not([open]), [hidden]') || !tile.getClientRects().length) continue;
      const r = tile.getBoundingClientRect();
      const clips = [tile.closest('.ff-extras'), tile.closest('.ff-card-row')].filter((node): node is Element => !!node);
      if (clips.some(node => { const clip = node.getBoundingClientRect(); return r.left < clip.left - 1 || r.right > clip.right + 1 || r.top < clip.top - 1 || r.bottom > clip.bottom + 1; })) continue;
      if (r.width > 0 && r.height > 0) cards.push({ ...value, rect: rect(r) });
    }
    const dieState = frickFrackDicePresentation(s, this.host.app.world!.time);
    const die = dieState && this.dieStage?.isConnected ? { result: dieState.result, progress: dieState.progress,
      rollKey: dieState.rollKey, rect: rect(this.dieStage.getBoundingClientRect()) } : undefined;
    const deck = this.deckStage?.isConnected ? rect(this.deckStage.getBoundingClientRect()) : undefined;
    setFrickFrackView({ sessionKey: `${s.id}:${s.rollNumber ?? this.engineRound}`, panel: rect(panel.getBoundingClientRect()), cards,
      reducedMotion: this.reducedMotion?.matches ?? false, ...(die ? { die } : {}), ...(deck ? { deck } : {}), ...(this.sleeveViewer ? { sleeveOverlay: rect(this.root.getBoundingClientRect()) } : {}) });
  }

  private setWager(value: number): void {
    if (!this.active || !['betting', 'result'].includes(this.active.phase) || this.pending) return;
    this.wager = clampWager(value, this.wagerAvailable);
    if (this.wagerInput) this.wagerInput.value = String(this.wager);
    this.updateWagerControls();
  }
  private updateWagerControls(): void {
    for (const b of this.body.querySelectorAll<HTMLButtonElement>('[data-wager]')) {
      b.disabled = !this.active || !['betting', 'result'].includes(this.active.phase) || !!this.pending || this.wagerAvailable < 1
        || (b.dataset.wager === '−' ? this.wager <= 1 : this.wager >= this.wagerAvailable);
    }
  }
  private action(parent: HTMLElement, text: string, action: TableAction, extra?: () => TableExtras): HTMLButtonElement {
    const control = button('ff-button', parent, text, () => { if (!control.disabled) this.send(action, extra?.()); }, 'confirm');
    control.setAttribute('data-action', action);
    return control;
  }
  private send(action: TableAction, extra?: TableExtras): void {
    const s = activeFrickFrack(this.host.app), w = this.host.app.world;
    if (!s || !w || this.pending === `${s.id}:${s.revision}`) return;
    // A single Deal commits the chosen wager, rolls and then automatically deals.
    if ((action === 'next' || action === 'play' || action === 'decline') && w.time < s.readyAt) return;
    if (s.phase === 'rolling' && action !== 'exit' && action !== 'decline') return;
    if (action === 'bet' && !['betting', 'result'].includes(s.phase) || action === 'again' && s.phase !== 'result') return;
    if (['hit', 'stand', 'cheat', 'choose'].includes(action) && s.phase !== 'playing') return;
    if (['hit', 'stand', 'cheat'].includes(action) && s.arcana?.choices?.length) return;
    // A fast second tap must not play the newly selected successor after acknowledgement.
    if (action === 'cheat' && performance.now() - this.lastSleevePlayAt < 450) return;
    if (action === 'cheat') this.lastSleevePlayAt = performance.now();
    this.pending = `${s.id}:${s.revision}`; this.pendingAt = performance.now();
    this.host.app.submit({ t: 'frickFrack', faction: s.faction, sessionId: s.id, revision: s.revision, action, ...extra });
    for (const b of this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('[data-action],input,select')) b.disabled = true;
  }
  private onBack = (ev: Event): void => { if (!this.active) return; ev.preventDefault(); if (this.sideboardOpen) { this.closeSleeve(); return; } if (this.active.phase !== 'dialogue') this.send('exit'); };
  private onKey = (ev: KeyboardEvent): void => {
    if (!activeFrickFrack(this.host.app)) return;
    if (this.sideboardOpen && ['ArrowLeft', 'ArrowRight'].includes(ev.key) && !(ev.target instanceof HTMLSelectElement)) { ev.preventDefault(); ev.stopImmediatePropagation(); this.browseSleeve(ev.key === 'ArrowLeft' ? -1 : 1); return; }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); if (!ev.repeat) { if (this.sideboardOpen) this.closeSleeve(); else if (this.active?.phase !== 'dialogue') this.send('exit'); } return; }
    // Other game shortcuts must not fire through this modal. Tab retains native focus traversal.
    if (ev.key !== 'Tab' && !(ev.target instanceof Node && this.root.contains(ev.target))) ev.stopPropagation();
    if (ev.key === 'Tab') {
      const buttons = [...(this.sleeveViewer ?? this.root).querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')].filter(b => !b.closest('[hidden], details:not([open])') || b.tagName === 'SUMMARY');
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last?.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first?.focus(); }
      ev.stopPropagation();
    }
  };
  dispose(): void { setFrickFrackView(null); this.engineCards.clear(); window.removeEventListener('keydown', this.onKey, true); window.removeEventListener('fh-menu-back', this.onBack); document.documentElement.classList.remove('ff-conversation-active'); this.root.remove(); this.offer.remove(); }
}
