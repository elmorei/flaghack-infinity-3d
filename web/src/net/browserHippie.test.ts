import { afterEach, expect, it, vi } from 'vitest';
import { Room } from '../../server/room';
import type { Match } from '../../server/match';
import { MAP_HALF } from '../sim/constants';
import { spawnFlag } from '../sim/factory';
import { hippiePlayerGoal } from '../sim/hippiePlayer';
import { recruitWithFlag } from '../sim/systems/recruitment';
import { eliminateByBoss } from '../sim/systems/victory';
import { NEUTRAL } from '../sim/types';
import type { FactionId } from '../sim/types';
import { NetClient } from './client';
import { browserClientSocket, browserRoomSocket, localWires } from './browserBurn';
import { parseClientMessage } from './validate';

let room: Room;
let clients: NetClient[] = [];
const spin = async (): Promise<void> => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

function burn(): Room {
  return room = new Room({ serverName: 'Browser test', admit: () => true, addressKey: key => key, log: () => {} });
}
function join(name: string, token: string | null = null) {
  const [host, guest] = localWires();
  room.connect(browserRoomSocket(host), { address: name, peer: name });
  const socket = browserClientSocket(guest);
  let saved = token;
  const starts: Array<{ seat: FactionId | null; tick: number }> = [];
  const client = new NetClient({
    url: '', name, password: '', serverName: 'Test', connect: () => socket, manualReconnect: true,
    tokens: { load: () => saved, save: t => { saved = t; } },
    hooks: { lobby: () => {}, matchStart: (_opts, seat, snapshot) => starts.push({ seat, tick: snapshot.tick }),
      state: () => {}, closed: () => {} },
  });
  clients.push(client);
  return { client, token: () => saved, starts, send: (payload: object) => socket.send(JSON.stringify(payload)) };
}
function world() { return (room as unknown as { match: Match }).match.world; }
function eliminate(f: FactionId): void {
  const w = world();
  for (const id of w.factions[f].hearthIds) w.buildings.delete(id);
  w.factions[f].hearthIds = [];
  eliminateByBoss(w, f);
}

afterEach(async () => {
  for (const client of clients) client.leave();
  clients = [];
  await room?.shutdown('test complete');
});

