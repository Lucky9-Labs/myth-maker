#!/usr/bin/env python3
"""Reject static or malformed frame sequences before encoding animation proof."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageChops


def verify_motion(paths: list[Path], *, minimum_frames: int = 24,
                  minimum_changed_fraction: float = 0.005) -> dict:
    if len(paths) < minimum_frames:
        raise ValueError(f"motion proof requires at least {minimum_frames} frames")
    hashes = []
    images = []
    size = None
    for path in paths:
        data = path.read_bytes()
        hashes.append(hashlib.sha256(data).hexdigest())
        with Image.open(path) as source:
            source.verify()
        with Image.open(path) as source:
            image = source.convert("RGB")
        if size is None:
            size = image.size
        elif image.size != size:
            raise ValueError("motion frames must have one stable viewport")
        images.append(image)

    changed_fractions = []
    pixels = size[0] * size[1]
    for before, after in zip(images, images[1:]):
        difference = ImageChops.difference(before, after).convert("L")
        changed = sum(1 for value in difference.get_flattened_data() if value >= 8)
        changed_fractions.append(changed / pixels)
    maximum = max(changed_fractions, default=0)
    if len(set(hashes)) < 2 or maximum < minimum_changed_fraction:
        raise ValueError("captured desktop did not meet the visible motion threshold")
    return {
        "format": "myth-maker.animation-motion-verification/v1",
        "sampled_frames": len(paths),
        "distinct_frame_hashes": len(set(hashes)),
        "minimum_changed_fraction": minimum_changed_fraction,
        "maximum_changed_fraction": maximum,
        "frame_sha256": hashes,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frame-dir", type=Path, required=True)
    parser.add_argument("--minimum-frames", type=int, default=24)
    parser.add_argument("--minimum-changed-fraction", type=float, default=.005)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    paths = sorted(args.frame_dir.glob("frame-*.png"))
    result = verify_motion(paths, minimum_frames=args.minimum_frames,
                           minimum_changed_fraction=args.minimum_changed_fraction)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
