'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { validateBundle, installBundle, inspectBundle, LIMITS } = require('./game-bundle.cjs');

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const index = `<!doctype html><html><head>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">
<script type="module" crossorigin src="/assets/index-a.js"></script>
<link rel="stylesheet" crossorigin href="./assets/index-a.css">
</head><body><canvas id="game"></canvas></body></html>`;
const contents = () => ({
  'index.html': index,
  'assets/index-a.js': 'document.querySelector("canvas");',
  'assets/index-a.css': '@font-face{src:url(./game-font.woff2)}.icon{background:url("data:image/svg+xml,%3Csvg/%3E")}',
  'assets/game-font.woff2': Buffer.from([1, 2, 3, 4]),
  'LICENSES.txt': 'Bundled dependency licenses.\n',
  'audio/boss/CREDITS.md': 'Audio attribution',
  'audio/boss/roar.mp3': Buffer.from([0, 2, 4]),
  'models/boss/asset-manifest.json': '{}',
  'models/boss/README.md': 'Model attribution',
  'models/boss/boss.glb': Buffer.from([0, 3, 6]),
  'cards/rider-waite/Major15.webp': Buffer.from([1, 2, 3]),
  'cards/parody/creature.webp': Buffer.from([3, 2, 1]),
});
function file(name, data) {
  const bytes = Buffer.from(data);
  return { path: name, size: bytes.length, sha256: hash(bytes), data: bytes.toString('base64') };
}
function fixture(options = {}) {
  const bundle = {
    schema: 1, runtimeApi: 1, branch: 'main', commit: COMMIT,
    files: Object.entries(options.contents ?? contents()).map(([name, data]) => file(name, data)),
    ...options.bundle,
  };
  options.mutate?.(bundle);
  const bytes = zlib.gzipSync(JSON.stringify(bundle));
  const expected = { schema: 1, runtimeApi: 1, branch: bundle.branch, commit: bundle.commit, sha256: hash(bytes), size: bytes.length, ...options.expected };
  return { bundle, bytes, expected };
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flaghack-bundle-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('valid Vite-style bundle validates without executing browser code', () => {
  const data = contents();
  data['assets/index-a.js'] = 'throw new Error("This must never run in Node");';
  const { bytes, expected } = fixture({ contents: data });
  const actual = validateBundle(bytes, expected);
  assert.equal(actual.branch, 'main');
  assert.equal(actual.commit, COMMIT);
  assert.equal(actual.files.length, Object.keys(data).length);
  assert.ok(Buffer.isBuffer(actual.files[0].data));
  assert.deepEqual(validateBundle(new Uint8Array(bytes), expected), actual);
});

test('atomic install, complete inspection, reuse and concurrent repeated install', async (t) => {
  const cacheRoot = path.join(await temporary(t), 'cache');
  const { bytes, expected } = fixture();
  const result = await installBundle({ bytes, expected, cacheRoot });
  assert.deepEqual(result, { branch: 'main', commit: COMMIT, dir: path.join(cacheRoot, `main-${COMMIT}`) });
  assert.deepEqual(await inspectBundle(result.dir), result);
  assert.deepEqual(await inspectBundle(result.dir, { branch: 'main', commit: COMMIT }), result);
  const before = await fs.stat(path.join(result.dir, 'index.html'));
  assert.deepEqual(await Promise.all(Array.from({ length: 4 }, () => installBundle({ bytes, expected, cacheRoot }))), Array(4).fill(result));
  assert.equal((await fs.stat(path.join(result.dir, 'index.html'))).ino, before.ino);
  assert.deepEqual(await fs.readdir(cacheRoot), [`main-${COMMIT}`]);
  const manifest = JSON.parse(await fs.readFile(path.join(result.dir, 'bundle.json'), 'utf8'));
  assert.equal(manifest.sha256, expected.sha256);
  assert.ok(manifest.files.every((entry) => !Object.hasOwn(entry, 'data')));
});

test('main and iteration with the same commit occupy distinct cache directories', async (t) => {
  const cacheRoot = await temporary(t);
  const main = fixture();
  const iteration = fixture({ bundle: { branch: 'iteration' } });
  const first = await installBundle({ ...main, cacheRoot });
  const second = await installBundle({ ...iteration, cacheRoot });
  assert.notEqual(first.dir, second.dir);
  await assert.rejects(inspectBundle(first.dir, { branch: 'iteration', commit: COMMIT }), /branch does not match/);
});

test('tampering is rejected and reinstall never overwrites a corrupt active destination', async (t) => {
  const cacheRoot = await temporary(t);
  const data = fixture();
  const { dir } = await installBundle({ ...data, cacheRoot });
  const filename = path.join(dir, 'assets/index-a.js');
  const original = await fs.readFile(filename);
  const tampered = Buffer.alloc(original.length, 88);
  await fs.writeFile(filename, tampered);
  await assert.rejects(inspectBundle(dir), /checksum mismatch/);
  await assert.rejects(installBundle({ ...data, cacheRoot }), /Existing cached game bundle is invalid; leaving it unchanged/);
  assert.deepEqual(await fs.readFile(filename), tampered);
  assert.deepEqual(await fs.readdir(cacheRoot), [`main-${COMMIT}`]);
});

test('missing files, metadata and extra files/directories are rejected', async (t) => {
  for (const mutation of ['missing-file', 'missing-metadata', 'extra-file', 'extra-directory', 'bad-metadata']) {
    const cacheRoot = path.join(await temporary(t), mutation);
    const { dir } = await installBundle({ ...fixture(), cacheRoot });
    if (mutation === 'missing-file') await fs.unlink(path.join(dir, 'assets/game-font.woff2'));
    if (mutation === 'missing-metadata') await fs.unlink(path.join(dir, 'bundle.json'));
    if (mutation === 'extra-file') await fs.writeFile(path.join(dir, 'unexpected.js'), 'not allowed');
    if (mutation === 'extra-directory') await fs.mkdir(path.join(dir, 'surprise'));
    if (mutation === 'bad-metadata') await fs.writeFile(path.join(dir, 'bundle.json'), '{');
    await assert.rejects(inspectBundle(dir));
  }
});

test('incomplete staging directories cannot be inspected and are not reused', async (t) => {
  const cacheRoot = await temporary(t);
  const stage = path.join(cacheRoot, '.stage-interrupted');
  await fs.mkdir(stage);
  await fs.writeFile(path.join(stage, 'index.html'), index);
  await assert.rejects(inspectBundle(stage), /ENOENT/);
  const result = await installBundle({ ...fixture(), cacheRoot });
  assert.notEqual(result.dir, stage);
  assert.deepEqual(await fs.readFile(path.join(stage, 'index.html'), 'utf8'), index);
});

test('symlinked root, ancestor, asset directory, file, and metadata are rejected', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows symlink creation requires extra privileges');
  const root = await temporary(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  const linked = path.join(root, 'linked');
  await fs.symlink(outside, linked, 'dir');
  await assert.rejects(installBundle({ ...fixture(), cacheRoot: linked }), /not a regular directory/);
  await assert.rejects(installBundle({ ...fixture(), cacheRoot: path.join(linked, 'new-cache') }), /not a regular directory/);
  assert.deepEqual(await fs.readdir(outside), []);
  for (const relative of ['assets', 'assets/index-a.js', 'bundle.json']) {
    const { dir } = await installBundle({ ...fixture(), cacheRoot: path.join(root, relative.replaceAll('/', '-')) });
    const target = path.join(dir, relative);
    const moved = path.join(outside, relative.replaceAll('/', '-'));
    await fs.rename(target, moved);
    await fs.symlink(moved, target, relative === 'assets' ? 'dir' : 'file');
    await assert.rejects(inspectBundle(dir), /symlink|not a regular file/);
  }
});

test('nonregular FIFO cache entries are rejected without opening them', async (t) => {
  if (process.platform === 'win32') return t.skip('FIFO test is POSIX-only');
  const { execFileSync } = require('node:child_process');
  const { dir } = await installBundle({ ...fixture(), cacheRoot: await temporary(t) });
  const filename = path.join(dir, 'assets/index-a.js');
  await fs.unlink(filename);
  execFileSync('mkfifo', [filename]);
  await assert.rejects(inspectBundle(dir), /nonregular cache entry/);
});

test('unsafe, platform-ambiguous, duplicate, and conflicting archive paths are rejected', () => {
  for (const name of ['cards/../escape', 'cards/../../escape', 'cards/.hidden', 'cards/CON', 'cards//x', 'cards-evil/card.webp', '/index.html', '../index.html', 'assets/../../escape', 'assets/./x', 'assets/../x', 'assets\\evil.js', 'assets/a:b.js', 'assets//x.js', 'assets/.hidden', 'assets/x.', 'assets/CON', 'assets/Lpt1.txt', 'assets/space name.js', 'assets/é.js', 'package.json', 'server.cjs', 'assets/']) {
    const { bytes, expected } = fixture({ mutate: (bundle) => bundle.files.push(file(name, 'x')) });
    assert.throws(() => validateBundle(bytes, expected), /path/, name);
  }
  for (const entries of [
    [file('assets/index-a.js', 'duplicate')],
    [file('assets/INDEX-a.js', 'case-fold collision')],
    [file('assets/sub', 'file'), file('assets/sub/x.js', 'nested')],
    [file('assets/A/x.js', 'x'), file('assets/a/y.js', 'y')],
  ]) {
    const { bytes, expected } = fixture({ mutate: (bundle) => bundle.files.push(...entries) });
    assert.throws(() => validateBundle(bytes, expected), /duplicate|conflicts|collision/);
  }
});

test('entry types, link metadata, unsupported fields and absent index are rejected', () => {
  for (const mutate of [
    (bundle) => { bundle.files[0].type = 'symlink'; },
    (bundle) => { bundle.files[0].linkname = '/etc/passwd'; },
    (bundle) => { bundle.files[0] = null; },
    (bundle) => { bundle.files = bundle.files.filter((entry) => entry.path !== 'index.html'); },
    (bundle) => { bundle.executable = 'assets/server.cjs'; },
    (bundle) => { bundle.files = []; },
  ]) {
    const { bytes, expected } = fixture({ mutate });
    assert.throws(() => validateBundle(bytes, expected));
  }
});

test('outer corruption, wrong size/hash, invalid gzip and malformed JSON are rejected', () => {
  const { bytes, expected } = fixture();
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => validateBundle(corrupt, expected), /checksum/);
  assert.throws(() => validateBundle(bytes, { ...expected, size: bytes.length + 1 }), /size/);
  assert.throws(() => validateBundle(bytes, { ...expected, sha256: 'x'.repeat(64) }), /sha256/);
  assert.throws(() => validateBundle('text', expected), /Buffer/);
  for (const invalid of [Buffer.from('not gzip'), zlib.gzipSync('{'), zlib.gzipSync(Buffer.from([0xff]))]) {
    assert.throws(() => validateBundle(invalid, { ...expected, size: invalid.length, sha256: hash(invalid) }), /gzip|JSON/);
  }
});

