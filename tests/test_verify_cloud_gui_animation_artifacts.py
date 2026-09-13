import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from verify_cloud_gui_animation_artifacts import verify


class CloudGuiAnimationArtifactVerificationTests(unittest.TestCase):
    def test_verifies_downloaded_outputs_and_frames_against_the_provider_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            native, final = b"BLENDER", b"png"
            (root / "native.blend").write_bytes(native)
            (root / "final.png").write_bytes(final)
            metadata = lambda data: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "uri": "modal-volume://evidence"}
            receipt = root / "receipt.json"
            receipt.write_text(json.dumps({"work_order": {"work_id": "reef-rig"}, "worker_state": {
                "provider_receipt": {"provider": "modal", "function_call_id": "fc-1",
                    "output_artifacts": {"reef-rig.blend": metadata(native)},
                    "blender_window_frames": {"final": metadata(final)}}}}))

            result = verify(receipt, root, {"reef-rig.blend": "native.blend"}, {"final": "final.png"})

            self.assertEqual(result["work_id"], "reef-rig")
            self.assertEqual(set(result["verified_artifacts"]), {"output:reef-rig.blend", "frame:final"})


if __name__ == "__main__":
    unittest.main()
