/**
 * Title screen (session.screen 'title'): the attract match plays behind a left-hand column
 * with the five-Flag pinwheel sigil, the FLAGHACK ∞ logo, rotating scripture, the menu (Begin
 * the Survey, the Training Burn, Liber HH, Settings) and the diegetic footer.
 *
 * When a FLAGHACK host served the page (app.hostInfo) the column leads with "Join <server>":
 * a handle (remembered on this device), the password (prefilled from an invite link), and the
 * host's answer (connecting, denied, gone). Without a host, a small card tells how to host one.
 */
import { MAX_NAME_LENGTH, PROTOCOL_VERSION } from '../net/protocol';
import type { HostInfo } from '../net/protocol';
import type { World } from '../sim/world';
import { readTrainingProgress, trainingStanding } from '../tutorial/progress';
import type { UiHost, UiPart } from './core';
import { button, el, html, setClass, setDisabled, setText, show } from './dom';
import { iconSvg } from './icons';
import { QUOTES } from './lore';

const QUOTE_MS = 8000;
const FADE_MS = 650;
/** localStorage key of the last handle used to join a host. */
const HANDLE_KEY = 'fh.handle.v1';

const HOST_PHASE: Record<HostInfo['phase'], string> = {
  lobby: 'gathering in the lobby',
  playing: 'a burn is under way',
  ended: 'between burns',
};

type JoinTone = 'bad' | 'busy' | 'hint';
const JOIN_TONES: readonly JoinTone[] = ['bad', 'busy', 'hint'];

function loadHandle(): string {
  try {
    return (localStorage.getItem(HANDLE_KEY) ?? '').slice(0, MAX_NAME_LENGTH);
  } catch {
    // Privacy modes may refuse storage outright: start with an empty handle.
    return '';
  }
}

function saveHandle(handle: string): void {
  try {
    localStorage.setItem(HANDLE_KEY, handle);
  } catch {
    // Not remembered on this device; joining still works.
  }
}

/** The GCC side-panel sigil: five yellow Flags pinwheeling around a red ley pentagram. */
export function sigilSvg(cls: string): string {
  let flags = '';
  for (let i = 0; i < 5; i++) {
    flags +=
      `<g transform="rotate(${i * 72})">` +
      `<path class="sg-pole" d="M0 -16 V-54"/>` +
      `<path class="sg-cloth" d="M1 -54 C9 -57 15 -49 26 -52 V-39 C15 -36 9 -44 1 -41 Z"/>` +
      `<circle class="sg-finial" cy="-55.5" r="2.2"/></g>`;
  }
  const star: string[] = [];
  for (const i of [0, 2, 4, 1, 3]) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    star.push(`${(Math.cos(a) * 15).toFixed(2)} ${(Math.sin(a) * 15).toFixed(2)}`);
  }
  return (
    `<svg class="${cls}" viewBox="-64 -64 128 128" aria-hidden="true">` +
    `<circle class="sg-ring" r="18.5"/><path class="sg-star" d="M${star.join(' L')} Z"/>${flags}</svg>`
  );
}

export class TitleScreen implements UiPart {
  private host: UiHost;
  private root: HTMLElement;
  private quote: HTMLElement;
  private quoteText: HTMLElement;
  private quoteBy: HTMLElement;
  private quoteIdx = 0;
  private nextQuoteAt = 0;
  private fadingSince = 0;
  private begin: HTMLButtonElement;
  private aloneLabel: HTMLElement;
  private trainSub: HTMLElement;
  private trainBadge: HTMLElement;
  private wasVisible = false;
  // ── Join (host mode) ──
  private join: HTMLElement;
  private joinServer: HTMLElement;
  private joinMeta: HTMLElement;
  private handle: HTMLInputElement;
  private password: HTMLInputElement;
  private joinBtn: HTMLButtonElement;
  private joinStatus: HTMLElement;
  private joinStatusText: HTMLElement;
  private reload: HTMLButtonElement;
  /** A reason the last Join click could not go through; cleared when the fields change. */
  private joinNote = '';
  private hostShown: HostInfo | null = null;
  private passwordPrefilled = false;
  private multiplayer: HTMLElement;