test('runtime, schema, branch, commit and expected manifest are strictly checked', () => {
  for (const [key, value] of [['runtimeApi', 2], ['schema', 2], ['branch', 'staging'], ['commit', 'main'], ['commit', 'A'.repeat(40)]]) {
    const { bytes, expected } = fixture({ bundle: { [key]: value } });
    assert.throws(() => validateBundle(bytes, expected), /unsupported|invalid/);
  }
  const { bytes, expected } = fixture();
  assert.throws(() => validateBundle(bytes, { ...expected, branch: 'iteration' }), /branch does not match/);
  assert.throws(() => validateBundle(bytes, { ...expected, commit: 'a'.repeat(40) }), /commit does not match/);
  assert.throws(() => validateBundle(bytes, { branch: 'main', commit: COMMIT }), /schema/);
});

test('per-file size, hash and noncanonical base64 are strictly checked', () => {
  for (const mutate of [
    (bundle) => { bundle.files[0].size++; },
    (bundle) => { bundle.files[0].sha256 = '0'.repeat(64); },
    (bundle) => { bundle.files[0].data += '\n'; },
    (bundle) => { bundle.files.push({ path: 'assets/x', size: 1, sha256: hash('a'), data: 'YR==' }); },
    (bundle) => { bundle.files.push({ path: 'assets/x', size: 1, sha256: hash('a'), data: 'YQ=A' }); },
    (bundle) => { bundle.files[0].size = LIMITS.file + 1; },
    (bundle) => { bundle.files[0].size = -1; },
    (bundle) => { bundle.files[0].size = 1.5; },
  ]) {
    const { bytes, expected } = fixture({ mutate });
    assert.throws(() => validateBundle(bytes, expected), /size|base64|checksum/);
  }
});

