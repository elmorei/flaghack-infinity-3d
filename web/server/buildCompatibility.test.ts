import { afterEach, describe, expect, it } from 'vitest';
import { BUILD_ID } from '../src/net/build';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import { CLOSE_DENIED } from './room';
import { cleanup, connect, hello, host, join, PASSWORD } from './testkit';

afterEach(cleanup);

describe('host build compatibility', () => {
  it('refuses a different build even with the right protocol and password', async () => {
    const h = await host();
    const c = await connect(h);
    hello(c, 'alice', null, PASSWORD, PROTOCOL_VERSION, 'other-release-commit');
    const denied = await c.next('denied');
    expect(denied.reason).toBe('build');
    expect(denied.message).toMatch(/update.*host.*reload/i);
    expect(await c.closed()).toBe(CLOSE_DENIED);
  });

  it('explains a missing build without waiting for the hello timeout', async () => {
    const h = await host();
    const c = await connect(h);
    c.send({ t: 'hello', protocol: PROTOCOL_VERSION, name: 'stale', password: PASSWORD, token: null });
    expect((await c.next('denied')).reason).toBe('build');
    expect(await c.closed()).toBe(CLOSE_DENIED);
  });

  it('keeps a useful protocol denial for old protocol13 clients without build metadata', async () => {
    const h = await host();
    const c = await connect(h);
    c.send({ t: 'hello', protocol: 13, name: 'old', password: PASSWORD, token: null });
    const denied = await c.next('denied');
    expect(denied.reason).toBe('protocol');
    expect(denied.message).toMatch(/update.*host.*reload/i);
  });

  it('welcomes only matching builds and does not count incompatibility as a bad password', async () => {
    const h = await host();
    for (let i = 0; i < 6; i++) {
      const c = await connect(h);
      hello(c, 'old', null, PASSWORD, PROTOCOL_VERSION, 'not-this-build');
      expect((await c.next('denied')).reason).toBe('build');
    }
    const good = await join(h, 'alice');
    expect(good.me).toMatchObject({ protocol: PROTOCOL_VERSION, build: BUILD_ID });
  });

  it('assigns each running host a distinct public relay-verification identity', async () => {
    const a = await host();
    const b = await host();
    expect(a.instanceId).toMatch(/^[0-9a-f]{32}$/);
    expect(b.instanceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.instanceId).not.toBe(b.instanceId);
  });
});
