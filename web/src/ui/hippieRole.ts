import { NEUTRAL } from '../sim/types';
import { FACTION_DEFS } from '../sim/constants';
import { joinableHippieAltar } from '../sim/systems/recruitment';
import { canReachSwagWizard } from '../sim/systems/frickFrack';
import { frickFrackTotal, frickFrackTarget } from '../sim/frickFrack';
import { cardLabel } from './frickFrack';
import type { World } from '../sim/world';
import type { UiHost, UiPart } from './core';
import { button, el, setDisabled, setText, show } from './dom';

/** The invite is unicast; no title button or shared lobby role identifies these players. */
export class HippieRolePart implements UiPart {
  private readonly root: HTMLElement;
  private readonly claim: HTMLButtonElement;
  private readonly pick: HTMLButtonElement;
  private readonly altar: HTMLButtonElement;
  private readonly aim: HTMLButtonElement;
  private readonly menu: HTMLButtonElement;
  private readonly task: HTMLButtonElement;
  private readonly frick: HTMLButtonElement;
  private readonly table: HTMLElement;
  private readonly cards: HTMLElement;
  private readonly tableMessage: HTMLElement;
  private readonly wager: HTMLInputElement;
  private readonly deal: HTMLButtonElement;
  private readonly hit: HTMLButtonElement;
  private readonly stand: HTMLButtonElement;
  private tableId: number | null = null;
  private readonly label: HTMLElement;

  constructor(private readonly host: UiHost, parent: HTMLElement) {
    this.root = el('div', 'panel hippie-role ix is-off', parent);
    this.label = el('div', 'hippie-role-label', this.root);
    this.label.setAttribute('aria-live', 'polite');
    const controls = el('div', 'hippie-role-tools', this.root);
    this.claim = button('btn', controls, 'Play as a hippie', () => this.host.app.net?.claimHippie?.(), 'confirm');
    this.pick = button('btn', controls, 'Pick up Flag', () => this.host.app.net?.hippiePickup?.(), 'click');
    this.altar = button('btn', controls, 'Take altar Flag', () => this.host.app.net?.hippieAltar?.(), 'confirm');
    this.aim = button('btn', controls, 'Throw Flag', () => {
      const s = this.host.app.session;
      s.hippieThrow = !s.hippieThrow;
      this.update(this.host.app.world);
    }, 'click');
    this.menu = button('btn', controls, 'Menu', () => this.host.app.setPaused(true), 'click');
    this.task = button('btn', controls, 'Do task', () => {
      const net = this.host.app.net;
      net?.hippieTask?.(!net.hippieRole?.active);
    }, 'click');
    this.frick = button('btn', controls, 'Play Frick-Frack', () => this.host.app.net?.hippieFrick?.('open'), 'confirm');
    this.table = el('section', 'hippie-swag-table is-off', this.root);
    this.table.setAttribute('aria-label', 'Frick-Frack SWAG table');
    el('strong', '', this.table, 'Frick-Frack · SWAG table');
    this.cards = el('p', '', this.table);
    this.tableMessage = el('p', '', this.table);
    const betting = el('label', 'hippie-bet', this.table, 'Wager SWAG ');
    this.wager = el('input', 'hippie-wager', betting);
    this.wager.type = 'number'; this.wager.min = '1'; this.wager.step = '1'; this.wager.value = '1';
    this.wager.inputMode = 'numeric';
    const actions = el('div', 'hippie-role-tools', this.table);
    this.deal = button('btn', actions, 'Roll & deal', () => this.host.app.net?.hippieFrick?.('bet', this.wager.valueAsNumber), 'confirm');
    this.hit = button('btn', actions, 'Hit', () => this.host.app.net?.hippieFrick?.('hit'), 'click');
    this.stand = button('btn', actions, 'Stand', () => this.host.app.net?.hippieFrick?.('stand'), 'click');
    button('btn', actions, 'Leave table', () => this.host.app.net?.hippieFrick?.('exit'), 'back');

  }

  update(world: World | null): void {
    const { net, session: s } = this.host.app;
    const role = net?.hippieRole;
    const visible = !!role && !s.campChoiceOpen && s.screen === 'playing' &&
      (s.spectator || world?.factions[s.playerFaction]?.alive === false) && net?.status === 'match' && world?.phase === 'playing' && (role.available || role.id !== null);
    show(this.root, visible);
    if (!visible || !role || !world) return;
    const hippie = role.id === null ? null : world.hippies.get(role.id);
    const carrying = hippie && hippie.carryingFlag !== -1;
    const able = hippie && hippie.status !== 'ko' && !hippie.airborne;
    show(this.claim, role.available && !role.queued);
    const table = role.table;
    show(this.table, !!table);
    if (table && this.tableId !== table.id) this.wager.value = '1';
    this.tableId = table?.id ?? null;
    if (table) {
      const betting = (table.phase === 'betting' || table.phase === 'result') && role.swag > 0;
      const playing = table.phase === 'playing';
      show(this.wager.parentElement!, betting); show(this.deal, betting);
      show(this.hit, playing); show(this.stand, playing);
      this.wager.max = String(role.swag);
      setDisabled(this.deal, !betting);
      const target = frickFrackTarget(table);
      const dealer = table.dealer.map(cardLabel).join(' · ');
      const hand = table.player.map(cardLabel).join(' · ');
      setText(this.cards, table.phase === 'rolling' ? 'Rolling the die…' : table.player.length || table.dealer.length
        ? `Target ${target} | Your hand (${frickFrackTotal(table.player, target)}): ${hand} | Wizard: ${dealer}`
        : 'Bet SWAG, roll a target, then hit or stand.');
      setText(this.tableMessage, role.error ?? (table.message || table.remark || ''));
    }
    show(this.task, !table && !!able && !!role.task);
    setText(this.task, role.active ? 'Stop task' : 'Do task');
    show(this.frick, !table && !!hippie && !!able && canReachSwagWizard(world, hippie));
    show(this.pick, !table && !!able && !carrying);
    show(this.altar, !table && !!able && !!hippie && !!joinableHippieAltar(world, hippie));
    show(this.aim, !table && !!able && !!carrying);
    show(this.menu, !table && !!hippie);
    setText(this.aim, s.hippieThrow ? 'Cancel throw' : 'Throw Flag');
    if (hippie) {
      const camp = hippie.faction === NEUTRAL ? 'Neutral' : FACTION_DEFS[hippie.faction].name;
      const task = role.task ? role.task[0].toUpperCase() + role.task.slice(1) : 'Waiting for work';
      if (table) { setText(this.label, `SWAG ${role.swag}`); return; }
      setText(this.label, [hippie.name, camp, `SWAG ${role.swag}`, `Task: ${task}${role.active ? ' (in progress)' : ''}`, `Flags ${carrying ? 1 : 0}/1`,
        hippie.status === 'ko' ? 'Knocked out' : s.hippieThrow ? 'Tap or click a throw target' : 'Tap or click to move',
        hippie.faction === NEUTRAL && !carrying ? 'Take a Flag at an altar to join its camp' : '', role.error].filter(Boolean).join(' · '));
    } else setText(this.label, role.error ?? (role.queued ? 'Waiting for a hippie…' : 'No camp is free. Want to join the crowd?'));
  }
}
