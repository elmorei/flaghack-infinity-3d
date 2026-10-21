'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, rm, readFile, readdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { VERSION, ASSETS, trustedDownloadUrl, fetchOfficial, downloadAsset, hashFile } = require('./fetch-cloudflared.cjs');

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'flaghack-download-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function fixture(content = 'official fixture') {
  return { name: 'helper.exe', url: 'https://github.com/cloudflare/cloudflared/releases/download/test/helper.exe',
    sha256: createHash('sha256').update(content).digest('hex'), maxBytes: 1024 };
}

test('pins official Windows x64 release checksum and its redistributable license', () => {
  assert.equal(VERSION, '2026.10.2');
  assert.equal(ASSETS[0].sha256, '12c7c887f8aaab779aef1dfa9b60673530a5adb88ecc55dd6df8f56e0b70f199');
  assert.match(ASSETS[0].url, /\/2026\.10\.2\/cloudflared-windows-amd64\.exe$/);
  assert.equal(ASSETS[1].name, 'cloudflared-LICENSE.txt');
  assert.match(ASSETS[1].url, /cloudflare\/cloudflared\/2026\.10\.2\/LICENSE$/);
});

test('allows only official HTTPS asset hosts with no credentials or custom port', () => {
  assert.equal(trustedDownloadUrl('https://release-assets.githubusercontent.com/asset?signature=abc'), 'https://release-assets.githubusercontent.com/asset?signature=abc');
  for (const url of ['http://github.com/a', 'https://github.com.evil.test/a', 'https://evil.test/a',
    'https://user:secret@github.com/a', 'https://github.com:444/a', 'file:///tmp/binary']) {
    assert.throws(() => trustedDownloadUrl(url));
  }
});

test('follows official asset redirect but refuses other destinations before fetching them', async () => {
  const calls = [];
  const result = await fetchOfficial('https://github.com/asset', { fetchImpl: async url => {
    calls.push(url);
    return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/file' } }) : new Response('bytes');
  } });
  assert.equal(await result.text(), 'bytes'); assert.equal(calls.length, 2);
  let count = 0;
  await assert.rejects(fetchOfficial('https://github.com/asset', { fetchImpl: async () => {
    count++; return new Response(null, { status: 302, headers: { Location: 'https://evil.test/file' } });
  } }), /official HTTPS/);
  assert.equal(count, 1);
});

test('bounds redirects and rejects HTTP failures', async () => {
  let count = 0;
  await assert.rejects(fetchOfficial('https://github.com/asset', { fetchImpl: async () => {
    count++; return new Response(null, { status: 302, headers: { Location: '/asset' } });
  } }), /Too many redirects/);
  assert.equal(count, 6);
  await assert.rejects(fetchOfficial('https://github.com/asset', { fetchImpl: async () => new Response('missing', { status: 404 }) }), /HTTP 404/);
});

test('verifies bytes before publishing, then re-verifies cached files without downloading', async t => {
  const root = await directory(t); const asset = fixture(); let downloads = 0;
  const fetchImpl = async () => { downloads++; return new Response('official fixture'); };
  const path = await downloadAsset(asset, root, { fetchImpl });
  assert.equal(await readFile(path, 'utf8'), 'official fixture');
  assert.equal(await hashFile(path), asset.sha256);
  assert.equal(await downloadAsset(asset, root, { fetchImpl }), path);
  assert.equal(downloads, 1);
  assert.deepEqual(await readdir(root), ['helper.exe']);
});

test('checksum mismatch never publishes binary and removes partial files', async t => {
  const root = await directory(t);
  await assert.rejects(downloadAsset(fixture(), root, { fetchImpl: async () => new Response('tampered') }), /SHA256 verification failed/);
  assert.deepEqual(await readdir(root), []);
});

test('tampered cache fails closed rather than silently trusting or replacing it', async t => {
  const root = await directory(t); await writeFile(join(root, 'helper.exe'), 'tampered');
  await assert.rejects(downloadAsset(fixture(), root, { fetchImpl: () => { throw new Error('must not fetch'); } }), /does not match the pinned SHA256/);
  assert.equal(await readFile(join(root, 'helper.exe'), 'utf8'), 'tampered');
});

test('rejects oversize streamed and declared downloads', async t => {
  const root = await directory(t);
  await assert.rejects(downloadAsset({ ...fixture(), maxBytes: 4 }, root, { fetchImpl: async () => new Response('large') }), /size limit/);
  await assert.rejects(downloadAsset(fixture(), root, { fetchImpl: async () => new Response('small', { headers: { 'Content-Length': '999999' } }) }), /size limit/);
  assert.deepEqual(await readdir(root), []);
});

test('abort timeout removes unfinished download', async t => {
  const root = await directory(t);
  const fetchImpl = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  await assert.rejects(downloadAsset(fixture(), root, { fetchImpl, timeoutMs: 10 }), { name: 'AbortError' });
  assert.deepEqual(await readdir(root), []);
});
