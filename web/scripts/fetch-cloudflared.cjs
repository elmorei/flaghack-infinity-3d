'use strict';

// Build-time only. Do not call this from the installed hosting application.
// Official release/checksum verified on 2026-10-21:
// https://github.com/cloudflare/cloudflared/releases/tag/2026.10.2
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { mkdir, stat, rename, rm, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const VERSION = '2026.10.2';
const RELEASE_URL = `https://github.com/cloudflare/cloudflared/releases/tag/${VERSION}`;
const ASSETS = Object.freeze([
  Object.freeze({ name: 'cloudflared.exe',
    url: `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-windows-amd64.exe`,
    sha256: '12c7c887f8aaab779aef1dfa9b60673530a5adb88ecc55dd6df8f56e0b70f199', maxBytes: 120 * 1024 * 1024 }),
  Object.freeze({ name: 'cloudflared-LICENSE.txt',
    url: `https://raw.githubusercontent.com/cloudflare/cloudflared/${VERSION}/LICENSE`,
    sha256: '58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd', maxBytes: 128 * 1024 }),
]);
const ALLOWED_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com',
  'objects.githubusercontent.com', 'github-releases.githubusercontent.com', 'raw.githubusercontent.com']);

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function trustedDownloadUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error('Refusing a cloudflared download outside official HTTPS GitHub asset hosts.');
  }
  return url.href;
}

async function fetchOfficial(url, { fetchImpl = fetch, signal } = {}) {
  let current = trustedDownloadUrl(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetchImpl(current, { redirect: 'manual', signal, headers: { 'User-Agent': 'FLAGHACK-host-build', Accept: 'application/octet-stream' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('Cloudflared download redirect has no location.');
      current = trustedDownloadUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Official cloudflared download failed (HTTP ${response.status}).`);
    }
    return response;
  }
  throw new Error('Too many redirects downloading cloudflared.');
}

async function downloadAsset(asset, outputDir, { fetchImpl = fetch, timeoutMs = 120000 } = {}) {
  const destination = join(outputDir, asset.name);
  try {
    const existing = await stat(destination);
    if (existing.isFile() && existing.size <= asset.maxBytes && await hashFile(destination) === asset.sha256) return destination;
    throw new Error(`Existing ${asset.name} does not match the pinned SHA256. Delete it and retry the build.`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const temporary = `${destination}.${randomUUID()}.tmp`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchOfficial(asset.url, { fetchImpl, signal: controller.signal });
    const length = Number(response.headers.get('content-length'));
    if (length > asset.maxBytes) {
      await response.body.cancel();
      throw new Error(`${asset.name} exceeds its download size limit.`);
    }
    const hash = createHash('sha256');
    let size = 0;
    const verify = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > asset.maxBytes) return callback(new Error(`${asset.name} exceeds its download size limit.`));
      hash.update(chunk); callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(temporary, { flags: 'wx', mode: 0o644 }), { signal: controller.signal });
    if (!size || hash.digest('hex') !== asset.sha256) throw new Error(`SHA256 verification failed for ${asset.name}. Nothing was installed.`);
    await rename(temporary, destination);
    return destination;
  } finally {
    clearTimeout(timeout);
    await rm(temporary, { force: true });
  }
}

async function fetchCloudflared({ outputDir = join(__dirname, '..', 'host-desktop', 'vendor'), fetchImpl = fetch } = {}) {
  await mkdir(outputDir, { recursive: true });
  for (const asset of ASSETS) await downloadAsset(asset, outputDir, { fetchImpl });
  await writeFile(join(outputDir, 'cloudflared-manifest.json'), JSON.stringify({
    version: VERSION, platform: 'win32', arch: 'x64', release: RELEASE_URL,
    files: ASSETS.map(({ name, url, sha256 }) => ({ name, url, sha256 })),
  }, null, 2) + '\n');
  return join(outputDir, 'cloudflared.exe');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1) { console.error('Usage: node scripts/fetch-cloudflared.cjs [output-directory]'); process.exitCode = 1; }
  else fetchCloudflared(args[0] ? { outputDir: resolve(args[0]) } : {}).then(path => {
    console.log(`Verified official cloudflared ${VERSION} Windows x64: ${path}`);
  }, error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { VERSION, RELEASE_URL, ASSETS, hashFile, trustedDownloadUrl, fetchOfficial, downloadAsset, fetchCloudflared };
