from pathlib import Path
import sys
import tempfile
import unittest

from PIL import Image


sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from verify_animation_motion import verify_motion


class AnimationMotionVerificationTests(unittest.TestCase):
    def test_requires_provider_hashed_frames_with_visible_pixel_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = []
            for index in range(8):
                path = root / f"frame-{index:03d}.png"
                image = Image.new("RGB", (40, 30), "black")
                for x in range(index, index + 8):
                    for y in range(8, 20):
                        image.putpixel((x, y), (0, 240, 220))
                image.save(path)
                paths.append(path)

            result = verify_motion(paths, minimum_frames=8, minimum_changed_fraction=.005)

            self.assertEqual(result["sampled_frames"], 8)
            self.assertGreater(result["maximum_changed_fraction"], .005)
            self.assertGreater(result["distinct_frame_hashes"], 1)

    def test_rejects_a_static_desktop_capture(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = []
            for index in range(8):
                path = root / f"frame-{index:03d}.png"
                Image.new("RGB", (40, 30), "black").save(path)
                paths.append(path)

            with self.assertRaisesRegex(ValueError, "motion threshold"):
                verify_motion(paths, minimum_frames=8, minimum_changed_fraction=.005)


if __name__ == "__main__":
    unittest.main()
