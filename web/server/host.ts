/**
 * The FLAGHACK ∞ multiplayer host: one HTTP port serving the built client (web/dist), INFO_PATH
 * (HostInfo JSON) and the WebSocket at WS_PATH (see net/protocol.ts). `npm run host` runs it via
 * server/main.ts; tests start it in-process on an ephemeral port.
 */
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { ServerOptions } from 'ws';
import { BUILD_ID } from '../src/net/build';
import { DEFAULT_PORT, INFO_PATH, MAX_CLIENT_MESSAGE_BYTES, PROTOCOL_VERSION, WS_PATH } from '../src/net/protocol';
import { originOf } from './auth';
import { browserOriginPolicy } from './browserOrigin';
import { Room } from './room';
import { createStaticHandler, send } from './static';
import { cleanText } from './text';

export interface HostOptions {
  /** What players type to join (both sides are trimmed before comparing). */
  password: string;
  /** Default DEFAULT_PORT; 0 picks a free port. */
  port?: number;
  /** Listen address; default every interface (IPv4 and IPv6). */
  bind?: string;
  /** Shown in the lobby; default "<hostname>'s burn". */
  serverName?: string;
  /** The built client; default web/dist. null serves no files (INFO_PATH and WS_PATH only). */
  staticDir?: string | null;
  /** Additional trusted browser origins (e.g. https://elmorei.github.io). Exact origins, no paths or wildcards. */
  allowedOrigins?: readonly string[];
  /** One line per event; default timestamped stdout. */
  log?: (line: string) => void;
}

export interface RunningHost {
  /** The bound port (the real one when 0 was asked for). */
  readonly port: number;
  readonly serverName: string;
  readonly instanceId: string;
  /** Notify every client, close every socket, stop the burn and stop listening. */
  close(): Promise<void>;
}

const MAX_SERVER_NAME = 48;
/** A socket the host closed gets this long to answer the close frame before it is cut (ws: 30 s). */
const CLOSE_TIMEOUT_MS = 2000;
/** web/dist next to both web/server/ (sources, tests) and web/dist-server/ (the bundle). */
const DEFAULT_STATIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

export async function startHost(opts: HostOptions): Promise<RunningHost> {
  const originAllowed = browserOriginPolicy(opts.allowedOrigins);
  const log = opts.log ?? ((line: string) => console.log(`${new Date().toTimeString().slice(0, 8)} ${line}`));
  const serverName = cleanText(opts.serverName ?? `${hostname()}'s burn`, MAX_SERVER_NAME) || 'A FLAGHACK burn';
  const room = new Room({ serverName, password: opts.password, log });
  const files = opts.staticDir === null ? null : createStaticHandler(opts.staticDir ?? DEFAULT_STATIC_DIR);
  // closeTimeout (ws >= 8.19) is missing from @types/ws 8.18, hence the checked const rather than a literal argument.
  const wsOptions = {
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    closeTimeout: CLOSE_TIMEOUT_MS,
    perMessageDeflate: {
      // State frames are repetitive JSON: a cheap level plus the sliding window (context
      // takeover) compresses them well without costing the tick loop much.
      zlibDeflateOptions: { level: 3 },
      // Pongs, inputs and chat lines are not worth a deflate round trip.
      threshold: 512,
      concurrencyLimit: 16,
    },
  } satisfies ServerOptions & { closeTimeout: number };
  const wss = new WebSocketServer(wsOptions);
  // A relay may route /api/info and /ws differently. Native readiness probes verify both
  // transports reach this running room without joining or exposing the match password.
  wss.on('headers', (headers) => {
    headers.push(
      `X-Flaghack-Instance: ${room.instanceId}`,
      `X-Flaghack-Build: ${BUILD_ID}`,
      `X-Flaghack-Protocol: ${PROTOCOL_VERSION}`,
    );
  });

  const server = createServer((req, res) => {
    const path = pathOf(req.url);
    if (path === INFO_PATH || path?.startsWith('/api/')) {
      res.setHeader('Vary', 'Origin');
      if (!originAllowed(req)) {
        send(res, 403, 'text/plain; charset=utf-8', 'Browser origin is not allowed.\n');
        return;
      }
      if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    }
    if (path === INFO_PATH && req.method === 'OPTIONS') {
      const requestedMethod = req.headers['access-control-request-method'];
      if (requestedMethod !== undefined && requestedMethod !== 'GET' && requestedMethod !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS', 'Cache-Control': 'no-store' }).end();
        return;
      }
      // Discovery is read-only and needs no custom headers or cross-origin credentials.
      if (req.headers['access-control-request-headers']?.toString().trim()) {
        send(res, 403, 'text/plain; charset=utf-8', 'Request headers are not allowed.\n');
        return;
      }
      res.writeHead(204, {
        Allow: 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Methods': 'GET, HEAD',
        'Cache-Control': 'no-store',
      }).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    if (path === INFO_PATH) {
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(room.info()));
      return;
    }
    if (!files || path === null) {
      send(res, 404, 'text/plain; charset=utf-8', 'Not found\n');
      return;
    }
    files(req, res, path).catch((err: unknown) => {
      log(`static file error for ${path}: ${err instanceof Error ? err.message : String(err)}`);
      if (res.headersSent) res.destroy();
      else send(res, 500, 'text/plain; charset=utf-8', 'Internal error\n');
    });
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Until ws owns the socket its errors are ours; unhandled they would end the process.
    socket.on('error', () => socket.destroy());
    if (pathOf(req.url) !== WS_PATH) return refuse(socket, '404 Not Found');
    if (!originAllowed(req)) return refuse(socket, '403 Forbidden');
    const origin = originOf(req.socket.remoteAddress, req.headers['cf-connecting-ip']);
    const refusal = room.upgradeRefusal(origin);
    if (refusal === 'address') return refuse(socket, '429 Too Many Requests');
    if (refusal === 'host') return refuse(socket, '503 Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => room.connect(ws, origin));
  });

  server.listen({ port: opts.port ?? DEFAULT_PORT, host: opts.bind });
  try {
    // Rejects on 'error' (EADDRINUSE, EACCES), so a failed start leaves nothing running.
    await once(server, 'listening');
  } catch (err) {
    await room.shutdown('');
    throw err;
  }
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (opts.port ?? DEFAULT_PORT);
  return {
    port,
    serverName,
    instanceId: room.instanceId,
    async close() {
      await room.shutdown('The host is shutting down. The burn is over.');
      wss.close();
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

/** The path of a request target (still percent-encoded, dot segments resolved), or null if unparsable. */
function pathOf(url: string | undefined): string | null {
  try {
    return new URL(url ?? '/', 'http://host.invalid').pathname;
  } catch {
    return null;
  }
}

function refuse(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
