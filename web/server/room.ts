import { DEFAULT_MATCH, normalizeMatch } from "../src/sim/matchSettings";
/**
 * The host's single room: connections and their handshake, players (seats, ready flags, the
 * leader, chat), the lobby phases (lobby → playing → ended → lobby) and the running Match.
 *
 * Players outlive their sockets: a hello carrying a player's token reclaims the same id and seat,
 * also mid-match. A seated player who drops keeps the seat; after SEAT_GRACE_MS an NPC drives it
 * until they return (or until someone else takes it). Disconnected players are forgotten after
 * FORGET_AFTER_MS unless they hold a seat in a running match. Every handler is wrapped so that
 * nothing a client sends can take the host down.
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { MAX_CHAT_LENGTH, MAX_NAME_LENGTH, MAX_SEED_LENGTH, PROTOCOL_VERSION, SEAT_COUNT } from '../src/net/protocol';
import type {
  ChatLine,
  ClientMessage,
  DenyReason,
  HostInfo,
  LobbyPhase,
  LobbySettings,
  LobbyState,
  ServerMessage,
} from '../src/net/protocol';
import { parseClientMessage } from '../src/net/validate';
import { FACTION_DEFS } from '../src/sim/constants';
import { FACTION_IDS } from '../src/sim/types';
import type { Difficulty, FactionId, MatchOptions } from '../src/sim/types';
import { addressKey, FailureThrottle, PasswordGate } from './auth';
import type { Origin } from './auth';
import { Match } from './match';
import type { MatchListener } from './match';
import { cleanText, uniqueName } from './text';

/** The first message must arrive this soon after the socket opens; silent sockets are cut then. */
const HELLO_TIMEOUT_MS = 10_000;
/** Connected players at once; further hellos are denied 'full'. */
export const MAX_PLAYERS = 16;
/**
 * Sockets that have not said hello yet, in total and per client address (addressKey); more
 * upgrades are refused at the HTTP level, so one silent peer cannot hold the door shut.
 */
const MAX_PENDING = 16;
const MAX_PENDING_PER_ADDRESS = 4;
/** A dropped seated player keeps driving (standing still) this long before an NPC takes over. */
const SEAT_GRACE_MS = 5_000;
const FORGET_AFTER_MS = 60_000;
/** A match nobody is connected to is dropped after this long. */
const ABANDON_AFTER_MS = 120_000;
const HOUSEKEEPING_MS = 250;
const PING_EVERY_MS = 2_000;
/** No pong for this long: the connection is dead (TCP may take minutes to notice). */
const DEAD_AFTER_MS = 15_000;
const CHAT_WINDOW_MS = 5_000;
const CHAT_LINES_PER_WINDOW = 5;
const MAX_MALFORMED = 25;
/** Message token bucket per socket: inputs arrive at 60/s; a stall may flush a burst. */
const MESSAGE_BURST = 600;
const MESSAGES_PER_SECOND = 240;
/** A client this far behind on its socket cannot catch up: it reconnects for a fresh snapshot. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/**
 * Wrong passwords per minute per client address, and in total through one socket peer: a tunnel
 * or proxy relays all its clients from one peer, whatever client a forged header claims.
 */
const FAILURE_LIMIT = 5;
const PEER_FAILURE_LIMIT = 30;
const FAILURE_WINDOW_MS = 60_000;
/** Seat, ready and settings changes reach everyone: one per player per this long, extras ignored. */
export const CHANGE_COOLDOWN_MS = 500;

/** Application close codes (4000-4999). */
const CLOSE_REPLACED = 4000;
export const CLOSE_DENIED = 4001;
const CLOSE_POLICY = 1008;
const CLOSE_GOING_AWAY = 1001;

const DIFFICULTY_NAMES: Record<Difficulty, string> = {
  chill: 'Chill',
  normal: 'Normal',
  hard: 'Hard',
  vexillosaint: 'Vexillosaint',
};

