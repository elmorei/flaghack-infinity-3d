"""Pixel-level checks for the packed action atlas. Run with Python + Pillow."""
from __future__ import annotations

import hashlib
import json
import statistics
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
CAST = ['dr-beef-supreme', 'beelzebub-crow', 'dj-scarecrow', 'president-jaguar']


class ActionAtlasTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((ROOT / 'web/src/render/actors/mobileSpriteActions.json').read_text())
        cls.pages = [Image.open(ROOT / 'web/public' / page['image'].lstrip('/')).convert('RGBA')
                     for page in cls.manifest['pages']]

    def frames(self, clip):
        page = self.pages[clip['page']]
        for row in range(2):
            for col in range(4):
                x, y = clip['x'] + col * 128, clip['y'] + row * 128
                yield row, col, page.crop((x, y, x + 128, y + 128))

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

    def test_pages_are_bounded_binary_cutouts(self):
        self.assertEqual(len(self.pages), 3)
        for page in self.pages:
            self.assertEqual(page.size, (2048, 2048))
            self.assertTrue(set(page.getchannel('A').getdata()) <= {0, 255})

    def test_all_frames_have_art_clear_margins_and_exact_foot_edges(self):
        for key, clip in self.manifest['clips'].items():
            for row, col, frame in self.frames(clip):
                with self.subTest(clip=key, row=row, frame=col):
                    box = frame.getchannel('A').getbbox()
                    self.assertIsNotNone(box)
                    self.assertGreaterEqual(box[0], 2)
                    self.assertGreaterEqual(box[1], 2)
                    self.assertLessEqual(box[2], 126)
                    self.assertEqual(box[3], clip['footYByCell'][row][col])
                    self.assertEqual(box[3], 124)

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
                xs = [x + .5 for x in range(128) if frame.getpixel((x, foot - 1))[3]]
                self.assertEqual(clip['poleTipByCell'][row][col], [statistics.mean(xs), foot])
                self.assertLessEqual(abs(statistics.mean(xs) - 64), 1)

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
