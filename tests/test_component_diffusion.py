from __future__ import annotations
import json
from pathlib import Path
import sys
import tempfile
import unittest
from PIL import Image

sys.path.insert(0, str(Path(__file__).parents[1] / "modal"))
from component_diffusion import FORMAT, MODEL, masked_component_crop, validate_component_diffusion_job


def job():
    return {"format": FORMAT, "run_id": "pilot-001", "work_id": "canopy-shape-v1", "attempt": 1,
            "asset_id": "mech", "component_id": "canopy-system", "model": MODEL,
            "reference_polygon": [[0.2, 0.1], [0.8, 0.1], [0.7, 0.9], [0.3, 0.9]],
            "seeds": [1101], "num_inference_steps": 30, "octree_resolution": 256}


class ComponentDiffusionTests(unittest.TestCase):
    def test_closed_job_validation(self):
        self.assertEqual(validate_component_diffusion_job(job()), job())
        invalid = {**job(), "seeds": [1, 2]}
        with self.assertRaisesRegex(ValueError, "exactly one"):
            validate_component_diffusion_job(invalid)

    def test_masked_crop_is_square_and_transparent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); source = root / "source.png"; output = root / "crop.png"
            Image.new("RGB", (100, 50), (10, 20, 30)).save(source)
            artifact = masked_component_crop(source, [[0.2, 0.1], [0.8, 0.1], [0.7, 0.9], [0.3, 0.9]], output)
            self.assertEqual(artifact["width"], artifact["height"])
            with Image.open(output) as crop:
                self.assertEqual(crop.mode, "RGBA")
                self.assertEqual(crop.getpixel((0, 0))[3], 0)


if __name__ == "__main__": unittest.main()
