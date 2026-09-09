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
        recipe = demo.kraken_demo_recipe()
        self.assertEqual(recipe["format"], "myth-maker.deterministic-encounter-recipe/v1")
        self.assertEqual(recipe["recipe_id"], "kraken-tentacled-demo")
        self.assertEqual(set(recipe), {"format", "recipe_id", "body", "appendages", "materials", "camera"})
        self.assertEqual(recipe["appendages"]["count"], 8)
        self.assertEqual(len(demo.recipe_digest(recipe)), 64)

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
        recipe = demo.kraken_demo_recipe()
        metadata = {name: {"uri": "modal-volume://proof/" + name, "bytes": 3, "sha256": "a" * 64}
                    for name in ("source", "glb", "initial", "intermediate", "final")}
        state = {
            "format": "myth-maker.deterministic-modal-blender-receipt/v1", "status": "completed",
            "execution": {"engine": "blender-cli"},
            "provenance": {"source_sha": "b" * 40, "recipe_sha256": demo.recipe_digest(recipe),
                           "deployed_function_id": "fu-proof", "openai_api_used": False},
            "glb_validation": {"format": "glb-2.0-self-contained"},
            "provider_receipt": {
                "provider": "modal", "function_name": "run_deterministic_recipe", "function_call_id": "fc-proof",
                "output_artifacts": {"kraken-tentacled-demo.blend": metadata["source"], "kraken-tentacled-demo.glb": metadata["glb"]},
                "blender_window_frames": {name: metadata[name] for name in ("initial", "intermediate", "final")},
            },
        }
        receipt = demo.public_terminal_receipt(state, source_sha="b" * 40,
                                               job_id="deterministic-encounter-demo-1", recipe=recipe)
        self.assertEqual(receipt["format"], "myth-maker.observed-modal-deterministic-demo/v1")
        state["provenance"]["openai_api_used"] = True
        with self.assertRaisesRegex(RuntimeError, "non-use"):
            demo.public_terminal_receipt(state, source_sha="b" * 40,
                                         job_id="deterministic-encounter-demo-1", recipe=recipe)


if __name__ == "__main__":
    unittest.main()
