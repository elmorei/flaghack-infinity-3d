#!/usr/bin/env python3
"""Pack approved sprite sheets with identical visible RGB and cutout coverage.

Requires Pillow. Run from any directory:
  python scripts/tools/build_mobile_sprite_atlas.py /path/to/unpacked-asset-pack
The input contains manifest.json and signifiers/metadata.json. Lossless WebP encoding and JSON order are deterministic for a fixed Pillow
version. Only shader-discarded pixels/unused alpha are normalized; source files
and every visible RGB value are unchanged.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image

WIDTH, HEIGHT, PADDING = 2048, 4096, 2
ROOT = Path(__file__).resolve().parents[2]


def build(source: Path, root: Path = ROOT) -> dict:
    cast = json.loads((source / 'manifest.json').read_text())
    modular = json.loads((source / 'signifiers/metadata.json').read_text())
    canvas = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 0))
    sheets = {}
    occupied = []

    def add(key, filename, x, y, width, height, cell, anchor):
        path = source / filename
        with Image.open(path) as original:
            assert original.mode == 'RGBA', f'{filename}: expected RGBA'
            assert original.size == (width, height), f'{filename}: wrong dimensions'
            image = original.copy()
        # Reserve a transparent two-pixel border on every side of every sheet.
        rect = (x - PADDING, y - PADDING, x + width + PADDING, y + height + PADDING)
        assert 0 <= rect[0] < rect[2] <= WIDTH and 0 <= rect[1] < rect[3] <= HEIGHT
        for other in occupied:
            assert rect[2] <= other[0] or other[2] <= rect[0] or rect[3] <= other[1] or other[3] <= rect[1], f'Overlap: {key}'
        occupied.append(rect)
        # No mask argument: preserve all RGBA source pixels exactly, including
        # semitransparent edges. Alpha-compositing here would alter edge pixels.
        canvas.paste(image, (x, y))
        assert canvas.crop((x, y, x + width, y + height)).tobytes() == image.tobytes()
        sheets[key] = dict(x=x, y=y, w=width, h=height, cellWidth=cell,
                           cellHeight=cell, columns=width // cell, rows=height // cell,
                           anchor=anchor, source=filename,
                           sourceSha256=hashlib.sha256(path.read_bytes()).hexdigest())
        if key.startswith('bodies-') or cell == 256:
            # Row-major cell-local contact baseline. Ignore low-alpha extraction
            # noise, matching the renderer's 0.5 alpha-discard threshold.
            feet = []
            for row in range(height // cell):
                row_feet = []
                for col in range(width // cell):
                    alpha = image.crop((col * cell, row * cell, (col + 1) * cell, (row + 1) * cell)).getchannel('A')
                    bbox = alpha.point(lambda a: 255 if a >= 128 else 0).getbbox()
                    row_feet.append(bbox[3] if bbox else anchor[1])
                feet.append(row_feet)
            sheets[key]['footYByCell'] = feet

    for index, character in enumerate(cast['characters']):
        add(character['id'], character['image'], 2, 2 + index * 516,
            1024, 512, 256, character['anchor'])
        sheets[character['id']]['sourceModelKey'] = character['sourceModelKey']
        sheets[character['id']]['directionRows'] = character['directionRows']

    # The 1024px cast sheets cannot be paired in a 2048px texture with gutters.
    # Stack them at left and use the remaining 1016px for the modular layers.
    for key, filename, y, width, height in [
        ('bodies-front', modular['bodyAtlas'], 2, 640, 1120),
        ('bodies-away', modular['directions']['away']['bodyAtlas'], 1126, 640, 1120),
        ('heads-front', modular['headAtlas'], 2250, 960, 480),
        ('heads-away', modular['directions']['away']['headAtlas'], 2734, 960, 480),
        ('flag-away', modular['directions']['away']['foregroundAtlas'], 3218, 640, 160),
    ]:
        add(key, 'signifiers/' + filename, 1030, y, width, height, 160, [80, 150])

    manifest = dict(schemaVersion=1, image='/assets/mobile-sprites/atlas.webp',
                    width=WIDTH, height=HEIGHT, padding=PADDING,
                    frameDurationMs=140, sheets=sheets,
                    signifiers=dict(neckAnchor=modular['neckAnchor'],
                                    footAnchor=[80, 150],
                                    heads=modular['heads'],
                                    bodyRows=modular['bodyRows'],
                                    bodyMap=modular['bodyMap'],
                                    headOffsets={direction: data['headOffsets'] for direction, data in modular['directions'].items()},
                                    drawOrder={direction: data['drawOrder'] for direction, data in modular['directions'].items()}),
                    sampling=dict(filter='nearest', mipmaps=False,
                                  alphaThreshold=0.5, encoding='lossless WebP, shader-equivalent cutout alpha',
                                  note='All visible source RGB and cutout coverage are preserved. Use exact cell-edge UVs with nearest sampling; transparent cell margins prevent neighboring-frame sampling. Anchors use pixel-edge coordinates.'))
    image_path = root / 'web/public/assets/mobile-sprites/atlas.webp'
    json_path = root / 'web/src/render/actors/mobileSpriteAtlas.json'
    image_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    # Shader discards alpha < .5 and emits alpha=1 for every surviving texel.
    # Normalize only those unused values, then encode losslessly. No quantization.
    mask = canvas.getchannel('A').point(lambda alpha: 255 if alpha >= 128 else 0)
    opaque = canvas.copy()
    opaque.putalpha(255)
    cutout = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    cutout.paste(opaque, (0, 0), mask)
    assert cutout.getchannel('A').tobytes() == mask.tobytes()
    original_bytes, packed_bytes = canvas.tobytes(), cutout.tobytes()
    for i in range(0, len(original_bytes), 4):
        if original_bytes[i + 3] >= 128:
            assert original_bytes[i:i + 3] == packed_bytes[i:i + 3]
    cutout.save(image_path, format='WEBP', lossless=True, method=6, exact=True)
    json_path.write_text(json.dumps(manifest, indent=2) + '\n')
    # Verify lossless decode preserves every normalized pixel exactly.
    with Image.open(image_path) as saved:
        assert saved.mode == 'RGBA' and saved.size == (WIDTH, HEIGHT)
        assert saved.tobytes() == cutout.tobytes()
    print(f'Packed {len(sheets)} sheets into {WIDTH}x{HEIGHT}: {image_path.stat().st_size:,} bytes')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='Unpacked approved asset-pack directory')
    parser.add_argument('--output-root', type=Path, default=ROOT, help='Repository root (default: this checkout)')
    args = parser.parse_args()
    build(args.source, args.output_root)
