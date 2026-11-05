/** Offline pixel validation of the checked-in actual-model building atlas. No browser needed. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/render/actors/mobileSpriteBuildings.json'), 'utf8'));
function decodePng(file) {
  const source = fs.readFileSync(file), chunks = []; let width, height, at = 8;
  assert.equal(source.subarray(1, 4).toString(), 'PNG');
  while (at < source.length) {
    const length = source.readUInt32BE(at), type = source.toString('ascii', at + 4, at + 8), data = source.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[8], 8); assert.equal(data[9], 6); assert.equal(data[12], 0); }
    if (type === 'IDAT') chunks.push(data);
    at += length + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks)), stride = width * 4, pixels = Buffer.alloc(width * height * 4);
  assert.equal(raw.length, (stride + 1) * height);
  function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, a = x >= 4 ? pixels[i - 4] : 0, b = y ? pixels[i - stride] : 0, c = y && x >= 4 ? pixels[i - stride - 4] : 0;
      pixels[i] = (raw[y * (stride + 1) + 1 + x] + (filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c))) & 255;
    }
  }
  return { width, height, pixels };
}
const states = {hearth:['idle','seated'],workshop:['idle','working'],drumcircle:['idle','active'],ward:['idle','pulse'],druglab:['idle','brewing'],gcc:['idle','moving','channel','wreck']};
const heights = {hearth:8.41,workshop:3,drumcircle:2.4,ward:5.405,druglab:3.2,gcc:3.4};
const expected = Object.entries(states).flatMap(([kind, names]) => names.map(state => `building:${kind}:${state}`));
assert.equal(manifest.schemaVersion, 1);
assert.deepEqual(Object.keys(manifest.clips).sort(), expected.sort());
assert.equal(manifest.pages.length, 1, 'Building art must stay within one 16 MiB GPU page.');
const reference = JSON.parse(fs.readFileSync(path.join(root, '../art/mobile-sprites/buildings-reference.json'), 'utf8'));
assert.match(reference.sourceCommit, /^[a-f0-9]{40}$/);
const occupied = new Set(), clipHashes = {};
const pages = manifest.pages.map((p, index) => {
  const file = path.join(root, 'public', p.image), sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(p.image, `/assets/mobile-sprites/buildings-${index}-${sha256.slice(0, 12)}.png`, 'Building atlas URL must match its image bytes.');
  assert.deepEqual(reference.outputs[index], {image:p.image,sha256});
  const image = decodePng(file);
  assert.equal(image.width, p.width); assert.equal(image.height, p.height); return image;
});
const cells = [];
for (const [key, clip] of Object.entries(manifest.clips)) {
  assert.equal(clip.rows, 4); assert.deepEqual(clip.directionRows, {front:0,right:1,away:2,left:3});
  assert(clip.heightPixels > 0); assert(clip.anchor.every(Number.isFinite));
  const page = pages[clip.page]; assert(page);
  assert(clip.x >= 0 && clip.y >= 0 && clip.x + clip.w <= page.width && clip.y + clip.h <= page.height);
  const hashes = [];
  assert.equal(clip.columns, 4); assert.equal(clip.cellWidth, 128); assert.equal(clip.cellHeight, 128);
  assert.equal(clip.w, 512); assert.equal(clip.h, 512);
  assert.equal(clip.worldHeight, key === 'building:hearth:seated' ? 2 : heights[key.split(':')[1]]);
  const proof = reference.references[key]; assert(proof);
  for (let row = 0; row < clip.rows; row++) for (let column = 0; column < clip.columns; column++) {
    const slot = `${clip.page}/${clip.x + column * clip.cellWidth}/${clip.y + row * clip.cellHeight}`;
    assert(!occupied.has(slot), `${key}: overlapping cell ${slot}`); occupied.add(slot);
    let count = 0, ownerPixels = 0, liveMapPixels = 0, minX = clip.cellWidth, maxX = -1, minY = clip.cellHeight, maxY = -1;
    const hash = crypto.createHash('sha256');
    for (let y = 0; y < clip.cellHeight; y++) {
      const offset = ((clip.y + row * clip.cellHeight + y) * page.width + clip.x + column * clip.cellWidth) * 4;
      hash.update(page.pixels.subarray(offset, offset + clip.cellWidth * 4));
      for (let x = 0; x < clip.cellWidth; x++) {
        const alpha = page.pixels[offset + x * 4 + 3]; assert([0,160,224,255].includes(alpha), `${key}: unexpected authoring mask ${alpha}`);
        if (!alpha) continue; count++; ownerPixels += alpha === 224 ? 1 : 0; liveMapPixels += alpha === 160 ? 1 : 0;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    assert(count > 0, `${key}/${row}/${column}: empty`);
    assert(minX > 0 && minY > 0 && maxX < clip.cellWidth - 1 && maxY < clip.cellHeight - 1, `${key}/${row}/${column}: clipped`);
    const digest = hash.digest('hex'); hashes.push(digest);
    const recorded = proof.footprint[row * clip.columns + column];
    assert.deepEqual(recorded, {direction:row,frame:column,opaque:count,owner:ownerPixels,liveMap:liveMapPixels,bounds:[minX,minY,maxX,maxY]});
    assert.equal(clip.footYByCell[row][column], clip.anchor[1]);
    cells.push({key,row,column,count,ownerPixels,liveMapPixels,bounds:[minX,minY,maxX,maxY],sha256:digest});
  }
  const livePixels = cells.filter(cell => cell.key === key).reduce((n, cell) => n + cell.liveMapPixels, 0);
  assert(key.startsWith('building:gcc:') ? livePixels > 0 : livePixels === 0, `${key}: invalid live-map mask`);
  clipHashes[key] = crypto.createHash('sha256').update(hashes.join('')).digest('hex');
  assert(cells.filter(cell => cell.key === key).some(cell => cell.ownerPixels > 0), `${key}: missing ownership mask`);
}
for (const [kind, names] of Object.entries(states)) {
  // Channel differs through its live tabletop shimmer and emitted effects; its
  // baked body can match idle once map pixels carry coordinates, not fixed color.
  const compared = kind === 'gcc' ? names.filter(name => name !== 'channel') : names;
  assert.equal(new Set(compared.map(name => clipHashes[`building:${kind}:${name}`])).size, compared.length, `${kind}: state art must differ`);
}
assert.equal(cells.length, 224);
const report = { clips: expected.length, pages: pages.length, cells: cells.length, allCellsNonemptyAndUnclipped: true, results: cells };
if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(report, null, 2) + '\n');
console.log(`Verified ${report.clips} clips, ${report.cells} unclipped cells and ${report.pages} atlas pages.`);
