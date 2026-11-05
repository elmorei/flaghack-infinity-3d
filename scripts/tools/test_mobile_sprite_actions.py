"""Pixel-level checks for the packed action atlas. Run with Python + Pillow."""
from __future__ import annotations

import hashlib
import json
import statistics
import unittest
from pathlib import Path

from PIL import Image
from build_mobile_sprite_actions import build_canonical

ROOT = Path(__file__).resolve().parents[2]
CAST = ['dr-beef-supreme', 'beelzebub-crow', 'dj-scarecrow', 'president-jaguar']


class ActionAtlasTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((ROOT / 'web/src/render/actors/mobileSpriteActions.json').read_text())
        cls.pages = [Image.open(ROOT / 'web/public' / page['image'].lstrip('/')).convert('RGBA')
                     for page in cls.manifest['pages']]
        cls.canonical_pages, cls.canonical = build_canonical(ROOT)

    def frames(self, clip):
        page = self.pages[clip['page']]
        for row in range(2):
            for col in range(4):
                w, h = clip['cellWidth'], clip['cellHeight']
                x, y = clip['x'] + col * w, clip['y'] + row * h
                yield row, col, page.crop((x, y, x + w, y + h))

    def test_reconstructs_every_canonical_rgba_byte_and_render_anchor(self):
        restored = [Image.new('RGBA', page.size) for page in self.canonical_pages]
        for key, clip in self.manifest['clips'].items():
            original = self.canonical['clips'][key]
            left, top = clip['cropOrigin']
            self.assertEqual(clip['heightPixels'], original['heightPixels'])
            self.assertEqual([clip['anchor'][0] + left, clip['anchor'][1] + top], original['anchor'])
            for field in ['headAnchorByCell', 'poleTipByCell']:
                if field in original:
                    self.assertEqual([[[x + left, y + top] for x, y in row] for row in clip[field]], original[field])
            for row, col, frame in self.frames(clip):
                full = Image.new('RGBA', (128, 128))
                full.paste(frame, (left, top))
                x, y = original['x'] + col * 128, original['y'] + row * 128
                source = self.canonical_pages[original['page']].crop((x, y, x + 128, y + 128))
                self.assertEqual(full.tobytes(), source.tobytes(), (key, row, col))
                restored[original['page']].paste(full, (x, y))
                old_foot, new_foot = original['footYByCell'][row][col], clip['footYByCell'][row][col]
                self.assertEqual(new_foot + top, old_foot)
                # Pixel centres retain identical camera-space vectors. Equal
                # vectors stay equal under any height, camera or flag/head roll.
                for px, py in [(left + .5, top + .5), (left + frame.width - .5, top + frame.height - .5)]:
                    self.assertEqual(px - original['anchor'][0], (px - left) - clip['anchor'][0])
                    self.assertEqual(old_foot - py, new_foot - (py - top))
        for before, after in zip(self.canonical_pages, restored):
            self.assertEqual(before.tobytes(), after.tobytes())

    def test_complete_state_coverage(self):
        clips = self.manifest['clips']
        for actor in CAST:
            for state in ['seated', 'swing', 'throw', 'plant', 'pull', 'align', 'channel', 'push',
                          'sprint', 'jump', 'fall', 'land', 'guard', 'hit', 'stun', 'ko', 'aim', 'respawn']:
                self.assertIn(f'{actor}:{state}', clips)
        for state in ['chop', 'kneel', 'tug', 'shove', 'kick', 'drum', 'dance', 'hammer', 'ko', 'stun', 'jump', 'hit', 'wobble', 'jitter']:
            self.assertIn(f'signifier:{state}', clips)
        for state in ['emerge', 'crouch', 'crouchWalk', 'rise', 'swipe', 'stomp', 'grab', 'recoil', 'death', 'dead', 'eye-charge', 'eye-fire']:
            self.assertIn(f'skeletal-boss:{state}', clips)
        for state in ['planted', 'ground', 'carried', 'thrown']:
            self.assertIn(f'flag:{state}', clips)

    def test_seated_rulers_include_complete_grounded_thrones(self):
        for actor in CAST:
            clip = self.manifest['clips'][actor + ':seated']
            self.assertTrue(clip['includesFurniture'])
            self.assertEqual(clip['worldHeight'], 6.545)
            self.assertEqual(clip['heightPixels'], 116)
            self.assertEqual(clip['source'], 'combined-thrones.webp')
            self.assertEqual([clip['anchor'][i] + clip['cropOrigin'][i] for i in range(2)], [64, 124])

    def test_pages_are_bounded_cutouts_with_authored_skin_markers(self):
        self.assertEqual(len(self.pages), 2)
        for index, page in enumerate(self.pages):
            self.assertEqual(page.size, (2048, 2048))
            self.assertTrue(set(page.getchannel('A').getdata()) <= {0, 192, 255})
            path = ROOT / 'web/public' / self.manifest['pages'][index]['image'].lstrip('/')
            self.assertEqual(path.name, f'actions-{index}.{hashlib.sha256(path.read_bytes()).hexdigest()[:12]}.webp')

    def test_action_skin_encoding_preserves_rgb_and_opaque_coverage(self):
        folder = ROOT / 'art/mobile-sprites/masks'
        review = json.loads((folder / 'actions-2-skin.json').read_text())
        mask = Image.open(folder / review['mask']).convert('L')
        page = self.canonical_pages[2]
        self.assertEqual(hashlib.sha256(page.convert('RGB').tobytes()).hexdigest(), review['sourceRgbSha256'])
        coverage = page.getchannel('A').point(lambda a: 255 if a >= 128 else 0)
        self.assertEqual(hashlib.sha256(coverage.tobytes()).hexdigest(), review['sourceCutoutSha256'])
        self.assertEqual(hashlib.sha256(mask.tobytes()).hexdigest(), review['maskPixelsSha256'])
        for alpha, marked in zip(page.getchannel('A').tobytes(), mask.tobytes()):
            self.assertEqual(alpha == 192, marked == 255)

    def test_action_skin_is_present_in_every_pose_and_excludes_props(self):
        review = json.loads((ROOT / 'art/mobile-sprites/masks/actions-2-skin.json').read_text())
        for key, counts in review['cellCounts'].items():
            clip = self.manifest['clips'][key]
            for row, col, frame in self.frames(clip):
                count = sum(a == 192 for a in frame.getchannel('A').tobytes())
                self.assertEqual(count, counts[row][col], (key, row, col))
                self.assertGreater(count, 100)
        self.assertEqual(sum(a == 192 for page in self.pages for a in page.getchannel('A').tobytes()),
                         sum(sum(row) for counts in review['cellCounts'].values() for row in counts))
        for key, row, col, x, y, role in review['protectedSamples']:
            clip = self.manifest['clips'][key]
            alpha = self.pages[clip['page']].getpixel((clip['x'] + col * clip['cellWidth'] + x - clip['cropOrigin'][0], clip['y'] + row * clip['cellHeight'] + y - clip['cropOrigin'][1]))[3]
            self.assertEqual(alpha, 255, (key, row, col, role))

    def test_all_frames_have_art_clear_margins_and_exact_foot_edges(self):
        for key, clip in self.manifest['clips'].items():
            for row, col, frame in self.frames(clip):
                with self.subTest(clip=key, row=row, frame=col):
                    box = frame.getchannel('A').getbbox()
                    self.assertIsNotNone(box)
                    self.assertGreaterEqual(box[0], 1)
                    self.assertGreaterEqual(box[1], 1)
                    self.assertLessEqual(box[2], frame.width - 1)
                    self.assertLessEqual(box[3], frame.height - 1)
                    self.assertEqual(box[3], clip['footYByCell'][row][col])
                    self.assertEqual(box[3] + clip['cropOrigin'][1], 124)

    def test_animated_clips_have_real_frame_changes_in_both_directions(self):
        for key, clip in self.manifest['clips'].items():
            if key.endswith(':dead'):
                continue  # An intentionally held dead pose.
            hashes = [[], []]
            for row, _, frame in self.frames(clip):
                hashes[row].append(hashlib.sha256(frame.tobytes()).digest())
            for row in range(2):
                with self.subTest(clip=key, row=row):
                    self.assertGreater(len(set(hashes[row])), 1)

    def test_standing_flags_have_exact_per_frame_bottom_tip_metadata(self):
        for state in ['planted', 'carried', 'thrown']:
            clip = self.manifest['clips'][f'flag:{state}']
            for row, col, frame in self.frames(clip):
                foot = frame.getchannel('A').getbbox()[3]
                xs = [x + .5 for x in range(frame.width) if frame.getpixel((x, foot - 1))[3]]
                self.assertEqual(clip['poleTipByCell'][row][col], [statistics.mean(xs), foot])
                self.assertLessEqual(abs(statistics.mean(xs) - clip['anchor'][0]), 1)

    def test_flags_remain_yellow_with_white_ribbons_and_no_red_noise(self):
        for state in ['planted', 'ground', 'carried']:
            for _, _, frame in self.frames(self.manifest['clips'][f'flag:{state}']):
                pixels = [p for p in frame.getdata() if p[3]]
                self.assertTrue(any(r > 200 and g > 140 and b < 60 for r, g, b, _ in pixels))
                self.assertTrue(any(min(r, g, b) > 140 and max(r, g, b) - min(r, g, b) < 70 for r, g, b, _ in pixels))
                self.assertFalse(any(r > 200 and g < 40 and b < 40 for r, g, b, _ in pixels))

    def test_modular_actions_retain_neck_and_flag_metadata(self):
        for key, clip in self.manifest['clips'].items():
            if not key.startswith('signifier:'):
                continue
            self.assertEqual([len(row) for row in clip['headAnchorByCell']], [4, 4])
            self.assertGreater(clip['heightPixels'], 90)
        self.assertTrue(self.manifest['clips']['signifier:kneel']['includesFlag'])
        self.assertFalse(self.manifest['clips']['signifier:hammer']['includesFlag'])


if __name__ == '__main__':
    unittest.main()
