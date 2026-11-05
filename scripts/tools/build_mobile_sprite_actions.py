#!/usr/bin/env python3
"""Pack generated action art without altering the approved walking atlas.

Requires Pillow. Source grids and provenance are in art/mobile-sprites/sources.json.
Only technical cutout normalization, grid extraction and nearest-neighbour scaling
are performed here. Artwork is generated separately, never drawn by this script.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import statistics
from io import BytesIO
from pathlib import Path

from PIL import Image
from mobile_sprite_skin import apply_action_skin_mask
from compact_mobile_sprite_actions import compact_action_atlas

ROOT = Path(__file__).resolve().parents[2]
CELL, PAGE, PAD, FOOT = 128, 2048, 0, 124
CLIP_W, CLIP_H = CELL * 4, CELL * 2


def cutout(image: Image.Image) -> Image.Image:
    image = image.convert('RGBA')
    mask = image.getchannel('A').point(lambda a: 255 if a >= 128 else 0)
    opaque = image.copy()
    opaque.putalpha(255)
    result = Image.new('RGBA', image.size)
    result.paste(opaque, (0, 0), mask)
    return result


def divisions(alpha: Image.Image, count: int, horizontal: bool) -> list[int]:
    """Find real transparent gutters; generated action rows are not always uniform."""
    length, cross = (alpha.height, alpha.width) if horizontal else (alpha.width, alpha.height)
    counts = []
    for at in range(length):
        box = (0, at, cross, at + 1) if horizontal else (at, 0, at + 1, cross)
        counts.append(sum(v > 0 for v in alpha.crop(box).getdata()))
    gaps = []
    start = None
    for at, occupied in enumerate(counts + [1]):
        if occupied == 0 and start is None:
            start = at
        elif occupied and start is not None:
            if start > 0 and at < length:
                gaps.append((at - start, (start + at) // 2))
            start = None
    if len(gaps) >= count - 1:
        # Each row/column can have large pose-dependent padding. Taking its actual
        # clear gutters prevents feet from the preceding row spilling into a cell.
        boundaries = sorted(mid for _, mid in sorted(gaps, reverse=True)[:count - 1])
        return [0, *boundaries, length]
    step = length / count
    result = [0]
    for index in range(1, count):
        expected = index * step
        lo, hi = round(expected - step * .20), round(expected + step * .20)
        def cost(at: int) -> tuple[int, float]:
            box = (0, at, cross, at + 1) if horizontal else (at, 0, at + 1, cross)
            return (counts[at], abs(at - expected))
        result.append(min(range(max(result[-1] + 1, lo), min(length, hi + 1)), key=cost))
    result.append(length)
    return result


def source_cells(image: Image.Image, rows: int) -> list[list[Image.Image]]:
    image = cutout(image)
    ys = divisions(image.getchannel('A'), rows, True)
    cells = []
    for row in range(rows):
        strip = image.crop((0, ys[row], image.width, ys[row + 1]))
        xs = divisions(strip.getchannel('A'), 8, False)
        cells.append([strip.crop((xs[col], 0, xs[col + 1], strip.height)) for col in range(8)])
    for row in cells:
        for cell in row:
            assert cell.getchannel('A').getbbox(), 'Empty source frame'
    return cells


def neck_point(image: Image.Image) -> tuple[float, float]:
    """Locate the isolated tan neck near centre, not raised hands or wooden props."""
    w, h = image.size
    shirt = [(x, y) for y in range(h) for x in range(w)
             if (lambda p: p[3] >= 128 and p[1] > p[0] * 1.3 and p[2] > p[0] * 1.2 and p[1] > 65)(image.getpixel((x, y)))]
    shirt_x = statistics.median(x for x, _ in shirt) if shirt else w / 2
    shirt_y = min(y for _, y in shirt) if shirt else 0
    candidates = []
    for y in range(max(0, shirt_y - round(h * .12)), min(h, shirt_y + round(h * .12))):
        run = []
        for x in range(max(0, round(shirt_x - w * .1)), min(w, round(shirt_x + w * .1))):
            r, g, b, a = image.getpixel((x, y))
            if a >= 128 and r > 120 and .45 * r < g < .91 * r and b < .78 * g:
                run.append(x)
        if len(run) >= 3:
            candidates.append((statistics.median(run), y, len(run)))
    if not candidates:
        box = image.getchannel('A').getbbox()
        return ((box[0] + box[2]) / 2, box[1])
    # Skin closest above the upper shirt is the neck; raised hands are farther away.
    x, y, _ = min(candidates, key=lambda p: abs(p[1] - shirt_y + 3) + abs(p[0] - shirt_x))
    return (x, y + 2)


def build_canonical(root: Path = ROOT) -> tuple[list[Image.Image], dict]:
    source_dir = root / 'art/mobile-sprites'
    config = json.loads((source_dir / 'sources.json').read_text())
    pages: list[Image.Image] = []
    manifest = {'schemaVersion': 1, 'skinMaskEncoding': 'alpha192', 'pages': [], 'clips': {},
                'sampling': {'filter': 'nearest', 'mipmaps': False, 'alphaThreshold': .5,
                             'note': 'Exact cell-edge UVs. All anchors use pixel-edge coordinates; transparent cell margins prevent neighboring-frame sampling.'},
                'provenance': 'art/mobile-sprites/sources.json'}
    clips_per_row = PAGE // (CLIP_W + 2 * PAD)
    clips_per_page = clips_per_row * (PAGE // (CLIP_H + 2 * PAD))
    next_slot = 0
    for source in config['sources']:
        path = source_dir / source['file']
        with Image.open(path) as original:
            cells = source_cells(original, source.get('rows', len(source['clips'])))
        source_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        boxes = [cell.getchannel('A').getbbox() for row in cells for cell in row]
        extent = max(max(box[2] - box[0], box[3] - box[1]) for box in boxes)
        scale = min(1, 116 / extent)
        height_pixels = source.get('heightPixels', 112)
        if source.get('modularHead'):
            reference = cells[source.get('referenceRow', 0)][0]
            reference_box = reference.getchannel('A').getbbox()
            # Match the existing neck-to-foot proportion (72 / 142) while retaining
            # one fixed pixel scale for every frame in this source grid.
            height_pixels = round((reference_box[3] - neck_point(reference)[1]) * scale * 142 / 72)
        for row_index, name in enumerate(source['clips']):
            if name.startswith('_'):
                continue
            source_row = source.get('rowIndices', list(range(len(source['clips']))))[row_index]
            page_index, slot = divmod(next_slot, clips_per_page)
            next_slot += 1
            if page_index == len(pages):
                pages.append(Image.new('RGBA', (PAGE, PAGE)))
            x = PAD + (slot % clips_per_row) * (CLIP_W + 2 * PAD)
            y = PAD + (slot // clips_per_row) * (CLIP_H + 2 * PAD)
            key = f"{source['actor']}:{name}"
            clip = dict(page=page_index, x=x, y=y, w=CLIP_W, h=CLIP_H,
                        cellWidth=CELL, cellHeight=CELL, columns=4, rows=2,
                        anchor=[CELL // 2, FOOT], footYByCell=[[], []],
                        frameDurationMs=source.get('frameDurationMs', 140),
                        loop=name not in {'ko', 'death', 'dead', 'land', 'hit', 'emerge', 'rise'},
                        directionRows={'front': 0, 'away': 1},
                        heightPixels=height_pixels,
                        source=source['file'], sourceSha256=source_hash)
            if name == 'seated':
                clip['includesFurniture'] = source.get('includesFurniture', False)
                if clip['includesFurniture']:
                    clip['worldHeight'] = source['worldHeight']
                    clip['heightPixels'] = round(max(cell.getchannel('A').getbbox()[3] - cell.getchannel('A').getbbox()[1] for cell in cells[source_row]) * scale)
                else:
                    clip['heightPixels'] = 144
            if source.get('modularHead'):
                clip['headAnchorByCell'] = [[], []]
                clip['includesFlag'] = name == 'kneel'
                if name == 'ko':
                    clip['headRotationByCell'] = [[0, -.25, -.75, -1.57], [0, .25, .75, 1.57]]
            if source['actor'] == 'flag':
                bounds = cells[row_index][0].getchannel('A').getbbox()
                clip['heightPixels'] = round((bounds[2] - bounds[0] if name == 'ground' else bounds[3] - bounds[1]) * scale)
                if name != 'ground':
                    clip['poleTipByCell'] = [[], []]
            for direction in range(2):
                for frame in range(4):
                    cell = cells[source_row][direction * 4 + frame]
                    box = cell.getchannel('A').getbbox()
                    body = cell.crop(box)
                    resized = body.resize((max(1, round(body.width * scale)), max(1, round(body.height * scale))), Image.Resampling.NEAREST)
                    final_box = resized.getchannel('A').getbbox()
                    dx, dy = (CELL - resized.width) // 2, FOOT - final_box[3]
                    if source['actor'] == 'flag' and name != 'ground':
                        bottom = [(xx, yy) for yy in range(max(0, final_box[3] - 3), final_box[3])
                                  for xx in range(resized.width) if resized.getpixel((xx, yy))[3] >= 128]
                        dx = CELL // 2 - round(statistics.mean(xx for xx, _ in bottom))
                    assert 2 <= dx and dy >= 2 and dx + resized.width <= CELL - 2, (key, resized.size)
                    pages[page_index].paste(resized, (x + frame * CELL + dx, y + direction * CELL + dy))
                    clip['footYByCell'][direction].append(FOOT)
                    if 'poleTipByCell' in clip:
                        lowest = [xx + .5 for xx in range(resized.width)
                                  if resized.getpixel((xx, final_box[3] - 1))[3] >= 128]
                        clip['poleTipByCell'][direction].append([dx + statistics.mean(lowest), FOOT])
                    if source.get('modularHead'):
                        neck = neck_point(cell)
                        overrides = source.get('headAnchors', {}).get(name, [])
                        if len(overrides) > direction * 4 + frame:
                            neck = overrides[direction * 4 + frame]
                        clip['headAnchorByCell'][direction].append([round(dx + (neck[0] - box[0]) * scale), round(dy + (neck[1] - box[1]) * scale)])
            manifest['clips'][key] = clip
    for alias, target in config.get('aliases', {}).items():
        assert target in manifest['clips'], target
        manifest['clips'][alias] = dict(manifest['clips'][target], aliasOf=target)
    pages = [apply_action_skin_mask(page, root, index) for index, page in enumerate(pages)]
    return pages, manifest


def pack(root: Path = ROOT) -> dict:
    canonical, manifest = build_canonical(root)
    pages, manifest = compact_action_atlas(canonical, manifest, PAGE)
    assert len(pages) < len(canonical), 'Compaction must remove a whole atlas page'
    output = root / 'web/public/assets/mobile-sprites'
    written = set()
    for index, page in enumerate(pages):
        encoded = BytesIO()
        page.save(encoded, 'WEBP', lossless=True, method=6, exact=True)
        content = encoded.getvalue()
        digest = hashlib.sha256(content).hexdigest()[:12]
        path = output / f'actions-{index}.{digest}.webp'
        path.write_bytes(content)
        written.add(path)
        with Image.open(path) as saved:
            assert saved.tobytes() == page.tobytes(), 'Lossless output mismatch'
        manifest['pages'].append({'image': f'/assets/mobile-sprites/{path.name}', 'width': PAGE, 'height': PAGE})
    target = root / 'web/src/render/actors/mobileSpriteActions.json'
    target.write_text(json.dumps(manifest, indent=2) + '\n')
    for unused in output.glob('actions-*.webp'):
        if unused not in written:
            unused.unlink()
    next_slot = sum('aliasOf' not in clip for clip in manifest['clips'].values())
    print(f"Packed {next_slot} action clips / {next_slot * 8} frames into {len(pages)} pages")
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    pack(parser.parse_args().root)