const DENIALS: Record<Exclude<DenyReason, 'banned'>, string> = {
  protocol: 'This page speaks another dialect of the D.E.G.E.N. mesh than the host. Reload the page to update it.',
  throttled: 'Too many wrong passwords from your camp. The Gaskeeper makes you wait a minute.',
  password: 'The Flags do not recognise that password.',
  name: 'Choose a handle the Flags can read (not only spaces).',
  full: `This burn is full (${MAX_PLAYERS} vexillomancers). Try again when someone wanders off.`,
};

export interface RoomOptions {
  serverName: string;
  password: string;
  log: (line: string) => void;
}

interface Conn {
  readonly ws: WebSocket;
  /** The client's address, for logs. */
  readonly address: string;
  /** addressKey of the client (pending cap, password throttle) and of the socket peer (relay ceiling). */
  readonly key: string;
  readonly peerKey: string;
  player: Player | null;
  /** The host is closing this socket: ignore whatever still arrives on it. */
  retired: boolean;
  helloTimer: NodeJS.Timeout | undefined;
  malformed: number;
  tokens: number;
  tokensAt: number;
  pingSentAt: number;
  awaitingPong: boolean;
}

interface Player {
  readonly id: string;
  readonly token: string;
  name: string;
  seat: FactionId | null;
  ready: boolean;
  conn: Conn | null;
  connectedAt: number;
  disconnectedAt: number;
  /** Smoothed round-trip time (ms) from ws pings; 0 until measured. */
  rtt: number;
  /** The ping the lobby last published (republished when it drifts). */
  shownPing: number;
  /** Receives state frames: got matchStart for the running match. */
  inMatch: boolean;
  /** Gets matchStart at the next frame boundary. */
  joining: boolean;
  chatTimes: number[];
  jammedAt: number;
  /** When the last seat/ready/settings change took effect (CHANGE_COOLDOWN_MS). */
  changedAt: number;
}

export class Room {
  readonly serverName: string;
  private readonly gate: PasswordGate;
  private readonly throttle = new FailureThrottle(FAILURE_LIMIT, FAILURE_WINDOW_MS);
  private readonly peerThrottle = new FailureThrottle(PEER_FAILURE_LIMIT, FAILURE_WINDOW_MS);
  private readonly log: (line: string) => void;
  private readonly conns = new Set<Conn>();
  /** Insertion order = join order (the lobby lists players that way). */
  private readonly players = new Map<string, Player>();
  private readonly byToken = new Map<string, Player>();
  private phase: LobbyPhase = 'lobby';
  private readonly settings: LobbySettings = { difficulty: 'normal', seed: null, match: normalizeMatch(DEFAULT_MATCH) };
  private leaderId: string | null = null;
  private match: Match | null = null;
  private nextPlayer = 1;
  private lobbyQueued = false;
  private readonly housekeeping: NodeJS.Timeout;
  private lastPingAt = 0;
  private lastSweepAt = 0;
  private abandonAt = 0;
  private closing = false;

  private readonly listener: MatchListener = {
    frame: (text) => {
      // 30 times a second: no per-frame closure for `safely`.
      try {
        this.frame(text);
      } catch (err) {
        this.report('a state frame', err);
      }
    },
    ended: () => this.safely('match end', () => this.matchEnded()),
    resync: () => {
      for (const p of this.players.values()) {
        if (!p.inMatch) continue;
        p.inMatch = false;
        p.joining = true;
      }
    },
    broken: () => this.safely('match failure', () => this.matchBroken()),
  };

  constructor(opts: RoomOptions) {
    this.serverName = opts.serverName;
    this.gate = new PasswordGate(opts.password);
    this.log = opts.log;
    this.housekeeping = setInterval(() => this.safely('housekeeping', () => this.tidy()), HOUSEKEEPING_MS);
  }

  info(): HostInfo {
    let players = 0;
    for (const p of this.players.values()) if (p.conn) players++;
    let seated = 0;
    for (const f of FACTION_IDS) if (this.ownerOf(f)) seated++;
    return { serverName: this.serverName, protocol: PROTOCOL_VERSION, phase: this.phase, players, seated };
  }