test('file count, compressed limit and bounded gzip decompression are enforced', () => {
  const { bytes, expected } = fixture({ mutate: (bundle) => { bundle.files = Array.from({ length: LIMITS.files + 1 }, (_, i) => file(`assets/${i}`, '')); } });
  assert.throws(() => validateBundle(bytes, expected), /file count/);
  const normal = fixture();
  assert.throws(() => validateBundle(normal.bytes, { ...normal.expected, size: LIMITS.compressed + 1 }), /size/);
  const bomb = zlib.gzipSync(Buffer.alloc(LIMITS.uncompressed + 1, 32));
  assert.throws(() => validateBundle(bomb, { ...normal.expected, size: bomb.length, sha256: hash(bomb) }), /decompression limit/);
});

test('root HTML references must resolve locally; remote and missing resource indirection fail', () => {
  for (const html of [
    '<script src="https://evil.example/game.js"></script>',
    '<!--><script src="https://evil.example/game.js"></script><!-- -->',
    '<script/src="https://evil.example/game.js"></script>',
    '<script src="https://evil.example/game.js>',
    '<script src="//evil.example/game.js"></script>',
    '<script src="https&#58;//evil.example/game.js"></script>',
    '<script src="data:text/javascript,alert(1)"></script>',
    '<script src="/assets/missing.js"></script>',
    '<link rel="stylesheet" href="https://evil.example/style.css">',
    '<img src="/assets/missing.png">',
    '<img src="/assets/%2e%2e/secret">',
    '<img src="../secret">',
    '<img srcset="/assets/game-font.woff2 1x, https://evil.example/x 2x">',
    '<base href="https://evil.example/">',
    '<iframe src="/assets/index-a.js"></iframe>',
    '<object data="https://evil.example/x"></object>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<script>alert(1)</script>',
    '<script src="/assets/index-a.js" src="https://evil.example/x"></script>',
  ]) {
    const { bytes, expected } = fixture({ contents: { ...contents(), 'index.html': html } });
    assert.throws(() => validateBundle(bytes, expected), undefined, html);
  }
});

