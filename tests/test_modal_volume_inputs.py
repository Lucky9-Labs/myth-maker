import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest


MODAL_DIR = Path(__file__).parents[1] / "modal"
sys.path.insert(0, str(MODAL_DIR))
from modal_volume_inputs import load_volume_inputs, validate_volume_input_manifest


class ModalVolumeInputTests(unittest.TestCase):
    def test_loads_only_exact_hash_and_length_verified_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_root = root / "run-a4" / "inputs"
            input_root.mkdir(parents=True)
            files = {
                "source_scene.blend": b"blend",
                "structure_reference.png": b"png-a",
                "component_reference.png": b"png-b",
                "primary_artwork.png": b"png-c",
                "concept_reference.png": b"png-d",
            }
            for name, data in files.items():
                (input_root / name).write_bytes(data)
            manifest = {
                "schema_version": "1", "volume_name": "volume", "input_root": "run-a4/inputs",
                "files": {name: {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)} for name, data in files.items()},
            }
            self.assertEqual(load_volume_inputs(manifest, root, expected_volume="volume"), files)

            manifest["files"]["source_scene.blend"]["sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                load_volume_inputs(manifest, root, expected_volume="volume")

    def test_rejects_unsafe_or_open_manifest_shapes(self):
        manifest = json.loads((MODAL_DIR / "kraken_input_manifest.json").read_text())
        validate_volume_input_manifest(manifest, expected_volume="myth-maker-encounter-submissions")
        manifest["input_root"] = "../escape"
        with self.assertRaisesRegex(ValueError, "safe relative"):
            validate_volume_input_manifest(manifest, expected_volume="myth-maker-encounter-submissions")


if __name__ == "__main__":
    unittest.main()
