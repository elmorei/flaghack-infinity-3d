import { NEUTRAL } from '../sim/types';
import { FACTION_DEFS } from '../sim/constants';
import { joinableHippieAltar } from '../sim/systems/recruitment';
import type { World } from '../sim/world';
import type { UiHost, UiPart } from './core';
import { button, el, setText, show } from './dom';

/** The invite is unicast; no title button or shared lobby role identifies these players. */
export class HippieRolePart implements UiPart {
  private readonly root: HTMLElement;
  private readonly claim: HTMLButtonElement;
  private readonly pick: HTMLButtonElement;
  private readonly altar: HTMLButtonElement;
  private readonly aim: HTMLButtonElement;
  private readonly menu: HTMLButtonElement;
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
    show(this.pick, !!able && !carrying);
    show(this.altar, !!able && !!hippie && !!joinableHippieAltar(world, hippie));
    show(this.aim, !!able && !!carrying);
    show(this.menu, !!hippie);
    setText(this.aim, s.hippieThrow ? 'Cancel throw' : 'Throw Flag');
    if (hippie) {
      const camp = hippie.faction === NEUTRAL ? 'Neutral' : FACTION_DEFS[hippie.faction].name;
      setText(this.label, [hippie.name, camp, `Flags ${carrying ? 1 : 0}/1`,
        hippie.status === 'ko' ? 'Knocked out' : s.hippieThrow ? 'Tap or click a throw target' : 'Tap or click to move',
        hippie.faction === NEUTRAL && !carrying ? 'Take a Flag at an altar to join its camp' : '', role.error].filter(Boolean).join(' · '));
    } else setText(this.label, role.error ?? (role.queued ? 'Waiting for a hippie…' : 'No camp is free. Want to join the crowd?'));
  }
}
