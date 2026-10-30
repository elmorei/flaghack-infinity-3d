'use strict';

// Browser-only bundles are data. Nothing in this module loads downloaded code.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const LIMITS = Object.freeze({
  compressed: 64 * 1024 * 1024,
  uncompressed: 128 * 1024 * 1024,
  files: 4096,
  file: 32 * 1024 * 1024,
  total: 96 * 1024 * 1024,
  metadata: 8 * 1024 * 1024,
});
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const NON_BASE64 = /[^A-Za-z0-9+/=]/;
const installs = new Map();

function fail(message) { throw new Error(`Invalid game bundle: ${message}`); }
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
}
function keys(value, allowed, name) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(`${name} has unsupported fields`);
}
function identity(value, name) {
  object(value, name);
  if (value.schema !== 1) fail(`${name} schema is unsupported`);
  if (value.runtimeApi !== 1) fail(`${name} runtimeApi is unsupported`);
  if (value.branch !== 'main' && value.branch !== 'iteration') fail(`${name} branch is unsupported`);
  if (typeof value.commit !== 'string' || !COMMIT.test(value.commit)) fail(`${name} commit is invalid`);
}
function envelope(value, name) {
  identity(value, name);
  if (typeof value.sha256 !== 'string' || !HASH.test(value.sha256)) fail(`${name} sha256 is invalid`);
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > LIMITS.compressed) fail(`${name} size is invalid`);
}
function compareExpected(value, expected, complete) {
  if (complete) envelope(expected, 'expected manifest');
  else object(expected, 'expected identity');
  for (const key of ['schema', 'runtimeApi', 'branch', 'commit', 'sha256', 'size']) {
    if ((complete || Object.hasOwn(expected, key)) && value[key] !== expected[key]) fail(`${key} does not match expected manifest`);
  }
}
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function utf8(bytes, label) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail(`${label} is not valid UTF-8`); }
}
function json(bytes, label) {
  try { return JSON.parse(utf8(bytes, label)); }
  catch (error) { fail(`${label} is not valid JSON (${error.message})`); }
}
function safePath(value) {
  if (typeof value !== 'string' || value.length > 1024) fail('file path is invalid');
  if (value !== 'index.html' && value !== 'LICENSES.txt' && !['assets/', 'audio/', 'models/', 'cards/'].some((prefix) => value.startsWith(prefix))) fail(`file path is not allowed: ${value}`);
  const parts = value.split('/');
  if (parts.length > 16 || parts.some((part) => (
    !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part) || part.length > 255 || part.endsWith('.') ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
  ))) fail(`unsafe file path: ${value}`);
  return value;
}
function descriptors(files, withData) {
  if (!Array.isArray(files) || files.length < 1 || files.length > LIMITS.files) fail('file count exceeds limits');
  const seen = new Set();
  let total = 0;
  const result = files.map((file) => {
    object(file, 'file');
    keys(file, withData ? ['path', 'size', 'sha256', 'data'] : ['path', 'size', 'sha256'], 'file');
    safePath(file.path);
    const folded = file.path.toLowerCase();
    if (seen.has(folded)) fail(`duplicate file path: ${file.path}`);
    seen.add(folded);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > LIMITS.file) fail(`file size exceeds limit: ${file.path}`);
    total += file.size;
    if (total > LIMITS.total) fail('aggregate file size exceeds limit');
    if (typeof file.sha256 !== 'string' || !HASH.test(file.sha256)) fail(`invalid file sha256: ${file.path}`);
    if (!withData) return { path: file.path, size: file.size, sha256: file.sha256 };
    if (typeof file.data !== 'string' || file.data.length !== Math.ceil(file.size / 3) * 4 || NON_BASE64.test(file.data)) fail(`invalid base64 or size: ${file.path}`);
    const data = Buffer.from(file.data, 'base64');
    // Buffer.from accepts noncanonical padding bits; require a round trip.
    if (data.length !== file.size || data.toString('base64') !== file.data) fail(`invalid base64 or size: ${file.path}`);
    if (sha256(data) !== file.sha256) fail(`file checksum mismatch: ${file.path}`);
    return { path: file.path, size: file.size, sha256: file.sha256, data };
  });
  if (!seen.has('index.html')) fail('index.html is missing');
  const directoryNames = new Map();
  for (const file of result) {
    const segments = file.path.split('/');
    while (segments.length > 1) {
      segments.pop();
      const name = segments.join('/');
      const folded = name.toLowerCase();
      if (directoryNames.has(folded) && directoryNames.get(folded) !== name) fail('case-folding directory collision');
      directoryNames.set(folded, name);
    }
  }
  for (const name of seen) {
    const parts = name.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (seen.has(parts.join('/'))) fail('file path conflicts with a directory');
    }
  }
  return result;
}

