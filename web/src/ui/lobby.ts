import { MatchSetup } from "./matchSetup";
import { normalizeMatch } from "../sim/matchSettings";
/**
 * Lobby (session.screen 'lobby', the attract burn plays behind): the host's name, four seat
 * cards (character medallion, name, title, colour, the Signifier or the rivals' AI holding it,
 * Take seat / Spectate), the Signifiers at the burn (leader crown, seat, ready, ping, lost),
 * the Ready toggle, the leader's controls (AI difficulty, seed or a random burn, Start), chat,
 * host notices, Leave, and a reconnecting veil. Rebuilt only when net.version changes; every
 * player-provided string (handles, chat, server name) is written as text.
 */
import type { NetSession } from '../net/session';
import { MAX_SEED_LENGTH } from '../net/protocol';
import type { LobbyState } from '../net/protocol';
import { FACTION_DEFS } from '../sim/constants';
import { FACTION_IDS } from '../sim/types';
import type { Difficulty, FactionId } from '../sim/types';
import type { World } from '../sim/world';
import { DIFFICULTIES, DIFFICULTY_INFO } from './catalog';
import { ChatLog, chatInput } from './chat';
import type { UiHost, UiPart } from './core';
import { button, el, html, setAttr, setClass, setDisabled, setText, show } from './dom';
import { iconSvg } from './icons';
import { fmtPing, leaderName, pingTone, seatPlayer } from './online';
import { portraitSvg } from './portraits';
import { sigilSvg } from './title';

/** A host notice stays on the strip this long after it arrives. */
const NOTICE_MS = 12_000;
/** A leader-only refusal stays under the Start button this long. */
const FLASH_MS = 2600;

interface SeatCard {
  root: HTMLElement;
  occupant: HTMLElement;
  state: HTMLElement;
  action: HTMLButtonElement;
}

export class LobbyScreen implements UiPart {
  private host: UiHost;
  private root: HTMLElement;
  private server: HTMLElement;
  private status: HTMLElement;
  private notice: HTMLElement;
  private noticeUntil = 0;
  private noticesSeen = 0;
  private seats: SeatCard[] = [];
  private players: HTMLElement;
  private playerCount: HTMLElement;
  private ready: HTMLButtonElement;
  private readyHint: HTMLElement;
  private diff = new Map<Difficulty, HTMLButtonElement>();
  private setup: MatchSetup;
  private seed: HTMLInputElement;
  private random: HTMLButtonElement;
  private start: HTMLButtonElement;
  private startHint: HTMLElement;
  /** What the line under Start says when nothing was refused (set from the lobby state). */
  private hint = '';
  private flash = '';
  private flashUntil = 0;
  private chat: ChatLog;
  private chatField: HTMLInputElement;
  private reconnect: HTMLElement;
  private net: NetSession | null = null;
  private version = -1;

