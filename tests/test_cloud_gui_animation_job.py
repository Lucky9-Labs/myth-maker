import hashlib
from pathlib import Path
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from run_cloud_gui_animation_job import (build_manifest, build_work_order, collect_inputs,
                                         validate_deployment_receipt)


GLB = b"glTF\x02\x00\x00\x00\x0c\x00\x00\x00"


class CloudGuiAnimationJobTests(unittest.TestCase):
    def test_collects_a_closed_hash_bound_input_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = {
                "source_asset.glb": GLB,
                "structure_reference.png": b"one",
                "component_reference.png": b"two",
                "primary_artwork.png": b"three",
                "concept_reference.png": b"four",
            }
            specs = []
            for name, data in files.items():
                path = root / name
                path.write_bytes(data)
                specs.append(f"{name}={path}")

            collected = collect_inputs(specs)
            manifest = build_manifest(collected, input_root="cloud-animation/run-7/reef-skitter-rig/inputs")

            self.assertEqual(set(manifest["files"]), set(files))
            self.assertEqual(manifest["files"]["source_asset.glb"]["sha256"], hashlib.sha256(GLB).hexdigest())
            self.assertEqual(manifest["volume_name"], "myth-maker-encounter-submissions")

    def test_work_order_keeps_the_instruction_and_stable_identity(self):
        order = build_work_order("reef-skitter-clip-idle", "animation-clip", "Author idle", attempt=1)

        self.assertEqual(order, {
            "schema_version": "1", "work_id": "reef-skitter-clip-idle", "encounter_id": "reef-skitter",
            "lane": "animation-clip", "attempt": 1, "instruction": "Author idle",
        })

    def test_deployment_receipt_binds_source_environment_and_volume_function(self):
        receipt = {
            "format": "myth-maker.deployment-receipt/v1", "provider": "modal", "status": "success",
            "environment": "dev", "source_sha": "a" * 40,
            "details": {"provider_evidence": {"health": {"volume_draft_function_id": "fu-current"}}},
        }

        validate_deployment_receipt(receipt, source_sha="a" * 40, environment="dev", function_id="fu-current")
        with self.assertRaisesRegex(RuntimeError, "deployment receipt"):
            validate_deployment_receipt(receipt, source_sha="b" * 40, environment="dev", function_id="fu-current")


if __name__ == "__main__":
    unittest.main()