  /**
   * Room for one more socket from `origin` that has yet to say hello: null, or what is full (the
   * host, or that address's share). Retired sockets no longer hold a slot.
   */
  upgradeRefusal(origin: Origin): 'host' | 'address' | null {
    if (this.closing) return 'host';
    const key = addressKey(origin.address);
    let pending = 0;
    let mine = 0;
    for (const c of this.conns) {
      if (c.player || c.retired) continue;
      pending++;
      if (c.key === key) mine++;
    }
    if (mine >= MAX_PENDING_PER_ADDRESS) return 'address';
    return pending >= MAX_PENDING ? 'host' : null;
  }

  connect(ws: WebSocket, origin: Origin): void {
    const conn: Conn = {
      ws,
      address: origin.address,
      key: addressKey(origin.address),
      peerKey: addressKey(origin.peer),
      player: null,
      retired: false,
      helloTimer: undefined,
      malformed: 0,
      tokens: MESSAGE_BURST,
      tokensAt: performance.now(),
      pingSentAt: 0,
      awaitingPong: false,
    };
    this.conns.add(conn);
    ws.on('message', (data, isBinary) => {
      try {
        this.receive(conn, data, isBinary);
      } catch (err) {
        this.report(`a message from ${who(conn)}`, err);
      }
    });
    ws.on('pong', () => this.pong(conn));
    ws.on('close', () => this.safely('a closing socket', () => this.closed(conn)));
    ws.on('error', (err) => this.log(`socket error from ${who(conn)}: ${err.message}`));
    // A socket that never says hello is not listening either: cut it instead of waiting out a close handshake.
    conn.helloTimer = setTimeout(() => {
      conn.retired = true;
      ws.terminate();
    }, HELLO_TIMEOUT_MS);
  }

  /** Tell everyone, close every socket (cut the stragglers after a second) and stop the burn. */
  async shutdown(notice: string): Promise<void> {
    this.closing = true;
    clearInterval(this.housekeeping);
    this.match?.stop();
    this.match = null;
    for (const conn of this.conns) {
      if (conn.player) this.send(conn, { t: 'notice', text: notice });
      this.retire(conn, CLOSE_GOING_AWAY, 'The host is shutting down');
    }
    const deadline = Date.now() + 1000;
    while (this.conns.size > 0 && Date.now() < deadline) await sleep(20);
    for (const conn of this.conns) conn.ws.terminate();
  }

  // ── Connections ───────────────────────────────────────────────────────────
  private receive(conn: Conn, data: RawData, isBinary: boolean): void {
    if (conn.retired) return;
    const now = performance.now();
    conn.tokens = Math.min(MESSAGE_BURST, conn.tokens + ((now - conn.tokensAt) / 1000) * MESSAGES_PER_SECOND);
    conn.tokensAt = now;
    if (conn.tokens < 1) {
      this.log(`${who(conn)} is flooding the host; disconnecting`);
      this.retire(conn, CLOSE_POLICY, 'Too many messages');
      return;
    }
    conn.tokens--;
    const msg = isBinary ? null : parseClientMessage(rawText(data));
    if (!msg) {
      conn.malformed++;
      if (conn.malformed === 1) this.log(`dropped a malformed message from ${who(conn)}`);
      if (conn.malformed >= MAX_MALFORMED) {
        this.log(`${who(conn)} sent ${MAX_MALFORMED} malformed messages; disconnecting`);
        this.retire(conn, CLOSE_POLICY, 'Too many malformed messages');
      }
      return;
    }
    if (conn.player) this.handle(conn.player, msg);
    else this.hello(conn, msg);
  }