it('privately offers multiple overflow players distinct neutral hippies, with one flag and no faction seat', async () => {
  burn();
  const players = [join('one'), join('two'), join('three'), join('four')];
  const fifth = join('five'), sixth = join('six');
  await spin();
  expect(players.map(p => p.client.seat)).toEqual([0, 1, 2, 3]);
  expect(players.every(p => p.client.hippieRole === null)).toBe(true);
  expect(fifth.client.hippieRole?.available).toBe(true);
  expect(sixth.client.hippieRole?.available).toBe(true);
  fifth.client.claimHippie();
  await spin();
  expect(fifth.client.hippieRole?.queued).toBe(true);
  players[0].client.start();
  await spin();
  expect(fifth.client.seat).toBeNull();
  expect(fifth.client.hippieRole?.id).not.toBeNull();
  sixth.client.claimHippie();
  await spin();
  const w = world();
  const first = w.hippies.get(fifth.client.hippieRole!.id!)!;
  const second = w.hippies.get(sixth.client.hippieRole!.id!)!;
  expect(first.id).not.toBe(second.id);
  expect(first.faction).toBe(NEUTRAL);
  expect(second.faction).toBe(NEUTRAL);
  expect(players.every(p => p.client.hippieRole === null)).toBe(true);

  const target = w.nav.nearestWalkable(first.pos.x + 4, first.pos.z);
  const start = { ...first.pos };
  fifth.send({ t: 'hippieMove', inputEpoch: 999, x: target.x, z: target.z });
  await spin();
  expect(hippiePlayerGoal(w, first.id)).toBeNull();
  fifth.client.hippieTarget(target.x, target.z, false);
  await spin();
  expect(hippiePlayerGoal(w, first.id)).toEqual(target);
  await vi.waitFor(() => expect(Math.hypot(first.pos.x - start.x, first.pos.z - start.z)).toBeGreaterThan(0.01));
  expect(hippiePlayerGoal(w, second.id)).toBeNull();
  expect(fifth.client.seat).toBeNull();

  const at = { x: first.pos.x, y: w.collision.groundHeight(first.pos.x, first.pos.z), z: first.pos.z };
  const own = spawnFlag(w, { state: 'loose', owner: NEUTRAL, pos: at });
  fifth.client.hippiePickup();
  await spin();
  expect(first.carryingFlag).toBe(own.id);
  const extra = spawnFlag(w, { state: 'loose', owner: NEUTRAL, pos: at });
  fifth.client.hippiePickup();
  await spin();
  expect(first.carryingFlag).toBe(own.id);
  expect(extra.state).toBe('loose');

  const gift = spawnFlag(w, { state: 'carried', owner: 1, holder: w.avatarOf(1).id, pos: at });
  w.avatarOf(1).carried.push(gift.id);
  expect(recruitWithFlag(w, first, 1, gift.id, 'hand')).toBe(true);
  expect(first.faction).toBe(1);
  expect(own.state).toBe('loose');
  expect(first.carryingFlag).toBe(gift.id);
  expect(fifth.client.hippieRole?.id).toBe(first.id);
  expect(fifth.client.seat).toBeNull();
  const aim = first.pos.x < 0 ? first.pos.x + 8 : first.pos.x - 8;
  fifth.client.hippieTarget(aim, first.pos.z, true);
  await spin();
  expect(first.carryingFlag).toBe(-1);
  expect(gift.state).toBe('flying');
  expect(w.projectiles.get(gift.holder)?.faction).toBe(NEUTRAL);
  await vi.waitFor(() => expect(gift.state).toBe('loose'), { timeout: 4_000 });
  expect(gift.node).toBe(-1);

  const rejoinToken = fifth.token();
  fifth.client.leave();
  await spin();
  expect(hippiePlayerGoal(w, first.id)).toBeUndefined();
  const back = join('five', rejoinToken);
  await vi.waitFor(() => expect(back.client.hippieRole?.id).toBe(first.id));
  expect(back.client.seat).toBeNull();
  expect(back.starts.at(-1)?.seat).toBeNull();
  expect(hippiePlayerGoal(w, first.id)).toBeNull();

  const altar = w.hearthOf(2)!;
  second.pos.x = altar.pos.x > 0 ? -100 : 100;
  second.pos.z = altar.pos.z > 0 ? -100 : 100;
  sixth.client.hippieAltar();
  await spin();
  expect(second.faction).toBe(NEUTRAL);
  expect(sixth.client.hippieRole?.error).toMatch(/stocked altar/);
  second.pos.x = altar.pos.x;
  second.pos.z = altar.pos.z;
  const stock = [...w.flags.values()].find(flag => flag.state === 'stock' && flag.holder === altar.id)!;
  expect(stock).toBeDefined();
  sixth.client.hippieAltar();
  await spin();
  expect(second.faction).toBe(2);
  expect(second.carryingFlag).toBe(stock.id);
  expect(stock.holder).toBe(second.id);
  expect(sixth.client.hippieRole?.error).toBeNull();
  expect(sixth.client.seat).toBeNull();
}, 15_000);

it('offers the role to an eliminated player only after the last available AI camp is gone', async () => {
  burn();
  const a = join('one'), b = join('two'), c = join('three');
  await spin();
  a.client.start();
  await spin();
  expect(a.client.seat).toBe(0);
  eliminate(0);
  await new Promise(resolve => setTimeout(resolve, 75));
  expect(a.client.hippieRole).toBeNull();
  a.send({ t: 'claimHippie' });
  await spin();
  expect(a.client.seat).toBe(0);
  eliminate(3);
  await vi.waitFor(() => expect(a.client.hippieRole?.available).toBe(true));
  a.client.claimHippie();
  await vi.waitFor(() => expect(a.client.hippieRole?.id).not.toBeNull());
  expect(a.client.seat).toBeNull();
  expect(a.starts.at(-1)?.seat).toBeNull();
  expect(world().hippies.get(a.client.hippieRole!.id!)?.faction).toBe(NEUTRAL);
  expect(b.client.hippieRole).toBeNull();
  expect(c.client.hippieRole).toBeNull();
}, 15_000);

it('validates hippie inputs and does not accept unit or faction overrides', () => {
  expect(parseClientMessage(JSON.stringify({ t: 'hippieMove', inputEpoch: 1, x: 1, z: 0 }))).toMatchObject({ t: 'hippieMove' });
  expect(parseClientMessage(JSON.stringify({ t: 'hippieThrow', inputEpoch: 1, x: MAP_HALF + 1, z: 0 }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ t: 'hippiePickup', inputEpoch: 0 }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ t: 'hippiePickup', inputEpoch: 1, id: 2 }))).toBeNull();
  expect(parseClientMessage(JSON.stringify({ t: 'claimHippie', faction: 2 }))).toBeNull();
});
