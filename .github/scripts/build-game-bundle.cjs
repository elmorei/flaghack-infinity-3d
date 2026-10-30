'use strict';
// CI/build-time packer only. No game code or build tool executes on player machines.
const { readdir, readFile, writeFile, mkdir, lstat } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { validateBundle } = require('../../web/desktop/game-bundle.cjs');
async function build({ branch, commit, dist, out }) {
  if (!['main', 'iteration'].includes(branch) || !/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Expected main/iteration and a full commit SHA');
  dist = resolve(dist); out = resolve(out);
  const files = [];
  async function add(path, bytes) { files.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') }); }
  async function walk(dir, prefix = '') {
    for (const name of (await readdir(dir)).sort()) {
      const path = prefix + name, absolute = join(dir, name), info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error('Symlink in build output');
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('.')) throw new Error('Unexpected build path');
      if (info.isDirectory()) { if (!['assets', 'audio', 'models', 'cards'].some(root => path === root || path.startsWith(root + '/'))) throw new Error('Unexpected output directory'); await walk(absolute, path + '/'); }
      else if (info.isFile()) { if (path !== 'index.html' && !['assets/', 'audio/', 'models/', 'cards/'].some(root => path.startsWith(root))) throw new Error('Unexpected output file'); if (path.endsWith('.map')) continue; await add(path, await readFile(absolute)); }
      else throw new Error('Non-regular build output');
    }
  }
  await walk(dist);
  const web = resolve(dist, '..');
  let licenses = 'FLAGHACK browser game bundle\nSource: https://github.com/elmorei/flaghack-infinity-3d\nBranch: ' + branch + '\nCommit: ' + commit + '\n\nThird-party runtime assets and notices:\n';
  const packages = ['three', '@fontsource/bungee', '@fontsource/cinzel', '@fontsource/cinzel-decorative', '@fontsource/rubik', '@fontsource/stardos-stencil'];
  for (const pkg of packages) licenses += '\n--- ' + pkg + ' ---\n' + await readFile(join(web, 'node_modules', pkg, 'LICENSE'), 'utf8');
  await add('LICENSES.txt', Buffer.from(licenses));
  if (!files.some(file => file.path === 'index.html') || files.length > 4096 || files.some(file => file.size > 32 * 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 96 * 1024 * 1024) throw new Error('Build exceeds game bundle limits');
  const payload = Buffer.from(JSON.stringify({ schema: 1, runtimeApi: 1, branch, commit, files }));
  if (payload.length > 128 * 1024 * 1024) throw new Error('Uncompressed bundle too large');
  const bytes = gzipSync(payload, { level: 9 });
  if (bytes.length > 64 * 1024 * 1024) throw new Error('Bundle too large');
  const bundle = `game-${branch}-${commit}.json.gz`;
  const manifest = { schema: 1, runtimeApi: 1, branch, commit, bundle, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  validateBundle(bytes, manifest);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, bundle), bytes);
  await writeFile(join(out, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest));
  return manifest;
}
module.exports = { build };
if (require.main === module) {
  const args = process.argv.slice(2), options = {};
  if (args.length !== 8) throw new Error('Use --branch <name> --commit <sha> --dist <directory> --out <directory>');
  for (let i = 0; i < args.length; i += 2) { const key = args[i].slice(2); if (!['branch', 'commit', 'dist', 'out'].includes(key) || options[key]) throw new Error('Unexpected argument'); options[key] = args[i + 1]; }
  build(options).catch(error => { console.error(error); process.exitCode = 1; });
}