  private hello(conn: Conn, msg: ClientMessage): void {
    if (msg.t !== 'hello') {
      this.retire(conn, CLOSE_POLICY, 'Say hello first');
      return;
    }
    clearTimeout(conn.helloTimer);
    if (msg.protocol !== PROTOCOL_VERSION) return this.deny(conn, 'protocol');
    const now = Date.now();
    if (this.throttle.blocked(conn.key, now) || this.peerThrottle.blocked(conn.peerKey, now)) return this.deny(conn, 'throttled');
    if (!this.gate.admits(msg.password)) {
      this.throttle.fail(conn.key, now);
      this.peerThrottle.fail(conn.peerKey, now);
      return this.deny(conn, 'password');
    }
    const known = msg.token === null ? undefined : this.byToken.get(msg.token);
    const name = cleanText(msg.name, MAX_NAME_LENGTH);
    if (!known && !name) return this.deny(conn, 'name');
    if (!known?.conn && this.connectedCount() >= MAX_PLAYERS) return this.deny(conn, 'full');
    if (known) {
      if (name && name !== known.name) known.name = this.uniqueAmongOthers(name, known);
      this.attach(conn, known, now, true);
    } else {
      this.attach(conn, this.newPlayer(name, now), now, false);
    }
  }

  private newPlayer(name: string, now: number): Player {
    const player: Player = {
      id: `p${this.nextPlayer++}`,
      token: randomBytes(16).toString('hex'),
      name: this.uniqueAmongOthers(name, null),
      seat: null,
      ready: false,
      conn: null,
      connectedAt: now,
      disconnectedAt: 0,
      rtt: 0,
      shownPing: 0,
      inMatch: false,
      joining: false,
      chatTimes: [],
      jammedAt: 0,
      changedAt: 0,
    };
    // In the lobby newcomers sit down at the lowest free seat; mid-match they watch first.
    if (this.phase === 'lobby') player.seat = FACTION_IDS.find((f) => normalizeMatch(this.settings.match).active.includes(f) && !this.ownerOf(f)) ?? null;
    this.players.set(player.id, player);
    this.byToken.set(player.token, player);
    return player;
  }

  private attach(conn: Conn, player: Player, now: number, returning: boolean): void {
    const previous = player.conn;
    if (previous) {
      // The same player from a new tab or a faster reconnect: the old socket goes quietly.
      previous.player = null;
      this.retire(previous, CLOSE_REPLACED, 'Signed in again elsewhere');
    }
    player.conn = conn;
    conn.player = player;
    player.connectedAt = now;
    player.inMatch = false;
    player.joining = this.match !== null;
    if (this.leaderId === null) this.leaderId = player.id;
    this.abandonAt = 0;
    this.send(conn, { t: 'welcome', protocol: PROTOCOL_VERSION, playerId: player.id, token: player.token, lobby: this.lobbyState() });
    if (!returning) this.system(`${player.name} arrived at the burn.`);
    else if (!previous) this.announce(player, `${player.name} found their way back.`);
    this.log(`${player.name} ${returning ? 'rejoined' : 'joined'} from ${conn.address} (${this.connectedCount()} connected)`);
    this.markLobby();
  }

  private closed(conn: Conn): void {
    this.conns.delete(conn);
    clearTimeout(conn.helloTimer);
    const p = conn.player;
    if (!p || p.conn !== conn) return;
    conn.player = null;
    p.conn = null;
    p.disconnectedAt = Date.now();
    p.inMatch = false;
    p.joining = false;
    if (this.match && p.seat !== null) this.match.holdStill(p.seat);
    if (this.closing) return;
    this.log(`${p.name} disconnected (${this.connectedCount()} connected)`);
    this.announce(p, `${p.name} wandered off into the dust.`);
    if (this.leaderId === p.id) this.passLeadership();
    this.markLobby();
  }

  private pong(conn: Conn): void {
    const p = conn.player;
    if (!conn.awaitingPong || !p) return;
    conn.awaitingPong = false;
    const rtt = performance.now() - conn.pingSentAt;
    p.rtt = p.rtt === 0 ? rtt : p.rtt * 0.75 + rtt * 0.25;
  }

  private deny(conn: Conn, reason: Exclude<DenyReason, 'banned'>): void {
    this.log(`denied ${conn.address}: ${reason}`);
    this.send(conn, { t: 'denied', reason, message: DENIALS[reason] });
    this.retire(conn, CLOSE_DENIED, reason);
  }

  /** Close from the host's side; queued messages (a denial, a notice) still go out first. */
  private retire(conn: Conn, code: number, reason: string): void {
    if (conn.retired) return;
    conn.retired = true;
    clearTimeout(conn.helloTimer);
    conn.ws.close(code, reason);
  }

