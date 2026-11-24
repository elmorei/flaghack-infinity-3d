/** Manual, ICE-complete WebRTC signaling for a no-service LAN preview. */
const CODE_PREFIX = 'fh-rtc1.';
const MAX_CODE = 64 * 1024;
const ICE_TIMEOUT_MS = 8_000;
const CHUNK_BYTES = 16_384; // Includes the one-byte chunk tag.
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const messageLimits = new WeakMap<RTCDataChannel, () => number | undefined>();

function toCode(sdp: string): string {
  const bytes = encoder.encode(sdp);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 4096) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 4096)));
  }
  const code = CODE_PREFIX + btoa(chunks.join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (code.length > MAX_CODE) throw new Error('Connection code is too large.');
  return code;
}

function fromCode(code: string, type: 'offer' | 'answer'): RTCSessionDescriptionInit {
  if (code.length > MAX_CODE) throw new Error('Connection code is too large.');
  const trimmed = code.trim();
  const body = trimmed.slice(CODE_PREFIX.length);
  if (!trimmed.startsWith(CODE_PREFIX) || !/^[\w-]+$/.test(body)) throw new Error('Invalid connection code.');
  try {
    const binary = atob(body.replace(/-/g, '+').replace(/_/g, '/'));
    const sdp = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
    if (!sdp.startsWith('v=0') || !/^m=application /m.test(sdp)) throw new Error('Invalid SDP.');
    return { type, sdp };
  } catch {
    throw new Error('Invalid connection code.');
  }
}

function finishIce(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const complete = () => {
      if (connection.iceGatheringState === 'complete') {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      connection.removeEventListener('icegatheringstatechange', complete);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out gathering local connection addresses.'));
    }, ICE_TIMEOUT_MS);
    connection.addEventListener('icegatheringstatechange', complete);
    complete();
  });
}

async function localCode(connection: RTCPeerConnection, desc: RTCSessionDescriptionInit): Promise<string> {
  await connection.setLocalDescription(desc);
  await finishIce(connection);
  const sdp = connection.localDescription?.sdp;
  if (!sdp || !/^a=candidate:/m.test(sdp)) throw new Error('No local connection address was gathered.');
  return toCode(sdp);
}

/** Scope persisted rejoin tokens to the authenticated DTLS identity, not only a room label. */
export function offerFingerprint(code: string): string {
  const sdp = fromCode(code, 'offer').sdp ?? '';
  const fingerprints = [...sdp.matchAll(/^a=fingerprint:sha-256 ((?:[0-9a-f]{2}:){31}[0-9a-f]{2})\s*$/gim)]
    .map((match) => match[1].replace(/:/g, '').toLowerCase());
  if (!fingerprints[0] || fingerprints.some((value) => value !== fingerprints[0])) {
    throw new Error('Invalid browser host identity.');
  }
  return fingerprints[0];
}

function newPeer(certificate?: RTCCertificate): RTCPeerConnection {
  if (typeof RTCPeerConnection !== 'function') throw new Error('This browser does not support WebRTC.');
  return new RTCPeerConnection({ iceServers: [], ...(certificate ? { certificates: [certificate] } : {}) });
}

function watchLimit(connection: RTCPeerConnection, channel: RTCDataChannel): void {
  messageLimits.set(channel, () => connection.sctp?.maxMessageSize);
}

export async function createRtcOffer(certificate?: RTCCertificate): Promise<{ code: string; connection: RTCPeerConnection; channel: RTCDataChannel }> {
  const connection = newPeer(certificate);
  try {
    const channel = connection.createDataChannel('flaghack-v1', { ordered: true });
    watchLimit(connection, channel);
    const code = await localCode(connection, await connection.createOffer());
    return { code, connection, channel };
  } catch (error) {
    connection.close();
    throw error;
  }
}