test('CSS resources, imports and nested paths are checked; data images stay self-contained', () => {
  for (const css of [
    'a{background:url(https://evil.example/x.png)}',
    'a{background:url("//evil.example/x.png")}',
    '@import "https://evil.example/x.css";',
    'a{background:image-set("https://evil.example/x.png" 1x)}',
    'a{background:-webkit-image-set("https://evil.example/x.png" 1x)}',
    '@import url(/assets/missing.css);',
    'a{background:url(/assets/missing.png)}',
    'a{background:url(../outside.png)}',
    'a{background:u\\72l(https://evil.example/x.png)}',
    'a{background:url(  "unterminated)}',
  ]) {
    const { bytes, expected } = fixture({ contents: { ...contents(), 'assets/index-a.css': css } });
    assert.throws(() => validateBundle(bytes, expected), undefined, css);
  }
  const { bytes, expected } = fixture({ contents: { ...contents(), 'assets/index-a.css': '@import "./nested.css";a{fill:url(#paint)}', 'assets/nested.css': 'a{color:red}' } });
  assert.doesNotThrow(() => validateBundle(bytes, expected));
});

test('inspection checks complete expected metadata and bounds metadata entries', async (t) => {
  const fixtureData = fixture();
  const { dir } = await installBundle({ ...fixtureData, cacheRoot: await temporary(t) });
  await assert.rejects(inspectBundle(dir, { ...fixtureData.expected, sha256: '0'.repeat(64) }), /sha256 does not match/);
  const metadataPath = path.join(dir, 'bundle.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  metadata.files[0].size = LIMITS.file + 1;
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(inspectBundle(dir), /file size exceeds limit/);
});