  // ── Lobby ─────────────────────────────────────────────────────────────────
  private handle(player: Player, msg: ClientMessage): void {
    switch (msg.t) {
      case 'hello':
        return;
      case 'seat':
      case 'ready':
      case 'settings':
        return this.change(player, msg);
      case 'start':
        return this.start(player);
      case 'backToLobby':
        if (player.id !== this.leaderId || this.phase !== 'ended') return;
        this.endMatch();
        return this.system('The ashes cool. Gather for the next Survey.');
      case 'chat':
        return this.chat(player, msg.text);
      case 'input':
        if (this.match && player.inMatch && player.seat !== null) this.match.pushInput(player.seat, player.id, msg);
        return;
      case 'ping':
        if (player.conn) this.send(player.conn, { t: 'pong', id: msg.id, clientTime: msg.clientTime, serverTime: Date.now() });
        return;
    }
  }

  /**
   * Seat, ready and settings changes each reach everyone (a lobby frame, mostly a chat line,
   * mid-match a camp handover and a fresh matchStart): one per player per CHANGE_COOLDOWN_MS.
   * Extras are ignored; the client sees the lobby as it stands and can ask again.
   */
  private change(player: Player, msg: Extract<ClientMessage, { t: 'seat' | 'ready' | 'settings' }>): void {
    const now = Date.now();
    if (now - player.changedAt < CHANGE_COOLDOWN_MS) return;
    let changed: boolean;
    if (msg.t === 'seat') changed = this.takeSeat(player, msg.seat);
    else if (msg.t === 'ready') changed = this.setReady(player, msg.ready);
    else changed = this.changeSettings(player, msg.settings);
    if (changed) player.changedAt = now;
  }

  private setReady(player: Player, ready: boolean): boolean {
    if (this.phase !== 'lobby' || player.ready === ready) return false;
    player.ready = ready;
    this.markLobby();
    return true;
  }

  /**
   * Seats: one human each. A seat is free when nobody holds it, or its holder has been gone past
   * the grace (an NPC drives it meanwhile; they come back as a spectator). Mid-match only alive
   * camps can be taken, and any seat change sends that client a fresh matchStart.
   */
  private takeSeat(player: Player, seat: FactionId | null): boolean {
    if (seat === player.seat || this.phase === 'ended') return false;
    const match = this.match;
    if (seat !== null) {
      if(!normalizeMatch(this.settings.match).active.includes(seat))return false;
      const holder = this.ownerOf(seat);
      if (holder && (holder.conn || Date.now() - holder.disconnectedAt < SEAT_GRACE_MS)) return false;
      if (match && !match.world.factions[seat].alive) return false;
      if (holder) holder.seat = null;
    }
    const from = player.seat;
    player.seat = seat;
    player.ready = false;
    if (!match) {
      this.announce(player, seat === null ? `${player.name} steps back to watch.` : `${player.name} takes up the Flags of ${FACTION_DEFS[seat].name}.`);
      this.markLobby();
      return true;
    }
    // Mid-match every seat change hands a camp to or from an NPC: the host log and the chat say so.
    if (from !== null) {
      match.driveNpc(from);
      this.log(`NPC takes over seat ${from} (${FACTION_DEFS[from].name}) from ${player.name}`);
    }
    player.inMatch = false;
    player.joining = player.conn !== null;
    if (seat !== null) {
      this.log(`${player.name} takes over seat ${seat} (${FACTION_DEFS[seat].name}) from the NPC`);
      this.announce(player, `${player.name} takes over ${FACTION_DEFS[seat].name} from the NPC.`);
    } else if (from !== null) {
      this.announce(player, `${player.name} steps back to watch; an NPC steers ${FACTION_DEFS[from].name}.`);
    }
    this.markLobby();
    return true;
  }

