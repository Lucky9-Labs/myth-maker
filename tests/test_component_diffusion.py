from __future__ import annotations
import json
from pathlib import Path
import sys
import tempfile
import unittest
from PIL import Image

sys.path.insert(0, str(Path(__file__).parents[1] / "modal"))
from component_diffusion import (A100_40GB_USD_PER_SECOND, FORMAT, MODEL, T4_USD_PER_SECOND,
                                 _gpu_identity, masked_component_crop,
                                 read_component_diffusion_status, validate_component_diffusion_job)


def job():
    return {"format": FORMAT, "run_id": "pilot-001", "work_id": "canopy-shape-v1", "attempt": 1,
            "asset_id": "mech", "component_id": "canopy-system", "model": MODEL,
            "reference_polygon": [[0.2, 0.1], [0.8, 0.1], [0.7, 0.9], [0.3, 0.9]],
            "seeds": [1101], "num_inference_steps": 30, "octree_resolution": 256}


class ComponentDiffusionTests(unittest.TestCase):
    def test_gpu_identity_prices_allocated_fallback(self):
        class Properties:
            total_memory = 40 * 1024**3
        class Cuda:
            get_device_name = staticmethod(lambda _: "NVIDIA A100-SXM4-40GB")
            get_device_properties = staticmethod(lambda _: Properties())
        class Torch:
            cuda = Cuda()
        self.assertEqual(_gpu_identity(Torch), ("NVIDIA A100-SXM4-40GB", A100_40GB_USD_PER_SECOND))

    def test_gpu_identity_prices_any_fallback(self):
        class Properties:
            total_memory = 16 * 1024**3
        class Cuda:
            get_device_name = staticmethod(lambda _: "Tesla T4")
            get_device_properties = staticmethod(lambda _: Properties())
        class Torch:
            cuda = Cuda()
        self.assertEqual(_gpu_identity(Torch), ("Tesla T4", T4_USD_PER_SECOND))

    def test_closed_job_validation(self):
        self.assertEqual(validate_component_diffusion_job(job()), job())
        invalid = {**job(), "seeds": [1, 2]}
        with self.assertRaisesRegex(ValueError, "exactly one"):
            validate_component_diffusion_job(invalid)
        conditioned = {**job(), "conditioning": {"path": "asset-production/pilot/isolation.png",
            "bytes": 123, "sha256": "a" * 64, "media_type": "image/png",
            "component_id": "canopy-system"}}
        self.assertEqual(validate_component_diffusion_job(conditioned), conditioned)

    def test_masked_crop_is_square_and_transparent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); source = root / "source.png"; output = root / "crop.png"
            Image.new("RGB", (100, 50), (10, 20, 30)).save(source)
            artifact = masked_component_crop(source, [[0.2, 0.1], [0.8, 0.1], [0.7, 0.9], [0.3, 0.9]], output)
            self.assertEqual(artifact["width"], artifact["height"])
            with Image.open(output) as crop:
                self.assertEqual(crop.mode, "RGBA")
                self.assertEqual(crop.getpixel((0, 0))[3], 0)

    def test_status_reads_latest_persisted_phase_and_terminal_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            attempt = root / "asset-production/pilot-001/component-diffusion/canopy-shape-v1/attempt-0001"
            attempt.mkdir(parents=True)
            (attempt / "job.json").write_text('{"work_id":"canopy-shape-v1"}')
            status = read_component_diffusion_status("pilot-001", "canopy-shape-v1", 1, root)
            self.assertEqual(status["status"], "dispatched")
            (attempt / "phase.json").write_text('{"phase":"model-cache","status":"running"}')
            self.assertEqual(read_component_diffusion_status(
                "pilot-001", "canopy-shape-v1", 1, root)["status"], "running")
            (attempt / "receipt.json").write_text('{"status":"completed"}')
            self.assertEqual(read_component_diffusion_status(
                "pilot-001", "canopy-shape-v1", 1, root)["status"], "completed")


if __name__ == "__main__": unittest.main()