  constructor(host: UiHost, parent: HTMLElement) {
    this.host = host;
    this.root = el('div', 'title ix', parent);
    el('div', 'title-shade', this.root);
    el('div', 'title-edition', this.root, 'game of the millennium edition');
    const col = el('div', 'title-col', this.root);
    html('div', 'title-sigil', sigilSvg('sigil spin'), col);
    html('h1', 'logo', 'FLAGHACK <span class="inf">∞</span>', col);
    el('div', 'subtitle', col, 'SURVEY FLAGS');

    this.quote = el('blockquote', 'quote', col);
    this.quoteText = el('p', 'quote-text', this.quote);
    this.quoteBy = el('cite', 'quote-by', this.quote);
    this.quoteIdx = Math.floor(Math.random() * QUOTES.length);
    this.showQuote();

    // ── Join the host's burn (only when a host served this page) ──
    this.join = el('div', 'menu join frame is-off', col);
    const jhead = el('div', 'join-head', this.join);
    el('div', 'join-kicker', jhead, 'Join the burn at');
    this.joinServer = el('div', 'join-server', jhead, '');
    this.joinMeta = el('div', 'join-meta', jhead, '');
    const fields = el('div', 'join-fields', this.join);
    this.handle = this.field(fields, 'Handle', 'text', 'Your name at the burn');
    this.handle.maxLength = MAX_NAME_LENGTH;
    this.handle.value = loadHandle();
    this.password = this.field(fields, 'Password', 'password', 'From your host');
    this.joinBtn = button('btn btn-primary btn-begin btn-join', this.join, 'Join the burn', () => this.tryJoin(), 'confirm');
    this.joinStatus = el('div', 'join-status', this.join);
    this.joinStatusText = el('span', 'join-status-t', this.joinStatus, '');
    this.reload = button('btn btn-tiny is-off', this.joinStatus, 'Reload', () => location.reload(), 'confirm');

    // ── Play alone ──
    const menu = el('div', 'menu solo frame', col);
    const s = host.app.session;
    this.aloneLabel = el('div', 'alone-label is-off', menu, 'Or burn alone');
    const soloRow = el('div', 'solo-row', menu);
    this.begin = button(
      'btn btn-primary btn-begin',
      soloRow,
      'Begin the Survey',
      () => {
        this.host.app.openLobby();
      },
      'confirm',
    );
    const train = button('btn btn-train', soloRow, '', () => this.host.veiledLoad(() => this.host.app.startTutorial()), 'confirm');
    const trainMain = el('span', 'bt-main', train);
    html('span', 'bt-ic', iconSvg('book'), trainMain);
    el('span', 'bt-name', trainMain, 'Training Burn');
    this.trainSub = el('span', 'bt-sub', train, '');
    this.trainBadge = el('span', 'bt-badge is-off', train, 'Recommended for new Signifiers');
    const row = el('div', 'menu-row', menu);
    button('btn', row, 'Liber HH', () => {
      s.panels.codex = true;
    });
    button('btn', row, 'Settings', () => {
      s.panels.settings = true;
    });

    // ── How to host (no host served this page) ──
    this.multiplayer = html(
      'div',
      'mp-card panel',
      '<div class="panel-title">Multiplayer</div>' +
        '<p>A friend runs <code>./host.sh --password …</code> and everyone opens the address it prints.</p>',
      col,
    );

    const foot = el('footer', 'title-foot', this.root);
    el('div', 'transmission', foot, 'A transmission from the Geomantic Command Center');
    el('div', 'warning-label', foot, 'Under no conditions should you attempt to play a game that claims to be Flaghack.');
  }