  private changeSettings(player: Player, patch: Partial<LobbySettings>): boolean {
    if (player.id !== this.leaderId || this.phase !== 'lobby') return false;
    const changes: string[] = [];
    if(patch.match) {
      if(this.humanSeats().some(f=>!patch.match!.active.includes(f))) {this.tell(player,"Move players out of a camp before disabling it.");return false;}
      this.settings.match=normalizeMatch(patch.match);changes.push("the game setup");
    }
    if (patch.difficulty !== undefined && patch.difficulty !== this.settings.difficulty) {
      this.settings.difficulty = patch.difficulty;
      changes.push(`the NPC rivals to ${DIFFICULTY_NAMES[patch.difficulty]}`);
    }
    if (patch.seed !== undefined) {
      const seed = patch.seed === null ? null : cleanText(patch.seed, MAX_SEED_LENGTH) || null;
      if (seed !== this.settings.seed) {
        this.settings.seed = seed;
        changes.push(seed === null ? 'a fresh random seed for every burn' : `the seed to "${seed}"`);
      }
    }
    if (changes.length === 0) return false;
    this.announce(player, `${player.name} set ${changes.join(' and ')}.`);
    this.markLobby();
    return true;
  }

  private start(player: Player): void {
    if (player.id !== this.leaderId || this.phase !== 'lobby') return;
    if (!FACTION_IDS.some((f) => this.ownerOf(f)?.conn)) {
      this.tell(player, 'Take a seat first: a burn needs at least one vexillomancer.');
      return;
    }
    const humans = this.humanSeats();
    const options: MatchOptions = {
      seed: this.settings.seed ?? `burn-${randomBytes(4).toString('hex')}`,
      difficulty: this.settings.difficulty,
      humans,
      mode: 'standard',
      match: normalizeMatch(this.settings.match),
    };
    const t0 = performance.now();
    let match: Match;
    try {
      match = new Match(options, this.listener, this.log);
    } catch (err) {
      this.report(`building the burn (seed ${options.seed})`, err);
      this.system('The burn would not light (the host hit an error). Try another seed.');
      return;
    }
    this.match = match;
    this.phase = 'playing';
    for (const f of FACTION_IDS) {
      const holder = this.ownerOf(f);
      if (holder?.conn) match.driveHuman(f, holder.id);
      else match.driveNpc(f);
    }
    // Everyone connected starts together from the encoder's baseline: no frame has gone out yet.
    const snapshot = JSON.stringify(match.full());
    for (const p of this.players.values()) {
      p.ready = false;
      p.joining = false;
      p.inMatch = p.conn !== null;
      if (p.conn) this.sendText(p.conn, this.matchStartText(match, p.seat, humans, snapshot));
    }
    match.start();
    const npcs = SEAT_COUNT - humans.length;
    this.log(`burn started: seed ${options.seed}, ${humans.length} human seat(s), ${npcs} ${options.difficulty} NPC(s), built in ${Math.round(performance.now() - t0)} ms`);
    this.system(
      `The Survey begins on seed "${options.seed}": ${humans.length} vexillomancer${humans.length === 1 ? '' : 's'}, ${npcs} NPC rival${npcs === 1 ? '' : 's'}.`,
    );
    this.markLobby();
  }

  /** After each frame's broadcast: clients waiting to join get matchStart, then later frames only. */
  private frame(text: string): void {
    const match = this.match;
    if (!match) return;
    for (const p of this.players.values()) if (p.inMatch && p.conn) this.sendText(p.conn, text);
    let snapshot: string | null = null;
    let humans: FactionId[] = [];
    for (const p of this.players.values()) {
      if (!p.joining || !p.conn) continue;
      if (snapshot === null) {
        snapshot = JSON.stringify(match.full());
        humans = this.humanSeats();
      }
      p.joining = false;
      p.inMatch = true;
      // Hands the seat back from the NPC (or restarts the input sequence) as matchStart goes out.
      if (p.seat !== null) match.driveHuman(p.seat, p.id);
      this.sendText(p.conn, this.matchStartText(match, p.seat, humans, snapshot));
    }
  }

  /** matchStart around an already serialized snapshot (stringified once for every recipient). */
  private matchStartText(match: Match, seat: FactionId | null, humans: FactionId[], snapshot: string): string {
    const options: MatchOptions = { ...match.world.options, humans };
    return `{"t":"matchStart","options":${JSON.stringify(options)},"seat":${seat === null ? 'null' : seat},"snapshot":${snapshot}}`;
  }

