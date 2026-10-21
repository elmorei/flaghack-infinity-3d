import { once } from 'node:events';
import { request } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILD_ID } from '../src/net/build';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import { cleanup, connect, hello, host, PASSWORD } from './testkit';

const PAGES = 'https://elmorei.github.io';
afterEach(cleanup);

async function http(port: number, headers: Record<string, string> = {}, method = 'GET', path = '/api/info') {
  const req = request({ host: '127.0.0.1', port, path, method, headers });
  req.end();
  const [res]: IncomingMessage[] = await once(req, 'response');
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(Buffer.from(chunk));
  return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() };
}

/** Read a refused WebSocket handshake without the successful-connect test helper's wait. */
async function upgrade(port: number, headers: Record<string, string>, path = '/ws'): Promise<number> {
  return (await upgradeResponse(port, headers, path)).status;
}

function upgradeResponse(port: number, headers: Record<string, string>, path = '/ws'): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, handshakeTimeout: 2000 });
    let responseHeaders: IncomingHttpHeaders = {};
    ws.once('upgrade', (res) => { responseHeaders = res.headers; });
    ws.on('error', reject);
    ws.once('open', () => {
      resolve({ status: 101, headers: responseHeaders });
      ws.terminate();
    });
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
      res.resume();
      ws.terminate();
    });
  });
}

