import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).parents[1]


def load(name: str):
    path = ROOT / "scripts" / (name + ".py")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


demo = load("observed_modal_blender_demo")
verify = load("verify_observed_modal_artifacts")


class ObservedModalDemoTests(unittest.TestCase):
    def test_kraken_is_only_a_closed_generic_recipe_instance(self):
        ids = demo.request_scoped_ids("modal-run-123-1")
        recipe = demo.kraken_demo_recipe(ids["work_id"])
        self.assertEqual(recipe["format"], "myth-maker.deterministic-encounter-recipe/v1")
        self.assertEqual(recipe["recipe_id"], "encounter-body-modal-run-123-1")
        self.assertEqual(set(recipe), {"format", "recipe_id", "body", "appendages", "materials", "camera"})
        self.assertEqual(recipe["appendages"]["count"], 8)
        self.assertEqual(len(demo.recipe_digest(recipe)), 64)

    def test_request_scoped_ids_are_generic_and_reject_unsafe_values(self):
        self.assertEqual(demo.request_scoped_ids("modal-run-42-2"), {
            "request_id": "modal-run-42-2", "encounter_id": "encounter-modal-run-42-2",
            "work_id": "encounter-body-modal-run-42-2",
        })
        with self.assertRaisesRegex(ValueError, "stable request"):
            demo.request_scoped_ids("Kraken-special-case")

    def test_verifier_requires_every_observed_provider_byte(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = {"source": b"blend", "preview": b"preview", "initial": b"initial", "latest": b"latest", "final": b"final"}
            for name, data in files.items():
                (root / ("source.blend" if name == "source" else name + ".png")).write_bytes(data)
            metadata = {name: {"uri": "modal-volume://proof/" + name, "bytes": len(data), "sha256": demo.digest(data)} for name, data in files.items()}
            receipt = {
                "format": "myth-maker.observed-modal-blender-demo/v1", "work_id": "kraken-cloud-observed-demo",
                "provider_receipt": {"provider": "modal", "function_call_id": "fc-proof", "output_artifacts": {"kraken-cloud-observed-demo.blend": metadata["source"], "kraken-cloud-observed-demo_preview.png": metadata["preview"]}, "blender_window_frames": {name: metadata[name] for name in ("initial", "latest", "final")}},
            }
            receipt_path = root / "receipt.json"
            receipt_path.write_text(json.dumps(receipt))
            result = verify.verify(receipt_path, root)
            self.assertEqual(result["function_call_id"], "fc-proof")
            (root / "final.png").write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                verify.verify(receipt_path, root)

    def test_deterministic_receipt_requires_glb_and_three_staged_frames(self):
        ids = demo.request_scoped_ids("modal-run-proof-1")
        recipe = demo.kraken_demo_recipe(ids["work_id"])
        metadata = {name: {"uri": "modal-volume://proof/" + name, "bytes": 3, "sha256": "a" * 64}
                    for name in ("source", "glb", "initial", "intermediate", "final")}
        state = {
            "format": "myth-maker.deterministic-modal-blender-receipt/v1", "status": "completed",
            "job_id": "deterministic-encounter-demo-1", "recipe_id": ids["work_id"],
            "execution": {"engine": "blender-cli"},
            "provenance": {"source_sha": "b" * 40, "recipe_sha256": demo.recipe_digest(recipe),
                           "deployed_function_id": "fu-proof", "openai_api_used": False},
            "glb_validation": {
                "format": "glb-2.0-self-contained", "appendage_count": recipe["appendages"]["count"],
                "required_node_names": ["encounter-body"] + [
                    f"encounter-appendage-{index:02d}" for index in range(recipe["appendages"]["count"])
                ],
            },
            "frame_validation": {
                name: {"width": recipe["camera"]["resolution"][0], "height": recipe["camera"]["resolution"][1]}
                for name in ("initial", "intermediate", "final")
            },
            "provider_receipt": {
                "provider": "modal", "function_name": "run_deterministic_recipe", "function_call_id": "fc-proof",
                "output_artifacts": {ids["work_id"] + ".blend": metadata["source"], ids["work_id"] + ".glb": metadata["glb"]},
                "blender_window_frames": {name: metadata[name] for name in ("initial", "intermediate", "final")},
            },
        }
        receipt = demo.public_terminal_receipt(state, source_sha="b" * 40,
                                               job_id="deterministic-encounter-demo-1", ids=ids, recipe=recipe)
        self.assertEqual(receipt["format"], "myth-maker.observed-modal-deterministic-demo/v1")
        self.assertEqual(receipt["encounter_id"], ids["encounter_id"])
        self.assertEqual(receipt["worker_receipt"]["frame_validation"]["final"], {"width": 768, "height": 576})
        state["provenance"]["openai_api_used"] = True
        with self.assertRaisesRegex(RuntimeError, "non-use"):
            demo.public_terminal_receipt(state, source_sha="b" * 40,
                                         job_id="deterministic-encounter-demo-1", ids=ids, recipe=recipe)


if __name__ == "__main__":
    unittest.main()
