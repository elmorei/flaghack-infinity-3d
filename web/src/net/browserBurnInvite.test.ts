import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserBurn, type InviteStatus } from './browserBurn';
import { NetClient } from './client';
import { acceptRtcAnswer, acceptRtcOffer, createRtcOffer } from './browserPeer';

vi.mock('./browserPeer', async (original) => ({
  ...await original<typeof import('./browserPeer')>(),
  createRtcOffer: vi.fn(),
  acceptRtcOffer: vi.fn(),
  acceptRtcAnswer: vi.fn(),
  offerFingerprint: () => 'test-identity',
}));

class Channel extends EventTarget {
  binaryType = '';
  bufferedAmount = 0;
  readyState = 'connecting';
  partner?: Channel;
  open(): void { this.readyState = 'open'; this.dispatchEvent(new Event('open')); }
  send(data: ArrayBuffer): void {
    queueMicrotask(() => this.partner?.dispatchEvent(new MessageEvent('message', { data })));
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
    this.partner?.close();
  }
}

class Peer extends EventTarget {
  connectionState = 'new';
  readonly local = new Channel();
  close(): void {
    if (this.connectionState === 'closed') return;
    this.connectionState = 'closed';
    this.local.close();
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

const rtc = (p: Peer) => p as unknown as RTCPeerConnection;
const channel = (p: Peer) => p.local as unknown as RTCDataChannel;
const peers: Peer[] = [];
const burns: BrowserBurn[] = [];
const clients: NetClient[] = [];
const spin = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function endpoint(): { burn: BrowserBurn; statuses: InviteStatus[]; client: () => NetClient } {
  const statuses: InviteStatus[] = [];
  let last!: NetClient;
  const burn = new BrowserBurn((name, socket, _scope, welcomed) => {
    last = new NetClient({
      name, url: '', password: '', serverName: 'Test', connect: () => socket, manualReconnect: true,
      tokens: { load: () => null, save: () => {} },
      hooks: { lobby: () => welcomed?.(), matchStart: () => {}, state: () => {}, closed: () => {} },
    });
    clients.push(last);
    return true;
  }, status => statuses.push(status));
  burns.push(burn);
  return { burn, statuses, client: () => last };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('RTCPeerConnection', { generateCertificate: async () => ({}) });
  vi.mocked(createRtcOffer).mockImplementation(async () => {
    const p = new Peer();
    peers.push(p);
    return { code: 'offer', connection: rtc(p), channel: channel(p) };
  });
  vi.mocked(acceptRtcAnswer).mockResolvedValue();
});
afterEach(async () => {
  burns.splice(0).forEach(b => { b.cancelGuest(); b.stopHost(); });
  clients.splice(0).forEach(c => c.leave());
  peers.length = 0;
  await spin();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('reports timeouts on both sides, then a fresh invitation reaches the actual lobby welcome', async () => {
  const h = endpoint(), g = endpoint();
  await h.burn.startHost('host');
  await spin();

  const expired = await h.burn.createOffer();
  vi.mocked(acceptRtcOffer).mockImplementationOnce(async () => ({
    code: 'answer', connection: rtc(new Peer()), channel: new Promise(() => {}),
  }));
  await g.burn.createAnswer(expired, 'guest');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.statuses).toEqual(['offer-expired']);
  expect(g.statuses).toEqual(['guest-failed']);

  await h.burn.createOffer();
  await h.burn.applyAnswer('answer');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(h.statuses.at(-1)).toBe('host-failed');
  expect(h.burn.connectedPeers).toBe(0);

  const fresh = await h.burn.createOffer();
  const hostPeer = peers.at(-1)!;
  const guestPeer = new Peer();
  hostPeer.local.partner = guestPeer.local;
  guestPeer.local.partner = hostPeer.local;
  vi.mocked(acceptRtcOffer).mockResolvedValueOnce({
    code: 'answer', connection: rtc(guestPeer), channel: Promise.resolve(channel(guestPeer)),
  });
  await g.burn.createAnswer(fresh, 'guest');
  await h.burn.applyAnswer('answer');
  hostPeer.local.open();
  expect(h.statuses.at(-1)).toBe('host-channel');
  guestPeer.local.open();
  await spin();
  expect(g.client().connected).toBe(true);
  expect(g.client().lobby?.players.map(p => p.name)).toEqual(['host', 'guest']);
  expect(h.statuses.slice(-2)).toEqual(['host-channel', 'host-welcome']);
  expect(g.statuses.slice(-2)).toEqual(['guest-channel', 'guest-welcome']);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(h.statuses.at(-1)).toBe('host-welcome');
  expect(g.statuses.at(-1)).toBe('guest-welcome');
});

it('allows a newer host offer and guest answer to outlive old-attempt failures', async () => {
  const h = endpoint(), g = endpoint();
  await h.burn.startHost('host');
  await spin();
  const oldOffer = await h.burn.createOffer();
  let rejectOld!: () => void;
  vi.mocked(acceptRtcOffer).mockImplementationOnce(async () => ({
    code: 'old', connection: rtc(new Peer()), channel: new Promise((_, reject) => {
      rejectOld = () => reject(new Error('old attempt'));
    }),
  }));
  await g.burn.createAnswer(oldOffer, 'guest');
  await h.burn.applyAnswer('old');
  const oldHostPeer = peers.at(-1)!;
  const fresh = await h.burn.createOffer();
  vi.mocked(acceptRtcOffer).mockImplementationOnce(async () => ({
    code: 'new', connection: rtc(new Peer()), channel: new Promise(() => {}),
  }));
  await expect(g.burn.createAnswer(fresh, 'guest')).resolves.toBe('new');
  oldHostPeer.close();
  rejectOld();
  await spin();
  expect(h.statuses).toEqual([]);
  expect(g.statuses).toEqual([]);
  expect(h.burn.connectedPeers).toBe(0);
});