function htmlEntities(value) {
  return value.replace(/&([^;\s]+);/g, (_all, entity) => {
    const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
    if (Object.hasOwn(named, entity)) return named[entity];
    const numeric = /^#(?:x([0-9a-f]+)|(\d+))$/i.exec(entity);
    if (!numeric) fail('unsupported entity in HTML attribute');
    const code = numeric[1] ? parseInt(numeric[1], 16) : Number(numeric[2]);
    if (!Number.isSafeInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail('invalid HTML entity');
    return String.fromCodePoint(code);
  });
}
function reference(raw, owner, names, { favicon = false, image = false, fragment = false } = {}) {
  if (typeof raw !== 'string' || !raw) fail(`empty resource reference in ${owner}`);
  if ((favicon || image) && /^data:image\/(?:svg\+xml|png|x-icon|vnd\.microsoft\.icon|gif|webp)(?:;[^,]*)?,[^\r\n]*$/i.test(raw)) return;
  if (fragment && raw.startsWith('#')) return;
  // Strict ASCII paths avoid browser/server decoding differences and URL schemes.
  if (!/^[A-Za-z0-9_./?#=&-]+$/.test(raw) || raw.startsWith('//') || raw.includes('\\')) fail(`external or unsafe resource reference in ${owner}: ${raw.slice(0, 100)}`);
  const pathname = raw.split(/[?#]/, 1)[0];
  if (!pathname) fail(`empty resource path in ${owner}`);
  const parts = pathname.split('/');
  if (parts.includes('..') || parts.some((part, i) => part === '' && i > 0)) fail(`unsafe resource path in ${owner}`);
  const resolved = pathname.startsWith('/') ? pathname.slice(1) : path.posix.join(path.posix.dirname(owner), pathname);
  safePath(resolved);
  if (!names.has(resolved)) fail(`missing resource ${resolved} referenced by ${owner}`);
}
function cssReferences(text, owner, names) {
  // Vite emits ordinary URLs. Reject CSS escapes instead of ambiguously decoding them.
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  if (css.includes('\\')) fail(`CSS escapes are unsupported in ${owner}`);
  if (/(?:^|[^A-Za-z0-9_-])(?:-webkit-)?image(?:-set)?\s*\(/i.test(css)) fail(`unsupported CSS image function in ${owner}`);
  for (const match of css.matchAll(/url\s*\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s)'";]+))\s*\)/gi)) {
    reference(match[1] ?? match[2] ?? match[3], owner, names, { fragment: true, image: true });
  }
  for (const match of css.matchAll(/@import\s+(?:"([^"\r\n]*)"|'([^'\r\n]*)')/gi)) reference(match[1] ?? match[2], owner, names);
  // Malformed/unsupported URL syntaxes must not skip checking.
  const withoutUrls = css.replace(/url\s*\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s)'";]+))\s*\)/gi, '');
  if (/url\s*\(/i.test(withoutUrls)) fail(`unsupported CSS URL in ${owner}`);
}
function htmlReferences(text, names) {
  const owner = 'index.html';
  if (text.includes('\0')) fail('NUL in HTML');
  // A conservative tokenizer rejects malformed comments/tags rather than skipping
  // text that a browser might interpret as an active resource element.
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('<', cursor);
    if (start === -1) break;
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4);
      if (end === -1 || /[<>]|--/.test(text.slice(start + 4, end))) fail('unsupported HTML comment');
      cursor = end + 3;
      continue;
    }
    const declaration = /^<!doctype\s+html\s*>/i.exec(text.slice(start));
    if (declaration) { cursor = start + declaration[0].length; continue; }
    const closing = /^<\/[A-Za-z][A-Za-z0-9:-]*\s*>/.exec(text.slice(start));
    if (closing) { cursor = start + closing[0].length; continue; }
    if (!/^<[A-Za-z][A-Za-z0-9:-]*(?:\s|\/?>)/.test(text.slice(start))) fail('unsupported HTML tag syntax');
    let quote = null;
    let end = start + 1;
    for (; end < text.length; end++) {
      const character = text[end];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
      else if (character === '<') fail('malformed HTML tag');
    }
    if (end === text.length) fail('unclosed HTML tag');
    const token = [text.slice(start, end + 1)];
    token.index = start;
    cursor = end + 1;
    const tag = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(token[0])[1].toLowerCase();
    if (['base', 'iframe', 'frame', 'frameset', 'object', 'embed'].includes(tag)) fail(`unsupported HTML tag: ${tag}`);
    const body = token[0].slice(tag.length + 1, -1).replace(/\/$/, '');
    const attrs = Object.create(null);
    let position = 0;
    const attr = /\s+([^\s=<>`"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
    while (position < body.length) {
      if (!body.slice(position).trim()) break;
      attr.lastIndex = position;
      const match = attr.exec(body);
      if (!match) fail(`unsupported HTML attributes on ${tag}`);
      position = attr.lastIndex;
      const name = match[1].toLowerCase();
      if (Object.hasOwn(attrs, name)) fail(`duplicate HTML attribute: ${name}`);
      attrs[name] = htmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
    }
    if ('srcdoc' in attrs || (tag === 'meta' && 'http-equiv' in attrs)) fail('HTML document redirects/policies are unsupported');
    for (const name of ['src', 'href', 'poster', 'action', 'formaction', 'xlink:href', 'background']) {
      if (name in attrs) reference(attrs[name], owner, names, {
        favicon: tag === 'link' && name === 'href' && /(?:^|\s)icon(?:\s|$)/i.test(attrs.rel ?? ''),
        fragment: name === 'href' && tag === 'a',
      });
    }
    // srcset parsing is deliberately narrow; data URLs are only allowed for favicon href.
    for (const attribute of ['srcset', 'imagesrcset']) {
      if (!(attribute in attrs)) continue;
      for (const candidate of attrs[attribute].split(',')) {
        const match = /^\s*(\S+)(?:\s+\d+(?:\.\d+)?[wx])?\s*$/.exec(candidate);
        if (!match) fail('unsupported HTML srcset');
        reference(match[1], owner, names);
      }
    }
    if ('style' in attrs) cssReferences(attrs.style, owner, names);
    if (tag === 'script' || tag === 'style') {
      const end = new RegExp(`</${tag}\\s*>`, 'ig');
      end.lastIndex = token.index + token[0].length;
      const close = end.exec(text);
      if (!close) fail(`unclosed HTML ${tag}`);
      const inner = text.slice(token.index + token[0].length, close.index);
      cursor = end.lastIndex;
      if (tag === 'script' && (!attrs.src || inner.trim())) fail('scripts must use a local src without inline content');
      if (tag === 'style') cssReferences(inner, owner, names);
    }
  }
}
function checkReferences(files) {
  const names = new Set(files.map((file) => file.path));
  htmlReferences(utf8(files.find((file) => file.path === 'index.html').data, 'index.html'), names);
  for (const file of files) if (/\.css$/i.test(file.path)) cssReferences(utf8(file.data, file.path), file.path, names);
}

function validateBundle(bytes, expected) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail('bundle bytes must be a Buffer or Uint8Array');
  envelope(expected, 'expected manifest');
  if (bytes.byteLength < 1 || bytes.byteLength > LIMITS.compressed || bytes.byteLength !== expected.size) fail('compressed bundle size mismatch or limit exceeded');
  if (sha256(bytes) !== expected.sha256) fail('compressed bundle checksum mismatch');
  let unpacked;
  try { unpacked = zlib.gunzipSync(bytes, { maxOutputLength: LIMITS.uncompressed }); }
  catch (error) { fail(`gzip is corrupt or exceeds decompression limit (${error.code || error.message})`); }
  const bundle = json(unpacked, 'bundle');
  identity(bundle, 'bundle');
  keys(bundle, ['schema', 'runtimeApi', 'branch', 'commit', 'files'], 'bundle');
  compareExpected({ ...bundle, sha256: expected.sha256, size: expected.size }, expected, true);
  const files = descriptors(bundle.files, true);
  checkReferences(files);
  return { schema: 1, runtimeApi: 1, branch: bundle.branch, commit: bundle.commit, sha256: expected.sha256, size: expected.size, files };
}

async function noSymlinkDirectory(dir, create = false) {
  const absolute = path.resolve(dir);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fsp.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try { await fsp.mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = await fsp.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`cache directory is not a regular directory: ${current}`);
  }
  return absolute;
}
async function readRegular(filename, maximum, expectedSize) {
  const before = await fsp.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink()) fail(`not a regular file: ${path.basename(filename)}`);
  const handle = await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum || (expectedSize !== undefined && stat.size !== expectedSize) || stat.ino !== before.ino || stat.dev !== before.dev) fail(`file size/type changed or exceeds limit: ${path.basename(filename)}`);
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) fail(`file is truncated: ${path.basename(filename)}`);
      offset += bytesRead;
    }
    const tail = await handle.read(Buffer.alloc(1), 0, 1, offset);
    if (tail.bytesRead) fail(`file grew during verification: ${path.basename(filename)}`);
    return data;
  } finally { await handle.close(); }
}
async function inspectBundle(dir, expected) {
  const absolute = await noSymlinkDirectory(dir);
  const manifest = json(await readRegular(path.join(absolute, 'bundle.json'), LIMITS.metadata), 'cache metadata');
  envelope(manifest, 'cache metadata');
  keys(manifest, ['schema', 'runtimeApi', 'branch', 'commit', 'sha256', 'size', 'files'], 'cache metadata');
  if (expected !== undefined) compareExpected(manifest, expected, false);
  const files = descriptors(manifest.files, false);
  const allowedFiles = new Set(['bundle.json', ...files.map((file) => file.path)]);
  const allowedDirs = new Set();
  for (const file of files) {
    let parent = path.posix.dirname(file.path);
    while (parent !== '.') { allowedDirs.add(parent); parent = path.posix.dirname(parent); }
  }
  const present = new Set();
  async function walk(relative) {
    const directory = await fsp.opendir(path.join(absolute, relative));
    for await (const entry of directory) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = await fsp.lstat(path.join(absolute, name));
      if (stat.isSymbolicLink()) fail(`symlink in cached bundle: ${name}`);
      if (stat.isDirectory() && allowedDirs.has(name)) await walk(name);
      else if (stat.isFile() && allowedFiles.has(name)) present.add(name);
      else fail(`unexpected or nonregular cache entry: ${name}`);
    }
  }
  await walk('');
  if (present.size !== allowedFiles.size) fail('cached bundle is incomplete');
  const decoded = [];
  for (const file of files) {
    const data = await readRegular(path.join(absolute, file.path), LIMITS.file, file.size);
    if (sha256(data) !== file.sha256) fail(`cached file checksum mismatch: ${file.path}`);
    decoded.push({ ...file, data });
  }
  checkReferences(decoded);
  return { branch: manifest.branch, commit: manifest.commit, dir: absolute };
}

async function installValidated(bundle, cacheRoot, expected) {
  const root = await noSymlinkDirectory(cacheRoot, true);
  const destination = path.join(root, `${bundle.branch}-${bundle.commit}`);
  async function existing() {
    try { await fsp.lstat(destination); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    // Never replace a corrupt existing directory; it may be the active bundle.
    try { return await inspectBundle(destination, expected); }
    catch (error) { throw new Error(`Existing cached game bundle is invalid; leaving it unchanged: ${error.message}`); }
  }
  const cached = await existing();
  if (cached) return cached;
  const staging = await fsp.mkdtemp(path.join(root, '.stage-'));
  let renamed = false;
  try {
    await fsp.chmod(staging, 0o700);
    for (const file of bundle.files) {
      const target = path.join(staging, file.path);
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fsp.writeFile(target, file.data, { flag: 'wx', mode: 0o600 });
    }
    const manifest = { ...bundle, files: bundle.files.map(({ path: name, size, sha256: hash }) => ({ path: name, size, sha256: hash })) };
    await fsp.writeFile(path.join(staging, 'bundle.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 });
    await inspectBundle(staging, expected);
    const raced = await existing();
    if (raced) return raced;
    try { await fsp.rename(staging, destination); renamed = true; }
    catch (error) {
      if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) {
        const other = await existing();
        if (other) return other;
      }
      throw error;
    }
    return await inspectBundle(destination, expected);
  } finally {
    if (!renamed) await fsp.rm(staging, { recursive: true, force: true });
  }
}
async function installBundle({ bytes, expected, cacheRoot }) {
  if (typeof cacheRoot !== 'string' || !cacheRoot) fail('cacheRoot must be a path');
  const bundle = validateBundle(bytes, expected);
  const key = path.join(path.resolve(cacheRoot), `${bundle.branch}-${bundle.commit}`);
  const previous = installs.get(key) || Promise.resolve();
  const result = previous.catch(() => {}).then(() => installValidated(bundle, cacheRoot, expected));
  installs.set(key, result);
  try { return await result; }
  finally { if (installs.get(key) === result) installs.delete(key); }
}

module.exports = { validateBundle, installBundle, inspectBundle, LIMITS };
