import { afterEach, expect, it } from 'vitest';
import { Room } from '../../server/room';
import { browserRoomSocket, localWires } from './browserBurn';
import { BUILD_ID } from './build';
import { PROTOCOL_VERSION } from './protocol';
import type { ServerMessage } from './protocol';

let current: Room | null = null;
afterEach(async () => { await current?.shutdown('test complete'); current = null; });

const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function endpoint(room: Room, name: string, token: string | null = null) {
  const [host, guest] = localWires();
  const messages: ServerMessage[] = [];
  guest.onmessage = (text) => messages.push(JSON.parse(text));
  room.connect(browserRoomSocket(host), { address: name, peer: name });
  const send = (message: object) => guest.send(JSON.stringify(message));
  send({ t: 'hello', protocol: PROTOCOL_VERSION, build: BUILD_ID, name, password: '', token });
  return { guest, send, messages };
}

it('starts, pauses, and reclaims an authoritative browser room seat through the portable transport', async () => {
  const room = current = new Room({ serverName: 'Browser test', admit: (password) => password === '', addressKey: (key) => key, log: () => {} });
  const host = endpoint(room, 'host');
  const guest = endpoint(room, 'guest');
  await flush();
  const welcome = guest.messages.find((m) => m.t === 'welcome');
  expect(welcome).toBeDefined();
  guest.send({ t: 'ready', ready: true });
  await flush();
  host.send({ t: 'start' });
  await flush();
  const start = guest.messages.find((m) => m.t === 'matchStart');
  expect(start?.seat).not.toBeNull();
  expect(start?.snapshot.tick).toBe(0);
  room.setPaused(true);
  expect(room.isPaused).toBe(true);
  guest.guest.close();
  await flush();
  const reconnect = endpoint(room, 'guest', welcome!.token);
  await flush();
  const rejoin = reconnect.messages.find((m) => m.t === 'matchStart');
  expect(reconnect.messages.find((m) => m.t === 'welcome')?.playerId).toBe(welcome!.playerId);
  expect(rejoin?.seat).toBe(start!.seat);
  expect(rejoin?.snapshot.tick).toBeGreaterThanOrEqual(start!.snapshot.tick);
  room.setPaused(false);
  expect(room.isPaused).toBe(false);
}, 20_000);
