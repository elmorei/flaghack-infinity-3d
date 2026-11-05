"""Encode reviewed semantic skin masks without modifying sprite RGB or coverage."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image

SKIN_ALPHA = 192


def apply_base_skin_mask(image: Image.Image, root: Path) -> Image.Image:
    return apply_reviewed_skin_mask(image, root, 'atlas-skin.json')


def apply_action_skin_mask(image: Image.Image, root: Path, page: int) -> Image.Image:
    """Only the Signifier action page contains recolorable modular skin."""
    if page != 2:
        return image
    return apply_reviewed_skin_mask(image, root, 'actions-2-skin.json')


def apply_reviewed_skin_mask(image: Image.Image, root: Path, review_name: str) -> Image.Image:
    """The checked-in mask is authoritative; no runtime colour classification."""
    folder = root / 'art/mobile-sprites/masks'
    review = json.loads((folder / review_name).read_text())
    mask = Image.open(folder / review['mask']).convert('L')
    assert mask.size == image.size, 'Skin mask dimensions changed'
    assert set(mask.tobytes()) <= {0, 255}, 'Skin mask must be binary'
    assert hashlib.sha256(mask.tobytes()).hexdigest() == review['maskPixelsSha256'], 'Review changed mask pixels'
    assert hashlib.sha256(image.convert('RGB').tobytes()).hexdigest() == review['sourceRgbSha256'], 'Review skin mask against changed source art'
    alpha = image.getchannel('A')
    coverage = alpha.point(lambda value: 255 if value >= 128 else 0)
    assert hashlib.sha256(coverage.tobytes()).hexdigest() == review['sourceCutoutSha256'], 'Source coverage changed'
    assert all(not marked or covered for marked, covered in zip(mask.tobytes(), coverage.tobytes())), 'Skin outside opaque art'
    alpha = coverage.copy()
    alpha.paste(SKIN_ALPHA, (0, 0, image.width, image.height), mask)
    result = image.copy()
    result.putalpha(alpha)
    assert result.convert('RGB').tobytes() == image.convert('RGB').tobytes()
    return result
