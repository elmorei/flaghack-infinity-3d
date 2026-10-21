'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const security = require('./security.cjs');
const options = { serverName: 'My match', port: 8787, mode: 'quick', pagesUrl: security.DEFAULT_PAGES_URL };
test('validates constrained host inputs', () => {
  assert.deepEqual(security.settings(options), { ...options, endpoint: null });
  for (const port of [0, 1023, 65536, 8787.5, NaN, Infinity]) assert.throws(() => security.settings({ ...options, port }));
  for (const serverName of ['', 'a'.repeat(49), 'a\nb']) assert.throws(() => security.settings({ ...options, serverName }));
  assert.throws(() => security.settings({ ...options, mode: 'arbitrary' }));
});
test('rejects unsafe endpoints, credentials and non-origin URLs', () => {
  for (const endpoint of ['http://a.example', 'file:///tmp/a', 'javascript:alert(1)', 'https://user:password@a.example', 'https://localhost', 'https://foo.local', 'https://127.0.0.1', 'https://[::1]', 'https://a.example/path', 'https://a.example?x=1', 'https://a.example#host=x', 'https://a.example\\evil', 'https://a.example.']) assert.throws(() => security.publicOrigin(endpoint), endpoint);
  assert.equal(security.publicOrigin('https://test.example:8443/'), 'https://test.example:8443');
});
test('validates Pages path and builds password-only fragment invite', () => {
  const invite = security.invite(security.DEFAULT_PAGES_URL, 'https://abc.trycloudflare.com', 'secret +&');
  const url = new URL(invite);
  assert.equal(url.search, '');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(url.hash.slice(1))), { host: 'https://abc.trycloudflare.com', pw: 'secret +&' });
  assert.throws(() => security.pagesUrl(`${security.DEFAULT_PAGES_URL}?pw=x`));
  assert.throws(() => security.pagesUrl(`${security.DEFAULT_PAGES_URL}#pw=x`));
});
test('passwords have 192 bits of entropy and diagnostics redact secrets', () => {
  const passwords = new Set(Array.from({ length: 100 }, security.password));
  assert.equal(passwords.size, 100);
  for (const password of passwords) assert.match(password, /^[\w-]{32}$/);
  assert.equal(security.cleanLog('secret\nhttps://example.test/#pw=secret&x=2', 'secret'), '[redacted] https://example.test/#pw=[redacted]&x=2');
});
test('host info projects known validated fields and rejects malformed status', () => {
  const info = { protocol: 14, build: 'abc', instanceId: 'instance', phase: 'lobby', players: 4, seated: 3 };
  assert.deepEqual(security.hostInfo({ ...info, password: 'never pass through' }), info);
  for (const patch of [{ build: '' }, { instanceId: '' }, { players: '4' }, { phase: '<script>' }, { seated: 8 }]) assert.throws(() => security.hostInfo({ ...info, ...patch }));
});
test('disconnected players can retain seats without invalidating healthy host info', () => {
  const info = { protocol: 14, build: 'abc', instanceId: 'instance', phase: 'playing', players: 0, seated: 4 };
  assert.deepEqual(security.hostInfo(info), info);
  assert.throws(() => security.hostInfo({ ...info, players: 17 }));
  assert.throws(() => security.hostInfo({ ...info, seated: 5 }));
});