describe('browser origin admission', () => {
  it('identifies the actual WebSocket room before hello, matching discovery and not reflected request headers', async () => {
    const h = await host({ allowedOrigins: [PAGES] });
    const info = JSON.parse((await http(h.port, { Origin: PAGES })).body);
    const response = await upgradeResponse(h.port, {
      Origin: PAGES, 'X-Flaghack-Instance': 'forged-room', 'X-Flaghack-Build': 'forged-build', 'X-Flaghack-Protocol': '0',
    });
    expect(response.status).toBe(101);
    expect(response.headers['x-flaghack-instance']).toBe(info.instanceId);
    expect(response.headers['x-flaghack-instance']).toBe(h.instanceId);
    expect(response.headers['x-flaghack-build']).toBe(info.build);
    expect(response.headers['x-flaghack-build']).toBe(BUILD_ID);
    expect(response.headers['x-flaghack-protocol']).toBe(String(info.protocol));
    expect(response.headers['x-flaghack-protocol']).toBe(String(PROTOCOL_VERSION));
    const denied = await upgradeResponse(h.port, { Origin: 'https://untrusted.example' });
    expect(denied.status).toBe(403);
    expect(denied.headers['x-flaghack-instance']).toBeUndefined();
    expect(denied.headers['x-flaghack-build']).toBeUndefined();
    expect(denied.headers['x-flaghack-protocol']).toBeUndefined();
  });

  it('allows the configured Pages origin for discovery and an authenticated WebSocket', async () => {
    const h = await host({ allowedOrigins: [PAGES] });
    const info = await http(h.port, { Origin: PAGES });
    expect(info.status).toBe(200);
    expect(info.headers['access-control-allow-origin']).toBe(PAGES);
    expect(info.headers['access-control-allow-credentials']).toBeUndefined();
    expect(info.headers.vary).toBe('Origin');
    expect(info.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(info.body)).toMatchObject({ protocol: PROTOCOL_VERSION, build: BUILD_ID, instanceId: h.instanceId });
    const c = await connect(h, { headers: { Origin: PAGES } });
    hello(c, 'Pages player');
    expect(await c.next('welcome')).toMatchObject({ protocol: PROTOCOL_VERSION, build: BUILD_ID });
  });

  it('retains same-authority direct and Host-preserving proxy clients without trusting forwarded headers', async () => {
    const h = await host();
    const own = `http://127.0.0.1:${h.port}`;
    expect((await http(h.port, { Origin: own })).status).toBe(200);
    expect(await upgrade(h.port, { Origin: own })).toBe(101);
    const proxy = { Host: 'burn.example', Origin: 'https://burn.example' };
    expect((await http(h.port, proxy)).status).toBe(200);
    expect(await upgrade(h.port, proxy)).toBe(101);
    const forged = { Origin: PAGES, 'X-Forwarded-Host': 'elmorei.github.io', 'X-Forwarded-Proto': 'https', Forwarded: 'host=elmorei.github.io;proto=https' };
    expect((await http(h.port, forged)).status).toBe(403);
    expect(await upgrade(h.port, forged)).toBe(403);
  });

  it('keeps absent-Origin native clients and HEAD discovery working without granting CORS', async () => {
    const h = await host();
    const info = await http(h.port);
    expect(info.status).toBe(200);
    expect(info.headers['access-control-allow-origin']).toBeUndefined();
    expect(await upgrade(h.port, {})).toBe(101);
    const head = await http(h.port, {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it.each([
    'https://evil.example',
    'https://elmorei.github.io.evil.example',
    'https://evil.elmorei.github.io',
    'http://elmorei.github.io',
    'https://elmorei.github.io:8443',
    'https://elmorei.github.io/',
    'https://elmorei.github.io/FLAGHACK/',
    'https://elmorei.github.io?next=evil',
    'https://elmorei.github.io#fragment',
    'https://user@elmorei.github.io',
    'https://elmorei.github.io, https://evil.example',
    'null',
    '*',
    'file://local',
  ])('rejects untrusted or malformed Origin %s for both API and WebSocket', async (origin) => {
    const h = await host({ allowedOrigins: [PAGES] });
    const info = await http(h.port, { Origin: origin });
    expect(info.status).toBe(403);
    expect(info.headers['access-control-allow-origin']).toBeUndefined();
    expect(info.body).not.toContain('serverName');
    expect(await upgrade(h.port, { Origin: origin })).toBe(403);
  });

  it('does not allow a remote origin unless explicitly configured, and rejects misleading Host authorities', async () => {
    const h = await host();
    expect((await http(h.port, { Origin: PAGES })).status).toBe(403);
    for (const value of ['user@elmorei.github.io', 'elmorei.github.io/path', 'elmorei.github.io#fragment', 'elmorei.github.io?query']) {
      expect((await http(h.port, { Origin: PAGES, Host: value })).status).toBe(403);
    }
    expect((await http(h.port, { Origin: 'https://evil.example' }, 'GET', '/api/unknown')).status).toBe(403);
    expect(await upgrade(h.port, { Origin: PAGES }, '/not-the-socket')).toBe(404);
    expect((await http(h.port, {}, 'GET', '/')).status).toBe(404);
  });

  it.each(['*', 'https://*.github.io', 'null', 'https://elmorei.github.io/FLAGHACK/', 'ftp://elmorei.github.io'])('fails startup for unsafe allowlist value %s', async (origin) => {
    await expect(host({ allowedOrigins: [origin] })).rejects.toThrow(/origin/i);
  });

  it('does not let an allowed browser origin bypass the password gate', async () => {
    const h = await host({ allowedOrigins: [PAGES] });
    const bad = await connect(h, { headers: { Origin: PAGES } });
    hello(bad, 'guesser', null, 'not-the-password');
    expect((await bad.next('denied')).reason).toBe('password');
    const good = await connect(h, { headers: { Origin: PAGES } });
    hello(good, 'friend', null, PASSWORD);
    await good.next('welcome');
  });
});

describe('discovery preflight', () => {
  it.each(['GET', 'HEAD'])('allows %s only from an admitted origin', async (method) => {
    const h = await host({ allowedOrigins: [PAGES] });
    const headers = { Origin: PAGES, 'Access-Control-Request-Method': method };
    const ok = await http(h.port, headers, 'OPTIONS');
    expect(ok.status).toBe(204);
    expect(ok.body).toBe('');
    expect(ok.headers['access-control-allow-origin']).toBe(PAGES);
    expect(ok.headers['access-control-allow-methods']).toBe('GET, HEAD');
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    const denied = await http(h.port, { ...headers, Origin: 'https://evil.example' }, 'OPTIONS');
    expect(denied.status).toBe(403);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not grant mutation methods, custom headers, private-network access or blanket OPTIONS routes', async () => {
    const h = await host({ allowedOrigins: [PAGES] });
    expect((await http(h.port, { Origin: PAGES, 'Access-Control-Request-Method': 'POST' }, 'OPTIONS')).status).toBe(405);
    const custom = await http(h.port, { Origin: PAGES, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' }, 'OPTIONS');
    expect(custom.status).toBe(403);
    expect(custom.headers['access-control-allow-headers']).toBeUndefined();
    const privateNetwork = await http(h.port, { Origin: PAGES, 'Access-Control-Request-Private-Network': 'true' }, 'OPTIONS');
    expect(privateNetwork.headers['access-control-allow-private-network']).toBeUndefined();
    expect((await http(h.port, {}, 'OPTIONS', '/')).status).toBe(405);
    expect((await http(h.port, {}, 'POST')).status).toBe(405);
    expect((await http(h.port, {}, 'OPTIONS')).headers['access-control-allow-origin']).toBeUndefined();
  });
});
