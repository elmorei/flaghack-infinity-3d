import { MAX_PLAYERS, Room } from '../../server/room';
import type { RoomSocket } from '../../server/room';
import type { ClientSocket } from './client';
import { MAX_CLIENT_MESSAGE_BYTES } from './protocol';
import { PeerWire, createRtcOffer, acceptRtcOffer, acceptRtcAnswer, offerFingerprint } from './browserPeer';

const ROOM_CODE_VERSION = 1;
const MAX_OFFER_CHARACTERS = 65_536;
const MAX_BROWSER_PEERS = MAX_PLAYERS - 1;
const INVITE_EXPIRY_MS = 120_000;
const LOBBY_JOIN_TIMEOUT_MS = 20_000;
const encoder = new TextEncoder();

interface Wire {
  readonly bufferedAmount: number;
  onopen: (() => void) | null;
  onmessage: ((text: string) => void) | null;
  onclose: (() => void) | null;
  send(text: string): void;
  close(): void;
}

/** The host player also joins the same room using the same wire protocol. */
export function localWires(): [Wire, Wire] {
  let closed = false;
  function side(): Wire {
    return {
      bufferedAmount: 0, onopen: null, onmessage: null, onclose: null,
      send(text) { const other = this === a ? b : a; queueMicrotask(() => { if (!closed) other.onmessage?.(text); }); },
      close() { if (closed) return; closed = true; queueMicrotask(() => { a.onclose?.(); b.onclose?.(); }); },
    };
  }
  const a = side(), b = side();
  queueMicrotask(() => { if (!closed) { a.onopen?.(); b.onopen?.(); } });
  return [a, b];
}

export function browserRoomSocket(wire: Wire, sent?: (text: string) => void): RoomSocket {
  let closed = false;
  let closedHandler: () => void = () => {};
  const close = (): void => {
    if (closed) return;
    closed = true;
    wire.close();
    queueMicrotask(closedHandler);
  };
  wire.onclose = close;
  return {
    get readyState() { return closed ? 3 : 1; },
    get bufferedAmount() { return wire.bufferedAmount; },
    onMessage(cb) { wire.onmessage = (text) => {
      if (!closed) cb(encoder.encode(text).byteLength <= MAX_CLIENT_MESSAGE_BYTES ? text : null);
    }; },
    onClose(cb) { closedHandler = cb; },
    onError() { /* PeerWire closes on transport failure; no peer-supplied text is logged. */ },
    send(text) { if (!closed) { try { wire.send(text); sent?.(text); } catch { close(); } } },
    close,
    terminate: close,
  };
}

export function browserClientSocket(wire: Wire): ClientSocket {
  let state: 0 | 1 | 3 = 0;
  const socket: ClientSocket = {
    get readyState() { return state; }, onopen: null, onclose: null, onmessage: null,
    send(text) {
      if (state !== 1 || typeof text !== 'string') return;
      try { wire.send(text); } catch { socket.close(); }
    },
    close(code = 1000) {
      if (state === 3) return;
      state = 3;
      wire.close();
      queueMicrotask(() => socket.onclose?.call(null as unknown as WebSocket, { code } as CloseEvent));
    },
  };
  wire.onopen = () => {
    if (state !== 0) return;
    state = 1;
    socket.onopen?.call(null as unknown as WebSocket, new Event('open'));
  };
  wire.onmessage = (data) => {
    if (state === 1) socket.onmessage?.call(null as unknown as WebSocket, { data } as MessageEvent);
  };
  wire.onclose = () => socket.close(1006);
  return socket;
}

export function encodeRoomOffer(room: string, offer: string): string {
  return JSON.stringify({ version: ROOM_CODE_VERSION, room, offer });
}

export function decodeRoomOffer(raw: string): { room: string; offer: string } {
  if (raw.length > MAX_OFFER_CHARACTERS) throw new Error('The offer code is too long.');
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version === ROOM_CODE_VERSION && typeof value.room === 'string' &&
      /^[a-f0-9]{32}$/.test(value.room) && typeof value.offer === 'string') {
      return { room: value.room, offer: value.offer };
    }
  } catch { /* use a fixed message; never echo private signaling material */ }
  throw new Error('Paste the complete browser-host offer code.');
}

