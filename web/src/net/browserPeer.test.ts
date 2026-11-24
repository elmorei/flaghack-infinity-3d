import { describe, expect, it } from 'vitest';
import { PeerWire } from './browserPeer';

class Channel extends EventTarget {
  binaryType = '';
  bufferedAmount = 0;
  readyState = 'open';
  sent: ArrayBuffer[] = [];
  failAfter = Infinity;

  send(data: ArrayBuffer): void {
    if (this.sent.length >= this.failAfter) throw new Error('test send failure');
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  deliver(data: ArrayBuffer | string): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

const wrap = (channel: Channel) => new PeerWire(channel as unknown as RTCDataChannel);

describe('manual WebRTC peer wire', () => {
  it('reassembles large UTF-8 messages and preserves subsequent message boundaries', () => {
    const tx = new Channel();
    const rx = new Channel();
    const input = wrap(tx);
    const output = wrap(rx);
    const seen: string[] = [];
    output.onmessage = (text) => seen.push(text);
    const snapshot = JSON.stringify({ pad: 'a'.repeat(16382) + '🌒'.repeat(24000) });
    input.send(snapshot);
    input.send('state');
    input.send('');
    expect(tx.sent.length).toBeGreaterThan(8);
    expect(tx.sent.every((frame) => frame.byteLength <= 16384)).toBe(true);
    for (const frame of tx.sent) rx.deliver(frame);
    expect(seen).toEqual([snapshot, 'state', '']);
  });

  it('rejects oversized UTF-8 and congested output before sending any fragments', () => {
    const tx = new Channel();
    const wire = wrap(tx);
    expect(() => wire.send('🌒'.repeat(1_100_000))).toThrow(/too large/);
    tx.bufferedAmount = 8 * 1024 * 1024;
    expect(() => wire.send('state')).toThrow(/queued data/);
    expect(tx.sent).toEqual([]);
  });

  it('closes exactly once when a partial send would corrupt the next message', () => {
    const tx = new Channel();
    tx.failAfter = 1;
    const wire = wrap(tx);
    let closes = 0;
    wire.onclose = () => closes++;
    expect(() => wire.send('a'.repeat(20000))).toThrow(/test send failure/);
    expect(() => wire.send('state')).toThrow(/not open/);
    wire.close();
    expect(closes).toBe(1);
  });

  it('rejects malformed chunks and bounds a stream of unfinished valid chunks', () => {
    const rx = new Channel();
    const wire = wrap(rx);
    let closes = 0;
    wire.onclose = () => closes++;
    const continuation = new Uint8Array(16384).buffer;
    for (let i = 0; i < 257; i++) rx.deliver(continuation);
    expect(closes).toBe(1);
    const bad = new Channel();
    const second = wrap(bad);
    let messages = 0;
    second.onmessage = () => messages++;
    bad.deliver(Uint8Array.of(1, 0xff).buffer);
    expect(bad.readyState).toBe('closed');
    expect(messages).toBe(0);
  });
});
