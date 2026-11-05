"""Lossless transparent-margin compaction for the canonical action atlas.

Canonical 128px cells and reviewed skin masks remain the authoring format.
This final packing step never scales, rotates or changes a retained RGBA byte.
"""
from __future__ import annotations

from copy import deepcopy

from PIL import Image


def frames(page: Image.Image, clip: dict):
    for row in range(clip['rows']):
        for column in range(clip['columns']):
            x = clip['x'] + column * clip['cellWidth']
            y = clip['y'] + row * clip['cellHeight']
            yield row, column, page.crop((x, y, x + clip['cellWidth'], y + clip['cellHeight']))


def placements(rectangles: list[tuple[str, int, int]], page_size: int, count: int) -> dict:
    """Deterministic, unrotated MaxRects with best-short-side placement."""
    free = [[(0, 0, page_size, page_size)] for _ in range(count)]
    result = {}
    # Stable ordering preserves canonical source order for equal-height clips.
    for key, width, height in sorted(rectangles, key=lambda item: item[2], reverse=True):
        candidates = []
        for page, spaces in enumerate(free):
            for x, y, w, h in spaces:
                if width <= w and height <= h:
                    small, large = sorted((w - width, h - height))
                    candidates.append((small, large, page, y, x))
        assert candidates, 'Lossless crops no longer fit fewer pages; review packing before adding art'
        _, _, page, y, x = min(candidates)
        result[key] = (page, x, y)
        split = []
        for fx, fy, fw, fh in free[page]:
            if x >= fx + fw or x + width <= fx or y >= fy + fh or y + height <= fy:
                split.append((fx, fy, fw, fh))
                continue
            if fx < x:
                split.append((fx, fy, x - fx, fh))
            if x + width < fx + fw:
                split.append((x + width, fy, fx + fw - x - width, fh))
            if fy < y:
                split.append((fx, fy, fw, y - fy))
            if y + height < fy + fh:
                split.append((fx, y + height, fw, fy + fh - y - height))
        free[page] = [a for i, a in enumerate(split) if not any(
            i != j and a[0] >= b[0] and a[1] >= b[1]
            and a[0] + a[2] <= b[0] + b[2] and a[1] + a[3] <= b[1] + b[3]
            and (a != b or i > j) for j, b in enumerate(split))]
    return result


def compact_action_atlas(pages: list[Image.Image], manifest: dict, page_size: int = 2048):
    crops, rectangles = {}, []
    concrete = {key: clip for key, clip in manifest['clips'].items() if 'aliasOf' not in clip}
    for key, clip in concrete.items():
        boxes = [frame.getchannel('A').getbbox() for _, _, frame in frames(pages[clip['page']], clip)]
        # One clear texel on each cell edge is sufficient for nearest sampling.
        left = max(0, min(box[0] for box in boxes) - 1)
        top = max(0, min(box[1] for box in boxes) - 1)
        right = min(clip['cellWidth'], max(box[2] for box in boxes) + 1)
        bottom = min(clip['cellHeight'], max(box[3] for box in boxes) + 1)
        crops[key] = (left, top, right, bottom)
        rectangles.append((key, (right - left) * clip['columns'], (bottom - top) * clip['rows']))
    count = len(pages) - 1
    assert count > 0
    layout = placements(rectangles, page_size, count)
    packed = [Image.new('RGBA', (page_size, page_size)) for _ in range(count)]
    result = deepcopy(manifest)
    result['pages'] = []
    result['packing'] = dict(method='lossless-uniform-clip-crop', transparentGutter=1,
                             canonicalCellSize=[128, 128], canonicalPageCount=len(pages))
    for key, original in concrete.items():
        left, top, right, bottom = crops[key]
        width, height = right - left, bottom - top
        page, x, y = layout[key]
        clip = result['clips'][key]
        clip.update(page=page, x=x, y=y, w=width * clip['columns'], h=height * clip['rows'],
                    cellWidth=width, cellHeight=height, cropOrigin=[left, top])
        clip['anchor'] = [original['anchor'][0] - left, original['anchor'][1] - top]
        if 'footYByCell' in clip:
            clip['footYByCell'] = [[v - top for v in row] for row in original['footYByCell']]
        for field in ['headAnchorByCell', 'poleTipByCell']:
            if field in clip:
                clip[field] = [[[px - left, py - top] for px, py in row] for row in original[field]]
        for row, column, source in frames(pages[original['page']], original):
            cropped = source.crop(crops[key])
            restored = Image.new('RGBA', source.size)
            restored.paste(cropped, (left, top))
            assert restored.tobytes() == source.tobytes(), (key, row, column, 'Nonzero RGBA removed')
            packed[page].paste(cropped, (x + column * width, y + row * height))
        assert clip['heightPixels'] == original['heightPixels']
    for key, original in manifest['clips'].items():
        if 'aliasOf' in original:
            result['clips'][key] = dict(deepcopy(result['clips'][original['aliasOf']]), aliasOf=original['aliasOf'])
    # Re-extract from the finished atlas: this also rejects any packing overlap.
    for key, original in concrete.items():
        clip = result['clips'][key]
        actual = frames(packed[clip['page']], clip)
        expected = frames(pages[original['page']], original)
        for (row, column, frame), (_, _, source) in zip(actual, expected):
            restored = Image.new('RGBA', source.size)
            restored.paste(frame, tuple(clip['cropOrigin']))
            assert restored.tobytes() == source.tobytes(), (key, row, column, 'Packing changed pixels')
    return packed, result