type Join = (name: string, socket: ClientSocket, room: string, welcomed?: () => void) => boolean;
export type InviteStatus = 'offer-expired' | 'host-channel' | 'host-welcome' | 'host-failed' |
  'guest-channel' | 'guest-welcome' | 'guest-failed';
type Pending = Awaited<ReturnType<typeof createRtcOffer>>;

/** Manually negotiated private room; there is no signaling, STUN or relay service. */
export class BrowserBurn {
  private room: Room | null = null;
  private certificate: RTCCertificate | null = null;
  private pending: Pending | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private peerNumber = 0;
  private readonly peers = new Set<RTCPeerConnection>();
  private guest: RTCPeerConnection | null = null;
  private cancelGuestAttempt: (() => void) | null = null;
  private hostGeneration = 0;
  private guestGeneration = 0;
  private pendingHostSetup = false;
  get paused(): boolean { return this.room?.isPaused ?? false; }
  get performancePaused(): boolean { return this.room?.performancePaused ?? false; }

  constructor(private readonly join: Join, private readonly onInviteStatus: (status: InviteStatus) => void,
    private readonly onPerformancePause: () => void = () => {}) {}
  get hosting(): boolean { return this.room !== null; }
  get connectedPeers(): number { return this.peers.size; }

  async startHost(name: string): Promise<void> {
    if (this.room) throw new Error('A browser burn is already running.');
    const algorithm: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
    this.certificate = await RTCPeerConnection.generateCertificate(algorithm);
    const [roomWire, clientWire] = localWires();
    const room = new Room({ serverName: 'Browser-hosted burn', admit: (password) => password === '',
      addressKey: (privateChannel) => privateChannel, log: () => {}, onPerformancePause: this.onPerformancePause });
    // Membership is granted only when the host manually applies a given peer's answer.
    room.connect(browserRoomSocket(roomWire), { address: 'browser-host', peer: 'browser-host' });
    this.room = room;
    if (!this.join(name, browserClientSocket(clientWire), room.instanceId)) {
      this.stopHost();
      throw new Error('Return to the title screen before starting a browser burn.');
    }
  }

  async createOffer(): Promise<string> {
    const room = this.room, certificate = this.certificate;
    if (!room || !certificate) throw new Error('Start the browser host first.');
    if (this.pendingHostSetup) throw new Error('Please wait for the current offer.');
    if (this.peers.size >= MAX_BROWSER_PEERS) throw new Error('This room is at its guest limit.');
    this.cancelOffer();
    this.pendingHostSetup = true;
    const generation = this.hostGeneration;
    try {
      const pending = await createRtcOffer(certificate);
      if (this.room !== room || this.hostGeneration !== generation) {
        pending.connection.close();
        throw new Error('This invitation was canceled.');
      }
      this.pending = pending;
      this.timer = setTimeout(() => {
        if (this.pending !== pending) return;
        this.cancelOffer();
        this.onInviteStatus('offer-expired');
      }, INVITE_EXPIRY_MS);
      return encodeRoomOffer(room.instanceId, pending.code);
    } finally {
      this.pendingHostSetup = false;
    }
  }

