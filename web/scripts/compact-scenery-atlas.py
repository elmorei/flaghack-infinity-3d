#!/usr/bin/env python3
"""Losslessly trim/pack native-baked world clips. Pillow is the sole dependency.

Every cell in a clip shares one crop, with two transparent pixels retained. Pixel
edge anchors translate by that crop; heightPixels and explicit-width reference
remain unchanged. No pixel is resized or recolored. All cells are reconstructed
and compared byte-for-byte BEFORE any production output is written.
"""
import argparse
import copy
import hashlib
import io
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = Path('src/render/actors/mobileSpriteWorld.json')


def read(path):
    return json.loads(path.read_text())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def cell(image, clip, row, column):
    x, y = clip['x'] + column * clip['cellWidth'], clip['y'] + row * clip['cellHeight']
    return image.crop((x, y, x + clip['cellWidth'], y + clip['cellHeight']))


def split_free(free, used):
    ux, uy, uw, uh = used
    result = []
    for x, y, w, h in free:
        if ux >= x+w or ux+uw <= x or uy >= y+h or uy+uh <= y:
            result.append((x, y, w, h))
            continue
        if ux > x:
            result.append((x, y, ux-x, h))
        if ux+uw < x+w:
            result.append((ux+uw, y, x+w-ux-uw, h))
        if uy > y:
            result.append((x, y, w, uy-y))
        if uy+uh < y+h:
            result.append((x, uy+uh, w, y+h-uy-uh))
    result = sorted(set(result))
    return [r for i, r in enumerate(result) if not any(
        i != j and s[0] <= r[0] and s[1] <= r[1] and
        s[0]+s[2] >= r[0]+r[2] and s[1]+s[3] >= r[1]+r[3]
        for j, s in enumerate(result))]


def pack(items, width, order):
    free, placed = [], {}
    for item in sorted(items, key=order):
        w, h = item['width'], item['height']
        candidates = []
        for page, rectangles in enumerate(free):
            for x, y, fw, fh in rectangles:
                if w <= fw and h <= fh:
                    candidates.append((min(fw-w, fh-h), max(fw-w, fh-h), page, y, x))
        if candidates:
            _, _, page, y, x = min(candidates)
        else:
            if w > width or h > 2048:
                return None
            page, x, y = len(free), 0, 0
            free.append([(0, 0, width, 2048)])
        free[page] = split_free(free[page], (x, y, w, h))
        placed[item['key']] = (page, x, y)
    sizes = [(max(placed[i['key']][1]+i['width'] for i in items if placed[i['key']][0] == page),
              max(placed[i['key']][2]+i['height'] for i in items if placed[i['key']][0] == page))
             for page in range(len(free))]
    return placed, sizes


