/** Offline pixel validation of the checked-in actual-model scenery atlas. No browser needed. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src/render/actors/mobileSpriteWorld.json'), 'utf8'));
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
const expected = [];
for (const [kind, count] of Object.entries({tent:3,tree:2,car:3,art:6,dome:1,porta:1,rock:1,stage:1,shade:1})) for (let v = 0; v < count; v++) expected.push(`scenery:${kind}:${v}:idle`);
for (const kind of ['pallets','lumber','moop']) expected.push(`pile:${kind}:idle`);
for (const kind of ['cloth','metal','wood','stone','mixed']) expected.push(`wreckage:${kind}:idle`);
for (const kind of ['plinth','scaffold','flag']) expected.push(`effigy:${kind}:idle`);
assert.deepEqual(Object.keys(manifest.clips).sort(), expected.sort());
const pages = manifest.pages.map(p => {
  const image = decodePng(path.join(root, 'public', p.image));
  assert.equal(image.width, p.width); assert.equal(image.height, p.height); return image;
});
const cells = [];
for (const [key, clip] of Object.entries(manifest.clips)) {
  assert.equal(clip.rows, 4); assert.deepEqual(clip.directionRows, {front:0,right:1,away:2,left:3});
  assert(clip.heightPixels > 0); assert(clip.anchor.every(Number.isFinite));
  const page = pages[clip.page]; assert(page);
  assert(clip.x >= 0 && clip.y >= 0 && clip.x + clip.w <= page.width && clip.y + clip.h <= page.height);
  const hashes = [];
  for (let row = 0; row < clip.rows; row++) for (let column = 0; column < clip.columns; column++) {
    let count = 0, ownerPixels = 0, minX = clip.cellWidth, maxX = -1, minY = clip.cellHeight, maxY = -1;
    const hash = crypto.createHash('sha256');
    for (let y = 0; y < clip.cellHeight; y++) {
      const offset = ((clip.y + row * clip.cellHeight + y) * page.width + clip.x + column * clip.cellWidth) * 4;
      hash.update(page.pixels.subarray(offset, offset + clip.cellWidth * 4));
      for (let x = 0; x < clip.cellWidth; x++) {
        const alpha = page.pixels[offset + x * 4 + 3]; assert([0,224,255].includes(alpha), `${key}: unexpected authoring mask ${alpha}`);
        if (!alpha) continue; count++; ownerPixels += alpha === 224 ? 1 : 0;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    assert(count > 0, `${key}/${row}/${column}: empty`);
    assert(minX > 0 && minY > 0 && maxX < clip.cellWidth - 1 && maxY < clip.cellHeight - 1, `${key}/${row}/${column}: clipped`);
    const digest = hash.digest('hex'); if (row === 0) hashes.push(digest);
    cells.push({key,row,column,count,ownerPixels,bounds:[minX,minY,maxX,maxY],sha256:digest});
  }
  if (['scenery:art:2:idle','scenery:art:3:idle','effigy:flag:idle'].includes(key)) {
    assert.equal(clip.columns, 4); assert.equal(new Set(hashes).size, 4, `${key}: animation poses must differ`);
  }
}
const report = { clips: expected.length, pages: pages.length, cells: cells.length, allCellsNonemptyAndUnclipped: true, results: cells };
if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), JSON.stringify(report, null, 2) + '\n');
console.log(`Verified ${report.clips} clips, ${report.cells} unclipped cells and ${report.pages} atlas pages.`);
