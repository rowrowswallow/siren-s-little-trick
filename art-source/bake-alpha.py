"""Bakes each model-generated luminance mask into its atlas as a real alpha channel.

The atlases came back from the generator with an opaque checkerboard instead of transparency,
so the runtime paired every atlas with a separate black/white mask and asked CSS to interpret it
with `mask-mode: luminance`. Older WebKit does not honour that: it takes `-webkit-mask-image`
with alpha semantics, the mask is opaque everywhere, so nothing is masked and the checkerboard
shows through. Observed on iPad Safari at sirenslittletrick.pages.dev.

Baking applies the same Rec.709 luminance-to-alpha maths the canvas path already ran at startup,
just ahead of time. It removes the CSS mask entirely, drops both mask files from the bundle and
skips ~1.57M pixels of main-thread compositing on every load.

Transparent areas keep a bled copy of the sprite colour near the edge and flat white further out,
so filtering never pulls checkerboard grey into an antialiased edge and the far field compresses
to almost nothing.

Run after regenerating any atlas:  python art-source/bake-alpha.py
"""
from PIL import Image, ImageFilter
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
QUALITY = 90
PAIRS = [
    ("game/assets/characters/siren-atlas.webp", "game/assets/characters/siren-mask.webp"),
    ("game/assets/boats/boats-atlas.webp", "game/assets/boats/boats-mask.webp"),
]


def bake(atlas_path, mask_path):
    atlas = Image.open(ROOT / atlas_path).convert("RGB")
    alpha = Image.open(ROOT / mask_path).convert("L")
    if atlas.size != alpha.size:
        raise SystemExit(f"{atlas_path}: atlas {atlas.size} != mask {alpha.size}")

    a = np.array(alpha)
    opaque = a > 8
    bled = atlas.copy()
    for _ in range(6):
        grown = np.array(bled.filter(ImageFilter.MaxFilter(5)))
        arr = np.array(bled)
        arr[~opaque] = grown[~opaque]
        bled = Image.fromarray(arr, "RGB")
        opaque = opaque | (np.array(bled).sum(axis=2) > 0)

    arr = np.array(bled)
    near = np.array(Image.fromarray((a > 8).astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(21)))
    arr[(near < 128) & (a < 2)] = 255
    return Image.fromarray(np.dstack([arr, a]), "RGBA")


total_before = total_after = 0
for atlas_path, mask_path in PAIRS:
    atlas_file, mask_file = ROOT / atlas_path, ROOT / mask_path
    before = atlas_file.stat().st_size + mask_file.stat().st_size
    baked = bake(atlas_path, mask_path)
    baked.save(atlas_file, "WEBP", quality=QUALITY, method=6)
    mask_file.unlink()
    after = atlas_file.stat().st_size
    total_before += before
    total_after += after
    print(f"{atlas_path:46s} {before/1024:7.1f}KB -> {after/1024:7.1f}KB  (遮罩已删除)")

print(f"{'合计':46s} {total_before/1024:7.1f}KB -> {total_after/1024:7.1f}KB  "
      f"省 {(total_before-total_after)/1024:.1f}KB")