export async function acceptRtcOffer(code: string): Promise<{ code: string; connection: RTCPeerConnection; channel: Promise<RTCDataChannel> }> {
  const offer = fromCode(code, 'offer');
  const connection = newPeer();
  const channel = new Promise<RTCDataChannel>((resolve, reject) => {
    const onChannel = (event: RTCDataChannelEvent) => {
      if (event.channel.label !== 'flaghack-v1' || !event.channel.ordered || event.channel.maxPacketLifeTime !== null || event.channel.maxRetransmits !== null) {
        event.channel.close();
        cleanup();
        reject(new Error('Invalid remote data channel.'));
        return;
      }
      watchLimit(connection, event.channel);
      cleanup();
      resolve(event.channel);
    };
    const check = () => {
      if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
        cleanup();
        reject(new Error('The peer connection closed before the channel opened.'));
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      connection.removeEventListener('datachannel', onChannel);
      connection.removeEventListener('connectionstatechange', check);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for the host. Check that the host pasted the answer.'));
      connection.close();
    }, 120_000);
    connection.addEventListener('datachannel', onChannel);
    connection.addEventListener('connectionstatechange', check);
  });
  // The caller needs the answer before it can await the channel.
  void channel.catch(() => {});
  try {
    await connection.setRemoteDescription(offer);
    const answer = await localCode(connection, await connection.createAnswer());
    return { code: answer, connection, channel };
  } catch (error) {
    connection.close();
    throw error;
  }
}

export async function acceptRtcAnswer(connection: RTCPeerConnection, code: string): Promise<void> {
  await connection.setRemoteDescription(fromCode(code, 'answer'));
}

/** Ordered reliable transport with bounded reassembly. Chunks of one message never interleave. */
export class PeerWire {
  onmessage: ((text: string) => void) | null = null;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;
  private readonly parts: Uint8Array[] = [];
  private receivedBytes = 0;
  private closed = false;

  constructor(private readonly channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('message', this.receive);
    channel.addEventListener('close', this.didClose);
    channel.addEventListener('error', this.close);
    if (channel.readyState === 'open') queueMicrotask(this.didOpen);
    else if (channel.readyState === 'closing' || channel.readyState === 'closed') queueMicrotask(this.didClose);
    else channel.addEventListener('open', this.didOpen);
  }

  get bufferedAmount(): number { return this.channel.bufferedAmount; }

  send(text: string): void {
    if (this.closed || this.channel.readyState !== 'open') throw new Error('Peer channel is not open.');
    if (text.length > MAX_MESSAGE_BYTES) throw new Error('Peer message is too large.');
    const bytes = encoder.encode(text);
    if (bytes.length > MAX_MESSAGE_BYTES) throw new Error('Peer message is too large.');
    const limit = messageLimits.get(this.channel)?.() ?? CHUNK_BYTES;
    const payload = Math.min(CHUNK_BYTES, limit) - 1;
    // Tiny negotiated chunks are not practical and cannot meet the bounded receive-frame count.
    if (payload < 1023) throw new Error('Peer channel message limit is too small.');
    const n = Math.max(1, Math.ceil(bytes.length / payload));
    if (this.bufferedAmount + bytes.length + n > MAX_QUEUE_BYTES) throw new Error('Peer channel has too much queued data.');
    try {
      for (let i = 0; i < n; i++) {
        const part = bytes.subarray(i * payload, (i + 1) * payload);
        const frame = new Uint8Array(part.length + 1);
        frame[0] = i + 1 === n ? 1 : 0;
        frame.set(part, 1);
        this.channel.send(frame.buffer);
      }
    } catch (error) {
      // A partially sent message must not absorb the next logical message.
      this.close();
      throw error;
    }
  }

  close = (): void => {
    if (this.closed) return;
    this.channel.close();
    this.didClose();
  };

  private didOpen = (): void => {
    if (!this.closed && this.channel.readyState === 'open') this.onopen?.();
  };

  private didClose = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.parts.length = 0;
    this.receivedBytes = 0;
    this.channel.removeEventListener('message', this.receive);
    this.channel.removeEventListener('open', this.didOpen);
    this.channel.removeEventListener('close', this.didClose);
    this.channel.removeEventListener('error', this.close);
    this.onclose?.();
  };

  private receive = (evt: MessageEvent): void => {
    if (this.closed) return;
    if (!(evt.data instanceof ArrayBuffer) || evt.data.byteLength < 1 || evt.data.byteLength > CHUNK_BYTES) {
      this.close();
      return;
    }
    const frame = new Uint8Array(evt.data);
    const tag = frame[0];
    const body = frame.subarray(1);
    if ((tag !== 0 && tag !== 1) || (tag === 0 && body.length < 1023) || this.receivedBytes + body.length > MAX_MESSAGE_BYTES) {
      this.close();
      return;
    }
    this.parts.push(body);
    this.receivedBytes += body.length;
    if (tag === 0) return;
    const bytes = new Uint8Array(this.receivedBytes);
    let offset = 0;
    for (const part of this.parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    this.parts.length = 0;
    this.receivedBytes = 0;
    let value: string;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      this.close();
      return;
    }
    this.onmessage?.(value);
  };
}