  constructor(host: UiHost, parent: HTMLElement) {
    this.host = host;
    this.root = el('div', 'lobby ix is-off', parent);
    el('div', 'lobby-shade', this.root);
    const box = el('div', 'lobby-box frame', this.root);

    // ── Header ──
    const head = el('div', 'lobby-head', box);
    html('div', 'lobby-sigil', sigilSvg('sigil spin'), head);
    const titles = el('div', 'lobby-titles', head);
    el('div', 'lobby-kicker', titles, 'The burn at');
    this.server = el('h2', 'lobby-server', titles, '');
    this.status = el('div', 'lobby-status', titles, '');
    const tools = el('div', 'lobby-tools', head);
    button(
      'btn btn-small',
      tools,
      'Liber HH',
      () => {
        this.host.app.session.panels.codex = true;
      },
      'click',
    );
    button(
      'btn btn-small',
      tools,
      'Settings',
      () => {
        this.host.app.session.panels.settings = true;
      },
      'click',
    );
    button('btn btn-small btn-danger', tools, 'Leave the burn', () => this.net?.leave(), 'back');
    this.notice = el('div', 'lobby-notice is-off', box, '');

    // ── Seats ──
    const seats = el('div', 'lobby-seats', box);
    for (const f of FACTION_IDS) this.seats.push(this.seatCard(seats, f));

    // ── Signifiers + settings | chat ──
    const lower = el('div', 'lobby-lower', box);
    const left = el('div', 'lobby-left', lower);
    const people = el('div', 'panel lobby-people', left);
    const ptitle = el('div', 'panel-title', people, 'Signifiers at the burn');
    this.playerCount = el('span', 'panel-sub', ptitle, '');
    this.players = el('div', 'lobby-players', people);
    const me = el('div', 'lobby-me', people);
    this.ready = button('toggle lobby-ready', me, 'Ready', () => {
      const net = this.net;
      const mine = net ? net.lobby?.players.find((p) => p.id === net.playerId) : undefined;
      if (net && mine) net.setReady(!mine.ready);
    }, 'toggle');
    this.readyHint = el('span', 'panel-hint', me, '');

    const rules = el('div', 'panel lobby-rules', left);
    el('div', 'panel-title', rules, 'The burn');
    this.setup=new MatchSetup(rules,()=>normalizeMatch(this.net?.lobby?.settings.match),v=>this.leaderOnly(()=>this.net?.setSettings({match:v})));
    const diffRow = el('div', 'lobby-row', rules);
    el('span', 'lobby-label', diffRow, 'Rival AI');
    const seg = el('div', 'seg', diffRow);
    for (const d of DIFFICULTIES) {
      const b = button('seg-btn', seg, DIFFICULTY_INFO[d].name, () => this.leaderOnly(() => this.net?.setSettings({ difficulty: d })), 'pick');
      b.title = DIFFICULTY_INFO[d].desc;
      this.diff.set(d, b);
    }
    const seedRow = el('div', 'lobby-row', rules);
    el('span', 'lobby-label', seedRow, 'Seed');
    this.seed = el('input', 'lobby-seed', seedRow);
    this.seed.type = 'text';
    this.seed.maxLength = MAX_SEED_LENGTH;
    this.seed.autocomplete = 'off';
    this.seed.spellcheck = false;
    this.seed.placeholder = 'a fresh burn every match';
    this.seed.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.seed.blur();
      }
    });
    // Commit on blur (Enter blurs too): one settings message per edit, not per keystroke.
    this.seed.addEventListener('change', () => {
      const seed = this.seed.value.trim();
      this.leaderOnly(() => this.net?.setSettings({ seed: seed === '' ? null : seed }));
    });
    this.random = button('toggle lobby-random', seedRow, 'Random', () => {
      this.leaderOnly(() => {
        const random = this.net?.lobby?.settings.seed === null;
        // Leaving random needs a seed: keep whatever is typed, else coin one the group can reuse.
        const seed = random ? this.seed.value.trim() || `burn-${Date.now().toString(36)}` : null;
        this.net?.setSettings({ seed });
      });
    }, 'toggle');
    const go = el('div', 'lobby-go', rules);
    this.start = button('btn btn-primary btn-begin lobby-start', go, 'Light the burn', () => {
      if (this.net?.lobby?.phase === 'playing') this.flashHint('A burn is already under way. Wait for it to end.');
      else this.leaderOnly(() => this.net?.start());
    }, 'confirm');
    this.startHint = el('div', 'panel-hint lobby-start-hint', go, '');

    const talk = el('div', 'panel lobby-chat', lower);
    el('div', 'panel-title', talk, 'Talk at the burn');
    this.chat = new ChatLog(talk, 'chat-log lobby-log', 200);
    const say = el('div', 'lobby-say', talk);
    this.chatField = chatInput(say, 'Say something to the burn (Enter)', (text) => this.net?.sendChat(text), () => this.chatField.blur());
    button(
      'btn btn-small',
      say,
      'Say',
      () => {
        const text = this.chatField.value.trim();
        this.chatField.value = '';
        if (text) this.net?.sendChat(text);
      },
      'click',
    );

    this.reconnect = el('div', 'lobby-reconnect is-off', this.root);
    html('div', 'rcn-ic', iconSvg('ping'), this.reconnect);
    el('div', 'rcn-head', this.reconnect, 'The mesh has gone quiet');
    el('div', 'rcn-sub', this.reconnect, 'Reconnecting to the host… your seat is kept for you.');
  }

  private seatCard(parent: HTMLElement, f: FactionId): SeatCard {
    const def = FACTION_DEFS[f];
    const root = el('div', 'seat-card', parent);
    root.style.setProperty('--fc', def.css);
    html('div', 'seat-face', portraitSvg(f), root);
    el('div', 'seat-name', root, def.name);
    el('div', 'seat-title', root, def.title);
    const who = el('div', 'seat-who', root);
    const occupant = el('span', 'seat-occupant', who, '');
    const state = el('span', 'seat-state', who, '');
    const action = button('btn btn-small seat-action', root, 'Take seat', () => {
      const net = this.net;
      if (!net) return;
      // Your own seat's button gives it up (spectate); an AI-held seat's button takes it.
      net.setSeat(net.seat === f ? null : f);
    });
    return { root, occupant, state, action };
  }

  /**
   * Leader-only controls. Everyone else hears the error blip (the controls are aria-disabled
   * for them) and reads who decides under the Start button; the feed is hidden in the lobby.
   */
  private leaderOnly(act: () => void): void {
    const net = this.net;
    if (!net) return;
    if (net.isLeader) {
      act();
      return;
    }
    const leader = leaderName(net.lobby);
    this.flashHint(leader ? `${leader} leads this burn and sets it up.` : 'Only the leader sets up the burn.');
  }

  private flashHint(text: string): void {
    this.flash = text;
    this.flashUntil = performance.now() + FLASH_MS;
    this.renderHint(performance.now());
  }

  /** The line under Start: a leader-only refusal for a moment, else what happens next. */
  private renderHint(now: number): void {
    const flashing = now < this.flashUntil;
    setText(this.startHint, flashing ? this.flash : this.hint);
    setClass(this.startHint, 'bad', flashing);
  }

  /** Enter outside any text field while the lobby is up: start typing in its chat. */
  focusChat(): boolean {
    if (!this.net || this.host.app.session.screen !== 'lobby') return false;
    this.chatField.focus();
    return true;
  }

  update(_world: World | null, now: number): void {
    const s = this.host.app.session;
    const net = this.host.app.net;
    const visible = s.screen === 'lobby' && !!net;
    show(this.root, visible);
    if (!visible || !net) return;
    if (net !== this.net) {
      this.net = net;
      this.version = -1;
      this.noticesSeen = 0;
      this.chat.clear();
    }
    show(this.reconnect, net.reconnecting);
    setClass(this.notice, 'is-off', now > this.noticeUntil);
    this.renderHint(now);
    if (net.version === this.version) return;
    this.version = net.version;

    setText(this.server, net.serverName);
    this.chat.sync(net.chat, now);
    if (net.notices.length < this.noticesSeen) this.noticesSeen = 0;
    if (net.notices.length > this.noticesSeen) {
      this.noticesSeen = net.notices.length;
      setText(this.notice, net.notices[net.notices.length - 1]);
      this.noticeUntil = now + NOTICE_MS;
      show(this.notice, true);
    }
    const lobby = net.lobby;
    if (!lobby) {
      setText(this.status, net.status === 'lobby' ? 'Gathering…' : 'Greeting the host…');
      return;
    }
    this.renderStatus(lobby);
    this.renderSeats(net, lobby);
    this.renderPlayers(net, lobby);
    this.renderRules(net, lobby);
  }

  private renderStatus(lobby: LobbyState): void {
    const seated = lobby.players.filter((p) => p.seat !== null);
    const ready = seated.filter((p) => p.ready).length;
    const phase =
      lobby.phase === 'playing' ? 'A burn is under way' : lobby.phase === 'ended' ? 'The last burn just ended' : 'Gathering for the next burn';
    setText(this.status, `${phase} · ${lobby.players.length} at the burn · ${ready}/${seated.length} seated ready`);
  }

  private renderSeats(net: NetSession, lobby: LobbyState): void {
    const ai = `The rivals' AI · ${DIFFICULTY_INFO[lobby.settings.difficulty].name}`;
    for (const f of FACTION_IDS) {
      const card = this.seats[f];
      const holder = seatPlayer(lobby, f);
      const mine = net.seat === f;
      const active=normalizeMatch(lobby.settings.match).active.includes(f);
      setText(card.occupant, active ? (holder ? holder.name : ai) : 'Disabled');
      setDisabled(card.action,!active);
      // A Signifier who dropped keeps the seat; the AI plays it until they return (or someone takes it).
      setText(card.state, holder ? (holder.connected ? (holder.ready ? 'ready' : 'not ready') : 'away · the AI holds the camp') : '');
      setClass(card.root, 'mine', mine);
      setClass(card.root, 'held', !!holder && !mine);
      setClass(card.root, 'ai', !holder);
      setClass(card.root, 'ready', !!holder?.ready);
      setClass(card.root, 'lost', !!holder && !holder.connected);
      show(card.action, mine || !holder || !holder.connected);
      setText(card.action, mine ? 'Spectate' : 'Take seat');
      setAttr(card.action, 'title', mine ? 'Give up this seat and watch the burn' : `Play ${FACTION_DEFS[f].name}`);
      setAttr(card.action, 'data-sfx', mine ? 'back' : 'confirm');
    }
  }

  private renderPlayers(net: NetSession, lobby: LobbyState): void {
    setText(this.playerCount, `${lobby.players.length} here`);
    this.players.textContent = '';
    for (const p of lobby.players) {
      const row = el('div', 'lp-row', this.players);
      setClass(row, 'me', p.id === net.playerId);
      setClass(row, 'lost', !p.connected);
      const crown = el('span', 'lp-crown', row);
      if (p.id === lobby.leaderId) {
        crown.innerHTML = iconSvg('star');
        crown.title = 'Leads this burn';
      }
      const nameCell = el('span', 'lp-name', row);
      el('span', 'lp-handle', nameCell, p.name);
      if (p.id === net.playerId) el('span', 'tag you', nameCell, 'you');
      const seat = el('span', 'lp-seat', row);
      if (p.seat !== null) {
        seat.style.setProperty('--fc', FACTION_DEFS[p.seat].css);
        seat.textContent = FACTION_DEFS[p.seat].name;
      } else seat.textContent = 'spectating';
      setClass(seat, 'spec', p.seat === null);
      el('span', `lp-ready${p.ready ? ' on' : ''}`, row, p.ready ? 'ready' : '·');
      const ping = el('span', 'lp-ping num', row, p.connected ? fmtPing(p.ping) : 'away');
      setAttr(ping, 'data-tone', p.connected ? pingTone(p.ping) : 'lost');
    }
    const mine = lobby.players.find((p) => p.id === net.playerId);
    setText(this.ready, mine?.ready ? 'Ready' : 'Not ready');
    setClass(this.ready, 'on', !!mine?.ready);
    setText(
      this.readyHint,
      net.seat === null ? 'You are spectating. Take a seat to play a camp.' : `You play ${FACTION_DEFS[net.seat].name}.`,
    );
  }

  private renderRules(net: NetSession, lobby: LobbyState): void {
    const leader = net.isLeader;
    this.setup.update(leader && lobby.phase==='lobby');
    for (const [d, b] of this.diff) {
      setClass(b, 'on', lobby.settings.difficulty === d);
      setDisabled(b, !leader);
    }
    const random = lobby.settings.seed === null;
    // Never overwrite what the leader is typing; everyone else always sees the agreed seed.
    if (document.activeElement !== this.seed) this.seed.value = lobby.settings.seed ?? '';
    this.seed.readOnly = !leader;
    setClass(this.random, 'on', random);
    setText(this.random, random ? 'Random' : 'Fixed');
    setDisabled(this.random, !leader);
    show(this.start, leader);
    setDisabled(this.start, lobby.phase === 'playing');
    const name = leaderName(lobby);
    this.hint =
      lobby.phase === 'playing'
        ? 'A burn is under way. The next one gathers here.'
        : leader
          ? 'Empty seats are played by the rivals\u2019 AI. Light the burn whenever you like.'
          : name
            ? `Waiting for ${name} to light the burn…`
            : 'Waiting for a leader…';
    this.renderHint(performance.now());
  }

  dispose(): void {
    this.root.remove();
  }
}
