"""Regression checks for the reviewed original Signifier skin mask."""
import hashlib
import json
from pathlib import Path
import unittest

from PIL import Image, ImageChops
from mobile_sprite_skin import apply_base_skin_mask

ROOT = Path(__file__).resolve().parents[2]


class BaseSkinMaskTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.review = json.loads((ROOT / 'art/mobile-sprites/masks/atlas-skin.json').read_text())
        cls.mask = Image.open(ROOT / 'art/mobile-sprites/masks/atlas-skin.webp').convert('L')
        cls.meta = json.loads((ROOT / 'web/src/render/actors/mobileSpriteAtlas.json').read_text())
        cls.path = ROOT / 'web/public' / cls.meta['image'].lstrip('/')
        cls.image = Image.open(cls.path).convert('RGBA')

    def test_runtime_url_is_content_versioned(self):
        data = self.path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()[:16]
        self.assertEqual(self.path.name, f'atlas-{digest}.webp')
        self.assertEqual(data, (ROOT / 'web/public/assets/mobile-sprites/atlas.webp').read_bytes())

    def test_source_rgb_and_cutout_are_unchanged(self):
        self.assertEqual(hashlib.sha256(self.image.convert('RGB').tobytes()).hexdigest(), self.review['sourceRgbSha256'])
        alpha = self.image.getchannel('A').point(lambda value: 255 if value >= 128 else 0)
        self.assertEqual(hashlib.sha256(alpha.tobytes()).hexdigest(), self.review['sourceCutoutSha256'])

    def test_binary_reviewed_mask_and_exact_encoding(self):
        self.assertEqual(self.mask.size, self.image.size)
        self.assertEqual(set(self.mask.tobytes()), {0, 255})
        self.assertEqual(self.mask.histogram()[255], self.review['selectedPixels'])
        selected = self.image.getchannel('A').point(lambda value: 255 if value == 192 else 0)
        self.assertIsNone(ImageChops.difference(selected, self.mask).getbbox())
        self.assertEqual(set(self.image.getchannel('A').tobytes()), {0, 192, 255})
        self.assertEqual(self.meta['skinMaskEncoding'], 'alpha192')

    def test_every_head_body_and_foreground_hand_has_reviewed_coverage(self):
        for key, rows in self.review['cellCounts'].items():
            sheet = self.meta['sheets'][key]
            for row, counts in enumerate(rows):
                for col, expected in enumerate(counts):
                    box = (sheet['x'] + col * 160, sheet['y'] + row * 160,
                           sheet['x'] + (col + 1) * 160, sheet['y'] + (row + 1) * 160)
                    self.assertEqual(self.mask.crop(box).histogram()[255], expected, (key, row, col))
                    self.assertGreater(expected, 20)

    def test_only_modular_signifier_layers_are_selected(self):
        remainder = self.mask.copy()
        for key in self.review['cellCounts']:
            s = self.meta['sheets'][key]
            remainder.paste(0, (s['x'], s['y'], s['x'] + s['w'], s['y'] + s['h']))
        self.assertIsNone(remainder.getbbox())

    def test_eyes_hair_hats_clothes_tools_and_flags_are_protected(self):
        # Cell-local rectangles covering unambiguous protected feature pixels.
        probes = {
            'heads-front': [(0, 0, (63, 56, 70, 63)), (0, 0, (65, 26, 90, 37)),
                            (1, 2, (48, 39, 110, 51)), (1, 3, (49, 43, 111, 57)),
                            (1, 5, (60, 55, 94, 61)), (2, 0, (58, 56, 69, 62))],
            'heads-away': [(0, 0, (58, 30, 100, 65)), (0, 3, (59, 30, 97, 60))],
            'bodies-front': [(r, c, (69, 92, 88, 111)) for r in range(7) for c in range(4)]
                            + [(r, c, (66, 119, 95, 145)) for r in range(7) for c in range(4)]
                            + [(3, c, (63, 108, 91, 119)) for c in range(4)],
            'flag-away': [(0, c, (90, 40, 139, 88)) for c in range(4)],
        }
        for key, entries in probes.items():
            s = self.meta['sheets'][key]
            for row, col, (x0, y0, x1, y1) in entries:
                ox, oy = s['x'] + col * 160, s['y'] + row * 160
                self.assertIsNone(self.mask.crop((ox+x0, oy+y0, ox+x1, oy+y1)).getbbox(), (key, row, col, (x0,y0,x1,y1)))

    def test_encoder_is_idempotent_and_preserves_rgb(self):
        encoded = apply_base_skin_mask(self.image, ROOT)
        self.assertEqual(encoded.tobytes(), self.image.tobytes())


if __name__ == '__main__':
    unittest.main()