  private matchEnded(): void {
    const match = this.match;
    if (!match) return;
    this.phase = 'ended';
    const winner = match.world.winner;
    const holder = winner === null ? undefined : this.ownerOf(winner);
    const who = winner === null ? '' : `${FACTION_DEFS[winner].name} (${holder ? holder.name : 'NPC'})`;
    this.log(`burn ended at ${Math.round(match.world.time)} s: ${who || 'no winner'}`);
    this.system(who ? `${who} completes the Survey. The leader can gather everyone for the next burn.` : 'The burn ends.');
    this.markLobby();
  }

  private matchBroken(): void {
    this.endMatch();
    this.broadcast({ t: 'notice', text: 'The burn collapsed: the host hit an internal error. Back to the lobby.' });
  }

  /** Drop the world and return everyone to the lobby. */
  private endMatch(): void {
    this.match?.stop();
    this.match = null;
    this.phase = 'lobby';
    this.abandonAt = 0;
    for (const p of this.players.values()) {
      p.inMatch = false;
      p.joining = false;
      p.ready = false;
    }
    this.markLobby();
  }

  private chat(player: Player, raw: string): void {
    const text = cleanText(raw, MAX_CHAT_LENGTH);
    if (!text) return;
    const now = Date.now();
    if (!this.spendChat(player, now)) {
      if (now - player.jammedAt >= CHAT_WINDOW_MS) {
        player.jammedAt = now;
        this.tell(player, 'The D.E.G.E.N. mesh is jammed: let it cool a moment before you transmit again.');
      }
      return;
    }
    this.broadcast({ t: 'chat', line: { from: player.name, playerId: player.id, seat: player.seat, text, at: now } });
  }

  /** One line from the player's chat budget (CHAT_LINES_PER_WINDOW per CHAT_WINDOW_MS); false when it is spent. */
  private spendChat(player: Player, now: number): boolean {
    const times = player.chatTimes;
    while (times.length > 0 && now - times[0] >= CHAT_WINDOW_MS) times.shift();
    if (times.length >= CHAT_LINES_PER_WINDOW) return false;
    times.push(now);
    return true;
  }

  /**
   * A system line about something `player` did, paid from their chat budget: past it the line is
   * dropped (the lobby still shows the change), so actions cannot out-shout the chat limit.
   */
  private announce(player: Player, text: string): void {
    if (this.spendChat(player, Date.now())) this.system(text);
  }

  private system(text: string): void {
    this.broadcast({ t: 'chat', line: systemLine(text) });
  }

  private tell(player: Player, text: string): void {
    if (player.conn) this.send(player.conn, { t: 'chat', line: systemLine(text) });
  }

  private passLeadership(): void {
    let next: Player | null = null;
    for (const p of this.players.values()) if (p.conn && (!next || p.connectedAt < next.connectedAt)) next = p;
    this.leaderId = next ? next.id : null;
    if (next) this.system(`${next.name} now leads the burn.`);
  }

  /** Housekeeping: NPC takeovers after the grace, forgetting, pings, throttle sweeps, abandonment. */
  private tidy(): void {
    const now = Date.now();
    const match = this.match;
    for (const p of this.players.values()) {
      if (p.conn) continue;
      const away = now - p.disconnectedAt;
      if (match && p.seat !== null && away >= SEAT_GRACE_MS && !match.drivenByNpc(p.seat)) {
        match.driveNpc(p.seat);
        this.log(`NPC takes over seat ${p.seat} for ${p.name}`);
        this.system(`An NPC steers ${FACTION_DEFS[p.seat].name} until ${p.name} returns.`);
      }
      if (away >= FORGET_AFTER_MS && !(match && p.seat !== null)) {
        this.players.delete(p.id);
        this.byToken.delete(p.token);
        this.markLobby();
      }
    }
    if (now - this.lastPingAt >= PING_EVERY_MS) {
      this.lastPingAt = now;
      this.pingAll();
    }
    if (now - this.lastSweepAt >= FAILURE_WINDOW_MS) {
      this.lastSweepAt = now;
      this.throttle.sweep(now);
      this.peerThrottle.sweep(now);
    }
    if (match) {
      if (this.connectedCount() > 0) this.abandonAt = 0;
      else if (this.abandonAt === 0) this.abandonAt = now + ABANDON_AFTER_MS;
      else if (now >= this.abandonAt) {
        this.log('burn abandoned: nobody was connected for two minutes');
        this.endMatch();
      }
    }
  }

