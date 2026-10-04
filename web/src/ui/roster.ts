/**
 * D.E.G.E.N. roster: every own Signifier grouped by what their beacon says they are doing
 * ("know what they're up to"), with attention bars. Clicking a name selects them and centres
 * the Command View camera on them. Includes the Retransmit "TAKE A SHOT" button. Rows are
 * keyed by hippie id and only move between groups when a status changes (no list rebuilds).
 */
import { RETRANSMIT_COOLDOWN } from '../sim/constants';
import type { EntityId, HippieStatus } from '../sim/types';
import type { World } from '../sim/world';
import { RETRANSMIT_INFO, STATUS_INFO } from './catalog';
import { tutorialTarget } from './core';
import type { UiHost, UiPart } from './core';
import { button, el, html, setAttr, setClass, setDisabled, setText, setVar, show } from './dom';
import { iconSvg } from './icons';

type GroupKey = HippieStatus | 'offmesh';

interface Group {
  key: GroupKey;
  order: number;
  root: HTMLElement;
  count: HTMLElement;
  list: HTMLElement;
  n: number;
}

interface Row {
  root: HTMLButtonElement;
  attn: HTMLElement;
  group: GroupKey | null;
  seen: boolean;
}

export class Roster implements UiPart {
  private host: UiHost;
  private root: HTMLElement;
  private count: HTMLElement;
  private shot: HTMLButtonElement;
  private shotCd: HTMLElement;
  private groupsBox: HTMLElement;
  private empty: HTMLElement;
  private groups = new Map<GroupKey, Group>();
  private rows = new Map<EntityId, Row>();

  constructor(host: UiHost, parent: HTMLElement) {
    this.host = host;
    this.root = el('div', 'panel roster ix', parent);
    tutorialTarget(this.root, 'degen-roster');
    const title = el('div', 'panel-title', this.root, 'D.E.G.E.N. Roster');
    el('span', 'panel-sub', title, "know what they're up to");
    button(
      'panel-x',
      title,
      iconSvg('close'),
      () => {
        this.host.app.session.panels.degen = false;
      },
      'back',
    );
    const head = el('div', 'roster-head', this.root);
    this.count = el('span', 'panel-meta', head, '');
    this.shot = button(
      'btn btn-gold btn-small shot',
      head,
      `${iconSvg('shot')}<span>${RETRANSMIT_INFO.name}</span><span class="shot-cd num"></span><span class="slot-sweep"></span>`,
      () => {
        const s = this.host.app.session;
        const w = this.host.app.world;
        const left = w ? w.factions[s.playerFaction].cooldowns.retransmit - w.time : 0;
        // Recharging: say so here rather than round-tripping a rejected command.
        if (left > 0) this.host.blocked(`${RETRANSMIT_INFO.name} recharging (${Math.ceil(left)} s).`);
        else this.host.app.submit({ t: 'retransmit', faction: s.playerFaction });
      },
      'confirm',
    );
    this.shot.title = RETRANSMIT_INFO.effect;
    this.shotCd = this.shot.querySelector<HTMLElement>('.shot-cd') ?? el('span', '', this.shot);
    this.groupsBox = el('div', 'roster-groups', this.root);
    this.empty = el('div', 'panel-hint is-off', this.root, 'No beacons on the mesh. Recruit neutrals at a Drum Circle or Command Center, or hand or throw them a Flag.');
  }

  private group(key: GroupKey): Group {
    const existing = this.groups.get(key);
    if (existing) return existing;
    const info = key === 'offmesh' ? null : STATUS_INFO[key];
    const order = info ? info.order : 99;
    const root = el('div', 'rg');
    const headEl = el('div', `rg-head tone-${info ? info.tone : 'down'}`, root);
    html('span', 'rg-ic', iconSvg(info ? info.icon : 'warning'), headEl);
    el('span', 'rg-label', headEl, info ? info.label : 'Off the mesh');
    const count = el('span', 'rg-n num', headEl, '0');
    const list = el('div', 'rg-list', root);
    // Keep groups in status order: busy first, broken last.
    let before: HTMLElement | null = null;
    for (const g of this.groups.values()) {
      if (g.order > order && (!before || g.order < Number(before.dataset.order))) before = g.root;
    }
    root.dataset.order = String(order);
    this.groupsBox.insertBefore(root, before);
    const g: Group = { key, order, root, count, list, n: 0 };
    this.groups.set(key, g);
    return g;
  }

  reset(_world: World): void {
    for (const g of this.groups.values()) g.root.remove();
    this.groups.clear();
    this.rows.clear();
  }

  update(world: World | null, _now: number): void {
    const s = this.host.app.session;
    const fac = world?.factions[s.playerFaction];
    const visible = s.screen === 'playing' && !s.spectator && !!world && !!fac && fac.alive && (s.view === 'command' || s.panels.degen);
    show(this.root, visible);
    if (!visible || !world || !fac) return;

    for (const g of this.groups.values()) g.n = 0;
    for (const row of this.rows.values()) row.seen = false;
    let total = 0;
    for (const h of world.hippies.values()) {
      if (h.faction !== fac.id) continue;
      total++;
      let row = this.rows.get(h.id);
      if (!row) {
        const id = h.id;
        const root = button('rr', null, '', () => this.focus(id));
        el('span', 'rr-name', root, h.name);
        const bar = el('span', 'rr-bar', root);
        const attn = el('i', '', bar);
        row = { root, attn, group: null, seen: false };
        this.rows.set(h.id, row);
      }
      row.seen = true;
      const key: GroupKey = h.beacon ? h.status : 'offmesh';
      const g = this.group(key);
      g.n++;
      if (row.group !== key) {
        g.list.appendChild(row.root);
        row.group = key;
      }
      setVar(row.attn, '--p', (h.attention / 100).toFixed(2));
      setClass(row.attn, 'low', h.attention < 30);
      setClass(row.root, 'sel', s.selection.has(h.id));
      setAttr(row.root, 'title', `${h.name} · ${key === 'offmesh' ? 'beacon lost' : STATUS_INFO[key].label} · attention ${Math.round(h.attention)}`);
    }
    for (const [id, row] of this.rows) {
      if (row.seen) continue;
      row.root.remove();
      this.rows.delete(id);
    }
    for (const g of this.groups.values()) {
      setText(g.count, String(g.n));
      show(g.root, g.n > 0);
    }
    setText(this.count, `${total} Signifier${total === 1 ? '' : 's'} on the mesh`);
    show(this.empty, total === 0);

    const left = fac.cooldowns.retransmit - world.time;
    setClass(this.shot, 'cooling', left > 0);
    setDisabled(this.shot, left > 0);
    setVar(this.shot, '--p', left > 0 ? Math.min(1, left / RETRANSMIT_COOLDOWN).toFixed(3) : '0');
    setText(this.shotCd, left > 0 ? String(Math.ceil(left)) : '');
  }

  /** Select a Signifier and point the Command View camera at them. */
  private focus(id: EntityId): void {
    const w = this.host.app.world;
    const s = this.host.app.session;
    const h = w?.hippies.get(id);
    if (!h) return;
    s.selection.clear();
    s.selection.add(id);
    s.camera.cmdX = h.pos.x;
    s.camera.cmdZ = h.pos.z;
  }

  dispose(): void {
    this.root.remove();
  }
}
