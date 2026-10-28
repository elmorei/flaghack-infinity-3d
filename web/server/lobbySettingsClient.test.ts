/** Real browser-client scheduling against the actual host's lobby throttle. */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { NetClient } from '../src/net/client';
import type { ClientMessage } from '../src/net/protocol';
import type { MatchOptions } from '../src/sim/types';
import { normalizeMatch } from '../src/sim/matchSettings';
import { cleanup, connect, hello, host, join, PASSWORD, until } from './testkit';

const clients: NetClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) client.leave(); await cleanup(); });

describe('browser settings queue with a real throttled host', () => {
  it.each([false, true])('starts with every rapid edit acknowledged (edit while in flight: %s)', async inFlight => {
    const h = await host();
    const sent: ClientMessage[] = [];
    let started: MatchOptions | null = null;
    let onFirstSettings: (() => void) | undefined;
    const client = new NetClient({
      url: `ws://127.0.0.1:${h.port}/ws`, name: 'leader', password: PASSWORD, serverName: 'Test burn',
      tokens: { load: () => null, save: () => {} },
      hooks: { lobby: () => {}, state: () => {}, closed: () => {}, matchStart: options => { started = options; } },
      connect: url => {
        const ws = new WebSocket(url);
        const send = ws.send.bind(ws);
        ws.send = ((data: string) => {
          const message = JSON.parse(data) as ClientMessage;
          sent.push(message); send(data);
          // A second user edit immediately after transmission, before its host echo.
          if (message.t === 'settings' && onFirstSettings) {
            const edit = onFirstSettings; onFirstSettings = undefined; edit();
          }
        }) as typeof ws.send;
        return ws as unknown as globalThis.WebSocket;
      },
    });
    clients.push(client);
    await until(() => client.isLeader && client.connected, 'leader welcome');
    const guest = await join(h, 'guest'); guest.c.mirrored = true;
    // This consumes the same host throttle bucket as settings.
    client.setReady(true);
    client.setSettings({ seed: '  rapid\n rules  ', match: normalizeMatch({ maxSignifiers: 0, buildingCapture: false }) });
    const rest = () => {
      client.setSettings({ match: { ...client.setupSettings!.match!, crystalFlagProtection: false } });
      client.setSettings({ match: { ...client.setupSettings!.match!, crystalAttacks: false } });
      client.start();
      expect(sent.filter(m => m.t === 'start')).toHaveLength(0);
    };
    if (inFlight) onFirstSettings = rest; else rest();
    await until(() => started !== null, 'acknowledged final setup starts the match', 15000);
    const expected = normalizeMatch({ maxSignifiers: 0, buildingCapture: false, crystalFlagProtection: false, crystalAttacks: false });
    expect(started!.match).toEqual(expected);
    expect(started!.seed).toBe('rapid rules');
    expect(client.settingsError).toBeNull();
    expect(client.settingsPending).toBe(false);
    expect(client.startPending).toBe(false);
    expect(sent.filter(m => m.t === 'settings')).toHaveLength(inFlight ? 2 : 1);
    expect(sent.filter(m => m.t === 'start')).toHaveLength(1);
    const guestStart = await guest.c.next('matchStart', undefined, 15000);
    expect(guestStart.options.match).toEqual(expected);
    expect(guest.c.mirror!.world.options.match).toEqual(expected);
    const late = await connect(h); late.mirrored = true; hello(late, 'late');
    expect((await late.next('matchStart', undefined, 15000)).options.match).toEqual(expected);
    expect(late.mirror!.world.options.match).toEqual(expected);
  });
});