  async applyAnswer(answer: string): Promise<void> {
    const room = this.room, pending = this.pending;
    if (!room || !pending) throw new Error('Create a fresh offer before applying an answer.');
    await acceptRtcAnswer(pending.connection, answer);
    if (room !== this.room || pending !== this.pending) throw new Error('This browser invite expired.');
    this.pending = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const peer = pending.connection;
    const wire = new PeerWire(pending.channel);
    this.peers.add(peer);
    const peerId = 'private-channel-' + ++this.peerNumber;
    const generation = this.hostGeneration;
    const notify = (status: InviteStatus): void => {
      if (this.room === room && this.hostGeneration === generation) this.onInviteStatus(status);
    };
    let admitted = false;
    const expiry = setTimeout(() => wire.close(), LOBBY_JOIN_TIMEOUT_MS);
    const discard = (): void => {
      clearTimeout(expiry);
      this.peers.delete(peer);
      peer.close();
      if (!admitted) notify('host-failed');
    };
    wire.onclose = discard;
    wire.onopen = () => {
      if (this.room !== room) { wire.close(); return; }
      const socket = browserRoomSocket(wire, (text) => {
        // Room.send serializes its local tagged message with t first. Never inspect guest input.
        if (admitted || !text.startsWith('{"t":"welcome",')) return;
        admitted = true;
        clearTimeout(expiry);
        notify('host-welcome');
      });
      const closeRoom = wire.onclose;
      wire.onclose = () => { closeRoom?.(); discard(); };
      room.connect(socket, { address: peerId, peer: peerId });
      notify('host-channel');
    };
    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') wire.close();
    });
  }

  async createAnswer(rawOffer: string, name: string): Promise<string> {
    this.cancelGuest();
    const generation = this.guestGeneration;
    const { room, offer } = decodeRoomOffer(rawOffer);
    // An untrusted room ID alone must never select another host’s reclaim token.
    const scope = room + ':' + offerFingerprint(offer);
    const invitation = await acceptRtcOffer(offer);
    if (this.guestGeneration !== generation) {
      invitation.connection.close();
      throw new Error('This invitation was canceled.');
    }
    const peer = invitation.connection;
    this.guest = peer;
    let wire: PeerWire | null = null;
    let welcomed = false;
    let lobbyDeadline: ReturnType<typeof setTimeout> | null = null;
    const expire = (): void => {
      if (this.guest !== peer) return;
      const shouldNotify = !welcomed;
      this.cancelGuest();
      if (shouldNotify) this.onInviteStatus('guest-failed');
    };
    const expiry = setTimeout(expire, INVITE_EXPIRY_MS);
    const clearDeadlines = (): void => {
      clearTimeout(expiry);
      if (lobbyDeadline !== null) clearTimeout(lobbyDeadline);
    };
    this.cancelGuestAttempt = () => { clearDeadlines(); wire?.close(); peer.close(); };
    void invitation.channel.then((channel) => {
      if (this.guest !== peer) { peer.close(); return; }
      const link = wire = new PeerWire(channel);
      const socket = browserClientSocket(link);
      const connected = link.onopen;
      const closed = link.onclose;
      link.onopen = () => {
        clearTimeout(expiry);
        lobbyDeadline = setTimeout(expire, LOBBY_JOIN_TIMEOUT_MS);
        if (this.guest === peer) this.onInviteStatus('guest-channel');
        connected?.();
      };
      link.onclose = () => { closed?.(); expire(); };
      peer.addEventListener('connectionstatechange', () => {
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') link.close();
      });
      if (!this.join(name, socket, scope, () => {
        if (this.guest !== peer || welcomed) return;
        welcomed = true;
        clearDeadlines();
        this.onInviteStatus('guest-welcome');
      })) { socket.close(); }
    }).catch(expire);
    return invitation.code;
  }

  cancelOffer(): void {
    this.hostGeneration++;
    this.pending?.connection.close();
    this.pending = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  cancelGuest(): void {
    this.guestGeneration++;
    this.guest = null;
    const cancel = this.cancelGuestAttempt;
    this.cancelGuestAttempt = null;
    cancel?.();
  }

  togglePause(): boolean {
    if (!this.room || this.room.info().phase !== 'playing') throw new Error('Start the match in the lobby before pausing the burn.');
    this.room.setPaused(!this.paused);
    return this.paused;
  }

  stopHost(): void {
    this.cancelOffer();
    const room = this.room;
    this.room = null;
    this.certificate = null;
    for (const peer of this.peers) peer.close();
    this.peers.clear();
    if (room) void room.shutdown('The browser host ended this burn.');
  }
}
