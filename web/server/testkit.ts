/**
 * Test helpers for the host: an in-process host on an ephemeral port, `ws` clients speaking the
 * protocol, and raw TCP sockets for peers that misbehave below the protocol (silent upgrades,
 * ignored close frames). Each test file calls `afterEach(cleanup)`.
 */
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { connect as connectTcp } from 'node:net';
import type { Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { NetMirror } from '../src/net/mirror';
import { BUILD_ID } from '../src/net/build';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import type { ServerMessage, StateFrame } from '../src/net/protocol';
import { startHost } from './host';
import type { HostOptions, RunningHost } from './host';

export const PASSWORD = 'saffron-pentacle-42';

export type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>;

function isMsg<T extends ServerMessage['t']>(m: ServerMessage, t: T): m is Msg<T> {
  return m.t === t;
}

export async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(10);
  }
}

export interface ClientOptions {
  path?: string;
  /** Extra upgrade request headers (e.g. what a tunnel would forward). */
  headers?: Record<string, string>;
}

export class Client {
  readonly ws: WebSocket;
  /** Every state frame, in order (also pushed into `mirror` when there is one). */
  readonly frames: StateFrame[] = [];
  /** Build a NetMirror from each matchStart (as the browser client does). */
  mirrored = false;
  mirror: NetMirror | null = null;
  inputEpoch = 0;
  closeCode: number | null = null;
  /** Other messages not yet taken by next()/take(), in arrival order. */
  private readonly inbox: ServerMessage[] = [];

  constructor(port: number, opts: ClientOptions = {}) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}${opts.path ?? '/ws'}`, { headers: opts.headers });
    this.ws.on('message', (data) => {
      const msg: ServerMessage = JSON.parse(data.toString());
      if (msg.t === 'state') {
        this.frames.push(msg.frame);
        this.mirror?.push(msg.frame);
        return;
      }
      if (msg.t === 'matchStart') {
        this.inputEpoch = msg.inputEpoch;
        if (this.mirrored) this.mirror = NetMirror.create(msg.options, msg.snapshot);
      }
      this.inbox.push(msg);
    });
    this.ws.on('close', (code) => {
      this.closeCode = code;
    });
    // Refused upgrades surface as errors; the tests read closeCode instead.
    this.ws.on('error', () => {});
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** The first unread `t` message passing `pred`; other messages stay unread. */
  async next<T extends ServerMessage['t']>(t: T, pred: (m: Msg<T>) => boolean = () => true, ms = 5000): Promise<Msg<T>> {
    const deadline = Date.now() + ms;
    for (;;) {
      for (let i = 0; i < this.inbox.length; i++) {
        const m = this.inbox[i];
        if (!isMsg(m, t) || !pred(m)) continue;
        this.inbox.splice(i, 1);
        return m;
      }
      if (Date.now() > deadline) throw new Error(`no '${t}' within ${ms} ms (unread: ${this.inbox.map((m) => m.t).join(' ') || 'nothing'})`);
      await sleep(10);
    }
  }

  /** Every unread `t` message, taken. */
  take<T extends ServerMessage['t']>(t: T): Msg<T>[] {
    const out: Msg<T>[] = [];
    for (let i = this.inbox.length - 1; i >= 0; i--) {
      const m = this.inbox[i];
      if (!isMsg(m, t)) continue;
      this.inbox.splice(i, 1);
      out.unshift(m);
    }
    return out;
  }

  async closed(): Promise<number> {
    await until(() => this.closeCode !== null, 'the socket to close');
    return this.closeCode ?? 0;
  }
}

const hosts: RunningHost[] = [];
const clients: Client[] = [];
const raws: Socket[] = [];

/** Close every client, raw socket and host the test opened. */
export async function cleanup(): Promise<void> {
  for (const c of clients.splice(0)) c.ws.terminate();
  for (const s of raws.splice(0)) s.destroy();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
}

export async function host(options: Partial<HostOptions> = {}): Promise<RunningHost> {
  const h = await startHost({
    password: PASSWORD,
    port: 0,
    bind: '127.0.0.1',
    serverName: 'Test burn',
    staticDir: null,
    log: () => {},
    ...options,
  });
  hosts.push(h);
  return h;
}

/** A client socket; on WS_PATH it waits until the socket is open. */
export async function connect(h: RunningHost, opts: ClientOptions = {}): Promise<Client> {
  const c = new Client(h.port, opts);
  clients.push(c);
  if ((opts.path ?? '/ws') === '/ws') await until(() => c.ws.readyState === WebSocket.OPEN, 'the socket to open');
  return c;
}

export function hello(c: Client, name: string, token: string | null = null, password = PASSWORD, protocol = PROTOCOL_VERSION, build = BUILD_ID): void {
  c.send({ t: 'hello', protocol, build, name, password, token });
}

export async function join(h: RunningHost, name: string, token: string | null = null): Promise<{ c: Client; me: Msg<'welcome'> }> {
  const c = await connect(h);
  hello(c, name, token);
  return { c, me: await c.next('welcome') };
}

export interface RawSocket {
  socket: Socket;
  /** Status of the host's answer to the upgrade (101: the WebSocket is open). */
  status: number;
  /** Settles when the host drops the connection. */
  closed: Promise<void>;
}

/**
 * A WebSocket upgrade over plain TCP from `localAddress` (any 127.x.y.z on Linux) that then does
 * nothing at all unless the test writes to it: never a hello, never an answer to a close frame.
 */
export async function rawUpgrade(port: number, localAddress: string): Promise<RawSocket> {
  const socket = connectTcp({ host: '127.0.0.1', port, localAddress });
  raws.push(socket);
  // A reset counts as closed too: `once` rejects on 'error'.
  const closed = once(socket, 'close').then(
    () => {},
    () => {},
  );
  await once(socket, 'connect');
  socket.write(
    [
      'GET /ws HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  );
  const [head]: Buffer[] = await once(socket, 'data');
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head.toString('latin1'))?.[1] ?? 0);
  return { socket, status, closed };
}

/** One masked client text frame, as the WebSocket protocol requires of clients (payload under 126 bytes). */
export function textFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const frame = Buffer.alloc(6 + payload.length);
  frame[0] = 0x81; // FIN + text
  frame[1] = 0x80 | payload.length; // masked, short length
  randomBytes(4).copy(frame, 2);
  for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ frame[2 + (i & 3)];
  return frame;
}