def verify(source, output, receipt):
    original, packed = read(source / MANIFEST), read(output / MANIFEST)
    originals = [Image.open(source / 'public' / p['image'].lstrip('/')).convert('RGBA') for p in original['pages']]
    targets = [Image.open(output / 'public' / p['image'].lstrip('/')).convert('RGBA') for p in packed['pages']]
    checked = 0
    for key, a in original['clips'].items():
        b = packed['clips'][key]
        x, y, _, _ = receipt['clips'][key]['crop']
        assert b['heightPixels'] == a['heightPixels'], key
        assert b['anchor'] == [a['anchor'][0]-x, a['anchor'][1]-y], key
        assert b['sourceCellWidth'] == a.get('sourceCellWidth', a['cellWidth']), key
        for row in range(a['rows']):
            for column in range(a['columns']):
                before = cell(originals[a['page']], a, row, column)
                after = cell(targets[b['page']], b, row, column)
                rebuilt = Image.new('RGBA', before.size)
                rebuilt.paste(after, (x, y))
                assert rebuilt.tobytes() == before.tobytes(), f'{key}/{row}/{column}: RGBA changed'
                assert abs(b['footYByCell'][row][column] + y - a['footYByCell'][row][column]) < 1e-10, key
                # The same source pixel center has the same world position for both
                # height-driven sizing and explicit-width wreckage. The burn cutoff
                # is measured from this preserved origin, not from a trimmed edge.
                for px, py in [(x+.5, y+.5), (x+after.width-.5, y+after.height-.5)]:
                    for width in [None, 6]:
                        sx = 1/a['heightPixels'] if width is None else width/a.get('sourceCellWidth',a['cellWidth'])
                        tx = 1/b['heightPixels'] if width is None else width/b['sourceCellWidth']
                        assert abs((px-a['anchor'][0])*sx-(px-x-b['anchor'][0])*tx) < 1e-10, key
                    assert abs((a['footYByCell'][row][column]-py)/a['heightPixels']-
                               (b['footYByCell'][row][column]-(py-y))/b['heightPixels']) < 1e-10, key
                checked += 1
    return checked


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='Original native-baked web directory')
    parser.add_argument('--output', type=Path, default=ROOT, help='Production web directory')
    parser.add_argument('--receipt', type=Path, default=ROOT.parent / 'art/mobile-sprites/scenery-compaction.json')
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    if args.verify_only:
        print(f'Verified {verify(args.source, args.output, read(args.receipt))} byte-exact reconstructed cells.')
        return
    manifest = read(args.source / MANIFEST)
    pages = [Image.open(args.source / 'public' / p['image'].lstrip('/')).convert('RGBA') for p in manifest['pages']]
    items, receipt = [], {'method':'Per-clip union alpha crop, two clear pixels; deterministic MaxRects; no resampling.',
                          'sourcePages':[], 'clips':{}}
    for p in manifest['pages']:
        receipt['sourcePages'].append({'image':p['image'], 'sha256':sha((args.source / 'public' / p['image'].lstrip('/')).read_bytes())})
    for key, clip in manifest['clips'].items():
        cells = [cell(pages[clip['page']], clip, row, col) for row in range(clip['rows']) for col in range(clip['columns'])]
        boxes = [c.getchannel('A').getbbox() for c in cells]
        assert all(boxes), f'Empty cell: {key}'
        box = (max(0, min(b[0] for b in boxes)-2), max(0, min(b[1] for b in boxes)-2),
               min(clip['cellWidth'], max(b[2] for b in boxes)+2), min(clip['cellHeight'], max(b[3] for b in boxes)+2))
        cw, ch = box[2]-box[0], box[3]-box[1]
        cropped = [c.crop(box) for c in cells]
        for before, after in zip(cells, cropped):
            rebuilt = Image.new('RGBA', before.size); rebuilt.paste(after, box[:2])
            assert rebuilt.tobytes() == before.tobytes(), f'Crop discards nonzero RGBA: {key}'
        items.append({'key':key, 'crop':box, 'cells':cropped, 'cw':cw, 'ch':ch,
                      'width':cw*clip['columns'], 'height':ch*clip['rows']})
        receipt['clips'][key] = {'crop':list(box), 'sourceCellSize':[clip['cellWidth'],clip['cellHeight']],
                                'rgbaSha256':[sha(c.tobytes()) for c in cells]}
    candidates = []
    for width in [2048, 1920, 1792, 1664, 1536, 1408, 1280]:
        for order in [lambda i:(-i['height'],-i['width'],i['key']),
                      lambda i:(-i['width']*i['height'],-i['height'],i['key']),
                      lambda i:(-max(i['width'],i['height']),-i['height'],i['key']),
                      lambda i:(-i['width'],-i['height'],i['key'])]:
            result = pack(items, width, order)
            if result:
                placements, sizes = result
                candidates.append((len(sizes),sum(w*h for w,h in sizes),placements,sizes))
    _, _, placements, sizes = min(candidates, key=lambda c:(c[0],c[1]))
    newpages = [Image.new('RGBA', size) for size in sizes]
    result = copy.deepcopy(manifest)
    for item in items:
        key = item['key']; original = manifest['clips'][key]; clip = result['clips'][key]
        page,x,y = placements[key]; cx,cy,_,_ = item['crop']; cw,ch = item['cw'],item['ch']
        for i, image in enumerate(item['cells']):
            newpages[page].paste(image, (x+(i%clip['columns'])*cw,y+(i//clip['columns'])*ch))
        clip.update(page=page,x=x,y=y,w=item['width'],h=item['height'],cellWidth=cw,cellHeight=ch,
                    sourceCellWidth=original.get('sourceCellWidth',original['cellWidth']),
                    anchor=[original['anchor'][0]-cx,original['anchor'][1]-cy],
                    footYByCell=[[n-cy for n in row] for row in original['footYByCell']])
    result['pages'] = []
    outputs = []
    for i, image in enumerate(newpages):
        stream = io.BytesIO(); image.save(stream,format='PNG',optimize=True); data = stream.getvalue()
        filename = f'world-{i}-{sha(data)[:12]}.png'
        result['pages'].append({'image':'/assets/mobile-sprites/'+filename,'width':image.width,'height':image.height})
        outputs.append((filename,data))
    oldbytes = sum(p.width*p.height*4 for p in pages)
    newbytes = sum(p.width*p.height*4 for p in newpages)
    assert newbytes < oldbytes, 'No memory improvement'
    receipt.update(sourceRGBABytes=oldbytes,packedRGBABytes=newbytes,savedRGBABytes=oldbytes-newbytes,
                   packedPages=result['pages'],heightPixelsUnchanged=True,allRGBAReconstructionExact=True,
                   cells=sum(c['rows']*c['columns'] for c in result['clips'].values()))
    # No destination changes occur until every original cell has passed exact reconstruction.
    for filename,data in outputs:
        target = args.output / 'public/assets/mobile-sprites' / filename
        target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(data)
    (args.output / MANIFEST).write_text(json.dumps(result,indent=2)+'\n')
    args.receipt.parent.mkdir(parents=True,exist_ok=True); args.receipt.write_text(json.dumps(receipt,indent=2)+'\n')
    checked = verify(args.source,args.output,receipt)
    print(json.dumps({'pages':sizes,'verifiedCells':checked,'savedMiB':(oldbytes-newbytes)/1048576,'RGBABytes':newbytes}))


if __name__ == '__main__':
    main()
