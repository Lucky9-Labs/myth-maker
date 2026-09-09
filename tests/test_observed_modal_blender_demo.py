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
    def test_inputs_are_pinned_and_reference_reuse_is_explicit(self):
        inputs, provenance = demo.inputs_and_provenance("a" * 40)
        self.assertEqual(set(inputs), {"source_scene.blend", "structure_reference.png", "component_reference.png", "primary_artwork.png", "concept_reference.png"})
        self.assertEqual(provenance["pinned_concept"]["sha256"], "e71be0a3d053f7d72e531c892c8f7d4857194f5d70fd27c4eeecc9a1143ec008")
        self.assertIn("does not invent", provenance["reference_slot_policy"])

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


if __name__ == "__main__":
    unittest.main()