  /** ws-level pings: browsers answer them natively, which measures RTT and finds dead sockets. */
  private pingAll(): void {
    const now = performance.now();
    for (const conn of this.conns) {
      if (!conn.player || conn.retired) continue;
      if (conn.awaitingPong) {
        if (now - conn.pingSentAt > DEAD_AFTER_MS) {
          this.log(`${who(conn)} stopped answering; dropping the connection`);
          conn.ws.terminate();
        }
        continue;
      }
      conn.awaitingPong = true;
      conn.pingSentAt = now;
      conn.ws.ping();
    }
    let changed = false;
    for (const p of this.players.values()) {
      const shown = Math.round(p.rtt);
      if (Math.abs(shown - p.shownPing) < 2) continue;
      p.shownPing = shown;
      changed = true;
    }
    if (changed) this.markLobby();
  }

  // ── State and sending ─────────────────────────────────────────────────────
  private ownerOf(f: FactionId): Player | undefined {
    for (const p of this.players.values()) if (p.seat === f) return p;
    return undefined;
  }

  private humanSeats(): FactionId[] {
    return FACTION_IDS.filter((f) => this.ownerOf(f) !== undefined);
  }

  private connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.conn) n++;
    return n;
  }

  private uniqueAmongOthers(name: string, self: Player | null): string {
    const taken = new Set<string>();
    for (const p of this.players.values()) if (p !== self) taken.add(p.name.toLowerCase());
    return uniqueName(name, taken, MAX_NAME_LENGTH);
  }

  private lobbyState(): LobbyState {
    const players = [];
    for (const p of this.players.values()) {
      players.push({ id: p.id, name: p.name, seat: p.seat, ready: p.ready, connected: p.conn !== null, ping: p.shownPing });
    }
    return {
      serverName: this.serverName,
      phase: this.phase,
      leaderId: this.leaderId,
      settings: { difficulty: this.settings.difficulty, seed: this.settings.seed, match: this.settings.match },
      seats: FACTION_IDS.map((faction) => ({ faction, playerId: this.ownerOf(faction)?.id ?? null })),
      players,
      match: this.match ? { time: this.match.world.time, winner: this.match.world.winner } : null,
    };
  }

  /** Coalesces every change made in one handler into a single lobby broadcast. */
  private markLobby(): void {
    if (this.lobbyQueued || this.closing) return;
    this.lobbyQueued = true;
    queueMicrotask(() =>
      this.safely('the lobby broadcast', () => {
        this.lobbyQueued = false;
        this.broadcast({ t: 'lobby', lobby: this.lobbyState() });
      }),
    );
  }

  private broadcast(msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const conn of this.conns) if (conn.player) this.sendText(conn, text);
  }

  private send(conn: Conn, msg: ServerMessage): void {
    this.sendText(conn, JSON.stringify(msg));
  }

  private sendText(conn: Conn, text: string): void {
    const ws = conn.ws;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.log(`${who(conn)} cannot keep up (${(ws.bufferedAmount / 1048576).toFixed(1)} MB queued); dropping it so it resyncs`);
      ws.terminate();
      return;
    }
    ws.send(text);
  }

  private safely(where: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      this.report(where, err);
    }
  }

  private report(where: string, err: unknown): void {
    this.log(`error handling ${where}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

function systemLine(text: string): ChatLine {
  return { from: null, playerId: null, seat: null, text, at: Date.now() };
}

function who(conn: Conn): string {
  return conn.player ? `${conn.player.name} (${conn.address})` : conn.address;
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