  /** A labelled join field. Enter joins; Escape hands the keys back to the menu. */
  private field(parent: HTMLElement, label: string, type: string, placeholder: string): HTMLInputElement {
    const wrap = el('label', 'field', parent);
    el('span', 'field-l', wrap, label);
    const input = el('input', 'field-in', wrap);
    input.type = type;
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.tryJoin();
      } else if (ev.key === 'Escape') {
        input.blur();
      }
    });
    input.addEventListener('input', () => {
      this.joinNote = '';
    });
    return input;
  }

  /** Why Join cannot go through right now ('' when it can). */
  private joinBlocker(): string {
    const app = this.host.app;
    if (!app.hostInfo) return 'No host served this page.';
    if (app.hostInfo.protocol !== PROTOCOL_VERSION) return 'This page speaks an older dialect of the Survey than its host. Reload it to join.';
    if (app.net && app.net.status !== 'closed') return `Already reaching ${app.hostInfo.serverName}…`;
    if (this.handle.value.trim() === '') return 'Choose a handle for the burn first.';
    return '';
  }

  private tryJoin(): void {
    const blocker = this.joinBlocker();
    if (blocker) {
      this.joinNote = blocker;
      this.renderJoinStatus();
      if (this.handle.value.trim() === '') this.handle.focus();
      return;
    }
    const name = this.handle.value.trim();
    saveHandle(name);
    this.joinNote = '';
    // Keys belong to the lobby (and soon the burn), not to the form.
    this.handle.blur();
    this.password.blur();
    this.host.app.joinHost(name, this.password.value);
    this.renderJoinStatus();
  }

  /** One line under Join: the host's answer, a reason Join is blocked, or what to do. */
  private renderJoinStatus(): void {
    const app = this.host.app;
    const net = app.net;
    const stale = !!app.hostInfo && app.hostInfo.protocol !== PROTOCOL_VERSION;
    let text: string;
    let tone: JoinTone;
    if (stale) {
      text = 'This page speaks an older dialect of the Survey than its host. Reload it to join.';
      tone = 'bad';
    } else if (net && net.status !== 'closed') {
      text = `Reaching ${app.hostInfo?.serverName ?? 'the host'}…`;
      tone = 'busy';
    } else if (this.joinNote) {
      text = this.joinNote;
      tone = 'bad';
    } else if (net?.error) {
      text = net.error;
      tone = 'bad';
    } else {
      text =
        this.handle.value.trim() === ''
          ? 'Choose a handle for the burn.'
          : this.password.value === ''
            ? 'Enter the password your host gave you.'
            : 'The gate of the burn stands open: Enter joins.';
      tone = 'hint';
    }
    setText(this.joinStatusText, text);
    for (const t of JOIN_TONES) setClass(this.joinStatus, t, t === tone);
    show(this.reload, stale);
    setDisabled(this.joinBtn, this.joinBlocker() !== '');
  }

  private showQuote(): void {
    const q = QUOTES[this.quoteIdx % QUOTES.length];
    setText(this.quoteText, `“${q.text}”`);
    setText(this.quoteBy, q.by ? `— ${q.by}` : '');
  }

  /** Training progress lives in localStorage: read it once each time the title comes up. */
  private showTraining(): void {
    const p = readTrainingProgress();
    show(this.trainBadge, !p.graduated);
    const standing = trainingStanding(p);
    setText(
      this.trainSub,
      standing === 'whole'
        ? 'Seal of Flagistan whole'
        : standing === 'walked'
          ? `Course walked · Seals ${p.seals}/${p.total}`
          : standing === 'started'
            ? `Seals ${p.seals}/${p.total}`
            : 'Survey 101 with the Vexillosaint',
    );
  }

  /** Host mode: the join panel leads; the solo menu steps back to a compact row. */
  private showHost(info: HostInfo | null): void {
    this.hostShown = info;
    const hosted = info !== null;
    setClass(this.root, 'hosted', hosted);
    show(this.join, hosted);
    show(this.aloneLabel, hosted);
    show(this.multiplayer, !hosted);
    setClass(this.begin, 'btn-primary', !hosted);
    setClass(this.begin, 'btn-gold', hosted);
    if (!info) return;
    setText(this.joinServer, info.serverName);
    const players = info.players === 1 ? '1 Signifier' : `${info.players} Signifiers`;
    setText(this.joinMeta, `${players} at the burn · ${HOST_PHASE[info.phase]}`);
  }

  update(_world: World | null, now: number): void {
    const app = this.host.app;
    const s = app.session;
    const visible = s.screen === 'title';
    show(this.root, visible);
    if (visible && !this.wasVisible) this.showTraining();
    this.wasVisible = visible;
    if (!visible) return;
    // Panels opened from the title (codex/settings) sit above it; keep the menu out of the way.
    setClass(this.root, 'dimmed', s.panels.codex || s.panels.settings);

    if (app.hostInfo !== this.hostShown) this.showHost(app.hostInfo);
    if (app.hostInfo) {
      // An invite link (#pw=…) fills the password once; the player may still change it.
      if (!this.passwordPrefilled && app.invitePassword !== null) {
        this.passwordPrefilled = true;
        if (this.password.value === '') this.password.value = app.invitePassword;
      }
      this.renderJoinStatus();
    }

    if (this.nextQuoteAt === 0) this.nextQuoteAt = now + QUOTE_MS;
    if (this.fadingSince === 0 && now >= this.nextQuoteAt) {
      this.fadingSince = now;
      setClass(this.quote, 'fade', true);
    } else if (this.fadingSince > 0 && now - this.fadingSince >= FADE_MS) {
      this.quoteIdx++;
      this.showQuote();
      setClass(this.quote, 'fade', false);
      this.fadingSince = 0;
      this.nextQuoteAt = now + QUOTE_MS;
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
